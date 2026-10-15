# 子项目② 详细设计：docx→md 公式解析（OMML→LaTeX）

- 状态：详细设计（可实现，待 writing-plans 出计划）
- 日期：2026-10-16
- 隶属：批次 F 总分解设计（见 `2026-10-16-docx-export-math-design.md`）之子项目②
- 原则锚定：纯 Rust、零外部二进制；映射核心为**纯函数**（入 roxmltree 节点、出 md 片段 + warnings，不碰 IO，可单测）；与既有 `docx_import.rs` 风格同构。

## 一、背景与目标

`docx_import.rs` 当前**完全不处理数学**：`map_inline_children`（docx_import.rs:593）无 `m:oMath` 分支，Word 里的公式（OMML）被静默丢弃。本子项目补齐**导入方向的数学**：把 OOXML 的 OMML 公式解析为 Markdown 的 LaTeX 数学（行内 `$..$`、块级 `$$..$$`），且产物必须能被编辑器现有的 math tokenizer 规则原样读回（保证入库后 KaTeX 可渲染、往返稳定）。

范围**仅导入**（OMML→LaTeX）。写侧（LaTeX→OMML）是子项目③，不在本 spec。

**成功标准**：给定真实 Word 公式，导入后 md 里出现语义正确的 LaTeX 数学；无法覆盖的构造**降级为可见文本 + warning，绝不静默丢内容**。

## 二、范围

**包含**：§五 映射表列出的 OMML 构造 → LaTeX；`DocxStats.math` 计数；未覆盖构造的降级 + warning。

**不包含（YAGNI / 属③或其它子项目）**：LaTeX→OMML 生成（③）；OMML 写出；公式渲染（前端 KaTeX 已负责，导入侧只产 LaTeX 文本）；MathML 输入（Word 只产 OMML，不接 MathML）；图片形式公式（Word 里极少数以 OLE/图片存的公式，仍按 drawing 走既有图片逻辑，不在数学范围）。

## 三、落点与接口改动（全部在 `docx_import.rs`，纯前端零改动）

1. **命名空间常量**：新增 `const M: &str = "http://schemas.openxmlformats.org/officeDocument/2006/math";`
2. **命名空间感知 helper**（数学解析专用，**不复用** `is_el`/`child`，见 §四）：
   - `fn is_mel(n: Node, name: &str) -> bool` — 元素且 `namespace()==Some(M)` 且局部名==name。
   - `fn mchild<'a,'i>(n, name) -> Option<Node>` — 首个 `is_mel` 子元素。
   - `fn mel_children<'a,'i>(n, name) -> Vec<Node>` — 所有该局部名的 m 命名空间子元素（用于 nary 的 sub/sup、matrix 的 mr 等）。
3. **行内挂点**（`map_inline_children`, :593）：在既有 `else if` 链中新增
   - `else if is_el(node, "oMath")`（`oMath` 局部名唯一、无 `w:` 冲突）→ `flush_pending`；`out.push('$'); out.push_str(&omml_to_latex(node, ctx)); out.push('$');`（行内 `$..$`）。
   - `else if is_el(node, "oMathPara")` → 交给块级路径（见 4），行内遇到时按 `$$..$$` 内联并 warn（罕见混排）。
4. **块级挂点**（`push_paragraph`, :444，置于 heading 判定之后、等宽/列表判定之前）：若 `mchild(p,"oMathPara")` 存在且其余非空文本 run 皆为空白 → `blocks.push(Block::Math(omml_to_latex(该 oMath)))`；`oMathPara` 内可含多个 `oMath`，用 `\n` 连接（多式）。
5. **新块变体**：`enum Block`（:329）加 `Math(String)`；`compose`（:337）加分支 `parts.push(format!("$$\n{}\n$$", latex.trim()))`（保证与邻块以空行分隔，命中编辑器 `math_block` 块规则 editor-schema.js:481）。
6. **统计/告警**：`DocxStats`（:62）加 `pub math: u64`；每解析一个 `oMath`（含块级内嵌）自增；降级 `ctx.warn("math", "...已降级", <locator>)`。
7. **解析器主函数**：`fn omml_to_latex(n: Node, ctx: &mut Ctx) -> String`——对 `oMath` 节点，按文档序遍历其**结构子元素**并拼接各自 LaTeX；叶子文本走 run 分支。

## 四、命名空间冲突（必须处理的坑）

