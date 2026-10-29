// 批次 E · 子项目 R1-B：内置远程（libgit2）后端。
//
// 本文件 Phase 1 只放**纯逻辑 + 共享 serde 结构**（无 git2 网络调用）——
// 目的是把可离线单测的决策从后端 IO 剥出来；Phase 3+ 再在同文件补
// `builtin::fetch/upstream/ahead_behind/pull_ff` 与凭据/known_hosts 回调。
//
// 详见 docs/superpowers/specs/2026-10-14-git-builtin-remote-design.md。

use serde::{Deserialize, Serialize};

// ==================== §4 URL → host 抽取 ====================

/// 从 git remote URL 抽 host。支持：
/// - `https://host[:port]/path`、`http://...`
/// - `ssh://[user@]host[:port]/path`
/// - scp 式 `[user@]host:path`（无 scheme）
/// 返回 None 表示 URL 空或不可解析。host 全小写化（SSH/HTTPS 域名大小写不敏感）。
#[allow(dead_code)] // §4 纯逻辑 helper：生产 fetch/pull 走 git2 `certificate_check` 回调直取 hostname，本函数仅留作单测与后续复用
pub fn parse_url_host(url: &str) -> Option<String> {
    let s = url.trim();
    if s.is_empty() {
        return None;
    }
    if let Some(idx) = s.find("://") {
        let rest = &s[idx + 3..];
        // 去掉 user@
        let after_user = match rest.find('@') {
            Some(a) => {
                // user-info 不能跨越 `/`（否则就是路径里的 @）
                match rest.find('/') {
                    Some(sl) if a < sl => &rest[a + 1..],
                    _ => rest,
                }
            }
            None => rest,
        };
        // host 到第一个 `/` 或整段
        let host_seg = match after_user.find('/') {
            Some(sl) => &after_user[..sl],
            None => after_user,
        };
        // 去端口（IPv4/域名场景；IPv6 [..] 暂不支持，git 远端罕见）
        let host = match host_seg.rfind(':') {
            Some(c) => &host_seg[..c],
            None => host_seg,
        };
        if host.is_empty() {
            None
        } else {
            Some(host.to_ascii_lowercase())
        }
    } else if let Some(at) = s.find('@') {
        // scp-style: user@host:path，':' 必须在第一个 '/' 之前才算路径分隔而非端口
        let after_at = &s[at + 1..];
        match after_at.find(':') {
            Some(colon) => {
                let before_slash = after_at.find('/').map(|x| x > colon).unwrap_or(true);
                if before_slash {
                    Some(after_at[..colon].to_ascii_lowercase())
                } else {
                    None
                }
            }
            None => None,
        }
    } else {
        None
    }
}

// ==================== §4 known_hosts 解析与生成 ====================

/// known_hosts 单行结构。当前仅覆盖**非哈希**条目（`|1|salt|hash` 跳过），
/// 用户手工写入与 OpenSSH 首连默认都是明文，兼容度足够。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct KnownHostEntry {
    pub hosts: Vec<String>,
    pub key_type: String,
    pub key_b64: String,
}

/// 解析 known_hosts 文本 → 条目列表；跳空行/`#` 注释/哈希条目/@ 标记行。
pub fn parse_known_hosts(content: &str) -> Vec<KnownHostEntry> {
    let mut out = Vec::new();
    for raw in content.lines() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        // @ 开头的 marker 行（如 `@cert-authority`）本 R1-B 不支持，跳
        if line.starts_with('@') {
            continue;
        }
        // 拆 3 段：hosts key_type key_b64（尾部注释 git 端不写、不解析）
        let mut it = line.split_whitespace();
        let hosts_field = match it.next() {
            Some(h) => h,
            None => continue,
        };
        // 哈希 known_hosts（`|1|...`）跳（本 R1-B 不做哈希匹配）
        if hosts_field.starts_with("|1|") {
            continue;
        }
        let key_type = match it.next() {
            Some(k) => k,
            None => continue,
        };
        let key_b64 = match it.next() {
            Some(b) => b,
            None => continue,
        };
        let hosts: Vec<String> = hosts_field
            .split(',')
            .map(|x| x.trim().to_ascii_lowercase())
            .filter(|x| !x.is_empty())
            .collect();
        if hosts.is_empty() {
            continue;
        }
        out.push(KnownHostEntry {
            hosts,
            key_type: key_type.to_string(),
            key_b64: key_b64.to_string(),
        });
    }
    out
}

/// 生成一行 known_hosts（不含换行）。
pub fn format_known_hosts_line(host: &str, key_type: &str, key_b64: &str) -> String {
    format!(
        "{} {} {}",
        host.trim().to_ascii_lowercase(),
        key_type.trim(),
        key_b64.trim()
    )
}

/// 精确 host 查表（不做通配符匹配；git 场景 host 都是 FQDN 已够用）。
pub fn lookup_known_host<'a>(
    entries: &'a [KnownHostEntry],
    host: &str,
) -> Option<&'a KnownHostEntry> {
    let h = host.to_ascii_lowercase();
    entries.iter().find(|e| e.hosts.iter().any(|x| x == &h))
}

// ==================== §4b OpenSSH blob 头 + base64（Phase 4：known_hosts 回调侧信道用）====================

/// OpenSSH 主机密钥 wire-format blob 前 4 字节是算法名长度（big-endian），紧接算法名字节。
/// 用于把 libgit2 `Hostkey::hostkey()` 原始字节 → `ssh-ed25519` / `ssh-rsa` 等字符串。
pub fn key_type_from_blob(blob: &[u8]) -> String {
    if blob.len() < 4 {
        return "unknown".into();
    }
    let n = u32::from_be_bytes([blob[0], blob[1], blob[2], blob[3]]) as usize;
    if n == 0 || blob.len() < 4 + n {
        return "unknown".into();
    }
    std::str::from_utf8(&blob[4..4 + n]).unwrap_or("unknown").to_string()
}

const B64CHARS: &[u8; 64] =
    b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/// 标准 base64（带 padding），与 OpenSSH known_hosts 里的 key 编码一致。
/// 手写 20 行，避免为一个函数引入 base64 crate。
pub fn b64(input: &[u8]) -> String {
    let mut out = String::with_capacity((input.len() + 2) / 3 * 4);
    for chunk in input.chunks(3) {
        let b0 = chunk[0];
        let b1 = *chunk.get(1).unwrap_or(&0);
        let b2 = *chunk.get(2).unwrap_or(&0);
        let n = ((b0 as u32) << 16) | ((b1 as u32) << 8) | (b2 as u32);
        out.push(B64CHARS[((n >> 18) & 63) as usize] as char);
        out.push(B64CHARS[((n >> 12) & 63) as usize] as char);
        if chunk.len() > 1 {
            out.push(B64CHARS[((n >> 6) & 63) as usize] as char);
        } else {
            out.push('=');
        }
        if chunk.len() > 2 {
            out.push(B64CHARS[(n & 63) as usize] as char);
        } else {
            out.push('=');
        }
    }
    out
}

// ==================== §5 ff-only 决策 ====================

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FfDecision {
    /// 已在最新（同 oid 或 behind=0）
    AlreadyUp,
    /// 可快进（ahead=0 && behind>0）
    FastForward,
    /// 已分叉（ahead>0 && behind>0），拒绝自动合并
    Divergent,
}

/// 决策：
/// - `same_oid==true` 或 `behind==0` → AlreadyUp（无待搬 commit）
/// - `ahead>0` → Divergent（本地有远端没有的 commit，ff 会丢）
/// - 其余 → FastForward
pub fn ff_decision(ahead: usize, behind: usize, same_oid: bool) -> FfDecision {
    if same_oid || behind == 0 {
        FfDecision::AlreadyUp
    } else if ahead > 0 {
        FfDecision::Divergent
    } else {
        FfDecision::FastForward
    }
}

// ==================== §6 错误归一 ====================

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[allow(dead_code)] // Phase 3+ 后端会构造 HostUnknown 变体，as_str 会在 tauri 命令壳里调
pub enum BuiltinErrCode {
    Network,
    Auth,
    HostUnknown,
    LocalChanges,
    NonFastForward,
    HostkeyMismatch,
    GitError,
}

#[allow(dead_code)] // Phase 3+ 命令壳使用
impl BuiltinErrCode {
    pub fn as_str(self) -> &'static str {
        match self {
            BuiltinErrCode::Network => "network",
            BuiltinErrCode::Auth => "auth",
            BuiltinErrCode::HostUnknown => "host_unknown",
            BuiltinErrCode::LocalChanges => "local_changes",
            BuiltinErrCode::NonFastForward => "non_fast_forward",
            BuiltinErrCode::HostkeyMismatch => "hostkey_mismatch",
            BuiltinErrCode::GitError => "git_error",
        }
    }
}

