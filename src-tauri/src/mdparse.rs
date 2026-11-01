// mdparse.rs —— Phase 1：Markdown → ProseMirror JSON 的后台解析（保守核心子集）
//
// 定位：虚拟化方案里「把初次解析挪出主线程」的地基。与前端 editor-schema.js 是两套实现，
// 漂移即坏文件，所以刻意保守：只覆盖纯 CommonMark + GFM（标题 / 段落 / 强调 / 行内码 /
// 链接 / 图片 / 删除线 / 列表 / 任务列表 / 代码块 / 引用 / 分割线 / 表格），其余一律
// supported:false 让调用方回退 JS 解析。判等靠 tests/fixtures/md-parity.json 与前端逐字节对拍。

use pulldown_cmark::{Alignment, CodeBlockKind, Event, HeadingLevel, Options, Parser, Tag, TagEnd};
use serde_json::{json, Value};

/// 入口：返回 {supported, doc|null, reason?}。
pub fn md_to_pm_json(md: &str) -> Value {
    if let Some(tok) = forbidden_token(md) {
        return unsupported(format!("含未覆盖构造 {tok}"));
    }
    match build(md) {
        Ok(doc) => json!({ "supported": true, "doc": doc }),
        Err(reason) => unsupported(reason),
    }
}

fn unsupported(reason: String) -> Value {
    json!({ "supported": false, "doc": Value::Null, "reason": reason })
}

// 预闸：含自定义 / 边缘语法就交给 JS，避免与 editor-schema.js 的解析分叉。
fn forbidden_token(md: &str) -> Option<&'static str> {
    for (pat, name) in [
        ("[[", "[[wikilink]]"),
        ("]]", "]]"),
        ("$", "$math$"),
        ("<", "<html/autolink>"),
        ("[^", "[^footnote]"),
        (":::", "容器"),
        ("~~~", "~~~ 围栏"),
        ("[!", "GitHub 提示块"),
    ] {
        if md.contains(pat) {
            return Some(name);
        }
    }
    None
}

// mark 在 PM 里按 schema rank 排序输出（link<em<strong<code<strike），与嵌套顺序无关。
fn mark_rank(t: &str) -> u8 {
    match t {
        "link" => 0,
        "em" => 1,
        "strong" => 2,
        "code" => 3,
        "strike" => 4,
        _ => 9,
    }
}

#[derive(Clone)]
struct Mark {
    ty: &'static str,
    attrs: Option<Value>,
}

type Stop<'a> = &'a dyn Fn(&TagEnd) -> bool;

struct Builder<'a> {
    ev: Vec<Event<'a>>,
    i: usize,
}

