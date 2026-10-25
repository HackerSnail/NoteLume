// csv.rs —— RFC4180 口径的 CSV 解析（Data 模块 .csv 用，阶段 2 批 2）
//
// .csv 文件落成 Markdown 管道表格（Quarkdown 那边产出 Table AST 节点，本引擎输出文本，
// Markdown 表格是最近的等价形态）。首行是表头；短行补空单元格（与前端 csv-preview.js 同口径）。
// 引号单元格：成对引号内的逗号 / 换行 / 转义引号（"" → "）都算内容。

/// 解析为行 × 单元格矩阵
pub fn parse_csv(content: &str) -> Vec<Vec<String>> {
    let mut rows: Vec<Vec<String>> = Vec::new();
    let mut row: Vec<String> = Vec::new();
    let mut cell = String::new();
    let mut chars = content.chars().peekable();
    let mut in_quotes = false;
    let mut cell_started = false;

    while let Some(c) = chars.next() {
        if in_quotes {
            match c {
                '"' => {
                    if chars.peek() == Some(&'"') {
                        cell.push('"');
                        chars.next();
                    } else {
                        in_quotes = false;
                    }
                }
                c => cell.push(c),
            }
            continue;
        }
        match c {
            '"' if cell.is_empty() && !cell_started => {
                in_quotes = true;
                cell_started = true;
            }
            ',' => {
                row.push(std::mem::take(&mut cell));
                cell_started = false;
            }
            '\r' => {
                // CRLF：吃掉跟在后面的 \n
                if chars.peek() == Some(&'\n') {
                    chars.next();
                }
                row.push(std::mem::take(&mut cell));
                cell_started = false;
                rows.push(std::mem::take(&mut row));
            }
            '\n' => {
                row.push(std::mem::take(&mut cell));
                cell_started = false;
                rows.push(std::mem::take(&mut row));
            }
            c => {
                cell.push(c);
                cell_started = true;
            }
        }
    }
    // 末行无换行符：有内容或已有单元格都收尾
    if !cell.is_empty() || !row.is_empty() {
        row.push(cell);
        rows.push(row);
    }
    // 空内容不算一行
    rows.retain(|r| !(r.len() == 1 && r[0].is_empty()));
    rows
}

/// 单元格转 Markdown：竖线是列分隔符要转义，换行压成空格
pub fn cell_to_md(cell: &str) -> String {
    cell.replace('|', "\\|").replace('\r', " ").replace('\n', " ")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn 基本解析() {
        assert_eq!(parse_csv("a,b,c\n1,2,3"), vec![vec!["a", "b", "c"], vec!["1", "2", "3"]]);
    }

    #[test]
    fn 引号与转义() {
        assert_eq!(
            parse_csv("\"a,\"\"b\"\",c\",2"),
            vec![vec!["a,\"b\",c", "2"]]
        );
        assert_eq!(parse_csv("\"multi\nline\",x"), vec![vec!["multi\nline", "x"]]);
    }

    #[test]
    fn 短行与空行() {
        assert_eq!(parse_csv("a,b\n1"), vec![vec!["a", "b"], vec!["1"]]);
        assert!(parse_csv("").is_empty());
        assert_eq!(parse_csv("a\n\nb"), vec![vec!["a"], vec!["b"]]);
    }

    #[test]
    fn 单元格转md() {
        assert_eq!(cell_to_md("a|b"), "a\\|b");
        assert_eq!(cell_to_md("a\nb"), "a b");
    }
}
