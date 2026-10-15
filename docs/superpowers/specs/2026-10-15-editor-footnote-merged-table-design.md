# 编辑器无损扩展 · 脚注 + 合并表格 · 设计 spec

> **前置子系统**（记 **功能项 J**，是 [docx 导入 spec](2026-10-15-docx-markdown-import-design.md) 的依赖）。目标：让 NoteLume 编辑器**无损往返**两类此前处理不了的构造——**脚注 `[^n]`** 与**合并单元格表格**，且可在 WYSIWYG 里编辑。
> 定位：纯核心编辑器管线扩展（schema/tokenizer/serializer/nodeView/命令），**不做 docx、不做插件热扩展**（那是 F2）。

## 1. 现状与动机
- 主 tokenizer = `MarkdownIt('commonmark', { html:false })` 仅再 `.enable(['table','strikethrough'])`（见 `src/editor-schema.js:287`）→ **无 footnote 解析**、**不解析原样 HTML**。
- 表格节点已用 `prosemirror-tables` 的 `tableNodes`，**模型层带 `colspan/rowspan/colwidth`**（`editor-schema.js:76`）；但 [table-editing.js:6-7](../../src/table-editing.js) **刻意未挂 merge/split**（"那会写出 GFM 表达不了的 colspan/rowspan"）。
- 即：合并表**模型已能表示、缺的只在 Markdown 往返层**；脚注则**模型与往返层都缺**。
- 触发点：docx 导入选定"原样保真产物"（脚注 / 合并表 HTML），但当前编辑器一打开就破坏——本 spec 消除该破坏。

## 2. 关键决策（与用户协做敲定）
- **范围**：脚注 + 合并表**两者都扩**，均可在 WYSIWYG 编辑。
- **脚注交互**：**Typora 式**——正文显上标角标 `[n]`（原子行内节点、`contenteditable=false`），脚注正文**自动收集到文末"脚注区"**可编辑；序列化回标准 `[^n]` + 定义行。
- **合并表编辑**：**保真往返 + 挂 merge/split**——新接 prosemirror-tables 内置 `mergeCells/splitCell` 进菜单，含合并的表可手动合并/拆分。
- **产物格式选标准、不破互操作**（原则 2）：脚注用 GFM/Obsidian 通用 `[^n]`；合并表存**真正的 `<table>` HTML**（GitHub/Obsidian 原生渲染）；**无合并仍出 GFM**。
- **不动全局 `html:true`**：HTML 表用**定向预处理**解析，任意 HTML 不进编辑器（安全面最小）。

## 3. 目标 / 非目标
**目标**：`[^n]`↔脚注节点无损往返并可编辑；`<table>`（含 colspan/rowspan）↔`prosemirror-tables` 节点无损往返；merge/split UI；两条都过 `roundtrip`。
**非目标**：脚注分栏/多段落富内容（脚注正文按 `inline*` 单段处理）；HTML 表里的嵌套块/列表（单元格内容仍 `inline*`）；任意 HTML 双向；`.docx`（属功能项 I）；插件注册 spec（属 F2）。

## 4. 架构与模块边界
- 全在**前端核心**：`src/editor-schema.js`（节点/标记 + tokenizer + parser tokens + serializer）+ `src/table-editing.js`（挂 merge/split）+ 新 `src/footnotes.js`（脚注插入/编号/跳转命令 + nodeView）+ `src/source-sync.js`/`editor-view.js`（若有加载钩子）。
- **后端无改动**（Rust 0）。→ 本功能**刷新即生效、无需重启 `tauri dev`**。
- **依赖新增**：`markdown-it-footnote`（纯前端、离线）→ 加进**主** tokenizer（不再只限校对预览）。

## 5. 脚注设计（Typora 式）
- **新节点**
  - `footnote_ref`：`inline:true, group:'inline', atom:true`，attrs `{ id }`。渲染为上标 `[n]`（`n` = 该 id 在文档内的**序号**，按 ref 出现顺序由 nodeView 现算，非存死），`contenteditable=false`，点击 → 滚动/聚焦到文末对应 `footnote_item`。
  - `footnote_section`：`block`，内容 `footnote_item+`，`defining:true`；文档内**至多一个、置于末尾**（插入首个脚注时惰性创建）。
  - `footnote_item`：`block`，attrs `{ id }`，内容 `inline*`（脚注正文，可编辑）。
- **解析**（`editor-schema.js` parserTokens 叠加，靠 markdown-it-footnote 产出的 token）
  - `footnote_reference`（inline）→ `footnote_ref{id}`；
  - `footnote_open`/`footnote`/`footnote_close`（block 容器）→ `footnote_section > footnote_item{id} > 内联`（把 markdown-it 的 `footnote_anchor`/`footnote back_link` 忽略）。
- **序列化**（`defaultMarkdownSerializer` 之外自写）
  - `footnote_ref` → `[^id]`；
  - `footnote_section` → 每项一行 `[^id]: <内联序列化>`（内联用同一序列化器递归、转义竖线/换行→空格）。
- **命令**（新 `src/footnotes.js`）
  - `insertFootnote(view)`：光标处插 `footnote_ref`（自动分配最小未用 id，如字符串序 `1,2,3…`）+ 在 `footnote_section` 追加空 `footnote_item` 并把选区落其内供输入；无 section 先建。
  - `deleteFootnote`：删 ref 时连带删其 item（并清理空 section）。
  - 编号：显示序号 = ref 文档序，增删自动重排（nodeView 现算，不写进 md，md 只存稳定 id）。
- **app 命令注册**：`app.insertFootnote`（批次 D 注册表，默认键可 `Ctrl+Shift+F`？——F 已被专注占用，改**无默认键**、命令面板可搜）。

