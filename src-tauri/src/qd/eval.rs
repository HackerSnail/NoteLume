// eval.rs —— 求值器：作用域栈 + 调用解析 + 错误降级
//
// 调用解析顺序：用户作用域（变量 / lambda / 函数）→ 内置表（stdlib 注册）→ 未知名诊断。
// 错误模型：任何单点失败先记诊断、再返回 Err(())；调用方（eval_block）把该调用的原始源文本
// （CallNode.src）作为输出降级——文档其余部分照常求值，Err 载荷不带消息，消息全在诊断数组。
// 特殊形式（function / var / if / ifnot / let）需要惰性求值 body，在此分派，不能出现在链式中间。

use std::collections::HashMap;

use super::ast::{Block, CallNode, CallSeg, InlineSeg};
use super::parser::parse_document;
use super::value::Value;

/// 递归深度上限：超限出诊断（不栈溢出）
const MAX_DEPTH: usize = 128;

#[derive(Debug, Clone, PartialEq)]
pub struct Diagnostic {
    pub line: u32,
    pub message: String,
}

pub type BuiltinFn = fn(&mut Evaluator, &BuiltinCall) -> Result<Value, String>;

/// 内置函数的实参视图：eval 层已全部求值——链式注入的首参排在 pos 最前，
/// 具名实参（`by:{2}`）单列。builtin 不接触原始 raw。
pub struct BuiltinCall<'a> {
    pub name: &'a str,
    pub pos: Vec<Value>,
    pub named: Vec<(String, Value)>,
}

pub struct Evaluator {
    /// 作用域栈：栈顶是当前作用域
    scopes: Vec<HashMap<String, Value>>,
    builtins: HashMap<String, BuiltinFn>,
    pub diagnostics: Vec<Diagnostic>,
    depth: usize,
}

impl Evaluator {
    pub fn new(builtins: HashMap<String, BuiltinFn>) -> Self {
        Evaluator { scopes: vec![HashMap::new()], builtins, diagnostics: Vec::new(), depth: 0 }
    }

    fn push_scope(&mut self) {
        self.scopes.push(HashMap::new());
    }

    fn pop_scope(&mut self) {
        self.scopes.pop();
    }

    fn define(&mut self, name: &str, value: Value) {
        self.scopes.last_mut().unwrap().insert(name.to_string(), value);
    }

    fn lookup(&self, name: &str) -> Option<&Value> {
        for scope in self.scopes.iter().rev() {
            if let Some(v) = scope.get(name) {
                return Some(v);
            }
        }
        None
    }

    fn diag(&mut self, line: usize, message: String) {
        self.diagnostics.push(Diagnostic { line: line as u32, message });
    }

    /// 整篇文档求值：块输出按行拼接，最终 trim（定义类调用静默，文档首尾不留空行）
    pub fn run_document(&mut self, blocks: &[Block]) -> String {
        let parts: Vec<String> = blocks
            .iter()
            .map(|b| match b {
                Block::Text(t) => t.clone(),
                Block::Inline(segs) => self.eval_inline(segs),
                Block::Call(c) => match self.eval_call(c) {
                    Ok(v) => v.to_output().trim().to_string(),
                    Err(()) => c.src.clone(), // 降级：原文原样
                },
            })
            .collect();
        parts.join("\n").trim().to_string()
    }

    /// 行内片段求值：文本原样、调用结果拼接（不 trim——嵌入句中）；失败降级调用原文
    fn eval_inline(&mut self, segs: &[InlineSeg]) -> String {
        let mut out = String::new();
        for seg in segs {
            match seg {
                InlineSeg::Str(s) => out.push_str(s),
                InlineSeg::Call(c) => match self.eval_call(c) {
                    Ok(v) => out.push_str(&v.to_output()),
                    Err(()) => out.push_str(&c.src),
                },
            }
        }
        out
    }

