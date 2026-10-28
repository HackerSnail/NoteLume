# NoteLume 功能详表（自 README 迁移）

> 本文件是 [README](../README.md) 的详版：逐项特性状态、首次上手清单、全量快捷键表与已知边界。README 只留概览，细节以本文为准。

一个介于 **Typora** 与 **Obsidian** 之间的 Markdown 知识库编辑器：

* 主编辑体验 = Typora：单文档一体化 WYSIWYG Markdown，点击渲染内容直接编辑，不做左右分屏源码；排版干净，阅读感强。
* 知识库能力 = 精简版 Obsidian：本地文件夹即知识库，双向链接、库内跳转、标签、大纲、搜索内置；知识图谱作为可选附加能力，不默认渲染大图。

> 设计文档与迭代路线见 [`CLAUDE.MD`](CLAUDE.MD)，下一阶段候选与批次排序见 [`ROADMAP.md`](ROADMAP.md)。

---

## 特性状态

### 编辑与排版

* WYSIWYG 编辑：标题、粗斜、删除线、引用、有序/无序列表、任务列表、表格、行内代码、代码块、图片、链接
* Markdown 与 ProseMirror 双向无损往返
* KaTeX 行内与块级数学，往返无损，与 Obsidian / Typora 写法互通
* 代码块语法高亮（highlight.js 视图装饰，不污染文档模型与 markdown）+ 右上角可点语言标签（Typora 式，弹搜索选语言）
* Mermaid 图表：```` ```mermaid ```` 代码块渲染为图，`mermaid` 懒加载，不拖累首屏
* Obsidian callout `> [!NOTE]` 渲染为彩色卡片（自定义块规则 + CSS，与文件互通）
* 表格完整编辑：增删行列、Tab 跨格、列宽拖拽、右键行列菜单（`prosemirror-tables`）
* 编辑器无损扩展（功能项 J）：脚注 `[^n]`（Typora 式上标角标、点角标定位、正文自动收集到文末脚注区可编辑，`markdown-it-footnote` 并入主 tokenizer）+ 合并单元格表格（含 `colspan/rowspan` 的表存真正的 `<table>` HTML 往返，右键菜单接 `mergeCells` / `splitCell`，无合并仍出 GFM）
* 块级裸 HTML 透传（html_block 节点）：外部导出的 md 里整段 `<h2>` / `<figure>` / `<table>` / `<blockquote>` 这类块级 HTML 存成原子块、原样保留，渲染态净化后就地显示（排版吃 `.ProseMirror` 的后代选择器），单击原地切源码编辑、失焦或 Esc 提交、改成全空白即删块（落点在块内图片上是放大查看，不切源码）；块内 `h1`–`h6` 计入大纲，点大纲整块选中并滚动；块内相对路径的图片按当前文档读库内字节显示（与正文图片同口径，远程图透传），站点与单篇 HTML 导出同样渲染，站点侧块内 `<img>` 镜像进 `assets/`，Word 导出降级为纯文本段落
* 图片拖拽 / 粘贴自动落库 `assets/` 并生成相对链接；正文图片右下角把手拖拽缩放，宽度作为节点属性写回 Markdown（Typora `![…](… =328x)` / Obsidian `![[…|328]]`），双击回原尺寸，导出静态站同样带上
* 正文 Markdown 源码双模式：CodeMirror 6，`Ctrl+E` 整篇互切，语法高亮与行号，原文保真、保存不重排
* 编辑器手感包：空行 `/` 弹块类型菜单 + 写作统计（字数 / 阅读时长 / 目标）+ 专注模式 `Ctrl+Shift+\`` + 打字机模式 `Ctrl+Shift+T`
* 内联格式按钮条（`src/format-bar.js`）：每个窗格一条，钉在标签条下方紧贴正文，粗体 / 斜体 / 删除线 / 行内代码 / 链接 / 图片六颗，动作转给本窗格编辑器实例（不新增命令）；按下态跟选区内是否含该 mark 走，标题带当前语言文案与重绑后的键位，空态 / 画布 / 源码态整条藏。给不熟悉 Markdown 语法的人一个可见入口
* 模板新建（`{{date}}` / `{{title}}` 等变量替换，未知 token 保留）+ 今日速记（`Ctrl+Shift+D` 全局浮层，与知识库解绑，自动存到固定目录）
* 浅色 / 暗黑 / Dracula 主题切换 + 类 Typora 阅读排版
* 快捷键 Ctrl+S / Ctrl+O / Ctrl+N / Ctrl+B / Ctrl+I，全文键位见下方「关键快捷键」
* 标签页：打开中的文档一横条列在工具条下方，点标签 / 中键关闭 / Ctrl+Tab 循环切换；非活动页按构造是干净的（离开时已保存或放弃）
* 新建先落到系统临时目录（`<temp>/NoteLume/scratch`），Ctrl+S 或关闭时再选正式位置，不要求先开知识库

### 知识库与检索

