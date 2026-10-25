// primitives.rs —— Primitives 模块（阶段 5）：Markdown 元素原语
//
// Kotlin 的 Primitives.kt 是 heading / paragraph / link / image / code / math / figure /
// pagebreak 八个原语，主要供 .extend 定制全部同类元素的渲染。本引擎直接落 Markdown 等价形态：
//  · heading {depth} + 行内 body → ATX 标题；numbered / indexed / breakpage / ref / 样式参数收下忽略
//  · paragraph + body → 平铺
//  · link + body → [content](url "title")
//  · image {url} label:{...} → ![label](url)；title 收下忽略，width / height 不落
//    （Typora 的 =WxH 尺寸形态不是标准 GFM，与幻灯片导出同一取舍）
//  · pagebreak → `---`：幻灯片导出里是切片（--- 优先模式），普通文档里是水平线；
//    打印排版走 DOM 克隆不经引擎产物，不受影响
//  · code lang:{...} caption:{...} + body → 围栏代码块 + 斜体 caption（csv 同口径）；
//    linenumbers / focus / callouts / ref 收下忽略
//  · math + body → $$ 块公式（block:{no} 落行内 $...$），前端 KaTeX 管线直接吃
//  · figure caption:{...} ref:{...} + body → 内容平铺 + figure 计数 caption 行（mermaid 同源）

use std::collections::HashMap;

use super::document::body_md;
use super::eval::{Builtin, BuiltinFn};
use super::mermaid::figure_md;
use super::stdlib::{named_or_pos, num, pos};
use super::value::Value;

