# 总体设计：Quarkdown 引擎移植（JS + Rust 重写）

- 状态：总体设计定稿，分期实施（阶段 0 起步）
- 日期：2026-10-25
- 前置决策（用户确认）：① 放开 GFM 约束——CLAUDE.MD 硬性约束第 3 条已改，「Quarkdown 语法文档不再要求 Typora / Obsidian 兼容，普通文档仍完全兼容」；② 载体选 JS + Rust 重写，不复用 Kotlin 产物、不打包 JVM/CLI；③ 范围全集（含包管理器），分期交付；④ 参考实现 `.others/quarkdown/`（Kotlin 源码，只读参考，不进构建）
- 决策原则锚定：纯文件、无自建服务器；求值不阻塞 UI（Rust 侧，与既有 VaultIndex 同策略）；警惕外部二进制依赖（重写而非携带 JVM）

## 一、引擎是什么

Quarkdown = Turing-complete Markdown 方言：`.name {arg} name:{arg}` 函数调用、lambda 块参数、变量（无参函数）、`.if/.else` 条件、`.loop/.foreach` 循环、`.function` 定义、`::` 链式调用、约 190 个内置函数的 stdlib、包管理器。编译模型：**源 Markdown → 求值展开 → 输出 Markdown/HTML**，无 return 语句，顺序执行的每条指令都成为输出。

语法锚点（以 `.others/quarkdown/docs/*.qd` 与 quarkdown-core 源码为准）：
- 调用：`.name {positional} name:{named}`；块参数 = 调用后缩进（一级 4 空格 / Tab）的后续行
- 定义：`.function {name}` + 缩进 lambda 体，lambda 首行 `param1 param2?:`（`?` 后缀 = 可选参数，缺省 `None`）
- 链式：`.value::function {arg}`（`.` 之后的 `::` 前调用结果为第一参数）
- 条件：`.if {cond}` 块 + `.ifnot` 反义（这一版 Quarkdown 没有 `.else`，取反流程用 `.let` 绑定条件后双分支）；循环：`.foreach {iterable} body`（lambda 首参或隐式 `.1`）、`.repeat {times}`；区间字面量 `{2..4}` 闭区间，Markdown 列表也是 iterable
- 注释：`<!-- -->` 是标准 HTML 注释；Quarkdown 无行注释（对齐源码行为）

## 二、架构与分工

```
md 源文件（GFM 基底 + Quarkdown 指令）
  → Rust 引擎（src-tauri/src/qd/）
      lexer → parser（指令树）→ AST → 求值器（作用域 / 栈帧）→ 展开后的 Markdown + 诊断[]
  → 前端既有 markdown-it 管线（编辑器 parse / site-export / slides / 单篇 HTML 全部复用）
```

**Rust 侧**（`src-tauri/src/qd/`，纯逻辑 crate 内模块 + Tauri 命令薄壳）：
- `lexer / parser / ast`：指令行扫描（行首 `.` + 名字合法字符）、花括号参数（嵌套配平）、缩进块归属、`::` 链拆分。markdown 文本原样保留为 AST 文本节点，**只识别指令，不改写普通 Markdown 解析**
- `eval`：作用域链（全局 → 函数栈帧）、变量即无参函数、lambda、条件 / 循环、错误模型（求值错误进诊断数组，输出降级为原文，不炸整个文档）
- `stdlib/`：按 Quarkdown 模块逐个移植——Math / Logical / Flow / Strings / Collection / TableComputation / Data(CSV/JSON) / Document / Layout / Slides / Mermaid(透传) / …
- `package-manager`：从远端拉 `.qdlib`，本地缓存（app data 目录），安全上沿用剪藏 HTTP 的域校验思路
- Tauri 命令：`qd_eval(md, options) -> { expanded, diagnostics }`（同步小文档）/ `qd_eval_batch`（整库）

**JS 侧**（`src/qd/`）：
- 调用层：tauri-bridge 包装、live preview 节流（输入停 300ms 后重求值，求值期间显示上次结果 + 「排版中」状态）
- 编辑器显示：指令块装饰——光标不在指令区时显示**求值结果快照**（mermaid/csv 的「点进源码」同款交互，快照内容是展开后的 Markdown 渲染结果）；光标进入显示源码指令；诊断（行号 + 消息）在源码态标注
- 导出注入：单篇 HTML / 整站 / 幻灯片渲染前先过 `qd_eval`；开关（settings `features.quarkdown`）关闭时引擎完全旁路，文件按普通 GFM 处理
- frontmatter：文档级选项（如 `doctype`）传给引擎 options

## 三、分期路线（每期独立交付）

| 阶段 | 内容 | 验收 |
|---|---|---|
| 0 | Rust 骨架：lexer / parser / AST / 求值器 + 变量、`.function` 定义调用、`.if` / `.ifnot` / `.let`、`.foreach` / `.repeat` + 最小内置库（Math 算术、Text 基础如 uppercase/lowercase） | `cargo test` 全量单测：语法 / 求值 / 错误降级各一组用例；`qd_eval` 命令连通 |
| 1 | 编辑器集成（指令块装饰 + 快照 + 诊断标注）+ 导出集成（四个输出点渲染前展开）+ `features.quarkdown` 开关 | 真机：写 `.function {greet}` 调用出结果；开关关闭全部旁路 |
| 2 | stdlib 第一批：Layout / Text 全量 / Collection / TableComputation / Data(CSV/JSON) / Document | 逐模块 Rust 单测 + 真机样例 |
| 3 | Slides 全功能（整库幻灯片并入此处）+ Mermaid / Math / Cross-references | 整库编译一套幻灯片 |
| 4 | 包管理器 + Libraries / FunctionExtension | 拉包、装包、调用第三方函数 |
| 5 | Bibliography / Localization / Dictionary / 环境与文件树长尾 | 逐模块验收 |

## 四、明确不做 / 后议

- 不移植 Kotlin/JS 或 WASM 构建链（已否）
- 不移植 Quarkdown 的 HTML/PDF 编译端（Quarkdown-HTML 模板那套）——NoteLume 用自己的渲染管线，引擎只输出展开 Markdown
- 编辑器不做 Quarkdown 语法的 WYSIWYG 求值编辑（源码可见可编辑，结果以快照呈现）；实时逐字符求值不做（节流批量）
- `.others/quarkdown/` 保持只读参考，不进 NoteLume 构建

## 五、风险

- 语法边角（缩进归块、嵌套花括号、`::` 链与普通调用的歧义）以 quarkdown-core 的 Kotlin 实现为准逐条对拍；每条规则配 Rust 单测
- live preview 的求值延迟：大文档全量重求值可能上百毫秒——节流 + 结果缓存（按文档哈希），阶段 1 实测再定增量策略
- stdlib 190 函数全量移植工程量大：分阶段交付，每期都可独立使用，不阻塞中间状态
