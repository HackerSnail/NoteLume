// stdlib.rs —— 内置库
//
// 函数名与 Quarkdown stdlib 逐一对齐（.others/quarkdown 的 Kotlin 源码）：
//  阶段 0：Math / Text 基础（sum / subtract / multiply / divide / pow / truncate / pi /
//          iseven / isodd / range / uppercase / lowercase / uppercasefirst）
//  阶段 2 批 1：Strings 全量 / Logical 全量 / Math 补充 / Collection 17 个
//  阶段 2 批 2：Data（read / pathtoroot / listfiles / filename / json / csv）+
//          Dictionary.get（.json 的取值入口）+ filetree（MiscElements）
//  阶段 2 批 4：Dictionary.dictionary（本文件）；Slides / Localization / Bibliography /
//          Ecosystem（include）/ Libraries 查询在各自模块文件
// 实参约定：eval 层把链式注入的首参排在位置实参最前、全部求值后传入（BuiltinCall），
// builtin 不再接触原始 raw——类型转换错误统一在这里报、由 eval 层降级为原文 + 诊断。
// 文件类函数经 QdIo（Evaluator.doc_dir）访问文件系统：只认相对文档目录的路径，
// 绝对路径与越界一律诊断降级（口径见 io.rs）。

use std::collections::HashMap;

use super::ast::Block;
use super::csv::{cell_to_md, parse_csv};
use super::document;
use super::eval::{Builtin, BuiltinCall, BuiltinFn};
use super::io::{regex_search, QdIo};
use super::value::Value;

/// 位置实参（越界报缺参）
pub(crate) fn pos<'a>(call: &'a BuiltinCall, index: usize) -> Result<&'a Value, String> {
    call.pos.get(index).ok_or_else(|| format!(".{} 缺少第 {} 个实参", call.name, index + 1))
}

pub(crate) fn num<'a>(call: &'a BuiltinCall, index: usize) -> Result<f64, String> {
    pos(call, index)?
        .as_num()
        .ok_or_else(|| format!(".{} 实参不是数字: {}", call.name, call.pos[index].to_output()))
}

/// 具名实参，取不到回落到位置 index（Quarkdown 的 by: / to: 两用口径）
pub(crate) fn named_or_pos<'a>(call: &'a BuiltinCall, name: &str, index: usize) -> Result<&'a Value, String> {
    if let Some((_, v)) = call.named.iter().find(|(n, _)| n == name) {
        return Ok(v);
    }
    pos(call, index)
}

fn register(map: &mut HashMap<String, Builtin>, name: &str, f: BuiltinFn) {
    register_l(map, name, &[], f)
}

/// 带 lambda 实参声明的注册：lambda_args 条目为具名参数名或 "pos:N"（见 Builtin 注释）
fn register_l(map: &mut HashMap<String, Builtin>, name: &str, lambda_args: &'static [&'static str], f: BuiltinFn) {
    map.insert(name.to_string(), Builtin { f, lambda_args });
}

