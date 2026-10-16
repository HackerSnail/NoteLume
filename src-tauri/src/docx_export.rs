// 批次 F 子项目①：md → docx 结构导出（写侧）。
//
// 分工（见 docs/superpowers/specs/2026-10-16-docx-export-math-design.md §三）：
//   前端把当前 ProseMirror 文档序列化为 Docx-IR（JSON 节点树，方言构造判定只此一次）→
//   本模块用 docx-rs 把 IR 组装为 OOXML 并 zip 落盘。数学此阶段降级为纯文本（③ 再换 OMML 注入）。
//
// 保真取向：产物要能被真实 Word 打开，且尽量能被现有导入引擎 docx_preview 读回等价结构（回环验收）。
// 关键坑（Phase 0 spike 实测）：docx-rs 默认 styles.xml 的 Heading1 不含 outlineLvl，导入侧认不出标题层级；
// 故本模块显式写入带 outlineLvl + 名称 "heading N" 的标题样式（NLH1..NLH6）。

use serde::Deserialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};

// ==================== Docx-IR（前端产出的 JSON 节点树） ====================

#[derive(Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct IRInline {
    pub text: String,
    pub bold: bool,
    pub italic: bool,
    pub strike: bool,
    pub code: bool,
    /// 外链（http/https）；给出则本段文本作为链接文字。
    pub link: Option<String>,
    /// 图片：只带库内相对路径，尺寸可缺（Rust 读字节后由 docx-rs 计算）。
    pub image: Option<IRImage>,
    /// 数学：① 阶段把 latex 源作为普通文本输出（text 即其内容）。
    pub math: bool,
    /// 脚注引用，指向某个 FootnoteDef.id。
    pub footnote: Option<usize>,
}

#[derive(Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct IRImage {
    pub rel: String,
    pub width: Option<u32>,
    pub height: Option<u32>,
}

#[derive(Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct IRListItem {
    pub level: usize,
    pub checked: Option<bool>,
    pub inline: Vec<IRInline>,
}

#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase", tag = "type")]
pub enum IRBlock {
    Heading { level: u8, inline: Vec<IRInline> },
    Paragraph { inline: Vec<IRInline> },
    Quote { inline: Vec<IRInline> },
    Code { text: String, lang: Option<String> },
    List { ordered: bool, items: Vec<IRListItem> },
    Table {
        header: Option<Vec<Vec<IRInline>>>,
        rows: Vec<Vec<Vec<IRInline>>>,
    },
    FootnoteDef { id: usize, inline: Vec<IRInline> },
}

