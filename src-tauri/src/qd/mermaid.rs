// mermaid.rs —— Mermaid 模块（阶段 3）
//
// 三个函数对齐 Kotlin stdlib Mermaid.kt。Kotlin 产出 Figure<MermaidDiagram> 节点、渲染成
// <pre class="mermaid">源码</pre> 由前端 Mermaid.js 渲染；本引擎输出 Markdown，
// ```mermaid 围栏代码块是等价形态——前端编辑器（mermaid 预览装饰）与四个导出点本就渲染这种围栏。
//
// 口径：caption / ref 任一设置时图按 figure 计数（Kotlin：有 caption 或 referenceId 就进编号），
// caption 行落 `*图 N. caption*` 斜体（「图」取 std 本地化词条）；ref:{id} 记入交叉引用账本，
// .ref {id} 可解析出编号（reference.rs）。xychart 由数值生成 xychart-beta 源码再落围栏。
// subdocumentgraph 依赖子文档图可视化，本引擎无输出。

use std::collections::HashMap;

use super::ast::Block;
use super::document::body_md;
use super::eval::{Builtin, BuiltinFn, Evaluator};
use super::localization::localize_or;
use super::value::Value;

pub fn register(m: &mut HashMap<String, Builtin>) {
    fn add(map: &mut HashMap<String, Builtin>, name: &str, f: BuiltinFn) {
        map.insert(name.to_string(), Builtin { f, lambda_args: &[] });
    }

    add(m, "mermaid", |ev, call| {
        let code = body_md(ev, call)?;
        if code.trim().is_empty() {
            return Err(".mermaid 需要图源码作为块参数".to_string());
        }
        let caption = named_str(call, "caption")?.filter(|c| !c.trim().is_empty());
        let refr = named_str(call, "ref")?.map(|r| r.trim().to_string()).filter(|r| !r.is_empty());
        let fence = format!("```mermaid\n{}\n```", code.trim_end());
        Ok(Value::Markdown(figure_md(ev, fence, caption, refr)))
    });

    add(m, "xychart", |ev, call| {
        let show_lines = named_bool(call, "lines", true)?;
        let show_bars = named_bool(call, "bars", false)?;
        let x_label = named_str(call, "x")?.filter(|s| !s.trim().is_empty());
        let y_label = named_str(call, "y")?.filter(|s| !s.trim().is_empty());
        let caption = named_str(call, "caption")?.filter(|c| !c.trim().is_empty());
        let refr = named_str(call, "ref")?.map(|r| r.trim().to_string()).filter(|r| !r.is_empty());
        let x_range = named_range(call, "xrange")?;
        let x_tags = named_str(call, "xtags")?.filter(|s| !s.trim().is_empty());
        let y_range = named_range(call, "yrange")?;
        if x_range.is_some() && x_tags.is_some() {
            return Err(".xychart 的 xrange 与 xtags 不能同时设置".to_string());
        }
        let body = match &call.body {
            Some(b) if !b.is_empty() => b,
            _ => return Err(".xychart 需要数值列表作为块参数".to_string()),
        };
        let (lines, points) = collect_lines(ev, body)?;
        if lines.is_empty() && points.is_empty() {
            return Err(".xychart 没有可绘制的数值".to_string());
        }
        let mut chart_lines: Vec<Vec<f64>> = lines;
        if !points.is_empty() {
            chart_lines.push(points); // 散点自成一条线（Kotlin extractLines 同规则）
        }

        let mut content = String::new();
        if let Some(r) = x_range {
            content.push_str(&format!("\nx-axis {} --> {}", fmt_num(r.0), fmt_num(r.1)));
        } else if let Some(tags) = x_tags {
            content.push_str(&format!("\nx-axis [{}]", tags));
        } else if let Some(l) = x_label {
            content.push_str(&format!("\nx-axis \"{}\"", l));
        }
        // y 轴没有 tags 位（Kotlin axis() 调用固定传 null）
        if let Some(r) = y_range {
            content.push_str(&format!("\ny-axis {} --> {}", fmt_num(r.0), fmt_num(r.1)));
        } else if let Some(l) = y_label {
            content.push_str(&format!("\ny-axis \"{}\"", l));
        }
        for points in &chart_lines {
            let list = format!("[{}]", points.iter().map(|p| fmt_num(*p)).collect::<Vec<_>>().join(", "));
            if show_bars {
                content.push_str(&format!("\nbar {}", list));
            }
            if show_lines {
                content.push_str(&format!("\nline {}", list));
            }
        }
        let code = format!("xychart-beta{}", content.replace('\n', "\n\t"));
        let fence = format!("```mermaid\n{}\n```", code);
        Ok(Value::Markdown(figure_md(ev, fence, caption, refr)))
    });

    add(m, "subdocumentgraph", |_, _| Ok(Value::None));
}