    /// 实参求值：raw 里可能是指令（`.n`、跨行块），可能是字面量（数字 / yes|no / 区间 / 文本）
    fn eval_raw(&mut self, raw: &str, line: usize) -> Result<Value, ()> {
        let trimmed = raw.trim();
        if trimmed.starts_with('.') {
            // 实参本身是调用：当子文档解析求值
            let blocks = parse_document(trimmed);
            let mut parts: Vec<String> = Vec::new();
            for b in &blocks {
                match b {
                    Block::Text(t) => parts.push(t.clone()),
                    Block::Inline(segs) => parts.push(self.eval_inline(segs)),
                    Block::Call(c) => match self.eval_call(c) {
                        Ok(v) => parts.push(v.to_output().trim().to_string()),
                        Err(()) => parts.push(c.src.clone()),
                    },
                }
            }
            let text = parts.join("\n");
            return Ok(infer_literal_like(&text));
        }
        Ok(infer_literal_like(trimmed))
    }

    /// 调用链求值：head 先行，链上每段以前一结果作为第一个位置参数
    fn eval_call(&mut self, node: &CallNode) -> Result<Value, ()> {
        if self.depth >= MAX_DEPTH {
            self.diag(node.line, format!("递归过深（超过 {} 层）", MAX_DEPTH));
            return Err(());
        }
        self.depth += 1;
        let r = self.eval_call_inner(node);
        self.depth -= 1;
        r
    }

    fn eval_call_inner(&mut self, node: &CallNode) -> Result<Value, ()> {
        // 特殊形式：function / var / if / ifnot / let 只能在首段且不能带链（需要惰性 body）；
        // foreach / repeat 例外——`.range {1} {3}::foreach` 是 Quarkdown 的惯用形态，
        // 链上注入的可迭代 / 次数作为它们的实参。
        const LAZY: [&str; 5] = ["function", "var", "if", "ifnot", "let"];
        if LAZY.contains(&node.head.name.as_str()) {
            if !node.chain.is_empty() {
                self.diag(node.line, format!(".{} 不能出现在链式调用中间", node.head.name));
                return Err(());
            }
            return match node.head.name.as_str() {
                "function" => self.eval_function(node),
                "var" => self.eval_var(node),
                "if" => self.eval_if(node, false),
                "ifnot" => self.eval_if(node, true),
                _ => self.eval_let(node),
            };
        }

        let mut current: Option<Value> = None;
        let mut segs: Vec<&CallSeg> = vec![&node.head];
        for seg in &node.chain {
            segs.push(seg);
        }
        for (idx, seg) in segs.iter().enumerate() {
            let is_last = idx == segs.len() - 1;
            // 实参求值：链式注入的前一结果排在位置实参最前，具名单列
            let mut pos: Vec<Value> = Vec::new();
            let mut named: Vec<(String, Value)> = Vec::new();
            if let Some(prev) = current.take() {
                pos.push(prev);
            }
            for a in seg.args.iter() {
                let v = self.eval_raw(&a.raw, node.line)?;
                match &a.name {
                    Some(n) => named.push((n.clone(), v)),
                    None => pos.push(v),
                }
            }
            // 链上的 foreach / repeat：注入值即实参（`.range {1} {3}::foreach` 惯用形态）
            if seg.name == "foreach" {
                if pos.is_empty() {
                    self.diag(node.line, ".foreach 缺少可迭代实参".to_string());
                    return Err(());
                }
                let v = pos.remove(0);
                let items = match v.as_items() {
                    Some(it) => it,
                    None => {
                        self.diag(node.line, ".foreach 实参不可迭代".to_string());
                        return Err(());
                    }
                };
                let body = node.body.clone().unwrap_or_default();
                current = Some(self.run_foreach(items, &body)?);
                continue;
            }
            if seg.name == "repeat" {
                if pos.is_empty() {
                    self.diag(node.line, ".repeat 缺少次数".to_string());
                    return Err(());
                }
                let v = pos.remove(0);
                let times = match v.as_num() {
                    Some(n) => n,
                    None => {
                        self.diag(node.line, ".repeat 实参必须是数字".to_string());
                        return Err(());
                    }
                };
                let body = node.body.clone().unwrap_or_default();
                current = Some(self.run_repeat(times, &body)?);
                continue;
            }
            // 用户作用域：lambda（函数 / 变量）
            let target = self.lookup(&seg.name).cloned();
            let value = match target {
                Some(v) => v,
                None => match self.builtins.get(&seg.name) {
                    Some(f) => {
                        let f = *f;
                        let call = BuiltinCall { name: &seg.name, pos, named };
                        current = Some(f(self, &call).map_err(|e| {
                            self.diag(node.line, e);
                        })?);
                        continue;
                    }
                    None => {
                        self.diag(node.line, format!("未知函数 .{}", seg.name));
                        return Err(());
                    }
                },
            };
            current = Some(self.invoke_value(value, &pos, node, is_last)?);
        }
        Ok(current.unwrap_or(Value::None))
    }

