use chrono::Local;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Component, Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::thread;

// mac 回收站走 NSFileManager 而非 Finder AppleScript，见 delete_file
#[cfg(target_os = "macos")]
use trash::macos::TrashContextExtMacos;

// 批次 E · 子项目 R1-B：内置远程（libgit2）后端。Phase 1 先挂纯逻辑与结构体；
// Phase 3 会在同文件补 fetch/upstream/ahead_behind/pull_ff 实现。
mod git_builtin;

// 功能项 I：Word(.docx) → Markdown 离线导入引擎（纯 Rust OOXML 解析 + 映射 + 图片去重落盘）。
mod docx_import;

// 批次 F ①：Markdown → Word(.docx) 结构导出（前端产 Docx-IR，本模块用 docx-rs 组装 OOXML 落盘）。
mod docx_export;

// 界面多语言：后端用户可见文案（命令错误 / docx 警告 / git 结果 / 托盘菜单）按当前界面语言取词。
// 词表与五种语言见 ui_lang.rs；前端启动与切换语言时调 set_ui_lang 上报。
mod ui_lang;

// 网页剪藏：本地 HTTP 服务 + 载荷落盘（模板渲染 / 图片 / 自动关联）。
mod webclip;

// 文件系统监听：检测外部对库文件的增删改，自动刷新树。
mod fs_watcher;

// Quarkdown 引擎（JS + Rust 重写）：源 Markdown → 求值展开后的 Markdown + 诊断。
// 设计与分期见 docs/superpowers/specs/2026-10-25-quarkdown-engine-design.md。
mod qd;

/// qd_eval 的返回：展开文本 + 诊断（camelCase 对前端）
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QdDiagnostic {
    pub line: u32,
    pub message: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QdOutcome {
    pub expanded: String,
    pub diagnostics: Vec<QdDiagnostic>,
}

/// Quarkdown 求值：源 md → 展开后的 md。求值失败点自动降级为原文并进诊断，命令本身不失败。
/// doc_dir = 文档所在目录（绝对路径）：Data 模块文件类函数相对它解析；None 时 IO 函数诊断降级。
/// libs_dir = 可加载库目录（库根 Libraries/）：include {名} 按文件名 stem 加载 .qd 库。
/// 包缓存目录由本命令从应用配置目录解析（qd-packages/），前端不用传。
#[tauri::command]
fn qd_eval(app: tauri::AppHandle, md: String, doc_dir: Option<String>, libs_dir: Option<String>) -> QdOutcome {
    let packages_dir = qd_packages_dir(&app).ok();
    let blocks = qd::parser::parse_document(&md);
    let (expanded, diags) = qd::eval::eval_document_with(
        &blocks,
        qd::stdlib::builtins(),
        doc_dir.map(std::path::PathBuf::from),
        libs_dir.map(std::path::PathBuf::from),
        packages_dir,
    );
    QdOutcome {
        expanded,
        diagnostics: diags
            .into_iter()
            .map(|d| QdDiagnostic { line: d.line, message: d.message })
            .collect(),
    }
}

/// 包缓存根：应用配置目录下 qd-packages/（与 settings.json 同级）
fn qd_packages_dir(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    use tauri::Manager;
    app.path()
        .app_config_dir()
        .map(|d| d.join("qd-packages"))
        .map_err(|e| format!("定位应用配置目录失败：{e}"))
}

/// 包引用 `@scope/name[:version]` 解析（版本判定与 qd::ecosystem 的 include 同一规则）。
/// 装包这一步允许省掉版本，省掉时按注册表目录取最高版本（见 qd_registry_versions）。
fn parse_pkg_ref(reference: &str) -> Result<(String, String, Option<String>), String> {
    let body = reference.trim().strip_prefix('@').ok_or("包引用以 @ 开头：@scope/name[:version]")?;
    let (scope, rest) = body.split_once('/').ok_or("包引用格式：@scope/name[:version]")?;
    let (name, version) = match rest.split_once(':') {
        Some((n, v)) => (n.trim(), Some(v.trim())),
        None => (rest.trim(), None),
    };
    let scope = scope.trim();
    if scope.is_empty() || name.is_empty() {
        return Err(format!("包引用 {} 缺 scope 或包名，形态是 @atoms/包名[:版本]", reference.trim()));
    }
    if let Some(v) = version {
        if v.is_empty() {
            return Err(format!("包引用 {} 写了冒号却没给版本；要省掉版本就连冒号一起去掉", reference.trim()));
        }
    }
    for part in [name].into_iter().chain(version) {
        if part.contains("..") || part.contains('\\') || part.contains('/') {
            return Err(format!("包引用段不合法：{part}"));
        }
        // 这两段直接拼进注册表 URL，只吃文件名里安全的那批字符
        if !part.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.')) {
            return Err(format!("包引用的 name / version 只能含字母、数字与 - _ .：{part}"));
        }
    }
    Ok((scope.into(), name.into(), version.map(Into::into)))
}

/// atoms 源（GitHub 仓库 quarkdown-labs/atoms）按 `name/version/` 目录组织，没有 latest
/// 通道：省略版本时列该包目录，把版本目录名当版本号，取最高。
fn qd_registry_versions(name: &str) -> Result<Vec<String>, String> {
    const API: &str = "https://api.github.com/repos/quarkdown-labs/atoms/contents/";
    let tmp = std::env::temp_dir().join(format!("nl-qd-versions-{}.json", std::process::id()));
    let text = download_remote(&format!("{API}{name}"), &tmp)
        .and_then(|()| fs::read_to_string(&tmp).map_err(|e| e.to_string()))
        .map_err(|e| format!("列注册表版本失败：{e}"));
    let _ = fs::remove_file(&tmp);
    let text = text?;
    let json: serde_json::Value = serde_json::from_str(&text).map_err(|e| format!("注册表版本清单解析失败：{e}"))?;
    let entries = json.as_array().ok_or_else(|| {
        let msg = json.get("message").and_then(|m| m.as_str()).unwrap_or("返回的不是目录清单");
        format!("注册表里查不到 @atoms/{name}：{msg}")
    })?;
    Ok(entries
        .iter()
        .filter(|e| e.get("type").and_then(|t| t.as_str()) == Some("dir"))
        .filter_map(|e| e.get("name").and_then(|n| n.as_str()).map(str::to_string))
        .collect())
}

/// 版本号比较：按 `.` 分段，两段都是数字就按数值比（1.10 > 1.9），否则按字面比；
/// 前缀相同时段数多的更大（1.0.1 > 1.0）。
fn qd_version_cmp(a: &str, b: &str) -> std::cmp::Ordering {
    let (pa, pb) = (a.split('.'), b.split('.'));
    for (x, y) in pa.zip(pb) {
        let ord = match (x.parse::<u64>(), y.parse::<u64>()) {
            (Ok(nx), Ok(ny)) => nx.cmp(&ny),
            _ => x.cmp(y),
        };
        if ord != std::cmp::Ordering::Equal {
            return ord;
        }
    }
    a.matches('.').count().cmp(&b.matches('.').count())
}

/// 显式安装 Quarkdown 包：从 atoms 源拉所选版本的 atom.toml 与 entrypoint 落进本地缓存。
/// include {@scope/name:version} 只读这份缓存——文档求值不触发下载，安装只能是用户的
/// 显式动作（命令面板「安装 Quarkdown 包…」）。返回可直接粘进文档的包引用。
#[tauri::command]
fn qd_package_install(app: tauri::AppHandle, reference: String) -> Result<String, String> {
    const REGISTRY: &str = "https://raw.githubusercontent.com/quarkdown-labs/atoms/main/";
    let (scope, name, wanted) = parse_pkg_ref(&reference)?;
    if scope != "atoms" {
        return Err(format!("只支持 atoms 包源，不支持 @{scope}"));
    }
    let dir_version = match wanted {
        Some(v) => v,
        None => qd_registry_versions(&name)?
            .into_iter()
            .max_by(|a, b| qd_version_cmp(a, b))
            .ok_or_else(|| format!("注册表里 @atoms/{name} 没有任何版本目录"))?,
    };
    let root = qd_packages_dir(&app)?;
    fs::create_dir_all(&root).map_err(|e| format!("创建包缓存目录失败：{e}"))?;
    // 清单先落临时文件：入口文件名与真实版本号都从清单读（不猜 main.qd，也不猜目录名）
    let tmp = root.join(format!(".download-{}", std::process::id()));
    let base = format!("{REGISTRY}{name}/{dir_version}/");
    let fetch = |url: &str, dest: &std::path::Path| -> Result<(), String> {
        download_remote(url, dest).map_err(|e| format!("下载失败 {url}：{e}"))
    };
    if let Err(e) = fetch(&format!("{base}atom.toml"), &tmp) {
        let _ = fs::remove_file(&tmp);
        return Err(e);
    }
    let manifest = fs::read_to_string(&tmp).map_err(|e| format!("读取 atom.toml 失败：{e}"))?;
    let _ = fs::remove_file(&tmp);
    // 缓存目录按清单声明的版本建：include 引用的就是这个版本号，不是目录名
    let version = qd::ecosystem::parse_atom_version(&manifest)?;
    if version.contains("..") || version.contains('/') || version.contains('\\') {
        return Err(format!("包清单里的版本不合法：{version}"));
    }
    let cache = root.join(&name).join(&version);
    let entry = qd::ecosystem::parse_atom_entrypoint(&manifest)?;
    if entry.contains("..") || entry.contains('\\') || entry.starts_with('/') {
        return Err(format!("包入口不合法：{entry}"));
    }
    let entry_path = cache.join(&entry);
    if let Some(parent) = entry_path.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("创建包目录失败：{e}"))?;
    }
    fetch(&format!("{base}{entry}"), &entry_path)?;
    // 清单留档（include 侧读的就是这份）
    fs::write(cache.join("atom.toml"), &manifest).map_err(|e| format!("写入 atom.toml 失败：{e}"))?;
    Ok(format!("@{scope}/{name}:{version}"))
}

// Phase 2：R1 的 Remote/AheadBehind/RemoteArgs 契约型 + 两种后端实现已搬进 git_builtin；
// 本文件仅保留 `#[tauri::command]` 壳与引擎分派。类型仍以 crate 根的名字对前端可见。
pub use git_builtin::{
    AheadBehind, CommitMergeArgs, GitSyncInfo, Remote, RemoteArgs, ResolveArgs, TrustHostArgs,
};

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

/// 图片附件（与 IMG_EXTS 白名单一致）：进文件树供单独查看，但不进索引
fn is_image(name: &str) -> bool {
    let lower = name.to_ascii_lowercase();
    IMG_EXTS.iter().any(|e| lower.ends_with(&format!(".{}", e)))
}

/// 拒绝越出库根的恶意路径（`..` 逃逸等）；root 与 target 均已 canonicalize
fn ensure_inside_root(root: &Path, target: &Path) -> Result<PathBuf, String> {
    // 文件不存在单独成一句：库外删掉 / 移走的文档，界面只该看到「文件已不存在」，
    // 不是 canonicalize 的 `No such file or directory (os error 2)`。
    let resolved = fs::canonicalize(target).map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            ui_msg!("fileNotFound", "path" => target.display())
        } else {
            ui_msg!("pathResolveFailed", "path" => target.display(), "err" => e)
        }
    })?;
    if resolved.starts_with(root) {
        Ok(resolved)
    } else {
        Err(ui_msg!("pathOutsideVault"))
    }
}

/// 库内相对路径（`/` 分隔）-> 绝对路径；要求所在目录已存在
pub(crate) fn abs_in_vault(vault_root: &str, rel: &str) -> Result<PathBuf, String> {
    let root = fs::canonicalize(vault_root).map_err(|e| e.to_string())?;
    let mut p = root.clone();
    for seg in rel.split('/').filter(|s| !s.is_empty()) {
        if seg == ".." {
            return Err(ui_msg!("pathEscapeVault"));
        }
        p.push(seg);
    }
    ensure_inside_root(&root, &p)
}

/// 库内相对路径（`/` 分隔）-> 绝对路径，纯词法拼接（不要求已存在），拒绝 `..` 跳出。
/// 用于新建文件/文件夹/重命名目标等「路径尚未存在」的场景；存在性/越界由调用方另行校验。
pub(crate) fn vault_join(root: &Path, rel: &str) -> Result<PathBuf, String> {
    let mut p = root.to_path_buf();
    for seg in rel.split('/').filter(|s| !s.is_empty()) {
        if seg == ".." {
            return Err(ui_msg!("pathEscapeVault"));
        }
        p.push(seg);
    }
    Ok(p)
}

/// 递归扫描目录树：收集 md / canvas / 图片文件与文件夹，同层"文件夹在前、按名称排序"
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
        } else if path.is_file() && (is_md(&name) || is_canvas(&name) || is_image(&name)) {
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
    let root = fs::canonicalize(&vault_root).map_err(|e| ui_msg!("vaultPathInvalid", "err" => e))?;
    if !root.is_dir() {
        return Err(ui_msg!("vaultNotDir"));
    }
    Ok(scan_dir(&root, "", 0))
}

/// 读取库内 md 文件
#[tauri::command]
fn read_md_file(vault_root: String, path: String) -> Result<String, String> {
    let abs = abs_in_vault(&vault_root, &path)?;
    fs::read_to_string(&abs).map_err(|e| ui_msg!("readFailed", "err" => e))
}

/// 写回库内 md 文件（UTF-8，标准 GFM，不引入任何私有格式）
#[tauri::command]
fn write_md_file(vault_root: String, path: String, content: String) -> Result<(), String> {
    let root = fs::canonicalize(&vault_root).map_err(|e| e.to_string())?;
    let mut abs = root.clone();
    for seg in path.split('/').filter(|s| !s.is_empty()) {
        if seg == ".." {
            return Err(ui_msg!("pathEscapeVault"));
        }
        abs.push(seg);
    }
    if let Some(parent) = abs.parent() {
        fs::create_dir_all(parent).map_err(|e| ui_msg!("createDirFailed", "err" => e))?;
    }
    // 越界校验：文件路径的父目录必须位于库根内
    let parent = fs::canonicalize(abs.parent().ok_or_else(|| ui_msg!("badFilePath"))?)
        .map_err(|e| e.to_string())?;
    if !parent.starts_with(&root) {
        return Err(ui_msg!("pathOutsideVault"));
    }
    // 文案带相对路径：库里改错哪个文件一眼可辨（QA GU-007/008：错误里没有文件名）
    fs::write(&abs, content).map_err(|e| ui_msg!("saveFailed", "path" => path, "err" => e))
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
        // 符号链接一律不进：库里的 dmg 暂存目录会链到 /Applications，跟进去等于把库外整棵树
        // 拖进扫描，且每条解析不掉的链接都要再走一遍（file_type 不跟随链接）
        let ft = match entry.file_type() {
            Ok(t) => t,
            Err(_) => continue,
        };
        if ft.is_symlink() {
            continue;
        }
        let path = entry.path();
        if ft.is_dir() {
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
        return Err(ui_msg!("emptyFileName"));
    }
    if !rel.to_ascii_lowercase().ends_with(".md") {
        rel.push_str(".md");
    }
    write_md_file(vault_root, rel.clone(), args.content)?;
    Ok(rel)
}

/// 回收站报错取人可读的那一段。`trash::Error` 的 Display 就是 Debug，直接抛给界面会连着
/// `Os { code, description }` 的外壳一起显示。
fn trash_err(e: trash::Error) -> String {
    match e {
        trash::Error::Os { description, .. } | trash::Error::Unknown { description } => description,
        trash::Error::CouldNotAccess { target } => target,
        other => other.to_string(),
    }
}

/// 把库内单个文件（md / canvas）移入系统回收站：路径经 abs_in_vault 限定库内，拒绝目录与越界。
///
/// mac 上显式选 `NsFileManager`：crate 默认的 `Finder` 方式是 fork `osascript` 让 Finder
/// 执行 AppleScript，未获「Apple 事件」授权就报 -1743。`trashItemAtURL` 是系统调用，
/// 不需要额外授权，代价是没有 Finder 的删除音，部分系统回收站条目右键少了「放回原处」。
#[tauri::command]
fn delete_file(vault_root: String, path: String) -> Result<(), String> {
    let abs = abs_in_vault(&vault_root, &path)?;
    // 目录也走回收站（trash crate 全平台支持目录）；此前拒删目录，界面上连删除入口都没有
    #[cfg_attr(not(target_os = "macos"), allow(unused_mut))] // 非 mac 没有可选的通道
    let mut ctx = trash::TrashContext::new();
    #[cfg(target_os = "macos")]
    ctx.set_delete_method(trash::macos::DeleteMethod::NsFileManager);
    ctx.delete(&abs)
        .map_err(|e| ui_msg!("trashFailed", "err" => trash_err(e)))?;
    Ok(())
}

/// 新建文件夹：路径限库内（父目录建后校验在根内），拒绝 `..` 越界、拒绝已存在。
#[tauri::command]
fn create_dir(vault_root: String, path: String) -> Result<(), String> {
    let root = fs::canonicalize(&vault_root).map_err(|e| e.to_string())?;
    let rel = path.trim().replace('\\', "/");
    if rel.is_empty() {
        return Err(ui_msg!("emptyFolderName"));
    }
    let abs = vault_join(&root, &rel)?;
    if abs.exists() {
        return Err(ui_msg!("targetExists"));
    }
    let parent = abs.parent().ok_or_else(|| ui_msg!("badPath"))?;
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let pc = fs::canonicalize(parent).map_err(|e| e.to_string())?;
    if !pc.starts_with(&root) {
        return Err(ui_msg!("pathOutsideVault"));
    }
    fs::create_dir(&abs).map_err(|e| ui_msg!("createDirFailed", "err" => e))?;
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
        return Err(ui_msg!("newNameEmpty"));
    }
    let abs_to = vault_join(&root, &rel_to)?;
    if abs_to.exists() {
        return Err(ui_msg!("renameExists"));
    }
    let parent = abs_to.parent().ok_or_else(|| ui_msg!("badPath"))?;
    let pc = fs::canonicalize(parent).map_err(|e| ui_msg!("targetDirMissing", "err" => e))?;
    if !pc.starts_with(&root) {
        return Err(ui_msg!("pathOutsideVault"));
    }
    // 不允许把文件夹移动到它自身或自己的子目录下
    if abs_from.is_dir() && abs_to.starts_with(&abs_from) {
        return Err(ui_msg!("moveIntoSelf"));
    }
    fs::rename(&abs_from, &abs_to).map_err(|e| ui_msg!("renameFailed", "err" => e))?;
    Ok(())
}

