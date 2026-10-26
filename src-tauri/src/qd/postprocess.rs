// postprocess.rs —— 求值产物的 Markdown 后处理（交叉引用 / 编号系统收口）
//
// Kotlin 侧这些机制活在 HTML 渲染层（LocationAwareLabelStorerHook 记位置、编号格式串
// 在渲染期展开），Markdown 输出引擎拿不到那个钩子，统一改成对最终产物的行级后处理：
//   · .numbering {headings: {1.1}} —— 标题编号：产物里数 `#` 深度逐级计数，编号前缀进标题文字；
//     figures / tables / 自定义 key 的格式串在各自计数点（figure_md / 表题注 / .numbered）生效
//   · 标题 {#id} —— 剥离属性、登记交叉引用账本（.ref {id} 解析）；`_` 表示仅编号不引用
//   · 装饰标题 `##!` —— 剥掉 `!`（Kotlin 语义：不编号、不进目录；无编号系统时与普通标题等价）
//   · 表格题注 —— 表格后一行 `"caption"` 或 `"caption" {#id}` 落 `*表 N. caption*`（figure 同口径）
//   · `$$$ … $$$` 多行公式块 → `$$ … $$`（KaTeX 管线只认两 dollar）
//   · 紧凑脚注 `[^label: 定义]` / `[^: 定义]` → 标准 `[^fn-N]` 引用 + 文末定义
//     （markdown-it-footnote 只认标准形态；同名 label 复用同一条定义，匿名各自独立）
//
// 全部行级变换都跳过围栏代码块；脚注扫描还跳过行内代码 span。项目惯例不引 regex crate，
// 匹配全部手写。

use std::collections::HashMap;

use super::eval::Evaluator;
use super::value::fmt_num;

// ============ 编号格式串（docs/numbering.qd）============

#[derive(Clone, Copy, Debug, PartialEq)]
enum Style {
    Dec,
    LowerAlpha,
    UpperAlpha,
    LowerRoman,
    UpperRoman,
}

#[derive(Debug, PartialEq)]
enum Sym {
    Counter(Style),
    Fixed(char),
}

/// 格式模板（NumberingFormat.kt 的符号列表）：计数符号 + 固定符号任意交错，
/// `"1.A.a"` → [Counter(Dec), Fixed('.'), Counter(Alpha), Fixed('.'), Counter(Alpha)]。
/// 层级值由计数符号按序消费；超出取值范围的层级值（如层级跳跃补的 0）落十进制字面量。
#[derive(Debug, PartialEq)]
pub(crate) struct NumTpl {
    syms: Vec<Sym>,
}

impl NumTpl {
    /// 计数符号数 = 模板能覆盖的层级数（Kotlin 的 accuracy）
    fn accuracy(&self) -> usize {
        self.syms.iter().filter(|s| matches!(s, Sym::Counter(_))).count()
    }
}

pub(crate) fn parse_tpl(s: &str) -> Option<NumTpl> {
    let mut syms: Vec<Sym> = Vec::new();
    let mut esc = false;
    for c in s.chars() {
        if esc {
            syms.push(Sym::Fixed(c));
            esc = false;
            continue;
        }
        if c == '\\' {
            esc = true;
            continue;
        }
        let st = match c {
            '1' => Some(Style::Dec),
            'a' => Some(Style::LowerAlpha),
            'A' => Some(Style::UpperAlpha),
            'i' => Some(Style::LowerRoman),
            'I' => Some(Style::UpperRoman),
            _ => None,
        };
        syms.push(match st {
            Some(st) => Sym::Counter(st),
            None => Sym::Fixed(c),
        });
    }
    if !syms.iter().any(|s| matches!(s, Sym::Counter(_))) {
        return None; // 无计数符号的模板没有编号语义
    }
    Some(NumTpl { syms })
}

