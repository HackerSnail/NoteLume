# NoteLume 下一阶段路线图（候选方向与优先级）

> 本文是"下一步做什么"的规划文档，不描述已完成功能（那部分见 `CHANGELOG.md` / `README.md`）。
> 定位：在 P0–P3 已基本落地之后，圈定下一阶段候选、给出排序依据与建议执行批次。

## 一、决策原则（硬约束回顾）

1. **纯文件、无自建服务器**：一切能力优先走"本地文件夹 + 标准文件"路线；同步/分享不自建后端。
2. **无损互操作**：继续与 GFM / Obsidian / Typora / JSON Canvas 文件互通，不引入私有格式。
3. **不引 UI 框架**：前端仍是 Vanilla JS + ProseMirror。
4. **复用优先**：新功能尽量接在已有能力上（`create_file` / `rename_item` / frontmatter / `.nl-suggest` 下拉 / 单篇 HTML 导出 / 插件钩子）。
5. **警惕外部二进制依赖**：如 pandoc、系统 git——能"检测到才启用"就不做成硬依赖，保持开箱即用。

## 二、候选方向总览

| # | 方向 | 价值 | 工作量 | 风险 | 纯文件契合 | 建议排序 |
|---|------|------|--------|------|-----------|---------|
| 1 | 模板 + 每日笔记 | 高（留存驱动） | 小 | 低 | ✅ 完全 | **A（先做）** |
| 2 | 编辑器手感包（斜杠/统计/专注/打字机） | 中高（日常体验） | 小–中 | 低 | ✅ 完全 | B |
| 3 | 整库导出 HTML 静态站 | 高（"本地维基"爽点） | 中 | 低–中 | ✅ 完全 | C |
| 4 | 命令面板 + 快捷键自定义 | 中 | 中 | 低 | ✅ 完全 | D |
| 5 | Git 集成（库即仓库，内置 commit/pull/push） | 高（同步主流解） | 大 | 中–高 | ✅（git 即文件） | E（单独立项） |
| 6 | 插件系统 v2（权限 + 隔离 + registerNodeSpec） | 中高（生态） | 大 | 高 | ✅ | F |
| 7 | 移动端适配 | 中 | 大 | 中 | ✅ | G（单独立项） |

## 三、各方向细化

### 1. 模板 + 每日笔记（建议先做）
- **模板**：库内约定一个模板目录（如 `.notelume-templates/` 或普通 `Templates/` 文件夹，用户可见可编辑）。"从模板新建"时做变量替换：`{{date}}` `{{time}}` `{{title}}` `{{filename}}`（可扩展 `{{weekday}}` 等）。
- **每日笔记**：设置项——存放目录（如 `Daily/`）、文件名格式（如 `YYYY-MM-DD`）、可选套用的模板。快捷键（如 `Ctrl+Shift+D`）一键"打开今天的笔记，不存在则按模板创建"。
- **复用**：`create_file` / `openFile` / frontmatter 全部现成；纯文件，零新依赖、无网络。
- **边界**：变量语法不与 Obsidian Templater 插件冲突即可（用最小 `{{token}}` 子集，写回仍是普通 md）。

### 2. 编辑器手感包
- **斜杠菜单 `/`**：在空行输入 `/` 弹出块类型菜单（标题/列表/代码块/表格/引用/分割线/mermaid/callout/图片…）。复用 `.nl-suggest` 的下拉与键盘交互，选中后 `replaceWith` 相应节点。
- **写作统计**：字数 / 阅读时长 / 当日目标进度（纯前端，按 doc 文本计算，放状态栏或侧栏）。
- **专注 / 打字机模式**：当前段高亮其余淡出、光标常驻行中等（视图层 CSS + 滚动定位，不改文档）。
- **正文内 markdown 源码双模式切换**：✅ 已完成（单列项，从手感包拆出）——CodeMirror 6 整篇互切（`Ctrl+/`），原文保真、懒加载，新 `src/source-editor.js` + `src/source-sync.js`；新增 CM/@lezer 依赖，无 Rust。

