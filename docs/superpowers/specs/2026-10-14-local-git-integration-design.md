# 批次 E（子项目 L）：本地 Git 集成 — 设计规格

- 状态：✅ 已实现并验证（子项目 L）——git2 只读/写命令面 + tauri-bridge 封装 + `src/git-panel.js` 面板 + `app.git.*` 入注册表；`cargo test --lib` 19 passed、`build:web` 无错
- 日期：2026-10-14
- 关联：ROADMAP §5「Git 集成（同步首选，单独立项）」；复用批次 D 统一命令注册表（`src/commands.js`）

## 1. 背景与动机

NoteLume 定位为「库即仓库」的本地 Markdown 知识库编辑器。用户本就熟悉 git，且纯文件、可移植。相比收费闭源的 Obsidian Sync，本地 git 集成是开源空间最大的同步路径。

git 集成的真正成本集中在**认证**（远程 pull/push 的凭据代持）。本规格有意以「本地 vs 远程」而非 ROADMAP 的「读 vs 写」为切分轴——因为本地 commit 无认证成本，而认证是远程阶段才需啃的硬骨头。据此把大特性拆成两个子项目：

- **子项目 L（本规格）**：检测/初始化 `.git`、`status` 改动列表、`log` 历史、`diff` 预览、一键本地 commit。全程离线，不碰远程与认证。
- **子项目 R（后续单独立项）**：pull/push + 认证（HTTPS PAT / SSH agent / 凭据助手）+ 冲突暴露与解决 UX。依赖 L 先落地。

## 2. 范围与非目标

**本批做（L）**：
- 探测当前库是否为 git 仓库（含向上 discover 并透明回显实际仓库目录）。
- `git status`（工作树/暂存/HEAD 差异）列表。
- `git log`（提交历史）列表 + 提交详情。
- 单文件 `diff` 预览（vs HEAD 或 vs 某历史提交）。
- 无仓库时初始化 `.git`（并按需写 `.gitignore`）。
- 一键「提交全部」= 等价 `git add -A`（尊重忽略）+ 带 author 签名 commit。

**本批不做（明确排除）**：
- 任何远程操作：pull / push / fetch / clone / 远端管理。
- 任何认证与凭据处理。
- 任何改写工作区或历史的高危动作：`checkout` / `reset` / `revert` / `merge` / `rebase` / `stash` / 分支切换 / `git init` 之外的破坏性写。
- 冲突检测与解决（属 R）。
- 细粒度暂存（逐个 stage/unstage）——L 只做「提交全部」；`git_status` 仅供查看。

## 3. 关键决策（已确认）

| 决策 | 选择 | 理由 |
|---|---|---|
| 首个里程碑范围 | **L 本地基础**（含 commit，不含远程/认证） | 风险最低、可独立验证，为 R 打地基 |
| 技术选型 | **`git2` (libgit2) crate** | 自带、跨平台、不依赖用户装 git，契合自包含理念 |
| 历史/diff 呈现 | **新建独立 Git 面板** | 与文件级备份快照语义不同，边界清晰 |
| commit 身份来源 | **读 git 配置，缺失则问一次并回写 repo 本地配置** | 符合 git 习惯，历史作者信息有意义 |
| 元数据入库 | **仅排除 `.notelume-backup/`** | 备份为运行时产物不应入库；`.notelume-plugins/` 视为用户资产保留可提交 |

## 4. 架构：两层

```
Rust (src-tauri/src/lib.rs)            前端
├─ git2 crate 命令面  ── invoke ──►  tauri-bridge.js 封装
│   · 只读: open/status/log/diff     ├─ git-panel.js (createGitPanel) 独立侧栏面板
│   · 写:   init/commit_all/identity │   · Changes 区 + History 区 + diff 预览
└─ 入参统一 vault_root               └─ app.git.* 注册进 commandRegistry（批次 D）
```

- 所有命令以「库根 = 仓库」定位：入参统一带 `vault_root`（与既有库级命令同一信任模型——前端只传已打开的库根）；文件路径由 git2 按仓库相对处理，不新增越界面。
- 面板仅在有库打开时（`openFolder`/单文件开库皆可）渲染与刷新。

## 5. Git 命令面（Rust）

返回类型均为 serde 结构体；错误统一 `Result<_, String>`。

### 5.1 只读（E1a）
- `git_open(vault_root) -> GitRepoInfo { is_repo: bool, repo_path: Option<String>, branch: Option<String>, has_head: bool }`
  - 用 `Repository::open(vault_root)`（会向上 discover）。`repo_path` 回显 `workdir()` 绝对路径，让用户看清实际操作的仓库；非仓库时 `is_repo=false`，不报错。
