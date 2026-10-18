
# 项目：Markdown 知识库编辑器（定位介于 Typora & Obsidian 之间）

## 项目定位

介于 Typora 和 Obsidian 中间形态：
✅ 主编辑体验 = Typora：**单文档一体化WYSIWYG Markdown，所见即所得，点击渲染内容直接编辑**，不是左右分屏源码预览。排版干净、阅读感强。
✅ 知识库能力 = 精简版 Obsidian：本地文件夹作为知识库仓库，文件之间双向链接、内部跳转、标签、文档大纲、搜索；**不强制全量渲染庞大知识图谱（图谱作为可选附加功能）**。

区别对比：

- Typora：只专注单MD文件编辑，没有知识库、双向链接、库内搜索、标签、文档关系管理。
- Obsidian：以知识库为核心，默认是分栏+源码模式，WYSIWYG是插件，很重，图谱为核心卖点。
- 本项目：**WYSIWYG为第一编辑体验，知识库是内置基础能力，轻量化，优先编辑体验，图谱可选**。

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

| 功能 | Win/Linux | Mac |
| --- | --- | --- |
| 新建文件 | Ctrl+N | Cmd+N |
| 保存 | Ctrl+S | Cmd+S |
| 撤销 / 重做 | Ctrl+Z / Ctrl+Shift+Z | Cmd+Z / Cmd+Shift+Z |
| 查找 / 替换 | Ctrl+F / Ctrl+H | Cmd+F / Cmd+H |
| 加粗 / 斜体 | Ctrl+B / Ctrl+I | Cmd+B / Cmd+I |
| 插入链接 | Ctrl+K | Cmd+K |
| 代码块 | Ctrl+Shift+K | Cmd+Shift+K |
| 行内代码 | Ctrl+` | Cmd+` |
| 标题 1~6 | Ctrl+1~6 | Cmd+1~6 |
| 切换编辑 / 预览 | Ctrl+E | Cmd+E |
| 打印 / 另存 PDF | Ctrl+P | Cmd+P |

第二档（区分「能用」与「好用」）：