/// 图 → Markdown 围栏 + 计数 caption 行。caption / ref 任一存在时计入 figure 序号，
/// ref 记入交叉引用账本（.ref {id} 解析）。（Primitives 的 .figure 复用）
pub(crate) fn figure_md(ev: &mut Evaluator, body: String, caption: Option<String>, refr: Option<String>) -> String {
    let mut out = body;
    if caption.is_some() || refr.is_some() {
        ev.figures += 1;
        if let Some(id) = refr {
            ev.numbered.push((id, ev.figures));
        }
        if let Some(c) = caption {
            let label = localize_or(ev, "std", "figure", "Figure");
            out.push_str(&format!("\n\n*{} {}. {}*", label, ev.figures, c));
        }
    }
    out
}

fn named_str(call: &super::eval::BuiltinCall, name: &str) -> Result<Option<String>, String> {
    match call.named.iter().find(|(n, _)| n == name) {
        Some((_, v)) => v
            .as_str()
            .map(Some)
            .ok_or_else(|| format!(".{} 的 {}: 必须是文本", call.name, name)),
        None => Ok(None),
    }
}

fn named_bool(call: &super::eval::BuiltinCall, name: &str, default: bool) -> Result<bool, String> {
    match call.named.iter().find(|(n, _)| n == name) {
        Some((_, v)) => v
            .as_bool()
            .ok_or_else(|| format!(".{} 的 {}: 必须是 yes / no", call.name, name)),
        None => Ok(default),
    }
}

fn named_range(call: &super::eval::BuiltinCall, name: &str) -> Result<Option<(f64, f64)>, String> {
    match call.named.iter().find(|(n, _)| n == name) {
        Some((_, v)) => match v {
            Value::Range(a, b) => Ok(Some((*a as f64, *b as f64))),
            _ => Err(format!(".{} 的 {}: 必须是区间（如 {{1..10}}）", call.name, name)),
        },
        None => Ok(None),
    }
}