### 3. 整库导出 HTML 静态站
- ✅ **已完成**：把已有的"单篇导出 HTML"扩成**批量**——新 Rust `build_site_graph`（全库 docs + `[[wikilink]]` 解析表）/`copy_vault_assets`（镜像相对路径复制被引用的图片）+ 新前端 `src/site-export.js`（复用编辑器同一 markdown-it 管线的全保真渲染、链接重写、侧栏树/反链/首页/无依赖纯前端搜索），产物为镜像库树、本地双击即浏览的静态站。画布不进站；pandoc 导 DOCX/PDF 仍列为检测到才启用的独立可选（未做）。
- 把已有的"单篇导出 HTML"扩成**批量**：遍历库，逐篇渲染 HTML 到一个输出目录，**重写 `[[wikilink]]` 与相对图片/文档链接**为站内的相对 `.html`/资源路径，生成首页/侧栏导航（可选简单搜索索引 json）。
- 纯文件产物（一个本地可打开的静态站）。
- **pandoc 导 DOCX/PDF**：作为**可选增强**——检测到系统装有 pandoc 才在导出菜单出现该项，否则不显示（避免硬依赖）。

### 4. 命令面板 + 快捷键自定义
- ✅ **已完成**：新增统一命令注册表 `src/commands.js`（app/editor/plugin 共用、命名空间防冲突）+ 快捷键纯逻辑层 `src/keymap.js`（绑定规范化/有效合成/冲突检出/模糊匹配）；`editor-view.js` 编辑器命令走「两层调度、一份注册表」方案 B（PM keymap 由默认∪覆盖动态生成、`setKeymapOverrides` 经 `state.reconfigure` 原地热重配，结构键固定）；新命令面板 `src/command-palette.js`（`Ctrl+Shift+P`，裸词搜文档/`>` 搜命令）与快捷键设置 `src/shortcut-settings.js`（录制/解绑/重置、撞键硬阻止、localStorage 持久化、两层即时生效）；`bindShortcuts` 硬编码链改为注册表驱动的全局分发器，并修正 `Ctrl+Shift+P` 被打印吞掉（打印收窄为纯 `Ctrl+P`）。纯前端、无 Rust。
- **命令面板**：`Ctrl+Shift+P`（注意 `Ctrl+P` 已被打印占用）唤起，列出所有命令/文档，模糊匹配、回车执行。复用 `.nl-suggest` 观感。
- **快捷键自定义设置页**：把现有硬编码 keymap 抽成可覆盖的映射表，存 localStorage；设置页里"命令 ↔ 按键"可重绑、显示冲突。
- 前置：先有一处**集中命令注册表**（命令面板、插件 `registerCommand`、快捷键设置三者共用），建议这一步把命令注册收敛统一。

