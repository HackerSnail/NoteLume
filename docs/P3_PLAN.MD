# P3 实施计划：把「已知边界」变成「已完成」

> 来源：README「已知边界（当前版本）」列出的缺口 + Obsidian 迁移关键能力。
> 目标：编辑器核心体验补齐，逐项从"文档里写着缺口"变为"实际可用"。
>
> **本轮已确认的两条决策（2026-10-14）：**
> 1. **依赖策略**：按需新增 npm 依赖，**稳字优先**（优先成熟库，不自造轮子）。此前画布阶段守的"零新依赖"在本批**放开**。
> 2. **起手顺序**：按下方推荐顺序 **1 → 7** 逐项推进。
>
> **工作方式**（沿用画布打磨节奏）：一次只做一个批次，验证通过即 commit+push；每批完成回到本文件打勾 + 更新状态表。

---

## 状态总览

| 批次 | 功能 | 新增依赖 | 风险 | 状态 |
|---|---|---|---|---|
| 1 | Frontmatter（YAML 头）保留 + 编辑面板 | `js-yaml` | 低 | ✅ 已完成 |
| 2 | 文件树基础操作：新建文件/文件夹、重命名、拖拽移动、外部拖入导入 | 无 JS（新 Rust 命令） | 中 | ✅ 已完成 |
| 3 | 标签全局视图：所有标签 → 点击列出含该标签文档 | 无（走索引） | 低 | ⬜ 待做 |
| 4 | wikilink / tag 输入自动补全（打 `[[` 弹模糊下拉） | 无（手搓 plugin，可选 suggest 库） | 中 | ⬜ 待做 |
| 5 | 表格完整编辑：增删行列 / Tab 跨格 / 右键行列表 / 列宽拖拽 | `prosemirror-tables` | 中 | ⬜ 待做 |
| 6 | Obsidian callout `> [!NOTE]` 渲染 | 无（自定义块规则 + CSS） | 低 | ⬜ 待做 |
| 7 | Mermaid 图表（` ```mermaid ` 代码块渲染） | `mermaid`（重，bundle 大） | 中高 | ⬜ 待做 |

图例：⬜ 待做 · ⏳ 进行中 · ✅ 已完成（已 commit+push）

---

## 地基实况（2026-10-14 勘查，供各批参考）

- 编辑器 = **自建 ProseMirror + prosemirror-markdown**（非现成封装）。
  - `src/editor-schema.js`：schema + Markdown↔PM 双向无损转换（纯逻辑，无 DOM）。
  - `src/editor-view.js`：`createEditor(opts)` 装配插件/快捷键/输入规则/图片落库/nodeView；对外 `{ view, setMarkdown(md), getMarkdown(), markSaved(), focus(), jumpToPos(pos) }`。
- **表格节点已存在**：`table / table_row / table_header / table_cell`（GFM 解析 + 对齐序列化已在 `serializeTable`）。缺的只是**编辑人体工学**，不是建表。
- **`[[wikilink]]` / `#tag` / KaTeX 数学都已是行内/块节点**，并有 `handleTextInput` 输入规则（敲 `]]` / 空格 / `$` 触发成节点）。缺的是 `[[` **自动补全下拉**。
- **frontmatter 当前会被 markdown-it 误解析**（首行 `---` 当分隔线/标题）→ 硬伤。`setMarkdown/getMarkdown` 整段 parse/serialize，无剥离。
- Rust 侧文件命令现状：`create_md_file` / `delete_file`（移入回收站）/ `write_md_file` / `read_md_file` / `scan` 等。**无** 新建文件夹 / 重命名 / 移动；**未接** Tauri 外部文件拖入（需查 `src-tauri/tauri.conf.json` 的 dragDrop 与 fs scope）。
- 侧栏面板（`src/index.html`）：搜索 / 文件 / 大纲 / 标签 / 双向链接 / 历史版本 / 插件。frontmatter 面板拟加在「大纲」附近。
- 已有 `.notelume-plugins` 钩子系统（`src/plugin-loader.js`），运行时 `state.reconfigure` 热注入 keymap/inputRule。
- 往返回归：`src/tests/roundtrip.test.mjs`（`node tests/roundtrip.test.mjs`），直接测 `parseMarkdown/serializeMarkdown`。frontmatter 剥离拟抽成**独立纯模块**，单列测试，不动这条幂等链。
- 环境校验：前端 `npm run build:web`（vite，约 147 modules）；含 Rust 改动需 `cargo test` 且**重启 `npm run tauri dev`**（HMR 不够）。

---

## 1. Frontmatter（YAML 头）保留 + 编辑面板 ✅

