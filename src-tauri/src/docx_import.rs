// 功能项 I：Word(.docx) → Markdown 离线、零配置导入引擎。
//
// .docx = OOXML（ZIP 容器 + XML）。本模块用纯 Rust（zip 读 + roxmltree 解析 XML + sha2 图片哈希，
// base64 复用 lib.rs 手写实现）把 OOXML 映射为保真 Markdown，**不依赖任何外部二进制**（pandoc/LibreOffice）。
// 拆两命令以兑现「校对后才落盘」：
//   • docx_preview —— 只转不写：开包 → 映射 md + 提取图片字节(回 base64) + warnings/stats；
//   • docx_commit  —— 校对后写 .md + 图片按内容哈希去重落库（abs_in_vault 双防线、冲突补 -N）。
// 映射核心写成**纯函数**（输入 roxmltree 节点、输出 md 片段 + warnings，不碰 IO），便于单测。

use chrono::Local;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::io::Read as IoRead;
use std::path::Path;

use crate::{b64_decode, b64_encode, vault_join};

// ==================== OOXML 命名空间 ====================
// 约定：document.xml/styles.xml/numbering.xml/footnotes.xml 里的元素与属性均带 `w:`/`r:` 前缀、
// 无默认命名空间；rels 文件元素/属性走各自默认命名空间。故映射按**局部名**匹配即可（见下方 helper）。
const W: &str = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const R: &str = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
// 数学（OMML）命名空间：document.xml 里 m: 前缀元素/属性属此。子项目② 公式解析用。
const M: &str = "http://schemas.openxmlformats.org/officeDocument/2006/math";

// ==================== 命令契约（serde camelCase，见 I spec §5） ====================

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocxPreviewArgs {
    pub src_path: String,
    pub dest_dir: String,
    pub title_override: Option<String>,
    pub dedup_index: HashMap<String, String>,
    pub with_frontmatter: bool,
    pub max_image_bytes: u64,
    /// 拖拽入口：浏览器 File 无绝对路径 → 前端回传字节 + 显示名（给了 src_b64 则忽略 src_path）。
    #[serde(default)]
    pub src_b64: Option<String>,
    #[serde(default)]
    pub src_display_name: Option<String>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ImportedImage {
    pub sha256: String,
    pub ext: String,
    pub data_b64: String,
    pub planned_rel: String,
    pub reused: bool,
    pub bytes: u64,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ConvertWarning {
    pub code: String,
    pub message: String,
    pub locator: String,
}

#[derive(Serialize, Default, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DocxStats {
    pub words: u64,
    pub images: u64,
    pub tables: u64,
    pub merged_tables: u64,
    pub footnotes: u64,
    pub dropped_textboxes: u64,
    pub math: u64,
    // 批次 F 后续：交叉引用——命中标题目标转内部链接 vs 降级为可见文本 各计数
    pub xref_resolved: u64,
    pub xref_degraded: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocxPreview {
    pub md: String,
    pub planned_doc_rel: String,
    pub title: String,
    pub images: Vec<ImportedImage>,
    pub warnings: Vec<ConvertWarning>,
    pub stats: DocxStats,
}

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CommitImage {
    pub sha256: String,
    pub ext: String,
    pub data_b64: String,
    pub planned_rel: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DocxCommitArgs {
    pub vault_root: String,
    #[allow(dead_code)] // dest_dir 由 doc_rel/planned_rel 隐含，保留以对齐契约
    pub dest_dir: String,
    pub md: String,
    pub doc_rel: String,
    pub images: Vec<CommitImage>,
    pub dedup_index: HashMap<String, String>,
    pub new_title: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DocxCommitResult {
    pub doc_rel: String,
    pub written_images: Vec<String>,
    pub reused_images: Vec<String>,
    pub updated_index: HashMap<String, String>,
}

// ==================== 纯 helper：局部名 / 属性访问 ====================

/// 元素局部名（去命名空间前缀）是否等于 `name`
fn is_el(n: roxmltree::Node, name: &str) -> bool {
    n.is_element() && n.tag_name().name() == name
}

/// 取第一个匹配局部名的直接子元素
fn child<'a, 'input>(n: roxmltree::Node<'a, 'input>, name: &str) -> Option<roxmltree::Node<'a, 'input>> {
    n.children().find(|c| is_el(*c, name))
}

/// `w:val` 之类带 w 前缀的属性
fn wattr<'a, 'input>(n: roxmltree::Node<'a, 'input>, name: &str) -> Option<&'a str> {
    n.attribute((W, name))
}

/// `r:id` / `r:embed` 之类带 r 前缀的属性
fn rattr<'a, 'input>(n: roxmltree::Node<'a, 'input>, name: &str) -> Option<&'a str> {
    n.attribute((R, name))
}

/// 无命名空间属性（rels 的 Id/Type/Target 等）
fn attr0<'a, 'input>(n: roxmltree::Node<'a, 'input>, name: &str) -> Option<&'a str> {
    n.attribute(name)
}

// ---- 命名空间感知 helper（数学解析专用；is_el 只比局部名，OMML 的 m:r/m:t 与 w:r/w:t 撞名，
// 故数学节点必须走以下带命名空间判定的访问，绝不复用 is_el/child）----

/// 元素属于命名空间 `ns` 且局部名 == `name`
fn ns_is(n: roxmltree::Node, ns: &str, name: &str) -> bool {
    n.is_element() && n.tag_name().name() == name && n.tag_name().namespace() == Some(ns)
}

/// OMML（m:）元素判定
fn is_mel(n: roxmltree::Node, name: &str) -> bool {
    ns_is(n, M, name)
}

/// 取第一个 m: 命名空间、指定局部名的直接子元素
fn mchild<'a, 'input>(n: roxmltree::Node<'a, 'input>, name: &str) -> Option<roxmltree::Node<'a, 'input>> {
    n.children().find(|c| is_mel(*c, name))
}

/// 所有 m: 命名空间、指定局部名的直接子元素（文档序）
fn mchildren<'a, 'input>(n: roxmltree::Node<'a, 'input>, name: &str) -> Vec<roxmltree::Node<'a, 'input>> {
    n.children().filter(|c| is_mel(*c, name)).collect()
}

/// m:val 之类带 m 前缀的属性
fn mattr<'a, 'input>(n: roxmltree::Node<'a, 'input>, name: &str) -> Option<&'a str> {
    n.attribute((M, name))
}

// ==================== 关系表 / 编号 / 样式 解析（纯） ====================

struct RelTarget {
    target: String,
    external: bool,
}

/// 解析 `*.rels`：Id -> {Target, TargetMode=External}
fn parse_rels(xml: &str) -> HashMap<String, RelTarget> {
    let mut map = HashMap::new();
    if let Ok(doc) = roxmltree::Document::parse(xml) {
        for node in doc.root().descendants().filter(|n| is_el(*n, "Relationship")) {
            let id = match attr0(node, "Id") {
                Some(i) => i.to_string(),
                None => continue,
            };
            let target = attr0(node, "Target").unwrap_or("").to_string();
            let external = attr0(node, "TargetMode") == Some("External");
            map.insert(id, RelTarget { target, external });
        }
    }
    map
}

/// 解析 `numbering.xml`：numId -> (ilvl -> numFmt)
fn parse_numbering(xml_opt: Option<&str>) -> HashMap<String, HashMap<u32, String>> {
    let mut out: HashMap<String, HashMap<u32, String>> = HashMap::new();
    let xml = match xml_opt {
        Some(x) => x,
        None => return out,
    };
    let doc = match roxmltree::Document::parse(xml) {
        Ok(d) => d,
        Err(_) => return out,
    };
    // abstractNumId -> (ilvl -> fmt)
    let mut abstracts: HashMap<String, HashMap<u32, String>> = HashMap::new();
    for an in doc.root().descendants().filter(|n| is_el(*n, "abstractNum")) {
        let aid = wattr(an, "abstractNumId").unwrap_or("").to_string();
        let mut lvls = HashMap::new();
        for lvl in an.children().filter(|n| is_el(*n, "lvl")) {
            let ilvl: u32 = wattr(lvl, "ilvl").and_then(|v| v.parse().ok()).unwrap_or(0);
            let fmt = child(lvl, "numFmt")
                .and_then(|f| wattr(f, "val"))
                .unwrap_or("bullet")
                .to_string();
            lvls.insert(ilvl, fmt);
        }
        abstracts.insert(aid, lvls);
    }
    // num -> abstractNumId
    for num in doc.root().descendants().filter(|n| is_el(*n, "num")) {
        let nid = wattr(num, "numId").unwrap_or("").to_string();
        let aid = child(num, "abstractNumId")
            .and_then(|a| wattr(a, "val"))
            .unwrap_or("")
            .to_string();
        if let Some(lvls) = abstracts.get(&aid) {
            out.insert(nid, lvls.clone());
        }
    }
    out
}

struct StyleInfo {
    name: String,
    outline: Option<u32>,
    monospace: bool,
}

/// 解析 `styles.xml`：styleId -> StyleInfo（名称 / outlineLvl / 等宽字体）
fn parse_styles(xml_opt: Option<&str>) -> HashMap<String, StyleInfo> {
    let mut out = HashMap::new();
    let xml = match xml_opt {
        Some(x) => x,
        None => return out,
    };
    let doc = match roxmltree::Document::parse(xml) {
        Ok(d) => d,
        Err(_) => return out,
    };
    for st in doc.root().descendants().filter(|n| is_el(*n, "style")) {
        let sid = wattr(st, "styleId").unwrap_or("").to_string();
        if sid.is_empty() {
            continue;
        }
        let name = child(st, "name").and_then(|x| wattr(x, "val")).unwrap_or("").to_string();
        let outline = st
            .descendants()
            .find(|n| is_el(*n, "outlineLvl"))
            .and_then(|n| wattr(n, "val").and_then(|v| v.parse::<u32>().ok()));
        let monospace = st
            .descendants()
            .filter(|n| is_el(*n, "rFonts"))
            .any(|rf| {
                ["ascii", "hAnsi", "cs"]
                    .iter()
                    .any(|k| is_mono_font(wattr(rf, k).unwrap_or("")))
            });
        out.insert(sid, StyleInfo { name, outline, monospace });
    }
    out
}

fn is_mono_font(f: &str) -> bool {
    const MONO: &[&str] = &[
        "consolas", "courier", "courier new", "monaco", "menlo", "mono", "source code",
        "jetbrains", "fira code", "cascadia", "lucida console", "fixedsys",
    ];
    let l = f.to_ascii_lowercase();
    MONO.iter().any(|m| l.contains(m))
}

// ==================== 图片内容哈希（纯） ====================

fn sha256_hex(bytes: &[u8]) -> String {
    let mut h = Sha256::new();
    h.update(bytes);
    let d = h.finalize();
    let mut s = String::with_capacity(64);
    for b in d {
        s.push_str(&format!("{:02x}", b));
    }
    s
}

// ==================== 映射上下文 ====================

struct Ctx<'a> {
    rels: &'a HashMap<String, RelTarget>,
    numbering: &'a HashMap<String, HashMap<u32, String>>,
    styles: &'a HashMap<String, StyleInfo>,
    media: &'a HashMap<String, Vec<u8>>, // zip 内路径(如 "word/media/image1.png") -> 字节
    dedup: &'a HashMap<String, String>,  // sha -> 库内相对路径（命中即引用、不重存）
    doc_dir_rel: String,                 // 本篇 .md 所在目录（相对库根），供图片相对引用
    max_image_bytes: u64,
    // 累积输出
    images: Vec<ImportedImage>,
    img_seen: HashMap<String, ()>, // 单文档内 sha 去重（重复插图收敛为一份）
    warnings: Vec<ConvertWarning>,
    stats: DocxStats,
    // 脚注：footnotes.xml/endnotes.xml 解析出的 id -> 内容；正文引用到的 id 依序收集
    footnote_text: HashMap<String, String>,
    referenced: Vec<String>,
    // 有序列表编号计数器
    ordered: HashMap<String, u32>,
    // 连续列表的最小 ilvl 基准（None 表示当前不在列表中），用于归一化层级
    list_base: Option<u32>,
    // 预扫描产物：Word 书签名 -> `#锚点`。含两类目标：① 标题书签（锚点=标题 slug，编辑器/站点靠标题自动
    // 锚点跳转，无需发 <a id>）；② 被交叉引用命中的非标题书签（图/表/公式/参考文献，锚点=净化后的书签名，
    // 需在目标处发一个字面 `<a id="…"></a>` 作为跳转落点——GFM 行内 HTML，Typora/Obsidian/GitHub 均认）。
    xref_anchor: HashMap<String, String>,
    // 需要「发 <a id>」的非标题被引用书签名集合（标题目标不在此集，故不发）。
    xref_emit: HashSet<String>,
}

impl<'a> Ctx<'a> {
    fn new(
        rels: &'a HashMap<String, RelTarget>,
        numbering: &'a HashMap<String, HashMap<u32, String>>,
        styles: &'a HashMap<String, StyleInfo>,
        media: &'a HashMap<String, Vec<u8>>,
        dedup: &'a HashMap<String, String>,
        doc_dir_rel: String,
        max_image_bytes: u64,
    ) -> Self {
        Ctx {
            rels,
            numbering,
            styles,
            media,
            dedup,
            doc_dir_rel,
            max_image_bytes,
            images: Vec::new(),
            img_seen: HashMap::new(),
            warnings: Vec::new(),
            stats: DocxStats::default(),
            footnote_text: HashMap::new(),
            referenced: Vec::new(),
            ordered: HashMap::new(),
            list_base: None,
            xref_anchor: HashMap::new(),
            xref_emit: HashSet::new(),
        }
    }

    fn warn(&mut self, code: &str, message: &str, locator: &str) {
        self.warnings.push(ConvertWarning {
            code: code.into(),
            message: message.into(),
            locator: locator.into(),
        });
    }
}

// ==================== 块模型与组装 ====================

enum Block {
    Heading(u32, String),
    Para(String),
    ListItem { indent: u32, marker: String, text: String },
    Code(String),
    TableHtml(String),
    Math(String),
}

fn compose(blocks: &[Block]) -> String {
    let mut parts: Vec<String> = Vec::new();
    let mut prev_list = false;
    for b in blocks {
        match b {
            Block::Heading(lv, t) => {
                parts.push(format!("{} {}", "#".repeat((*lv).min(6) as usize), t));
                prev_list = false;
            }
            Block::Para(t) => {
                if !t.trim().is_empty() {
                    parts.push(t.clone());
                }
                prev_list = false;
            }
            Block::Code(body) => {
                parts.push(format!("```\n{}\n```", body.trim_end_matches('\n')));
                prev_list = false;
            }
            Block::TableHtml(html) => {
                parts.push(html.clone());
                prev_list = false;
            }
            Block::Math(latex) => {
                parts.push(format!("$$\n{}\n$$", latex.trim()));
                prev_list = false;
            }
            Block::ListItem { indent, marker, text } => {
                let line = format!("{}{} {}", "  ".repeat(*indent as usize), marker, text);
                if prev_list {
                    if let Some(last) = parts.last_mut() {
                        last.push('\n');
                        last.push_str(&line);
                    }
                } else {
                    parts.push(line);
                }
                prev_list = true;
            }
        }
    }
    parts.join("\n\n")
}

// ==================== 正文映射（纯函数） ====================

/// 从各 XML 片段（document/rels/numbering/styles/footnotes + 媒体）跑完整映射（供纯单测直接调用）
#[cfg(test)]
fn map_parts(
    document_xml: &str,
    rels_xml: &str,
    numbering_xml: &str,
    styles_xml: &str,
    footnotes_xml: &str,
    media: &HashMap<String, Vec<u8>>,
) -> (String, Vec<ConvertWarning>, DocxStats) {
    let rels = parse_rels(rels_xml);
    let numbering = parse_numbering(Some(numbering_xml));
    let styles = parse_styles(Some(styles_xml));
    let doc = roxmltree::Document::parse(document_xml).expect("parse test doc");
    let dedup = HashMap::new();
    let mut ctx = Ctx::new(&rels, &numbering, &styles, media, &dedup, "".into(), u64::MAX);
    if !footnotes_xml.is_empty() {
        collect_notes(Some(footnotes_xml), &mut ctx);
    }
    scan_headings_and_bookmarks(&doc, &mut ctx);
    let blocks = map_body(&doc, &mut ctx);
    let mut md = compose(&blocks);
    let fs = render_footnote_section(&ctx);
    if !fs.is_empty() {
        md = if md.is_empty() { fs } else { format!("{}\n\n{}", md, fs) };
    }
    (md, ctx.warnings, ctx.stats)
}

fn map_body(doc: &roxmltree::Document, ctx: &mut Ctx) -> Vec<Block> {
    let mut blocks = Vec::new();
    let body = doc.root_element().children().find(|n| is_el(*n, "body"));
    let body = match body {
        Some(b) => b,
        None => return blocks,
    };
    push_children_blocks(body, ctx, &mut blocks);
    blocks
}