| 功能 | Win/Linux | Mac |
| --- | --- | --- |
| 命令面板 | Ctrl+Shift+P | Cmd+Shift+P |
| 快速打开文件 | Ctrl+O | Cmd+O |
| 粘贴为纯文本 | Ctrl+Shift+V | Cmd+Shift+V |
| 任务列表 | Ctrl+Shift+L | Cmd+Shift+L |
| 无序 / 有序列表 | Ctrl+Shift+[ / Ctrl+Shift+] | Cmd+Shift+[ / Cmd+Shift+] |
| 插入表格 | Ctrl+T | Cmd+T |
| 插入图片 | Ctrl+Shift+I | Cmd+Shift+I |
| 引用块 | Ctrl+Shift+Q | Cmd+Shift+Q |
| 删除当前行 / 段落 | Ctrl+D | Cmd+D |
| 提升 / 降低标题级别 | Ctrl+] / Ctrl+[ | Cmd+] / Cmd+[ |
| 关闭当前标签页 | Ctrl+W | Cmd+W |
| 切换下一个 / 上一个标签页 | Ctrl+Tab / Ctrl+Shift+Tab | Ctrl+Tab / Ctrl+Shift+Tab |

第三档（加分项，已做的）：

| 功能 | Win/Linux | Mac |
| --- | --- | --- |
| 专注模式（沉浸写作） | Ctrl+Shift+` | Cmd+Shift+` |
| 重命名当前文件 | F2 | F2 |

冲突裁决（同一键被两个习惯占用时，按档位取舍，低档位改键）：

1. Ctrl+P 归打印 / 另存 PDF（明确要求保留）；命令面板回 Ctrl+Shift+P；粘贴为纯文本改 Ctrl+Shift+V——这本来就是 Typora / Obsidian 的纯文本粘贴习惯键，且 mac 上 Cmd+Shift+V 就是系统级「粘贴并匹配样式」，语义重合。
2. Ctrl+Shift+I 归插入图片，隐藏 / 显示检查器栏改到 Ctrl+Shift+B。
3. Ctrl+E 归切换编辑 / 预览，源码 ⇄ 所见即所得从 Ctrl+/ 挪到 Ctrl+E，Ctrl+/ 不再占默认键（设置里可绑回）。
4. 专注模式用 Ctrl+Shift+`，原 Ctrl+Shift+E 释放。
5. Ctrl+` 归行内代码（第一档），侧栏显隐保持 Ctrl+Shift+S。
6. 标签页切换刻意用 Ctrl 而非 Mod：mac 上 Cmd+Tab 被系统「切换应用」占用，按键到不了应用内，故两个平台都绑 Ctrl+Tab。

暂不做的：

- 关闭窗口 / 退出应用交给系统（Alt+F4 / Cmd+Q），不占用 Ctrl+W。

两条链路说明：

- 编辑器命令（标题、列表、表格、链接、删行等）在 ProseMirror keymap 里求值，源码态（CodeMirror）下撤销 / 重做单独走 CM 历史，其余命令对源码态不生效。
- 应用命令（文件、标签页、视图、粘贴为纯文本）走 document 级 keydown 分发器；F2 这类无修饰键与 Ctrl+Tab 这类带修饰的 Tab 均已放行（keymap.js 的 `isFKey` 与 Tab 例外）。

## 标签页设计

单编辑器实例 + 一列打开中的文档：`src/tabs.js` 管列表与标签条，`main.js` 管切页 / 关页链路。不做多文档并发编辑——那要编辑器实例池加各自的脏状态机，收益不抵复杂度；标签页在这里的职责是「快速回到刚才看过的几篇」，与文件树、最近打开互补。

不变式：非活动页一定是干净的。离开一页时 `ensureSavedBeforeLeave` 已强制保存或放弃改动，所以关非活动页不必再问；标签上的脏点也只可能出现在活动页。

行为规则：

- 打开动作（点文件树 / 命令面板 / wikilink / 模板 / 最近打开 / 拖拽导入）都会落到某一页；同一路径只开一个标签，重复打开改为激活。
- 切页走既有打开链路：先处理当前文档的未保存改动，再换工作根、重载文件树与索引、重载插件。跨根切页（库 A 的文件切到临时目录的文件）同理，索引跟着根走。
- Ctrl+W 关活动页；只剩一页时等同关闭文档，回到无文档态（不退出应用）。关页后激活右邻，没有右邻取左邻。中键点标签 = 关闭，标签条超出宽度横向滚动。

新建文件的临时目录机制（配 Ctrl+N）：

- Ctrl+N 与工具条「新建」不要求先开知识库：文件建到系统临时目录 `<temp>/NoteLume/scratch/未命名-<时间戳>.md`，直接可编辑。
- 临时文件也是普通一页，标签带临时标记（标题后一个点）；侧栏在临时态只列当前这一个文件，不铺开 temp 目录。
- Ctrl+S 对临时文件 = 另存为：弹保存框选正式位置，落盘后该页改指新路径、退出临时态，并记入「最近打开」。自动保存仍写临时目录保命，不改变「还没选位置」这个事实。
- 关闭临时页先问「选位置 / 直接关闭 / 取消」；自动保存过也不再问保存与否，但仍会问要不要选位置。
- 临时目录路径存 localStorage（`nl-scratch-dir`），重开后从「打开文件」进到这个目录也能认出是临时文件。
- 文件树右键的「新建文件…」不变：那是在既有知识库里按目录建，属另一个刻意动作。

## 分栏设计（P5 §6.1，2026-10 起，取代上面「不做多文档并发编辑」的结论）

用户拍板做完整分栏引擎，上面「单编辑器实例」的结论就此作废：编辑器区是一棵 SplitPane 树，叶子窗格各持一个编辑器实例。

- `src/split-pane.js` 是引擎：树模型（`split` / `leaf` 两种节点）+ 4px 分割条 + 指针捕获拖拽，纯逻辑可单测；DOM 只做定向手术（拆分 / 关闭各只搬动一个元素），不整树重建——整树重建会把 ProseMirror 的 DOM 连根拔起。
- 窗格与标签页的绑定：一个标签同时只在一个窗格显示（`paneTabs` / `tabPane` 双向表）。点文件树 / wikilink / 命令面板都落到焦点窗格；点标签条把该标签挪到焦点窗格，原窗格留空。拆分时新窗格优先接管一个没人占的已开标签，没有则空置。
- 脏状态按窗格各自记（每个实例自己的 dirty），`ensureSavedBeforeLeave` / 自动保存遍历所有脏窗格；标签上的脏点取绑定窗格的 dirty。活动窗格的概念替代了「活动页」：面板（大纲 / 属性 / 反链 / git）与查找栏都跟焦点窗格走。
- 每侧最小 20%、最大 80%（p5plan §6.1）；比例与树结构存 settings.json 的 `panes` 段，拖拽结束（pointerup）即时落盘，窗口 resize 不重算（百分比天然自适应）。
- 画布模式在分栏下禁用（画布视图是单实例，多窗格要实例池，收益不抵复杂度，跟当初标签页的判断一个路子）；源码模式是编辑器实例内部状态，各窗格独立。
- 「拆分」按钮在编辑区右上角（横 / 竖两键）与标签条；关窗格按钮在每个窗格自己的右上角，只剩一个窗格时不显示。

## 架构设计

### Rust（src-tauri）职责

1. 文件系统操作：打开文件夹库、读取md、保存md、复制图片到assets目录
2. 知识库索引构建：扫描文件夹，收集md文件列表、文档内的[[链接]]、#标签；维护文档之间引用关系，用于双向链接、全局搜索
3. Tauri系统对话框：文件夹选择器、文件保存对话框
4. 处理路径：统一相对路径、库内路径转换；处理跨平台路径兼容（Windows/macOS）
5. 不做编辑器渲染，渲染交给前端ProseMirror
6. 提供invoke接口，给前端调用知识库API

### 前端 src/ 职责

1. ProseMirror WYSIWYG编辑器主体，核心编辑交互
2. 解析[[wikilink]]、#tag 自定义Markdown扩展，在ProseMirror中渲染成可点击链接、标签
3. UI布局：左侧知识库侧边栏（文件树+大纲+双向链接），主区域是WYSIWYG编辑器
4. 主题样式、快捷键绑定、hover悬浮预览
5. 调用Rust Tauri命令，获取文件列表、索引信息、读写文档

## 硬性约束

1. 使用 Tauri v2，Rust stable版本
2. 前端使用原生ES Module Vanilla JS，**不引入Vue/React**，降低项目体积和复杂度
3. 全部md文件为标准GFM，**文件完全兼容Typora/Obsidian**，不能自定义私有格式
4. 代码附带注释，所有代码必须可直接复制运行；按文件拆分输出
5. 每次输出先给出完整最小可运行demo，再逐步增加功能
6. 优先保证编辑器流畅性，知识库索引不要阻塞UI（Rust后台扫描）
7. 前端界面不用 emoji 与临时字形（✕ ✓ ▾ ↑ ↓ ⚠ • 之类），图标统一走 SVG sprite：`src/icons.js` 的 `setIcon(el, name, label)` / `iconHTML(name)`，图形数据只有 `index.html` 里 `<svg class="nl-sprite">` 那一份 `<symbol id="i-*">`。例外：键位图例（⌘ ⌥）、提示句里的 →、Git 状态字母徽标（M/N/D/R/C/?）

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