/// 块参数收集线条：顶层 `- ` 项，项内再有 `- ` 子项 → 一条线；否则该项是一个散点。
/// 散点合成一条线在调用方处理（Kotlin extractLines 同规则）。
fn collect_lines(ev: &mut Evaluator, body: &[Block]) -> Result<(Vec<Vec<f64>>, Vec<f64>), String> {
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
    struct Item {
        children: Vec<String>,
        point: Option<String>,
    }
    let mut items: Vec<Item> = Vec::new();
    for l in &lines {
        let t = l.trim_end();
        let st = t.trim_start();
        if !st.starts_with("- ") {
            continue;
        }
        let ind = t.len() - st.len();
        let text = st[2..].trim().to_string();
        if ind == 0 {
            items.push(Item { children: Vec::new(), point: Some(text) });
        } else {
            match items.last_mut() {
                Some(it) => it.children.push(text),
                None => return Err(".xychart 的数值列表缩进层级不对".to_string()),
            }
        }
    }
    if items.is_empty() {
        // 单行数值串（.repeat 产出的裸数字行）也收
        let nums: Vec<f64> = lines
            .iter()
            .filter_map(|l| l.trim().parse::<f64>().ok())
            .collect();
        if !nums.is_empty() {
            return Ok((Vec::new(), nums));
        }
        return Err(".xychart 块参数里没有数值列表".to_string());
    }
    let mut out_lines: Vec<Vec<f64>> = Vec::new();
    let mut points: Vec<f64> = Vec::new();
    for it in items {
        if !it.children.is_empty() {
            // `- - 5` 顶层项的内联余文是第一个子点
            let mut cells: Vec<String> = Vec::new();
            if let Some(p) = &it.point {
                if let Some(first) = p.trim().strip_prefix("- ") {
                    cells.push(first.trim().to_string());
                }
            }
            cells.extend(it.children);
            let line = cells
                .iter()
                .map(|c| {
                    c.trim()
                        .parse::<f64>()
                        .map_err(|_| format!(".xychart 数值不是数字: {}", c.trim()))
                })
                .collect::<Result<Vec<_>, _>>()?;
            out_lines.push(line);
        } else if let Some(p) = it.point {
            let n = p.trim().parse::<f64>().map_err(|_| format!(".xychart 数值不是数字: {}", p.trim()))?;
            points.push(n);
        }
    }
    Ok((out_lines, points))
}

fn fmt_num(n: f64) -> String {
    super::value::fmt_num(n)
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
    fn mermaid_落围栏与caption() {
        let src = ".mermaid\n    graph TD\n        A --> B";
        assert_eq!(out(src), "```mermaid\ngraph TD\n    A --> B\n```");
        // caption 计数 + 本地化词条
        let src2 = ".doclang {Chinese}\n.mermaid caption:{流程}\n    graph TD\n        A --> B\n\n.mermaid caption:{时序}\n    sequenceDiagram\n        A->>B";
        let (text, diags) = {
            let blocks = parse_document(src2);
            eval_document(&blocks, builtins(), None)
        };
        assert!(diags.is_empty());
        assert!(text.contains("*图 1. 流程*"));
        assert!(text.contains("*图 2. 时序*"));
    }

    #[test]
    fn xychart_生成源码() {
        let src = ".xychart\n    - 5\n    - 2\n    - 4";
        assert_eq!(
            out(src),
            "```mermaid\nxychart-beta\n\tline [5, 2, 4]\n```"
        );
        // 多线 + 柱状 + 轴标签
        let src2 = ".xychart bars:{yes} lines:{no} x:{月份} y:{销量}\n    - - 5\n      - 8\n    - - 3\n      - 1";
        assert_eq!(
            out(src2),
            "```mermaid\nxychart-beta\n\tx-axis \"月份\"\n\ty-axis \"销量\"\n\tbar [5, 8]\n\tbar [3, 1]\n```"
        );
        // xtags 与 xrange 互斥
        let (t, n) = {
            let blocks = parse_document(".xychart xrange:{1..5} xtags:{a} \n    - 1");
            eval_document(&blocks, builtins(), None)
        };
        assert!(t.contains(".xychart"));
        assert_eq!(n.len(), 1);
        // 轴范围
        let src3 = ".xychart xrange:{0..10}\n    - 1\n    - 2";
        assert!(out(src3).contains("x-axis 0 --> 10"));
    }

    #[test]
    fn mermaid_ref进交叉引用账本() {
        let src = ".mermaid ref:{flow} caption:{架构}\n    graph TD\n        A --> B\n\n见图 .ref {flow}";
        assert!(out(src).contains("见图 1"));
    }

    #[test]
    fn mermaid_空body降级() {
        let (t, n) = {
            let blocks = parse_document(".mermaid {x}");
            eval_document(&blocks, builtins(), None)
        };
        assert!(t.contains(".mermaid"));
        assert_eq!(n.len(), 1);
    }
}