/// 按 libgit2/git 常见错误文本给归一 code。顺序敏感：
/// 1) HostkeyMismatch 先于 Network（"host key verification failed" 会命中 network 关键词）
/// 2) NonFastForward 先于 LocalChanges（"Merge is not possible - divergent" 归 Divergent 语义）
/// 3) LocalChanges 先于 Auth（"local changes would be overwritten" 不含 auth 词）
/// 4) Auth 先于 Network（"authentication failed" 可能同时含 "connect"）
pub fn map_err_text(msg: &str) -> BuiltinErrCode {
    let l = msg.to_ascii_lowercase();
    let has = |needle: &str| l.contains(needle);
    if has("host key") || has("known_hosts") || has("known hosts") || has("hostkey") {
        return BuiltinErrCode::HostkeyMismatch;
    }
    if has("fast-forward")
        || has("non-fast-forward")
        || has("divergent")
        || has("diverge")
        || has("not possible to fast-forward")
    {
        return BuiltinErrCode::NonFastForward;
    }
    if has("local changes")
        || has("would be overwritten")
        || has("not clean")
        || has("uncommitted changes")
        || has("untracked")
    {
        return BuiltinErrCode::LocalChanges;
    }
    if has("authentication")
        || has("credentials")
        || has("unauthorized")
        || has("403")
        || has("invalid username")
        || has("could not read")
    {
        return BuiltinErrCode::Auth;
    }
    if has("could not connect")
        || has("connection refused")
        || has("timed out")
        || has("timeout")
        || has("resolve")
        || has("network")
        || has("unreachable")
    {
        return BuiltinErrCode::Network;
    }
    BuiltinErrCode::GitError
}

// ==================== §4.3 / §2 结构体（serde 契约）====================

/// known_hosts 侧信道 payload：Builtin SSH 在回调里捕获，外层 fetch 返 Err 时携带。
#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct HostUnknownPayload {
    pub host: String,
    pub key_type: String,
    pub key_b64: String,
    /// OpenSSH 风格 SHA256:xxx 短指纹（Base64、无 padding）
    pub fingerprint: String,
}

/// `git_r_info` 返回：告诉前端当前引擎与能力。
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GitSyncInfo {
    /// "system" | "builtin"
    pub engine: String,
    /// 系统 git 版本串（无则 None）；面板徽标显示
    pub git_version: Option<String>,
    /// 内置后端是否可用（本 R1-B 里恒 true，编译进来了就可用；保留字段以便未来 feature-gate）
    pub builtin_ready: bool,
}

/// `git_r_trust_host` 入参。
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct TrustHostArgs {
    pub host: String,
    pub key_type: String,
    pub key_b64: String,
}

/// R3：`git_r_resolve` 入参。side = "ours" | "theirs"。
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct ResolveArgs {
    pub path: String,
    /// "ours" | "theirs"
    pub side: String,
}

/// R3：`git_r_commit_merge` 入参。
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct CommitMergeArgs {
    pub message: String,
}

// ==================== Phase 2：共享 serde 契约（从 lib.rs 搬入）====================

/// `git remote -v` 解析出的单个远端
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct Remote {
    pub name: String,
    pub url: String,
}

/// 上游领先/落后计数
#[derive(Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AheadBehind {
    /// 本地独有提交数（ahead）
    pub ahead: usize,
    /// 上游独有提交数（behind）
    pub behind: usize,
    /// 上游名（如 origin/main）
    pub upstream: String,
}

/// 远端增/改入参
#[derive(Deserialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct RemoteArgs {
    pub name: String,
    pub url: String,
}

// ==================== Phase 2：Engine 检测与缓存 ====================

/// 远程引擎二选一：装了系统 git 走 System（R1 shell-out），否则走 Builtin（R1-B 内置 git2）。
/// spec §1 决策“混合”：System 优先、Builtin 兜底。
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Engine {
    System,
    Builtin,
}

/// 起子进程的统一入口。GUI 子系统进程（本应用）spawn git / cmd 这类控制台程序时，
/// Windows 会给每个子进程弹一个控制台窗口，一闪即灭；CREATE_NO_WINDOW 压掉。
pub fn new_command(program: &str) -> std::process::Command {
    let mut cmd = std::process::Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    cmd
}

/// 进程内一次性检测并缓存（`std::sync::OnceLock`）。开 `git --version` 失败一律归 Builtin（保守），
/// 确保 R1-B 内置路径在系统 git 并不可用环境中自动接管。
/// Phase 4 起额外缓存版本串，供 `git_r_info` 上报前端做徽标展示。
pub fn cached_engine_and_version() -> (Engine, Option<String>) {
    use std::sync::OnceLock;
    static CACHE: OnceLock<(Engine, Option<String>)> = OnceLock::new();
    CACHE
        .get_or_init(|| {
            match new_command("git")
                .arg("--version")
                .output()
            {
                Ok(o) if o.status.success() => {
                    let s = String::from_utf8_lossy(&o.stdout).trim().to_string();
                    (Engine::System, Some(s))
                }
                _ => (Engine::Builtin, None),
            }
        })
        .clone()
}

/// 保留旧名字（lib.rs 命令壳已依赖）。
pub fn cached_engine() -> Engine {
    cached_engine_and_version().0
}

// ==================== Phase 2：System 后端（R1 shell-out 全量搬入）====================

/// R1 现 shell-out 系统 git 的完整实现，行为与 R1 一致。命令壳（`#[tauri::command]`）保留在 lib.rs，
/// 通过 `match cached_engine() { System => system::*, Builtin => builtin::* }` 分派。
pub mod system {
    use super::{
        format_known_hosts_line, AheadBehind, CommitMergeArgs, GitSyncInfo, Remote, RemoteArgs,
        ResolveArgs, TrustHostArgs,
    };
    use crate::ui_msg;

    /// 一次 git 进程调用的收敛结果
    pub struct GitRun {
        pub code: i32,
        pub stdout: String,
        pub stderr: String,
    }

    /// 非零退出时的回显：优先 stderr，其次 stdout，都空则报退出码
    pub fn git_err_msg(run: &GitRun) -> String {
        let se = run.stderr.trim();
        if !se.is_empty() {
            return se.to_string();
        }
        let so = run.stdout.trim();
        if !so.is_empty() {
            return so.to_string();
        }
        ui_msg!("gitExitCode", "code" => run.code)
    }

    /// 统一的 git 进程调用：current_dir=vault_root、非交互 env（禁终端提示 / SSH BatchMode）。
    pub async fn git_run(vault_root: String, args: Vec<String>) -> Result<GitRun, String> {
        tauri::async_runtime::spawn_blocking(move || -> Result<GitRun, String> {
            let ref_args: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
            let out = super::new_command("git")
                .args(&ref_args)
                .current_dir(&vault_root)
                .env("GIT_TERMINAL_PROMPT", "0")
                .env("GIT_SSH_COMMAND", "ssh -oBatchMode=yes")
                .output()
                .map_err(|e| ui_msg!("gitSpawnFailed", "err" => e))?;
            Ok(GitRun {
                code: out.status.code().unwrap_or(-1),
                stdout: String::from_utf8_lossy(&out.stdout).to_string(),
                stderr: String::from_utf8_lossy(&out.stderr).to_string(),
            })
        })
        .await
        .map_err(|e| ui_msg!("gitTaskFailed", "err" => e))?
    }

    /// 纯函数：解析 `git remote -v`。留 fetch 行、去 push。
    pub fn parse_remote_v(text: &str) -> Vec<Remote> {
        let mut out = Vec::new();
        for line in text.lines() {
            let line = line.trim_end();
            if line.is_empty() {
                continue;
            }
            let (name, rest) = match line.split_once('\t') {
                Some(kv) => kv,
                None => continue,
            };
            let rest = rest.trim();
            if rest.ends_with("(push)") {
                continue;
            }
            let url = match rest.strip_suffix("(fetch)") {
                Some(u) => u.trim().to_string(),
                None => rest.to_string(),
            };
            out.push(Remote {
                name: name.trim().to_string(),
                url,
            });
        }
        out
    }

    /// 纯函数：`git rev-list --left-right --count`。“左=behind、右=ahead”。
    pub fn parse_left_right_count(text: &str) -> Option<(usize, usize)> {
        let line = text.lines().next()?.trim();
        let mut it = line.split_whitespace();
        let left: usize = it.next()?.parse().ok()?;
        let right: usize = it.next()?.parse().ok()?;
        Some((left, right))
    }

    /// 纯函数：`git rev-parse --abbrev-ref @{u}`。空/未解析哨兵 → None。
    pub fn parse_upstream(text: &str) -> Option<String> {
        let s = text.trim();
        if s.is_empty() || s.contains("@{u}") {
            return None;
        }
        Some(s.to_string())
    }

    // ---------- 8 命令实现（与 lib.rs 里 #[tauri::command] 壳同名同参） ----------

    pub async fn have() -> Option<String> {
        tauri::async_runtime::spawn_blocking(|| -> Option<String> {
            super::new_command("git")
                .arg("--version")
                .output()
                .ok()
                .filter(|o| o.status.success())
                .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        })
        .await
        .ok()
        .flatten()
    }

