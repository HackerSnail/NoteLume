// mdtable.rs —— Markdown 管道表格的解析与序列化（阶段 2 批 3）
//
// TableComputation（tablesort / tablefilter / tablecompute / tablecolumn(s) / tablebyrows）
// 与 Layout 的 `.table`（子表列拼接）都以「管道表 → 单元格矩阵 → 管道表」的方式在文本层操作，
// 对应 Kotlin 侧 findTable + Table AST 的那一段。口径：
//  · 表 = 一段连续的行，每行 trim 后以 `|` 开头；第二行是分隔行（`---`）才算表，否则不算
//  · 单元格 `\|` 还原为 `|`；序列化时反向转义
//  · 列号一律 1 起始（对齐 Quarkdown 的 getat / withindices 口径）

/// 从行序列里取第一张管道表（表头 + 数据行，分隔行剔除）；没有表返回 None
pub fn parse_pipe_rows(lines: &[&str]) -> Option<Vec<Vec<String>>> {
    let mut i = 0;
    while i < lines.len() {
        if is_pipe_row(lines[i]) {
            // 候选表：本行 + 下一行必须是分隔行
            if i + 1 < lines.len() && is_separator_row(lines[i + 1]) {
                let mut rows = vec![parse_row(lines[i])];
                i += 2;
                while i < lines.len() && is_pipe_row(lines[i]) {
                    rows.push(parse_row(lines[i]));
                    i += 1;
                }
                return Some(rows);
            }
        }
        i += 1;
    }
    None
}

fn is_pipe_row(line: &str) -> bool {
    line.trim_start().starts_with('|')
}

fn is_separator_row(line: &str) -> bool {
    let t = line.trim();
    t.starts_with('|') && t.contains('-') && t.chars().all(|c| c == '|' || c == '-' || c == ':' || c.is_whitespace())
}

/// 单行 → 单元格：去首尾 `|` 后按「未转义的 `|`」切（`\|` 是内容，不切）
fn parse_row(line: &str) -> Vec<String> {
    let t = line.trim();
    let inner = t.strip_prefix('|').unwrap_or(t);
    let inner = inner.strip_suffix('|').unwrap_or(inner);
    let mut cells: Vec<String> = Vec::new();
    let mut cur = String::new();
    let mut chars = inner.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '\\' && chars.peek() == Some(&'|') {
            cur.push('|');
            chars.next();
        } else if c == '|' {
            cells.push(cur.trim().to_string());
            cur = String::new();
        } else {
            cur.push(c);
        }
    }
    cells.push(cur.trim().to_string());
    cells
}

/// 单元格 → md：`|` 转义（与 csv.rs 的 cell_to_md 同口径，这里独立实现避免模块倒挂）
pub fn cell_to_md(cell: &str) -> String {
    cell.replace('|', "\\|").replace('\r', " ").replace('\n', " ")
}

/// 单元格矩阵 → 管道表（首行表头 + 分隔行 + 数据行）
pub fn pipe_table_md(rows: &[Vec<String>]) -> String {
    let cols = rows.iter().map(|r| r.len()).max().unwrap_or(0);
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
            let cell = row.get(c).map(String::as_str).unwrap_or("");
            out.push_str(&format!(" {} |", cell_to_md(cell)));
        }
        out.push('\n');
    }
    out.trim_end().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 取首表并剔除分隔行() {
        let lines = ["前言", "", "| a | b |", "| --- | --- |", "| 1 | 2 |", "| 3 | 4 |", "尾文"];
        assert_eq!(
            parse_pipe_rows(&lines),
            Some(vec![vec!["a".into(), "b".into()], vec!["1".into(), "2".into()], vec!["3".into(), "4".into()]])
        );
    }

    #[test]
    fn 无表与无分隔行() {
        assert_eq!(parse_pipe_rows(&["| a | b |"]), None); // 缺分隔行
        assert_eq!(parse_pipe_rows(&["普通行"]), None);
    }

    #[test]
    fn 转义还原与序列化() {
        let rows = vec![vec!["a|b".into(), "c".into()], vec!["x".into(), "y".into()]];
        let md = pipe_table_md(&rows);
        assert_eq!(md, "| a\\|b | c |\n| --- | --- |\n| x | y |");
        let back = parse_pipe_rows(&md.lines().collect::<Vec<_>>()).unwrap();
        assert_eq!(back, rows);
    }
}