* 打开本地文件夹作为知识库；文件树右键新建 / 重命名·移动 / 删除（移入系统回收站，可恢复）+ 树内拖拽移动 + 外部拖入（桌面版为「拖入即打开」，网页版为「拖入即导入」）
* 单独打开一个 md 文件（所在目录作为工作根，可正常保存）
* `[[wikilink]]`：识别、点击跳转、目标不存在时提示新建；`[[` 输入弹全库文档名模糊下拉
* Obsidian 图片嵌入 `![[图片]]` 渲染为图（裸名按库内文件名回退查找，与 `![[笔记]]` 链接共存，往返无损）
* 文件树图片附件单独查看：PNG / JPG 等点击全屏放大 / 缩放，读字节 data URL，只读不进编辑器
* 文档大纲面板（点击跳转），层级折叠（大标题常显、子级整节可收）
* `#tag` 识别并在侧栏展示；`#` 输入弹已有标签补全；标签全局视图（全库标签 + 计数，点标签列出含该标签文档）
* 双向链接面板（引用本文件 + 本文件引用），Rust 后台索引 + 增量更新
* 全局搜索（标题 / 正文 / 标签），侧栏内实时回显匹配片段
* `[[链接]]` hover 悬浮预览（卡片展示目标文档标题 + 摘要）
* 自动保存 + 库内备份（停手 2s 写回；每 2 分钟副本到 `.notelume-backup/日期/`）
* 版本快照面板：历史备份列表、全文预览、一键回滚
* 简易知识图谱（Canvas 力导向，无外部依赖）
* 画布 / 白板：JSON Canvas 规范，与 Obsidian `.canvas` 互操作
* 打开最近文件（「更多」→「最近打开」，跨库全局记录、一键重开并回灌目录上下文）
* 命令面板（`Ctrl+Shift+P`：模糊搜命令 / 文档、回车执行）+ 快捷键自定义（应用 / 编辑器 / 插件命令可重绑、冲突硬阻止、localStorage 持久化），收敛为统一命令注册表

### 界面与桌面集成

* 侧栏「文件 / 大纲」两 tab 共用一块区域 + 栏外常驻图标（文件 / 大纲 / 检查器）
* 右侧检查器栏：文档属性 / 标签 / 双向链接 / 历史版本 / Git / 插件集中于此，左栏只留文件与大纲（`Ctrl+Shift+B`）
* 左右栏按住分隔条拖拽调宽：`180–520px`、记忆宽度、拖到边整栏收起（反向再拖回来）、双击回默认
* macOS 原生菜单栏（应用 / 文件 / 编辑 / 格式 / 段落 / 视图 / 窗口，全中文含系统注入项；应用组含快捷键设置 / 外观设置 / 网页剪藏设置 / 界面语言，「段落」组按当前块类型勾选 + 标题升 / 降级），窗口内工具条沉底为状态条；Windows 工具条原样保留

### 导出与同步

* 导出 HTML（系统保存对话框）+ 打印 / PDF（无默认键，走「更多」菜单或自行重绑）
* 整库导出 HTML 静态站（「更多」→「导出整站…」）：全保真渲染 + wikilink / 图片重写 + 侧栏树 / 反链 / 首页 / 纯前端搜索，本地双击即浏览的「本地维基」
* Word(.docx) → Markdown 离线导入（功能项 I，「更多」→「导入 Word(.docx)…」，或拖 `.docx` 到文件树）：纯 Rust `zip` + `roxmltree` 直读 OOXML（零外部二进制、不联网络）保真映射为 Markdown（标题 / 列表 / 粗斜下删 / 超链接 / 表格 / 合并表转 `<table>` / 脚注转 `[^n]` / 图片提取），逐个可视化校对（左只读渲染预览、右源码可编辑、顶部 warnings 列出降级项），接受才落库；图片按 sha256 全库去重、命中不重存仅引用。依赖功能项 J；含 Rust，须重启生效
* 本地 Git 集成（侧栏 Git 面板）：仓库探测 / status 改动 / log 历史 / 单文件 diff 预览 / 一键提交 / 初始化，`git2` 内置无外部 git 依赖
* Git 远程同步·快进 Pull：「同步」区（远端增改、`Fetch`、领先落后、`Pull（快进）`）；认证复用系统凭据助手 / ssh-agent / GCM，应用零凭据存储
* Git 远程内置引擎（R1-B）：免装系统 git 也能 fetch / pull。`git2` 新开 `ssh` + `https` feature，Windows MSVC 下 libgit2 走 Schannel、libssh2 走 win32-crypto，零 openssl。凭据不存不弹：SSH 先试 ssh-agent 再到无口令私钥，HTTPS 先试环境变量 token。SSH 首次陌生 host 走一次性信任，写应用私库 `git-known_hosts`。面板顶部徽标为图标 + 文案（terminal 图标「系统 git」+ 版本 / box 图标「内置引擎」）；装了 git 优先走 shell-out，没装自动切内置
* Git push（R2）：当前分支推 upstream 同名分支，固定 refspec、不自动 force；无 upstream 明确引导、不自动先 pull
* Git 合并拉取 + 冲突解决（R3）：`Pull（合并）`（非 ff-only）；冲突文件在「变更」列表逐行列出，每个可选「用本地 / 用远端 / 编辑」；顶部合并工具条「提交合并」/「中止合并」（check / close 图标）；不代持凭据、不自动 force

### 插件

* 插件钩子系统（快捷键 / 命令 / 输入规则 / 生命周期）
* 插件系统 v2·F1：文件夹化插件包 `.notelume-plugins/<id>/{manifest.json, main.js}` + 声明式清单校验 + 首载「一律弹」权限同意软闸门。基线能力（命令 / 快捷键 / 输入规则 / 生命周期）不算权限，只管额外可达面 `network` / `fs-vault` / `fs-outside` / `git` / `schema` / `persistent-store`。破坏性：不再识别平铺 `.js`，仅面板提示迁移。不改 ctx、不做技术拦截，那部分属 F3

### 规划中

* 移动端（见 `docs/ROADMAP.md` 批次 G）

---

## 技术栈