    pub async fn remote_list(vault_root: String) -> Result<Vec<Remote>, String> {
        let run = git_run(vault_root, vec!["remote".into(), "-v".into()]).await?;
        if run.code != 0 {
            return Err(git_err_msg(&run));
        }
        Ok(parse_remote_v(&run.stdout))
    }

    pub async fn remote_add(vault_root: String, args: RemoteArgs) -> Result<(), String> {
        let run = git_run(
            vault_root,
            vec!["remote".into(), "add".into(), args.name, args.url],
        )
        .await?;
        if run.code != 0 {
            return Err(git_err_msg(&run));
        }
        Ok(())
    }

    pub async fn remote_set_url(vault_root: String, args: RemoteArgs) -> Result<(), String> {
        let run = git_run(
            vault_root,
            vec!["remote".into(), "set-url".into(), args.name, args.url],
        )
        .await?;
        if run.code != 0 {
            return Err(git_err_msg(&run));
        }
        Ok(())
    }

    pub async fn fetch(vault_root: String, remote: Option<String>) -> Result<String, String> {
        let mut args = vec!["fetch".into(), "--prune".into()];
        match remote {
            Some(r) if !r.trim().is_empty() => args.push(r),
            _ => args.push("--all".into()),
        }
        let run = git_run(vault_root, args).await?;
        if run.code != 0 {
            return Err(git_err_msg(&run));
        }
        Ok(run.stderr)
    }

    pub async fn upstream(vault_root: String) -> Result<Option<String>, String> {
        let run = git_run(
            vault_root,
            vec!["rev-parse".into(), "--abbrev-ref".into(), "@{u}".into()],
        )
        .await?;
        if run.code != 0 {
            return Ok(None);
        }
        Ok(parse_upstream(&run.stdout))
    }

    pub async fn ahead_behind(vault_root: String) -> Result<Option<AheadBehind>, String> {
        let up = git_run(
            vault_root.clone(),
            vec!["rev-parse".into(), "--abbrev-ref".into(), "@{u}".into()],
        )
        .await?;
        if up.code != 0 {
            return Ok(None);
        }
        let upstream = match parse_upstream(&up.stdout) {
            Some(u) => u,
            None => return Ok(None),
        };
        let spec = format!("{}...HEAD", upstream);
        let run = git_run(
            vault_root,
            vec!["rev-list".into(), "--left-right".into(), "--count".into(), spec],
        )
        .await?;
        if run.code != 0 {
            return Err(git_err_msg(&run));
        }
        match parse_left_right_count(&run.stdout) {
            Some((behind, ahead)) => Ok(Some(AheadBehind {
                ahead,
                behind,
                upstream,
            })),
            None => Ok(None),
        }
    }

    pub async fn pull_ff(vault_root: String) -> Result<String, String> {
        let run = git_run(vault_root, vec!["pull".into(), "--ff-only".into()]).await?;
        let combined = format!("{}{}", run.stdout, run.stderr);
        if run.code != 0 {
            return Err(combined);
        }
        Ok(combined)
    }

    /// R2：`git push`（当前分支 → upstream，非交互）。凭据交系统 git（GCM/ssh-agent/凭据助手）。
    /// 非零退出时按 stderr 关键字前置 `[code]` 串（与 builtin::push 同分类契约），
    /// 无匹配则保留原文回显，让前端 `handleRemoteErr` 走 NONFF_RE 兼容旧分支。
    pub async fn push(vault_root: String) -> Result<String, String> {
        let run = git_run(vault_root, vec!["push".into()]).await?;
        let combined = format!("{}{}", run.stdout, run.stderr);
        if run.code != 0 {
            let lower = combined.to_lowercase();
            let code: Option<&'static str> = if lower.contains("no upstream")
                || lower.contains("has no upstream")
                || lower.contains("does not have an upstream")
            {
                Some("no_upstream")
            } else if lower.contains("non-fast-forward")
                || lower.contains("fast-forward")
                || lower.contains("[rejected]")
                || lower.contains("fetch first")
                || lower.contains("behind its remote")
            {
                Some("non_fast_forward")
            } else if lower.contains("permission")
                || lower.contains("authentication")
                || lower.contains("denied")
                || lower.contains("403")
                || lower.contains("401")
                || lower.contains("read-only")
                || lower.contains("protected branch")
            {
                Some("auth")
            } else if lower.contains("could not resolve host")
                || lower.contains("connection refused")
                || lower.contains("timed out")
                || lower.contains("network is unreachable")
                || lower.contains("remote end hung up")
            {
                Some("network")
            } else if lower.contains("host key verification failed")
                || lower.contains("known_hosts")
                || lower.contains("hostkey")
            {
                Some("hostkey_mismatch")
            } else {
                None
            };
            return Err(match code {
                Some(c) => format!("[{}]{}", c, combined),
                None => combined,
            });
        }
        Ok(combined)
    }

    // ---------- R3：合并拉取 + 冲突解决 ----------

    /// R3：尝试 `git pull`（不带 --ff-only），合并远端。
    /// 成功无冲突 → Ok("MERGED\n…")；有冲突 → Ok("CONFLICTS\n…")；其他失败 → Err。
    pub async fn pull_merge(vault_root: String) -> Result<String, String> {
        let run = git_run(vault_root, vec!["pull".into()]).await?;
        let combined = format!("{}{}", run.stdout, run.stderr);
        if run.code == 0 {
            return Ok(format!("MERGED\n{}", combined));
        }
        // git pull 有冲突时退出码非零，stderr 含 "CONFLICT" / "Automatic merge failed"
        let lower = combined.to_lowercase();
        if lower.contains("conflict") || lower.contains("automatic merge failed") || lower.contains("merge conflict") {
            return Ok(format!("CONFLICTS\n{}", combined));
        }
        // 其他失败同 push 分类前置 [code]
        let code = super::map_err_text(&combined);
        Err(format!("[{}]{}", code.as_str(), combined))
    }

    /// R3：列冲突文件。`git diff --name-only --diff-filter=U`。
    pub async fn conflict_files(vault_root: String) -> Result<Vec<String>, String> {
        let run = git_run(
            vault_root,
            vec!["diff".into(), "--name-only".into(), "--diff-filter=U".into()],
        )
        .await?;
        if run.code != 0 {
            return Err(git_err_msg(&run));
        }
        Ok(run
            .stdout
            .lines()
            .map(|l| l.trim().to_string())
            .filter(|l| !l.is_empty())
            .collect())
    }

    /// R3：解决单个冲突文件——选边 + stage。
    pub async fn resolve(vault_root: String, args: ResolveArgs) -> Result<(), String> {
        let flag = match args.side.as_str() {
            "ours" => "--ours",
            "theirs" => "--theirs",
            _ => return Err(format!("[git_error]{}", ui_msg!("gitSideInvalid"))),
        };
        let r1 = git_run(
            vault_root.clone(),
            vec!["checkout".into(), flag.into(), "--".into(), args.path.clone()],
        )
        .await?;
        if r1.code != 0 {
            return Err(git_err_msg(&r1));
        }
        let r2 = git_run(
            vault_root,
            vec!["add".into(), "--".into(), args.path],
        )
        .await?;
        if r2.code != 0 {
            return Err(git_err_msg(&r2));
        }
        Ok(())
    }

    /// R3：检查是否处于 merge-in-progress 状态。
    pub async fn merge_state(vault_root: String) -> Result<bool, String> {
        let run = git_run(
            vault_root,
            vec!["rev-parse".into(), "--verify".into(), "MERGE_HEAD".into()],
        )
        .await?;
        Ok(run.code == 0)
    }

    /// R3：中止合并（回到 pull 前状态）。
    pub async fn abort_merge(vault_root: String) -> Result<(), String> {
        let run = git_run(vault_root, vec!["merge".into(), "--abort".into()]).await?;
        if run.code != 0 {
            return Err(git_err_msg(&run));
        }
        Ok(())
    }

    /// R3：提交合并（当前已 stage 的内容 + merge commit）。
    pub async fn commit_merge(vault_root: String, args: CommitMergeArgs) -> Result<(), String> {
        let run = git_run(
            vault_root,
            vec!["commit".into(), "--no-edit".into(), "-m".into(), args.message],
        )
        .await?;
        if run.code != 0 {
            return Err(git_err_msg(&run));
        }
        Ok(())
    }

    /// Phase 4：System 引擎下一次性信任——追加写 `~/.ssh/known_hosts`，同 OpenSSH 自己的行为一致，
    /// 不会弄脏应用私库（System 后端的 known_hosts 无应用私库概念）。
    pub async fn trust_host(args: TrustHostArgs) -> Result<(), String> {
        tauri::async_runtime::spawn_blocking(move || {
            let home = std::env::var_os("HOME")
                .or_else(|| std::env::var_os("USERPROFILE"))
                .map(std::path::PathBuf::from)
                .ok_or(ui_msg!("gitKnownHostsHome"))?;
            let ssh = home.join(".ssh");
            std::fs::create_dir_all(&ssh)
                .map_err(|e| ui_msg!("gitKnownHostsCreate", "err" => e))?;
            let p = ssh.join("known_hosts");
            use std::io::Write;
            let mut f = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(&p)
                .map_err(|e| ui_msg!("gitKnownHostsOpen", "err" => e))?;
            let line = format_known_hosts_line(&args.host, &args.key_type, &args.key_b64);
            writeln!(f, "{}", line)
                .map_err(|e| ui_msg!("gitKnownHostsWrite", "err" => e))?;
            Ok(())
        })
        .await
        .map_err(|e| ui_msg!("gitSpawnBlockingFailed", "err" => e))?
    }

