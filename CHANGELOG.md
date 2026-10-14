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
- **文件树右键删除（移入回收站）**：在左侧文件树的文档/画布上右键弹出菜单（打开 / **删除**），不再只能调出浏览器原生菜单。删除是**移入系统回收站**（可从回收站恢复），前弹原生确认框；若删的是当前打开文档则自动清空编辑区回到无文档态；删后重扫文件树。新 Rust command `delete_file(vault_root, path)`（经 `abs_in_vault` 限定库内、拒绝 `..` 越界与目录，调 `trash::delete` 移入回收站；附单测 `delete_file_rejects_escape_dir_and_missing`）；菜单复用画布已有的 `.cv-menu` 样式。新增依赖 `trash`（跨平台回收站，Windows 走 Shell API）
- **删除时同步清理索引**：文件移入回收站后，索引（`VaultIndex`）会即时移除这条文档，无需全量重建。新 Rust command `remove_index_doc(path)`：删 `docs` 条目、清掉它写入他人 `backlinks` 的 outgoing 贡献、并移除自身作为 target 的 `backlinks`（`ready=false` 时跳过，交由 rebuild）；抽为纯函数 `remove_doc_from_index` 附单测 `remove_doc_from_index_clears_entry_and_backlinks`。前端在 `deleteFile` 成功后调 `removeIndexDoc`（canvas 不在索引内，为空操作），与保存后的 `updateIndexDoc` 对称
- **Frontmatter（YAML 头）保留 + 编辑面板**（P3 首批）：读写 md 不再破坏文件开头的 `---\n<yaml>\n---` 头——解析前剥离、序列化前**逐字节原样补回**（用户手写的键顺序/注释/引号风格不丢，只有显式编辑才重排）。新纯模块 `src/frontmatter.js`（`splitFrontmatter`/`joinFrontmatter`，仅识别文件绝对开头的围栏，未闭合/无 fm 安全降级为不改动）；`editor-view.js` 在边界接住（`setMarkdown` 剥离、`getMarkdown` 补回，新增 `getFrontmatter()`/`setFrontmatter()`）。侧栏新增「文档属性」面板（`src/frontmatter-panel.js`）：已解析字段只读摘要 + 源码 textarea 编辑（应用前用 js-yaml 校验，失败不落盘）+ 显式「重新格式化」（可能改动注释/顺序，故不自动）。导出 HTML 自动剔除 frontmatter。YAML 解析引入新依赖 `js-yaml`（成熟、稳）；`roundtrip.test.mjs` 新增 frontmatter 往返幂等 + 边界用例
- **文件树基础操作：新建 / 重命名 / 移动**（P3 批次 2 · 2A）：左侧文件树右键菜单补齐——**文件项**（打开 / 重命名·移动 / 移入回收站）、**文件夹**（新建文件 / 新建文件夹 / 重命名·移动）、**树空白区**（在库根新建文件/文件夹）。新建/重命名用应用内单行输入模态（`src/prompt-dialog.js`，因 Tauri webview 下 `window.prompt` 不可靠；Enter 确认 / Esc 取消 / 重命名预选文件名主干保留扩展名）。重命名与移动合一项：“新名称”含路径分隔符即跨目录移动；文件会自动保留原扩展名。新 Rust commands `create_dir(vault_root, path)` 与 `rename_item(vault_root, from, to)`（均走 `vault_join`/`abs_in_vault` 限库内 + 拒绝 `..` 越界；create 拒绝重名；rename 要求 from 已存在、to 不静默覆盖、禁止文件夹移入自身；附 `create_dir_makes_dir_and_rejects_escape_and_exists` / `rename_item_renames_and_rejects_escape_and_exists` 单测）。重命名/移动后走 `startIndexPolling()` 全量重建索引以反映新路径；若改的是当前打开文档（或其所在文件夹）则 `remapCurrentAfterRename` 只重映射当前路径标识、不重载内容，保留编辑器缓冲与脏状态。零新增 JS 依赖
- **文件树拖拽：内部移动 + 外部拖入导入**（P3 批次 2·2B）：① **拖拽移动**——文件/文件夹设为 `draggable`，在 `els.tree` 上用事件委托接 dragstart/dragover/dragleave/drop（重渲染不丢监听）；目标解析：拖到文件夹→移入该文件夹、拖到文件→移入其所在目录、拖到空白→库根；落点复用 `rename_item`，目标项 `.tree-drop-hover` 高亮；原地放置自动跳过。② **外部拖入导入**——沿用编辑区已有的 DOM `dataTransfer.files` 机制（非 Tauri 原生事件），新 Rust command `import_vault_file(vault_root, { destDirRel, name, dataBase64 })`：`vault_join` 限库内（目标目录不存在则创建）、name 只取末段文件名（去除任何目录成分/拒绝 `..`）、同名不同内容时按 fnv1a 内容指纹重命名（附单测 `import_vault_file_writes_sanitizes_and_rejects_escape`）。前端只放行 `.md` / `.canvas` / 图片白名单，不支持类型弹提示；多文件逐个导入。导入/移动后 `renderTree` + `startIndexPolling()` 重建索引。零新增 JS 依赖
- **标签全局视图**（P3 批次 3）：侧栏「标签」面板在“本文档标签”下方新增“全局标签”区——列出全库所有 `#标签` 并带出现次数 badge（按次数降序、同数按名序）；点某个标签就地展开含该标签的文档列表，点文档直接跳转（再次点同一标签收起）。新 Rust commands `list_all_tags(state) -> Vec<{tag, count}>` 与 `query_tag(state, tag) -> Vec<{path, title}>`（查询忽略大小写与开头的 `#`），均基于已有 `VaultIndex`（每文档存 `tags`）派生；抽为纯函数 `collect_all_tags` / `collect_docs_by_tag` 附单测 `collect_all_tags_counts_sorts_and_query_tag_matches`。前端新 `refreshGlobalTags()` 由索引就绪时（`startIndexPolling` tick）触发，未开库/未就绪显占位。零新增依赖（frontmatter 里的 `tags:` 暂未纳入聚合）
- **`[[` / `#` 输入自动补全下拉**（P3 批次 4）：编辑器输入 `[[` 时弹文档名模糊匹配下拉、输入 `#` 时弹已有标签补全（Obsidian 核心手感）。新独立模块 `src/suggest-plugin.js`（手搓 ProseMirror `Plugin`，零新依赖）：不抢文本输入，每次 doc/选区变化后在光标前正则识别 `[[query` / `#query`，命中候选则弹 `position:fixed` 下拉；↑/↓ 移动、Enter/Tab 选当前、Esc 关闭、点项选中；选中后用 schema 已有的 `wikiLink`/`tag` 节点 `replaceWith` 替换原始 `[[…`/`#…` 文本（与手敲成环走同一批节点，无第二条序列化路径）。候选源：`[[` 走全库 `.md` 文件名主干（`renderTree` 里 `collectDocNames` 递归收集），`#` 走全库标签（`refreshGlobalTags` 写入），前端子串过滤 + 前缀优先 + 去重截断 12 条。插件装配在 `editor-view.js` 的 `history()` 之后、`keymapPlugin`/`base` 之前（保证补全的 Enter 先于段落切分被处理）；`createEditor` 通过 `opts.suggestDocs/suggestTags` provider 惰性取数。`npm run build:web` 152 modules、`roundtrip` 18 passed。零新依赖
- **表格完整编辑**（P3 批次 5）：基于 `prosemirror-tables` 把表格从“只能编辑内容”升级为完整的人体工学——**Tab / Shift-Tab 跨格跳转**（表末尾自动补行）、**列宽拖拽**（拖单元格右边线）、**单元格拖选**、**右键行列菜单**（上/下方插入行、左/右侧插入列、删除本行/列、左/中/右对齐、切换首行为表头、删除整个表格）。用库的 `tableNodes({ tableGroup:'block', cellContent:'inline*', cellAttributes:{ alignment } })` 接管现有自建 `table/table_row/table_header/table_cell` spec（cell 自带 colspan/rowspan/colwidth + TableMap；节点名不变，Markdown 解析与 `serializeTable` 零改动，GFM 往返仍无损）；新模块 `src/table-editing.js`（tablePlugins/tableKeymap/attachTableContextMenu，菜单复用 `.cv-menu`）。新增依赖 `prosemirror-tables`；`style.css` 补 `.tableWrapper`/列宽手柄/选中覆盖层/.table-menu。`npm run build:web` 154 modules、`roundtrip` 22 passed（+空单元格/仅表头/单元格内联标记三个边界用例 + 对齐与结构 attrs 定向断言）。边界：GFM 不支持合并单元格，故有意不接 merge/split；列宽仅视口内生效不入 md
- **Obsidian callout `> [!NOTE]` 渲染**（P3 批次 6）：把 `> [!TYPE] 标题` 系列（NOTE/TIP/INFO/TODO/WARNING/IMPORTANT/FAILURE/DANGER/ERROR/SUCCESS/QUESTION/EXAMPLE/QUOTE 及任意自定义 type）渲染为带标题、彩色左边框/背景的卡片，**不破坏 GFM 引用语义、与 Obsidian 文件互通**。不改 markdown-it 的 blockquote 机制，而是新增一条 core-ruler 规则（插在 `block` 之后、`inline` 之前）：在已成型的 token 流上，把首段以 `[!TYPE]{fold} 标题` 起始的 `blockquote_open/close` 改写为 `callout_open/close`，首行拆为 marker（type/fold/title）+ 剩余正文（空正文则删该段），内层正文仍是可编辑的普通块。PM 新增 `callout` 块节点（`content:'block*'`、attrs type/fold/title，`parseDOM` 用 `contentElement` 指向 `.nl-callout-body`）；序列化用 `wrapBlock("> ", "> [!TYPE] title\n", …)` 原样回写。折叠标记 `-`/`+` 无损保留（编辑器内保持正文可见）。`style.css` 补分型配色（`color-mix` 随 light/dark/Dracula 三主题自适应）。零新依赖（无 Rust）；`npm run build:web` 154 modules、`roundtrip` 28 passed（+标题行/折叠/多块正文/空卡片/内层行内标记五个用例 + callout attrs 定向断言）
- **Mermaid 图表渲染**（P3 批次 7）：` ```mermaid ` 代码块渲染为图（迁移 Obsidian 用户的关键开关）。**不新增 schema 节点**——mermaid 围栏就是普通 `code_block`（lang=mermaid），parse/serialize 走原生 fence↔code_block，GFM 往返零风险。新模块 `src/mermaid-preview.js`：一个纯 Decoration 插件（与 `hl-decorations.js` 同构），在每个 mermaid 块**下方**挂 `Decoration.widget`（side:1、stopEvent）异步渲染图为 SVG；源码仍可编辑、仍参与语法高亮。`mermaid` 重依赖走 `await import('mermaid')` 动态加载——vite 自动拆为 `mermaid.core-*.js`（~673 kB）+ 按图类型子块（flow/sequence/gantt/elk…），**仅当真渲染对应图时才拉取，主 bundle 仅 +~3 kB**（约 910→913 kB）。按 `data-theme` 选 mermaid theme（dark/vampire→dark），按主题缓存 SVG；`main.js` 的 `applyTheme` 派发 `nl-theme-change` 事件，插件借 `view()` 生命周期监听并清缓存+发 meta 事务重建。`style.css` 新增 `.nl-mermaid` 预览容器样式。新增依赖 `mermaid`（无 Rust）；`roundtrip` 30 passed（+mermaid 围栏幂等用例 + “围栏→code_block 且 params 保留 mermaid”定向断言）。边界：MVP 为“代码块下方展示预览”（非 Typora 式失焦隐源码）；导出/打印 HTML 暂不渲染 mermaid（降级为代码）
- **文件树图片附件单独查看**（P3 后增强）：像 Obsidian 那样把库内 PNG/JPG 等图片**单独放大看清楚**。Rust `scan_vault` 把图片白名单（`IMG_EXTS`：png/jpg/jpeg/gif/svg/webp/bmp/ico/avif）纳入文件树（`is_image`，进树不进索引，不影响搜索/反链/`[[` 补全）；前端新模块 `src/img-viewer.js`——一个**全屏浮层查看器**，点树中图片即用 `read_image_data_uri(vault_root, "", rel)`（复用既有命令，`md_rel` 传空即按库根解析）读字节转 data URL 显示。支持：适应窗口 / `−`·`＋` 缩放（10%~1600%）/ 1:1 实际大小 / 双击在适应与放大间切换 / 滚轮缩放 / 点空白或 Esc 关闭；大图随容器滚动条平移。图片**只读、不进编辑器**，与当前文档/脏状态完全解耦（查看不打断底下笔记，关掉即回原状）。`tauri-bridge.js` 导出 `isImagePath`，`main.js` 在 `openFile` 顶部按扩展名路由到查看器、树中图片项加 🖼 图标；`style.css` 新增 `.nl-imgv` 浮层样式。**含 Rust 改动，须重启 `tauri dev`**；零新增 JS 依赖
- **Obsidian 图片嵌入渲染 + 代码块语言标签 Typora 化**（P3 后增强）：① `![[图片.png]]`（Obsidian 拖入图片默认写法）此前被误解析为“文本 `!` + 指向文档的链接”，图片根本不显示。现扩展 wikilink 行内规则：`![[target|别名]]` 仅当目标带图片扩展名时产出 `wiki_img` token → 映射到 `image` 节点（新增 `embed` 属性，无损承载）；非图片的 `![[笔记]]` 仍按链接处理。序列化原样写回 `![[src|别名]]`，普通 `![]()` 走默认路径，往返幂等。② 配合 Rust `read_image_data_uri` 新增**库内按文件名回退查找**（`find_asset_by_name`，不区分大小写、先浅后深、跳过隐藏/`SKIP_DIRS`）：当相对路径解析失败（Obsidian 裸文件名/最短路径嵌入、或附件在子目录）时按名回退定位，迁移库的嵌入图能直接显示。③ 代码块语言标签由**右下角**改为 **Typora 风格右上角**（`pre[data-language]` 顶部留白 28px + `::after` 上提、不透明度提高），不再与首行代码重叠、更醒目。零新依赖（含 Rust 改动，须重启 `tauri dev`）；`roundtrip` 35 passed（+`![[图片]]` 裸名/带别名/带路径/非图片四个用例 + “嵌入→image 且 embed=true、普通 ![]() embed=false”定向断言）
- **代码块语言选择控件（Typora 式，可点击）**（P3 后增强）：上一批的语言标签是只读角标（CSS `::after`），且 NoteLume 此前**无任何 UI 能为代码块设/改语言**（语言只能靠读文件时的 ` ```lang ` 围栏带进来），导致用户把语言当正文文字敲进去。现将右上角标签换为一个**真可点击元素**（`code_block.toDOM` 渲染空文本的 `span.nl-code-lang[data-lang]`，文本仍由 CSS `::after` 取 `attr(data-lang)`——因是空节点，`parseDOM` 读 `pre` 不会把它误当代码内容，HTML 往返无损）；新模块 `src/code-lang-picker.js`：点标签弹**可搜索语言下拉**（复用 `.nl-suggest` 观感与 ↑/↓/Enter/Esc + 输入过滤交互），候选取自 `highlight.js` 已注册语言（`hljs.listLanguages()`，保证选中即有高亮）+ 常用置顶 + “纯文本（无）”清除项；选中后由 `view.posAtDOM` 反查该 `code_block` 位置并 `setNodeMarkup` 写 `attrs.params`（即围栏 info string），**语言永远不进入正文**；高亮/mermaid 按 params 驱动，改完自动重渲染。未设语言的块悬停时右上角浮出“＋语言”提示。`editor-view.js` 装配 `attachCodeLangPicker(view)`；`style.css` 将旧 `::after` 角标换为 `.nl-code-lang` + 新增 `.nl-codelang-menu`。零新依赖（无 Rust）；`roundtrip` 35 passed、`build:web` 无错
- **图片加载失败显示「未找到」提示**（P3 后增强）：此前 `![[图]]` / `![]()` 指向的文件解析/读取失败时，只显一个**无信息的虚线空框**，用户无从知道缺的是哪张图。现将图片 NodeView 包一层 `span.nl-img-host`：`read_image_data_uri` 失败（catch）时隐藏破图、在原地渲染一个带 🖼 图标的提示条——正文显示“未找到图片：<src>”（hover 有完整路径），让用户一眼看出缺哪个文件。仅改 `editor-view.js`（`makeImageNodeView`/`loadImgSrc`，失败态每次重载先清除）+ `style.css`（`.nl-img-host`/`.nl-img-hint`，换掉旧 `.nl-img-missing` 空框样式）；**纯前端、无 Rust**，刷新即生效；`build:web` 无错
- **模板 + 今日速记（全局浮层，与知识库解绑）**（批次 A，见 `docs/ROADMAP.md`）：笔记软件留存率的真正驱动因素，纯文件、零新依赖、**无 Rust 改动**（刷新即生效）。① **模板**：库内约定 `Templates/`（可经设置改目录，存 localStorage），工具条新增 📋 模板 菜单列出该目录下的 `.md` 并“基于模板新建”——填名后把模板正文里的 `{{date}}`/`{{time}}`/`{{datetime}}`/`{{title}}`/`{{filename}}`/`{{weekday}}`/`{{year}}`/`{{month}}`/`{{day}}` 替换为运行期值再落库打开；**未知 `{{token}}` 原样保留**（不误伤 Obsidian Templater 之类），产物仍是普通 md 无私有语法。菜单另含 ➕ 新建空白模板（写入带示例变量的种子）与“无模板”空态。② **今日速记（全局浮层，与知识库解绑）**：`今日` **不再写进“当前打开的库”**——按反馈“今日不该和知识库文件夹绑定”重做。工具条 📅 今日 与 `Ctrl+Shift+D` 唤起一个**独立浮层 textarea**（不占主编辑区、不切换工作根、**未开库也能用**），把今天记进一个**用户选定的固定绝对目录**（存 localStorage，所有库共用这一个 `YYYY-MM-DD.md`，默认命名 `YYYY-MM-DD`，支持 `YY/MM/DD/HH/mm/ss`）；停止输入 ~0.8s 自动落盘为标准 markdown，关闭 / `Ctrl+S` 立即保存、`Esc` 关闭；面板内 ⚙（或 📋 菜单里“今日速记设置…”）用系统对话框改存放目录与命名格式。新前端 `src/daily-capture.js`——把“今日目录”当作它自己的根传给现有 `read_md_file`/`write_md_file`（路径天然在根内，**无需改 Rust**）。新纯模块 `src/template.js`（`formatDate`/`builtinVars`/`applyTemplate`，无 DOM 无依赖，附 `src/tests/template.test.mjs` 3 组用例）；`main.js` 复用既有 `promptDialog`/`writeMdFile`/`scanVault`/`updateIndexDoc`/`openFile` 与 `.cv-menu` 菜单，`renderTree` 缓存 `state.tree` 供列目录，`ensureDir` 逐段建目录（已存在忽略）。`template.test` 3 passed、`roundtrip` 35 passed、`build:web` 无错
- **编辑器手感包：斜杠菜单 + 写作统计 + 专注/打字机**（批次 B，见 `docs/ROADMAP.md`）：日常书写体验，纯前端、零新依赖、**无 Rust 改动**（刷新即生效）。① **斜杠 `/` 块菜单**：在**空段落行首**输入 `/` 弹 Typora 式块类型下拉（正文/一~三级标题/无序·有序·任务列表/代码块/引用/分割线/表格/提示卡片/公式块/Mermaid 图 共 14 项），继续打字按中英文名/关键词模糊过滤、前缀优先；↑/↓ 移动、Enter/Tab 选中、Esc 关闭、点击直选，复用 `.nl-suggest` 下拉观感。选中后把当前块整体 `replaceWith` 为目标节点并用 `Selection.near` 将光标放进块内——**仅当整块内容就是 `/query`时触发**，故不会误伤正文/路径/URL 中的斜杠。新模块 `src/slash-menu.js`（手揉 `Plugin`，依赖 schema 现有节点）。② **写作统计**：工具条内联实时显示字数·预估阅读时长（CJK 逐字 + 拉丁按词混排口径），点击弹模态设当日字数目标并显进度百分比（存 localStorage `nl-word-goal`，0 清除）。新纯模块 `src/writing-stats.js`（`countWords`/`readingMinutes`/`statsLabel`，无 DOM 可 Node 单测，附 `src/tests/writing-stats.test.mjs` 3 组用例）；`editor-view.js` 新增 `getText()` 取文档纯文本，`main.js` 在 `onDocChange`/`setMode` 刷新。③ **专注 + 打字机模式**：工具条 🎯 专注（`Ctrl+Shift+F`）——当前顶层块高亮、其余淡出（Decoration 挂类 + CSS `.nl-focus` 不改文档）；⌨ 打字机（`Ctrl+Shift+T`）——选区变化时把当前块滚到视口竖直中部。开关态存 localStorage（`nl-focus`/`nl-typewriter`），`createEditor` 启动时由 `main.js` 传入插件初态。新模块 `src/editor-modes.js`（视图层 `Plugin`）。`writing-stats.test` 3 passed、`roundtrip` 35 passed、`template.test` 3 passed、`build:web` 无错

### 计划中（P2 未完项）

- 移动端适配

### Fixed

- **代码块内容丢失（严重、早已有之的回归）**：自 `d703f05`（代码块语言标签）起，`.update('code_block', {…})` 整体覆盖了基 schema 的 `code_block` spec 却没带 `content:'text*'`/`marks:'code'`（`OrderedMap.update` 是替换非合并），导致 **加载/打开任何含 ``` 围栏的 md 时代码块内容被静默丢弃**，且语法高亮因无 code_block 节点而完全失效。roundtrip 幂等测试因“空→空”而长期掩盖。本批实现 mermaid 时发现并修复：给 `.update('code_block')` 补回 `content:'text*'` 与 `marks:'code'`；代码块与高亮恢复正常（mermaid 也依赖此路径）。`roundtrip` 新增用例验证 code_block 真产出且 params 无损
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
