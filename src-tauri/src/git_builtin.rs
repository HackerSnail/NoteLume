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