    /// Phase 4：向上报当前引擎。System 下 git_version 从前置一次性探测的结果射。
    pub async fn info(git_version: Option<String>) -> GitSyncInfo {
        GitSyncInfo {
            engine: "system".into(),
            git_version,
            builtin_ready: true,
        }
    }

    // ---------- System 后端的离线单测（从 lib.rs 搬入，行为同 R1） ----------

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn parse_remote_v_keeps_fetch_and_multiple_remotes() {
            let s = "origin\thttps://gitee.com/x/note-lume.git (fetch)\norigin\thttps://gitee.com/x/note-lume.git (push)\nup\tgit@github.com:y/z.git (fetch)\nup\tgit@github.com:y/z.git (push)\n";
            let r = parse_remote_v(s);
            assert_eq!(r.len(), 2);
            assert_eq!(r[0].name, "origin");
            assert_eq!(r[0].url, "https://gitee.com/x/note-lume.git");
            assert_eq!(r[1].name, "up");
            assert_eq!(r[1].url, "git@github.com:y/z.git");
        }

        #[test]
        fn parse_remote_v_empty_is_empty_vec() {
            assert!(parse_remote_v("").is_empty());
            assert!(parse_remote_v("\n  \n").is_empty());
        }

        #[test]
        fn parse_left_right_count_maps_left_behind_right_ahead() {
            assert_eq!(parse_left_right_count("3\t1\n"), Some((3, 1)));
            assert_eq!(parse_left_right_count("0\t0"), Some((0, 0)));
            assert_eq!(parse_left_right_count("garbage"), None);
            assert_eq!(parse_left_right_count(""), None);
        }

        #[test]
        fn parse_upstream_handles_real_and_sentinel() {
            assert_eq!(parse_upstream("origin/main\n").as_deref(), Some("origin/main"));
            assert_eq!(parse_upstream("main\n").as_deref(), Some("main"));
            assert_eq!(parse_upstream("@{u}\n"), None);
            assert_eq!(parse_upstream("  \n"), None);
        }

        #[test]
        fn remote_and_aheadbehind_serialize_camel_case() {
            let r = Remote { name: "origin".into(), url: "u".into() };
            let j = serde_json::to_string(&r).unwrap();
            assert!(j.contains("\"name\""));
            assert!(j.contains("\"url\""));
            let ab = AheadBehind { ahead: 1, behind: 3, upstream: "origin/main".into() };
            let j2 = serde_json::to_string(&ab).unwrap();
            assert!(j2.contains("\"upstream\""));
        }
    }
}

// ==================== Phase 4：known_hosts 私库读写 + 合并表 ====================

/// 内置后端的主机信任存储。不污染 `~/.ssh/known_hosts`，写盘到应用私库：
///   • Windows: `%APPDATA%\NoteLume\git-known_hosts`
///   • 其它（Linux/macOS）：`$XDG_CONFIG_HOME/notelume/git-known_hosts` 或 `~/.config/notelume/git-known_hosts`
/// 验证时将 **私库 + 用户 dotfile** 合并，已有条目直接命中、零摩擦；首次陌生 host 走“一次性信任”。
pub mod known_hosts_store {
    use super::{format_known_hosts_line, parse_known_hosts, KnownHostEntry};
    use crate::ui_msg;
    use std::fs;
    use std::io::Write;
    use std::path::PathBuf;

    /// 返回应用私库 known_hosts 路径。环境缺失时 → None（内置仍可用用户 dotfile）。
    pub fn app_path() -> Option<PathBuf> {
        if cfg!(windows) {
            std::env::var_os("APPDATA").map(PathBuf::from).map(|p| p.join("NoteLume").join("git-known_hosts"))
        } else {
            if let Some(x) = std::env::var_os("XDG_CONFIG_HOME") {
                return Some(PathBuf::from(x).join("notelume").join("git-known_hosts"));
            }
            std::env::var_os("HOME")
                .map(PathBuf::from)
                .map(|p| p.join(".config").join("notelume").join("git-known_hosts"))
        }
    }

    /// 用户 `~/.ssh/known_hosts`（只读补充）。不存在 → None。
    pub fn user_path() -> Option<PathBuf> {
        std::env::var_os("HOME")
            .or_else(|| std::env::var_os("USERPROFILE"))
            .map(PathBuf::from)
            .map(|p| p.join(".ssh").join("known_hosts"))
    }

    fn read_entries(p: &PathBuf) -> Vec<KnownHostEntry> {
        match fs::read_to_string(p) {
            Ok(s) => parse_known_hosts(&s),
            Err(_) => Vec::new(),
        }
    }

    /// 私库 + 用户 dotfile 合并。不写盘，仅供 known_hosts 回调使用。
    pub fn merged() -> Vec<KnownHostEntry> {
        let mut v = Vec::new();
        if let Some(p) = app_path() {
            v.extend(read_entries(&p));
        }
        if let Some(p) = user_path() {
            v.extend(read_entries(&p));
        }
        v
    }

    /// 向私库追加一行。自动 mkdir。失败 → Err 回显。
    pub fn append(host: &str, key_type: &str, key_b64: &str) -> Result<(), String> {
        let p = app_path().ok_or(ui_msg!("gitKnownHostsStoreHome"))?;
        if let Some(dir) = p.parent() {
            fs::create_dir_all(dir).map_err(|e| ui_msg!("gitKnownHostsStoreDir", "err" => e))?;
        }
        let mut f = fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&p)
            .map_err(|e| ui_msg!("gitKnownHostsStoreOpen", "err" => e))?;
        let line = format_known_hosts_line(host, key_type, key_b64);
        writeln!(f, "{}", line).map_err(|e| ui_msg!("gitKnownHostsStoreWrite", "err" => e))?;
        Ok(())
    }
}

// ==================== Phase 3：Builtin 后端实装（git2）====================

/// 内置 git2 后端。凭据回调遵 spec §3：SSH 先试 agent、后试无口令私钥；HTTPS 读 env token。
/// 主机密钥 Phase 4 接自管：合并 `私库 + ~/.ssh/known_hosts` 作 lookup 表，命中同 key 就信任；
/// 陌生 host 写侧信道→外层前置 `[host_unknown]<json>`，前端启一次性信任。
/// ff-pull 走 §5 契约：先 fetch、后 checkout_tree+reset Soft（同一步搬 ref + 工作区），失败回滚。
pub mod builtin {
    use super::{
        b64, key_type_from_blob, known_hosts_store, lookup_known_host, map_err_text,
        AheadBehind, BuiltinErrCode, CommitMergeArgs, GitSyncInfo, HostUnknownPayload,
        KnownHostEntry, Remote, RemoteArgs, ResolveArgs, TrustHostArgs,
    };
    use crate::ui_msg;
    use git2::{
        build::CheckoutBuilder, cert::Cert, CertificateCheckStatus, Cred, CredentialType,
        Error as GError, ErrorClass, FetchOptions, MergeOptions, ObjectType, PushOptions,
        Reference, Repository, RepositoryState, ResetType,
    };
    use std::sync::{Arc, Mutex};

    /// known_hosts 侧信道：同一次 fetch 里回调写入、外层 Err 分支取出并前置 `[host_unknown]<json>`。
    type HostSide = Arc<Mutex<Option<HostUnknownPayload>>>;

    // ---------- 小 helper ----------

    fn open_repo(vault_root: &str) -> Result<Repository, String> {
        Repository::open(vault_root).map_err(|e| format!("[git_error]{}", ui_msg!("gitOpenRepoFailed", "err" => e)))
    }

    fn home_dir() -> Option<std::path::PathBuf> {
        std::env::var_os("HOME")
            .or_else(|| std::env::var_os("USERPROFILE"))
            .map(std::path::PathBuf::from)
    }

    fn env_token() -> Option<String> {
        ["NOTE_LUME_GIT_TOKEN", "GITHUB_TOKEN", "GITLAB_TOKEN"]
            .iter()
            .find_map(|k| std::env::var(k).ok().filter(|v| !v.is_empty()))
    }

    fn has_ssh_agent() -> bool {
        std::env::var_os("SSH_AUTH_SOCK").is_some()
    }

