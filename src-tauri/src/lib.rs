use chrono::Local;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::thread;

// ==================== P0 已有类型 ====================

/// 目录树节点：文件夹或 .md 文件
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TreeNode {
    pub name: String,
    /// 相对库根的路径，统一使用 `/` 分隔（跨平台兼容）
    pub path: String,
    #[serde(rename = "type")]
    pub kind: String, // "folder" | "file"
    pub children: Option<Vec<TreeNode>>,
}

/// [[wikilink]] 解析结果
#[derive(Serialize)]
pub struct WikiResolve {
    pub exists: bool,
    pub path: Option<String>,
}

/// 扫描时跳过的目录名（隐藏目录另判）
const SKIP_DIRS: &[&str] = &[
    "node_modules",
    "target",
    "dist",
    ".git",
    ".obsidian",
    ".trash",
    ".notelume-backup",
];
/// 图片复制支持（白名单，防止任意文件混入 assets）
const IMG_EXTS: &[&str] = &["png", "jpg", "jpeg", "gif", "svg", "webp", "bmp", "ico", "avif"];

fn is_md(name: &str) -> bool {
    name.to_ascii_lowercase().ends_with(".md")
}

/// 画布文件（JSON Canvas 规范，与 Obsidian .canvas 兼容）：进文件树但不进索引
fn is_canvas(name: &str) -> bool {
    name.to_ascii_lowercase().ends_with(".canvas")
}

/// 拒绝越出库根的恶意路径（`..` 逃逸等）；root 与 target 均已 canonicalize
fn ensure_inside_root(root: &Path, target: &Path) -> Result<PathBuf, String> {
    let target = fs::canonicalize(target)
        .map_err(|e| format!("路径解析失败 {}：{}", target.display(), e))?;
    if target.starts_with(root) {
        Ok(target)
    } else {
        Err("非法路径：目标不在知识库根目录内".into())
    }
}

/// 库内相对路径（`/` 分隔）-> 绝对路径；要求所在目录已存在
fn abs_in_vault(vault_root: &str, rel: &str) -> Result<PathBuf, String> {
    let root = fs::canonicalize(vault_root).map_err(|e| e.to_string())?;
    let mut p = root.clone();
    for seg in rel.split('/').filter(|s| !s.is_empty()) {
        if seg == ".." {
            return Err("非法路径：不允许跳出知识库根目录".into());
        }
        p.push(seg);
    }
    ensure_inside_root(&root, &p)
}

/// 库内相对路径（`/` 分隔）-> 绝对路径，纯词法拼接（不要求已存在），拒绝 `..` 跳出。
/// 用于新建文件/文件夹/重命名目标等「路径尚未存在」的场景；存在性/越界由调用方另行校验。
fn vault_join(root: &Path, rel: &str) -> Result<PathBuf, String> {
    let mut p = root.to_path_buf();
    for seg in rel.split('/').filter(|s| !s.is_empty()) {
        if seg == ".." {
            return Err("非法路径：不允许跳出知识库根目录".into());
        }
        p.push(seg);
    }
    Ok(p)
}

/// 递归扫描目录树：仅收集 md 文件与文件夹，同层"文件夹在前、按名称排序"
fn scan_dir(dir: &Path, rel: &str, depth: usize) -> Vec<TreeNode> {
    let mut out = Vec::new();
    if depth > 12 {
        return out; // 防异常深嵌套
    }
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return out, // 无权限目录直接跳过，不中断整体扫描
    };
    let mut dirs = Vec::new();
    let mut files = Vec::new();
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') || SKIP_DIRS.contains(&name.as_str()) {
            continue;
        }
        let path = entry.path();
        let child_rel = if rel.is_empty() { name.clone() } else { format!("{}/{}", rel, name) };
        if path.is_dir() {
            dirs.push((name, child_rel, path));
        } else if path.is_file() && (is_md(&name) || is_canvas(&name)) {
            files.push(TreeNode { name, path: child_rel, kind: "file".into(), children: None });
        }
    }
    dirs.sort_by(|a, b| a.0.to_lowercase().cmp(&b.0.to_lowercase()));
    files.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    for (name, child_rel, path) in dirs {
        let children = scan_dir(&path, &child_rel, depth + 1);
        out.push(TreeNode { name, path: child_rel, kind: "folder".into(), children: Some(children) });
    }
    out.extend(files);
    out
}

/// 打开文件夹作为知识库：扫描 md 文件树
#[tauri::command]
fn scan_vault(vault_root: String) -> Result<Vec<TreeNode>, String> {
    let root = fs::canonicalize(&vault_root).map_err(|e| format!("知识库路径无效：{}", e))?;
    if !root.is_dir() {
        return Err("知识库路径不是目录".into());
    }
    Ok(scan_dir(&root, "", 0))
}

/// 读取库内 md 文件
#[tauri::command]
fn read_md_file(vault_root: String, path: String) -> Result<String, String> {
    let abs = abs_in_vault(&vault_root, &path)?;
    fs::read_to_string(&abs).map_err(|e| format!("读取失败：{}", e))
}

/// 写回库内 md 文件（UTF-8，标准 GFM，不引入任何私有格式）
#[tauri::command]
fn write_md_file(vault_root: String, path: String, content: String) -> Result<(), String> {
    let root = fs::canonicalize(&vault_root).map_err(|e| e.to_string())?;
    let mut abs = root.clone();
    for seg in path.split('/').filter(|s| !s.is_empty()) {
        if seg == ".." {
            return Err("非法路径：不允许跳出知识库根目录".into());
        }
        abs.push(seg);
    }
    if let Some(parent) = abs.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("创建目录失败：{}", e))?;
    }
    // 越界校验：文件路径的父目录必须位于库根内
    let parent = fs::canonicalize(abs.parent().ok_or("非法文件路径")?)
        .map_err(|e| e.to_string())?;
    if !parent.starts_with(&root) {
        return Err("非法路径：目标不在知识库根目录内".into());
    }
    fs::write(&abs, content).map_err(|e| format!("保存失败：{}", e))
}

/// 在库根按文件名查找 md（wikilink 解析），命中返回相对路径
fn find_md_by_basename(root: &Path, name: &str, depth: usize) -> Option<String> {
    if depth > 12 {
        return None;
    }
    let entries = fs::read_dir(root).ok()?;
    let mut sub_hits = Vec::new();
    for entry in entries.flatten() {
        let fname = entry.file_name().to_string_lossy().to_string();
        if fname.starts_with('.') || SKIP_DIRS.contains(&fname.as_str()) || fname == "assets" {
            continue;
        }
        let path = entry.path();
        if path.is_dir() {
            if let Some(hit) = find_md_by_basename(&path, name, depth + 1) {
                sub_hits.push(hit);
            }
        } else {
            let stem = fname.rsplit_once('.').map_or(fname.as_str(), |(s, _)| s);
            if stem == name && is_md(&fname) {
                sub_hits.insert(0, fname.clone()); // 同层优先
            }
        }
    }
    sub_hits.into_iter().next()
}

/// 目标 md 的库内路径：相对 ref_rel 所在目录解析 `../a/b.md` 之类
fn normalize_target(ref_rel: &str, link: &str) -> String {
    let base_dir = match ref_rel.rsplit_once('/') {
        Some((d, _)) => d.to_string(),
        None => String::new(),
    };
    let joined = if link.starts_with('/') {
        link.trim_start_matches('/').to_string()
    } else if base_dir.is_empty() {
        link.to_string()
    } else {
        format!("{}/{}", base_dir, link)
    };
    let mut parts: Vec<&str> = Vec::new();
    for seg in joined.split('/').filter(|s| !s.is_empty() && *s != ".") {
        if seg == ".." {
            parts.pop();
        } else {
            parts.push(seg);
        }
    }
    parts.join("/")
}

