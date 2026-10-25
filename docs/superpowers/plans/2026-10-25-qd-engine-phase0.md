# Quarkdown 引擎阶段 0（Rust 骨架）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rust 引擎骨架：lexer / parser / AST / 求值器，支持变量、`.function` 定义与调用、`.if` / `.ifnot` / `.let` 条件、`.foreach` / `.repeat` 循环、`::` 链式调用、最小内置库（Math / Text / range），`qd_eval` Tauri 命令连通，输出展开后的 Markdown + 诊断。

**Architecture:** 纯逻辑模块 `src-tauri/src/qd/`（ast / parser / eval / stdlib）+ `lib.rs` 挂薄壳命令。求值器带作用域链与错误降级：单点求值失败进诊断数组、输出原文，不炸整个文档。前端集成是阶段 1，本阶段不含。

**Tech Stack:** Rust stable、serde（命令序列化）、内置 `#[cfg(test)]` 单测（`cargo test --lib`）。

**Spec:** `docs/superpowers/specs/2026-10-25-quarkdown-engine-design.md`（语法锚点：`.others/quarkdown/docs/*.qd`）

## Global Constraints

- 语法以 `.others/quarkdown/docs/*.qd` 与 quarkdown-core 源码为准：无 `.else`（用 `.if` / `.ifnot` + `.let`）、布尔字面量 `{yes}` / `{no}`、循环是 `.foreach` / `.repeat`（无 `.loop`）、区间字面量 `{2..4}` 闭区间。
- 求值错误必须降级：诊断 + 原文输出，任何单点失败不允许panic 或丢弃整个文档。
- 递归深度上限 128 层，超限出诊断。
- 普通非指令行逐字保留（含空行），只有指令替换成求值结果——GFM 基底不动。
- 整数输出不带小数点（`.sum {2} {3}` → `5` 非 `5.0`）；布尔输出 `yes` / `no`；`None` 输出空串。
- 本阶段不动前端任何文件；`qd_eval` 命令在 `lib.rs` 注册但无调用方。

## Review Focus

- 缩进归块：块参数 = 后续缩进**严格大于**调用行的连续行；嵌套更深的内容归内层调用。空行不断开块（Quarkdown 允许块内空行）→ Task 1 用测试钉住（空行在块中间时仍归块）。
- 花括号参数跨行与嵌套配平：`{a{b}c}` 内层花括号不截断参数 → Task 1 测试钉住。
- 递归函数（阶乘式自调用）受深度上限保护，超限诊断而非栈溢出 → Task 2 测试钉住。
- `.1` 隐式首参：lambda 无参数行时参数名固定为 `1`，`.1` 调用解析为该变量 → Task 3 测试钉住。
- 除零 / 非数字参数：诊断 + 原文，不 panic → Task 4 测试钉住。

---

### Task 1: AST 与解析器（`qd/ast.rs` + `qd/parser.rs`）

**Files:**
- Create: `src-tauri/src/qd/mod.rs`
- Create: `src-tauri/src/qd/ast.rs`
- Create: `src-tauri/src/qd/parser.rs`
- Modify: `src-tauri/src/lib.rs`（`mod qd;`）

**Interfaces:**
- Produces（后续任务依赖，签名钉死）:
  - `ast::Block`：`enum { Text(String), Call(CallNode) }`
  - `ast::CallNode { name: String, chain: Vec<String>, args: Vec<Arg>, body: Option<Vec<Block>>, line: usize }`；`Arg { name: Option<String>, raw: String }`（raw 为花括号内原文，含区间字面量 `2..4`，求值时再判类型）
  - `parser::parse_document(src: &str) -> Vec<Block>`（顶层块序列，`line` 为 1 起始行号，供诊断）

- [ ] **Step 1: 写失败测试**

`src-tauri/src/qd/parser.rs` 内 `#[cfg(test)]`（与实现同文件，模块内单测惯例）：