## 6. 合并表格设计
- **序列化** `serializeTable`（`editor-schema.js:551` 改造）
  - 遍历：任一 cell `colspan>1 || rowspan>1` ⇒ **整表走 HTML**：`<table>` 行 `<tr>`、表头行 `<th>`（`table_header`）、数据 `<td>`，写 `colspan/rowspan`（仅 >1 时）、`style="text-align:…"`（对齐），单元格外层内容按 `inline*` 序列化并 **HTML 转义**（`& < > "`）；块间空行不产生。
  - 无合并 ⇒ **维持现状 GFM**（回归不变、`roundtrip` 老用例仍过）。
- **解析**：**定向两阶段预处理**（不开全局 html）
  1. `parseMarkdown` 前：正则/扫描把顶层**裸 `<table>…</table>` 块**替换成占位行（如 `NLTABLEPLACEHOLDER_<k>`），**跳过围栏代码块**内的假阳性；
  2. 其余照常 `mdParser.parse`；
  3. 对每个占位，用 `DOMParser.fromSchema(schema).parseSlice(<div innerHTML=原HTML>)` 还原成 `table` 节点（prosemirror-tables 的 `parseDOM` 已读 `colspan/rowspan/style`），替换占位段落。
  - 具体切片插入技法/正则健壮性留 **Phase 0 spike** 验证（本 spec 只锁策略：**定向、不全局 html、代码块内不动**）。
- **编辑 UI**（`src/table-editing.js`）
  - import `mergeCells, splitCell, selectedCells, cellAround`（prosemirror-tables 已提供，现仅没挂）。
  - 菜单增：选中 ≥2 格时显「合并单元格」(`mergeCells`)；格为合并态时显「拆分单元格」(`splitCell`)。移除 [table-editing.js:6-7](../../src/table-editing.js) 那条"不接 merge/split"的旧约束注释。
  - 需 CellSelection（拖选/Shift 点多格）：`tableEditing()` 已启用单元格选择，验证交互可用即可。

## 7. 与既有管线/其它子系统的关系
- **docx 导入（功能项 I）依赖本 spec**：I 的 `docx_commit` 产出的 `.md` 里脚注/合并表，落库后用 NoteLume 编辑器打开即无损可编辑（不再仅源码态）。I 的校对预览仍独立用 `html:true` 渲染器，不受本 spec 影响。
- **站点导出（site-export）**：共用同一 `tokenizer`。加 footnote 插件后，导出站也顺带能渲染脚注（净增益）；但 `site-export` 走 `.render()` 且本 tokenizer 仍 `html:false` → **合并表的 `<table>` HTML 在静态站会被转义**（现状即如此，非本次回归）。若要让站点也渲 HTML 表，属导出侧小改，**本 spec 不做**、留作 I 的落地补记风险项。
- **F2（registerNodeSpec）**：本 spec 是**构建期**给核心 schema 加节点，与"F2 运行时插件加 spec（受不可变约束）"是两回事、不冲突；反而为 F2 探明"装配期统一建 schema"的路子。

## 8. 诚实边界
- 脚注正文/合并表单元格内容受 `inline*` 约束：**单元格/脚注内的多段落、块级列表不承载**（会并成单段）。对 Word 常见脚注与合并表足够；极端富单元格不保证。
- **两阶段 HTML 表解析是新增且最脆的一环**（尤其它绕开 markdown-it 自己扫描），故必须先 spike；若 spike 证明脆弱，**回退方案** = 合并表在编辑器里以"只读富对象"承载或退回"仅源码态"（即恢复功能项 I §11 的原取舍），但不阻断脚注部分。
- 静态站暂不渲染合并表 HTML（见 §7），如需另议。

## 9. 测试策略（`roundtrip` 为门禁核心）
- **`src/tests/roundtrip.test.mjs`（扩）**——既有 GFM 用例**必须仍全过**（证明未回归）：
  - 脚注：`[^1] 正文 … [^1]: 注` → ref+section → 再序列化，**结构稳定**（幂等、可重解析）；多脚注、增删重排序号。
  - 合并表：`<table>` 带 colspan/rowspan → table 节点（合并属性保真）→ 再序列化仍为等价 HTML；**无合并表 → 仍产 GFM**（防误升级）。
  - 代码块内含 `<table>` 字面量**不被预处理误吞**。
- **`nodeView`/命令**：`insertFootnote` 建 section+item、点击角标定位、`mergeCells/splitCell` 命令在选区下生效（以 ProseMirror 事务级断言，无 DOM 依赖部分优先）。
- **门禁**：`roundtrip` 全绿 + 其余 node 测试全过 + `npm run build` 无错（本功能无 Rust，不需重启 tauri dev）；手测：在编辑器手打脚注、合并几格、存盘重开不坏。

## 10. 落地分相（代码/文档分 commit）
- **P0 Spike**：最小验证"两阶段 HTML 表 ↔ prosemirror-tables round-trip"与 footnote 插件并入主 tokenizer 的可行性/健壮性；结论回写本 spec §11。
- **P1 脚注**：dep + 节点 + parser tokens + serializer + `src/footnotes.js` 命令/nodeView + roundtrip 用例。
- **P2 合并表**：`serializeTable` 分支 + 预处理解析 + merge/split 挂载 + roundtrip 用例。
- **P3 文档**：README/CHANGELOG/ROADMAP 记功能项 J、本 spec 落地补记；并回填功能项 I 对 J 的依赖（软化其 §11 取舍）。

## 11. Spike 结论（P0 后回填，占位）
- 待 P0：两阶段 HTML 表解析是否稳（代码块规避、切片插入位）；footnote 插件对既有 commonmark 行为零影响确认；merge/split 与 columnResizing 事件优先级。若不稳 → 启用 §8 回退方案。