/// 依次把 parent 的块级子节点映射为块：p→段落、tbl→表格、sdt→透明展开其 sdtContent（递归，
/// 使被内容控件包裹的段落/表格不丢失，如简历模板里的分节标题）。其余（sectPr 等）忽略。
fn push_children_blocks(parent: roxmltree::Node, ctx: &mut Ctx, blocks: &mut Vec<Block>) {
    for node in parent.children() {
        if is_el(node, "p") {
            push_paragraph(node, ctx, blocks);
        } else if is_el(node, "tbl") {
            push_table(node, ctx, blocks);
        } else if is_el(node, "sdt") {
            if is_toc_sdt(node) {
                ctx.warn("toc", "目录域已按可见文本降级（域码不执行）", "sdt");
            }
            if let Some(c) = child(node, "sdtContent") {
                push_children_blocks(c, ctx, blocks);
            }
        }
    }
}

// ==================== 交叉引用预扫描（批次 F 后续）====================

/// 标题纯文本：拼接段内所有 `w:t`（零副作用）。因 slug 丢弃标点，且链接 URL / 脚注 id / 上下标降级符号
/// 都不进入此串或本就被 slug 忽略，故与「编辑器 / site 从写出的 md 反算的标题纯文本」**必然同 slug**。
fn plain_text_wt(p: roxmltree::Node) -> String {
    let mut s = String::new();
    for d in p.descendants() {
        if ns_is(d, W, "t") {
            s.push_str(d.text().unwrap_or(""));
        }
    }
    s.trim().to_string()
}

/// 段落是否为标题（**复刻** `push_paragraph` 的 style 判定：outline 或 name 前缀 `heading `）。
fn heading_level(p: roxmltree::Node, ctx: &Ctx) -> Option<u32> {
    let ppr = child(p, "pPr");
    let style_id = ppr
        .and_then(|pp| child(pp, "pStyle"))
        .and_then(|s| wattr(s, "val").map(|x| x.to_string()));
    let st = style_id.as_ref().and_then(|id| ctx.styles.get(id))?;
    if let Some(o) = st.outline {
        return Some(o + 1);
    }
    let n = st.name.to_ascii_lowercase();
    n.strip_prefix("heading ").and_then(|rest| rest.trim().parse::<u32>().ok())
}

/// 收集段内所有 `bookmarkStart@w:name`（书签落在标题段内 → 该段即其跳转目标）。
fn bookmark_names(p: roxmltree::Node) -> Vec<String> {
    p.descendants()
        .filter(|n| is_el(*n, "bookmarkStart"))
        .filter_map(|n| wattr(n, "name").map(|s| s.to_string()))
        .collect()
}

/// 解析域码 `REF`/`PAGEREF`/`NOTEREF` 的目标书签名。形如 ` REF _Ref123 \h \* MERGEFORMAT ` 或 ` REF "名" \h `。
fn parse_xref_target(instr: &str) -> Option<String> {
    let mut it = instr.trim().split_whitespace();
    let field = it.next()?.to_ascii_uppercase();
    if !matches!(field.as_str(), "REF" | "PAGEREF" | "NOTEREF") {
        return None;
    }
    let name = it.next()?.trim_matches('"');
    if name.is_empty() {
        None
    } else {
        Some(name.to_string())
    }
}

/// 预扫描：顺序遍历正文（含 sdt 递归，与 `push_children_blocks` 同域），收集每个非空标题的纯文本与其
/// 书签名，用 `assign_anchors` 依文档序算锚点，登记 书签名 -> `#锚点` 到 ctx.xref_anchor。**必须早于 map_body**（前向引用）。
/// 有序表含**所有**非空标题（非仅带书签者），以保证 dedup 后缀与编辑器读到的整篇标题序一致。
fn scan_headings_and_bookmarks(doc: &roxmltree::Document, ctx: &mut Ctx) {
    let body = match doc.root_element().children().find(|n| is_el(*n, "body")) {
        Some(b) => b,
        None => return,
    };
    let mut ordered: Vec<(String, Vec<String>)> = Vec::new(); // (标题纯文本, 该段书签名)
    collect_heading_scan(body, ctx, &mut ordered);
    let plains: Vec<String> = ordered.iter().map(|(t, _)| t.clone()).collect();
    let anchors = assign_anchors(&plains);
    for ((_, names), anchor) in ordered.iter().zip(anchors.into_iter()) {
        for name in names {
            ctx.xref_anchor.insert(name.clone(), format!("#{anchor}"));
        }
    }
    // 第二遍：登记「被交叉引用命中、但不在标题上」的书签 → 分配锚点并标记需发 <a id>。
    // 来源三处（与收口侧 finalize_xref 一致）：instrText 域码、fldSimple@instr、hyperlink@w:anchor。
    scan_referenced_nonheading_anchors(body, ctx);
}

/// 书签名 → 可安全用作 HTML id / URL fragment 的锚点：仅保留 `[A-Za-z0-9_-]`，其余字符丢弃；
/// 结果为空则回退 `ref`。Word 自动生成的引用书签多为 `_RefNNN`，本就全在保留集内，此处主要兜底外部书签。
fn sanitize_anchor(name: &str) -> String {
    let mut s: String = name
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '_' || *c == '-')
        .collect();
    if s.is_empty() {
        s.push_str("ref");
    }
    s
}

/// 收集正文中被 REF/PAGEREF/NOTEREF 域或内部锚点超链接**引用到**的书签名（按文档序去重），
/// 对其中「已存在于正文（有对应 bookmarkStart）、又未命中任何标题」（不在 ctx.xref_anchor）者分配净化后的
/// 唯一锚点、登记进 xref_anchor（令 finalize_xref 能解析）并记入 xref_emit（令目标处发 `<a id>`）。
/// 目标书签不存在（无 bookmarkStart）→不登记，finalize_xref 仍降级为可见文本；标题目标已在表→跳过不发。
fn scan_referenced_nonheading_anchors(body: roxmltree::Node, ctx: &mut Ctx) {
    let mut referenced: Vec<String> = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    let mut present: HashSet<String> = HashSet::new(); // 正文中存在 bookmarkStart 的全部书签名
    let push_name = |name: String, referenced: &mut Vec<String>, seen: &mut HashSet<String>| {
        if seen.insert(name.clone()) {
            referenced.push(name);
        }
    };
    for n in body.descendants() {
        if is_el(n, "bookmarkStart") {
            if let Some(nm) = wattr(n, "name") {
                present.insert(nm.to_string());
            }
        } else if is_el(n, "instrText") {
            if let Some(t) = n.text() {
                if let Some(name) = parse_xref_target(t) {
                    push_name(name, &mut referenced, &mut seen);
                }
            }
        } else if is_el(n, "fldSimple") {
            if let Some(instr) = wattr(n, "instr") {
                if let Some(name) = parse_xref_target(instr) {
                    push_name(name, &mut referenced, &mut seen);
                }
            }
        } else if is_el(n, "hyperlink") {
            if let Some(a) = wattr(n, "anchor") {
                let name = a.to_string();
                if !name.is_empty() {
                    push_name(name, &mut referenced, &mut seen);
                }
            }
        }
    }
    // 分配锚点：仅处理「正文中存在、且未命中标题」的引用目标（同名净化冲突按计数 dedup `-1`/`-2` 保证唯一）。
    let mut used: HashMap<String, u32> = HashMap::new();
    for name in referenced {
        if !present.contains(&name) {
            continue; // 目标书签不存在：保持降级行为（不造无落点的悬链接）
        }
        if ctx.xref_anchor.contains_key(&name) {
            continue; // 标题书签：沿用标题 slug 锚点，不发 <a id>
        }
        let base = sanitize_anchor(&name);
        let cnt = used.entry(base.clone()).or_insert(0);
        let id = if *cnt == 0 { base.clone() } else { format!("{base}-{cnt}") };
        *cnt += 1;
        ctx.xref_anchor.insert(name.clone(), format!("#{id}"));
        ctx.xref_emit.insert(name);
    }
}

fn collect_heading_scan(parent: roxmltree::Node, ctx: &Ctx, out: &mut Vec<(String, Vec<String>)>) {
    for node in parent.children() {
        if is_el(node, "p") {
            if heading_level(node, ctx).is_some() {
                let plain = plain_text_wt(node);
                if !plain.is_empty() {
                    out.push((plain, bookmark_names(node)));
                }
            }
        } else if is_el(node, "sdt") {
            if let Some(c) = child(node, "sdtContent") {
                collect_heading_scan(c, ctx, out);
            }
        }
    }
}

fn is_toc_sdt(sdt: roxmltree::Node) -> bool {
    sdt.descendants().any(|n| {
        is_el(n, "docPartGallery") && wattr(n, "val").map(|v| v.eq_ignore_ascii_case("Table of Contents")).unwrap_or(false)
    })
}

/// 段落 -> Heading / ListItem / Code / Para（可能产出多块：文本框内容）
fn push_paragraph(p: roxmltree::Node, ctx: &mut Ctx, blocks: &mut Vec<Block>) {
    let ppr = child(p, "pPr");

    // 文本框（w:txbxContent）优先：内层段落顺序输出 + warning（位置/浮动丢失）
    let txbx: Vec<roxmltree::Node> = p.descendants().filter(|n| is_el(*n, "txbxContent")).collect();
    if !txbx.is_empty() {
        for tb in &txbx {
            for ip in tb.children().filter(|n| is_el(*n, "p")) {
                let text = map_inline(ip, ctx);
                if !text.trim().is_empty() {
                    ctx.stats.dropped_textboxes += 1;
                    blocks.push(Block::Para(text));
                }
            }
        }
        ctx.warn("textbox", "文本框内容已按顺序段落输出（位置/浮动信息丢失）", "txbxContent");
        return;
    }

    let style_id = ppr.and_then(|pp| child(pp, "pStyle")).and_then(|s| wattr(s, "val").map(|x| x.to_string()));
    let style = style_id.as_ref().and_then(|id| ctx.styles.get(id));

    // 标题
    let heading: Option<u32> = style.and_then(|st| {
        if let Some(o) = st.outline {
            return Some(o + 1);
        }
        let n = st.name.to_ascii_lowercase();
        if let Some(rest) = n.strip_prefix("heading ") {
            return rest.trim().parse::<u32>().ok();
        }
        None
    });
    if let Some(lv) = heading {
        let text = map_inline(p, ctx);
        if !text.trim().is_empty() {
            ctx.ordered.clear(); ctx.list_base = None;
            blocks.push(Block::Heading(lv, text.trim().to_string()));
            return;
        }
    }

    // 块级公式：段落含 m:oMathPara 且无正文文本（w:t）→ 独立 $$..$$（置于等宽/列表前，
    // 避开 para_all_runs_mono 把 m:r 误当 run）。
    if let Some(omp) = mchild(p, "oMathPara") {
        let has_text = p
            .descendants()
            .any(|d| ns_is(d, W, "t") && !d.text().unwrap_or("").trim().is_empty());
        if !has_text {
            let latex = omml_para_to_latex(omp, ctx);
            if !latex.trim().is_empty() {
                ctx.ordered.clear(); ctx.list_base = None;
                blocks.push(Block::Math(latex));
                return;
            }
        }
    }

    // 等宽样式段落 -> 代码行（启发式；与上一块 Code 合并）。
    // 护栏：含中文正文的段落绝不判为代码块——等宽字体启发式对中文论文正文会整段误判
    //（真实回归：一篇学位论文的纯散文段落因正文用等宽字体被误转成围栏代码）。
    let has_cjk_text = p
        .descendants()
        .any(|d| ns_is(d, W, "t") && has_cjk(d.text().unwrap_or("")));
    let monospace = !has_cjk_text
        && (style.map(|st| st.monospace).unwrap_or(false) || para_all_runs_mono(p, ctx));
    if monospace {
        let text = map_inline(p, ctx);
        if let Some(Block::Code(prev)) = blocks.last_mut() {
            prev.push('\n');
            prev.push_str(&strip_markdown_for_code(&text));
            return;
        } else if !text.trim().is_empty() {
            blocks.push(Block::Code(strip_markdown_for_code(&text)));
            return;
        }
    }

    // 列表
    if let Some(numpr) = ppr.and_then(|pp| child(pp, "numPr")) {
        let ilvl: u32 = child(numpr, "ilvl").and_then(|n| wattr(n, "val").and_then(|v| v.parse().ok())).unwrap_or(0);
        let num_id = child(numpr, "numId").and_then(|n| wattr(n, "val")).unwrap_or("").to_string();
        let fmt = ctx
            .numbering
            .get(&num_id)
            .and_then(|m| m.get(&ilvl))
            .cloned()
            .unwrap_or_else(|| "bullet".into());
        let text = map_inline(p, ctx);
        if text.trim().is_empty() {
            return;
        }
        let marker = if fmt == "bullet" || fmt == "none" {
            "-".to_string()
        } else {
            let key = format!("{}-{}", num_id, ilvl);
            let n = ctx.ordered.entry(key).or_insert(0);
            *n += 1;
            format!("{}.", n)
        };
        // 归一化列表层级：以连续列表的最小 ilvl 为基准 → 每段连续列表最浅项 depth=0，故绝不会
        // 出现“孤立 ≥4 空格起始行”（缩进代码块只在**无列表标记**的行触发；列表行恒带 `-`/`1.` 标记，
        // 2 空格/级的缩进被 Markdown 当作子列表嵌套而非代码）。故不封顶深度（批次 F 后续：多级列表）。
        let base = match ctx.list_base { Some(b) => b.min(ilvl), None => ilvl };
        ctx.list_base = Some(base);
        let depth = ilvl.saturating_sub(base);
        blocks.push(Block::ListItem { indent: depth, marker, text: text.trim().to_string() });
        return;
    }

    // 普通段落（或以字面项目符号起始 → 规整为无序列表项）
    ctx.ordered.clear(); ctx.list_base = None;
    let text = map_inline(p, ctx);
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return;
    }
    if let Some(rest) = strip_bullet_marker(trimmed) {
        let rest = rest.trim();
        if !rest.is_empty() {
            blocks.push(Block::ListItem { indent: 0, marker: "-".to_string(), text: rest.to_string() });
            return;
        }
    }
    blocks.push(Block::Para(trimmed.to_string()));
}

/// 去掉行首的字面项目符号（Word 里很多“伪列表”其实是手打的 • · ‣ 等字符，非真 numPr 列表）。
fn strip_bullet_marker(s: &str) -> Option<&str> {
    for b in ['\u{2022}', '\u{00B7}', '\u{2023}', '\u{25E6}', '\u{25AA}', '\u{25B8}', '\u{25CF}', '\u{25CB}'] {
        if let Some(rest) = s.strip_prefix(b) {
            return Some(rest.trim_start());
        }
    }
    None
}

fn para_all_runs_mono(p: roxmltree::Node, ctx: &Ctx) -> bool {
    let runs: Vec<_> = p.descendants().filter(|n| is_el(*n, "r")).collect();
    if runs.is_empty() {
        return false;
    }
    runs.iter().all(|r| {
        let rp = child(*r, "rPr");
        rp.map(|rp| {
            rp.descendants().filter(|n| is_el(*n, "rFonts")).any(|rf| is_mono_font(wattr(rf, "ascii").unwrap_or("")))
                || child(rp, "rStyle")
                    .and_then(|s| wattr(s, "val").map(|v| v.to_string()))
                    .and_then(|id| ctx.styles.get(&id))
                    .map(|st| st.monospace)
                    .unwrap_or(false)
        })
        .unwrap_or(false)
    })
}

/// 去掉行内 markdown 标记，用于把等宽段落并入围栏代码块（代码不该带 ** _ 等）
fn strip_markdown_for_code(s: &str) -> String {
    let mut out = String::new();
    out.push_str(s);
    for pat in ["**", "~~", "`", "*"] {
        out = out.replace(pat, "");
    }
    out
}

// ==================== 子项目②：OMML → LaTeX（数学解析，纯函数） ====================
// Word 公式以 OMML（m: 命名空间）存于 document.xml。此处递归映射为 LaTeX。
// 关键约束：OMML 的 m:r/m:t 与 Word 的 w:r/w:t 局部名相同，故一律走 is_mel/mchild/mchildren/mattr
// 命名空间感知访问；绝不把数学节点交给通用 map_run/mergeable_run（它们按 w: 语义解释）。

/// 顶层：把一个 m:oMath 的内容拼为行内 LaTeX（无裸换行）。每调用一次计一次 stats.math。
fn omml_to_latex(n: roxmltree::Node, ctx: &mut Ctx) -> String {
    ctx.stats.math += 1;
    collapse_ws(&omml_contents(n, ctx))
}

/// oMathPara 可含多个 oMath（多式）：逐个转 LaTeX，以换行分隔。
fn omml_para_to_latex(omp: roxmltree::Node, ctx: &mut Ctx) -> String {
    let maths = mchildren(omp, "oMath");
    if maths.is_empty() {
        return omml_contents(omp, ctx);
    }
    let parts: Vec<String> = maths.iter().map(|m| omml_to_latex(*m, ctx)).collect();
    parts.join("\n")
}

/// 连接节点所有元素子节点（文档序）的 LaTeX —— 用于操作数槽与降级拼接。
fn omml_contents(n: roxmltree::Node, ctx: &mut Ctx) -> String {
    let mut s = String::new();
    for c in n.children() {
        if c.is_element() {
            s.push_str(&omml_node_to_latex(c, ctx));
        }
    }
    s
}

