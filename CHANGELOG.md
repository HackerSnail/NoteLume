# 更新日志

本项目的所有重要变更都会记录在此文件中。

格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### Added

- **Dracula 主题**：主题按钮改为 浅色 → 暗黑 → Dracula 三态循环。采用 **Dracula 官方色板**（背景 #282a36 / 文字 #f8f8f2 / 强调紫 #bd93f9 / 注释蓝 #6272a4 / 选中 #44475a），代码高亮也换为 Dracula 语法色（关键字粉、字符串黄、数字紫、函数绿）；深色族派生样式（代码高亮基线、语言标签、滚动条）改用 `data-dark` 统一命中，两个暗色系主题共享
- **版本快照 UI**（P2）：侧栏新增 📦 历史版本面板，列出当前文档在 `.notelume-backup/` 下的历次快照（最新在前）；点条目弹模态用 markdown-it 渲染全文预览；右下角“↩ 回滚到此版本”一键写回原 md（覆盖前自动先备份当前版，回滚可逆）。新 Rust command `read_backup(vault_root, backup_rel)`（前缀白名单 + `abs_in_vault` 双重防路径穿越，附单测）；新前端 `src/snapshot-panel.js`
- **插件基础钩子系统**（P2）：把 `.js` 放进 `<vault>/.notelume-plugins/`，开库后自动加载。插件 `export default` 一个对象，可在 `onInit(ctx)` 里 `registerKeymap` / `registerCommand` / `registerInputRule`，并实现在 `onEditorReady` / `onDocChange` / `onFileOpen` / `onSave` 生命周期钩子。因为编辑器开库前已装配，keymap/inputRule 用 `state.reconfigure` 运行时热注入（带 `__nlPlugin` 标记可重入刷新）；schema 创建后不可变，registerNodeSpec/MarkSpec v1 暂不支持。侧栏 🔌 插件面板列出已加载插件 + 启用/禁用（localStorage 记忆）+ 命令按钮。新 Rust commands `list_plugins` / `read_plugin`（同样前缀白名单防穿越，附单测）；新前端 `src/plugin-loader.js` + 示例 `examples/notelume-plugins/hello.js`
- **画布 / 白板**（P2）：类 Obsidian Canvas 的自由画板。数据遵循 **JSON Canvas 规范**（`.canvas`，与 Obsidian 互操作，无私有格式）：`{nodes:[{id,type:"text"|"file",x,y,width,height,color,text|file}], edges:[{id,fromNode,fromSide,toNode,toSide,label,color}]}`。新前端 `src/canvas-view.js`（SVG 渲染 + 视口平移/滚轮缩放以光标为锚 + 拖拽移动（可多选 shift）+ 端口拖拽连线 + 角点 resize + 双击编辑文字/背景新建卡片 + 六色色板 + 适应视图 + Delete 删除）；文件节点双击跳转对应文档。Rust 仅让 `scan_vault` 把 `.canvas` 纳入文件树（`is_canvas`，进树不进索引，附单测），IO 复用通用 `read_md_file`/`write_md_file`（含路径安全），**未新增命令、未引入依赖**。工具条 🗺 新画布 一键新建空画布并落盘；打开/保存/脏检查/自动备份按 `state.mode` 与编辑器分流，画布按 JSON 往返无损
- **画布增强：多选对齐 + 分组**（P2）：工具条新增对齐区（左/水平居中/右/顶/垂直居中/底 六向对齐，选中≥２生效）、等距分布（水平/垂直，选中≥３）、编组/解组。分组采用 **JSON Canvas / Obsidian 兼容的 `type:"group"` 节点**（`{id,type:"group",x,y,width,height,label,color}`，往返无损）：分组框垫底渲染、半透填充可点击穿透（仅边框/标签可选中）、虚线边框选中变实线；**拖动分组框会连带框内成员一起移动**（按成员中心是否落在框内判定）；双击分组框顶部可编辑标签。连线目标排除分组框
- **画布增强：撤销/重做 + 连线方向箭头 + 边标签编辑**（P2）：① 快照式历史栈（`Ctrl+Z` / `Ctrl+Shift+Z`·`Ctrl+Y`，工具条 ↶↷），按“手势/离散操作”粒度入栈（移动/缩放/连线/对齐/分布/编组/删除/颜色/新建/文字编辑各一条），上限 100 步，切换/新建画布时清空；② 连线默认在目标端画方向箭头（复用已有 `#cv-arrow` marker），支持 JSON Canvas 的 `toEnd`/`fromEnd`（`"arrow"`/`"none"`，与 Obsidian 互操作；新建边自动带 `toEnd:"arrow"`）；③ 双击连线可编辑边标签（复用浮层编辑器）
- **画布增强：选择与精度**（P2）：① **框选 marquee**——背景 + Shift 拖出矩形批量选中（与普通背景拖拽平移互不干扰，选区可与已有选择叠加）；② **方向键微调**——选中后←↑→↓ 移动 1px、Shift+方向键 10px（连按合并为一条撤销记录，拖分组框连带成员）；③ **Ctrl+A 全选**（不含分组框）；④ 工具条 ↶↷ 按钮随历史栈空/非空自动置灰
- **画布增强：复制/粘贴/重复 + 缩放控件**（P2）：① `Ctrl+C`/`Ctrl+V`/`Ctrl+D` 复制、粘贴、重复选中元素（连同一并复制两端都在选区内的连线，粘贴时重新生成 id 并映射边端点、默认偏移 +24px，连续粘贴逐级错开）；② 工具条新增 `−` / `＋` 缩放按钮（以视口中心为锚），百分比标签可点击重置 100%；键盘 `Ctrl +/-` 缩放、`Ctrl+0` 重置
- **画布增强：拖拽智能对齐**（P2）：拖动卡片时，靠近其他卡片的边/水平中心/右边（或顶/垂直中心/底）在 8px（随缩放换算）阈值内自动**磁吸**对齐，并画出参考线（`.cv-guide`，不随缩放变粗）；多选拖动按选择整体包围盒对齐；按住 **Alt 临时禁用**磁吸；松开即清除参考线
- **画布增强：右键上下文菜单**（P2）：在画布上右键弹出上下文感知菜单，把散落的能力聚合到指针下——**背景**（新建卡片/粘贴/全选/适应视图/重置缩放）、**卡片**（编辑文字·打开文件/复制/删除/颜色色板行/编组·解组/六向对齐行/等距分布行，按选中数量条件显示）、**连线**（编辑标签/切换方向箭头✓/删除）；三类菜单底部统一挂撤销·重做（随历史栈自动置灰）。纯 DOM 浮层（`.cv-menu`）复用既有模型函数与色板，点选/外点/Esc/滚轮/失焦即关，菜单自动避让画布边缘不出屏；零新依赖
- **画布增强：卡片内 Markdown 渲染**（P2）：文本卡片不再只显纯文本，而是以 **markdown-lite** 渲染（标题/粗体·斜体/有序无序列表/行内代码·代码块/引用/分割线/表格/删除线/自动识别链接），复用项目已有的 markdown-it（`html:false` 转义原始 HTML 防注入，零新依赖）。`.canvas` 仍存**原始 markdown** 文本（与 Obsidian 卡片渲染对齐、往返无损）；双击编辑时回到原始 markdown 的 textarea；渲染结果按文本缓存（临时字段 `_md`/`_mdSrc`，save/snapshot 自动剔除）。卡片内链接仅样式化不可点（应用未接外部 opener，避免劫持拖拽）
- **画布增强：缩略图 minimap**（P2）：画布右下角全局小地图，按节点包围盒自适应缩放到 180×120，把每张卡片（分组框虚线）绘为小矩形并高亮选中项；叠加一个**视口框**实时反映当前可见区域。在缩略图上点击/拖拽即可平移主视口到对应区域（setPointerCapture 支持连续拖动）。工具条 ▦ 按钮显隐，选择记 localStorage。纯前端 SVG，复用现有渲染/变换，零新依赖；`applyView`（平移/缩放）与 `render`（节点变化）分别只刷新视口框/节点层，`destroy` 清理拖拽监听
- **文件树右键删除**：在左侧文件树的文档/画布上右键弹出菜单（打开 / **删除**），不再只能调出浏览器原生菜单。删除前弹原生确认框（明确提示不可撤销）；若删的是当前打开文档则自动清空编辑区回到无文档态；删后重扫文件树。新 Rust command `delete_file(vault_root, path)`（经 `abs_in_vault` 限定库内、拒绝 `..` 越界与目录，附单测 `delete_file_removes_inside_and_rejects_escape`）；菜单复用画布已有的 `.cv-menu` 样式

