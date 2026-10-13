use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

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
const SKIP_DIRS: &[&str] = &["node_modules", "target", "dist", ".git", ".obsidian", ".trash"];
/// 图片复制支持（白名单，防止任意文件混入 assets）
const IMG_EXTS: &[&str] = &["png", "jpg", "jpeg", "gif", "svg", "webp", "bmp", "ico", "avif"];

/// 判断是否为参与知识库的 Markdown 文件
fn is_md(name: &str) -> bool {
    name.to_ascii_lowercase().ends_with(".md")
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

/// 递归扫描目录树：仅收集 md 文件与文件夹，同层“文件夹在前、按名称排序”
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
        } else if path.is_file() && is_md(&name) {
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
    let link = name.trim();
    if link.is_empty() {
        return Err("空链接".into());
    }
    // 1) 路径样式（含 / 或 ../，或带 .md 后缀）：相对当前文档解析
    if link.contains('/') || link.starts_with("..") || link.to_ascii_lowercase().ends_with(".md") {
        let rel = normalize_target(&ref_rel, link);
        let cand = normalize_target("", &rel) + if rel.to_ascii_lowercase().ends_with(".md") { "" } else { ".md" };
        let cand = if cand.to_ascii_lowercase().ends_with(".md") { cand } else { format!("{}.md", cand) };
        if root.join(&cand).exists() {
            return Ok(WikiResolve { exists: true, path: Some(cand) });
        }
    }
    // 2) 按文件名（去 .md 后缀）全库查找
    let stem = link.rsplit_once('.').filter(|_| is_md(link)).map_or(link, |(s, _)| s).to_string();
    if let Some(rel) = find_md_by_basename(&root, &stem, 0) {
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
/// `path` 来自拖拽（Tauri 为 File 对象注入了绝对路径）。
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

    // 防重名：若同名已存在且内容不同，追加内容哈希
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
    // 复用 copy 逻辑：直接写入 assets 目录
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            scan_vault,
            read_md_file,
            write_md_file,
            resolve_wiki_link,
            create_md_file,
            copy_image_asset,
            save_image_bytes
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