    /// 将 git2 错误归一为 `[code]msg` 前串；code 同 spec §6。
    /// msg 是证书回调里 from_str 的分类 token 时正文换本地化文案——token 只参与
    /// map_err_text 的关键词分类，不该以英文原文显示给用户。
    fn map_err(e: GError) -> String {
        let code = classify_err(&e);
        let msg = e.message();
        let body = match msg {
            "hostkey mismatch" => ui_msg!("gitHostkeyMismatch"),
            "host key not trusted" => ui_msg!("gitHostNotTrusted"),
            "push rejected" => ui_msg!("gitPushRejectedToken"),
            _ => msg.to_string(),
        };
        format!("[{}]{}", code.as_str(), body)
    }

    /// 失败时先看侧信道是否有 host_unknown payload，有→前置 `[host_unknown]<json>`；无→回 map_err。
    fn map_err_with_side(e: GError, side: &HostSide) -> String {
        if let Ok(mut g) = side.lock() {
            if let Some(payload) = g.take() {
                let j = serde_json::to_string(&payload).unwrap_or_default();
                return format!("[host_unknown]{}", j);
            }
        }
        map_err(e)
    }

    fn classify_err(e: &GError) -> BuiltinErrCode {
        if matches!(e.class(), ErrorClass::Net) {
            return BuiltinErrCode::Network;
        }
        map_err_text(e.message())
    }

