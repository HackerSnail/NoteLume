# 批次 F 子项目③ 后续设计：交叉引用可点击跳到「非标题」目标

- 状态：已实现并归档（对应 commit `cb6413c`；本文与已提交代码一致，作设计存档）
- 日期：2026-10-16
- 前置：扩展并接续 [`2026-10-16-docx-xref-multilevel-list-design.md`](2026-10-16-docx-xref-multilevel-list-design.md)（下称「③ 主设计」）。③ 主设计只让**标题**类交叉引用成为可点击内部链接，非标题目标（图/表/公式/参考文献）一律降级纯文本。
- 决策原则锚定：纯文件、无损互操作（GFM/Obsidian/Typora）；不引私有格式；不引 UI 框架；复用既有扩展模式（wikilink/tag/math 的自定义行内规则 + 合并表的行内 HTML 往返先例）。

## 一、背景与目标

③ 主设计落地后，用户拿真实论文回归时发现：正文点 `[52]` 无法跳到文末那条参考文献——因为参考文献条目是**普通段落/列表项**（非标题），标准 GFM 不给它锚点，故 ③ 主设计把它降级为纯文本。

本批目标：把内部锚点从「仅标题」扩展到「被交叉引用命中的非标题书签」，使 Word 里指向**图 / 表 / 公式 / 参考文献条目**的交叉引用（`REF`/`PAGEREF`/`NOTEREF` 域 + `w:anchor` 内部超链接）在**导入产物、编辑器、导出静态站**三处都能点击跳到那条目标。

覆盖范围（用户明确选定「所有非标题目标」）：图、表、公式、参考文献——它们本质都是「带书签、被引用、但不是标题」的同一类，机制统一。

## 二、为什么这是 architectural

「点 `[52]` 跳到参考文献」要求**引用处**与**目标处**在同一份 `.md` 里携带一个逐字符一致、且三处（导入写 / 编辑器读 / 站点读）都能识别的内部锚点。而标准 GFM 只给**标题**自动锚点，任意块没有原生锚点原语。要补上，必须新增一个被三个子系统共同依赖的**内部约定**（行内 HTML 锚 `<a id>` 的语义 + 编辑器承载它的 schema 节点），改动被他人依赖的接口。故 architectural。

## 三、范围

**包含**
- 导入：预扫描「被交叉引用命中、且正文确有对应 `bookmarkStart`」的非标题书签，分配锚点；在目标 `bookmarkStart` 处发行内 HTML 锚；引用转 `[可见文本](#id)`。
- 编辑器 schema：新增 `anchor` 原子行内节点 + markdown-it 行内规则 + 序列化（让锚点不被 `html:false` 当转义文本、且成为可跳转落点）。
- 编辑器跳转：`buildAnchorMap` 除标题外收集 `anchor` 节点（`id→pos`），复用既有 `#` 点击跳转。
- 站点导出：把 `anchor` token 渲染成原始 `<a id>`，使站点里 `#id` 可落。
- 测试：Rust 单测（存在/不存在/标题优先/超链接四类）；前端往返、buildAnchorMap、site 渲染。

**不包含（YAGNI / 后续）**
- 交叉引用**反向**（导出 md→docx 时重建 Word 域）——仍不在范围。
- 把 Word 的可见编号（如 `[52]`）从 SEQ 域结果**重算/校验**——本批只搬运域缓存结果文本，不重建编号逻辑。
- 从目标可见文本**派生**语义化 id（如 `#ref-52`）——采用净化后的**书签名**作 id（唯一、免重算、免 dedup 依赖文本）。
- 编辑器内锚点的可视化编辑交互（锚点是零宽原子节点，只作定位标记，不设计点选/删除的专用 UI）。
- 跨笔记 `#` 链接（跨文档仍走 wikiLink，不动）。

## 四、核心机制：两类锚点并存

一条 `.md` 里同时存在两种内部锚点，命名空间与生成方式不同，但**共用同一点击跳转入口**：

| 类别 | 目标 | 锚点 id | 落点如何产生 | 需重算 slug？ |
|---|---|---|---|---|
| A. 标题 | 非空标题段 | 标题纯文本经 `slugAllInOrder` 的 slug | 站点 `R.heading_open` 给 `<hN>` 发 `id`；编辑器 `buildAnchorMap` 顶层遍历标题反算 | 需要（三边共享 slug 契约，见 ③ 主设计 §四） |
| B. 非标题（本批） | 被引用的图/表/公式/参考文献 | **净化后的 Word 书签名**（`_RefNNN`） | 导入在目标 `bookmarkStart` 处**写死**字面 `<a id="X"></a>`；编辑器把它解析成 `anchor` 节点；站点原样渲染 | **不需要**——id 是 `.md` 里的字面量，三处逐字匹配 `#X`↔`id="X"` |

**为什么 B 类比 A 类简单**：B 类锚点自描述（写死在 `.md`），导入同时写「引用侧 `#X`」与「目标侧 `id="X"`」，两处同源，故无需跨语言重算，也不与标题的 slug 契约耦合。