- `git_status(vault_root) -> Vec<GitFileStatus { path: String, kind: String, staged: bool }>`
  - `kind` ∈ `modified | new | deleted | renamed | untracked | ignored | conflicted`（对齐 git2 `StatusItem`/`diff` 语义）。
  - 用 `statuses` 且 `recurse_untracked_dirs(true)`；封顶 1000 项，前端据长度提示「还有 N 项」。
  - `path` 相对仓库工作目录、`/` 分隔。
- `git_log(vault_root, limit: usize /*默认200*/) -> Vec<GitCommitInfo { id: String, id_short: String, summary: String, author_name: String, author_email: String, time: i64 }>`
  - 从 HEAD `walk()` 沿第一父链，`time` 为提交 Unix 秒。无提交（空库）返回空数组。
- `git_diff_file(vault_root, args: DiffFileArgs { path: String, against: String /* "HEAD" 或 commit id */ }) -> String`
  - 统一 diff 文本。`against="HEAD"` 取工作树该文件 vs HEAD（未跟踪/新文件对空树）；否则取该 commit vs 其父的该文件差异。空/无差异返回空串。

### 5.2 写（E1b）
- `git_config_identity(vault_root) -> Option<Identity { name: String, email: String }>`
  - 读 repo `Config`：`user.name`/`user.email`（repo 覆盖 global，git2 `Config` 打开时已含全局回退）。两者都在才 `Some`。
- `git_init(vault_root) -> Result<GitRepoInfo, String>`
  - `Repository::init(vault_root)`。**仅当仓库根不存在 `.gitignore` 时才写**，内容至少含一行 `.notelume-backup/`；已存在则不改动。返回同 `git_open` 结构。
- `git_commit_all(vault_root, args: CommitArgs { message: String, name: Option<String>, email: Option<String> }) -> Result<GitCommitResult { id: String, id_short: String }, String>`
  - 等价 `git add -A`：`Index::add_all(["*"], None, Some(cb))` 尊重忽略，再对已删除项 `remove_all`，`write()`。
  - 签名：优先用传入 `name/email`；若来自「问一次」流程则一并 `Config::set_str("user.name"/"user.email")` 写入 repo 本地配置。
  - `message` 去空白后为空 → 拒绝（返回 Err，前端不提交）。
  - 无改动可提交 → 返回 Err（前端提示「没有需要提交的改动」）。

## 6. 前端

### 6.1 tauri-bridge.js
为上述命令各加一层 `invoke` 封装（沿用现有 `invoke` 包装与错误传递范式），JS 侧只认封装函数，不直接散写 `invoke('git_...')`。

### 6.2 命令注册（并入批次 D 注册表）
在 `main.js` 的 `registerAppCommands()` 增 `app.git.*`（`category:'app'`，**无 defaultKey**，避免抢占既有键）：
- `app.git.refresh`「Git：刷新状态」
- `app.git.commit`「Git：提交全部…」
- `app.git.init`「Git：初始化仓库」
命令 `run` 委托给 `gitPanel` 暴露的方法；面板未就绪时 `run` 直接 return。命令可被命令面板搜到并执行。

### 6.3 独立 Git 面板（`src/git-panel.js`，`createGitPanel(deps)`）
右侧 inspector 区新增容器 `<div id="git">`（与 backlinks/outgoing/snapshots/plugins 并列），`els.git = $('git')`。面板结构：
- **顶栏**：分支名 + 改动计数 + 手动刷新按钮；未初始化则显「未检测到仓库」+「初始化仓库」按钮。
- **Changes 区**：`git_status` 列表，每行状态徽标 + 相对路径；点击 → 调 `git_diff_file(against:"HEAD")` 渲染 diff。超封顶显「还有 N 项」。
- **History 区**：`git_log` 列表（short id + summary + 相对时间）；点击 → 提交详情（作者/时间/完整 message）+ 该提交改动文件（复用 `git_diff_file(against:commit_id)`）。
- **动作**：「提交全部」→ `promptDialog` 收 message；提交前若 `git_config_identity` 为 `None`，先弹一次收集 name+email 一并传给 `git_commit_all`；成功后刷新 + 状态栏提示。
- **diff 渲染**：轻量 `<pre>`，按行前缀 `+`/`-` 着色（新增/删除），复用现有 `.nl-*` 观感与主题变量。
- **API**：`createGitPanel(deps)` 返回 `{ refresh(), open(), commitAll(), init() }`（`refresh` 供 boot 与命令调用）。

### 6.4 刷新时机（`main.js` 接线）
`openFolder`、`openFile`、手动保存、提交成功后、面板内手动刷新 → 调 `gitPanel.refresh()`。仅在已开库时实际拉取。

