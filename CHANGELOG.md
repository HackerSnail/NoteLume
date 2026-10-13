# 更新日志

本项目的所有重要变更都会记录在此文件中。

格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### Added

- **吸血鬼主题**：主题按钮改为 浅色 → 暗黑 → 吸血鬼 三态循环。采用 **Dracula 官方色板**（背景 #282a36 / 文字 #f8f8f2 / 强调紫 #bd93f9 / 注释蓝 #6272a4 / 选中 #44475a），代码高亮也换为 Dracula 语法色（关键字粉、字符串黄、数字紫、函数绿）；深色族派生样式（代码高亮基线、语言标签、滚动条）改用 `data-dark` 统一命中，两个暗色系主题共享
- **版本快照 UI**（P2）：侧栏新增 📦 历史版本面板，列出当前文档在 `.notelume-backup/` 下的历次快照（最新在前）；点条目弹模态用 markdown-it 渲染全文预览；右下角“↩ 回滚到此版本”一键写回原 md（覆盖前自动先备份当前版，回滚可逆）。新 Rust command `read_backup(vault_root, backup_rel)`（前缀白名单 + `abs_in_vault` 双重防路径穿越，附单测）；新前端 `src/snapshot-panel.js`

### 计划中（P2 未完项）

- 插件基础钩子系统
- 画布 / 白板
- 移动端适配

## [0.3.0] - 2026-10-13

P2 首项落地：简易知识图谱（零外部依赖，基于现有索引，单文件 264 行）。

### Added

#### 知识图谱（模态层）

- **Rust** 新 command `get_graph_data(vault_root)` 从当前 `VaultIndex` 抽取 `{nodes, edges}`；无向归一（同一对文档的 A→B / B→A 合并为 1 条边，权重=双向链接总次数），不连自身
- **前端** `src/graph-view.js`：自实现 Canvas 2D 力导向布局（斥力 + 弹簧 + 向心 + 阻尼），零外部依赖；预热 320 tick 每帧 5 步，收敛后自动降频，>800 节点不崩
- **交互**：拖平移背景、滚轮缩放（以鼠标点为中心，0.35~3.5x）、拖节点重定位、hover 高亮邻边 + 添标题、点节点直接跳文档；Esc / × 按钮 / 背板点击关闭
- **高亮**：当前文档红点；节点半径按 degree 平方根映射（3~14px）；边粗细按权重
- **工具条** 新增 🕸 图谱 按钮；Ctrl+G 应开/已开则无操作（幂等）
- **样式** 亮/暗主题自适应（面板背景 / 卡片阴影 / 颜色变量均走现有 CSS 体系）

### Fixed

- **标签支持 Unicode CJK**：`is_tag_start` / `is_tag_char` 从 `is_ascii_alphanumeric()` 升为 `is_alphanumeric()`，与 Obsidian 行为一致；新写入单测 `extract_tags_basic_and_cjk` 验证 `#世界` 类中文标签
- 单测目录新增 4 个 Rust 单测（`extract_wikilinks_basic` / `extract_wikilinks_dedup_and_strip_alias` / `extract_tags_basic_and_cjk` / `extract_graph_merges_undirected_and_skips_self`），为后续索引层改动提供回归保护

## [0.2.0] - 2026-10-13

P1 知识库完善阶段全量落地（双向链接 · 搜索 · 自动保存 · KaTeX · 高亮 · 导出 · 悬浮预览）。

### Added

#### 知识库索引（Rust 后台）

- 新增 `VaultIndex` 托管状态 + `Arc<Mutex<…>>` 共享；`rebuild_index` 开后台线程全量扫描，不阻塞 UI
- `update_index_doc` 在每次保存后增量更新（文档标题/标签/出链），反查表同步修正，无需全量重建
- 前端 `startIndexPolling` 500ms 一次 `get_index_status`，就绪后自动刷新反链面板

#### 双向链接面板

- 侧栏新增「双向链接」面板，上区「引用本文档」、下区「本文档引用」，点击直接跳转
- `query_backlinks` / `query_outgoing` 两个新 command

#### 全局搜索

- 侧栏顶部搜索框，230ms 防抖，`search_vault` 基于索引匹配标题/正文/#标签
- 结果卡片展示标题 + 相对路径 + 匹配片段 + 命中来源 badge
- Ctrl+F 聚焦搜索框，Esc 清空
- 标签 chip 点击直接归入搜索

#### 自动保存 + 备份

- 工具条开关（localStorage 记忆），停手 2s 自动写回，失败仅日得日志不弹窗
- 每次手动保存、以及自动保存后每 2 分钟间隔，写入一份时间戳副本到 `.notelume-backup/YYYY-MM-DD/{stem}-HH-MM-SS.md`
- `.notelume-backup` 目录默认不入库扫描（已加入 `SKIP_DIRS`）

#### KaTeX 数学公式

- 新增 `math_inline` / `math_block` 行内与块级原子节点；markdown-it 自定义 inline + block 规则
- NodeView 使用 katex.render 展示，失败自动降级为 `$…$` 预览；双击可编辑（目前走 window.prompt）
- 往返幂等回归测试新增两例（行内公式 / 块公式），共 12/12 全通
- 输入 `$x^2$` 敲完尾 `$` 自动射为公式；Ctrl+M / Ctrl+Shift+M 插入行内/块级占位
- 普通文本中的 `$` 均转义，与行内公式不冲突（`escapeExtraCharacters: /[#$]/g`）