```rust
// 用例（check 语义，逐条独立断言）：
// 1. 纯文本逐字保留：parse_document("hello\n\nworld") == [Text("hello"), Text(""), Text("world")]（空行各自成 Text 节点，内容含换行与否以实现为准，测试钉「文本不丢不改」）
// 2. 调用行：".sum {2} {3}" → Call{ name:"sum", args:[{None,"2"},{None,"3"}], chain:[], body:None }
// 3. 具名参数：".multiply {.n} by:{2}" → args[1].name == Some("by")
// 4. 嵌套花括号配平：".f {a{b}c}" → args[0].raw == "a{b}c"
// 5. 链式：".pow {2} to:{3}::multiply {.pi}" → name:"pow", chain:["multiply"]
// 6. 块参数：调用行后缩进更深的连续行归 body（含空行断开的连续段）；正文按一级缩进剥离：
//    ".if {yes}\n    hello\n\n    world" → body 有两个块，"hello"/"world" 无缩进
// 7. 嵌套调用：块内行首 `.` 开头的行继续解析成 Call（body 里是 Call 节点而非 Text）
// 8. 非指令行首的 `.`（如 "3.14" 行首是数字、句中 .x）不触发调用解析——只有行首紧跟名字才算
// 9. 区间字面量保留在 raw："{2..4}" → raw == "2..4"（求值层判类型）
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd src-tauri && cargo test --lib qd`
Expected: 编译失败（模块不存在）

- [ ] **Step 3: 实现解析器**

实现要点（签名与测试已定，只钉算法）：
1. 逐行扫描；`parse_blocks(lines, start_indent) -> Vec<Block>`：行首 `.` + `[a-zA-Z][a-zA-Z0-9_]*` 且缩进 == start_indent → 解析调用；其余行与相邻普通行合并成 Text（保留原行文本）。
2. 调用行解析：名字后扫 `::name` 链；随后扫参数序列——`(\w+)?\s*:\s*\{` 为具名，`\{` 为位置；花括号配平扫描（计数器，字符串内不特判引号——Quarkdown 参数里花括号必须配平，对齐源码行为）；参数间空白（含换行）跳过。`N..M` 区间在求值层识别，解析层原样存 raw。
3. 块归属：调用行之后，缩进 > 调用行缩进的连续行（空行不断开，但空行后若缩进回到 ≤ 调用行则块结束）→ 递归 `parse_blocks(inner_lines, call_indent + 4)`，即剥离一级缩进（Tab 记 4）。空行在块内保留为 Text("")。
4. 行号记录：每个 CallNode 记首行行号。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd src-tauri && cargo test --lib qd`
Expected: 全部 PASS

- [ ] **Step 5: 提交**

```bash
git add src-tauri/src/qd/ src-tauri/src/lib.rs
git commit -m "feat(qd): 引擎 AST 与解析器（指令行 / 参数 / 链式 / 缩进块）"
```

---

### Task 2: 求值器核心（`qd/eval.rs`）——变量、函数、条件、错误降级

**Files:**
- Create: `src-tauri/src/qd/value.rs`
- Create: `src-tauri/src/qd/eval.rs`
- Modify: `src-tauri/src/qd/mod.rs`

**Interfaces:**
- Consumes: Task 1 的 `parse_document` / `Block` / `CallNode`。
- Produces:
  - `value::Value`：`enum { Str(String), Num(f64), Bool(bool), None, Markdown(String), Lambda { params: Vec<String>, body: Vec<Block> }, Range(i64, i64), List(Vec<Value>) }`，`Value::to_output(&self) -> String`（整数无小数点、Bool → yes/no、None → 空串）
  - `eval::Diagnostic { line: u32, message: String }`
  - `eval::eval_document(blocks: &[Block]) -> (String, Vec<Diagnostic>)`；`eval::Env`（作用域链，`child()` / `define` / `lookup`）

- [ ] **Step 1: 写失败测试**

`eval.rs` 内 `#[cfg(test)]`（parseMarkdown 风格：先 parse 再 eval 的组合断言）：