## 7. 数据流

```
用户开库 ─► gitPanel.refresh()
   ├─ git_open ─ is_repo?
   │        否 ► 显「初始化仓库」入口
   │        是 ► git_status ► 渲染 Changes
   │            ► git_log    ► 渲染 History
用户点 Changes 文件 ─► git_diff_file(HEAD) ─► diff 预览
用户点「提交全部」 ─► promptDialog(message)
   ─► git_config_identity? 缺则收集 name/email
   ─► git_commit_all ─ ok ► refresh() + 状态栏「已提交 <short_id>」
                         ─ Err ► messageDialog(错误)
```

## 8. 边界与错误处理

- `.git` 存在但损坏 / 非仓库：`git_open` 返回 `is_repo=false`（探测失败不当致命），面板显占位，不做任何写。
- 空库（已 init 无提交）：`log` 空、`status` 全部计 untracked/new、diff 对空树。
- 权限 / 锁文件 / 磁盘错误：命令返回 `Err(msg)`，前端 `messageDialog`，不改本地状态。
- 父目录存在 `.git`：使用 discover，但面板顶栏**回显 `repo_path`**，让用户明确知道在哪个仓库操作；所有 status/log 天然限该仓库工作树。
- 大库：status 封顶 1000、log 默认 200；diff 仅按需单文件加载，绝不批量拉全库 diff。

## 9. 测试计划

- **Rust 单测**（`git2` 需真实 libgit2，用临时目录）：
  - `Repository::init` 建临时库 → 写文件 → `git_status` 得 untracked/new → `git_commit_all`（传显式 name/email）→ `git_log` 得 1 条 → 修改文件 → `git_status` 得 modified → `git_diff_file` 输出含增/删行。
  - `.gitignore`  seeding：无则写入含 `.notelume-backup/`；已有则不覆盖。
  - 测试用 `std::env::temp_dir()` + 随机子目录，测后清理；断言最小充分，不追高覆盖。
- **前端**：`git-panel.js` 重 DOM+I/O，靠 `npm run build:web`（无构建错误）+ 手动冒烟验证。`roundtrip.test` / `keymap.test` 不受影响。
- ⚠️ **本批含 Rust 改动，须重启 `tauri dev` 才生效**（区别于纯前端的批次 D）。

## 10. 落地顺序

- **E1a** Rust 只读：加 `git2`（vendored）依赖；实现 `git_open`/`git_status`/`git_log`/`git_diff_file`；注册进 `generate_handler!`；跑通只读链路单测。
- **E1b** Rust 写：`git_config_identity`/`git_init`（含 `.gitignore` seeding）/`git_commit_all`；扩展单测到 commit 回环。
- **E1c** `tauri-bridge.js` 封装 + `app.git.*` 注册进命令表（含占位 `gitPanel` 变量，先接命令面板路径）。
- **E1d** `git-panel.js` UI + `index.html` 容器 + `els.git` + boot 接线 + 刷新时机 + `style.css`（`.nl-git-*` 面板与 diff 着色）。
- **E1e** 验证（重启 tauri dev + `cargo test` + `build:web` 全绿）+ CHANGELOG / README / ROADMAP 回填。

## 11. 影响与风险

- **依赖体积**：`git2` + libgit2 编译变重。采用 `git2` 的 `vendored-libgit2`（必要时叠加 `vendored-openssl`）静态自带，跨平台免装系统 libgit2/openssl，契合「无外部依赖」自包含理念。首次 `cargo build` 时间上升，属可接受一次性成本。
- **对用户文件的副作用**：L 阶段仅 `add + commit`，绝不做 `checkout/reset/merge` 等改写工作区/历史动作；提交前在 Changes 区列明将提交的改动，提交是显式动作（经 `promptDialog`）。
- **`.gitignore` 写入**：仅在仓库根无 `.gitignore` 时创建，绝不改动用户已有忽略文件。
- **接口稳定性**：新增命令面为独立 `git_*`，不影响既有库级命令；`app.git.*` 并入注册表不改动批次 D 既有命令。

## 12. 成功标准

1. 打开一个已存在的 git 库，面板能显示分支、status 改动列表、log 历史，点击文件/提交能看 diff。
2. 打开一个非 git 的空文件夹，可一键初始化仓库并生成含 `.notelume-backup/` 的 `.gitignore`。
3. 有改动时「提交全部」用现有配置身份直接提交；无配置身份时问一次并记住（写入 repo 本地配置，第二次不再问）。
4. 提交后 status 清空、log 顶部落出新提交；无外部 git 依赖，`build:web` 与 `cargo test` 全绿。