    /// 调用一个已解析的值：lambda 调用（绑参 / 变量重绑定），其余值原样返回
    fn invoke_value(&mut self, value: Value, args: &[Value], node: &CallNode, is_last: bool) -> Result<Value, ()> {
        let (params, body) = match &value {
            Value::Lambda { params, body } => (params.clone(), body.clone()),
            other => {
                // 非 lambda 值带参调用 = 变量重赋值（`.myvar {newvalue}`，Quarkdown 同语义，静默无输出）
                if !args.is_empty() && is_last {
                    self.define(&node.head.name, args[0].clone());
                    return Ok(Value::None);
                }
                return Ok(other.clone());
            }
        };
        if params.is_empty() && !args.is_empty() && is_last {
            // 无参 lambda（.var 定义的变量）带一个实参 = 重绑定（`.myvar {newvalue}`）
            self.define(&node.head.name, args[0].clone());
            return Ok(args[0].clone());
        }
        self.push_scope();
        let r = self.bind_and_run(&params, &body, args, node);
        self.pop_scope();
        r
    }

    /// 绑定参数并求值 lambda 体
    fn bind_and_run(&mut self, params: &[String], body: &[Block], args: &[Value], node: &CallNode) -> Result<Value, ()> {
        for (i, p) in params.iter().enumerate() {
            let optional = p.ends_with('?');
            let name = p.trim_end_matches('?');
            match args.get(i) {
                Some(v) => self.define(name, v.clone()),
                None => {
                    if optional {
                        self.define(name, Value::None);
                    } else {
                        self.diag(node.line, format!("缺少参数 .{}", name));
                        return Err(());
                    }
                }
            }
        }
        if args.len() > params.len() {
            self.diag(node.line, format!("多出 {} 个实参，已忽略", args.len() - params.len()));
        }
        self.eval_blocks(body)
    }

    /// 求值一组块（函数体 / 块参数），输出按行拼接；内层调用失败降级原文继续
    fn eval_blocks(&mut self, blocks: &[Block]) -> Result<Value, ()> {
        let parts: Vec<String> = blocks
            .iter()
            .map(|b| match b {
                Block::Text(t) => t.clone(),
                Block::Inline(segs) => self.eval_inline(segs),
                Block::Call(c) => match self.eval_call(c) {
                    Ok(v) => v.to_output().trim().to_string(),
                    Err(()) => c.src.clone(),
                },
            })
            .collect();
        Ok(Value::Markdown(parts.join("\n")))
    }

