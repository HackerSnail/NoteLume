# 批次 F 后续设计：Word 导入的交叉引用 + 多级列表

- 状态：设计待评审
- 日期：2026-10-16
- 决策原则锚定：纯文件、无损互操作（GFM/Obsidian）；不引 UI 框架；复用优先；跨实现一致性用 fixture 锁死

## 一、背景与目标

Word 文档里有两类结构，当前 docx→md 导入处理得不完整：

1. **交叉引用**（`REF`/`PAGEREF`/`NOTEREF` 域 + 书签锚点超链接）：Word 里可点击跳到某标题/图/表/公式。今天导入后**降级为可见纯文本**（域码 `w:instrText` 被 `map_run` 忽略、结果文本保留，所以不泄漏，但链接语义丢失）。
2. **多级列表**（`w:numPr` 的 `ilvl≥2`）：为规避"缩进代码块误判"（commit `03985b8`），深度被 `.min(1)` **刻意封顶 1 级**（`docx_import.rs:587`），≥2 级嵌套被压平。

本批目标：
- 交叉引用 → 指向**标题**的引用转成可点击的**内部锚点链接** `[可见文本](#slug)`，并在**编辑器内点击跳转**、在**导出静态站**中真正可跳；指向图/表/公式等非标题目标的引用**保持可见文本 + 告警**。
- 多级列表 → **放开到任意深度**，按标准 2 空格/级嵌套，同时重设防误判护栏并回归验证。

## 二、为什么这是 architectural

"`#slug` 链接能跳转"依赖三处算出**逐字符相同**的标题锚点：导入侧写 `#slug`、站点导出给 `<h*>` 发 `id=slug`、编辑器点击按 slug 反查标题位置。任一实现偏差即退回死链。故新增一份**跨语言共享约定**（heading-anchor slug）+ 一个前端新能力（链接点击跳转），跨 3 子系统、改动被他人依赖的接口（锚点格式）。

## 三、范围

**包含**
- 导入侧：标题锚点预扫描 + 书签→标题映射；复杂域（`fldChar`/`instrText`）状态机；`fldSimple`、`w:anchor` 超链接的标题类引用转 `[文本](#slug)`；非标题引用降级 + `xref` 告警与计数。
- 多级列表：去深度封顶，`base` 归一化保留；回归覆盖"深列表不判代码块"。
- 站点导出：`R.heading` 给标题发 `id`，含同文档重名 dedup。
- 编辑器：`#anchor` 链接点击 → 匹配标题 → 复用 `jumpToPos` 语义滚动定位。
- 测试：跨语言 slug fixture 双边断言；导入/导出/编辑器各自单测；端到端人工回归。

**不包含（YAGNI / 后续）**
- 指向图/表/`SEQ` 公式的引用转链接（markdown 无跨元素引用原语，仅标题有锚点落点）。
- 交叉引用的**反向**（导出 md→docx 时重建 Word 域）——不在本批。
- 跨文档 `#` 链接（跨笔记仍走 wikiLink，不动）。
- Word 自动编号标题的"序号文本"还原（既有导入限制，标题正文不含 `3.2`，与锚点无关）。

## 四、共享约定：heading-anchor slug（命门）

### 4.1 规则（GitHub 风）
输入 = 标题**纯文本**（已剥去 `**`/`_`/`` ` ``/`~~` 等行内标记，仅可见文字）。逐字符：
1. 转小写：仅对 ASCII `A-Z`；非 ASCII（含 CJK）原样保留大小写。
2. 删除字符：除「字母、数字、CJK、空格、`-`、`_`」外的标点与符号全部丢弃（如 `.` `，` `：` `(` `)` `（` `）` `"` 等）。
3. 空白折叠：连续空格/制表 → 单个 `-`；首尾的 `-`/空格裁掉。
4. 重名 dedup：同文档内按出现顺序，第二次起的同 slug 追加 `-1`、`-2`……（GitHub gutter 规则；首个不加后缀）。