### 5. Git 集成（同步首选，单独立项）
- ✅ **已完成（子项目 L：本地基础）**：以 `git2`（libgit2，`vendored-libgit2`、无 openssl）内置接入，**不依赖用户装 git**。新 Rust 命令面 `git_open`/`git_status`/`git_log`/`git_diff_file`（只读）+ `git_config_identity`/`git_init`（含 `.gitignore` seeding 排除 `.notelume-backup/`）/`git_commit_all`（等价 `add -A` + 带身份 commit）；新前端 `src/git-panel.js`（侧栏 Git 面板：Changes/History/diff 预览/提交/初始化）；`app.git.*` 并入批次 D 命令注册表。有意以「本地 vs 远程」而非下述 E1/E2 的「读 vs 写」为切分轴（本地 commit 无认证成本，认证是远程阶段才需啃的硬骨头）：见 [`docs/superpowers/specs/2026-10-14-local-git-integration-design.md`](superpowers/specs/2026-10-14-local-git-integration-design.md)。**含 Rust，须重启 `tauri dev` 重编生效**。
- ⏳ **待做（子项目 R：远程与认证）**：已拆为 R1~R4（成本轴：认证最难、push 依赖 fetch/pull 先行、冲突独立）。
  - ✅ **R1（已完成）**：远程**只读 + 快进 pull**——shell out 系统 `git`（复用凭据助手/ssh-agent/GCM、零凭据存储、检测到才启用），新 `git_r_*`（have/remote list·add·set-url/fetch/upstream/ahead-behind/pull --ff-only）+ `git-panel.js`「同步」区 + `app.git.*` 并入命令注册表 + `afterRemotePull` 编辑器集成。**有意回避合并**（非快进即停、不自动 merge/rebase）。见 [`docs/superpowers/specs/2026-10-14-git-remote-pull-design.md`](superpowers/specs/2026-10-14-git-remote-pull-design.md)。
  - ✅ **R1-B（已完成）**：**内置远程传输（免装系统 git）**——Rust 侧 `RemoteEngine{System, Builtin}` 双后端：装了 git 继续走 R1 shell-out（凭据 UX 最佳），没装自动切内置 git2（`git2` 新开 `ssh`+`https` feature；Windows MSVC 下 libgit2 走 Schannel、libssh2 走 win32-crypto，**仍无 openssl**）。凭据“不存不弹”：SSH 先试 ssh-agent → 无口令私钥；HTTPS 先试 env token（`NOTE_LUME_GIT_TOKEN`/`GITHUB_TOKEN`/`GITLAB_TOKEN`）；皆无 → `[auth]` 引导。SSH 首次连陌生 host 走“一次性信任”（写应用私库，验时与 `~/.ssh/known_hosts` 合并）；新命令 `git_r_trust_host`/`git_r_info`。前端同步区顶部加引擎徽标（terminal 图标「系统 git」/ box 图标「内置引擎」），fetch/pull 错误按 `[host_unknown]`/`[non_fast_forward]`/`[local_changes]`/`[hostkey_mismatch]`/`[network]`/`[auth]` 前串分类引导，陌生 host 弹一次性信任后原地重试。ff-pull 四步原子（fetch → 同 oid 判 → ff_decision → checkout_tree(safe) + reset Soft → 失败回滚）。**R1 当时“依赖系统 git”的妥协至此收扰——ROADMAP 原则 5“纯自包含”并回到闭环**。见 [`docs/superpowers/specs/2026-10-14-git-builtin-remote-design.md`](superpowers/specs/2026-10-14-git-builtin-remote-design.md)。
  - ✅ **R2（已完成）**：**内置 push**——新 `git_r_push` 双后端。System 走 `git push`（同 R1 shell-out 非交互 env，凭据交系统）；Builtin 走 git2 `Remote::push`，固定 `refs/heads/<br>:refs/heads/<br>` refspec（不靠 push.default）、不自动 force。无 upstream 明确回 `[no_upstream]` 引导（不代推设、避免默默创远程新分支）；远端拒非快进 / 权限不足 / 网络 / host key 变化 …统一以 `[code]` 前串回前端，复用 R1-B `handleRemoteErr` 同一张分派表（`push_update_reference` 回调捕 reason 写 `Arc<Mutex<Option<…>>>` 拒因槽）。前端同步区 actRow 新增 `↑ Push` 按钮 + 失败弹框 + `app.git.push` 入命令注册表。**非快进不自动先 pull**（与 R1 一致插不自动 merge/rebase），仅引导人工先拉。见下一行 R2 实现注与 R1-B spec §14。
  - ✅ **R3（已完成）**：**合并拉取 + 冲突暴露与解决**——新 6 命令 × 2 引擎（`git_r_pull_merge`/`conflict_files`/`resolve`/`merge_state`/`abort_merge`/`commit_merge`）。同步区新增 `Pull（合并）` 按钮（非 ff-only）；ff-pull 被拒时引导改走合并拉取（不在错误回调里自动发起，避与 `busy` 串行化重入冲突）。`pull_merge` 统一契约：无冲突回 `MERGED\n…`、有冲突回 `CONFLICTS\n…`、其他失败仍回 `[code]msg`（Builtin 走 git2 `reference_to_annotated_commit`→`merge_analysis`→`repo.merge`→`index.has_conflicts()`）。冲突复用「变更」区——`gitStatus` 已将 `CONFLICTED` 标为 `conflicted`，冲突文件逐行出现并给「用本地 / 用远端 / 编辑」三小按钮（`resolve`：Builtin 从 `index.conflicts()` 取指定边 blob 写工作区 + `add_path`/`write` stage 0；「编辑」经注入的 `openFile` dep 打开带冲突标记文件）；顶部合并工具条 `merge_state`（`repo.state()==Merge`）控制「提交合并」（读 `MERGE_HEAD` 作第二父）/「中止合并」（reset Hard HEAD + 清状态文件）。仍不代持凭据 / 不自动 force。见 R1-B spec §15。
  - 🚫 **R4（经评估：不做 LFS）**：LFS 依赖外部 `git-lfs` 可执行（**libgit2 不实现 LFS**），与 R1-B 立身之本“零外部二进制、纯自包含”直接冲突；且“本地 markdown 库的大附件 + 开了 git 同步”交集很小，gitee/GitHub 的 LFS 又各有配额/成本墙。故 **放弃完整 LFS**，降级为一条轻量护栏（可选、未做）：`commit_all` 对超约 25MB 的文件弹一次性提示（不阻断），提醒大文件会永久留在 git 历史、真需大附件请自配 `.gitattributes` 或换存储——纯前端、零新依赖。**批次 E 视为已闭环。**