    /// 拼建凭据 + 证书校验回调（spec §3 / §5）。
    /// - 凭据：SSH 先 agent、后无口令私钥；HTTPS 先 env token。皆无 → Cred::default()。
    /// - 证书：SSH 主机密钥命中同 key → CertificateOk；命中异 key → Err（libgit2 会拼 hostkey mismatch）；
    ///   陌生 host → 写侧信道 payload + Err，外层将取 payload 拼 `[host_unknown]<json>`。
    ///   HTTPS X509 无 as_hostkey → CertificatePassthrough，交 Schannel 默认链验。
    fn make_callbacks(
        entries: Vec<KnownHostEntry>,
        side: HostSide,
    ) -> git2::RemoteCallbacks<'static> {
        let mut cb = git2::RemoteCallbacks::new();
        cb.credentials(|_url, user_from_url, allowed| {
            let user = user_from_url.unwrap_or("git");
            // SSH：先试 agent、后试无口令私钥
            if allowed.intersects(CredentialType::SSH_KEY | CredentialType::SSH_MEMORY) {
                if has_ssh_agent() {
                    if let Ok(c) = Cred::ssh_key_from_agent(user) {
                        return Ok(c);
                    }
                }
                if let Some(home) = home_dir() {
                    let ssh = home.join(".ssh");
                    for fname in ["id_ed25519", "id_rsa", "id_ecdsa"] {
                        let p = ssh.join(fname);
                        if p.exists() {
                            if let Ok(c) = Cred::ssh_key(user, None, &p, None) {
                                return Ok(c);
                            }
                        }
                    }
                }
            }
            // HTTPS：env token 优先（无 → Cred::default() 让 libgit2 匿名拉公开仓）
            if allowed.contains(CredentialType::USER_PASS_PLAINTEXT) {
                if let Some(tok) = env_token() {
                    let user_https = user_from_url.unwrap_or("x-access-token");
                    return Cred::userpass_plaintext(user_https, &tok);
                }
            }
            Cred::default()
        });
        cb.certificate_check(move |cert: &Cert, hostname: &str| {
            let hk = match cert.as_hostkey() {
                Some(h) => h,
                // X509 或无 hostkey 信息 → 交 libgit2/Schannel 默认验链
                None => return Ok(CertificateCheckStatus::CertificatePassthrough),
            };
            let blob: &[u8] = match hk.hostkey() {
                Some(b) if !b.is_empty() => b,
                _ => return Ok(CertificateCheckStatus::CertificatePassthrough),
            };
            // 优先取 libgit2 直接提供的算法名（SshHostKeyType::name）；无 → 从 blob 头解
            let kt = hk
                .hostkey_type()
                .map(|t| t.name().to_string())
                .filter(|s| s != "unknown")
                .unwrap_or_else(|| key_type_from_blob(blob));
            let kb64 = b64(blob);
            match lookup_known_host(&entries, hostname) {
                Some(e) if e.key_b64 == kb64 && e.key_type == kt => {
                    Ok(CertificateCheckStatus::CertificateOk)
                }
                Some(_) => Err(GError::from_str("hostkey mismatch")),
                None => {
                    // OpenSSH 风格 SHA256 指纹：base64 无 padding
                    let fp = hk
                        .hash_sha256()
                        .map(|b| format!("SHA256:{}", b64(b).trim_end_matches('=').to_string()))
                        .unwrap_or_default();
                    let payload = HostUnknownPayload {
                        host: hostname.to_string(),
                        key_type: kt,
                        key_b64: kb64,
                        fingerprint: fp,
                    };
                    if let Ok(mut g) = side.lock() {
                        *g = Some(payload);
                    }
                    Err(GError::from_str("host key not trusted"))
                }
            }
        });
        cb
    }

    /// 当前分支与上游元信息（无上游 → Err 带引导）
    struct HeadInfo {
        up_short: String,
        remote_name: String,
    }

    fn read_head_info(repo: &Repository) -> Result<HeadInfo, String> {
        let head = repo
            .head()
            .map_err(|_| format!("[git_error]{}", ui_msg!("gitNoHead")))?;
        if !head.is_branch() {
            return Err(format!("[git_error]{}", ui_msg!("gitDetachedPull")).into());
        }
        let branch = head
            .shorthand()
            .ok_or_else(|| format!("[git_error]{}", ui_msg!("gitNoBranchName")))?
            .to_string();
        let up_refname_buf = repo.branch_upstream_name(&branch).map_err(|_| {
            format!("[auth]{}", ui_msg!("gitNoUpstreamBuiltin"))
        })?;
        let up_full = up_refname_buf
            .as_str()
            .ok_or_else(|| format!("[git_error]{}", ui_msg!("gitUpstreamNotUtf8")))?
            .to_string();
        let up_short = up_full
            .strip_prefix("refs/remotes/")
            .unwrap_or(&up_full)
            .to_string();
        let remote_name = up_short
            .split('/')
            .next()
            .ok_or_else(|| format!("[git_error]{}", ui_msg!("gitRemoteNameUnresolved")))?
            .to_string();
        Ok(HeadInfo { up_short, remote_name })
    }

    // ---------- 命令实现 ----------

    pub async fn have() -> Option<String> {
        None
    }

    pub async fn remote_list(vault_root: String) -> Result<Vec<Remote>, String> {
        tauri::async_runtime::spawn_blocking(move || {
            let repo = open_repo(&vault_root)?;
            let names = repo.remotes().map_err(map_err)?;
            let mut out = Vec::new();
            for n in names.iter() {
                let name = match n { Some(s) => s, None => continue };
                if let Ok(r) = repo.find_remote(name) {
                    if let Some(url) = r.url() {
                        out.push(Remote { name: name.to_string(), url: url.to_string() });
                    }
                }
            }
            Ok(out)
        })
        .await
        .map_err(|e| ui_msg!("gitSpawnBlockingFailed", "err" => e))?
    }

    pub async fn remote_add(vault_root: String, args: RemoteArgs) -> Result<(), String> {
        tauri::async_runtime::spawn_blocking(move || {
            let repo = open_repo(&vault_root)?;
            repo.remote(&args.name, &args.url).map_err(map_err)?;
            Ok(())
        })
        .await
        .map_err(|e| ui_msg!("gitSpawnBlockingFailed", "err" => e))?
    }

    pub async fn remote_set_url(vault_root: String, args: RemoteArgs) -> Result<(), String> {
        tauri::async_runtime::spawn_blocking(move || {
            let repo = open_repo(&vault_root)?;
            repo.remote_set_url(&args.name, &args.url).map_err(map_err)?;
            Ok(())
        })
        .await
        .map_err(|e| ui_msg!("gitSpawnBlockingFailed", "err" => e))?
    }

    pub async fn fetch(vault_root: String, remote: Option<String>) -> Result<String, String> {
        tauri::async_runtime::spawn_blocking(move || {
            let repo = open_repo(&vault_root)?;
            let entries = known_hosts_store::merged();
            let side: HostSide = Arc::new(Mutex::new(None));
            let cb = make_callbacks(entries, side.clone());
            let mut fo = FetchOptions::new();
            fo.remote_callbacks(cb);
            let mut summary = String::new();
            let target = remote.filter(|r| !r.trim().is_empty());
            match target {
                Some(name) => {
                    let mut r = repo
                        .find_remote(&name)
                        .map_err(|e| map_err_with_side(e, &side))?;
                    r.fetch(&[] as &[&str], Some(&mut fo), None)
                        .map_err(|e| map_err_with_side(e, &side))?;
                    summary.push_str(&format!("fetched {}\n", name));
                }
                None => {
                    let names = repo
                        .remotes()
                        .map_err(|e| map_err_with_side(e, &side))?;
                    for n in names.iter() {
                        let name = match n {
                            Some(s) => s,
                            None => continue,
                        };
                        if let Ok(mut r) = repo.find_remote(name) {
                            r.fetch(&[] as &[&str], Some(&mut fo), None)
                                .map_err(|e| map_err_with_side(e, &side))?;
                            summary.push_str(&format!("fetched {}\n", name));
                        }
                    }
                }
            }
            Ok(summary)
        })
        .await
        .map_err(|e| ui_msg!("gitSpawnBlockingFailed", "err" => e))?
    }

    pub async fn upstream(vault_root: String) -> Result<Option<String>, String> {
        tauri::async_runtime::spawn_blocking(move || {
            let repo = open_repo(&vault_root)?;
            match read_head_info(&repo) {
                Ok(info) => Ok(Some(info.up_short)),
                Err(_) => Ok(None),
            }
        })
        .await
        .map_err(|e| ui_msg!("gitSpawnBlockingFailed", "err" => e))?
    }

    pub async fn ahead_behind(vault_root: String) -> Result<Option<AheadBehind>, String> {
        tauri::async_runtime::spawn_blocking(move || {
            let repo = open_repo(&vault_root)?;
            let info = match read_head_info(&repo) {
                Ok(v) => v,
                Err(_) => return Ok(None),
            };
            let head = repo.head().map_err(map_err)?;
            let local_oid = match head.target() {
                Some(o) => o,
                None => return Ok(None),
            };
            let up_full = format!("refs/remotes/{}", info.up_short);
            let up_ref: Reference = repo.find_reference(&up_full).map_err(map_err)?;
            let up_oid = match up_ref.target() {
                Some(o) => o,
                None => {
                    // 可能为 symbolic ref（少见）→ peel
                    let c = up_ref.peel_to_commit().map_err(map_err)?;
                    c.id()
                }
            };
            let (ahead, behind) =
                repo.graph_ahead_behind(local_oid, up_oid).map_err(map_err)?;
            Ok(Some(AheadBehind {
                ahead,
                behind,
                upstream: info.up_short,
            }))
        })
        .await
        .map_err(|e| ui_msg!("gitSpawnBlockingFailed", "err" => e))?
    }

    pub async fn pull_ff(vault_root: String) -> Result<String, String> {
        tauri::async_runtime::spawn_blocking(move || {
            let repo = open_repo(&vault_root)?;
            let info = read_head_info(&repo)?;

            // 1) fetch 目标 remote，同 libgit2 默认 refspec；带 known_hosts 侧信道
            let entries = known_hosts_store::merged();
            let side: HostSide = Arc::new(Mutex::new(None));
            let cb = make_callbacks(entries, side.clone());
            let mut fo = FetchOptions::new();
            fo.remote_callbacks(cb);
            let mut remote = repo
                .find_remote(&info.remote_name)
                .map_err(|e| map_err_with_side(e, &side))?;
            remote
                .fetch(&[] as &[&str], Some(&mut fo), None)
                .map_err(|e| map_err_with_side(e, &side))?;

            // 2) 取 fetch 后的 up_oid
            let head = repo.head().map_err(map_err)?;
            let local_oid = head.target().ok_or("[git_error]HEAD 无 target")?;
            let up_full = format!("refs/remotes/{}", info.up_short);
            let up_ref = repo.find_reference(&up_full).map_err(map_err)?;
            let up_oid = match up_ref.target() {
                Some(o) => o,
                None => up_ref.peel_to_commit().map_err(map_err)?.id(),
            };

            // 3) 同 oid → AlreadyUp
            if local_oid == up_oid {
                return Ok(format!("{}\n", ui_msg!("gitAlreadyUp")));
            }
            let (ahead, behind) =
                repo.graph_ahead_behind(local_oid, up_oid).map_err(map_err)?;
            let dec = super::ff_decision(ahead, behind, false);
            if dec == super::FfDecision::Divergent {
                return Err(format!(
                    "[non_fast_forward]{}",
                    ui_msg!("gitNonFfDivergent", "ahead" => ahead, "behind" => behind)
                ));
            }

            // 4) 原子 ff：先 checkout_tree(safe) 搬工作区+index，失败 → local_changes
            let up_obj = repo
                .find_object(up_oid, Some(ObjectType::Commit))
                .map_err(map_err)?;
            let mut opts = CheckoutBuilder::new();
            opts.update_index(true).allow_conflicts(false);
            // 默认就是 safe（不删未跟踪、不覆本地修改）——不需显式开
            if let Err(e) = repo.checkout_tree(&up_obj, Some(&mut opts)) {
                return Err(map_err(e));
            }

            // 5) 搬分支 ref（reset soft）；失败则回滚 checkout
            if let Err(e) = repo.reset(&up_obj, ResetType::Soft, None) {
                // 回滚：把文件恢复至 local_oid
                if let Ok(prev_obj) =
                    repo.find_object(local_oid, Some(ObjectType::Commit))
                {
                    let mut back = CheckoutBuilder::new();
                    back.update_index(true).force();
                    let _ = repo.checkout_tree(&prev_obj, Some(&mut back));
                }
                return Err(map_err(e));
            }

            let short = |o: git2::Oid| -> String { o.to_string().chars().take(7).collect() };
            Ok(format!(
                "{}\n",
                ui_msg!("gitFastForward", "from" => short(local_oid), "to" => short(up_oid))
            ))
        })
        .await
        .map_err(|e| ui_msg!("gitSpawnBlockingFailed", "err" => e))?
    }

    /// R2：内置 `Remote::push`。推当前分支→ upstream 同名分支（固定 refspec，不靠 push.default）。
    /// 同 fetch 一样走凭据 + certificate_check 回调 + 侧信道；额外挂 `push_update_reference`
    /// 捕远端拒因（fast-forward / permission / …）一并前置 `[code]` 同前端契约。
    /// 无 upstream → `[no_upstream]`（内置不自动设 upstream，避免默默创远程新分支）。
    pub async fn push(vault_root: String) -> Result<String, String> {
        tauri::async_runtime::spawn_blocking(move || {
            let repo = open_repo(&vault_root)?;
            let head = repo
                .head()
                .map_err(|_| format!("[git_error]{}", ui_msg!("gitNoHead")))?;
            if !head.is_branch() {
                return Err(format!("[git_error]{}", ui_msg!("gitDetachedPush")).into());
            }
            let branch = head
                .shorthand()
                .ok_or_else(|| format!("[git_error]{}", ui_msg!("gitNoBranchName")))?
                .to_string();
            let up_refname_buf = repo.branch_upstream_name(&branch).map_err(|_| {
                format!("[no_upstream]{}", ui_msg!("gitNoUpstreamPush"))
            })?;
            let up_full = up_refname_buf
                .as_str()
                .ok_or_else(|| format!("[git_error]{}", ui_msg!("gitUpstreamNotUtf8")))?
                .to_string();
            let up_short = up_full
                .strip_prefix("refs/remotes/")
                .unwrap_or(&up_full)
                .to_string();
            let (remote_name, remote_branch) = match up_short.split_once('/') {
                Some((r, b)) => (r.to_string(), b.to_string()),
                None => return Err(format!("[git_error]{}", ui_msg!("gitUpstreamUnresolved", "up" => up_short))),
            };
            let refspec = format!("refs/heads/{}:refs/heads/{}", branch, remote_branch);

            let entries = known_hosts_store::merged();
            let side: HostSide = Arc::new(Mutex::new(None));
            let reject: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
            let mut cb = make_callbacks(entries, side.clone());
            let rj = reject.clone();
            cb.push_update_reference(move |refname, reason| {
                if let Some(r) = reason {
                    if let Ok(mut g) = rj.lock() {
                        *g = Some(format!("{}: {}", refname, r));
                    }
                    return Err(git2::Error::from_str("push rejected"));
                }
                Ok(())
            });
            let mut opts = PushOptions::new();
            opts.remote_callbacks(cb);
            let mut remote = repo
                .find_remote(&remote_name)
                .map_err(|e| map_err_with_side(e, &side))?;
            let specs: Vec<&str> = vec![refspec.as_str()];
            if let Err(e) = remote.push(&specs, Some(&mut opts)) {
                // 优先：拒因（远端明确拒绝原因）
                if let Ok(mut g) = reject.lock() {
                    if let Some(reason) = g.take() {
                        let lower = reason.to_lowercase();
                        let code: &'static str = if lower.contains("fast-forward")
                            || lower.contains("fetch first")
                            || lower.contains("non-fast-forward")
                            || lower.contains("rejected")
                            || lower.contains("behind")
                        {
                            "non_fast_forward"
                        } else if lower.contains("permission")
                            || lower.contains("denied")
                            || lower.contains("read-only")
                            || lower.contains("protected")
                            || lower.contains("auth")
                        {
                            "auth"
                        } else {
                            "git_error"
                        };
                        return Err(format!("[{}]{}", code, ui_msg!("gitPushRejected", "reason" => reason)));
                    }
                }
                // 次优：侧信道 host_unknown；否则 map_err 默认
                return Err(map_err_with_side(e, &side));
            }
            Ok(format!(
                "{}\n",
                ui_msg!("gitPushedRefs", "branch" => branch, "remote" => remote_name, "remoteBranch" => remote_branch)
            ))
        })
        .await
        .map_err(|e| ui_msg!("gitSpawnBlockingFailed", "err" => e))?
    }

    // ---------- R3：合并拉取 + 冲突解决（git2 merge API） ----------

    /// R3：尝试合并拉取。同 pull_ff 先 fetch、后 merge（而非 ff）。
    /// 无冲突 → Ok("MERGED\n…")；有冲突 → Ok("CONFLICTS\n…")。
    pub async fn pull_merge(vault_root: String) -> Result<String, String> {
        tauri::async_runtime::spawn_blocking(move || {
            let repo = open_repo(&vault_root)?;
            let info = read_head_info(&repo)?;

            // 1) fetch（同 pull_ff）
            let entries = known_hosts_store::merged();
            let side: HostSide = Arc::new(Mutex::new(None));
            let cb = make_callbacks(entries, side.clone());
            let mut fo = FetchOptions::new();
            fo.remote_callbacks(cb);
            let mut remote = repo
                .find_remote(&info.remote_name)
                .map_err(|e| map_err_with_side(e, &side))?;
            remote
                .fetch(&[] as &[&str], Some(&mut fo), None)
                .map_err(|e| map_err_with_side(e, &side))?;

            // 2) 取 upstream ref → AnnotatedCommit
            let up_full = format!("refs/remotes/{}", info.up_short);
            let up_ref = repo.find_reference(&up_full).map_err(map_err)?;
            let up_annotated = repo
                .reference_to_annotated_commit(&up_ref)
                .map_err(map_err)?;

            // 3) merge_analysis
            let (analysis, _pref) = repo.merge_analysis(&[&up_annotated]).map_err(map_err)?;
            if analysis.is_up_to_date() {
                return Ok(format!("MERGED\n{}\n", ui_msg!("gitAlreadyUp")));
            }
            if !(analysis.is_normal() || analysis.is_fast_forward()) {
                return Err(format!("[git_error]{}", ui_msg!("gitMergeImpossible")).into());
            }

            // 4) merge
            let mut mopts = MergeOptions::new();
            repo.merge(&[&up_annotated], Some(&mut mopts), None)
                .map_err(map_err)?;

            // 5) 检冲突
            let idx = repo.index().map_err(map_err)?;
            if idx.has_conflicts() {
                Ok(format!("CONFLICTS\n{}\n", ui_msg!("gitMergeConflicts")))
            } else {
                Ok(format!("MERGED\n{}\n", ui_msg!("gitMergeOk")))
            }
        })
        .await
        .map_err(|e| ui_msg!("gitSpawnBlockingFailed", "err" => e))?
    }

    /// R3：列冲突文件（index stage>0 的唯一路径）。
    pub async fn conflict_files(vault_root: String) -> Result<Vec<String>, String> {
        tauri::async_runtime::spawn_blocking(move || {
            let repo = open_repo(&vault_root)?;
            let idx = repo.index().map_err(map_err)?;
            let mut out: Vec<String> = Vec::new();
            for c in idx.conflicts().map_err(map_err)? {
                let c = c.map_err(map_err)?;
                let p = c
                    .our
                    .as_ref()
                    .or(c.their.as_ref())
                    .or(c.ancestor.as_ref())
                    .map(|e| String::from_utf8_lossy(&e.path).to_string())
                    .unwrap_or_default();
                if !p.is_empty() && !out.contains(&p) {
                    out.push(p);
                }
            }
            Ok(out)
        })
        .await
        .map_err(|e| ui_msg!("gitSpawnBlockingFailed", "err" => e))?
    }

    /// R3：解决单个冲突文件（选 ours/theirs + 写工作区 + resolve index）。
    pub async fn resolve(vault_root: String, args: ResolveArgs) -> Result<(), String> {
        tauri::async_runtime::spawn_blocking(move || {
            let repo = open_repo(&vault_root)?;
            let mut idx = repo.index().map_err(map_err)?;
            // 在冲突迭代器里找该路径，取指定边的 IndexEntry.id
            let mut chosen: Option<git2::Oid> = None;
            for c in idx.conflicts().map_err(map_err)? {
                let c = c.map_err(map_err)?;
                let cur = c
                    .our
                    .as_ref()
                    .or(c.their.as_ref())
                    .or(c.ancestor.as_ref())
                    .map(|e| String::from_utf8_lossy(&e.path).to_string())
                    .unwrap_or_default();
                if cur != args.path {
                    continue;
                }
                let side_entry = match args.side.as_str() {
                    "ours" => c.our.as_ref(),
                    "theirs" => c.their.as_ref(),
                    _ => return Err(format!("[git_error]{}", ui_msg!("gitSideInvalid"))),
                };
                match side_entry {
                    Some(e) => chosen = Some(e.id),
                    None => {
                        return Err(format!("[git_error]{}", ui_msg!("gitNoSideVersion", "path" => args.path.as_str(), "side" => args.side.as_str())))
                    }
                }
                break;
            }
            let oid = chosen.ok_or_else(|| format!("[git_error]{}", ui_msg!("gitNotConflicted", "path" => args.path.as_str())))?;
            // 取该 blob 写工作区
            let blob = repo.find_blob(oid).map_err(map_err)?;
            let workdir = repo
                .workdir()
                .ok_or(format!("[git_error]{}", ui_msg!("gitBareNoWorkdir")))?
                .join(&args.path);
            std::fs::write(&workdir, blob.content())
                .map_err(|e| ui_msg!("gitWriteWorkdirFailed", "err" => e))?;
            // stage 到 0（同时清除该路径的冲突阶段），落盘 index
            idx.add_path(std::path::Path::new(&args.path))
                .map_err(map_err)?;
            idx.write().map_err(map_err)?;
            Ok(())
        })
        .await
        .map_err(|e| ui_msg!("gitSpawnBlockingFailed", "err" => e))?
    }

    /// R3：检 merge-in-progress（repo.state() == Merge）。
    pub async fn merge_state(vault_root: String) -> Result<bool, String> {
        tauri::async_runtime::spawn_blocking(move || {
            let repo = open_repo(&vault_root)?;
            Ok(repo.state() == RepositoryState::Merge)
        })
        .await
        .map_err(|e| ui_msg!("gitSpawnBlockingFailed", "err" => e))?
    }

    /// R3：中止合并—— hard reset 回 HEAD + 清 MERGE_HEAD。
    pub async fn abort_merge(vault_root: String) -> Result<(), String> {
        tauri::async_runtime::spawn_blocking(move || {
            let repo = open_repo(&vault_root)?;
            let head_obj = repo
                .head()
                .map_err(map_err)?
                .peel(ObjectType::Commit)
                .map_err(map_err)?;
            repo.reset(&head_obj, ResetType::Hard, None).map_err(map_err)?;
            // 清 MERGE_HEAD / MERGE_MSG 等状态文件
            for f in &["MERGE_HEAD", "MERGE_MSG", "MERGE_MODE"] {
                let _ = std::fs::remove_file(repo.path().join(f));
            }
            Ok(())
        })
        .await
        .map_err(|e| ui_msg!("gitSpawnBlockingFailed", "err" => e))?
    }

    /// R3：提交合并（index → tree → commit with two parents）。
    pub async fn commit_merge(vault_root: String, args: CommitMergeArgs) -> Result<(), String> {
        tauri::async_runtime::spawn_blocking(move || {
            let repo = open_repo(&vault_root)?;
            let mut idx = repo.index().map_err(map_err)?;
            let tree_oid = idx.write_tree().map_err(map_err)?;
            let tree = repo.find_tree(tree_oid).map_err(map_err)?;
            let head_commit = repo
                .head()
                .map_err(map_err)?
                .peel_to_commit()
                .map_err(map_err)?;
            // 读 MERGE_HEAD 作第二父
            let mh_content =
                std::fs::read_to_string(repo.path().join("MERGE_HEAD")).map_err(|_| {
                    format!("[git_error]{}", ui_msg!("gitNoMergeHead"))
                })?;
            let mh_oid =
                git2::Oid::from_str(mh_content.trim()).map_err(|e| format!("[git_error]{}", e))?;
            let mh_commit = repo.find_commit(mh_oid).map_err(map_err)?;
            let sig = repo.signature().map_err(map_err)?;
            repo.commit(
                Some("HEAD"),
                &sig,
                &sig,
                &args.message,
                &tree,
                &[&head_commit, &mh_commit],
            )
            .map_err(map_err)?;
            // 清状态文件
            for f in &["MERGE_HEAD", "MERGE_MSG", "MERGE_MODE"] {
                let _ = std::fs::remove_file(repo.path().join(f));
            }
            Ok(())
        })
        .await
        .map_err(|e| ui_msg!("gitSpawnBlockingFailed", "err" => e))?
    }

    /// Phase 4：一次性信任陌生 host——写入应用私库（不污染 ~/.ssh）。
    pub async fn trust_host(args: TrustHostArgs) -> Result<(), String> {
        tauri::async_runtime::spawn_blocking(move || {
            known_hosts_store::append(&args.host, &args.key_type, &args.key_b64)
        })
        .await
        .map_err(|e| ui_msg!("gitSpawnBlockingFailed", "err" => e))?
    }

    /// Phase 4：向上报当前引擎。Builtin 下 git_version 永远 None（不依赖系统 git）。
    pub async fn info(git_version: Option<String>) -> GitSyncInfo {
        GitSyncInfo {
            engine: "builtin".into(),
            git_version,
            builtin_ready: true,
        }
    }
}