impl NumTpl {
    /// nums = 各层计数值（depth = nums.len()），Kotlin NumberingFormat.format 同款：
    /// 层级值被计数符号逐个消费；层级耗尽且 accuracy ≠ depth 时截断（尾部固定符号丢弃，
    /// depth == accuracy 时才完整输出——"(1.1)" 配单层值出 "(1" 是 Kotlin 的已知行为）。
    /// 层级深度超过 accuracy 的判定在调用方（标题趟：Kotlin 传 allowMismatchingLength=false）。
    pub fn render(&self, nums: &[usize]) -> String {
        let accuracy = self.accuracy();
        let depth = nums.len();
        let mut out = String::new();
        let mut idx = 0usize;
        for sym in &self.syms {
            if idx >= depth && accuracy != depth {
                break;
            }
            match sym {
                Sym::Fixed(c) => out.push(*c),
                Sym::Counter(st) => {
                    let n = nums[idx];
                    idx += 1;
                    out.push_str(&fmt_styled(n, *st));
                }
            }
        }
        out
    }
}

fn fmt_styled(n: usize, st: Style) -> String {
    match st {
        Style::Dec => n.to_string(),
        Style::LowerAlpha => alpha(n, false).unwrap_or_else(|| n.to_string()),
        Style::UpperAlpha => alpha(n, true).unwrap_or_else(|| n.to_string()),
        Style::LowerRoman => roman(n).map(|s| s.to_lowercase()).unwrap_or_else(|| n.to_string()),
        Style::UpperRoman => roman(n).unwrap_or_else(|| n.to_string()),
    }
}

/// 1–26 → a–z；0 与越界回落 None（Kotlin 落十进制字面量，层级跳跃补的 0 就走这条）
fn alpha(n: usize, upper: bool) -> Option<String> {
    if n == 0 || n > 26 {
        return None;
    }
    let c = (b'a' + (n - 1) as u8) as char;
    Some(if upper { c.to_ascii_uppercase().to_string() } else { c.to_string() })
}

fn roman(n: usize) -> Option<String> {
    if n == 0 || n > 3999 {
        return None;
    }
    const TABLE: &[(&str, usize)] = &[
        ("M", 1000), ("CM", 900), ("D", 500), ("CD", 400), ("C", 100), ("XC", 90),
        ("L", 50), ("XL", 40), ("X", 10), ("IX", 9), ("V", 5), ("IV", 4), ("I", 1),
    ];
    let mut n = n;
    let mut s = String::new();
    for (sym, val) in TABLE {
        while n >= *val {
            s.push_str(sym);
            n -= val;
        }
    }
    Some(s)
}

/// 计数器值 → 文本：numbering 登记了该 key 的格式串就按模板渲染（单层），否则十进制。
/// figure / .numbered 各计数点共用。
pub(crate) fn format_counter(ev: &Evaluator, key: &str, n: usize) -> String {
    if !ev.numbering_off {
        if let Some(tpl) = ev.numbering.get(key).and_then(|s| parse_tpl(s)) {
            return tpl.render(&[n]);
        }
    }
    fmt_num(n as f64)
}

// ============ 出口后处理 ============

pub fn run(ev: &mut Evaluator, out: &mut String) {
    table_captions(ev, out);
    headings(ev, out);
    math_blocks(out);
    footnotes(out);
}

/// 按行跑变换，围栏代码块内跳过。f 返回 Some(替换行) 或 None（保持原行）。
fn map_lines(out: &str, mut f: impl FnMut(&str) -> Option<String>) -> String {
    let mut in_fence = false;
    let mut mark = ' ';
    let mut result: Vec<String> = Vec::with_capacity(out.len());
    for l in out.split('\n') {
        let t = l.trim_start();
        if t.starts_with("```") || t.starts_with("~~~") {
            let c = t.chars().next().unwrap();
            if !in_fence {
                in_fence = true;
                mark = c;
            } else if c == mark {
                in_fence = false;
            }
            result.push(l.to_string());
            continue;
        }
        if in_fence {
            result.push(l.to_string());
            continue;
        }
        match f(l) {
            Some(nl) => result.push(nl),
            None => result.push(l.to_string()),
        }
    }
    result.join("\n")
}

// ---- 表格题注（docs/cross-references.qd：表格后一行 "caption" / "caption" {#id}）----

