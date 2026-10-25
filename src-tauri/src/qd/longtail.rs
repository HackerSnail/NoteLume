// longtail.rs —— stdlib 长尾模块（阶段 5）：Flow 收尾 / Text / Collection / Strings /
// Optionality / Logger / MiscElements / Color / Html / Markdown / Process
//
// 阶段 5 收尾口径（对齐 .others/quarkdown 各 Kotlin 源文件，Markdown 引擎做等价降级）：
//  · Flow.node —— 不可见空节点，无输出。
//  · Text：br 落行尾反斜杠硬换行（编辑器 Shift-Enter 的序列化形态）；codespan 落行内代码；
//    match 用迷你正则（io.rs regex_replace）做正则替换、命中串喂给 lambda；
//    loremipsum 照抄 Kotlin 常量。
//  · Collection.pair 构造二元组（[a, b] 列表，.1::first / .1::second 取用）。
//  · Strings.plaintext 行内 Markdown 转纯文本——简化剥离（链接取文本、去强调/代码记号），
//    非完整行内解析（批 1 计划里延后到本阶段的实现）。
//  · Optionality 五件套：none / isnone / otherwise / ifpresent / takeif，围绕 Value::None。
//  · Logger：log / debug 打到进程 stdout/stderr（副作用，不进文档）；error 走既有错误
//    降级通道（诊断 + 原文，对齐 Kotlin 的错误框渲染）。
//  · MiscElements.keybinding：Markdown 无 kbd 形态，文本原样透传。
//  · Color：red/green/blue 落 CSS rgb()/rgba() 串；只给 base（颜色名 / hex）时原样透传
//    （样式的消费端本来就丢弃颜色，这里只为 String 化）。
//  · Html / Markdown：html / css 原样输出（编辑器 html_block 节点与 site-export 的
//    renderWithHtml 会接管真实 HTML；Quarkdown 层文档本就不再要求 Obsidian 兼容）；
//    htmloptions / cssproperties / llmstxt 是 HTML 编译器的生成选项，无输出。
//  · Process.env 读进程环境变量（Kotlin 需 ProcessAccess 权限，本引擎无权限系统——
//    库与包是用户显式引入的受信内容， Caveat 见 CLAUDE.md），缺失回落 none。
//
// 未移植：Icon.icon 与 Emoji.emoji / allemojis（Bootstrap 图标与 1900 条 emoji 词表在
// Rust 侧复制一份不值；emoji 显示层由前端 emoji-text.js 承担）——调用即未知函数降级。

use std::collections::HashMap;

use super::document::body_md;
use super::eval::{Builtin, BuiltinFn};
use super::io::regex_replace;
use super::stdlib::{named_or_pos, pos};
use super::value::Value;

