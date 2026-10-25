// document.rs —— Document / Layout / TableComputation 三模块（阶段 2 批 3）
//
// 输出口径（批 3 决策）：全部输出 Markdown，不做 HTML 片段。HTML 路线要同时改
// 编辑器快照（html:false 是刻意安全口径）、单篇 HTML、整站、幻灯片四个 markdown-it
// 消费端并各接净化链路，成本与行为不一致都不划算。落点分三档：
//  · 有 Markdown 等价物的结构照常输出（表格运算、box / collapse → 引用块、toc → [[toc]]）
//  · 纯样式 / 布局容器（container / row / grid / align…）输出 body 平铺，样式丢弃
//  · 分页渲染器的专属机制（页码、页边距、页格式）无输出或占位符，内容性实参随之丢弃
//    （footer / pagemargin 的正文不进主文档流，Quarkdown 里也是后处理复制到每页的）
//
// 函数名与语义逐条对拍 Kotlin 源码（Document.kt / Layout.kt / TableComputation.kt，
// 行号证据见实现时核对记录）。TableComputation 的表操作在文本层进行：
// 块参数求值 → 取第一张管道表（mdtable.rs）→ 变换单元格 → 重新序列化，
// 对应 Kotlin 侧 findTable + Table AST 那一段。
// lambda 实参（tablefilter / tablecompute）经 Builtin 的 lambda_args 声明、
// eval 层解析为 Value::Lambda，调用走 Evaluator::call_lambda。

use std::collections::HashMap;

use super::eval::{Builtin, BuiltinCall, BuiltinFn, Evaluator};
use super::mdtable::{cell_to_md, parse_pipe_rows, pipe_table_md};
use super::stdlib::{named_or_pos, num, pos};
use super::value::Value;

fn add(map: &mut HashMap<String, Builtin>, name: &str, f: BuiltinFn) {
    add_l(map, name, &[], f)
}

fn add_l(map: &mut HashMap<String, Builtin>, name: &str, lambda_args: &'static [&'static str], f: BuiltinFn) {
    map.insert(name.to_string(), Builtin { f, lambda_args });
}