impl<'a> Builder<'a> {
    fn peek(&self) -> Option<&Event<'a>> {
        self.ev.get(self.i)
    }
    fn next(&mut self) -> Option<Event<'a>> {
        let e = self.ev.get(self.i).cloned();
        if e.is_some() {
            self.i += 1;
        }
        e
    }
    // 消费一个匹配 pred 的 End 事件
    fn eat_end(&mut self, pred: Stop) -> Result<(), String> {
        match self.next() {
            Some(Event::End(t)) if pred(&t) => Ok(()),
            other => Err(format!("期望块结束，实际 {:?}", other)),
        }
    }

    fn parse_blocks(&mut self, stop: Option<Stop>) -> Result<Vec<Value>, String> {
        let mut out = Vec::new();
        loop {
            match self.peek() {
                None => break,
                Some(Event::End(t)) => {
                    if let Some(s) = stop {
                        if s(t) {
                            break;
                        }
                    }
                    return Err(format!("意外的块结束 {:?}", t));
                }
                Some(_) => out.push(self.parse_block()?),
            }
        }
        Ok(out)
    }

    fn parse_block(&mut self) -> Result<Value, String> {
        match self.next() {
            Some(Event::Start(Tag::Heading { level, .. })) => {
                let content = self.parse_inline(&|t| matches!(t, TagEnd::Heading(_)))?;
                self.eat_end(&|t| matches!(t, TagEnd::Heading(_)))?;
                Ok(json!({"type":"heading","attrs":{"level":level_num(level)},"content":content}))
            }
            Some(Event::Start(Tag::Paragraph)) => {
                let content = self.parse_inline(&|t| matches!(t, TagEnd::Paragraph))?;
                self.eat_end(&|t| matches!(t, TagEnd::Paragraph))?;
                Ok(json!({"type":"paragraph","content":content}))
            }
            Some(Event::Start(Tag::BlockQuote(_))) => {
                let content = self.parse_blocks(Some(&|t| matches!(t, TagEnd::BlockQuote(_))))?;
                self.eat_end(&|t| matches!(t, TagEnd::BlockQuote(_)))?;
                Ok(json!({"type":"blockquote","content":content}))
            }
            Some(Event::Start(Tag::List(start))) => self.parse_list(start),
            Some(Event::Start(Tag::CodeBlock(kind))) => {
                let params = match kind {
                    CodeBlockKind::Fenced(info) => info.to_string(),
                    CodeBlockKind::Indented => String::new(),
                };
                let mut text = String::new();
                while let Some(e) = self.next() {
                    match e {
                        Event::Text(t) => text.push_str(&t),
                        Event::End(TagEnd::CodeBlock) => break,
                        other => return Err(format!("代码块内含意外事件 {:?}", other)),
                    }
                }
                if text.ends_with('\n') {
                    text.pop();
                }
                let content = if text.is_empty() {
                    Value::Array(vec![])
                } else {
                    json!([{"type":"text","text":text}])
                };
                Ok(json!({"type":"code_block","attrs":{"params":params},"content":content}))
            }
            Some(Event::Rule) => Ok(json!({"type":"horizontal_rule"})),
            Some(other) => Err(format!("未覆盖的块事件 {:?}", other)),
            None => Err("块提前结束".into()),
        }
    }

    fn parse_list(&mut self, start: Option<u64>) -> Result<Value, String> {
        let ordered = start.is_some();
        let mut items = Vec::new();
        let mut tight = true;
        while !matches!(self.peek(), Some(Event::End(TagEnd::List(_)))) {
            match self.next() {
                Some(Event::Start(Tag::Item)) => {}
                other => return Err(format!("期望列表项 {:?}", other)),
            }
            let mut checked: Option<bool> = None;
            if let Some(Event::TaskListMarker(b)) = self.peek() {
                checked = Some(*b);
                self.i += 1;
            }
            let content = if matches!(self.peek(), Some(Event::Start(Tag::Paragraph))) {
                tight = false;
                self.parse_blocks(Some(&|t| matches!(t, TagEnd::Item)))?
            } else {
                let inline = self.parse_inline(&|t| matches!(t, TagEnd::Item))?;
                vec![json!({"type":"paragraph","content":inline})]
            };
            self.eat_end(&|t| matches!(t, TagEnd::Item))?;
            items.push(json!({"type":"list_item","attrs":{"checked":checked},"content":content}));
        }
        self.next(); // End(List)
        if ordered {
            Ok(json!({"type":"ordered_list","attrs":{"order":start.unwrap_or(1),"tight":tight},"content":items}))
        } else {
            Ok(json!({"type":"bullet_list","attrs":{"tight":tight},"content":items}))
        }
    }

    fn parse_table(&mut self, aligns: Vec<Alignment>) -> Result<Value, String> {
        let mut rows = Vec::new();
        loop {
            match self.next() {
                Some(Event::End(TagEnd::Table)) => break,
                Some(Event::Start(Tag::TableHead)) => {
                    rows.push(self.parse_table_row(&aligns, true)?);
                    self.eat_end(&|t| matches!(t, TagEnd::TableHead))?;
                }
                Some(Event::Start(Tag::TableRow)) => {
                    rows.push(self.parse_table_row(&aligns, false)?);
                    self.eat_end(&|t| matches!(t, TagEnd::TableRow))?;
                }
                other => return Err(format!("表格结构意外 {:?}", other)),
            }
        }
        Ok(json!({"type":"table","content":rows}))
    }

    fn parse_table_row(&mut self, aligns: &[Alignment], head: bool) -> Result<Value, String> {
        let ty = if head { "table_header" } else { "table_cell" };
        let mut cells = Vec::new();
        let mut col = 0usize;
        while !matches!(
            self.peek(),
            Some(Event::End(TagEnd::TableHead)) | Some(Event::End(TagEnd::TableRow))
        ) {
            match self.next() {
                Some(Event::Start(Tag::TableCell)) => {}
                other => return Err(format!("期望单元格 {:?}", other)),
            }
            let content = if matches!(self.peek(), Some(Event::Start(Tag::Paragraph))) {
                self.i += 1;
                let c = self.parse_inline(&|t| matches!(t, TagEnd::Paragraph))?;
                self.eat_end(&|t| matches!(t, TagEnd::Paragraph))?;
                c
            } else {
                self.parse_inline(&|t| matches!(t, TagEnd::TableCell))?
            };
            let alignment = match aligns.get(col) {
                Some(Alignment::Left) => Some("left"),
                Some(Alignment::Center) => Some("center"),
                Some(Alignment::Right) => Some("right"),
                _ => None,
            };
            cells.push(json!({
                "type": ty,
                "attrs": {"colspan":1,"rowspan":1,"colwidth":null,"alignment":alignment},
                "content": content
            }));
            self.eat_end(&|t| matches!(t, TagEnd::TableCell))?;
            col += 1;
        }
        Ok(json!({"type":"table_row","content":cells}))
    }

    fn parse_inline(&mut self, stop: Stop) -> Result<Vec<Value>, String> {
        let mut marks: Vec<Mark> = Vec::new();
        let mut nodes: Vec<Value> = Vec::new();
        loop {
            let Some(e) = self.peek().cloned() else { break };
            match e {
                Event::End(t) if stop(&t) => break,
                Event::Text(t) => {
                    nodes.push(text_node(&t, &marks));
                    self.i += 1;
                }
                Event::Code(t) => {
                    let mut m = marks.clone();
                    m.push(Mark { ty: "code", attrs: None });
                    nodes.push(text_node(&t, &m));
                    self.i += 1;
                }
                Event::SoftBreak | Event::HardBreak => return Err("含软/硬换行".into()),
                Event::Html(_) | Event::InlineMath(_) | Event::DisplayMath(_) => {
                    return Err("含 HTML/数学".into())
                }
                Event::Start(tag) => match tag {
                    Tag::Emphasis => {
                        marks.push(Mark { ty: "em", attrs: None });
                        self.i += 1;
                    }
                    Tag::Strong => {
                        marks.push(Mark { ty: "strong", attrs: None });
                        self.i += 1;
                    }
                    Tag::Strikethrough => {
                        marks.push(Mark { ty: "strike", attrs: None });
                        self.i += 1;
                    }
                    Tag::Link { dest_url, title, .. } => {
                        marks.push(Mark {
                            ty: "link",
                            attrs: Some(json!({"href": dest_url.to_string(), "title": title_or_null(&title)})),
                        });
                        self.i += 1;
                    }
                    Tag::Image { dest_url, title, .. } => {
                        self.i += 1;
                        let alt = self.parse_inline(&|t| matches!(t, TagEnd::Image))?;
                        self.eat_end(&|t| matches!(t, TagEnd::Image))?;
                        nodes.push(json!({
                            "type":"image",
                            "attrs":{
                                "src": dest_url.to_string(),
                                "alt": alt_text(&alt),
                                "title": title_or_null(&title),
                                "embed": false,
                                "width": null
                            }
                        }));
                    }
                    other => return Err(format!("未覆盖的行内起始 {:?}", other)),
                },
                Event::End(t) => match t {
                    TagEnd::Emphasis | TagEnd::Strong | TagEnd::Strikethrough | TagEnd::Link => {
                        marks.pop();
                        self.i += 1;
                    }
                    _ => return Err(format!("行内遇到意外结束 {:?}", t)),
                },
                other => return Err(format!("行内遇到意外事件 {:?}", other)),
            }
        }
        Ok(merge_text(nodes))
    }
}

