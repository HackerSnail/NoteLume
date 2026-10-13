# NoteLume

一个介于 **Typora** 与 **Obsidian** 之间的 Markdown 知识库编辑器：

- **主编辑体验 = Typora**：单文档一体化 WYSIWYG Markdown，点击渲染内容直接编辑，非左右分屏源码；排版干净，阅读感强。
- **知识库能力 = 精简版 Obsidian**：本地文件夹即知识库，双向链接、库内跳转、标签、大纲、搜索内置；知识图谱作为可选附加能力，不默认渲染大图。

> 设计文档与迭代路线见 [`docs/CLUADE.MD`](docs/CLUADE.MD)。

---

## 特性状态

| 阶段         | 内容                                                                                          | 状态      |
| ------------ | --------------------------------------------------------------------------------------------- | --------- |
| **P0** | WYSIWYG 编辑（标题/粗斜/删除线/引用/有序无序/任务列表/表格/行内代码/代码块/图片/链接）        | ✅ 已完成 |
| **P0** | Markdown ↔ ProseMirror 双向无损（12 项幂等测试全通过）                                       | ✅ 已完成 |
| **P0** | 图片拖拽/粘贴自动落库`assets/` 并生成相对链接                                               | ✅ 已完成 |
| **P0** | 快捷键 Ctrl+S / Ctrl+O / Ctrl+B / Ctrl+I                                                      | ✅ 已完成 |
| **P0** | 浅色/暗黑/吸血鬼主题切换 + 类 Typora 阅读排版                                              | ✅ 已完成 |
| **P0** | 打开本地文件夹作为知识库、文件树、点击切换                                                    | ✅ 已完成 |
| **P0** | 单独打开一个 md 文件（所在目录作为工作根，可正常保存）                                    | ✅ 已完成 |
| **P0** | `[[wikilink]]` 支持：识别、点击跳转、目标不存在时提示新建                                   | ✅ 已完成 |
| **P0** | 文档大纲面板（点击跳转）                                                                      | ✅ 已完成 |
| **P0** | `#tag` 识别并在侧栏展示                                                                     | ✅ 已完成 |
| **P1** | 双向链接面板（引用本文件 + 本文件引用），Rust 后台索引 + 增量更新                        | ✅ 已完成 |
| **P1** | 全局搜索（标题/正文/#标签），侧栏内实时回显匹配片段                                            | ✅ 已完成 |
| **P1** | 自动保存 + 库内备份（停手 2s 写回；每 2 分钟副本到 `.notelume-backup/日期/`）              | ✅ 已完成 |
| **P1** | KaTeX 行内与块级数学（往返无损，与 Obsidian/Typora 写法互通）                              | ✅ 已完成 |
| **P1** | 代码块语法高亮（highlight.js 视图装饰，不污染文档模型与 markdown）                          | ✅ 已完成 |
| **P1** | 导出 HTML（系统保存对话框）+ 打印/PDF（Ctrl+P）                                                  | ✅ 已完成 |
| **P1** | `[[链接]]` hover 悬浮预览（卡片展示目标文档标题 + 摘要）                                     | ✅ 已完成 |
| **P2** | 简易知识图谱（Canvas 力导向，无外部依赖）                                                  | ✅ 已完成 |
| **P2** | 版本快照 UI（历史备份列表 · 全文预览 · 一键回滚）                                       | ✅ 已完成 |
| **P2** | 插件基础钩子系统（`.notelume-plugins/*.js`：快捷键 / 命令 / 输入规则 / 生命周期）      | ✅ 已完成 |
| **P2** | 画布 · 白板（JSON Canvas 规范，与 Obsidian `.canvas` 互操作）                          | ✅ 已完成 |
| **P2** | 移动端                                                                             | ⏳ 规划中 |

---

## 技术栈

- **桌面外壳**：Tauri v2 + Rust stable
- **编辑器**：Vanilla JS + ProseMirror + prosemirror-markdown
- **前端构建**：Vite（打包器，不引入 Vue/React 等框架）
- **存储**：完全基于本地文件夹 + `.md` 文件，标准 GFM，兼容 Typora / Obsidian，无数据库
- **平台**：Windows 优先（WebView2 + MSVC），macOS / Linux 同架构可跑

---

## 目录结构

