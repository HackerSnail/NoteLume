# Git 内置远程传输（免装系统 git）设计 · 批次 E · 子项目 R1-B

日期：2026-10-14 · 范围：远程 fetch/pull 的**内置 libgit2 后端**，作为 R1 shell-out 系统 git 的兜底 · 落点：`src-tauri/src/lib.rs`（新增引擎抽象 + Builtin impl）、`src/git-panel.js`（引擎徽标 + 一次性信任 UI + 错误分类）、`src/tauri-bridge.js`（一条新命令）· **零新依赖 crate**（走 git2 现有 vendored-libgit2 + 新启用 `ssh` feature，Windows 走 Schannel TLS）

状态：✅ **已全量交付**（Phase 0→5，master 6 个 commit：fd07a2c Phase0 / 36427c5 Phase1 / fb8e95a Phase2 / 92afc11 Phase3 / 6698fde Phase4 / 0c37307 Phase5；`cargo test --lib` 51 passed / 0 warning；`npm run build` 2332 modules）

---

## 0. 为什么有这一份 · 与 R1 §11 妥协的关系

R1（commit 9e3765d）§11 明写：「远程依赖系统 git 可用——**这是有意识的取舍，违背 ROADMAP 原则 5"纯自包含"一次**，理由：认证是最难啃的硬骨头，复用 OS 凭据助手/ssh-agent 让应用零凭据存储」。同时留话：「若日后要回纯自包含，可另立子项目评估 git2 remote + keyring」。

**本 R1-B 就是那个"另立的子项目"**。触发条件：用户提出"要内置进应用，让用户没有安装 git 也能用"。

设计选择并**不推翻** R1——而是**叠加**：装了系统 git 的用户继续走 R1 路径（凭据助手/GCM 体验最好），没装的用户自动切进本 R1-B 的内置 git2 路径。**这是纯增量、零退化的架构**。

## 1. 关键决策（三项，已与用户对齐）

| 决策 | 选定 | 理由 / 代价 |
|---|---|---|
| **传输范围** | **HTTPS(Schannel) + SSH(libssh2) 都内置** | libgit2 Windows 原生支持 `USE_HTTPS=schannel`（用系统证书，**免 openssl**）+ `USE_SSH=libssh2`（vendored 到 libgit2-sys 的 cmake 构建里，与现有 vendored-libgit2 同工具链）。覆盖面最大，SSH 密钥场景（多数 GitHub 用户）不用改 URL。 |
| **凭据模型** | **不存储、不弹框**——SSH 读 ssh-agent + `~/.ssh` 无口令私钥；HTTPS 读 env token；失败回显引导 | 与 CLUADE/项目安全红线"应用绝不存储任何凭据"完全一致。UX 代价：带口令私钥 & 无 env token 的私有 HTTPS 走不通（内置边界，见 §8）。**主机密钥信任**属网络信任非身份凭据，用一次性「信任此主机」按钮（非凭据弹框），详见 §4。 |
| **新旧关系** | **混合：SystemGit 优先、Builtin 兜底**，命令壳同 `git_r_*`、后端 `match engine` dispatch | 复用 R1 面板 UX、命令契约、serde 结构体**一行不改**；`tauri-bridge.js` 只增一条 `gitRTrustHost`。代价：Rust 里 fetch/pull/upstream/ahead_behind 各两套实现共存（~150 行 builtin 增量）。 |

**明确不做**（YAGNI）：
- ❌ push（属 R2，另立 spec）
- ❌ 冲突解决 UX（属 R3）
- ❌ 凭据 keyring 存储（改红线需另议）
- ❌ 弹框问凭据（改"不弹框"策略需另议）
- ❌ 打包 `git.exe` 随应用（引入分发/许可负担）

## 2. 架构：`RemoteEngine` 二后端抽象

Rust 内部加一层引擎枚举；`git_r_*` 命令壳变成薄 dispatch；**所有 R1 已有 shell-out 代码原封搬进 `System::` 分支**。

```rust
enum Engine { System, Builtin }         // 进程内一次性判定

impl Engine {
    fn detect() -> Engine {             // std::process::Command::new("git").arg("--version")
        if git_present() { Engine::System } else { Engine::Builtin }
    }
}

// 各命令壳只做 dispatch，签名/serde 不变：
#[tauri::command]
async fn git_r_fetch(vault_root: String, remote: Option<String>) -> Result<String, String> {
    match cached_engine() {
        Engine::System  => system::fetch(vault_root, remote).await,   // = R1 现有 git_run
        Engine::Builtin => builtin::fetch(vault_root, remote).await,  // 本文 §3~§6
    }
}
```

