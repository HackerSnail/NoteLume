
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

第二档（区分「能用」与「好用」）：

| 功能 | Win/Linux | Mac |
| --- | --- | --- |
| 命令面板 | Ctrl+P | Cmd+P |
| 快速打开文件 | Ctrl+O | Cmd+O |
| 粘贴为纯文本 | Ctrl+Shift+P | Cmd+Shift+P |
| 任务列表 | Ctrl+Shift+L | Cmd+Shift+L |
| 无序 / 有序列表 | Ctrl+Shift+[ / Ctrl+Shift+] | Cmd+Shift+[ / Cmd+Shift+] |
| 插入表格 | Ctrl+T | Cmd+T |
| 插入图片 | Ctrl+Shift+I | Cmd+Shift+I |
| 引用块 | Ctrl+Shift+Q | Cmd+Shift+Q |
| 删除当前行 / 段落 | Ctrl+D | Cmd+D |
| 提升 / 降低标题级别 | Ctrl+] / Ctrl+[ | Cmd+] / Cmd+[ |

第三档（加分项，已做的）：

| 功能 | Win/Linux | Mac |
| --- | --- | --- |
| 关闭当前文件 | Ctrl+W | Cmd+W |
| 专注模式（沉浸写作） | Ctrl+Shift+` | Cmd+Shift+` |
| 重命名当前文件 | F2 | F2 |

冲突裁决（同一键被两个习惯占用时，按档位取舍，低档位改键）：

1. Ctrl+P：命令面板（第二档）赢，打印 / 另存 PDF 取消默认键，只剩「更多」菜单入口，可在快捷键设置里自绑。
2. Ctrl+Shift+I：插入图片（第二档）赢，隐藏 / 显示检查器栏改到 Ctrl+Shift+B。
3. Ctrl+E：切换编辑 / 预览（第一档）赢，源码 ⇄ 所见即所得从 Ctrl+/ 挪到 Ctrl+E，Ctrl+/ 不再占默认键（设置里可绑回）。
4. Ctrl+Shift+`：专注模式（第三档）从 Ctrl+Shift+E 挪到 Ctrl+Shift+`，Ctrl+Shift+E 释放。
5. Ctrl+`：行内代码（第一档）赢，侧栏显隐保持 Ctrl+Shift+S，不占 Ctrl+`。

暂不做的：

- Ctrl+Tab 切换标签：本应用无标签页设计，不做标签切换。
- 关闭窗口 / 退出应用：交给系统（Alt+F4 / Cmd+Q），不占用 Ctrl+W。

两条链路说明：

- 编辑器命令（标题、列表、表格、链接、删行等）在 ProseMirror keymap 里求值，源码态（CodeMirror）下撤销 / 重做单独走 CM 历史，其余命令对源码态不生效。
- 应用命令（文件、视图、粘贴为纯文本）走 document 级 keydown 分发器，F2 这类无修饰键也已放行（keymap.js 允许 F1–F12 裸绑）。

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