pub fn register(m: &mut HashMap<String, Builtin>) {
    // ============ Document：文档元数据（modifyOrEcho 模式的无值侧 → 无输出）============
    // Kotlin 有值写入元数据、无值回显当前值；文本引擎不持元数据，两侧都无输出。
    // footer / pagemargin 的内容属页边距区域（分页后处理复制到每页），不进主文档流。
    const DOC_NOOPS: [&str; 23] = [
        "doctype", "docname", "docdescription", "docauthor", "docauthors", "dockeywords", "doclang", "theme",
        "numbering", "nonumbering", "font", "paragraphstyle", "captionposition", "texmacro", "pageformat",
        "autopagebreak", "noautopagebreak", "formatpagenumber", "resetpagenumber", "pagemargin", "footer",
        "marker", "lastheading",
    ];
    for name in DOC_NOOPS {
        add(m, name, |_, _| Ok(Value::None));
    }
    // 页码占位：Quarkdown HTML 里也是 "-" 占位、由运行时分页脚本填充
    add(m, "currentpage", |_, _| Ok(Value::Str("-".to_string())));
    add(m, "totalpages", |_, _| Ok(Value::Str("-".to_string())));
    // 目录：交给前端既有的 [[toc]] 渲染链路（编辑器 toc-block 装饰 + 导出 injectToc）；
    // maxdepth / breakpage 等参数收下忽略（[[toc]] 固定 H1–H3）
    add(m, "tableofcontents", |_, _| Ok(Value::Str("[[toc]]".to_string())));

    // ============ Layout：容器 ============
    // 纯布局容器（样式 / 浮动 / 网格在 Markdown 里无处安放）：body 求值后平铺输出
    const LAYOUT_PASSTHROUGH: [&str; 10] =
        ["container", "align", "center", "float", "row", "column", "grid", "landscape", "fullspan", "clip"];
    for name in LAYOUT_PASSTHROUGH {
        add(m, name, |ev, call| {
            let body = body_md(ev, call)?;
            Ok(Value::Markdown(body))
        });
    }
    // 空白占位：无内容语义
    add(m, "whitespace", |_, _| Ok(Value::None));
    // 提示盒 / 折叠：引用块 + 加粗标题行（标题缺省时只出正文）
    add(m, "box", |ev, call| {
        let title = call.pos.get(0).and_then(|v| v.as_str());
        let body = body_md(ev, call)?;
        Ok(Value::Markdown(quote_block(title.as_deref().filter(|t| !t.is_empty()), &body)))
    });
    add(m, "todo", |ev, call| {
        let body = body_md(ev, call)?;
        Ok(Value::Markdown(quote_block(Some("TODO"), &body)))
    });
    add(m, "collapse", |ev, call| {
        // <details><summary> 在 Markdown 无等价物：降级为引用块（内容不丢，折叠语义丢失）
        let title = call.pos.get(0).and_then(|v| v.as_str());
        let body = body_md(ev, call)?;
        Ok(Value::Markdown(quote_block(title.as_deref().filter(|t| !t.is_empty()), &body)))
    });
    add(m, "textcollapse", |_, call| {
        // 内联收起靠 JS 交互：输出展开态全文
        let full = pos(call, 0)?.as_str().ok_or_else(|| ".textcollapse 的 full: 必须是文本".to_string())?;
        Ok(Value::Str(full))
    });
    // Layout 的 .table：块参数里多个子表按「行对齐、列拼接」合成一张表
    //（Kotlin 侧 @Body subTables 逐段解析取首个 Table 节点；这里按空行分段）
    add(m, "table", |ev, call| {
        let body = body_md(ev, call)?;
        let mut segments: Vec<Vec<Vec<String>>> = Vec::new();
        for seg in body.split("\n\n") {
            let lines: Vec<&str> = seg.lines().collect();
            if let Some(rows) = parse_pipe_rows(&lines) {
                segments.push(rows);
            }
        }
        if segments.is_empty() {
            return Err(".table 块参数里没有管道表格".to_string());
        }
        let row_count = segments.iter().map(|s| s.len()).max().unwrap_or(0);
        let mut merged: Vec<Vec<String>> = Vec::new();
        for r in 0..row_count {
            let mut row: Vec<String> = Vec::new();
            for seg in &segments {
                row.extend(seg.get(r).cloned().unwrap_or_default());
            }
            merged.push(row);
        }
        Ok(Value::Markdown(pipe_table_md(&merged)))
    });

    // ============ TableComputation：表变换 ============
    // 列号一律 1 起始；表来自块参数求值结果里的第一张管道表（字面表格或 .csv 输出皆可）
    fn col_index(call: &BuiltinCall, arg_index: usize) -> Result<usize, String> {
        let col = num(call, arg_index)?;
        if col < 1.0 {
            return Err(format!(".{} 列号从 1 开始", call.name));
        }
        Ok(col as usize - 1)
    }
    fn body_table(ev: &mut Evaluator, call: &BuiltinCall) -> Result<Vec<Vec<String>>, String> {
        let body = body_md(ev, call)?;
        let lines: Vec<&str> = body.lines().collect();
        parse_pipe_rows(&lines).ok_or_else(|| format!(".{} 块参数里没有管道表格", call.name))
    }
    fn cmp_cells(a: &str, b: &str) -> std::cmp::Ordering {
        // 数值优先、文本兜底（与 sorted 同口径）
        if let (Ok(x), Ok(y)) = (a.trim().parse::<f64>(), b.trim().parse::<f64>()) {
            return x.partial_cmp(&y).unwrap_or(std::cmp::Ordering::Equal);
        }
        a.cmp(b)
    }
    add(m, "tablesort", |ev, call| {
        let ci = col_index(call, 0)?;
        let order = call
            .named
            .iter()
            .find(|(n, _)| n == "order")
            .map(|(_, v)| v.to_output().to_lowercase())
            .unwrap_or_else(|| "ascending".to_string());
        if !matches!(order.as_str(), "ascending" | "descending") {
            return Err(".tablesort order 只认 ascending / descending".to_string());
        }
        let table = body_table(ev, call)?;
        if table[0].len() <= ci {
            return Err(format!(".tablesort 列 {} 越界", ci + 1));
        }
        let mut data: Vec<Vec<String>> = table[1..].to_vec();
        data.sort_by(|a, b| cmp_cells(a.get(ci).map(String::as_str).unwrap_or(""), b.get(ci).map(String::as_str).unwrap_or("")));
        if order == "descending" {
            data.reverse();
        }
        let mut out = vec![table[0].clone()];
        out.extend(data);
        Ok(Value::Markdown(pipe_table_md(&out)))
    });
    add_l(m, "tablefilter", &["pos:1", "filter"], |ev, call| {
        let ci = col_index(call, 0)?;
        let filter = pos(call, 1)?;
        let table = body_table(ev, call)?;
        if table[0].len() <= ci {
            return Err(format!(".tablefilter 列 {} 越界", ci + 1));
        }
        let mut out = vec![table[0].clone()];
        for row in &table[1..] {
            let cell = row.get(ci).cloned().unwrap_or_default();
            let hit = ev
                .call_lambda(filter, &[Value::Str(cell)], 0)
                .map_err(|()| ".tablefilter 条件求值失败".to_string())?;
            match hit.as_bool() {
                Some(true) => out.push(row.clone()),
                Some(false) => {}
                None => return Err(".tablefilter 条件必须返回布尔（yes / no）".to_string()),
            }
        }
        Ok(Value::Markdown(pipe_table_md(&out)))
    });
    add_l(m, "tablecompute", &["pos:1", "compute"], |ev, call| {
        let ci = col_index(call, 0)?;
        let compute = pos(call, 1)?;
        let table = body_table(ev, call)?;
        if table[0].len() <= ci {
            return Err(format!(".tablecompute 列 {} 越界", ci + 1));
        }
        // lambda 收整列（数据行）：`{.1::average::round}` 的 .1 即列值集合
        let cells: Vec<Value> = table[1..]
            .iter()
            .map(|r| Value::Str(r.get(ci).cloned().unwrap_or_default()))
            .collect();
        let result = ev
            .call_lambda(compute, &[Value::List(cells)], 0)
            .map_err(|()| ".tablecompute 计算失败".to_string())?;
        let mut out = table.clone();
        let mut new_row = vec![String::new(); table[0].len()];
        new_row[ci] = cell_to_md(&result.to_output());
        out.push(new_row);
        Ok(Value::Markdown(pipe_table_md(&out)))
    });
    add(m, "tablecolumn", |ev, call| {
        let ci = col_index(call, 0)?;
        let table = body_table(ev, call)?;
        if table[0].len() <= ci {
            return Err(format!(".tablecolumn 列 {} 越界", ci + 1));
        }
        // 数据行的该列单元格（不含表头）
        let cells: Vec<Value> = table[1..]
            .iter()
            .map(|r| Value::Str(r.get(ci).cloned().unwrap_or_default()))
            .collect();
        Ok(Value::List(cells))
    });
    add(m, "tablecolumns", |ev, call| {
        let table = body_table(ev, call)?;
        let cols = table[0].len();
        let out: Vec<Value> = (0..cols)
            .map(|ci| {
                Value::List(
                    table[1..]
                        .iter()
                        .map(|r| Value::Str(r.get(ci).cloned().unwrap_or_default()))
                        .collect(),
                )
            })
            .collect();
        Ok(Value::List(out))
    });
    add(m, "tablebyrows", |_, call| {
        // tablebyrows headers:{列表} rows:{列表}：行元素是列表按格拆，标量收成单格
        let headers = named_or_pos(call, "headers", 0)?
            .as_items()
            .ok_or_else(|| ".tablebyrows 的 headers: 必须是列表".to_string())?
            .iter()
            .map(|v| v.to_output())
            .collect::<Vec<_>>();
        let rows_v = named_or_pos(call, "rows", 1)?
            .as_items()
            .ok_or_else(|| ".tablebyrows 的 rows: 必须是列表".to_string())?;
        let mut rows = vec![headers];
        for v in rows_v {
            match v {
                Value::List(cells) => rows.push(cells.iter().map(|c| c.to_output()).collect()),
                other => rows.push(vec![other.to_output()]),
            }
        }
        Ok(Value::Markdown(pipe_table_md(&rows)))
    });
}