**新增 `git_r_info()`**：返回 `{ engine:"system"|"builtin", gitVersion: string|null, builtinReady: bool }`，供面板头部徽标显示当前引擎与能力边界。`git_r_have` 保留原语义（返系统 git 版本，无则 null）向后兼容。

**依赖注入**：`builtin::*` 用 `git2::Repository::open(vault_root)` 打开仓库；每次调用重新 open，无内部状态，与 shell-out 后端互不干扰。

## 3. 凭据回调（不存不弹策略落地）

git2 `RemoteCallbacks::credentials(cb)`，按 libgit2 传入的 `allowed_types` 位掩码分支：

- **`SSH_KEY | SSH_MEMORY`**：
  1. 有 `SSH_AUTH_SOCK`（Unix）/命名管 `$env:SSH_AUTH_SOCK` 存在则 `Cred::ssh_key_from_agent(username_from_url)`。
  2. 否则枚举 `~/.ssh/{id_ed25519, id_rsa, id_ecdsa}` 第一个存在的文件（默认无口令）：`Cred::ssh_key(username_from_url, None, path, None)`；**passphrase=None 只对无口令私钥生效**，带口令时 libgit2 抛 `Auth` 错 → §7 归一 `code:"auth"` + 引导。
- **`USER_PASS_PLAINTEXT`**（HTTPS）：
  1. 读 env：优先 `NOTE_LUME_GIT_TOKEN`（对齐 CLUADE 项目 env 前缀约定），后备 `GITHUB_TOKEN`、`GITLAB_TOKEN`。命中：`Cred::userpass_plaintext(username_from_url.unwrap_or("x-access-token"), token)`。
  2. 无 env token：若 remote URL 属公开仓（无凭据也允许 fetch）→ 让 libgit2 匿名继续（返 `Cred::default()`）；若确实需要认证 → 抛 Err with 引导「设 `NOTE_LUME_GIT_TOKEN=<PAT>` 或安装系统 git」。
- **`USERNAME` / `DEFAULT_CRED_HELPER`**：`Cred::default()` 让 libgit2 从 URL 抽用户名。

**关键：凭据只在一次 `fetch` 调用栈内存活，从不落盘、从不进配置、从不进日志。**

## 4. SSH 主机密钥校验与一次性信任动作

libgit2 SSH 默认走 libssh2 + 严格 `~/.ssh/known_hosts` 匹配，首次连 host 直接拒。给一个**非凭据**的一次性"信任此主机"动作。

### 4.1 存储位置：应用私库 + 合并读用户 dotfile

- 私库路径：`%APPDATA%/NoteLume/git-known_hosts`（Windows）/ `~/.config/notelume/git-known_hosts`（Unix）——**卸载即清、不污染 `~/.ssh/`**。
- 校验时把私库 + `~/.ssh/known_hosts`（若存在）**合并成一份内存表**喂 `known_hosts` 回调。

### 4.2 校验策略

`RemoteCallbacks::known_hosts(cb)` 我方自实现：

- 表内查 `host` → 命中且 `key_type + key_bytes` 精确匹配 → `Ok(true)` 继续。
- 表内查 `host` → 存在但 key 不同 → **`Ok(false)` 硬失败**，不给一键覆盖按钮（防 MITM）；错误文案引导用户手动核对并更新私库文件。
- 表内无 `host` → 见 §4.3 预飞。

### 4.3 首次连接的"一次性信任"UI（fetch 预飞 + 结构化返错）

Builtin SSH 走 `RemoteCallbacks::known_hosts(cb)` 拦截：libgit2 在 SSH transport 协商阶段回调我方 cb 并**递交 host 与 presented key**（此时 TCP 已连、**尚未传任何 git 对象**）。回调里查合并表：
- 缺条目 → 把 `host + keyType + keyB64 + fingerprint` 存进一个 `Arc<Mutex<Option<HostUnknownPayload>>>` 侧信道，回调立刻返 `Err` 中断 fetch；外层读到侧信道有值 → 返 `Err({ code:"host_unknown", ... })`。
- 面板据此渲染：`⚠ 首次连接 github.com，SHA256:xxxx [信任并继续]`；按钮调新命令 `git_r_trust_host(host, keyType, keyB64)` → 追加一行到私库 → 自动重试 fetch。

