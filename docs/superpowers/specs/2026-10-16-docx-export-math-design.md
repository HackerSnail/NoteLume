# 批次 F 总分解设计：md→docx 导出 + 双向数学（OMML↔LaTeX）

- 状态：分解设计（本轮只定三子项目的边界/接口/依赖/验收基线，不深入任一实现）
- 日期：2026-10-16
- 决策原则锚定：纯 Rust + 零外部二进制（延续导入侧功能项 I 哲学，**明确排除 pandoc/LibreOffice**）；无损互操作（GFM/Obsidian/Word）；复用优先（既有 `zip`/`roxmltree`/`sha2`/手写 `b64`、图片 sha256 去重、`docx_preview/docx_commit` 契约风格、`export_file` + save 对话框）；单一 md 语义源（构造判定只在编辑器模型发生一次）
- 这是"功能项 I（docx→md）"的**逆过程 + 数学补全**。用户定的保真档：**全保真（对齐导入侧全集）**；数学范围：**尽量全（不设子集上限）**。

## 一、背景

现状：`src-tauri/src/docx_import.rs` 已实现 docx→md 的 OOXML→Markdown 映射（标题/段落/粗斜删/列表/任务/引用/行内码/围栏码/链接/图片/GFM 表含合并单元格/脚注），但**完全没有处理数学**——`map_inline_children`（docx_import.rs:593）无 `m:oMath` 分支，Word 公式被静默丢弃。导出方向（md→docx）尚不存在。

本批次补齐三块能力，因其规模与可独立交付性，拆成三条子项目，各自走 spec→plan→实现→验收。

## 二、两个决定接口的地基事实（已核对）

1. **md 源与方言全在编辑器模型里**：前端 `editor-schema.js` 的 ProseMirror 文档已理解每一种 NoteLume 构造（wikilink / tag / math / callout / footnote / 合并表），存盘内容即其序列化结果。Rust 侧只有 docx→md，**没有 markdown 解析器**。
2. **数学的 LaTeX 已被 KaTeX 解析**：`math_inline`/`math_block` 节点携带 `latex` 属性（editor-schema.js:147/174），前端用 KaTeX 渲染。→ 对"尽量全"的 LaTeX→OMML，**复用 KaTeX 解析树**远优于在 Rust 从零手写 LaTeX 解析器（KaTeX 本身即成熟的大子集 LaTeX 解析器，这是"尽量全"能落地的唯一合理解）。

由这两点，**引擎切分**定案（见 §三）。

## 三、引擎切分（核心决策）

分工：**前端负责"理解语义"，Rust 负责"组装 OOXML 与落盘"。**

```
前端 (JS)                                      Rust
─────────────────────────────                 ─────────────────────────────
当前 ProseMirror 文档                           export_docx(IR, vaultRoot, outAbs)
  → 序列化为 Docx-IR (JSON 节点树)      ──IR──▶   → IR 映射为 docx-rs 文档
  · 所有方言构造已在此判定一次                      · Docx::build() 得 XMLDocx(字符串部件)
  · 图片只带库内 rel 路径                          · 读图片字节 + sha256 + 写 media + rels + content-types
  · 数学带 OMML 片段(③) 或纯文本(①)                · (③) document.xml 占位符 → 注入 OMML + 声明 xmlns:m
                                                   · zip 打包落盘 → 返回 { 路径, warnings, stats }
```

理由：
- Rust 不重新解析 markdown，避免"两套 md 语义"漂移；导出口径与存盘内容永远一致。
- docx-rs **原生不支持数学**（结构体全清单无任何 `Math`/`oMath`/`m:` 元素，段落/Run 子元素是封闭枚举，无原始 XML 逃生口）。数学靠 `Docx::build()`→`XMLDocx`→**字符串后处理注入 OMML**绕开——已验证部件即字符串、`zip`(deflate) 可写，可行。
- docx-rs **能写**脚注（`Footnote`/`Footnotes`/`FootnoteReference`）与合并单元格（`GridSpan` 横向 + `VMerge`/`VMergeType` 纵向）——已核对，无需为此手搓 XML。

备选（未采纳）：md→docx 全在 Rust——要么引 md 解析器 crate（违背"零新依赖"倾向）、要么放弃 KaTeX 现成 LaTeX 解析（与"尽量全"矛盾）。

## 四、三条子项目

### 子项目① 结构导出（md→docx 骨架，数学此阶段降级为文本）