/// 取某操作数槽（可缺失）的内容 LaTeX。
fn omml_slot(n: Option<roxmltree::Node>, ctx: &mut Ctx) -> String {
    match n {
        Some(x) => omml_contents(x, ctx),
        None => String::new(),
    }
}

/// 折叠连续空白/换行为单空格（行内数学不允许裸换行）。
fn collapse_ws(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut last_ws = false;
    for ch in s.chars() {
        if ch == ' ' || ch == '\n' || ch == '\t' || ch == '\r' {
            if !last_ws {
                out.push(' ');
                last_ws = true;
            }
        } else {
            out.push(ch);
            last_ws = false;
        }
    }
    out.trim().to_string()
}

/// 分派：已知 m: 构造映射为 LaTeX；未知 m: 容器降级为内容拼接 + warning；非 m:（属性/w:）忽略。
fn omml_node_to_latex(n: roxmltree::Node, ctx: &mut Ctx) -> String {
    if !n.is_element() {
        return String::new();
    }
    if n.tag_name().namespace() != Some(M) {
        return String::new(); // 属性元素（w:rPr 等）不含数学内容
    }
    match n.tag_name().name() {
        "r" => omml_run_to_latex(n),
        "e" => omml_contents(n, ctx), // 独立成组（少见）
        "f" => {
            let num = omml_slot(mchild(n, "num"), ctx);
            let den = omml_slot(mchild(n, "den"), ctx);
            format!("\\frac{{{}}}{{{}}}", num, den)
        }
        "sSup" => {
            let e = omml_slot(mchild(n, "e"), ctx);
            let sup = omml_slot(mchild(n, "sup"), ctx);
            format!("{{{}}}^{{{}}}", e, sup)
        }
        "sSub" => {
            let e = omml_slot(mchild(n, "e"), ctx);
            let sub = omml_slot(mchild(n, "sub"), ctx);
            format!("{{{}}}_{{{}}}", e, sub)
        }
        "sSubSup" => {
            let e = omml_slot(mchild(n, "e"), ctx);
            let sub = omml_slot(mchild(n, "sub"), ctx);
            let sup = omml_slot(mchild(n, "sup"), ctx);
            format!("{{{}}}_{{{}}}^{{{}}}", e, sub, sup)
        }
        "rad" => {
            let hide = mchild(n, "radPr")
                .and_then(|pr| mchild(pr, "degHide"))
                .map(|d| !matches!(mattr(d, "val").unwrap_or("1"), "0" | "false"))
                .unwrap_or(false);
            let e = omml_slot(mchild(n, "e"), ctx);
            if hide {
                format!("\\sqrt{{{}}}", e)
            } else {
                let deg = omml_slot(mchild(n, "deg"), ctx);
                format!("\\sqrt[{}]{{{}}}", deg, e)
            }
        }
        "nary" => omml_nary_to_latex(n, ctx),
        "d" => omml_delim_to_latex(n, ctx),
        "acc" => {
            let chr = mchild(n, "accPr")
                .and_then(|pr| mchild(pr, "chr"))
                .and_then(|c| mattr(c, "val").map(|s| s.to_string()))
                .unwrap_or_else(|| "\u{302}".to_string());
            let e = omml_slot(mchild(n, "e"), ctx);
            match accent_cmd(&chr) {
                Some(cmd) => format!("{}{{{}}}", cmd, e),
                None => {
                    ctx.warn("math", &format!("未知重音字符 {:?}，已原样前置", chr), "acc");
                    format!("{}{}", chr, e)
                }
            }
        }
        "func" => {
            let fname = omml_slot(mchild(n, "fName"), ctx);
            let e = omml_slot(mchild(n, "e"), ctx);
            format!("{} {}", omml_func_name(&fname), e)
        }
        "limLow" => {
            let e = omml_slot(mchild(n, "e"), ctx);
            let lim = omml_slot(mchild(n, "lim"), ctx);
            if e.trim() == "lim" {
                format!("\\lim_{{{}}}", lim)
            } else {
                format!("\\underset{{{}}}{{{}}}", lim, e)
            }
        }
        "limUpp" => {
            let e = omml_slot(mchild(n, "e"), ctx);
            let lim = omml_slot(mchild(n, "lim"), ctx);
            format!("\\overset{{{}}}{{{}}}", lim, e)
        }
        "m" => format!("\\begin{{matrix}}{}\\end{{matrix}}", omml_matrix_body(n, ctx)),
        "eqArr" => format!("\\begin{{cases}}{}\\end{{cases}}", omml_eqarr_body(n, ctx)),
        "bar" => {
            let pos = mchild(n, "barPr")
                .and_then(|pr| mchild(pr, "pos"))
                .and_then(|p| mattr(p, "val").map(|s| s.to_string()))
                .unwrap_or_else(|| "barOver".to_string());
            let e = omml_slot(mchild(n, "e"), ctx);
            if pos == "barUnder" {
                format!("\\underline{{{}}}", e)
            } else {
                format!("\\overline{{{}}}", e)
            }
        }
        "groupChr" => {
            let chr = mchild(n, "groupChrPr")
                .and_then(|pr| mchild(pr, "chr"))
                .and_then(|c| mattr(c, "val").map(|s| s.to_string()))
                .unwrap_or_default();
            let e = omml_slot(mchild(n, "e"), ctx);
            if chr.chars().next() == Some('\u{23DF}') {
                format!("\\underbrace{{{}}}", e)
            } else {
                format!("\\overbrace{{{}}}", e)
            }
        }
        "borderBox" | "box" => {
            let e = omml_slot(mchild(n, "e"), ctx);
            format!("\\boxed{{{}}}", e)
        }
        other => {
            ctx.warn("math", &format!("OMML 构造 m:{} 未支持，已降级为内容拼接", other), other);
            omml_contents(n, ctx)
        }
    }
}

/// 转义字面文本里的 LaTeX 特殊字符（数学模式下这些字符有语法含义或非法，来自 m:t 时均为字面）。
/// 不转义 `+ - = ( ) , | < >` 等（它们在数学模式合法）。
fn escape_math_text(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for ch in s.chars() {
        match ch {
            '#' | '%' | '&' | '_' | '{' | '}' | '$' => {
                out.push('\\');
                out.push(ch);
            }
            '\\' => out.push_str("\\backslash "),
            c => out.push(c),
        }
    }
    out
}

/// 是否含 CJK / 全角字符（判定一个 run 是否为文本标签）。
fn has_cjk(s: &str) -> bool {
    s.chars().any(|c| {
        matches!(c as u32,
            0x2E80..=0x2FFF | 0x3000..=0x303F | 0x3400..=0x4DBF | 0x4E00..=0x9FFF
            | 0xF900..=0xFAFF | 0xFF00..=0xFFEF)
    })
}

/// m:r → LaTeX：取所有 m:t 文本拼接；依 rPr 的 nor/scr/sty 包基命令。
fn omml_run_to_latex(n: roxmltree::Node) -> String {
    let rpr = mchild(n, "rPr");
    let nor = rpr.and_then(|x| mchild(x, "nor")).is_some();
    let sty = rpr.and_then(|x| mchild(x, "sty")).and_then(|s| mattr(s, "val").map(|v| v.to_string()));
    let scr = rpr.and_then(|x| mchild(x, "scr")).and_then(|s| mattr(s, "val").map(|v| v.to_string()));
    let mut raw = String::new();
    for c in n.children() {
        if is_mel(c, "t") {
            raw.push_str(c.text().unwrap_or(""));
        }
    }
    // m:t 是字面文本：LaTeX 特殊字符必须转义，否则 KaTeX 报错（如 # 会断整个数学区间）。
    let text = escape_math_text(&raw);
    if text.is_empty() {
        return String::new();
    }
    // 含 CJK 的 run 属于文本标签（如公式编号“#式(3.16)”），包 \text{} 避免“数学模式用 Unicode 文本”告警。
    if has_cjk(&text) {
        return format!("\\text{{{}}}", text);
    }
    if nor {
        format!("\\mathrm{{{}}}", text)
    } else if let Some(s) = scr {
        match s.as_str() {
            "doubleStruck" => format!("\\mathbb{{{}}}", text),
            "script" => format!("\\mathcal{{{}}}", text),
            "fraktur" => format!("\\mathfrak{{{}}}", text),
            _ => text,
        }
    } else if sty.as_deref() == Some("b") {
        format!("\\mathbf{{{}}}", text)
    } else {
        text
    }
}

/// m:nary：大运算符（∑∫∏…）+ 可选上下限（hideSub/hideSup 省略）。
fn omml_nary_to_latex(n: roxmltree::Node, ctx: &mut Ctx) -> String {
    let pr = mchild(n, "naryPr");
    let chr = pr
        .and_then(|p| mchild(p, "chr"))
        .and_then(|c| mattr(c, "val").map(|s| s.to_string()))
        .unwrap_or_else(|| "\u{222B}".to_string());
    let hide = |nm: &str| {
        pr.and_then(|p| mchild(p, nm))
            .map(|d| !matches!(mattr(d, "val").unwrap_or("1"), "0" | "false"))
            .unwrap_or(false)
    };
    let op = nary_cmd(&chr);
    let sub = omml_slot(mchild(n, "sub"), ctx);
    let sup = omml_slot(mchild(n, "sup"), ctx);
    let e = omml_slot(mchild(n, "e"), ctx);
    let mut s = op;
    if !hide("hideSub") && !sub.is_empty() {
        s.push_str(&format!("_{{{}}}", sub));
    }
    if !hide("hideSup") && !sup.is_empty() {
        s.push_str(&format!("^{{{}}}", sup));
    }
    s.push(' ');
    s.push_str(&e);
    s
}

/// m:d：定界符；单 e 内恰一个 m:m → 按定界符选矩阵环境；否则 \left..\right。
fn omml_delim_to_latex(n: roxmltree::Node, ctx: &mut Ctx) -> String {
    let pr = mchild(n, "dPr");
    let chr_of = |nm: &str, def: &str| {
        pr.and_then(|p| mchild(p, nm))
            .and_then(|c| mattr(c, "val").map(|s| s.to_string()))
            .unwrap_or_else(|| def.to_string())
    };
    let beg = norm_delim(&chr_of("begChr", "("));
    let end = norm_delim(&chr_of("endChr", ")"));
    let sep = chr_of("sepChr", ",");
    let es = mchildren(n, "e");
    if es.len() == 1 {
        let inner: Vec<_> = es[0].children().filter(|c| c.is_element()).collect();
        if inner.len() == 1 && is_mel(inner[0], "m") {
            let env = matrix_env(&beg, &end);
            let body = omml_matrix_body(inner[0], ctx);
            return format!("\\begin{{{}}}{}\\end{{{}}}", env, body, env);
        }
    }
    let parts: Vec<String> = es.iter().map(|e| omml_contents(*e, ctx)).collect();
    let inner = parts.join(&format!("{} ", sep));
    format!("\\left{} {} \\right{}", delim_latex(&beg), inner, delim_latex(&end))
}

fn omml_matrix_body(n: roxmltree::Node, ctx: &mut Ctx) -> String {
    let rows = mchildren(n, "mr");
    let rl: Vec<String> = rows
        .iter()
        .map(|r| {
            let cells: Vec<String> = mchildren(*r, "e").iter().map(|c| omml_contents(*c, ctx)).collect();
            cells.join(" & ")
        })
        .collect();
    format!(" {} ", rl.join(" \\\\ "))
}

fn omml_eqarr_body(n: roxmltree::Node, ctx: &mut Ctx) -> String {
    let rl: Vec<String> = mchildren(n, "e").iter().map(|e| omml_contents(*e, ctx)).collect();
    format!(" {} ", rl.join(" \\\\ "))
}

// ---- 字符/名称映射 ----

fn nary_cmd(chr: &str) -> String {
    let s = match chr {
        "\u{2211}" => "\\sum",
        "\u{220F}" => "\\prod",
        "\u{2210}" => "\\coprod",
        "\u{222B}" => "\\int",
        "\u{222C}" => "\\iint",
        "\u{222D}" => "\\iiint",
        "\u{222E}" => "\\oint",
        "\u{22C0}" => "\\bigwedge",
        "\u{22C1}" => "\\bigvee",
        "\u{22C2}" => "\\bigcap",
        "\u{22C3}" => "\\bigcup",
        "\u{2A01}" => "\\bigoplus",
        "\u{2A02}" => "\\bigotimes",
        "\u{2A04}" => "\\biguplus",
        _ => "",
    };
    if s.is_empty() {
        chr.to_string()
    } else {
        s.to_string()
    }
}

fn accent_cmd(chr: &str) -> Option<&'static str> {
    match chr {
        "\u{302}" => Some("\\hat"),
        "\u{303}" => Some("\\tilde"),
        "\u{304}" | "\u{305}" | "\u{203E}" | "\u{FFE}" => Some("\\bar"),
        "\u{2D9}" => Some("\\dot"),
        "\u{A8}" | "\u{20DC}" => Some("\\ddot"),
        "\u{20D7}" | "\u{2192}" => Some("\\vec"),
        _ => None,
    }
}

/// 全角/CJK 定界符归一化为 KaTeX 可识别的半角/标准形式。
/// Word 里中文输入法常打出全角括号（），若不归一化 \left／\right 会拿到非法定界符而报错。
fn norm_delim(c: &str) -> String {
    let s = match c {
        "\u{FF08}" => "(",           // （
        "\u{FF09}" => ")",           // ）
        "\u{FF3B}" => "[",           // ［
        "\u{FF3D}" => "]",           // ］
        "\u{FF5B}" => "{",           // ｛
        "\u{FF5D}" => "}",           // ｝
        "\u{3010}" | "\u{3014}" => "[", // 【 〔
        "\u{3011}" | "\u{3015}" => "]", // 】 〕
        "\u{3008}" => "\u{27E8}",    // 〈 → ⟨
        "\u{3009}" => "\u{27E9}",    // 〉 → ⟩
        "\u{FF5C}" => "|",           // ｜
        other => return other.to_string(),
    };
    s.to_string()
}

fn delim_latex(c: &str) -> String {
    match c {
        "" => ".".to_string(),
        "(" | ")" | "[" | "]" | "|" => c.to_string(),
        "{" => "\\{".to_string(),
        "}" => "\\}".to_string(),
        "\u{27E8}" => "\\langle".to_string(),
        "\u{27E9}" => "\\rangle".to_string(),
        other => other.to_string(),
    }
}

fn matrix_env(beg: &str, end: &str) -> &'static str {
    match (beg, end) {
        ("(", ")") => "pmatrix",
        ("[", "]") => "bmatrix",
        ("{", "}") => "Bmatrix",
        ("|", "|") => "vmatrix",
        ("\u{27E8}", "\u{27E9}") => "Vmatrix",
        _ => "matrix",
    }
}

fn omml_func_name(raw: &str) -> String {
    let t = raw.trim();
    let cmd = match t {
        "sin" => "\\sin", "cos" => "\\cos", "tan" => "\\tan", "cot" => "\\cot",
        "sec" => "\\sec", "csc" => "\\csc", "arcsin" => "\\arcsin", "arccos" => "\\arccos",
        "arctan" => "\\arctan", "sinh" => "\\sinh", "cosh" => "\\cosh", "tanh" => "\\tanh",
        "log" => "\\log", "ln" => "\\ln", "lim" => "\\lim", "limsup" => "\\limsup",
        "liminf" => "\\liminf", "max" => "\\max", "min" => "\\min", "sup" => "\\sup",
        "inf" => "\\inf", "det" => "\\det", "dim" => "\\dim", "gcd" => "\\gcd", "Pr" => "\\Pr",
        _ => "",
    };
    if cmd.is_empty() {
        format!("\\mathrm{{{}}}", t)
    } else {
        cmd.to_string()
    }
}

/// 段落内联映射：按文档序处理 runs / hyperlink / fldSimple / ins；返回 markdown 行内串
fn map_inline(p: roxmltree::Node, ctx: &mut Ctx) -> String {
    let mut out = String::new();
    map_inline_children(p, ctx, &mut out);
    out
}

/// 复杂域状态：一个已打开的 Word 域（`fldChar begin` … `end`）。`collecting=false` 表示正处于
/// begin..separate 的**域码区**（收集 instr）；`true` 表示已过 separate、正处于**结果区**。
/// `pre` 暂存域码区里出现的普通文本 run：若该域**有** separate，pre 属域码丢弃；若**无** separate
/// （Word 自动编号 SEQ / 部分交叉引用域的常见写法），则这些普通 run 就是缓存结果，收口时取用。
struct OpenField {
    instr: String,
    result: String,
    pre: String,
    collecting: bool,
}

/// 把一段产物路由到输出：若当前仍在某外层域内（嵌套域），并入该域的结果区（有 separate）或 pre 暂存区
/// （无 separate）；否则追加到 out。
fn push_inline(fields: &mut Vec<OpenField>, out: &mut String, s: String) {
    if s.is_empty() {
        return;
    }
    if let Some(f) = fields.last_mut() {
        if f.collecting {
            f.result.push_str(&s);
        } else {
            f.pre.push_str(&s);
        }
        return;
    }
    out.push_str(&s);
}

