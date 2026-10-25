// webclip.rs —— 网页剪藏：载荷落盘的纯逻辑（模板渲染 / 文件名 / 图片 / 自动关联）。
//
// 链路：浏览器扩展 POST /clip → 本模块的 write_clip 按模板渲染、图片进 assets/、写盘，
// 再用 VaultIndex 的既有条目算相关笔记，文末追加「## 相关笔记」段。
// HTTP 服务与 Tauri 装配在同文件下半部分（serve_loop / handle_conn）。
//
// 服务只绑 127.0.0.1，不带令牌：来源闸门是 Origin（存在时必须是扩展来源）+ Host（必须
// 回环名）两道，浏览器侧攻击面由此全覆盖；本机其他进程本就写得了库里的文件，令牌拦不住
// 它却要每个用户手工复制粘贴，不划算。决策依据见 spec §2。
//
// 设计依据：docs/superpowers/specs/2026-10-21-web-clip-design.md
// 实现计划：docs/superpowers/plans/2026-10-21-web-clip-plan.md

use chrono::{DateTime, Datelike, Local, Timelike};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{Read, Write};
use std::net::{TcpListener, TcpStream};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

// ==================== 常量 ====================

/// 本地服务默认端口；占用时顺延 +1 至多 10 个
pub const DEFAULT_PORT: u16 = 3210;
/// 剪藏目标目录默认值（库内相对路径）
pub const DEFAULT_FOLDER: &str = "Clippings";
/// 文件名模式默认值（渲染后再净化）
pub const DEFAULT_FILENAME: &str = "{{date}}-{{title}}";
/// 自动关联默认上限
pub const DEFAULT_MAX_LINKS: usize = 5;
/// 关联段标题（写进 md 的固定中文，用户可自行改写）
pub const RELATED_HEADING: &str = "## 相关笔记";
/// 整个请求体上限
pub const MAX_BODY: usize = 8 * 1024 * 1024;
/// markdown 正文上限
pub const MAX_MARKDOWN: usize = 2 * 1024 * 1024;
/// 单张图片上限
pub const MAX_IMAGE: usize = 5 * 1024 * 1024;

/// 内置 article 模板：未选模板或模板读失败时用（整页剪藏）。变量语义与
/// src/template.js 的 applyTemplate 一致（未知 token 原样保留），{{tags}} 逗号分隔供
/// frontmatter，{{hashtags}} 是 #a #b 形式。frontmatter 字段见 v2 spec §2：
/// published_at 页面给了才填、clipped_at 本地时区 ISO 8601、template 记本次实际模板名。
pub const DEFAULT_TEMPLATE_ARTICLE: &str = concat!(
    "---\n",
    "title: {{title}}\n",
    "source: {{url}}\n",
    "author: {{author}}\n",
    "published_at: {{published_at}}\n",
    "clipped_at: {{clipped_at}}\n",
    "tags: [{{tags}}]\n",
    "template: {{template}}\n",
    "---\n",
    "\n",
    "# {{title}}\n",
    "\n",
    "> {{description}}\n",
    "\n",
    "{{content}}\n",
);

/// 内置 highlight 模板：选区剪藏用。来源行进引用块，与整页剪藏拉开观感；
/// frontmatter 同 article（template 字段渲染成 highlight）。
pub const DEFAULT_TEMPLATE_HIGHLIGHT: &str = concat!(
    "---\n",
    "title: {{title}}\n",
    "source: {{url}}\n",
    "author: {{author}}\n",
    "published_at: {{published_at}}\n",
    "clipped_at: {{clipped_at}}\n",
    "tags: [{{tags}}]\n",
    "template: {{template}}\n",
    "---\n",
    "\n",
    "# {{title}}\n",
    "\n",
    "> 摘录自 [{{site}}]({{url}})\n",
    "\n",
    "{{content}}\n",
);

/// 内置 shot 模板：选区截图剪藏用。正文是截下来的那张图（后面跟选中的文字，
/// 选了文字才有），来源行进引用块——与整页剪藏、选区摘录都拉开观感。
pub const DEFAULT_TEMPLATE_SHOT: &str = concat!(
    "---\n",
    "title: {{title}}\n",
    "source: {{url}}\n",
    "author: {{author}}\n",
    "published_at: {{published_at}}\n",
    "clipped_at: {{clipped_at}}\n",
    "tags: [{{tags}}]\n",
    "template: {{template}}\n",
    "---\n",
    "\n",
    "# {{title}}\n",
    "\n",
    "> 截自 [{{site}}]({{url}})\n",
    "\n",
    "{{content}}\n",
);

// ==================== 载荷与配置 ====================

/// 扩展传来的一张图：url 是 markdown 里出现的地址；dataUri 是扩展侧取到的本地副本
///（取不到时只有 url，Rust 按远程 URL 保留或 Windows 上兜底下载）。
#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ClipImage {
    pub url: String,
    #[serde(default)]
    pub data_uri: Option<String>,
}

/// 选区截图：扩展截下页面上一块画面（data URI）。
/// 与 images 分开走——截图是剪藏内容本身，不是正文里的远程图，
/// 不受 localize_images 开关影响，恒定落进 assets/ 并写进正文。
#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ClipScreenshot {
    pub data_uri: String,
}

/// POST /clip 的 JSON 载荷。字符串字段缺省按空串（与 CreateDocArgs 的风格一致）。
#[derive(Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ClipPayload {
    pub title: String,
    pub url: String,
    #[serde(default)]
    pub byline: String,
    #[serde(default)]
    pub excerpt: String,
    #[serde(default)]
    pub site_name: String,
    #[serde(default)]
    pub published: String,
    pub markdown: String,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub images: Vec<ClipImage>,
    #[serde(default)]
    pub template: String,
    #[serde(default)]
    pub folder: String,
    #[serde(default)]
    pub clip_type: String,
    /// 选区截图（clipType='screenshot' 时有）：扩展截下页面那块画面的 data URI
    #[serde(default)]
    pub screenshot: Option<ClipScreenshot>,
}

/// 落盘结果，回给扩展（camelCase）。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipOutcome {
    pub rel: String,
    pub title: String,
    pub linked: usize,
    pub images_saved: usize,
    pub images_failed: usize,
}

/// 剪藏配置。前 11 个字段来自 settings.json 的 clip 段；bound_port 是运行态
///（端口占用顺延后的实际绑定值），不落盘。
#[derive(Clone, Debug)]
pub struct ClipConfig {
    pub enabled: bool,
    pub port: u16,
    pub folder: String,
    pub template_rel: String,
    pub filename_pattern: String,
    pub auto_link: bool,
    pub max_links: usize,
    pub open_after_save: bool,
    /// 图片本地化开关。false（默认）时扩展不取图、Rust 完全不碰图，正文保留 https:// 原链接
    pub localize_images: bool,
    /// 整页兜底开关。两级提取器都失败时，true 才退化 document.body；false 报「提取失败」
    pub full_page_fallback: bool,
    /// frontmatter 的 tags 第一项是否放默认 clip 标签（页面关键词接在其后）
    pub default_clip_tag: bool,
    pub bound_port: Option<u16>,
}

impl Default for ClipConfig {
    fn default() -> Self {
        ClipConfig {
            enabled: false,
            port: DEFAULT_PORT,
            folder: DEFAULT_FOLDER.to_string(),
            template_rel: String::new(),
            filename_pattern: DEFAULT_FILENAME.to_string(),
            auto_link: true,
            max_links: DEFAULT_MAX_LINKS,
            open_after_save: false,
            localize_images: false,
            full_page_fallback: false,
            default_clip_tag: true,
            bound_port: None,
        }
    }
}

/// 目标目录归一化：反斜杠转正斜杠、去首尾斜杠；空值回落默认目录。
fn normalize_folder(s: &str) -> String {
    let f = s.trim().replace('\\', "/").trim_matches('/').to_string();
    if f.is_empty() {
        DEFAULT_FOLDER.to_string()
    } else {
        f
    }
}

/// settings.json 的 clip 段 → 配置。坏类型 / 越界回落默认（与 normalizeAppearance 同思路）。
pub fn clip_config_from_json(v: &serde_json::Value) -> ClipConfig {
    let mut cfg = ClipConfig::default();
    let obj = match v.as_object() {
        Some(o) => o,
        None => return cfg,
    };
    if let Some(b) = obj.get("enabled").and_then(|x| x.as_bool()) {
        cfg.enabled = b;
    }
    if let Some(n) = obj.get("port").and_then(|x| x.as_u64()) {
        cfg.port = n.clamp(1024, 65535) as u16;
    }
    // 历史版本 settings.json 里可能留有 token 段：本版本不带令牌，读档时忽略
    if let Some(s) = obj.get("folder").and_then(|x| x.as_str()) {
        cfg.folder = normalize_folder(s);
    }
    if let Some(s) = obj.get("template").and_then(|x| x.as_str()) {
        cfg.template_rel = s.trim().to_string();
    }
    if let Some(s) = obj.get("filename").and_then(|x| x.as_str()) {
        let f = s.trim().to_string();
        if !f.is_empty() {
            cfg.filename_pattern = f;
        }
    }
    if let Some(b) = obj.get("autoLink").and_then(|x| x.as_bool()) {
        cfg.auto_link = b;
    }
    if let Some(n) = obj.get("maxLinks").and_then(|x| x.as_u64()) {
        cfg.max_links = (n as usize).min(20);
    }
    if let Some(b) = obj.get("openAfterSave").and_then(|x| x.as_bool()) {
        cfg.open_after_save = b;
    }
    if let Some(b) = obj.get("localizeImages").and_then(|x| x.as_bool()) {
        cfg.localize_images = b;
    }
    if let Some(b) = obj.get("fullPageFallback").and_then(|x| x.as_bool()) {
        cfg.full_page_fallback = b;
    }
    if let Some(b) = obj.get("defaultClipTag").and_then(|x| x.as_bool()) {
        cfg.default_clip_tag = b;
    }
    cfg
}

// ==================== 模板 ====================

/// 日期格式替换：支持 YYYY YY MM M DD D HH mm ss（与 src/template.js 的 formatDate 同集合，
/// 大小写敏感：MM=月、mm=分）。未匹配的字符原样拷贝。
fn fmt_date(fmt: &str, now: &DateTime<Local>) -> String {
    let cs: Vec<char> = fmt.chars().collect();
    let mut out = String::with_capacity(fmt.len());
    let mut i = 0usize;
    while i < cs.len() {
        let c = cs[i];
        let mut n = 0usize;
        while i + n < cs.len() && cs[i + n] == c {
            n += 1;
        }
        let pushed = match c {
            'Y' if n >= 4 => {
                out.push_str(&now.year().to_string());
                true
            }
            'Y' if n == 2 => {
                out.push_str(&format!("{:02}", now.year() % 100));
                true
            }
            'M' if n >= 2 => {
                out.push_str(&format!("{:02}", now.month()));
                true
            }
            'M' if n == 1 => {
                out.push_str(&now.month().to_string());
                true
            }
            'D' if n >= 2 => {
                out.push_str(&format!("{:02}", now.day()));
                true
            }
            'D' if n == 1 => {
                out.push_str(&now.day().to_string());
                true
            }
            'H' if n >= 2 => {
                out.push_str(&format!("{:02}", now.hour()));
                true
            }
            'm' if n >= 2 => {
                out.push_str(&format!("{:02}", now.minute()));
                true
            }
            's' if n >= 2 => {
                out.push_str(&format!("{:02}", now.second()));
                true
            }
            _ => false,
        };
        if pushed {
            i += n; // 整个 run 消费掉
        } else {
            out.push(c);
            i += 1;
        }
    }
    out
}