#[derive(Deserialize, Clone, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct DocxIR {
    pub title: Option<String>,
    pub blocks: Vec<IRBlock>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportDocxArgs {
    pub ir: DocxIR,
    pub vault_root: String,
    /// 目标 .docx 绝对路径（前端 save 对话框选定）。
    pub out_path: String,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportWarning {
    pub code: String,
    pub message: String,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportStats {
    pub headings: u32,
    pub paragraphs: u32,
    pub lists: u32,
    pub tables: u32,
    pub images: u32,
    pub footnotes: u32,
    pub code_blocks: u32,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportDocx {
    pub out_path: String,
    pub warnings: Vec<ExportWarning>,
    pub stats: ExportStats,
}

// ==================== 构建上下文 ====================

struct ExCtx {
    vault_root: PathBuf,
    warnings: Vec<ExportWarning>,
    stats: ExportStats,
    footnote_defs: HashMap<usize, Vec<IRInline>>,
    missing_images: Vec<String>,
}

impl ExCtx {
    fn warn(&mut self, code: &str, message: &str) {
        self.warnings.push(ExportWarning { code: code.to_string(), message: message.to_string() });
    }
}

// docx-rs 编号常量：有序列表复用其内建默认（numId=1 十进制），无序列表自建（numId/abstract=100）。
const ORDERED_NUM_ID: usize = 1;
const BULLET_ABS_ID: usize = 100;
const BULLET_NUM_ID: usize = 100;

// ==================== 命令：export_docx ====================

#[tauri::command]
pub fn export_docx(args: ExportDocxArgs) -> Result<ExportDocx, String> {
    use docx_rs::*;

    let mut ctx = ExCtx {
        vault_root: PathBuf::from(&args.vault_root),
        warnings: Vec::new(),
        stats: ExportStats {
            headings: 0,
            paragraphs: 0,
            lists: 0,
            tables: 0,
            images: 0,
            footnotes: 0,
            code_blocks: 0,
        },
        footnote_defs: HashMap::new(),
        missing_images: Vec::new(),
    };
    // 预收集脚注定义（id → 内容），供引用点取用。
    for b in &args.ir.blocks {
        if let IRBlock::FootnoteDef { id, inline } = b {
            ctx.footnote_defs.insert(*id, inline.clone());
        }
    }

    // 标题样式：显式带 outlineLvl + 名称 "heading N"，修 spike 发现的层级丢失缺口。
    let mut docx = Docx::new();
    for lvl in 1..=6u8 {
        docx = docx.add_style(
            Style::new(format!("NLH{}", lvl), StyleType::Paragraph)
                .name(format!("heading {}", lvl))
                .outline_lvl((lvl - 1) as usize),
        );
    }
    // 无序列表编号（bullet），有序列表复用内建 numId=1。
    docx = docx
        .add_abstract_numbering(
            AbstractNumbering::new(BULLET_ABS_ID).add_level(
                Level::new(
                    0,
                    Start::new(1),
                    NumberFormat::new("bullet"),
                    LevelText::new("\u{2022}"),
                    LevelJc::new("left"),
                )
                .indent(Some(420), Some(SpecialIndentType::Hanging(360)), None, None),
            ),
        )
        .add_numbering(Numbering::new(BULLET_NUM_ID, BULLET_ABS_ID));

    for b in &args.ir.blocks {
        match b {
            IRBlock::Heading { level, inline } => {
                let lvl = (*level).clamp(1, 6);
                let sid = format!("NLH{}", lvl);
                let p = build_paragraph(inline, &mut ctx).style(&sid);
                docx = docx.add_paragraph(p);
                ctx.stats.headings += 1;
            }
            IRBlock::Paragraph { inline } => {
                docx = docx.add_paragraph(build_paragraph(inline, &mut ctx));
                ctx.stats.paragraphs += 1;
            }
            IRBlock::Quote { inline } => {
                // 导入侧无引用概念（读回为普通段落），此处仍以左缩进保真 Word 显示。
                let p = build_paragraph(inline, &mut ctx)
                    .indent(Some(480), None, Some(480), None);
                docx = docx.add_paragraph(p);
                ctx.stats.paragraphs += 1;
            }
            IRBlock::Code { text, lang } => {
                let _ = lang; // ① 阶段不写代码样式语言标签
                for line in text.replace("\r\n", "\n").split('\n') {
                    let run = Run::new()
                        .add_text(if line.is_empty() { " " } else { line })
                        .fonts(mono_fonts());
                    docx = docx.add_paragraph(Paragraph::new().add_run(run));
                }
                ctx.stats.code_blocks += 1;
            }
            IRBlock::List { ordered, items } => {
                use docx_rs::*;
                let num_id = if *ordered { ORDERED_NUM_ID } else { BULLET_NUM_ID };
                for it in items {
                    let mut para = Paragraph::new();
                    if let Some(checked) = it.checked {
                        // 任务项：以字面复选标记前缀（Word 无原生 md 任务；导入读回含该前缀）。
                        let mark = if checked { "\u{2611} " } else { "\u{2610} " };
                        para = para.add_run(Run::new().add_text(mark));
                    }
                    for inl in &it.inline {
                        para = push_inline(para, inl, &mut ctx);
                    }
                    para = para.numbering(NumberingId::new(num_id), IndentLevel::new(it.level.min(3)));
                    docx = docx.add_paragraph(para);
                }
                ctx.stats.lists += 1;
            }
            IRBlock::Table { header, rows } => {
                docx = docx.add_table(build_table(header, rows, &mut ctx));
                ctx.stats.tables += 1;
            }
            IRBlock::FootnoteDef { .. } => { /* 内容随引用点输出，定义不单独成块 */ }
        }
    }

    // 落盘：build() 得 XMLDocx（原始部件）→ pack 写 zip。
    let file = std::fs::File::create(&args.out_path)
        .map_err(|e| format!("创建输出文件失败：{}", e))?;
    docx.build().pack(file).map_err(|e| format!("打包 docx 失败：{}", e))?;

    if !ctx.missing_images.is_empty() {
        let list = ctx.missing_images.join(", ");
        ctx.warn("missing_image", &format!("以下图片在库内未找到，已跳过：{}", list));
    }

    Ok(ExportDocx {
        out_path: args.out_path,
        warnings: ctx.warnings,
        stats: ctx.stats,
    })
}

// ==================== 段落 / 行内 构建 ====================

fn mono_fonts() -> docx_rs::RunFonts {
    docx_rs::RunFonts::new()
        .ascii("Consolas")
        .hi_ansi("Consolas")
        .east_asia("Consolas")
        .cs("Consolas")
}

/// 把一组 inline 追加进段落（供表格单元格复用）。
fn build_paragraph(inline: &[IRInline], ctx: &mut ExCtx) -> docx_rs::Paragraph {
    let mut p = docx_rs::Paragraph::new();
    for it in inline {
        p = push_inline(p, it, ctx);
    }
    p
}

fn push_inline(p: docx_rs::Paragraph, it: &IRInline, ctx: &mut ExCtx) -> docx_rs::Paragraph {
    use docx_rs::*;
    if let Some(img) = &it.image {
        if let Some(bytes) = load_image(img, ctx) {
            // Pic::new 借 image feature 统一转 PNG 并算尺寸；对损坏/不支持的图会 panic，用 catch_unwind 兜住。
            let pic = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| Pic::new(&bytes)));
            match pic {
                Ok(pic) => {
                    ctx.stats.images += 1;
                    return p.add_run(Run::new().add_image(pic));
                }
                Err(_) => {
                    ctx.warn("bad_image", &format!("图片无法解码，已跳过：{}", img.rel));
                    return p;
                }
            }
        }
        return p;
    }
    if let Some(fid) = it.footnote {
        let content = ctx.footnote_defs.get(&fid).cloned().unwrap_or_default();
        let mut fn_node = Footnote::new();
        let inner = build_paragraph(&content, ctx);
        fn_node.add_content(inner);
        ctx.stats.footnotes += 1;
        return p.add_run(Run::new().add_footnote_reference(fn_node));
    }
    // 文本类（含 math 降级为纯文本）
    let text = if it.math { it.text.clone() } else { it.text.clone() };
    if text.is_empty() {
        return p;
    }
    let run = apply_marks(Run::new().add_text(text.clone()), it);
    if let Some(url) = &it.link {
        let hl = Hyperlink::new(url.clone(), HyperlinkType::External).add_run(run);
        return p.add_hyperlink(hl);
    }
    p.add_run(run)
}

fn apply_marks(run: docx_rs::Run, it: &IRInline) -> docx_rs::Run {
    let mut r = run;
    if it.bold {
        r = r.bold();
    }
    if it.italic {
        r = r.italic();
    }
    if it.strike {
        r = r.strike();
    }
    if it.code {
        r = r.fonts(mono_fonts());
    }
    r
}

// ==================== 表格 ====================

fn build_table(
    header: &Option<Vec<Vec<IRInline>>>,
    rows: &[Vec<Vec<IRInline>>],
    ctx: &mut ExCtx,
) -> docx_rs::Table {
    use docx_rs::*;
    let mut trs: Vec<TableRow> = Vec::new();
    if let Some(hdr) = header {
        trs.push(TableRow::new(hdr.iter().map(|cell| build_cell(cell, ctx)).collect()));
    }
    for row in rows {
        trs.push(TableRow::new(row.iter().map(|cell| build_cell(cell, ctx)).collect()));
    }
    Table::new(trs)
}

fn build_cell(cell: &[IRInline], ctx: &mut ExCtx) -> docx_rs::TableCell {
    docx_rs::TableCell::new().add_paragraph(build_paragraph(cell, ctx))
}

// ==================== 图片：库内相对路径 → 字节 + 尺寸 ====================

/// 读库内图片字节；缺失记入 ctx.missing_images 并返回 None。尺寸与格式转换交给 Pic::new。
fn load_image(img: &IRImage, ctx: &mut ExCtx) -> Option<Vec<u8>> {
    let abs = match resolve_inside(&ctx.vault_root, &img.rel) {
        Some(p) => p,
        None => {
            ctx.missing_images.push(img.rel.clone());
            return None;
        }
    };
    match std::fs::read(&abs) {
        Ok(b) => Some(b),
        Err(_) => {
            ctx.missing_images.push(img.rel.clone());
            None
        }
    }
}

/// 库内相对路径 → 绝对路径，拒绝跳出 vault 根。
fn resolve_inside(root: &Path, rel: &str) -> Option<PathBuf> {
    let norm = rel.replace('\\', "/");
    let mut p = root.to_path_buf();
    for seg in norm.split('/').filter(|s| !s.is_empty() && *s != ".") {
        if seg == ".." {
            return None;
        }
        p.push(seg);
    }
    p.exists().then_some(p)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::docx_import::{docx_preview, DocxPreviewArgs};
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_dir(tag: &str) -> PathBuf {
        let nanos = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_nanos();
        let d = std::env::temp_dir().join(format!("nl_export_{}_{}_{}", tag, std::process::id(), nanos));
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    /// 回环：前端形状的 Docx-IR(JSON) → export_docx 落盘 → 现有 docx_preview 读回 → 断言结构等价。
    #[test]
    fn ir_roundtrips_through_docx_preview() {
        let dir = temp_dir("rt");
        let out = dir.join("t.docx");
        let ir_json = r#"{
          "title": null,
          "blocks": [
            {"type":"heading","level":1,"inline":[{"text":"一级标题"}]},
            {"type":"heading","level":2,"inline":[{"text":"二级标题"}]},
            {"type":"paragraph","inline":[{"text":"粗","bold":true},{"text":"斜","italic":true},{"text":"删","strike":true},{"text":"普通"}]},
            {"type":"list","ordered":false,"items":[{"inline":[{"text":"甲"}]},{"inline":[{"text":"乙"}]}]},
            {"type":"list","ordered":true,"items":[{"inline":[{"text":"壹"}]}]},
            {"type":"code","text":"int x = 1;","lang":"c"},
            {"type":"table","header":[[{"text":"列A"}],[{"text":"列B"}]],"rows":[[[{"text":"1"}],[{"text":"2"}]]]},
            {"type":"paragraph","inline":[{"text":"参见"},{"footnote":1}]},
            {"type":"footnoteDef","id":1,"inline":[{"text":"脚注内容"}]}
          ]
        }"#;
        let ir: DocxIR = serde_json::from_str(ir_json).expect("IR JSON must deserialize");
        let res = export_docx(ExportDocxArgs {
            ir,
            vault_root: dir.to_string_lossy().to_string(),
            out_path: out.to_string_lossy().to_string(),
        })
        .expect("export should succeed");
        assert!(out.exists(), "docx not written");
        assert_eq!(res.stats.headings, 2);
        assert_eq!(res.stats.tables, 1);

        let prev = docx_preview(DocxPreviewArgs {
            src_path: out.to_string_lossy().to_string(),
            dest_dir: dir.join("prev").to_string_lossy().to_string(),
            title_override: None,
            dedup_index: HashMap::new(),
            with_frontmatter: false,
            max_image_bytes: 20_000_000,
            src_b64: None,
            src_display_name: None,
        })
        .expect("preview should read back the exported docx");
        let md = prev.md;

        // 标题层级（验证 outlineLvl 样式修复：不是降级成普通段落）
        assert!(md.contains("# 一级标题"), "h1 lost: {md}");
        assert!(md.contains("## 二级标题"), "h2 lost: {md}");
        // 行内强调
        assert!(md.contains("**粗**"), "bold lost: {md}");
        assert!(md.contains("*斜*"), "italic lost: {md}");
        assert!(md.contains("~~删~~"), "strike lost: {md}");
        // 列表
        assert!(md.contains("- 甲"), "bullet lost: {md}");
        assert!(md.contains("1. 壹"), "ordered lost: {md}");
        // 代码围栏
        assert!(md.contains("```") && md.contains("int x = 1;"), "code lost: {md}");
        // GFM 表
        assert!(md.contains("| 列A | 列B |"), "table lost: {md}");
        // 脚注
        assert!(md.contains("脚注内容") && md.contains("[^"), "footnote lost: {md}");

        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn resolve_inside_rejects_traversal() {
        // 跳出库根的相对路径必须被拒（返回 None），不触碰文件系统。
        assert!(resolve_inside(Path::new("/"), "../evil.png").is_none());
        assert!(resolve_inside(Path::new("/"), "a/../../evil.png").is_none());
    }
}