pub fn register(m: &mut HashMap<String, Builtin>) {
    fn add(map: &mut HashMap<String, Builtin>, name: &str, f: BuiltinFn) {
        map.insert(name.to_string(), Builtin { f, lambda_args: &[] });
    }
    fn add_l(map: &mut HashMap<String, Builtin>, name: &str, lambda_args: &'static [&'static str], f: BuiltinFn) {
        map.insert(name.to_string(), Builtin { f, lambda_args });
    }

    // ============ Flow.node ============
    add(m, "node", |_, _| Ok(Value::None));

    // ============ Text ============
    add(m, "br", |_, _| Ok(Value::Str("\\\n".to_string())));
    add(m, "codespan", |_, call| {
        let text = pos(call, 0)?.as_str().ok_or_else(|| ".codespan 实参必须是文本".to_string())?;
        // 含反引号时用双反引号夹空格（CommonMark 口径）
        let s = if text.contains('`') {
            format!("`` {} ``", text)
        } else {
            format!("`{}`", text)
        };
        Ok(Value::Str(s))
    });
    add_l(m, "match", &["pos:2"], |ev, call| {
        // match {content} {pattern} + 替换 lambda（收命中串，隐式 .1）；空 pattern 原样
        let content = pos(call, 0)?.as_str().ok_or_else(|| ".match 的 content 必须是文本".to_string())?;
        let pattern = pos(call, 1)?.as_str().ok_or_else(|| ".match 的 pattern 必须是文本".to_string())?;
        let body = match &call.body {
            Some(b) if !b.is_empty() => b.clone(),
            _ => return Err(".match 需要替换 lambda 作为块参数".to_string()),
        };
        let out = regex_replace(&pattern, &content, &mut |matched: &str| {
            match ev.call_block(&body, &[Value::Str(matched.to_string())], 0) {
                Ok(v) => v.to_output(),
                Err(()) => String::new(), // 单点失败不炸整个替换（诊断已记录）
            }
        })
        .map_err(|e| format!(".match {}", e))?;
        Ok(Value::Str(out))
    });
    add(m, "loremipsum", |_, _| {
        Ok(Value::Str(
            "Lorem ipsum dolor sit amet, consectetur adipiscing elit. Aliquam aliquet ut erat nec suscipit. Mauris \
             vitae massa eu leo molestie ullamcorper. Fusce ornare neque quis faucibus laoreet. Pellentesque mauris \
             sapien, pretium sed leo vitae, aliquam suscipit dolor. Aenean egestas congue rutrum. Nunc eget eros eu \
             justo fringilla lobortis efficitur non est. In ultrices lectus ac iaculis cursus. Phasellus at luctus \
             nibh, non porttitor ex. Vestibulum ligula metus, dignissim ac nisi non, tristique hendrerit purus."
                .to_string(),
        ))
    });

    // ============ Collection.pair ============
    add(m, "pair", |_, call| {
        let a = pos(call, 0)?;
        let b = pos(call, 1)?;
        Ok(Value::List(vec![a.clone(), b.clone()]))
    });

    // ============ Strings.plaintext ============
    add(m, "plaintext", |_, call| {
        let s = pos(call, 0)?.as_str().ok_or_else(|| ".plaintext 实参必须是文本".to_string())?;
        Ok(Value::Str(plaintext(&s)))
    });

    // ============ Optionality ============
    add(m, "none", |_, _| Ok(Value::None));
    add(m, "isnone", |_, call| Ok(Value::Bool(matches!(pos(call, 0)?, Value::None))));
    add(m, "otherwise", |_, call| {
        // 链式注入的值非 none 取之，否则 fallback（具名或位置 1）
        let v = pos(call, 0)?;
        if matches!(v, Value::None) {
            return Ok(named_or_pos(call, "fallback", 1)?.clone());
        }
        Ok(v.clone())
    });
    add_l(m, "ifpresent", &["pos:1"], |ev, call| {
        let v = pos(call, 0)?;
        if matches!(v, Value::None) {
            return Ok(Value::None);
        }
        let body = match &call.body {
            Some(b) if !b.is_empty() => b.clone(),
            _ => return Err(".ifpresent 需要映射 lambda 作为块参数".to_string()),
        };
        ev.call_block(&body, &[v.clone()], 0).map_err(|()| ".ifpresent 映射求值失败".to_string())
    });
    add_l(m, "takeif", &["pos:1"], |ev, call| {
        let v = pos(call, 0)?;
        let body = match &call.body {
            Some(b) if !b.is_empty() => b.clone(),
            _ => return Err(".takeif 需要条件 lambda 作为块参数".to_string()),
        };
        let hit = ev
            .call_block(&body, &[v.clone()], 0)
            .map_err(|()| ".takeif 条件求值失败".to_string())?;
        match hit.as_bool() {
            Some(true) => Ok(v.clone()),
            Some(false) => Ok(Value::None),
            None => Err(".takeif 条件必须返回布尔（yes / no）".to_string()),
        }
    });

    // ============ Logger ============
    add(m, "log", |_, call| {
        let msg = pos(call, 0)?.as_str().unwrap_or_default();
        println!("NoteLume qd: {}", msg);
        Ok(Value::None)
    });
    add(m, "debug", |_, call| {
        let msg = pos(call, 0)?.as_str().unwrap_or_default();
        eprintln!("NoteLume qd debug: {}", msg);
        Ok(Value::None)
    });
    add(m, "error", |_, call| {
        // 抛错：走既有错误降级通道（诊断 + 原文），对齐 Kotlin 的错误框渲染
        let msg = pos(call, 0)?.as_str().ok_or_else(|| ".error 消息必须是文本".to_string())?;
        Err(msg)
    });

    // ============ MiscElements.keybinding ============
    add(m, "keybinding", |_, call| {
        let s = pos(call, 0)?.as_str().ok_or_else(|| ".keybinding 实参必须是文本".to_string())?;
        Ok(Value::Str(s))
    });

    // ============ Color ============
    add(m, "color", |_, call| {
        let ch = |name: &str| call.named.iter().find(|(n, _)| n == name).and_then(|(_, v)| v.as_num());
        let (r, g, b) = (ch("red"), ch("green"), ch("blue"));
        let alpha = ch("alpha");
        let rgb = if let (Some(r), Some(g), Some(b)) = (r, g, b) {
            let clamp = |x: f64| x.round().clamp(0.0, 255.0) as i64;
            Some(match alpha {
                Some(a) => format!("rgba({}, {}, {}, {})", clamp(r), clamp(g), clamp(b), a.clamp(0.0, 1.0)),
                None => format!("rgb({}, {}, {})", clamp(r), clamp(g), clamp(b)),
            })
        } else {
            None
        };
        Ok(Value::Str(match rgb {
            Some(s) => s,
            // 无 rgb 分量：base（颜色名 / hex 串）原样透传；空 = Kotlin 默认不透明黑
            None => call
                .pos
                .first()
                .and_then(|v| v.as_str())
                .map(|s| s.to_string())
                .unwrap_or_else(|| "rgb(0, 0, 0)".to_string()),
        }))
    });

    // ============ Html / Markdown ============
    add(m, "html", |ev, call| {
        let body = body_md(ev, call)?;
        Ok(Value::Markdown(body))
    });
    add(m, "css", |ev, call| {
        let body = body_md(ev, call)?;
        Ok(Value::Markdown(format!("<style>\n{}\n</style>", body)))
    });
    add(m, "htmloptions", |_, _| Ok(Value::None));
    add(m, "cssproperties", |_, _| Ok(Value::None));
    add(m, "llmstxt", |_, _| Ok(Value::None));
    add(m, "markdown", |ev, call| {
        // 我们本来就输出 Markdown：原样透传
        let body = body_md(ev, call)?;
        Ok(Value::Markdown(body))
    });

    // ============ Process.env ============
    add(m, "env", |_, call| {
        let name = pos(call, 0)?.as_str().ok_or_else(|| ".env 变量名必须是文本".to_string())?;
        Ok(match std::env::var(name.trim()) {
            Ok(v) => Value::Str(v),
            Err(_) => Value::None,
        })
    });
}

