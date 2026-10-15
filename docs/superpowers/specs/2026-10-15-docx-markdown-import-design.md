# Word(.docx) → Markdown 导入 · 设计 spec

> 批次候选（尚未排入 A–G 字母批次，暂记 **功能项 I**）。目标产物：把本地 `.docx` **离线、零配置**转成 Markdown，经**逐个可视化校对**后落库，图片**自动提取 + 库内去重**。
> 定位：面向"手上有一堆 Word、要迁进知识库"的真实场景；不做云端、不做外部二进制依赖。

## 1. 现状与动机
- NoteLume 现有导入只做**文件搬运**（`isImportableFileName`/`importVaultFileFrom` 把文件复制入库），**不解析、不转换**内容。
- 无 pandoc / LibreOffice / mammoth 等相关代码。ROADMAP 原则 5 明令"外部二进制一律检测到才启用、不做硬依赖"——与"零配置"直接冲突。
- `.docx` 是 OOXML（ZIP + XML），**可纯应用内解析**，故能同时兑现"离线 + 零配置"；老式 `.doc`（二进制 OLE）离线零配置基本不可靠，**本设计不做**。

## 2. 关键决策（与用户协做敲定）
- **输入**：仅 `.docx`。遇 `.doc/.rtf` 明确提示"请用 Word 另存为 .docx"。
- **引擎**：**纯 Rust 自研 OOXML→Markdown 映射**（非 mammoth、非 pandoc）。唯一能兑现"离线+零配置+高保真"的路线，且落点契合"Rust 干文件活"。
- **工作流**：**每一次转换都经逐个可视化校对才落盘**（批量 = 队列，逐个弹校对，确认→落盘→下一个）。
- **图片**：**按文档分目录 + 内容哈希（sha256）去重**；库级 `hash→已落路径` 索引使"专属目录"与"同库只存一份"统一（命中即跨目录引用同一文件）。
- **产物契约**：**原样保真 Markdown**（真脚注 `[^n]`、合并表原样 `<table>` HTML）。**依赖前置功能项 J**（[编辑器无损扩展 spec](2026-10-15-editor-footnote-merged-table-design.md)）：J 落地后脚注/合并表可在 NoteLume 编辑器 **WYSIWYG 无损往返编辑**；J 未就绪前降级为仅源码态（见 §11）。
- **保真范围**：高保真（含合并单元格/脚注尾注/代码块/TOC/分栏文本框），超出 GFM 者降级为原样 HTML 并**逐条产 warning 交校对**。

## 3. 目标 / 非目标
> **前置依赖：功能项 J**（编辑器无损扩展·脚注+合并表）。本功能项 **应在 J 之后实现**（或至少在其回退方案下保证 WYSIWYG 不坏），否则导入产物中的脚注/合并表在编辑器里会被破坏。
**目标**：`.docx`→保真 Markdown；图片提取+去重落库；校对视图（预览/源码/警告）；批量队列编排；命名/frontmatter/冲突处理。
**非目标（Out of scope）**：`.doc/.rtf/.odt`；PDF；表格之外的复杂排版像素级还原；写入时自动渲染 footnotes/HTML 表进编辑器（属渲染侧、另议）；富文本样式编辑器（校对只改 Markdown 源）。

## 4. 架构与模块边界
- **后端（Rust）**：解析 docx、映射 Markdown、算图片哈希、（commit 阶段）写库。零外部二进制；新 lib 依赖 `zip`（读）+ `roxmltree`（XML）+ `sha2`（哈希）+ `base64`（图片字节跨 IPC）。
- **前端（Vanilla JS）**：批量队列编排 + 校对模态（预览/源码编辑/警告）+ 命名/去重索引 + 落库调用。**不含解析逻辑**。
- **两命令拆分**（尊重"校对后才落盘"）：`docx_preview`（**只转不写**，回 md + 图片字节 + 警告）→ 用户校对/编辑 → `docx_commit`（写 `.md` + 去重落图）。单文件一次调用，契合逐个节奏。

