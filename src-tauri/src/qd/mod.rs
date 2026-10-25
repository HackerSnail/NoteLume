// qd —— Quarkdown 引擎（JS + Rust 重写）
//
// 总体设计见 docs/superpowers/specs/2026-10-25-quarkdown-engine-design.md：
// 引擎只负责「源 Markdown → 求值展开后的 Markdown + 诊断」，HTML 渲染仍走前端
// markdown-it 管线。语法锚点以 .others/quarkdown/docs/*.qd 与 quarkdown-core 源码为准。
//
// 模块：ast（语法树）→ parser（指令行解析）→ eval（求值）→ stdlib（内置函数）；
// io（Data 模块的文件访问，阶段 2 批 2）、csv（RFC4180 解析）、mdtable（管道表工具）与
// document（Document / Layout / TableComputation，阶段 2 批 3）；slides / localization /
// bibliography / ecosystem（Slides / Localization / Bibliography / Ecosystem / Libraries，
// 阶段 2 批 4）。
// 错误模型：单点求值失败进诊断数组、输出原文降级，不炸整个文档。

pub mod ast;
pub mod bibliography;
pub mod csv;
pub mod document;
pub mod ecosystem;
pub mod eval;
pub mod io;
pub mod localization;
pub mod mdtable;
pub mod parser;
pub mod slides;
pub mod stdlib;
pub mod value;

#[cfg(test)]
mod e2e_tests {
    /// 端到端：parse → eval 全链路（与 qd_eval 命令同一函数组合）
    fn qd_eval(md: &str) -> (String, Vec<(u32, String)>) {
        let blocks = super::parser::parse_document(md);
        let (expanded, diags) = super::eval::eval_document(&blocks, super::stdlib::builtins(), None);
        (expanded, diags.into_iter().map(|d| (d.line, d.message)).collect())
    }

    #[test]
    fn 组合样例_变量函数条件循环() {
        let src = [
            ".var {name} {NoteLume}",
            ".function {greet}",
            "    to:",
            "    Hello, .to, welcome to .name!",
            "",
            ".greet {world}",
            ".foreach {1..2}",
            "    .1::uppercase",
        ]
        .join("\n");
        let (out, diags) = qd_eval(&src);
        assert_eq!(out, "Hello, world, welcome to NoteLume!\n1\n2");
        assert!(diags.is_empty());
    }

    #[test]
    fn 组合样例_未知函数降级并出诊断() {
        let src = "正文保持\n\n.nope {x}\n\n尾部照常";
        let (out, diags) = qd_eval(src);
        assert!(out.contains(".nope {x}"));
        assert!(out.contains("正文保持"));
        assert!(out.contains("尾部照常"));
        assert_eq!(diags.len(), 1);
    }
}
