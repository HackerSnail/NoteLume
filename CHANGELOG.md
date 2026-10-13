# 更新日志

本项目的所有重要变更都会记录在此文件中。

格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

## [Unreleased]

### 计划中（P1）

- 双向链接面板：「引用本文件」+「本文件引用的其他文件」
- 全局搜索：库内 md 内容 + 文件名 + 标签（Rust 后台索引）
- 自动保存 + 备份机制
- KaTeX 数学公式、代码块语法高亮
- 导出 HTML / PDF、[[链接]] 悬浮预览

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
[0.1.0]: https://gitee.com/hackerSnail/note-lume
