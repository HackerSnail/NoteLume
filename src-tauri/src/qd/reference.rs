// reference.rs —— 交叉引用（阶段 3，最小集）
//
// Kotlin 的交叉引用是一套编号系统：可引用目标（标题 {#id}、图片 / 表格 / 代码块的 caption、
// .numbered 自定义块）由 LocationAwareLabelStorerHook 记位置，.ref {id} 解析成目标编号的链接，
// 编号格式由 .numbering 的格式串（1.1.1 / 1.A.a）决定。
//
// 本引擎的 Markdown 输出撑不起完整系统（标题 {#id} 属性语法、图表自动编号的格式串都无处落地），
// 落最小集：
//  · .numbered {key} ref:{id} + lambda 块参数 —— 按计数分组 key 出序号，body 以编号字符串为
//    首参求值（Kotlin 的 NumberedEvaluatorHook 在文本层的等价物）；ref 记入账本。
//  · .ref {id} —— 落占位符，eval_document 出口统一换成账本里该 id 的编号；查不到 [???]
//    （Kotlin 渲染未解析引用同款）。标题 / 图片 / 表格目标不支持，同样落 [???]。
//  · .marker {name} —— 不可见标记，无输出（Kotlin 造一个 MARKER_HEADING 深度的不可见标题）。
// 编号是各 key 独立的 1 起始序号，不做 .numbering 的格式串（figure / table 计数走各自通道）。

use std::collections::HashMap;

use super::eval::{Builtin, BuiltinFn, Evaluator};
use super::value::Value;

pub fn register(m: &mut HashMap<String, Builtin>) {
    fn add(map: &mut HashMap<String, Builtin>, name: &str, f: BuiltinFn) {
        map.insert(name.to_string(), Builtin { f, lambda_args: &[] });
    }

    add(m, "numbered", |ev, call| {
        let key = call
            .pos
            .first()
            .and_then(|v| v.as_str())
            .ok_or_else(|| ".numbered 计数分组必须是文本".to_string())?
            .trim()
            .to_string();
        if key.is_empty() {
            return Err(".numbered 计数分组不能为空".to_string());
        }
        let refr = call
            .named
            .iter()
            .find(|(n, _)| n == "ref")
            .map(|(_, v)| v.as_str().ok_or_else(|| ".numbered 的 ref: 必须是文本".to_string()))
            .transpose()?
            .map(|r| r.trim().to_string())
            .filter(|r| !r.is_empty());
        let n = match ev.num_counters.get_mut(&key) {
            Some(c) => {
                *c += 1;
                *c
            }
            None => {
                ev.num_counters.insert(key.clone(), 1);
                1
            }
        };
        // 编号文本按 .numbering 里该 key 的格式串渲染（如 eq: (1) → "(1)"），无登记则十进制
        let label = super::postprocess::format_counter(ev, &key, n);
        if let Some(id) = refr {
            ev.numbered.push((id, label.clone()));
        }
        let body = match &call.body {
            Some(b) if !b.is_empty() => b.clone(),
            _ => return Ok(Value::Str(label)), // 无 body：只出编号
        };
        ev.call_block(&body, &[Value::Str(label)], 0)
            .map_err(|()| ".numbered 内容求值失败".to_string())
    });

    add(m, "ref", |ev, call| {
        let id = call
            .pos
            .first()
            .and_then(|v| v.as_str())
            .ok_or_else(|| ".ref 引用 id 必须是文本".to_string())?
            .trim()
            .to_string();
        if id.is_empty() {
            return Err(".ref 引用 id 不能为空".to_string());
        }
        let idx = ev.refs.len();
        ev.refs.push(id);
        Ok(Value::Str(format!("{{{{nlref-{}}}}}", idx)))
    });

    add(m, "marker", |_, _| Ok(Value::None));
}

/// 引用占位符统一解析：按账本里的 ref id 出登记的引用文本（编号已按格式串渲染）；
/// 查不到 [???]（Kotlin 未解析引用同款）。
pub fn resolve_refs(ev: &mut Evaluator, out: &mut String) {
    if ev.refs.is_empty() {
        return;
    }
    for (i, id) in ev.refs.iter().enumerate() {
        let label = match ev.numbered.iter().find(|(rid, _)| rid == id) {
            Some((_, label)) => label.clone(),
            None => "[???]".to_string(),
        };
        *out = out.replace(&format!("{{{{nlref-{}}}}}", i), &label);
    }
}

#[cfg(test)]
mod tests {
    use super::super::eval::eval_document;
    use super::super::parser::parse_document;
    use super::super::stdlib::builtins;

    fn out(src: &str) -> String {
        let blocks = parse_document(src);
        eval_document(&blocks, builtins(), None).0
    }

    #[test]
    fn numbered_分组计数与body() {
        let src = ".numbered {eq}\n    n:\n    式 .n\n\n.numbered {eq}\n    n:\n    式 .n\n\n.numbered {fig}\n    n:\n    图 .n";
        assert_eq!(out(src), "式 1\n\n式 2\n\n图 1");
        // 无 body：只出编号
        assert_eq!(out(".numbered {x}\n\n.numbered {x}"), "1\n\n2");
    }

    #[test]
    fn ref_解析编号与未解析问号() {
        let src = ".numbered {eq} ref:{pythagoras}\n    n:\n    a² + b² = c²（式 .n）\n\n见 .ref {pythagoras} 与 .ref {nope}";
        assert!(out(src).contains("见 1 与 [???]"));
    }

    #[test]
    fn marker_静默() {
        assert_eq!(out(".marker {intro}\n正文"), "正文");
    }

    #[test]
    fn numbered_缺key降级() {
        let (t, n) = {
            let blocks = parse_document(".numbered");
            eval_document(&blocks, builtins(), None)
        };
        assert!(t.contains(".numbered"));
        assert_eq!(n.len(), 1);
    }
}
