# 批次 E（子项目 R1）：Git 远程集成 · 认证 + 快进 Pull — 设计规格

- 状态：✅ 设计已获批准，待写实现计划
- 日期：2026-10-14
- 关联：ROADMAP §5「Git 集成（同步首选，单独立项）」；承接子项目 L（本地 Git 基础，已实现）；复用批次 D 统一命令注册表（`src/commands.js`）与 `src/git-panel.js`

## 1. 背景与动机

子项目 L 已把「库即仓库」的**本地** git 能力落地（探测 / status / log / diff / 一键 commit / 初始化，全程离线）。R 阶段补上**远程**，让同步真正可用。

R 体量横跨多个关注点——① 远程传输 + 认证 ② pull ③ push ④ 冲突暴露与解决 ⑤ 大库/大附件性能——无法塞进单个 spec，故按「认证是最难啃的硬骨头、push 依赖 fetch/pull 先行、冲突是独立大块」的成本轴再切子项目：

- **R1（本规格）**：远程**只读 + 快进 pull**。认证 + `fetch` + 领先/落后展示 + `git pull --ff-only`。**回避合并**（非快进即停下回显，不自动合）。
- **R2（后续）**：`push`（含拒非快进先 pull）。
- **R3（后续）**：冲突暴露与解决 UX（列冲突文件、ours/theirs 对比、选边/手动编辑）。
- **R4（视需要）**：大附件 / `.gitattributes` / LFS 性能。

R1 先啃掉「认证 + 连上远端并拉下来」这块地基，风险集中但不碰合并，能独立验证。

## 2. 关键决策（已确认）

| 决策 | 选择 | 理由 |
|---|---|---|
| 传输 / 认证机制 | **shell out 系统 `git`**（非 git2 remote、非 tauri-plugin-shell） | 认证可复用用户已配好的凭据助手 / ssh-agent，体验最顺、零凭据存储；本地 L 保留 git2 不动 |
| 进程调用方式 | **Rust 命令侧 `std::process::Command`，argv 数组传参** | 无 shell 字符串拼接 = 无注入面；不引新插件、不改 capabilities；与既有「Rust 命令 + bridge 封装」架构一致 |
| 凭据模型 | **纯交给系统 git，应用绝不接触/存储任何凭据** | 零密码存储风险；认证失败回显 git 原生错误 + 引导 |
| 远端建立 | **应用内可添加 / 改 origin** | 新手可自助，无需外部命令行 |
| 首里程碑范围 | **R1：认证 + 快进 pull** | 风险集中在网络但不碰合并，为 R2/R3 打地基 |
| 非交互策略 | **`GIT_TERMINAL_PROMPT=0` + `GIT_SSH_COMMAND="ssh -oBatchMode=yes"`** | 防后台进程卡死等待终端输入；**保留** GCM 的 GUI 弹窗（标准登录 UX，不抑制） |

## 3. 范围与非目标

**R1 做**：
- 探测系统 git 是否可用（`git --version`）。
- 读现有远端（`git remote -v`）；无远端时可应用内 `git remote add origin <url>` / `git remote set-url`。
- `git fetch --prune`（非交互）。
- 上游检测 + 领先/落后计数（ahead/behind）。
- `git pull --ff-only`（仅快进；非快进/需合并 → 报错回显，**不做任何合并**）。
- pull 成功后与编辑器集成（重扫树 / 重建索引 / 刷双链标签 / 当前文档按脏净态处理重载）。

**R1 明确不做**：
- `push`（属 R2）。
- 合并 / rebase / 冲突解决（属 R3）；`pull` 只有 `--ff-only`。
- 分支切换 / 创建。
- 应用内任何凭据存储（token 输入框、keyring、配置文件写秘密）。
- LFS / submodule / 大附件优化。
- 自动联网（绝不在开库 / 保存 / 定时器里自动 fetch/pull，仅用户显式点）。

## 4. 架构（在 L 之上添第三层）

```
Rust (src-tauri/src/lib.rs)                    前端
├─ L：git2 命令面（本地，保留不动）
├─ R1：git_r_* —— std::process::Command("git")  ── invoke ──►  tauri-bridge.js 封装
│   · argv 数组传参、current_dir=vault_root                     ├─ git-panel.js 增「同步」区
│   · async fn + spawn_blocking 跑 output()                     │    · origin / Fetch / Pull(快进) / 领先落后
└─ 探测缺失 git → 优雅禁用远程区                                └─ app.git.fetch·pull·remote 并入 commandRegistry（批次 D）
```