* 桌面外壳：Tauri v2 + Rust stable
* 编辑器：Vanilla JS + ProseMirror + prosemirror-markdown
* 前端构建：Vite（打包器，不引入 Vue / React 等框架）
* 存储：完全基于本地文件夹 + `.md` 文件，标准 GFM，兼容 Typora / Obsidian，无数据库
* 平台：Windows 优先（WebView2 + MSVC），macOS / Linux 同架构可跑

---

## 目录结构

```
NoteLume/
├── docs/CLUADE.MD          # 设计与迭代文档（本 README 的上级规格）
├── docs/ROADMAP.md         # 下一阶段候选与批次排序
├── src-tauri/              # Rust 后端（Tauri v2）
│   ├── Cargo.toml
│   ├── build.rs
│   ├── capabilities/       # 权限清单（core + dialog）
│   ├── icons/              # 应用图标（tauri icon 生成）
│   ├── tauri.conf.json
│   └── src/
│       ├── main.rs         # 入口（薄壳）
│       ├── lib.rs          # 59 个 #[tauri::command]：扫描/读写/wikilink/assets +
│       │                   # 后台索引 · 双向链接 · 全局搜索 · 悬浮预览 · 备份 · 导出 ·
│       │                   # 整站图/资源拷贝 · 图谱 · 快照 · 插件 · 本地与远程 Git · docx 导入
│       ├── git_builtin.rs  # 远程 Git 双后端（系统 git shell-out / 内置 git2）
│       └── docx_import.rs  # OOXML 直读转 Markdown + 图片提取去重
├── src/                    # 前端 Web 工程（Vite 根，43 个模块）
│   ├── index.html
│   ├── main.js             # 应用装配：面板 / 快捷键 / 自动保存 / 导出 / 索引轮询
│   ├── icons.js            # 内联 SVG 图标 sprite（界面零表情包）
│   ├── app-menu.js         # macOS 原生菜单栏装配
│   ├── editor-schema.js    # ProseMirror 扩展 schema + MD 双向转换（含 KaTeX，纯逻辑可 Node 单测）
│   ├── editor-view.js      # WYSIWYG 编辑器装配：插件、快捷键、输入规则、图片拖粘
│   ├── block-commands.js   # 块类型命令（标题 / 列表 / 引用 / 代码块…）纯逻辑
│   ├── fold-plugin.js      # 大纲档位与整节折叠
│   ├── outline-tree.js     # 侧栏大纲树层级纯逻辑
│   ├── footnotes.js        # 功能项 J：脚注收集与定位
│   ├── table-editing.js    # 表格编辑 + 合并 / 拆分单元格
│   ├── hl-decorations.js   # 代码块语法高亮（视图层 Decoration）
│   ├── code-lang-picker.js # 代码块语言标签弹搜索
│   ├── mermaid-preview.js  # Mermaid 渲染（懒加载）
│   ├── math-nodeviews.js   # KaTeX NodeView（行内 / 块级，双击编辑）
│   ├── wiki-hover.js       # [[链接]] 悬浮预览卡片
│   ├── suggest-plugin.js   # [[ 与 # 输入补全下拉
│   ├── slash-menu.js       # 空行 `/` 弹块类型菜单
│   ├── frontmatter.js      # YAML 头逐字节保真剥离 / 补回
│   ├── frontmatter-panel.js# 「文档属性」编辑
│   ├── source-editor.js    # 正文源码模式（CodeMirror 6，CM / @lezer 全懒加载）
│   ├── source-sync.js      # 进源码展示原文 vs 序列化的纯判定
│   ├── editor-modes.js     # 专注模式 + 打字机模式
│   ├── writing-stats.js    # 写作统计（字数 / 阅读时长，纯函数，中英日混排口径）
│   ├── template.js         # 模板变量替换 + 日期格式化（纯函数）
│   ├── daily-capture.js    # 全局「今日速记」浮层
│   ├── commands.js         # 统一命令注册表（app / editor / plugin 共用）
│   ├── keymap.js           # 快捷键纯逻辑（规范化 / 合成 / 冲突检出 / 模糊匹配）
│   ├── tabs.js             # 标签页：打开中的文档列表 + 标签条渲染 / 切换 / 关闭
│   ├── command-palette.js  # Ctrl+Shift+P 命令面板
│   ├── shortcut-settings.js# 快捷键设置（录制 / 解绑 / 重置 / 冲突阻止）
│   ├── graph-view.js       # 知识图谱（Canvas 2D 力导向）
│   ├── canvas-view.js      # 画布 / 白板：JSON Canvas 渲染 / 拖拽连线缩放 / 双击编辑
│   ├── snapshot-panel.js   # 版本快照：历史列表 / 预览 / 回滚
│   ├── git-panel.js        # 本地 + 远程 Git：探测 / status / log / diff / 提交 / 初始化 +「同步」区（引擎徽标 / 远端增改 / fetch / 领先落后 / 快进 pull / push / 合并 pull / 冲突解决 / 一次性 SSH host 信任）
│   ├── plugin-loader.js    # 插件：文件夹化包加载编排 / 权限同意 / 快捷键注入 / 生命周期总线 / 面板
│   ├── plugin-manifest.js  # 纯逻辑：manifest 解析校验 + 权限同意决策（可 Node 单测）
│   ├── plugin-consent-dialog.js # 插件权限同意模态（多插件合并一次、全有 / 全无）
│   ├── docx-import.js      # 功能项 I：docx 导入编排与批量队列状态机
│   ├── docx-review.js      # docx 校对模态（只读预览 + 源码编辑 + warnings）
│   ├── site-export.js      # 整站导出：渲染 / 链接重写 / 导航 / 反链 / 搜索（Tauri I/O 依赖注入）
│   ├── img-viewer.js       # 附件全屏查看器
│   ├── prompt-dialog.js / confirm3-dialog.js # 应用内输入与三态确认
│   ├── tauri-bridge.js     # Rust invoke 封装 + 系统对话框
│   ├── style.css           # 类 Typora 排版 + 浅 / 暗 / Dracula 主题 + 面板样式
│   ├── vite.config.js
│   ├── package.json
│   └── tests/              # 14 个 Node 离线单测（roundtrip / keymap / footnotes / merged-table / docx-import / plugin-manifest / outline-tree / …）
└── package.json            # 根脚本：代理到 src/ 里本地安装的 @tauri-apps/cli
```