```rust
// 1. 变量：".var {name} {Quarkdown}\nHello, .name!" → "Hello, Quarkdown!"
// 2. 重绑定：".var {n} {5}\n.var {n} {6}\n.n" → "6"
// 3. 函数定义与调用（含参数与可选参 ?）：
//    .function {greet}\n    to from?:\n    Hello, .to from .from!\n\n.greet {world} → "Hello, world from !"（None → 空串）
// 4. 函数返回 Markdown 加粗：".function {greet}\n    to:\n    **Hello, .to**\n\n.greet {world}" → "**Hello, world**"
// 5. 函数重定义以后者为准（同文档后置覆盖）
// 6. .if / .ifnot：".if {yes}\n    A\n.ifnot {yes}\n    B" → "A"；{no} 反之
// 7. .let：".let {3}\n    n:\n    value is .n" → "value is 3"
// 8. 错误降级：未知函数 ".nosuch {x}" → 输出原文 ".nosuch {x}" + 1 条诊断（行号正确）
// 9. 递归深度：自调用函数（无终止条件）→ 输出原文 + 深度诊断，不栈溢出
// 10. 整数输出：".var {n} {5}\n.n" → "5"；布尔输出 ".var {b} {yes}\n.b" → "yes"
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd src-tauri && cargo test --lib qd`
Expected: 编译失败

- [ ] **Step 3: 实现 `value.rs` 与 `eval.rs`**

实现要点：
1. `Env { values: HashMap<String, Value>, parent: Option<&Env> }`——实际用 `Rc<RefCell<…>>` 或直接传 `&mut Stack<Vec<HashMap>>` 作用域栈，二选一（实现者定，测试只看行为）；深度计数器 128。
2. 调用解析顺序：作用域内用户函数 / 变量 → 内置表 → 未知名诊断（原文降级）。
3. `.function {name}`：body 首块若为 Text 且首行匹配 `^([\w?]+( [\w?]+)*)?:$` 则为参数表（`?` 后缀剥成可选）；余下块为 lambda 体。注册进当前作用域。
4. 变量调用（无参 Lambda）求值 = 在子作用域绑定参数后逐块求值拼接。
5. `.if {cond}` / `.ifnot {cond}`：cond 为 Bool；Str("yes"/"no") 也接受；其余类型出诊断并跳过。`.let {value}`：body 参数行首参绑定 value。
6. 参数绑定：位置参数按序、具名按名、可选缺省 None、块参数（body）绑到末参。实参数 > 形参数：多出的忽略 + 诊断。
7. 每个调用结果 `Value::to_output()` 后 trim 端部空白再拼（Text 节点不 trim）。

- [ ] **Step 4: 跑测试确认通过** → **Step 5: 提交**

```bash
git add src-tauri/src/qd/
git commit -m "feat(qd): 求值器核心（作用域 / 变量 / 函数 / 条件 / 错误降级）"
```

---

### Task 3: 循环与隐式首参（`foreach` / `repeat` / 区间 / `.1`）

**Files:**
- Modify: `src-tauri/src/qd/parser.rs`（区间字面量识别）
- Modify: `src-tauri/src/qd/eval.rs`

**Interfaces:**
- Consumes: Task 1 / 2 全部。
- Produces: `{2..4}` 区间字面量 → `Value::Range(2, 4)`（闭区间）；`.foreach` / `.repeat`；lambda 无参数行时隐式参数名 `1`。

- [ ] **Step 1: 写失败测试**（追加到 eval.rs 测试）

```rust
// 1. 区间：".var {r} {2..4}\n.r" 输出 "2\n3\n4"（Range to_output = 各元素换行）
// 2. foreach + 显式参数：".foreach {2..4}\n    n:\n    The number is .n" → 三行，各 "The number is 2/3/4"
// 3. foreach + 隐式 .1：".foreach {1..3}\n    .1" → "1\n2\n3"
// 4. foreach 列表：".var {letters}\n    - A\n    - B\n\n.foreach {.letters}\n    l:\n    letter .l" → 变量块参数成 Markdown 列表值，逐项迭代（List of Str）
// 5. repeat：".repeat {3}\n    x" → "x\nx\nx"
// 6. foreach 嵌套 if：".foreach {1..3}\n    n:\n    .if {.n::iseven}\n        even .n" → "even 2"
```

- [ ] **Step 2: 跑测试确认失败**

- [ ] **Step 3: 实现**

要点：`Arg.raw` 匹配 `^(\d+)\.\.(\d+)$` → Range；`.foreach` 实参 Range → List<Num>；Lambda 首参缺省名 `1`（`.1` 调用查作用域）；`.repeat` 实参取整。Markdown 列表值：块参数整体为 Str 时的 `- ` 逐行拆 List<Str>（iterable.qd 语义的最小集）。