> 落地：新纯模块 `src/frontmatter.js`（split/join，字节级往返，未闭合安全降级）+ `src/editor-view.js` 边界接线（setMarkdown 剥离 / getMarkdown 补回 / getFrontmatter / setFrontmatter）+ 侧栏「文档属性」面板 `src/frontmatter-panel.js`（只读摘要 + 源码 textarea + 校验应用 + 显式重排）+ `index.html`/`style.css`。导出剔除 frontmatter。新增依赖 `js-yaml`（注意其 ESM 无 default 导出，需 `import * as yaml`）。`roundtrip.test.mjs` 新增 6 例往返；`npm run build:web` 150 modules 通过。

**目标**：读写 md 时保留并原样往返 `---\n<yaml>\n---` 头，并提供专门面板编辑字段（Obsidian 用户用它放 tags/date/status 等，不保留会被判定"会弄坏我的库"）。

**决策**：YAML 解析用 **`js-yaml`**（成熟、稳），不手写解析器。

**方案**：
- 新纯模块 `src/frontmatter.js`：
  - `splitFrontmatter(mdText) -> { yaml: string|null, body: string }`：仅识别**文件最开头**的 `---` 围栏（首个非空前必须是 `---` 行，闭合 `---` / `...`）；无则原样返回。
  - `joinFrontmatter(yaml, body) -> string`：把 yaml 原样前置补回。
  - 保留**原始 yaml 字符串**做字节级往返（用户手写的顺序/注释不丢）；面板编辑后才用 `js-yaml` dump 重排。
- 接线在 `src/editor-view.js` 编辑器边界（schema 的 parse/serialize 保持纯净不变）：
  - 闭包持有 `let fmRaw = null`。
  - `setMarkdown(md)`：先 `splitFrontmatter`，存 `fmRaw`，只 parse `body`。
  - `getMarkdown()`：`serialize(doc)` 后 `joinFrontmatter(fmRaw, body)`。
  - 新增 API：`getFrontmatter()`（返回 `{ raw, data }`，data 经 `js-yaml` load，解析失败降级 `{}` 不抛）、`setFrontmatter(rawString)`（更新 `fmRaw` + 置脏 + 回调 `onFrontmatterChange`）。
- 新面板 `src/frontmatter-panel.js` + `index.html` 侧栏「文档属性」区：把 `data` 渲染成 key/value 行（含数组），支持增/改/删字段与整块 YAML 原文切换编辑；改动写回 `editor.setFrontmatter`。
- 快照回滚（`snapshot-panel.js` 调 `editor.setMarkdown(content)`）自然经由边界剥离/补回，无需改。

**验收**：
- 打开带 frontmatter 的 Obsidian md → 头部字段完整显示、正文正常编辑 → 保存 → `---` 头原样保留、不产生多余转义、再开不劣化（幂等）。
- 无 frontmatter 的文档 → 不被误加头、不受影响。
- 非法 YAML → 不崩，面板提示并按原文保留。
- `node tests/roundtrip.test.mjs` 全绿（新增 frontmatter split/join 用例）。

---

## 2. 文件树基础操作 ✅

> **2A 已完成**：新 Rust 命令 `create_dir` / `rename_item`（重命名与移动合一）+ 前端右键菜单三态（文件/文件夹/空白区）+ 应用内输入模态 `src/prompt-dialog.js`；重命名/移动后 `startIndexPolling()` 重建索引 + `remapCurrentAfterRename`。`cargo test` 单测覆盖越界/重名/不静默覆盖/禁止文件夹入自身。
>
> **2B 已完成**：① **内部拖拽移动**——文件/文件夹 `draggable`，事件委托 dragstart/dragover/drop 在 `els.tree` 上，目标解析（拖到文件夹→该文件夹 / 拖到文件→其所在目录 / 空白→库根），落点走 `rename_item`，目标高亮 `.tree-drop-hover`；② **外部拖入导入**——复用编辑区已有的 DOM `dataTransfer.files` 机制（非 Tauri 原生事件），新 Rust 命令 `import_vault_file(dest_dir_rel, name, data_base64)`（限库内 + 名称只取末段 + 同名不同内容按 fnv1a 指纹重命名），前端只放行 `.md`/`.canvas`/图片白名单。`npm run build:web` 151 modules、`cargo test` 14 passed（+import 单测）。
>
> 遗留已知近似：拖拽/重命名后全库指向旧路径的 `[[链接]]` 不回写（与删除同类，靠 rebuild 纠正）；OS 拖入依靠 dataTransfer.files（若本环境 dragDropEnabled 不交回文件，需改接 `@tauri-apps/api/webview` 原生事件）。

**目标**：右键菜单补齐 新建文件 / 新建文件夹 / 重命名 / 移动（拖拽到文件夹）；支持从系统拖入 `.md` / 图片导入到库。

**方案（草案）**：
- 新 Rust 命令（均走 `abs_in_vault` 限库内 + 拒绝 `..` 越界，附单测）：
  - `create_dir(vault_root, path)`
  - `rename(vault_root, from, to)`（同目录改名 / 跨目录移动二选一或合一）
  - 外部拖入：确认/开启 `tauri.conf.json` 的 `dragDropEnabled`，前端 `onDragDropEvent`（`@tauri-apps/api/webview`）拿绝对路径 → 拷贝进 `assets/` 或目标目录（复用已有图片落库思路）。