---

## 环境准备

NoteLume 基于 Tauri v2（Rust 后端 + Web 前端），需要以下工具链：

| 依赖          | 最低版本  | 安装方式                                                                                                                |
| ----------- | ----- | ------------------------------------------------------------------------------------------------------------------- |
| Rust        | 1.80+ | `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \| sh -s -- -y`（安装后执行 `. "$HOME/.cargo/env"` 加载环境，或重开终端） |
| Node.js     | 18+   | `brew install node`（或官网下载）                                                                                          |
| WebView 运行时 | 无     | macOS 自带 WKWebView，无需额外安装                                                                                           |
| 系统构建工具      | 无     | `xcode-select --install`（命令行开发者工具，提供 clang / make / pkg-config）                                                     |

> macOS 可选：用 Homebrew 一键装齐（若未安装 Homebrew，先跑 `/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"`）：
>
> ```bash
> brew install node rust
> xcode-select --install
> ```

### 自检

全部装好后，在仓库根目录跑：

```bash
npm run tauri -- info
```

Tauri 会输出检测到的系统 / Rust / Node / WebView 信息，没有报错即环境就绪。

---

## 开发启动

```bash
# 1) 安装前端依赖（含本地 @tauri-apps/cli）
cd src
npm install
cd ..

# 2) 从仓库根启动 Tauri 开发模式（beforeDevCommand 会自动跑 vite dev server）
npm run dev
```

首次启动会编译 400+ Rust crate，mac 上大概 5 至 10 分钟；之后改代码自动增量编译，秒级热重载。改动含 Rust 时需重启 `tauri dev` 重编生效。

> 若提示 `rustc: command not found`，说明 Rust 的 PATH 没加载。执行：
>
> ```bash
> . "$HOME/.cargo/env"
> ```
>
> 或在 `~/.zshrc`（zsh）/ `~/.bash_profile`（bash）里加一行 `export PATH="$HOME/.cargo/bin:$PATH"`。

---

## 回归测试（可选，无需浏览器）

```bash
npm run test:roundtrip
```

对「解析 → 序列化 → 再解析 → 再序列化」做幂等校验，64 项断言，覆盖：标题 / 行内混排 / 引用与列表 / 任务列表 / 代码块 / 图片 / `[[wikilink]]` / `#tag` / 表格 / 行内公式 / 块公式 / 组合 / Obsidian 图片嵌入 / 图片尺寸写回。

`src/tests/` 共 40 个离线单测文件（keymap、footnote、merged-table、html-block、html-sanitize、docx-import、docx-export、plugin-manifest、outline-tree、fold、block-commands、site-export、source-sync、template、writing-stats、app-menu 等），逐个 `node src/tests/<name>.test.mjs` 跑、按退出码判定；根 `package.json` 只为 roundtrip / footnote / merged-table 三条留了转发入口，`src/package.json` 另有 29 条单文件入口，没有全量聚合脚本。

---

## 生产打包

```bash
npm run build
```

### 产物位置

macOS（分两个型号：Apple Silicon 的 `_aarch64` 卷与 Intel 的 `_x64` 卷。本机 `npm run build` 只出当前芯片那一份，另一份由 CI 在对应架构的 runner 上打）：

```
src-tauri/target/release/bundle/
├── macos/NoteLume.app               # 可直接双击运行的应用 (≈14.5 MB)
├── dmg/NoteLume_0.2.0_aarch64.dmg   # DMG 安装包，拖入 Applications 即可 (≈6 MB)
```

打包完成后 macOS 会弹出权限请求，允许 VS Code 控制「访达」：

![授权-访达权限](./img/%E6%8E%88%E6%9D%83-%E8%AE%BF%E8%BE%BE%E6%9D%83%E9%99%90.png)

允许后系统自动弹出 Finder 窗口，把 NoteLume.app 拖进 Applications 即完成安装：

![拖入-应用程序](./img/%E6%8B%96%E5%85%A5-%E5%BA%94%E7%94%A8%E7%A8%8B%E5%BA%8F.png)

> 首次 release 编译会比 dev 更慢（需要 LTO 优化），大约 7 至 10 分钟；之后增量编译只重编改动文件。

---