`is_el`（:118）只比局部名、**命名空间无关**：OMML 的 `m:r`/`m:t` 与 Word 的 `w:r`/`w:t` 局部名相同。数学子元素**只能**用 §三.2 的 `is_mel/mchild` 访问；容器递归时也不得对数学节点调用通用 `map_run`/`mergeable_run`（它们按 `w:` 语义解释 `rPr/t`）。`oMath`/`oMathPara` 局部名全局唯一，外层 dispatch 用 `is_el` 判定安全（`m:r` 不会是 `w:p` 的直接子，冲突面在 `oMath` 内部，已被隔离在数学解析器里）。

## 五、OMML→LaTeX 映射表

约定：`e`/`num`/`den`/`sub`/`sup` 等为其操作数子元素（递归转 LaTeX）。跳过任何 `*Pr` 内的 `m:ctrlPr`（控制字形格式，非内容）。`m:r`→取其中所有 `m:t` 文本拼接（`m:t` 已由 roxmltree 解实体）。

| OMML | 结构 | LaTeX |
|---|---|---|
| `m:r`/`m:t` | 文本 run | 原样文本（KaTeX 变量默认斜体，不显式加 `i`） |
| `m:f` | `m:num`,`m:den` | `\frac{num}{den}` |
| `m:sSup` | `m:e`,`m:sup` | `{e}^{sup}` |
| `m:sSub` | `m:e`,`m:sub` | `{e}_{sub}` |
| `m:sSubSup` | `m:e`,`m:sub`,`m:sup` | `{e}_{sub}^{sup}` |
| `m:rad` | `m:radPr/m:degHide`,`m:deg`,`m:e` | degHide 开→`\sqrt{e}`；否则 `\sqrt[deg]{e}` |
| `m:nary` | `m:naryPr/m:chr`(默认∫),`m:sub`,`m:sup`,`m:e`；`hideSub/hideSup` 省略 | `\sum_{sub}^{sup} e`（chr→算子名，见下） |
| `m:d` | `m:dPr/m:begChr,endChr`,`m:e`+（多 e 以 `m:sepChr` 默认 `,` 拼） | `\left<beg> e_1, e_2 \right<end>`（delim 映射见下；空 beg/end→`\left. \right.`） |
| `m:acc` | `m:accPr/m:chr`(默认 ̂),`m:e` | `\hat{e}`（chr→重音命令，见下） |
| `m:func` | `m:fName`(含 m:r 函数名),`m:e` | `\sin e` 等（名映射 `\sin\cos\tan\log\ln\lim...`；未知→原样） |
| `m:limLow` | `m:e`,`m:lim` | e=="lim"→`\lim_{lim}`；否则 `\underset{lim}{e}` |
| `m:limUpp` | `m:e`,`m:lim` | `\overset{lim}{e}` |
| `m:m`(矩阵) | `m:mr`*，每 `m:mr` 内 `m:e`* 为单元格 | 行 `\\`、列 `&` 分隔；环境按外层 `m:d` delim 选：()→`pmatrix` []→`bmatrix` {}→`Bmatrix` \|→`vmatrix` ⟨⟩→`Vmatrix`，否则 `matrix`；`\begin{env}…\end{env}` |
| `m:eqArr` | `m:eqArrPr/m:align`,`m:e`* | `\begin{cases} e_1 \\ e_2 \end{cases}`（常作 `m:d`{左大括号} 内层） |
| `m:bar` | `m:barPr/m:pos`(overline/underline),`m:e` | `\overline{e}` / `\underline{e}` |
| `m:groupChr` | `m:groupChrPr/m:chr`(⏞⏟),`m:e` | chr∈{⏟,下}→`\underbrace{e}`；⏞{上}→`\overbrace{e}` |
| `m:borderBox`/`m:box` | `m:e` | `\boxed{e}` |
| `m:r` 内 `m:rPr` | `m:nor` / `m:sty`(p/b/i)/`m:scr`(script/fraktur/doubleStruck) | `m:nor`→`\mathrm{…}`；`m:scr` doubleStruck→`\mathbb{}`、script→`\mathcal{}`、fraktur→`\mathfrak{}`；`m:sty` b→`\mathbf{}`；缺省不包 |