    /// lambda 体首块的参数表：`to from?:` → ["to", "from?"]。
    /// `allow_implicit`：真时无参数表视为隐式首参 `.1`（foreach 的迭代 lambda）；
    /// .function / .let 的 body 无参数行就是零参（函数没写参数就无参可绑）。
    fn lambda_params(body: &[Block], allow_implicit: bool) -> (Vec<String>, &[Block]) {
        if let Some(Block::Text(t)) = body.first() {
            let line = t.trim();
            if let Some(head) = line.strip_suffix(':') {
                let tokens: Vec<&str> = head.split_whitespace().collect();
                let ok = !tokens.is_empty()
                    && tokens.iter().all(|w| {
                        let core = w.trim_end_matches('?');
                        !core.is_empty() && core.chars().all(|c| c.is_alphanumeric() || c == '_')
                    });
                if ok {
                    return (tokens.iter().map(|w| w.to_string()).collect(), &body[1..]);
                }
            }
        }
        if allow_implicit {
            (vec!["1".to_string()], body)
        } else {
            (Vec::new(), body)
        }
    }

    fn eval_function(&mut self, node: &CallNode) -> Result<Value, ()> {
        let name = match node.head.args.first().map(|a| a.raw.trim()) {
            Some(n) if !n.is_empty() => n.to_string(),
            _ => {
                self.diag(node.line, ".function 缺少函数名".to_string());
                return Err(());
            }
        };
        let body = node.body.clone().unwrap_or_default();
        let (params, rest) = Evaluator::lambda_params(&body, false);
        self.define(&name, Value::Lambda { params, body: rest.to_vec() });
        Ok(Value::None)
    }

    fn eval_var(&mut self, node: &CallNode) -> Result<Value, ()> {
        let name = match node.head.args.first().map(|a| a.raw.trim()) {
            Some(n) if !n.is_empty() => n.to_string(),
            _ => {
                self.diag(node.line, ".var 缺少变量名".to_string());
                return Err(());
            }
        };
        let value = match node.head.args.get(1) {
            Some(a) => self.eval_raw(&a.raw, node.line)?,
            None => match node.body {
                // 块变量：`.var {name}` + 缩进块，值是块内容的求值结果
                Some(ref body) => {
                    self.push_scope();
                    let r = self.eval_blocks(body);
                    self.pop_scope();
                    r?
                }
                None => Value::None,
            },
        };
        self.define(&name, value.clone());
        Ok(Value::None) // .var 是定义，不产生输出
    }

    /// .foreach {iterable} + 迭代 lambda：逐项绑定首参（或隐式 `.1`）求值 body，结果按行拼接
    fn eval_foreach(&mut self, node: &CallNode) -> Result<Value, ()> {
        let items = match node.head.args.first() {
            Some(a) => {
                let v = self.eval_raw(&a.raw, node.line)?;
                match v.as_items() {
                    Some(it) => it,
                    None => {
                        self.diag(node.line, ".foreach 实参不可迭代".to_string());
                        return Err(());
                    }
                }
            }
            None => {
                self.diag(node.line, ".foreach 缺少可迭代实参".to_string());
                return Err(());
            }
        };
        let body = node.body.clone().unwrap_or_default();
        self.run_foreach(items, &body)
    }

    /// foreach 的执行核心（首段与链上两种入口共用）
    fn run_foreach(&mut self, items: Vec<Value>, body: &[Block]) -> Result<Value, ()> {
        let (params, rest) = Evaluator::lambda_params(body, true);
        if params.is_empty() {
            self.diagnostics.push(Diagnostic { line: 0, message: ".foreach 缺少迭代参数".to_string() });
            return Err(());
        }
        let mut outs: Vec<String> = Vec::new();
        for item in items {
            self.push_scope();
            self.define(&params[0], item);
            let r: Result<String, ()> = match self.eval_blocks(rest) {
                Ok(v) => Ok(v.to_output()),
                Err(()) => Ok(String::new()), // 单项失败不炸整个循环（诊断已记录）
            };
            self.pop_scope();
            if let Ok(o) = r {
                outs.push(o);
            }
        }
        Ok(Value::Markdown(outs.join("\n")))
    }

