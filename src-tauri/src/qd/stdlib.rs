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

    // ============ Math 补充（阶段 2 批 1）============
    register(&mut m, "rem", |_, call| {
        let a = num(call, 0)?;
        let b = num(call, 1)?;
        if b == 0.0 {
            return Err(".rem 除零".to_string());
        }
        Ok(Value::Num(a % b))
    });
    register(&mut m, "abs", |_, call| Ok(Value::Num(num(call, 0)?.abs())));
    register(&mut m, "negate", |_, call| Ok(Value::Num(-num(call, 0)?)));
    register(&mut m, "sqrt", |_, call| {
        let n = num(call, 0)?;
        if n < 0.0 {
            return Err(".sqrt 负数无平方根".to_string());
        }
        Ok(Value::Num(n.sqrt()))
    });
    register(&mut m, "logn", |_, call| {
        let n = num(call, 0)?;
        let base = num(call, 1)?;
        if n <= 0.0 || base <= 0.0 || base == 1.0 {
            return Err(".logn 定义域错误".to_string());
        }
        Ok(Value::Num(n.log(base)))
    });
    register(&mut m, "sin", |_, call| Ok(Value::Num(num(call, 0)?.sin())));
    register(&mut m, "cos", |_, call| Ok(Value::Num(num(call, 0)?.cos())));
    register(&mut m, "tan", |_, call| Ok(Value::Num(num(call, 0)?.tan())));
    register(&mut m, "round", |_, call| {
        // round {n} {小数位}：四舍五入到指定小数位（与 truncate 同形）
        let n = num(call, 0)?;
        let digits = num(call, 1)? as i32;
        let f = 10f64.powi(digits);
        Ok(Value::Num((n * f).round() / f))
    });

    // ============ Strings（阶段 2 批 1，全部函数名对齐 Kotlin 源码）============
    register(&mut m, "uppercase", |_, call| {
        let s = pos(call, 0)?.as_str().ok_or_else(|| ".uppercase 实参不是文本".to_string())?;
        Ok(Value::Str(s.to_uppercase()))
    });
    register(&mut m, "lowercase", |_, call| {
        let s = pos(call, 0)?.as_str().ok_or_else(|| ".lowercase 实参不是文本".to_string())?;
        Ok(Value::Str(s.to_lowercase()))
    });
    register(&mut m, "capitalize", |_, call| {
        // 首字母大写（Strings 模块 Kotlin capitalize；无 @Name，调用名即函数名小写）
        let s = pos(call, 0)?.as_str().ok_or_else(|| ".capitalize 实参不是文本".to_string())?;
        let mut c = s.chars();
        match c.next() {
            Some(first) => Ok(Value::Str(first.to_uppercase().collect::<String>() + c.as_str())),
            None => Ok(Value::Str(String::new())),
        }
    });
    register(&mut m, "concatenate", |_, call| {
        // 全部位置实参按序拼接（链式注入的首参在最前）
        let joined: String = call.pos.iter().filter_map(|v| v.as_str()).collect();
        Ok(Value::Str(joined))
    });
    register(&mut m, "isempty", |_, call| {
        let s = pos(call, 0)?.as_str().unwrap_or_default();
        Ok(Value::Bool(s.is_empty()))
    });
    register(&mut m, "isnotempty", |_, call| {
        let s = pos(call, 0)?.as_str().unwrap_or_default();
        Ok(Value::Bool(!s.is_empty()))
    });
    register(&mut m, "startswith", |_, call| {
        let s = pos(call, 0)?.as_str().ok_or_else(|| ".startswith 实参不是文本".to_string())?;
        let prefix = pos(call, 1)?.as_str().ok_or_else(|| ".startswith 前缀不是文本".to_string())?;
        Ok(Value::Bool(s.starts_with(&prefix)))
    });
    register(&mut m, "string", |_, call| {
        // 类型转换：任意值 → 文本形态
        let s = pos(call, 0)?.as_str().ok_or_else(|| ".string 无法转换为文本".to_string())?;
        Ok(Value::Str(s))
    });

    // ============ Logical（阶段 2 批 1）============
    // 比较：双方都是数字按数值比，否则按文本比（Quarkdown 弱类型）
    fn cmp_vals(call: &BuiltinCall) -> Result<std::cmp::Ordering, String> {
        let a = pos(call, 0)?;
        let b = pos(call, 1)?;
        if let (Some(x), Some(y)) = (a.as_num(), b.as_num()) {
            return Ok(x.partial_cmp(&y).unwrap_or(std::cmp::Ordering::Equal));
        }
        let (sa, sb) = (
            a.as_str().ok_or_else(|| format!(".{} 实参不可比较", call.name))?,
            b.as_str().ok_or_else(|| format!(".{} 实参不可比较", call.name))?,
        );
        Ok(sa.cmp(&sb))
    }
    register(&mut m, "islower", |_, call| {
        Ok(Value::Bool(cmp_vals(call)? == std::cmp::Ordering::Less))
    });
    register(&mut m, "isgreater", |_, call| {
        Ok(Value::Bool(cmp_vals(call)? == std::cmp::Ordering::Greater))
    });
    register(&mut m, "equals", |_, call| {
        Ok(Value::Bool(cmp_vals(call)? == std::cmp::Ordering::Equal))
    });
    register(&mut m, "not", |_, call| {
        let b = pos(call, 0)?.as_bool().ok_or_else(|| ".not 实参必须是布尔".to_string())?;
        Ok(Value::Bool(!b))
    });
    register(&mut m, "and", |_, call| {
        let a = pos(call, 0)?.as_bool().ok_or_else(|| ".and 实参必须是布尔".to_string())?;
        let b = pos(call, 1)?.as_bool().ok_or_else(|| ".and 实参必须是布尔".to_string())?;
        Ok(Value::Bool(a && b))
    });
    register(&mut m, "or", |_, call| {
        let a = pos(call, 0)?.as_bool().ok_or_else(|| ".or 实参必须是布尔".to_string())?;
        let b = pos(call, 1)?.as_bool().ok_or_else(|| ".or 实参必须是布尔".to_string())?;
        Ok(Value::Bool(a || b))
    });

    // ============ Collection（阶段 2 批 1，名字对齐 @Name 注解；index 从 1 起）============
    // 实参约定：位置 0 = 可迭代集合（链式注入或显式传入），其余位置 / 具名见各函数。
    // findfirst / sortby / groupvalues 需要 lambda 引用与字典类型，随后续批次。
    fn items_arg<'a>(call: &'a BuiltinCall, index: usize) -> Result<Vec<Value>, String> {
        pos(call, index)?
            .as_items()
            .ok_or_else(|| format!(".{} 实参不可迭代", call.name))
    }
    fn get_at_index(items: &[Value], index: usize) -> Option<&Value> {
        items.get(index)
    }
    register(&mut m, "getat", |_, call| {
        let items = items_arg(call, 0)?;
        let index = num(call, 1)? as i64;
        if index < 1 {
            return Err(".getat 序号从 1 开始".to_string());
        }
        match get_at_index(&items, (index - 1) as usize) {
            Some(v) => Ok(v.clone()),
            None => match call.named.iter().find(|(n, _)| n == "orelse") {
                Some((_, v)) => Ok(v.clone()),
                None => Err(format!(".getat 序号 {} 越界", index)),
            },
        }
    });
    for spec in [("first", 0usize), ("second", 1), ("third", 2)] {
        // fn 指针不能捕获变量：按 offset 生成具体注册
        let (name, offset) = spec;
        let f: BuiltinFn = match offset {
            0 => |_, call| {
                let items = items_arg(call, 0)?;
                match get_at_index(&items, 0) {
                    Some(v) => Ok(v.clone()),
                    None => match call.named.iter().find(|(n, _)| n == "orelse") {
                        Some((_, v)) => Ok(v.clone()),
                        None => Err(".first 集合元素不足".to_string()),
                    },
                }
            },
            1 => |_, call| {
                let items = items_arg(call, 0)?;
                match get_at_index(&items, 1) {
                    Some(v) => Ok(v.clone()),
                    None => match call.named.iter().find(|(n, _)| n == "orelse") {
                        Some((_, v)) => Ok(v.clone()),
                        None => Err(".second 集合元素不足".to_string()),
                    },
                }
            },
            _ => |_, call| {
                let items = items_arg(call, 0)?;
                match get_at_index(&items, 2) {
                    Some(v) => Ok(v.clone()),
                    None => match call.named.iter().find(|(n, _)| n == "orelse") {
                        Some((_, v)) => Ok(v.clone()),
                        None => Err(".third 集合元素不足".to_string()),
                    },
                }
            },
        };
        register(&mut m, name, f);
    }
    register(&mut m, "last", |_, call| {
        let items = items_arg(call, 0)?;
        match items.last() {
            Some(v) => Ok(v.clone()),
            None => Err(".last 集合为空".to_string()),
        }
    });
    register(&mut m, "size", |_, call| {
        let items = items_arg(call, 0)?;
        Ok(Value::Num(items.len() as f64))
    });
    register(&mut m, "sumall", |_, call| {
        let items = items_arg(call, 0)?;
        let mut total = 0.0;
        for v in &items {
            total += v
                .as_num()
                .ok_or_else(|| format!(".sumall 元素不是数字: {}", v.to_output()))?;
        }
        Ok(Value::Num(total))
    });
    register(&mut m, "average", |_, call| {
        let items = items_arg(call, 0)?;
        if items.is_empty() {
            return Err(".average 集合为空".to_string());
        }
        let mut total = 0.0;
        for v in &items {
            total += v
                .as_num()
                .ok_or_else(|| format!(".average 元素不是数字: {}", v.to_output()))?;
        }
        Ok(Value::Num(total / items.len() as f64))
    });
    register(&mut m, "distinct", |_, call| {
        let items = items_arg(call, 0)?;
        let mut seen: Vec<String> = Vec::new();
        let mut out: Vec<Value> = Vec::new();
        for v in items {
            let key = v.to_output();
            if !seen.contains(&key) {
                seen.push(key);
                out.push(v);
            }
        }
        Ok(Value::List(out))
    });
    register(&mut m, "sorted", |_, call| {
        let mut items = items_arg(call, 0)?;
        // 数值优先、文本兜底（与 isgreater 同口径）
        items.sort_by(|a, b| {
            if let (Some(x), Some(y)) = (a.as_num(), b.as_num()) {
                return x.partial_cmp(&y).unwrap_or(std::cmp::Ordering::Equal);
            }
            a.to_output().cmp(&b.to_output())
        });
        Ok(Value::List(items))
    });
    register(&mut m, "reversed", |_, call| {
        let mut items = items_arg(call, 0)?;
        items.reverse();
        Ok(Value::List(items))
    });
    register(&mut m, "prepended", |_, call| {
        // 与 appended 同形：to:{集合} + value:{元素}（链式注入集合在 pos[0]）
        let mut items = items_arg(call, 0)?;
        let value = named_or_pos(call, "value", 1)?.clone();
        items.insert(0, value);
        Ok(Value::List(items))
    });
    register(&mut m, "appended", |_, call| {
        let mut items = items_arg(call, 0)?;
        let value = named_or_pos(call, "value", 1)?.clone();
        items.push(value);
        Ok(Value::List(items))
    });
    register(&mut m, "joinstring", |_, call| {
        let items = items_arg(call, 0)?;
        let sep = pos(call, 1)?.as_str().ok_or_else(|| ".joinstring 分隔符不是文本".to_string())?;
        let parts: Vec<String> = items.iter().map(|v| v.to_output()).collect();
        Ok(Value::Str(parts.join(&sep)))
    });
    register(&mut m, "withindices", |_, call| {
        // 每个元素配 1 起始的序号，产出二元列表 [序号, 元素]——取用 .1::first / .1::second
        let items = items_arg(call, 0)?;
        let pairs: Vec<Value> = items
            .into_iter()
            .enumerate()
            .map(|(i, v)| Value::List(vec![Value::Num((i + 1) as f64), v]))
            .collect();
        Ok(Value::List(pairs))
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
        assert_eq!(out(".capitalize {hello}"), "Hello");
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

    // —— 阶段 2 批 1：Strings / Logical / Math 补充 / Collection ——

    #[test]
    fn 字符串模块() {
        assert_eq!(out(".capitalize {hello world}"), "Hello world");
        assert_eq!(out(".concatenate {a} {b} {c}"), "abc");
        assert_eq!(out(".var {s} {}\n.if {.s::isempty}\n    empty"), "empty");
        assert_eq!(out(".var {s2} {abc}\n.if {.s2::isnotempty}\n    has"), "has");
        assert_eq!(out(".var {h} {hello}\n.if {.h::startswith {he}}\n    yes"), "yes");
        assert_eq!(out(".string {42}"), "42");
    }

    #[test]
    fn 逻辑与比较() {
        assert_eq!(out(".if {.isgreater {3} {2}}\n    bigger"), "bigger");
        assert_eq!(out(".if {.islower {3} {2}}\n    smaller"), "");
        assert_eq!(out(".if {.equals {5} {5}}\n    eq"), "eq");
        assert_eq!(out(".if {.equals {abc} {abc}}\n    eq"), "eq");
        assert_eq!(out(".if {.not {no}}\n    negated"), "negated");
        assert_eq!(out(".if {.and {yes} {no}}\n    a"), "");
        assert_eq!(out(".if {.or {no} {yes}}\n    a"), "a");
    }

    #[test]
    fn 数学补充() {
        assert_eq!(out(".rem {7} {3}"), "1");
        assert_eq!(out(".abs {-4}"), "4");
        assert_eq!(out(".negate {6}"), "-6");
        assert_eq!(out(".sqrt {9}"), "3");
        assert_eq!(out(".logn {8} {2}"), "3");
        assert_eq!(out(".round {3.14159} {2}"), "3.14");
    }

    #[test]
    fn 集合访问与统计() {
        assert_eq!(out(".var {l}\n    - 10\n    - 20\n    - 30\n\n.size {.l}"), "3");
        assert_eq!(out(".var {l}\n    - 10\n    - 20\n    - 30\n\n.getat {.l} {2}"), "20");
        assert_eq!(out(".var {l}\n    - 10\n    - 20\n    - 30\n\n.l::first"), "10");
        assert_eq!(out(".var {l}\n    - 10\n    - 20\n    - 30\n\n.l::last"), "30");
        assert_eq!(out(".var {l}\n    - 10\n    - 20\n    - 30\n\n.sumall {.l}"), "60");
        assert_eq!(out(".var {l}\n    - 10\n    - 20\n    - 30\n\n.average {.l}"), "20");
    }

    #[test]
    fn 集合变换() {
        assert_eq!(out(".var {l}\n    - 3\n    - 1\n    - 2\n\n.l::sorted::foreach\n    .1"), "1\n2\n3");
        assert_eq!(out(".var {l}\n    - 1\n    - 2\n\n.l::reversed::foreach\n    .1"), "2\n1");
        assert_eq!(out(".var {l}\n    - a\n    - a\n    - b\n\n.l::distinct::size"), "2");
        assert_eq!(out(".var {l}\n    - b\n\n.l::prepended {a}::foreach\n    .1"), "a\nb");
        assert_eq!(out(".var {l}\n    - a\n\n.l::appended {b}::foreach\n    .1"), "a\nb");
        // 实参首尾空白按 Quarkdown 口径 trim：分隔符 {, } 落成 ","
        assert_eq!(out(".var {l}\n    - a\n    - b\n\n.joinstring {.l} {, }"), "a,b");
    }

    #[test]
    fn withindices_配对() {
        assert_eq!(
            out(".var {letters}\n    - A\n    - B\n\n.letters::withindices::foreach\n    .1::first .1::second"),
            "1 A\n2 B"
        );
    }

    #[test]
    fn 集合越界与类型错误降级() {
        let (text, n) = run(".var {l}\n    - a\n\n.getat {.l} {5}");
        assert_eq!(text.contains(".getat"), true);
        assert_eq!(n, 1);
        let (text, n) = run(".sumall {5}\n    - x\n\nx");
        // sumall 元素非数字 → 降级原文
        assert_eq!(n >= 1, true);
        let _ = text;
    }
}