- **两层并存**：本地读写仍走 L 的 git2；远程这层走系统 git。二者作用于同一工作目录（`.git`），面板 `busy` 串行化避免并发抢 `.git/index.lock`。
- **仓库定位沿用 L 信任模型**：入参统一带 `vault_root`（前端只传已打开的库根），`Command` 以 `current_dir(vault_root)` 运行，git 自行向上 discover——与 L 的 discover 行为一致。
- **无新增越界面**：只调用名为 `git` 的二进制、参数全 argv 数组；不向 JS 暴露任何通用命令执行能力。

## 5. 命令面（Rust，均 shell out `git`）

错误统一 `Result<_, String>`；`stderr` 原样带上以便回显。

### 5.1 探测
- `git_r_have() -> Option<String>` — `git --version` 成功返回版本串、失败/找不到返回 `None`。前端据此显示/隐藏同步区。

### 5.2 远端管理
- `git_r_remote_list(vault_root) -> Vec<Remote { name: String, url: String }>`
  - 跑 `git remote -v`，纯函数 `parse_remote_v` 解析取每个 remote 的 fetch URL（去 `-v` 的 `(fetch)`/`(push)` 重复行，留 fetch）。
- `git_r_remote_add(vault_root, args: RemoteArgs { name, url }) -> Result<(), String>` — `git remote add <name> <url>`。
- `git_r_remote_set_url(vault_root, args: RemoteArgs { name, url }) -> Result<(), String>` — `git remote set-url <name> <url>`。

### 5.3 fetch / 状态
- `git_r_fetch(vault_root, remote: Option<String>) -> Result<FetchSummary { stderr }, String>`
  - 有 `remote` 则 `git fetch --prune <remote>`，否则 `git fetch --prune --all`。非交互。返回 stderr 供展示进度/警告；非零退出为 Err（附 stderr）。
- `git_r_upstream(vault_root) -> Result<Option<String>, String>`
  - `git rev-parse --abbrev-ref @{u}`；无上游（退出码非 0 / 输出含 `@{u}` 未解析）→ `Ok(None)`。
- `git_r_ahead_behind(vault_root) -> Result<Option<AheadBehind { ahead: usize, behind: usize, upstream: String }>, String>`
  - 先取上游名（无则 `Ok(None)`），再 `git rev-list --left-right --count <upstream>...HEAD`，纯函数 `parse_left_right_count` 解析「左=上游独有(behind) 右=本地独有(ahead)」→ `{ahead, behind}`。

### 5.4 快进 pull
- `git_r_pull_ff(vault_root) -> Result<String, String>`（与其它 `git_r_*` 同构：仅区分成功与否）
  - `git pull --ff-only`。退出码 0 → `Ok(stdout 摘要)`（如 `Fast-forward` + 改动文件统计）。
  - 非零退出（非快进 / 需合并 / 工作树阻挡 / 凭据失败等）→ `Err(stderr)`。是否为「非快进（分叉）」由前端据 stderr 关键字（`fast-forward`/`divergent`/`Not possible to fast-forward`/`overwritten by merge`）判定并给「冲突解决属 R3」专门引导；其余 Err 走通用回显。

### 5.5 环境变量（所有 `git_r_*` 调用统一设置）
- `GIT_TERMINAL_PROMPT=0`：禁终端用户名/密码提示（否则会挂起等待不可见的终端）。
- `GIT_SSH_COMMAND="ssh -oBatchMode=yes"`：SSH 无 agent 且密钥带口令时快失败而非卡住。**已确认接受此代价**（用户须备好 ssh-agent 或用 HTTPS + GCM）。
- **不抑制** Git Credential Manager：HTTPS 首次登录仍弹 GCM GUI，属预期标准 UX。

## 6. 前端

### 6.1 tauri-bridge.js
为上述命令各加一层 `invoke` 封装（沿用现有包装与错误传递），JS 侧只认封装函数。带 struct 入参走 `{ vaultRoot, args: {...} }`。