fn table_captions(ev: &mut Evaluator, out: &mut String) {
    let mut prev_table = false;
    let mut to_register: Vec<(String, String)> = Vec::new();
    let result = map_lines(out, |l| {
        let t = l.trim();
        if prev_table {
            if let Some((caption, id)) = parse_table_caption(t) {
                prev_table = false;
                ev.tables += 1;
                let label = format_counter(ev, "tables", ev.tables);
                let name = super::localization::localize_or(ev, "std", "table", "Table");
                if let Some(id) = id {
                    if id != "_" {
                        to_register.push((id, label.clone()));
                    }
                }
                return Some(format!("*{} {}. {}*", name, label, caption));
            }
        }
        prev_table = t.starts_with('|');
        None
    });
    ev.numbered.extend(to_register);
    *out = result;
}

/// `"caption"` 或 `"caption" {#id}` → (题注, id)。rest 不是合法 {#id} 后缀就不当题注行。
fn parse_table_caption(t: &str) -> Option<(String, Option<String>)> {
    if !t.starts_with('"') {
        return None;
    }
    let close = t[1..].find('"')? + 1;
    let caption = t[1..close].trim().to_string();
    if caption.is_empty() {
        return None;
    }
    let rest = t[close + 1..].trim();
    if rest.is_empty() {
        return Some((caption, None));
    }
    parse_ref_id(rest).map(|id| (caption, Some(id)))
}

/// `{#id}` → id。id 只认字母数字与 _ -；`_` 是 Kotlin 的「仅编号不引用」标记，原样返回由调用方过滤。
fn parse_ref_id(s: &str) -> Option<String> {
    let inner = s.strip_prefix('{')?.strip_suffix('}')?;
    let id = inner.strip_prefix('#')?;
    if !id.is_empty() && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '_' || c == '-') {
        Some(id.to_string())
    } else {
        None
    }
}

// ---- 标题：{#id} 剥离 + 装饰 `#!` + .numbering 编号 ----

fn headings(ev: &mut Evaluator, out: &mut String) {
    let mut counters = [0usize; 7];
    let heading_tpl = if ev.numbering_off {
        None
    } else {
        ev.numbering.get("headings").and_then(|s| parse_tpl(s))
    };
    let mut to_register: Vec<(String, String)> = Vec::new();
    let result = map_lines(out, |l| {
        let (level, decorative, mut text) = parse_heading(l)?;
        let id = take_trailing_id(&mut text);
        if decorative {
            // 不编号、不进目录；`!` 剥掉后与普通标题等价
            let line = format!("{} {}", "#".repeat(level), text);
            if let Some(id) = &id {
                if id != "_" {
                    to_register.push((id.clone(), text.clone()));
                }
            }
            return Some(line);
        }
        if let Some(tpl) = &heading_tpl {
            // 深度超过模板层数（accuracy）：Kotlin 不编号（allowMismatchingLength=false，
            // docs/numbering.qd Headings 的 ##### → None 同款）
            if level <= tpl.accuracy() {
                counters[level] += 1;
                for c in counters.iter_mut().skip(level + 1) {
                    *c = 0;
                }
                let nums: Vec<usize> = (1..=level).map(|i| counters[i]).collect();
                let label = tpl.render(&nums);
                if let Some(id) = &id {
                    if id != "_" {
                        to_register.push((id.clone(), label.clone()));
                    }
                }
                return Some(format!("{} {} {}", "#".repeat(level), label, text));
            }
        }
        if let Some(id) = &id {
            if id != "_" {
                to_register.push((id.clone(), text.clone()));
            }
            return Some(format!("{} {}", "#".repeat(level), text));
        }
        None
    });
    ev.numbered.extend(to_register);
    *out = result;
}

/// `#{1,6}` + 可选 `!` + 空白 + 标题文字。行首才认（`> # x` 与 `#tag` 不算标题）。
fn parse_heading(l: &str) -> Option<(usize, bool, String)> {
    let hashes = l.chars().take_while(|&c| c == '#').count();
    if hashes == 0 || hashes > 6 {
        return None;
    }
    let rest = &l[hashes..];
    let (decorative, rest) = match rest.strip_prefix('!') {
        Some(r) => (true, r),
        None => (false, rest),
    };
    if !rest.starts_with(' ') && !rest.starts_with('\t') {
        return None;
    }
    let text = rest.trim().to_string();
    if text.is_empty() {
        return None;
    }
    Some((hashes, decorative, text))
}