/// body 求值 → 文本（空 body → 空串）
fn body_md(ev: &mut Evaluator, call: &BuiltinCall) -> Result<String, String> {
    match &call.body {
        Some(b) if !b.is_empty() => match ev.eval_blocks(b) {
            Ok(v) => Ok(v.to_output()),
            Err(()) => Err(format!(".{} 内容求值失败", call.name)),
        },
        _ => Ok(String::new()),
    }
}

/// 引用块形态：可选加粗标题行 + 逐行 "> " 前缀（box / collapse / todo 的 Markdown 落点）
fn quote_block(title: Option<&str>, body: &str) -> String {
    let mut out = String::new();
    if let Some(t) = title {
        out.push_str(&format!("> **{}**\n", t));
    }
    for line in body.lines() {
        if line.is_empty() {
            out.push_str(">\n");
        } else {
            out.push_str(&format!("> {}\n", line));
        }
    }
    out.trim_end().to_string()
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

    fn diags(src: &str) -> usize {
        let blocks = parse_document(src);
        eval_document(&blocks, builtins(), None).1.len()
    }

    // —— Document ——

    #[test]
    fn 元数据函数无输出() {
        assert_eq!(out(".doclang {en}\n正文"), "正文");
        assert_eq!(diags(".doclang {en}"), 0);
        assert_eq!(diags(".footer\n    页脚文字"), 0);
        // 页码占位符
        assert_eq!(out("第 .currentpage 页 / 共 .totalpages 页"), "第 - 页 / 共 - 页");
    }

    #[test]
    fn 目录落成toc标记() {
        assert_eq!(out(".tableofcontents"), "[[toc]]");
    }

    // —— Layout ——

    #[test]
    fn 布局容器body平铺() {
        assert_eq!(out(".center\n    居中内容"), "居中内容");
        // 两个独立调用之间的空行按正文空行保留（run_document 的既有行为）
        assert_eq!(out(".row\n    第一格\n\n.column\n    第二格"), "第一格\n\n第二格");
    }

    #[test]
    fn box与collapse落成引用块() {
        assert_eq!(out(".box {注意}\n    盒内文字"), "> **注意**\n> 盒内文字");
        assert_eq!(out(".collapse {展开}\n    折叠内容"), "> **展开**\n> 折叠内容");
        assert_eq!(out(".todo\n    待办事项"), "> **TODO**\n> 待办事项");
        assert_eq!(out(".textcollapse {全文} short:{全…}"), "全文");
    }

    #[test]
    fn layout_table列拼接() {
        let src = [
            ".table",
            "    | 名称 | 数量 |",
            "    | --- | --- |",
            "    | 苹果 | 3 |",
            "",
            "    | 单价 |",
            "    | --- |",
            "    | 5 |",
        ]
        .join("\n");
        assert_eq!(out(&src), "| 名称 | 数量 | 单价 |\n| --- | --- | --- |\n| 苹果 | 3 | 5 |");
    }

    // —— TableComputation ——

    fn table_src(head: &str) -> String {
        [head, "    | 名称 | 分数 |", "    | --- | --- |", "    | bob | 85 |", "    | alice | 90 |"].join("\n")
    }

    #[test]
    fn tablesort按列排序() {
        assert_eq!(
            out(&table_src(".tablesort {2} order:{descending}")),
            "| 名称 | 分数 |\n| --- | --- |\n| alice | 90 |\n| bob | 85 |"
        );
        assert_eq!(
            out(&table_src(".tablesort {2}")),
            "| 名称 | 分数 |\n| --- | --- |\n| bob | 85 |\n| alice | 90 |"
        );
    }

    #[test]
    fn tablefilter按lambda过滤() {
        let src = [
            ".tablefilter {2} {x: .x::isgreater {86}}",
            "    | 名称 | 分数 |",
            "    | --- | --- |",
            "    | bob | 85 |",
            "    | alice | 90 |",
        ]
        .join("\n");
        assert_eq!(out(&src), "| 名称 | 分数 |\n| --- | --- |\n| alice | 90 |");
    }

    #[test]
    fn tablecompute列尾追加计算行() {
        let src = [
            ".tablecompute {2} {.1::average::round {0}}",
            "    | 名称 | 分数 |",
            "    | --- | --- |",
            "    | bob | 85 |",
            "    | alice | 90 |",
        ]
        .join("\n");
        assert_eq!(
            out(&src),
            "| 名称 | 分数 |\n| --- | --- |\n| bob | 85 |\n| alice | 90 |\n|  | 88 |"
        );
    }

    #[test]
    fn tablecolumn取列与tablebyrows建表() {
        let src = [".tablecolumn {1}", "    | 名称 | 分数 |", "    | --- | --- |", "    | bob | 85 |"].join("\n");
        assert_eq!(out(&src), "bob");
        // 列表实参走块变量（引擎的列表口径是 Markdown 列表文本）；标量行收成单格
        let src2 = [
            ".var {h}",
            "    - a",
            "    - b",
            "",
            ".var {r}",
            "    - 1",
            "    - 2",
            "",
            ".tablebyrows headers:{.h} rows:{.r}",
        ]
        .join("\n");
        assert_eq!(out(&src2), "| a | b |\n| --- | --- |\n| 1 |  |\n| 2 |  |");
    }

    #[test]
    fn 表操作错误降级() {
        // 没有表格的 body
        assert!(diags(".tablesort {1}\n    没有表格") >= 1);
        // 列号 0
        assert!(diags(&table_src(".tablesort {0}")) >= 1);
    }
}
