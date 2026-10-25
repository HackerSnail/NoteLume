// parser.rs —— 指令行解析：源 Markdown → Block 序列
//
// 规则（与 quarkdown-core 对齐的最小集，逐条有测试）：
//  · 指令行 = 行首 `.`（允许前置空白）+ 名字 [a-zA-Z0-9_]+（`.1` 隐式首参也是合法调用名）。
//    非行首的 `.`（句中 .x、行首数字如 3.14）是普通文本。
//  · 参数：`{...}` 位置参数、`name:{...}` 具名参数；花括号配平、未闭合时吞后续行直到配平；
//    参数必须与调用同行起始，不跨行起新参。
//  · 链式：名字后零或多个 `::name`（无空白）。
//  · 块参数：调用行之后缩进严格更深的连续行（空行不断开；空行后缩进回落则块结束），
//    整体剥一级缩进（4 空格，Tab 记 4）后递归解析——内层更深缩进的调用随之成为嵌套 Call。
//  · 其余行逐行保留为 Text（原样，含缩进与空行）。
//
// 注意：调用在任何缩进层都识别（≥ 文档层即可）——引擎按缩进层级结构化输入，
// 缩进 4 空格的代码块里行首形如指令的行会被识别为调用，这与 Quarkdown 行为一致。

use super::ast::{Arg, Block, CallNode, CallSeg, InlineSeg};

/// Tab 视作的空格数（与 Quarkdown 一致按 4 计）
const TAB_WIDTH: usize = 4;
/// 块参数相对调用行的缩进层级
const BLOCK_INDENT: usize = 4;

fn indent_of(line: &str) -> usize {
    let mut n = 0;
    for c in line.chars() {
        match c {
            ' ' => n += 1,
            '\t' => n += TAB_WIDTH,
            _ => break,
        }
    }
    n
}

fn is_blank(line: &str) -> bool {
    line.trim().is_empty()
}

/// 去缩进后是否为指令调用：`.` + 名字（首字符须字母 / 数字，`.1` 合法）
fn call_name_at(trimmed: &str) -> Option<(String, usize)> {
    let rest = trimmed.strip_prefix('.')?;
    let name: String = rest.chars().take_while(|c| c.is_alphanumeric() || *c == '_').collect();
    let first = name.chars().next()?;
    if !first.is_alphanumeric() {
        return None;
    }
    let len = 1 + name.chars().count();
    Some((name, len))
}

/// 剥掉一行前 strip 列的空白（Tab 记 TAB_WIDTH），用于块参数降一级缩进
fn deindent(line: &str, strip: usize) -> String {
    let mut removed = 0;
    let mut out = String::new();
    let mut chars = line.chars().peekable();
    while removed < strip {
        match chars.peek() {
            Some(' ') => {
                removed += 1;
                chars.next();
            }
            Some('\t') => {
                removed += TAB_WIDTH;
                chars.next();
            }
            _ => break,
        }
    }
    out.extend(chars);
    out
}

/// 解析一段行序列为 Block 列表。`lines` 为 (行号, 原文)；`start_indent` 为本段基准缩进。
pub fn parse_blocks(lines: &[(usize, &str)], start_indent: usize) -> Vec<Block> {
    let mut out = Vec::new();
    let mut i = 0;
    while i < lines.len() {
        let (line_no, raw) = lines[i];
        if is_blank(raw) {
            out.push(Block::Text(String::new()));
            i += 1;
            continue;
        }
        let ind = indent_of(raw);
        let trimmed = raw.trim_start();
        if ind >= start_indent {
            if let Some((name, name_len)) = call_name_at(trimmed) {
                let (node, consumed) = parse_call(lines, i, ind, name, name_len);
                out.push(Block::Call(node));
                i += consumed;
                continue;
            }
        }
        match scan_inline(raw, line_no) {
            Some(segs) => out.push(Block::Inline(segs)),
            None => out.push(Block::Text(raw.to_string())),
        }
        i += 1;
    }
    out
}