/// 基础64 解码（容忍空白，遇 `=` 截断）：用于外部拖入文件的字节回写
pub(crate) fn b64_decode(input: &str) -> Result<Vec<u8>, String> {
    const TBL: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let clean: String = input.chars().filter(|c| !c.is_whitespace()).collect();
    let mut out: Vec<u8> = Vec::with_capacity(clean.len() * 3 / 4);
    let mut buf: u32 = 0;
    let mut bits: u32 = 0;
    for ch in clean.chars() {
        if ch == '=' {
            break;
        }
        let v = TBL.iter().position(|c| *c as char == ch).ok_or(ui_msg!("badBase64"))? as u32;
        buf = (buf << 6) | v;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((buf >> bits) as u8);
        }
    }
    Ok(out)
}

/// 从外部（系统拖入）导入一个文件到库内目录：dest_dir 限库内（不存在则创建），
/// name 只取末段文件名（去除任何目录成分），同名不同内容时按内容指纹重命名，返回库内相对路径。
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportArgs {
    pub dest_dir_rel: String,
    pub name: String,
    pub data_base64: String,
}

#[tauri::command]
fn import_vault_file(vault_root: String, args: ImportArgs) -> Result<String, String> {
    let root = fs::canonicalize(&vault_root).map_err(|e| e.to_string())?;
    let ndir = args.dest_dir_rel.trim().replace('\\', "/").trim_matches('/').to_string();
    let abs_dir = vault_join(&root, &ndir)?;
    fs::create_dir_all(&abs_dir).map_err(|e| e.to_string())?;
    let dc = fs::canonicalize(&abs_dir).map_err(|e| e.to_string())?;
    if !dc.starts_with(&root) {
        return Err(ui_msg!("pathOutsideVault"));
    }
    let base = args.name.rsplit(|c| c == '/' || c == '\\').next().unwrap_or("").trim().to_string();
    if base.is_empty() || base == "." || base == ".." {
        return Err(ui_msg!("badImportFileName"));
    }
    let bytes = b64_decode(&args.data_base64)?;
    let stem = base.rsplit_once('.').map_or(base.as_str(), |(s, _)| s).to_string();
    let ext = base.rsplit_once('.').map(|(_, e)| e.to_ascii_lowercase()).unwrap_or_default();
    let mut file_name = base.clone();
    let mut dest = dc.join(&file_name);
    if dest.exists() {
        let same = fs::read(&dest).map(|o| o == bytes).unwrap_or(false);
        if !same {
            file_name = if ext.is_empty() {
                format!("{}-{:x}", stem, fnv1a(&bytes))
            } else {
                format!("{}-{:x}.{}", stem, fnv1a(&bytes), ext)
            };
            dest = dc.join(&file_name);
        }
    }
    if !dest.exists() {
        fs::write(&dest, &bytes).map_err(|e| ui_msg!("importFailed", "err" => e))?;
    }
    let rel = if ndir.is_empty() { file_name } else { format!("{}/{}", ndir, file_name) };
    Ok(rel)
}

/// 系统拖入的路径探测：mac 打包版留着 wry 的窗口拖放拦截，HTML5 的 dragover / drop 收不到，
/// 原生事件只给绝对路径。这里补回「名字 / 是否目录」，前端据此决定开文档还是另开窗口。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalDrop {
    pub name: String,
    pub is_dir: bool,
}

#[tauri::command]
fn probe_external_drop(path: String) -> Result<ExternalDrop, String> {
    let p = PathBuf::from(&path);
    let meta = fs::metadata(&p).map_err(|e| e.to_string())?;
    let name = p
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_string();
    Ok(ExternalDrop { name, is_dir: meta.is_dir() })
}

/// FNV-1a 64 位哈希：用于图片内容去重（同名不同内容时追加内容指纹）
pub(crate) fn fnv1a(bytes: &[u8]) -> u64 {
    let mut h: u64 = 0xcbf2_9ce4_8422_2325;
    for b in bytes {
        h ^= *b as u64;
        h = h.wrapping_mul(0x1000_0000_01b3);
    }
    h
}

/// 魔数嗅探：内容是否为常见图片格式（PNG / JPEG / GIF / WebP / BMP / ICO / SVG）。
/// 只挡「根本不是图片」的文件（扩展名叫 .png 的文本 / 二进制垃圾，QA GU-027 的 fake.png），
/// 不校验完整性——截断的真图仍放行，读取端自有降级。
fn looks_like_image(bytes: &[u8]) -> bool {
    if bytes.starts_with(&[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]) {
        return true; // PNG
    }
    if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        return true; // JPEG
    }
    if bytes.len() >= 6 && (&bytes[..6] == b"GIF87a" || &bytes[..6] == b"GIF89a") {
        return true; // GIF
    }
    if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        return true; // WebP
    }
    if bytes.starts_with(b"BM") {
        return true; // BMP
    }
    if bytes.len() >= 4 && &bytes[..4] == [0x00, 0x00, 0x01, 0x00] {
        return true; // ICO
    }
    // SVG 是文本：剥 BOM 与行首空白后以 <svg 开头，或 <?xml 声明后跟着 <svg
    let body = bytes.strip_prefix([0xEF, 0xBB, 0xBF].as_slice()).unwrap_or(bytes);
    let text = String::from_utf8_lossy(body);
    let text = text.trim_start();
    text.starts_with("<svg") || (text.starts_with("<?xml") && text.contains("<svg"))
}

/// 把库外图片拷入该文档同级的 assets/ 目录，返回可直接写入 md 的相对链接。
#[tauri::command]
fn copy_image_asset(vault_root: String, md_rel: String, path: String) -> Result<String, String> {
    let src = PathBuf::from(&path);
    if !src.exists() {
        return Err(ui_msg!("srcNotExists", "path" => path));
    }
    let name = src.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
    let ext = src.extension().map(|e| e.to_string_lossy().to_lowercase()).unwrap_or_default();
    if !IMG_EXTS.contains(&ext.as_str()) {
        return Err(ui_msg!("unsupportedImgType", "ext" => ext));
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

    let bytes = fs::read(&src).map_err(|e| ui_msg!("readImgFailed", "err" => e))?;
    // 内容校验在写盘前：扩展名骗得过 IMG_EXTS，骗不过魔数
    if !looks_like_image(&bytes) {
        return Err(ui_msg!("imgNotImage", "path" => name));
    }
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
        fs::copy(&src, &dest).map_err(|e| ui_msg!("copyImgFailed", "err" => e))?;
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
        return Err(ui_msg!("unsupportedImgType", "ext" => ext));
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
        let v = table.iter().position(|c| *c == ch).ok_or(ui_msg!("badBase64"))? as u32;
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
    fs::write(assets_dir.join(&file_name), &buf).map_err(|e| ui_msg!("writeImgFailed", "err" => e))?;
    Ok(format!("./assets/{}", file_name))
}

/// 手写 base64 编码（项目不引入 base64 crate；与 save_image_bytes 里的手写解码对称）
pub(crate) fn b64_encode(data: &[u8]) -> String {
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
pub(crate) fn percent_decode(s: &str) -> String {
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

/// 库内按文件名（不区分大小写）递归查找一个文件，返回绝对路径。
/// 用于 Obsidian 裸文件名 / 最短路径嵌入（如 `![[Pasted image xxx.PNG]]`）的默认回退解析：
/// 先浅后深（逐层扫完当前目录文件再下钻），靠近库根的优先命中。
fn find_asset_by_name(dir: &Path, name: &str, depth: usize) -> Option<PathBuf> {
    if depth > 12 {
        return None;
    }
    let entries = fs::read_dir(dir).ok()?;
    let mut subdirs = Vec::new();
    for e in entries.flatten() {
        let fname = e.file_name().to_string_lossy().to_string();
        if fname.starts_with('.') {
            continue;
        }
        let p = e.path();
        if p.is_dir() {
            if SKIP_DIRS.contains(&fname.as_str()) {
                continue;
            }
            subdirs.push(p);
        } else if fname.eq_ignore_ascii_case(name) {
            return Some(p);
        }
    }
    for d in subdirs {
        if let Some(found) = find_asset_by_name(&d, name, depth + 1) {
            return Some(found);
        }
    }
    None
}

/// 读图片字节并返回 data: URL（供前端 <img> 直接显示，绕开 asset 协议 scope/跨域问题）。
#[tauri::command]
fn read_image_data_uri(vault_root: String, md_rel: String, src: String) -> Result<String, String> {
    // 先按常规解析（相对当前 md / 绝对路径）；失败则按文件名在库内回退查找（Obsidian 嵌入）。
    let abs = match resolve_media_abs(&vault_root, &md_rel, &src) {
        Ok(a) => a,
        Err(_) => {
            let decoded = percent_decode(&src);
            let base = decoded.rsplit(['/', '\\']).next().unwrap_or(&decoded);
            let root = fs::canonicalize(&vault_root).map_err(|e| e.to_string())?;
            find_asset_by_name(&root, base, 0)
                .ok_or_else(|| ui_msg!("imgNotFound", "src" => src))?
        }
    };
    let ext = abs
        .extension()
        .map(|e| e.to_string_lossy().to_lowercase())
        .unwrap_or_default();
    if !IMG_EXTS.contains(&ext.as_str()) {
        return Err(ui_msg!("unsupportedImgType", "ext" => ext));
    }
    let bytes = fs::read(&abs).map_err(|e| ui_msg!("readImgFailed", "err" => e))?;
    Ok(format!("data:{};base64,{}", mime_for_ext(&ext), b64_encode(&bytes)))
}

/// 按字节魔数嗅图片 MIME，扩展名兜底（远程图 URL 可能不带扩展名）。
pub(crate) fn sniff_image_mime(bytes: &[u8], url: &str) -> Option<&'static str> {
    if bytes.starts_with(&[0x89, b'P', b'N', b'G']) {
        return Some("image/png");
    }
    if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        return Some("image/jpeg");
    }
    if bytes.starts_with(b"GIF8") {
        return Some("image/gif");
    }
    if bytes.len() > 12 && bytes[0..4] == *b"RIFF" && bytes[8..12] == *b"WEBP" {
        return Some("image/webp");
    }
    if bytes.starts_with(b"BM") {
        return Some("image/bmp");
    }
    let head = String::from_utf8_lossy(&bytes[..bytes.len().min(256)]);
    let trimmed = head.trim_start();
    if trimmed.starts_with("<svg") || trimmed.starts_with("<?xml") {
        return Some("image/svg+xml");
    }
    let ext = url
        .split(['?', '#'])
        .next()?
        .rsplit('.')
        .next()?
        .to_lowercase();
    match mime_for_ext(&ext) {
        "application/octet-stream" => None,
        m => Some(m),
    }
}

/// 远程图取字节回 data: URL（图片右键「复制图像 / 另存为」共用）。下载走各平台的系统网络栈
/// （Windows 用 URLDownloadToFileW，其余平台用系统 curl）：不引 TLS 依赖、请求不带 Referer
/// （Gitee 等图床的防盗链对 localhost Referer 直接 403，无 Referer 反而放行）。
#[tauri::command]
fn fetch_remote_image_data_uri(url: String) -> Result<String, String> {
    let lower = url.to_lowercase();
    if !(lower.starts_with("http://") || lower.starts_with("https://")) {
        return Err(ui_msg!("unsupportedImgType", "ext" => "url"));
    }
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let tmp = std::env::temp_dir().join(format!("notelume-img-{}.part", stamp));
    let _ = fs::remove_file(&tmp); // 同毫秒残留兜底
    let res = (|| -> Result<String, String> {
        download_remote(&url, &tmp)?;
        let meta = fs::metadata(&tmp).map_err(|e| ui_msg!("readImgFailed", "err" => e))?;
        if meta.len() > 32 * 1024 * 1024 {
            return Err(ui_msg!("readImgFailed", "err" => "image > 32MB"));
        }
        let bytes = fs::read(&tmp).map_err(|e| ui_msg!("readImgFailed", "err" => e))?;
        let mime = sniff_image_mime(&bytes, &url)
            .ok_or_else(|| ui_msg!("unsupportedImgType", "ext" => "bytes"))?;
        Ok(format!("data:{};base64,{}", mime, b64_encode(&bytes)))
    })();
    let _ = fs::remove_file(&tmp); // 临时文件无论如何清掉
    res
}

#[cfg(windows)]
pub(crate) fn download_remote(url: &str, dest: &std::path::Path) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    #[link(name = "urlmon")]
    extern "system" {
        fn URLDownloadToFileW(
            pcaller: *mut core::ffi::c_void,
            szurl: *const u16,
            szfilename: *const u16,
            dwreserved: u32,
            lpfncb: *mut core::ffi::c_void,
        ) -> i32;
    }
    let wurl: Vec<u16> = url.encode_utf16().chain([0]).collect();
    let wdest: Vec<u16> = dest.as_os_str().encode_wide().chain([0]).collect();
    let hr = unsafe {
        URLDownloadToFileW(
            std::ptr::null_mut(),
            wurl.as_ptr(),
            wdest.as_ptr(),
            0,
            std::ptr::null_mut(),
        )
    };
    if hr == 0 {
        Ok(())
    } else {
        Err(ui_msg!("downloadImgFailed", "code" => format!("0x{:08X}", hr as u32)))
    }
}

/// 非 Windows：走系统 curl（macOS 与主流 Linux 均预装），同样不引 TLS 依赖、不带 Referer。
/// `--url` 收值，避免以 `-` 开头的地址被当成选项。
#[cfg(not(windows))]
fn download_remote(url: &str, dest: &std::path::Path) -> Result<(), String> {
    let out = std::process::Command::new("curl")
        .arg("--fail")
        .arg("--silent")
        .arg("--show-error")
        .arg("--location")
        .arg("--max-time")
        .arg("30")
        .arg("--output")
        .arg(dest)
        .arg("--url")
        .arg(url)
        .output()
        .map_err(|e| ui_msg!("downloadImgFailed", "code" => e))?;
    if out.status.success() {
        return Ok(())
    }
    let err = String::from_utf8_lossy(&out.stderr).trim().to_string();
    Err(ui_msg!("downloadImgFailed", "code" => if err.is_empty() { format!("curl {}", out.status) } else { err }))
}

/// 拖放落点判定（Windows / Linux 的 Tauri drag-drop 事件只给路径不给类型）：
/// 判断拖入路径是否目录，前端按 isDir 分流打开文件夹还是打开文件。
#[tauri::command]
fn drop_path_is_dir(path: String) -> bool {
    std::path::Path::new(&path).is_dir()
}