- [ ] **Step 4: 跑测试确认通过** → **Step 5: 提交**

```bash
git add src-tauri/src/qd/
git commit -m "feat(qd): foreach / repeat / 区间字面量与隐式首参"
```

---

### Task 4: 最小内置库（`qd/stdlib.rs`）——Math / Text / range

**Files:**
- Create: `src-tauri/src/qd/stdlib.rs`
- Modify: `src-tauri/src/qd/eval.rs`（内置表接线）

**Interfaces:**
- Produces: `stdlib::builtin(name: &str) -> Option<BuiltinFn>`；注册集（名字与 Quarkdown stdlib 逐一对齐）：
  - Math：`sum` `subtract` `multiply`(具名 `by:`) `divide` `pow`(具名 `to:`) `truncate`(第二参小数位) `pi` `iseven` `isodd` `range`（`{from} {to}` → Range）
  - Text：`uppercase` `lowercase` `uppercasefirst`
- 除零 / 非数字参数 → 诊断 + 原文降级。

- [ ] **Step 1: 写失败测试**（追加到 stdlib.rs 测试）

```rust
// 1. ".sum {2} {3}" → "5"；".sum {2.5} {1}" → "3.5"
// 2. 链式数学：".var {radius} {8}\n.pow {.radius} to:{2}::multiply {.pi}::truncate {2}" → 201.06 口径（pi 取 f64 常量，truncate 两位）
// 3. ".iseven {3}" → "no"；".foreach {1..3}\n    .1::multiply {10}" → "10\n20\n30"
// 4. ".uppercase {quarkdown}" → "QUARKDOWN"；".lowercase {ABC}" → "abc"
// 5. ".divide {5} {0}" → 原文 + 诊断（除零）
// 6. ".sum {a} {b}" → 原文 + 诊断（非数字）
// 7. ".range {1} {3}::foreach\n    .1" → "1\n2\n3"
```

- [ ] **Step 2: 跑测试确认失败** → **Step 3: 实现** → **Step 4: 跑测试确认通过** → **Step 5: 提交**

```bash
git add src-tauri/src/qd/
git commit -m "feat(qd): 最小内置库（Math / Text / range）"
```

---

### Task 5: `qd_eval` 命令与端到端

**Files:**
- Modify: `src-tauri/src/lib.rs`（注册命令 + invoke_handler）

**Interfaces:**
- Consumes: `qd::eval_document`。
- Produces: `#[tauri::command] qd_eval(md: String) -> QdOutcome`；`QdOutcome { expanded: String, diagnostics: Vec<QdDiagnostic> }`（serde camelCase：`expanded` / `diagnostics`，`QdDiagnostic { line, message }`）。前端阶段 1 才调用，本阶段无调用方。

- [ ] **Step 1: 端到端失败测试**（lib.rs 或 qd/mod.rs 测试）

```rust
// 组合用例（parse → eval 全链路，经 qd_eval 内部同一函数）：
// 输入：".var {name} {NoteLume}\n.function {greet}\n    to:\n    Hello, .to, welcome to .name!\n\n.greet {world}\n.foreach {1..2}\n    .1::uppercase"
// 期望输出三段：Hello 行、greet 结果、"1"/"2"；诊断为空。
// 附一条带未知函数的用例：正文原样保留 + 诊断 1 条。
```

- [ ] **Step 2: 确认失败** → **Step 3: 实现命令薄壳**（`invoke_handler` 注册 `qd_eval`）→ **Step 4: `cargo test --lib` 全量通过 + `cargo build` 无警告新增** → **Step 5: 提交并推送**

```bash
git add src-tauri/src/
git commit -m "feat(qd): qd_eval 命令与阶段 0 端到端"
git push
```

## 验收（阶段 0 完成判据）

`cargo test --lib` 全绿（既有 163+ 条不破，qd 新增 ≥ 30 条）；`qd_eval` 对一段含变量、函数、条件、循环的真实样例文档产出正确展开文本与空诊断；错误样例产出原文 + 定位诊断。