#### 代码块语法高亮

- `hl-decorations.js`：将 highlight.js 输出的 HTML 映射为 ProseMirror inline Decoration
- 仅视图层上色，不污染文档模型，不影响 markdown 内容，不影响往返幂等
- 内置亮/暗双套主题（GitHub-like）

#### 导出 HTML / 打印 PDF

- 工具条 📤 导出：markdown-it 渲染自含样式的 HTML，系统保存对话框选目录，`export_file` 写入任意路径
- 工具条 🖨 打印 + Ctrl+P：使用系统打印对话框，可另存为 PDF

#### [[链接]] 悬浮预览

- `wiki-hover.js`：hover 380ms 展示卡片（fixed 定位，自动避开屏幕边缘）
- 优先从索引 `get_doc_info` 拿标题 + 摘要，未就绪回落到 `doc_preview` 直接读文件
- 目标不存在时提示“文档不存在·点击可新建”

#### 工程

- 新增 8 个 Rust command（共 15 个）；`IndexState` 作为 `tauri::Builder.manage` 托管
- Cargo.toml 新增 `chrono = 0.4`，仅取 clock+std 子特性
- 前端新增 `katex` `highlight.js` 依赖

### Changed

- `resize` 中 `resolve_wiki_link` 抽取 `resolve_one` 内部函数，供索引与 command 共用
- `save_image_bytes` / `copy_image_asset` 行为不变，仅代码路径重新整理
- `escapeExtraCharacters` 从 `/#/g` 扩展为 `/[#$]/g`
- 行内代码块中 `#` 不再被误认为标签（tokenizer 并自测已覆盖）

## [0.1.0] - 2026-10-13

首个可运行版本：P0 全部落地（Typora 式 WYSIWYG + 精简 Obsidian 知识库能力）。

### Added

#### 编辑器核心（对标 Typora）

- ProseMirror 单文档一体化 WYSIWYG Markdown 编辑，非左右分屏源码模式
- GFM 支持：标题、粗体、斜体、删除线、段落、引用、无序/有序列表、任务列表、表格、行内代码、代码块、图片、链接、分隔线、硬换行
- Markdown ↔ ProseMirror 双向无损转换（纯 GFM，无私有格式，与 Typora/Obsidian 文件互通），配套 10 项幂等回归测试（`src/tests/roundtrip.test.mjs`）
- 拖拽 / 粘贴图片自动落库 `assets/` 目录，正文写入相对链接 `![](./assets/xxx.png)`；同名不同内容按内容哈希去重
- 快捷键：Ctrl+S 保存、Ctrl+O 打开文件、Ctrl+Shift+O 打开知识库、Ctrl+B 粗体、Ctrl+I 斜体、Ctrl+\` 行内代码、Ctrl+Shift+X 删除线、Ctrl+Z / Ctrl+Y 撤销重做、Shift+Enter 硬换行
- 浅色 / 暗黑主题切换（localStorage 记忆），类 Typora 阅读排版（固定阅读宽度、舒适字体与行高）
- 输入 `[[目标]]` 敲完右括号即时生成可点击链接节点；输入 `#标签 ` 空格触发标签节点

#### 知识库核心（精简 Obsidian）

- 打开本地文件夹作为知识库：Rust 后台递归扫描 md 文件树（跳过隐藏目录与 node_modules/target 等）
- 侧边栏文件树：文件夹可折叠，点击文件直接切换编辑器，当前文件高亮
- 单独打开一个 md 文件：以其所在目录为工作根，侧栏只列当前文件，保存/图片/wikilink 均正常
- `[[wikilink]]` 点击跳转库内文档：支持路径式与按文件名（全库查找）两种解析；目标不存在时提示一键新建
- 文档大纲面板：实时提取标题层级，点击跳转对应位置
- 文档标签面板：识别并汇总当前文档全部 `#tag`
- 路径安全：库内相对路径统一 `/` 分隔，读写拒绝 `..` 越出库根

#### 工程与协作

- Tauri v2 + Rust 后端（文件扫描/读写/wikilink 解析/图片落库共 7 个 invoke 命令）
- 前端 Vanilla JS + Vite（不引入 Vue/React）
- 根 `package.json` 代理 `src/` 本地安装的 `@tauri-apps/cli`，仓库根一条 `npm run dev` 即可启动
- 应用图标经 `tauri icon` 生成
- README.md（特性状态表 / 安装启动打包 / 上手清单 / 已知边界）
- 采用 Apache License 2.0

### Fixed

- 启动即崩导致所有按钮无响应：ProseMirror 插件误以普通对象传入 `EditorState.create`，改为 `new Plugin({…})`
- 增加全局 `error` / `unhandledrejection` 捕获，异常直接显示在状态栏，杜绝"白屏无反应"无从排查
- Ctrl+O 语义与需求文档对齐（原文档要求"Ctrl+O 打开文件"，初版误绑为打开文件夹）

[unreleased]: https://gitee.com/hackerSnail/note-lume/compare/master...dev
[0.3.0]: https://gitee.com/hackerSnail/note-lume/compare/v0.2.0...v0.3.0
[0.2.0]: https://gitee.com/hackerSnail/note-lume/compare/v0.1.0...v0.2.0
[0.1.0]: https://gitee.com/hackerSnail/note-lume