**说明**：这**不算凭据弹框**（凭据 = 身份密钥，主机信任 = 网络层）；与"不存不弹"策略兼容。

## 5. ff-only pull：ref + 工作区双更新（内置最微妙段）

**项目关键事实**：笔记数据从磁盘文件读，pull 只挪 ref 不动工作区 = 用户看不到更新、编辑器内容也陈旧。git2 里正确序列：

```
1) Remote::fetch(refspec: "+refs/heads/*:refs/remotes/<r>/*")
2) local_oid  = HEAD peel to commit oid
   up_oid     = refs/remotes/<r>/<br> peel to commit oid
3) if local_oid == up_oid → return { code:"already_up_to_date" }
4) (ahead, behind) = graph_ahead_behind(local_oid, up_oid)
   if ahead > 0 → return Err({ code:"non_fast_forward", ahead, behind })
5) 快进原子三步（配 §5.1 回滚）：
   a) find_branch(cur_name, Local).set_target(up_oid, "ff-pull")
   b) checkout_tree(up_object, CheckoutBuilder::new()
        .safe_files()          // 有本地修改的文件拒绝覆盖 = §5.2 脏拦截
        .remove_untracked(false)
        .update_index(true))
   c) set_head("refs/heads/<cur_name>")
6) Ok("Fast-forward\n")  // 与 shell-out 契约同形
```

### 5.1 失败回滚
step 5 任一失败（尤其 checkout 中途），闭包 `restore_ff(prev_oid, prev_head_ref)`：
- `set_target(prev_oid)` 复原分支 ref；
- `checkout_tree(find_object(prev_oid), opts)` 复原工作区；
- 若失败仍失败 → 返 `code:"ff_rollback_failed"` + 提示"用批次 L 快照页回退"。

### 5.2 脏工作区拦截（双保险）
- **第一道**（前端）：R1 已有 `gitStatus` 非空 → `confirmDialog` 提醒。
- **第二道**（内置）：`safe_files()` 让 libgit2 拒绝覆盖已修改文件、抛错 → 归 `code:"local_changes"`。并发/时序下更稳。

### 5.3 与 System 后端行为一致
非快进**绝不自作 merge/rebase**；同 R1 spec §4.1；分叉一律交回用户。

## 6. 错误归一与前端契约

Rust 一处集中把 `git2::Error` + 我方主动 Err → `{ code, msg }` 映射（`code` 见下表）。shell-out 后端沿用 R1 现 stderr 文本；`pull_ff` 返回 Err 字符串里以 `[code]msg` 前缀携带归一 code，前端 `NONFF_RE` 等匹配同步识别。

| 症状 | code | 引导文案（内置版）|
|---|---|---|
| `class==Net` | `network` | 检查网络/代理 |
| `Auth` 错 / §3 凭据分支主动 Err | `auth` | 见 §3 具体引导 |
| §4.3 预飞 | `host_unknown` | 一次性「信任此主机」按钮 |
| §5 checkout `safe_files` 拦下 | `local_changes` | 先提交/暂存本地改动 |
| §5 `graph_ahead_behind` ahead>0 | `non_fast_forward` | 装系统 git 用其 merge 工作流，或用批次 L 快照 + 手动处理 |
| 主机 key 变化 | `hostkey_mismatch` | 手动核对并更新私库文件（不提供一键覆盖）|
| 其它 | `git_error` | 原样 stderr |

## 7. 编译面与 Phase 0 闸口（**未过则整个方案降级**）

### 7.1 依赖变更
`Cargo.toml`：`git2 = { features = ["vendored-libgit2", "ssh"] }`（`ssh` 让 libgit2-sys 的 cmake 构建里编 libssh2，与 vendored-libgit2 同工具链、**无新增 cmake-perl-openssl**）。

### 7.2 假设（待证）
- **假设 A**：libgit2-sys vendored 构建在 Windows MSVC 目标下默认 `USE_HTTPS=schannel`（用系统 TLS），不引入 openssl。
- **假设 B**：`ssh` feature 只加 libssh2 编译，不会把 openssl 拽回来（libssh2 可挂 Schannel/win32-crypto 后端）。
- **假设 C**：`cargo tree` 里 `openssl`/`openssl-sys` 保持缺席。