/// 行内 Markdown → 纯文本（简化剥离）：图片/链接取文本，强调/代码记号丢弃。
/// 非完整行内解析，嵌套怪形态不强求——plaintext 的用途就是拿干净的纯文本。
fn plaintext(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let chars: Vec<char> = s.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        if chars[i] == '!' && chars.get(i + 1) == Some(&'[') {
            // ![alt](url) → alt
            if let Some((inner, mut next)) = bracket_group(&chars, i + 1, '[', ']') {
                if chars.get(next) == Some(&'(') {
                    if let Some((_, after)) = bracket_group(&chars, next, '(', ')') {
                        next = after;
                    }
                }
                out.push_str(&plaintext(&inner));
                i = next;
                continue;
            }
        }
        if chars[i] == '[' {
            // [text](url) → text
            if let Some((inner, mut next)) = bracket_group(&chars, i, '[', ']') {
                if chars.get(next) == Some(&'(') {
                    if let Some((_, after)) = bracket_group(&chars, next, '(', ')') {
                        next = after;
                    }
                }
                out.push_str(&plaintext(&inner));
                i = next;
                continue;
            }
        }
        match chars[i] {
            '*' | '_' | '`' | '~' => {} // 强调 / 代码 / 删除线记号丢弃
            '\\' => {}                  // 转义符丢弃
            c => out.push(c),
        }
        i += 1;
    }
    out
}