/// 交叉引用收口（复杂域 end / fldSimple / 内部锚点超链接 三处共用）：域码解析出 REF/PAGEREF/NOTEREF
/// 目标书签名 → 命中锚点（标题 slug 或被引用的非标题 `<a id>`）则包成 `[结果](#锚点)` 并计 resolved；
/// 目标书签在正文中不存在（预扫描未登记）则降级为可见文本 + `xref` 告警并计 degraded；
/// 非引用域（PAGE/DATE/TOC 等）原样返回结果文本。
fn finalize_xref(instr: &str, text: &str, ctx: &mut Ctx) -> String {
    if let Some(name) = parse_xref_target(instr) {
        if let Some(anchor) = ctx.xref_anchor.get(&name) {
            ctx.stats.xref_resolved += 1;
            let label = if text.trim().is_empty() { anchor.trim_start_matches('#') } else { text };
            return format!("[{}]({})", label, anchor);
        }
        // 目标书签正文中不存在（既未命中标题、也无被登记的 bookmarkStart）：降级为可见文本 + 告警
        ctx.stats.xref_degraded += 1;
        ctx.warn("xref", "交叉引用目标书签未找到，已降级为可见文本", instr);
    }
    text.to_string()
}

/// 行内映射：按文档序处理 parent 的行内子节点，追加到 out。对 hyperlink / fldSimple / ins /
/// smartTag / sdt 递归展开，使被内联内容控件（w:sdt）包裹的 run 不丢失（如模板里的分节标题）。
/// 相邻且强调格式完全一致的纯文本 run 会被合并（Word 常按 rsid 把一句加粗切成多段 run，
/// 逐段包裹会得到 **a****b** 这种碎片）。
/// 批次 F 后续：新增**复杂域状态机**——`fldChar begin/separate/end` + `instrText` 分域码区/结果区，
/// 域码绝不泄漏为正文；结果若为 REF/PAGEREF/NOTEREF 且命中标题锚点 → `[文本](#锚点)`。非引用域行为原样不变。
fn map_inline_children(parent: roxmltree::Node, ctx: &mut Ctx, out: &mut String) {
    let mut pending: Option<(u32, String)> = None; // (强调签名, 累积原文)
    let mut fields: Vec<OpenField> = Vec::new(); // 复杂域栈（支持嵌套）
    for node in parent.children() {
        if is_el(node, "pPr") {
            continue;
        } else if is_el(node, "r") {
            // 域标记优先：fldChar / instrText 不是正文，先于普通 run 判定
            let fc = node
                .children()
                .find(|c| is_el(*c, "fldChar"))
                .and_then(|c| wattr(c, "fldCharType"))
                .map(|s| s.to_string());
            if let Some(kind) = fc {
                flush_pending(&mut pending, out);
                match kind.as_str() {
                    "begin" => fields.push(OpenField { instr: String::new(), result: String::new(), pre: String::new(), collecting: false }),
                    "separate" => {
                        if let Some(f) = fields.last_mut() {
                            f.collecting = true;
                        }
                    }
                    "end" => {
                        if let Some(f) = fields.pop() {
                            // 有 separate → 取结果区 result；无 separate → pre 暂存的普通 run 即缓存结果。
                            let body = if f.collecting { &f.result } else { &f.pre };
                            let s = finalize_xref(&f.instr, body, ctx);
                            push_inline(&mut fields, out, s);
                        }
                    }
                    _ => {}
                }
                continue;
            }
            if let Some(code) = node
                .children()
                .find(|c| is_el(*c, "instrText"))
                .and_then(|c| c.text().map(|t| t.to_string()))
            {
                flush_pending(&mut pending, out);
                if let Some(f) = fields.last_mut() {
                    if !f.collecting {
                        f.instr.push_str(&code); // 域码累积（可跨多段 instrText run）
                    }
                }
                continue;
            }
            // 正处于某域内：结果区（已过 separate）并入 result；域码区并入 pre 暂存
            // （域码只由 instrText 承载，普通 w:t run 要么是缓存结果、要么为空，均不应丢弃）。
            if let Some(f) = fields.last_mut() {
                flush_pending(&mut pending, out);
                let t = map_run(node, ctx);
                if f.collecting {
                    f.result.push_str(&t);
                } else {
                    f.pre.push_str(&t);
                }
                continue;
            }
            match mergeable_run(node, ctx) {
                Some((sig, text)) => match &mut pending {
                    Some((psig, ptext)) if *psig == sig => ptext.push_str(&text),
                    _ => {
                        flush_pending(&mut pending, out);
                        pending = Some((sig, text));
                    }
                },
                None => {
                    flush_pending(&mut pending, out);
                    out.push_str(&map_run(node, ctx));
                }
            }
        } else if is_el(node, "hyperlink") {
            flush_pending(&mut pending, out);
            let mut inner = String::new();
            map_inline_children(node, ctx, &mut inner);
            let rid = rattr(node, "id").unwrap_or("").to_string();
            let anchor = wattr(node, "anchor").unwrap_or("").to_string();
            let produced = if let Some(rel) = ctx.rels.get(&rid) {
                let url = resolve_link_target(&rel.target);
                if rel.external && !url.is_empty() {
                    if inner.trim().is_empty() {
                        url
                    } else {
                        format!("[{}]({})", inner, url)
                    }
                } else {
                    inner
                }
            } else if !anchor.is_empty() {
                // 内部锚点超链接（书签）：命中标题→ [inner](#锚点)，否则经 finalize_xref 降级 + 告警
                finalize_xref(&format!("REF {}", anchor), &inner, ctx)
            } else {
                inner
            };
            push_inline(&mut fields, out, produced);
        } else if is_el(node, "fldSimple") {
            flush_pending(&mut pending, out);
            let instr = wattr(node, "instr").unwrap_or("").to_string();
            if instr.to_ascii_uppercase().contains("TOC") {
                ctx.warn("toc", "目录域已按可见文本降级", "fldSimple");
            }
            let mut inner = String::new();
            map_inline_children(node, ctx, &mut inner);
            let produced = finalize_xref(&instr, &inner, ctx);
            push_inline(&mut fields, out, produced);
        } else if is_el(node, "ins") || is_el(node, "smartTag") {
            flush_pending(&mut pending, out);
            map_inline_children(node, ctx, out);
        } else if is_el(node, "sdt") {
            flush_pending(&mut pending, out);
            if let Some(c) = child(node, "sdtContent") {
                map_inline_children(c, ctx, out);
            }
        } else if is_mel(node, "oMath") {
            flush_pending(&mut pending, out);
            out.push('$');
            out.push_str(&omml_to_latex(node, ctx));
            out.push('$');
        } else if is_mel(node, "oMathPara") {
            flush_pending(&mut pending, out);
            // 罕见：显示式与正文混排（纯式已由 push_paragraph 拦为块级）→ 内联为 $..$。
            let latex = omml_para_to_latex(node, ctx);
            if !latex.trim().is_empty() {
                out.push('$');
                out.push_str(&collapse_ws(&latex));
                out.push('$');
                ctx.warn("math", "显示公式与正文混排，已内联为 $..$", "oMathPara");
            }
        } else if is_el(node, "bookmarkStart") {
            // 被交叉引用命中的非标题书签目标：在书签起始处发一个字面 `<a id="…"></a>`（GFM 行内 HTML），
            // 作为正文 `[文本](#id)` 的跳转落点。标题目标不在 xref_emit，故不发（标题自带锚点）。
            let anchor = wattr(node, "name").and_then(|nm| {
                if ctx.xref_emit.contains(nm) {
                    ctx.xref_anchor.get(nm).cloned()
                } else {
                    None
                }
            });
            if let Some(a) = anchor {
                flush_pending(&mut pending, out);
                out.push_str(&format!("<a id=\"{}\"></a>", a.trim_start_matches('#')));
            }
        } else if is_el(node, "del") {
            flush_pending(&mut pending, out);
            ctx.warn("unknown_style", "已忽略删除痕迹（tracked deletion）内的文本", "del");
        }
    }
    flush_pending(&mut pending, out);
}

/// 把待合并的 run 组按签名包裹后写入 out。
fn flush_pending(pending: &mut Option<(u32, String)>, out: &mut String) {
    if let Some((sig, text)) = pending.take() {
        out.push_str(&wrap_emphasis(sig, &text));
    }
}

/// 按强调签名包裹文本（包裹顺序与 map_run 一致：strike→u→i→b）。
fn wrap_emphasis(sig: u32, text: &str) -> String {
    if text.is_empty() {
        return String::new();
    }
    let mut s = text.to_string();
    if sig & 8 != 0 {
        s = format!("~~{}~~", s);
    }
    if sig & 4 != 0 {
        s = format!("_{}_", s);
    }
    if sig & 2 != 0 {
        s = format!("*{}*", s);
    }
    if sig & 1 != 0 {
        s = format!("**{}**", s);
    }
    s
}

/// 若 run 仅由「一个 rPr + 若干 w:t」构成（无图片/脚注/换行/制表/sym/上下标等副作用），
/// 返回其 (强调签名, 文本) 以便与相邻同格式 run 合并；否则返回 None（走 map_run 原逻辑）。
fn mergeable_run(r: roxmltree::Node, ctx: &mut Ctx) -> Option<(u32, String)> {
    let rpr = child(r, "rPr");
    let is = |name: &str| rpr.and_then(|x| child(x, name)).is_some();
    if rpr.and_then(|x| child(x, "vertAlign")).is_some() {
        return None;
    }
    let mut sig: u32 = 0;
    if is("b") {
        sig |= 1;
    }
    if is("i") {
        sig |= 2;
    }
    if is("u") {
        sig |= 4;
    }
    if is("strike") {
        sig |= 8;
    }
    let mut text = String::new();
    for node in r.children() {
        if is_el(node, "rPr") {
            continue;
        } else if is_el(node, "t") {
            let t = node.text().unwrap_or("");
            ctx.stats.words += count_words(t);
            text.push_str(&escape_text(t));
        } else {
            return None; // br/cr/tab/footnoteReference/drawing/pict/sym 等 → 不合并
        }
    }
    Some((sig, text))
}

/// 单个 run：先算纯文本与图片，再按 rPr 记号包裹
fn map_run(r: roxmltree::Node, ctx: &mut Ctx) -> String {
    let rpr = child(r, "rPr");
    let mut text = String::new();
    let mut trailing = String::new(); // 图片/脚注等非文本产物，不参与记号包裹
    for node in r.children() {
        if is_el(node, "rPr") {
            continue;
        } else if is_el(node, "t") {
            let t = node.text().unwrap_or("");
            ctx.stats.words += count_words(t);
            text.push_str(&escape_text(t));
        } else if is_el(node, "br") || is_el(node, "cr") {
            trailing.push('\n');
        } else if is_el(node, "tab") {
            trailing.push(' ');
        } else if is_el(node, "footnoteReference") || is_el(node, "endnoteReference") {
            let id = wattr(node, "id").unwrap_or("").to_string();
            if !id.is_empty() {
                ctx.referenced.push(id.clone());
                ctx.stats.footnotes += 1;
                ctx.warn("footnote", "脚注/尾注引用已降为 [^id] + 文末定义", "footnoteReference");
                trailing.push_str(&format!("[^{}]", id));
            }
        } else if is_el(node, "drawing") || is_el(node, "pict") {
            if let Some(md) = map_drawing(node, ctx) {
                trailing.push_str(&md);
            }
        } else if is_el(node, "sym") {
            if let Some(c) = wattr(node, "char") {
                if let Ok(u) = u32::from_str_radix(c.trim_start_matches("0x"), 16) {
                    if let Some(ch) = char::from_u32(u) {
                        text.push(ch);
                    }
                }
            }
        }
    }

    let mut s = String::new();
    if !text.is_empty() {
        s.push_str(&text);
        // 记号包裹（仅当文本存在）
        let is = |name: &str| rpr.and_then(|x| child(x, name)).is_some();
        let val = |name: &str| rpr.and_then(|x| child(x, name)).and_then(|x| wattr(x, "val").map(|v| v.to_string()));
        if val("vertAlign").as_deref() == Some("superscript") {
            // 上标：GFM 无对应语法，用 `^` 前缀降级（比 `<sup>` 干净，如参考文献 `^[22]`）。
            s = format!("^{}", s);
            ctx.warn("unknown_style", "上标 GFM 无对应语法，已降级为 ^ 前缀", "vertAlign");
        } else if val("vertAlign").as_deref() == Some("subscript") {
            // 下标：与上标对称，GFM 无对应语法，用 `~` 前缀降级（如 `~i`）。
            s = format!("~{}", s);
            ctx.warn("unknown_style", "下标 GFM 无对应语法，已降级为 ~ 前缀", "vertAlign");
        }
        if is("strike") {
            s = format!("~~{}~~", s);
        }
        if is("u") {
            s = format!("_{}_", s);
        }
        if is("i") {
            s = format!("*{}*", s);
        }
        if is("b") {
            s = format!("**{}**", s);
        }
    }
    s.push_str(&trailing);
    s
}

/// drawing：优先图片(a:blip)，其次文本框(交回段落映射)——返回 markdown 图片引用
fn map_drawing(d: roxmltree::Node, ctx: &mut Ctx) -> Option<String> {
    let blip = d.descendants().find(|n| is_el(*n, "blip"));
    let embed = blip.and_then(|b| rattr(b, "embed").or_else(|| rattr(b, "link")))?;
    let rel = ctx.rels.get(embed)?;
    if rel.external {
        return None;
    }
    let zip_path = resolve_media_path(&rel.target);
    let bytes = ctx.media.get(&zip_path)?;
    let alt = d
        .descendants()
        .find(|n| is_el(*n, "docPr"))
        .and_then(|p| attr0(p, "descr"))
        .unwrap_or("")
        .to_string();
    Some(push_image(bytes, &rel.target, &alt, ctx))
}

/// 登记图片并返回 md 引用；同 sha 单文档内收敛为一份
fn push_image(bytes: &[u8], target: &str, alt: &str, ctx: &mut Ctx) -> String {
    let sha = sha256_hex(bytes);
    let ext = target.rsplit_once('.').map(|(_, e)| e.to_ascii_lowercase()).unwrap_or_else(|| "png".into());
    let fname = format!("{}.{}", &sha[..12.min(sha.len())], ext);

    if bytes.len() as u64 > ctx.max_image_bytes {
        ctx.warn("image_skipped", &format!("图片超过 max_image_bytes（{} 字节）已跳过", bytes.len()), target);
        return format!("<!--img skipped: too large: {}-->", alt);
    }

    let (rel_ref, reused) = match ctx.dedup.get(&sha) {
        Some(existing) => (relpath_from(ctx.doc_dir_rel.as_str(), existing), true),
        None => (fname.clone(), false),
    };
    if !ctx.img_seen.contains_key(&sha) {
        ctx.img_seen.insert(sha.clone(), ());
        ctx.images.push(ImportedImage {
            sha256: sha,
            ext,
            data_b64: b64_encode(bytes),
            planned_rel: if reused { rel_ref.clone() } else { join_rel(&ctx.doc_dir_rel, &fname) },
            reused,
            bytes: bytes.len() as u64,
        });
        ctx.stats.images += 1;
    }
    format!("![{}]({})", alt, rel_ref)
}

fn join_rel(dir: &str, name: &str) -> String {
    if dir.is_empty() {
        name.to_string()
    } else {
        format!("{}/{}", dir.trim_end_matches('/'), name)
    }
}

/// 从 doc 目录到既有库内相对路径的可达相对引用（同目录直取；否则 ../ 回溯）
fn relpath_from(doc_dir: &str, target: &str) -> String {
    let from: Vec<&str> = doc_dir.split('/').filter(|s| !s.is_empty()).collect();
    let to: Vec<&str> = target.split('/').filter(|s| !s.is_empty()).collect();
    let mut i = 0;
    while i < from.len() && i < to.len() && from[i] == to[i] {
        i += 1;
    }
    let ups = from.len() - i;
    let mut segs: Vec<String> = Vec::new();
    for _ in 0..ups {
        segs.push("..".into());
    }
    for s in &to[i..] {
        segs.push((*s).to_string());
    }
    if segs.is_empty() {
        target.to_string()
    } else {
        segs.join("/")
    }
}

// ==================== 表格映射 ====================

/// 判断“版式表格”：任一单元格含 ≥2 个非空段落，或含嵌套表 → 视为用表格做的排版（非真数据表）。
/// 这类表（典型如整页简历用 1~3 格表格排版）若按数据表拍平，会把格子里几十段拼成一行、并丢弃
/// 格子内段落的标题/列表结构，故改为「线性化」：逐格把其中的 w:p 走完整 push_paragraph。
fn is_layout_table(tbl: roxmltree::Node) -> bool {
    // 宽度闸：版式排版表按定义是窄的（整页简历那种 1~3 格）；任一行 ≥4 格一律视为真数据表，
    // 绝不线性化——否则宽表里一个普通的格内换行（如两行表头）就会误伤，把整表拍成段落丢掉列结构。
    let wide = tbl
        .children()
        .filter(|n| is_el(*n, "tr"))
        .any(|tr| tr.children().filter(|n| is_el(*n, "tc")).count() >= 4);
    if wide {
        return false;
    }
    for tr in tbl.children().filter(|n| is_el(*n, "tr")) {
        for tc in tr.children().filter(|n| is_el(*n, "tc")) {
            if tc.children().any(|n| is_el(n, "tbl")) {
                return true;
            }
            let nonempty = tc
                .children()
                .filter(|n| is_el(*n, "p"))
                .filter(|p| {
                    p.descendants()
                        .filter(|n| is_el(*n, "t"))
                        .any(|t| !t.text().unwrap_or("").trim().is_empty())
                })
                .count();
            if nonempty >= 2 {
                return true;
            }
        }
    }
    false
}