    /// .repeat {times} + body：重复求值 n 次，按行拼接
    fn eval_repeat(&mut self, node: &CallNode) -> Result<Value, ()> {
        let times = match node.head.args.first() {
            Some(a) => {
                let v = self.eval_raw(&a.raw, node.line)?;
                match v.as_num() {
                    Some(n) => n,
                    None => {
                        self.diag(node.line, ".repeat 实参必须是数字".to_string());
                        return Err(());
                    }
                }
            }
            None => {
                self.diag(node.line, ".repeat 缺少次数".to_string());
                return Err(());
            }
        };
        let body = node.body.clone().unwrap_or_default();
        self.run_repeat(times, &body)
    }

    fn run_repeat(&mut self, times: f64, body: &[Block]) -> Result<Value, ()> {
        let mut outs: Vec<String> = Vec::new();
        for _ in 0..times.max(0.0) as usize {
            self.push_scope();
            let r: Result<String, ()> = match self.eval_blocks(body) {
                Ok(v) => Ok(v.to_output()),
                Err(()) => Ok(String::new()),
            };
            self.pop_scope();
            if let Ok(o) = r {
                outs.push(o);
            }
        }
        Ok(Value::Markdown(outs.join("\n")))
    }

    /// .if / .ifnot：条件成立（ifnot 为不成立）时求值 body，否则输出空
    fn eval_if(&mut self, node: &CallNode, negate: bool) -> Result<Value, ()> {
        let cond = match node.head.args.first() {
            Some(a) => self.eval_raw(&a.raw, node.line)?,
            None => {
                self.diag(node.line, ".if 缺少条件".to_string());
                return Err(());
            }
        };
        let truth = match cond.as_bool() {
            Some(b) => b,
            None => {
                self.diag(node.line, ".if 条件必须是布尔（yes / no）".to_string());
                return Err(());
            }
        };
        let run = if negate { !truth } else { truth };
        if !run {
            return Ok(Value::None);
        }
        let body = node.body.clone().unwrap_or_default();
        self.push_scope();
        let r = self.eval_blocks(&body);
        self.pop_scope();
        r
    }

    fn eval_let(&mut self, node: &CallNode) -> Result<Value, ()> {
        let value = match node.head.args.first() {
            Some(a) => self.eval_raw(&a.raw, node.line)?,
            None => Value::None,
        };
        let body = node.body.clone().unwrap_or_default();
        let (params, rest) = Evaluator::lambda_params(&body, false);
        self.push_scope();
        let r = self.bind_and_run(&params, rest, &[value], node);
        self.pop_scope();
        r
    }
}

/// 字面量推断：yes|no → 布尔，N..M → 区间，数字 → Num，其余 → Str（文本先过一遍它，
/// 以便 `.:name:` 型实参求值结果再次落型——数字算式的链式结果要能继续参与数学运算）
pub fn infer_literal_like(trimmed: &str) -> Value {
    if trimmed == "yes" {
        return Value::Bool(true);
    }
    if trimmed == "no" {
        return Value::Bool(false);
    }
    if let Some((a, b)) = trimmed.split_once("..") {
        if let (Ok(a), Ok(b)) = (a.trim().parse::<i64>(), b.trim().parse::<i64>()) {
            return Value::Range(a, b);
        }
    }
    if let Ok(n) = trimmed.parse::<f64>() {
        return Value::Num(n);
    }
    Value::Str(trimmed.to_string())
}

/// 整篇文档求值入口：返回（展开文本，诊断）
pub fn eval_document(blocks: &[Block], builtins: HashMap<String, BuiltinFn>) -> (String, Vec<Diagnostic>) {
    let mut ev = Evaluator::new(builtins);
    let out = ev.run_document(blocks);
    (out, ev.diagnostics)
}

#[cfg(test)]
mod tests {
    use super::super::parser::parse_document;
    use super::*;
    use std::collections::HashMap;