## 首次上手清单

 1. **打开文件 / 知识库**：工具条左上角前两个图标（悬停有文字提示）分别是「打开文件」（Ctrl+O，直接编辑单个 md）与「打开知识库」（Ctrl+Shift+O，选一个本地文件夹作为库根）
 2. **文件树**：点击 `.md` 文件加载，直接编辑，Ctrl+S 写回原文件；或勾选右上角「自动保存」，停手 2s 自动写盘 + 每 2 分钟一份时间戳副本
    * 右键树条目弹菜单：文件（打开 / 重命名·移动 / 删除）、文件夹（新建文件 / 新建文件夹 / 重命名·移动）、空白区（在库根新建）
    * 重命名与新建用应用内输入框；删除会弹确认并把文件移入系统回收站，可恢复，并同步从索引 / 双向链接中移除
    * 树内拖拽：把文件或文件夹拖到目标文件夹即移动。从系统拖入分两条通道：桌面版是「拖入即打开」——拖入 `.md` / `.canvas` / 图片即在当前窗口打开这一篇，拖入文件夹则另开一个窗口把该文件夹作为知识库打开，当前窗口的库不变；网页版仍走文件树导入，拖入 `.md` / `.canvas` / 图片 / `.docx` 即写入库内
    * 点树中的图片附件（如 `Pasted image *.PNG`）弹出全屏查看器：适应窗口 / `−`·`＋` 缩放 / 1:1 / 滚轮缩放 / 双击切换，Esc 或点空白关闭；图片只读，不打断底下正打开的笔记
 3. **`[[wikilink]]`**：正文输入 `[[` 弹全库文档名模糊下拉（↑↓ 移动、Enter / Tab 选中、Esc 关，选中直接成链接）；也可手敲 `[[文档名]]`，敲完右中括号自动变可点击链接；hover 弹目标文档预览，点击时目标不存在会提示新建
 4. **标签**：输入 `#` 弹已有标签补全下拉；也可手敲 `#标签 `（末尾空格触发）变成标签 chip，检查器「标签」列出当前文档全部标签，点 chip 直接归入全局搜索。面板下方「全局标签」区列出全库标签及出现次数，点标签展开含该标签的文档、点文档直接跳转
 5. **图片入库**：拖一张图片到编辑区，或剪贴板 Ctrl+V 粘贴图片，自动拷贝到同目录的 `assets/`，正文以 `![](./assets/xxx.png)` 相对路径写入
 6. **大纲与双向链接**：左栏「大纲」按标题层级列出（大标题常显、子级整节可收），点击跳转；检查器「双向链接」展示「引用本文档」+「本文档引用」
 7. **全局搜索**：侧栏顶部搜索框（Ctrl+Shift+F 聚焦）在索引内匹配标题 / 正文 / 标签，带片段回显
 8. **代码块与公式**：代码块自动高亮（预置 37 种常用语言），点右上角语言标签可搜索换语言；行内公式写 `$x^2$`，敲完尾 `$` 自动射为公式；块级公式用 `$$` 独占一行 + 内容 + `$$` 独占一行，或按 Ctrl+M / Ctrl+Shift+M 插入占位；双击公式可编辑
 9. **导出**：「更多」→「导出为 HTML」把当前文档导出为自含样式的 HTML（系统保存对话框选目录）；「导出整站…」选一个输出目录，把整库渲染为本地静态站（侧栏导航 / 反链 / 首页 / 搜索）；「打印 / 另存 PDF」走系统打印对话框
10. **主题**：右上角主题按钮显示当前主题名，点击循环切换 浅色 → 暗黑 → Dracula（记忆在 localStorage）
11. **知识图谱**：「更多」→「打开知识图谱」（或 Ctrl+G）打开模态；拖平移、滚轮缩放、拖节点重定位、点节点跳文档，当前文档红点高亮
12. **历史版本**：检查器「历史版本」列出当前文档历次保存 / 自动保存产生的快照（最新在前），点条目预览全文，「回滚到此版本」一键覆盖（覆盖前自动另存当前版，回滚可逆）
13. **插件**：把插件文件夹 `<id>/`（含 `manifest.json` + `main.js`）放进知识库根的 `.notelume-plugins/`，打开知识库后自动识别
    * 首次加载会弹出「插件权限同意」，列出该插件所需权限，同意后才运行；面板内可「重设权限」再次征求
    * 检查器「插件」可启用 / 禁用（记忆）、查看权限、点击执行插件命令
    * 旧版平铺 `.js` 不再识别，面板会提示迁移。示例见 `examples/notelume-plugins/hello/`（注册 Mod-Shift+H 快捷键 + 插入时间命令）
14. **命令面板与快捷键**：`Ctrl+Shift+P`（或「更多」→「命令面板」）直接输入即模糊搜文档回车跳转，以 `>` 开头则模糊搜命令回车执行（应用 / 编辑器 / 插件命令均在列）。「更多」→「快捷键设置…」可逐条重绑（录制新键 / 解绑 / 重置），撞键会硬阻止保存并提示占用者，改完即时生效并存于 localStorage
15. **画布 / 白板**：「更多」→「新画布 / 白板」新建 `.canvas`，或双击画布空白处新建卡片
    * 拖拽移动 / Shift 多选 / 拖端口连线 / 拖角点缩放 / 双击编辑文字 / 六色色板 / 滚轮缩放 / 适应视图
    * 多选对齐（六向 + 等距分布）/ 拖拽磁吸对齐（靠近他卡自动吸附 + 参考线，Alt 禁用）/ 编组解组（拖框边整体移动）
    * 撤销重做（Ctrl+Z / Ctrl+Shift+Z）/ 双击连线编辑标签（新连线自带方向箭头）/ 框选（背景 + Shift 拖拽）/ 方向键微调（Shift ×10）/ Ctrl+A 全选 / Ctrl+C·V·D 复制粘贴重复 / 缩放按钮（Ctrl +/-/0）
    * 右键上下文菜单（背景 / 卡片 / 连线三类，聚合新建·粘贴·对齐·分组·颜色·编组·撤销重做等）
    * 卡片内 Markdown 渲染（标题 / 粗斜体 / 列表 / 代码 / 引用 / 表格 / 删除线等），`.canvas` 仍存原始 markdown、往返无损
    * 缩略图 minimap（右下角全局小地图 + 视口框，点击 / 拖拽导航，可显隐）
    * `.canvas` 遵循 JSON Canvas 规范，可被 Obsidian 直接打开互操作
