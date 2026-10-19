<h1 align="center">NoteLume · 文溯</h1>

<p align="center">
  把 <strong>Typora 的所写即所得</strong>和 <strong>精简版 Obsidian 的知识库能力</strong>装进 Tauri 壳的本地 Markdown 笔记工具。<br>
  你的笔记就是一堆标准 <code>.md</code> 文件躺在自己的文件夹里：秒开、离线、零格式锁定。
</p>

<p align="center">
  <a href="https://github.com/HackerSnail/NoteLume"><img alt="platforms" src="https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-6f6f6f?style=flat-square"></a>
  <a href="https://github.com/HackerSnail/NoteLume/blob/master/LICENSE"><img alt="license" src="https://img.shields.io/badge/license-Apache--2.0-2ea44f?style=flat-square"></a>
  <img alt="size" src="https://img.shields.io/badge/DMG-~6%20MB-8a2be2?style=flat-square">
</p>

<p align="center">
  <a href="#中文">中文</a> ·
  <a href="#english">English</a>
</p>

<table align="center">
  <tr>
    <td align="center"><img src="img/preview/light.png" alt="浅色主题" width="100%"><br>浅色</td>
    <td align="center"><img src="img/preview/dark.png" alt="暗黑主题" width="100%"><br>暗黑</td>
    <td align="center"><img src="img/preview/vampire.png" alt="Dracula 主题" width="100%"><br>Dracula</td>
  </tr>
</table>

---

## 中文

### 简介

受够了云笔记的转圈加载，又舍不得本地记事本的速度？NoteLume（中文名「文溯」）就是为这个矛盾来的：

它把 **Typora 的一体化 WYSIWYG 编辑体验**和 **精简版 Obsidian 的知识库能力**装进了一个 Tauri 壳里——你的笔记就是一堆标准 `.md` 文件躺在自己的文件夹里，双击即开、断网可用，但 `[[双链]]`、标签、反链、全文搜索、知识图谱、Git 同步一个不少。没有任何私有格式，哪天换工具了，文件还是你的。

**适合谁用**：极简主义者、隐私敏感者、开发者与文字工作者——所有「想要本地文件的确定性，又想要现代笔记软件顺手能力」的人。

### 功能亮点

* ✍️ **所写即所得**：Markdown 与富文本双向无损往返；KaTeX 公式、Mermaid 图表、callout 卡片、合并单元格表格、脚注、代码块子语言高亮，全都在渲染态直接编辑
* 🗂 **文件夹即知识库**：`[[wikilink]]` 输入补全与悬浮预览、`#tag` 全局视图、双向链接面板、Canvas 力导向图谱、全库搜索、版本快照一键回滚
* 🔒 **完全本地、零锁定**：纯 GFM 文件，Typora / Obsidian 可直接打开同一份库；不联网也绝不上传，删除进系统回收站
* 🔄 **Git 内置**：状态 / 历史 / 单文件 diff / 提交 / 推送 / 合并冲突解决全部内建（`git2` 引擎，没装 git 也能 fetch/pull）
* 📦 **轻**：macOS DMG 约 6 MB；Word(.docx) 离线导入导出、整库导出静态站、插件系统（`.notelume-plugins/`）同样内建

### 快速开始

**安装**：到 [Releases][releases] 下载对应平台的安装包——

| 平台    | 文件                              | 安装方式            |
| ------- | --------------------------------- | ------------------- |
| Windows | `NoteLume_x.y.z_x64-setup.exe`  | 双击安装            |
| macOS   | `NoteLume_x.y.z_aarch64.dmg`    | 拖入 Applications   |
| Linux   | `NoteLume_x.y.z_amd64.AppImage` | `chmod +x` 后运行 |

**使用**：打开后 `Ctrl+Shift+O` 选一个存着 `.md` 的文件夹作为知识库，开写；只想改单个文件就 `Ctrl+O`。全部键位可在命令面板（`Ctrl+Shift+P`）和快捷键设置里查看、重绑。

**从源码构建**：需要 Rust 1.80+ 与 Node 18+。

```bash
cd src && npm install && cd ..
npm run dev      # 开发模式（首次约 5–10 分钟编译 Rust 依赖）
npm run build    # 生产打包（产物在 src-tauri/target/release/bundle/）
```