/// 解析 [[wikilink]]：先按库内相对路径解析，失败再按 basename 全库查找
#[tauri::command]
fn resolve_wiki_link(vault_root: String, ref_rel: String, name: String) -> Result<WikiResolve, String> {
    let root = fs::canonicalize(&vault_root).map_err(|e| e.to_string())?;
    if let Some(rel) = resolve_one(&root, &ref_rel, &name) {
        return Ok(WikiResolve { exists: true, path: Some(rel) });
    }
    Ok(WikiResolve { exists: false, path: None })
}

/// 新建 md 文档（wikilink 点击不存在的文档时可选新建）
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateDocArgs {
    pub path: String,
    pub content: String,
}

#[tauri::command]
fn create_md_file(vault_root: String, args: CreateDocArgs) -> Result<String, String> {
    let mut rel = args.path.trim().replace('\\', "/");
    if rel.is_empty() {
        return Err("文件名不能为空".into());
    }
    if !rel.to_ascii_lowercase().ends_with(".md") {
        rel.push_str(".md");
    }
    write_md_file(vault_root, rel.clone(), args.content)?;
    Ok(rel)
}

/// 把库内单个文件（md / canvas）移入系统回收站：路径经 abs_in_vault 限定库内，拒绝目录与越界。
#[tauri::command]
fn delete_file(vault_root: String, path: String) -> Result<(), String> {
    let abs = abs_in_vault(&vault_root, &path)?;
    if abs.is_dir() {
        return Err("不支持删除文件夹".into());
    }
    trash::delete(&abs).map_err(|e| format!("移入回收站失败：{}", e))?;
    Ok(())
}

/// 新建文件夹：路径限库内（父目录建后校验在根内），拒绝 `..` 越界、拒绝已存在。
#[tauri::command]
fn create_dir(vault_root: String, path: String) -> Result<(), String> {
    let root = fs::canonicalize(&vault_root).map_err(|e| e.to_string())?;
    let rel = path.trim().replace('\\', "/");
    if rel.is_empty() {
        return Err("文件夹名不能为空".into());
    }
    let abs = vault_join(&root, &rel)?;
    if abs.exists() {
        return Err("目标已存在".into());
    }
    let parent = abs.parent().ok_or_else(|| "非法路径".to_string())?;
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let pc = fs::canonicalize(parent).map_err(|e| e.to_string())?;
    if !pc.starts_with(&root) {
        return Err("非法路径：目标不在知识库根目录内".into());
    }
    fs::create_dir(&abs).map_err(|e| format!("创建文件夹失败：{}", e))?;
    Ok(())
}

/// 重命名 / 移动库内条目（文件或文件夹，一次 fs::rename 完成）。from 必须已存在且在库内；
/// to 的父目录必须已存在且在库内，to 不能已存在（不静默覆盖），不允许把文件夹移入自身内部。
#[tauri::command]
fn rename_item(vault_root: String, from: String, to: String) -> Result<(), String> {
    let root = fs::canonicalize(&vault_root).map_err(|e| e.to_string())?;
    let abs_from = abs_in_vault(&vault_root, &from)?;
    let rel_to = to.trim().replace('\\', "/");
    if rel_to.is_empty() {
        return Err("新名称不能为空".into());
    }
    let abs_to = vault_join(&root, &rel_to)?;
    if abs_to.exists() {
        return Err("目标已存在，无法重命名 / 移动".into());
    }
    let parent = abs_to.parent().ok_or_else(|| "非法路径".to_string())?;
    let pc = fs::canonicalize(parent).map_err(|e| format!("目标目录不存在：{}", e))?;
    if !pc.starts_with(&root) {
        return Err("非法路径：目标不在知识库根目录内".into());
    }
    // 不允许把文件夹移动到它自身或自己的子目录下
    if abs_from.is_dir() && abs_to.starts_with(&abs_from) {
        return Err("不能把文件夹移动到自身内部".into());
    }
    fs::rename(&abs_from, &abs_to).map_err(|e| format!("重命名失败：{}", e))?;
    Ok(())
}

/// FNV-1a 64 位哈希：用于图片内容去重（同名不同内容时追加内容指纹）
fn fnv1a(bytes: &[u8]) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in bytes {
        h ^= *b as u64;
        h = h.wrapping_mul(0x1000_0000_01b3);
    }
    h
}

/// 把库外图片拷入该文档同级的 assets/ 目录，返回可直接写入 md 的相对链接。
#[tauri::command]
fn copy_image_asset(vault_root: String, md_rel: String, path: String) -> Result<String, String> {
    let src = PathBuf::from(&path);
    if !src.exists() {
        return Err(format!("源文件不存在：{}", path));
    }
    let name = src.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    let ext = src.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
    if !IMG_EXTS.contains(&ext.as_str()) {
        return Err(format!("不支持的图片类型：{}", ext));
    }
    let root = fs::canonicalize(&vault_root).map_err(|e| e.to_string())?;
    let base_dir = match md_rel.rsplit_once('/') {
        Some((d, _)) => root.join(d.replace('/', "\\")),
        None => root.clone(),
    };
    fs::create_dir_all(&base_dir).map_err(|e| e.to_string())?;
    let md_dir = fs::canonicalize(&base_dir).map_err(|e| e.to_string())?;
    let assets_dir = md_dir.join("assets");
    fs::create_dir_all(&assets_dir).map_err(|e| e.to_string())?;

    let bytes = fs::read(&src).map_err(|e| format!("读取图片失败：{}", e))?;
    let stem = name.rsplit_once('.').map_or(name.as_str(), |(s, _)| s).to_string();
    let mut file_name = name.clone();
    let mut dest = assets_dir.join(&file_name);
    if dest.exists() {
        let same = fs::read(&dest).map(|old| old == bytes).unwrap_or(false);
        if !same {
            file_name = format!("{}-{:x}.{}", stem, fnv1a(&bytes), ext);
            dest = assets_dir.join(&file_name);
        }
    }
    if !dest.exists() {
        fs::copy(&src, &dest).map_err(|e| format!("复制图片失败：{}", e))?;
    }
    Ok(format!("./assets/{}", file_name))
}

/// 保存 base64 图片数据到 assets/（剪贴板粘贴等无文件系统路径的场景）
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveAssetArgs {
    pub data_base64: String,
    pub ext: String,
}

#[tauri::command]
fn save_image_bytes(vault_root: String, md_rel: String, args: SaveAssetArgs) -> Result<String, String> {
    let ext = args.ext.to_ascii_lowercase().trim_start_matches('.').to_string();
    if !IMG_EXTS.contains(&ext.as_str()) {
        return Err(format!("不支持的图片类型：{}", ext));
    }
    let table: Vec<char> = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
        .chars().collect();
    let clean: String = args.data_base64.chars().filter(|c| !c.is_whitespace()).collect();
    let mut buf: Vec<u8> = Vec::with_capacity(clean.len() * 3 / 4);
    let mut acc: u32 = 0;
    let mut bits: u32 = 0;
    for ch in clean.chars() {
        if ch == '=' {
            break;
        }
        let v = table.iter().position(|c| *c == ch).ok_or("非法 base64 字符")? as u32;
        acc = (acc << 6) | v;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            buf.push((acc >> bits) as u8);
        }
    }
    let root = fs::canonicalize(&vault_root).map_err(|e| e.to_string())?;
    let base_dir = match md_rel.rsplit_once('/') {
        Some((d, _)) => root.join(d.replace('/', "\\")),
        None => root.clone(),
    };
    fs::create_dir_all(&base_dir).map_err(|e| e.to_string())?;
    let md_dir = fs::canonicalize(&base_dir).map_err(|e| e.to_string())?;
    let assets_dir = md_dir.join("assets");
    fs::create_dir_all(&assets_dir).map_err(|e| e.to_string())?;
    let file_name = format!("pasted-{:x}.{}", fnv1a(&buf), ext);
    fs::write(assets_dir.join(&file_name), &buf).map_err(|e| format!("写入图片失败：{}", e))?;
    Ok(format!("./assets/{}", file_name))
}