例（作为 fixture 契约的一部分，非穷举）：
- `第 3 节 概述` → `第-3-节-概述`
- `Hello, World!` → `hello-world`
- `3.2 方法（一）` → `32-方法一`
- 两个同名 `引言` → 第一个 `引言`、第二个 `引言-1`
- 标题含 `**粗**体` → 纯文本 `粗体` → `粗体`

### 4.2 单一事实源与一致性锁
- **JS**：新增 `src/heading-anchor.js`，导出：
  - `anchorSlug(plainText) -> string`（规则 1-3）
  - `slugAllInOrder(plainTexts: string[]) -> string[]`（叠加规则 4 dedup，按数组顺序）
  - `headingPlainText(...)` 由各消费方按自身表示提供（见 §6/§7）。
  - site-export 与编辑器**必须** import 本模块，不得各写一份。
- **Rust**：`docx_import.rs` 内镜像 `heading_anchor_slug(plain) -> String` + `assign_anchors(&[plain]) -> Vec<String>`（dedup）。
- **跨语言 parity**：共享 fixture `src/tests/fixtures/heading-slug.json`：
  `[{ "in": ["标题A","引言","引言","3.2 方法（一）"], "expected": ["标题a","引言","引言-1","32-方法一"] }, ...]`。
  - Rust 测试读该 JSON 断言 `assign_anchors`。
  - JS 测试读同一 JSON 断言 `slugAllInOrder`。
  - 任何一方改规则而不同步 → 双边测试红。CJK/emoji/组合字符用例必须进 fixture。

## 五、架构与数据流

```
导入（Rust docx_preview）：
  预扫描正文段落（含 sdt 递归）
    → 收集有序标题纯文本 → assign_anchors 得 slug 表
    → 登记落在标题段内的 bookmarkStart 名 → slug（Ctx.xref_anchor）
  map_body 逐段映射：
    段落/列表/表格内联遇到：
      复杂域(fldChar/instrText) / fldSimple / w:anchor 超链接
        → 解析目标书签名 → 命中 xref_anchor ? [结果文本](#slug) : 结果文本(+xref告警)
    numPr 列表 → depth = ilvl - base（不封顶）
  compose 出 md（含 ## 标题 与 [..](#slug) 链接）

站点导出（site-export.js）：
  R.heading：按文档序对每个标题纯文本 dedup 发 id=slug  ← 与导入同一 slugAllInOrder

编辑器（ProseMirror 插件）：
  点击 <a href="#x"> → 走 doc 收集标题纯文本(序) → slugAllInOrder → 找 ==x 的 heading 位置 → jumpToPos
```

三者都调用**同一** `slugAllInOrder`（或 Rust 镜像）且顺序=文档序，故锚点必然一致。

## 六、组件划分

### Rust 导入（`src-tauri/src/docx_import.rs`）
- **`Ctx` 增字段**：`xref_anchor: HashMap<String,String>`（书签名→`#slug`，含前导 `#`）。`DocxStats` 新增两计数 `xref_resolved`/`xref_degraded`（与其他字段同样进预览回显）；非标题引用逐条 `ctx.warn("xref", ...)`。
- **预扫描 `scan_headings_and_bookmarks(doc, ctx)`**：在 `map_body` 前调用（`docx_preview:1788` 与测试 `map_parts` 各一处）。
  - 顺序遍历 body（复用 `push_children_blocks` 的 sdt 递归骨架，只遍历不产出块）。
  - 判标题：与 `push_paragraph:505-516` 同一逻辑（style outline / name 前缀 `heading `）。
  - 标题纯文本：只读该段 `w:t` 拼接（**不调 `map_inline`**，零副作用），剥标记即纯文本本身（`w:t` 无 markdown 标记）。
  - 落在标题段 `w:p` 子树内的 `bookmarkStart@w:name` → 记 `xref_anchor[name]=#slug`（同段多个书签都映射到该标题）。
  - dedup 用 `assign_anchors` 对有序标题串一次算出，保证与正文标题顺序一致。