### 快捷键

mac 上 `Ctrl` 即 `⌘`。以下键位按 Typora / Obsidian 主流习惯预置，全部可在「更多」→「快捷键设置…」重绑（冲突会硬阻止保存）。

**文件与导航**

| 键位                              | 作用                                     |
| --------------------------------- | ---------------------------------------- |
| `Ctrl+N`                        | 新建文件（先落系统临时目录，不要求开库） |
| `Ctrl+O`                        | 打开单个 Markdown 文件                   |
| `Ctrl+Shift+O`                  | 打开文件夹作为知识库                     |
| `Ctrl+Tab` / `Ctrl+Shift+Tab` | 切换下一个 / 上一个标签页                |
| `Ctrl+W`                        | 关闭当前标签页                           |
| `F2`                            | 重命名当前文件（可顺带移动）             |
| `Ctrl+S`                        | 保存（临时文件 = 另存为，选正式位置）    |
| `Ctrl+P`                        | 打印 / 另存 PDF                          |
| `Ctrl+Shift+P`                  | 命令面板（模糊搜命令 / 文档）            |
| `Ctrl+E`                        | 正文与 Markdown 源码整篇互切             |
| `Ctrl+F`                        | 本篇文档内查找                           |
| `Ctrl+H`                        | 本篇文档内查找替换                       |
| `Ctrl+Shift+F`                  | 聚焦侧栏全局搜索                         |
| `Ctrl+Shift+V`                  | 粘贴为纯文本                             |
| `Ctrl+Shift+I`                  | 插入图片（自动入库 `assets/`）         |
| `Ctrl+K`                        | 插入 / 编辑链接（地址留空 = 解除链接）   |

**格式与段落**

