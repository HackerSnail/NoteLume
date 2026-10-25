# Quarkdown 引擎阶段 2（stdlib 补齐）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 按模块补齐 stdlib。每批独立交付、独立单测；函数名一律以 `.others/quarkdown` 源码的 `@Name` 注解为准（缺省 = Kotlin 函数名小写），本计划已核对：

- **批 1（本计划）**：Strings 全量（string / concatenate / uppercase / lowercase / capitalize / isempty / isnotempty / startswith；plaintext 需真实 Markdown 剥离实现，延后）、Logical 全量（islower / isgreater / equals / not / and / or）、Math 补充（rem / abs / negate / sqrt / logn / sin / cos / tan / round）、Collection 17 个（getat / first / second / third / last / size / sumall / average / distinct / sorted / reversed / groupvalues / prepended / appended / findfirst / joinstring / withindices）
- **批 2**：Data / FileTree（需给引擎加 IO provider，涉及 qd_eval 命令签名扩展）
- **批 3**：Document / Layout / TableComputation（产出 HTML / 结构节点的模块，要定「引擎输出 Markdown 还是 HTML 片段」的口径）。**口径已定（2026-10-25 实施时）**：全部输出 Markdown——HTML 路线要同时改编辑器快照（html:false 刻意安全口径）与三个导出管线并各接净化，不值；box / collapse 等降级引用块，分页专属机制 no-op，toc 落 `[[toc]]`。附：lambda 实参机制（Builtin.lambda_args）随本批落地，findfirst / groupvalues 一并补齐；计划原文所列 sortby 在 Kotlin stdlib 中不存在（仅 listfiles 的同名具名参数）。
- **批 4**：Slides / Bibliography / Localization / Dictionary / 包管理器。**口径已定（2026-10-25 实施时）**：Slides 的 slides / fragment 无 Markdown 形态（配置静默、fragment 内容平铺），speakernote 落 `::: notes` 接前端幻灯片导出；Bibliography 只做 BibTeX + ieee 数字编号（CSL 引擎不搬），cite 走占位符 + eval_document 出口统一解析，编号按条目文件顺序；本地化无当前文档概念，靠 `doclang` 设语言（从 Document no-op 名单拿出真做）；Dictionary 按 Kotlin 就 dictionary / get 两个，配 as_items 适配复用 Collection；包管理器只做 include 的文件路径态（工作目录分支 + share/scope 两档 sandbox），@包引用与 --libs 目录降级 / 缓做。解析顺带修了行内调用链式段不收参数的既有缺陷（`.x::sum {1}` 的 {1} 被静默丢掉）。

**Global Constraints**

- 函数名与语义逐条对拍 Kotlin 源码；调用名 = `@Name` 注解，无注解 = 函数名小写。
- 类型错误 / 缺参 → 诊断 + 原文降级（既有错误模型，不允许 panic）。
- 集合类实参统一走 `Value::as_items()`（Range / List / Markdown 列表文本三种来源）；`withindices` 产出的配对用 `List [index, elem]` 表达（`.1::first` / `.1::second` 可取），不引入字典类型（destructuring 后续阶段再说）。
- `sortby` / `groupvalues` / `findfirst` 的 lambda 实参：lambda 以 Value::Lambda 传入，求值走既有 `bind_and_run` 路径。
- 测试：`cargo test --lib qd`，每模块一组用例。

**批 1 验收**：上述 4 模块约 30 个函数全部有单测（正常路径 + 类型错误降级）；`cargo test --lib` 全量不破。
