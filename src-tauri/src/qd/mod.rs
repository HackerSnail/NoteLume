// qd —— Quarkdown 引擎（JS + Rust 重写）
//
// 总体设计见 docs/superpowers/specs/2026-10-25-quarkdown-engine-design.md：
// 引擎只负责「源 Markdown → 求值展开后的 Markdown + 诊断」，HTML 渲染仍走前端
// markdown-it 管线。语法锚点以 .others/quarkdown/docs/*.qd 与 quarkdown-core 源码为准。
//
// 模块：ast（语法树）→ parser（指令行解析）→ eval（求值）→ stdlib（内置函数）。
// 错误模型：单点求值失败进诊断数组、输出原文降级，不炸整个文档。

pub mod ast;
pub mod parser;