fn build(md: &str) -> Result<Value, String> {
    let mut opts = Options::empty();
    opts.insert(Options::ENABLE_TABLES);
    opts.insert(Options::ENABLE_STRIKETHROUGH);
    opts.insert(Options::ENABLE_TASKLISTS);
    let ev: Vec<Event> = Parser::new_ext(md, opts).collect();
    let mut b = Builder { ev, i: 0 };
    let mut content: Vec<Value> = Vec::new();
    while b.peek().is_some() {
        if let Some(Event::Start(Tag::Table(aligns))) = b.peek() {
            let aligns = aligns.clone();
            b.i += 1;
            content.push(b.parse_table(aligns)?);
            continue;
        }
        let before = b.i;
        content.extend(b.parse_blocks(None)?);
        if b.i == before {
            return Err("解析未推进".into());
        }
    }
    Ok(json!({"type":"doc","content":content}))
}

fn text_node(t: &str, marks: &[Mark]) -> Value {
    if marks.is_empty() {
        json!({"type":"text","text":t})
    } else {
        let mut ms: Vec<&Mark> = marks.iter().collect();
        ms.sort_by_key(|m| mark_rank(m.ty));
        let arr: Vec<Value> = ms
            .iter()
            .map(|m| match &m.attrs {
                Some(a) => json!({"type": m.ty, "attrs": a}),
                None => json!({"type": m.ty}),
            })
            .collect();
        json!({"type":"text","marks":arr,"text":t})
    }
}