- **复杂域状态机**（`map_inline_children:1067`）：在 per-`w:r` 分支前插入 fldChar/instrText 处理：
  - 局部栈 `field_stack: Vec<(instr_buf, result_buf, phase)>`，phase∈{Code,Result}。
  - run 含 `fldChar begin` → flush pending → push 新帧（Code）。
  - run 含 `instrText` 且栈顶 phase=Code → 追加到 instr_buf，**不产出**。
  - run 含 `fldChar separate` → 栈顶转 Result。
  - run 含 `fldChar end` → 弹栈并 finalize：解析 instr_buf（`REF|PAGEREF|NOTEREF` + 首个非引号 token 为目标名）→ 命中 `xref_anchor` 则把 result_buf 包成 `[result](#slug)`（xref_resolved++），否则原样输出 result_buf（若为非标题 REF 则 xref_degraded++ 并告警 `xref`）。
  - 栈非空且 phase=Result 时的普通 run → 文本并入 result_buf（而非 `out`）。
  - 嵌套：多帧；begin/end 计数防失配（多余 end 忽略）。
  - 现有 `fldSimple`/`hyperlink` 分支保持递归调用本函数（其内部若有 fldChar 也能处理）。
- **`fldSimple:1105`**：读 `w:instr` → 目标名；子节点渲染进临时串 `temp`（沿用递归）；命中 → `out.push([temp](#slug))`，否则 `out.push(temp)`；TOC 告警保留。
- **`hyperlink` 内锚点:1086**：当 `w:anchor` 存在且无有效 `r:id`（或 `r:id` 不在 rels）：命中 `xref_anchor[anchor]` → `[inner](#slug)`；否则维持现状（输出 inner）。
- **多级列表:587**：`let depth = ilvl.saturating_sub(base);`（去掉 `.min(1)`）。base 归一化（585）保留。护栏不变：列表行必带 marker，且每段连续列表 depth 从 0 起 → 不会孤立出现 ≥4 空格起始行。
- **compose:400**：`"  ".repeat(indent)` 对任意 indent 生成正确嵌套（无需改）；确认非列表段落仍走 `Block::Para`（不缩进）——代码块误判只可能来自 Para，与列表无关。

### 前端 site-export（`src/site-export.js`）
- 新增 `R.heading` 渲染规则（`ensureRenderRules`）：渲染 `<hN ... id="slug">inner</hN>`。
  - 标题纯文本：markdown-it heading 的 inline token（`type==='inline'`）拼接其子节点中 `type==='text'` 的 `content`（跳过 code_open/close 等标记 token），即得渲染后纯文字→plain（与 §4.1/§7 定义一致）。
  - dedup：`env.__anchorCounts` per-doc map，`slugAllInOrder` 语义在渲染流里用增量计数复刻（保证与整篇预扫描同结果——标题渲染即文档序，逐条 dedup 等价）。
- import `heading-anchor.js`。

### 前端编辑器（`src/editor-view.js` + 新 `src/anchor-link.js`）
- 新插件/`handleDOMEvents.click`（或 `handleClickOn`）：
  - 命中点击目标为 `<a href="#x">`（PM 链接渲染）→ `preventDefault`。
  - 走 `view.state.doc` 顺序收集 heading 节点纯文本（`node.textContent`，天然无 markdown 标记）→ `slugAllInOrder` → 找 `==x` 的 heading → 其位置 `pos`。
  - 复用大纲跳转：`editor.jumpToPos(pos)`（含 unfold 覆盖节、设 TextSelection、scrollIntoView）。
  - 找不到目标（旧链接/无匹配标题）→ 不跳转（不误报），可选状态栏提示。
- `headingPlainText` 对编辑器 = `headingNode.textContent`（已在 §4.1 纯文本域内）。

## 七、数据流细节：锚点纯文本三边定义（防漂移）

| 侧 | 标题"纯文本"来源 | 是否含 markdown 标记 |
|---|---|---|
| Rust 预扫描 | 段落内所有 `w:t` 拼接（trim） | 无（Word run 文本本身即纯文本） |
| site-export | heading token 的渲染文本 | 需剥（源是 md） |
| 编辑器 | ProseMirror `heading.textContent` | 无（节点文本已剥离标记） |

三边都在"可见纯文字"域上运算，故同一标题得同一 slug。**唯一真值链**：编辑器与 site-export 读的是 Rust 写出的**同一份 md**，二者必须互相一致（这才是点击能否命中的关键）；Rust 的责任是让它写出的 `#slug` = 该 md 里对应 `## 标题` 经"剥标记→纯文本→slug"算出的值。