16. **表格与脚注**：光标入单元格后 Tab / Shift-Tab 在格间跳转（末行 Tab 自动补一行）；拖动单元格右边线调列宽（仅预览、不写进 `.md`）；右键单元格弹出菜单：上 / 下方插入行、左 / 右侧插入列、删除本行 / 列、单元格左 / 中 / 右对齐、切换首行为表头、删除整个表格
    * 选区跨越 2 个及以上单元格时右键出现「合并单元格」，合并态格显「拆分单元格」；含 `colspan/rowspan` 的表存为真正的 `<table>` HTML 往返，无合并的仍出 GFM
    * 脚注 `[^n]` 用「更多」或命令面板 `editor.footnote` 插入（无默认键），点正文上标角标定位，文末脚注区可编辑
17. **Git 本地**（批次 E · L）：打开知识库后自动探测仓库，侧栏 Git 面板顶栏显分支 + 改动计数
    * 「变更」列 `git status`（点文件看它与 HEAD 的 diff）、「历史」列 `git log`（点条目看提交详情）
    * 「提交全部」= `git add -A`（尊重 `.gitignore`）+ 带身份 commit；首次无配置身份会问一次姓名 / 邮箱并记住，写回仓库本地配置
    * 非仓库文件夹可一键「初始化仓库」（无 `.gitignore` 时补一份排除 `.notelume-backup/`）
    * `app.git.*`（刷新 / 提交 / 初始化）已并入命令面板
18. **Git 远程·快进 pull**（批次 E · R1）：面板「同步」区显 origin 地址，可「添加远端」/「改地址」，`Fetch` 后显「领先 N · 落后 M」徽标，`Pull（快进）` 执行 `git pull --ff-only`（无分叉时把远端提交快进进本地，成功后自动重扫文件树 / 重建索引 / 按脏净态处理当前文档，脏不静默覆盖）
    * 认证完全交系统 git（凭据助手 / ssh-agent / GCM），应用不接触也不存任何凭据
    * 非快进 / 分叉会明确拒绝并引导改走合并拉取，绝不自动 merge / rebase
    * `app.git.fetch` / `app.git.pull` / `app.git.remote` 已并入命令面板
19. **Git 内置引擎**（批次 E · R1-B）：没装系统 git 也能 fetch / pull。Rust 侧 `RemoteEngine{System, Builtin}` 双后端，装了 git 继续走 shell-out（凭据 UX 最佳）、没装自动切内置 git2（进程内一次性探测）
    * 面板徽标行为图标 + 文案：terminal 图标「系统 git」+ 版本，或 box 图标「内置引擎」（hover title 提示凭据模型）
    * 内置下 fetch / pull 靠 ssh-agent / 无口令私钥 / 环境变量 token（`NOTE_LUME_GIT_TOKEN` / `GITHUB_TOKEN` / `GITLAB_TOKEN`），应用仍不代持凭据
    * SSH 首次连陌生 host 会弹一次性信任（展示指纹、写应用私库 `git-known_hosts`，与 `~/.ssh/known_hosts` 合并命中），同主机下次自动放行
    * fetch / pull 错误按 `[host_unknown]` / `[non_fast_forward]` / `[local_changes]` / `[hostkey_mismatch]` / `[network]` / `[auth]` 前串分类引导
20. **Git push**（批次 E · R2）：「同步」区的 `Push` 把当前分支推到 upstream 同名分支；双后端同一个 `git_r_push` dispatcher
    * 无 upstream 回 `[no_upstream]` 引导（不自动设，避免默默创远程新分支）；非快进回 `[non_fast_forward]` 提示先拉（不自动先 pull）；host 陌生走一次性信任后原地重试
    * `app.git.push`（无默认键）已入命令面板
21. **Git 合并拉取 + 冲突解决**（批次 E · R3）：「同步」区的 `Pull（合并）`（非 ff-only），ff-pull 被拒时会引导改走合并拉取；命令面板 `app.git.pullMerge`
    * 合并后若冲突，冲突文件在「变更」列表逐行以 `C` 标列出，每行给「用本地 / 用远端 / 编辑」：前者直接选 ours / theirs 边 stage，后者经编辑器打开带 `<<<<<<<` 标记的文件手改保存
    * 顶部合并工具条「提交合并」（check 图标，生成带两父的 merge commit）/「中止合并」（close 图标，回到合并前）
22. **Word(.docx) 导入**（功能项 I）：「更多」→「导入 Word(.docx)…」选一个或多个 `.docx`，也可从系统拖 `.docx` 到文件树。不要求先开知识库：选完文件即直接解析进校对模态，落不落盘、落到哪由你决定
    * 已开库时按钮为「接受并落库」，落到当前文档所在夹否则库根，走去重索引、自动刷树
    * 未开库时按钮为「接受并保存…」，点了才弹目录选择器选保存位置（取消即这篇不保存），每篇自包含落盘（图片必写、不进库级索引），完成后回显每个文件的完整保存路径
    * 校对模态：左侧只读渲染预览（脚注 / 合并表所见即所得、图片 data URL 内联）、右侧 Markdown 源码可编辑、顶部列出 warnings（合并表 / 上下标 / 文本框等降级项）；可改标题重命名，「跳过此文档」不写
    * 图片按 sha256 全库去重（命中已有则引用、不重复存储，索引存 localStorage）；产物的脚注 / 合并表在编辑器（功能项 J）打开不坏

