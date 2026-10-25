// stdlib.rs —— 最小内置库（阶段 0）：Math / Text / range
//
// 函数名与 Quarkdown stdlib 逐一对齐（.others/quarkdown 的 Math / Text 模块）：
//  sum / subtract / multiply(具名 by:) / divide / pow(具名 to:) / truncate / pi / iseven / isodd / range
//  uppercase / lowercase / uppercasefirst
// 实参约定：eval 层把链式注入的首参排在位置实参最前、全部求值后传入（BuiltinCall），
// builtin 不再接触原始 raw——类型转换错误统一在这里报、由 eval 层降级为原文 + 诊断。
// 纯计算，不碰文件系统与网络——文件类（Data / FileTree）在后续阶段。

use std::collections::HashMap;

use super::eval::{BuiltinCall, BuiltinFn, Evaluator};
use super::value::Value;

/// 位置实参（越界报缺参）
fn pos<'a>(call: &'a BuiltinCall, index: usize) -> Result<&'a Value, String> {
    call.pos.get(index).ok_or_else(|| format!(".{} 缺少第 {} 个实参", call.name, index + 1))
}

fn num<'a>(call: &'a BuiltinCall, index: usize) -> Result<f64, String> {
    pos(call, index)?
        .as_num()
        .ok_or_else(|| format!(".{} 实参不是数字: {}", call.name, call.pos[index].to_output()))
}

/// 具名实参，取不到回落到位置 index（Quarkdown 的 by: / to: 两用口径）
fn named_or_pos<'a>(call: &'a BuiltinCall, name: &str, index: usize) -> Result<&'a Value, String> {
    if let Some((_, v)) = call.named.iter().find(|(n, _)| n == name) {
        return Ok(v);
    }
    pos(call, index)
}

fn register(map: &mut HashMap<String, BuiltinFn>, name: &str, f: BuiltinFn) {
    map.insert(name.to_string(), f);
}

/// 阶段 0 内置函数表
pub fn builtins() -> HashMap<String, BuiltinFn> {
    let mut m: HashMap<String, BuiltinFn> = HashMap::new();

    register(&mut m, "sum", |_, call| {
        let a = num(call, 0)?;
        let b = num(call, 1)?;
        Ok(Value::Num(a + b))
    });
    register(&mut m, "subtract", |_, call| {
        let a = num(call, 0)?;
        let b = num(call, 1)?;
        Ok(Value::Num(a - b))
    });
    register(&mut m, "multiply", |_, call| {
        let a = num(call, 0)?;
        let b = named_or_pos(call, "by", 1)?.as_num().ok_or_else(|| ".multiply 实参不是数字".to_string())?;
        Ok(Value::Num(a * b))
    });
    register(&mut m, "divide", |_, call| {
        let a = num(call, 0)?;
        let b = num(call, 1)?;
        if b == 0.0 {
            return Err(".divide 除零".to_string());
        }
        Ok(Value::Num(a / b))
    });
    register(&mut m, "pow", |_, call| {
        let base = num(call, 0)?;
        let exp = named_or_pos(call, "to", 1)?.as_num().ok_or_else(|| ".pow 指数不是数字".to_string())?;
        Ok(Value::Num(base.powf(exp)))
    });
    register(&mut m, "truncate", |_, call| {
        let n = num(call, 0)?;
        let digits = num(call, 1)? as i32;
        let f = 10f64.powi(digits);
        Ok(Value::Num((n * f).trunc() / f))
    });
    register(&mut m, "pi", |_, _| Ok(Value::Num(std::f64::consts::PI)));
    register(&mut m, "iseven", |_, call| {
        let n = num(call, 0)?;
        Ok(Value::Bool(n % 2.0 == 0.0))
    });
    register(&mut m, "isodd", |_, call| {
        let n = num(call, 0)?;
        Ok(Value::Bool(n % 2.0 != 0.0))
    });
    register(&mut m, "range", |_, call| {
        let from = num(call, 0)? as i64;
        let to = num(call, 1)? as i64;
        Ok(Value::Range(from, to))
    });

    register(&mut m, "uppercase", |_, call| {
        let s = pos(call, 0)?.as_str().ok_or_else(|| ".uppercase 实参不是文本".to_string())?;
        Ok(Value::Str(s.to_uppercase()))
    });
    register(&mut m, "lowercase", |_, call| {
        let s = pos(call, 0)?.as_str().ok_or_else(|| ".lowercase 实参不是文本".to_string())?;
        Ok(Value::Str(s.to_lowercase()))
    });
    register(&mut m, "uppercasefirst", |_, call| {
        let s = pos(call, 0)?.as_str().ok_or_else(|| ".uppercasefirst 实参不是文本".to_string())?;
        let mut c = s.chars();
        match c.next() {
            Some(first) => Ok(Value::Str(first.to_uppercase().collect::<String>() + c.as_str())),
            None => Ok(Value::Str(String::new())),
        }
    });

    m
}

#[cfg(test)]
mod tests {
    use super::super::eval::eval_document;
    use super::super::parser::parse_document;
    use super::*;

    fn out(src: &str) -> String {
        let blocks = parse_document(src);
        eval_document(&blocks, builtins()).0
    }

    fn run(src: &str) -> (String, usize) {
        let blocks = parse_document(src);
        let (text, diags) = eval_document(&blocks, builtins());
        (text, diags.len())
    }

    #[test]
    fn 算术四则() {
        assert_eq!(out(".sum {2} {3}"), "5");
        assert_eq!(out(".sum {2.5} {1}"), "3.5");
        assert_eq!(out(".subtract {5} {2}"), "3");
        assert_eq!(out(".multiply {4} by:{2}"), "8");
        assert_eq!(out(".divide {7} {2}"), "3.5");
    }

    #[test]
    fn 幂与截断与常量() {
        assert_eq!(out(".pow {2} to:{10}"), "1024");
        assert_eq!(out(".truncate {3.789} {2}"), "3.78");
        assert_eq!(out(".pi"), std::f64::consts::PI.to_string());
    }

    #[test]
    fn 奇偶判定与文本函数() {
        assert_eq!(out(".iseven {3}"), "no");
        assert_eq!(out(".isodd {3}"), "yes");
        assert_eq!(out(".uppercase {quarkdown}"), "QUARKDOWN");
        assert_eq!(out(".lowercase {ABC}"), "abc");
        assert_eq!(out(".uppercasefirst {hello}"), "Hello");
    }

    #[test]
    fn 除零与非数字降级出诊断() {
        let (text, n) = run(".divide {5} {0}");
        assert_eq!(text, ".divide {5} {0}");
        assert_eq!(n, 1);
        let (text, n) = run(".sum {a} {b}");
        assert_eq!(text, ".sum {a} {b}");
        assert_eq!(n, 1);
    }

    #[test]
    fn 区间生成与迭代() {
        assert_eq!(out(".range {1} {3}::foreach\n    .1"), "1\n2\n3");
    }

    #[test]
    fn 链式首参注入() {
        assert_eq!(out(".var {n} {5}\n.n::sum {1}"), "6");
        assert_eq!(out(".var {radius} {8}\n.pow {.radius} to:{2}::multiply {.pi}::truncate {2}"), "201.06");
    }

    #[test]
    fn foreach_嵌套奇偶() {
        assert_eq!(out(".foreach {1..3}\n    n:\n    .if {.n::iseven}\n        even .n"), "even 2");
    }
}