```
NoteLume/
├── docs/CLUADE.MD          # 设计与迭代文档（本 README 的上级规格）
├── src-tauri/              # Rust 后端（Tauri v2）
│   ├── Cargo.toml
│   ├── build.rs
│   ├── capabilities/       # 权限清单（core + dialog）
│   ├── icons/              # 应用图标（tauri icon 生成）
│   ├── tauri.conf.json
│   └── src/
│       ├── main.rs         # 入口（薄壳）
│       └── lib.rs          # 23 个 #[tauri::command]：扫描/读写/wikilink/assets +
│                            # 后台索引 · 双向链接 · 全局搜索 · 悬浮预览 · 备份 · 导出 · 图谱 · 快照 · 插件
├── src/                    # 前端 Web 工程（Vite 根）
│   ├── index.html
│   ├── main.js             # 应用装配：面板/快捷键/自动保存/导出/索引轮询
│   ├── editor-schema.js    # ProseMirror 扩展 schema + MD 双向转换（含 KaTeX，纯逻辑可 Node 单测）
│   ├── editor-view.js      # WYSIWYG 编辑器装配：插件、快捷键、输入规则、图片拖粘
│   ├── hl-decorations.js   # 代码块语法高亮（视图层 Decoration）
│   ├── math-nodeviews.js   # KaTeX NodeView（行内/块级，双击编辑）
│   ├── wiki-hover.js       # [[链接]] 悬浮预览卡片
│   ├── graph-view.js       # P2 知识图谱（Canvas 2D 力导向）
│   ├── snapshot-panel.js   # P2 版本快照：历史列表 / 预览 / 回滚
│   ├── plugin-loader.js    # P2 插件钩子：动态加载 / 快捷键注入 / 生命周期总线 / 面板
│   ├── canvas-view.js      # P2 画布 / 白板：JSON Canvas 渲染 / 拖拽连线缩放 / 双击编辑
│   ├── tauri-bridge.js     # Rust invoke 封装 + 系统对话框
│   ├── style.css           # 类 Typora 排版 + 浅/暗/吸血鬼主题 + 新面板样式
│   ├── vite.config.js
│   ├── package.json
│   └── tests/
│       └── roundtrip.test.mjs   # Markdown <-> ProseMirror 幂等回归测试（12 例）
└── package.json            # 根脚本：代理到 src/ 里本地安装的 @tauri-apps/cli
```

---

## 环境准备

- **Rust stable**（`rustc --version` 至少 1.80+；本项目实测 1.99）
- **MSVC 构建工具**（Windows）：`tauri info` 可核对
- **WebView2 运行时**（Windows 10/11 自带或经 Edge 更新）
- **Node.js** ≥ 18 + npm

自检一条命令即可：

```bat
npm run tauri -- info
```

---

## 开发启动

```bat
:: 1) 安装前端依赖（含本地 @tauri-apps/cli）
cd src
npm install
cd ..

:: 2) 从仓库根启动 Tauri 开发模式（beforeDevCommand 会自动跑 vite）
npm run dev
```

首次会编译 Rust 依赖树，视机器 3–10 分钟；之后是增量编译。

## 回归测试（可选，无需浏览器）

```bat
npm run test:roundtrip
```

对 12 个样例做「解析 → 序列化 → 再解析 → 再序列化」幂等校验，覆盖：标题 / 行内混排 / 引用与列表 / 任务列表 / 代码块 / 图片 / `[[wikilink]]` / `#tag` / 表格 / 行内公式 / 块公式 / 组合。

## 生产打包

```bat
npm run build
```

产物落在 `src-tauri/target/release/bundle/`（Windows 下含 `.msi` 与 `.exe`）。

---

## 首次上手清单

1. 打开应用，点工具条 **📄 打开文件** 直接编辑单个 md（Ctrl+O），或点 **📂 打开知识库** 选一个本地文件夹作为库根（Ctrl+Shift+O）
2. 左侧文件树点击 `.md` 文件即可加载；直接编辑，**Ctrl+S** 写回原文件（或勾选右上角「自动保存」，停手 2s 自动写盘 + 每 2 分钟一份时间戳副本）
3. 在正文输入 `[[文档名]]`，敲完右中括号会自动变成可点击链接；hover 弹出目标文档预览，点击若目标不存在会提示新建
4. 输入 `#标签 `（末尾空格触发）变成标签 chip，侧栏「标签」面板列出当前文档全部标签；点 chip 直接归入全局搜索
5. 拖一张图片到编辑区，或剪贴板 Ctrl+V 粘贴图片：自动拷贝到同目录的 `assets/`，正文以 `![](./assets/xxx.png)` 相对路径写入
6. 「大纲」面板按标题层级列出，点击可跳转；「双向链接」面板实时展示「引用本文档」+「本文档引用」
7. 侧栏顶部搜索框（Ctrl+F 聚焦）：在索引内匹配标题/正文/#标签，带片段回显
8. 代码块自动高亮（已预置 37 种常用语言）；行内公式写 `$x^2$`，敲完尾 `$` 自动射为公式；块级公式输入 `$$` 独占一行 + 内容 + `$$` 独占一行；或按 Ctrl+M / Ctrl+Shift+M 插入占位；双击公式可编辑
9. 工具条 📤 导出 = 导出当前文档为自含样式的 HTML（系统对话框选目录）；🖨 打印 = 使用系统打印对话框，可另存 PDF
10. 右上角 🌙/🧛/☀️ 主题按钮循环切换 浅色 → 暗黑 → 吸血鬼（记忆在 localStorage）
11. 工具条 🕸 图谱（或 Ctrl+G）打开知识图谱模态；拖平移、滚轮缩放、拖节点重定位、点节点跳文档，当前文档红点高亮
12. 侧栏 📦 历史版本面板：列出当前文档历次保存/自动保存产生的快照（最新在前），点条目预览全文，右下角“↩ 回滚到此版本”一键覆盖（覆盖前会自动另存当前版，回滚可逆）
13. 插件：把 `.js` 文件放进知识库根的 `.notelume-plugins/`，打开知识库后自动加载；侧栏 🔌 插件面板可启用/禁用（记忆）与点击执行插件命令。示例见 `examples/notelume-plugins/hello.js`（注册 Mod-Shift+H 快捷键 + 插入时间命令）
14. 画布 / 白板：工具条 🗺 新画布 新建 `.canvas`（或双击画布空白处新建卡片）；拖拽移动 /  shift 多选 / 拖端口连线 / 拖角点缩放 / 双击编辑文字 / 六色色板 / 滚轮缩放 / ⤢ 适应；`.canvas` 文件遵循 JSON Canvas 规范，可被 Obsidian 直接打开互操作