### 6.2 命令注册（并入批次 D 注册表）
`main.js` `registerAppCommands()` 增（`category:'app'`、**无 defaultKey**）：
- `app.git.fetch`「Git：抓取远端」
- `app.git.pull`「Git：拉取（仅快进）」
- `app.git.remote`「Git：设置远端 origin…」
`run` 委托给 `gitPanel` 暴露的方法（`fetch()` / `pullFf()` / `setupRemote()`）；面板未就绪则 return。可被命令面板搜到执行。

### 6.3 git-panel.js 增「同步」区（在现有 Changes/History 下）
- **系统 git 缺失**（`git_r_have()` = null）：显「远程同步需先安装系统 git」占位，隐藏下述控件；L 的本地功能不受影响。
- **远端行**：显示 origin `name + url`；无远端 → 「＋ 添加远端」按钮（`promptDialog` 收 URL → `git_r_remote_add origin`）；有远端 → 可「改地址」（`git_r_remote_set_url`）。
- **动作**：`⟳ Fetch`、`↓ Pull（快进）` 两按钮；进行中禁用全部并显「同步中…」（复用面板 `busy`）。
- **状态徽标**：fetch 后取 `git_r_ahead_behind` 显「↑ 领先 N · 落后 M」；无上游显「未设置上游」并引导先 pull 或在外部设上游。
- **错误**：任何 `Err` → `messageDialog` 回显 git stderr 原文 + 一句引导（pull 且命中非快进关键字时提示「可能分叉，冲突解决属 R3」；凭据类提示「请在终端配好 git 凭据助手 / ssh-agent 后重试」）。

### 6.4 与编辑器的集成（pull 改磁盘文件后）
- `git_r_pull_ff` 成功（`Ok`）后，`main.js` 侧回调：`renderTree(await scanVault(vaultRoot))` + `startIndexPolling()` + `refreshLinkPanels()` + `refreshGlobalTags()`（复用 `openFolder` 那套刷新）。
- **当前打开文档处理**：若 pull 改动涉及 `state.currentFile`——
  - 脏（`state.dirty`）：`confirmDialog` 提示「远端更新了此文档，是否放弃本地改动重新加载？」，确认则 `readMdFile`+`editor.setMarkdown`+`markSaved`，取消则保留本地（不动）。
  - 净：直接 `readMdFile` 回灌新内容 + `editor.setMarkdown` + `markSaved`。
- **pull 前置提醒**：点「Pull」时若 `git_status` 非空，先提示「有未提交改动，快进可能被拒或产生冲突（冲突处理属 R3），建议先提交」，用户确认后仍执行、由 git 定夺（不静默 stash/merge）。

## 7. 数据流

```
用户开库 → 面板「同步」区：git_r_have? 无 → 占位；有 → git_r_remote_list
用户点「添加远端」 → promptDialog(URL) → git_r_remote_add origin
用户点 ⟳ Fetch → git_r_fetch ─ ok → git_r_ahead_behind → 徽标
                                ─ Err(stderr) → messageDialog（含凭据引导）
用户点 ↓ Pull → (status 非空? 先提示) → git_r_pull_ff
   ├ Ok(摘要) → 重扫树/重建索引/刷双链标签 + 当前文档按脏净态处理 + 再 fetch 刷新徽标 + 状态栏「已快进」
   └ Err(stderr) → messageDialog（命中非快进关键字 → 附「可能分叉，冲突解决属 R3」；否则通用回显 + 引导）
```

## 8. 边界与错误处理

- **未装系统 git**：`git_r_have` = null，同步区整体隐藏，不报错；L 功能照常。
- **无远端**：`remote_list` 空 → 面板引导添加 origin；fetch/pull 按钮此时禁用。
- **无上游**：`ahead_behind` = None → 显「未设置上游」；pull 仍由 `git pull --ff-only` 自行按上游规则（无上游时 git 报错，回显）。
- **非快进 / 分叉**：`git pull --ff-only` 非零 → `Err(stderr)`，**绝不自动 merge/rebase**；前端识别非快进关键字提示属 R3。
- **凭据失败 / 网络断**：git 非零退出，`Err(stderr)` 原样回显 + 引导；应用不重试、不缓存任何秘密。
- **进程超时**：R1 不设主动超时（依赖 git 自身网络超时 + BatchMode/TERMINAL_PROMPT 防卡死），面板期间禁用按钮；如后续观测到长挂起再议加 `timeout`。
- **并发**：面板 `busy` 串行化所有 git（含 L 本地与 R 远程）操作，规避 `.git/index.lock` 竞争。
- **注入面**：远端 URL、路径一律作为独立 argv 传入，不经 shell 解释；仅调用固定二进制 `git`。