### 7.3 Phase 0 三步验证
1. 只加 `features=["ssh"]` 不写一行代码 → `cargo tree -e features -p git2` **必须无 openssl/openssl-sys**；有则立刻停手回 §8 讨论降级路径。
2. `#[ignore]` 手工冒烟：`git_r_builtin_smoke_https`（公开 `https://github.com/git/git.git` `Remote::create_anon` + `fetch`）过 → 假设 A 坐实。
3. `#[ignore]` 手工冒烟：`git_r_builtin_smoke_ssh`（本机生一枚**无口令** ed25519、公钥挂自 GitHub、经 §4.3 一次性信任）过 → 假设 B 坐实。

### 7.4 Phase 0 任一失败的降级预案
- 假设 A 失败 → **仅 SSH**（HTTPS 保留要求装系统 git），先落地 SSH 内置。
- 假设 B 失败 → **仅 HTTPS**（SSH 保留要求装系统 git），先落地 HTTPS 内置。
- 都失败 → 停手回来讨论"干脆打包 git.exe"备选；R1 现有能力**不动**、不退化。

## 8. 内置路径的能力边界（诚实声明）

**生效场景**（无系统 git）：
- 公开 HTTPS 仓（匿名 fetch）；
- 私有 HTTPS 仓（env 已配 `NOTE_LUME_GIT_TOKEN`）；
- SSH 仓 + ssh-agent 已启（多数桌面 IDE 用户）；
- SSH 仓 + `~/.ssh` 无口令私钥（首次经一次性信任）。

**不生效场景**：带口令的 SSH 私钥 / 无 env token 的私有 HTTPS 仓 / 主机 key 变化的 SSH 仓（防 MITM 硬失败）——一律回显引导，用户要么装系统 git、要么补上对应配置。

## 9. 测试计划

**离线单测（进 CI）**——剥纯逻辑：
- `parse_url_host`：`https://github.com/a/b.git` / `git@github.com:a/b.git`（scp 式）/ `ssh://git@github.com/a/b` → 都得 `github.com`。
- `format_known_hosts_line` 输出与 OpenSSH known_hosts 格式一致。
- `load_merged_known_hosts(app_path, user_path)`：行合并、空文件容错、注释行剔除。
- `ff_decision(ahead, behind, sameOid)` → enum `{AlreadyUp, FastForward, Divergent}`；4 case。
- `map_git2_err(err) -> (code, msg)` 6 条 fixture。
- serde camelCase 契约：`GitSyncInfo` / `TrustHostArgs` / `BuiltinErrPayload`。

**手工冒烟（`#[ignore]`、真网络、本机跑一次）**：
- 公开 https clone+fetch；ssh-agent 场景 fetch；
- 无口令私钥 + 首次 host 信任流程 fetch；
- ff-pull 真快进（本地净 & 远端多 1 commit）；
- ff-pull 非快进拦截（本地多 1 + 远端多 1）；
- ff-pull 脏工作区拦截；
- System 后端优先（装了 git）与强制 Builtin（临时屏蔽 PATH 里 git）两模式各跑一遍同步区。

## 10. 落地顺序（每步 cargo test + build:web 必过、commit 一次）

1. **Phase 0 编译闸口**（§7，1 commit；可能触发降级讨论）
2. **Builtin 纯逻辑 + 单测**（§9 前半，含 `parse_url_host` / `ff_decision` / `map_git2_err` / `format_known_hosts_line` / `load_merged_known_hosts`）
3. **`RemoteEngine` 抽象 + System 后端搬迁**（把现有 `git_r_*` 内的 shell-out 挪进 `System::xxx`，命令壳只做 dispatch，行为零变）
4. **Builtin 后端**：`fetch`（含 §3 credentials 回调 + §4.3 预飞）→ `upstream`/`ahead_behind`（读 ref + `graph_ahead_behind`）→ `pull_ff`（§5 完整含回滚）
5. **`git_r_trust_host` 命令 + known_hosts 私库读写**（§4.1/§4.3）
6. **前端**：引擎徽标 + 主机信任按钮 + 错误分类引导（改动限 `git-panel.js` 错误渲染段 + `style.css` 新增两个小类 + `tauri-bridge.js` 一条封装）
7. **文档回填**：CHANGELOG Unreleased 顶部新条目 / README 特性表 + 上手 step 18 加"内置远程（免装 git）" / ROADMAP 批次 E R1-B 行 / 本 spec 状态改「✅ 已实现并验证」

## 11. 明确不做 / 后续