/// 行内调用扫描：在普通文本行里找 `.name {arg} name:{arg}::chain` 形态的调用。
/// 判定：`.` 的前一个字符不能是字母数字（排除小数 3.14、文件名 img.png），`.` 后须紧跟
/// 名字；参数与链与行首调用同规则，但只在行内配平（跨行的当普通文本）。无调用返回 None。
fn scan_inline(line: &str, line_no: usize) -> Option<Vec<InlineSeg>> {
    let chars: Vec<char> = line.chars().collect();
    let mut segs: Vec<InlineSeg> = Vec::new();
    let mut text_start = 0usize;
    let mut ci = 0usize;
    let mut found = false;
    while ci < chars.len() {
        if chars[ci] != '.' {
            ci += 1;
            continue;
        }
        // 前一字符是字母数字 → 属于词内部（小数 / 域名），不是调用
        if ci > 0 && (chars[ci - 1].is_alphanumeric() || chars[ci - 1] == '_') {
            ci += 1;
            continue;
        }
        let name: String = chars[ci + 1..].iter().take_while(|c| c.is_alphanumeric() || **c == '_').collect();
        let first = name.chars().next();
        if first.map_or(true, |c| !c.is_alphanumeric()) {
            ci += 1;
            continue;
        }
        let mut cur = ci + 1 + name.chars().count();
        let mut seg_args: Vec<Arg> = Vec::new();
        let mut chain: Vec<CallSeg> = Vec::new();
        let mut ok = true;
        loop {
            let pre_skip = cur; // 跳空白前位置：本迭代没吃到参数 / 链时回退，空格还给文本
            while cur < chars.len() && (chars[cur] == ' ' || chars[cur] == '\t') {
                cur += 1;
            }
            if cur >= chars.len() {
                cur = pre_skip;
                break;
            }
            if chars[cur] == ':' && chars.get(cur + 1) == Some(&':') {
                let mut j = cur + 2;
                let cname: String = chars[j..].iter().take_while(|c| c.is_alphanumeric() || **c == '_').collect();
                if cname.is_empty() {
                    ok = false;
                    cur = pre_skip;
                    break;
                }
                j += cname.chars().count();
                chain.push(CallSeg { name: cname, args: Vec::new() });
                cur = j;
                continue;
            }
            // 具名 / 位置参数（本行内配平）
            let mut j = cur;
            while j < chars.len() && (chars[j].is_alphanumeric() || chars[j] == '_') {
                j += 1;
            }
            let named = j > cur && chars.get(j) == Some(&':') && chars.get(j + 1) == Some(&'{');
            let (arg_name, brace_col) = if named {
                (Some(chars[cur..j].iter().collect::<String>()), j + 1)
            } else if chars.get(cur) == Some(&'{') {
                (None, cur)
            } else {
                cur = pre_skip; // 没有更多参数：空白还给文本，调用本身成立
                break;
            };
            // 本行内配平读花括号
            let mut depth = 0usize;
            let mut k = brace_col;
            let mut closed = false;
            while k < chars.len() {
                if chars[k] == '{' {
                    depth += 1;
                } else if chars[k] == '}' {
                    depth -= 1;
                    if depth == 0 {
                        closed = true;
                        break;
                    }
                }
                k += 1;
            }
            if !closed {
                ok = false; // 跨行 / 未闭合：行内不认，当普通文本
                break;
            }
            let raw: String = chars[brace_col + 1..k].iter().collect();
            seg_args.push(Arg { name: arg_name, raw });
            cur = k + 1;
        }
        if !ok {
            ci += 1;
            continue;
        }
        // 切出调用前文本，记录调用
        if ci > text_start {
            segs.push(InlineSeg::Str(chars[text_start..ci].iter().collect()));
        }
        let src: String = chars[ci..cur].iter().collect();
        segs.push(InlineSeg::Call(CallNode {
            head: CallSeg { name, args: seg_args },
            chain,
            body: None,
            line: line_no,
            src: src.clone(),
        }));
        found = true;
        ci = cur;
        text_start = cur;
    }
    if !found {
        return None;
    }
    if text_start < chars.len() {
        segs.push(InlineSeg::Str(chars[text_start..].iter().collect()));
    }
    Some(segs)
}

