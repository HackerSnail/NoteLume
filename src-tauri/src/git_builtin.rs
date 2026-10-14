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
#[allow(dead_code)] // Phase 4+ 命令壳会构造
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

/// 进程内一次性检测并缓存（`std::sync::OnceLock`）。开 `git --version` 失败一律归 Builtin（保守），
/// 确保 R1-B 内置路径在系统 git 并不可用环境中自动接管。
pub fn cached_engine() -> Engine {
    use std::sync::OnceLock;
    static CACHE: OnceLock<Engine> = OnceLock::new();
    *CACHE.get_or_init(|| {
        match std::process::Command::new("git")
            .arg("--version")
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .output()
        {
            Ok(o) if o.status.success() => Engine::System,
            _ => Engine::Builtin,
        }
    })
}

// ==================== Phase 2：System 后端（R1 shell-out 全量搬入）====================

/// R1 现 shell-out 系统 git 的完整实现，行为与 R1 一致。命令壳（`#[tauri::command]`）保留在 lib.rs，
/// 通过 `match cached_engine() { System => system::*, Builtin => builtin::* }` 分派。
pub mod system {
    use super::{AheadBehind, Remote, RemoteArgs};

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
        format!("git 退出码 {}", run.code)
    }

    /// 统一的 git 进程调用：current_dir=vault_root、非交互 env（禁终端提示 / SSH BatchMode）。
    pub async fn git_run(vault_root: String, args: Vec<String>) -> Result<GitRun, String> {
        tauri::async_runtime::spawn_blocking(move || -> Result<GitRun, String> {
            let ref_args: Vec<&str> = args.iter().map(|s| s.as_str()).collect();
            let out = std::process::Command::new("git")
                .args(&ref_args)
                .current_dir(&vault_root)
                .env("GIT_TERMINAL_PROMPT", "0")
                .env("GIT_SSH_COMMAND", "ssh -oBatchMode=yes")
                .output()
                .map_err(|e| format!("调用系统 git 失败：{}（请确认已安装并在 PATH 中）", e))?;
            Ok(GitRun {
                code: out.status.code().unwrap_or(-1),
                stdout: String::from_utf8_lossy(&out.stdout).to_string(),
                stderr: String::from_utf8_lossy(&out.stderr).to_string(),
            })
        })
        .await
        .map_err(|e| format!("git 任务调度失败：{}", e))?
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
            std::process::Command::new("git")
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

// ==================== Phase 3：Builtin 后端实装（git2）====================

/// 内置 git2 后端。凭据回调遵 spec §3：SSH 先试 agent、后试无口令私钥；HTTPS 读 env token。
/// 主机密钥仍走 libgit2 默认（读 ~/.ssh/known_hosts、严格匹配）；Phase 4 接 self-manage + 一次性信任。
/// ff-pull 走 §5 契约：先 fetch、后 reset Hard（同一步搬 ref + 工作区），safe_files 默认开。
pub mod builtin {
    use super::{map_err_text, AheadBehind, BuiltinErrCode, Remote, RemoteArgs};
    use git2::{
        build::CheckoutBuilder, Cred, CredentialType, Error as GError, ErrorClass, FetchOptions,
        ObjectType, Reference, Repository, ResetType,
    };

    // ---------- 小 helper ----------

    fn open_repo(vault_root: &str) -> Result<Repository, String> {
        Repository::open(vault_root).map_err(|e| format!("[git_error]打开仓库失败：{}", e))
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
    fn map_err(e: GError) -> String {
        let code = classify_err(&e);
        let msg = e.message();
        format!("[{}]{}", code.as_str(), msg)
    }

    fn classify_err(e: &GError) -> BuiltinErrCode {
        if matches!(e.class(), ErrorClass::Net) {
            return BuiltinErrCode::Network;
        }
        map_err_text(e.message())
    }

    /// 拼建凭据回调（spec §3）。无 known_hosts 回调——Phase 4 接。
    fn make_callbacks<'a>() -> git2::RemoteCallbacks<'a> {
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
            .map_err(|_| "[git_error]无 HEAD（仓库可能为空）".to_string())?;
        if !head.is_branch() {
            return Err("[git_error]内置 pull 需要 HEAD 在分支上（当前 detached）".into());
        }
        let branch = head
            .shorthand()
            .ok_or_else(|| "[git_error]无分支名".to_string())?
            .to_string();
        let up_refname_buf = repo.branch_upstream_name(&branch).map_err(|_| {
            "[auth]当前分支无上游；先安装系统 git 运行 `git branch --set-upstream-to=origin/<br>`、或在面板里配置".to_string()
        })?;
        let up_full = up_refname_buf
            .as_str()
            .ok_or_else(|| "[git_error]上游 refname 非 UTF8".to_string())?
            .to_string();
        let up_short = up_full
            .strip_prefix("refs/remotes/")
            .unwrap_or(&up_full)
            .to_string();
        let remote_name = up_short
            .split('/')
            .next()
            .ok_or_else(|| "[git_error]无法解析 remote 名".to_string())?
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
        .map_err(|e| format!("spawn_blocking 失败：{}", e))?
    }

    pub async fn remote_add(vault_root: String, args: RemoteArgs) -> Result<(), String> {
        tauri::async_runtime::spawn_blocking(move || {
            let repo = open_repo(&vault_root)?;
            repo.remote(&args.name, &args.url).map_err(map_err)?;
            Ok(())
        })
        .await
        .map_err(|e| format!("spawn_blocking 失败：{}", e))?
    }

    pub async fn remote_set_url(vault_root: String, args: RemoteArgs) -> Result<(), String> {
        tauri::async_runtime::spawn_blocking(move || {
            let repo = open_repo(&vault_root)?;
            repo.remote_set_url(&args.name, &args.url).map_err(map_err)?;
            Ok(())
        })
        .await
        .map_err(|e| format!("spawn_blocking 失败：{}", e))?
    }

    pub async fn fetch(vault_root: String, remote: Option<String>) -> Result<String, String> {
        tauri::async_runtime::spawn_blocking(move || {
            let repo = open_repo(&vault_root)?;
            let cb = make_callbacks();
            let mut fo = FetchOptions::new();
            fo.remote_callbacks(cb);
            let mut summary = String::new();
            let target = remote.filter(|r| !r.trim().is_empty());
            match target {
                Some(name) => {
                    let mut r = repo.find_remote(&name).map_err(map_err)?;
                    r.fetch(&[] as &[&str], Some(&mut fo), None).map_err(map_err)?;
                    summary.push_str(&format!("fetched {}\n", name));
                }
                None => {
                    let names = repo.remotes().map_err(map_err)?;
                    for n in names.iter() {
                        let name = match n { Some(s) => s, None => continue };
                        if let Ok(mut r) = repo.find_remote(name) {
                            r.fetch(&[] as &[&str], Some(&mut fo), None).map_err(map_err)?;
                            summary.push_str(&format!("fetched {}\n", name));
                        }
                    }
                }
            }
            Ok(summary)
        })
        .await
        .map_err(|e| format!("spawn_blocking 失败：{}", e))?
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
        .map_err(|e| format!("spawn_blocking 失败：{}", e))?
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
        .map_err(|e| format!("spawn_blocking 失败：{}", e))?
    }

    pub async fn pull_ff(vault_root: String) -> Result<String, String> {
        tauri::async_runtime::spawn_blocking(move || {
            let repo = open_repo(&vault_root)?;
            let info = read_head_info(&repo)?;

            // 1) fetch 目标 remote，同 libgit2 默认 refspec
            let cb = make_callbacks();
            let mut fo = FetchOptions::new();
            fo.remote_callbacks(cb);
            let mut remote = repo.find_remote(&info.remote_name).map_err(map_err)?;
            remote.fetch(&[] as &[&str], Some(&mut fo), None).map_err(map_err)?;

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
                return Ok("已经是最新\n".into());
            }
            let (ahead, behind) =
                repo.graph_ahead_behind(local_oid, up_oid).map_err(map_err)?;
            let dec = super::ff_decision(ahead, behind, false);
            if dec == super::FfDecision::Divergent {
                return Err(format!(
                    "[non_fast_forward]分叉：ahead={} behind={}；本 R1-B 不自动 merge/rebase，请用系统 git 工作流或批次 L 快照手动处理",
                    ahead, behind
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
                "Fast-forward {} -> {}\n",
                short(local_oid),
                short(up_oid)
            ))
        })
        .await
        .map_err(|e| format!("spawn_blocking 失败：{}", e))?
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