/// 合并相邻、同 marks 的文本节点（pulldown 可能把一段文本拆成多个 Text 事件）。
fn merge_text(nodes: Vec<Value>) -> Vec<Value> {
    let mut out: Vec<Value> = Vec::new();
    for n in nodes {
        if n.get("type").and_then(|v| v.as_str()) == Some("text") {
            let same = out.last().map(|p| {
                p.get("type").and_then(|v| v.as_str()) == Some("text") && p.get("marks") == n.get("marks")
            });
            if same == Some(true) {
                let merged = format!(
                    "{}{}",
                    out.last().unwrap()["text"].as_str().unwrap_or(""),
                    n["text"].as_str().unwrap_or("")
                );
                let marks = out.last().unwrap().get("marks").cloned();
                let mut tn = json!({"type":"text","text":merged});
                if let Some(m) = marks {
                    tn["marks"] = m;
                }
                *out.last_mut().unwrap() = tn;
                continue;
            }
        }
        out.push(n);
    }
    out
}

fn alt_text(nodes: &[Value]) -> Option<String> {
    let s: String = nodes
        .iter()
        .map(|n| n.get("text").and_then(|v| v.as_str()).unwrap_or(""))
        .collect();
    if s.is_empty() {
        None
    } else {
        Some(s)
    }
}

fn title_or_null(t: &pulldown_cmark::CowStr) -> Value {
    if t.is_empty() {
        Value::Null
    } else {
        json!(t.to_string())
    }
}

fn level_num(l: HeadingLevel) -> u8 {
    match l {
        HeadingLevel::H1 => 1,
        HeadingLevel::H2 => 2,
        HeadingLevel::H3 => 3,
        HeadingLevel::H4 => 4,
        HeadingLevel::H5 => 5,
        HeadingLevel::H6 => 6,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    // 与前端 editor-schema.js 共享同一 fixture：Rust 产物 == fixture == JS 产物，即三方一致。
    const FIXTURE: &str = include_str!("../../src/tests/fixtures/md-parity.json");

    #[test]
    fn parity_with_frontend_fixture() {
        let cases: Vec<Value> = serde_json::from_str(FIXTURE).unwrap();
        assert!(!cases.is_empty());
        for (idx, c) in cases.iter().enumerate() {
            let md = c["md"].as_str().unwrap();
            let want = &c["doc"];
            let got = md_to_pm_json(md);
            assert_eq!(
                got["supported"].as_bool(),
                Some(true),
                "用例 {idx} 应被支持，reason={}",
                got["reason"]
            );
            assert_eq!(&got["doc"], want, "用例 {idx} 与前端产物不一致：{md:?}");
        }
    }

    #[test]
    fn custom_syntax_falls_back() {
        assert_eq!(md_to_pm_json("[[页]]")["supported"].as_bool(), Some(false));
        assert_eq!(md_to_pm_json("$x^2$")["supported"].as_bool(), Some(false));
        assert_eq!(md_to_pm_json("<b>x</b>")["supported"].as_bool(), Some(false));
    }
}