---

## 关键快捷键

mac 上 `Ctrl` 即 `⌘`。键位按 Typora / Obsidian 主流习惯配，全部可在「更多」→「快捷键设置…」里重绑（冲突会硬阻止保存）。

文件与导航：

| 键位                  | 作用                      |
| ------------------- | ----------------------- |
| Ctrl + N            | 新建文件（先建到系统临时目录，不要求开库） |
| Ctrl + O            | 打开单个 Markdown 文件        |
| Ctrl + Shift + O    | 打开文件夹作为知识库              |
| Ctrl + Tab / Ctrl + Shift + Tab | 切换下一个 / 上一个标签页       |
| Ctrl + W            | 关闭当前标签页（只剩一页时回到无文档态）  |
| F2                  | 重命名当前文件（可顺带移动）         |
| Ctrl + S            | 保存当前文档（临时文件 = 另存为，选正式位置） |
| Ctrl + P            | 打印 / 另存 PDF             |
| Ctrl + Shift + P    | 命令面板（模糊搜命令 / 文档，回车执行）   |
| Ctrl + E            | 正文与 Markdown 源码整篇互切（编辑 / 预览） |
| Ctrl + F            | 在本篇文档中查找（所见即所得）        |
| Ctrl + H            | 在本篇文档中查找并替换             |
| Ctrl + Shift + F    | 聚焦侧栏全局搜索框               |
| Ctrl + Shift + V    | 粘贴为纯文本（去掉格式插入）         |
| Ctrl + Shift + I    | 插入图片（选图后自动入库 `assets/`） |
| Ctrl + K            | 插入 / 编辑链接（弹窗问 URL；地址留空 = 解除链接） |

格式与段落：

| 键位                  | 作用                      |
| ------------------- | ----------------------- |
| Ctrl + B / Ctrl + I | 粗体 / 斜体                 |
| Ctrl + \`           | 行内代码                    |
| Ctrl + Shift + K    | 代码块                     |
| Ctrl + Shift + X    | 删除线                     |
| Ctrl + 1 ~ 6        | 设为一级 ~ 六级标题            |
| Ctrl + ] / Ctrl + [ | 提升 / 降低标题级别             |
| Ctrl + Shift + Q    | 引用块                     |
| Ctrl + Shift + L    | 任务列表                   |
| Ctrl + Shift + [ / ] | 无序 / 有序列表              |
| Ctrl + T            | 插入表格                    |
| Ctrl + D            | 删除当前行 / 段落              |
| Ctrl + M            | 插入行内公式（有选区则包裹）          |
| Ctrl + Shift + M    | 插入块级公式                  |
| Ctrl + Z / Ctrl + Y | 撤销 / 重做                 |
| Shift + Enter       | 硬换行                     |
| Tab / Shift + Tab   | 表格单元格间跳转（末行自动补行）        |

视图：

| 键位                  | 作用                      |
| ------------------- | ----------------------- |
| Ctrl + G            | 打开 / 关闭知识图谱（模态）         |
| Ctrl + Shift + D    | 今日速记（全局浮层，独立于知识库）       |
| Ctrl + Shift + \`   | 专注模式（当前块高亮）             |
| Ctrl + Shift + T    | 打字机模式（当前块居中）            |
| Ctrl + Shift + S    | 隐藏 / 显示侧栏（也可拖分隔条或点栏外图标） |
| Ctrl + Shift + B    | 隐藏 / 显示右侧检查器栏           |
| Ctrl + Shift + H    | 折叠 / 展开当前节              |

---

## 设计要点

* 纯 GFM，零私有格式：所有 md 文件可被 Typora / Obsidian 直接打开，无信息丢失
* `[[wikilink]]` 与 `#tag` 是行内节点（非普通文本），通过 markdown-it 自定义 inline 规则识别、ProseMirror 序列化为标准 `[[…]]` / `#xxx`；输入规则让编辑器里敲下 `]]` 或紧跟空格的 `#xxx` 即自动生成节点
* 表格与任务列表走 GFM 语义（表头行 + 对齐分隔行 + `- [x]` / `- [ ]`）；单元格允许行内内容，序列化时按列宽对齐输出；表格编辑（增删行列 / Tab 跨格 / 列宽拖拽 / 右键菜单）基于 `prosemirror-tables`
* 块级裸 HTML 的块边界交回 markdown-it 判定（解析那一趟临时把 `options.html` 置 true，取 `html_block` token 的 `map`，随后复位），只接管顶格块且起始标签过白名单，不收类型 7——`<a id="x"></a>` 与 `<mark data-color=…>` 独占一行时仍归自定义行内规则 anchor / highlight；净化走「DOMParser 解析 + 白名单重拼字符串」，不用 `innerHTML = tree.innerHTML`（那条路有 mXSS 差异），编辑器 / 站点 / 单篇导出共用一份白名单
* Frontmatter（YAML 头）：文件开头的 `--- … ---` 逐字节原样保留（解析前剥离、写回前补回），不丢失键顺序与注释；检查器「文档属性」可编辑，默认走源码编辑不重排，避免静默把 `date` 等改格式
* Rust 后端只做文件 / 索引 / 路径处理，UI 与渲染全在 ProseMirror，职责清晰
* 路径安全：`ensure_inside_root` + `..` 逃逸拒绝，避免 md 读写越出库根