**统一实现规则（三边共用，无特例）**：标题 plain = 剥去行内 markdown 标记（`**`/`_`/`` ` ``/`~~` 等）后的可见文字，再套 §4.1 slug。
- 编辑器：`headingNode.textContent`——ProseMirror 节点文本天然无标记，直接即 plain。
- site-export：对 heading 的 inline token 拼接其**渲染后文本**（走与各渲染规则一致的取字路径），即 plain。
- Rust 预扫描：用轻量 `plain_text_of(p)`（只拼段落内 `w:t`、**不调 `map_inline`**，零副作用）。Word 标题 run 文本即纯文字（无 md 标记），`w:t` 拼接 = plain。

三边在同一无标记标题上必然相等；**含行内标记/脚注/上标的标题**用 fixture 用例锁定：若个别边界不平，以 site-export/编辑器实际读的 md 为最终真值，Rust 对齐它们（`strip_md_marks()` 把 `Block::Heading` 文本还原成同一 plain 作兜底）。

## 八、错误处理

- 域码失配（begin 无 end / end 无 begin）：按计数容错，最坏退化为"保留可见结果文本"，绝不吞正文。
- 目标书签不存在 / 指向非标题：保持可见文本 + `xref` 告警（不计失败）。
- 编辑器点击的 `#x` 在本文档无匹配标题：静默不跳（不当坏链处理，不弹错）。
- 多级列表：base 归一化确保首项 depth0；异常深层（如 ilvl 巨大）由 Word 侧本就罕见，saturating_sub 防下溢。

## 九、测试计划

**Rust（`cargo test`）**
- slug parity：读 `heading-slug.json` 断言 `assign_anchors`（含 CJK/重名 dedup/标点）。
- 复杂域 `REF _RefX`（begin/separate/end 结构）命中预扫描书签 → `[..](#slug)`。
- `PAGEREF`/`NOTEREF` 指向标题 → 链接；指向非标题 → 纯文本 + `xref` 告警。
- `fldSimple instr="REF _RefX …"` → 链接；`w:anchor` 超链接 → 链接。
- 域码失配不吞正文（结果文本仍在）。
- 多级列表：ilvl 0/1/2 连续 → depth 0/1/2，compose 出 0/2/4 空格；回归断言"深列表整节不被判为代码块"。
- 既有 102+ 测试无破坏（尤其 `03985b8` 那条缩进代码块回归仍绿）。

**前端（`npm run test:*`）**
- `heading-anchor.test.mjs`：读同一 `heading-slug.json` 断言 `slugAllInOrder`。
- site-export：给定含标题 md，渲染 HTML 每标题带正确 `id`（重名 dedup）。
- anchor-link：构造 doc（多标题），`buildAnchorMap(doc)` → 点击解析到正确 pos；无匹配返回不跳。

**端到端人工**：真实 Word（多级列表 + 交叉引用到标题/图）导入 → 编辑器内点链接跳转对应标题 → 导出整站 → 浏览器点开验证。

## 十、实现顺序（供 writing-plans 展开）

1. `heading-anchor.js` + Rust `heading_anchor_slug/assign_anchors` + 共享 fixture（先立契约，两边红→绿）。
2. Rust 多级列表去封顶 + 回归（独立、低风险，先落）。
3. Rust 预扫描 + 书签映射 + 复杂域/fldSimple/anchor 转链接 + 告警/stats。
4. site-export `R.heading` 发 id。
5. 编辑器 anchor-link 点击跳转。
6. CHANGELOG + ROADMAP 批次 F 子项更新 + 端到端人工回归。

## 十一、已知限制（写 CHANGELOG）

- 仅标题类交叉引用转内部链接；图/表/公式引用降级为可见文本。
- 内部链接依赖"同文档标题锚点"约定；用户在编辑器手动改动标题文字会使既有 `#slug` 链接失效（与所有 md 锚点行为一致）。
- `PAGEREF` 转链接后落在标题（非页码定位，md 无分页概念）。