fn push_table(tbl: roxmltree::Node, ctx: &mut Ctx, blocks: &mut Vec<Block>) {
    // 版式表格：按文档顺序线性化为普通块（保留格子内标题/列表/段落），不当作数据表拍平。
    if is_layout_table(tbl) {
        ctx.warn(
            "layout_table",
            "检测到版式表格（单元格含多段/嵌套表），已按文档顺序展开为普通块（标题/列表/段落保留）",
            "tbl",
        );
        for tr in tbl.children().filter(|n| is_el(*n, "tr")) {
            for tc in tr.children().filter(|n| is_el(*n, "tc")) {
                push_children_blocks(tc, ctx, blocks);
            }
        }
        return;
    }
    let mut rows: Vec<Vec<(String, u32, u32, bool)>> = Vec::new(); // (text, colspan, rowspan, is_header)
    let mut merged = false;
    for tr in tbl.children().filter(|n| is_el(*n, "tr")) {
        let header_row = tr
            .children()
            .find(|n| is_el(*n, "trPr"))
            .and_then(|tp| child(tp, "tblHeader"))
            .is_some();
        let mut row = Vec::new();
        for tc in tr.children().filter(|n| is_el(*n, "tc")) {
            let tcpr = child(tc, "tcPr");
            let colspan = tcpr
                .and_then(|p| child(p, "gridSpan"))
                .and_then(|g| wattr(g, "val").and_then(|v| v.parse().ok()))
                .unwrap_or(1);
            let vmerge = tcpr.and_then(|p| child(p, "vMerge"));
            let rowspan = if vmerge.is_some() {
                let val = vmerge.and_then(|v| wattr(v, "val")).unwrap_or("continue");
                if val == "restart" {
                    2 // 无法精确测行数（需回溯），保底标 merged；校对兜底
                } else {
                    1
                }
            } else {
                1
            };
            if colspan > 1 || rowspan > 1 || (vmerge.is_some() && wattr(vmerge.unwrap(), "val").unwrap_or("continue") != "restart") {
                merged = true;
            }
            let mut cell_texts: Vec<String> = Vec::new();
            for p in tc.children().filter(|n| is_el(*n, "p")) {
                let t = map_inline(p, ctx);
                if !t.trim().is_empty() {
                    cell_texts.push(t.trim().to_string());
                }
            }
            let _ = header_row; // 判定留待 GFM 首行 / HTML th
            row.push((cell_texts.join(" "), colspan, rowspan, false));
        }
        rows.push(row);
    }
    if rows.is_empty() {
        return;
    }
    ctx.stats.tables += 1;

    if merged {
        ctx.stats.merged_tables += 1;
        ctx.warn("merged_table", "合并单元格 GFM 无法表达，已输出原样 <table> HTML", "tbl");
        blocks.push(Block::TableHtml(table_to_html(&rows)));
    } else {
        blocks.push(Block::TableHtml(gfm_or_html_table(&rows)));
    }
}

/// 无合并表 -> GFM；单元格里管道转义
fn gfm_or_html_table(rows: &[Vec<(String, u32, u32, bool)>]) -> String {
    let cols = rows.iter().map(|r| r.len()).max().unwrap_or(0);
    let cell = |t: &str| t.replace('|', "\\|").replace('\n', " ");
    let mut out = String::new();
    for (ri, row) in rows.iter().enumerate() {
        let mut line = String::from("|");
        for ci in 0..cols {
            let text = row.get(ci).map(|c| cell(&c.0)).unwrap_or_default();
            line.push(' ');
            line.push_str(&text);
            line.push_str(" |");
        }
        out.push_str(&line);
        out.push('\n');
        if ri == 0 {
            let sep: Vec<String> = (0..cols).map(|_| "---".to_string()).collect();
            out.push_str(&format!("| {} |", sep.join(" | ")));
            out.push('\n');
        }
    }
    out.trim_end().to_string()
}

/// 合并表 -> 真正的 <table> HTML（colspan/rowspan、单元格内容 HTML 转义）
fn table_to_html(rows: &[Vec<(String, u32, u32, bool)>]) -> String {
    let mut parts = vec!["<table>".to_string()];
    for row in rows {
        parts.push("<tr>".to_string());
        for (text, colspan, rowspan, _) in row {
            let mut tag = String::from("<td");
            if *colspan > 1 {
                tag.push_str(&format!(" colspan=\"{}\"", colspan));
            }
            if *rowspan > 1 {
                tag.push_str(&format!(" rowspan=\"{}\"", rowspan));
            }
            tag.push('>');
            parts.push(tag);
            parts.push(escape_html(text));
            parts.push("</td>".to_string());
        }
        parts.push("</tr>".to_string());
    }
    parts.push("</table>".to_string());
    parts.join("")
}

// ==================== 脚注 / 尾注 定义收集 ====================

fn collect_notes(xml_opt: Option<&str>, ctx: &mut Ctx) {
    let xml = match xml_opt {
        Some(x) => x,
        None => return,
    };
    let doc = match roxmltree::Document::parse(xml) {
        Ok(d) => d,
        Err(_) => return,
    };
    for note in doc.root().descendants().filter(|n| is_el(*n, "footnote") || is_el(*n, "endnote")) {
        let id = wattr(note, "id").unwrap_or("").to_string();
        let ntype = wattr(note, "val").or_else(|| wattr(note, "type")).unwrap_or("");
        if id.is_empty() || matches!(ntype, "separator" | "continuationSeparator" | "continuationNotice") {
            continue;
        }
        // 脚注正文按段落内联，合并为单行（换行→空格）
        let mut acc: Vec<String> = Vec::new();
        for p in note.children().filter(|n| is_el(*n, "p")) {
            let text = map_inline(p, ctx);
            let t = text.trim();
            if !t.is_empty() {
                acc.push(t.to_string());
            }
        }
        ctx.footnote_text.insert(id, acc.join(" "));
    }
}

fn render_footnote_section(ctx: &Ctx) -> String {
    let mut lines: Vec<String> = Vec::new();
    let mut seen: HashMap<&str, ()> = HashMap::new();
    for id in &ctx.referenced {
        if seen.contains_key(id.as_str()) {
            continue;
        }
        seen.insert(id.as_str(), ());
        let body = ctx.footnote_text.get(id).cloned().unwrap_or_default();
        let body = body.replace('\n', " ");
        lines.push(format!("[^{}]: {}", id, body));
    }
    lines.join("\n\n")
}

// ==================== 文本 / HTML 转义 ====================

/// markdown 文本里的竖线/反引号风险低；主要保留原字符，HTML 表再单独转义
fn escape_text(s: &str) -> String {
    s.to_string()
}

fn escape_html(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            _ => out.push(c),
        }
    }
    out
}

/// rels 里的超链接 target：外部 URL 原样；内部锚点（document.xml#...）取 #fragment，无则丢弃
fn resolve_link_target(target: &str) -> String {
    if target.contains("://") {
        target.to_string()
    } else if let Some(pos) = target.find('#') {
        format!("#{}", &target[pos + 1..])
    } else {
        String::new()
    }
}

/// media 关系 target（如 "media/image1.png"）→ zip 内路径（"word/media/image1.png"）
fn resolve_media_path(target: &str) -> String {
    let t = target.trim_start_matches("/word/").trim_start_matches("./");
    if t.starts_with("media/") {
        format!("word/{}", t)
    } else {
        t.to_string()
    }
}

fn count_words(s: &str) -> u64 {
    let mut c = 0u64;
    let mut in_lat = false;
    for ch in s.chars() {
        if is_cjk(ch) {
            if in_lat {
                c += 1;
                in_lat = false;
            }
            c += 1;
        } else if ch.is_alphanumeric() {
            in_lat = true;
        } else if in_lat {
            c += 1;
            in_lat = false;
        }
    }
    if in_lat {
        c += 1;
    }
    c
}

fn is_cjk(ch: char) -> bool {
    let u = ch as u32;
    (0x4E00..=0x9FFF).contains(&u)
        || (0x3400..=0x4DBF).contains(&u)
        || (0x3040..=0x30FF).contains(&u)
        || (0xAC00..=0xD7AF).contains(&u)
        || (0xF900..=0xFAFF).contains(&u)
}

// ==================== ZIP 读取（IO） ====================

struct ZipContent {
    document: String,
    rels: String,
    numbering: Option<String>,
    styles: Option<String>,
    footnotes: Option<String>,
    endnotes: Option<String>,
    media: HashMap<String, Vec<u8>>,
}

fn read_zip(data: &[u8]) -> Result<ZipContent, String> {
    let cursor = std::io::Cursor::new(data);
    let mut z = zip::ZipArchive::new(cursor).map_err(|e| format!("打开 docx（ZIP）失败：{}", e))?;
    let get_text = |z: &mut zip::ZipArchive<std::io::Cursor<&[u8]>>, name: &str| -> Option<String> {
        let mut f = z.by_name(name).ok()?;
        let mut buf = String::new();
        f.read_to_string(&mut buf).ok()?;
        Some(buf)
    };
    let document = get_text(&mut z, "word/document.xml").ok_or("非有效 .docx（缺 word/document.xml）")?;
    let rels = get_text(&mut z, "word/_rels/document.xml.rels").unwrap_or_default();
    let numbering = get_text(&mut z, "word/numbering.xml");
    let styles = get_text(&mut z, "word/styles.xml");
    let footnotes = get_text(&mut z, "word/footnotes.xml");
    let endnotes = get_text(&mut z, "word/endnotes.xml");
    let mut media: HashMap<String, Vec<u8>> = HashMap::new();
    for i in 0..z.len() {
        let mut f = match z.by_index(i) {
            Ok(f) => f,
            Err(_) => continue,
        };
        let name = f.name().to_string();
        if name.starts_with("word/media/") {
            let mut buf = Vec::new();
            if f.read_to_end(&mut buf).is_ok() {
                media.insert(name, buf);
            }
        }
    }
    Ok(ZipContent { document, rels, numbering, styles, footnotes, endnotes, media })
}

// ==================== 命名 / 路径 安全（纯） ====================

/// 标题 -> 目录/文件名安全化：去路径非法字符、控制字符；空格折叠为 -；空回退 Untitled
pub fn slugify(title: &str) -> String {
    let mut out = String::new();
    let mut last_dash = false;
    for ch in title.chars() {
        let keep = ch.is_alphanumeric() || matches!(ch, '-' | '_' | '.' | ' ' | '\u{4e00}'..='\u{9fff}') || is_cjk(ch);
        if keep && !is_illegal(ch) {
            if ch == ' ' {
                if !last_dash && !out.is_empty() {
                    out.push('-');
                    last_dash = true;
                }
            } else {
                out.push(ch);
                last_dash = false;
            }
        }
    }
    let out = out.trim_matches(|c| c == '-' || c == '.').to_string();
    if out.is_empty() {
        "Untitled".to_string()
    } else {
        out
    }
}

fn is_illegal(ch: char) -> bool {
    matches!(ch, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|') || (ch as u32) < 0x20
}

// ==================== 标题锚点 slug（批次 F 后续：交叉引用 ↔ 站点/编辑器 三方契约）====================
// 本函数是前端 src/heading-anchor.js 的**镜像**，二者由共享 fixture `src/tests/fixtures/heading-slug.json`
// 在 cargo test 与 `npm run test:heading-anchor` 双边逐字符锁死。规则（自定义、非严格 GitHub）：
//  逐码点小写（unicode 感知）；保留 字母/数字/CJK/`_`/`-`，其余标点整字符丢弃；空白（含连续）折叠为单个 `-`、
//  首尾裁掉；重名 dedup 由 assign_anchors 依文档序追加 `-1`/`-2`……（首个不加后缀）。

/// 单个标题纯文本 → 基础 slug（不含 dedup 后缀）。
pub fn heading_anchor_slug(plain: &str) -> String {
    let mut out = String::new();
    let mut pending_space = false; // 有待续分隔符（out 非空才置位 → 首尾空白自然裁掉）
    for ch in plain.to_lowercase().chars() {
        if ch.is_whitespace() {
            if !out.is_empty() {
                pending_space = true;
            }
            continue;
        }
        if ch.is_alphanumeric() || ch == '_' || ch == '-' {
            if pending_space {
                out.push('-');
                pending_space = false;
            }
            out.push(ch);
        }
        // 其余（标点/符号）整字符丢弃，不产生分隔符
    }
    out
}

/// 有序标题纯文本 → 逐字符唯一锚点（叠加 dedup）。文档序调用即得与正文标题一致的锚点表。
pub fn assign_anchors(plain: &[String]) -> Vec<String> {
    let mut counts: HashMap<String, u32> = HashMap::new();
    plain
        .iter()
        .map(|p| {
            let base = heading_anchor_slug(p);
            let idx = counts.entry(base.clone()).or_insert(0);
            let n = *idx;
            *idx += 1;
            if n == 0 { base } else { format!("{base}-{n}") }
        })
        .collect()
}

/// 归一化库内相对路径：反斜杠→/、去首斜杠、拒绝 .. 段；返回干净串
fn sanitize_rel(rel: &str) -> Result<String, String> {
    let norm = rel.trim().replace('\\', "/");
    let mut segs: Vec<&str> = Vec::new();
    for s in norm.split('/').filter(|s| !s.is_empty() && *s != ".") {
        if s == ".." {
            return Err("非法路径：不允许跳出知识库根目录".into());
        }
        segs.push(s);
    }
    Ok(segs.join("/"))
}

/// 冲突处理：路径存在则在文件名主干后补 -2/-3…（目录名不变）
fn resolve_conflict(root: &Path, rel: &str) -> String {
    if root.join(rel_slash_to_native(rel)).exists() {
        let (dir, file) = split_dir_file(rel);
        let (stem, ext) = file.rsplit_once('.').map(|(s, e)| (s.to_string(), Some(e.to_string()))).unwrap_or((file.clone(), None));
        for n in 2..1000u32 {
            let cand_file = match &ext {
                Some(e) => format!("{}-{}.{}", stem, n, e),
                None => format!("{}-{}", stem, n),
            };
            let cand = if dir.is_empty() { cand_file } else { format!("{}/{}", dir, cand_file) };
            if !root.join(rel_slash_to_native(&cand)).exists() {
                return cand;
            }
        }
    }
    rel.to_string()
}

fn rel_slash_to_native(rel: &str) -> std::path::PathBuf {
    Path::new(rel).components().collect::<std::path::PathBuf>()
}

fn split_dir_file(rel: &str) -> (String, String) {
    match rel.rsplit_once('/') {
        Some((d, f)) => (d.to_string(), f.to_string()),
        None => (String::new(), rel.to_string()),
    }
}

// ==================== 命令：docx_preview（只转不写） ====================

#[tauri::command]
pub fn docx_preview(args: DocxPreviewArgs) -> Result<DocxPreview, String> {
    // 字节来源：优先 src_b64（拖拽）；否则读 src_path（对话框）。
    let (data, src_name) = match &args.src_b64 {
        Some(b) if !b.trim().is_empty() => {
            let name = args
                .src_display_name
                .as_deref()
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .map(|s| s.to_string())
                .unwrap_or_else(|| "document.docx".to_string());
            (b64_decode(b)?, name)
        }
        _ => (fs_read(&args.src_path)?, file_name(&args.src_path)),
    };
    let content = read_zip(&data)?;
    let rels = parse_rels(&content.rels);
    let numbering = parse_numbering(content.numbering.as_deref());
    let styles = parse_styles(content.styles.as_deref());
    let doc = roxmltree::Document::parse(&content.document).map_err(|e| format!("document.xml 解析失败：{}", e))?;

    // 标题：override → 首个标题样式段落 → 文件名主干
    let stem = src_name.rsplit_once('.').map(|(s, _)| s.to_string()).unwrap_or_else(|| src_name.clone());
    let title = match &args.title_override {
        Some(t) if !t.trim().is_empty() => t.trim().to_string(),
        _ => detect_first_heading(&doc, &styles).unwrap_or(stem.clone()),
    };
    let slug = slugify(&title);
    let dest_dir = sanitize_rel(&args.dest_dir)?;
    let doc_dir = join_rel(&dest_dir, &slug);

    let mut ctx = Ctx::new(&rels, &numbering, &styles, &content.media, &args.dedup_index, doc_dir.clone(), args.max_image_bytes.max(1));
    collect_notes(content.footnotes.as_deref(), &mut ctx);
    collect_notes(content.endnotes.as_deref(), &mut ctx);
    scan_headings_and_bookmarks(&doc, &mut ctx);
    let blocks = map_body(&doc, &mut ctx);
    let mut md = compose(&blocks);
    let fn_sec = render_footnote_section(&ctx);
    if !fn_sec.is_empty() {
        md = if md.is_empty() { fn_sec } else { format!("{}\n\n{}", md, fn_sec) };
    }

    if args.with_frontmatter {
        let imported = Local::now().format("%Y-%m-%d").to_string();
        let fm = format!("---\nsource: \"{}\"\nimported: \"{}\"\n---\n\n", src_name, imported);
        md = format!("{}{}", fm, md);
    }

    let planned_doc_rel = join_rel(&doc_dir, &format!("{}.md", slug));
    Ok(DocxPreview {
        md,
        planned_doc_rel,
        title,
        images: ctx.images,
        warnings: ctx.warnings,
        stats: ctx.stats,
    })
}

fn detect_first_heading(doc: &roxmltree::Document, styles: &HashMap<String, StyleInfo>) -> Option<String> {
    for p in doc.root_element().children().find(|n| is_el(*n, "body"))?.children().filter(|n| is_el(*n, "p")) {
        let ppr = child(p, "pPr");
        let style_id = ppr.and_then(|pp| child(pp, "pStyle")).and_then(|s| wattr(s, "val").map(|x| x.to_string()));
        let st = style_id.as_ref().and_then(|id| styles.get(id));
        let is_heading = st.map(|s| s.outline.is_some() || s.name.to_ascii_lowercase().starts_with("heading")).unwrap_or(false);
        if is_heading {
            let rels = HashMap::new();
            let numbering = HashMap::new();
            let media = HashMap::new();
            let dedup = HashMap::new();
            let mut c = Ctx::new(&rels, &numbering, styles, &media, &dedup, "".into(), u64::MAX);
            let t = map_inline(p, &mut c);
            let t = t.trim().to_string();
            if !t.is_empty() {
                return Some(t);
            }
        }
    }
    None
}

// ==================== 命令：docx_commit（校对后落盘 + 去重） ====================

#[tauri::command]
pub fn docx_commit(args: DocxCommitArgs) -> Result<DocxCommitResult, String> {
    let root = fs_canonicalize(&args.vault_root)?;
    let mut rel = sanitize_rel(&args.doc_rel)?;
    // new_title：校对后改名——保留目录、以 slugify 后的标题重建文件名（不静默覆盖，交由冲突处理）
    if let Some(nt) = args.new_title.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        let (dir, _) = split_dir_file(&rel);
        let slug = slugify(nt);
        rel = if dir.is_empty() { format!("{}.md", slug) } else { format!("{}/{}.md", dir, slug) };
    }
    if rel.is_empty() || !rel.to_ascii_lowercase().ends_with(".md") {
        return Err("非法 doc_rel：须为 .md 库内相对路径".into());
    }
    let final_rel = resolve_conflict(&root, &rel);
    let doc_dir = split_dir_file(&final_rel).0;

    // 写 .md
    let md_abs = vault_join(&root, &final_rel)?;
    if !md_abs.starts_with(&root) {
        return Err("非法路径：目标不在知识库根目录内".into());
    }
    if let Some(parent) = md_abs.parent() {
        fs_create_dir_all(parent)?;
    }
    fs_write(&md_abs, args.md.as_bytes())?;

    let mut updated = args.dedup_index.clone();
    let mut written: Vec<String> = Vec::new();
    let mut reused: Vec<String> = Vec::new();
    for img in &args.images {
        if img.sha256.is_empty() {
            continue;
        }
        if let Some(existing) = updated.get(&img.sha256).cloned() {
            // 加固：索引命中 ≠ 文件真在当前库（跨库污染 / 手删 / 移动都会让索引指向已不存在的库内路径）。
            // 校验目标存在：在则复用；缺失则按索引路径补写自愈，绝不留下断图引用。
            if let Ok(target) = vault_join(&root, &existing) {
                if target.starts_with(&root) {
                    if target.exists() {
                        reused.push(existing);
                        continue;
                    }
                    if let Some(parent) = target.parent() {
                        fs_create_dir_all(parent)?;
                    }
                    let bytes = b64_decode(&img.data_b64)?;
                    fs_write(&target, &bytes)?;
                    written.push(existing);
                    continue;
                }
            }
            // existing 越界/异常 → 不 continue，落到下面按 planned_rel 正常写并更新索引
        }
        let irel = if img.planned_rel.trim().is_empty() {
            // 无计划路径 → 按 <sha前12>.<ext> 落在文档同目录（用 ext 重建文件名）
            let e = img.ext.trim().trim_start_matches('.').to_ascii_lowercase();
            if e.is_empty() {
                continue;
            }
            join_rel(&doc_dir, &format!("{}.{}", &img.sha256[..12.min(img.sha256.len())], e))
        } else {
            sanitize_rel(&img.planned_rel)?
        };
        if irel.is_empty() {
            continue;
        }
        let abs = vault_join(&root, &irel)?;
        if !abs.starts_with(&root) {
            return Err("非法路径：图片目标不在知识库根目录内".into());
        }
        if let Some(parent) = abs.parent() {
            fs_create_dir_all(parent)?;
        }
        let bytes = b64_decode(&img.data_b64)?;
        if !abs.exists() {
            fs_write(&abs, &bytes)?;
            written.push(irel.clone());
        }
        updated.insert(img.sha256.clone(), irel);
    }

    Ok(DocxCommitResult { doc_rel: final_rel, written_images: written, reused_images: reused, updated_index: updated })
}