/// 用系统默认浏览器打开站外链接（「关于」对话框的仓库 / LICENSE / Releases 按钮）。
/// 只放行 http / https，避免把任意 scheme 交给系统 shell；三平台各自的打开方式
/// 与 reveal_in_folder 同一惯例（Windows start、macOS open、Linux xdg-open）。
#[tauri::command]
fn open_external_url(url: String) -> Result<(), String> {
    let u = url.trim();
    if !(u.starts_with("http://") || u.starts_with("https://")) {
        return Err(ui_msg!("openUrlFailed", "url" => u.to_string()));
    }
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("cmd")
            .args(["/c", "start", "", u])
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open").arg(u).spawn().map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "linux")]
    {
        std::process::Command::new("xdg-open").arg(u).spawn().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// 在系统文件管理器中显示库内文件 / 文件夹（文件树右键）。Windows 用 explorer /select 选中
/// 该项（退出码经常回 1，只要进程起得来即算成功）；macOS 用 open -R 反选；Linux 没有
/// 通用反选，xdg-open 打开所在目录。
#[tauri::command]
fn reveal_in_folder(vault_root: String, rel: String) -> Result<(), String> {
    let abs = abs_in_vault(&vault_root, &rel)?;
    if !abs.exists() {
        return Err(ui_msg!("revealNotFound", "path" => abs.to_string_lossy()));
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg("-R")
            .arg(&abs)
            .spawn()
            .map_err(|e| e.to_string())?;
        return Ok(());
    }
    #[cfg(target_os = "linux")]
    {
        let dir = if abs.is_dir() {
            abs.clone()
        } else {
            abs.parent().map(|p| p.to_path_buf()).unwrap_or(abs)
        };
        std::process::Command::new("xdg-open").arg(&dir).spawn().map_err(|e| e.to_string())?;
        return Ok(());
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // raw_arg 绕开 Command 的引号转义：/select 后面的路径要带原样引号才能命中带空格的项
        std::process::Command::new("explorer")
            .raw_arg(format!("/select,\"{}\"", abs.to_string_lossy()))
            .spawn()
            .map_err(|e| e.to_string())?;
        Ok(())
    }
}

/// 把 data: URL 的图片字节写到任意路径（图片右键「另存为」；路径来自前端保存对话框）。
#[tauri::command]
fn save_image_from_data_uri(path: String, data_uri: String) -> Result<(), String> {
    let payload = data_uri
        .strip_prefix("data:")
        .and_then(|rest| rest.split_once(";base64,"))
        .map(|(_, payload)| payload)
        .ok_or_else(|| ui_msg!("writeImgFailed", "err" => "not a base64 data URI"))?;
    let bytes = b64_decode(payload).map_err(|e| ui_msg!("writeImgFailed", "err" => e))?;
    if bytes.is_empty() {
        return Err(ui_msg!("writeImgFailed", "err" => "empty payload"));
    }
    fs::write(&path, &bytes).map_err(|e| ui_msg!("writeImgFailed", "err" => e))
}

// ==================== P1 新增：知识库索引 / 双向链接 / 搜索 / 预览 / 备份 / 导出 ====================

/// 内部：每个 md 一条 DocEntry（含原文用于快速搜索与片段）
#[derive(Clone)]
pub(crate) struct DocEntry {
    pub(crate) path: String,
    pub(crate) title: String,
    pub(crate) tags: Vec<String>,
    pub(crate) outgoing: Vec<String>, // 解析成功的目标 rel path
    pub(crate) unresolved: Vec<String>, // 未能解析的目标（保留原 name）
    pub(crate) content: String,
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

/// 从 md 提取所有 #tag（跳过标题行、代码块、行内代码、**链接/图片目标里的锚点**）
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
                // 链接/图片目标位置上的 `#` 是锚点 href（`](#anchor)` 或 `](<#anchor>)`），不是标签：
                // 内部锚点链接（如交叉引用导入产生的 `(#_Ref…)`、`(#标题slug)`）会被左边界白名单里的
                // `(` 误判成标签，把每个锚点灌成一个幽灵标签进标签面板，故先排除。
                let is_link_dest = (k >= 2 && cs[k - 1] == '(' && cs[k - 2] == ']')
                    || (k >= 3 && cs[k - 1] == '<' && cs[k - 2] == '(' && cs[k - 3] == ']');
                if is_link_dest {
                    k += 1;
                    continue;
                }
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
pub(crate) fn extract_title(md: &str, path: &str) -> String {
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
        let ft = match e.file_type() {
            Ok(t) => t,
            Err(_) => continue,
        };
        // 符号链接不进索引：链到库外时读到的内容与键（库内相对路径）对不上，剪藏会写成死链
        if ft.is_symlink() {
            continue;
        }
        let p = e.path();
        let cr = if rel.is_empty() { name.clone() } else { format!("{}/{}", rel, name) };
        if ft.is_dir() {
            collect_md_paths(&p, &cr, depth + 1, out);
        } else if ft.is_file() && is_md(&name) {
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

/// 全库标签计数（不分大小写区分，按原始写法聚合）：[{tag, count}]，按出现次数降序、同数按名序
fn collect_all_tags(g: &VaultIndex) -> Vec<(String, usize)> {
    let mut map: HashMap<String, usize> = HashMap::new();
    for d in g.docs.values() {
        for t in &d.tags {
            *map.entry(t.clone()).or_insert(0) += 1;
        }
    }
    let mut v: Vec<(String, usize)> = map.into_iter().collect();
    v.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
    v
}

/// 含指定标签的文档列表（大小写不敏感、忽略开头的 #），按路径排序
fn collect_docs_by_tag(g: &VaultIndex, tag: &str) -> Vec<BacklinkHit> {
    let t = tag.trim().trim_start_matches('#').to_lowercase();
    let mut v: Vec<BacklinkHit> = g
        .docs
        .values()
        .filter(|d| d.tags.iter().any(|x| x.to_lowercase() == t))
        .map(|d| BacklinkHit { path: d.path.clone(), title: d.title.clone() })
        .collect();
    v.sort_by(|a, b| a.path.cmp(&b.path));
    v
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct TagCount {
    pub tag: String,
    pub count: usize,
}

#[tauri::command]
fn list_all_tags(state: tauri::State<'_, IndexState>) -> Vec<TagCount> {
    let g = state.0.lock().unwrap();
    collect_all_tags(&g)
        .into_iter()
        .map(|(tag, count)| TagCount { tag, count })
        .collect()
}

#[tauri::command]
fn query_tag(state: tauri::State<'_, IndexState>, tag: String) -> Vec<BacklinkHit> {
    let g = state.0.lock().unwrap();
    collect_docs_by_tag(&g, &tag)
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
    index_doc_into(&mut g, &path, &content);
    Ok(())
}

/// 索引键的规范形态：库内相对路径（`/` 分隔、只收 `.md`），与 build_index 扫出来的键同一套。
/// 库外文件也会走到 update_index_doc（打开 / 保存 /tmp 下的临时稿），此前没有这道闸，
/// 绝对路径与非 md 文件都原样进索引；剪藏挑「相关笔记」时把它们写成 `[[/tmp/…]]` 死链。
/// 绝对路径落在库内时归一成相对键；越界（库外、`..`、非 md）返回 None。
fn index_key_in_vault(vault_root: &str, path: &str) -> Option<String> {
    let p = Path::new(path);
    let mut parts: Vec<String> = Vec::new();
    if p.is_absolute() {
        let root = fs::canonicalize(vault_root).ok()?;
        let abs = fs::canonicalize(p).ok()?;
        for c in abs.strip_prefix(&root).ok()?.components() {
            match c {
                Component::Normal(s) => parts.push(s.to_string_lossy().into_owned()),
                Component::CurDir => {}
                _ => return None,
            }
        }
    } else {
        for c in p.components() {
            match c {
                Component::Normal(s) => parts.push(s.to_string_lossy().into_owned()),
                Component::CurDir => {}
                Component::Prefix(_) | Component::RootDir | Component::ParentDir => return None,
            }
        }
    }
    if parts.is_empty() {
        return None;
    }
    let key = parts.join("/");
    if is_md(&key) { Some(key) } else { None }
}

/// 把一条文档写进索引（含 backlinks 增量维护）。update_index_doc 命令层与网页剪藏
/// （webclip.rs 的 write_clip）共用，避免剪藏落盘后索引对不上。
pub(crate) fn index_doc_into(g: &mut VaultIndex, path: &str, content: &str) {
    let Some(key) = index_key_in_vault(&g.vault_root, path) else {
        // 库外 / 非 md：顺手清掉老版本可能已经写进去的同名条目
        remove_doc_from_index(g, path);
        return;
    };
    let root = PathBuf::from(&g.vault_root);
    let raw = extract_wikilinks(content);
    let mut outgoing: Vec<String> = Vec::new();
    let mut unresolved: Vec<String> = Vec::new();
    for r in raw {
        match resolve_one(&root, &key, &r) {
            Some(hit) => {
                if hit != key {
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
    let title = extract_title(content, &key);
    let tags = extract_tags(content);
    let old_outgoing: Vec<String> = g
        .docs
        .get(&key)
        .map(|d| d.outgoing.clone())
        .unwrap_or_default();
    g.docs.insert(
        key.clone(),
        DocEntry { path: key.clone(), title, tags, outgoing, unresolved, content: content.to_string() },
    );
    for tgt in &old_outgoing {
        if let Some(lst) = g.backlinks.get_mut(tgt) {
            lst.retain(|p| p != &key);
        }
    }
    let new_outgoing: Vec<String> = g
        .docs
        .get(&key)
        .map(|d| d.outgoing.clone())
        .unwrap_or_default();
    for tgt in new_outgoing {
        let e = g.backlinks.entry(tgt).or_default();
        if !e.contains(&key) {
            e.push(key.clone());
            e.sort();
        }
    }
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
    fs::write(&abs, args.content).map_err(|e| ui_msg!("writeBackupFailed", "err" => e))?;
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
        return Err(ui_msg!("backupOnly"));
    }
    let abs = abs_in_vault(&vault_root, &norm)?;
    fs::read_to_string(&abs).map_err(|e| ui_msg!("readBackupFailed", "err" => e))
}

/// 插件包条目（批次 F1：文件夹化安装包）
/// dir_name = 一级目录名（=== manifest.id，由前端校验）；manifest_raw = manifest.json 原文
/// （Rust 不解析 JSON、不校验 id/scope——那是前端 plugin-manifest.js 的职责）；
/// main_exists = 默认 main.js/main.mjs 是否存在的探测。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginPackage {
    pub dir_name: String,
    pub manifest_path: String,
    pub manifest_raw: String,
    pub main_exists: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginList {
    pub packages: Vec<PluginPackage>,
    pub legacy_flat: Vec<String>,
}

/// 枚举 <vault>/.notelume-plugins/ 下的一级子目录（每个是一个插件包），只读
/// manifest.json 原文交前端校验。顶层游离 *.js/*.mjs 收集进 legacyFlat（旧版
/// 平铺插件，前端提示需文件夹化迁移）。
#[tauri::command]
fn list_plugins(vault_root: String) -> Result<PluginList, String> {
    let root = fs::canonicalize(&vault_root).map_err(|e| e.to_string())?;
    let base = root.join(".notelume-plugins");
    let mut packages = Vec::new();
    let mut legacy_flat = Vec::new();
    if base.exists() {
        for e in fs::read_dir(&base).map_err(|e| e.to_string())?.flatten() {
            let p = e.path();
            let file_name = e.file_name().to_string_lossy().to_string();
            if p.is_file() {
                if file_name.ends_with(".js") || file_name.ends_with(".mjs") {
                    legacy_flat.push(file_name);
                }
                continue;
            }
            if !p.is_dir() {
                continue;
            }
            let manifest = p.join("manifest.json");
            let manifest_raw = fs::read_to_string(&manifest).unwrap_or_default();
            let main_exists = p.join("main.js").exists() || p.join("main.mjs").exists();
            let manifest_path = manifest
                .strip_prefix(&root)
                .map(|r| r.to_string_lossy().replace('\\', "/"))
                .unwrap_or_else(|_| file_name.clone());
            packages.push(PluginPackage {
                dir_name: file_name,
                manifest_path,
                manifest_raw,
                main_exists,
            });
        }
    }
    packages.sort_by(|a, b| a.dir_name.cmp(&b.dir_name));
    legacy_flat.sort();
    Ok(PluginList { packages, legacy_flat })
}

/// 读取一个插件源码（前端用 Blob URL + 动态 import 加载）。
/// 前缀白名单 .notelume-plugins/ + abs_in_vault 双重防路径穿越。
#[tauri::command]
fn read_plugin(vault_root: String, plugin_rel: String) -> Result<String, String> {
    let norm = plugin_rel.replace('\\', "/");
    if !norm.starts_with(".notelume-plugins/") {
        return Err(ui_msg!("pluginOnly"));
    }
    let abs = abs_in_vault(&vault_root, &norm)?;
    fs::read_to_string(&abs).map_err(|e| ui_msg!("readPluginFailed", "err" => e))
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
        fs::create_dir_all(parent).map_err(|e| ui_msg!("createDirFailed", "err" => e))?;
    }
    fs::write(&p, args.content).map_err(|e| ui_msg!("exportFailed", "err" => e))
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
    let guard = state.0.lock().map_err(|_| ui_msg!("indexLockPoisoned"))?;
    Ok(extract_graph(&guard))
}

// ==================== 批次 C：整站导出 ====================

/// 站点文档条目（供首页/侧栏/搜索索引）
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SiteDoc {
    pub rel: String,
    pub title: String,
}

/// 一条 wikilink 解析结果：from 文档里的原始 target 文本 → 解析到的库内 md rel（None=解析不到）
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SiteWiki {
    pub from: String,
    pub target: String,
    pub to: Option<String>,
}

/// build_site_graph 返回：全库文档 + wikilink 解析表（导航/反链/链接重写单一事实源）
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SiteGraph {
    pub docs: Vec<SiteDoc>,
    pub wiki: Vec<SiteWiki>,
}

/// 遍历库内所有 md，产出文档列表与 wikilink 解析表。
/// 复用 extract_wikilinks + resolve_one，链接解析与编辑器点击跳转完全一致。
#[tauri::command]
fn build_site_graph(vault_root: String) -> Result<SiteGraph, String> {
    let root = fs::canonicalize(&vault_root).map_err(|e| ui_msg!("vaultPathInvalid", "err" => e))?;
    if !root.is_dir() {
        return Err(ui_msg!("vaultNotDir"));
    }
    let mut paths: Vec<String> = Vec::new();
    collect_md_paths(&root, "", 0, &mut paths);
    paths.sort();
    let mut docs: Vec<SiteDoc> = Vec::new();
    let mut wiki: Vec<SiteWiki> = Vec::new();
    for rel in paths {
        let mut abs = root.clone();
        for seg in rel.split('/') {
            abs.push(seg);
        }
        let content = fs::read_to_string(&abs).unwrap_or_default();
        docs.push(SiteDoc { rel: rel.clone(), title: extract_title(&content, &rel) });
        // 同一文档内相同 target 只解析一次（渲染按 (from,target) 查表）
        let mut seen: HashSet<String> = HashSet::new();
        for target in extract_wikilinks(&content) {
            if !seen.insert(target.clone()) {
                continue;
            }
            let to = resolve_one(&root, &rel, &target);
            wiki.push(SiteWiki { from: rel.clone(), target, to });
        }
    }
    Ok(SiteGraph { docs, wiki })
}

/// 把库内引用到的资源（图片）按相同相对路径镜像复制到输出目录。
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CopyAssetsArgs {
    pub rels: Vec<String>,
    pub out_dir: String,
}

/// 逐个 abs_in_vault 校验（拒绝 .. 逃逸）；缺失/越界资源跳过不中断整站。
#[tauri::command]
fn copy_vault_assets(vault_root: String, args: CopyAssetsArgs) -> Result<(), String> {
    let out_root = PathBuf::from(&args.out_dir);
    fs::create_dir_all(&out_root).map_err(|e| ui_msg!("createOutDirFailed", "err" => e))?;
    for rel in &args.rels {
        let src = match abs_in_vault(&vault_root, rel) {
            Ok(s) => s,
            Err(_) => continue, // 资源不存在/越界：跳过
        };
        if !src.is_file() {
            continue;
        }
        let dest = vault_join(&out_root, rel)?;
        if let Some(parent) = dest.parent() {
            fs::create_dir_all(parent).map_err(|e| ui_msg!("createDirFailed", "err" => e))?;
        }
        fs::copy(&src, &dest).map_err(|e| ui_msg!("copyFailedRel", "rel" => rel, "err" => e))?;
    }
    Ok(())
}

// ==================== 批次 E（子项目 L）：本地 Git（只读部分）====================
// 设计见 docs/superpowers/specs/2026-10-14-local-git-integration-design.md
// 「库根 = 仓库」：所有命令入参带 vault_root，用 git2 在该目录（向上 discover）操作；
// 本批仅只读查看 + 后续 E1b 的 add/commit，绝不做 checkout/reset/merge 等改写动作。

/// 仓库探测结果
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitRepoInfo {
    pub is_repo: bool,
    /// 实际仓库工作目录绝对路径（可能高于 vault_root，回显以示透明）
    pub repo_path: Option<String>,
    pub branch: Option<String>,
    pub has_head: bool,
}

/// 单文件状态
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitFileStatus {
    /// 相对仓库工作目录、`/` 分隔
    pub path: String,
    /// new | modified | deleted | renamed | untracked | conflicted
    pub kind: String,
    /// 是否已在暂存区（index 相对 HEAD 有变动）
    pub staged: bool,
}

/// 提交记录
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCommitInfo {
    pub id: String,
    pub id_short: String,
    pub summary: String,
    pub author_name: String,
    pub author_email: String,
    /// 提交 Unix 秒
    pub time: i64,
}

/// 单文件 diff 入参
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DiffFileArgs {
    pub path: String,
    /// "HEAD"（工作树 vs HEAD）或某 commit id（该提交 vs 其父）
    pub against: String,
}

/// 打开库根所在仓库；失败统一映射成可读错误
fn open_repo(vault_root: &str) -> Result<git2::Repository, String> {
    git2::Repository::open(vault_root).map_err(|e| ui_msg!("gitOpenRepoFailed", "err" => e))
}

/// 把 Repository 收敛成 GitRepoInfo（多处复用）
fn repo_info(repo: &git2::Repository) -> GitRepoInfo {
    let head = repo.head().ok();
    GitRepoInfo {
        is_repo: true,
        repo_path: repo.workdir().map(|p| p.to_string_lossy().to_string()),
        branch: head.as_ref().and_then(|h| h.shorthand().map(|s| s.to_string())),
        has_head: head.is_some(),
    }
}

/// 探测当前库是否为 git 仓库（含向上 discover）；非仓库返回 is_repo=false 而非报错
#[tauri::command]
fn git_open(vault_root: String) -> Result<GitRepoInfo, String> {
    let repo = match git2::Repository::open(&vault_root) {
        Ok(r) => r,
        Err(_) => {
            return Ok(GitRepoInfo {
                is_repo: false,
                repo_path: None,
                branch: None,
                has_head: false,
            })
        }
    };
    Ok(repo_info(&repo))
}

/// 依据 git2 状态位分类；暂存区（index vs HEAD）优先于工作树（worktree vs index）
fn classify_status(s: git2::Status) -> (String, bool) {
    if s.contains(git2::Status::INDEX_NEW) {
        ("new".into(), true)
    } else if s.contains(git2::Status::INDEX_MODIFIED) {
        ("modified".into(), true)
    } else if s.contains(git2::Status::INDEX_DELETED) {
        ("deleted".into(), true)
    } else if s.contains(git2::Status::INDEX_RENAMED) {
        ("renamed".into(), true)
    } else if s.contains(git2::Status::CONFLICTED) {
        ("conflicted".into(), false)
    } else if s.contains(git2::Status::WT_NEW) {
        ("untracked".into(), false)
    } else if s.contains(git2::Status::WT_MODIFIED) {
        ("modified".into(), false)
    } else if s.contains(git2::Status::WT_DELETED) {
        ("deleted".into(), false)
    } else if s.contains(git2::Status::WT_RENAMED) {
        ("renamed".into(), false)
    } else {
        ("modified".into(), false)
    }
}

/// 工作树/暂存/HEAD 差异列表；封顶 1000 项
#[tauri::command]
fn git_status(vault_root: String) -> Result<Vec<GitFileStatus>, String> {
    let repo = open_repo(&vault_root)?;
    let mut opts = git2::StatusOptions::new();
    opts.recurse_untracked_dirs(true)
        .include_untracked(true)
        .include_ignored(false);
    let statuses = repo.statuses(Some(&mut opts)).map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for entry in statuses.iter() {
        let path = match entry.path() {
            Some(p) => p.to_string(),
            None => continue,
        };
        let (kind, staged) = classify_status(entry.status());
        out.push(GitFileStatus { path, kind, staged });
        if out.len() >= 1000 {
            break;
        }
    }
    Ok(out)
}

/// 从 HEAD 沿历史走 limit 条（默认 200）；空库返回空数组
#[tauri::command]
fn git_log(vault_root: String, limit: Option<usize>) -> Result<Vec<GitCommitInfo>, String> {
    let repo = open_repo(&vault_root)?;
    if repo.head().is_err() {
        return Ok(Vec::new()); // 无 HEAD（空库）→ 无历史
    }
    let limit = limit.unwrap_or(200);
    let mut revwalk = repo.revwalk().map_err(|e| e.to_string())?;
    revwalk.push_head().map_err(|e| e.to_string())?;
    revwalk
        .set_sorting(git2::Sort::TIME)
        .map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for oid in revwalk.flatten().take(limit) {
        let commit = repo.find_commit(oid).map_err(|e| e.to_string())?;
        let id = commit.id().to_string();
        let author = commit.author();
        out.push(GitCommitInfo {
            id: id.clone(),
            id_short: id.chars().take(7).collect(),
            summary: commit.summary().unwrap_or("").to_string(),
            author_name: author.name().unwrap_or("").to_string(),
            author_email: author.email().unwrap_or("").to_string(),
            time: commit.time().seconds(),
        });
    }
    Ok(out)
}

/// 单文件统一 diff 文本。against="HEAD"：工作树（含未跟踪）vs HEAD；
/// against=commit id：该提交 vs 其父（首提交对空树）。无差异返回空串。
#[tauri::command]
fn git_diff_file(vault_root: String, args: DiffFileArgs) -> Result<String, String> {
    let repo = open_repo(&vault_root)?;

    // against=HEAD 且 HEAD 里没有该文件（未跟踪/新文件）：git2 的 tree_to_workdir 不含未跟踪，
    // 手工合成「对空树、全为新增」的统一 diff。
    if (args.against.eq_ignore_ascii_case("head") || args.against.is_empty())
        && !head_has_path(&repo, &args.path)
    {
        let abs = repo
            .workdir()
            .ok_or(ui_msg!("gitNoWorkdir"))?
            .join(Path::new(&args.path));
        let bytes = fs::read(&abs).map_err(|e| ui_msg!("readFileFailed", "path" => abs.display(), "err" => e))?;
        return Ok(synthesize_added_patch(&args.path, &bytes));
    }

    let mut opts = git2::DiffOptions::new();
    opts.pathspec(&args.path)
        .include_untracked(true)
        .recurse_untracked_dirs(true);

    let diff = if args.against.eq_ignore_ascii_case("head") || args.against.is_empty() {
        let head_tree = repo
            .head()
            .ok()
            .and_then(|h| h.peel_to_tree().ok());
        repo.diff_tree_to_workdir_with_index(head_tree.as_ref(), Some(&mut opts))
            .map_err(|e| e.to_string())?
    } else {
        let oid = git2::Oid::from_str(&args.against).map_err(|e| e.to_string())?;
        let commit = repo.find_commit(oid).map_err(|e| e.to_string())?;
        let tree = commit.tree().map_err(|e| e.to_string())?;
        let parent_tree = commit.parents().next().and_then(|p| p.tree().ok());
        repo.diff_tree_to_tree(parent_tree.as_ref(), Some(&tree), Some(&mut opts))
            .map_err(|e| e.to_string())?
    };

    Ok(render_patch(&diff))
}

/// HEAD 树里是否存在该相对路径
fn head_has_path(repo: &git2::Repository, path: &str) -> bool {
    match repo.head().ok().and_then(|h| h.peel_to_tree().ok()) {
        Some(tree) => tree.get_path(Path::new(path)).is_ok(),
        None => false, // 空库无 HEAD
    }
}

/// 把一个 Diff 渲染成标准 unified patch 文本。
/// add/del/context 行的 content() 不含 +/-/空格前缀，需补 origin()；
/// file/hunk 头行与 binary 行的 content() 已是完整渲染行，原样拼接。
fn render_patch(diff: &git2::Diff) -> String {
    let mut buf = String::new();
    let _ = diff.print(git2::DiffFormat::Patch, |_delta, _hunk, line| {
        use git2::DiffLineType::*;
        let content = std::str::from_utf8(line.content()).unwrap_or("");
        match line.origin_value() {
            Context | Addition | Deletion | ContextEOFNL | AddEOFNL | DeleteEOFNL => {
                buf.push(line.origin());
                buf.push_str(content);
            }
            _ => buf.push_str(content),
        }
        true
    });
    buf
}

/// 未跟踪/新文件：手工拼「对空树、全新增」的 unified diff
fn synthesize_added_patch(path: &str, bytes: &[u8]) -> String {
    let text = String::from_utf8_lossy(bytes);
    let mut out = String::new();
    out.push_str(&format!("diff --git a/{p} b/{p}\n", p = path));
    out.push_str("--- /dev/null\n");
    out.push_str(&format!("+++ b/{p}\n", p = path));
    let lines: Vec<&str> = text.split('\n').collect();
    // 末尾因 \n 产生的空串不计
    let n = if lines.last() == Some(&"") {
        lines.len() - 1
    } else {
        lines.len()
    };
    out.push_str(&format!("@@ -0,0 +1,{n} @@\n"));
    for l in lines.iter().take(n) {
        out.push('+');
        out.push_str(l);
        out.push('\n');
    }
    out
}

// —— E1b 写命令：身份读取 / init（+gitignore seeding）/ add -A + commit ——

/// 提交身份
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Identity {
    pub name: String,
    pub email: String,
}

/// commit 入参
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CommitArgs {
    pub message: String,
    pub name: Option<String>,
    pub email: Option<String>,
}

/// commit 结果
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitCommitResult {
    pub id: String,
    pub id_short: String,
}

/// 读仓库配置里的 user.name/user.email。两者齐备才 Some。
/// 两个关键坑：
/// 1) git2 0.19 的 Config::get_str 必须在 snapshot() 上调用（直接对 open 出的 config 取键会 Err）；
/// 2) 故意按文件路径直接打开本地 .git/config 读（避开 libgit2 对 repo.config() 的快照缓存），
///    本地缺的键再回退全局。
fn read_identity(repo: &git2::Repository) -> Result<Option<Identity>, String> {
    let local_path = repo.path().join("config");
    let mut name: Option<String> = None;
    let mut email: Option<String> = None;
    if let Ok(mut cfg) = git2::Config::open(&local_path) {
        name = cfg
            .snapshot()
            .ok()
            .and_then(|s| s.get_str("user.name").ok().map(|v| v.to_string()));
        email = cfg
            .snapshot()
            .ok()
            .and_then(|s| s.get_str("user.email").ok().map(|v| v.to_string()));
    }
    if name.as_deref().map_or(true, |v| v.trim().is_empty())
        || email.as_deref().map_or(true, |v| v.trim().is_empty())
    {
        if let Ok(mut cfg) = git2::Config::open_default() {
            if name.as_deref().map_or(true, |v| v.trim().is_empty()) {
                name = cfg
                    .snapshot()
                    .ok()
                    .and_then(|s| s.get_str("user.name").ok().map(|v| v.to_string()));
            }
            if email.as_deref().map_or(true, |v| v.trim().is_empty()) {
                email = cfg
                    .snapshot()
                    .ok()
                    .and_then(|s| s.get_str("user.email").ok().map(|v| v.to_string()));
            }
        }
    }
    match (name, email) {
        (Some(n), Some(e)) if !n.trim().is_empty() && !e.trim().is_empty() => {
            Ok(Some(Identity { name: n, email: e }))
        }
        _ => Ok(None),
    }
}

/// 暴露给面板：探测时顺便读身份；非仓库返回 None
#[tauri::command]
fn git_config_identity(vault_root: String) -> Result<Option<Identity>, String> {
    let repo = open_repo(&vault_root)?;
    read_identity(&repo)
}

/// 初始化仓库；若仓库根无 .gitignore 则写一份排除 .notelume-backup/（已存在则不碰）
#[tauri::command]
fn git_init(vault_root: String) -> Result<GitRepoInfo, String> {
    let repo =
        git2::Repository::init(&vault_root).map_err(|e| ui_msg!("gitInitFailed", "err" => e))?;
    let gi = Path::new(&vault_root).join(".gitignore");
    if !gi.exists() {
        fs::write(&gi, ".notelume-backup/\n").map_err(|e| ui_msg!("gitignoreWriteFailed", "err" => e))?;
    }
    Ok(repo_info(&repo))
}

/// 确定签名身份：优先传入（来自“问一次”），否则读配置；两者都缺则报错。
fn resolve_identity(
    repo: &git2::Repository,
    name: Option<&str>,
    email: Option<&str>,
) -> Result<(String, String), String> {
    let from_cfg = read_identity(repo)?;
    let n = name
        .map(|s| s.to_string())
        .or_else(|| from_cfg.as_ref().map(|i| i.name.clone()));
    let e = email
        .map(|s| s.to_string())
        .or_else(|| from_cfg.as_ref().map(|i| i.email.clone()));
    match (n, e) {
        (Some(n), Some(e)) if !n.trim().is_empty() && !e.trim().is_empty() => Ok((n, e)),
        _ => Err(ui_msg!("gitIdentityMissing")),
    }
}

/// 等价 git add -A（尊重忽略）+ 带签名 commit。无改动可提交/空消息均拒。
/// 若身份来自传入参数（“问一次”流程）则回写 repo 本地配置。
#[tauri::command]
fn git_commit_all(vault_root: String, args: CommitArgs) -> Result<GitCommitResult, String> {
    let repo = open_repo(&vault_root)?;
    let message = args.message.trim_end();
    if message.trim().is_empty() {
        return Err(ui_msg!("gitCommitMsgEmpty"));
    }
    let (name, email) = resolve_identity(&repo, args.name.as_deref(), args.email.as_deref())?;

    let mut idx = repo.index().map_err(|e| e.to_string())?;
    idx.add_all(["*"].iter(), git2::IndexAddOption::DEFAULT, None)
        .map_err(|e| e.to_string())?;
    idx.update_all(["*"].iter(), None)
        .map_err(|e| e.to_string())?;
    idx.write().map_err(|e| e.to_string())?;
    let tree_id = idx.write_tree().map_err(|e| e.to_string())?;
    let tree = repo.find_tree(tree_id).map_err(|e| e.to_string())?;

    // HEAD 父提交（首提交时 None）
    let parent_commit: Option<git2::Commit> = repo
        .head()
        .ok()
        .and_then(|h| h.peel_to_commit().ok());
    // 无改动可提交：树与 HEAD 相同则拒
    if let Some(hct) = parent_commit.as_ref().and_then(|c| c.tree().ok()) {
        if hct.id() == tree_id {
            return Err(ui_msg!("gitNothingToCommit"));
        }
    }

    let sig = git2::Signature::now(&name, &email).map_err(|e| e.to_string())?;
    let parents: Vec<&git2::Commit> = parent_commit.iter().collect();
    let oid = repo
        .commit(Some("HEAD"), &sig, &sig, message, &tree, &parents)
        .map_err(|e| e.to_string())?;

    // 身份来自参数且原本缺失 → 回写本地配置（下次直接读）
    if args.name.is_some() && args.email.is_some() && read_identity(&repo)?.is_none() {
        // 显式打开 .git/config 本地文件写（repo.config() 快照的 open_level 写入不可靠）
        if let Ok(mut local) = git2::Config::open(&repo.path().join("config")) {
            let _ = local.set_str("user.name", &name);
            let _ = local.set_str("user.email", &email);
        }
    }

    let id = oid.to_string();
    Ok(GitCommitResult {
        id_short: id.chars().take(7).collect(),
        id,
    })
}

// ==================== 批次 E（子项目 R1）：Git 远程命令壳 ====================
// 与子项目 L（本地 git2）并行的第三层：远程。
// 硬约束同 R1 spec：① argv 数组无拼接注入面；② 不接触/存储凭据；③ `--ff-only`，绝不自动 merge/rebase。
//
// Phase 2 (R1-B) 后本段只留 `#[tauri::command]` 壳与引擎分派；具体实现：
//   • System 后端（shell-out）→ `git_builtin::system::*`
//   • Builtin 后端（内置 git2，Phase 3 实装）→ `git_builtin::builtin::*`
// 进程启动后首次调用时 `cached_engine()` 开一次 `git --version` 探测，命中→System、否则→Builtin。

/// 探测系统 git 是否可用：`git --version` 成功回版本串，否则 None。前端据此可提示“内置 vs 系统”。
/// Phase 2 后 Builtin 引擎下本命令仍返 None（内置不依赖系统 git），引擎详情见 Phase 4 的 `git_r_info`。
#[tauri::command]
async fn git_r_have() -> Option<String> {
    match git_builtin::cached_engine() {
        git_builtin::Engine::System => git_builtin::system::have().await,
        git_builtin::Engine::Builtin => git_builtin::builtin::have().await,
    }
}

/// 列出现有远端
#[tauri::command]
async fn git_r_remote_list(vault_root: String) -> Result<Vec<Remote>, String> {
    match git_builtin::cached_engine() {
        git_builtin::Engine::System => git_builtin::system::remote_list(vault_root).await,
        git_builtin::Engine::Builtin => git_builtin::builtin::remote_list(vault_root).await,
    }
}

/// 添加远端
#[tauri::command]
async fn git_r_remote_add(vault_root: String, args: RemoteArgs) -> Result<(), String> {
    match git_builtin::cached_engine() {
        git_builtin::Engine::System => git_builtin::system::remote_add(vault_root, args).await,
        git_builtin::Engine::Builtin => git_builtin::builtin::remote_add(vault_root, args).await,
    }
}

/// 改远端地址
#[tauri::command]
async fn git_r_remote_set_url(vault_root: String, args: RemoteArgs) -> Result<(), String> {
    match git_builtin::cached_engine() {
        git_builtin::Engine::System => git_builtin::system::remote_set_url(vault_root, args).await,
        git_builtin::Engine::Builtin => git_builtin::builtin::remote_set_url(vault_root, args).await,
    }
}

/// `fetch --prune`（非交互）
#[tauri::command]
async fn git_r_fetch(vault_root: String, remote: Option<String>) -> Result<String, String> {
    match git_builtin::cached_engine() {
        git_builtin::Engine::System => git_builtin::system::fetch(vault_root, remote).await,
        git_builtin::Engine::Builtin => git_builtin::builtin::fetch(vault_root, remote).await,
    }
}

/// 上游名（`rev-parse --abbrev-ref @{u}`）；无上游 → Ok(None)。
#[tauri::command]
async fn git_r_upstream(vault_root: String) -> Result<Option<String>, String> {
    match git_builtin::cached_engine() {
        git_builtin::Engine::System => git_builtin::system::upstream(vault_root).await,
        git_builtin::Engine::Builtin => git_builtin::builtin::upstream(vault_root).await,
    }
}

/// 领先/落后计数
#[tauri::command]
async fn git_r_ahead_behind(vault_root: String) -> Result<Option<AheadBehind>, String> {
    match git_builtin::cached_engine() {
        git_builtin::Engine::System => git_builtin::system::ahead_behind(vault_root).await,
        git_builtin::Engine::Builtin => git_builtin::builtin::ahead_behind(vault_root).await,
    }
}

/// 快进 pull：退出码 0 → Ok(stdout+stderr)；非零 → Err(stderr+stdout)，前端 NONFF_RE 归类。
#[tauri::command]
async fn git_r_pull_ff(vault_root: String) -> Result<String, String> {
    match git_builtin::cached_engine() {
        git_builtin::Engine::System => git_builtin::system::pull_ff(vault_root).await,
        git_builtin::Engine::Builtin => git_builtin::builtin::pull_ff(vault_root).await,
    }
}

/// R2 新增：推当前分支→ upstream。System 走 `git push`；Builtin 走 git2 `Remote::push`。
/// 失败时回 `[code]msg` 前串（no_upstream / non_fast_forward / auth / network /
/// hostkey_mismatch / host_unknown / git_error），前端 `handleRemoteErr` 同一张表分派。
#[tauri::command]
async fn git_r_push(vault_root: String) -> Result<String, String> {
    match git_builtin::cached_engine() {
        git_builtin::Engine::System => git_builtin::system::push(vault_root).await,
        git_builtin::Engine::Builtin => git_builtin::builtin::push(vault_root).await,
    }
}

/// R3 新增：合并拉取（不带 --ff-only）。System 走 `git pull`；Builtin 走 git2 merge API。
/// 无冲突回 `MERGED\n…`；有冲突回 `CONFLICTS\n…`；其他失败回 `[code]msg`。
#[tauri::command]
async fn git_r_pull_merge(vault_root: String) -> Result<String, String> {
    match git_builtin::cached_engine() {
        git_builtin::Engine::System => git_builtin::system::pull_merge(vault_root).await,
        git_builtin::Engine::Builtin => git_builtin::builtin::pull_merge(vault_root).await,
    }
}

/// R3 新增：列当前冲突文件（相对路径）。System 走 `git diff --diff-filter=U`；Builtin 扫 index stage>0。
#[tauri::command]
async fn git_r_conflict_files(vault_root: String) -> Result<Vec<String>, String> {
    match git_builtin::cached_engine() {
        git_builtin::Engine::System => git_builtin::system::conflict_files(vault_root).await,
        git_builtin::Engine::Builtin => git_builtin::builtin::conflict_files(vault_root).await,
    }
}

/// R3 新增：解决单个冲突文件——选 ours/theirs 边 + stage。args.path 相对路径、args.side "ours"|"theirs"。
#[tauri::command]
async fn git_r_resolve(vault_root: String, args: ResolveArgs) -> Result<(), String> {
    match git_builtin::cached_engine() {
        git_builtin::Engine::System => git_builtin::system::resolve(vault_root, args).await,
        git_builtin::Engine::Builtin => git_builtin::builtin::resolve(vault_root, args).await,
    }
}

/// R3 新增：是否处于 merge-in-progress（MERGE_HEAD 存在）。前端刷新时用它决定是否显冲突工具条。
#[tauri::command]
async fn git_r_merge_state(vault_root: String) -> Result<bool, String> {
    match git_builtin::cached_engine() {
        git_builtin::Engine::System => git_builtin::system::merge_state(vault_root).await,
        git_builtin::Engine::Builtin => git_builtin::builtin::merge_state(vault_root).await,
    }
}

/// R3 新增：中止合并，回到 pull 前状态。
#[tauri::command]
async fn git_r_abort_merge(vault_root: String) -> Result<(), String> {
    match git_builtin::cached_engine() {
        git_builtin::Engine::System => git_builtin::system::abort_merge(vault_root).await,
        git_builtin::Engine::Builtin => git_builtin::builtin::abort_merge(vault_root).await,
    }
}

/// R3 新增：提交合并（冲突全部解决后，生成带两父的 merge commit）。
#[tauri::command]
async fn git_r_commit_merge(vault_root: String, args: CommitMergeArgs) -> Result<(), String> {
    match git_builtin::cached_engine() {
        git_builtin::Engine::System => git_builtin::system::commit_merge(vault_root, args).await,
        git_builtin::Engine::Builtin => git_builtin::builtin::commit_merge(vault_root, args).await,
    }
}

/// Phase 4 新增：一次性信任陌生 SSH host。前端从 `[host_unknown]<json>` 错误里解出 payload，
/// 展示 key 指纹后递回本命令；System 引擎写 `~/.ssh/known_hosts`，Builtin 引擎写应用私库。
#[tauri::command]
async fn git_r_trust_host(args: TrustHostArgs) -> Result<(), String> {
    match git_builtin::cached_engine() {
        git_builtin::Engine::System => git_builtin::system::trust_host(args).await,
        git_builtin::Engine::Builtin => git_builtin::builtin::trust_host(args).await,
    }
}

/// Phase 4 新增：上报当前引擎与系统 git 版本，前端徽标 + 错误引导需要。进程内 OnceLock 缓存，无额外开销。
#[tauri::command]
async fn git_r_info() -> GitSyncInfo {
    let (engine, ver) = git_builtin::cached_engine_and_version();
    match engine {
        git_builtin::Engine::System => git_builtin::system::info(ver).await,
        git_builtin::Engine::Builtin => git_builtin::builtin::info(ver).await,
    }
}

// ==================== macOS 原生菜单（系统菜单栏）====================
// 菜单内容只在前端算一处（src/app-menu.js 的 buildMacMenuSpec：文案 / 快捷键 / 可用性 / 勾选
// 全取命令注册表），Rust 只把算好的 spec 落成原生菜单并挂上菜单栏。
// 一次 invoke 换掉整棵菜单，而不是前端逐项走 plugin:menu|new——后者在真机上没生效过，
// 且一次装配要几十次 IPC。点击经 `nl:menu-select` 事件回前端，由注册表执行。

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MenuGroup {
    pub id: String,
    pub text: String,
    #[serde(default)]
    pub items: Vec<MenuItemSpec>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MenuItemSpec {
    /// "cmd" | "check" | "sep" | "role" | "submenu"
    #[serde(rename = "type")]
    pub kind: String,
    #[serde(default)]
    pub id: Option<String>,
    #[serde(default)]
    pub text: Option<String>,
    /// kind == "role" 时的系统项名（About / Services / Hide / Quit / CloseWindow …）
    #[serde(default)]
    pub role: Option<String>,
    #[serde(default)]
    pub accelerator: Option<String>,
    #[serde(default)]
    pub enabled: Option<bool>,
    #[serde(default)]
    pub checked: Option<bool>,
    #[serde(default)]
    pub items: Vec<MenuItemSpec>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MenuSpec {
    pub groups: Vec<MenuGroup>,
}

/// mac 认 id 为 `window` 的组为系统「窗口」菜单（原生窗口列表挂上去）
fn native_group_id(id: &str) -> &str {
    if id == "window" {
        tauri::menu::WINDOW_SUBMENU_ID
    } else {
        id
    }
}

fn predefined_item(
    app: &tauri::AppHandle,
    role: &str,
    text: Option<&str>,
) -> Result<tauri::menu::MenuItemKind<tauri::Wry>, String> {
    use tauri::menu::{IsMenuItem, PredefinedMenuItem};
    let built = match role {
        "About" => PredefinedMenuItem::about(app, text, None).map(|i| i.kind()),
        "Separator" => PredefinedMenuItem::separator(app).map(|i| i.kind()),
        "Services" => PredefinedMenuItem::services(app, text).map(|i| i.kind()),
        "Hide" => PredefinedMenuItem::hide(app, text).map(|i| i.kind()),
        "HideOthers" => PredefinedMenuItem::hide_others(app, text).map(|i| i.kind()),
        "ShowAll" => PredefinedMenuItem::show_all(app, text).map(|i| i.kind()),
        "Quit" => PredefinedMenuItem::quit(app, text).map(|i| i.kind()),
        "CloseWindow" => PredefinedMenuItem::close_window(app, text).map(|i| i.kind()),
        "Minimize" => PredefinedMenuItem::minimize(app, text).map(|i| i.kind()),
        "Maximize" => PredefinedMenuItem::maximize(app, text).map(|i| i.kind()),
        "Fullscreen" => PredefinedMenuItem::fullscreen(app, text).map(|i| i.kind()),
        "Cut" => PredefinedMenuItem::cut(app, text).map(|i| i.kind()),
        "Copy" => PredefinedMenuItem::copy(app, text).map(|i| i.kind()),
        "Paste" => PredefinedMenuItem::paste(app, text).map(|i| i.kind()),
        "SelectAll" => PredefinedMenuItem::select_all(app, text).map(|i| i.kind()),
        "Undo" => PredefinedMenuItem::undo(app, text).map(|i| i.kind()),
        "Redo" => PredefinedMenuItem::redo(app, text).map(|i| i.kind()),
        other => return Err(ui_msg!("unknownMenuRole", "role" => other)),
    };
    built.map_err(|e| e.to_string())
}

fn build_menu_item(
    app: &tauri::AppHandle,
    it: &MenuItemSpec,
) -> Result<tauri::menu::MenuItemKind<tauri::Wry>, String> {
    use tauri::menu::{
        CheckMenuItemBuilder, IsMenuItem, MenuItemBuilder, SubmenuBuilder,
    };
    let text = it.text.clone().unwrap_or_default();
    let enabled = it.enabled.unwrap_or(true);
    let built = match it.kind.as_str() {
        "sep" => return predefined_item(app, "Separator", None),
        "role" => return predefined_item(app, it.role.as_deref().unwrap_or(""), it.text.as_deref()),
        "submenu" => {
            let mut b = SubmenuBuilder::new(app, &text).id(it.id.as_deref().unwrap_or("nl.sub"));
            for c in &it.items {
                b = b.item(&build_menu_item(app, c)?);
            }
            b.build().map(|s| s.kind()).map_err(|e| e.to_string())?
        }
        "check" => {
            let mut b = CheckMenuItemBuilder::with_id(it.id.clone().unwrap_or_default(), &text)
                .enabled(enabled)
                .checked(it.checked.unwrap_or(false));
            if let Some(a) = &it.accelerator {
                b = b.accelerator(a);
            }
            b.build(app).map(|c| c.kind()).map_err(|e| e.to_string())?
        }
        _ => {
            let mut b =
                MenuItemBuilder::with_id(it.id.clone().unwrap_or_default(), &text).enabled(enabled);
            if let Some(a) = &it.accelerator {
                b = b.accelerator(a);
            }
            b.build(app).map(|m| m.kind()).map_err(|e| e.to_string())?
        }
    };
    Ok(built)
}

fn install_app_menu(app: &tauri::AppHandle, spec: MenuSpec) -> Result<(), String> {
    use tauri::menu::{IsMenuItem, MenuBuilder, SubmenuBuilder};
    let mut tops: Vec<tauri::menu::MenuItemKind<tauri::Wry>> = Vec::new();
    for g in &spec.groups {
        let mut b = SubmenuBuilder::new(app, &g.text).id(native_group_id(&g.id));
        for it in &g.items {
            b = b.item(&build_menu_item(app, it)?);
        }
        tops.push(b.build().map(|s| s.kind()).map_err(|e| e.to_string())?);
    }
    if tops.is_empty() {
        return Err(ui_msg!("emptyMenuGroups"));
    }
    let refs: Vec<&dyn IsMenuItem<tauri::Wry>> = tops.iter().map(|i| i as &dyn IsMenuItem<tauri::Wry>).collect();
    let menu = MenuBuilder::new(app)
        .items(&refs)
        .build()
        .map_err(|e| e.to_string())?;
    menu.set_as_app_menu()
        .map_err(|e| e.to_string())
        .map(|_| ())
}

/// mac 启动先把「只有应用菜单」的原生骨架挂上。整棵菜单要等前端算好 spec 再 push，
/// 中间那一段系统菜单栏显示的是 Tauri 默认那套英文项（File / Edit / View …）。
/// 骨架全用系统预定义项：文案由 macOS 按系统语言给，一条也不复制前端的菜单文案，
/// 所以不存在两处口径漂移；前端第一次 push 会把它整棵换掉。
#[cfg(target_os = "macos")]
fn install_bootstrap_menu(app: &tauri::AppHandle) -> Result<(), String> {
    let role = |r: &str| MenuItemSpec {
        kind: "role".into(),
        id: None,
        text: None,
        role: Some(r.into()),
        accelerator: None,
        enabled: None,
        checked: None,
        items: vec![],
    };
    install_app_menu(
        app,
        MenuSpec {
            groups: vec![MenuGroup {
                id: "app".into(),
                // 第一个子菜单由 macOS 用进程名绘制，这个标题只是占位
                text: app.package_info().name.clone(),
                items: vec![
                    role("About"),
                    role("Separator"),
                    role("Services"),
                    role("Separator"),
                    role("Hide"),
                    role("HideOthers"),
                    role("ShowAll"),
                    role("Separator"),
                    role("Quit"),
                ],
            }],
        },
    )
}

/// 前端在 mac 启动与状态变化时调用；抛错由前端回显到状态栏，并把窗口内工具条摘掉原生标记放回来
#[tauri::command]
fn set_mac_menu(app: tauri::AppHandle, spec: MenuSpec) -> Result<(), String> {
    install_app_menu(&app, spec)
}

#[cfg(test)]
mod tests {
    use super::*;

    // 非 Windows 的远程图下载走系统 curl：用 file:// 起一个本地源，验证真把字节落到了目标路径
    #[cfg(not(windows))]
    #[test]
    fn pkg_ref_parse_rules() {
        assert_eq!(parse_pkg_ref("@atoms/demo:1.0.0").unwrap(), ("atoms".into(), "demo".into(), Some("1.0.0".into())));
        // 省掉版本交给注册表挑最高版
        assert_eq!(parse_pkg_ref("@atoms/demo").unwrap(), ("atoms".into(), "demo".into(), None));
        assert_eq!(parse_pkg_ref(" @atoms/demo:1.0.0 ").unwrap(), ("atoms".into(), "demo".into(), Some("1.0.0".into())));
        assert!(parse_pkg_ref("atoms/demo:1.0").is_err());
        assert!(parse_pkg_ref("@/demo:1.0").is_err());
        assert!(parse_pkg_ref("@atoms/demo:").is_err());
        assert!(parse_pkg_ref("@atoms/").is_err());
        assert!(parse_pkg_ref("@atoms/../x:1.0").is_err());
        assert!(parse_pkg_ref("@atoms/demo:1.0/x").is_err());
        assert!(parse_pkg_ref("@atoms/de mo:1.0").is_err());
    }

    #[test]
    fn pkg_version_按段取最高() {
        use std::cmp::Ordering::*;
        assert_eq!(qd_version_cmp("1.10.0", "1.9.0"), Greater);
        assert_eq!(qd_version_cmp("1.0.1", "1.0"), Greater);
        assert_eq!(qd_version_cmp("2.0", "10.0"), Less);
        assert_eq!(qd_version_cmp("1.0.0", "1.0.0"), Equal);
        let vs = ["0.9.0", "1.0.0", "1.9.0", "1.10.0"];
        assert_eq!(vs.into_iter().max_by(|a, b| qd_version_cmp(a, b)).unwrap(), "1.10.0");
    }

    /// 真打 atoms 注册表的联网用例：默认不跑，手动 `cargo test -- --ignored` 验证
    /// 「省略版本 → 列目录取最高 → 清单里的版本号与入口名对得上」这条链路。
    #[test]
    #[ignore = "需要 GitHub 网络"]
    fn pkg_省略版本按注册表取最高() {
        let vs = qd_registry_versions("cowsay").unwrap();
        assert!(
            vs.iter().any(|v| v.starts_with(|c: char| c.is_ascii_digit())),
            "版本目录名应是版本号：{vs:?}"
        );
        let latest = vs.into_iter().max_by(|a, b| qd_version_cmp(a, b)).unwrap();
        let tmp = std::env::temp_dir().join(format!("nl-qd-atom-{}.toml", std::process::id()));
        let url = format!("https://raw.githubusercontent.com/quarkdown-labs/atoms/main/cowsay/{latest}/atom.toml");
        let got = download_remote(&url, &tmp)
            .and_then(|()| fs::read_to_string(&tmp).map_err(|e| e.to_string()));
        let _ = fs::remove_file(&tmp);
        let manifest = got.unwrap();
        assert_eq!(qd::ecosystem::parse_atom_version(&manifest).unwrap(), latest);
        assert!(!qd::ecosystem::parse_atom_entrypoint(&manifest).unwrap().is_empty());
    }

    #[test]
    fn download_remote_reads_through_system_curl() {
        let dir = std::env::temp_dir().join(format!("notelume-dl-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let src = dir.join("src.txt");
        fs::write(&src, b"payload").unwrap();
        let dest = dir.join("dest.txt");
        download_remote(&format!("file://{}", src.to_string_lossy()), &dest).unwrap();
        assert_eq!(fs::read(&dest).unwrap(), b"payload");
        let _ = fs::remove_dir_all(&dir);
    }

    #[test]
    fn extract_wikilinks_basic() {
        let s = "see [[A]] and [[B|alias]] and nested [[C]] [[B]]";
        let mut v = extract_wikilinks(s);
        v.sort();
        v.dedup();
        assert_eq!(v, vec!["A", "B", "C"]);
    }

    // 批次 E（L）只读链路：用 git2 裸 API 造一个含首提交的临时库，验证 open/status/log/diff
    #[test]
    fn git_readonly_status_log_diff() {
        use git2::Signature;
        let tmp = std::env::temp_dir().join(format!("notelume-git-ro-{}", std::process::id()));
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(&tmp).unwrap();
        let repo = git2::Repository::init(&tmp).unwrap();
        let file = tmp.join("a.md");
        fs::write(&file, "line1\nline2\n").unwrap();
        {
            let mut idx = repo.index().unwrap();
            idx.add_path(std::path::Path::new("a.md")).unwrap();
            idx.write().unwrap();
            let tree_id = idx.write_tree().unwrap();
            let tree = repo.find_tree(tree_id).unwrap();
            let sig = Signature::now("Tester", "tester@example.com").unwrap();
            repo.commit(Some("HEAD"), &sig, &sig, "init commit", &tree, &[])
                .unwrap();
        }
        let root = tmp.to_string_lossy().to_string();

        // git_open
        let info = git_open(root.clone()).unwrap();
        assert!(info.is_repo);
        assert!(info.has_head);

        // 刚提交完工作树干净：a.md 不应为 untracked/modified
        let clean = git_status(root.clone()).unwrap();
        assert!(clean
            .iter()
            .all(|f| !(f.path == "a.md" && (f.kind == "modified" || f.kind == "untracked"))));

        // git_log 一条
        let log = git_log(root.clone(), None).unwrap();
        assert_eq!(log.len(), 1);
        assert_eq!(log[0].summary, "init commit");
        assert_eq!(log[0].author_email, "tester@example.com");

        // 改 a.md + 新增 b.md → status
        fs::write(&file, "line1\nline2 changed\n").unwrap();
        fs::write(tmp.join("b.md"), "new\n").unwrap();
        let st = git_status(root.clone()).unwrap();
        assert!(st.iter().any(|f| f.path == "a.md" && f.kind == "modified"));
        assert!(st.iter().any(|f| f.path == "b.md" && f.kind == "untracked"));

        // diff a.md vs HEAD 含增删行
        let d = git_diff_file(
            root.clone(),
            DiffFileArgs { path: "a.md".into(), against: "HEAD".into() },
        )
        .unwrap();
        assert!(d.contains("+line2 changed"));
        assert!(d.contains("-line2"));

        // diff 未跟踪 b.md vs HEAD 含新增
        let db = git_diff_file(
            root.clone(),
            DiffFileArgs { path: "b.md".into(), against: "HEAD".into() },
        )
        .unwrap();
        assert!(db.contains("+new"));

        // against=首提交 id，无父 → 对空树全为新增
        let cid = log[0].id.clone();
        let dc = git_diff_file(
            root.clone(),
            DiffFileArgs { path: "a.md".into(), against: cid },
        )
        .unwrap();
        assert!(dc.contains("+line1"));

        let _ = fs::remove_dir_all(&tmp);
    }

    // 批次 E（L）写链路：git_init + gitignore seeding + git_commit_all 回环
    #[test]
    fn git_write_commit_roundtrip() {
        let tmp = std::env::temp_dir().join(format!("notelume-git-wt-{}", std::process::id()));
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(&tmp).unwrap();
        let root = tmp.to_string_lossy().to_string();

        // init：应创建仓库并写 .gitignore（含 .notelume-backup/）
        let info = git_init(root.clone()).unwrap();
        assert!(info.is_repo);
        let gi = tmp.join(".gitignore");
        assert!(gi.exists());
        assert!(fs::read_to_string(&gi).unwrap().contains(".notelume-backup/"));
        // .gitignore 已存在时 init 不覆盖
        fs::write(&gi, "custom\n").unwrap();
        git_init(root.clone()).unwrap();
        assert_eq!(fs::read_to_string(&gi).unwrap(), "custom\n");
        fs::write(&gi, ".notelume-backup/\n").unwrap();

        // 传显式 name/email 提交（首提交）
        fs::write(tmp.join("a.md"), "hello\n").unwrap();
        let r = git_commit_all(
            root.clone(),
            CommitArgs {
                message: "first".into(),
                name: Some("W".into()),
                email: Some("w@e.com".into()),
            },
        )
        .unwrap();
        assert_eq!(r.id.chars().count(), 40);

        // 提交后 log 有 1 条；身份已回写本地配置（再读应 Some）
        let log = git_log(root.clone(), None).unwrap();
        assert_eq!(log.len(), 1);
        assert_eq!(log[0].summary, "first");
        assert!(git_config_identity(root.clone()).unwrap().is_some());

        // status 应干净（a.md 已入库）
        let st = git_status(root.clone()).unwrap();
        assert!(!st.iter().any(|f| f.path == "a.md"));

        // 无改动再提交 → 拒
        let dup = git_commit_all(
            root.clone(),
            CommitArgs { message: "noop".into(), name: None, email: None },
        );
        assert!(dup.is_err(), "无改动应拒绝");

        // 空消息 → 拒
        fs::write(tmp.join("b.md"), "x\n").unwrap();
        let empty = git_commit_all(
            root.clone(),
            CommitArgs { message: "   ".into(), name: None, email: None },
        );
        assert!(empty.is_err(), "空消息应拒绝");

        // 第二次提交（复用已配置身份，不传 name/email）
        let r2 = git_commit_all(
            root.clone(),
            CommitArgs { message: "second".into(), name: None, email: None },
        )
        .unwrap();
        assert!(!r2.id_short.is_empty());
        assert_eq!(git_log(root.clone(), None).unwrap().len(), 2);

        let _ = fs::remove_dir_all(&tmp);
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

    /// 回归：链接/图片目标里的 `#锚点` 不得被当成标签（交叉引用导入会大量产生 `(#_Ref…)`/`(#slug)`，
    /// 否则每个内部锚点都会往标签面板灌一个幽灵标签）；而止于链接外的真标签仍须计入。
    #[test]
    fn extract_tags_skips_anchor_in_link_destination() {
        let s = "见 [52](#_Ref206499018) 与 [标题](#第-1-章) 及 ![](media/a.png#_Toc1) \n\
                 带角尖括号 [x](<#_Toc2>) 也不算\n\
                 但正文里的 #work 和 [#tag文本](https://a.b) 仍是标签";
        let mut v = extract_tags(s);
        v.sort();
        assert_eq!(v, vec!["tag文本", "work"], "锚点 href 不应入标签，真标签应保留");
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
        // 不存在的文件被拒
        assert!(delete_file(root.clone(), "ghost.md".to_string()).is_err());
        // 两条拒绝均在调用回收站前就返回 Err，note.md 应仍在原处
        assert!(tmp.join("note.md").exists());
        // 注：成功路径（文件 / 目录）会真的移入系统回收站，为避免污染用户回收站，
        // happy path 交由手动验证；目录删除由界面入口（文件夹右键「移入回收站」）手动覆盖

        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn missing_file_reports_plain_words() {
        let tmp = std::env::temp_dir().join(format!("notelume-gone-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(&tmp).unwrap();
        let root = tmp.to_string_lossy().to_string();
        let err = abs_in_vault(&root, "ghost.md").unwrap_err();
        // 取词按界面语言走（测试进程里语言可能被别的用例设过），只锁两点：带路径、不带 errno 原文
        assert!(err.contains("ghost.md"), "{err}");
        assert!(!err.contains("os error"), "{err}");

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
    fn index_doc_into_keeps_keys_vault_relative_and_drops_outside() {
        let tmp = std::env::temp_dir().join(format!("notelume-idx-guard-{}", std::process::id()));
        let root = tmp.join("vault");
        let outside = tmp.join("outside.md");
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(root.join("sub")).unwrap();
        fs::write(root.join("a.md"), "# a\n").unwrap();
        fs::write(root.join("sub").join("b.md"), "# b\n").unwrap();
        fs::write(&outside, "# outside\n").unwrap();

        let entry = |path: &str| DocEntry {
            path: path.into(),
            title: path.into(),
            tags: vec![],
            outgoing: vec![],
            unresolved: vec![],
            content: String::new(),
        };
        let mut idx = VaultIndex::default();
        idx.ready = true;
        idx.vault_root = fs::canonicalize(&root).unwrap().to_string_lossy().into_owned();

        // 库内相对键原样入索引
        index_doc_into(&mut idx, "sub/b.md", "# b\n");
        assert!(idx.docs.contains_key("sub/b.md"));

        // 库内绝对路径归一成相对键，不另起一条绝对键
        let abs_in = root.join("a.md").to_string_lossy().into_owned();
        index_doc_into(&mut idx, &abs_in, "# a\n");
        assert!(idx.docs.contains_key("a.md"));
        assert!(!idx.docs.contains_key(&abs_in));

        // 库外绝对路径（/tmp 下的临时稿）不入索引
        let abs_out = outside.to_string_lossy().into_owned();
        index_doc_into(&mut idx, &abs_out, "# outside\n");
        assert!(!idx.docs.contains_key(&abs_out));
        assert!(!idx.docs.contains_key("outside.md"));

        // 老版本已经写进索引的库外键：同一路径再更新时顺手清掉
        idx.docs.insert(abs_out.clone(), entry(&abs_out));
        index_doc_into(&mut idx, &abs_out, "# outside\n");
        assert!(!idx.docs.contains_key(&abs_out));

        // `..` 越界与非 md 同样拒绝
        index_doc_into(&mut idx, "../outside.md", "# x\n");
        index_doc_into(&mut idx, "sub/../a.md", "# x\n");
        index_doc_into(&mut idx, "notes.txt", "x");
        assert!(!idx.docs.contains_key("../outside.md"));
        assert!(!idx.docs.contains_key("sub/../a.md"));
        assert!(!idx.docs.contains_key("notes.txt"));
        assert!(!idx.docs.iter().any(|(k, _)| k.contains("outside")));

        let _ = fs::remove_dir_all(&tmp);
    }

    #[cfg(unix)]
    #[test]
    fn index_scan_skips_symlinks_leading_outside_vault() {
        use std::os::unix::fs::symlink;
        let tmp = std::env::temp_dir().join(format!("notelume-idx-symlink-{}", std::process::id()));
        let root = tmp.join("vault");
        let outside = tmp.join("outside");
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(&root).unwrap();
        fs::create_dir_all(&outside).unwrap();
        fs::write(root.join("a.md"), "# a\n").unwrap();
        fs::write(outside.join("secret.md"), "# secret\n").unwrap();
        symlink(&outside, root.join("linkdir")).unwrap();
        symlink(outside.join("secret.md"), root.join("linkfile.md")).unwrap();

        // 全量扫描只收库内真实文件；顺着链接会读到库外内容却挂在库内键下
        let mut paths = Vec::new();
        collect_md_paths(&root, "", 0, &mut paths);
        assert_eq!(paths, vec!["a.md".to_string()]);

        // 按文件名解析 wikilink 也不穿链接
        assert_eq!(find_md_by_basename(&root, "a", 0).as_deref(), Some("a.md"));
        assert_eq!(find_md_by_basename(&root, "secret", 0), None);
        assert_eq!(find_md_by_basename(&root, "linkfile", 0), None);

        let _ = fs::remove_dir_all(&tmp);
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
    fn import_vault_file_writes_sanitizes_and_rejects_escape() {
        let tmp = std::env::temp_dir().join(format!("notelume-import-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(&tmp).unwrap();
        let root = tmp.to_string_lossy().to_string();
        let b64 = "aGVsbG8=".to_string(); // "hello"

        // 库根导入
        let r = import_vault_file(root.clone(), ImportArgs { dest_dir_rel: "".into(), name: "note.md".into(), data_base64: b64.clone() }).unwrap();
        assert_eq!(r, "note.md");
        assert_eq!(fs::read_to_string(tmp.join("note.md")).unwrap(), "hello");
        // 指定子目录（不存在则创建）；name 带外部绝对路径 → 只取末段
        let r2 = import_vault_file(root.clone(), ImportArgs { dest_dir_rel: "sub".into(), name: "c:/x/y/pic.png".into(), data_base64: b64.clone() }).unwrap();
        assert_eq!(r2, "sub/pic.png");
        assert!(tmp.join("sub").join("pic.png").exists());
        // dest_dir 借 .. 越界 → 拒
        assert!(import_vault_file(root.clone(), ImportArgs { dest_dir_rel: "../out".into(), name: "a.md".into(), data_base64: b64.clone() }).is_err());
        // name 只取到 .. → 拒
        assert!(import_vault_file(root.clone(), ImportArgs { dest_dir_rel: "".into(), name: "../..".into(), data_base64: b64.clone() }).is_err());

        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn collect_all_tags_counts_sorts_and_query_tag_matches() {
        let mut idx = VaultIndex::default();
        idx.docs.insert(
            "a.md".into(),
            DocEntry { path: "a.md".into(), title: "A".into(), tags: vec!["x".into(), "Y".into()], outgoing: vec![], unresolved: vec![], content: String::new() },
        );
        idx.docs.insert(
            "b.md".into(),
            DocEntry { path: "b.md".into(), title: "B".into(), tags: vec!["x".into()], outgoing: vec![], unresolved: vec![], content: String::new() },
        );
        let v = collect_all_tags(&idx);
        // x 出现 2 次排前，Y 一次
        assert_eq!(v, vec![("x".to_string(), 2), ("Y".to_string(), 1)]);
        // 查询忽略大小写与前缀 #
        assert_eq!(collect_docs_by_tag(&idx, "#X").len(), 2);
        let y = collect_docs_by_tag(&idx, "y");
        assert_eq!(y.iter().map(|d| d.path.as_str()).collect::<Vec<_>>(), vec!["a.md"]);
        assert!(collect_docs_by_tag(&idx, "nope").is_empty());
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
    fn list_and_read_plugins_folder_packages() {
        let tmp = std::env::temp_dir().join(format!("notelume-plugin-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&tmp);
        let dir = tmp.join(".notelume-plugins");
        let hello = dir.join("hello");
        fs::create_dir_all(&hello).unwrap();
        fs::write(hello.join("manifest.json"), "{\"id\":\"hello\",\"name\":\"Hello\"}").unwrap();
        fs::write(hello.join("main.js"), "export default { id: 'hello' }").unwrap();
        // 顶层游离 .js → legacyFlat；非 js 忽略
        fs::write(dir.join("stale.js"), "// old").unwrap();
        fs::write(dir.join("notes.txt"), "ignored").unwrap();
        let root_str = tmp.to_string_lossy().to_string();

        let list = list_plugins(root_str.clone()).unwrap();
        assert_eq!(list.packages.len(), 1, "只列一级子目录");
        assert_eq!(list.packages[0].dir_name, "hello");
        assert!(list.packages[0].manifest_raw.contains("hello"));
        assert_eq!(
            list.packages[0].manifest_path,
            ".notelume-plugins/hello/manifest.json"
        );
        assert!(list.packages[0].main_exists);
        assert_eq!(list.legacy_flat, vec!["stale.js".to_string()]);

        // <id>/<相对> 内可读
        let src =
            read_plugin(root_str.clone(), ".notelume-plugins/hello/main.js".to_string()).unwrap();
        assert!(src.contains("hello"));
        // 库外 / 穿越被拒
        assert!(read_plugin(root_str.clone(), "secret.js".to_string()).is_err());
        assert!(read_plugin(
            root_str.clone(),
            ".notelume-plugins/../../escape.js".to_string()
        )
        .is_err());

        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn sniff_image_mime_detects_magic_then_ext() {
        assert_eq!(sniff_image_mime(&[0x89, b'P', b'N', b'G', 1, 2], "https://x/a"), Some("image/png"));
        assert_eq!(sniff_image_mime(&[0xFF, 0xD8, 0xFF, 0xE0], "https://x/a.bin"), Some("image/jpeg"));
        assert_eq!(sniff_image_mime(b"RIFF1234WEBPVP8 ", "https://x/a"), Some("image/webp"));
        assert_eq!(sniff_image_mime(b"  <svg xmlns>", "https://x/a"), Some("image/svg+xml"));
        // 魔数不认识时按扩展名兜底；两处都不认识返回 None
        assert_eq!(sniff_image_mime(b"???", "https://x/pic.avif"), Some("image/avif"));
        assert_eq!(sniff_image_mime(b"???", "https://x/pic.txt"), None);
    }

    #[test]
    fn fetch_remote_image_rejects_non_http_scheme() {
        assert!(fetch_remote_image_data_uri("data:image/png;base64,AAAA".into()).is_err());
        assert!(fetch_remote_image_data_uri("./assets/x.png".into()).is_err());
        assert!(fetch_remote_image_data_uri("javascript:alert(1)".into()).is_err());
    }

    #[test]
    fn save_image_from_data_uri_decodes_and_writes() {
        let tmp = std::env::temp_dir().join(format!("notelume-save-img-{}.png", std::process::id()));
        let _ = fs::remove_file(&tmp);
        // "QUJD" == "ABC"
        save_image_from_data_uri(tmp.to_string_lossy().to_string(), "data:image/png;base64,QUJD".into()).unwrap();
        assert_eq!(fs::read(&tmp).unwrap(), b"ABC");
        let _ = fs::remove_file(&tmp);

        // 非 data URI、空 payload 要报错且不落文件
        let bad = std::env::temp_dir().join(format!("notelume-save-img-bad-{}.png", std::process::id()));
        assert!(save_image_from_data_uri(bad.to_string_lossy().to_string(), "https://x/a.png".into()).is_err());
        assert!(save_image_from_data_uri(bad.to_string_lossy().to_string(), "data:image/png;base64,".into()).is_err());
        assert!(!bad.exists());
    }

    #[test]
    fn looks_like_image_accepts_known_magics_and_rejects_garbage() {
        let png = b"\x89PNG\r\n\x1a\nrest".to_vec();
        assert!(looks_like_image(&png)); // PNG
        assert!(looks_like_image(&[0xFF, 0xD8, 0xFF, 0xE0, 0x00])); // JPEG
        assert!(looks_like_image(b"GIF89a0102"));
        assert!(looks_like_image(b"GIF87a0102"));
        assert!(looks_like_image(b"RIFF\x24\x00\x00\x00WEBPVP8 ")); // WebP
        assert!(looks_like_image(b"BM\x36\x00\x00\x00")); // BMP
        assert!(looks_like_image(&[0x00, 0x00, 0x01, 0x00, 0x01])); // ICO
        // SVG 是文本，但要真以 <svg / <?xml（可带 BOM 与前导空白）开头
        assert!(looks_like_image(b"<svg xmlns=\"http://www.w3.org/2000/svg\"></svg>"));
        assert!(looks_like_image("\u{feff}  <?xml version=\"1.0\"?><svg/>".as_bytes()));
        assert!(!looks_like_image(b"<?xml-stylesheet?>")); // xml 指令但不是 svg 文档
        // 文本 / 随机字节 / 空文件都拒绝
        assert!(!looks_like_image(b"hello, definitely not an image"));
        assert!(!looks_like_image(&[0x01, 0x02, 0x03, 0x04]));
        assert!(!looks_like_image(b""));
    }

    #[test]
    fn copy_image_asset_rejects_non_image_content() {
        let tmp = std::env::temp_dir().join(format!("notelume-fake-img-{}", std::process::id()));
        let _ = fs::remove_dir_all(&tmp);
        let doc_dir = tmp.join("notes");
        fs::create_dir_all(&doc_dir).unwrap();
        let fake = tmp.join("fake.png");
        fs::write(&fake, b"plain text pretending to be a png").unwrap();
        let root = tmp.to_string_lossy().to_string();

        let err = copy_image_asset(root.clone(), "notes/a.md".into(), fake.to_string_lossy().to_string()).unwrap_err();
        assert!(err.contains("不是有效的图片文件"), "错误应是「不是有效的图片文件」，实得：{err}");
        // 不落任何副本
        assert!(!doc_dir.join("assets").join("fake.png").exists());

        // 真 PNG 魔数的文件照常入库（只写 8 字节头，不校验完整性）
        let real = tmp.join("real.png");
        fs::write(&real, b"\x89PNG\r\n\x1a\npayload").unwrap();
        let rel = copy_image_asset(root, "notes/a.md".into(), real.to_string_lossy().to_string()).unwrap();
        assert_eq!(rel, "./assets/real.png");
        assert!(doc_dir.join("assets").join("real.png").exists());
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
    fn scan_includes_canvas_and_images_but_not_text() {
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
        // 图片附件已入树（见「图片入树」特性：scan_dir 白名单含 is_image）
        assert!(names.contains(&"pic.png".to_string()), "图片应进文件树");

        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn build_site_graph_resolves_wikilinks_and_titles() {
        let tmp = std::env::temp_dir().join(format!("notelume-sitegraph-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&tmp);
        fs::create_dir_all(tmp.join("sub")).unwrap();
        fs::write(tmp.join("index.md"), "# 首页\n[[target]] [[sub/target2|别名]] [[缺失]]\n").unwrap();
        fs::write(tmp.join("target.md"), "# T\n").unwrap();
        fs::write(tmp.join("sub").join("target2.md"), "# T2\n").unwrap();
        let root_str = tmp.to_string_lossy().to_string();

        let g = build_site_graph(root_str.clone()).unwrap();
        assert_eq!(g.docs.len(), 3);
        let idx = g.docs.iter().find(|d| d.rel == "index.md").unwrap();
        assert_eq!(idx.title, "首页");
        let w_of = |target: &str| g.wiki.iter().find(|w| w.from == "index.md" && w.target == target).map(|w| w.to.clone());
        // basename 回退（库根文件）→ target.md；路径式 → sub/target2.md；解析不到 → None
        assert_eq!(w_of("target").flatten().as_deref(), Some("target.md"));
        assert_eq!(w_of("sub/target2").flatten().as_deref(), Some("sub/target2.md"));
        assert_eq!(w_of("缺失"), Some(None));
        // 同文档重复 target 只一条：index.md 共 3 条
        assert_eq!(g.wiki.iter().filter(|w| w.from == "index.md").count(), 3);

        let _ = fs::remove_dir_all(&tmp);
    }

    #[test]
    fn copy_vault_assets_mirrors_and_skips_missing_and_tolerates_escape() {
        let tmp = std::env::temp_dir().join(format!("notelume-copyassets-test-{}", std::process::id()));
        let out = std::env::temp_dir().join(format!("notelume-copyassets-out-{}", std::process::id()));
        let _ = fs::remove_dir_all(&tmp);
        let _ = fs::remove_dir_all(&out);
        fs::create_dir_all(tmp.join("assets")).unwrap();
        fs::write(tmp.join("assets").join("x.png"), b"PNGDATA").unwrap();
        let root_str = tmp.to_string_lossy().to_string();
        let out_str = out.to_string_lossy().to_string();

        // 正常：镜像相对路径
        copy_vault_assets(root_str.clone(), CopyAssetsArgs { rels: vec!["assets/x.png".into()], out_dir: out_str.clone() }).unwrap();
        assert_eq!(fs::read(out.join("assets").join("x.png")).unwrap(), b"PNGDATA");
        // 缺失资源：跳过、不报错、不写出
        copy_vault_assets(root_str.clone(), CopyAssetsArgs { rels: vec!["assets/ghost.png".into()], out_dir: out_str.clone() }).unwrap();
        assert!(!out.join("assets").join("ghost.png").exists());
        // .. 逃逸：源侧 abs_in_vault 拒绝 → 跳过（不写出、不报错）
        copy_vault_assets(root_str.clone(), CopyAssetsArgs { rels: vec!["../outside.png".into()], out_dir: out_str.clone() }).unwrap();

        let _ = fs::remove_dir_all(&tmp);
        let _ = fs::remove_dir_all(&out);
    }

    // ===== 批次 E（子项目 R1）远程骨架单测已重搬到 git_builtin::system::tests（Phase 2） =====

    #[test]
    fn menu_spec_accepts_frontend_shape() {
        // 前端 buildMacMenuSpec 的真实形态：cmd / check / sep / role / 嵌套 submenu 五类条目
        let spec: MenuSpec = serde_json::from_str(
            r#"{"groups":[{"id":"file","text":"文件","items":[
                {"type":"cmd","id":"app.save","text":"保存当前文件","accelerator":"Cmd+S","enabled":false},
                {"type":"sep"},
                {"type":"check","id":"app.autosave","text":"自动保存","checked":true},
                {"type":"submenu","id":"recent","text":"打开最近","dynamic":"recents","items":[
                    {"type":"cmd","id":"recent:0","text":"a.md"}]},
                {"type":"role","role":"CloseWindow"}
            ]}]}"#,
        )
        .unwrap();
        assert_eq!(spec.groups.len(), 1);
        assert_eq!(spec.groups[0].text, "文件");
        let items = &spec.groups[0].items;
        assert_eq!(items.len(), 5);
        assert_eq!(items[0].accelerator.as_deref(), Some("Cmd+S"));
        assert_eq!(items[0].enabled, Some(false));
        assert_eq!(items[1].kind, "sep");
        assert_eq!(items[2].checked, Some(true));
        assert_eq!(items[3].items.len(), 1);
        assert_eq!(items[4].role.as_deref(), Some("CloseWindow"));
    }

    #[test]
    fn menu_spec_rejects_missing_group_text_and_maps_window_id() {
        // 组缺 text 是契约错误，要在装配前以 Err 形式回给前端而不是 panic
        let bad: Result<MenuSpec, _> = serde_json::from_str(r#"{"groups":[{"id":"file"}]}"#);
        assert!(bad.is_err());
        assert_eq!(native_group_id("window"), tauri::menu::WINDOW_SUBMENU_ID);
        assert_eq!(native_group_id("file"), "file");
    }

    #[test]
    fn menu_spec_gives_roles_a_text() {
        // 角色项带 text 时标题由前端给（mac 上「剪切/退出」是固定译法），不带则退回 muda 默认英文
        let spec: MenuSpec = serde_json::from_str(
            r#"{"groups":[{"id":"edit","text":"编辑","items":[
                {"type":"role","role":"Cut","text":"剪切"},
                {"type":"role","role":"Quit"}
            ]}]}"#,
        )
        .unwrap();
        let items = &spec.groups[0].items;
        assert_eq!(items[0].text.as_deref(), Some("剪切"));
        assert_eq!(items[1].text, None);
    }
}

// ==================== macOS 菜单栏状态图标（NSStatusItem + NSMenu，经 Tauri tray 落地）====================

/// 组装托盘菜单：显示主窗口 / 新建笔记 / 打开最近（子菜单，按 recent 动态生成）/ 退出。
/// 「打开最近」项 id 形如 `recent:<绝对路径>`，点击时 on_menu_event 取路径 emit 给前端。
#[cfg(target_os = "macos")]
fn build_tray_menu(
    app: &tauri::AppHandle,
    recent: &[String],
) -> Result<tauri::menu::Menu<tauri::Wry>, String> {
    use tauri::menu::{MenuBuilder, MenuItemBuilder, PredefinedMenuItem, SubmenuBuilder};
    let show = MenuItemBuilder::with_id("show", ui_msg!("trayShow")).build(app).map_err(|e| e.to_string())?;
    let new_note = MenuItemBuilder::with_id("new", ui_msg!("trayNewNote")).build(app).map_err(|e| e.to_string())?;

    let mut sub = SubmenuBuilder::new(app, ui_msg!("trayOpenRecent"));
    if recent.is_empty() {
        let none = MenuItemBuilder::with_id("recent:none", ui_msg!("trayNoRecent"))
            .enabled(false)
            .build(app)
            .map_err(|e| e.to_string())?;
        sub = sub.item(&none);
    } else {
        for (i, p) in recent.iter().enumerate() {
            let name = std::path::Path::new(p).file_name().and_then(|s| s.to_str()).unwrap_or(p);
            // id 用下标：点击回传下标，前端据此在「最近打开」列表取条目打开
            let item = MenuItemBuilder::with_id(format!("recent:{i}"), name)
                .build(app)
                .map_err(|e| e.to_string())?;
            sub = sub.item(&item);
        }
    }
    let recent_sub = sub.build().map_err(|e| e.to_string())?;
    let sep = PredefinedMenuItem::separator(app).map_err(|e| e.to_string())?;
    let quit = MenuItemBuilder::with_id("quit", ui_msg!("trayQuit")).build(app).map_err(|e| e.to_string())?;

    MenuBuilder::new(app)
        .items(&[&show, &new_note, &recent_sub, &sep, &quit])
        .build()
        .map_err(|e| e.to_string())
}

/// 建状态栏图标并挂菜单：左键点图标唤主窗口，右键弹菜单。tray 存入 state 供刷新「打开最近」。
#[cfg(target_os = "macos")]
fn build_tray(app: &tauri::AppHandle) -> Result<(), String> {
    use tauri::Manager;
    use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
    let menu = build_tray_menu(app, &[])?;
    let tray = TrayIconBuilder::new()
        .icon(tauri::include_image!("icons/32x32.png"))
        .tooltip("NoteLume")
        .menu(&menu)
        // 左键不弹菜单，统一唤窗口；菜单走右键（mac 上 Ctrl+点亦可）
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| {
            use tauri::{Emitter, Manager};
            let id = event.id().as_ref();
            if id == "show" || id == "new" {
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.show();
                    let _ = w.set_focus();
                }
                let _ = app.emit("notelume://menu-action", id);
            } else if id == "quit" {
                // 走窗口关闭，触发前端未保存询问（core:window:allow-destroy 链路）
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.close();
                }
            } else if let Some(idx) = id.strip_prefix("recent:") {
                if idx != "none" {
                    if let Some(w) = app.get_webview_window("main") {
                        let _ = w.show();
                        let _ = w.set_focus();
                    }
                    let _ = app.emit("notelume://menu-open", idx);
                }
            }
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                let app = tray.app_handle();
                if let Some(w) = app.get_webview_window("main") {
                    let _ = w.show();
                    let _ = w.set_focus();
                }
            }
        })
        .build(app)
        .map_err(|e| e.to_string())?;
    app.manage(tray);
    Ok(())
}

/// 前端上报当前界面语言（启动与切换语言时调用）。词表见 ui_lang.rs，
/// 未知 id 返回 false（前端传入的总是 LOCALES 里的 id）。
#[tauri::command]
fn set_ui_lang(lang: String) -> bool {
    ui_lang::set_lang(&lang)
}

// ==================== P5 §6.6 文件打开链路 ====================
//
// 四条入口汇到一条交付通道（deliver_open_targets）：
//  · 启动参数（`note.exe x.md`，Windows 双击关联文件同条）：setup 前收进 LaunchPaths，前端
//    boot 时经 take_launch_paths 取走。这里不用事件推是防竞态——setup 执行时页面 JS 还没
//    跑起来，emit 出去没人听；拉取式没有时序问题。
//  · macOS LaunchServices：双击关联文件、右键「打开方式」、把文件拖到 Dock 图标。
//    路径只经 application:openURLs: 递来、不进 argv，要 run callback 接 RunEvent::Opened，
//    不接就只剩「唤起应用、文件没打开」。
//  · 单实例二次唤起：第二个进程把新路径交给第一个进程的 argv 回调。
//  · 拖入窗口：桌面版由 wry 原生事件递绝对路径（HTML5 的 drop 在拦截下收不到），前端按平台
//    补类型后分流——文件走同一套 openAbsPath，文件夹另开一个窗口（open_vault_window）；
//    纯 web 构建没有事件通道，走 HTML5 的 DataTransfer。
// 交付通道只做两件事：目标排进 LaunchPaths，再 emit 一次 file-opened 叫前端来取。
// 两条都不能省：冷启动时前端监听未必就绪，排着等它 boot 来取；应用常驻时前端不再主动
// 取，得靠这次 emit 叫醒。emit 不带路径（同一条走队列只出一份，不会开两遍）。

/// 启动 / 二次唤起的参数里挑出真实存在的文件或目录。exe 自身按路径比对剔除
/// （不按位置 skip：std::env::args 与单实例插件的 argv 首元素是否 exe 并不保证）；
/// `-` 开头的是 CLI 开关，不要。
fn launch_targets<I: IntoIterator<Item = String>>(argv: I) -> Vec<LaunchTarget> {
    let argv: Vec<String> = argv.into_iter().collect();
    // argv 首元素是「递来这份参数的那个进程」自己的 exe：冷启动时它就是本机 current_exe，
    // 单实例二次唤起时它是另一条路径上的同一份应用（多份拷贝、.app 内外各一份）。
    // 只比 current_exe 会漏掉后者，于是把应用二进制当文档递出去——前端弹
    // 「notelume 不是 Markdown 或画布文件」，点开后只剩「stream did not contain valid UTF-8」。
    let sender = argv.first().cloned();
    let exe = std::env::current_exe().ok().map(|p| p.to_string_lossy().to_string());
    launch_targets_with_exe(argv, exe)
        .into_iter()
        .filter(|t| !sender.as_deref().is_some_and(|s| same_path(s, &t.path)))
        .collect()
}

/// 与 launch_targets 同，exe 路径由调用方给（测试注入；生产传 current_exe()）。
fn launch_targets_with_exe<I: IntoIterator<Item = String>>(argv: I, exe: Option<String>) -> Vec<LaunchTarget> {
    argv.into_iter()
        .filter(|a| !a.is_empty() && !a.starts_with('-'))
        .filter(|a| exe.as_deref().map_or(true, |e| !same_path(e, a)))
        .filter_map(|a| {
            let p = Path::new(&a);
            // 只收普通文件与目录：存在但既不是文件也不是目录的（管道等）跳过
            if p.is_dir() {
                Some(LaunchTarget { path: a, is_dir: true })
            } else if p.is_file() {
                Some(LaunchTarget { path: a, is_dir: false })
            } else {
                None
            }
        })
        .collect()
}

/// 仅用于剔除 exe 自身。先 canonicalize（消相对路径、符号链接与 8.3 短名），
/// 失败（文件不存在等）退回归一化字符串：容分隔符、大小写（Windows 路径大小写
/// 不敏感）与 `\\?\` verbatim 前缀之差——current_exe() 在 Windows 上可能带这个
/// 前缀而 argv 里不带，纯字符串比对会把 exe 自身漏过去，前端就弹
/// 「notelume.exe 不是 Markdown 或画布文件」。
fn same_path(a: &str, b: &str) -> bool {
    if let (Some(pa), Some(pb)) = (std::fs::canonicalize(a).ok(), std::fs::canonicalize(b).ok()) {
        let na = pa.to_string_lossy().replace('\\', "/");
        let nb = pb.to_string_lossy().replace('\\', "/");
        #[cfg(target_os = "windows")]
        let (na, nb) = (na.to_lowercase(), nb.to_lowercase());
        return na == nb
    }
    let strip_verbatim = |s: &str| match s.replace('\\', "/").strip_prefix("//?/") {
        Some(rest) => rest.to_string(),
        None => s.replace('\\', "/"),
    };
    let (na, nb) = (strip_verbatim(a), strip_verbatim(b));
    #[cfg(target_os = "windows")]
    let (na, nb) = (na.to_lowercase(), nb.to_lowercase());
    na == nb
}

/// 打开目标：文件按文档开，目录按知识库开（is_dir 让前端不必再查一次文件系统）
#[derive(serde::Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct LaunchTarget {
    path: String,
    is_dir: bool,
}

#[derive(Default)]
struct LaunchPaths(std::sync::Mutex<Vec<LaunchTarget>>);

/// 前端 boot 时取走启动参数（取后即清：刷新页面不会重复打开同一文件）
#[tauri::command]
fn take_launch_paths(app: tauri::AppHandle) -> Vec<LaunchTarget> {
    use tauri::Manager;
    match app.try_state::<LaunchPaths>() {
        Some(s) => s.0.lock().map(|mut v| std::mem::take(&mut *v)).unwrap_or_default(),
        None => Vec::new(),
    }
}

// —— 拖入文件夹 → 另开一个窗口 ——
// 库路径按「窗口标签 → 路径」暂存，新窗口 boot 时凭自己的标签取走。不塞进 URL query：
// 打包版走自定义协议加载前端，query 能不能透传到 location.search 取决于协议实现；
// 也不排进 LaunchPaths：那份队列全应用共享，新窗口 boot 会把主窗口待开的目标抢走。
#[derive(Default)]
struct WindowVaults(std::sync::Mutex<HashMap<String, String>>);

/// 新建一个窗口把 path 当知识库打开，返回窗口标签。
/// 索引与文件监听是应用级单份（IndexState / FsWatcherState），两窗口开两个库时后 boot 的
/// 那份接管：先开的窗口全文检索/反链会指到后开的库上，直到某个窗口重新扫描自己的库。
#[tauri::command]
fn open_vault_window(window: tauri::WebviewWindow, app: tauri::AppHandle, path: String) -> Result<String, String> {
    use std::sync::atomic::{AtomicUsize, Ordering};
    use tauri::{LogicalPosition, LogicalSize, Manager, WebviewUrl, WebviewWindowBuilder};
    static SEQ: AtomicUsize = AtomicUsize::new(2); // 主窗口算第 1 个
    if !Path::new(&path).is_dir() {
        return Err(ui_msg!("badPath"));
    }
    let label = format!("vault-{}", SEQ.fetch_add(1, Ordering::Relaxed));
    if let Some(state) = app.try_state::<WindowVaults>() {
        if let Ok(mut m) = state.0.lock() {
            m.insert(label.clone(), path);
        }
    }
    // 新窗口沿用拖入那个窗口的尺寸、往右下错开一格：同尺寸才看得出是「同一应用的另一个窗口」，
    // 完全重叠会把旧窗口整个盖住。取不到几何（异常平台状态）就退回 tauri.conf.json 的默认尺寸。
    let scale = window.scale_factor().unwrap_or(1.0);
    let size = window.outer_size().ok().map(|s| LogicalSize::new(s.width as f64 / scale, s.height as f64 / scale));
    let pos = window.outer_position().ok().map(|p| {
        let step = 40.0 * scale;
        LogicalPosition::new((p.x as f64 + step) / scale, (p.y as f64 + step) / scale)
    });
    let builder = WebviewWindowBuilder::new(&app, &label, WebviewUrl::App("index.html".into()))
        .title("NoteLume — Markdown 知识库编辑器")
        .inner_size(1240.0, 820.0)
        .min_inner_size(900.0, 600.0);
    let builder = match size {
        Some(s) => builder.inner_size(s.width, s.height),
        None => builder,
    };
    let builder = match pos {
        Some(p) => builder.position(p.x, p.y),
        None => builder.center(),
    };
    // 与主窗口同一套标题栏：mac 用 Overlay 保留红黄绿按钮，其余平台去边框由前端 .titlebar 顶替
    #[cfg(target_os = "macos")]
    let builder = builder.title_bar_style(tauri::TitleBarStyle::Overlay).hidden_title(true);
    #[cfg(not(target_os = "macos"))]
    let builder = builder.decorations(false);
    // 拖放通道与主窗口同口径：留着 Tauri 的原生拦截，拖入经 tauri://drag-* 事件递到前端
    // （前端按平台用 probe_external_drop / drop_path_is_dir 补类型，再落 handleDropTargets）。
    // 这个窗口由 Rust 建、不读 tauri.conf.json，默认就是启用，无需显式设置。
    let win = builder.build().map_err(|e| e.to_string())?;
    let _ = win.set_focus();
    Ok(label)
}

/// 新窗口 boot 时取自己该开的库（取后即清：刷新页面不重复打开）
#[tauri::command]
fn take_window_vault(window: tauri::WebviewWindow, app: tauri::AppHandle) -> Option<String> {
    use tauri::Manager;
    let state = app.try_state::<WindowVaults>()?;
    let mut m = state.0.lock().ok()?;
    m.remove(window.label())
}

/// 打开目标交给前端的唯一通道：排进队列 + 敲一次 file-opened（详见本节抬头）。
fn deliver_open_targets(app: &tauri::AppHandle, targets: Vec<LaunchTarget>) {
    use tauri::{Emitter, Manager};
    if targets.is_empty() {
        return;
    }
    if let Some(state) = app.try_state::<LaunchPaths>() {
        if let Ok(mut v) = state.0.lock() {
            v.extend(targets);
        }
    }
    let _ = app.emit("file-opened", ());
}

/// LaunchServices 递来的 URL → 打开目标：只收 file: 协议且当前真实存在的文件/目录，
/// 其余（http、已删的路径、非 file）逐项丢弃。to_file_path 负责 percent-解码，
/// 「打开方式」递的中文/空格文件名靠它才能还原成真实路径。
#[cfg_attr(not(target_os = "macos"), allow(dead_code))] // 生产路径只有 mac 的 RunEvent::Opened 调它，其余平台仅 launch_tests 引用
fn opened_targets(urls: &[tauri::Url]) -> Vec<LaunchTarget> {
    urls.iter()
        .filter_map(|u| u.to_file_path().ok())
        .filter_map(|p| {
            let path = p.to_string_lossy().to_string();
            if path.is_empty() {
                return None;
            }
            if p.is_dir() {
                Some(LaunchTarget { path, is_dir: true })
            } else if p.is_file() {
                Some(LaunchTarget { path, is_dir: false })
            } else {
                None
            }
        })
        .collect()
}

/// 应用设置文件路径：<app_config_dir>/settings.json。
/// app_config_dir 在 Windows 是 %APPDATA%\<identifier>，macOS 是
/// ~/Library/Application Support/<identifier>，由 Tauri 按 tauri.conf.json 的 identifier 定位。
fn settings_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    use tauri::Manager;
    let dir = app
        .path()
        .app_config_dir()
        .map_err(|e| format!("定位应用配置目录失败：{e}"))?;
    Ok(dir.join("settings.json"))
}

/// 读取 settings.json。文件不存在返回 Null（前端用代码里的默认值）；
/// 内容损坏也返回 Null 并打日志——启动链路不能因为一份坏设置就起不来，
/// 用户改回来的任何一次保存都会把坏内容覆盖掉。
#[tauri::command]
fn read_settings_json(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    let p = settings_path(&app)?;
    match fs::read_to_string(&p) {
        Ok(text) => match serde_json::from_str(&text) {
            Ok(v) => Ok(v),
            Err(e) => {
                eprintln!("NoteLume settings.json 解析失败，按默认值启动：{e}");
                Ok(serde_json::Value::Null)
            }
        },
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(serde_json::Value::Null),
        Err(e) => Err(format!("读取 settings.json 失败：{e}")),
    }
}

/// 写入 settings.json。先写同目录临时文件再 rename：写一半崩溃不会留下
/// 半截 JSON（下次启动 read 到坏内容只能整体回落默认值）。
#[tauri::command]
fn write_settings_json(app: tauri::AppHandle, settings: serde_json::Value) -> Result<(), String> {
    let p = settings_path(&app)?;
    if let Some(parent) = p.parent() {
        fs::create_dir_all(parent).map_err(|e| format!("创建配置目录失败：{e}"))?;
    }
    let text = serde_json::to_string_pretty(&settings).map_err(|e| e.to_string())?;
    let tmp = p.with_extension("json.tmp");
    fs::write(&tmp, text).map_err(|e| format!("写入 settings.json 失败：{e}"))?;
    fs::rename(&tmp, &p).map_err(|e| format!("替换 settings.json 失败：{e}"))?;
    Ok(())
}

/// 剪藏设置保存后调用：按新的 clip 段停旧起新本地 HTTP 服务。返回运行态
/// （含实际绑定端口与令牌——令牌可能是 Rust 侧现场生成的，前端要落回设置）。
#[tauri::command]
fn clip_server_apply(
    app: tauri::AppHandle,
    state: tauri::State<'_, webclip::ClipServerState>,
    clip: serde_json::Value,
) -> Result<webclip::ClipStatus, String> {
    webclip::apply(&app, &state, clip)
}

/// 查询剪藏服务运行态：{ running, port, token }。设置面板打开时拉一次。
#[tauri::command]
fn clip_server_status(state: tauri::State<'_, webclip::ClipServerState>) -> webclip::ClipStatus {
    webclip::status(&state)
}

/// 前端在「最近文件」变化时调用，重建「打开最近」子菜单。非 mac 为空操作。
#[tauri::command]
#[cfg_attr(not(target_os = "macos"), allow(unused_variables))]
fn tray_set_recent(app: tauri::AppHandle, paths: Vec<String>) {
    #[cfg(target_os = "macos")]
    {
        use tauri::Manager;
        if let Some(tray) = app.try_state::<tauri::tray::TrayIcon>() {
            if let Ok(menu) = build_tray_menu(&app, &paths) {
                // set_menu 收 Menu 本体（ContextMenu 不为 &Menu<R> 实现），不是建造器那样的引用
                let _ = tray.set_menu(Some(menu));
            }
        }
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // 启动参数先于窗口装配收好（P5 §6.6）：exe 路径本身已被 launch_targets 剔除
    let launch = launch_targets(std::env::args());
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        // 单实例（P5 §6.6）：第二个进程把新文件路径经本回调交给第一个进程。
        .plugin(tauri_plugin_single_instance::init(|app, argv, _cwd| {
            deliver_open_targets(app, launch_targets(argv));
        }))
        .manage(LaunchPaths(std::sync::Mutex::new(launch)))
        .manage(WindowVaults::default())
        .manage(IndexState(Arc::new(Mutex::new(VaultIndex::default()))))
        .manage(webclip::ClipServerState::default())
        .manage(fs_watcher::FsWatcherState::default())
        .setup(|app| {
            // 非 macOS：去掉原生标题栏，改由前端 .titlebar 顶替。
            // macOS 保留 Overlay（红黄绿按钮 + 透明标题条），不碰。
            #[cfg(not(target_os = "macos"))]
            {
                use tauri::Manager;
                if let Some(win) = app.get_webview_window("main") {
                    // 个别平台/合成器可能拒绝去边框，失败不致命，忽略
                    let _ = win.set_decorations(false);
                }
            }
            #[cfg(target_os = "macos")]
            {
                // 菜单栏状态图标（NSStatusItem + NSMenu）；创建失败不阻断启动，仅打日志
                if let Err(e) = build_tray(app.handle()) {
                    eprintln!("NoteLume 菜单栏图标创建失败：{e}");
                }
                // 先把原生菜单骨架挂上，别让 Tauri 默认的英文 File/Edit/View 顶在前端 push 之前
                if let Err(e) = install_bootstrap_menu(app.handle()) {
                    eprintln!("NoteLume 原生菜单骨架创建失败：{e}");
                }
            }
            // 网页剪藏：settings.json 的 clip 段启用时起本地 HTTP 服务（只绑 127.0.0.1）。
            // 端口全被占等失败不阻断启动，仅打日志——前端设置面板能看到未运行状态。
            {
                use tauri::Manager;
                let handle = app.handle();
                match read_settings_json(handle.clone()) {
                    Ok(v) => {
                        let cfg = webclip::clip_config_from_json(
                            v.get("clip").unwrap_or(&serde_json::Value::Null),
                        );
                        if cfg.enabled {
                            if let Err(e) = webclip::start(&handle, &handle.state::<webclip::ClipServerState>(), cfg) {
                                eprintln!("NoteLume 剪藏服务启动失败：{e}");
                            }
                        }
                    }
                    Err(e) => eprintln!("NoteLume settings.json 读取失败，剪藏服务未启动：{e}"),
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            // P0
            qd_eval,
            qd_package_install,
            drop_path_is_dir,
            open_external_url,
            reveal_in_folder,
            scan_vault,
            read_md_file,
            write_md_file,
            resolve_wiki_link,
            create_md_file,
            delete_file,
            create_dir,
            rename_item,
            import_vault_file,
            probe_external_drop,
            copy_image_asset,
            save_image_bytes,
            read_image_data_uri,
            fetch_remote_image_data_uri,
            save_image_from_data_uri,
            // 文件系统监听
            fs_watcher::start_vault_watcher,
            fs_watcher::stop_vault_watcher,
            // P1
            rebuild_index,
            get_index_status,
            query_backlinks,
            query_outgoing,
            get_doc_info,
            search_vault,
            list_all_tags,
            query_tag,
            doc_preview,
            update_index_doc,
            remove_index_doc,
            backup_write,
            list_backups,
            read_backup,
            list_plugins,
            read_plugin,
            export_file,
            get_graph_data,
            // 批次 C：整站导出
            build_site_graph,
            copy_vault_assets,
            // 批次 E（子项目 L）：本地 Git
            git_open,
            git_status,
            git_log,
            git_diff_file,
            git_config_identity,
            git_init,
            git_commit_all,
            // 批次 E（子项目 R1）：Git 远程（认证 + 快进 pull，shell out 系统 git）
            git_r_have,
            git_r_remote_list,
            git_r_remote_add,
            git_r_remote_set_url,
            git_r_fetch,
            git_r_upstream,
            git_r_ahead_behind,
            git_r_pull_ff,
            git_r_push,
            // 合并拉取 + 冲突暴露与解决
            git_r_pull_merge,
            git_r_conflict_files,
            git_r_resolve,
            git_r_merge_state,
            git_r_abort_merge,
            git_r_commit_merge,
            git_r_trust_host,
            git_r_info,
            // Word(.docx) 离线导入（只转不写 preview + 去重落盘 commit + 独立模式临时目录 + 另存为整树拷贝）
            docx_import::docx_preview,
            docx_import::docx_commit,
            docx_import::ensure_temp_import_dir,
            docx_import::relocate_import,
            // 批次 F ①：Markdown → Word(.docx) 结构导出
            docx_export::export_docx,
            // macOS 原生菜单（前端算 spec，Rust 落原生对象）
            set_mac_menu,
            // macOS 菜单栏状态图标：刷新「打开最近」子菜单
            tray_set_recent,
            // 界面多语言：前端上报当前语言，后端文案按语言取词
            set_ui_lang,
            // 应用设置（settings.json）：外观等跨会话状态，启动时前端先读回再装配界面
            read_settings_json,
            write_settings_json,
            // 网页剪藏：本地 HTTP 服务（只绑 127.0.0.1，令牌闸门）
            clip_server_apply,
            clip_server_status,
            // P5 §6.6：启动参数（双击 / 命令行打开的文件或目录）
            take_launch_paths,
            open_vault_window,
            take_window_vault
        ])
        .on_menu_event(|app, event| {
            use tauri::Emitter;
            let _ = app.emit("nl:menu-select", event.id().as_ref().to_string());
        })
        .build(tauri::generate_context!())
        .expect("error while building NoteLume application");
    app.run(|app, event| {
        // macOS 的「双击 / 打开方式 / 拖到 Dock 图标」不进 argv，只以 Opened 事件递 URL；
        // 非 mac 目标没这个变体，两个参数都用不上，显式消费掉免 unused 警告。
        #[cfg(target_os = "macos")]
        if let tauri::RunEvent::Opened { urls } = event {
            deliver_open_targets(app, opened_targets(&urls));
        }
        #[cfg(not(target_os = "macos"))]
        let _ = (app, event);
    });
}

#[cfg(test)]
mod launch_tests {
    use super::*;

    #[test]
    fn drops_flags_empty_and_missing_paths() {
        let argv = vec![
            "notelume".to_string(), // 不是真实 exe 路径：exists 直接滤掉
            "-v".to_string(),
            String::new(),
            "/no/such/file.md".to_string(),
        ];
        assert!(launch_targets(argv).is_empty());
    }

    #[test]
    fn keeps_existing_file_and_dir_verbatim() {
        let dir = std::env::temp_dir();
        let file = dir.join("notelume-launch-test.md");
        std::fs::write(&file, "x").unwrap();
        let argv = vec![
            "notelume".to_string(),
            file.to_string_lossy().to_string(),
            dir.to_string_lossy().to_string(),
        ];
        let got = launch_targets(argv);
        assert_eq!(got.len(), 2);
        assert!(got[0].path.ends_with("notelume-launch-test.md"));
        assert!(!got[0].is_dir);
        assert_eq!(got[1].path, dir.to_string_lossy());
        assert!(got[1].is_dir);
        let _ = std::fs::remove_file(&file);
    }

    #[test]
    fn same_path_normalizes_separators_and_windows_case() {
        assert!(same_path("/a/b/x", "\\a\\b\\x"));
        #[cfg(target_os = "windows")]
        assert!(same_path("C:\\A\\X", "c:/a/x"));
        assert!(!same_path("/a/b/x", "/a/b/y"));
    }

    #[test]
    fn same_path_ignores_windows_verbatim_prefix() {
        // current_exe() 可能返回 \\?\C:\... 而 argv 里不带：此前纯字符串比对漏掉 exe 自身
        assert!(same_path(r"\\?\C:\Program Files\NoteLume\notelume.exe", r"C:\Program Files\NoteLume\notelume.exe"));
        assert!(!same_path(r"\\?\C:\a\x.exe", r"C:\a\y.exe"));
    }

    #[test]
    fn drops_exe_self_by_injected_path() {
        // 用一个真实存在的临时文件假扮 exe：verbatim 前缀形式也要被剔除
        let dir = std::env::temp_dir();
        let exe = dir.join("notelume-self-test.exe");
        std::fs::write(&exe, "x").unwrap();
        let exe_s = exe.to_string_lossy().to_string();
        // 手工拼 verbatim 形式（temp_dir 不是 UNC，不会天然带前缀）
        let verbatim = format!("\\\\?\\{}", exe_s);
        let other = dir.join("notelume-other-test.md");
        std::fs::write(&other, "y").unwrap();
        let got = launch_targets_with_exe(
            vec![exe_s.clone(), verbatim, other.to_string_lossy().to_string(), "-v".to_string()],
            Some(exe_s),
        );
        assert_eq!(got.len(), 1);
        assert!(got[0].path.ends_with("notelume-other-test.md"));
        let _ = std::fs::remove_file(&exe);
        let _ = std::fs::remove_file(&other);
    }

    #[test]
    fn drops_sender_exe_when_it_is_not_current_exe() {
        // 单实例二次唤起：argv 首元素是「另一个进程」的 exe，路径与本机 current_exe 不同。
        // 只比 current_exe 会把这份应用二进制当文档递出去（前端弹「不是 Markdown 或画布文件」）。
        let dir = std::env::temp_dir();
        let sender = dir.join("notelume-sender-self-test");
        std::fs::write(&sender, "x").unwrap();
        let other = dir.join("notelume-sender-other.md");
        std::fs::write(&other, "y").unwrap();
        let got = launch_targets(vec![sender.to_string_lossy().to_string(), other.to_string_lossy().to_string()]);
        assert_eq!(got.len(), 1);
        assert!(got[0].path.ends_with("notelume-sender-other.md"));
        let _ = std::fs::remove_file(&sender);
        let _ = std::fs::remove_file(&other);
    }

    #[test]
    fn opened_targets_decodes_paths_and_skips_rest() {
        // 「打开方式」递来的 URL：带空格与中文的路径经 percent 编码，非 file: 协议与
        // 不存在的路径一律丢弃
        let dir = std::env::temp_dir().join("notelume opened 测试");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("打开方式 探测.md");
        std::fs::write(&file, "x").unwrap();

        let file_url = tauri::Url::from_file_path(&file).unwrap();
        assert!(file_url.as_str().contains("%20"), "夹具应带 percent 编码：{file_url}");
        let got = opened_targets(&[
            tauri::Url::parse("https://example.com/a.md").unwrap(),
            tauri::Url::parse("file:///no/such/file.md").unwrap(),
            file_url,
        ]);
        assert_eq!(got.len(), 1);
        assert_eq!(got[0].path, file.to_string_lossy());
        assert!(!got[0].is_dir);

        let got_dir = opened_targets(&[tauri::Url::from_file_path(&dir).unwrap()]);
        assert_eq!(got_dir.len(), 1);
        assert!(got_dir[0].is_dir);
        assert!(opened_targets(&[]).is_empty());

        let _ = std::fs::remove_dir_all(&dir);
    }
}