/// 内置函数总表：阶段 0/2 批 1/2 的 Math / Strings / Logical / Collection / Data /
/// Dictionary.get / filetree 在本文件，Document / Layout / TableComputation 在 document.rs。
pub fn builtins() -> HashMap<String, Builtin> {
    let mut m: HashMap<String, Builtin> = HashMap::new();

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
        // Kotlin 侧小数指数截断为整数（exponent.toInt()）
        Ok(Value::Num(base.powf(exp.trunc())))
    });
    register(&mut m, "truncate", |_, call| {
        // truncate {n} [decimals:{小数位}]：Kotlin 的 decimals 是 LikelyNamed，位置与具名两用
        let n = num(call, 0)?;
        let digits = named_or_pos(call, "decimals", 1)?
            .as_num()
            .ok_or_else(|| ".truncate 的小数位不是数字".to_string())? as i32;
        if digits < 0 {
            return Err(".truncate 小数位不能为负".to_string());
        }
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
        // 自然对数（对齐 Kotlin：kotlin.math.ln，单参数；此前误实现成按底对数）
        let n = num(call, 0)?;
        if n <= 0.0 {
            return Err(".logn 定义域错误".to_string());
        }
        Ok(Value::Num(n.ln()))
    });
    register(&mut m, "sin", |_, call| Ok(Value::Num(num(call, 0)?.sin())));
    register(&mut m, "cos", |_, call| Ok(Value::Num(num(call, 0)?.cos())));
    register(&mut m, "tan", |_, call| Ok(Value::Num(num(call, 0)?.tan())));
    register(&mut m, "round", |_, call| {
        // 四舍五入取整（对齐 Kotlin 单参数口径；此前多出的 decimals 参数移除）
        let n = num(call, 0)?;
        Ok(Value::Num(n.round()))
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
    register_l(&mut m, "findfirst", &["pos:1", "condition"], |ev, call| {
        // findfirst {条件 lambda}：首个满足条件的元素；全不满足时无输出（Kotlin NOT_FOUND → 空）
        let items = items_arg(call, 0)?;
        let cond = pos(call, 1)?;
        for item in items {
            let hit = ev.call_lambda(cond, &[item.clone()], 0).map_err(|()| ".findfirst 条件求值失败".to_string())?;
            match hit.as_bool() {
                Some(true) => return Ok(item),
                Some(false) => {}
                None => return Err(".findfirst 条件必须返回布尔（yes / no）".to_string()),
            }
        }
        Ok(Value::None)
    });
    register(&mut m, "groupvalues", |_, call| {
        // groupvalues：按元素相等分组（组间保持首次出现顺序），产出组的集合
        let items = items_arg(call, 0)?;
        let mut order: Vec<String> = Vec::new();
        let mut groups: Vec<Vec<Value>> = Vec::new();
        for v in items {
            let key = v.to_output();
            match order.iter().position(|k| k == &key) {
                Some(i) => groups[i].push(v),
                None => {
                    order.push(key);
                    groups.push(vec![v]);
                }
            }
        }
        Ok(Value::List(groups.into_iter().map(Value::List).collect()))
    });

    // ============ Data（阶段 2 批 2，名字对齐 Data.kt 的 @Name 注解）============
    // 布尔类具名参数统一收 yes / no（Quarkdown 布尔字面量口径）
    fn named_bool(call: &BuiltinCall, name: &str, default: bool) -> Result<bool, String> {
        match call.named.iter().find(|(n, _)| n == name) {
            Some((_, v)) => v
                .as_bool()
                .ok_or_else(|| format!(".{} 的 {}: 必须是 yes / no", call.name, name)),
            None => Ok(default),
        }
    }
    fn named_str(call: &BuiltinCall, name: &str) -> Result<Option<String>, String> {
        match call.named.iter().find(|(n, _)| n == name) {
            Some((_, v)) => v
                .as_str()
                .map(Some)
                .ok_or_else(|| format!(".{} 的 {}: 必须是文本", call.name, name)),
            None => Ok(None),
        }
    }

    register(&mut m, "read", |ev, call| {
        // read {path} [lines:{2..4}]：读整个文件为文本；给了行区间按 1 起始闭区间切片（越界报错）
        let path = pos(call, 0)?.as_str().ok_or_else(|| ".read 路径必须是文本".to_string())?;
        let io = QdIo::new(ev.doc_dir.clone());
        let text = io.read_text(&path)?;
        let lines = call
            .named
            .iter()
            .find(|(n, _)| n == "lines")
            .map(|(_, v)| v.clone())
            .or_else(|| call.pos.get(1).cloned());
        match lines {
            None | Some(Value::None) => Ok(Value::Str(text)),
            Some(Value::Range(a, b)) => {
                if a < 1 {
                    return Err(".read 行号从 1 开始".to_string());
                }
                let all: Vec<&str> = text.split('\n').collect();
                if b as usize > all.len() {
                    return Err(format!(".read 行区间 {}..{} 越界（共 {} 行）", a, b, all.len()));
                }
                let slice = all[(a - 1) as usize..b as usize]
                    .iter()
                    .map(|l| l.trim_end_matches('\r'))
                    .collect::<Vec<_>>()
                    .join("\n");
                Ok(Value::Str(slice))
            }
            Some(_) => Err(".read 的 lines: 必须是区间（如 {2..4}）".to_string()),
        }
    });
    register(&mut m, "pathtoroot", |_, call| {
        // pathtoroot [granularity:{project|subdocument}]：文档到编译根的相对路径。
        // NoteLume 的编译根就是文档所在目录，恒为 "."；granularity 收下不区分（对齐调用形态）。
        let _ = call;
        Ok(Value::Str(".".to_string()))
    });
    register(&mut m, "listfiles", |ev, call| {
        // listfiles {path} [directories:{yes}] [recursive:{no}] [pattern:{"\\.md$"}]
        //           [fullpath:{yes}] [sortby:{none|name|lastmodified}] [order:{ascending|descending}]
        let path = pos(call, 0)?.as_str().ok_or_else(|| ".listfiles 路径必须是文本".to_string())?;
        let directories = named_bool(call, "directories", true)?;
        let recursive = named_bool(call, "recursive", false)?;
        let fullpath = named_bool(call, "fullpath", true)?;
        let pattern = named_str(call, "pattern")?;
        let sortby = named_str(call, "sortby")?.map(|s| s.to_lowercase()).unwrap_or_else(|| "none".to_string());
        let order = named_str(call, "order")?.map(|s| s.to_lowercase()).unwrap_or_else(|| "ascending".to_string());
        if !matches!(sortby.as_str(), "none" | "name" | "lastmodified") {
            return Err(".listfiles sortby 只认 none / name / lastmodified".to_string());
        }
        if !matches!(order.as_str(), "ascending" | "descending") {
            return Err(".listfiles order 只认 ascending / descending".to_string());
        }
        let io = QdIo::new(ev.doc_dir.clone());
        let mut paths = io.list(&path, recursive)?;
        if !directories {
            paths.retain(|p| !p.is_dir());
        }
        if let Some(pat) = &pattern {
            let mut kept = Vec::new();
            for p in paths {
                let name = p.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default();
                match regex_search(pat, &name) {
                    Ok(true) => kept.push(p),
                    Ok(false) => {}
                    Err(e) => return Err(format!(".listfiles pattern 错误: {}", e)),
                }
            }
            paths = kept;
        }
        match sortby.as_str() {
            "name" => paths.sort_by_key(|p| p.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default()),
            "lastmodified" => paths.sort_by_key(|p| io.modified_millis(p).unwrap_or(0)),
            _ => {}
        }
        if order == "descending" {
            paths.reverse();
        }
        let base = io.resolve(".")?;
        let strs: Vec<String> = paths
            .iter()
            .map(|p| {
                if fullpath {
                    // 工作目录相对路径，/ 分隔（文档内引用友好，不出平台绝对路径）
                    p.strip_prefix(&base).unwrap_or(p).to_string_lossy().replace('\\', "/")
                } else {
                    p.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_default()
                }
            })
            .collect();
        Ok(Value::List(strs.into_iter().map(Value::Str).collect()))
    });
    register(&mut m, "filename", |ev, call| {
        // filename {path} [extension:{yes}]：文件名（可去扩展名）；文件必须存在（Kotlin 同）
        let path = pos(call, 0)?.as_str().ok_or_else(|| ".filename 路径必须是文本".to_string())?;
        let ext = call
            .named
            .iter()
            .find(|(n, _)| n == "extension")
            .map(|(_, v)| v.as_bool().ok_or_else(|| ".filename 的 extension: 必须是 yes / no".to_string()))
            .transpose()?
            .unwrap_or_else(|| call.pos.get(1).and_then(|v| v.as_bool()).unwrap_or(true));
        let io = QdIo::new(ev.doc_dir.clone());
        let p = io.resolve(&path)?;
        let name = if ext {
            p.file_name()
        } else {
            p.file_stem()
        }
        .map(|n| n.to_string_lossy().to_string())
        .ok_or_else(|| ".filename 取不到文件名".to_string())?;
        Ok(Value::Str(name))
    });
    register(&mut m, "json", |ev, call| {
        // json {path}：读 JSON 文件为字典（对象）；数组 → 列表；标量按类型
        let path = pos(call, 0)?.as_str().ok_or_else(|| ".json 路径必须是文本".to_string())?;
        let io = QdIo::new(ev.doc_dir.clone());
        let text = io.read_text(&path)?;
        let v: serde_json::Value = serde_json::from_str(&text).map_err(|e| format!(".json 解析失败: {}", e))?;
        Ok(json_to_value(&v))
    });
    register(&mut m, "csv", |ev, call| {
        // csv {path} [mode:{plain}] [caption:{}]：CSV 文件 → Markdown 管道表格（首行是表头）。
        // Quarkdown 产出 Table AST 节点，本引擎输出文本，Markdown 表格是最近的等价形态；
        // mode 的 markdown（单元格按行内语法重解析）与 ref 交叉引用暂不支持。
        let path = pos(call, 0)?.as_str().ok_or_else(|| ".csv 路径必须是文本".to_string())?;
        if let Some(mode) = named_str(call, "mode")? {
            if mode.to_lowercase() != "plain" {
                return Err(".csv 只支持 mode plain（markdown 模式暂不支持）".to_string());
            }
        }
        let caption = named_str(call, "caption")?;
        let io = QdIo::new(ev.doc_dir.clone());
        let text = io.read_text(&path)?;
        let rows = parse_csv(&text);
        if rows.is_empty() {
            return Err(".csv 文件为空".to_string());
        }
        let cols = rows[0].len();
        let mut out = String::new();
        for (i, row) in rows.iter().enumerate() {
            if i == 1 {
                out.push('|');
                for _ in 0..cols {
                    out.push_str(" --- |");
                }
                out.push('\n');
            }
            out.push('|');
            for c in 0..cols {
                out.push_str(&format!(" {} |", cell_to_md(row.get(c).map(String::as_str).unwrap_or(""))));
            }
            out.push('\n');
        }
        if let Some(cap) = caption {
            out.push_str(&format!("\n*{}*", cap));
        }
        Ok(Value::Markdown(out.trim_end().to_string()))
    });

    // ============ Dictionary（批 2 的 .json 取值入口 + 批 4 的显式字典构造）============
    // Kotlin 的 Dictionary 模块全量就是 dictionary / get 两个函数——字典的其余操作
    // 靠「字典 → [键, 值] 对集合」适配复用 Collection 函数，本引擎 as_items 已支持。
    register(&mut m, "get", |_, call| {
        let dict = pos(call, 0)?;
        let key = pos(call, 1)?.as_str().ok_or_else(|| ".get 键名必须是文本".to_string())?;
        match dict {
            Value::Dict(entries) => Ok(entries
                .iter()
                .find(|(k, _)| k == &key)
                .map(|(_, v)| v.clone())
                // 缺键回落 orelse（Kotlin 默认 NOT_FOUND → 空串，本引擎 None 输出同为空串）
                .unwrap_or_else(|| {
                    call.named
                        .iter()
                        .find(|(n, _)| n == "orelse")
                        .map(|(_, v)| v.clone())
                        .unwrap_or(Value::None)
                })),
            _ => Err(".get 实参不是字典（用 .json 读一个，或 .dictionary 构造）".to_string()),
        }
    });
    register(&mut m, "dictionary", |ev, call| {
        let body = match &call.body {
            Some(b) if !b.is_empty() => b,
            _ => return Err(".dictionary 需要 Markdown 列表作为块参数".to_string()),
        };
        let mut lines: Vec<String> = Vec::new();
        for b in body {
            match b {
                Block::Text(t) => lines.extend(t.split('\n').map(|s| s.to_string())),
                Block::Inline(segs) => lines.push(ev.eval_inline(segs)),
                Block::Call(c) => match ev.eval_call(c) {
                    Ok(v) => lines.push(v.to_output()),
                    Err(()) => lines.push(c.src.clone()),
                },
            }
        }
        let mut entries: Vec<(usize, String)> = Vec::new();
        for l in &lines {
            let t = l.trim_end();
            if let Some(rest) = t.trim_start().strip_prefix("- ") {
                let text = rest.trim();
                if !text.is_empty() {
                    entries.push((t.len() - t.trim_start().len(), text.to_string()));
                }
            }
        }
        if entries.is_empty() {
            return Err(".dictionary 块参数里没有 Markdown 列表".to_string());
        }
        // 缩进层级按出现过的缩进值定级（2 / 4 空格风格都吃），相对首项归零
        let mut levels: Vec<usize> = entries.iter().map(|(i, _)| *i).collect();
        levels.sort_unstable();
        levels.dedup();
        let items: Vec<(usize, String)> = entries
            .into_iter()
            .map(|(i, t)| (levels.iter().position(|&l| l == i).unwrap_or(0), t))
            .collect();
        let mut idx = 0;
        let dict = build_dict(&items, &mut idx, 0);
        Ok(Value::Dict(dict))
    });

    // ============ FileTree（MiscElements.kt，阶段 2 批 2）============
    // .filetree + Markdown 列表块参数 → 规范化的文件树列表：目录补尾斜杠、... / … 归一成 …、
    // 粗体（高亮）保留。Quarkdown 渲染成 file-tree HTML，本引擎输出 Markdown 列表
    // （与其 GFM 渲染器回退形态一致）。body 里的行内调用照常求值。
    register(&mut m, "filetree", |ev, call| {
        let body = match &call.body {
            Some(b) if !b.is_empty() => b,
            _ => return Err(".filetree 需要 Markdown 列表作为块参数".to_string()),
        };
        let mut lines: Vec<String> = Vec::new();
        for b in body {
            match b {
                Block::Text(t) => lines.extend(t.split('\n').map(|s| s.to_string())),
                Block::Inline(segs) => lines.push(ev.eval_inline(segs)),
                Block::Call(c) => match ev.eval_call(c) {
                    Ok(v) => lines.push(v.to_output()),
                    Err(()) => lines.push(c.src.clone()),
                },
            }
        }
        struct FtItem {
            text: String,
            children: Vec<FtItem>,
        }
        // 收集列表项（缩进, 文本）；散行忽略（Kotlin 只取 body 里的列表）
        let mut entries: Vec<(usize, String)> = Vec::new();
        for l in &lines {
            let t = l.trim_end();
            if let Some(rest) = t.trim_start().strip_prefix("- ") {
                let text = rest.trim();
                if !text.is_empty() {
                    entries.push((t.len() - t.trim_start().len(), text.to_string()));
                }
            }
        }
        if entries.is_empty() {
            return Err(".filetree 块参数里没有 Markdown 列表".to_string());
        }
        // 相对首项缩进建树：每两级空格一层
        let base = entries[0].0;
        let mut forest: Vec<FtItem> = Vec::new();
        let mut stack: Vec<(usize, FtItem)> = Vec::new();
        for (raw, text) in entries {
            let depth = raw.saturating_sub(base) / 2;
            while stack.last().map_or(false, |(d, _)| *d >= depth) {
                let (_, done) = stack.pop().unwrap();
                match stack.last_mut() {
                    Some((_, parent)) => parent.children.push(done),
                    None => forest.push(done),
                }
            }
            stack.push((depth, FtItem { text, children: Vec::new() }));
        }
        while let Some((_, done)) = stack.pop() {
            match stack.last_mut() {
                Some((_, parent)) => parent.children.push(done),
                None => forest.push(done),
            }
        }
        fn render(items: &[FtItem], level: usize, out: &mut Vec<String>) {
            for it in items {
                let indent = "  ".repeat(level);
                if it.text == "..." || it.text == "…" {
                    out.push(format!("{}- …", indent));
                } else if it.children.is_empty() {
                    out.push(format!("{}- {}", indent, it.text));
                } else {
                    out.push(format!("{}- {}/", indent, it.text.trim_end_matches('/')));
                    render(&it.children, level + 1, out);
                }
            }
        }
        let mut out = Vec::new();
        render(&forest, 0, &mut out);
        Ok(Value::Markdown(out.join("\n")))
    });

    // ============ Document / Layout / TableComputation（阶段 2 批 3，见 document.rs）============
    document::register(&mut m);

    // ============ Slides / Localization / Bibliography / Ecosystem / Libraries（阶段 2 批 4）============
    super::slides::register(&mut m);
    super::localization::register(&mut m);
    super::bibliography::register(&mut m);
    super::ecosystem::register(&mut m);

    // ============ Mermaid / 交叉引用（阶段 3）============
    super::mermaid::register(&mut m);
    super::reference::register(&mut m);

    m
}

/// 字典列表递归构建：`- key: value` 行内值按字面量推断（数字 / yes|no 落型），
/// `- key` 无行内值时：有子级落嵌套字典（Kotlin 的嵌套列表 → 嵌套字典），无子级落空字典。
fn build_dict(items: &[(usize, String)], idx: &mut usize, depth: usize) -> Vec<(String, Value)> {
    let mut dict: Vec<(String, Value)> = Vec::new();
    while *idx < items.len() {
        let (d, text) = &items[*idx];
        if *d < depth {
            break;
        }
        if *d > depth {
            // 跳层防御：不认识的更深层级跳过，不挂死循环
            *idx += 1;
            continue;
        }
        *idx += 1;
        let (key, inline) = match text.split_once(':') {
            Some((k, v)) => (k.trim().to_string(), v.trim().to_string()),
            None => (text.clone(), String::new()),
        };
        if key.is_empty() {
            continue;
        }
        let children = if *idx < items.len() && items[*idx].0 > depth {
            Some(build_dict(items, idx, depth + 1))
        } else {
            None
        };
        let value = match children {
            Some(c) => Value::Dict(c),
            None if inline.is_empty() => Value::Dict(Vec::new()),
            None => super::eval::infer_literal_like(&inline),
        };
        dict.push((key, value));
    }
    dict
}

/// serde_json 值 → 求值器值：对象 → 字典（保持键序）、数组 → 列表、标量按类型
fn json_to_value(v: &serde_json::Value) -> Value {
    match v {
        serde_json::Value::Null => Value::None,
        serde_json::Value::Bool(b) => Value::Bool(*b),
        serde_json::Value::Number(n) => Value::Num(n.as_f64().unwrap_or(0.0)),
        serde_json::Value::String(s) => Value::Str(s.clone()),
        serde_json::Value::Array(items) => Value::List(items.iter().map(json_to_value).collect()),
        serde_json::Value::Object(map) => Value::Dict(map.iter().map(|(k, v)| (k.clone(), json_to_value(v))).collect()),
    }
}

#[cfg(test)]
mod tests {
    use super::super::eval::eval_document;
    use super::super::parser::parse_document;
    use super::*;

    fn out(src: &str) -> String {
        let blocks = parse_document(src);
        eval_document(&blocks, builtins(), None).0
    }

    fn run(src: &str) -> (String, usize) {
        let blocks = parse_document(src);
        let (text, diags) = eval_document(&blocks, builtins(), None);
        (text, diags.len())
    }

    fn out_in(src: &str, doc_dir: Option<std::path::PathBuf>) -> String {
        let blocks = parse_document(src);
        eval_document(&blocks, builtins(), doc_dir).0
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
        // 自然对数（对齐 Kotlin）；round 四舍五入取整
        assert_eq!(out(".logn {1}"), "0");
        assert_eq!(out(".round {3.6}"), "4");
        assert_eq!(out(".round {3.4}"), "3");
        // 小数指数截断为整数（Kotlin exponent.toInt()）
        assert_eq!(out(".pow {2} to:{2.9}"), "4");
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

    // —— 阶段 2 批 4：Dictionary 构造与 orelse ——

    #[test]
    fn dictionary_构造与取值() {
        let src = ".var {d}\n    .dictionary\n        - name: qd\n        - count: 3\n        - ok: yes\n\n.d::get {name} .d::get {count} .d::get {ok}";
        assert_eq!(out(src), "qd 3 yes");
        // 嵌套列表 → 嵌套字典；无值条目 → 空字典；块变量存字典保住类型
        let src2 = ".var {d2}\n    .dictionary\n        - outer\n          - inner: 1\n        - empty\n\n.d2::get {outer}::get {inner}";
        assert_eq!(out(src2), "1");
        // 字典按 [键, 值] 对参与集合运算
        assert_eq!(out(".var {d2}\n    .dictionary\n        - a: 1\n        - b: 2\n\n.size {.d2}"), "2");
    }

    #[test]
    fn dictionary_缺块参数降级() {
        let (text, n) = run(".dictionary {x}");
        assert!(text.contains(".dictionary"));
        assert_eq!(n, 1);
    }

    #[test]
    fn get_缺键回落orelse() {
        let src = ".var {d}\n    .dictionary\n        - a: 1\n\n.d::get {zzz} orelse:{none-found}";
        assert_eq!(out(src), "none-found");
        assert_eq!(out(".var {d3}\n    .dictionary\n        - a: 1\n\n.d3::get {zzz}"), "");
    }

    // —— 阶段 2 批 2：Data / Dictionary.get / filetree ——

    /// 临时文档目录：notes.txt / data.csv / cfg.json / sub/inner.md
    /// 测试并发跑，目录按序号隔离（共享目录会互相 remove_dir_all）
    fn temp_docs() -> std::path::PathBuf {
        use std::sync::atomic::{AtomicU32, Ordering};
        static SEQ: AtomicU32 = AtomicU32::new(0);
        let dir = std::env::temp_dir().join(format!(
            "nl-qd-test-{}-{}",
            std::process::id(),
            SEQ.fetch_add(1, Ordering::SeqCst)
        ));
        std::fs::create_dir_all(dir.join("sub")).unwrap();
        std::fs::write(dir.join("notes.txt"), "alpha\nbeta\ngamma\n").unwrap();
        std::fs::write(dir.join("data.csv"), "name,score\nalice,90\nbob,85\n").unwrap();
        std::fs::write(dir.join("cfg.json"), r#"{"name":"qd","n":3,"ok":true,"tags":["a","b"],"sub":{"x":1}}"#).unwrap();
        std::fs::write(dir.join("sub").join("inner.md"), "# inner\n").unwrap();
        dir
    }

    #[test]
    fn read_全文与行区间() {
        let dir = temp_docs();
        assert_eq!(out_in(".read {notes.txt}", Some(dir.clone())), "alpha\nbeta\ngamma");
        assert_eq!(out_in(".read {notes.txt} lines:{2..3}", Some(dir.clone())), "beta\ngamma");
        // 行区间越界 → 降级原文 + 诊断
        let (text, n) = {
            let blocks = parse_document(".read {notes.txt} lines:{2..9}");
            let (t, d) = eval_document(&blocks, builtins(), Some(dir.clone()));
            (t, d.len())
        };
        assert!(text.contains(".read"));
        assert_eq!(n, 1);
    }

    #[test]
    fn read_无工作目录与越界路径降级() {
        // 没有 doc_dir（画布 / 未落盘）：IO 函数整体诊断降级
        let (text, n) = run(".read {notes.txt}");
        assert!(text.contains(".read"));
        assert_eq!(n, 1);
        // .. 越出工作目录拒绝
        let (text, n) = out_in_return(".read {../outside.txt}", Some(temp_docs()));
        assert!(text.contains(".read"));
        assert_eq!(n, 1);
    }

    fn out_in_return(src: &str, doc_dir: Option<std::path::PathBuf>) -> (String, usize) {
        let blocks = parse_document(src);
        let (t, d) = eval_document(&blocks, builtins(), doc_dir);
        (t, d.len())
    }

    #[test]
    fn listfiles_过滤与排序() {
        let dir = temp_docs();
        // 递归 + 正则（子集）+ 按名排序，只收 .md
        assert_eq!(
            out_in(".listfiles {.} pattern:{\\.md$} recursive:{yes} sortby:{name}", Some(dir.clone())),
            "sub/inner.md"
        );
        // 只要文件名
        assert_eq!(
            out_in(".listfiles {.} pattern:{\\.csv$} fullpath:{no}", Some(dir.clone())),
            "data.csv"
        );
        // pattern 语法错误 → 诊断降级
        let (text, n) = out_in_return(".listfiles {.} pattern:{(unclosed}", Some(dir));
        assert!(text.contains(".listfiles"));
        assert_eq!(n, 1);
    }

    #[test]
    fn filename_带与不带扩展名() {
        let dir = temp_docs();
        assert_eq!(out_in(".filename {notes.txt}", Some(dir.clone())), "notes.txt");
        assert_eq!(out_in(".filename {notes.txt} extension:{no}", Some(dir)), "notes");
    }

    #[test]
    fn json_读字典并取键() {
        let dir = temp_docs();
        assert_eq!(out_in(".json {cfg.json}::get {name}", Some(dir.clone())), "qd");
        assert_eq!(out_in(".json {cfg.json}::get {n}", Some(dir.clone())), "3");
        assert_eq!(out_in(".json {cfg.json}::get {ok}", Some(dir.clone())), "yes");
        assert_eq!(out_in(".json {cfg.json}::get {missing}", Some(dir)), "");
    }

    #[test]
    fn csv_落成markdown表格() {
        let dir = temp_docs();
        assert_eq!(
            out_in(".csv {data.csv}", Some(dir.clone())),
            "| name | score |\n| --- | --- |\n| alice | 90 |\n| bob | 85 |"
        );
        // caption 落在表格后的斜体行
        assert!(out_in(".csv {data.csv} caption:{成绩表}", Some(dir)).contains("\n*成绩表*"));
    }

    #[test]
    fn filetree_规范化列表() {
        let src = ".filetree\n    - src/\n      - main.ts\n    - README.md\n    - **docs.md**\n    - ...";
        assert_eq!(
            out(src),
            "- src/\n  - main.ts\n- README.md\n- **docs.md**\n- …"
        );
        // 目录补尾斜杠
        let src2 = ".filetree\n    - src\n      - main.ts";
        assert_eq!(out(src2), "- src/\n  - main.ts");
    }

    #[test]
    fn filetree_缺块参数降级() {
        let (text, n) = run(".filetree {x}");
        assert!(text.contains(".filetree"));
        assert_eq!(n, 1);
    }
}