// ==================== 单测（全离线，无网络）====================

#[cfg(test)]
mod tests {
    use super::*;

    // ---- parse_url_host ----
    #[test]
    fn parse_url_host_https_basic() {
        assert_eq!(
            parse_url_host("https://github.com/a/b.git").as_deref(),
            Some("github.com")
        );
    }
    #[test]
    fn parse_url_host_https_with_user_and_port() {
        assert_eq!(
            parse_url_host("https://user:pw@example.com:8443/repo.git").as_deref(),
            Some("example.com")
        );
    }
    #[test]
    fn parse_url_host_ssh_scheme() {
        assert_eq!(
            parse_url_host("ssh://git@github.com/a/b").as_deref(),
            Some("github.com")
        );
    }
    #[test]
    fn parse_url_host_scp_style() {
        assert_eq!(
            parse_url_host("git@github.com:a/b.git").as_deref(),
            Some("github.com")
        );
        assert_eq!(
            parse_url_host("git@gitee.com:snail/note.git").as_deref(),
            Some("gitee.com")
        );
    }
    #[test]
    fn parse_url_host_empty_or_garbage_is_none() {
        assert_eq!(parse_url_host(""), None);
        assert_eq!(parse_url_host("   "), None);
        assert_eq!(parse_url_host("https://"), None);
        assert_eq!(parse_url_host("no-at-no-slash-no-colon"), None);
    }
    #[test]
    fn parse_url_host_is_case_insensitive() {
        assert_eq!(
            parse_url_host("https://GitHub.com/a/b").as_deref(),
            Some("github.com")
        );
    }