**nary chr 映射**：∑`\sum` ∏`\prod` ∐`\coprod` ∫`\int` ∬`\iint` ∭`\iiint` ∮`\oint` ⋀`\bigwedge` ⋁`\bigvee` ⋂`\bigcap` ⋃`\bigcup` ⨁`\bigoplus` ⨂`\bigotimes` ⨄`\biguplus`；未列→原字符。
**accent chr 映射**：̂(U+0302)`\hat`  ̃(U+0303)`\tilde`  ̄(U+0305)/‾`\bar`  ˙(U+02D9)`\dot`  ¨(U+00A8)`\ddot`  ⃑(U+20D7)`\vec`；未列→该字符前置 + warn。
**delim 映射**：`(`→`(`,`)`→`)`,`[`→`[`,`]`→`]`,`{`→`\{`,`}`→`\}`,`|`→`\|`,`⟨`→`\langle`,`⟩`→`\rangle`；未列→原字符（转义 `\{\}` 仅花括号）。

## 六、降级策略（绝不静默丢）

- **未知/未覆盖的容器元素**（如新出现的 `m:limUpp` 变体、`m:eqArrPr` 之外结构）：递归其 `m:e`（或全部子）取内容文本级 LaTeX 拼接，`ctx.warn("math","OMML 构造 <名> 未支持，已降级为内容拼接", 局部名)`。
- **无法成文的孤立字符/字体**：原样进 `m:t` 文本。
- **inline 与 block 的 `$` 冲突**：LaTeX 串若含裸 `$`→转义 `\$`（罕见），防断数学区间。

## 七、输出格式对齐（往返稳定的关键）

产物必须被编辑器 tokenizer 读回：块级用 `$$` 独占起止行（editor-schema.js:481 `math_block` 规则要求首行仅 `$$`、尾行仅 `$$`），行内用 `$..$`（:460 附近 `math_inline`，单行无换行）。故 `Block::Math` compose 严格产 `$$\n<latex>\n$$`；行内 `$<latex>$` 内 latex 不含裸换行（容器递归把换行折叠为空格）。

## 八、测试方案（Rust `cargo test`，映射核心纯函数）

- **测试基建**：`mod tests` 的 `doc(body)`（:1484）root 元素加 `xmlns:m="{M}"`（数学样例必需；对既有非数学用例无副作用）。新增便捷 `fn math(body)->String` 直接返回 md。
- **黄金用例表**（每构造 ≥1 例，断言 md 含预期 LaTeX 子串）：分数、上下标、根号(带/不带次数)、nary(∑带上下限 / ∫隐藏上限)、定界符(圆/方/花/无)、重音(hat/vec)、函数、limLow、矩阵(带 pmatrix delim)、eqArr/cases、bar、underbrace、box、`m:scr`→`\mathbb`。
- **组合例**：`\frac{1}{\sqrt{2}}`、`x_i^2`、`\sum_{i=1}^{n} i`、内联嵌入句 `"设 $a+b$ 则"`。
- **块级**：仅含 `oMathPara` 的段→ `$$\n..\n$$`；验证与前后段以空行分隔。
- **stats/warnings**：解析 N 个 oMath→`stats.math==N`；喂一未知构造→有 `code=="math"` warning 且不丢内容。
- **回归**：全量 `cargo test` 绿；`docx_import` 既有 15 测试不破（因 doc() 仅加命名空间声明，不改语义）。
- 说明：`src/tests/docx-import.test.mjs` 测的是**前端编排**，本子项目**不动它**（无前端改动）。

## 九、验收标准

1. `cargo test` 全绿（含新增数学用例）。
2. 拿真实含公式 Word 文档走 `docx_preview`：公式在 md 中为正确 LaTeX，无静默丢失；未支持项有 warning。
3. 该 md 在编辑器打开后，`$$`/`$` 被识别为 math_block/math_inline 并可 KaTeX 渲染（人工抽验 ≥3 例）。
4. 不引任何新依赖；纯 Rust；`npm run build` 不受影响（无前端改动）。
5. CHANGELOG 记 `Added`：docx→md 支持公式（OMML→LaTeX）解析。

## 十、风险

- **OMML 真实形态多样**：不同 Word 版本/编辑器产生的结构有别（如 `m:naryPr` 的 `limLoc` undOvr vs subSup 影响 `\sum` 上下限摆放）。以黄金样例先覆盖主流，边角走降级 + 逐轮补。
- **"尽量全"无界**：以 §五 映射表 + 语料基线为验收锚；未入表者明确降级，不追求穷尽。