- **原分阶段设想（读/写轴，已由 L/R 轴取代）**：
  - **E1 只读**：检测/初始化 `.git`、`status`（改动列表）、`log`（历史）、`diff` 预览。（已随 L 完成）
  - **E2 写**：一键 commit（已随 L 完成）；pull、push（属 R）。
- **真正的成本（务必先设计）**：
  - **认证**：HTTPS 个人访问令牌 / SSH agent / 凭据助手——Tauri 侧如何安全又不越权地代持。
  - **pull 冲突**：markdown 合并冲突的暴露与解决 UX（至少能列冲突文件、打开对比）。
  - 大库/大附件性能与 `.gitignore` 引导（`.notelume-backup/`、`.notelume-plugins/` 等是否入库）。
- **技术选型待定**：`git2`(libgit2) crate（自带、跨平台、无外部依赖，但编译重）vs shell out 系统 `git`（轻，但依赖用户装 git）。建议 E1 先用一种跑通再定。

### 6. 插件系统 v2
- 现状（P2 v1）：钩子与主线程**同权、无沙箱**；schema 创建后不可变，故不支持运行时扩展节点。
- 按依赖链拆为 **F1~F4**，逐块独立立项（每块各自 spec → plan → 实现）：
  - ✅ **F1（已完成）**：**文件夹化插件包 + 声明式清单 + 权限同意软闸门**——`.notelume-plugins/<id>/{manifest.json,main.js}`（目录名===`manifest.id`，**破坏性**：不再识别平铺 `.js`、仅面板提示迁移）；Rust `list_plugins` 只当文件系统枚举器（读 `manifestRaw`+探 `mainExists`、**不解析 JSON/不校 id·scope**，唯一真源移到前端 `src/plugin-manifest.js`）；首载**一律弹**同意（含空权限），consent 存 localStorage `nl-plugin-consent`，权限变更重弹；面板显权限 chip/版本·作者/旧版提示 + 授予/重设。**纯声明+知情同意，不改 ctx、不做技术拦截**。见 [`docs/superpowers/specs/2026-10-15-plugin-manifest-permission-design.md`](superpowers/specs/2026-10-15-plugin-manifest-permission-design.md)。**含 Rust，须重启 `tauri dev` 重编生效**。
  - ⏳ **F2（待做）**：**`registerNodeSpec` 支持**（消费 F1 预留的 `schema` scope）——受 ProseMirror「schema 不可变」约束，需设计「装配前收集插件 spec、统一构建 schema」的加载时机（热加载需重建 state/视图），是扩展语法的唯一入口。
  - ⏳ **F3（待做）**：**权限技术拦截 + 可选隔离**——把 F1 的 scope 契约落成 ctx 能力包装 / `fetch`·fs·git 运行时拦截；混合隔离路线（默认 Obsidian 式信任 + 非编辑器类插件可选 Worker）。深度 PM 集成与硬沙箱互斥，故隔离只对放弃编辑器钩子的插件开放。
  - ⏳ **F4（待做）**：**插件市场**——在线发现/安装/更新/策展，依赖 F1 文件夹包作分发单元。四块齐备才谈得上生态。