/// 解析一个调用（lines[i] 为调用行）。返回节点与从 i 起消费的总行数（含跨行参数与块参数）。
/// 段序列：名字 + 参数，`::name` 开新段并接它自己的参数——`.pow {2} to:{3}::multiply {.pi}`
/// 里 `{.pi}` 属于 multiply 段。块参数绑到最后一段。
fn parse_call(lines: &[(usize, &str)], i: usize, call_indent: usize, name: String, name_len: usize) -> (CallNode, usize) {
    let mut segs = vec![CallSeg { name, args: Vec::new() }];
    let mut li = i;
    let mut chars: Vec<char> = lines[li].1.chars().collect();
    let mut ci = indent_of(lines[li].1) + name_len;

    loop {
        while ci < chars.len() && (chars[ci] == ' ' || chars[ci] == '\t') {
            ci += 1;
        }
        if ci >= chars.len() {
            break;
        }
        // 链式 ::name：开新段
        if chars[ci] == ':' && chars.get(ci + 1) == Some(&':') {
            let j = ci + 2;
            let cname: String = chars[j..].iter().take_while(|c| c.is_alphanumeric() || **c == '_').collect();
            if cname.is_empty() {
                break;
            }
            ci = j + cname.chars().count();
            segs.push(CallSeg { name: cname, args: Vec::new() });
            continue;
        }
        // 具名参数：identifier ':' '{'
        let mut j = ci;
        while j < chars.len() && (chars[j].is_alphanumeric() || chars[j] == '_') {
            j += 1;
        }
        let named = j > ci && chars.get(j) == Some(&':') && chars.get(j + 1) == Some(&'{');
        let (arg_name, brace_col) = if named {
            (Some(chars[ci..j].iter().collect::<String>()), j + 1)
        } else if chars[ci] == '{' {
            (None, ci)
        } else {
            break; // 非参数内容：调用行剩余部分忽略
        };
        let (raw, end_line, end_col) = read_balanced(lines, li, brace_col);
        let arg = Arg { name: arg_name, raw };
        segs.last_mut().unwrap().args.push(arg);
        if end_line != li {
            li = end_line;
            chars = lines[li].1.chars().collect();
        }
        ci = end_col;
    }

    // —— 块参数：缩进严格更深（或空行）的连续行，剥一级缩进后递归 ——
    let mut body_lines: Vec<(usize, String)> = Vec::new();
    let mut j = li + 1;
    while j < lines.len() {
        let (ln, l) = lines[j];
        if is_blank(l) {
            body_lines.push((ln, String::new()));
            j += 1;
            continue;
        }
        if indent_of(l) > call_indent {
            body_lines.push((ln, deindent(l, call_indent + BLOCK_INDENT)));
            j += 1;
        } else {
            break;
        }
    }
    while body_lines.last().map_or(false, |(_, s)| s.is_empty()) {
        body_lines.pop();
        j -= 1;
    }
    let body = if body_lines.is_empty() {
        None
    } else {
        let refs: Vec<(usize, &str)> = body_lines.iter().map(|(ln, s)| (*ln, s.as_str())).collect();
        Some(parse_blocks(&refs, 0))
    };

    let consumed = j - i;
    let src = lines[i..j].iter().map(|(_, l)| *l).collect::<Vec<_>>().join("\n");
    let mut it = segs.into_iter();
    let head = it.next().unwrap();
    (
        CallNode {
            head,
            chain: it.collect(),
            body,
            line: lines[i].0,
            src,
        },
        consumed,
    )
}

/// 从 lines[li] 的第 ci 个字符起的配平花括号内容（首字符应为 '{'）。
/// 返回（花括号内原文、结束行号、结束列）。未配平时吞到末尾（求值层对此出诊断）。
fn read_balanced(lines: &[(usize, &str)], mut li: usize, mut ci: usize) -> (String, usize, usize) {
    let mut raw = String::new();
    let mut depth = 0usize;
    while li < lines.len() {
        let chars: Vec<char> = lines[li].1.chars().collect();
        while ci < chars.len() {
            let c = chars[ci];
            ci += 1;
            if c == '{' {
                depth += 1;
                if depth == 1 {
                    continue; // 外层开括号不入 raw
                }
            } else if c == '}' {
                depth -= 1;
                if depth == 0 {
                    return (raw, li, ci);
                }
            }
            raw.push(c);
        }
        li += 1;
        ci = 0;
        if li < lines.len() {
            raw.push('\n');
        }
    }
    (raw, li.saturating_sub(1), ci)
}

