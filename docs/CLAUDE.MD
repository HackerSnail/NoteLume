# 项目：Markdown 知识库编辑器（定位：轻 + 纯 md + 编辑手感）

## 项目定位

2026-10-26 定位收紧：砍掉「Obsidian 重度用户」这条受众，主打**轻 + 纯 md + 编辑手感**，目标用户是嫌 Typora 没组织、嫌 Obsidian 重的人。不再用「介于 Typora 和 Obsidian 之间」这种两头站的表述；插件生态与重型图谱是 Obsidian 的地盘，不拼也不当卖点。

- 编辑体验 = Typora：**单文档一体化WYSIWYG Markdown，所见即所得，点击渲染内容直接编辑**，不是左右分屏源码预览。排版干净、阅读感强。粘贴清理（AI 对话框 / 飞书 / 公众号来源的脏内容）算编辑手感的一部分，见「粘贴清理」一节。
- 知识库能力 = 内置基础能力：本地文件夹作为知识库仓库，文件之间双向链接、内部跳转、标签、文档大纲、搜索；**不强制全量渲染庞大知识图谱（图谱作为可选附加功能）**。
- 数据 = 纯 .md + 原生文件夹。「零锁定」用动作兑现（标准 GFM 导出，见对应章节），不靠宣称。

## 技术栈

- 后端：Tauri v2 + Rust
- 前端：Vanilla JS + ProseMirror + prosemirror-markdown（WYSIWYG核心）
- Markdown解析：prosemirror-markdown，Rust辅助文件扫描、索引构建
- 本地存储：**完全基于原生文件夹 + .md 文件，不使用私有数据库**，文件可直接用其他编辑器打开，兼容标准GFM
- 打包：Tauri，Windows优先，支持mac/linux

## 功能清单（分P0核心 / P1重要 / P2扩展）

### P0｜必须第一版实现（基础可用版本）

编辑器核心（对标Typora）

1. WYSIWYG一体化Markdown编辑，GFM全支持：标题、粗体、斜体、删除线、段落、引用、无序列表、有序列表、任务列表、表格、行内代码、代码块
2. Markdown字符串 ↔ ProseMirror文档双向无损转换
3. 拖拽/粘贴图片：自动把图片复制到库内 `assets` 文件夹，自动生成相对路径图片链接 `![](./assets/xxx.png)`
4. 基础快捷键：Ctrl+S保存，Ctrl+O打开文件，Ctrl+B粗体、Ctrl+I斜体（完整键位见下方「快捷键规范」）
5. 浅色/暗黑主题切换，类Typora阅读排版（固定阅读宽度、舒适字体、行高）

知识库核心（精简Obsidian能力）
6. 打开**本地文件夹作为知识库库**（不是只能打开单个md文件）
7. 侧边栏：库文件树，浏览库内所有md文档；点击文件直接切换编辑器
8. [[内部链接]] 语法支持：`[[文档名]]`，点击链接直接跳转到库内对应md文档；不存在的文档点击链接可选择新建文档
9. 文档大纲面板：提取当前文档标题，可点击大纲跳转到文档对应位置
10. 文档标签支持 `#tag`，识别文档内标签，侧边展示当前文档标签

### P1｜第二阶段迭代（完善知识库）

1. 双向链接面板：当前文档的「引用本文件」+「本文件引用的其他文件」列表（Obsidian反向链接）
2. 全局搜索：在整个知识库内搜索md文件内容+文件名+标签，支持预览匹配片段（Rust后端做文件扫描索引，提升搜索速度）
3. 自动保存 + 备份机制
4. KaTeX数学公式支持（行内公式 $...$、块公式

   $$
   ...
   $$

   ）
5. 代码块语法高亮
6. 导出：当前文档导出HTML / PDF
7. 悬浮预览：鼠标hover [[链接]]，弹出文档预览小窗口（类似Obsidian悬浮预览）

### P2｜可选扩展（按需做，强制核心）

1. 简易知识图谱可视化（仅展示文档之间连接关系，轻量化，不追求Obsidian那种复杂3D/大量节点性能）
2. 笔记版本快照（简单本地快照，非完整git）
3. 插件基础钩子系统（简单自定义JS插件接口）
4. 画布/白板卡片（可选，复杂度高，放最后）
5. 移动端适配（低优先级）

## 快捷键规范

键位按 Typora / Obsidian 主流习惯配置，Windows/Linux 用 Ctrl，mac 用 Cmd（下文写 Ctrl，mac 读者替换为 ⌘）。全部键位走统一命令注册表：应用命令由全局分发器触发，编辑器命令进 ProseMirror keymap，每条都能在「快捷键设置…」里重绑 / 解绑 / 重置，撞键硬阻止保存。改默认键只需改 `main.js` 的 `registerAppCommands` 与 `editor-view.js` 的 `EDITOR_COMMANDS`，菜单、命令面板、设置页三处自动跟随。

第一档（肌肉记忆级，缺了会不顺手）：

| 功能            | Win/Linux             | Mac                 |
| --------------- | --------------------- | ------------------- |
| 新建文件        | Ctrl+N                | Cmd+N               |
| 保存            | Ctrl+S                | Cmd+S               |
| 撤销 / 重做     | Ctrl+Z / Ctrl+Shift+Z | Cmd+Z / Cmd+Shift+Z |
| 查找 / 替换     | Ctrl+F / Ctrl+H       | Cmd+F / Cmd+H       |
| 加粗 / 斜体     | Ctrl+B / Ctrl+I       | Cmd+B / Cmd+I       |
| 插入链接        | Ctrl+K                | Cmd+K               |
| 代码块          | Ctrl+Shift+K          | Cmd+Shift+K         |
| 行内代码        | Ctrl+`                | Cmd+`               |
| 标题 1~6        | Ctrl+1~6              | Cmd+1~6             |
| 切换编辑 / 预览 | Ctrl+E                | Cmd+E               |
| 打印 / 另存 PDF | Ctrl+P                | Cmd+P               |

第二档（区分「能用」与「好用」）：