---

## 关键快捷键

| 键位                | 作用                 |
| ------------------- | -------------------- |
| Ctrl + O            | 打开单个 Markdown 文件 |
| Ctrl + Shift + O    | 打开文件夹作为知识库 |
| Ctrl + S            | 保存当前文档         |
| Ctrl + B            | 粗体                 |
| Ctrl + I            | 斜体                 |
| Ctrl +\`            | 行内代码             |
| Ctrl + Shift + X    | 删除线               |
| Ctrl + Z / Ctrl + Y | 撤销 / 重做          |
| Shift + Enter       | 硬换行               |
| Ctrl + F            | 聚焦侧栏全局搜索框   |
| Ctrl + P            | 打印 / 打印为 PDF    |
| Ctrl + M            | 插入行内公式（有选区则包裹） |
| Ctrl + Shift + M    | 插入块级公式                 |
| Ctrl + G            | 打开/关闭知识图谱（模态）            |

---

## 设计要点

- **纯 GFM，零私有格式**：所有 md 文件可被 Typora / Obsidian 直接打开，无信息丢失
- **`[[wikilink]]` 与 `#tag` 是行内节点**（非普通文本），通过 markdown-it 自定义 inline 规则识别、ProseMirror 序列化为标准 `[[…]]` / `#xxx`；输入规则让你在编辑器里敲下 `]]` 或紧跟空格的 `#xxx` 即自动生成节点
- **表格、任务列表**：GFM 语义（表头行 + 对齐分隔行 + `- [x]` / `- [ ]`）；单元格允许行内内容，序列化时按列宽对齐输出
- **Rust 后端**只做文件/索引/路径处理，UI 与渲染全在 ProseMirror，职责清晰
- **路径安全**：`ensure_inside_root` + `..` 逃逸拒绝，避免 md 读写越出库根

---

## 已知边界（当前版本）

- 表格支持渲染/编辑内容/无损往返，但**增删行列、Tab 单元格跳转**尚未接入（依赖 prosemirror-tables，下个迭代补上）
- 图片走字节 → base64 → 落盘路径，**超大图（数十 MB）粘贴**会比文件拖拽慢；下个迭代拖拽会直接用绝对路径拷贝
- KaTeX 公式双击编辑目前走 `window.prompt`，后续换成内置弹窗
- 搜索为 substring 匹配，未上分词/拼音；索引内容全量存内存，知识库量级至数百 md 文件时无压力，未来可换 fallthru + 磁盘索引
- `assets/` 目前放在每个 md **同目录**（相对链接最稳）；库根级 `assets` 归一化留待后续
- 备份文件写入 `.notelume-backup/`（已默认不入库根扫描）；P2 版本快照 UI 已提供历史列表 / 预览 / 一键回滚
- 插件钩子（P2 v1）：`.notelume-plugins/*.js` 可注册快捷键 / 命令 / 输入规则 / 生命周期回调；暂不支持运行时扩展 schema（registerNodeSpec / MarkSpec），且无沙箱——插件与主线程同权，用户自担风险
- 画布（P2 v1）：已覆盖卡片/连线/缩放/颜色/文件节点；多选对齐、分组、边箭头双端、JSON Canvas 其余字段（如 group）留待后续

---

## Git 工作流约定（本仓库）

- 远端：`https://gitee.com/hackerSnail/note-lume.git`（`origin`）
- 分支：`master`
- 协作规则见 `docs/CLUADE.MD` 末尾：**改动验证通过后直接 commit + push**，无需逐次确认；破坏性操作（`--force` / `--no-verify`）仍需显式同意

---

## License

[Apache License 2.0](http://www.apache.org/licenses/LICENSE-2.0)。完整文本见仓库根目录 [LICENSE](LICENSE)。

Copyright 2026 hackerSnail