/// 解析整篇文档
pub fn parse_document(src: &str) -> Vec<Block> {
    let lines: Vec<(usize, &str)> = src.lines().enumerate().map(|(k, l)| (k + 1, l)).collect();
    parse_blocks(&lines, 0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parse(src: &str) -> Vec<Block> {
        parse_document(src)
    }

    fn call_of(block: &Block) -> &CallNode {
        match block {
            Block::Call(c) => c,
            other => panic!("应为 Call，实际 {:?}", other),
        }
    }

    fn text_of(block: &Block) -> &str {
        match block {
            Block::Text(t) => t,
            other => panic!("应为 Text，实际 {:?}", other),
        }
    }

    #[test]
    fn 纯文本逐字保留_空行自成节点() {
        let blocks = parse("hello\n\nworld");
        assert_eq!(blocks.len(), 3);
        assert_eq!(text_of(&blocks[0]), "hello");
        assert_eq!(text_of(&blocks[1]), "");
        assert_eq!(text_of(&blocks[2]), "world");
    }

    #[test]
    fn 位置参数调用() {
        let blocks = parse(".sum {2} {3}");
        let c = call_of(&blocks[0]);
        assert_eq!(c.head.name, "sum");
        assert!(c.chain.is_empty());
        assert_eq!(c.head.args.len(), 2);
        assert_eq!(c.head.args[0].raw, "2");
        assert_eq!(c.head.args[1].raw, "3");
        assert!(c.body.is_none());
    }

    #[test]
    fn 具名参数() {
        let blocks = parse(".multiply {.n} by:{2}");
        let c = call_of(&blocks[0]);
        assert_eq!(c.head.args.len(), 2);
        assert_eq!(c.head.args[0].name, None);
        assert_eq!(c.head.args[1].name.as_deref(), Some("by"));
        assert_eq!(c.head.args[1].raw, "2");
    }

    #[test]
    fn 嵌套花括号配平() {
        let blocks = parse(".f {a{b}c}");
        let c = call_of(&blocks[0]);
        assert_eq!(c.head.args[0].raw, "a{b}c");
    }

    #[test]
    fn 链式调用() {
        let blocks = parse(".pow {2} to:{3}::multiply {.pi}");
        let c = call_of(&blocks[0]);
        // 首段 pow 带自己的参数；::multiply 段的 {.pi} 属于 multiply
        assert_eq!(c.head.name, "pow");
        assert_eq!(c.head.args.len(), 2);
        assert_eq!(c.head.args[1].name.as_deref(), Some("to"));
        assert_eq!(c.chain.len(), 1);
        assert_eq!(c.chain[0].name, "multiply");
        assert_eq!(c.chain[0].args[0].raw, ".pi");
    }

    #[test]
    fn 块参数归块_空行不断开_一级缩进剥离() {
        let blocks = parse(".if {yes}\n    hello\n\n    world\n正文");
        assert_eq!(blocks.len(), 2); // if 调用 + 正文
        let c = call_of(&blocks[0]);
        let body = c.body.as_ref().unwrap();
        assert_eq!(body.len(), 3); // hello, 空行, world
        assert_eq!(text_of(&body[0]), "hello");
        assert_eq!(text_of(&body[1]), "");
        assert_eq!(text_of(&body[2]), "world");
        assert_eq!(text_of(&blocks[1]), "正文");
    }

    #[test]
    fn 块内行首指令解析成嵌套调用() {
        let blocks = parse(".if {yes}\n    .uppercase {x}");
        let c = call_of(&blocks[0]);
        let body = c.body.as_ref().unwrap();
        assert_eq!(call_of(&body[0]).head.name, "uppercase");
    }

    #[test]
    fn 行内调用拆片段_小数不是调用() {
        let blocks = parse("3.14\nsee .x at home");
        // 3.14：点前是数字 → 整行 Text
        assert_eq!(text_of(&blocks[0]), "3.14");
        // see .x at home：.x 前是空格 → 行内调用（未知函数由求值层降级，文本输出不变）
        match &blocks[1] {
            Block::Inline(segs) => {
                assert_eq!(segs.len(), 3);
                assert_eq!(segs[0], InlineSeg::Str("see ".to_string()));
                assert!(matches!(&segs[1], InlineSeg::Call(c) if c.head.name == "x"));
                assert_eq!(segs[2], InlineSeg::Str(" at home".to_string()));
            }
            other => panic!("应为 Inline，实际 {:?}", other),
        }
    }

    #[test]
    fn 区间字面量原样进raw() {
        let blocks = parse(".foreach {2..4}");
        let c = call_of(&blocks[0]);
        assert_eq!(c.head.args[0].raw, "2..4");
    }

    #[test]
    fn 未闭合花括号吞到文档尾() {
        let blocks = parse(".f {abc");
        let c = call_of(&blocks[0]);
        assert_eq!(c.head.args[0].raw, "abc");
    }

    #[test]
    fn 深层嵌套缩进递归成块() {
        let blocks = parse(".if {yes}\n    .if {no}\n        deep");
        let outer = call_of(&blocks[0]);
        let inner = call_of(&outer.body.as_ref().unwrap()[0]);
        assert_eq!(inner.head.name, "if");
        let inner_body = inner.body.as_ref().unwrap();
        assert_eq!(text_of(&inner_body[0]), "deep"); // 两级各剥一层缩进
    }

    #[test]
    fn 缩进回落结束块参数() {
        let blocks = parse(".f {x}\n    body\ntail");
        let c = call_of(&blocks[0]);
        assert_eq!(c.body.as_ref().unwrap().len(), 1);
        assert_eq!(text_of(&blocks[1]), "tail");
    }
}