## 5. Rust 命令契约（serde camelCase）
```rust
struct DocxPreviewArgs {
    src_path: String,               // 用户经对话框选定的 .docx 绝对路径（库外可读，显式选择）
    dest_dir: String,               // 库内相对目录（"" = 库根）；决定 plannedDocRel 与图片相对引用基准
    title_override: Option<String>, // 覆盖标题；缺省由正文首个 H1→文件名派生
    dedup_index: HashMap<String, String>, // sha256hex -> 库内相对路径（前端维护、命中即引用不重存）
    with_frontmatter: bool,         // 是否注入 source/imported frontmatter
    max_image_bytes: u64,           // 单图内联上限（超限：写占位 + warning，不回字节，防 IPC 爆）
}
struct DocxPreview {
    md: String,                     // 保真 Markdown（未落盘，供编辑）
    planned_doc_rel: String,        // 预计 .md 库内相对路径，如 "My Doc/My Doc.md"
    title: String,
    images: Vec<ImportedImage>,     // 提取到的图片（含字节，commit 时回传）
    warnings: Vec<ConvertWarning>,  // 每项有损/不确定转换
    stats: DocxStats,               // words / images / tables / mergedTables / footnotes / droppedTextboxes
}
struct ImportedImage { sha256: String, ext: String, data_b64: String, planned_rel: String, reused: bool, bytes: u64 }
struct ConvertWarning { code: String, message: String, locator: String } // code: merged_table|footnote|textbox|toc|image_skipped|unknown_style|...
struct DocxCommitArgs {
    vault_root: String, dest_dir: String, md: String,
    doc_rel: String,                    // 校对后可能改名后的最终 .md 相对路径
    images: Vec<CommitImage>,           // [{sha256,ext,data_b64,planned_rel}]
    dedup_index: HashMap<String,String>, // 再次传入，commit 端权威判重
    new_title: Option<String>,
}
struct DocxCommitResult { doc_rel: String, written_images: Vec<String>, reused_images: Vec<String>, updated_index: HashMap<String,String> }
```
- `docx_preview`：`zip` 开包 → 解析 → 映射；**只读 src_path、绝不写库**；图片仅算哈希 + 回字节。
- `docx_commit`：`abs_in_vault` 双防线写 `.md` 与新图（命中 `dedup_index` 的 sha 不写、仅引用），回 `updated_index` 供前端持久化。
- 命名安全：标题→目录/文件名做 slug 化去非法字符；同名冲突由 commit 端补 `-2` 等（返回最终 `doc_rel`）。