- 前端：`showTreeMenu` 增项；重命名/新建用行内输入或 `messageDialog` 式弹窗；拖拽移动 = HTML5 drag + 目标文件夹高亮。
- 删/改名当前打开文档时同步收尾（清编辑区 / 更新 `state.currentFile`）+ 索引同步（复用 `removeIndexDoc` / `updateIndexDoc`）。

**待细究**：重命名后指向它的其他文档 `[[链接]]`/backlinks 是否改写（Obsidian 会全库改链接）；MVP 可先只改文件与移动索引条目，链接修复列为可选。

---

## 3. 标签全局视图 ⬜

**目标**：侧栏「标签」现在只列当前文档 tag；补"全库所有标签 → 点击列出含该标签的文档"。

**方案（草案）**：
- Rust：`VaultIndex` 已每文档存 `tags`。加命令 `list_all_tags(state) -> Vec<{ tag, count }>` 与 `query_tag(state, tag) -> Vec<DocInfo>`（或一个 `tag_docs`）。
- 前端：标签面板加"全局"分组；点击标签 → 列文档 → 跳转 `openFile`。
- 注意：frontmatter 里的 `tags:` 是否纳入（与批次 1 协同，可后续增强）。

---

## 4. wikilink / tag 自动补全 ⬜

**目标**：输入 `[[` 弹文档名模糊匹配下拉；输入 `#` 弹已有标签补全。Obsidian 核心手感。

**方案（草案）**：
- ProseMirror `Plugin`：监听 `handleTextInput`/`handleKeyDown`，检测到 `[[`（或 `#`）后进入"补全态"，弹下拉（复用 `.cv-menu` 风格或新样式），ArrowUp/Down + Enter/Tab/Esc。
- 数据源：文档列表走索引（`search_vault` 或新 `list_docs`）前端缓存 + 模糊匹配；标签源同批次 3。
- 可评估 `prosemirror-suggest` 库；先手搓保持可控。

---

## 5. 表格完整编辑 ⬜

**目标**：接 `prosemirror-tables`，做增删行列、Tab 跨格跳转、右键行/列操作、列宽拖拽。

**方案（草案）**：
- `npm i prosemirror-tables`。
- **关键风险**：现有自建 `table/table_row/table_header/table_cell` spec 与 prosemirror-tables 期望的 cell 结构（`colspan/rowspan` 等 attrs、`TableMap`）需调和；`cellToMarkdown/serializeTable` 往返要保 GFM 无损。
- 接入：`tableKeymap`（Tab/Enter 等）、列宽 `columnResizing`、右键复用 `.cv-menu` 风格调 `addRowAfter/addColumnBefore/deleteRow/...`。
- 回归：`roundtrip.test.mjs` 的 `table` 样例必须仍幂等；新增含合并单元格/空表用例。

---

## 6. Obsidian callout ⬜

**目标**：渲染 `> [!NOTE] 内容` 系列为带标题/图标的彩色卡片；不破坏 GFM 引用语义。

**方案（草案）**：
- markdown-it 自定义 block 规则（仿现有 `math_block` 写法）识别 `> [!TYPE]` 起始；PM 加 `callout` block 节点（或复用 blockquote + attrs）；序列化原样写回 `> [!TYPE]\n> ...`，保持与 Obsidian 文件互通。
- 支持类型：NOTE/TIP/IMPORTANT/WARNING/CAUTION + `-[`/`+` 折叠标记（MVP 可先静态、折叠列可选）。
- CSS：分型配色（沿用主题变量），与三主题（light/dark/Dracula）适配。

---

## 7. Mermaid 图表 ⬜

**目标**：` ```mermaid ` 代码块渲染成图。迁移 Obsidian 用户的关键开关。

**方案（草案）**：
- `npm i mermaid`（**重**，动态 `import()` 懒加载避免拖慢首屏）。
- 代码块 `params` 语言为 `mermaid` 时，nodeView 异步 `mermaid.render()` 成 SVG 插入（仿 `math-nodeviews.js` 的 nodeView 模式）。
- 导出/打印 HTML 需一并渲染或降级为代码；`.canvas` 卡片 markdown 渲染里若出现 mermaid 是否渲染（暂可降级）。
- 主题/深色适配：mermaid `themeVariables` 对齐三主题。

---

## 备注 / 已决事项

- 本批**允许新增依赖**（用户拍板"按需新增，稳字优先"）；每项落地后更新 README「已知边界」删除对应缺口条目。
- 与 `CLAUDE.md`/`CLUADE.MD`（仓库文档）约定一致：验证通过即 commit+push 到 Gitee `origin/master`；逐文件 `git add`；中文 commit 走 UTF-8 文件 + `-F`；不用 `--no-verify`/force push；临时文件落 `*.tmp`（已被 gitignore）。