/// 剪藏模板变量集。weekday 走后端词表（clip.weekday.0..6），与界面语言一致；
/// clipped_at 是本地时区 ISO 8601（带偏移，如 2026-10-22T14:30:05+08:00）；
/// tags 第一项默认放 clip（cfg.default_clip_tag 可关），页面关键词接在其后，
/// 页面里已有 clip（大小写不敏感）时不重复加。template 变量由 write_clip 在模板
/// 解析后插入（内置 article / highlight 或用户模板主名）。
pub fn clip_vars(payload: &ClipPayload, cfg: &ClipConfig) -> HashMap<String, String> {
    let now = Local::now();
    let mut tags: Vec<String> = payload
        .tags
        .iter()
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect();
    if cfg.default_clip_tag && !tags.iter().any(|t| t.eq_ignore_ascii_case("clip")) {
        tags.insert(0, "clip".to_string());
    }
    let hashtags: Vec<String> = tags.iter().map(|t| format!("#{}", t)).collect();
    let mut m = HashMap::new();
    m.insert("title".into(), payload.title.trim().to_string());
    m.insert("url".into(), payload.url.trim().to_string());
    m.insert("site".into(), payload.site_name.trim().to_string());
    m.insert("author".into(), payload.byline.trim().to_string());
    m.insert("description".into(), payload.excerpt.trim().to_string());
    m.insert("published".into(), payload.published.trim().to_string());
    m.insert("published_at".into(), payload.published.trim().to_string());
    m.insert("clipped_at".into(), now.format("%Y-%m-%dT%H:%M:%S%:z").to_string());
    m.insert("content".into(), payload.markdown.clone());
    m.insert("tags".into(), tags.join(", "));
    m.insert("hashtags".into(), hashtags.join(" "));
    m.insert("date".into(), fmt_date("YYYY-MM-DD", &now));
    m.insert("time".into(), fmt_date("HH:mm", &now));
    m.insert("datetime".into(), fmt_date("YYYY-MM-DD HH:mm", &now));
    m.insert("year".into(), fmt_date("YYYY", &now));
    m.insert("month".into(), fmt_date("MM", &now));
    m.insert("day".into(), fmt_date("DD", &now));
    let wd = now.weekday().num_days_from_sunday();
    let wd_key = format!("clip.weekday.{}", wd);
    m.insert("weekday".into(), crate::ui_msg!(wd_key.as_str()));
    m
}

/// 整行只剩一个值为空的 {{token}} 时把这一行去掉（连同模板里它与上文之间的空行）。
/// 内置模板的摘要行是 `> {{description}}`：页面没给 description 时（PJAX 站点换页后
/// `<head>` 还留着上一页的元信息，首页恰好没有 description）渲染出来是一个空引用块，
/// 编辑器里就是一个带光标的空行，看着像正文丢了。只认「行首允许 > / - / * / + 加空白」
/// 这种纯变量行，frontmatter 的 `author: {{author}}` 与正文行不受影响；未知 token 也不动。
fn drop_empty_token_lines(tpl: &str, vars: &HashMap<String, String>) -> String {
    let mut out: Vec<&str> = Vec::new();
    for line in tpl.split_inclusive('\n') {
        let body = line.trim_end_matches(['\n', '\r']);
        let trimmed = body.trim();
        let rest = if let Some(r) = trimmed.strip_prefix('>') {
            r.trim()
        } else if let Some(r) = trimmed
            .strip_prefix("- ")
            .or_else(|| trimmed.strip_prefix("* "))
            .or_else(|| trimmed.strip_prefix("+ "))
        {
            r.trim()
        } else {
            trimmed
        };
        let token = rest
            .strip_prefix("{{")
            .and_then(|r| r.strip_suffix("}}"))
            .map(str::trim)
            .filter(|k| !k.is_empty() && k.chars().all(|c| c.is_ascii_alphanumeric() || c == '_'));
        let empty = matches!(token, Some(k) if vars.get(k).map(|v| v.trim().is_empty()).unwrap_or(false));
        if empty {
            if out.last().map(|l| l.trim().is_empty()).unwrap_or(false) {
                out.pop();
            }
            continue;
        }
        out.push(line);
    }
    out.concat()
}

/// {{token}} 替换：token 两侧允许空格，只认字母数字下划线；未知 / 非法 token 原样保留
///（与 template.js 的 applyTemplate 同语义，避免误伤 Obsidian Templater 的 {{...}}）。
pub fn render_template(tpl: &str, vars: &HashMap<String, String>) -> String {
    let cs: Vec<char> = tpl.chars().collect();
    let mut out = String::with_capacity(tpl.len());
    let mut i = 0usize;
    while i < cs.len() {
        if cs[i] == '{' && i + 1 < cs.len() && cs[i + 1] == '{' {
            let mut j = i + 2;
            while j < cs.len() && !(cs[j] == '}' && j + 1 < cs.len() && cs[j + 1] == '}') {
                j += 1;
            }
            if j < cs.len() {
                let key: String = cs[i + 2..j].iter().collect();
                let key = key.trim();
                if !key.is_empty() && key.chars().all(|c| c.is_ascii_alphanumeric() || c == '_') {
                    if let Some(v) = vars.get(key) {
                        out.push_str(v);
                        i = j + 2;
                        continue;
                    }
                }
                // 未知 token：两个括号原样落回，继续扫
            }
            out.push('{');
            i += 1;
            continue;
        }
        out.push(cs[i]);
        i += 1;
    }
    out
}

/// 模板解析：用户显式选过（设置里的 template_rel，或扩展选项页的单次覆盖）就用库内
/// 模板，读失败 / 内容为空回落内置；没选过时按剪藏类型挑内置模板——选区摘录走
/// highlight（来源行进引用块），选区截图走 shot，其余走 article。返回 (模板文本,
/// 模板名)，模板名写进 frontmatter 的 template 字段（用户模板取主名，不含目录与
/// 扩展名）。
fn resolve_template(root: &Path, cfg: &ClipConfig, payload: &ClipPayload) -> (String, String) {
    let rel = if payload.template.trim().is_empty() {
        cfg.template_rel.trim()
    } else {
        payload.template.trim()
    };
    if !rel.is_empty() {
        if let Ok(abs) = crate::vault_join(root, rel) {
            if let Ok(text) = fs::read_to_string(&abs) {
                if !text.trim().is_empty() {
                    let name = rel.rsplit(['/', '\\']).next().unwrap_or(rel);
                    let stem = match name.rsplit_once('.') {
                        Some((s, _)) => s,
                        None => name,
                    };
                    return (text, stem.to_string());
                }
            }
        }
    }
    if payload.clip_type == "selection" {
        (DEFAULT_TEMPLATE_HIGHLIGHT.to_string(), "highlight".to_string())
    } else if payload.clip_type == "screenshot" {
        (DEFAULT_TEMPLATE_SHOT.to_string(), "shot".to_string())
    } else {
        (DEFAULT_TEMPLATE_ARTICLE.to_string(), "article".to_string())
    }
}

// ==================== 文件名 ====================

/// 文件名净化：Windows 非法字符与控制字符换 '-'，去首尾空格与点（系统会自行剥掉，
/// 不先剥会导致落盘名与索引记录不一致），截断 80 字符；空名回落 untitled。
fn sanitize_name(s: &str) -> String {
    let mut out: String = s
        .chars()
        .map(|c| {
            if matches!(c, '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|') || c.is_control() {
                '-'
            } else {
                c
            }
        })
        .collect();
    out = out.trim_matches(|c: char| c == ' ' || c == '.').to_string();
    let mut capped: String = out.chars().take(80).collect();
    capped = capped.trim_matches(|c: char| c == ' ' || c == '.').to_string();
    if capped.is_empty() {
        "untitled".to_string()
    } else {
        capped
    }
}

/// 文件名模式 → 净化后的主名（不含 .md）。模式先渲染再净化，title 里的标点不会漏进
/// 文件名；模式里的 '/' 取末段（防用户写带目录的模式）。
pub fn clip_filename(pattern: &str, vars: &HashMap<String, String>) -> String {
    let rendered = render_template(pattern, vars);
    let base = rendered.rsplit(['/', '\\']).next().unwrap_or(&rendered);
    sanitize_name(base)
}

/// 重名回避：x.md 已存在则 x-2.md、x-3.md……（与 docx 导入的重名体验一致）
fn unique_rel(root: &Path, rel: &str) -> String {
    if !root.join(rel).exists() {
        return rel.to_string();
    }
    let (stem, ext) = match rel.rsplit_once('.') {
        Some((s, e)) => (s.to_string(), format!(".{}", e)),
        None => (rel.to_string(), String::new()),
    };
    for n in 2..=999u32 {
        let cand = format!("{}-{}{}", stem, n, ext);
        if !root.join(&cand).exists() {
            return cand;
        }
    }
    format!("{}-{}{}", stem, Local::now().format("%H%M%S"), ext)
}

// ==================== 图片 ====================

/// data:<mime>;base64,<payload> → (mime, bytes)。mime 缺省按 png；空字节 / 坏 base64 返回 None。
fn parse_data_uri(uri: &str) -> Option<(String, Vec<u8>)> {
    let rest = uri.strip_prefix("data:")?;
    let (meta, payload) = rest.split_once(";base64,")?;
    let mime = if meta.is_empty() {
        "image/png".to_string()
    } else {
        meta.to_string()
    };
    let bytes = crate::b64_decode(payload).ok()?;
    if bytes.is_empty() {
        return None;
    }
    Some((mime, bytes))
}

fn ext_for_mime(mime: &str) -> Option<&'static str> {
    match mime.split(';').next().unwrap_or("").trim().to_ascii_lowercase().as_str() {
        "image/png" => Some("png"),
        "image/jpeg" | "image/jpg" => Some("jpg"),
        "image/gif" => Some("gif"),
        "image/webp" => Some("webp"),
        "image/bmp" => Some("bmp"),
        "image/svg+xml" => Some("svg"),
        "image/x-icon" | "image/vnd.microsoft.icon" => Some("ico"),
        "image/avif" => Some("avif"),
        _ => None,
    }
}

/// 无 data URI 时的远程兜底：走 lib.rs 的 download_remote（各平台系统网络栈，不带 Referer），
/// 下载失败一律 Ok(None)——保留远程 URL，不阻断剪藏。
fn fetch_remote_bytes(url: &str) -> Result<Option<Vec<u8>>, String> {
    let lower = url.to_lowercase();
    if !(lower.starts_with("http://") || lower.starts_with("https://")) {
        return Ok(None);
    }
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let tmp = std::env::temp_dir().join(format!("notelume-clip-{}.part", stamp));
    let res = (|| -> Result<Vec<u8>, String> {
        crate::download_remote(url, &tmp)?;
        fs::read(&tmp).map_err(|e| e.to_string())
    })();
    let _ = fs::remove_file(&tmp);
    match res {
        Ok(b) => Ok(Some(b)),
        Err(_) => Ok(None),
    }
}