pub fn register(m: &mut HashMap<String, Builtin>) {
    fn add(map: &mut HashMap<String, Builtin>, name: &str, f: BuiltinFn) {
        map.insert(name.to_string(), Builtin { f, lambda_args: &[] });
    }

    add(m, "heading", |ev, call| {
        let depth = num(call, 0)? as usize;
        if !(1..=6).contains(&depth) {
            return Err(".heading 的 depth 必须是 1–6".to_string());
        }
        let content = body_md(ev, call)?;
        Ok(Value::Markdown(format!("{} {}", "#".repeat(depth), content)))
    });

    add(m, "paragraph", |ev, call| {
        let content = body_md(ev, call)?;
        Ok(Value::Markdown(content))
    });

    add(m, "link", |ev, call| {
        let url = pos(call, 0)?.as_str().ok_or_else(|| ".link 的 url 必须是文本".to_string())?;
        let content = body_md(ev, call)?;
        let title = call
            .named
            .iter()
            .find(|(n, _)| n == "title")
            .map(|(_, v)| v.as_str().ok_or_else(|| ".link 的 title: 必须是文本".to_string()))
            .transpose()?
            .filter(|t| !t.trim().is_empty());
        Ok(Value::Str(match title {
            Some(t) => format!("[{}]({} \"{}\")", content.trim(), url.trim(), t.trim()),
            None => format!("[{}]({})", content.trim(), url.trim()),
        }))
    });

    add(m, "image", |_, call| {
        let url = pos(call, 0)?.as_str().ok_or_else(|| ".image 的 url 必须是文本".to_string())?;
        let label = named_or_pos(call, "label", 1)?
            .as_str()
            .ok_or_else(|| ".image 的 label: 必须是文本".to_string())?;
        Ok(Value::Str(format!("![{}]({})", label.trim(), url.trim())))
    });

    add(m, "pagebreak", |_, _| Ok(Value::Markdown("---".to_string())));

    add(m, "code", |ev, call| {
        let lang = call
            .named
            .iter()
            .find(|(n, _)| n == "lang")
            .map(|(_, v)| v.as_str().ok_or_else(|| ".code 的 lang: 必须是文本".to_string()))
            .transpose()?
            .map(|l| l.trim().to_string())
            .filter(|l| !l.is_empty());
        let caption = call
            .named
            .iter()
            .find(|(n, _)| n == "caption")
            .map(|(_, v)| v.as_str().ok_or_else(|| ".code 的 caption: 必须是文本".to_string()))
            .transpose()?
            .filter(|c| !c.trim().is_empty());
        let code = body_md(ev, call)?;
        if code.trim().is_empty() {
            return Err(".code 需要代码内容作为块参数".to_string());
        }
        let fence = match &lang {
            Some(l) => format!("```{}\n{}\n```", l, code.trim_end()),
            None => format!("```\n{}\n```", code.trim_end()),
        };
        Ok(Value::Markdown(match caption {
            Some(c) => format!("{}\n\n*{}*", fence, c),
            None => fence,
        }))
    });

    add(m, "math", |ev, call| {
        let block = call
            .named
            .iter()
            .find(|(n, _)| n == "block")
            .map(|(_, v)| v.as_bool().ok_or_else(|| ".math 的 block: 必须是 yes / no".to_string()))
            .transpose()?
            .unwrap_or(true);
        let content = body_md(ev, call)?;
        if content.trim().is_empty() {
            return Err(".math 需要公式作为块参数".to_string());
        }
        Ok(Value::Markdown(match block {
            true => format!("$$\n{}\n$$", content.trim()),
            false => format!("${}$", content.trim()),
        }))
    });

    add(m, "figure", |ev, call| {
        let caption = call
            .named
            .iter()
            .find(|(n, _)| n == "caption")
            .map(|(_, v)| v.as_str().ok_or_else(|| ".figure 的 caption: 必须是文本".to_string()))
            .transpose()?
            .filter(|c| !c.trim().is_empty());
        let refr = call
            .named
            .iter()
            .find(|(n, _)| n == "ref")
            .map(|(_, v)| v.as_str().ok_or_else(|| ".figure 的 ref: 必须是文本".to_string()))
            .transpose()?
            .map(|r| r.trim().to_string())
            .filter(|r| !r.is_empty());
        let body = body_md(ev, call)?;
        Ok(Value::Markdown(figure_md(ev, body, caption, refr)))
    });
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
    fn heading_与paragraph() {
        assert_eq!(out(".heading {3}\n    三级标题"), "### 三级标题");
        assert_eq!(out(".heading {1}\n    顶格"), "# 顶格");
        let (_, n) = {
            let blocks = parse_document(".heading {9}\n    x");
            eval_document(&blocks, builtins(), None)
        };
        assert_eq!(n.len(), 1);
        assert_eq!(out(".paragraph\n    就是正文"), "就是正文");
    }

    #[test]
    fn link_与image() {
        assert_eq!(out(".link {https://x}\n    点这里"), "[点这里](https://x)");
        assert_eq!(out(".link {https://x} title:{提示}\n    点这里"), "[点这里](https://x \"提示\")");
        assert_eq!(out(".image {a.png} label:{截图}"), "![截图](a.png)");
        let (_, n) = {
            let blocks = parse_document(".image {a.png}");
            eval_document(&blocks, builtins(), None)
        };
        assert_eq!(n.len(), 1);
    }

    #[test]
    fn pagebreak_落水平线() {
        assert_eq!(out("上页\n\n.pagebreak\n\n下页"), "上页\n\n---\n\n下页");
    }

    #[test]
    fn code_围栏与caption() {
        assert_eq!(out(".code lang:{rust}\n    fn main() {}"), "```rust\nfn main() {}\n```");
        assert_eq!(
            out(".code caption:{示例}\n    x = 1"),
            "```\nx = 1\n```\n\n*示例*"
        );
    }

    #[test]
    fn math_块与行内() {
        assert_eq!(out(".math\n    E = mc^2"), "$$\nE = mc^2\n$$");
        assert_eq!(out(".math block:{no}\n    a+b"), "$a+b$");
    }

    #[test]
    fn figure_计数与caption() {
        let src = ".doclang {Chinese}\n.figure caption:{架构} ref:{fig1}\n    内容\n\n见图 .ref {fig1}";
        let text = out(src);
        assert!(text.contains("*图 1. 架构*"));
        assert!(text.contains("见图 1"));
    }
}