| 键位                                | 作用                             |
| ----------------------------------- | -------------------------------- |
| `Ctrl+B` / `Ctrl+I`             | 粗体 / 斜体                      |
| `` Ctrl+` ``                      | 行内代码                         |
| `Ctrl+Shift+K`                    | 代码块                           |
| `Ctrl+Shift+X`                    | 删除线                           |
| `Ctrl+1` ~ `Ctrl+6`             | 设为一级 ~ 六级标题              |
| `Ctrl+]` / `Ctrl+[`             | 提升 / 降低标题级别              |
| `Ctrl+Shift+Q`                    | 引用块                           |
| `Ctrl+Shift+L`                    | 任务列表                         |
| `Ctrl+Shift+[` / `Ctrl+Shift+]` | 无序 / 有序列表                  |
| `Ctrl+T`                          | 插入表格                         |
| `Ctrl+D`                          | 删除当前行 / 段落                |
| `Ctrl+M`                          | 插入行内公式（有选区则包裹）     |
| `Ctrl+Shift+M`                    | 插入块级公式                     |
| `Ctrl+Z` / `Ctrl+Y`             | 撤销 / 重做                      |
| `Shift+Enter`                     | 硬换行                           |
| `Tab` / `Shift+Tab`             | 表格单元格间跳转（末行自动补行） |

**视图**

| 键位                | 作用                               |
| ------------------- | ---------------------------------- |
| `Ctrl+G`          | 打开 / 关闭知识图谱                |
| `Ctrl+Shift+D`    | 今日速记（全局浮层，独立于知识库） |
| `` Ctrl+Shift+` `` | 专注模式（当前块高亮）             |
| `Ctrl+Shift+T`    | 打字机模式（当前块居中）           |
| `Ctrl+Shift+S`    | 隐藏 / 显示侧栏                    |
| `Ctrl+Shift+B`    | 隐藏 / 显示右侧检查器栏            |
| `Ctrl+Shift+H`    | 折叠 / 展开当前节                  |

### 技术栈

| 层       | 选型                                                                |
| -------- | ------------------------------------------------------------------- |
| 桌面外壳 | Tauri v2 + Rust（文件 I/O、索引、docx 解析、Git 全在 Rust 侧）      |
| 编辑器   | ProseMirror（WYSIWYG）+ CodeMirror 6（源码模式），无 Vue/React 框架 |
| 前端构建 | Vite                                                                |
| 存储     | 本地文件夹 + 标准 GFM `.md`，无数据库、无私有格式                 |

### 贡献指南

1. Fork 仓库，基于 `master` 切出自己的分支（网页版开发隔离在 `web` 分支，请勿向上合并）
2. 改动后跑离线回归：`npm run test:roundtrip`，或逐个执行 `src/tests/*.test.mjs`
3. 提交 PR，CI（GitHub Actions）会自动跑前端测试、Rust check/test 与三平台构建
4. 设计文档与迭代规划见 [`docs/CLAUDE.MD`](docs/CLAUDE.MD)、[`docs/ROADMAP.md`](docs/ROADMAP.md)；逐项功能细节与已知边界见 [`docs/FEATURES.md`](docs/FEATURES.md)

Issue 和 PR 都欢迎，也欢迎任何形式的功能建议。

### 许可证

[Apache License 2.0][license] · Copyright 2026 hackerSnail

---

## English

### Overview

Tired of cloud notes that spin forever, but unwilling to give up speed for structure? NoteLume (Chinese name: 文溯, *Wènsù*) resolves that trade-off: it packs the **all-in-one WYSIWYG editing of Typora** and a **lean subset of Obsidian's vault features** into a tiny Tauri app. Your notes stay plain `.md` files in a folder you own — instant to open, fully offline, yet with `[[wikilinks]]`, tags, backlinks, full-text search, a knowledge graph, and built-in Git sync. Zero proprietary formats: if you ever leave, your files don't.

**Who it's for**: minimalists, privacy advocates, developers and writers — anyone who wants the certainty of local files with the ergonomics of a modern note-taking app.

### Highlights

* ✍️ **True WYSIWYG**: lossless Markdown round-trip; edit KaTeX math, Mermaid diagrams, callouts, merged-cell tables, footnotes, and syntax-highlighted code blocks right in the rendered view
* 🗂 **A folder is a vault**: `[[wikilink]]` autocomplete with hover preview, global tag view, backlinks panel, Canvas-based knowledge graph, vault-wide search, snapshot history with one-click rollback
* 🔒 **Local-first, no lock-in**: pure GFM — Typora and Obsidian can open the same vault; nothing ever leaves your machine; deletions go to the system trash
* 🔄 **Git built in**: status / history / per-file diff / commit / push / merge-conflict resolution, powered by embedded `git2` — works even without a system Git installed
* 📦 **Featherweight**: the macOS DMG is about 6 MB; offline Word (.docx) import/export, full-vault static-site export, and a plugin system (`.notelume-plugins/`) come standard

### Quick Start

**Install**: grab the package for your platform from [Releases][releases] —

| Platform | File                              | How                    |
| -------- | --------------------------------- | ---------------------- |
| Windows  | `NoteLume_x.y.z_x64-setup.exe`  | Run the installer      |
| macOS    | `NoteLume_x.y.z_aarch64.dmg`    | Drag to Applications   |
| Linux    | `NoteLume_x.y.z_amd64.AppImage` | `chmod +x`, then run |

**Use**: press `Ctrl+Shift+O` and point NoteLume at a folder of `.md` files to open it as a vault, or `Ctrl+O` for a single file. Every shortcut is discoverable in the command palette (`Ctrl+Shift+P`) and fully remappable.

**Build from source**: requires Rust 1.80+ and Node 18+.

```bash
cd src && npm install && cd ..
npm run dev      # dev mode (first Rust build takes ~5–10 min)
npm run build    # release bundles, output under src-tauri/target/release/bundle/
```

### Keyboard Shortcuts

On macOS, `Ctrl` means `⌘`. Everything below follows Typora / Obsidian conventions and is fully remappable in Settings → Shortcuts (conflicts are hard-blocked).

**Files & navigation**

| Keys                              | Action                                                    |
| --------------------------------- | --------------------------------------------------------- |
| `Ctrl+N`                        | New file (lands in a temp scratch dir; no vault required) |
| `Ctrl+O`                        | Open a single Markdown file                               |
| `Ctrl+Shift+O`                  | Open a folder as a vault                                  |
| `Ctrl+Tab` / `Ctrl+Shift+Tab` | Next / previous tab                                       |
| `Ctrl+W`                        | Close current tab                                         |
| `F2`                            | Rename current file (doubles as move)                     |
| `Ctrl+S`                        | Save (a scratch file becomes Save As)                     |
| `Ctrl+P`                        | Print / export PDF                                        |
| `Ctrl+Shift+P`                  | Command palette (fuzzy-search commands & docs)            |
| `Ctrl+E`                        | Toggle between WYSIWYG and Markdown source                |
| `Ctrl+F`                        | Find in document                                          |
| `Ctrl+H`                        | Find & replace in document                                |
| `Ctrl+Shift+F`                  | Focus vault-wide search                                   |
| `Ctrl+Shift+V`                  | Paste as plain text                                       |
| `Ctrl+Shift+I`                  | Insert image (auto-saved to `assets/`)                  |
| `Ctrl+K`                        | Insert / edit link (empty URL removes it)                 |

**Format & blocks**

| Keys                                | Action                                              |
| ----------------------------------- | --------------------------------------------------- |
| `Ctrl+B` / `Ctrl+I`             | Bold / italic                                       |
| `` Ctrl+` ``                      | Inline code                                         |
| `Ctrl+Shift+K`                    | Code block                                          |
| `Ctrl+Shift+X`                    | Strikethrough                                       |
| `Ctrl+1` ~ `Ctrl+6`             | Heading level 1–6                                  |
| `Ctrl+]` / `Ctrl+[`             | Promote / demote heading                            |
| `Ctrl+Shift+Q`                    | Blockquote                                          |
| `Ctrl+Shift+L`                    | Task list                                           |
| `Ctrl+Shift+[` / `Ctrl+Shift+]` | Bullet / numbered list                              |
| `Ctrl+T`                          | Insert table                                        |
| `Ctrl+D`                          | Delete current line / block                         |
| `Ctrl+M`                          | Inline math (wraps selection if any)                |
| `Ctrl+Shift+M`                    | Block math                                          |
| `Ctrl+Z` / `Ctrl+Y`             | Undo / redo                                         |
| `Shift+Enter`                     | Hard line break                                     |
| `Tab` / `Shift+Tab`             | Jump between table cells (appends a row at the end) |

**View**

| Keys                | Action                                                   |
| ------------------- | -------------------------------------------------------- |
| `Ctrl+G`          | Toggle knowledge graph                                   |
| `Ctrl+Shift+D`    | Daily capture (global overlay, independent of the vault) |
| `` Ctrl+Shift+` `` | Focus mode (highlight current block)                     |
| `Ctrl+Shift+T`    | Typewriter mode (center current block)                   |
| `Ctrl+Shift+S`    | Toggle sidebar                                           |
| `Ctrl+Shift+B`    | Toggle right inspector                                   |
| `Ctrl+Shift+H`    | Fold / unfold current section                            |

### Tech Stack

| Layer   | Choice                                                                            |
| ------- | --------------------------------------------------------------------------------- |
| Shell   | Tauri v2 + Rust (file I/O, indexing, docx parsing, Git all live on the Rust side) |
| Editor  | ProseMirror (WYSIWYG) + CodeMirror 6 (source mode), no UI framework               |
| Bundler | Vite                                                                              |
| Storage | Plain folders of GFM `.md` — no database, no proprietary format                |

### Contributing

1. Fork the repo and branch off `master` (the web edition is isolated on the `web` branch — never merge it upstream)
2. Run the offline regression suite: `npm run test:roundtrip`, or execute `src/tests/*.test.mjs` individually
3. Open a PR — CI (GitHub Actions) runs frontend tests, Rust check/test, and three-platform builds
4. Design docs live in [`docs/CLAUDE.MD`](docs/CLAUDE.MD) and [`docs/ROADMAP.md`](docs/ROADMAP.md); the exhaustive feature list and known limits are in [`docs/FEATURES.md`](docs/FEATURES.md)

Issues and PRs of every kind are welcome.

### License

[Apache License 2.0][license] · Copyright 2026 hackerSnail

<!-- links -->

[license]: LICENSE
[repo]: https://github.com/HackerSnail/NoteLume
[releases]: https://github.com/HackerSnail/NoteLume/releases