### 7. 移动端
- Tauri v2 原生支持 iOS/Android，但真正成本在**触屏交互重排**（侧栏/工具条/右键菜单/拖拽/悬浮预览都要改造）。已在 CHANGELOG 标"计划中"，**建议单独立项**，不占功能迭代节奏。

## 四、建议执行批次（顺序）

- **批次 A**：模板 + 每日笔记（最小、最高留存价值、零风险）— ✅ 已完成（新 `src/template.js` 从模板新建 + `src/daily-capture.js` 全局「今日速记」浮层（按反馈与知识库解绑：不占主编辑区/不切根/未开库可用，存固定绝对目录）+ 工具条 📅/📋 + `Ctrl+Shift+D`）
- **批次 B**：编辑器手感包——斜杠 `/` + 写作统计 + 专注/打字机（源码双模式暂不并入）— ✅ 已完成（新 `src/slash-menu.js` 空行 `/` 弹块菜单（复用 `.nl-suggest` 观感、仅空块触发）+ `src/writing-stats.js` 工具条字数/阅读时长/目标（`getText()`+`onDocChange`）+ `src/editor-modes.js` 专注(`Ctrl+Shift+F`)/打字机(`Ctrl+Shift+T`)，开关存 localStorage；均无 Rust）
- **批次 C**：整库导出 HTML 静态站（pandoc 作为检测到才启用的可选项）— ✅ 已完成（新 Rust `build_site_graph`/`copy_vault_assets`（附单测，需重启 tauri dev）+ 新前端 `src/site-export.js`（全保真渲染/链接重写/导航/反链/首页/搜索，Tauri I/O 依赖注入）+ `src/tauri-bridge.js` 封装 + 「更多」→「导出整站…」；Node 单测 `src/tests/site-export.test.mjs`）
- **批次 D**：命令面板 + 快捷键自定义（顺带收敛统一命令注册表）— ✅ 已完成（新 `src/commands.js` 统一注册表 + `src/keymap.js` 快捷键纯逻辑 + `src/command-palette.js` `Ctrl+Shift+P` 命令/文档面板 + `src/shortcut-settings.js` 可重绑/冲突硬阻止；`main.js` `bindShortcuts` 改注册表驱动全局分发器、打印收窄纯 Ctrl+P；`editor-view.js` 方案 B 动态 keymap 热重配 + `plugin-loader.js` 插件命令并入；均无 Rust，刷新即生效；`keymap.test` 14、`roundtrip` 35、`build:web` 全绿）
- **批次 E**：Git 集成——子项目 L（本地基础）✅ + 子项目 R1（远程 shell-out 认证 + 快进 pull）✅ + 子项目 R1-B（内置 libgit2 远程，免装 git）✅ + 子项目 R2（内置 push，双后端 + `[code]` 前串同张分派表）✅ + 子项目 R3（合并拉取 + 冲突暴露与解决，6 命令 × 2 引擎）✅ 均已完成；R4 经评估放弃 LFS（与内置自包含冲突），仅余可选大文件提交提示
- **批次 F**：插件系统 v2（按依赖链拆 F1 清单+权限同意 → F2 registerNodeSpec → F3 拦截+隔离 → F4 市场）— **F1 ✅ 已完成**（文件夹化包 + 声明式清单 + 首载一律弹权限同意软闸门；破坏性：不再识别平铺 `.js`；不改 ctx、不做技术拦截属 F3）；F2/F3/F4 待做
- **批次 G**：移动端（单独立项）
- **功能项 I（Word/.docx → Markdown 离线保真导入）+ 前置功能项 J（编辑器无损扩展）**：不在上表候选内、由“迁移 Obsidian/Word 用户”诉求单独立项。**先 J 后 I**：J 让编辑器能无损往返脚注/合并表，I 的保真产物才不会一打开就坏。✅ **J（已完成）**：脚注（Typora 式、`markdown-it-footnote` 入主 tokenizer）+ 合并单元格表（含 colspan/rowspan 存真 `<table>` HTML 往返 + 接 `mergeCells`/`splitCell`），纯前端无 Rust（见 [`docs/superpowers/specs/2026-10-15-editor-footnote-merged-table-design.md`](superpowers/specs/2026-10-15-editor-footnote-merged-table-design.md)）。✅ **I（已完成）**：`.docx` 离线零配置→保真 Markdown 逐个校对导入 + 图片去重（Rust `docx_import.rs` zip+roxmltree 映射 OOXML、**无 openssl**；`docx_preview` 只转不写 → 前端校对模态（独立 markdown-it 预览 + CodeMirror 源码）→ `docx_commit` 落库+sha256 去重；批量队列状态机失败不阻断；含 Rust 须重启 `tauri dev`；见 [`docs/superpowers/specs/2026-10-15-docx-markdown-import-design.md`](superpowers/specs/2026-10-15-docx-markdown-import-design.md)）
  - ✅ **I 后续·交叉引用 + 多级列表 + 内部锚点三处联动（已完成）**：把 Word 交叉引用（`REF`/`PAGEREF`/`NOTEREF` 域 + 书签锚点超链接）导成 `[可见文本](#slug)` 内部链接，多级列表放开到任意深度（护栏重设而非移除）；`#锚点` 从死链变可跳——以 `src/heading-anchor.js`↔Rust `heading_anchor_slug` 的**共享 slug 契约**（由 `src/tests/fixtures/heading-slug.json` 双边锁死）串起导入（写链接）/ 站点导出（`site-export.js` 给标题发 `id`）/ 编辑器（`anchor-link.js` 点击反查跳转）三处；非标题目标（图/表/公式）降级为纯文本 + warning。含 Rust 须重启 `tauri dev`；见 [`docs/superpowers/specs/2026-10-16-docx-xref-multilevel-list-design.md`](superpowers/specs/2026-10-16-docx-xref-multilevel-list-design.md)

## 五、暂缓 / 存疑（避免踩坑）

- **pandoc / 系统 git** 等外部二进制：一律"检测到才启用"，不做硬依赖。
- **正文 markdown 源码双模式**：✅ 已完成（见上·单列项；CodeMirror 6，`Ctrl+/` 整篇互切、原文保真、CM 懒加载）。
- **`registerNodeSpec` 运行时热加载**：受 ProseMirror schema 不可变约束，需改加载时机，属插件 v2 的难点而非起点。
- **知识图谱大图 / 复杂 3D**：维持"可选附加、不默认渲染"的既定取舍。

---
_本文档为规划草案，随每批次落地后回填状态（未开始 / 进行中 / 已完成）。当前：批次 A/B/C/D 已完成；批次 E（Git 集成 L + R1 + R1-B + R2 + R3，R4 经评估不做 LFS）已闭环；批次 F（插件 v2）已拆 F1~F4，**F1（文件夹化清单 + 权限同意软闸门）已完成**、F2/F3/F4 待做；批次 G（移动端）未开始；功能项 I（docx 导入）及其前置 **功能项 J（编辑器无损扩展：脚注 + 合并表）均已完成**。_