- **不做**（本 R1-B）：push（R2）、冲突解决 UX（R3）、keyring 存储、打包 git.exe、图形化 known_hosts 管理器。
- **后续可叠**：
  - **R2 push**：builtin 后端加 `Remote::push` + 同套凭据回调；System 后端 shell `git push` 已在 §R1 命令集预留 `git_r_remote` 语义。
  - **R3 冲突 UX**：非快进现只暴露信息，R3 再叠加逐文件三方合并视图。
  - **凭据 keyring**：若产品策略改为"允许存 OS 钥匙串"（Windows Credential Manager），另立 spec。
  - **known_hosts 图形管理**：加"查看/删除已信任主机"面板。

## 12. 风险登记

| 风险 | 缓解 |
|---|---|
| Phase 0 假设 A/B 任一失败 → 需降级 | §7.4 三条预案；R1 现能力不动、零退化 |
| `checkout_tree` 中途失败留下半更新 | §5.1 `restore_ff` 回滚；失败仍失败提示批次 L 快照页 |
| 大仓 `graph_ahead_behind` 慢 | 全部在 `spawn_blocking` 内，UI 不卡；未来可优化为 `rev-list --count` 近似 |
| ssh-agent 检测跨平台差异 | 只读 `SSH_AUTH_SOCK` env；Windows OpenSSH 默认已设命名管，git2/libssh2 内部会尝试 agent，失败自然回枚举私钥 |
| 「不弹框」策略与产品后续冲突 | 决策 §1 明写，如改红线需另立 spec 重议 |
| libssh2 vendored 构建在特定 toolchain 挂（缺 cmake/nasm）| 与现有 vendored-libgit2 同工具链、Phase 0 若编译挂立即暴露；不引入新工具 |

## 13. 交付记录 / 实施差异

实施中与本 spec 预定有 2 处需记的差异（均不影响对外契约）：

1. **git2 0.19 不提供 `RemoteCallbacks::known_hosts` setter**（只暴露 `certificate_check`）—— Phase 4 将“自管 known_hosts 回调 + 侧信道”从 `known_hosts` 改挂到 `certificate_check(&Cert, &str) -> Result<CertificateCheckStatus, Error>` 上实现：
   - `cert.as_hostkey()` 命中 SSH 主机密钥分支（同 spec §4 语义）；X509 分支 → `CertificatePassthrough` 交 Schannel 默认链验，同 spec 预定一致
   - 拒绝时回 `Err(GError::from_str(...))`（同 spec 预期“拒绝放行”，只是 API 层面无 `Ok(false)`，改而用 `Err` 传递）
   - blob → 算法名优先取 `SshHostKeyType::name()`；无 → 手写 `key_type_from_blob` 解 wire-format 头（与 OpenSSH 同）
   - base64 手写 `b64()`（避为一函数引入 base64 crate），与 libgit2 wire blob 无交集、只用来存 与 展示 payload
2. **Phase 0 假设 A/B 均成立**（Windows MSVC + `vendored-libgit2` + `ssh`+`https`）：cargo tree 无 openssl-sys、libgit2 走 Schannel、libssh2 走 win32-crypto。未触发降级预案。

Phase 6 预期中的文档回填与本行均在同一个 commit，CHANGELOG/README/ROADMAP 同步更新。

## 14. R2 补记（内置 push）

R2 作为本基础设施的自然延伸，不另开 spec（同属 R1-B 双后端架构，无新决策），不改动本 spec 既定契约。要点：

- 新命令 `git_r_push(vault_root)`，dispatcher 同 fetch/pull 一样 `match cached_engine()` 委派。
- `system::push`：`git push`，非零退出时按 stderr 关键字前置 `[code]`（no_upstream / non_fast_forward / auth / network / hostkey_mismatch），无匹配保留原文，兼容旧 NONFF_RE。
- `builtin::push`：git2 `Remote::push`，固定 `refs/heads/<br>:refs/heads/<br>` refspec（不靠 push.default，不自动 force）；挂 `push_update_reference` 将拒因写入 `Arc<Mutex<Option<String>>>` 拒因槽，外层优先级：拒因→`[code]`、侧信道→`[host_unknown]`、默认→`map_err`。
- 无 upstream 回 `[no_upstream]`，内置不自动设（避免默默创远程新分支）。
- 前端 `handleRemoteErr` 补 `[no_upstream]` 弹框；`[non_fast_forward]` 文案从「拉取被拒」改 `opName + '被拒…'`（拉/推共用）。新增 `↑ Push` 按钮与 `app.git.push` 命令。不自动先 pull——与 R1 插不自动 merge/rebase 一脉相承。

实现 commit：`6ee0d9b`（feat R2 Phase 0-1）+ 本行所在 commit（docs）。