- **范围（包含）**：标题(1-6)/段落/粗/斜/删/行内码/围栏代码(等宽)/引用/有序无序任务列表/链接/**图片**(rel→Rust 读字节→media+rels+content-types，sha256 去重)/GFM 表含**合并单元格**/脚注；NoteLume 方言：frontmatter(剥离或转元数据)、wikilink(解析为链接或降级)、callout(转引用/段落)、tag(降级文本)。数学先当等宽纯文本。
- **接口**：新命令 `export_docx`（前端产出 IR）；UI 入口在 `▾ 更多` 菜单加"导出 Word(.docx)"，复用 save 对话框（与单篇 HTML 导出并列）。命令契约风格对齐 `docx_preview/docx_commit`（返回 warnings/stats；导出为单篇一步落盘，不强制两段校对）。
- **验收基线**：IR→docx 后用**现有导入引擎** `docx_preview` 读回，结构等价（回环）；纯映射逻辑单测放 JS（仿 `site-export.test.mjs`）+ Rust 集成回环测试。`npm run build` 与 `cargo test` 全绿；不引新 Rust 依赖（docx-rs 为唯一新增，见 §六）。

### 子项目② 导入公式（OMML→LaTeX，**完全独立**）

- **落点（已定位）**：`docx_import.rs` 的 `map_inline_children`（第 593 行）新增 `oMath`/`oMathPara` 分支 + 一个递归 OMML→LaTeX 函数（纯函数，便于单测，与既有映射核心同构）。
- **必须处理的坑**：`is_el`（docx_import.rs:118）只比局部名、**命名空间无关**；OMML 的 `m:r`/`m:t` 与 Word 的 `w:r`/`w:t` 局部名撞车 → 数学解析器需**命名空间感知**匹配（用 `(M, "r")` 形式或判 `node.namespace()`），不可复用现有 `is_el`。
- **产出**：行内 `$..$`、块级 `$$..$$`（KaTeX 可渲染的 LaTeX）；新增 `DocxStats.math`；未覆盖构造 `ctx.warn("math", ...)` 并降级为可见文本。
- **支持构造**（起步核心，逐轮扩，"尽量全"以语料基线驱动）：`m:r/m:t`(文本 run)、`m:f`(分数)、`m:sSup/m:sSub/m:sSubSup`(上下标)、`m:rad`(根号)、`m:nary`(∑∫∏ 大运算符)、`m:d`(定界符)、`m:acc`(重音)、`m:func`(函数名)、`m:limLow/m:limUpp`(极限)、`m:m`(矩阵)、`m:eqArr`(方程组)。
- **验收基线**：真实 Word 公式 docx 样本 → 预期 LaTeX 的黄金用例表（Node/Rust 皆可）；与③组成 LaTeX→OMML→读回→LaTeX 回环。独立可先做先验收。

### 子项目③ 导出生成公式（LaTeX→OMML，**依赖①骨架**）

- **做法**：前端用 **KaTeX 解析树 → OMML** 生成器（JS），产出 OMML XML 片段随 IR 交给 Rust；Rust 在 `Docx::build()` 得到的 `document.xml` 字符串上，把数学占位符替换为 OMML（并确保根元素声明 `xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"`），再 zip 落盘。
- **复用**：①的骨架、打包、图片/脚注/表格逻辑；只增"OMML 生成 + 注入"一段。
- **验收基线**：导出的 .docx 在 Word 里是**可编辑公式对象**（非图片/纯文本）；与②回环。"尽量全"以共享公式语料基线驱动，凡基线内公式 round-trip 保真。

## 五、依赖与排序

```
② 导入公式  ──(独立，随时可做)
① 结构导出  ──▶ ③ 导出生成公式(依赖①骨架与打包)
共享：一份「公式语料基线」同时喂 ② 与 ③ 的回环测试
```

**推进顺序：② → ① → ③**（② 独立且是本轮新点名项，先摘；① 是原始诉求主体；③ 最硬放最后）。每条子项目后续各出独立 spec + plan。

## 六、依赖引入（唯一新增）

- `docx-rs`（crates.io，MIT，纯 Rust）：承担 OOXML 结构与打包（段落/表/图/脚注/编号/样式）。**Phase 0 闸口**：先验证 `cargo add docx-rs` 能拉入、`cargo tree` 不引 openssl、Windows MSVC 目标能编译；不通过则回退"纯手写 OOXML(复用 zip)"路线。
- 不引 pandoc、不引外部二进制；不引前端新框架（KaTeX 已在依赖内）。

## 七、风险与偏离声明

- **偏离**：导入侧当年特意排除 pandoc 走纯 Rust，本批次导出同样坚持纯 Rust（无偏离）；唯一新增依赖是 docx-rs（写侧库），与导入侧"读用 roxmltree、不引读侧库"的极简倾向相比多一个依赖，已记此声明。
- **"尽量全"的可验收性**：无界目标必须以**公式语料基线**锚定，否则无法宣布"完成"。基线由常见数学/物理/笔记公式构成，逐轮扩充；每轮以基线全绿为验收线。
- **docx-rs 成熟度**：0.4.x，中等；数学靠注入绕过，合并表/脚注需 Phase 0 实测其 writer 输出确可被 Word 正常打开。

## 八、本轮产出与下一步

本轮：本份总分解设计（提交入库）。
下一步：按 ②→①→③ 顺序，先为**子项目②（导入公式）**写可实现的详细 spec，再进 writing-plans。