// ==================== 命令：临时导入目录（独立解析模式） ====================

/// 在系统临时目录下建一个本次导入专属子目录（`<temp>/NoteLume/docx-import/<毫秒时间戳>`），返回其绝对路径。
/// 未开库的独立解析模式把转换结果先写到这里并立即在编辑器打开，是否长期保存（移走/另存）由用户自行决定。
/// 目录当场创建，以便 `docx_commit` 对 `vault_root` 的 canonicalize 能通过（其要求路径已存在）。
#[tauri::command]
pub fn ensure_temp_import_dir() -> Result<String, String> {
    use std::time::{SystemTime, UNIX_EPOCH};
    let ts = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_millis();
    let dir = std::env::temp_dir()
        .join("NoteLume")
        .join("docx-import")
        .join(ts.to_string());
    fs_create_dir_all(&dir)?;
    Ok(dir.to_string_lossy().to_string())
}

/// 把「源目录」整棵树递归复制到「目标目录」（保留相对路径），已存在的目标文件覆写。
/// 独立解析模式下 Ctrl+S「另存为」时使用：把系统 temp 一次性目录里的 .md + 附件图片 全部落到
/// 用户选定的正式目录。**不删除源目录**（交系统 temp 自动回收；避免中途失败丢内容）。
/// 目标不存在时按需创建。源必须存在（内部会 canonicalize，与 `docx_commit` 的 root 校验对称）。
#[tauri::command]
pub fn relocate_import(from_root: String, to_root: String) -> Result<(), String> {
    let src = fs_canonicalize(&from_root)?;
    let dst_raw = Path::new(&to_root);
    if !dst_raw.exists() {
        fs_create_dir_all(dst_raw)?;
    }
    let dst = fs_canonicalize(&dst_raw.to_string_lossy())?;
    copy_tree(&src, &dst)
}

fn copy_tree(src: &Path, dst: &Path) -> Result<(), String> {
    for entry in std::fs::read_dir(src).map_err(|e| format!("读取目录失败 {}：{}", src.display(), e))? {
        let entry = entry.map_err(|e| e.to_string())?;
        let ft = entry.file_type().map_err(|e| e.to_string())?;
        let target = dst.join(entry.file_name());
        if ft.is_dir() {
            fs_create_dir_all(&target)?;
            copy_tree(&entry.path(), &target)?;
        } else if ft.is_file() {
            std::fs::copy(&entry.path(), &target)
                .map_err(|e| format!("复制失败 {}→{}：{}", entry.path().display(), target.display(), e))?;
        }
        // 符号链接等其他类型：忽略（temp 导入目录里不会出现）
    }
    Ok(())
}

// ==================== fs 薄封装（集中错误串，便于跨平台） ====================

fn fs_read(p: &str) -> Result<Vec<u8>, String> {
    std::fs::read(p).map_err(|e| format!("读取文件失败 {}：{}", p, e))
}
fn fs_canonicalize(p: &str) -> Result<std::path::PathBuf, String> {
    std::fs::canonicalize(p).map_err(|e| e.to_string())
}
fn fs_create_dir_all(p: &Path) -> Result<(), String> {
    std::fs::create_dir_all(p).map_err(|e| format!("创建目录失败：{}", e))
}
fn fs_write(p: &Path, data: &[u8]) -> Result<(), String> {
    std::fs::write(p, data).map_err(|e| format!("写入失败 {}：{}", p.display(), e))
}
fn file_name(p: &str) -> String {
    Path::new(p).file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| p.to_string())
}

// ==================== 单测 ====================

#[cfg(test)]
mod tests {
    use super::*;

    const WNS: &str = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
    const RNS: &str = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

    /// 把正文 body 片段包成完整 document.xml
    fn doc(body: &str) -> String {
        format!(
            r#"<w:document xmlns:w="{WNS}" xmlns:r="{RNS}" xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"><w:body>{body}</w:body></w:document>"#
        )
    }

    fn empty_media() -> HashMap<String, Vec<u8>> {
        HashMap::new()
    }

    fn map(body: &str) -> (String, Vec<ConvertWarning>, DocxStats) {
        map_parts(&doc(body), "", "", "", "", &empty_media())
    }