| 功能                      | Win/Linux                   | Mac                       |
| ------------------------- | --------------------------- | ------------------------- |
| 命令面板                  | Ctrl+Shift+P                | Cmd+Shift+P               |
| 快速打开文件              | Ctrl+O                      | Cmd+O                     |
| 粘贴为纯文本              | Ctrl+Shift+V                | Cmd+Shift+V               |
| 任务列表                  | Ctrl+Shift+L                | Cmd+Shift+L               |
| 无序 / 有序列表           | Ctrl+Shift+[ / Ctrl+Shift+] | Cmd+Shift+[ / Cmd+Shift+] |
| 插入表格                  | Ctrl+T                      | Cmd+T                     |
| 插入图片                  | Ctrl+Shift+I                | Cmd+Shift+I               |
| 引用块                    | Ctrl+Shift+Q                | Cmd+Shift+Q               |
| 删除当前行 / 段落         | Ctrl+D                      | Cmd+D                     |
| 提升 / 降低标题级别       | Ctrl+] / Ctrl+[             | Cmd+] / Cmd+[             |
| 关闭当前标签页            | Ctrl+W                      | Cmd+W                     |
| 切换下一个 / 上一个标签页 | Ctrl+Tab / Ctrl+Shift+Tab   | Ctrl+Tab / Ctrl+Shift+Tab |

第三档（加分项，已做的）：

| 功能                 | Win/Linux    | Mac         |
| -------------------- | ------------ | ----------- |
| 专注模式（沉浸写作） | Ctrl+Shift+` | Cmd+Shift+` |
| 重命名当前文件       | F2           | F2          |

固定结构键（不进注册表：`normalizeBinding` 只认单字符基础键、F1–F12 与带修饰的 Tab，这几个键串判非法，重绑不了）：

| 键          | 行为                                                                                                                                                                   |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Enter       | 分块。表格里走下一格、末格出表；列表项内新起一项（空项退出列表）；标题把光标后的文字降到下方正文段，行首则在标题上方空一段；脚注项内换行；代码块内只加行；其余走原生链 |
| Shift-Enter | 块内硬换行（序列化成行尾反斜杠）。表格里=上一格；代码块内=块内加行（与 Enter 同果）；标题里=无事发生，标题的硬换行没有 markdown 形态，插进去会写坏原文                 |
| Mod-Enter   | 离开代码块 / 容器块，实际响应由 baseKeymap 提供；注册表项 `editor.exitBlock` 默认键留空，只负责让命令在面板与快捷键设置页可见可搜                                    |
| Backspace   | 块首：上一块是代码块或原子块则选中整块（再按删块），否则合并回上一块、正文不丢；单元格里不越 isolating 边界                                                            |
| Shift-Mod-z | 重做的标准别名                                                                                                                                                         |

冲突裁决（同一键被两个习惯占用时，按档位取舍，低档位改键）：

1. Ctrl+P 归打印 / 另存 PDF（明确要求保留）；命令面板回 Ctrl+Shift+P；粘贴为纯文本改 Ctrl+Shift+V——这本来就是 Typora / Obsidian 的纯文本粘贴习惯键，且 mac 上 Cmd+Shift+V 就是系统级「粘贴并匹配样式」，语义重合。
2. Ctrl+Shift+I 归插入图片，隐藏 / 显示检查器栏改到 Ctrl+Shift+B。
3. Ctrl+E 归切换编辑 / 预览，源码 ⇄ 所见即所得从 Ctrl+/ 挪到 Ctrl+E，Ctrl+/ 不再占默认键（设置里可绑回）。
4. 专注模式用 Ctrl+Shift+`，原 Ctrl+Shift+E 释放。
5. Ctrl+` 归行内代码（第一档），侧栏显隐保持 Ctrl+Shift+S。
6. 标签页切换刻意用 Ctrl 而非 Mod：mac 上 Cmd+Tab 被系统「切换应用」占用，按键到不了应用内，故两个平台都绑 Ctrl+Tab。

暂不做的：

- 关闭窗口 / 退出应用交给系统（Alt+F4 / Cmd+Q），不占用 Ctrl+W。

按键链路说明：

- 编辑器命令（标题、列表、表格、链接、删行等）在 ProseMirror keymap 里求值，源码态（CodeMirror）下撤销 / 重做单独走 CM 历史，其余命令对源码态不生效。仓库键位先装、baseKeymap 后装，仓库那一层返回 false 就退回原生行为，所以重绑一个键等于多插一层前置命令；上表五个结构键在 `editor-view.js` 的 map 里固定。
- 应用命令（文件、标签页、视图、粘贴为纯文本）走 document 级 keydown 分发器；F2 这类无修饰键与 Ctrl+Tab 这类带修饰的 Tab 均已放行（keymap.js 的 `isFKey` 与 Tab 例外）。
- 表格出表另有就地入口：右键菜单「表后另起一段」，与末格 Enter 同一个 `exitTableBelow`。表格 / 代码块 / 公式在文档末尾时下方有一个可点可打字的间隙落点（gapcursor），落点只是选区、不改文档，因此不判脏也不落盘。
- 块类型菜单两个入口：mac 是原生「段落」菜单（`app-menu.js` 的 paragraph 组），Windows / Linux 是工具条「段落」按钮下拉（`main.js` 的 `openParagraphMenu`，按钮在 `.btn-group` 里，mac 该组整体隐藏）。两边同源：条目顺序与「当前块类型」单选勾都读 `menuCommands()`，执行走命令注册表。两平台的「表格」项与斜杠菜单的「表格」都先弹 Word 式 N×M 选择器（`src/table-picker.js`），Esc / 点外面关掉即不插；Tab 在选择器里是右移一格（右边界换行、末格落定），底部提示是明确的「N 行 × M 列」。
- 所见即所得也有行号装订线（`src/wysiwyg-gutter.js`，2026-10-26 起）：与源码模式同口径——按折行后的视觉行连续编号、常开、无开关。行位来自 DOM Range `getClientRects` 按 top 合并（纯函数 `mergeLineTops`），装订线只渲染视口 ±30 行；文档变更 rAF 去抖重算，宽 / 字号变化与折叠展开靠 ResizeObserver 兜住，折叠隐藏的行不编号不断号。overlay 挂在 `.editor` 里（源码态 `.editor` 整体隐藏所以不会和 CM 行号叠罗汉），打印样式里不上纸。
- 右键菜单全部自绘（2026-10-26 起，WebView2 原生菜单不再出现）：编辑器窗格（文本格式 + 块插入，`attachEditorContextMenu`）、表格行列操作（`table-editing.js`）、图片（另存 / 复制）、文件树（文件 / 文件夹 / 空白区，文件夹含删除；单文件树 `renderSingleFileTree` 的行与侧栏空白同样有菜单——空白区在单文件 / 未开库时给「打开单个文件 / 打开知识库文件夹」）、画布各自的监听照旧；标签条、查找栏、源码模式、输入框与其余空白区域由 `main.js` 的 `installGlobalContextMenu` 在 document capture 阶段兜底——输入框与源码 CodeMirror 弹剪切 / 复制 / 粘贴 / 全选编辑菜单（粘贴走 navigator.clipboard，输入框用 `setRangeText`、CM 用 `insertText`），标签条弹关闭 / 关闭其他 / 固定 / 复制路径 / 在资源管理器中显示，其余区域压掉原生、不出菜单。已有自绘菜单的区域在 capture 阶段一律放行（它们在冒泡阶段 preventDefault）。所有自绘菜单共用 `.cv-menu` 样式与 `placeMenu`（定位翻转 + 点外面 / Esc / 滚轮 / resize 关闭）。

## 标签页设计（2026-10-19 起：完整分栏模式，标签归窗格）

每个窗格一条自己的标签条，窗格内可开多篇文档；屏幕顶部没有全局标签栏。`src/tabs.js` 是每窗格一个实例的标签条组件（列表 + 渲染 + 交互），`src/pane-strip.js` 是条子的 DOM 与按钮（拆分横 / 竖 + 关窗格），`main.js` 的 `openDocInPane` / `closeTab` / `cycleTab` 管打开 / 关闭 / 切换链路。

硬限制不变：一个窗格一个编辑器实例，所以窗格内切标签前必须先处理当前文档的未保存改动（保存 / 不保存 / 取消），切走的标签内容不驻留。VS Code 那种「后台挂多个脏文档」要编辑器实例池，项目已否决，不做。

不变式：

- 标签 id = `paneId + root + rel`，同一文档可在多个窗格各开一份（后保存的覆盖先保存的，不合并，与 VS Code 一致）。
- 一个窗格里同一路径只一个标签；每个窗格最多一个预览标签（见下）。
- 脏标记按标签记：哪个窗格在改它的活动标签，哪个标签上的点亮；非活动标签此刻不可能脏（切走时已问过）。

行为规则：

- 打开落定分两种入口。**预览入口**（拖入打开、原生侧唤起——单实例二次唤起与 macOS 的双击 / 「打开方式」/ 拖到 Dock 图标）：开斜体的预览标签，同窗格再开一个预览时替换掉旧预览（旧预览有未保存改动先问）。**固定入口**（文件树单击、wikilink、搜索、命令面板、最近打开、模板、新建、docx 落库、启动参数）：开普通标签，永不被预览替换。双击预览标签 = 固定它。文件树单击原走预览入口（2026-10-19 起改为固定）——点文件就是开一篇，预览替换的省事掩盖了「刚点的文件被下一个点击顶掉」的困惑。
- 切标签（点标签 / Ctrl+Tab / Ctrl+Shift+Tab，焦点窗格内循环）：先问当前文档的未保存改动，再激活目标标签装内容。根没变只刷高亮与面板；根变了才重扫树 / 重建索引 / 重载插件（`vault-path.js` 的 `rootChanged` 判定）。
- Ctrl+W 关焦点窗格的活动标签；关完激活右邻再左邻，关光了整格自动关掉（只剩最后一个窗格时保留空态）。中键点标签 = 关闭。标签条超出宽度横向滚动。
- 拆分（`app.splitH` / `app.splitV`，命令面板 / mac 窗口菜单 / 各窗格标签条按钮同入口）：新窗格复制焦点窗格的当前文档（VS Code 行为）；焦点窗格是空态或当前是画布时新窗格空置。
- 拖拽（2026-10-19 起，`src/pane-drag.js` + `main.js` 的 `handlePaneDrop`）：标签拖到另一个窗格的中间 = 移动（源窗格摘标签，源空了留空态）；拖到窗格左 / 右 / 上 / 下的外圈 25% = 在该侧拆出新窗格装它；落回自己窗格的中间 = 按落点重排标签顺序。落定一律是固定标签（拖预览标签过去会转正），画布标签拦下（`pn.canvasSplit`），落点不在窗格上或按 Esc 则无操作。文件树的文件项也能拖：落中间 = 在那个窗格打开，落边缘 = 拆出新窗格再打开，都是固定标签。
- 落定的未保存改动一次问清：移动要问源窗格（被拖的是活动标签时）与目标窗格（要换内容），拆分只问源窗格。落定路径直接走 `tabs` + `loadDocIntoPane`，不经过 `openDocInPane`（2026-10-19 起后者的 `ensurePaneSaved` 在窗格不脏时直接放行，不再退化成「问所有脏窗格」）。

新建文件的临时目录机制（配 Ctrl+N）：

- Ctrl+N 与工具条「新建」不要求先开知识库：文件建到系统临时目录 `<temp>/NoteLume/scratch/未命名-<时间戳>.md`，直接可编辑。
- 临时文件也是普通一页，标签带临时标记（标题后一个点）；侧栏在临时态只列当前这一个文件，不铺开 temp 目录。
- Ctrl+S 对临时文件 = 另存为：弹保存框选正式位置，落盘后该页改指新路径、退出临时态，并记入「最近打开」。自动保存仍写临时目录保命，不改变「还没选位置」这个事实。
- 关闭临时页先问「选位置 / 直接关闭 / 取消」；自动保存过也不再问保存与否，但仍会问要不要选位置。
- 临时目录路径存 localStorage（`nl-scratch-dir`），重开后从「打开文件」进到这个目录也能认出是临时文件。
- 文件树右键的「新建文件…」不变：那是在既有库里按目录建，属另一个刻意动作。

## 分栏设计（P5 §6.1，2026-10 完整模式）

编辑器区是一棵 SplitPane 树，叶子窗格各持一个编辑器实例、一条标签条和自己的根 / 文档上下文；全局 state 只镜像焦点窗格的活动标签（面板、索引、文件树都读它）。

- `src/split-pane.js` 是引擎：树模型（`split` / `leaf` 两种节点）+ 4px 分割条 + 指针捕获拖拽，纯逻辑可单测；DOM 只做定向手术（拆分 / 关闭各只搬动一个元素），不整树重建——整树重建会把 ProseMirror 的 DOM 连根拔起。手术后按 DOM 现取子节点重算 flex 比例样式（缓存引用会刷到已搬走的元素上）。
- 每窗格顶部一条 `.nl-pane-strip`（sticky，`src/pane-strip.js`）：左边标签滚动区，右边拆分横 / 竖 / 关窗格三个按钮；关窗格按钮只在多窗格时显示。`.nl-pane` 仍是滚动容器（不套嵌套滚动），查找栏的 top 偏移含条子高度。
- 脏状态按窗格各自记（每个实例自己的 dirty），`ensurePaneSaved` / 自动保存遍历所有脏窗格；多窗格未保存时一次问清「全部保存 / 全部不保存 / 取消」。面板（大纲 / 属性 / 反链 / git）与查找栏、高亮工具栏都跟焦点窗格的活动标签走。
- 空窗格自动关掉（2026-10-19 起）：关掉窗格最后一个标签、把最后一个标签拖走、删掉当前文档关光标签，这三种情况都整格自动关掉（`closePaneIfEmpty`），只剩最后一个窗格时保留空态承接下一次打开。启动恢复时标签列为空的叶子直接剪掉（`pruneEmptyPanes`，首叶子保留）。关掉 `#canvas-mount` 宿主窗格时挂载点搬进剩余第一个窗格（`rehomeCanvasMount`），`panes.canvasPane` 跟着改——此前手动关掉那个窗格画布就静默残废。
- 每侧最小 20%、最大 80%（p5plan §6.1）；树结构、比例、各窗格标签列与焦点窗格存 settings.json 的 `panes` 段（`{tree, focused, tabs}`，预览与脏标记不落盘），拆分 / 关闭 / 拖拽结束（pointerup）/ 开关标签都落盘（`persistPanes` 内 update 后立即 flush，不走 500ms 防抖——拖完立刻关窗不丢布局），窗口 resize 不重算（百分比天然自适应）。
- 恢复：`normalizeTree` 认新形状与旧形状（裸树，迁移时首窗格按 `workspace.lastFile` 建一个固定标签），坏数据退回单窗格空布局。启动时每个窗格只读活动标签的内容，其余标签点击时再读；恢复出的文档已被移走则摘掉该标签，标签光了的多余窗格整格关掉，不打断启动。焦点窗格装载时全局镜像一并回填（`state.vaultRoot` / `currentFile` / `scratch`）——恢复路径只走 `loadDocIntoPane`，不补镜像的话 `state.vaultRoot` 停在 null，重启后点文件树会被 `openFile` 静默拦下（2026-10-19 修）。
- 画布模式在分栏下禁用（画布视图是单实例，多窗格要实例池，收益不抵复杂度，跟当初标签页的判断一个路子）；源码模式是编辑器实例内部状态，各窗格独立。
- 落边拆分（2026-10-19 起）：`splitPane(tree, paneId, orientation, newPaneId, newFirst)` 与 `view.split(...)` 同签名，`newFirst` 为真时新窗格居左 / 上（树里 children 对调，DOM 顺序 `[新, bar, 旧]`，比例样式落在新叶上）。拖拽落边走它，按钮 / 命令不传参，行为不变。
- 拖拽的落点判定在 `src/pane-drag.js`：`dropZoneFor(rect, x, y)` 认外圈 25% 的四个落区，其余算中心；`tabDropIndex(rects, x, skip)` 算条内排序的插入位置。拖拽本身走 pointer 事件（与分割条同源），不用 HTML5 DnD——外部文件拖入已经占着 `.body` 的 `drop` 事件（`drop-open.js`），两套 DnD 混在会互相抢。
- 不做：复制式拖放（Alt / Ctrl 拖）、拖出成独立窗口；全局总览栏。

## 网页剪藏（2026-10-21）

链路四段：浏览器扩展提取 → 本地 HTTP 推给 Tauri 主进程 → Rust 按模板落盘 → 笔记里自动关联已有知识。设计依据 `docs/superpowers/specs/2026-10-21-web-clip-design.md`（v1）与 `docs/superpowers/specs/2026-10-21-web-clip-v2-design.md`（v2：Defuddle 一级提取、图片本地化可选、frontmatter 规范化、highlight 模板），实现计划 `docs/superpowers/plans/2026-10-21-web-clip-plan.md`；截图剪藏见 `docs/superpowers/specs/2026-10-22-web-clip-screenshot-design.md`（v3）。

- 扩展在 `extension/`（MV3，无构建无 npm）：`background.js` 是 service worker，入口三个——工具栏图标（`mode='auto'`：页面上有选区就剪选区，没有才剪整页；图标是唯一的显眼入口，用户选了文字点图标要的就是那段文字）、右键「剪藏选中内容」（`mode='selection'`）、右键「剪藏整页」（`mode='page'`，显式要整页，有选区也剪整页）。提取走 `chrome.scripting.executeScript` 按需注入 `vendor/defuddle.js` + `vendor/Readability.js` + `vendor/turndown.js` + `content/extract.js`，注入顺序即优先级：Defuddle 抛错 / `content` 空 / `wordCount < 120` 时降级 Readability，两级都空时按设置 `clip.fullPageFallback`（默认 false）决定报「提取失败」还是退化 `document.body`；选区模式优先于提取器。Defuddle 内部提取失败时不抛错，而是把整个 body 序列化后当 `content` 返回（`_fallbackResponse`），没有语义主标的 div 汤页也会退到 body 入口把导航侧栏留下来——`extract.js` 的 `defuddleUsable` 按内容长度（≥ 整个 body 的 90%）、字数与元数据全空三种特征识别这种假成功并降级 Readability。正文尾部博客平台挂的签名块（本文作者 / 本文链接 / 版权声明 / posted @ 阅读(…) 评论(…) 收藏 举报 / © …）由 `stripFooterSignatures` 从结尾往前整段切掉（切口落在内容前 60% 之内才动手，只认整行以签名开头的，正文提及不受影响；签名块上方常挂的入群二维码图一并切掉）——博客园实测这一步把 5154 字符的提取结果削到 4375，结尾停在参考文献。不常驻 content script（`activeTab` 权限）。图片由后台 fetch 成 data URI（`host_permissions: <all_urls>`），受设置 `clip.localizeImages`（默认 false）控制：关着时载荷 `images` 传空数组、Rust 完全不碰图，正文保留 `https://` 原链接；两个开关都经每次剪藏前的 `GET /health` 下发。右键菜单（选区 / 整页两条）在 `onInstalled` 与 `onStartup` 两个入口幂等重建（removeAll + create）：菜单注册在浏览器侧，浏览器重启会清掉它，而重建代码跑在可能被逐出的 service worker 里、重启时 `onInstalled` 不触发——只在安装时建一次，重启后就只剩工具栏图标。选区在 iframe 里或在输入框里时 isolated world 的 `getSelection` 读不到，用菜单点击时 Chrome 给的 `info.selectionText`（经 opts 传入）兜底。安装与配置见 `extension/README.md`。
- 截图剪藏（v3）：选区截图是第三种剪藏物，入口两个——右键「截取选区图片剪藏到 NoteLume」与快捷键 `Alt+Shift+S`（manifest 的 `commands` 段登记，浏览器自己派发）；工具栏图标语义不动（有选区剪文字选区，没有剪整页），图标只有一个，按住不放会让「剪文字」与「截图」互相猜。链路：页面侧 `extension/content/shot.js` 量出选区矩形（`getBoundingClientRect`；选区有一截在视口外先 `scrollIntoView({behavior:'instant'})` 滚进来、等 150ms 再量；本 frame 读不到时退到同源 iframe 里找，矩形加上 iframe 自己在页面里的位置）→ `chrome.tabs.captureVisibleTab` 拍可视视口 → service worker 里 `OffscreenCanvas` 按 `图片宽 / innerWidth` 的比例裁出那块（长边超 2000px 等比缩，PNG 超 3.5MB 转 JPEG）→ 载荷带 `clipType='screenshot'` 与 `screenshot: {dataUri}`。截图只能拍到当前视口里的画面，选区比视口大时截不全，通知里说明。
- 手动框选截图（v3）：浏览器的选区只能圈文字，圈不住图表与插图，框选补这一段。入口两个——右键「框选区域截图剪藏到 NoteLume」（contexts 为 page + selection）与快捷键 `Alt+Shift+D`。页面侧 `shot.js` 的 `startPick()` 挂一层 `position:fixed` 的暗色遮罩（样式走 `chrome.scripting.insertCSS`，页面的 CSP 管不到；写成元素的 style 属性反会被严格 CSP 拦下），拖动时画选框，松开即把矩形算出来并**先把遮罩与选框撤掉**（截图拍的是当前画面，遮罩留着就被拍进去了）；`Esc` 取消，拖动面积不足 4px 当误点处理。结果两路报回后台——`chrome.runtime.sendMessage` 与 `window.__NL_SHOT.lastPick`（后台 `waitForPick` 轮询兜底，页面里拿不到 runtime 时走这条），后台拿到后与选区截图同一条链路裁剪、落盘（`clipType='screenshot'`，正文只有图、不带选中的文字）。
- 本地服务在 `src-tauri/src/webclip.rs`，手写 `std::net::TcpListener`，只绑 `127.0.0.1`，不引 crate。路由三条：`POST /clip`、`GET /health`、`OPTIONS` 预检。端口默认 3210，被占顺延 +1 至多 10 个，实际端口记运行态并经 `/health` 与设置面板回显。listener 设 nonblocking，accept 循环每 5ms 查关闭标志；每连接一线程。
- 安全两道闸都在响应前校验，不带令牌：`Origin` 存在时必须是 `chrome-extension://` / `moz-extension://` 开头，否则 403（浏览器里恶意网页的 fetch 与表单提交必带 http(s) Origin，到不了 `/clip`）；`Host` 去端口后必须是 `127.0.0.1` / `localhost` / `::1`，否则 403（挡 DNS rebinding）。不带 Origin 的请求（Firefox 扩展、curl、本机进程）放行——本机进程本来写得了库里的文件，HTTP 服务没给它新能力，设令牌只会把复制粘贴的成本转嫁给正常用户（2026-10-21 决策；此前是三道闸，第三道 `X-NL-Token` 恒定时间比对已撤）。载荷上限整体 8MB、markdown 2MB、单图 5MB，超限 413。
- 落盘：模板取库内 `Templates/` 下设置里选的 md，扩展选项页填了目录 / 模板就是单次覆盖；模板读失败或未选回落内置模板——整页剪藏走 article、选区剪藏走 highlight（来源行进引用块），用户显式选过模板（设置里的 `template_rel` 或选项页的单次覆盖）时优先。内置 article 的 frontmatter 为 `title / source / author / published_at / clipped_at / tags / template`：`published_at` 页面给了才填，`clipped_at` 是本地时区 ISO 8601（`%Y-%m-%dT%H:%M:%S%:z`），`template` 记本次实际使用的模板名（article / highlight / 用户模板主名）；`tags` 第一项默认 `clip`（设置 `clip.defaultClipTag` 可关），页面关键词接在后面。变量与 `src/template.js` 的 `applyTemplate` 同语义（未知 token 原样保留）：`{{title}}` `{{url}}` `{{site}}` `{{author}}` `{{description}}` `{{content}}` `{{tags}}`（逗号分隔，frontmatter 用）`{{hashtags}}`（`#a #b`，正文用）`{{date}}` `{{time}}` `{{datetime}}` `{{year}}` `{{month}}` `{{day}}` `{{weekday}}`（走后端词表，五语言）`{{published_at}}` `{{clipped_at}}` `{{template}}`。目标目录默认 `Clippings/`；文件名模式默认 `{{date}}-{{title}}`，非法字符换 `-`、截断 80 字符、重名追加 `-2`。图片落 `<目标目录>/assets/`，同内容复用、异内容追加 fnv1a 指纹，markdown 里的远程 URL 改写为 `./assets/<name>`（仅 `clip.localizeImages` 开启时）。截图剪藏走内置 shot 模板（来源行 `> 截自 [站点](链接)`），图恒定落 `<目标目录>/assets/clip-<时间戳>.png`（同一秒两张加序号）——不受 `clip.localizeImages` 影响，那开关管的是正文里的远程图；正文写 `![页面标题](./assets/xxx.png)`（标准 GFM，不写 Typora 的 `=宽x` 尺寸形态——那不是标准 GFM，Obsidian 与 GitHub 会把整段当纯文本），后面接选中的文字（选了才有）；有截图就不算空内容（选区是一张图时没有文字），用户模板里没有 `{{content}}` 时图补到文末。越界校验复用 `vault_join` + 父目录 canonicalize，与 `write_md_file` 同一套。
- 自动关联：写盘后用 `VaultIndex` 打分，标签交集 ×3、标题词重叠 ×2、正文命中 ×1（每词封顶 3 次）；CJK 取 2 字滑窗，拉丁词 4 字符以上并去停用词。取前 `maxLinks`（默认 5），文末追加 `## 相关笔记` 段，链接用根绝对形式 `[[/目录/文件名|标题]]`——剪藏多在一级子目录，相对路径会因参照目录不同解析不到。只改新剪藏，不动已有笔记；反向连接由现有反链面板在 `index_doc_into` 注册 outgoing 后自然呈现。索引未就绪（没开库或正在重建）时跳过关联，响应里 `linked` 为 0。
- 前端：`src/clip-settings.js` 是设置面板（工具条「更多」与命令面板 `app.clipSettings` 两个入口），配置存 settings.json 的 `clip` 段，字段与 Rust 侧 `ClipConfig` 一一对应；「保存」时经 `clip_server_apply` 停旧起新服务。boot 里监听 `nl:clip-saved`：刷文件树 + 状态栏出「已剪藏：{rel}（关联 n 篇）」，不自动打开（设置里 `openAfterSave` 可开）。后端错误文案走 `ui_lang.rs` 五语言词表，界面文案进 `src/locales/` 五份。
- 错误码：403 来源不允许、409 没开知识库、413 超限、400 畸形请求、404 接口不存在、500 写盘失败；响应体统一 `{ok, code?, message?}`，成功时回 `{rel, title, linked, imagesSaved, imagesFailed}`。

## 幻灯片导出（2026-10-25）

单文档入口 `app.exportSlides`（`main.js` 的 `exportSlides`，与 `app.export` 同骨架），把当前一篇 md 编译成单个自包含 HTML：内联 reveal.js 5（`src/slides-assets.js` 经 vite `?raw` 读 dist 文本），双击可放映，`xxx.slides.html` 默认名。设计 `docs/superpowers/specs/2026-10-25-slides-export-design.md`，计划 `docs/superpowers/plans/2026-10-25-slides-export.md`。

- 切片在 markdown-it token 流上做（`src/slides-export.js` 的 `splitSlides`）：有顶层连字符水平线 `---` 按它切（`***` / `___` 不算，当普通水平线渲染），否则按 `##` 切、`###` 不切；首个切片点前的引言独立成首页。md 源文件不引入私有标记，`---` 就是标准 GFM 水平线，Obsidian 幻灯片插件同规则。
- `::: notes` … `:::` 摘进该片的 `<aside class="notes">`（未闭合吃到片尾，fence 内不算）；演讲者视图按 S 弹出——reveal 5 的 notes 插件自己 `document.write` 内嵌页面，不请求外部资源，单文件开箱即用（设计时按 reveal 4 预判的 blob URL 方案实现时删了）。
- 每片正文复用 `site-export.js` 的 `renderSite` 全保真渲染；KaTeX css 走 CDN（断网时公式降级）；主题字体 `@import` 构建期剥掉，回退系统字体栈。图片相对路径按导出文件所在目录解析，与单篇 HTML 导出同口径。整库编译幻灯片、垂直分页、主题选择不做（YAGNI，整库版后续单独立项）。

## 打印排版（2026-10-25）

Ctrl+P（`main.js` 的 `printViaDialog`）先弹排版选项窗（`src/print-options-dialog.js`，四个勾选：自动目录页 / 页码与页眉标题 / H1 起新页 / 封面页，存 localStorage `nl-print-options`，首启只勾页码与页眉），确认后 Paged.js 预分页再走系统打印；取消不打印，canvas 模式直出老打印。设计 `docs/superpowers/specs/2026-10-25-print-pagedjs-design.md`。

- 内容源是焦点窗格 `.ProseMirror` 的 DOM 克隆（`src/print-paged.js` 的 `printPaged`）：图片已是 data URI、公式与 mermaid 已出图，应用内重渲染必裂图；frontmatter 本就不在编辑器 DOM 里。H1/H2 用与编辑器同一套 `anchorSlug` 补锚点，目录页码靠 `target-counter` 自动算。
- 打印 CSS 在 `printStyles` 按勾选拼（Paged.js 只处理传给它的样式）；标题进 `@top-center` 前要转义引号与反斜杠，不转义整条 `@page` 静默失效；H1 分页带 `h1:first-child` 例外，否则封面 / 目录后空出首页。
- 隔离：`#print-root` 常态移出屏外（预分页需要真实布局，`display:none` 会量出零尺寸），body 打 `data-paged-print` 标记后 `@media print` 只显示分页容器；老打印路径不打标记不受影响。`printPaged` 的 `finally` 摘容器与标记，抛错时 main.js 回退 `window.print()`。
- 依赖 `pagedjs@^0.4`（Previewer API，动态 import；不用 polyfill 自动模式——那会接管全页样式与应用样式打架）。纸型边距维持 A4 / 18mm 20mm，不加选项。

## Emoji 短代码（2026-10-25）

`:smile:` 这类 GitHub 短代码只在显示层换脸，md 源文件永远是原文（`src/emoji-text.js`）。不能用 markdown-it-emoji 插件——它的 core 规则在 parse 阶段把文本 token 换成 emoji token，prosemirror-markdown 对未知 token 跳过，编辑器丢字、保存即删内容。

- 编辑器显示：`src/emoji-decorations.js` 的装饰插件（emoji widget + 原文 `font-size:0` 隐藏，与 hl-decorations 同族），行内代码与代码块里不换脸。
- 导出渲染：`mountEmojiRenderer` 只改 `renderer.rules.text`，挂在共享 tokenizer（整站 / 幻灯片导出）与 `main.js` 的 `exportMd`（单篇 HTML）上；docx 导出走 PM 文档树保持原文。
- 词表：markdown-it-emoji 的 full 数据 + shortcuts 别名，约 1900 条。

## 粘贴清理（2026-10-26）

富文本粘贴进编辑器前先过 `src/paste-clean.js` 的 `cleanPastedHtml`（`editor-view.js` 挂 `transformPastedHTML`；纯文本粘贴与 Ctrl+Shift+V 不走这条）。ProseMirror 拿到 text/html 后按 schema 解析，schema 管不住的只有结构垃圾：AI 对话框代码块头部的「复制 / Copy」按钮文字（button 不进 schema，按钮文字会被当正文留下）、行号装订线 span、代码块工具条、空段落串联、长串 `<br>`。清理三步：垃圾节点整棵摘（JUNK_TAGS + class 词元判定 + aria-label / data-testid 认「复制 / copy」）→ 空壳逐轮收缩（p / div / span / 空标题 / 空 li / 空链接，文本为空且子节点只剩 br；表格单元格不摘——空 td 是合法内容）→ 连续 3 个以上 `<br>` 收成 1 个（两个还可能是刻意的段落间隔）。class 按词元（classList 逐 token）匹配而不是属性子串，「copyright」不因含 copy 误杀；pre / code 本体永不按 class 摘——Prism 把 line-numbers 挂在 pre 上。实测 `node tests/paste-clean.test.mjs` 10 条全过。

## 标准 GFM 导出（2026-10-26）

新命令 `app.exportPlain`（Windows / Linux「更多」菜单、命令面板，须开库，按 `MENU_NEEDS_VAULT` 置灰）：把库内全部 md 复制到选定文件夹，Obsidian 私有语法在写出时降级，产物任何编辑器能开——「零锁定」用动作兑现。实现在 `src/plain-export.js`，io 注入与 `exportSite` 同模式（buildGraph / scanTree / readMd / writeFile / copyAssets）。

降级规则：callout 首行落 `> **标题**`（无标题用类型名，`-` / `+` 折叠标记丢弃，正文行保持引用块）；`![[图片]]` 落标准 `![alt](相对路径)`，数字别名是 Obsidian 的宽度语法、GFM 无对应形态，丢弃；`![[笔记]]` 落普通链接；`[[目标|别名]]` 落 `[别名](相对路径.md)`；未创建的链接只留别名文字，不产坏链；`[[目标#锚]]` href 丢锚（Obsidian 锚是标题原文、GFM 锚是 slug，直译必坏），锚保留在链接文字里。wikilink 解析复用 `build_site_graph` 的 wiki 表（与编辑器跳转、站点导出同一 Rust 实现），表里没有的 target 按 rel（含省略 .md 写法）/ basename 兜底再解一次；围栏代码块与行内代码里的 wiki 语法一律不动。链接地址经 encodeURI 并显式转 `(` `)`（GFM 链接目标不允许裸括号）。目录结构与原库一致，引用到的图片经 copyVaultAssets 镜像到同相对位置，frontmatter 原样保留。转换主体 `convertPlainMd` 是纯字符串函数；`node tests/plain-export.test.mjs` 12 条全过。词条 `cmd.app.exportPlain` / `plain.*` / `msg.plainExport*` 五语言。

## Quarkdown 可发现性（2026-10-26）

功能默认开（`features.quarkdown: true`），但藏在设置与文档里的功能约等于没做，可发现性单独做了一层（新模块 `src/qd/snippets.js`）：

- **斜杠菜单**：`/` 菜单末尾追加四个 Quarkdown 入门片段——变量（`.var`）、循环（`.foreach {1..3}` + 块体）、条件（`.ifnot` + 块体）、行内文本变换（`.text … case:{uppercase}`）。片段以 PM 节点插入：指令行落段落、块参数体落 code_block，与 `qd/editor.js` 收集求值区域的结构（指令段 + 连续 code_block / 列表）同构，插入即出快照，序列化按既有规则还原 4 空格缩进。片段文案走 `slash.qd.*` / `qd.snip.*` 词条，五语言。
- **编辑器右键菜单**：块插入组之后加「Quarkdown…」子菜单（`openQdInsertMenu`，同一份 QD_SNIPPETS），插到当前选区（`insertSnippet`，选区非空先删）。
- **内置模板**：工具条「模板」菜单加三个开箱即跑的模板——周报（.var + .foreach）、变量化文档头（.var 全文档引用）、编号与交叉引用（.numbering + 标题 {#id} + .mermaid caption/ref + .ref）。选了弹命名框（默认名带当日日期，规避 `create_md_file` 同名覆盖），落到库根新文件并打开；模板正文走 `tpl.qd.*` 词条，不写进库内 `Templates/`。
- **README** 新增「进阶：用 Quarkdown 让笔记可编程」一节（中英），动图演示位留了注释（`img/qd-demo.gif`，录好后取消注释）。
- **回归修复（2026-10-26）**：右键菜单点片段「点了没反应」——`insertSnippet` 给 `replaceSelection` 传的是 `Fragment` 而非 `Slice`，`openStart / openEnd` 为 undefined，`ReplaceStep` 里 `$from.depth - undefined` 得 NaN、`NaN != NaN` 恒成立，恒抛 `ReplaceError("Inconsistent open depths")`，事务中止插入永远失败（斜杠菜单的块替换路径用 `replaceWith` 不受影响，所以只有右键入口坏）。改为与 `insertPlainText` 同款的 `new Slice(Fragment.fromArray(…), 0, 0)`。回归测试 `tests/qd-snippets.test.mjs`（mock view 驱动插入：结构合法性、foreach 的段落+code_block 结构、空文档 / 非空选区插入）；真机（WebView2 远程调试 + Playwright）复验插入与状态栏提示均生效。教训：Chromium 里只验到「子菜单弹出」不够，要点到插入为止。

刻意不做：插入片段时不做「是否开启 Quarkdown」的确认弹窗——开关默认开；关掉的用户是有意关的，插进的指令以普通文本呈现也自洽。

「不再 GFM」提示（2026-10-26 补）：用了指令的文档离开 NoteLume 后指令部分就是普通文本（硬性约束 3 的取舍），代价要说在明处。片段插入（斜杠菜单 / 右键）后经 `setQdNotice` 钩子触发状态栏轻提示（`status.qdSnippetHint`）——片段是轻动作不打断；内置模板创建前走确认框（`msg.qdGfmWarn` / `msg.qdGfmTitle`）——创建是重动作；README 进阶章节写明同样的话。

## 功能开关（2026-10-25）

设置页「功能开关」区块（`src/feature-flags.js`，settings.json 的 `features` 段）：`tocBlock` / `csvTable` / `emoji` / `headingNumbering`。原则：**全部关闭即标准模式**——开关只关显示 / 输出层增强，md 源文件不受影响；坏数据逐键回落默认。开关改动经 `main.js` 的 `refreshFeatureFlags` 以 `nl-features` meta 广播全部编辑器强制重建装饰（emoji / toc / csv 三个插件的 `apply` 都认这个 meta）。

- **[[toc]] 目录块**：单独一行 `[[toc]]`（Obsidian 同款普通 wikilink）。编辑器 `src/toc-block.js` 装饰换目录块（H1–H3，slug 与全量标题同源去重，条目 `<a href="#slug">` 走既有锚点拦截）；导出侧 `site-export.js` 的 `injectToc` 换渲染产物里的 toc 锚，单篇 HTML 导出靠 `exportMd` 的 heading_open 锚点规则给标题发 id。幻灯片里按普通 wikilink（分片渲染取不到全文档标题，刻意不做）。
- **CSV 表格渲染**：`src/csv-preview.js`，mermaid 同构（光标出块隐源码挂表格 widget、点表进块），`parseCsv` 为 RFC4180 口径纯函数，短行补齐；导出件保留代码块（同 mermaid 先例）。
- **标题自动编号**：`src/heading-numbering.js` 的 CSS counter，只编 H1/H2（1、1.1），覆盖单篇 HTML / 整站（site.css `article` 前缀）/ 打印（`.nl-pbody`）/ 幻灯片（`.reveal .slides`，counter 跨 section 连续）四个输出点；编辑器与源文件不编。
- **Emoji 短代码**：见上节，`emoji` 开关关掉即不换脸。

## Quarkdown 引擎（2026-10-25 起，分期实施）

总体设计 `docs/superpowers/specs/2026-10-25-quarkdown-engine-design.md`，分期计划在 `docs/superpowers/plans/`（qd-engine-phase*.md）。约束：CLAUDE.MD 硬性约束第 3 条已修订——Quarkdown 语法文档不再要求 Typora / Obsidian 兼容，普通文档仍兼容；除 Quarkdown 层外不得再引入其他私有格式。参考实现 `.others/quarkdown/`（Kotlin，只读，不进构建）。

- **管线**：md → Rust 引擎（`src-tauri/src/qd/`：lexer / parser / AST / 求值器）→ 展开后的 Markdown + 诊断 → 前端既有 markdown-it 管线。命令 `qd_eval`（lib.rs 薄壳，注意：crate 根的 tauri command 不能用 `pub fn`，宏重导出会撞名）。
- **阶段 0 已完成**：解析器（指令行 / 花括号配平 / 段式链式 `::` / 缩进块 / 行内调用——`.` 前是字母数字则不算调用，排除小数与域名）、求值器（作用域栈、`.var` / `.function` / `.if` / `.ifnot` / `.let` / `.foreach` / `.repeat`、区间字面量 `{2..4}`、块变量、隐式首参 `.1`、递归上限 128）、最小内置库（Math 10 + Text 3，名字对齐 Quarkdown stdlib）、错误降级（单点失败 → 诊断 + 原文，不炸文档）。语法以 `.others/quarkdown/docs/*.qd` 为准：无 `.else`（用 `.ifnot` + `.let`），循环是 `.foreach` / `.repeat`。
- **阶段 1 已完成**：编辑器集成 `src/qd/editor.js`（装饰插件，mermaid/csv 同族交互——光标出区域隐源码挂快照 widget，快照 = evalQd 展开文本本地渲染，诊断灰字条，缓存键 = 区域源码）；区域 = 指令段 + 连续 code_block / 列表（缩进体在 CommonMark 落成这两类，重组按 4 空格还原；段落体 v1 不在区域内，已知限制）；导出注入：单篇 HTML / 幻灯片预展开、整站经 `exportSite` 的 `evalMd` 注入逐篇展开；打印走 DOM 克隆随快照带上。`features.quarkdown` 开关关闭时完全旁路；无 Tauri 环境 evalQd 透传。
- **阶段 2 批 1 已完成**：Strings 全量、Logical 全量、Math 补充（rem / abs / negate / sqrt / logn / sin / cos / tan / round）、Collection 17 个（getat / first / second / third / last / size / sumall / average / distinct / sorted / reversed / groupvalues 之外的 16 个 + withindices；findfirst / sortby / groupvalues 等需要 lambda 引用实参，随后续批次）。
- **阶段 2 批 2 已完成**：Data 模块（`src-tauri/src/qd/io.rs` + `csv.rs`）。`qd_eval` 加 `docDir` 参数（文档所在目录，前端 `qdDocDir` 拼 vaultRoot + 文档目录），文件类函数只认相对它的路径，绝对路径与 `..` 越界拒绝（canonicalize 校验）。`read`（行区间 `lines:{2..4}`）/ `pathtoroot`（恒 `.`，编译根即文档目录）/ `listfiles`（directories / recursive / pattern / fullpath / sortby / order；pattern 为手写迷你正则子集，CPS 回溯，不引 regex crate）/ `filename` / `json`（`Value` 新增 `Dict` 变体，Vec 保键序、输出 JSON 形态、as_items 产出 [键, 值] 对）+ `get`（Dictionary 取值入口，全量在批 4）/ `csv`（RFC4180 → Markdown 管道表格，caption 落斜体行，mode markdown 与 ref 交叉引用暂不支持）。`filetree` 吃 Markdown 列表块参数输出规范化列表（目录补斜杠、`...` 归一 `…`、粗体保留；Quarkdown 的 GFM 回退形态），`BuiltinCall` 为此加 `body` 字段。
- **阶段 2 批 3 已完成**：Document / Layout / TableComputation（`src-tauri/src/qd/document.rs` + `mdtable.rs`），口径定为**全部输出 Markdown、不做 HTML 片段**（HTML 要动四个 markdown-it 消费端并各接净化，不值）。落点：Document 23 个元数据函数静默 no-op，currentpage / totalpages 出 `-` 占位，`tableofcontents` → `[[toc]]`（复用前端 toc-block / injectToc）；布局容器（container / row / column / grid / center / align / float / landscape / fullspan / clip / navigation）body 平铺、样式丢弃；box / todo / collapse → 引用块加粗标题行，textcollapse 出展开全文，Layout `.table` 多子表按行列拼接。TableComputation 全量：tablesort / tablefilter / tablecompute / tablecolumn / tablecolumns / tablebyrows，表 = 块参数求值结果里的第一张管道表。机制增量：`Builtin.lambda_args` 声明 lambda 实参位（具名或 `pos:N`），eval 层先定目标再求值实参，命中位经 `parse_lambda_raw` 解析为 `Value::Lambda`（行内 `x: body` / 块头独占一行 / 无头隐式 `.1`），`Evaluator::call_lambda` 供 builtin 调用；普通文本实参不受参数头形似内容影响。Collection 收尾：findfirst（条件 lambda）、groupvalues（相等分组）；计划里写的 sortby 在 Kotlin stdlib 中不存在（只有 listfiles 同名参数）。`as_bool` 补认 Markdown（lambda 体输出 `Value::Markdown("yes")`，条件 lambda 此前全部判假）。未移植：numbered（依赖编号计数与交叉引用，`[[toc]]` 的 maxdepth 细调参数）。
- **阶段 2 批 4 已完成**：Slides / Bibliography / Localization / Dictionary / Ecosystem（include）+ Libraries 查询（`slides.rs` / `bibliography.rs` / `localization.rs` / `ecosystem.rs`，`dictionary` 在 stdlib.rs）。Slides 三函数：`slides` 配置收下校验（transition none/fade/slide/zoom、speed default/fast/slow）后静默——放映配置归导出链路，Markdown 里无处安放；`fragment` 标记丢弃、内容平铺（collapse 降级同一取舍）；`speakernote` 落 `::: notes` 容器，接前端幻灯片导出既有的备注链路。Bibliography 只支持 BibTeX（手写解析：花括号配平、字段名小写、值剥括号折空白、@comment/@string/@preamble 跳过）+ ieee 数字编号，apa 等 CSL 样式与 kotlin-bibliographer 不搬；条目内容是简化拼装（作者、*标题*、出处取 journal/booktitle/publisher 第一个非空、卷期页、年份）；`cite` 求值期落占位符 `{{nlcite-N}}`，eval_document 出口统一换成 `[n]` / `[n, m]`——cite 常在 bibliography 之前拿不到编号，编号按 bibliography 的条目文件顺序定（非 Kotlin 的首次引用重排），键查不到 `[?]`。Localization：`localization {表}` + Markdown 嵌套列表注册（顶层项语言、子项 `- 键: 值`，重名报错、merge:{yes} 按语言合并新条目优先），`localize {表:键}` 按当前语言查、先语言前缀回退（zh-CN→zh，Kotlin 没有这层，补的）再回退 en，std 内置表照抄 Kotlin 十语言 12 键启动即注册；`doclang` 从 Document no-op 名单拿出真做（有值设当前语言、认不出降级，无值回显 tag）。Dictionary 全量就是 Kotlin 的两个函数：`dictionary` 块参数构造（嵌套列表→嵌套字典、无值条目空字典、值字面量推断）+ `get` 补 `orelse:`；其余字典操作靠 as_items 的 [键, 值] 对适配复用 Collection（批 2 已有）。Ecosystem：`include` 三态——stdlib 名静默、`@scope/name:version` 包引用诊断降级（没有包仓库与安装通道）、文件路径读取求值（工作目录切到被包含文件所在目录、求值完恢复；sandbox 的 share 声明并入当前文档，scope / subdocument 走 `Evaluator::eval_isolated` 隔离不回传）；`includeall` 吃位置实参或块参数列表；`subdocument` 有 label 出 Markdown 链接、无 label 静默。Libraries 查询四件套 libexists / functionexists / libraries / libfunctions——已加载库恒定 stdlib（Kotlin 的 --libs 目录机制阶段 4 再议）。解析顺带修一个既有缺陷：行内调用的链式段不收参数（`.x::sum {1}` 的 {1} 全绑到头段被静默丢掉），scan_inline 改为参数归当前段；配套两处类型保真：单调用块变量与单调用实参直接取返回值，`.var {d}` 存字典、`.size {.d}` 传字典不再经文本往返丢型。实测 `cargo test --lib` 267 条全过（新增 26 条）。
- **阶段 3 已完成**：Mermaid / 交叉引用最小集 / 整库幻灯片 + Math 对拍修正 + 死代码清理。Mermaid（`mermaid.rs`）：`.mermaid` + 图源码块参数落 ```mermaid 围栏（编辑器与四个导出点的既有渲染链路直接吃），caption / ref 任一设置按 figure 计数（「图」取 std 本地化词条），caption 行落 `*图 N. caption*` 斜体、ref 记入交叉引用账本；`.xychart` 由数值列表生成 xychart-beta 源码再落围栏（顶层项是散点、自成一线，嵌套列表是一条线；lines / bars / x / xrange / xtags / y / yrange，xrange 与 xtags 互斥校验）；`subdocumentgraph` 依赖子文档图可视化，无输出。交叉引用最小集（`reference.rs`）：`.numbered {key} ref:{id}` 按分组计数（各 key 独立 1 起始）、body 以编号字符串为首参求值，`.ref {id}` 落占位符、eval_document 出口统一解析成账本编号（查不到 `[???]`，与 Kotlin 未解析引用同款），`.marker` 静默；标题 `{#id}` 属性、`.numbering` 的编号格式串（1.1.1 / 1.A.a）不支持——Markdown 输出撑不起，账本里只有各分组序号。Math 对拍修正三处：`logn` 是自然对数（Kotlin 的 kotlin.math.ln，此前误实现成按底对数）、`round` 取整单参数（此前多出的 decimals 参数移除）、`pow` 小数指数截断为整数；`truncate` 补具名 decimals 与负数校验；`isodd` 是 Kotlin 没有的 NoteLume 增补，保留。整库幻灯片：新命令 `app.exportVaultSlides`（Windows「更多」菜单、mac 文件菜单、命令面板，须开库，`MENU_NEEDS_VAULT` 置灰口径）把库内全部 md 按 build_site_graph 的树序合成一份放映件——逐篇剥 frontmatter、qd 求值（按各自目录），`buildVaultSlidesHtml`（slides-export.js）用 reveal 嵌套 section：外层章 = 文档（左右翻页）、内层 = 文档内的页（上下翻页），首页出片名与文档清单，切不出内容的文档整章跳过；产物仍是单文件自包含 HTML，默认名 `<库名>.slides.html`。死代码清理：删除无调用方的 eval_foreach / eval_repeat / last_seg、eval_raw 的 line 与 eval_seg_args 的 node 死参数；parser 的 first_end 改默认整行吃掉、只在首行记余文列——顺带修了跨行实参后按错行切首行余文的隐患。实测：`cargo test --lib` 275 条全过零告警（新增 13 条），前端 41 个测试文件全过（slides-export 新增 2 条），`build:web` 无错。
- **阶段 4 已完成**：Libraries / 包管理器 / FunctionExtension。Libraries：`qd_eval` 加 `libsDir` 参数（前端 `qdLibsDir`：库根 `Libraries/`，未开库退文档目录下的 Libraries/），`include {名}` 按文件名 stem 精确匹配 .qd 文件（对齐 Kotlin QdLibraries：只扫直接子级、loadLibrary 大小写敏感），share 语义声明并入、非定义内容进输出；`libexists` 大小写不敏感（对齐 findLibrary）、`libraries` 回显已加载库、`libfunctions` 对 .qd 库扫源码收集 `.function` 定义名。包管理器：`include {@scope/name:version}` 只读本地缓存（应用配置目录 `qd-packages/<name>/<version>/`，atom.toml 清单的 entrypoint 为入口，工作目录切到包根），未安装诊断降级——安装走新命令 `qd_package_install` 显式进行（命令面板「安装 Quarkdown 包…」输入引用），源为官方 atoms 仓库（GitHub quarkdown-labs/atoms，与 Kotlin PackageRepositories 默认注册一致），拉 atom.toml + entrypoint 两个文件落缓存，引用段禁 `..` 与路径分隔符；**文档求值不触发下载**——打开陌生文档不会自动执行远端代码（Kotlin 有 Permission.PackageInstall 闸，同思路）。atom.toml 手写最小解析只取 entrypoint（不引 toml crate）。FunctionExtension：`.extend {name} where:{条件}` + body 包装已有函数（用户 lambda 或内置），body 内 `.super` 调原函数——裸 `.super` 透传当前调用实参（Kotlin 参数沿袭口径，靠求值期 super / super_args 作用域绑定实现），显式 `.super {x}` 覆盖传参；where: 不满足透明回落；链式扩展后声明者紧贴原函数。实现为 `Value::Extended` 变体（base 持原函数），内置目标包 `Value::Builtin` 占位、eval_call 按内置表原路求值保住具名实参。实测：`cargo test --lib` 287 条全过零告警（新增 12 条），前端 41 个测试文件全过、`build:web` 无错。未实测：真实 atoms 仓库的下载安装（单测覆盖缓存读取与引用解析，HTTP 走既有 download_remote）、真机 include 库的快照呈现。
- **阶段 5 已完成（引擎五阶段收官）**：环境与文件树长尾 35 个函数（`longtail.rs` + `primitives.rs`）。环境：`.env` 读进程环境变量（Kotlin 需 ProcessAccess 权限，本引擎无权限系统——库与包是用户显式引入的受信内容），缺失回落 none；Logger 三件套 log / debug 打进程 stdout / stderr（副作用不进文档）、error 走既有错误降级（对齐 Kotlin 错误框）。杂项：keybinding 文本透传（Markdown 无 kbd 形态）。长尾各模块：Flow.node 不可见空节点；Text 四件套——br 落行尾反斜杠硬换行（编辑器 Shift-Enter 序列化同形态）、codespan 落行内代码（含反引号时双反引号夹空格）、match 迷你正则替换（io.rs 新增 `regex_replace`：最左优先、贪心、零宽匹配照出替换文本，Java replaceAll 口径；顺手给迷你正则补了 \d \w \s 字符类）、loremipsum 照抄 Kotlin 常量；Collection.pair 二元组（[a, b] 列表）；Strings.plaintext 行内 Markdown 简化剥离（图片 / 链接取文本、去强调与代码记号——批 1 计划里延后的实现）；Optionality 五件套 none / isnone / otherwise / ifpresent / takeif（与 get 缺键的 none 串用）；Color 落 CSS rgb()/rgba() 串、只给 base 时原样透传；Html.html / css 原样输出（编辑器 html_block 与 site-export 的 renderWithHtml 接管真实 HTML）、htmloptions / cssproperties / llmstxt 无输出；Markdown.markdown 原样透传。Primitives（.extend 定制同类元素的基座）：heading（depth 动态 1–6）/ paragraph / link / image / pagebreak / code / math / figure——pagebreak 落 `---`（幻灯片导出里是切片、普通文档是水平线；打印走 DOM 克隆不经引擎产物）；math 落 $$ 块 / $ 行内（KaTeX 管线直接吃）；figure 与 mermaid 共用 figure 计数与 caption 行；image 不落 width / height（Typora 尺寸形态非标准 GFM）。特殊形式 var / function / if / ifnot / let / foreach / repeat 在内置表登记占位（eval 层照旧拦截），functionexists / libfunctions 的清单口径补全。未移植（刻意）：Icon.icon、Emoji.emoji / allemojis——Bootstrap 图标与 1900 条 emoji 词表在 Rust 侧复制一份不值，emoji 显示层由前端 emoji-text.js 承担，调用即未知函数降级。实测：`cargo test --lib` 305 条全过零告警（新增 18 条），前端零改动。
- **阶段 6 已完成（stdlib 对 Kotlin 的差集清零）**：对 `.others/quarkdown` Kotlin stdlib 全量函数清单与 `docs/*.qd` 语法示例做逐项对拍，补齐此前的「刻意未移植」与语法缺口（新模块 `emoji.rs` / `emoji_data.rs` / `postprocess.rs`）。函数侧：`Emoji.emoji` / `allemojis`——1903 条短代码 → emoji 词表从 markdown-it-emoji 的 full 数据生成 Rust 静态表（`src/tools/gen-emoji-data.mjs`，与前端 emoji-text.js 同一份词表），未知短代码诊断降级；`Icon.icon` 落 jsDelivr CDN 的 Bootstrap SVG 图片（`![icon 名](…/icons/名.svg)`，非法字符拒绝）；`Text.text` 的 case 变换（uppercase / lowercase / capitalize）与 url 链接真实生效，size / weight 等纯样式参数无 Markdown 落点收下忽略；`NavigationContainer`（navigationcontainer）body 平铺。语义补全：`.sorted by:{lambda}`（键求值后排序，数值优先）；lambda 解构（Kotlin Destructuring）——多参数 lambda 收到单个 List 实参时按位置拆包（字典迭代出的 [键, 值] 对、`.pair` 二元组都吃），`bind_and_run` 与 `run_foreach` 两处生效；`.heading ref:{id}` 以标题 `{#id}` 形态落产物、进交叉引用账本；`.numbering` 真实现 + `.nonumbering` 真关闭（此前都是 no-op）。语法侧（postprocess 出口后处理，全部行级变换、跳围栏代码块）：`.numbering` 格式串按 Kotlin `NumberingFormat.format` 逐符号消费层级值——计数符号 1/a/A/i/I + 固定符号 + `\` 转义，层级值超出符号取值范围（层级跳跃补的 0、>26 的字母）落十进制字面量，层级值少于模板时尾部固定符号截断（`(1.1)` 配单层出 `(1` 是 Kotlin 已知行为，照抄），标题深度超过模板层数不编号（allowMismatchingLength=false）；标题编号按各层独立计数（层级跳跃补 0，Kotlin LocationAwarenessHook 的 gap filler 同款），编号前缀进标题文字，产物即 `## 1.1 标题`，源文件不受影响；figures / tables / `.numbered` 自定义 key 的格式串在各自计数点生效；标题 `{#id}` 剥离并登记交叉引用账本（`_` 仅编号不引用，无编号时引用落标题文字）；装饰标题 `#!` 剥掉叹号、不编号；表格题注（表格后一行 `"caption"` / `"caption" {#id}`）落 `*表 N. caption*`；`$$$ … $$$` 多行公式块改写为 `$$`；紧凑脚注 `[^label: 定义]` / `[^: 定义]` 改写为标准 `[^fn-N]` 引用 + 文末定义（同名 label 复用同一条定义，匿名各自独立），行内代码 span 内不碰。merge 语义：`.numbering` 默认与现有配置合并，`merge:{no}` 先清空。无 Markdown 落点、维持 no-op 的（引擎输出 Markdown 的架构决定，见硬性约束第 3 条）：Document 元数据（theme / pageformat / footer / pagemargin 等，分页渲染器专属）、equations / code / footnotes 的编号格式串（KaTeX 与 markdown-it-footnote 不吃编号参数）、`tableofcontents` 的 maxdepth（前端 `[[toc]]` 固定 H1–H3）、`!(WxH)` 图片尺寸、图片 / 表格 / 公式的非标题 `{#id}`（仅标题形态有账本落点）、blockquote 引用出处样式。实测：`cargo test --lib` 330 条全过零告警（新增 25 条：emoji 3、icon / text 2、sorted by 与解构 1、编号格式串 / 标题编号 / 装饰标题 / {#id} / 表格题注 / 脚注 / 公式块 / merge 共 19），前端零改动。
- **待做**：真机验收项——编辑器快照里标题编号 / 图标图片 / emoji 字符的实际呈现、`$$$` 公式块的 KaTeX 渲染；Kotlin 侧 CSL 参考文献样式（apa 等）与 kotlin-bibliographer 仍只支持 BibTeX + ieee 数字编号。

## 架构设计

### Rust（src-tauri）职责

1. 文件系统操作：打开文件夹库、读取md、保存md、复制图片到assets目录
2. 知识库索引构建：扫描文件夹，收集md文件列表、文档内的[[链接]]、#标签；维护文档之间引用关系，用于双向链接、全局搜索
3. Tauri系统对话框：文件夹选择器、文件保存对话框
4. 处理路径：统一相对路径、库内路径转换；处理跨平台路径兼容（Windows/macOS）
5. 不做编辑器渲染，渲染交给前端ProseMirror
6. 提供invoke接口，给前端调用知识库API
7. 文件打开链路的原生侧（P5 §6.6）：四条入口——启动参数、macOS 的 `application:openURLs:`、单实例二次唤起、窗口内拖入（纯前端，不经 Rust）——汇到 `deliver_open_targets` 一条交付通道：目标排进 `LaunchPaths` 队列，再 emit 一次不带路径的 `file-opened`，前端 boot 主动取、常驻时被动叫醒，两条时序都不丢。mac 的双击关联文件、右键「打开方式」、拖到 Dock 图标都只以 `RunEvent::Opened` 递 URL、不进 argv，要用 `build(context)?.run(callback)` 才接得到；目录也收（`Info.macOS.plist` 声明 `public.folder`），前端按 `isDir` 分流 `openVaultPath` / `openAbsPath`

### 前端 src/ 职责

1. ProseMirror WYSIWYG编辑器主体，核心编辑交互
2. 解析[[wikilink]]、#tag 自定义Markdown扩展，在ProseMirror中渲染成可点击链接、标签
3. UI布局：左侧知识库侧边栏（文件树+大纲+双向链接），主区域是WYSIWYG编辑器
4. 主题样式、快捷键绑定、hover悬浮预览
5. 调用Rust Tauri命令，获取文件列表、索引信息、读写文档

## 硬性约束

1. 使用 Tauri v2，Rust stable版本
2. 前端使用原生ES Module Vanilla JS，**不引入Vue/React**，降低项目体积和复杂度
3. md 文件以标准 GFM 为基底。**使用 Quarkdown 语法的文档（`.function` 函数、变量、条件循环、`.include` 等）不再要求 Typora / Obsidian 兼容**——这类文档离开 NoteLume 后指令部分就是无效文本，这是 2026-10-25 的明确取舍；未使用 Quarkdown 语法的普通文档仍然完全兼容 Typora / Obsidian。除 Quarkdown 层外不得再引入其他私有格式
4. 代码附带注释，所有代码必须可直接复制运行；按文件拆分输出
5. 每次输出先给出完整最小可运行demo，再逐步增加功能
6. 优先保证编辑器流畅性，知识库索引不要阻塞UI（Rust后台扫描）
7. 前端界面不用 emoji 与临时字形（✕ ✓ ▾ ↑ ↓ ⚠ • 之类），图标统一走 SVG sprite：`src/icons.js` 的 `setIcon(el, name, label)` / `iconHTML(name)`，图形数据只有 `index.html` 里 `<svg class="nl-sprite">` 那一份 `<symbol id="i-*">`。例外：键位图例（⌘ ⌥）、提示句里的 →、Git 状态字母徽标（M/N/D/R/C/?）
8. 分支纪律：`web`（网页沙盒试用版）**永不合并进** `master`（桌面主干），主干只收桌面改动。`master → web` 方向随时可合，那是 web 跟住主干的正常手段；反过来要拿 web 里的某条桌面修复，就把那一条单独 cherry-pick 到 master，不在 master 上合整支。两分支的公共祖先是 `c5846a0`，站在 master 上合 web 会一次性拖进 `server/`、`src/web/`、演示库与 `web:*` 脚本，git 不会拦也不报错，只靠这条约定兜（细则见 `docs/SERVER.MD`「分支与合并方向」）

## 界面多语言（i18n）

内置五种语言：简体中文 `zh-CN`（默认）、繁體中文 `zh-Hant`、English `en-US`、Français `fr-FR`、Deutsch `de-DE`。

- 词条在 `src/locales/`，一种语言一个文件，默认导出一个键值对象；新增语言在 `locales/index.js` 的 `LOCALES` 与 `MESSAGES` 各登记一行。
- `src/i18n.js` 是唯一入口：`t(key, vars)`（`{name}` 占位符）、`setLocale` / `getLocale`、`applyStaticDom`（刷 `data-i18n` / `-title` / `-placeholder` / `-aria-label`）、`onLocaleChange`（动态 UI 重绘订阅）。缺词条回退 en-US，再缺回退键名本身。
- 语言选择顺序：localStorage `nl-lang` → navigator.languages（按主语言匹配，zh 分简繁）→ 简体中文。切换入口在工具条「更多 → 界面语言」，mac 原生菜单与命令面板是五个 `app.lang.*` 命令（注册表驱动，标题与勾选态自动跟随）。
- 命令标题的键名与命令 id 对齐：`cmd.<命令id>`（如 `cmd.app.save`、`cmd.editor.block.h1`）；斜杠菜单项是 `cmd.block.<id>`；静态界面 `ui.*` / `panel.*`；菜单里不在注册表的条目 `menu.*`；弹窗 `dlg.*`；状态与消息 `status.*` / `msg.*`。换语言后 main.js 重新注册命令表并 `applyStaticDom`，依赖运行期文案的模块自己在渲染点调 `t()` 或订阅 `onLocaleChange`。
- 新文案一律进词条，不写死中文；中英标点各自惯例（中文全角、西文半角），法文注意省音符撇号（’）与窄空格习惯。
- 后端同理：`src-tauri/src/ui_lang.rs` 放五语言词表，Rust 各处 `ui_msg!("key", "name" => value)` 取词；前端启动与切语言时经 `set_ui_lang` 上报（tauri-bridge.js 的 `setUiLang`），未上报默认 zh-CN。带 `[code]` 前串的 git 错误与 `MERGED` / `CONFLICTS` 协议行只本地化前串之后的说明（前端按前串分派解析）；docx 导入警告的 code 不变、message 本地化。

## 当前状态

本地Rust已安装，tauri-cli已安装。
当前目标：搭建最小可运行版本，实现P0基础功能：

1. Tauri窗口，布局：左侧侧边栏文件树 + 主区域ProseMirror WYSIWYG编辑器
2. 选择本地文件夹作为知识库
3. 侧边栏点击md文件，加载文档到WYSIWYG编辑器
4. 编辑器修改内容，保存回原md文件
5. 识别[[wikilink]]，点击跳转库内文档，不存在文档提示新建
6. 基础暗黑/浅色切换

## 文档写作要求

写 CHANGELOG、docs、代码注释时按人的写法，不出现 AI 味表述：

1. 直陈问题、原因、改法，不写总结句，不升华
2. 一句话能说清的不要拆成三段；编号只用于真正并列的多项，不为凑结构而编号
3. 不用空话过渡：值得注意的是、归根结底、本质上、简而言之、与此同时、更重要的是
4. 不用戏剧化用词：打满、吃掉、凭空、丝滑、完美、优雅、一像素都不滚
5. 少用加粗，只在需要一眼定位的地方用
6. 保留具体信息：文件名、数字、测试名、复现步骤

## 输出要求

请一次性输出整套项目文件，分开列出：

1. src-tauri/Cargo.toml
2. src-tauri/tauri.conf.json
3. src-tauri/src/main.rs
4. src/package.json
5. src/index.html
6. src/main.js
   附带完整步骤：安装依赖、开发启动、打包。
   后续迭代时，可以继续基于这个文档，逐步增加P1/P2功能。

git地址

[gitee.com/hackerSnail/note-lume](https://gitee.com/hackerSnail/note-lume)

commit 后直接push