    // ---- known_hosts parse/format/lookup ----
    #[test]
    fn parse_known_hosts_skips_comments_and_blanks_and_hashed() {
        let text = "\
# a comment
github.com ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIFake

|1|salt|hash ssh-rsa AAAAB3NzaC1yc2EAAA...
@cert-authority *.example.com ssh-rsa AAAA...
gitee.com ssh-ed25519 AAAAC3NzaFake2
";
        let entries = parse_known_hosts(text);
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].hosts, vec!["github.com".to_string()]);
        assert_eq!(entries[0].key_type, "ssh-ed25519");
        assert_eq!(entries[1].hosts, vec!["gitee.com".to_string()]);
    }
    #[test]
    fn parse_known_hosts_multi_host_line() {
        let text = "host-a,host-b ssh-ed25519 AAAA==";
        let entries = parse_known_hosts(text);
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].hosts, vec!["host-a".to_string(), "host-b".to_string()]);
    }
    #[test]
    fn format_known_hosts_line_roundtrip() {
        let line = format_known_hosts_line("GitHub.com", "ssh-ed25519", "AAAA==");
        assert_eq!(line, "github.com ssh-ed25519 AAAA==");
        let parsed = parse_known_hosts(&line);
        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0].hosts, vec!["github.com".to_string()]);
    }
    #[test]
    fn lookup_known_host_exact_case_insensitive() {
        let entries = parse_known_hosts("github.com ssh-ed25519 AAAA==");
        assert!(lookup_known_host(&entries, "GitHub.com").is_some());
        assert!(lookup_known_host(&entries, "gitlab.com").is_none());
    }

    // ---- b64 ----
    #[test]
    fn b64_empty_is_empty() {
        assert_eq!(b64(&"".as_bytes().to_vec()), "");
    }
    #[test]
    fn b64_pads_correctly() {
        assert_eq!(b64(b"a"), "YQ==");
        assert_eq!(b64(b"ab"), "YWI=");
        assert_eq!(b64(b"abc"), "YWJj");
        assert_eq!(b64(b"abcd"), "YWJjZA==");
        assert_eq!(b64(b"abcde"), "YWJjZGU=");
    }
    #[test]
    fn b64_matches_std_alphabet() {
        // 确保 0xfb 的尾部 4 位 = 63 = '/'， 0xff 全 1 = 63 = '/'
        assert_eq!(b64(&[0xff, 0xff, 0xff]), "////");
    }

    // ---- key_type_from_blob ----
    #[test]
    fn key_type_from_blob_recovers_ed25519() {
        let mut blob: Vec<u8> = vec![0, 0, 0, 11];
        blob.extend(b"ssh-ed25519");
        blob.extend(std::iter::repeat(0u8).take(32)); // key body
        assert_eq!(key_type_from_blob(&blob), "ssh-ed25519");
    }
    #[test]
    fn key_type_from_blob_short_or_bad_is_unknown() {
        assert_eq!(key_type_from_blob(&[]), "unknown");
        assert_eq!(key_type_from_blob(&[0, 0, 0]), "unknown");
        // n 比实际长→ unknown
        assert_eq!(key_type_from_blob(&[0, 0, 0, 100, b'x']), "unknown");
        // n=0 也归 unknown（防御）
        assert_eq!(key_type_from_blob(&[0, 0, 0, 0]), "unknown");
    }

    // ---- ff_decision ----
    #[test]
    fn ff_decision_same_oid_is_already_up() {
        assert_eq!(ff_decision(0, 0, true), FfDecision::AlreadyUp);
        // 即使传入非零的 ahead/behind，same_oid 优先（不应发生，但防御）
        assert_eq!(ff_decision(3, 2, true), FfDecision::AlreadyUp);
    }
    #[test]
    fn ff_decision_behind_zero_is_already_up() {
        assert_eq!(ff_decision(0, 0, false), FfDecision::AlreadyUp);
        assert_eq!(ff_decision(5, 0, false), FfDecision::AlreadyUp);
    }
    #[test]
    fn ff_decision_pure_behind_is_fast_forward() {
        assert_eq!(ff_decision(0, 7, false), FfDecision::FastForward);
    }
    #[test]
    fn ff_decision_both_nonzero_is_divergent() {
        assert_eq!(ff_decision(2, 3, false), FfDecision::Divergent);
    }

    // ---- map_err_text ----
    #[test]
    fn map_err_host_key_beats_network_keyword() {
        // 典型 SSH 报的 "Host key verification failed" 也含 verification 但不是 auth/net
        assert_eq!(map_err_text("Host key verification failed"), BuiltinErrCode::HostkeyMismatch);
    }
    #[test]
    fn map_err_non_fast_forward() {
        assert_eq!(
            map_err_text("Not possible to fast-forward, aborting."),
            BuiltinErrCode::NonFastForward
        );
        assert_eq!(
            map_err_text("branch and origin/main have divergent commits"),
            BuiltinErrCode::NonFastForward
        );
    }
    #[test]
    fn map_err_local_changes() {
        assert_eq!(
            map_err_text("Your local changes to the following files would be overwritten by merge"),
            BuiltinErrCode::LocalChanges
        );
        assert_eq!(
            map_err_text("working directory not clean"),
            BuiltinErrCode::LocalChanges
        );
    }
    #[test]
    fn map_err_auth_beats_generic_connection() {
        assert_eq!(
            map_err_text("authentication failed (SSH)"),
            BuiltinErrCode::Auth
        );
        assert_eq!(
            map_err_text("the requested URL returned error: 403"),
            BuiltinErrCode::Auth
        );
    }
    #[test]
    fn map_err_network() {
        assert_eq!(
            map_err_text("failed to connect to github.com port 443: timed out"),
            BuiltinErrCode::Network
        );
        assert_eq!(map_err_text("Could not resolve host: foo"), BuiltinErrCode::Network);
    }
    #[test]
    fn map_err_default_git_error() {
        assert_eq!(map_err_text("some unrelated git thing"), BuiltinErrCode::GitError);
    }

    // ---- serde camelCase 契约 ----
    #[test]
    fn host_unknown_payload_serializes_camel_case() {
        let p = HostUnknownPayload {
            host: "github.com".into(),
            key_type: "ssh-ed25519".into(),
            key_b64: "AAAA".into(),
            fingerprint: "SHA256:abc".into(),
        };
        let s = serde_json::to_string(&p).unwrap();
        assert!(s.contains("\"keyType\""), "got {s}");
        assert!(s.contains("\"keyB64\""), "got {s}");
    }
    #[test]
    fn trust_host_args_deserializes_camel_case() {
        let j = r#"{"host":"github.com","keyType":"ssh-ed25519","keyB64":"AAAA"}"#;
        let a: TrustHostArgs = serde_json::from_str(j).unwrap();
        assert_eq!(a.host, "github.com");
        assert_eq!(a.key_type, "ssh-ed25519");
        assert_eq!(a.key_b64, "AAAA");
    }
}