/// 从 chars[start]（应为 open 括号）读配平的括号组：返回（组内文本、组后下标）；不配平返回 None
fn bracket_group(chars: &[char], start: usize, open: char, close: char) -> Option<(String, usize)> {
    if chars.get(start) != Some(&open) {
        return None;
    }
    let mut depth = 0usize;
    let mut i = start;
    while i < chars.len() {
        let c = chars[i];
        if c == open {
            depth += 1;
        } else if c == close {
            depth -= 1;
            if depth == 0 {
                return Some((chars[start + 1..i].iter().collect(), i + 1));
            }
        }
        i += 1;
    }
    None
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
    fn flow_node与br_codespan() {
        assert_eq!(out(".node\n正文"), "正文");
        // .br 前要能断词（行内调用的 '.' 规则与行首一致）
        assert_eq!(out("一行 .br 二行"), "一行 \\\n 二行");
        assert_eq!(out(".codespan {x*y}"), "`x*y`");
        assert_eq!(out(".codespan {a`b}"), "`` a`b ``");
    }

    #[test]
    fn match_正则替换喂lambda() {
        let src = ".match {价格 12 与 34 元} {\\d+}\n    n:\n    **.n**";
        assert_eq!(out(src), "价格 **12** 与 **34** 元");
        // 空 pattern 原样
        assert_eq!(out(".match {abc} {}\n    .1"), "abc");
        // 语法错误降级
        let (t, n) = {
            let blocks = parse_document(".match {a} {(bad}\n    .1");
            eval_document(&blocks, builtins(), None)
        };
        assert!(t.contains(".match"));
        assert_eq!(n.len(), 1);
    }

    #[test]
    fn loremipsum_固定文本() {
        assert!(out(".loremipsum").starts_with("Lorem ipsum dolor sit amet"));
    }

    #[test]
    fn pair_二元组() {
        assert_eq!(out(".pair {a} {b}::first"), "a");
        assert_eq!(out(".var {p}\n    .pair {1} {2}\n\n.p::second"), "2");
    }

    #[test]
    fn plaintext_剥离行内记号() {
        assert_eq!(out(".plaintext {**粗** 和 [链](https://x) 与 `code`}"), "粗 和 链 与 code");
        // 图片取 alt；行首空格被整篇输出的 trim 吃掉
        assert_eq!(out(".plaintext {![](img.png) 图}"), "图");
    }

    #[test]
    fn optionality_五件套() {
        assert_eq!(out(".var {v}\n    .none\n\n.v::isnone"), "yes");
        assert_eq!(out(".var {v2}\n    有值\n\n.v2::isnone"), "no");
        assert_eq!(out(".none::otherwise {兜底}"), "兜底");
        assert_eq!(out(".var {v3}\n    有\n\n.v3::otherwise {兜底}"), "有");
        assert_eq!(out(".var {v4}\n    42\n\n.v4::ifpresent\n    值是 .1"), "值是 42");
        assert_eq!(out(".none::ifpresent\n    不会出"), "");
        assert_eq!(out(".var {v5} {7}\n\n.v5::takeif\n    .1::iseven"), "");
        assert_eq!(out(".var {v6} {8}\n\n.v6::takeif\n    .1::iseven"), "8");
        // get 缺键的 none 与 otherwise 串用
        assert_eq!(out(".var {d}\n    .dictionary\n        - a: 1\n\n.d::get {zzz}::otherwise {缺省}"), "缺省");
    }

    #[test]
    fn logger_log无输出_error降级() {
        assert_eq!(out(".log {记录}\n正文"), "正文");
        let (t, n) = {
            let blocks = parse_document(".error {出错了}");
            eval_document(&blocks, builtins(), None)
        };
        assert!(t.contains(".error"));
        assert_eq!(n.len(), 1);
        assert!(n[0].message.contains("出错了"));
    }

    #[test]
    fn keybinding_原样() {
        assert_eq!(out(".keybinding {Ctrl+S}"), "Ctrl+S");
    }

    #[test]
    fn color_rgb与base透传() {
        assert_eq!(out(".color red:{255} green:{0} blue:{0}"), "rgb(255, 0, 0)");
        assert_eq!(out(".color red:{1} green:{2} blue:{3} alpha:{0.5}"), "rgba(1, 2, 3, 0.5)");
        assert_eq!(out(".color {#ff0000}"), "#ff0000");
    }

    #[test]
    fn html_css_markdown_原样输出() {
        assert_eq!(out(".html\n    <b>x</b>"), "<b>x</b>");
        assert!(out(".css\n    p { color: red }").starts_with("<style>"));
        assert_eq!(out(".markdown\n    **原文**"), "**原文**");
        assert_eq!(out(".htmloptions title:{x}\n正文"), "正文");
    }

    #[test]
    fn env_读取与缺失() {
        std::env::set_var("NL_QD_TEST_VAR", "hello");
        assert_eq!(out(".env {NL_QD_TEST_VAR}"), "hello");
        assert_eq!(out(".env {NL_QD_MISSING_VAR_XYZ}::isnone"), "yes");
    }
}