    fn run(src: &str) -> (String, Vec<Diagnostic>) {
        let blocks = parse_document(src);
        eval_document(&blocks, HashMap::new())
    }

    fn out(src: &str) -> String {
        run(src).0
    }

    #[test]
    fn 变量定义与访问() {
        assert_eq!(out(".var {name} {Quarkdown}\nHello, .name!"), "Hello, Quarkdown!");
    }

    #[test]
    fn 变量重绑定() {
        assert_eq!(out(".var {n} {5}\n.var {n} {6}\n.n"), "6");
    }

    #[test]
    fn 变量重绑定的调用形式() {
        assert_eq!(out(".var {n} {5}\n.n {6}\n.n"), "6");
    }

    #[test]
    fn 函数定义与调用_可选参数缺省为空() {
        assert_eq!(out(".function {greet}\n    to from?:\n    Hello, .to from .from!\n\n.greet {world}"), "Hello, world from !");
    }

    #[test]
    fn 函数返回加粗内容() {
        assert_eq!(out(".function {greet}\n    to:\n    **Hello, .to**\n\n.greet {world}"), "**Hello, world**");
    }

    #[test]
    fn 函数重定义以后者为准() {
        assert_eq!(out(".function {f}\n    A\n\n.function {f}\n    B\n\n.f"), "B");
    }

    #[test]
    fn 条件_if_ifnot() {
        assert_eq!(out(".if {yes}\n    A\n.ifnot {yes}\n    B"), "A");
        assert_eq!(out(".if {no}\n    A\n.ifnot {no}\n    B"), "B");
    }

    #[test]
    fn let_绑定条件变量() {
        assert_eq!(out(".let {3}\n    n:\n    value is .n"), "value is 3");
    }

    #[test]
    fn 错误降级_未知函数输出原文并出诊断() {
        let (text, diags) = run(".nosuch {x}");
        assert_eq!(text, ".nosuch {x}");
        assert_eq!(diags.len(), 1);
        assert_eq!(diags[0].line, 1);
        assert!(diags[0].message.contains("nosuch"));
    }

    #[test]
    fn 递归过深_诊断而非栈溢出() {
        let (text, diags) = run(".function {loop}\n    .loop\n\n.loop");
        assert_eq!(text, ".loop");
        assert!(diags.iter().any(|d| d.message.contains("递归")));
    }

    #[test]
    fn 数字与布尔输出格式() {
        assert_eq!(out(".var {n} {5}\n.n"), "5");
        assert_eq!(out(".var {b} {yes}\n.b"), "yes");
    }

    #[test]
    fn 行内调用嵌入句子() {
        assert_eq!(out(".var {name} {NoteLume}\nWelcome to .name, enjoy!"), "Welcome to NoteLume, enjoy!");
    }

    #[test]
    fn 区间字面量输出() {
        assert_eq!(out(".var {r} {2..4}\n.r"), "2\n3\n4");
    }

    #[test]
    fn foreach_显式参数() {
        assert_eq!(out(".foreach {2..4}\n    n:\n    The number is .n"), "The number is 2\nThe number is 3\nThe number is 4");
    }

    #[test]
    fn foreach_隐式首参() {
        assert_eq!(out(".foreach {1..3}\n    .1"), "1\n2\n3");
    }

    #[test]
    fn foreach_列表变量() {
        assert_eq!(out(".var {letters}\n    - A\n    - B\n\n.foreach {.letters}\n    l:\n    letter .l"), "letter A\nletter B");
    }

    #[test]
    fn repeat_重复求值() {
        assert_eq!(out(".repeat {3}\n    x"), "x\nx\nx");
    }

    #[test]
    fn foreach_嵌套条件() {
        assert_eq!(out(".foreach {1..2}\n    .if {yes}\n        item .1"), "item 1\nitem 2");
    }

    #[test]
    fn 多块文本拼接() {
        assert_eq!(out("# 标题\n\n正文一段"), "# 标题\n\n正文一段");
    }
}