## 15. R3 补记（合并拉取 + 冲突暴露与解决）

R3 仍是本双后端架构的延伸（新增命令 × 2 引擎，复用 `[code]` 分派表），不另开 spec。它是 R1/R2 一直把非快进往外推的那个后续——现在把「合并 + 逐个解决冲突」落地。要点：

- **触发**（D1）：同步区新增 `Pull（合并）` 按钮（独立入口，不走 ff-only）；ff-pull 被拒时 `handleRemoteErr` 的 `[non_fast_forward]` 文案从「冲突解决尚未支持（R3）」改为引导点该按钮 / 命令面板「Git：拉取（合并）」（不在错误回调里自动发起合并，避免与 `busy` 串行化重入冲突）。
- **新命令 6 个 × 2 引擎**：`git_r_pull_merge` / `git_r_conflict_files` / `git_r_resolve` / `git_r_merge_state` / `git_r_abort_merge` / `git_r_commit_merge`。入参新增 `ResolveArgs{path,side}`、`CommitMergeArgs{message}`。
- **pull_merge 契约**：无论引擎，成功回 `"MERGED\n…"`、有冲突回 `"CONFLICTS\n…"`，其他失败仍回 `[code]msg`。System 走 `git pull`（非零退出按 stderr 判 conflict / automatic merge failed）；Builtin 走 git2 `reference_to_annotated_commit` → `merge_analysis`（UP_TO_DATE 直接回 MERGED；NORMAL|FASTFORWARD 才 merge）→ `repo.merge` → `index.has_conflicts()` 判冲突。
- **冲突列举**（D2）：复用变更区——`gitStatus`（git2）本就把 `Status::CONFLICTED` 标为 kind `conflicted`，故合并后冲突自动出现在变更列表，无需新命令即可渲染；`git_r_conflict_files` 供需要权威列表时调用（System 走 `git diff --diff-filter=U`，Builtin 走 `index.conflicts()` 迭代去重）。`merge_state` 用 `repo.state()==Merge` 判定是否显示顶部合并工具条。
- **单文件解决**（D3）：每行给「用本地 / 用远端 / 编辑」三个小按钮。`resolve`：System 走 `git checkout --ours/--theirs` + `git add`；Builtin 从 `index.conflicts()` 取该 path 指定边的 `IndexEntry.id` → `find_blob` 写工作区 → `index.add_path`（stage 0 顺带清冲突阶段）+ `index.write`。「编辑」经注入的 `openFile` dep 打开带冲突标记的文件，手改保存后回来提交。
- **提交 / 中止**：`commit_merge` System 走 `git commit`；Builtin 读 `MERGE_HEAD` 作第二父、`write_tree`+`commit(two parents)` 后清状态文件。`abort_merge` System 走 `git merge --abort`；Builtin 走 `reset(Hard, HEAD)` + 清 `MERGE_HEAD/MSG/MODE`。
- **不变量**：仍「不代持凭据 / 不自动 force」；非快进不再被简单拒绝，而是给出可控的合并解决路径，但合并拉取前置仍会就「有未提交改动」弹确认。

实现要点（git2 0.19 API 校正，均不影响对外契约）：`AnnotatedCommit` 无 `from_ref` → 用 `repo.reference_to_annotated_commit`；`merge_analysis` 只 1 参；`MergeAnalysis::is_up_to_date/is_fast_forward`；`Index` 无 `get_conflict/resolve` → 用 `conflicts()` 迭代 + `add_path`+`write` 解决；`IndexEntry` 的 `path` 是字段（`Vec<u8>`）非方法、无 `stage()` → 改 `has_conflicts()`；`Reference` 无 `peel_to_object` → `peel(ObjectType::Commit)`。

---

**一句话**：R1-B 在 Rust 里加 `RemoteEngine{System, Builtin}` 双后端——装了 git 的用户继续走 R1 shell-out 保 UX，没装的自动切内置 git2 直连；HTTPS 用 Schannel 免 openssl，SSH 用 libssh2 + ssh-agent/无口令私钥；凭据一律不存不弹；ff-pull 通过 `set_target`+`checkout_tree(safe)`+`set_head` 三步原子搬 ref 与工作区，非快进/脏工作区一律拒并清晰引导；known_hosts 首次缺失以「一次性信任按钮」这种**非凭据**动作解；落地前用 Phase 0 三步验编译假设，任一失败即降级到"仅 HTTPS"或"仅 SSH"。