/// assets 内的文件名：URL 主名净化后加扩展名；已存在时同内容复用、异内容追加 fnv1a 指纹。
fn image_name(assets_dir: &Path, url: &str, ext: &str, bytes: &[u8]) -> String {
    let base = url.split(['?', '#']).next().unwrap_or("");
    let last = base.rsplit('/').next().unwrap_or(base);
    // URL 路径段里的中文等字符是百分号编码；先按 URL 语义解码再落盘。否则磁盘上留下
    // `%E7%A0%81…png`，读取端把 md 里的链接解码一次就找不到文件（图片显示为读取失败）
    let last = crate::percent_decode(last);
    let raw_stem = match last.rsplit_once('.') {
        Some((s, _)) => s,
        None => last.as_str(),
    };
    let stem = {
        let s = sanitize_name(raw_stem);
        if s == "untitled" {
            format!("clip-{:x}", crate::fnv1a(bytes))
        } else {
            s
        }
    };
    let mut name = format!("{}.{}", stem, ext);
    if assets_dir.join(&name).exists() {
        let same = fs::read(assets_dir.join(&name))
            .map(|o| o == bytes)
            .unwrap_or(false);
        if !same {
            name = format!("{}-{:x}.{}", stem, crate::fnv1a(bytes), ext);
        }
    }
    name
}

/// 落一张剪藏图片。返回 Ok(Some(相对链接)) = 已落盘、markdown 需改写；Ok(None) = 没有本地
/// 副本（无 data URI 且下载不可用 / 超限 / 非图片），保留远程 URL。
fn save_clip_image(assets_dir: &Path, img: &ClipImage) -> Result<Option<String>, String> {
    let (mime, bytes) = match img.data_uri.as_deref() {
        Some(uri) => match parse_data_uri(uri) {
            Some(v) => v,
            None => return Ok(None), // 畸形 data URI：按远程 URL 保留
        },
        None => match fetch_remote_bytes(&img.url)? {
            Some(b) => (
                crate::sniff_image_mime(&b, &img.url)
                    .unwrap_or("application/octet-stream")
                    .to_string(),
                b,
            ),
            None => return Ok(None),
        },
    };
    if bytes.len() > MAX_IMAGE {
        return Ok(None); // 超限按远程 URL 保留
    }
    let ext = match ext_for_mime(&mime) {
        Some(e) => e,
        None => return Ok(None), // 防盗链返回的 HTML 等非图片：保留远程 URL
    };
    // assets 目录按需创建：一张图都落不了时不留空目录
    fs::create_dir_all(assets_dir).map_err(|e| crate::ui_msg!("clip.writeFailed", "err" => e))?;
    let name = image_name(assets_dir, &img.url, ext, &bytes);
    fs::write(assets_dir.join(&name), &bytes)
        .map_err(|e| crate::ui_msg!("clip.writeFailed", "err" => e))?;
    Ok(Some(format!("./assets/{}", name)))
}

/// 落一张选区截图。固定进 <目标目录>/assets/，文件名带时间戳（同秒两张加序号）。
/// 与正文里的远程图不同，截图是剪藏内容本身，恒定落盘——不受 localize_images 影响。
/// 返回 Ok(Some(相对链接)) = 已落盘；Ok(None) = data URI 畸形 / 超限 / 非图片。
fn save_clip_screenshot(assets_dir: &Path, shot: &ClipScreenshot) -> Result<Option<String>, String> {
    let (mime, bytes) = match parse_data_uri(&shot.data_uri) {
        Some(v) => v,
        None => return Ok(None),
    };
    if bytes.len() > MAX_IMAGE {
        return Ok(None);
    }
    let ext = match ext_for_mime(&mime) {
        Some(e) => e,
        None => return Ok(None),
    };
    fs::create_dir_all(assets_dir).map_err(|e| crate::ui_msg!("clip.writeFailed", "err" => e))?;
    let stamp = Local::now().format("%Y%m%d-%H%M%S").to_string();
    let mut name = format!("clip-{}.{}", stamp, ext);
    let mut n = 2;
    while assets_dir.join(&name).exists() && n < 1000 {
        name = format!("clip-{}-{}.{}", stamp, n, ext);
        n += 1;
    }
    fs::write(assets_dir.join(&name), &bytes)
        .map_err(|e| crate::ui_msg!("clip.writeFailed", "err" => e))?;
    Ok(Some(format!("./assets/{}", name)))
}

/// 截图的 alt 文本：页面标题（方括号换成全角、换行折成空格，免得写坏图片语法），
/// 空则「截图」
fn shot_alt(payload: &ClipPayload) -> String {
    let t = payload
        .title
        .trim()
        .replace(['[', ']'], "（）")
        .split_whitespace()
        .collect::<Vec<&str>>()
        .join(" ");
    if t.is_empty() {
        "截图".to_string()
    } else {
        t
    }
}

/// 截图的 markdown 行：`![标题](./assets/xxx.png)`。
/// 不写 Typora 的 `=宽x` 尺寸形态——那不是标准 GFM，Obsidian / GitHub 会把整段当纯文本，
/// 图片在这些阅读器里就废了；图按原图大小显示，由阅读器自己按栏宽收。
fn shot_markdown(payload: &ClipPayload, rel: &str) -> String {
    format!("![{}]({})", shot_alt(payload), rel)
}

// ==================== 自动关联 ====================

/// 拉丁停用词（4 字符以上才可能命中，短词天然被长度过滤挡掉大半）
const STOPWORDS: &[&str] = &[
    "the", "and", "for", "with", "that", "this", "from", "have", "not", "are", "was", "were", "you",
    "your", "its", "our", "their", "but", "all", "can", "will", "just", "more", "some", "such",
    "than", "them", "then", "there", "here", "what", "when", "who", "how", "why", "into", "over",
    "under", "about", "after", "before", "between", "also", "each", "only", "very", "much", "many",
    "most", "like", "been", "being", "would", "could", "should",
];

fn is_cjk(c: char) -> bool {
    matches!(c, '\u{4E00}'..='\u{9FFF}' | '\u{3400}'..='\u{4DBF}' | '\u{F900}'..='\u{FAFF}')
}

fn push_word(cur: &mut String, out: &mut HashSet<String>) {
    if cur.chars().count() >= 4 && !STOPWORDS.contains(&cur.as_str()) {
        out.insert(std::mem::take(cur));
    } else {
        cur.clear();
    }
}

/// 取关键词：拉丁词小写后 4 字符以上去过停用词；CJK 连续段取 2 字滑窗。
fn extract_words_into(s: &str, out: &mut HashSet<String>) {
    let lower = s.to_lowercase();
    let mut cur = String::new();
    for c in lower.chars() {
        if c.is_alphanumeric() {
            cur.push(c);
        } else {
            push_word(&mut cur, out);
        }
    }
    push_word(&mut cur, out);
    let run: Vec<char> = s.chars().filter(|c| is_cjk(*c)).collect();
    for w in run.windows(2) {
        let bg: String = w.iter().collect();
        out.insert(bg);
    }
}

/// 从索引里挑相关笔记：标签交集 ×3、标题词重叠 ×2、正文命中 ×1（每词封顶 3 次）。
/// 0 分不入列；按分数降序、路径升序取前 limit。self_rel 命中的条目跳过。
pub fn related_docs(
    index: &crate::VaultIndex,
    payload: &ClipPayload,
    self_rel: &str,
    limit: usize,
) -> Vec<(String, String)> {
    if limit == 0 {
        return Vec::new();
    }
    let clip_tags: HashSet<String> = payload
        .tags
        .iter()
        .map(|t| t.trim().to_ascii_lowercase())
        .filter(|t| !t.is_empty())
        .collect();
    let mut words: HashSet<String> = HashSet::new();
    extract_words_into(&payload.title, &mut words);
    extract_words_into(&payload.excerpt, &mut words);
    extract_words_into(&payload.site_name, &mut words);
    if words.is_empty() && clip_tags.is_empty() {
        return Vec::new();
    }
    let mut scored: Vec<(usize, String, String)> = Vec::new();
    for doc in index.docs.values() {
        if doc.path == self_rel {
            continue;
        }
        let mut score = 0usize;
        for t in &doc.tags {
            if clip_tags.contains(&t.to_ascii_lowercase()) {
                score += 3;
            }
        }
        if !words.is_empty() {
            let mut title_words = HashSet::new();
            extract_words_into(&doc.title, &mut title_words);
            let title_hits = words.iter().filter(|w| title_words.contains(*w)).count();
            let content_lower = doc.content.to_lowercase();
            let mut content_hits = 0usize;
            for w in &words {
                let mut n = content_lower.matches(w.as_str()).count();
                if n > 3 {
                    n = 3;
                }
                content_hits += n;
            }
            score += title_hits * 2 + content_hits;
        }
        if score > 0 {
            scored.push((score, doc.path.clone(), doc.title.clone()));
        }
    }
    scored.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.cmp(&b.1)));
    scored.into_iter().take(limit).map(|(_, p, t)| (p, t)).collect()
}

/// 文末追加「## 相关笔记」段。文档里已有该标题行（用户模板自带）时把列表插到标题之后，
/// 否则整段追加到文末；links 为空时原样返回。链接用根绝对路径 `[[/目录/文件名|标题]]`
/// （不含 .md）——剪藏文档多在一级子目录里，相对路径会因参照目录不同解析不到，
/// 根绝对形式与 resolve_one 的 '/' 分支一致，从库内任何位置点击都能跳转。
pub fn append_related(md: &str, links: &[(String, String)]) -> String {
    if links.is_empty() {
        return md.to_string();
    }
    let list: Vec<String> = links
        .iter()
        .map(|(path, title)| {
            let stem = path.strip_suffix(".md").unwrap_or(path);
            let label = {
                let t = title.trim();
                if t.is_empty() {
                    stem.trim_start_matches('/').to_string()
                } else {
                    t.to_string()
                }
            };
            format!("- [[/{}|{}]]", stem.trim_start_matches('/'), label)
        })
        .collect();
    let lines: Vec<&str> = md.lines().collect();
    if let Some(idx) = lines.iter().rposition(|l| l.trim() == RELATED_HEADING) {
        let mut out: Vec<String> = lines[..=idx].iter().map(|s| s.to_string()).collect();
        out.push(String::new());
        out.extend(list);
        out.extend(lines[idx + 1..].iter().map(|s| s.to_string()));
        let mut s = out.join("\n");
        if !s.ends_with('\n') {
            s.push('\n');
        }
        return s;
    }
    let mut out = md.to_string();
    if !out.is_empty() && !out.ends_with('\n') {
        out.push('\n');
    }
    out.push_str(&format!("\n{}\n\n{}\n", RELATED_HEADING, list.join("\n")));
    out
}

// ==================== 落盘 ====================