---

## 已知边界（当前版本）

* 表格已接 `prosemirror-tables`：增删行列、Tab 跨格跳转、右键行列菜单、列宽拖拽、单元格拖选均可用；合并单元格以 `<table>` HTML 承载（GFM 表达不了，故无合并的表仍写回 GFM），拖拽列宽不会写进 `.md`（仅当前视口内生效，重开文件恢复默认宽）
* Obsidian callout（`> [!TYPE]`）已渲染为带标题 / 图标的彩色卡片并与文件往返无损；但卡片标题 / type / 折叠标记存于节点属性（非正文 inline 可编），改标题需改源行；折叠 `-` / `+` 保留但不一键收起（编辑时正文始终可见）
* 图片走字节 → base64 → 落盘路径，超大图（数十 MB）粘贴会比文件拖拽慢
* Obsidian 图片嵌入 `![[图片]]` 已渲染为图并与文件往返无损（非图片的 `![[笔记]]` 仍作链接）；裸文件名按相对路径解析不到时，会按文件名在库内不区分大小写、先浅后深地回退查找并取第一个匹配，同名图片多处存在时可能命中非预期那一张；库内确实找不到该文件时不显空白框，而是就地显示「未找到图片：<路径>」提示
* 块级裸 HTML 只处理块级（顶格起始）：段落里混排的行内字面 HTML（`<span style=…>` 之类）仍按转义文本显示；WordPress 专属 class（`has-text-align-center` / `has-vivid-red-color` / 字号类）不映射，只吃通用排版；块内图片不支持右下角把手拖拽缩放（无损写回只服务真 image 节点），`html_block` 内的链接点击不跟随；字数与阅读时长不计块内文字（atom 无 textContent，与图片 / 公式同口径），查找替换也不穿透源码；整块被白名单挡光时，纯注释块整体不显示（与 Typora 一致），纯 `<script>` / `<style>` 退回显示源码原文
* 保存正文时两处空白会被规整：frontmatter 与正文之间的空行、文件末尾的空行。WordPress 导出的 md 首次保存因此少这两行，块与块之间的空行原样保留，标记与属性一字不动
* KaTeX 公式双击编辑目前走 `window.prompt`，后续换成内置弹窗
* 搜索为 substring 匹配，未上分词 / 拼音；索引内容全量存内存，知识库量级至数百 md 文件时无压力
* `assets/` 目前放在每个 md 同目录（相对链接最稳）；库根级 `assets` 归一化留待后续
* 备份文件写入 `.notelume-backup/`（默认不入库根扫描）；版本快照面板已提供历史列表 / 预览 / 一键回滚
* 插件系统（P2 v1 → 批次 F1）：已改为文件夹化安装包 + 声明式权限清单 + 首载「一律弹」权限同意（软闸门）。主线程插件与宿主同权，不做技术拦截（用户自担风险），技术隔离属后续 F3。注册命令 / 快捷键 / 输入规则 / 生命周期为基线能力、不算权限；暂不支持运行时扩展 schema（`registerNodeSpec` / `MarkSpec`，属 F2）；平铺 `.js` 不再识别
* 画布（P2）：已覆盖卡片 / 连线（含方向箭头 toEnd / fromEnd）/ 缩放 / 颜色 / 文件节点 / 多选对齐（六向 + 等距分布）/ 分组（Obsidian 兼容 `type:group`，拖框连带成员）/ 撤销重做 / 边标签编辑 / 框选 / 方向键微调 / 全选 / 复制粘贴重复 / 缩放控件 / 拖拽磁吸对齐；JSON Canvas 其余字段留待后续
* 图片尺寸只存宽：只接 Typora 的 `![alt](src =328x)` 与 Obsidian 的 `![[src|328]]`，`=328x200`（高宽比写死）、`=50%`（相对容器宽）与尖括号目的地 `![a](<b c.png> =328x)` 一律不识别，原样保留为文本（往返幂等，不会改坏路径）；高度按图片自然比例自适应，不做裁剪
* 栏宽（侧栏 / 检查器）属于本地视图状态，存 `localStorage` 而不写进文件，换设备打开同一份 md 不会带上宽度；图片宽度属于文档内容，写进 `.md`，Typora / Obsidian 打开同样带尺寸
* `tauri dev` 跑裸二进制、无 bundle，AppKit / WebKit 自注入的菜单项（窗口组系统项、编辑组自动填充 / 表情与符号、WebView 右键菜单）靠构建时写到可执行文件同级的最小 `Info.plist`（`CFBundleDevelopmentRegion=zh_CN`）取中文词；若某台机器上系统不采纳扁平 bundle，dev 下这些项回退为英文，打包 `.app` 走 `bundle.macOS.infoPlist` 那份不受影响
* Git 同步不代持凭据、不自动 force、不做 LFS（libgit2 不实现 LFS，与「零外部二进制」冲突）；真需大附件请自配 `.gitattributes` 或换存储

---

## Git 工作流约定（本仓库）

* 远端：`https://gitee.com/hackerSnail/note-lume.git`（`origin`）
* 分支：`master`
* 协作规则见 `CLAUDE.MD` 末尾：改动验证通过后直接 commit + push，无需逐次确认；破坏性操作（`--force` / `--no-verify`）仍需显式同意

---

## License

[Apache License 2.0](http://www.apache.org/licenses/LICENSE-2.0)。完整文本见仓库根目录 [LICENSE](LICENSE)。

Copyright 2026 hackerSnail