## 6. OOXML → Markdown 映射规则（元素级）
| OOXML | 输出 | 备注 |
|---|---|---|
| `w:p` + `w:pStyle`=`Heading1..6` | `#`×层级 | 无样式但字号/加粗近似→按 `styles.xml` outline level 兜底；判不出记 `unknown_style` |
| 普通 `w:p` | 段落 | |
| run `w:b/w:i/w:u/w:strike/w:vertAlign` | `**`/`*`/`_`/`~~`/上下标（`<sup>` 或 `^`） | 上标 GFM 无 → 原样 `<sup>` 并记 warning |
| `w:numPr`（配 `numbering.xml`） | 有序/无序/**嵌套**列表 | 依 `ilvl` 缩进 |
| `w:hyperlink` + rels | `[text](url)` | |
| `w:tbl`（纯 1×1 网格） | GFM 表格 | |
| `w:tbl` 含 `w:gridSpan`/`w:vMerge` | **原样 `<table>` HTML** + `merged_table` warning | GFM 无法表达合并（§11） |
| `w:drawing`/`w:blip`→`media/*` | `![alt](<hash>.<ext>)` | 见 §7 |
| `w:footnote`/`w:endnote` | 正文 `[^n]` + 文末 `[^n]: …` | 编辑器不解析 footnote，源码态保真 |
| 文本框 `w:txbxContent` | 内层段落顺序输出 + `textbox` warning | 位置/浮动信息丢失 |
| 等宽字体样式段落（`Consolas` 等） | 围栏代码块 ```lang``` | 启发式；lang 取样式名映射 |
| TOC 域 `w:sdt`/`fldSimple` | 标题嵌套列表 + `toc` warning | 域码不可执行，取可见文本 |
| 分栏 `w:cols` | 顺序段落 | 版式丢失 |
| `w:br`/`w:cr`、制表位 | 换行/空格 | |

映射核心写成**纯函数**（输入 XML 片段/节点、输出 md 片段 + warnings），**不碰 IO**，便于 Rust 单测。

## 7. 图片提取 + 去重目录模型
- 每张 `media`：`sha256(bytes)` → 文件名 `<sha 前 12><.ext>`；ext 取自 zip 内媒体真实类型（`png/jpg/...`）。
- **单文档目录**：文档落 `<dest_dir>/<标题>/<标题>.md`，图默认同目录 `<dest_dir>/<标题>/<hash>.<ext>`，md 内以**同目录相对名**引用。
- **库级去重索引** `hash→库内相对路径`（前端存 `localStorage['nl-img-index']`，preview/commit 传入）：
  - 命中：不再写文件，`reused=true`，md 引用指向既有 `hash` 命中的相对路径（相对当前 `.md` 计算可达相对路径）。
  - 未命中：commit 端写入本文档目录，回传 `updated_index`，前端合并持久化。
- `max_image_bytes` 超限（默认建议 8MB）：md 内放占位 `<!--img skipped: too large-->` + `image_skipped` warning，不回字节。
- 单文档内重复插图（Word 常见）天然被同一 sha 收敛为一份。

## 8. 前端校对视图 + 批量编排
- 新 `src/docx-import.js`（编排、无重 DOM 逻辑可单测部分剥离）：
  - `runImport(uris | dir)`：建队列 → 逐个 `tauri.docxPreview(args, {dedupIndex})` → 打开校对模态 → 接受则 `docxCommit` 并更新索引/树、跳过则记队列 → 进度回报。
  - 失败**不阻断整批**：单文件错误入队列"失败"态，可重试/跳过。
- 新校对模态 `src/docx-review.js`（复用 `.nl-*` 对话框观感，参照 `prompt-dialog.js`/`confirm3-dialog.js`）：
  - **左预览**：只读渲染预览——独立 `MarkdownIt({html:true})` + `markdown-it-footnote` + table/strikethrough（**仅校对展示，绝不挂进 `editor-schema.js` 主 tokenizer**，避免污染编辑器）。`markdown-it-footnote` 当前**不在** `src/package.json` 依赖，P1 新增（纯前端、离线、体积小）。图片用提取字节（data URL）即时显示。
  - **右源码**：复用 `source-editor.js`（CodeMirror）编辑最终 Markdown；编辑内容即 commit 的 `md`。
  - **顶部**：`warnings` 列表（可点定位）+ 图片去重报告（新增 N / 复用 M）。
  - 动作：`接受并落库` / `跳过此文件` / （批量时）显示"第 k/n"。
- 依赖注入：`docx-import.js` 的 I/O（preview/commit/写索引/刷树）经参数注入，以支持 Node 纯逻辑单测（照 `site-export.js` 范式）。

## 9. 入口 / 落盘 / 命名 / frontmatter
- **入口**：工具条「▾ 更多 → 📥 导入 Word(.docx)…」→ 原生多选文件对话框；**或**拖 `.docx` 到侧栏文件树 → 复用同一流。需 `tauri-bridge.js` 加 `pickDocxFiles()`（dialog `multiple`）与 `docxPreview/docxCommit` 两条 `invoke`。
- **目标目录**：默认库根（或当前选中文件夹）；用户可选。
- **标题**：正文首个 H1 → 回退源文件名；slug 化作目录/文件名。
- **frontmatter**（`with_frontmatter` 开，默认开）：注入
  ```yaml
  ---
  source: "原文件名.docx"
  imported: "2026-10-15"
  ---
  ```
  与编辑器 `splitFrontmatter`/`fmRaw` 往返兼容。
- **冲突**：`<dest_dir>/<标题>/` 或 `.md` 已存在 → 自动 `-2`/`-3`，不覆盖。

## 10. 错误处理矩阵
| 情况 | 表现 |
|---|---|
| 选了 `.doc/.rtf` | 队列标"不支持格式，请另存为 .docx"，跳过 |
| docx 损坏 / 非 ZIP / 缺 `document.xml` | 单文件"转换失败：<原因>"入失败态，可重试/跳过，不阻断 |
| 图片超 `max_image_bytes` | 占位 + warning，仍转换其余 |
| 合并表/脚注/文本框/TOC | 降级输出 + warning（校对可见），不算失败 |
| 写库越界（commit 路径解析到库外） | `abs_in_vault` 拒、回错误、整篇不部分写 |
| IPC 过大（整册巨型图文） | 建议逐文件导入；preview 已按单文件切 |

## 11. 诚实边界（无损子集，已向功能项 J 收敛）
- **本取舍已由前置功能项 J 解决**：J 落地后，NoteLume 主编辑器已能无损往返脚注 `[^n]` 与合并表（存为 `<table>` HTML），导入产物打开即可 WYSIWYG 编辑。
- **若 J 未就绪的情形（过渡）**：NoteLume 编辑器 tokenizer = `commonmark` + `table` + `strikethrough`、`html:false`、无 footnote（见 `src/editor-schema.js`）——此时脚注/合并表仅宜源码态编辑或给 pandoc/Obsidian 消费。**校对模态左预览用独立渲染器**（html+footnote）总能“看得见”，但那不代表主编辑器能无损承载。
- 结论：功能项 I **建在 J 之上**；两者合起才既保真又 WYSIWYG 可编。

## 12. 测试策略
- **Rust `#[cfg(test)]`**：喂内联 OOXML 片段断言映射——标题层级/嵌套列表/删除线/超链接/普通表→GFM/**合并表→HTML+warning**/脚注→`[^n]`/文本框/TOC/代码块/图片引用；`docx_commit` 用临时库验写盘 + 去重命中不重存 + `abs_in_vault` 拒穿越；slug/冲突 `-2`。
- **前端 `src/tests/docx-import.test.mjs`**（`cd src && node tests/…`，照 `keymap.test`/`site-export.test` check/pass/fail 风格）：去重索引合并、标题/frontmatter 生成、warnings 聚合、批量队列状态机（注入假 preview/commit：接受/跳过/失败不阻断）。
- **门禁**：`cargo test --lib` 全绿（基线 51、新增后 0 失败）+ node 全部测试过 + `npm run build` 无错；含 Rust 重启 `tauri dev`，丢一个真 `.docx`（含表/图/脚注）走通"预览→校对→落库→图片去重"。