/// 摘掉行尾的 `{#id}` 属性，返回 id。
fn take_trailing_id(text: &mut String) -> Option<String> {
    let t = text.trim_end();
    if !t.ends_with('}') {
        return None;
    }
    let open = t.rfind('{')?;
    let id = parse_ref_id(&t[open..])?;
    *text = t[..open].trim_end().to_string();
    Some(id)
}

// ---- `$$$ … $$$` 多行公式块 → `$$ … $$` ----

fn math_blocks(out: &mut String) {
    *out = map_lines(out, |l| {
        if l.trim() == "$$$" {
            Some("$$".to_string())
        } else {
            None
        }
    });
}

// ---- 紧凑脚注（docs/footnotes.qd）----

fn footnotes(out: &mut String) {
    let mut ids: HashMap<String, String> = HashMap::new();
    let mut seq = 0usize;
    let mut defs: Vec<String> = Vec::new();
    let mut in_fence = false;
    let mut mark = ' ';
    let mut result: Vec<String> = Vec::new();
    for l in out.split('\n') {
        let t = l.trim_start();
        if t.starts_with("```") || t.starts_with("~~~") {
            let c = t.chars().next().unwrap();
            if !in_fence {
                in_fence = true;
                mark = c;
            } else if c == mark {
                in_fence = false;
            }
            result.push(l.to_string());
            continue;
        }
        if in_fence {
            result.push(l.to_string());
            continue;
        }
        result.push(outside_inline_code(l, |seg| rewrite_compact_footnote(seg, &mut ids, &mut seq, &mut defs)));
    }
    let mut joined = result.join("\n");
    if !defs.is_empty() {
        let trimmed = joined.trim_end();
        joined = format!("{}\n\n{}", trimmed, defs.join("\n"));
    }
    *out = joined;
}

/// 行内代码 span（`…`、`` `..` `` 双反引号同口径）之外才跑 f
fn outside_inline_code(line: &str, mut f: impl FnMut(&str) -> String) -> String {
    let chars: Vec<char> = line.chars().collect();
    let mut out = String::new();
    let mut seg = String::new();
    let mut i = 0;
    while i < chars.len() {
        if chars[i] == '`' {
            let run = chars[i..].iter().take_while(|&&c| c == '`').count();
            if let Some(end) = find_run(&chars, i + run, run) {
                out.push_str(&f(&seg));
                seg.clear();
                out.extend(&chars[i..end + run]);
                i = end + run;
                continue;
            }
        }
        seg.push(chars[i]);
        i += 1;
    }
    out.push_str(&f(&seg));
    out
}

/// 从 from 起找长度恰好 len 的反引号串起点
fn find_run(chars: &[char], from: usize, len: usize) -> Option<usize> {
    let mut i = from;
    while i + len <= chars.len() {
        if chars[i] == '`' {
            let r = chars[i..].iter().take_while(|&&c| c == '`').count();
            if r == len {
                return Some(i);
            }
            i += r;
        } else {
            i += 1;
        }
    }
    None
}