## 9. 测试计划

- **Rust 纯函数单测**（离线、可测；不依赖真实 git/网络）：
  - `parse_remote_v`：多行 `origin\tURL (fetch)` / `(push)` → 每 remote 一条 fetch URL；含多个远端。
  - `parse_left_right_count`：`"3\t1"`（左=上游独有=behind、右=本地独有=ahead）→ `{ahead:1, behind:3}`；`"0\t0"` → 均 0；异常行降级。
  - 上游名解析：`main` / `origin/main` / 未解析哨兵 → None。
  - `Remote`/`AheadBehind` 的 serde 字段 camelCase 断言（前端契约）。
- **进程调用本身不进单测**（需真实 git + 远端）；靠手动冒烟。
- `roundtrip.test.mjs` / `keymap.test.mjs` 不受影响；`cargo test --lib`（既有 19 + 新纯函数测）全绿；`npm run build:web` 无错。
- ⚠️ **含 Rust 改动，须重启 `tauri dev` 重编生效**；远程链路只能本机连真实远端（HTTPS 私有库 / SSH）**手动冒烟**验证 fetch/ahead-behind/快进 pull/非快进拒绝四条路径。

## 10. 落地顺序

- **R1a** Rust 探测 + 只读骨架：`git_r_have` / `git_r_remote_list`（含 `parse_remote_v` 纯函数 + 单测）；注册 `generate_handler!`。
- **R1b** Rust fetch + 状态：`git_r_fetch` / `git_r_upstream` / `git_r_ahead_behind`（含 `parse_left_right_count` 单测）；统一 env 设置 helper（`GIT_TERMINAL_PROMPT`/`GIT_SSH_COMMAND`）。
- **R1c** Rust 写远端 + 快进 pull：`git_r_remote_add` / `git_r_remote_set_url` / `git_r_pull_ff`（`PullResult{ok:false}` 路径）。
- **R1d** 前端接线：`tauri-bridge.js` 封装 + `app.git.*` 注册 + `git-panel.js`「同步」区 UI + `main.js` 集成回调（重扫/索引/当前文档处理）+ `style.css`（`.nl-git-*` 同步区延展）。
- **R1e** 验证（`cargo test --lib` + `build:web` 全绿 + 本机连真实远端手动冒烟）+ CHANGELOG / README / ROADMAP 回填 + spec 状态。

## 11. 影响与风险

- **外部二进制依赖**：R 远程**依赖系统装 git**——这是对 ROADMAP 决策原则 5「警惕外部二进制依赖」的一次**有意妥协**：换取认证复用系统凭据体系、零凭据存储、免 openssl/libssh2 编译。已以「检测到才启用（`git_r_have` 缺失即优雅禁用远程区、不影响 L）」兜住。若日后要回纯自包含，可另立子项目评估 git2 remote + keyring。
- **git2 与系统 git 混用**：同库两套 git 实现，须串行（面板 busy 锁）避免 index.lock 竞争；本地读展示仍 git2、远程写走系统 git，职责清晰。
- **pull 改动磁盘**：与编辑器缓冲的一致性靠 §6.4 集成回调兜底（脏不静默覆盖）。
- **认证 UX 依赖环境**：BatchMode 下 SSH 口令密钥无 agent 会直接失败；HTTPS 依赖 GCM 弹窗。均在错误回显里给明确引导。
- **接口稳定性**：新增命令面为独立 `git_r_*`，不动 L 既有 `git_*` 与批次 D 命令。

## 12. 成功标准

1. 打开一个已配 origin 且有上游的 git 库，面板「同步」区显 origin 地址、点 Fetch 后显「领先/落后」、点 Pull(快进) 在无分叉时成功把远端提交快进进本地。
2. 本地落后且无分叉 → pull 快进成功，文件树/索引/当前文档随之更新；当前文档若有本地未保存改动则先询问、不静默覆盖。
3. 与远端分叉（本地也有新提交）→ pull 明确拒绝并提示「冲突处理尚未支持（R3）」，**不产生任何自动合并**。
4. 无远端库可在应用内添加 origin 后正常 fetch；未装系统 git 时同步区优雅隐藏、本地 L 功能不受影响。
5. 全程应用不存储任何凭据；`cargo test --lib` 与 `build:web` 全绿。