## 13. 落地分相（代码/文档分 commit，沿 R/F 系列习惯）
- **P0 Rust**：新 `src-tauri/src/docx_import.rs`（依赖 + 纯映射函数 + `docx_preview`/`docx_commit`）+ Rust 单测 → `cargo test`。
- **P1 前端**：`tauri-bridge.js` 三封装；`src/docx-import.js` 编排 + 去重索引；`src/docx-review.js` 校对模态（预览独立渲染器 + CodeMirror 源码 + 警告）；入口（更多菜单 + 拖拽）+ `style.css`；`docx-import.test.mjs` → `npm run build` + node 测试。
- **P2 文档**：README 导入段 + 特性行、CHANGELOG Unreleased Added、ROADMAP 记功能项 I、本 spec 落地补记。

## 14. 依赖与风险 / 待确认
- **新 Rust 依赖**：`zip`（`default-features=false` 仅读，避免引自有 TLS）、`roxmltree`、`sha2`、`base64`。均为纯 lib、离线、无外部二进制。**待 P0 编译闸口验证** `cargo tree` 无 `openssl-sys`。
- **大文档内存**：`roxmltree` 全量载入 `document.xml`——超大 Word 可能吃内存；可后续换 `quick-xml` 事件流（本期不做）。
- **等宽→代码块 / outline 判标题是启发式**：可能误判，交校对兜底。
- **base64 图片跨 IPC**：单文件内联，多图大文件受 `max_image_bytes` 约束；若后续要"不预览直接批量落盘"可加旁路（本期不做，与"逐个校对"定位一致）。
- **`markdown-it-footnote`**：校对预览渲染器需在前端 bundle 加此插件（纯前端、离线）——**已核实 `src/package.json` 未含，P1 新增**（不进主编辑器 tokenizer，仅供 `docx-review.js` 预览）。
- **对话框多选**：`@tauri-apps/plugin-dialog` 的 `open({ multiple:true, filters:[{extensions:['docx']}] })` 直接可用（现有 `pickFolder/pickFile` 同 API），无新依赖。
- **已锁定默认值**（实现期不再决策）：① **输出目录** = 当前选中文件夹，无选中则库根（`dest_dir` 用户可在入口改选）；② **frontmatter 默认开**（`source`+`imported`，可关）；③ **拖拽入口** = 仅侧栏文件树拖 `.docx`（编辑区拖拽现仅图片，不动）。