/// 剪藏落盘：模板渲染 →（localize_images 开时）图片进 assets/ 并改写 URL → 关联段
/// 追加 → 写 md → 增量更新索引。index 传 Some 时同时用于关联计算与索引回写
/// （调用方持有锁，避免内部重复加锁）。
pub fn write_clip(
    root: &Path,
    payload: &ClipPayload,
    cfg: &ClipConfig,
    mut index: Option<&mut crate::VaultIndex>,
) -> Result<ClipOutcome, String> {
    // 截图剪藏可以没有文字（选区是一张图），有截图就不算空内容
    if payload.markdown.trim().is_empty() && payload.screenshot.is_none() {
        return Err(crate::ui_msg!("clip.emptyContent"));
    }
    let (template, template_name) = resolve_template(root, cfg, payload);
    let mut vars = clip_vars(payload, cfg);
    vars.insert("template".into(), template_name);
    let folder = normalize_folder(if payload.folder.trim().is_empty() {
        &cfg.folder
    } else {
        &payload.folder
    });
    let mut images_saved = 0usize;
    let mut images_failed = 0usize;
    // 截图先落盘：正文里要写它的相对路径，路径得先知道
    let mut shot_rel: Option<String> = None;
    if let Some(shot) = payload.screenshot.as_ref() {
        let assets_dir = crate::vault_join(root, &folder).map(|p| p.join("assets"))?;
        match save_clip_screenshot(&assets_dir, shot) {
            Ok(Some(rel)) => {
                images_saved += 1;
                shot_rel = Some(rel);
            }
            Ok(None) => images_failed += 1,
            Err(e) => return Err(e),
        }
    }
    // 截图剪藏的正文：图在前，选中的文字在后（没选文字就只有图）
    if let Some(rel) = shot_rel.as_ref() {
        let mut body = shot_markdown(payload, rel);
        let text = payload.markdown.trim();
        if !text.is_empty() {
            body.push_str("\n\n");
            body.push_str(text);
        }
        vars.insert("content".into(), body);
    }
    let mut content = render_template(&drop_empty_token_lines(&template, &vars), &vars);
    // 用户的模板里没有 {{content}} 时把图补到文末，别让截下来的画面丢了
    if let Some(rel) = shot_rel.as_ref() {
        if !content.contains(rel.as_str()) {
            if !content.ends_with('\n') {
                content.push('\n');
            }
            content.push_str(&format!("\n{}\n", shot_markdown(payload, rel)));
        }
    }
    // 图片本地化默认关：扩展侧不发图，这里同样不碰图，正文保留 https:// 原链接
    if cfg.localize_images && !payload.images.is_empty() {
        let assets_dir = crate::vault_join(root, &folder).map(|p| p.join("assets"))?;
        for img in &payload.images {
            match save_clip_image(&assets_dir, img) {
                Ok(Some(rel_in_md)) => {
                    // 同一 URL 在正文里出现多处时一并改写
                    content = content.replace(&img.url, &rel_in_md);
                    images_saved += 1;
                }
                _ => images_failed += 1,
            }
        }
    }

    let links = match index.as_deref() {
        Some(g) if cfg.auto_link => related_docs(g, payload, "", cfg.max_links),
        _ => Vec::new(),
    };
    let content = append_related(&content, &links);

    let name = clip_filename(&cfg.filename_pattern, &vars);
    let mut rel = if folder.is_empty() {
        name
    } else {
        format!("{}/{}", folder, name)
    };
    if !rel.to_ascii_lowercase().ends_with(".md") {
        rel.push_str(".md");
    }
    let rel = unique_rel(root, &rel);
    let abs = crate::vault_join(root, &rel)?;
    if let Some(parent) = abs.parent() {
        fs::create_dir_all(parent).map_err(|e| crate::ui_msg!("clip.writeFailed", "err" => e))?;
    }
    // 越界双检，与 write_md_file 同一套：父目录 canonicalize 后必须仍在库根内
    let pc = fs::canonicalize(abs.parent().ok_or_else(|| crate::ui_msg!("badFilePath"))?)
        .map_err(|e| crate::ui_msg!("clip.writeFailed", "err" => e))?;
    if !pc.starts_with(root) {
        return Err(crate::ui_msg!("pathOutsideVault"));
    }
    fs::write(&abs, content.as_bytes()).map_err(|e| crate::ui_msg!("clip.writeFailed", "err" => e))?;
    if let Some(g) = index.as_deref_mut() {
        crate::index_doc_into(g, &rel, &content);
    }
    let title = crate::extract_title(&content, &rel);
    Ok(ClipOutcome {
        rel,
        title,
        linked: links.len(),
        images_saved,
        images_failed,
    })
}

// ==================== 本地 HTTP 服务 ====================

/// 服务状态回给前端（camelCase）。
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ClipStatus {
    pub running: bool,
    pub port: Option<u16>,
}

/// 运行中的服务。handle 留着只为 stop 时 join 等 accept 循环退出（listener 在线程里 drop）。
struct ClipServer {
    cfg: ClipConfig,
    shutdown: Arc<AtomicBool>,
    handle: Option<thread::JoinHandle<()>>,
}

/// Tauri 托管状态。None = 没在跑。起停都走 start / stop / status，字段不公开。
#[derive(Clone, Default)]
pub struct ClipServerState(Arc<Mutex<Option<ClipServer>>>);

/// 事件发射回调。serve_loop / handle_conn 不直接依赖 AppHandle，测试可传空实现。
type EmitFn = Arc<dyn Fn(&str, serde_json::Value) + Send + Sync>;

/// 起服务。端口占用时顺延 +1 至多 10 个；端口全被占才返回错误。
pub fn start(app: &tauri::AppHandle, state: &ClipServerState, mut cfg: ClipConfig) -> Result<(), String> {
    let mut listener = None;
    let mut bound = None;
    for off in 0..10u16 {
        let port = match cfg.port.checked_add(off) {
            Some(p) => p,
            None => break,
        };
        match TcpListener::bind(("127.0.0.1", port)) {
            Ok(l) => {
                listener = Some(l);
                bound = Some(port);
                break;
            }
            Err(_) => continue,
        }
    }
    let listener = listener.ok_or_else(|| crate::ui_msg!("clip.portBusy", "port" => cfg.port))?;
    cfg.bound_port = bound;
    listener
        .set_nonblocking(true)
        .map_err(|e| format!("设置剪藏监听失败：{e}"))?;
    // 索引状态从托管里取 Arc 克隆进线程（只读 vault_root 与 docs，不再经过命令层）
    let index = {
        use tauri::Manager;
        app.state::<crate::IndexState>().0.clone()
    };
    let shutdown = Arc::new(AtomicBool::new(false));
    let sd = shutdown.clone();
    let cfg_for_thread = cfg.clone();
    let app_for_emit = app.clone();
    let emit: EmitFn = Arc::new(move |event: &str, payload: serde_json::Value| {
        use tauri::Emitter;
        let _ = app_for_emit.emit(event, payload);
    });
    let handle = thread::spawn(move || serve_loop(listener, index, cfg_for_thread, sd, emit));
    let mut g = state.0.lock().map_err(|e| e.to_string())?;
    *g = Some(ClipServer { cfg, shutdown, handle: Some(handle) });
    Ok(())
}

/// 停服务：置关闭标志并 join。accept 循环最多 5ms 内退出。
pub fn stop(state: &ClipServerState) {
    let mut g = match state.0.lock() {
        Ok(g) => g,
        Err(_) => return,
    };
    if let Some(mut srv) = g.take() {
        srv.shutdown.store(true, Ordering::SeqCst);
        if let Some(h) = srv.handle.take() {
            let _ = h.join();
        }
    }
}

pub fn status(state: &ClipServerState) -> ClipStatus {
    let g = match state.0.lock() {
        Ok(g) => g,
        Err(_) => {
            return ClipStatus { running: false, port: None }
        }
    };
    match g.as_ref() {
        Some(srv) => ClipStatus {
            running: true,
            port: srv.cfg.bound_port,
        },
        None => ClipStatus { running: false, port: None },
    }
}

/// 前端改设置后调用：停旧起新。settings 是 settings.json 的 clip 段。
pub fn apply(
    app: &tauri::AppHandle,
    state: &ClipServerState,
    settings: serde_json::Value,
) -> Result<ClipStatus, String> {
    let cfg = clip_config_from_json(&settings);
    stop(state);
    if cfg.enabled {
        start(app, state, cfg)?;
    }
    Ok(status(state))
}

/// accept 循环。listener 为 nonblocking：无连接时 WouldBlock，sleep 5ms 再查关闭标志。
fn serve_loop(
    listener: TcpListener,
    index: Arc<Mutex<crate::VaultIndex>>,
    mut cfg: ClipConfig,
    shutdown: Arc<AtomicBool>,
    emit: EmitFn,
) {
    // 端口以实际监听地址为准：起服务时端口可能顺延，/health 报出去的必须和扩展实际连的一致
    cfg.bound_port = listener.local_addr().ok().map(|a| a.port());
    while !shutdown.load(Ordering::SeqCst) {
        match listener.accept() {
            Ok((stream, _)) => {
                let index = index.clone();
                let cfg = cfg.clone();
                let emit = emit.clone();
                thread::spawn(move || {
                    if let Err(e) = handle_conn(stream, &index, &cfg, &emit) {
                        eprintln!("NoteLume 剪藏请求处理失败：{e}");
                    }
                });
            }
            Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                thread::sleep(Duration::from_millis(5));
            }
            Err(_) => {
                // accept 偶发错误（连接在 accept 前断开等）不退出服务
                thread::sleep(Duration::from_millis(50));
            }
        }
    }
}

/// 原始请求：方法、路径（不带 query）、头（名已小写）、body。
struct RawRequest {
    method: String,
    path: String,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}

impl RawRequest {
    fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .find(|(k, _)| k == name)
            .map(|(_, v)| v.as_str())
    }
}

#[derive(Debug)]
enum RequestError {
    Bad,
    TooLarge,
}

fn find_subslice(hay: &[u8], needle: &[u8]) -> Option<usize> {
    hay.windows(needle.len()).position(|w| w == needle)
}

/// 从头串里取 Content-Length（没有 / 非法按 0）。
fn content_length_of(head: &str) -> usize {
    head.lines()
        .find_map(|l| {
            let (k, v) = l.split_once(':')?;
            if k.trim().eq_ignore_ascii_case("content-length") {
                v.trim().parse().ok()
            } else {
                None
            }
        })
        .unwrap_or(0)
}

/// 解析完整缓冲（头 + body）。body 不足按 Bad（截断的请求）。
fn parse_request(raw: &[u8]) -> Result<RawRequest, RequestError> {
    let header_end = find_subslice(raw, b"\r\n\r\n").ok_or(RequestError::Bad)?;
    let head = String::from_utf8_lossy(&raw[..header_end]).to_string();
    let mut lines = head.split("\r\n");
    let first = lines.next().ok_or(RequestError::Bad)?;
    let mut parts = first.split_whitespace();
    let method = parts.next().ok_or(RequestError::Bad)?.to_ascii_uppercase();
    let path = parts.next().ok_or(RequestError::Bad)?.to_string();
    let mut headers = Vec::new();
    for line in lines {
        if let Some((k, v)) = line.split_once(':') {
            headers.push((k.trim().to_ascii_lowercase(), v.trim().to_string()));
        }
    }
    let content_length = content_length_of(&head);
    if content_length > MAX_BODY {
        return Err(RequestError::TooLarge);
    }
    let body = raw[header_end + 4..].to_vec();
    if body.len() < content_length {
        return Err(RequestError::Bad);
    }
    Ok(RawRequest { method, path, headers, body })
}