    #[test]
    fn marks_bold_italic_strike_underline() {
        let (md, _, _) = map(r#"<w:p><w:r><w:rPr><w:b/><w:i/></w:rPr><w:t>hi</w:t></w:r></w:p>
<w:p><w:r><w:rPr><w:strike/></w:rPr><w:t>gone</w:t></w:r></w:p>
<w:p><w:r><w:rPr><w:u/></w:rPr><w:t>und</w:t></w:r></w:p>"#);
        assert!(md.contains("***hi***"), "got: {md}");
        assert!(md.contains("~~gone~~"), "got: {md}");
        assert!(md.contains("_und_"), "got: {md}");
    }

    #[test]
    fn superscript_degrades_to_caret_with_warning() {
        let (md, w, _) = map(r#"<w:p><w:r><w:rPr><w:vertAlign w:val="superscript"/></w:rPr><w:t>[22]</w:t></w:r></w:p>"#);
        assert!(md.contains("^[22]"), "got: {md}");
        assert!(!md.contains("<sup>"), "must not emit <sup>, got: {md}");
        assert!(w.iter().any(|x| x.code == "unknown_style"));
    }

    #[test]
    fn subscript_degrades_to_tilde_with_warning() {
        let (md, w, _) = map(r#"<w:p><w:r><w:rPr><w:vertAlign w:val="subscript"/></w:rPr><w:t>i</w:t></w:r></w:p>"#);
        assert!(md.contains("~i"), "got: {md}");
        assert!(!md.contains("<sub>"), "must not emit <sub>, got: {md}");
        assert!(w.iter().any(|x| x.code == "unknown_style"));
    }

    #[test]
    fn heading_via_style_outline() {
        let styles = format!(
            r#"<w:styles xmlns:w="{WNS}"><w:style w:type="paragraph" w:styleId="H1"><w:name w:val="heading 1"/><w:pPr><w:outlineLvl w:val="0"/></w:pPr></w:style></w:styles>"#
        );
        let (md, _, _) = map_parts(
            &doc(r#"<w:p><w:pPr><w:pStyle w:val="H1"/></w:pPr><w:r><w:t>Title</w:t></w:r></w:p>"#),
            "", "", &styles, "", &empty_media(),
        );
        assert!(md.starts_with("# Title"), "got: {md}");
    }

    #[test]
    fn layout_table_linearized_keeps_cell_headings_and_lists() {
        let styles = format!(
            r#"<w:styles xmlns:w="{WNS}"><w:style w:type="paragraph" w:styleId="H2"><w:name w:val="heading 2"/><w:pPr><w:outlineLvl w:val="1"/></w:pPr></w:style></w:styles>"#
        );
        // 一个“版式表”：单格内含 标题段 + 两个 bullet 段（≥2 段 → 触发线性化）
        let body = r#"<w:tbl><w:tr><w:tc>
<w:p><w:pPr><w:pStyle w:val="H2"/></w:pPr><w:r><w:t>教育背景</w:t></w:r></w:p>
<w:p><w:r><w:t>• 奖项一</w:t></w:r></w:p>
<w:p><w:r><w:t>• 奖项二</w:t></w:r></w:p>
</w:tc></w:tr></w:tbl>"#;
        let (md, w, _) = map_parts(&doc(body), "", "", &styles, "", &empty_media());
        assert!(md.contains("## 教育背景"), "cell heading lost: {md}");
        assert!(md.contains("- 奖项一\n- 奖项二"), "literal bullets not listified: {md}");
        assert!(!md.contains("<table>") && !md.contains("| 教育"), "should not render as table: {md}");
        assert!(w.iter().any(|x| x.code == "layout_table"), "missing layout_table warning: {md}");
    }

    #[test]
    fn literal_bullet_paragraph_becomes_list() {
        let (md, _, _) = map(r#"<w:p><w:r><w:t>• 通过 comfyui 剪辑</w:t></w:r></w:p>"#);
        assert!(md.starts_with("- 通过 comfyui 剪辑"), "got: {md}");
    }

    #[test]
    fn single_paragraph_cell_stays_real_table() {
        // 回归护栏：每格仅 1 段的数据表不应被线性化（仍走 GFM）
        let (md, w, _) = map(r#"<w:tbl>
<w:tr><w:tc><w:p><w:r><w:t>a</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>b</w:t></w:r></w:p></w:tc></w:tr>
<w:tr><w:tc><w:p><w:r><w:t>c</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>d</w:t></w:r></w:p></w:tc></w:tr></w:tbl>"#);
        assert!(md.contains("| a | b |"), "got: {md}");
        assert!(!w.iter().any(|x| x.code == "layout_table"), "should not be treated as layout: {md}");
    }

    #[test]
    fn wide_table_with_multiline_cell_stays_real_table() {
        // 回归（真实学位论文表4-2）：7~8 列数据表里一个格内换行（两行表头 身体/碰撞）
        // 不应把整表误判为版式表拍成段落——宽度闸应直接判为数据表，两段并入同格。
        let mut row0 = String::from("<w:tr>");
        for label in ["应变", "弯曲", "惯性"] {
            row0.push_str(&format!("<w:tc><w:p><w:r><w:t>{label}</w:t></w:r></w:p></w:tc>"));
        }
        row0.push_str("<w:tc><w:p><w:r><w:t>身体</w:t></w:r></w:p><w:p><w:r><w:t>碰撞</w:t></w:r></w:p></w:tc>");
        for label in ["摩擦", "重力", "总计"] {
            row0.push_str(&format!("<w:tc><w:p><w:r><w:t>{label}</w:t></w:r></w:p></w:tc>"));
        }
        row0.push_str("</w:tr>");
        let mut row1 = String::from("<w:tr>");
        for _ in 0..7 {
            row1.push_str("<w:tc><w:p><w:r><w:t>1.0E-01</w:t></w:r></w:p></w:tc>");
        }
        row1.push_str("</w:tr>");
        let body = format!("<w:tbl>{row0}{row1}</w:tbl>");
        let (md, w, _) = map(&body);
        assert!(!w.iter().any(|x| x.code == "layout_table"), "wide table wrongly linearized: {md}");
        assert!(md.contains("| 应变 | 弯曲 | 惯性 |"), "columns lost: {md}");
        assert!(md.contains("身体 碰撞"), "multiline cell not joined into one cell: {md}");
    }

    #[test]
    fn block_sdt_inside_cell_is_linearized() {
        let styles = format!(
            r#"<w:styles xmlns:w="{WNS}"><w:style w:type="paragraph" w:styleId="H2"><w:name w:val="heading 2"/><w:pPr><w:outlineLvl w:val="1"/></w:pPr></w:style></w:styles>"#
        );
        // 版式表：单元格内两段普通段（≥2 触发线性化）+ 中间夹一段被 sdt 包裹的标题段（需透明展开）
        let body = r#"<w:tbl><w:tr><w:tc>
<w:p><w:r><w:t>第一行</w:t></w:r></w:p>
<w:sdt><w:sdtContent><w:p><w:pPr><w:pStyle w:val="H2"/></w:pPr><w:r><w:t>教育背景</w:t></w:r></w:p></w:sdtContent></w:sdt>
<w:p><w:r><w:t>第二行</w:t></w:r></w:p>
</w:tc></w:tr></w:tbl>"#;
        let (md, _, _) = map_parts(&doc(body), "", "", &styles, "", &empty_media());
        assert!(md.contains("## 教育背景"), "sdt heading dropped: {md}");
        assert!(md.contains("第一行") && md.contains("第二行"), "got: {md}");
    }

    #[test]
    fn inline_sdt_run_not_dropped() {
        // 「技能」式：段落可见文本整段在 inline sdt 里
        let body = r#"<w:p><w:sdt><w:sdtContent><w:r><w:t>技能</w:t></w:r></w:sdtContent></w:sdt></w:p>"#;
        let (md, _, _) = map(body);
        assert!(md.contains("技能"), "inline sdt run dropped: {md}");
    }

    #[test]
    fn adjacent_same_bold_runs_merge() {
        // Word 按 rsid 把一句加粗切成多段：应合并为 **AI视频工程师**，而非 **AI****视频工程师**
        let body = r#"<w:p><w:r><w:rPr><w:b/></w:rPr><w:t>AI</w:t></w:r><w:r><w:rPr><w:b/></w:rPr><w:t>视频工程师</w:t></w:r></w:p>"#;
        let (md, _, _) = map(body);
        assert!(md.contains("**AI视频工程师**"), "bold runs not merged: {md}");
        assert!(!md.contains("****"), "fragmented emphasis remains: {md}");
    }

    #[test]
    fn bold_then_plain_runs_stay_separate() {
        // 相邻但格式不同的 run 不应被误合并
        let body = r#"<w:p><w:r><w:rPr><w:b/></w:rPr><w:t>角色</w:t></w:r><w:r><w:t>：医疗顾问</w:t></w:r></w:p>"#;
        let (md, _, _) = map(body);
        assert_eq!(md.trim(), "**角色**：医疗顾问", "got: {md}");
    }

    #[test]
    fn list_bullet_and_ordered() {
        let numbering = format!(
            r#"<w:numbering xmlns:w="{WNS}">
<w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/></w:lvl></w:abstractNum>
<w:abstractNum w:abstractNumId="1"><w:lvl w:ilvl="0"><w:numFmt w:val="decimal"/></w:lvl></w:abstractNum>
<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>
<w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num></w:numbering>"#
        );
        let (md, _, _) = map_parts(
            &doc(r#"<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>b1</w:t></w:r></w:p>
<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>b2</w:t></w:r></w:p>
<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="2"/></w:numPr></w:pPr><w:r><w:t>o1</w:t></w:r></w:p>
<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="2"/></w:numPr></w:pPr><w:r><w:t>o2</w:t></w:r></w:p>"#),
            "", &numbering, "", "", &empty_media(),
        );
        assert!(md.contains("- b1\n- b2"), "got: {md}");
        assert!(md.contains("1. o1\n2. o2"), "got: {md}");
    }

    #[test]
    fn deep_ilvl_list_is_not_indented_code() {
        // Word 的 ilvl 偏大（如 2/3）不得变成 ≥4 前导空格（会被 Markdown 当缩进代码块）。
        // 归一化后：首项 depth=0（无缩进），次项 depth=1（2 空格），均 <4。
        let (md, _, _) = map(r#"<w:p><w:pPr><w:numPr><w:ilvl w:val="2"/><w:numId w:val="5"/></w:numPr></w:pPr><w:r><w:t>基于纯几何模型的仿真</w:t></w:r></w:p>
<w:p><w:pPr><w:numPr><w:ilvl w:val="3"/><w:numId w:val="5"/></w:numPr></w:pPr><w:r><w:t>在计算机图形学领域中</w:t></w:r></w:p>"#);
        assert!(!md.contains("    "), "must not indent by 4+ spaces, got: {md}");
        assert!(!md.contains("```"), "must not become code fence, got: {md}");
        assert!(md.starts_with("- 基于纯几何模型的仿真"), "first item flush-left, got: {md}");
        assert!(md.contains("\n  - 在计算机图形学领域中"), "second item nested at 2 spaces, got: {md}");
    }

    #[test]
    fn multilevel_list_keeps_depth_beyond_one() {
        // 批次 F 后续：去掉 .min(1) 封顶后，连续列表 ilvl 0/1/2 → depth 0/1/2（0/2/4 前导空格），
        // 三级嵌套不被压平；因列表行恒带标记且首项 depth=0，仍不触发缩进代码块。
        let numbering = format!(
            r#"<w:numbering xmlns:w="{WNS}">
<w:abstractNum w:abstractNumId="0"><w:lvl w:ilvl="0"><w:numFmt w:val="bullet"/></w:lvl></w:abstractNum>
<w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num></w:numbering>"#
        );
        let (md, _, _) = map_parts(
            &doc(r#"<w:p><w:pPr><w:numPr><w:ilvl w:val="0"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>甲</w:t></w:r></w:p>
<w:p><w:pPr><w:numPr><w:ilvl w:val="1"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>乙</w:t></w:r></w:p>
<w:p><w:pPr><w:numPr><w:ilvl w:val="2"/><w:numId w:val="1"/></w:numPr></w:pPr><w:r><w:t>丙</w:t></w:r></w:p>"#),
            "", &numbering, "", "", &empty_media(),
        );
        assert!(md.contains("- 甲\n  - 乙\n    - 丙"), "got: {md}");
        assert!(!md.contains("```"), "must not become code fence, got: {md}");
    }

    #[test]
    fn plain_table_becomes_gfm() {
        let (md, w, stats) = map(r#"<w:tbl>
<w:tr><w:tc><w:p><w:r><w:t>a</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>b</w:t></w:r></w:p></w:tc></w:tr>
<w:tr><w:tc><w:p><w:r><w:t>c</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>d</w:t></w:r></w:p></w:tc></w:tr></w:tbl>"#);
        assert!(md.contains("| a | b |"), "got: {md}");
        assert!(md.contains("| --- | --- |"), "got: {md}");
        assert!(!md.contains("<table>"));
        assert!(!w.iter().any(|x| x.code == "merged_table"));
        assert_eq!(stats.tables, 1);
    }

    #[test]
    fn merged_table_becomes_html_with_warning() {
        let (md, w, stats) = map(r#"<w:tbl>
<w:tr><w:tc><w:tcPr><w:gridSpan w:val="2"/></w:tcPr><w:p><w:r><w:t>wide</w:t></w:r></w:p></w:tc></w:tr>
<w:tr><w:tc><w:p><w:r><w:t>l</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>r</w:t></w:r></w:p></w:tc></w:tr></w:tbl>"#);
        assert!(md.contains("<table>"), "got: {md}");
        assert!(md.contains("<td colspan=\"2\">wide</td>"), "got: {md}");
        assert!(w.iter().any(|x| x.code == "merged_table"));
        assert_eq!(stats.merged_tables, 1);
    }

    #[test]
    fn external_hyperlink_to_md_link() {
        let rels = r#"<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.com" TargetMode="External"/></Relationships>"#;
        let (md, _, _) = map_parts(
            &doc(r#"<w:p><w:hyperlink r:id="rId1"><w:r><w:t>site</w:t></w:r></w:hyperlink></w:p>"#),
            rels, "", "", "", &empty_media(),
        );
        assert!(md.contains("[site](https://example.com)"), "got: {md}");
    }

    #[test]
    fn footnote_reference_and_definition() {
        let footnotes = format!(
            r#"<w:footnotes xmlns:w="{WNS}"><w:footnote w:id="1"><w:p><w:r><w:t>Note one</w:t></w:r></w:p></w:footnote></w:footnotes>"#
        );
        let (md, w, stats) = map_parts(
            &doc(r#"<w:p><w:r><w:t>See </w:t></w:r><w:r><w:footnoteReference w:id="1"/></w:r></w:p>"#),
            "", "", "", &footnotes, &empty_media(),
        );
        assert!(md.contains("See [^1]"), "got: {md}");
        assert!(md.contains("[^1]: Note one"), "got: {md}");
        assert_eq!(stats.footnotes, 1);
        assert!(w.iter().any(|x| x.code == "footnote"));
    }

    #[test]
    fn monospace_paragraph_becomes_code_fence() {
        let (md, _, _) = map(r#"<w:p><w:r><w:rPr><w:rFonts w:ascii="Consolas"/></w:rPr><w:t>x = 1</w:t></w:r></w:p>"#);
        assert!(md.contains("```\nx = 1\n```"), "got: {md}");
    }

    #[test]
    fn monospace_cjk_paragraph_is_not_code() {
        // 含中文正文的等宽段落不得判为代码块（等宽字体启发式对中文论文正文的回归护栏）
        let (md, _, _) = map(r#"<w:p><w:r><w:rPr><w:rFonts w:ascii="Consolas"/></w:rPr><w:t>随着计算机图形学的发展</w:t></w:r></w:p>"#);
        assert!(!md.contains("```"), "CJK prose must not become code fence, got: {md}");
        assert!(md.contains("随着计算机图形学的发展"), "content preserved, got: {md}");
    }

    #[test]
    fn textbox_content_flattened_with_warning() {
        let body = r#"<w:p><w:r><w:t>normal</w:t></w:r></w:p>
<w:p><w:r><mc:AlternateContent xmlns:mc="http://schemas.openxmlformats.org/markup-compatibility/2006">
<w:txbxContent><w:p><w:r><w:t>in a box</w:t></w:r></w:p></w:txbxContent>
</mc:AlternateContent></w:r></w:p>"#;
        let (md, w, stats) = map(body);
        assert!(md.contains("in a box"), "got: {md}");
        assert!(w.iter().any(|x| x.code == "textbox"));
        assert_eq!(stats.dropped_textboxes, 1);
    }

    #[test]
    fn slugify_strips_unsafe_and_spaces() {
        assert_eq!(slugify("My Doc"), "My-Doc");
        assert_eq!(slugify("a/b:c*d?e"), "abcde");
        assert_eq!(slugify("  中文 标题  "), "中文-标题");
        assert_eq!(slugify("///"), "Untitled");
    }

    // 跨语言契约：Rust assign_anchors 与前端 slugAllInOrder 读**同一份** fixture 逐字符断言。
    // 任何一方改规则不同步 → 本测试与 `npm run test:heading-anchor` 同时红。
    #[test]
    fn heading_anchor_slug_matches_shared_fixture() {
        let raw = include_str!("../../src/tests/fixtures/heading-slug.json");
        let v: serde_json::Value = serde_json::from_str(raw).expect("fixture json");
        let cases = v["cases"].as_array().expect("cases array");
        for c in cases {
            let inputs: Vec<String> = c["in"]
                .as_array()
                .unwrap()
                .iter()
                .map(|x| x.as_str().unwrap().to_string())
                .collect();
            let expected: Vec<String> = c["expected"]
                .as_array()
                .unwrap()
                .iter()
                .map(|x| x.as_str().unwrap().to_string())
                .collect();
            assert_eq!(assign_anchors(&inputs), expected, "case: {inputs:?}");
        }
    }

    // ---- 批次 F 后续：交叉引用（REF/PAGEREF/NOTEREF 域 + 书签锚点超链接）----

    fn h1_styles() -> String {
        format!(r#"<w:styles xmlns:w="{WNS}"><w:style w:type="paragraph" w:styleId="H1"><w:name w:val="heading 1"/><w:pPr><w:outlineLvl w:val="0"/></w:pPr></w:style></w:styles>"#)
    }

    #[test]
    fn complex_field_ref_to_heading_becomes_anchor_link() {
        // 一个带书签的标题 + 一个复杂域 REF 指向它 → [标题](#锚点)；域码绝不泄漏。
        let (md, _, stats) = map_parts(
            &doc(r#"<w:p><w:pPr><w:pStyle w:val="H1"/></w:pPr><w:bookmarkStart w:id="0" w:name="_Ref1"/><w:r><w:t>目标标题</w:t></w:r><w:bookmarkEnd w:id="0"/></w:p>
<w:p><w:r><w:t>参见 </w:t></w:r><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> REF _Ref1 \h \* MERGEFORMAT </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>目标标题</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r><w:r><w:t> 处。</w:t></w:r></w:p>"#),
            "", "", &h1_styles(), "", &empty_media(),
        );
        assert!(md.contains("[目标标题](#目标标题)"), "got: {md}");
        assert!(!md.contains("MERGEFORMAT") && !md.contains("_Ref1"), "field code must not leak, got: {md}");
        assert_eq!(stats.xref_resolved, 1);
    }

    #[test]
    fn fldsimple_ref_to_heading_becomes_anchor_link() {
        let (md, _, stats) = map_parts(
            &doc(r#"<w:p><w:pPr><w:pStyle w:val="H1"/></w:pPr><w:bookmarkStart w:id="0" w:name="_Ref1"/><w:r><w:t>引言</w:t></w:r><w:bookmarkEnd w:id="0"/></w:p>
<w:p><w:r><w:t>见 </w:t></w:r><w:fldSimple w:instr=" REF _Ref1 \h "><w:r><w:t>引言</w:t></w:r></w:fldSimple><w:r><w:t> 端。</w:t></w:r></w:p>"#),
            "", "", &h1_styles(), "", &empty_media(),
        );
        assert!(md.contains("[引言](#引言)"), "got: {md}");
        assert_eq!(stats.xref_resolved, 1);
    }

    #[test]
    fn ref_to_non_heading_degrades_with_warning() {
        // REF 目标书签未落在标题上（图/表/公式）→ 保留可见文本、不成链、带 xref 告警。
        let (md, w, stats) = map_parts(
            &doc(r#"<w:p><w:pPr><w:pStyle w:val="H1"/></w:pPr><w:r><w:t>某标题</w:t></w:r></w:p>
<w:p><w:r><w:t>见图 </w:t></w:r><w:fldSimple w:instr=" REF _RefFig1 \h "><w:r><w:t>1</w:t></w:r></w:fldSimple></w:p>"#),
            "", "", &h1_styles(), "", &empty_media(),
        );
        assert!(md.contains("见图 1"), "got: {md}");
        assert!(!md.contains("[1]("), "must not link non-heading, got: {md}");
        assert!(w.iter().any(|x| x.code == "xref"), "expected xref warning");
        assert_eq!(stats.xref_degraded, 1);
    }

    #[test]
    fn internal_anchor_hyperlink_to_heading_becomes_link() {
        // w:anchor 内部超链接（无 r:id）指向带书签标题 → [文本](#锚点)。
        let (md, _, stats) = map_parts(
            &doc(r#"<w:p><w:pPr><w:pStyle w:val="H1"/></w:pPr><w:bookmarkStart w:id="0" w:name="_Ref1"/><w:r><w:t>结论</w:t></w:r><w:bookmarkEnd w:id="0"/></w:p>
<w:p><w:hyperlink w:anchor="_Ref1" w:history="1"><w:r><w:t>结论</w:t></w:r></w:hyperlink></w:p>"#),
            "", "", &h1_styles(), "", &empty_media(),
        );
        assert!(md.contains("[结论](#结论)"), "got: {md}");
        assert_eq!(stats.xref_resolved, 1);
    }

    #[test]
    fn ref_to_present_non_heading_becomes_link_with_anchor() {
        // 批次 F 后续：被 REF 命中、且正文里确有 bookmarkStart 的非标题目标（参考文献条目）
        // → 引用转 [52](#_RefBib)，目标段首发字面 <a id="_RefBib"></a> 作落点；计数 resolved、无降级。
        let (md, _, stats) = map_parts(
            &doc(r#"<w:p><w:bookmarkStart w:id="0" w:name="_RefBib"/><w:r><w:t>文献条目全文</w:t></w:r><w:bookmarkEnd w:id="0"/></w:p>
<w:p><w:r><w:t>见 </w:t></w:r><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> REF _RefBib \h </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>52</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r><w:r><w:t>。</w:t></w:r></w:p>"#),
            "", "", "", "", &empty_media(),
        );
        assert!(md.contains("<a id=\"_RefBib\"></a>"), "anchor emitted at target, got: {md}");
        assert!(md.contains("[52](#_RefBib)"), "citation becomes link, got: {md}");
        assert!(!md.contains("REF"), "field code must not leak, got: {md}");
        assert_eq!(stats.xref_resolved, 1);
        assert_eq!(stats.xref_degraded, 0);
    }

    #[test]
    fn hyperlink_anchor_to_present_non_heading_becomes_link() {
        // 内部锚点超链接指向正文中存在的非标题书签（图题）→ [图 1](#_RefFig) + 目标处发 <a id>。
        let (md, _, stats) = map_parts(
            &doc(r#"<w:p><w:bookmarkStart w:id="0" w:name="_RefFig"/><w:r><w:t>图 1 系统架构</w:t></w:r><w:bookmarkEnd w:id="0"/></w:p>
<w:p><w:hyperlink w:anchor="_RefFig"><w:r><w:t>图 1</w:t></w:r></w:hyperlink></w:p>"#),
            "", "", "", "", &empty_media(),
        );
        assert!(md.contains("<a id=\"_RefFig\"></a>"), "anchor emitted at target, got: {md}");
        assert!(md.contains("[图 1](#_RefFig)"), "hyperlink becomes link, got: {md}");
        assert_eq!(stats.xref_resolved, 1);
    }

    #[test]
    fn heading_target_does_not_emit_a_id() {
        // 被引用的书签落在标题上：解析为标题 slug 链接，但**不**发字面 <a id>（标题自带锚点）。
        let (md, _, stats) = map_parts(
            &doc(r#"<w:p><w:pPr><w:pStyle w:val="H1"/></w:pPr><w:bookmarkStart w:id="0" w:name="_Ref1"/><w:r><w:t>目标标题</w:t></w:r><w:bookmarkEnd w:id="0"/></w:p>
<w:p><w:hyperlink w:anchor="_Ref1"><w:r><w:t>目标标题</w:t></w:r></w:hyperlink></w:p>"#),
            "", "", &h1_styles(), "", &empty_media(),
        );
        assert!(md.contains("[目标标题](#目标标题)"), "got: {md}");
        assert!(!md.contains("<a id"), "heading target must not emit a id, got: {md}");
        assert_eq!(stats.xref_resolved, 1);
    }

    #[test]
    fn complex_field_without_separate_keeps_result() {
        // 回归（用户真实论文）：REF 域无 `separate` 时，begin..end 间的普通 run 就是缓存结果，
        // 不得当域码丢弃（否则 `[52]` 变空括号 `[]`）。目标非标题→降级为纯文本。
        let (md, _, stats) = map_parts(
            &doc(r#"<w:p><w:r><w:t>[</w:t></w:r><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> REF _Ref52 \h </w:instrText></w:r><w:r><w:t>52</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r><w:r><w:t>]</w:t></w:r></w:p>"#),
            "", "", "", "", &empty_media(),
        );
        assert!(md.contains("[52]"), "result must not be dropped, got: {md}");
        assert!(!md.contains("REF") && !md.contains("_Ref52"), "field code must not leak, got: {md}");
        assert_eq!(stats.xref_degraded, 1);
    }

    #[test]
    fn seq_field_without_separate_keeps_number() {
        // 回归：参考文献自动编号 SEQ 域常无 separate，编号不得丢失。
        let (md, _, _) = map_parts(
            &doc(r#"<w:p><w:r><w:t>[</w:t></w:r><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> SEQ ref \* ARABIC </w:instrText></w:r><w:r><w:t>52</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r><w:r><w:t>]</w:t></w:r></w:p>"#),
            "", "", "", "", &empty_media(),
        );
        assert!(md.contains("[52]"), "seq number must survive, got: {md}");
        assert!(!md.contains("SEQ") && !md.contains("ARABIC"), "field code must not leak, got: {md}");
    }

    #[test]
    fn field_with_separate_ignores_pre_separate_runs() {
        // 有 separate 时，separate 前的普通 run 属域码区→丢弃，只取 separate 后的结果（不重复）。
        let (md, _, _) = map_parts(
            &doc(r#"<w:p><w:r><w:t>文献</w:t></w:r><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> REF _Ref52 </w:instrText></w:r><w:r><w:t>52</w:t></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:t>52</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r></w:p>"#),
            "", "", "", "", &empty_media(),
        );
        assert_eq!(md.trim(), "文献52", "must not double the number, got: {md}");
    }

    #[test]
    fn sanitize_rel_rejects_escape() {
        assert_eq!(sanitize_rel("a\\b/c.md").unwrap(), "a/b/c.md");
        assert!(sanitize_rel("../evil.md").is_err());
    }

    #[test]
    fn relpath_from_same_and_cross_dir() {
        assert_eq!(relpath_from("Docs/T", "Docs/T/abc.png"), "abc.png");
        assert_eq!(relpath_from("Docs/T", "Other/x.png"), "../../Other/x.png");
    }

    // ---- commit IO（临时库验写盘 + 去重命中不重存 + 冲突 -2 + 越界拒）----

    fn temp_vault(tag: &str) -> std::path::PathBuf {
        let base = std::env::temp_dir().join(format!("nl-docx-{}-{}", tag, std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).unwrap();
        std::fs::canonicalize(&base).unwrap()
    }

    fn commit_args(vault: &Path, doc_rel: &str, md: &str, images: Vec<CommitImage>, dedup: HashMap<String, String>) -> DocxCommitArgs {
        DocxCommitArgs { vault_root: vault.display().to_string(), dest_dir: "".into(), md: md.into(), doc_rel: doc_rel.into(), images, dedup_index: dedup, new_title: None }
    }

    #[test]
    fn commit_writes_md_and_dedups_images() {
        let v = temp_vault("dedup");
        let png = b"\x89PNGDATA".to_vec();
        let sha = sha256_hex(&png);
        let b64 = b64_encode(&png);
        let imgs = vec![
            CommitImage { sha256: sha.clone(), ext: "png".into(), data_b64: b64.clone(), planned_rel: "Doc/img.png".into() },
            CommitImage { sha256: sha.clone(), ext: "png".into(), data_b64: b64.clone(), planned_rel: "Doc/img.png".into() },
        ];
        let r = docx_commit(commit_args(&v, "Doc/Doc.md", "# hi", imgs, HashMap::new())).unwrap();
        assert_eq!(r.doc_rel, "Doc/Doc.md");
        assert_eq!(r.written_images.len(), 1, "同 sha 应只落一份");
        assert!(v.join("Doc").join("Doc.md").exists());
        assert!(r.updated_index.contains_key(&sha));

        // 再来一次、dedup 命中 → reused、不重存
        let r2 = docx_commit(commit_args(&v, "Doc2/Doc2.md", "# hi2", vec![CommitImage { sha256: sha.clone(), ext: "png".into(), data_b64: b64.clone(), planned_rel: "Doc2/img.png".into() }], r.updated_index.clone())).unwrap();
        assert_eq!(r2.written_images.len(), 0);
        assert_eq!(r2.reused_images.len(), 1);
    }

    #[test]
    fn commit_self_heals_missing_reused_image() {
        let v = temp_vault("selfheal");
        let png = b"\x89PNGDATA".to_vec();
        let sha = sha256_hex(&png);
        let b64 = b64_encode(&png);
        // 索引声称图在 "Old/loc/x.png"，但当前库里根本没有（模拟跨库污染 / 手删）
        let mut stale = HashMap::new();
        stale.insert(sha.clone(), "Old/loc/x.png".to_string());
        let imgs = vec![CommitImage { sha256: sha.clone(), ext: "png".into(), data_b64: b64, planned_rel: "Doc/x.png".into() }];
        let r = docx_commit(commit_args(&v, "Doc/Doc.md", "![](../Old/loc/x.png)", imgs, stale)).unwrap();
        // 应自愈：按索引路径补写，而非静默复用
        assert_eq!(r.written_images, vec!["Old/loc/x.png".to_string()], "缺失的 reused 目标应被补写自愈");
        assert_eq!(r.reused_images.len(), 0);
        assert!(v.join("Old").join("loc").join("x.png").exists(), "自愈应把图写到索引指向的库内路径");
        assert_eq!(std::fs::read(v.join("Old").join("loc").join("x.png")).unwrap(), png);
    }

    #[test]
    fn commit_conflict_appends_suffix() {
        let v = temp_vault("conflict");
        docx_commit(commit_args(&v, "N/N.md", "first", vec![], HashMap::new())).unwrap();
        let r = docx_commit(commit_args(&v, "N/N.md", "second", vec![], HashMap::new())).unwrap();
        assert_eq!(r.doc_rel, "N/N-2.md");
    }

    #[test]
    fn commit_rejects_path_escape() {
        let v = temp_vault("escape");
        assert!(docx_commit(commit_args(&v, "../evil.md", "x", vec![], HashMap::new())).is_err());
    }

    #[test]
    fn relocate_import_copies_tree_into_target() {
        // 模拟独立解析模式“另存为”：源 = temp 一次性目录（含 .md + 嵌套子目录下的图），
        // 目标 = 用户选定的新目录。验证递归复制、保留相对路径、覆写已存在的目标。
        let src = temp_vault("relocate_src");
        let dst = temp_vault("relocate_dst");
        std::fs::create_dir_all(src.join("附件").join("Doc")).unwrap();
        std::fs::write(src.join("Doc.md"), b"# hi").unwrap();
        std::fs::write(src.join("附件").join("Doc").join("a.png"), b"PNGDATA").unwrap();
        // 预置同名目标文件，验证被覆写
        std::fs::write(dst.join("Doc.md"), b"stale").unwrap();
        relocate_import(src.display().to_string(), dst.display().to_string()).unwrap();
        assert_eq!(std::fs::read_to_string(dst.join("Doc.md")).unwrap(), "# hi");
        assert!(dst.join("附件").join("Doc").join("a.png").exists());
        assert_eq!(std::fs::read(dst.join("附件").join("Doc").join("a.png")).unwrap(), b"PNGDATA");
        // 不删源
        assert!(src.join("Doc.md").exists());
    }

    #[test]
    fn relocate_import_creates_missing_target_dir() {
        // 目标不存在 → 应自动建目录（允许用户选一个新建路径）
        let src = temp_vault("relocate2_src");
        let base = temp_vault("relocate2_dstbase");
        let dst = base.join("does-not-exist-yet");
        std::fs::write(src.join("x.md"), b"x").unwrap();
        relocate_import(src.display().to_string(), dst.display().to_string()).unwrap();
        assert!(dst.join("x.md").exists());
    }

    // ==================== 子项目②：OMML → LaTeX 公式解析（黄金用例） ====================

    fn mr(t: &str) -> String {
        format!("<m:r><m:t>{}</m:t></m:r>", t)
    }
    // 操作数槽：<m:name>inner</m:name>（e/num/den/sub/sup/deg/lim/fName 等）
    fn sl(name: &str, inner: &str) -> String {
        format!("<m:{0}>{1}</m:{0}>", name, inner)
    }
    fn om(inner: &str) -> String {
        format!("<m:oMath>{}</m:oMath>", inner)
    }
    fn mpara(inner: &str) -> String {
        map(&format!("<w:p>{}</w:p>", inner)).0
    }

    #[test]
    fn math_fraction_inline() {
        let f = format!("<m:f>{}</m:f>", sl("num", &mr("1")) + &sl("den", &mr("2")));
        assert!(mpara(&om(&f)).contains(r#"$\frac{1}{2}$"#));
    }

    #[test]
    fn math_scripts() {
        assert!(mpara(&om(&format!("<m:sSup>{}</m:sSup>", sl("e", &mr("x")) + &sl("sup", &mr("2"))))).contains(r#"{x}^{2}"#));
        assert!(mpara(&om(&format!("<m:sSub>{}</m:sSub>", sl("e", &mr("x")) + &sl("sub", &mr("i"))))).contains(r#"{x}_{i}"#));
        let ss = format!("<m:sSubSup>{}{}{}</m:sSubSup>", sl("e", &mr("x")), sl("sub", &mr("i")), sl("sup", &mr("2")));
        assert!(mpara(&om(&ss)).contains(r#"{x}_{i}^{2}"#));
    }

    #[test]
    fn math_radical_sqrt_and_nthroot() {
        let sq = format!("<m:rad><m:radPr><m:degHide m:val=\"1\"/></m:radPr>{}{}</m:rad>", sl("deg", ""), sl("e", &mr("2")));
        assert!(mpara(&om(&sq)).contains(r#"\sqrt{2}"#));
        let nr = format!("<m:rad><m:radPr/>{}{}</m:rad>", sl("deg", &mr("3")), sl("e", &mr("x")));
        assert!(mpara(&om(&nr)).contains(r#"\sqrt[3]{x}"#));
    }

    #[test]
    fn math_nary_sum_with_limits() {
        let n = format!("<m:nary><m:naryPr><m:chr m:val=\"\u{2211}\"/></m:naryPr>{}{}{}</m:nary>",
            sl("sub", &mr("i=1")), sl("sup", &mr("n")), sl("e", &mr("i")));
        assert!(mpara(&om(&n)).contains(r#"\sum_{i=1}^{n} i"#));
    }

    #[test]
    fn math_nary_integral_hides_upper() {
        let n = format!("<m:nary><m:naryPr><m:chr m:val=\"\u{222B}\"/><m:hideSup/></m:naryPr>{}{}{}</m:nary>",
            sl("sub", &mr("0")), sl("sup", &mr("1")), sl("e", &mr("x")));
        let md = mpara(&om(&n));
        assert!(md.contains(r#"\int_{0} x"#), "got: {}", md);
        assert!(!md.contains("^{"), "upper must be hidden: {}", md);
    }

    #[test]
    fn math_delimiter_paren() {
        let d = format!("<m:d><m:dPr><m:begChr m:val=\"(\"/><m:endChr m:val=\")\"/></m:dPr>{}</m:d>", sl("e", &mr("a+b")));
        let md = mpara(&om(&d));
        assert!(md.contains(r#"\left("#) && md.contains(r#"\right)"#) && md.contains("a+b"), "got: {}", md);
    }

    #[test]
fn math_delimiter_fullwidth_normalized() {
        // Word 中文输入法打出的全角括号（U+FF08/FF09）须归一化为半角，否则 \left 拿到非法定界符 KaTeX 报错
        let d = format!("<m:d><m:dPr><m:begChr m:val=\"\u{FF08}\"/><m:endChr m:val=\"\u{FF09}\"/></m:dPr>{}</m:d>", sl("e", &mr("a+b")));
        let md = mpara(&om(&d));
        assert!(md.contains(r#"\left("#) && md.contains(r#"\right)"#), "got: {}", md);
        assert!(!md.contains('\u{FF08}') && !md.contains('\u{FF09}'), "fullwidth leaked: {}", md);
    }

    #[test]
    fn math_matrix_via_delimiter_picks_pmatrix() {
        let mrow = |cells: &[&str]| format!("<m:mr>{}</m:mr>", cells.iter().map(|c| sl("e", &mr(c))).collect::<Vec<_>>().join(""));
        let m = format!("<m:m>{}{}</m:m>", mrow(&["a", "b"]), mrow(&["c", "d"]));
        let d = format!("<m:d><m:dPr><m:begChr m:val=\"(\"/><m:endChr m:val=\")\"/></m:dPr>{}</m:d>", sl("e", &m));
        let md = mpara(&om(&d));
        assert!(md.contains("pmatrix") && md.contains("a & b") && md.contains("c & d"), "got: {}", md);
    }

    #[test]
    fn math_accents_default_hat_and_vec() {
        assert!(mpara(&om(&format!("<m:acc>{}</m:acc>", sl("e", &mr("a"))))).contains(r#"\hat{a}"#));
        let v = format!("<m:acc><m:accPr><m:chr m:val=\"\u{20D7}\"/></m:accPr>{}</m:acc>", sl("e", &mr("b")));
        assert!(mpara(&om(&v)).contains(r#"\vec{b}"#));
    }

    #[test]
    fn math_func_name() {
        let fu = format!("<m:func>{}{}</m:func>", sl("fName", &mr("sin")), sl("e", &mr("x")));
        assert!(mpara(&om(&fu)).contains(r#"\sin x"#));
    }

    #[test]
    fn math_limlow_becomes_lim() {
        let l = format!("<m:limLow>{}{}</m:limLow>", sl("e", &mr("lim")), sl("lim", &mr("x")));
        assert!(mpara(&om(&l)).contains(r#"\lim_{x}"#));
    }

    #[test]
    fn math_eqarr_becomes_cases() {
        let e = format!("<m:eqArr>{}{}</m:eqArr>", sl("e", &mr("a")), sl("e", &mr("b")));
        let md = mpara(&om(&e));
        assert!(md.contains(r#"\begin{cases}"#) && md.contains(r#"\end{cases}"#) && md.contains("a") && md.contains("b"), "got: {}", md);
    }

    #[test]
    fn math_bar_groupchr_box_and_scr() {
        let bar = format!("<m:bar><m:barPr><m:pos m:val=\"barOver\"/></m:barPr>{}</m:bar>", sl("e", &mr("x")));
        assert!(mpara(&om(&bar)).contains(r#"\overline{x}"#));
        let gc = format!("<m:groupChr><m:groupChrPr><m:chr m:val=\"\u{23DF}\"/></m:groupChrPr>{}</m:groupChr>", sl("e", &mr("y")));
        assert!(mpara(&om(&gc)).contains(r#"\underbrace{y}"#));
        assert!(mpara(&om(&format!("<m:borderBox>{}</m:borderBox>", sl("e", &mr("z"))))).contains(r#"\boxed{z}"#));
        let sc = "<m:r><m:rPr><m:scr m:val=\"doubleStruck\"/></m:rPr><m:t>R</m:t></m:r>";
        assert!(mpara(&om(sc)).contains(r#"\mathbb{R}"#));
    }

    #[test]
    fn math_block_display_from_omathtext_para() {
        let md = map(&format!("<w:p><m:oMathPara>{}</m:oMathPara></w:p>", om(&mr("E")))).0;
        assert!(md.contains("$$\nE\n$$"), "got: {}", md);
    }

    #[test]
    fn math_inline_among_text() {
        let body = format!("<w:p><w:r><w:t>设 </w:t></w:r>{}<w:r><w:t> 则</w:t></w:r></w:p>",
            om(&format!("<m:f>{}{}</m:f>", sl("num", &mr("a")), sl("den", &mr("b")))));
        let md = map(&body).0;
        assert!(md.contains(r#"$\frac{a}{b}$"#), "got: {}", md);
    }

    #[test]
    fn math_stats_counted_and_unknown_degrades_with_warning() {
        let (md, w, s) = map(&format!("<w:p>{}</w:p>", om(&format!("<m:dne>{}</m:dne>", mr("x")))));
        assert_eq!(s.math, 1, "one oMath counted");
        assert!(w.iter().any(|x| x.code == "math"), "unknown construct warns");
        assert!(md.contains('x'), "content not dropped: {}", md);
    }

    #[test]
    fn math_escapes_special_hash() {
        // m:t 里的字面 # 必须转义为 \#（否则 KaTeX 断整个区间）
        assert!(mpara(&om(&mr("a#b"))).contains(r#"$a\#b$"#));
    }

    #[test]
    fn math_wraps_cjk_run_in_text() {
        // 含中文的 run → \text{}（公式编号标签场景）
        assert!(mpara(&om(&mr("式(3.16)"))).contains(r#"\text{式(3.16)}"#));
    }
}