**GFM 合法性**：`<a id="X"></a>` 是 CommonMark/GFM 明确允许的**行内 HTML**，与本项目合并单元格已在用的 `<table>` 行内 HTML 是同一先例；Typora / Obsidian / GitHub 都把它当合法锚点，**非私有格式**。

**净化与唯一性**：`sanitize_anchor(name)` 仅保留 `[A-Za-z0-9_-]`（其余丢弃），空则回退 `ref`；同名净化冲突在登记时按文档序 dedup `-1`/`-2` 保证唯一。Word 自动书签多为 `_Ref\d+`，本就全在保留集内。

## 五、架构与数据流

```
导入（Rust docx_preview）：
  scan_headings_and_bookmarks(body, ctx)：
    ① 标题预扫描 → assign_anchors → xref_anchor[标题书签] = #slug   （A 类，③ 主设计）
    ② scan_referenced_nonheading_anchors(body, ctx)：                （B 类，本批）
         一次 descendants 遍历收集：
           present  = 正文中出现的所有 bookmarkStart@name
           referenced = 被 REF/PAGEREF/NOTEREF(instrText/fldSimple) + hyperlink@w:anchor 引用的名字（文档序去重）
         对 referenced 中「present 且 不在 xref_anchor（非标题）」者：
           id = 净化+dedup → xref_anchor[name] = #id ; xref_emit.insert(name)
  map_body 逐段映射 map_inline_children：
    遇 bookmarkStart 且 name ∈ xref_emit → out += `<a id="{id}"></a>`   （目标处发落点）
    遇 复杂域/fldSimple/w:anchor 超链接 → finalize_xref：
        目标 ∈ xref_anchor → [结果文本](#锚点)（xref_resolved++）
        目标 ∉ xref_anchor → 结果文本（xref_degraded++ + xref 告警）    （含不存在书签）

站点导出（site-export.js）：
  R.anchor：anchor token → 原始 `<a id="X"></a>`；标题仍走 R.heading_open 发 id
  → `[文本](#X)` 在导出站里落到该锚

编辑器（ProseMirror）：
  parseMarkdown：`<a id="X"></a>` → anchor 原子行内节点（tokenizer 自定义行内规则，非转义文本）
  点击 <a href="#x"> → buildAnchorMap(doc)（标题 slug + anchor id）→ 命中 → jumpToPos(pos)
```

关键点：B 类引用 `[文本](#X)` 走**默认 markdown link**（编辑器渲染成 `<a href="#X">`，链接 mark 既有能力），点击入口与 A 类完全相同；差异只在 `buildAnchorMap` 多收集一批 `anchor` 节点。

## 六、组件划分（四处联动，缺一即坏）

### 6.1 Rust 导入（`src-tauri/src/docx_import.rs`）
- `Ctx` 新增字段：`xref_emit: HashSet<String>`（需「发 `<a id>`」的非标题被引用书签名）。`xref_anchor` 语义从「仅标题」扩展为「标题 slug ∪ 非标题净化书签名 → `#id`」。
- 新函数 `sanitize_anchor(name) -> String`。
- 新函数 `scan_referenced_nonheading_anchors(body, ctx)`：在 `scan_headings_and_bookmarks` 末尾（标题表已填好后）调用。
  - `present`（存在性）与 `referenced` 两个集合同在一次 `body.descendants()` 遍历里取。
  - 登记门槛：`present.contains(name) && !xref_anchor.contains_key(name)`——**先验存在性**，再让标题优先（已在表的跳过、不重复发落点）。
  - 净化 dedup 用局部 `used: HashMap<String,u32>`。
- `map_inline_children` 新增 `bookmarkStart` 分支：`name ∈ xref_emit` → `flush_pending` → `out.push_str("<a id=\"…\"></a>")`（取 `xref_anchor[name]` 去前导 `#`）。`bookmarkEnd` 忽略。
- `finalize_xref`：解析出的目标若在 `xref_anchor`（A 或 B 类）→ `[文本](#锚点)`；否则保持可见文本 + `xref` 告警。**降级语义由「指向非标题」收敛为「目标书签未找到」**（非标题现在能解析了）。

### 6.2 编辑器 schema（`src/editor-schema.js`）
- `extendedNodes` 追加 `anchor` 节点：`inline, group:'inline', atom:true, attrs:{id}`；`toDOM` → 空 `<a class="nl-anchor">`；`parseDOM` 读 `a.nl-anchor[id]`（复制粘贴往返）。
- tokenizer 新行内规则 `anchor`（`ANCHOR_RE = /^<a id="([^"]*)"><\/a>/`，仅认导入侧序列化的空锚形态；其余 `<a>` 交回默认规则）。
- `parserTokens.anchor` → `{ node:'anchor', getAttrs: tok => ({ id: tok.attrGet('id')||'' }) }`。
- `serializerNodes.anchor` → `state.write('<a id="' + escapeAttr(id) + '"></a>')`（原样写回，不转义 `<`）。

### 6.3 编辑器跳转（`src/anchor-link.js`）
- `buildAnchorMap(doc)`：保留顶层标题遍历（A 类 slug→pos）；**追加** `doc.descendants` 收集 `anchor` 节点（`id→pos`，`!map.has(id)` 令标题优先）。pos 语义与既有 `jumpToPos` 一致（跳转处 +1 进入目标）。

### 6.4 站点导出（`src/site-export.js`）
- `ensureRenderRules` 里加 `R.anchor = (tokens, idx) => { const id=tokens[idx].attrGet('id')||''; return id?`<a id="${escAttr(id)}"></a>`:'' }`。tokenizer 的 `anchor` token（`html:false` 下默认会被当转义文本）由此显式输出字面锚。

## 七、悬链接护栏（本批的命门）

**风险**：若对「被引用但正文里根本没有对应 `bookmarkStart`」的名字也发链，会产生 `[文本](#X)` 却无 `id="X"` 落点的**悬空内部链接**（点开什么都不跳，且比纯文本更糟——看起来是坏链）。

**护栏**：`scan_referenced_nonheading_anchors` 以 `present`（正文 `bookmarkStart` 全集）为**准入前置**。只有「被引用 ∧ 存在 ∧ 非标题」才登记发落点；不存在的仍走 `finalize_xref` 降级为可见文本 + 告警。

这同时保住了 ③ 主设计的既有测试：`ref_to_non_heading_degrades_with_warning`（目标书签 `_RefFig1` 不存在→仍降级）、`complex_field_without_separate_keeps_result`（`_Ref52` 不存在→仍 `[52]` 纯文本、`xref_degraded==1`）。

## 八、错误处理

- 目标书签不存在：可见文本 + `xref` 告警（与 ③ 一致）。
- 净化后名字为空：回退 `ref`，再经 dedup 加后缀，绝不产空 id。
- 引用与标题同名冲突：标题优先（A 类已占 `xref_anchor`，B 类登记时 `contains_key` 跳过）。
- `bookmarkStart` 出现在域结果区/表格单元格内等罕见位置：仅在被引用且存在时发锚；未被引用的书签不发，正文零污染。
- 编辑器点击的 `#x` 既非标题 slug 也无 anchor 节点：`buildAnchorMap` 无该 key → 静默不跳（既有行为）。

## 九、测试计划

**Rust（`cargo test`）**
- `ref_to_present_non_heading_becomes_link_with_anchor`：存在非标题书签 + REF（有 separate）→ 目标含 `<a id="_RefBib"></a>`、引用为 `[52](#_RefBib)`、域码不泄漏、`xref_resolved==1`、`xref_degraded==0`。
- `hyperlink_anchor_to_present_non_heading_becomes_link`：`w:anchor` 指向存在的非标题书签 → `[图 1](#_RefFig)` + 发锚。
- `heading_target_does_not_emit_a_id`：被引用书签落在标题上 → `[目标标题](#目标标题)`，**不**发 `<a id>`（标题自带锚点）。
- 既有回归不破：`ref_to_non_heading_degrades_with_warning`、`complex_field_without_separate_keeps_result`、`seq_field_without_separate_keeps_number`。

**前端（`npm run test:*`）**
- `roundtrip`：新增样本 `xref_anchor`（`<a id>` + `[文本](#id)`）幂等；结构断言 `<a id>` 解析为 `anchor` 节点（非转义文本）且序列化原样写回。
- `anchor-link`：`buildAnchorMap` 对含 `anchor` 节点的 doc，同时得标题 slug 与 anchor id→pos（pos 与 `descendants` 独立复算一致）。
- `site-export`：`<a id="_Ref52"></a>` 渲染为原始 `<a id>`（不被 `&lt;` 转义）、`[52](#_Ref52)` 渲染为 `href="#_Ref52"`。

**端到端人工**：真实论文导入 → 编辑器点正文 `[52]` 跳文末该条 → 导出整站 → 浏览器点开验证。含 Rust + schema → **须重启 `tauri dev` 并重新导入**方生效。

## 十、实现顺序（实际落地即此序，每步测试跑绿）

1. Rust 导入：预扫描 + `xref_emit` + `bookmarkStart` 发锚 + `finalize_xref` 语义调整 + 悬链接护栏 → `cargo test`。
2. `editor-schema.js`：`anchor` 节点 + 行内规则 + `parserTokens` + `serializerNodes` → `roundtrip`。
3. `anchor-link.js`：`buildAnchorMap` 收 `anchor` 节点 → `anchor-link`。
4. `site-export.js`：`R.anchor` → `site-export`。
5. CHANGELOG + ROADMAP「I 后续②」条目 + `vite build` + 全量前端测 + `cargo test` + commit/push。

## 十一、已知限制

- 锚点 id 用净化后的书签名（形如 `_Ref52`），不是语义化 `#ref-52`；够用、唯一、免重算，但可读性一般。若后续要美化 id，需同时改引用与目标两处（同源，风险可控）。
- 仅处理「正文里确有 `bookmarkStart`」的引用目标；Word 里引用悬空（书签已删）的仍降级纯文本。
- `PAGEREF` 转链接后落在目标锚点（非页码；md 无分页概念，与 ③ 一致）。
- 编辑器 `anchor` 为零宽原子节点，无专用编辑 UI；用户一般不会注意到它的存在。
