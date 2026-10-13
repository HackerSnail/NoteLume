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
| **P0** | Markdown ↔ ProseMirror 双向无损（10 项幂等测试全通过）                                       | ✅ 已完成 |
| **P0** | 图片拖拽/粘贴自动落库`assets/` 并生成相对链接                                               | ✅ 已完成 |
| **P0** | 快捷键 Ctrl+S / Ctrl+O / Ctrl+B / Ctrl+I                                                      | ✅ 已完成 |
| **P0** | 浅色/暗黑主题切换 + 类 Typora 阅读排版                                                        | ✅ 已完成 |
| **P0** | 打开本地文件夹作为知识库、文件树、点击切换                                                    | ✅ 已完成 |
| **P0** | 单独打开一个 md 文件（所在目录作为工作根，可正常保存）                                    | ✅ 已完成 |
| **P0** | `[[wikilink]]` 支持：识别、点击跳转、目标不存在时提示新建                                   | ✅ 已完成 |
| **P0** | 文档大纲面板（点击跳转）                                                                      | ✅ 已完成 |
| **P0** | `#tag` 识别并在侧栏展示                                                                     | ✅ 已完成 |
| **P1** | 双向链接面板 · 全局搜索 · 自动保存 + 备份 · KaTeX · 代码高亮 · 导出 HTML/PDF · 悬浮预览 | ⏳ 规划中 |
| **P2** | 简易知识图谱 · 版本快照 · 插件钩子 · 画布 · 移动端                                        | ⏳ 规划中 |

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
│       └── lib.rs          # 所有 #[tauri::command]（扫描/读写/wikilink/assets）
├── src/                    # 前端 Web 工程（Vite 根）
│   ├── index.html
│   ├── main.js             # 应用装配：布局、快捷键、打开/保存/跳转
│   ├── editor-schema.js    # ProseMirror 扩展 schema + MD 双向转换（纯逻辑，可 Node 单测）
│   ├── editor-view.js      # WYSIWYG 编辑器装配：插件、快捷键、输入规则、图片拖粘
│   ├── tauri-bridge.js     # Rust invoke 封装 + 系统对话框
│   ├── style.css           # 类 Typora 排版 + 浅色/暗黑主题
│   ├── vite.config.js
│   ├── package.json
│   └── tests/
│       └── roundtrip.test.mjs   # Markdown <-> ProseMirror 幂等回归测试（10 例）
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

对 10 个样例做「解析 → 序列化 → 再解析 → 再序列化」幂等校验，覆盖：标题 / 行内混排 / 引用与列表 / 任务列表 / 代码块 / 图片 / `[[wikilink]]` / `#tag` / 表格 / 组合样例。

## 生产打包

```bat
npm run build
```

产物落在 `src-tauri/target/release/bundle/`（Windows 下含 `.msi` 与 `.exe`）。

---

## 首次上手清单

1. 打开应用，点工具条 **📄 打开文件** 直接编辑单个 md（Ctrl+O），或点 **📂 打开知识库** 选一个本地文件夹作为库根（Ctrl+Shift+O）
2. 左侧文件树点击 `.md` 文件即可加载；直接编辑，**Ctrl+S** 写回原文件
3. 在正文输入 `[[文档名]]`，敲完右中括号会自动变成可点击链接；点击若目标不存在会提示新建
4. 输入 `#标签 `（末尾空格触发）变成标签 chip，侧栏「标签」面板列出当前文档全部标签
5. 拖一张图片到编辑区，或剪贴板 Ctrl+V 粘贴图片：自动拷贝到同目录的 `assets/`，正文以 `![](./assets/xxx.png)` 相对路径写入
6. 「大纲」面板按标题层级列出，点击可跳转
7. 右下角 🌙/☀️ 切换深色/浅色（记忆在 localStorage）

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

---

## 设计要点

- **纯 GFM，零私有格式**：所有 md 文件可被 Typora / Obsidian 直接打开，无信息丢失
- **`[[wikilink]]` 与 `#tag` 是行内节点**（非普通文本），通过 markdown-it 自定义 inline 规则识别、ProseMirror 序列化为标准 `[[…]]` / `#xxx`；输入规则让你在编辑器里敲下 `]]` 或紧跟空格的 `#xxx` 即自动生成节点
- **表格、任务列表**：GFM 语义（表头行 + 对齐分隔行 + `- [x]` / `- [ ]`）；单元格允许行内内容，序列化时按列宽对齐输出
- **Rust 后端**只做文件/索引/路径处理，UI 与渲染全在 ProseMirror，职责清晰
- **路径安全**：`ensure_inside_root` + `..` 逃逸拒绝，避免 md 读写越出库根

---

## 已知边界（当前版本）

- 表格支持渲染/编辑内容/无损往返，但**增删行列、Tab 单元格跳转**尚未接入（依赖 prosemirror-tables，P1 补上）
- 图片走"字节 → base64 → 落盘"路径，因此**超大图（数十 MB）粘贴**会比走文件路径慢；后续会用拖拽文件绝对路径优化
- 全局搜索与双向链接面板依赖 Rust 后台索引，尚未开始
- `assets/` 目前放在每个 md **同目录**（相对链接最稳）；库根级 `assets` 归一化留待 P1

---

## Git 工作流约定（本仓库）

- 远端：`https://gitee.com/hackerSnail/note-lume.git`（`origin`）
- 分支：`master`
- 协作规则见 `docs/CLUADE.MD` 末尾：**改动验证通过后直接 commit + push**，无需逐次确认；破坏性操作（`--force` / `--no-verify`）仍需显式同意

---

## License

[Apache License 2.0](http://www.apache.org/licenses/LICENSE-2.0)。完整文本见仓库根目录 [LICENSE](LICENSE)。

Copyright 2026 hackerSnail