/// `[^label: 定义]` → `[^fn-N]`（同名 label 复用同号同定义）；`[^: 定义]` 每处独立成注
fn rewrite_compact_footnote(
    seg: &str,
    ids: &mut HashMap<String, String>,
    seq: &mut usize,
    defs: &mut Vec<String>,
) -> String {
    let mut out = String::new();
    let mut rest = seg;
    while let Some(p) = rest.find("[^") {
        let after = &rest[p + 2..];
        let colon = after.find(':');
        let close = after.find(']');
        match (colon, close) {
            (Some(ci), Some(bi)) if ci < bi => {
                let label = after[..ci].trim();
                let def = after[ci + 1..bi].trim();
                if label.contains(' ') || label.contains('\t') {
                    // 带空格不是紧凑脚注的 label 形态，按普通文本放过
                    out.push_str(&rest[..p + 2]);
                    rest = after;
                    continue;
                }
                let (id, is_new) = if label.is_empty() {
                    *seq += 1;
                    (format!("fn-auto-{}", seq), true)
                } else {
                    match ids.get(label) {
                        Some(v) => (v.clone(), false),
                        None => {
                            *seq += 1;
                            let id = format!("fn-auto-{}", seq);
                            ids.insert(label.to_string(), id.clone());
                            (id, true)
                        }
                    }
                };
                if is_new {
                    defs.push(format!("[^{}]: {}", id, def));
                }
                out.push_str(&rest[..p]);
                out.push_str(&format!("[^{}]", id));
                rest = &after[bi + 1..];
            }
            _ => {
                out.push_str(&rest[..p + 2]);
                rest = after;
            }
        }
    }
    out.push_str(rest);
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use super::super::eval::eval_document;
    use super::super::parser::parse_document;
    use super::super::stdlib::builtins;

    fn out(src: &str) -> String {
        let blocks = parse_document(src);
        eval_document(&blocks, builtins(), None).0
    }

    #[test]
    fn 格式串_模板解析与渲染() {
        let tpl = parse_tpl("1.1").unwrap();
        assert_eq!(tpl.render(&[1, 1]), "1.1");
        assert_eq!(tpl.render(&[1, 2]), "1.2");
        // 层级值多于模板：截断到模板长度（Kotlin 同款，多余层级由标题趟的深度守门拦下）
        assert_eq!(tpl.render(&[1, 1, 3]), "1.1");
        // 层级值少于模板：尾部固定符号丢弃；depth == accuracy 才完整输出
        // （"(1.1)" 配单层值出 "(1" 是 Kotlin format() 的已知行为，照抄）
        assert_eq!(parse_tpl("(1.1)").unwrap().render(&[1]), "(1");
        let tpl = parse_tpl("(1)").unwrap();
        assert_eq!(tpl.render(&[3]), "(3)");
        let tpl = parse_tpl("1.A.a").unwrap();
        assert_eq!(tpl.render(&[2, 3, 4]), "2.C.d");
        // 越界层级值（层级跳跃补的 0）落十进制字面量
        assert_eq!(parse_tpl("1.A.a").unwrap().render(&[1, 0, 2]), "1.0.b");
        assert_eq!(parse_tpl("普通文本"), None);
    }

    #[test]
    fn 标题编号_数字与字母混排() {
        let src = ".numbering\n    - headings: 1.A\n\n# 章\n\n## 节一\n\n## 节二\n\n### 小节";
        // 深度超过模板层数：Kotlin 不编号（##### → None 同款）
        assert_eq!(out(src), "# 1 章\n\n## 1.A 节一\n\n## 1.B 节二\n\n### 小节");
    }

    #[test]
    fn 标题编号_层级跳跃补零() {
        // H1 后直接 H3：Kotlin 给缺的 H2 补 0（quarkdown-test NumberingTest 的 B/0/1 同款）
        let src = ".numbering\n    - headings: 1.1.1\n\n# 章\n\n### 小节";
        assert_eq!(out(src), "# 1 章\n\n### 1.0.1 小节");
    }

    #[test]
    fn 标题编号_同层复位与罗马数字() {
        let src = ".numbering\n    - headings: I.i\n\n# 一\n\n## 甲\n\n## 乙\n\n# 二\n\n## 丙";
        assert_eq!(out(src), "# I 一\n\n## I.i 甲\n\n## I.ii 乙\n\n# II 二\n\n## II.i 丙");
    }

    #[test]
    fn 装饰标题_剥叹号不编号() {
        let src = ".numbering\n    - headings: 1.1\n\n# 正常\n\n#! 装饰\n\n## 儿子";
        assert_eq!(out(src), "# 1 正常\n\n# 装饰\n\n## 1.1 儿子");
    }

    #[test]
    fn 标题ref_登记账本供ref解析() {
        let src = "## 背景 {#intro}\n\n见 .ref {intro}";
        assert!(out(src).contains("见 背景"));
        assert!(!out(src).contains("{#intro}"));
        // 编号开启时引用出编号
        let src2 = ".numbering\n    - headings: 1.1\n\n# 章 {#intro}\n\n见 .ref {intro}";
        assert!(out(src2).contains("见 1"));
        // {#_} 仅编号不引用
        let src3 = "## 背景 {#_}\n\n见 .ref {_}";
        assert!(out(src3).contains("[???]"));
    }

    #[test]
    fn heading原语_ref落属性形态() {
        let src = ".heading {2} ref:{sec}\n    标题\n\n见 .ref {sec}";
        assert!(out(src).contains("见 标题"));
        assert!(!out(src).contains("{#sec}"));
    }

    #[test]
    fn 表格题注_落斜体行并进账本() {
        let src = "| a | b |\n| - | - |\n| 1 | 2 |\n\"说明文字\" {#tbl}\n\n见 .ref {tbl}";
        let o = out(src);
        assert!(o.contains("*Table 1. 说明文字*"), "{}", o);
        assert!(o.contains("见 1"));
    }

    #[test]
    fn 表格题注_编号格式串生效() {
        let src = ".numbering\n    - tables: (1)\n\n| a |\n| - |\n| 1 |\n\"题\"";
        assert!(out(src).contains("*Table (1). 题*"), "{}", out(src));
    }

    #[test]
    fn 非表格后的引号行不动() {
        let src = "前文\n\n\"普通引用\" 不动";
        assert_eq!(out(src), src);
    }

    #[test]
    fn 多行公式块_三美元换两美元() {
        let src = "$$$\na + b\n$$$";
        assert_eq!(out(src), "$$\na + b\n$$");
        // 围栏里不动
        let src2 = "```\n$$$\n```";
        assert_eq!(out(src2), src2);
    }

    #[test]
    fn 紧凑脚注_改写标准形态() {
        let src = "正文[^n1: 第一条] 继续[^: 匿名] 再引[^n1: 第一条]";
        let o = out(src);
        assert!(o.contains("正文[^fn-auto-1] 继续[^fn-auto-2] 再引[^fn-auto-1]"), "{}", o);
        assert!(o.contains("[^fn-auto-1]: 第一条"), "{}", o);
        // 同名 label 只落一条定义
        assert_eq!(o.matches("[^fn-auto-1]:").count(), 1);
        assert!(o.contains("[^fn-auto-2]: 匿名"), "{}", o);
    }

    #[test]
    fn 紧凑脚注_行内代码与标准形态不受影响() {
        let src = "代码 `[^x: 不动]` 与标准 [^1]\n\n[^1]: 定义";
        assert_eq!(out(src), src);
    }

    #[test]
    fn number格式串_作用于numbered() {
        let src = ".numbering\n    - eq: (1)\n\n.numbered {eq}\n\n.numbered {eq}";
        assert_eq!(out(src), "(1)\n\n(2)");
    }

    #[test]
    fn 非numbering_关闭() {
        let src = ".numbering\n    - headings: 1\n\n.nonumbering\n\n# 标题";
        assert_eq!(out(src), "# 标题");
    }

    #[test]
    fn numbering_默认合并与merge_no清空() {
        // 默认合并：两次 .numbering 的条目都生效
        let src = ".numbering\n    - headings: (1)\n\n.numbering\n    - figures: 1\n\n# 章";
        assert_eq!(out(src), "# (1) 章");
        // merge:{no}：未指定条目全部关闭
        let src2 = ".numbering\n    - headings: 1\n\n.numbering merge:{no}\n    - figures: 1\n\n# 章";
        assert_eq!(out(src2), "# 章");
    }

    #[test]
    fn 围栏里的标题与题注不处理() {
        let src = "```\n# 不编号 {#x}\n```\n\n见 .ref {x}";
        let o = out(src);
        assert!(o.contains("# 不编号 {#x}"), "{}", o);
        assert!(o.contains("[???]"), "{}", o);
    }
}