/// 手写 base64 编码（项目不引入 base64 crate；与 save_image_bytes 里的手写解码对称）
fn b64_encode(data: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity((data.len() + 2) / 3 * 4);
    for chunk in data.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = *chunk.get(1).unwrap_or(&0) as u32;
        let b2 = *chunk.get(2).unwrap_or(&0) as u32;
        let n = (b0 << 16) | (b1 << 8) | b2;
        out.push(TABLE[(n >> 18) as usize & 63] as char);
        out.push(TABLE[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 { TABLE[(n >> 6) as usize & 63] as char } else { '=' });
        out.push(if chunk.len() > 2 { TABLE[n as usize & 63] as char } else { '=' });
    }
    out
}

fn mime_for_ext(ext: &str) -> &'static str {
    match ext {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "svg" => "image/svg+xml",
        "webp" => "image/webp",
        "bmp" => "image/bmp",
        "ico" => "image/x-icon",
        "avif" => "image/avif",
        _ => "application/octet-stream",
    }
}

/// 百分号解码（至少把 %20 还原为空格）：markdown 图片链接遵循 URL 规范，
/// 文件名里的空格等字符会被编码成 %XX，而磁盘上的真实文件名是解码后的。
fn percent_decode(s: &str) -> String {
    let bytes = s.as_bytes();
    let mut out: Vec<u8> = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 3 <= bytes.len() {
            if let Ok(v) = u8::from_str_radix(std::str::from_utf8(&bytes[i + 1..i + 3]).unwrap_or(""), 16) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8(out).unwrap_or_else(|_| s.to_string())
}

/// 将相对当前 md（或绝对）的图片路径解析为绝对路径，允许 `..` 但 canonicalize 后必须在库内。
fn resolve_media_abs(vault_root: &str, md_rel: &str, src: &str) -> Result<PathBuf, String> {
    let src = percent_decode(src);
    let root = fs::canonicalize(vault_root).map_err(|e| e.to_string())?;
    let src_clean = src.trim_start_matches("./");
    let bytes = src_clean.as_bytes();
    let is_abs = src_clean.starts_with('/')
        || (bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':');
    let p = if is_abs {
        PathBuf::from(src_clean)
    } else {
        let mut base = root.clone();
        if let Some((d, _)) = md_rel.rsplit_once('/') {
            for seg in d.split('/').filter(|s| !s.is_empty()) {
                base.push(seg);
            }
        }
        for seg in src_clean.split(['/', '\\']).filter(|s| !s.is_empty()) {
            base.push(seg);
        }
        base
    };
    ensure_inside_root(&root, &p) // canonicalize 解析 .. 并校验未逸出库根
}

/// 读图片字节并返回 data: URL（供前端 <img> 直接显示，绕开 asset 协议 scope/跨域问题）。
#[tauri::command]
fn read_image_data_uri(vault_root: String, md_rel: String, src: String) -> Result<String, String> {
    let abs = resolve_media_abs(&vault_root, &md_rel, &src)?;
    let ext = abs
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    if !IMG_EXTS.contains(&ext.as_str()) {
        return Err(format!("不支持的图片类型：{}", ext));
    }
    let bytes = fs::read(&abs).map_err(|e| format!("读取图片失败：{}", e))?;
    Ok(format!("data:{};base64,{}", mime_for_ext(&ext), b64_encode(&bytes)))
}

// ==================== P1 新增：知识库索引 / 双向链接 / 搜索 / 预览 / 备份 / 导出 ====================

/// 内部：每个 md 一条 DocEntry（含原文用于快速搜索与片段）
#[derive(Clone)]
struct DocEntry {
    path: String,
    title: String,
    tags: Vec<String>,
    outgoing: Vec<String>,   // 解析成功的目标 rel path
    unresolved: Vec<String>, // 未能解析的目标（保留原 name）
    content: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DocInfo {
    pub path: String,
    pub title: String,
    pub tags: Vec<String>,
    pub outgoing: Vec<String>,
    pub unresolved: Vec<String>,
    pub summary: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct BacklinkHit {
    pub path: String,
    pub title: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SearchHit {
    pub path: String,
    pub title: String,
    pub snippet: String,
    pub matched_by: String, // "title" | "tag" | "content"
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct IndexStatus {
    pub vault_root: String,
    pub docs: usize,
    pub ready: bool,
}

#[derive(Default, Clone)]
pub struct VaultIndex {
    pub(crate) vault_root: String,
    pub(crate) docs: HashMap<String, DocEntry>,
    pub(crate) backlinks: HashMap<String, Vec<String>>, // target rel -> [src rel...]
    pub(crate) ready: bool,
}

/// Tauri 托管状态：Arc 便于后台线程 clone 后写回
#[derive(Clone)]
pub struct IndexState(pub Arc<Mutex<VaultIndex>>);

/// 从 md 提取所有 [[...]] 目标（去 label）。无嵌套；遇到换行终止避免跨段。
fn extract_wikilinks(md: &str) -> Vec<String> {
    let mut out = Vec::new();
    let cs: Vec<char> = md.chars().collect();
    let mut i = 0;
    while i + 1 < cs.len() {
        if cs[i] == '[' && cs[i + 1] == '[' {
            let mut j = i + 2;
            let mut ok = false;
            while j + 1 < cs.len() {
                if cs[j] == '\n' { break; }
                if cs[j] == ']' && cs[j + 1] == ']' { ok = true; break; }
                j += 1;
            }
            if ok {
                let inner: String = cs[i + 2..j].iter().collect();
                if !inner.contains('[') {
                    let target = inner.split('|').next().unwrap_or("").trim().to_string();
                    if !target.is_empty() {
                        out.push(target);
                    }
                }
                i = j + 2;
                continue;
            }
        }
        i += 1;
    }
    out
}

fn is_tag_start(c: char) -> bool {
    // 支持 Unicode CJK、拉丁等字母数字（与 Obsidian 行为一致）
    c.is_alphanumeric() || c == '_' || c == '-' || c == '/'
}
fn is_tag_char(c: char) -> bool {
    c.is_alphanumeric() || c == '_' || c == '-' || c == '/'
}

/// 从 md 提取所有 #tag（跳过标题行、代码块、行内代码）
fn extract_tags(md: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    let mut in_code_block = false;
    for line in md.lines() {
        let trimmed = line.trim_start();
        if trimmed.starts_with("```") || trimmed.starts_with("~~~") {
            in_code_block = !in_code_block;
            continue;
        }
        if in_code_block {
            continue;
        }
        if trimmed.starts_with('#') {
            // 标题行：`#` 后面即使有 word 也不算 tag
            continue;
        }
        let cs: Vec<char> = line.chars().collect();
        let mut k = 0;
        while k < cs.len() {
            let c = cs[k];
            // 跳过行内代码段
            if c == '`' {
                let mut e = k + 1;
                while e < cs.len() && cs[e] != '`' { e += 1; }
                k = (e + 1).min(cs.len());
                continue;
            }
            if c == '#' && k + 1 < cs.len() && is_tag_start(cs[k + 1]) {
                // 左边界：`#` 前必须是空白或标点，否则视为词中（例如 C#）
                let left_ok = k == 0 || {
                    let p = cs[k - 1];
                    p.is_whitespace()
                        || matches!(p, '(' | '>' | '"' | '\'' | '[' | ']' | '*' | '_' | '~' | ',' | '.' | ';' | ':' | '!' | '?')
                };
                if !left_ok {
                    k += 1;
                    continue;
                }
                let mut n = 1;
                while k + n < cs.len() && is_tag_char(cs[k + n]) { n += 1; }
                let tag: String = cs[k + 1..k + n].iter().collect();
                if seen.insert(tag.clone()) {
                    out.push(tag);
                }
                k += n;
            } else {
                k += 1;
            }
        }
    }
    out
}

/// 首个 `# heading` 作为标题；否则用文件名去 .md
fn extract_title(md: &str, path: &str) -> String {
    for line in md.lines() {
        let t = line.trim_start();
        if t.starts_with('#') {
            let s = t.trim_start_matches('#').trim();
            if !s.is_empty() {
                return s.to_string();
            }
        }
    }
    let name = path.rsplit('/').next().unwrap_or(path);
    name.rsplit_once('.').map_or(name.to_string(), |(s, _)| s.to_string())
}

/// 摘要：粗略剥掉行内 md 语法后取前 n 字
fn summary_from(md: &str, n: usize) -> String {
    let mut buf = String::new();
    let mut count = 0usize;
    for line in md.lines() {
        let t = line.trim();
        if t.is_empty() {
            continue;
        }
        let cleaned = strip_inline(t);
        for ch in cleaned.chars() {
            buf.push(ch);
            count += 1;
            if count >= n {
                return buf;
            }
        }
        buf.push(' ');
        count += 1;
        if count >= n {
            return buf;
        }
    }
    buf
}

fn strip_inline(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let cs: Vec<char> = s.chars().collect();
    let mut i = 0;
    while i < cs.len() {
        let c = cs[i];
        if (c == '*' || c == '_' || c == '~') && i + 1 < cs.len() && cs[i + 1] == c {
            i += 2;
            continue;
        }
        if c == '#' && i + 1 < cs.len() && is_tag_start(cs[i + 1]) {
            let mut n = 1;
            while i + n < cs.len() && is_tag_char(cs[i + n]) { n += 1; }
            i += n;
            continue;
        }
        if c == '[' && i + 1 < cs.len() && cs[i + 1] == '[' {
            let mut j = i + 2;
            while j + 1 < cs.len() && !(cs[j] == ']' && cs[j + 1] == ']') { j += 1; }
            if j + 1 < cs.len() {
                let inner: String = cs[i + 2..j].iter().collect();
                let label = inner.split('|').last().unwrap_or("").trim();
                if !label.is_empty() {
                    out.push_str(label);
                }
                i = j + 2;
                continue;
            }
        }
        if c == '[' && i + 1 < cs.len() {
            // [text](url) 保留 text
            let mut j = i + 1;
            while j < cs.len() && cs[j] != ']' { j += 1; }
            if j < cs.len() {
                let text: String = cs[i + 1..j].iter().collect();
                out.push_str(&text);
                i = j + 1;
                // 跳过 (url)
                if i < cs.len() && cs[i] == '(' {
                    let mut k = i + 1;
                    while k < cs.len() && cs[k] != ')' { k += 1; }
                    i = (k + 1).min(cs.len());
                }
                continue;
            }
        }
        if c == '`' || c == '*' || c == '_' || c == '~' {
            i += 1;
            continue;
        }
        out.push(c);
        i += 1;
    }
    out
}

/// 解析单个 wiki 链接到库内 rel path。root 是 canonical 库根。
fn resolve_one(root: &Path, ref_rel: &str, link: &str) -> Option<String> {
    let link = link.trim();
    if link.is_empty() {
        return None;
    }
    if link.contains('/') || link.starts_with("..") || link.to_ascii_lowercase().ends_with(".md") {
        let rel = normalize_target(ref_rel, link);
        let cand = if rel.to_ascii_lowercase().ends_with(".md") {
            rel
        } else {
            format!("{}.md", rel)
        };
        if root.join(&cand).exists() {
            return Some(cand);
        }
    }
    let stem = link
        .rsplit_once('.')
        .filter(|_| is_md(link))
        .map_or(link, |(s, _)| s)
        .to_string();
    find_md_by_basename(root, &stem, 0)
}

/// 收集库内所有 md 相对路径
fn collect_md_paths(dir: &Path, rel: &str, depth: usize, out: &mut Vec<String>) {
    if depth > 12 {
        return;
    }
    let entries = match fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return,
    };
    for e in entries.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        if name.starts_with('.') || SKIP_DIRS.contains(&name.as_str()) {
            continue;
        }
        let p = e.path();
        let cr = if rel.is_empty() { name.clone() } else { format!("{}/{}", rel, name) };
        if p.is_dir() {
            collect_md_paths(&p, &cr, depth + 1, out);
        } else if p.is_file() && is_md(&name) {
            out.push(cr);
        }
    }
}

/// 全量构建索引
fn build_index(vault_root: &str) -> Result<VaultIndex, String> {
    let root = fs::canonicalize(vault_root).map_err(|e| e.to_string())?;
    let mut paths: Vec<String> = Vec::new();
    collect_md_paths(&root, "", 0, &mut paths);
    let mut docs: HashMap<String, DocEntry> = HashMap::new();
    for p in paths {
        let mut abs = root.clone();
        for seg in p.split('/') {
            abs.push(seg);
        }
        let content = fs::read_to_string(&abs).unwrap_or_default();
        let raw = extract_wikilinks(&content);
        let mut outgoing: Vec<String> = Vec::new();
        let mut unresolved: Vec<String> = Vec::new();
        for r in raw {
            match resolve_one(&root, &p, &r) {
                Some(hit) => {
                    if hit != p {
                        outgoing.push(hit);
                    }
                }
                None => unresolved.push(r),
            }
        }
        outgoing.sort();
        outgoing.dedup();
        unresolved.sort();
        unresolved.dedup();
        let title = extract_title(&content, &p);
        let tags = extract_tags(&content);
        docs.insert(p.clone(), DocEntry { path: p.clone(), title, tags, outgoing, unresolved, content });
    }
    let mut backlinks: HashMap<String, Vec<String>> = HashMap::new();
    for (src, entry) in docs.iter() {
        for tgt in &entry.outgoing {
            backlinks.entry(tgt.clone()).or_default().push(src.clone());
        }
    }
    for lst in backlinks.values_mut() {
        lst.sort();
        lst.dedup();
    }
    Ok(VaultIndex {
        vault_root: root.to_string_lossy().into_owned(),
        docs,
        backlinks,
        ready: true,
    })
}

/// 触发后台全量重建；立即返回，前端轮询 get_index_status 判断就绪
#[tauri::command]
fn rebuild_index(state: tauri::State<'_, IndexState>, vault_root: String) -> Result<IndexStatus, String> {
    let shared = state.0.clone();
    let canonical = fs::canonicalize(&vault_root).map_err(|e| e.to_string())?;
    {
        let mut g = shared.lock().map_err(|e| e.to_string())?;
        g.ready = false;
        g.vault_root = canonical.to_string_lossy().into_owned();
        g.docs.clear();
        g.backlinks.clear();
    }
    let vr = vault_root.clone();
    thread::spawn(move || {
        match build_index(&vr) {
            Ok(idx) => {
                if let Ok(mut g) = shared.lock() {
                    *g = idx;
                }
            }
            Err(_) => {
                if let Ok(mut g) = shared.lock() {
                    g.ready = false;
                }
            }
        }
    });
    Ok(IndexStatus { vault_root, docs: 0, ready: false })
}

#[tauri::command]
fn get_index_status(state: tauri::State<'_, IndexState>) -> IndexStatus {
    let g = state.0.lock().unwrap();
    IndexStatus { vault_root: g.vault_root.clone(), docs: g.docs.len(), ready: g.ready }
}

#[tauri::command]
fn query_backlinks(state: tauri::State<'_, IndexState>, path: String) -> Vec<BacklinkHit> {
    let g = state.0.lock().unwrap();
    g.backlinks
        .get(&path)
        .map(|lst| {
            lst.iter()
                .filter_map(|p| g.docs.get(p).map(|d| BacklinkHit { path: p.clone(), title: d.title.clone() }))
                .collect()
        })
        .unwrap_or_default()
}

#[tauri::command]
fn query_outgoing(state: tauri::State<'_, IndexState>, path: String) -> Vec<BacklinkHit> {
    let g = state.0.lock().unwrap();
    g.docs
        .get(&path)
        .map(|d| {
            d.outgoing
                .iter()
                .filter_map(|p| g.docs.get(p).map(|t| BacklinkHit { path: p.clone(), title: t.title.clone() }))
                .collect()
        })
        .unwrap_or_default()
}

#[tauri::command]
fn get_doc_info(state: tauri::State<'_, IndexState>, path: String) -> Option<DocInfo> {
    let g = state.0.lock().unwrap();
    g.docs.get(&path).map(|d| DocInfo {
        path: d.path.clone(),
        title: d.title.clone(),
        tags: d.tags.clone(),
        outgoing: d.outgoing.clone(),
        unresolved: d.unresolved.clone(),
        summary: summary_from(&d.content, 200),
    })
}

/// 大小写不敏感 substring 匹配；顺序：标题 > 标签 > 正文
#[tauri::command]
fn search_vault(state: tauri::State<'_, IndexState>, query: String, limit: usize) -> Vec<SearchHit> {
    let g = state.0.lock().unwrap();
    let q = query.trim().to_lowercase();
    if q.is_empty() {
        return Vec::new();
    }
    let mut hits: Vec<SearchHit> = Vec::new();
    for d in g.docs.values() {
        let matched_by = if d.title.to_lowercase().contains(&q) {
            "title"
        } else if d.tags.iter().any(|t| t.to_lowercase().contains(&q)) {
            "tag"
        } else if d.content.to_lowercase().contains(&q) {
            "content"
        } else {
            continue;
        };
        let snippet = make_snippet(&d.content, &q, 90);
        hits.push(SearchHit {
            path: d.path.clone(),
            title: d.title.clone(),
            snippet,
            matched_by: matched_by.to_string(),
        });
        if hits.len() >= limit.saturating_mul(3).max(50) {
            break;
        }
    }
    hits.sort_by(|a, b| match a.matched_by.cmp(&b.matched_by) {
        std::cmp::Ordering::Equal => a.path.cmp(&b.path),
        o => o,
    });
    hits.into_iter().take(limit).collect()
}

/// 从原文提取匹配位置前后 radius 字符，跨字符边界安全
fn make_snippet(md: &str, q_lower: &str, radius: usize) -> String {
    let ml = md.to_lowercase();
    match ml.find(q_lower) {
        Some(byte_idx) => {
            // byte_idx 一定在 UTF-8 字符边界上（因 to_lowercase 保留边界）
            let before_chars = md[..byte_idx].chars().count();
            let q_chars = q_lower.chars().count();
            let cs: Vec<char> = md.chars().collect();
            let start = before_chars.saturating_sub(radius);
            let end = (before_chars + q_chars + radius).min(cs.len());
            let body: String = cs[start..end].iter().collect();
            let prefix = if start > 0 { "…" } else { "" };
            let suffix = if end < cs.len() { "…" } else { "" };
            format!("{}{}{}", prefix, body.replace('\n', " "), suffix)
        }
        None => summary_from(md, radius * 2),
    }
}

#[tauri::command]
fn doc_preview(vault_root: String, path: String, max_chars: usize) -> Result<String, String> {
    let abs = abs_in_vault(&vault_root, &path)?;
    let content = fs::read_to_string(&abs).map_err(|e| e.to_string())?;
    Ok(summary_from(&content, max_chars))
}

/// 增量更新一文档；用于保存/新建后立刻反映到索引，无需全量重建
#[tauri::command]
fn update_index_doc(
    state: tauri::State<'_, IndexState>,
    path: String,
    content: String,
) -> Result<(), String> {
    let mut g = state.0.lock().map_err(|e| e.to_string())?;
    if !g.ready {
        return Ok(()); // rebuild 中：忽略，rebuild 结束时会拿到最新文件
    }
    let root = PathBuf::from(&g.vault_root);
    let raw = extract_wikilinks(&content);
    let mut outgoing: Vec<String> = Vec::new();
    let mut unresolved: Vec<String> = Vec::new();
    for r in raw {
        match resolve_one(&root, &path, &r) {
            Some(hit) => {
                if hit != path {
                    outgoing.push(hit);
                }
            }
            None => unresolved.push(r),
        }
    }
    outgoing.sort();
    outgoing.dedup();
    unresolved.sort();
    unresolved.dedup();
    let title = extract_title(&content, &path);
    let tags = extract_tags(&content);
    let old_outgoing: Vec<String> = g
        .docs
        .get(&path)
        .map(|d| d.outgoing.clone())
        .unwrap_or_default();
    g.docs.insert(
        path.clone(),
        DocEntry { path: path.clone(), title, tags, outgoing, unresolved, content },
    );
    for tgt in &old_outgoing {
        if let Some(lst) = g.backlinks.get_mut(tgt) {
            lst.retain(|p| p != &path);
        }
    }
    let new_outgoing: Vec<String> = g
        .docs
        .get(&path)
        .map(|d| d.outgoing.clone())
        .unwrap_or_default();
    for tgt in new_outgoing {
        let e = g.backlinks.entry(tgt).or_default();
        if !e.contains(&path) {
            e.push(path.clone());
            e.sort();
        }
    }
    Ok(())
}

/// 从索引移除一条文档：清掉它写入他人 backlinks 的贡献，再删自身条目与作为 target 的 backlinks。
/// 抽成纯函数便于单测（命令层只负责加锁与 ready 判断）。
fn remove_doc_from_index(g: &mut VaultIndex, path: &str) {
    if let Some(entry) = g.docs.remove(path) {
        for tgt in &entry.outgoing {
            if let Some(lst) = g.backlinks.get_mut(tgt) {
                lst.retain(|p| p != path);
            }
        }
    }
    g.backlinks.remove(path);
}

/// 文件删除后增量清理索引；无需全量重建
#[tauri::command]
fn remove_index_doc(
    state: tauri::State<'_, IndexState>,
    path: String,
) -> Result<(), String> {
    let mut g = state.0.lock().map_err(|e| e.to_string())?;
    if !g.ready {
        return Ok(()); // rebuild 中：忽略，rebuild 不会收录已删除文件
    }
    remove_doc_from_index(&mut g, &path);
    Ok(())
}

/// 备份：.notelume-backup/YYYY-MM-DD/{stem}-HH-MM-SS.md
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupArgs {
    pub path: String,
    pub content: String,
}

#[tauri::command]
fn backup_write(vault_root: String, args: BackupArgs) -> Result<String, String> {
    let root = fs::canonicalize(&vault_root).map_err(|e| e.to_string())?;
    let now = Local::now();
    let day = now.format("%Y-%m-%d").to_string();
    let ts = now.format("%H-%M-%S").to_string();
    let file_name = args.path.rsplit('/').next().unwrap_or(&args.path);
    let stem = file_name
        .rsplit_once('.')
        .map_or(file_name.to_string(), |(s, _)| s.to_string());
    let file_rel = format!(".notelume-backup/{}/{}-{}.md", day, stem, ts);
    let mut abs = root.clone();
    for seg in file_rel.split('/') {
        abs.push(seg);
    }
    if let Some(p) = abs.parent() {
        fs::create_dir_all(p).map_err(|e| e.to_string())?;
    }
    fs::write(&abs, args.content).map_err(|e| format!("写入备份失败：{}", e))?;
    Ok(file_rel)
}

/// 列出库内已有备份（按时间倒序，用于 P2 版本快照 UI；P1 只做写入不做展示）
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupEntry {
    pub path: String,
    pub day: String,
    pub name: String,
}

#[tauri::command]
fn list_backups(vault_root: String, doc_rel: Option<String>) -> Result<Vec<BackupEntry>, String> {
    let root = fs::canonicalize(&vault_root).map_err(|e| e.to_string())?;
    let base = root.join(".notelume-backup");
    if !base.exists() {
        return Ok(Vec::new());
    }
    let stem_filter = doc_rel.as_deref().and_then(|p| {
        let f = p.rsplit('/').next().unwrap_or(p);
        f.rsplit_once('.').map(|(s, _)| s.to_string()).or_else(|| Some(f.to_string()))
    });
    let mut out = Vec::new();
    let days = fs::read_dir(&base).map_err(|e| e.to_string())?;
    for day_entry in days.flatten() {
        if !day_entry.path().is_dir() {
            continue;
        }
        let day = day_entry.file_name().to_string_lossy().to_string();
        let files = match fs::read_dir(day_entry.path()) {
            Ok(f) => f,
            Err(_) => continue,
        };
        for f in files.flatten() {
            let name = f.file_name().to_string_lossy().to_string();
            if !name.ends_with(".md") {
                continue;
            }
            if let Some(filter) = &stem_filter {
                if !name.starts_with(&format!("{}-", filter)) {
                    continue;
                }
            }
            if let Ok(rel) = f.path().strip_prefix(&root) {
                out.push(BackupEntry {
                    path: rel.to_string_lossy().replace('\\', "/"),
                    day: day.clone(),
                    name,
                });
            }
        }
    }
    out.sort_by(|a, b| b.day.cmp(&a.day).then_with(|| b.name.cmp(&a.name)));
    Ok(out)
}

/// 读取 .notelume-backup 下某个快照全文（P2 版本快照 UI 预览 / 回滚用）。
/// 仅允许读取备份目录内文件，前缀白名单 + abs_in_vault 双重防路径穿越。
#[tauri::command]
fn read_backup(vault_root: String, backup_rel: String) -> Result<String, String> {
    let norm = backup_rel.replace('\\', "/");
    if !norm.starts_with(".notelume-backup/") {
        return Err("非法路径：只能读取备份目录内的快照".into());
    }
    let abs = abs_in_vault(&vault_root, &norm)?;
    fs::read_to_string(&abs).map_err(|e| format!("读取备份失败：{}", e))
}

/// 插件文件条目：name = 文件名，path = 库内相对路径
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginEntry {
    pub name: String,
    pub path: String,
}

/// 列出 <vault>/.notelume-plugins/ 下的 *.js / *.mjs 插件文件（P2 插件钩子系统）
#[tauri::command]
fn list_plugins(vault_root: String) -> Result<Vec<PluginEntry>, String> {
    let root = fs::canonicalize(&vault_root).map_err(|e| e.to_string())?;
    let base = root.join(".notelume-plugins");
    if !base.exists() {
        return Ok(Vec::new());
    }
    let mut out = Vec::new();
    for e in fs::read_dir(&base).map_err(|e| e.to_string())?.flatten() {
        let p = e.path();
        if !p.is_file() {
            continue;
        }
        let name = e.file_name().to_string_lossy().to_string();
        if !(name.ends_with(".js") || name.ends_with(".mjs")) {
            continue;
        }
        if let Ok(rel) = p.strip_prefix(&root) {
            out.push(PluginEntry {
                name,
                path: rel.to_string_lossy().replace('\\', "/"),
            });
        }
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
}

/// 读取一个插件源码（前端用 Blob URL + 动态 import 加载）。
/// 前缀白名单 .notelume-plugins/ + abs_in_vault 双重防路径穿越。
#[tauri::command]
fn read_plugin(vault_root: String, plugin_rel: String) -> Result<String, String> {
    let norm = plugin_rel.replace('\\', "/");
    if !norm.starts_with(".notelume-plugins/") {
        return Err("非法路径：只能读取插件目录内的文件".into());
    }
    let abs = abs_in_vault(&vault_root, &norm)?;
    fs::read_to_string(&abs).map_err(|e| format!("读取插件失败：{}", e))
}

/// 导出 HTML 到库外任意路径；仅接受由原生保存对话框返回的绝对路径
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportArgs {
    pub abs_path: String,
    pub content: String,
}

#[tauri::command]
fn export_file(args: ExportArgs) -> Result<(), String> {
    let p = PathBuf::from(&args.abs_path);
    if let Some(parent) = p.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("创建目录失败：{}", e))?;
    }
    fs::write(&p, args.content).map_err(|e| format!("导出失败：{}", e))
}

/// 从当前索引抽取知识图谱数据：只保留已解析的链接，同一对文档合并为一条边（权重=反向两个方向链接次数之和）。
#[derive(serde::Serialize)]
struct GraphNode {
    path: String,
    title: String,
}

#[derive(serde::Serialize)]
struct GraphEdge {
    s: String,
    t: String,
    w: usize,
}

#[derive(serde::Serialize)]
struct GraphData {
    nodes: Vec<GraphNode>,
    edges: Vec<GraphEdge>,
}

fn extract_graph(index: &VaultIndex) -> GraphData {
    let mut nodes = Vec::with_capacity(index.docs.len());
    let mut sorted: Vec<&String> = index.docs.keys().collect();
    sorted.sort();
    for p in sorted {
        let d = &index.docs[p];
        nodes.push(GraphNode { path: d.path.clone(), title: d.title.clone() });
    }
    // 与 build_index 中保持同步：将链接当作库根相对 + 同目录相对两种候选。
    let root = PathBuf::from(&index.vault_root);
    // 有向边累加到无向边：(min, max) 归一化，权重为两个方向链接总次数
    let mut agg: std::collections::HashMap<(String, String), usize> = std::collections::HashMap::new();
    for (src_path, entry) in &index.docs {
        for tgt in &entry.outgoing {
            let resolved = match resolve_one(&root, "", tgt) {
                Some(r) => r,
                None => continue,
            };
            if resolved == *src_path {
                continue; // 不连自己
            }
            if !index.docs.contains_key(&resolved) {
                continue;
            }
            let key = if src_path <= &resolved {
                (src_path.clone(), resolved.clone())
            } else {
                (resolved.clone(), src_path.clone())
            };
            *agg.entry(key).or_insert(0) += 1;
        }
    }
    let mut edges: Vec<GraphEdge> = agg
        .into_iter()
        .map(|((s, t), w)| GraphEdge { s, t, w })
        .collect();
    edges.sort_by(|a, b| (&a.s, &a.t).cmp(&(&b.s, &b.t)));
    GraphData { nodes, edges }
}

#[tauri::command]
fn get_graph_data(
    vault_root: String,
    state: tauri::State<'_, IndexState>,
) -> Result<GraphData, String> {
    let _ = fs::canonicalize(&vault_root).map_err(|e| e.to_string())?;
    let guard = state.0.lock().map_err(|_| "索引状态锁 poisoned".to_string())?;
    Ok(extract_graph(&guard))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extract_wikilinks_basic() {
        let s = "see [[A]] and [[B|alias]] and nested [[C]] [[B]]";
        let mut v = extract_wikilinks(s);
        v.sort();
        v.dedup();
        assert_eq!(v, vec!["A", "B", "C"]);
    }

    #[test]
    fn extract_wikilinks_dedup_and_strip_alias() {
        // 当前实现不跳过 code block；extract_wikilinks 不去重，build_index 会 sort + dedup。
        let s = "[[B]] [[A]] [[B|alias]] [[B]]";
        let raw = extract_wikilinks(s);
        assert_eq!(raw, vec!["B", "A", "B", "B"]); // alias 取 | 前的部分
        let mut v = raw;
        v.sort();
        v.dedup();
        assert_eq!(v, vec!["A", "B"]);
    }

    #[test]
    fn extract_tags_basic_and_cjk() {
        let s = "see #hello and #世界 and inline__not_a_tag";
        let mut v = extract_tags(s);
        v.sort();
        assert_eq!(v, vec!["hello", "世界"]);
    }

    #[test]
    fn extract_graph_merges_undirected_and_skips_self() {
        // 手写一个临时库，写两个文件，验证 extract_graph 能正确拉一条无向边
        let tmp = std::env::temp_dir().join(format!("notelume-graph-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(&tmp).unwrap();
        let mut a = tmp.clone();
        a.push("a.md");
        let mut b = tmp.clone();
        b.push("b.md");
        fs::write(&a, "links to [[b]] and again [[b]]\n").unwrap();
        fs::write(&b, "links back to [[a]]\n").unwrap();
        // 直接把未规范化的 tmp 路径交给 resolve_one：内部会 canonicalize，
        // 避免在 Windows 下把 \ 先转 / 后影响 verbatim 前缀行为。
        let root_str = tmp.to_string_lossy().to_string();

        let mut index = VaultIndex::default();
        let mut docs = HashMap::new();
        let entry = |path: &str, title: &str, outgoing: Vec<&str>| DocEntry {
            path: path.into(),
            title: title.into(),
            tags: vec![],
            outgoing: outgoing.iter().map(|s| s.to_string()).collect(),
            unresolved: vec![],
            content: String::new(),
        };
        let rel_a = "a.md".to_string();
        let rel_b = "b.md".to_string();
        docs.insert(rel_a.clone(), entry(&rel_a, "a", vec!["b", "b"]));
        docs.insert(rel_b.clone(), entry(&rel_b, "b", vec!["a"]));
        index.docs = docs;
        index.vault_root = root_str.clone();
        index.ready = true;

        let g = extract_graph(&index);
        assert_eq!(g.nodes.len(), 2);
        // 无向归一：(a,b) 只一条，权重=3（a→b 两次 + b→a 一次）
        assert_eq!(g.edges.len(), 1, "expected exactly one undirected edge, got {:?}", g.edges.iter().map(|e| (&e.s, &e.t, e.w)).collect::<Vec<_>>());
        assert_eq!(g.edges[0].w, 3);
        // 无向边 key 归一化后，s <= t 字典序
        assert!(g.edges[0].s.as_str() <= g.edges[0].t.as_str());

        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn delete_file_rejects_escape_dir_and_missing() {
        let tmp = std::env::temp_dir().join(format!("notelume-del-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(&tmp).unwrap();
        fs::write(tmp.join("note.md"), "# hi\n").unwrap();
        fs::create_dir_all(tmp.join("sub")).unwrap();
        fs::write(tmp.join("sub").join("a.md"), "a").unwrap();
        let root = tmp.to_string_lossy().to_string();

        // 借 .. 越权跳出被 abs_in_vault 拒绝
        assert!(delete_file(root.clone(), "../outside.md".to_string()).is_err());
        // 目录被拒（仅允许删文件）
        assert!(delete_file(root.clone(), "sub".to_string()).is_err());
        // 不存在的文件被拒
        assert!(delete_file(root.clone(), "ghost.md".to_string()).is_err());
        // 三条拒绝均在调用回收站前就返回 Err，note.md 应仍在原处
        assert!(tmp.join("note.md").exists());
        // 注：成功路径会真的把文件移入系统回收站，为避免污染用户回收站，happy path 交由手动验证

        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn remove_doc_from_index_clears_entry_and_backlinks() {
        let mut idx = VaultIndex::default();
        idx.ready = true;
        let entry = |path: &str, outgoing: Vec<&str>| DocEntry {
            path: path.into(),
            title: path.into(),
            tags: vec![],
            outgoing: outgoing.iter().map(|s| s.to_string()).collect(),
            unresolved: vec![],
            content: String::new(),
        };
        // a -> b；b 无对外链接
        idx.docs.insert("a.md".into(), entry("a.md", vec!["b.md"]));
        idx.docs.insert("b.md".into(), entry("b.md", vec![]));
        idx.backlinks.insert("b.md".into(), vec!["a.md".into()]);
        idx.backlinks.insert("a.md".into(), vec![]);

        remove_doc_from_index(&mut idx, "a.md");
        // 自身条目移除
        assert!(!idx.docs.contains_key("a.md"));
        // a.md 写入 b.md 的反向链接贡献被清除；b.md 仍在索引
        assert_eq!(idx.backlinks.get("b.md").map(|v| v.len()), Some(0));
        assert!(idx.docs.contains_key("b.md"));
        // a.md 作为 target 的 backlinks 条目被移除
        assert!(!idx.backlinks.contains_key("a.md"));

        // 删除不存在的 path 为空操作，不应 panic
        remove_doc_from_index(&mut idx, "ghost.md");
        assert!(idx.docs.contains_key("b.md"));
    }

    #[test]
    fn create_dir_makes_dir_and_rejects_escape_and_exists() {
        let tmp = std::env::temp_dir().join(format!("notelume-mkdir-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(&tmp).unwrap();
        let root = tmp.to_string_lossy().to_string();

        // 正常新建（多层父目录自动建）
        assert!(create_dir(root.clone(), "a/b".to_string()).is_ok());
        assert!(tmp.join("a").join("b").is_dir());
        // 同名已存在 → 拒
        assert!(create_dir(root.clone(), "a".to_string()).is_err());
        // .. 越界 → 拒
        assert!(create_dir(root.clone(), "../evil".to_string()).is_err());

        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn rename_item_renames_and_rejects_escape_and_exists() {
        let tmp = std::env::temp_dir().join(format!("notelume-rename-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(&tmp).unwrap();
        fs::write(tmp.join("note.md"), "# hi\n").unwrap();
        fs::create_dir_all(tmp.join("dir")).unwrap();
        fs::write(tmp.join("dir").join("taken.md"), "x").unwrap();
        let root = tmp.to_string_lossy().to_string();

        // 重命名（同目录）
        assert!(rename_item(root.clone(), "note.md".into(), "renamed.md".into()).is_ok());
        assert!(tmp.join("renamed.md").exists() && !tmp.join("note.md").exists());
        // 移动（跨目录）
        assert!(rename_item(root.clone(), "renamed.md".into(), "dir/moved.md".into()).is_ok());
        assert!(tmp.join("dir").join("moved.md").exists());
        // 目标已存在 → 拒（不静默覆盖）
        assert!(rename_item(root.clone(), "dir/moved.md".into(), "dir/taken.md".into()).is_err());
        // to 借 .. 越界 → 拒
        assert!(rename_item(root.clone(), "dir/taken.md".into(), "../out.md".into()).is_err());
        // from 不存在 → 拒
        assert!(rename_item(root.clone(), "ghost.md".into(), "x.md".into()).is_err());

        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn read_backup_reads_inside_and_rejects_outside() {
        // 临时库：写一份 .notelume-backup/<day>/<stem>-HH-MM-SS.md 快照
        let tmp = std::env::temp_dir().join(format!("notelume-backup-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&tmp);
        let day = tmp.join(".notelume-backup").join("2026-01-01");
        fs::create_dir_all(&day).unwrap();
        fs::write(day.join("note-12-00-00.md"), "# hello snapshot\n").unwrap();
        let root_str = tmp.to_string_lossy().to_string();

        // 目录内快照可读
        let ok = read_backup(root_str.clone(), ".notelume-backup/2026-01-01/note-12-00-00.md".to_string()).unwrap();
        assert_eq!(ok, "# hello snapshot\n");

        // 非备份目录前缀被白名单拒绝
        assert!(read_backup(root_str.clone(), "secret.md".to_string()).is_err());
        // 借 .. 越权跳出被 abs_in_vault 拒绝
        assert!(read_backup(root_str.clone(), ".notelume-backup/../../escape.md".to_string()).is_err());

        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn list_and_read_plugins_only_inside_dir() {
        let tmp = std::env::temp_dir().join(format!("notelume-plugin-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&tmp);
        let dir = tmp.join(".notelume-plugins");
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("hello.js"), "export default { id: 'hello' }").unwrap();
        fs::write(dir.join("notes.txt"), "ignored").unwrap(); // 非 js 不列
        let root_str = tmp.to_string_lossy().to_string();

        let list = list_plugins(root_str.clone()).unwrap();
        assert_eq!(list.len(), 1, "只应列出 .js/.mjs");
        assert_eq!(list[0].name, "hello.js");
        assert_eq!(list[0].path, ".notelume-plugins/hello.js");

        // 目录内可读
        let src = read_plugin(root_str.clone(), ".notelume-plugins/hello.js".to_string()).unwrap();
        assert!(src.contains("hello"));
        // 目录外被白名单拒绝
        assert!(read_plugin(root_str.clone(), "secret.js".to_string()).is_err());
        assert!(read_plugin(root_str.clone(), ".notelume-plugins/../../escape.js".to_string()).is_err());

        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn read_image_data_uri_encodes_and_guards_path() {
        let tmp = std::env::temp_dir().join(format!("notelume-img-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&tmp);
        let notes = tmp.join("notes");
        fs::create_dir_all(notes.join("assets")).unwrap();
        fs::create_dir_all(tmp.join("secret")).unwrap();
        // 3 字节 -> base64 无 padding："QUJD" == "ABC"
        fs::write(notes.join("assets").join("x.png"), b"ABC").unwrap();
        fs::write(tmp.join("secret").join("s.png"), b"SECRET").unwrap();
        let root_str = tmp.to_string_lossy().to_string();

        // 相对当前 md（notes/a.md）的 ./assets/x.png → 正常编码
        let uri = read_image_data_uri(
            root_str.clone(),
            "notes/a.md".into(),
            "./assets/x.png".into(),
        )
        .unwrap();
        assert_eq!(uri, "data:image/png;base64,QUJD");

        // 库内 .. 跳转（从 notes 上跳到 secret）允许，但仍在库内
        let up = read_image_data_uri(
            root_str.clone(),
            "notes/a.md".into(),
            "../secret/s.png".into(),
        );
        assert!(up.is_ok(), "库内 .. 应允许：{:?}", up);

        // 逸出库根被 ensure_inside_root 拒绝
        let esc = read_image_data_uri(
            root_str.clone(),
            "notes/a.md".into(),
            "../../../../Windows/win.ini".into(),
        );
        assert!(esc.is_err());

        // 非图片扩展名拒绝
        fs::write(notes.join("assets").join("x.txt"), b"hi").unwrap();
        assert!(read_image_data_uri(root_str.clone(), "notes/a.md".into(), "./assets/x.txt".into()).is_err());

        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn read_image_data_uri_percent_decodes_space() {
        let tmp = std::env::temp_dir().join(format!("notelume-imgspace-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&tmp);
        let dir = tmp.join("图片和附件");
        fs::create_dir_all(&dir).unwrap();
        // 磁盘真实名含空格，md 里引用为 %20
        fs::write(dir.join("image 1.png"), b"ABC").unwrap();
        let root_str = tmp.to_string_lossy().to_string();

        let uri = read_image_data_uri(
            root_str.clone(),
            "doc/a.md".into(),
            "../图片和附件/image%201.png".into(),
        )
        .unwrap();
        assert_eq!(uri, "data:image/png;base64,QUJD");

        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn scan_includes_canvas_but_not_other_types() {
        let tmp = std::env::temp_dir().join(format!("notelume-scan-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(&tmp).unwrap();
        fs::write(tmp.join("a.md"), "# A").unwrap();
        fs::write(tmp.join("board.canvas"), r#"{"nodes":[],"edges":[]}"#).unwrap();
        fs::write(tmp.join("notes.txt"), "ignored").unwrap();
        fs::write(tmp.join("pic.png"), b"x").unwrap();
        let root_str = tmp.to_string_lossy().to_string();

        let tree = scan_vault(root_str.clone()).unwrap();
        let names: Vec<String> = tree.into_iter().map(|n| n.name).collect();
        assert!(names.contains(&"a.md".to_string()));
        assert!(names.contains(&"board.canvas".to_string()), "canvas 应入树");
        assert!(!names.contains(&"notes.txt".to_string()));
        assert!(!names.contains(&"pic.png".to_string()));

        let _ = fs::remove_dir_all(&tmp);
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(IndexState(Arc::new(Mutex::new(VaultIndex::default()))))
        .invoke_handler(tauri::generate_handler![
            // P0
            scan_vault,
            read_md_file,
            write_md_file,
            resolve_wiki_link,
            create_md_file,
            delete_file,
            create_dir,
            rename_item,
            copy_image_asset,
            save_image_bytes,
            read_image_data_uri,
            // P1
            rebuild_index,
            get_index_status,
            query_backlinks,
            query_outgoing,
            get_doc_info,
            search_vault,
            doc_preview,
            update_index_doc,
            remove_index_doc,
            backup_write,
            list_backups,
            read_backup,
            list_plugins,
            read_plugin,
            export_file,
            get_graph_data
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