### 计划中（P2 未完项）

- 移动端适配

### Fixed

- **图片无法显示**：编辑器内 `![](./assets/x.png)` 等相对路径图片此前全部碎图。根因：Tauri webview 中 `<img src=相对>` 会解析到应用自身 origin（`http://tauri.localhost/`）而非磁盘，必然 404。修复：为 `image` 节点新增 NodeView，通过新 Rust command `read_image_data_uri(vault_root, md_rel, src)` 读图片字节返回 `data:` URL（手写 base64 编码，无新依赖；路径用 canonicalize + `ensure_inside_root` 限定库内，允许 `..` 但拒绝逃逸）；http/data/blob 直接透传。此方案不依赖 asset 协议 scope/跨域，最稳。序列化仍用原始相对 src（attrs 不变），写盘/往返无损；结果按绝对键缓存，切文件不重读。`tauri.conf.json` 保留 `assetProtocol` 启用（无害，供其他场景）
- 补充修复：图片链接遵循 URL 规范，文件名里的空格被编码为 `%20`（如 `image%201.png`），而磁盘真实名是 `image 1.png`。`resolve_media_abs` 新增 `percent_decode`，解析前先还原 `%XX`（否则中文目录/含空格附件图永远 404）
- **画布初始化崩溃**：`canvas-view.js` 中 `zoomLabel` 声明在 `buildToolbar()` 调用之后，而 `buildToolbar` 内会赋值 `zoomLabel`，触发暂时性死区（“Cannot access 'zoomLabel' before initialization”）导致整个应用启动失败。将 `let zoomLabel = null` 上提到状态区（先于调用）
- **主题按钮名称与实际不符**：按钮此前显示“下一个主题”（如当前为 Dracula 时显示“☀️ 浅色”），易误读为当前主题。改为显示当前主题名（☀️ 浅色 / 🌙 暗黑 / 🧛 Dracula），与界面实际一致（主题显示名由“吸血鬼”改为“Dracula”）
- **新建画布“点了没反应”**：未打开知识库时 `newCanvas` 仅写状态栏小字提示，易被忽略。改为弹原生提示框（`messageDialog` info）明确告知需先打开知识库文件夹（画布需保存为库内 `.canvas`）
- **画布连线“连不上”**：拖端口连线时，`hitNode` 用严格矩形包含判定，而端口/边缘在矩形边界上，光标差几个像素落在节点外就判空，松手不生成边。修复：连线命中给 ±28px（随缩放换算）容差；命中时目标节点高亮描边 + 虚线吸附到目标最近端口，让“能不能连”一目了然
- **索引“构建超时”（实际已就绪）**：前端轮询用 `st.vaultRoot === state.vaultRoot` 判断索引就绪，但 Rust 存的是 `fs::canonicalize` 后的路径（Windows 带 `\\?\` verbatim 前缀、盘符大写），与对话框返回的原始路径永不相等 → 永远轮询到 60s 超时（后台索引其实早已建好，反查/搜索仍可用，仅误报）。新增 `normVaultPath` 规范化后比较（去 `\\?\` 前缀、统一分隔符、去尾部、忽大小写）
- **打开/新建画布时节点跑到左上角被裁**：`openCanvas`/`newCanvas` 先调 `canvasView.open/newBlank`（内含 `fitView`/`centerWorld`）再 `setMode('canvas')`，此时容器仍 `display:none`，`getBoundingClientRect()` 返回 0×0 → fitView 算出负平移把节点甩出屏幕。改为先 `setMode('canvas')` 再开画布；并从根上加固：`fitView` 遇 0×0 时 `requestAnimationFrame` 下帧重试（不再用零尺寸算变换）；`newBlank` 初始卡片改为固定放世界原点 (0,0)、视图 tx/ty=80（不依赖 `centerWorld`，新画布卡片永不出屏）；“适应”最大缩放由 3× 改为 1×（单卡片不再被放大到 300%）

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
