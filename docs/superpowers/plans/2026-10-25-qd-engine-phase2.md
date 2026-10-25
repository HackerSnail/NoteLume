# Quarkdown 引擎阶段 2（stdlib 补齐）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 按模块补齐 stdlib。每批独立交付、独立单测；函数名一律以 `.others/quarkdown` 源码的 `@Name` 注解为准（缺省 = Kotlin 函数名小写），本计划已核对：

- **批 1（本计划）**：Strings 全量（string / concatenate / uppercase / lowercase / capitalize / isempty / isnotempty / startswith；plaintext 需真实 Markdown 剥离实现，延后）、Logical 全量（islower / isgreater / equals / not / and / or）、Math 补充（rem / abs / negate / sqrt / logn / sin / cos / tan / round）、Collection 17 个（getat / first / second / third / last / size / sumall / average / distinct / sorted / reversed / groupvalues / prepended / appended / findfirst / joinstring / withindices）
- **批 2**：Data / FileTree（需给引擎加 IO provider，涉及 qd_eval 命令签名扩展）
- **批 3**：Document / Layout / TableComputation（产出 HTML / 结构节点的模块，要定「引擎输出 Markdown 还是 HTML 片段」的口径）
- **批 4**：Slides / Bibliography / Localization / Dictionary / 包管理器

**Global Constraints**

- 函数名与语义逐条对拍 Kotlin 源码；调用名 = `@Name` 注解，无注解 = 函数名小写。
- 类型错误 / 缺参 → 诊断 + 原文降级（既有错误模型，不允许 panic）。
- 集合类实参统一走 `Value::as_items()`（Range / List / Markdown 列表文本三种来源）；`withindices` 产出的配对用 `List [index, elem]` 表达（`.1::first` / `.1::second` 可取），不引入字典类型（destructuring 后续阶段再说）。
- `sortby` / `groupvalues` / `findfirst` 的 lambda 实参：lambda 以 Value::Lambda 传入，求值走既有 `bind_and_run` 路径。
- 测试：`cargo test --lib qd`，每模块一组用例。

**批 1 验收**：上述 4 模块约 30 个函数全部有单测（正常路径 + 类型错误降级）；`cargo test --lib` 全量不破。