/// 从流里读全一个请求：先读到 `\r\n\r\n`，再按 Content-Length 读满 body。
/// 不支持 chunked（扩展走普通 fetch + Content-Length，浏览器会自己算好）。
fn read_request(stream: &mut TcpStream) -> Result<RawRequest, RequestError> {
    // Windows 上 accept 返回的流可能继承非阻塞模式，显式设回阻塞
    stream.set_nonblocking(false).ok();
    let mut buf: Vec<u8> = Vec::with_capacity(8192);
    let mut chunk = [0u8; 4096];
    let header_end;
    loop {
        if let Some(pos) = find_subslice(&buf, b"\r\n\r\n") {
            header_end = pos;
            break;
        }
        if buf.len() > 64 * 1024 {
            return Err(RequestError::TooLarge);
        }
        match stream.read(&mut chunk) {
            Ok(0) => return Err(RequestError::Bad),
            Ok(n) => buf.extend_from_slice(&chunk[..n]),
            Err(ref e)
                if e.kind() == std::io::ErrorKind::WouldBlock
                    || e.kind() == std::io::ErrorKind::TimedOut =>
            {
                return Err(RequestError::Bad)
            }
            Err(ref e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(_) => return Err(RequestError::Bad),
        }
    }
    let content_length = content_length_of(&String::from_utf8_lossy(&buf[..header_end]));
    if content_length > MAX_BODY {
        return Err(RequestError::TooLarge);
    }
    let need = header_end + 4 + content_length;
    while buf.len() < need {
        match stream.read(&mut chunk) {
            Ok(0) => break,
            Ok(n) => buf.extend_from_slice(&chunk[..n]),
            Err(ref e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(_) => break,
        }
    }
    parse_request(&buf)
}

/// Host 检查：挡 DNS rebinding（恶意网页把自家域名解析到 127.0.0.1 后带 Origin 访问）。
/// 扩展的 fetch 与 curl 都不带端口外的花样，放行三种回环名。
fn host_ok(host: &str) -> bool {
    let h = host.rsplit('@').next().unwrap_or(host); // 去掉可能存在的 userinfo
    let h = h.split(':').next().unwrap_or("").trim().to_ascii_lowercase();
    h == "127.0.0.1" || h == "localhost" || h == "::1" || h == "[::1]"
}

/// Origin 检查：存在时只放行扩展来源。浏览器里恶意网页的 fetch / 表单提交必带
/// http(s) Origin，在这里被挡掉；扩展 service worker 带 chrome-extension Origin。
/// 不带 Origin 的请求（Firefox 扩展、curl、本机进程）放行——本机进程本来写得了库里
/// 的文件，HTTP 服务没给它任何新能力，为此设令牌只会把成本转嫁给正常用户。
fn origin_ok(origin: &str) -> bool {
    origin.starts_with("chrome-extension://") || origin.starts_with("moz-extension://")
}

fn err_json(code: &str, message: &str) -> String {
    serde_json::json!({ "ok": false, "code": code, "message": message }).to_string()
}

/// 拼响应。所有响应都带 CORS 三件套（预检与跨源 fetch 都要）与 Connection: close
///（一次请求一条连接，不做 keep-alive）。
fn write_response(stream: &mut TcpStream, code: u16, body: &str) -> Result<(), String> {
    let reason = match code {
        200 => "OK",
        204 => "No Content",
        400 => "Bad Request",
        401 => "Unauthorized",
        403 => "Forbidden",
        404 => "Not Found",
        409 => "Conflict",
        413 => "Payload Too Large",
        500 => "Internal Server Error",
        _ => "OK",
    };
    let head = format!(
        "HTTP/1.1 {} {}\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: {}\r\nAccess-Control-Allow-Origin: *\r\nAccess-Control-Allow-Headers: content-type\r\nAccess-Control-Allow-Methods: POST, GET, OPTIONS\r\nAccess-Control-Max-Age: 600\r\nConnection: close\r\n\r\n",
        code, reason, body.len()
    );
    stream
        .write_all(head.as_bytes())
        .map_err(|e| format!("写响应头失败：{e}"))?;
    if !body.is_empty() {
        stream
            .write_all(body.as_bytes())
            .map_err(|e| format!("写响应体失败：{e}"))?;
    }
    stream.flush().ok();
    Ok(())
}

/// /clip 的业务核心：来源之外的校验（载荷大小 / JSON / 知识库）→ 落盘。返回
/// (HTTP 码, 响应体, 待发事件)。事件由调用方发（测试里可断言其内容，运行时才真的 emit）。
/// 来源闸门（Origin / Host）在 handle_conn，请求到不了这里。
fn process_clip(
    index: &Arc<Mutex<crate::VaultIndex>>,
    cfg: &ClipConfig,
    req: &RawRequest,
) -> (u16, String, Option<serde_json::Value>) {
    if req.body.len() > MAX_BODY {
        return (413, err_json("too_large", &crate::ui_msg!("clip.tooLarge")), None);
    }
    let payload: ClipPayload = match serde_json::from_slice(&req.body) {
        Ok(p) => p,
        Err(_) => return (400, err_json("bad_request", &crate::ui_msg!("clip.badRequest")), None),
    };
    if payload.markdown.len() > MAX_MARKDOWN {
        return (413, err_json("too_large", &crate::ui_msg!("clip.tooLarge")), None);
    }
    let mut guard = match index.lock() {
        Ok(g) => g,
        Err(_) => {
            return (
                500,
                err_json("locked", &crate::ui_msg!("clip.writeFailed", "err" => "index lock poisoned")),
                None,
            )
        }
    };
    if guard.vault_root.is_empty() {
        return (409, err_json("no_vault", &crate::ui_msg!("clip.noVault")), None);
    }
    let root = match fs::canonicalize(&guard.vault_root) {
        Ok(r) => r,
        Err(e) => return (500, err_json("vault_gone", &crate::ui_msg!("clip.writeFailed", "err" => e)), None),
    };
    let outcome = match write_clip(&root, &payload, cfg, Some(&mut *guard)) {
        Ok(o) => o,
        Err(e) => return (500, err_json("write_failed", &e), None),
    };
    drop(guard);
    let body = serde_json::to_string(&outcome).unwrap_or_else(|_| "{}".to_string());
    let event = serde_json::json!({
        "path": outcome.rel,
        "title": outcome.title,
        "linked": outcome.linked,
        "clipType": payload.clip_type,
    });
    (200, body, Some(event))
}

fn handle_clip(
    stream: &mut TcpStream,
    index: &Arc<Mutex<crate::VaultIndex>>,
    cfg: &ClipConfig,
    req: &RawRequest,
    emit: &EmitFn,
) -> Result<(), String> {
    let (code, body, event) = process_clip(index, cfg, req);
    if let Some(payload) = event {
        emit("nl:clip-saved", payload);
    }
    write_response(stream, code, &body)
}

/// /health 响应体。localizeImages / fullPageFallback 随健康检查下发：扩展每次剪藏前
/// GET 一次 /health（localhost 轻请求）读这两个开关——前者决定要不要把图 fetch 成
/// data URI，后者决定两级提取器都失败时报「提取失败」还是退化整页。
fn health_json(cfg: &ClipConfig, has_vault: bool) -> String {
    serde_json::json!({
        "ok": true,
        "app": "notelume",
        "port": cfg.bound_port,
        "hasVault": has_vault,
        "localizeImages": cfg.localize_images,
        "fullPageFallback": cfg.full_page_fallback,
    })
    .to_string()
}

/// 单连接处理：来源检查（Host / Origin）→ 路由 → 响应。
fn handle_conn(
    mut stream: TcpStream,
    index: &Arc<Mutex<crate::VaultIndex>>,
    cfg: &ClipConfig,
    emit: &EmitFn,
) -> Result<(), String> {
    stream.set_read_timeout(Some(Duration::from_secs(10))).ok();
    stream.set_nodelay(true).ok();
    let req = match read_request(&mut stream) {
        Ok(r) => r,
        Err(RequestError::TooLarge) => {
            return write_response(&mut stream, 413, &err_json("too_large", &crate::ui_msg!("clip.tooLarge")))
        }
        Err(_) => {
            return write_response(&mut stream, 400, &err_json("bad_request", &crate::ui_msg!("clip.badRequest")))
        }
    };
    let host = req.header("host").unwrap_or_default().to_string();
    if !host_ok(&host) {
        return write_response(&mut stream, 403, &err_json("forbidden", &crate::ui_msg!("clip.forbidden")));
    }
    if let Some(origin) = req.header("origin") {
        if !origin_ok(origin) {
            return write_response(&mut stream, 403, &err_json("forbidden", &crate::ui_msg!("clip.forbidden")));
        }
    }
    let path = req.path.split('?').next().unwrap_or(&req.path).to_string();
    match (req.method.as_str(), path.as_str()) {
        ("OPTIONS", _) => write_response(&mut stream, 204, ""),
        ("GET", "/health") => {
            let has_vault = index.lock().map(|g| !g.vault_root.is_empty()).unwrap_or(false);
            write_response(&mut stream, 200, &health_json(cfg, has_vault))
        }
        ("POST", "/clip") => handle_clip(&mut stream, index, cfg, &req, emit),
        _ => write_response(&mut stream, 404, &err_json("not_found", &crate::ui_msg!("clip.notFound"))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{DocEntry, VaultIndex};

    fn index_with(docs: Vec<DocEntry>) -> VaultIndex {
        let mut idx = VaultIndex::default();
        for d in docs {
            idx.docs.insert(d.path.clone(), d);
        }
        idx.ready = true;
        idx
    }

    fn doc(path: &str, title: &str, tags: &[&str], content: &str) -> DocEntry {
        DocEntry {
            path: path.to_string(),
            title: title.to_string(),
            tags: tags.iter().map(|s| s.to_string()).collect(),
            outgoing: vec![],
            unresolved: vec![],
            content: content.to_string(),
        }
    }

    fn payload(title: &str, markdown: &str) -> ClipPayload {
        serde_json::from_str::<ClipPayload>(&format!(
            r#"{{"title":{},"url":"https://example.com/a","markdown":{}}}"#,
            serde_json::to_string(title).unwrap(),
            serde_json::to_string(markdown).unwrap()
        ))
        .unwrap()
    }

    #[test]
    fn render_template_keeps_unknown_tokens() {
        let mut vars = HashMap::new();
        vars.insert("title".to_string(), "foo".to_string());
        assert_eq!(render_template("{{title}}", &vars), "foo");
        assert_eq!(render_template("{{ title }}", &vars), "foo");
        assert_eq!(render_template("{{title}}-{{unknown}}", &vars), "foo-{{unknown}}");
        assert_eq!(render_template("{{}} {{ti tle}}", &vars), "{{}} {{ti tle}}");
        assert_eq!(render_template("{{title", &vars), "{{title");
    }

    #[test]
    fn drop_empty_token_lines_skips_empty_quote_but_keeps_frontmatter() {
        let mut vars = HashMap::new();
        vars.insert("title".to_string(), "T".to_string());
        vars.insert("description".to_string(), "".to_string());
        vars.insert("author".to_string(), "".to_string());
        let tpl = "# {{title}}\n\n> {{description}}\n\n{{content}}\n";
        // 空摘要行连同上方的空行一起消失，不留空引用块也不留连续空行
        assert_eq!(drop_empty_token_lines(tpl, &vars), "# {{title}}\n\n{{content}}\n");
        // 有值照旧
        let mut filled = vars.clone();
        filled.insert("description".to_string(), "摘要".to_string());
        assert_eq!(drop_empty_token_lines(tpl, &filled), tpl);
        // frontmatter 的「键: {{author}}」不是纯变量行，空值也保留
        let fm = "---\nauthor: {{author}}\n---\n";
        assert_eq!(drop_empty_token_lines(fm, &vars), fm);
        // 未知 token 原样留着，等 render_template 按未知处理
        assert_eq!(drop_empty_token_lines("> {{unknown}}\n", &vars), "> {{unknown}}\n");
    }

    #[test]
    fn write_clip_omits_empty_summary_quote() {
        let dir = std::env::temp_dir().join("notelume-clip-empty-summary-test");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let root = fs::canonicalize(&dir).unwrap();
        // PJAX 站点换页后 <head> 还是首页的：首页没有 description，剪藏的摘要就是空的
        let p = payload("记录生活学习", "本文最后更新于 780 天前。\n");
        let out = write_clip(&root, &p, &ClipConfig::default(), None).unwrap();
        let text = fs::read_to_string(root.join(&out.rel)).unwrap();
        assert!(!text.lines().any(|l| l.trim() == ">"), "不留空引用块：{text}");
        assert!(text.contains("# 记录生活学习\n\n本文最后更新于"), "标题与正文之间没有空块：{text}");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn fmt_date_tokens() {
        use chrono::TimeZone;
        let now = Local.with_ymd_and_hms(2026, 10, 21, 9, 5, 3).unwrap();
        assert_eq!(fmt_date("YYYY-MM-DD HH:mm:ss", &now), "2026-10-21 09:05:03");
        assert_eq!(fmt_date("YY/M/D", &now), "26/10/21");
        // 单 Y / 单 H / 单 m / 单 s 不是 token，原样保留（与 template.js 的 formatDate 一致）
        assert_eq!(fmt_date("Y H m s", &now), "Y H m s");
    }

    #[test]
    fn clip_filename_sanitizes_and_caps() {
        let mut vars = HashMap::new();
        vars.insert("title".to_string(), "a/b:c*?\"<>|d".to_string());
        // 模式里的 '/' 取末段：a/ 被剥掉，剩下 b:c*?"<>|d
        assert_eq!(clip_filename("{{title}}", &vars), "b-c------d");
        vars.insert("title".to_string(), "x".repeat(120));
        let name = clip_filename("{{title}}", &vars);
        assert_eq!(name.chars().count(), 80);
        vars.insert("title".to_string(), "///".to_string());
        assert_eq!(clip_filename("{{title}}", &vars), "untitled");
        // 模式里的 '/' 取末段
        vars.insert("title".to_string(), "t".to_string());
        assert_eq!(clip_filename("子目录/{{title}}", &vars), "t");
    }

    #[test]
    fn unique_rel_appends_suffix() {
        let dir = std::env::temp_dir().join("notelume-clip-unique-test");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("x.md"), "1").unwrap();
        assert_eq!(unique_rel(&dir, "x.md"), "x-2.md");
        fs::write(dir.join("x-2.md"), "2").unwrap();
        assert_eq!(unique_rel(&dir, "x.md"), "x-3.md");
        assert_eq!(unique_rel(&dir, "y.md"), "y.md");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn write_clip_writes_template_images_and_links() {
        let dir = std::env::temp_dir().join("notelume-clip-write-test");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let root = fs::canonicalize(&dir).unwrap();
        // 1x1 PNG
        let png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
        let p = payload("测试页面", "# 标题\n\n![图](https://example.com/a.png)\n\n正文 rust 编程");
        let p = ClipPayload {
            tags: vec!["rust".into()],
            images: vec![ClipImage {
                url: "https://example.com/a.png".into(),
                data_uri: Some(format!("data:image/png;base64,{}", png)),
            }],
            ..p
        };
        let mut idx = index_with(vec![doc("notes/rust.md", "Rust 笔记", &["rust"], "rust 编程指南")]);
        idx.vault_root = root.to_string_lossy().into_owned();
        // 索引条目对应的真实文件也要在盘上：resolve_one 解析 [[...]] 要查文件存在性
        fs::create_dir_all(root.join("notes")).unwrap();
        fs::write(root.join("notes/rust.md"), "rust 编程指南").unwrap();
        // 图片本地化默认关，这条用例要验落图链路，显式打开
        let cfg = ClipConfig { localize_images: true, ..ClipConfig::default() };
        let out = write_clip(&root, &p, &cfg, Some(&mut idx)).unwrap();

        assert!(out.rel.starts_with("Clippings/"));
        assert!(out.rel.ends_with(".md"));
        assert_eq!(out.images_saved, 1);
        assert_eq!(out.linked, 1);
        let text = fs::read_to_string(root.join(&out.rel)).unwrap();
        assert!(text.contains("title: 测试页面"), "frontmatter 标题");
        assert!(text.contains("./assets/a.png"), "图片改写为相对路径：{text}");
        assert!(!text.contains("https://example.com/a.png"), "远程 URL 已改写");
        assert!(text.contains("## 相关笔记"));
        assert!(text.contains("- [[/notes/rust|Rust 笔记]]"));
        assert!(root.join("Clippings/assets/a.png").exists(), "图片落盘");
        // 索引已增量收录新文档，反链可查
        assert!(idx.docs.contains_key(&out.rel));
        assert_eq!(idx.backlinks.get("notes/rust.md").map(|v| v.len()), Some(1));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn write_clip_decodes_percent_encoded_image_names() {
        let dir = std::env::temp_dir().join(format!("notelume-clip-pct-image-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let root = fs::canonicalize(&dir).unwrap();
        // 1x1 PNG
        let png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
        let encoded = "https://example.com/%E7%A0%81%E9%81%93%E7%99%BB%E5%BD%95%E9%A1%B5.png";
        let p = payload("编码图名", &format!("# 编码图名\n\n![广告]({})\n", encoded));
        let p = ClipPayload {
            images: vec![ClipImage {
                url: encoded.into(),
                data_uri: Some(format!("data:image/png;base64,{}", png)),
            }],
            ..p
        };
        let cfg = ClipConfig { localize_images: true, ..ClipConfig::default() };
        let out = write_clip(&root, &p, &cfg, None).unwrap();
        assert_eq!(out.images_saved, 1);
        let text = fs::read_to_string(root.join(&out.rel)).unwrap();
        // 磁盘与正文都用解码后的名字，不留百分号形态
        assert!(text.contains("./assets/码道登录页.png"), "{text}");
        assert!(root.join("Clippings/assets/码道登录页.png").exists());
        assert!(!root
            .join("Clippings/assets/%E7%A0%81%E9%81%93%E7%99%BB%E5%BD%95%E9%A1%B5.png")
            .exists());
        // 读取端（会先按 URL 语义解码一次）能按这条链接取到图
        let uri = crate::read_image_data_uri(
            root.to_string_lossy().into_owned(),
            out.rel.clone(),
            "./assets/码道登录页.png".into(),
        )
        .unwrap();
        assert!(uri.starts_with("data:image/png;base64,"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn write_clip_frontmatter_new_fields() {
        let dir = std::env::temp_dir().join("notelume-clip-frontmatter-test");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let root = fs::canonicalize(&dir).unwrap();
        let p = payload("测试页面", "正文");
        let p = ClipPayload { tags: vec!["rust".into()], published: "2026-10-01".into(), ..p };
        let out = write_clip(&root, &p, &ClipConfig::default(), None).unwrap();
        let text = fs::read_to_string(root.join(&out.rel)).unwrap();
        // frontmatter 字段（v2 spec §2）
        assert!(text.contains("source: https://example.com/a"));
        assert!(text.contains("author: "), "缺 author 行");
        assert!(text.contains("published_at: 2026-10-01"), "页面给了发布时间才填");
        // clipped_at：本地时区 ISO 8601，带偏移（如 2026-10-22T14:30:05+08:00）
        let clipped = text
            .lines()
            .find_map(|l| l.strip_prefix("clipped_at: "))
            .expect("缺 clipped_at 行");
        let bytes = clipped.as_bytes();
        assert_eq!(bytes.len(), 25, "长度不对：{clipped}");
        assert_eq!(bytes[4], b'-', "年月日分隔：{clipped}");
        assert_eq!(bytes[7], b'-', "月日分隔：{clipped}");
        assert_eq!(bytes[10], b'T', "日期时间分隔：{clipped}");
        assert!(matches!(bytes[19], b'+' | b'-'), "带时区偏移：{clipped}");
        assert_eq!(bytes[22], b':', "偏移里的冒号：{clipped}");
        // tags 第一项默认 clip，页面关键词接后；template 记本次实际模板名
        assert!(text.contains("tags: [clip, rust]"));
        assert!(text.contains("template: article"), "整页剪藏落 article");
        assert!(!text.contains("site: "), "旧 frontmatter 字段已移除");
        assert!(!text.contains("clipped: "), "旧 frontmatter 字段已移除");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn write_clip_uses_highlight_template_for_selection() {
        let dir = std::env::temp_dir().join("notelume-clip-highlight-test");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let root = fs::canonicalize(&dir).unwrap();
        // 选区剪藏：highlight 模板，来源行进引用块
        let p = payload("测试页面", "划中的片段");
        let p = ClipPayload { clip_type: "selection".into(), site_name: "示例站".into(), ..p };
        let out = write_clip(&root, &p, &ClipConfig::default(), None).unwrap();
        let text = fs::read_to_string(root.join(&out.rel)).unwrap();
        assert!(text.contains("template: highlight"));
        assert!(text.contains("> 摘录自 [示例站](https://example.com/a)"), "{text}");
        assert!(text.contains("# 测试页面"), "标题段照旧");
        assert!(text.contains("划中的片段"), "正文是选区内容");
        let _ = fs::remove_dir_all(&dir);
    }

    /// 截图剪藏：图片恒定落盘（不受 localize_images 影响），正文写本地相对路径
    /// 截图载荷的字段名：扩展发的是 camelCase（screenshot.dataUri）
    #[test]
    fn clip_payload_reads_screenshot_field() {
        let png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
        let json = format!(
            r#"{{"title":"t","url":"https://example.com/a","markdown":"","clipType":"screenshot","screenshot":{{"dataUri":"data:image/png;base64,{}"}}}}"#,
            png
        );
        let p: ClipPayload = serde_json::from_str(&json).unwrap();
        assert_eq!(p.clip_type, "screenshot");
        let shot = p.screenshot.expect("screenshot 字段读到了");
        assert!(shot.data_uri.starts_with("data:image/png;base64,"));
        // 字段缺失时是 None，不报错（老的扩展发来的载荷照样能解）
        let p2: ClipPayload =
            serde_json::from_str(r#"{"title":"t","url":"u","markdown":"x"}"#).unwrap();
        assert!(p2.screenshot.is_none());
    }

    #[test]
    fn write_clip_saves_screenshot_and_embeds_it() {
        let dir = std::env::temp_dir().join("notelume-clip-shot-test");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let root = fs::canonicalize(&dir).unwrap();
        let png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
        // 截图剪藏可以没有文字：选区就是一张图
        let p = ClipPayload {
            clip_type: "screenshot".into(),
            screenshot: Some(ClipScreenshot {
                data_uri: format!("data:image/png;base64,{}", png),
            }),
            ..payload("测试页面", "")
        };
        // 图片本地化默认关，截图照样落盘——它是剪藏内容本身
        let out = write_clip(&root, &p, &ClipConfig::default(), None).unwrap();
        assert_eq!(out.images_saved, 1);
        assert_eq!(out.images_failed, 0);
        let text = fs::read_to_string(root.join(&out.rel)).unwrap();
        assert!(text.contains("template: shot"), "{text}");
        assert!(text.contains("> 截自 ["), "来源行：{text}");
        assert!(
            text.contains("![测试页面](./assets/clip-"),
            "正文写的是本地相对路径：{text}"
        );
        assert!(!text.contains("=400x"), "不写非标准的尺寸形态：{text}");
        let assets = fs::read_dir(root.join("Clippings/assets")).unwrap().count();
        assert_eq!(assets, 1, "截图落进 Clippings/assets");
        let _ = fs::remove_dir_all(&dir);
    }

    /// 截图剪藏：选中的文字接在图后面
    #[test]
    fn write_clip_screenshot_keeps_selected_text_after_image() {
        let dir = std::env::temp_dir().join("notelume-clip-shot-text-test");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let root = fs::canonicalize(&dir).unwrap();
        let png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
        let p = ClipPayload {
            clip_type: "screenshot".into(),
            screenshot: Some(ClipScreenshot {
                data_uri: format!("data:image/png;base64,{}", png),
            }),
            ..payload("测试页面", "选中的文字")
        };
        let out = write_clip(&root, &p, &ClipConfig::default(), None).unwrap();
        let text = fs::read_to_string(root.join(&out.rel)).unwrap();
        let img_at = text.find("![测试页面](./assets/").expect("图在正文里");
        let txt_at = text.find("选中的文字").expect("文字在正文里");
        assert!(img_at < txt_at, "图在前、文字在后：{text}");
        let _ = fs::remove_dir_all(&dir);
    }

    /// 截图剪藏：用户的模板里没有 {{content}} 时，图补到文末（别把画面丢了）
    #[test]
    fn write_clip_screenshot_appends_image_when_template_has_no_content() {
        let dir = std::env::temp_dir().join("notelume-clip-shot-tpl-test");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let root = fs::canonicalize(&dir).unwrap();
        fs::create_dir_all(root.join("Templates")).unwrap();
        fs::write(root.join("Templates/t.md"), "# {{title}}\n").unwrap();
        let png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
        let p = ClipPayload {
            clip_type: "screenshot".into(),
            screenshot: Some(ClipScreenshot {
                data_uri: format!("data:image/png;base64,{}", png),
            }),
            ..payload("测试页面", "")
        };
        let cfg = ClipConfig { template_rel: "Templates/t.md".into(), ..ClipConfig::default() };
        let out = write_clip(&root, &p, &cfg, None).unwrap();
        let text = fs::read_to_string(root.join(&out.rel)).unwrap();
        assert!(text.contains("![测试页面](./assets/clip-"), "图补进正文：{text}");
        assert!(text.trim_end().ends_with(".png)"), "图在文末：{text}");
        let _ = fs::remove_dir_all(&dir);
    }

    /// 截图 data URI 畸形时不算空内容之外的失败：正文照落，只是没有图
    #[test]
    fn write_clip_screenshot_rejects_bad_data_uri() {
        let dir = std::env::temp_dir().join("notelume-clip-shot-bad-test");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let root = fs::canonicalize(&dir).unwrap();
        let p = ClipPayload {
            clip_type: "screenshot".into(),
            screenshot: Some(ClipScreenshot { data_uri: "not-a-data-uri".into() }),
            ..payload("测试页面", "")
        };
        let out = write_clip(&root, &p, &ClipConfig::default(), None).unwrap();
        assert_eq!(out.images_saved, 0);
        assert_eq!(out.images_failed, 1);
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn write_clip_keeps_remote_url_when_localize_off() {
        let dir = std::env::temp_dir().join("notelume-clip-nodata-test");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let root = fs::canonicalize(&dir).unwrap();
        let p = payload("测试页面", "![图](https://example.com/b.png)");
        let p = ClipPayload {
            images: vec![ClipImage { url: "https://example.com/b.png".into(), data_uri: None }],
            ..p
        };
        let out = write_clip(&root, &p, &ClipConfig::default(), None).unwrap();
        let text = fs::read_to_string(root.join(&out.rel)).unwrap();
        assert!(text.contains("https://example.com/b.png"), "本地化关着：保留远程 URL");
        // 开关关着时 Rust 完全不碰图：两个计数都是 0，也不建 assets
        assert_eq!(out.images_saved, 0);
        assert_eq!(out.images_failed, 0);
        assert!(!root.join("Clippings/assets").exists(), "没有图片就不建 assets");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn write_clip_localizes_images_when_enabled() {
        let dir = std::env::temp_dir().join("notelume-clip-localize-test");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let root = fs::canonicalize(&dir).unwrap();
        let png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
        let p = payload("测试页面", "![图](https://example.com/a.png)");
        let p = ClipPayload {
            images: vec![ClipImage {
                url: "https://example.com/a.png".into(),
                data_uri: Some(format!("data:image/png;base64,{}", png)),
            }],
            ..p
        };
        let cfg = ClipConfig { localize_images: true, ..ClipConfig::default() };
        let out = write_clip(&root, &p, &cfg, None).unwrap();
        let text = fs::read_to_string(root.join(&out.rel)).unwrap();
        assert_eq!(out.images_saved, 1);
        assert_eq!(out.images_failed, 0);
        assert!(text.contains("./assets/a.png"), "{text}");
        assert!(!text.contains("https://example.com/a.png"), "远程 URL 已改写");
        assert!(root.join("Clippings/assets/a.png").exists(), "图片落盘");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn write_clip_honors_payload_folder_override() {
        let dir = std::env::temp_dir().join("notelume-clip-override-test");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let root = fs::canonicalize(&dir).unwrap();
        let p = payload("t", "正文");
        let p = ClipPayload { folder: "Inbox".into(), ..p };
        let out = write_clip(&root, &p, &ClipConfig::default(), None).unwrap();
        assert!(out.rel.starts_with("Inbox/"), "{}", out.rel);
        assert!(root.join("Inbox").join(std::path::Path::new(&out.rel).file_name().unwrap()).exists());
        // 载荷里带 '..' 的目录同样被 normalize_folder + vault_join 挡在库内
        let p = payload("t2", "正文");
        let p = ClipPayload { folder: "../escape".into(), ..p };
        assert!(write_clip(&root, &p, &ClipConfig::default(), None).is_err());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn write_clip_rejects_empty_markdown() {
        let dir = std::env::temp_dir().join("notelume-clip-empty-test");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let root = fs::canonicalize(&dir).unwrap();
        let p = payload("测试页面", "   \n  ");
        assert!(write_clip(&root, &p, &ClipConfig::default(), None).is_err());
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn related_docs_scores_tags_over_content() {
        let idx = index_with(vec![
            doc("a.md", "Rust 入门", &["rust"], "rust 入门教程"),
            doc("b.md", "无关文档", &["other"], "rust rust rust 编程"),
            doc("c.md", "零分文档", &["x"], "什么都没有"),
        ]);
        let p = payload("rust", "rust");
        let p = ClipPayload { tags: vec!["rust".into()], ..p };
        let got = related_docs(&idx, &p, "", 5);
        assert_eq!(got[0].0, "a.md", "标签交集 + 标题命中权重最高");
        assert_eq!(got[1].0, "b.md", "纯正文命中次之");
        assert_eq!(got.len(), 2, "0 分文档不入列");
        // limit 截断
        assert_eq!(related_docs(&idx, &p, "", 1).len(), 1);
        // 自身跳过
        let got = related_docs(&idx, &p, "a.md", 5);
        assert!(!got.iter().any(|(p, _)| p == "a.md"));
    }

    #[test]
    fn related_docs_cjk_bigrams() {
        let idx = index_with(vec![doc("ml.md", "深度学习入门", &[], "深度学习是人工智能的方向")]);
        let p = payload("深度学习", "深度学习");
        let got = related_docs(&idx, &p, "", 5);
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].0, "ml.md");
    }

    #[test]
    fn append_related_appends_or_inserts() {
        let links = vec![("a/b.md".to_string(), "标题B".to_string())];
        // 无标题行：整段追加到文末
        let got = append_related("# 正文\n", &links);
        assert!(got.ends_with("\n## 相关笔记\n\n- [[/a/b|标题B]]\n"));
        // 已有标题行（模板自带）：列表插到标题之后，原后续内容保留
        let got = append_related("# 正文\n\n## 相关笔记\n\n旧内容\n", &links);
        assert!(got.contains("## 相关笔记\n\n- [[/a/b|标题B]]\n\n旧内容"));
        // 空链接：原样返回
        assert_eq!(append_related("# x", &[]), "# x");
        // 标题为空时链接回落路径主名
        let got = append_related("# x", &[("a/b.md".to_string(), "  ".to_string())]);
        assert!(got.contains("- [[/a/b|a/b]]"));
    }

    #[test]
    fn parse_data_uri_and_ext() {
        assert!(parse_data_uri("not-a-uri").is_none());
        assert!(parse_data_uri("data:image/png;base64,!!!").is_none());
        let png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
        let (mime, bytes) = parse_data_uri(&format!("data:image/png;base64,{}", png)).unwrap();
        assert_eq!(mime, "image/png");
        assert_eq!(ext_for_mime(&mime), Some("png"));
        assert!(ext_for_mime("text/html").is_none());
        assert!(bytes.len() > 60);
    }

    #[test]
    fn clip_config_from_json_defaults_and_clamps() {
        let cfg = clip_config_from_json(&serde_json::Value::Null);
        assert!(!cfg.enabled);
        assert_eq!(cfg.port, DEFAULT_PORT);
        assert_eq!(cfg.folder, DEFAULT_FOLDER);
        assert_eq!(cfg.filename_pattern, DEFAULT_FILENAME);
        assert_eq!(cfg.max_links, DEFAULT_MAX_LINKS);
        assert!(cfg.auto_link);
        // v2 三个开关的默认值
        assert!(!cfg.localize_images, "图片本地化默认关");
        assert!(!cfg.full_page_fallback, "整页兜底默认关");
        assert!(cfg.default_clip_tag, "默认 clip 标签默认开");

        let v = serde_json::json!({
            "enabled": true, "port": 999999, "folder": "  ", "maxLinks": 99,
            "filename": "  ", "template": "Templates/x.md",
            "localizeImages": true, "fullPageFallback": true, "defaultClipTag": false
        });
        let cfg = clip_config_from_json(&v);
        assert!(cfg.enabled);
        assert_eq!(cfg.port, 65535, "端口越界夹取");
        assert_eq!(cfg.folder, DEFAULT_FOLDER, "空目录回落默认");
        assert_eq!(cfg.max_links, 20, "上限夹取");
        assert_eq!(cfg.filename_pattern, DEFAULT_FILENAME, "空模式回落默认");
        assert_eq!(cfg.template_rel, "Templates/x.md");
        assert!(cfg.localize_images);
        assert!(cfg.full_page_fallback);
        assert!(!cfg.default_clip_tag);
        // 坏类型（字符串等）不认，保持默认
        let bad = serde_json::json!({ "localizeImages": "yes", "fullPageFallback": 1, "defaultClipTag": null });
        let cfg = clip_config_from_json(&bad);
        assert!(!cfg.localize_images);
        assert!(!cfg.full_page_fallback);
        assert!(cfg.default_clip_tag);
    }

    #[test]
    fn clip_vars_default_tag_and_timestamps() {
        let mut p = payload("测试页面", "正文");
        p.tags = vec!["rust".into(), "  ".into(), "编程".into()];
        p.published = "2026-10-01T08:00:00+08:00".into();
        let vars = clip_vars(&p, &ClipConfig::default());
        // tags 第一项默认 clip，页面关键词接后；空关键词被滤掉
        assert_eq!(vars.get("tags").unwrap(), "clip, rust, 编程");
        assert_eq!(vars.get("hashtags").unwrap(), "#clip #rust #编程");
        // published_at 页面给了才填（与 published 同值）
        assert_eq!(vars.get("published_at").unwrap(), "2026-10-01T08:00:00+08:00");
        // clipped_at：本地时区 ISO 8601，结构 2026-10-22T14:30:05+08:00（25 字符）
        let clipped = vars.get("clipped_at").unwrap();
        assert_eq!(clipped.len(), 25, "{clipped}");
        assert!(clipped[19..].starts_with('+') || clipped[19..].starts_with('-'), "{clipped}");
        assert_eq!(&clipped[22..23], ":", "{clipped}");

        // 页面关键词里已有 clip（大小写不敏感）不重复加
        p.tags = vec!["Clip".into(), "rust".into()];
        let vars = clip_vars(&p, &ClipConfig::default());
        assert_eq!(vars.get("tags").unwrap(), "Clip, rust");
        // 关掉默认标签：只放页面关键词
        let cfg = ClipConfig { default_clip_tag: false, ..ClipConfig::default() };
        p.tags = vec!["rust".into()];
        let vars = clip_vars(&p, &cfg);
        assert_eq!(vars.get("tags").unwrap(), "rust");
        assert_eq!(vars.get("hashtags").unwrap(), "#rust");
    }

    #[test]
    fn resolve_template_picks_builtin_by_clip_type() {
        let dir = std::env::temp_dir().join("notelume-clip-tpl-test");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let root = fs::canonicalize(&dir).unwrap();
        let page = payload("t", "正文");
        let sel = ClipPayload { clip_type: "selection".into(), ..payload("t", "正文") };

        // 没选过模板：整页走 article、选区走 highlight
        let (text, name) = resolve_template(&root, &ClipConfig::default(), &page);
        assert_eq!(name, "article");
        assert_eq!(text, DEFAULT_TEMPLATE_ARTICLE);
        let (text, name) = resolve_template(&root, &ClipConfig::default(), &sel);
        assert_eq!(name, "highlight");
        assert_eq!(text, DEFAULT_TEMPLATE_HIGHLIGHT);

        // 设置里选过模板：优先于内置（选区也不例外）
        fs::create_dir_all(root.join("Templates")).unwrap();
        fs::write(root.join("Templates/我的模板.md"), "# {{title}}\n").unwrap();
        let cfg = ClipConfig { template_rel: "Templates/我的模板.md".into(), ..ClipConfig::default() };
        let (text, name) = resolve_template(&root, &cfg, &sel);
        assert_eq!(text, "# {{title}}\n");
        assert_eq!(name, "我的模板", "模板名取主名，不带目录与扩展名");

        // 单次覆盖（载荷 template）优先于设置里的选择
        let p = ClipPayload { template: "Templates/我的模板.md".into(), ..payload("t", "正文") };
        let (text, name) = resolve_template(&root, &ClipConfig::default(), &p);
        assert_eq!(text, "# {{title}}\n");
        assert_eq!(name, "我的模板");

        // 读失败 / 内容为空 → 回落内置（按剪藏类型）
        let cfg = ClipConfig { template_rel: "Templates/不存在.md".into(), ..ClipConfig::default() };
        let (_, name) = resolve_template(&root, &cfg, &page);
        assert_eq!(name, "article");
        fs::write(root.join("Templates/空.md"), "  \n").unwrap();
        let cfg = ClipConfig { template_rel: "Templates/空.md".into(), ..ClipConfig::default() };
        let (_, name) = resolve_template(&root, &cfg, &page);
        assert_eq!(name, "article");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn health_json_carries_switches() {
        let cfg = ClipConfig {
            bound_port: Some(3211),
            localize_images: true,
            full_page_fallback: true,
            ..ClipConfig::default()
        };
        let body = health_json(&cfg, true);
        let v: serde_json::Value = serde_json::from_str(&body).unwrap();
        assert_eq!(v["ok"], true);
        assert_eq!(v["port"], 3211);
        assert_eq!(v["hasVault"], true);
        assert_eq!(v["localizeImages"], true);
        assert_eq!(v["fullPageFallback"], true);
        // 端口未绑定时是 null，开关缺省即 false
        let body = health_json(&ClipConfig::default(), false);
        let v: serde_json::Value = serde_json::from_str(&body).unwrap();
        assert!(v["port"].is_null());
        assert_eq!(v["hasVault"], false);
        assert_eq!(v["localizeImages"], false);
        assert_eq!(v["fullPageFallback"], false);
    }

    // ---------- HTTP 层 ----------

    fn raw_request(raw: &str) -> RawRequest {
        parse_request(raw.as_bytes()).unwrap()
    }

    #[test]
    fn parse_request_reads_post_body() {
        let body = r#"{"title":"t"}"#;
        let raw = format!(
            "POST /clip HTTP/1.1\r\nHost: 127.0.0.1:3210\r\nOrigin: chrome-extension://abc\r\nContent-Length: {}\r\n\r\n{}",
            body.len(),
            body
        );
        let req = raw_request(&raw);
        assert_eq!(req.method, "POST");
        assert_eq!(req.path, "/clip");
        assert_eq!(req.header("origin"), Some("chrome-extension://abc"));
        assert_eq!(req.header("host"), Some("127.0.0.1:3210"));
        assert_eq!(String::from_utf8_lossy(&req.body), body);
    }

    #[test]
    fn parse_request_rejects_bad_and_oversize() {
        // 无 \r\n\r\n
        assert!(matches!(parse_request(b"POST /clip HTTP/1.1"), Err(RequestError::Bad)));
        // body 不足（截断）
        let raw = "POST /clip HTTP/1.1\r\nContent-Length: 100\r\n\r\nshort";
        assert!(matches!(parse_request(raw.as_bytes()), Err(RequestError::Bad)));
        // Content-Length 超限
        let raw = format!("POST /clip HTTP/1.1\r\nContent-Length: {}\r\n\r\n", MAX_BODY + 1);
        assert!(matches!(parse_request(raw.as_bytes()), Err(RequestError::TooLarge)));
    }

    #[test]
    fn host_and_origin_gates() {
        assert!(host_ok("127.0.0.1:3210"));
        assert!(host_ok("localhost"));
        assert!(host_ok("LOCALHOST:3210"));
        assert!(!host_ok("evil.com"));
        assert!(!host_ok("evil.com:3210"));
        assert!(!host_ok(""));
        assert!(origin_ok("chrome-extension://abcdef"));
        assert!(origin_ok("moz-extension://abcdef"));
        assert!(!origin_ok("https://evil.com"));
        assert!(!origin_ok("http://localhost"));
    }

    #[test]
    fn process_clip_gates_and_writes() {
        let dir = std::env::temp_dir().join("notelume-clip-process-test");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let root = fs::canonicalize(&dir).unwrap();

        let index = Arc::new(Mutex::new(VaultIndex::default()));
        index.lock().unwrap().vault_root = root.to_string_lossy().into_owned();
        let cfg = ClipConfig::default();
        let body = serde_json::json!({"title": "p", "url": "https://e.com/a", "markdown": "正文"}).to_string();

        // 坏 JSON → 400
        let bad = "POST /clip HTTP/1.1\r\nContent-Length: 3\r\n\r\nxxx";
        let (code, _, _) = process_clip(&index, &cfg, &raw_request(bad));
        assert_eq!(code, 400);

        // 正确载荷（不带任何鉴权头）→ 200 + 落盘 + 事件
        let ok = format!("POST /clip HTTP/1.1\r\nContent-Length: {}\r\n\r\n{}", body.len(), body);
        let (code, resp, ev) = process_clip(&index, &cfg, &raw_request(&ok));
        assert_eq!(code, 200);
        assert!(resp.contains("\"rel\""), "{resp}");
        let ev = ev.expect("成功剪藏要发事件");
        assert!(ev["path"].as_str().unwrap().starts_with("Clippings/"));
        assert_eq!(ev["linked"], 0);

        // 没开库 → 409
        let empty = Arc::new(Mutex::new(VaultIndex::default()));
        let (code, resp, _) = process_clip(&empty, &cfg, &raw_request(&ok));
        assert_eq!(code, 409);
        assert!(resp.contains("no_vault"));
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn http_layer_serves_clip_over_socket() {
        let dir = std::env::temp_dir().join("notelume-clip-http-test");
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let root = fs::canonicalize(&dir).unwrap();

        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        listener.set_nonblocking(true).unwrap();

        let index = Arc::new(Mutex::new(VaultIndex::default()));
        index.lock().unwrap().vault_root = root.to_string_lossy().into_owned();
        let cfg = ClipConfig::default();
        let shutdown = Arc::new(AtomicBool::new(false));
        let emit: EmitFn = Arc::new(|_, _| {});
        let idx2 = index.clone();
        let cfg2 = cfg.clone();
        let sd2 = shutdown.clone();
        thread::spawn(move || serve_loop(listener, idx2, cfg2, sd2, emit));

        // 发一个 POST 并读完全部响应（服务端写完即关连接）。extra_headers 是附加头
        // （不带 \r\n），空串表示只带默认头
        let post = |body: &str, extra_headers: &str| -> String {
            let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
            s.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
            let head = if extra_headers.is_empty() {
                format!("Host: 127.0.0.1:{}", port)
            } else {
                format!("Host: 127.0.0.1:{}\r\n{}", port, extra_headers)
            };
            let req = format!(
                "POST /clip HTTP/1.1\r\n{}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
                head, body.len(), body
            );
            s.write_all(req.as_bytes()).unwrap();
            let mut resp = Vec::new();
            let mut buf = [0u8; 4096];
            loop {
                match s.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => resp.extend_from_slice(&buf[..n]),
                    Err(_) => break,
                }
            }
            String::from_utf8_lossy(&resp).to_string()
        };

        // GET /health 报出实际绑定端口（扩展「测试连接」会把它显示出来）
        let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
        s.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
        let req =
            format!("GET /health HTTP/1.1\r\nHost: 127.0.0.1:{}\r\nConnection: close\r\n\r\n", port);
        s.write_all(req.as_bytes()).unwrap();
        let mut resp = Vec::new();
        let mut buf = [0u8; 4096];
        loop {
            match s.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => resp.extend_from_slice(&buf[..n]),
                Err(_) => break,
            }
        }
        let resp = String::from_utf8_lossy(&resp);
        assert!(resp.starts_with("HTTP/1.1 200"), "{resp}");
        assert!(resp.contains(&format!("\"port\":{}", port)), "{resp}");

        let body =
            serde_json::json!({"title": "http 测试", "url": "https://e.com/a", "markdown": "正文"}).to_string();
        // 扩展来源 → 200
        let resp = post(&body, "Origin: chrome-extension://abc");
        assert!(resp.starts_with("HTTP/1.1 200"), "{resp}");
        assert!(resp.contains("\"rel\""), "{resp}");
        let entries: Vec<_> = fs::read_dir(root.join("Clippings")).unwrap().collect();
        assert_eq!(entries.len(), 1, "落盘一篇");
        assert!(entries[0].as_ref().unwrap().path().extension().unwrap() == "md");

        // 无 Origin（Firefox 扩展 / curl / 本机进程）→ 放行
        let resp = post(&body, "");
        assert!(resp.starts_with("HTTP/1.1 200"), "{resp}");

        // 网页来源 → 403（挡恶意网页直连本机端口）
        let resp = post(&body, "Origin: https://evil.com");
        assert!(resp.starts_with("HTTP/1.1 403"), "{resp}");
        assert!(resp.contains("forbidden"));

        // 非回环 Host（DNS rebinding）→ 403
        let mut s = TcpStream::connect(("127.0.0.1", port)).unwrap();
        s.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
        let req = format!(
            "POST /clip HTTP/1.1\r\nHost: evil.com\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            body.len(),
            body
        );
        s.write_all(req.as_bytes()).unwrap();
        let mut resp = Vec::new();
        let mut buf = [0u8; 4096];
        loop {
            match s.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => resp.extend_from_slice(&buf[..n]),
                Err(_) => break,
            }
        }
        assert!(String::from_utf8_lossy(&resp).starts_with("HTTP/1.1 403"));

        shutdown.store(true, Ordering::SeqCst);
        let _ = fs::remove_dir_all(&dir);
    }
}
