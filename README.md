# NoteLume

一个介于 **Typora** 与 **Obsidian** 之间的 Markdown 知识库编辑器：

- **主编辑体验 = Typora**：单文档一体化 WYSIWYG Markdown，点击渲染内容直接编辑，非左右分屏源码；排版干净，阅读感强。
- **知识库能力 = 精简版 Obsidian**：本地文件夹即知识库，双向链接、库内跳转、标签、大纲、搜索内置；知识图谱作为可选附加能力，不默认渲染大图。

> 设计文档与迭代路线见 [`docs/CLUADE.MD`](docs/CLUADE.MD)。

---

## 特性状态

| 阶段         | 内容                                                                                                              | 状态      |
| ------------ | ----------------------------------------------------------------------------------------------------------------- | --------- |
| **P0** | WYSIWYG 编辑（标题/粗斜/删除线/引用/有序无序/任务列表/表格/行内代码/代码块/图片/链接）                            | ✅ 已完成 |
| **P0** | Markdown ↔ ProseMirror 双向无损（12 项幂等测试全通过）                                                           | ✅ 已完成 |
| **P0** | 图片拖拽/粘贴自动落库`assets/` 并生成相对链接                                                                   | ✅ 已完成 |
| **P0** | 快捷键 Ctrl+S / Ctrl+O / Ctrl+B / Ctrl+I                                                                          | ✅ 已完成 |
| **P0** | 浅色/暗黑/Dracula 主题切换 + 类 Typora 阅读排版                                                                   | ✅ 已完成 |
| **P0** | 打开本地文件夹作为知识库、文件树（右键新建/重命名/移动/删→回收站 + 拖拽移动/外部拖入导入）                       | ✅ 已完成 |
| **P0** | 单独打开一个 md 文件（所在目录作为工作根，可正常保存）                                                            | ✅ 已完成 |
| **P0** | `[[wikilink]]` 支持：识别、点击跳转、目标不存在时提示新建                                                       | ✅ 已完成 |
| **P0** | 文档大纲面板（点击跳转）                                                                                          | ✅ 已完成 |
| **P3** | 标签全局视图：全库标签 + 计数，点标签列出含该标签文档（走索引）                                                   | ✅ 已完成 |
| **P3** | `[[` / `#` 输入自动补全下拉（全库文档名 / 已有标签的模糊匹配，↑↓ Enter Esc）                                | ✅ 已完成 |
| **P3** | 表格完整编辑：增删行列 / Tab 跨格 / 列宽拖拽 / 右键行列菜单（`prosemirror-tables`）                             | ✅ 已完成 |
| **P3** | Obsidian callout `> [!NOTE]` 渲染为彩色卡片（自定义块规则 + CSS，与文件互通）                                   | ✅ 已完成 |
| **P3** | Mermaid 图表（` ```mermaid ` 代码块渲染为图；`mermaid` 懒加载，不拖累首屏）                                   | ✅ 已完成 |
| **P3** | 文件树图片附件单独查看（PNG/JPG 等点击全屏放大/缩放，读字节 data URL，只读不进编辑器）                            | ✅ 已完成 |
| **P3** | Obsidian 图片嵌入 `![[图片]]` 渲染为图（裸名按库内文件名回退查找，与 `![[笔记]]` 链接共存，往返无损）         | ✅ 已完成 |
| **P0** | `#tag` 识别并在侧栏展示                                                                                         | ✅ 已完成 |
| **P1** | 双向链接面板（引用本文件 + 本文件引用），Rust 后台索引 + 增量更新                                                 | ✅ 已完成 |
| **P1** | 全局搜索（标题/正文/#标签），侧栏内实时回显匹配片段                                                               | ✅ 已完成 |
| **P1** | 自动保存 + 库内备份（停手 2s 写回；每 2 分钟副本到`.notelume-backup/日期/`）                                    | ✅ 已完成 |
| **P1** | KaTeX 行内与块级数学（往返无损，与 Obsidian/Typora 写法互通）                                                     | ✅ 已完成 |
| **P1** | 代码块语法高亮（highlight.js 视图装饰，不污染文档模型与 markdown）+ 右上角可点语言标签（Typora 式，弹搜索选语言） | ✅ 已完成 |
| **P1** | 导出 HTML（系统保存对话框）+ 打印/PDF（Ctrl+P）                                                                   | ✅ 已完成 |
| **P1** | `[[链接]]` hover 悬浮预览（卡片展示目标文档标题 + 摘要）                                                        | ✅ 已完成 |
| **P2** | 简易知识图谱（Canvas 力导向，无外部依赖）                                                                         | ✅ 已完成 |
| **P2** | 版本快照 UI（历史备份列表 · 全文预览 · 一键回滚）                                                               | ✅ 已完成 |
| **P2** | 插件基础钩子系统（`.notelume-plugins/*.js`：快捷键 / 命令 / 输入规则 / 生命周期）                               | ✅ 已完成 |
| **P2** | 画布 · 白板（JSON Canvas 规范，与 Obsidian`.canvas` 互操作）                                                   | ✅ 已完成 |
| **增强** | 模板新建（`{{date}}`/`{{title}}` 等变量替换，未知 token 保留）+ 今日速记（`Ctrl+Shift+D` 全局浮层，**与知识库解绑**，自动存到固定目录）  | ✅ 已完成 |
| **增强** | 编辑器手感包：斜杠 `/` 块菜单 + 写作统计（字数/阅读时长/目标）+ 专注模式 `Ctrl+Shift+F` + 打字机模式 `Ctrl+Shift+T`  | ✅ 已完成 |
| **增强** | 正文 Markdown 源码双模式（CodeMirror 6，`Ctrl+/` 整篇互切，语法高亮/行号，**原文保真**保存不重排）  | ✅ 已完成 |
| **增强** | 打开最近文件（`▾ 更多 → 🕘 最近打开`，跨库全局记录、一键重开并回灌目录上下文）  | ✅ 已完成 |
| **增强** | 整库导出 HTML 静态站（`▾ 更多 → 🌐 导出整站…`）：全保真渲染 + wikilink/图片重写 + 侧栏树/反链/首页/纯前端搜索，本地双击即浏览的“本地维基”  | ✅ 已完成 |
| **增强** | 命令面板（`Ctrl+Shift+P`：模糊搜命令/文档、回车执行）+ 快捷键自定义（应用/编辑器/插件命令可重绑、冲突硬阻止、localStorage 持久化），收敛为统一命令注册表  | ✅ 已完成 |
| **增强** | 本地 Git 集成（侧栏 🌿 Git 面板：仓库探测 / status 改动 / log 历史 / 单文件 diff 预览 / 一键提交 / 初始化，`git2` 内置无外部 git 依赖）  | ✅ 已完成 |
| **增强** | Git 远程同步·快进 Pull（「同步」区：系统 git 探测 / 远端 origin 增改 / `fetch` / 领先落后 / `pull --ff-only`；认证复用系统凭据助手·ssh-agent·GCM、应用零凭据存储；不含 push 与冲突自动解决，属后续 R2/R3）  | ✅ 已完成 |
| **增强** | Git 远程内置引擎（R1-B：免装系统 git 也能 fetch/pull——`git2` 新开 `ssh`+`https` feature，Windows MSVC 下 libgit2 走 Schannel、libssh2 走 win32-crypto，**零 openssl**；凭据不存不弹：SSH 先试 ssh-agent → 无口令私钥、HTTPS 先试 env token；SSH 首次陌生 host 走一次性信任，写应用私库 `git-known_hosts`；面板顶部徽标 🛡 系统 git / 📦 内置引擎；装了 git 优先走 R1 shell-out、没装自动切内置）  | ✅ 已完成 |
| **P2** | 移动端                                                                                                            | ⏳ 规划中 |

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
│       └── lib.rs          # 47 个 #[tauri::command]：扫描/读写/wikilink/assets +
│                            # 后台索引 · 双向链接 · 全局搜索 · 悬浮预览 · 备份 · 导出 · 整站图/资源拷贝 · 图谱 · 快照 · 插件 · 本地 Git（git2）· 远程 Git（系统 git）
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
│   ├── git-panel.js         # 批次 E（L+R1+R1-B）本地+远程 Git：本地探测/status/log/diff/提交/初始化 + 远程「同步」区（引擎徽标/远端增改/fetch/领先落后/快进 pull/一次性 SSH host 信任/错误分类引导）
│   ├── plugin-loader.js    # P2 插件钩子：动态加载 / 快捷键注入 / 生命周期总线 / 面板
│   ├── canvas-view.js      # P2 画布 / 白板：JSON Canvas 渲染 / 拖拽连线缩放 / 双击编辑
│   ├── template.js         # 模板变量替换 + 日期格式化（纯函数，供从模板新建 / 每日笔记）
│   ├── daily-capture.js    # 全局「今日速记」浮层（textarea，与知识库解绑，自动存固定目录）
│   ├── slash-menu.js       # 编辑器手感：空行 `/` 弹块类型菜单（Typora 式）
│   ├── writing-stats.js    # 写作统计（字数/阅读时长，纯函数，中英日混排口径）
│   ├── editor-modes.js     # 专注模式（当前块高亮）+ 打字机模式（当前块居中）
│   ├── source-editor.js    # 正文源码模式（CodeMirror 6，CM/@lezer 全懒加载）
│   ├── source-sync.js      # 进源码展示原文 vs 序列化的纯判定
│   ├── tauri-bridge.js     # Rust invoke 封装 + 系统对话框
│   ├── style.css           # 类 Typora 排版 + 浅/暗/Dracula 主题 + 新面板样式
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
2. 左侧文件树点击 `.md` 文件即可加载；直接编辑，**Ctrl+S** 写回原文件（或勾选右上角「自动保存」，停手 2s 自动写盘 + 每 2 分钟一份时间戳副本）；右键文件树条目弹出菜单——**文件**（打开 / 重命名·移动 / 删除）、**文件夹**（新建文件 / 新建文件夹 / 重命名·移动）、**空白区**（在库根新建）；重命名/新建用应用内输入框，删除会弹确认并将文件**移入系统回收站**、可恢复，并同步从索引/双向链接中移除；也可直接把文件/文件夹**拖拽**到目标文件夹移动，或从系统**拖入** `.md` / `.canvas` / 图片到文件树即导入库内；点击树中的图片附件（🖼 图标，如 `Pasted image *.PNG`）会弹出**全屏查看器**单独放大（适应窗口 / `−`·`＋` 缩放 / 1:1 / 滚轮缩放 / 双击切换，Esc 或点空白关闭；图片只读，不打断底下正打开的笔记）
3. 在正文输入 `[[` 即弹全库文档名模糊下拉（↑/↓ 移、Enter/Tab 选中、Esc 关，选中直接成链接）；也可手敲 `[[文档名]]`，敲完右中括号会自动变成可点击链接；hover 弹出目标文档预览，点击若目标不存在会提示新建
4. 输入 `#` 即弹已有标签补全下拉（同 ↑/↓、Enter/Tab、Esc）；也可手敲 `#标签 `（末尾空格触发）变成标签 chip，侧栏「标签」面板列出当前文档全部标签；点 chip 直接归入全局搜索。该面板下方还有“**全局标签**”区：列出全库所有标签及出现次数，点标签展开含该标签的文档、点文档直接跳转
5. 拖一张图片到编辑区，或剪贴板 Ctrl+V 粘贴图片：自动拷贝到同目录的 `assets/`，正文以 `![](./assets/xxx.png)` 相对路径写入
6. 「大纲」面板按标题层级列出，点击可跳转；「双向链接」面板实时展示「引用本文档」+「本文档引用」
7. 侧栏顶部搜索框（Ctrl+F 聚焦）：在索引内匹配标题/正文/#标签，带片段回显
8. 代码块自动高亮（已预置 37 种常用语言）；行内公式写 `$x^2$`，敲完尾 `$` 自动射为公式；块级公式输入 `$$` 独占一行 + 内容 + `$$` 独占一行；或按 Ctrl+M / Ctrl+Shift+M 插入占位；双击公式可编辑
9. 工具条 ▾ 更多 → 📤 导出 = 导出当前文档为自含样式的 HTML（系统保存对话框选目录）；🌐 导出整站… = 选一个输出目录，把整库渲染为本地静态站（侧栏导航/反链/首页/搜索）；🖨 打印 = 使用系统打印对话框，可另存 PDF
10. 右上角主题按钮显示当前主题（☀️ 浅色 / 🌙 暗黑 / 🧛 Dracula），点击循环切换 浅色 → 暗黑 → Dracula（记忆在 localStorage）
11. 工具条 🕸 图谱（或 Ctrl+G）打开知识图谱模态；拖平移、滚轮缩放、拖节点重定位、点节点跳文档，当前文档红点高亮
12. 侧栏 📦 历史版本面板：列出当前文档历次保存/自动保存产生的快照（最新在前），点条目预览全文，右下角“↩ 回滚到此版本”一键覆盖（覆盖前会自动另存当前版，回滚可逆）
13. 插件：把 `.js` 文件放进知识库根的 `.notelume-plugins/`，打开知识库后自动加载；侧栏 🔌 插件面板可启用/禁用（记忆）与点击执行插件命令。示例见 `examples/notelume-plugins/hello.js`（注册 Mod-Shift+H 快捷键 + 插入时间命令）
14. 命令面板 `Ctrl+Shift+P`（或 `▾ 更多 → ⌘ 命令面板`）：直接输入即模糊搜文档回车跳转，以 `>` 开头则模糊搜命令回车执行（应用/编辑器/插件命令均在列）。`▾ 更多 → 🎛 快捷键设置…` 可逐条重绑快捷键（录制新键/解绑/重置），撞键会硬阻止保存并提示占用者；改完即时生效并存于 localStorage
15. 画布 / 白板：工具条 🗺 新画布 新建 `.canvas`（或双击画布空白处新建卡片）；拖拽移动 /  shift 多选 / 拖端口连线 / 拖角点缩放 / 双击编辑文字 / 六色色板 / 滚轮缩放 / ⤢ 适应 / 多选对齐（六向 + 等距分布）/ 拖拽磁吸对齐（靠近他卡自动吸附 + 参考线，Alt 禁用）/ 编组解组（拖框边整体移动）/ 撤销重做（Ctrl+Z / Ctrl+Shift+Z）/ 双击连线编辑标签（新连线自带方向箭头）/ 框选（背景+Shift 拖拽）/ 方向键微调（Shift ×10）/ Ctrl+A 全选 / Ctrl+C·V·D 复制粘贴重复 / −＋ 缩放按钮（Ctrl +/-/0）/**右键上下文菜单**（背景/卡片/连线三类，聚合新建·粘贴·对齐·分组·颜色·编组·撤销重做等）/**卡片内 Markdown 渲染**（标题/粗斜体/列表/代码/引用/表格/删除线等，.canvas 仍存原始 markdown、往返无损）/**缩略图 minimap**（右下角全局小地图 + 视口框，点击/拖拽导航，▦ 按钮显隐）；`.canvas` 文件遵循 JSON Canvas 规范，可被 Obsidian 直接打开互操作
16. 表格：光标入单元格后 **Tab / Shift-Tab** 在格间跳转（末行 Tab 自动补一行）；拖动单元格右边线可**调整列宽**（仅预览、不写进 `.md`）；**右键单元格**弹出菜单——上/下方插入行、左/右侧插入列、删除本行/列、单元格左/中/右对齐、切换首行为表头、删除整个表格（GFM 不支持合并单元格，故无 merge/split）
17. 侧栏 🌿 Git 面板（批次 E · 本地基础）：打开知识库后自动探测仓库——顶栏显分支 + 改动计数；「变更」区列 `git status`（点文件看它与 HEAD 的 diff）、「历史」区列 `git log`（点条目看提交详情）；「提交全部」= `git add -A`（尊重 `.gitignore`）+ 带身份 commit（首次无配置身份会问一次姓名/邮箱并记住，写回仓库本地配置）；非仓库文件夹可一键「初始化仓库」（无 `.gitignore` 时补一份排除 `.notelume-backup/`）。`app.git.*`（刷新/提交/初始化）已并入命令面板可搜可执行
18. Git 远程同步（批次 E · R1）：面板「同步」区——未装系统 git 时自动隐藏控件（本地功能不受影响）；有则显 origin 地址，可 `＋ 添加远端` / `改地址`，`⟳ Fetch` 后显「↑ 领先 N · 落后 M」徽标，`↓ Pull（快进）` 执行 `git pull --ff-only`（无分叉时把远端提交快进进本地，成功后自动重扫文件树/重建索引/按脏净态处理当前文档；脏不静默覆盖）。**认证完全交系统 git**（凭据助手 / ssh-agent / GCM），应用不接触也不存任何凭据；**非快进/分叉会明确拒绝并提示「冲突解决属后续版本」，绝不自动 merge/rebase**；`app.git.fetch`/`app.git.pull`/`app.git.remote` 已并入命令面板。**含 Rust，需重启 `tauri dev` 重编生效**
19. Git 远程内置引擎（批次 E · R1-B）：上面 R1 的“依赖系统 git”已另立子项目 R1-B 收回——`git2` 新开 `ssh`+`https` feature，Rust 侧 `RemoteEngine{System, Builtin}` 双后端：**装了 git 继续走 R1 shell-out（凭据 UX 最佳）、没装自动切内置 git2**（一次性进程内探测）。面板徽标行显 🛡 系统 git · 版本 或 📦 内置引擎（hover title 提示凭据模型）；内置下 fetch/pull 靠 ssh-agent / 无口令私钥 / env token（`NOTE_LUME_GIT_TOKEN`/`GITHUB_TOKEN`/`GITLAB_TOKEN`），应用仍不代持凭据。SSH 首次连陌生 host 会弹**一次性信任**（展示指纹、写应用私库 `git-known_hosts`，与 `~/.ssh/known_hosts` 合并命中），同主机下次自动放行；fetch/pull 错误按 `[host_unknown]` / `[non_fast_forward]` / `[local_changes]` / `[hostkey_mismatch]` / `[network]` / `[auth]` 前串分类引导。**含 Rust，需重启 `tauri dev` 重编生效**

---

## 关键快捷键

| 键位                | 作用                             |
| ------------------- | -------------------------------- |
| Ctrl + O            | 打开单个 Markdown 文件           |
| Ctrl + Shift + O    | 打开文件夹作为知识库             |
| Ctrl + S            | 保存当前文档                     |
| Ctrl + B            | 粗体                             |
| Ctrl + I            | 斜体                             |
| Ctrl +\`            | 行内代码                         |
| Ctrl + Shift + X    | 删除线                           |
| Ctrl + Z / Ctrl + Y | 撤销 / 重做                      |
| Shift + Enter       | 硬换行                           |
| Ctrl + F            | 聚焦侧栏全局搜索框               |
| Ctrl + P            | 打印 / 打印为 PDF                |
| Ctrl + Shift + P    | 命令面板（模糊搜命令/文档，回车执行）  |
| Ctrl + M            | 插入行内公式（有选区则包裹）     |
| Ctrl + Shift + M    | 插入块级公式                     |
| Ctrl + G            | 打开/关闭知识图谱（模态）        |
| Tab / Shift + Tab   | 表格单元格间跳转（末行自动补行） |

---

## 设计要点

- **纯 GFM，零私有格式**：所有 md 文件可被 Typora / Obsidian 直接打开，无信息丢失
- **`[[wikilink]]` 与 `#tag` 是行内节点**（非普通文本），通过 markdown-it 自定义 inline 规则识别、ProseMirror 序列化为标准 `[[…]]` / `#xxx`；输入规则让你在编辑器里敲下 `]]` 或紧跟空格的 `#xxx` 即自动生成节点
- **表格、任务列表**：GFM 语义（表头行 + 对齐分隔行 + `- [x]` / `- [ ]`）；单元格允许行内内容，序列化时按列宽对齐输出；表格编辑（增删行列 / Tab 跨格 / 列宽拖拽 / 右键菜单）基于 `prosemirror-tables`
- **Frontmatter（YAML 头）**：文件开头的 `--- … ---` 会被**逐字节原样保留**（解析前剥离、写回前补回），不丢失键顺序 / 注释；侧栏「文档属性」面板可编辑（默认走源码编辑不重排，避免静默把 `date` 等改格式）
- **Rust 后端**只做文件/索引/路径处理，UI 与渲染全在 ProseMirror，职责清晰
- **路径安全**：`ensure_inside_root` + `..` 逃逸拒绝，避免 md 读写越出库根

---

## 已知边界（当前版本）

- 表格已接 `prosemirror-tables`：增删行列 / Tab 跨格跳转 / 右键行列菜单 / 列宽拖拽 / 单元格拖选均可用；但 **GFM 本身不支持合并单元格**（故有意不接 merge/split），且**拖拽列宽不会写进 `.md`**（仅当前视口内生效，重开文件恢复默认宽）
- **Obsidian callout**（`> [!TYPE]`）已渲染为带标题/图标的彩色卡片并与文件往返无损；但卡片**标题/type/折叠标记存于节点属性**（非正文 inline 可编），改标题需改源行；折叠 `-`/`+` 保留但不一键收起（编辑时正文始终可见）
- 图片走字节 → base64 → 落盘路径，**超大图（数十 MB）粘贴**会比文件拖拽慢；下个迭代拖拽会直接用绝对路径拷贝
- **Obsidian 图片嵌入** `![[图片]]` 已渲染为图并与文件往返无损（非图片的 `![[笔记]]` 仍作链接）；当裸文件名按相对路径解析不到时，会**按文件名在库内不区分大小写、先浅后深地回退查找**并取第一个匹配——同名图片多处存在时可能命中非预期那一张；若库内确实找不到该文件，不再只显一个空白框，而是就地显示“🖼 未找到图片：<路径>”提示
- KaTeX 公式双击编辑目前走 `window.prompt`，后续换成内置弹窗
- 搜索为 substring 匹配，未上分词/拼音；索引内容全量存内存，知识库量级至数百 md 文件时无压力，未来可换 fallthru + 磁盘索引
- `assets/` 目前放在每个 md **同目录**（相对链接最稳）；库根级 `assets` 归一化留待后续
- 备份文件写入 `.notelume-backup/`（已默认不入库根扫描）；P2 版本快照 UI 已提供历史列表 / 预览 / 一键回滚
- 插件钩子（P2 v1）：`.notelume-plugins/*.js` 可注册快捷键 / 命令 / 输入规则 / 生命周期回调；暂不支持运行时扩展 schema（registerNodeSpec / MarkSpec），且无沙箱——插件与主线程同权，用户自担风险
- 画布（P2）：已覆盖卡片/连线（含方向箭头 toEnd/fromEnd）/缩放/颜色/文件节点/多选对齐（六向+等距分布）/分组（Obsidian 兼容 `type:group`，拖框连带成员）/撤销重做/边标签编辑/框选/方向键微调/全选/复制粘贴重复/缩放控件/拖拽磁吸对齐；JSON Canvas 其余字段留待后续

---

## Git 工作流约定（本仓库）

- 远端：`https://gitee.com/hackerSnail/note-lume.git`（`origin`）
- 分支：`master`
- 协作规则见 `docs/CLUADE.MD` 末尾：**改动验证通过后直接 commit + push**，无需逐次确认；破坏性操作（`--force` / `--no-verify`）仍需显式同意

---

## License

[Apache License 2.0](http://www.apache.org/licenses/LICENSE-2.0)。完整文本见仓库根目录 [LICENSE](LICENSE)。

Copyright 2026 hackerSnail