## 15. 落地补记（实现与 spec 的差异，P0-P2 完成后回填）
- **未引 `base64` crate**：§14 列的四个新依赖中，实际只新加了 `zip`/`roxmltree`/`sha2`——base64 编解码**复用 `lib.rs` 已有的手写 `b64_encode`/`b64_decode`**（改 `pub(crate)` 供 `docx_import` 消费），尊重项目既有约定、少一个依赖。`cargo tree` 验证 `zip`（`default-features=false`+`deflate`）走纯 Rust `flate2`→`miniz_oxide`，**无 `openssl-sys`**，P0 编译闸口通过。
- **`markdown-it-footnote` 无需新增**：§14 预计“P1 新增”，但前置功能项 J 已把它加入 `src/package.json` 生产依赖（主 tokenizer 用），故 I 直接复用；`docx-review.js` 用**独立实例** `MarkdownIt({html:true}).use(footnote)`，不碰主 tokenizer。为保持 CodeMirror 懒加载，校对模态对 `source-editor.js` 用**动态 `import()`**（否则 `vite build` 会把 CM 拉进主 chunk）。
- **拖拽字节入口（超原契约）**：Tauri v2 webview 下浏览器 `File` 无绝对路径，故 `DocxPreviewArgs` 增可选 `src_b64` + `src_display_name`（给了 `src_b64` 则忽略 `src_path`）；`docx_preview` 顶部优先取回传字节。侧栏文件树拖 `.docx` 由 `main.js` 先 `fileToBase64` 再走同一流。
- **目标目录与“不要求先开库 + 导入后立即回显”（经多轮用户反馈迭代）**：应用无持久的“选中文件夹”态。已开库时 `importWordViaDialog` 取 `parentOf(state.currentFile)` 作 `dest_dir`（无当前文档则库根 `''`），接受即落库。未开库的独立模式经多轮反馈收敛：**不再弹 `pickFolder` 让用户选保存位置**（先“静默拦截”被反馈“点了没反应”→“前置选目录”被反馈“找不到落盘文件”→“接受时才弹目录”仍不够直接），**最终形态：「接受」即把转换结果写入系统 temp 的一次性目录**（新 Rust 命令 `ensure_temp_import_dir` 建 `<temp>/NoteLume/docx-import/<毫秒时间戳>` 并返回绝对路径；该目录当场创建，因 `docx_commit` 会对 `vault_root` 做 canonicalize、要求路径已存在），该篇 `commit` 以此为 `vault_root`（`abs_in_vault` 仍防穿越）且**不传/不回库级去重索引**（每篇自包含：图片必落盘、md 引用必对）；`openDocxReview` 按钮文案独立模式改回“接受”（无“保存”语义）。**导入完成后立即回显**：两种模式都把首篇 `committedRels[0]` 用 `openFile` 在主编辑器打开；独立模式先 `state.vaultRoot = tempRoot` + `renderTree(scanVault)` + `startIndexPolling`（把 temp 一次性目录作为工作根，侧栏树列出全部导入篇、可逐个点开），是否长期保存（移走/另存）完全由用户自决。完成提示从“阻塞式 `messageDialog` 列路径”改为 `setStatus`（不遮挡刚打开的文档）；仅当 0 篇落盘（全跳过/失败）时才弹 `messageDialog` 说明。
- **reused 图片仍带 `data_b64`**：`push_image` 无论命中与否都回字节，便于预览内联；commit 侧以 `dedup_index` 为权威判命中（命中不重写、仅引用）。去重文件名固定 `<sha前12>.<ext>`，预览按此 basename 回映 data URL。
- **单文档内同图收敛**：`img_seen` 按 sha 去重，同一 `.docx` 多处引同一图仅产一条 `ImportedImage`。
- **版式表格线性化（真实简历样本驱动修正）**：用户丢入一份整页用表格排版的简历，导出“完全不能看”。解剖其 `document.xml`（非猜测）发现：整页内容全在 **1 个 `w:tbl` 的 3 个单元格**里（单格最多 72 段），且“个人信息/教育背景”等用的是**真 heading 样式（heading 2/3/4、带 outlineLvl）**。旧 `push_table` 对单元格走 `map_inline`（只行内）+ `join(" ")`，**丢弃了格内段落的标题/列表/换行** → 拍成一行。修正：新增 `is_layout_table`（任一单元格含 ≥2 非空段或嵌套表 → 判为版式表），命中则**线性化**：逐格把 `w:p` 走完整 `push_paragraph`（标题/列表/段落自然回归），并发 `layout_table` warning；每格仅 1 段的数据表仍走原 GFM/HTML 路径（回归护栏 `single_paragraph_cell_stays_real_table`）。另 `strip_bullet_marker` 把字面 • · ‣ 等伪列表字符→ Markdown `- ` 项。**据此推翻“按字号/加粗启发式识别标题”（计划曾选“积极”）：实测字号不可靠（“姓名：”=sz32、正文整块加粗），真标题本就由样式携带，无需误伤面大的启发式。** `cargo test --lib` 70 passed（+3）。
- **内容控件（`w:sdt`）透明化 + 相邻同格式 run 合并（同一简历样本二次修正）**：线性化后小标题（个人信息/教育背景/工作经验）仍整段消失、正文满是 `**AI****视频工程师**` 碎片。再解剖 XML 定位两处独立真因：① 分节标题段落被 `<w:sdt>` 内容控件包裹（块级 sdt 夹在 `w:tc` 之间、行内 sdt 把 `技能` 的 `w:r` 包在段内），旧代码只在 `map_body` 顶层展开 sdt 的 `p`，块遍历（表格单元格）与 `map_inline` 均不下钻 sdt → 内容整段丢失。修：新增 `push_children_blocks`（p/tbl/sdt 递归、sdt 透明展开其 `sdtContent`），`map_body` 与线性化循环统一走它；`map_inline` 重构为 `map_inline_children`，对 hyperlink/fldSimple/ins/smartTag/**sdt** 一律递归。② Word 按 rsid 把一句加粗切成多段同格式 run，`map_run` 逐段包裹得 `**a****b**`。修：`map_inline_children` 用 `mergeable_run`（仅“一 rPr + 若干 w:t”、无图片/换行/上下标等副作用）计算强调签名，`flush_pending`/`wrap_emphasis` 把相邻同签名 run 合并后再包裹（包裹序与 `map_run` 一致：strike→u→i→b）。新增 4 用例（`block_sdt_inside_cell_is_linearized`/`inline_sdt_run_not_dropped`/`adjacent_same_bold_runs_merge`/`bold_then_plain_runs_stay_separate`），`cargo test --lib` 74 passed。
- **未开库导入后 Ctrl+S “没反应” → 另存为升级 + CM `Mod-s` 吐吞修正**： temp 一次性目录作为工作根后，用户预期 Ctrl+S 应“由自己决定是否保存”，但实际完全无反馈。两处独立真因：① **CodeMirror 6 默认 keymap 里 `Mod-s` 绑到 `save` 命令**，其 `run: () => true` 吐吞事件且不做事——**源码模式下** Ctrl+S 到不了 document 级的应用分发器（app.save），表现为“没反应”。修：`source-editor.js` 建 keymap 时 `defaultKeymap.filter((b) => b.key !== 'Mod-s')`，让事件冒泡到应用层（主编辑器与校对模态共用本组件、自一并不响应）。② **temp 目录不应默默覆写**：以往 `saveCurrent` 写回到同一 temp 文件，用户体感上仍为“没保存”。修：新增 `state.tempImportRoot` 标记（`openFolder`/`openSingleFile`/`reopenRecent` 入口清零）；`saveCurrent(manual=true)` 命中时短路到 `saveTempAsFormal()`——先回写一次 temp（保证取消弹框不丢改动）→ `pickFolder` → 新 Rust 命令 `relocate_import(from_root, to_root)` 递归拷贝整棵 temp → target（同名覆写、不删源、目标不存在自动建）→ 将 `state.vaultRoot` 切至 target、`tempImportRoot` 清零、刷树/索引/插件/Git 面板。取消选目录 → 仅“已保存到临时目录（未选择保存位置）”提示，不会默默将“保存”语义塑造成 temp 写。新 Rust 命令含 2 单测（`relocate_import_copies_tree_into_target`、`relocate_import_creates_missing_target_dir`），`cargo test --lib` 76 passed（基线 74 + 2）。
- **测试覆盖**：`cargo test --lib` 67 passed（基线 51 + 新增 16 docx 用例，含 commit 临时库验去重/冲突/穿越）；新 `src/tests/docx-import.test.mjs` 11 passed（队列/索引/映射/失败不阻断）；其余 Node 套件全绿、`npm run build` 无错。真 `.docx` 整机冒烟需重启 `tauri dev`（含 Rust）。
