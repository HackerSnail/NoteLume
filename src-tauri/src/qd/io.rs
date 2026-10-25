// io.rs —— Data 模块的文件系统访问（阶段 2 批 2）
//
// 工作目录 = qd_eval 传入的文档所在目录（doc_dir）。未传（画布 / 未落盘文档）时 IO 函数
// 在 stdlib 层诊断降级，这里只管路径解析与读取。
// 路径口径：只认相对工作目录的相对路径。绝对路径、`..` 越出工作目录一律拒绝——
// 打开来路不明的 qd 文档不许借 .read / .listfiles 探测库外文件，与 webclip 的
// vault_join + canonicalize 校验同一思路。canonicalize 同时把符号链接解到真实位置。

use std::path::{Path, PathBuf};

pub struct QdIo {
    pub doc_dir: Option<PathBuf>,
}

impl QdIo {
    pub fn new(doc_dir: Option<PathBuf>) -> Self {
        QdIo { doc_dir }
    }

    fn base(&self) -> Result<&Path, String> {
        self.doc_dir.as_deref().ok_or_else(|| "没有工作目录（文档未落盘），文件类函数不可用".to_string())
    }

    /// 相对路径 → 工作目录内的绝对路径（canonicalize 过，存在才通过）
    pub fn resolve(&self, path: &str) -> Result<PathBuf, String> {
        let base = self.base()?;
        let trimmed = path.trim();
        if trimmed.is_empty() {
            return Err("路径为空".to_string());
        }
        if Path::new(trimmed).is_absolute() {
            return Err(format!("只允许相对工作目录的路径: {}", trimmed));
        }
        let canon_base = base.canonicalize().map_err(|e| format!("工作目录不可用: {}", e))?;
        let canon = Path::new(base).join(trimmed).canonicalize().map_err(|_| format!("路径不存在: {}", trimmed))?;
        if !canon.starts_with(&canon_base) {
            return Err(format!("路径越出工作目录: {}", trimmed));
        }
        Ok(canon)
    }

    pub fn read_text(&self, path: &str) -> Result<String, String> {
        let p = self.resolve(path)?;
        std::fs::read_to_string(p).map_err(|e| format!("读取失败: {}", e))
    }

    /// 列目录；recursive 时深度优先走完整个子树（符号链接目录不跟进，防环）
    pub fn list(&self, path: &str, recursive: bool) -> Result<Vec<PathBuf>, String> {
        let root = self.resolve(path)?;
        if !root.is_dir() {
            return Err(format!("不是目录: {}", path.trim()));
        }
        let mut out = Vec::new();
        let mut stack = vec![root];
        while let Some(dir) = stack.pop() {
            let entries = std::fs::read_dir(&dir).map_err(|e| format!("列目录失败: {}", e))?;
            for entry in entries.flatten() {
                let p = entry.path();
                if p.is_dir() {
                    if recursive && !is_symlink_dir(&p) {
                        stack.push(p.clone());
                    }
                    out.push(p);
                } else {
                    out.push(p);
                }
            }
        }
        Ok(out)
    }

    pub fn modified_millis(&self, p: &Path) -> Result<u128, String> {
        p.metadata()
            .and_then(|m| m.modified())
            .map_err(|e| format!("取修改时间失败: {}", e))
            .and_then(|t| {
                t.duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_millis())
                    .map_err(|e| format!("取修改时间失败: {}", e))
            })
    }
}

fn is_symlink_dir(p: &Path) -> bool {
    p.symlink_metadata().map(|m| m.file_type().is_symlink()).unwrap_or(false) && p.is_dir()
}

/// 迷你正则（`listfiles` 的 pattern 参数用，不引 regex crate，项目惯例手写）：
/// 支持字面量、`.`、`*` `+` `?`、`[]` 字符类（`^` 取反、`a-z` 范围）、`^` `$` 锚、`|` 分支、
/// `()` 分组、`\` 转义。unanchored：pattern 不必匹配整串（Kotlin Regex 的 find 语义）。
/// 回溯深度超 10_000 判不匹配（防构造串卡死）；pattern 512 字符、文本 64KB 封顶。
pub fn regex_search(pattern: &str, text: &str) -> Result<bool, String> {
    if pattern.len() > 512 || text.len() > 64 * 1024 {
        return Err("pattern 或文件名过长".to_string());
    }
    let chars: Vec<char> = pattern.chars().collect();
    let (node, rest) = parse_alt(&chars).ok_or_else(|| "pattern 语法错误".to_string())?;
    if !rest.is_empty() {
        return Err("pattern 语法错误（括号不配平）".to_string());
    }
    let text_chars: Vec<char> = text.chars().collect();
    for start in 0..=text_chars.len() {
        let m = Matcher { text: &text_chars };
        if m.match_node(&node, start, 0, &mut |_, _| true) {
            return Ok(true);
        }
    }
    Ok(false)
}

/// 正则替换（`match` 函数用）：从左到右逐个匹配，命中区间交给 repl 生成替换文本。
/// 语义对齐 Kotlin Regex.replace 的常用口径：最左优先、同一位置取首个成功终点（贪心）；
/// 零宽匹配不吃字符、原地跳过一个字符防死循环。pattern 沿用 listfiles 的迷你正则子集。
pub fn regex_replace(pattern: &str, text: &str, repl: &mut dyn FnMut(&str) -> String) -> Result<String, String> {
    if pattern.len() > 512 || text.len() > 64 * 1024 {
        return Err("pattern 或文本过长".to_string());
    }
    if pattern.is_empty() {
        return Ok(text.to_string());
    }
    let chars: Vec<char> = pattern.chars().collect();
    let (node, rest) = parse_alt(&chars).ok_or_else(|| "pattern 语法错误".to_string())?;
    if !rest.is_empty() {
        return Err("pattern 语法错误（括号不配平）".to_string());
    }
    let t: Vec<char> = text.chars().collect();
    let mut out = String::with_capacity(text.len());
    let mut pos = 0usize;
    let mut matches = 0usize;
    while pos <= t.len() {
        if matches >= 1000 {
            break; // 匹配数封顶，防构造串卡死
        }
        // 最左起点 + 该起点的首个成功终点
        let mut found: Option<(usize, usize)> = None;
        for start in pos..=t.len() {
            let m = Matcher { text: &t };
            let mut end_pos: Option<usize> = None;
            if m.match_node(&node, start, 0, &mut |e, _| {
                if end_pos.is_none() {
                    end_pos = Some(e);
                }
                true
            }) {
                if let Some(e) = end_pos {
                    found = Some((start, e));
                    break;
                }
            }
        }
        match found {
            None => break,
            Some((s, e)) => {
                matches += 1;
                if e == s {
                    // 零宽匹配：替换文本照出（Java/Kotlin replaceAll 同款），再吃一个字符防原地空转
                    let matched: String = t[s..e].iter().collect();
                    out.push_str(&repl(&matched));
                    if let Some(c) = t.get(s) {
                        out.push(*c);
                    }
                    pos = s + 1;
                    continue;
                }
                out.extend(&t[pos..s]);
                let matched: String = t[s..e].iter().collect();
                out.push_str(&repl(&matched));
                pos = e;
            }
        }
    }
    if pos < t.len() {
        out.extend(&t[pos..]);
    }
    Ok(out)
}

#[derive(Debug, Clone)]
enum Node {
    Empty,
    Seq(Vec<Node>),
    Alt(Box<Node>, Box<Node>),
    Char(char),
    AnyChar,
    Class { neg: bool, items: Vec<ClassItem> },
    Star(Box<Node>),
    Plus(Box<Node>),
    Opt(Box<Node>),
    StartAnchor,
    EndAnchor,
}

#[derive(Debug, Clone)]
enum ClassItem {
    Single(char),
    Range(char, char),
}

struct Matcher<'a> {
    text: &'a [char],
}

impl<'a> Matcher<'a> {
    /// node 从 pos 匹配，成功时把（终点位置，深度）交给续延 k；k 返回真 = 整体匹配成立。
    /// CPS 让 Star / Alt 的回溯自然工作：k 失败就试 node 的下一个可能。
    fn match_node(&self, node: &Node, pos: usize, depth: usize, k: &mut dyn FnMut(usize, usize) -> bool) -> bool {
        if depth > 10_000 {
            return false;
        }
        match node {
            Node::Empty => k(pos, depth),
            Node::Seq(items) => self.match_items(items, 0, pos, depth, k),
            Node::Alt(a, b) => {
                self.match_node(a, pos, depth + 1, k) || self.match_node(b, pos, depth + 1, k)
            }
            Node::Char(c) => match self.text.get(pos) {
                Some(t) if t == c => k(pos + 1, depth),
                _ => false,
            },
            Node::AnyChar => match self.text.get(pos) {
                Some(t) if *t != '\n' => k(pos + 1, depth),
                _ => false,
            },
            Node::Class { neg, items } => match self.text.get(pos) {
                Some(t) if *t != '\n' => {
                    let hit = items.iter().any(|it| match it {
                        ClassItem::Single(c) => c == t,
                        ClassItem::Range(a, b) => (*a..=*b).contains(t),
                    });
                    if hit != *neg {
                        k(pos + 1, depth)
                    } else {
                        false
                    }
                }
                _ => false,
            },
            Node::Star(inner) => self.match_star(inner, pos, depth, k),
            Node::Plus(inner) => self.match_node(inner, pos, depth + 1, &mut |p, d| {
                // 至少一次：先吃一遍，剩下的交给星号语义。零宽匹配不再重复（防死循环），
                // 直接把续延交给终点。
                if p > pos {
                    self.match_star(inner, p, d, k)
                } else {
                    k(p, d)
                }
            }),
            Node::Opt(inner) => {
                self.match_node(inner, pos, depth + 1, k) || k(pos, depth)
            }
            Node::StartAnchor => {
                if pos == 0 {
                    k(pos, depth)
                } else {
                    false
                }
            }
            Node::EndAnchor => {
                if pos == self.text.len() {
                    k(pos, depth)
                } else {
                    false
                }
            }
        }
    }

    /// items[i..] 从 pos 接续匹配，末段接 k
    fn match_items(&self, items: &[Node], i: usize, pos: usize, depth: usize, k: &mut dyn FnMut(usize, usize) -> bool) -> bool {
        match items.get(i) {
            None => k(pos, depth),
            Some(n) => {
                let mut ok = false;
                self.match_node(n, pos, depth + 1, &mut |p, d| {
                    if self.match_items(items, i + 1, p, d, k) {
                        ok = true;
                        true
                    } else {
                        false
                    }
                });
                ok
            }
        }
    }

    /// 贪心星号：能多吃先多吃，失败逐级吐出（回溯由续延失败触发）
    fn match_star(&self, inner: &Node, pos: usize, depth: usize, k: &mut dyn FnMut(usize, usize) -> bool) -> bool {
        if depth > 10_000 {
            return false;
        }
        let ate = self.match_node(inner, pos, depth + 1, &mut |p, d| {
            if p > pos {
                self.match_star(inner, p, d, k)
            } else {
                // 零宽子匹配：再重复没有进展，直接走续延
                k(p, d)
            }
        });
        ate || k(pos, depth)
    }
}

// —— 解析 ——

/// 分支：seq（ '|' seq ）*
fn parse_alt(chars: &[char]) -> Option<(Node, &[char])> {
    let mut branches: Vec<Node> = Vec::new();
    let mut rest = chars;
    loop {
        let (seq, r) = parse_seq(rest)?;
        branches.push(seq);
        if r.first() == Some(&'|') {
            rest = &r[1..];
        } else {
            rest = r;
            break;
        }
    }
    // 折叠成右结合 Alt
    let node = branches
        .into_iter()
        .rev()
        .reduce(|acc, b| Node::Alt(Box::new(b), Box::new(acc)))
        .unwrap_or(Node::Empty);
    Some((node, rest))
}

/// 序列：原子 + 量词，吃字符直到 '|'、')' 或末尾
fn parse_seq(chars: &[char]) -> Option<(Node, &[char])> {
    let mut items: Vec<Node> = Vec::new();
    let mut rest = chars;
    loop {
        match rest.first() {
            None | Some('|') | Some(')') => break,
            _ => {}
        }
        let (atom, r) = parse_atom(rest)?;
        rest = r;
        let mut atom = atom;
        loop {
            match rest.first() {
                Some('*') => {
                    atom = Node::Star(Box::new(atom));
                    rest = &rest[1..];
                }
                Some('+') => {
                    atom = Node::Plus(Box::new(atom));
                    rest = &rest[1..];
                }
                Some('?') => {
                    atom = Node::Opt(Box::new(atom));
                    rest = &rest[1..];
                }
                _ => break,
            }
        }
        if !matches!(atom, Node::Empty) {
            items.push(atom);
        }
    }
    if items.is_empty() {
        Some((Node::Empty, rest))
    } else {
        Some((Node::Seq(items), rest))
    }
}

fn parse_atom(chars: &[char]) -> Option<(Node, &[char])> {
    match chars.first()? {
        '(' => {
            let (inner, rest) = parse_alt(&chars[1..])?;
            if rest.first() != Some(&')') {
                return None;
            }
            Some((inner, &rest[1..]))
        }
        '[' => {
            let mut i = 1;
            let mut neg = false;
            if chars.get(i) == Some(&'^') {
                neg = true;
                i += 1;
            }
            let mut items = Vec::new();
            // 首个 ']' 算字面量（[a]] 匹配 "a]"）
            if chars.get(i) == Some(&']') {
                items.push(ClassItem::Single(']'));
                i += 1;
            }
            while i < chars.len() && chars[i] != ']' {
                let c = if chars[i] == '\\' && i + 1 < chars.len() {
                    i += 1;
                    chars[i]
                } else {
                    chars[i]
                };
                if chars.get(i + 1) == Some(&'-') && chars.get(i + 2).map_or(false, |c| *c != ']') {
                    items.push(ClassItem::Range(c, chars[i + 2]));
                    i += 3;
                } else {
                    items.push(ClassItem::Single(c));
                    i += 1;
                }
            }
            if i >= chars.len() {
                return None;
            }
            Some((Node::Class { neg, items }, &chars[i + 1..]))
        }
        '^' => Some((Node::StartAnchor, &chars[1..])),
        '$' => Some((Node::EndAnchor, &chars[1..])),
        '.' => Some((Node::AnyChar, &chars[1..])),
        '\\' => {
            // \d \w \s（及大写取反）：常用字符类；其余转义当字面量
            let c = chars.get(1)?;
            let class = |items: Vec<ClassItem>, neg: bool| Some((Node::Class { neg, items }, &chars[2..]));
            match c {
                'd' => class(vec![ClassItem::Range('0', '9')], false),
                'D' => class(vec![ClassItem::Range('0', '9')], true),
                'w' => class(vec![ClassItem::Range('a', 'z'), ClassItem::Range('A', 'Z'), ClassItem::Range('0', '9'), ClassItem::Single('_')], false),
                'W' => class(vec![ClassItem::Range('a', 'z'), ClassItem::Range('A', 'Z'), ClassItem::Range('0', '9'), ClassItem::Single('_')], true),
                's' => class(vec![ClassItem::Single(' '), ClassItem::Single('\t')], false),
                'S' => class(vec![ClassItem::Single(' '), ClassItem::Single('\t')], true),
                _ => Some((Node::Char(*c), &chars[2..])),
            }
        }
        c => Some((Node::Char(*c), &chars[1..])),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn m(pattern: &str, text: &str) -> bool {
        regex_search(pattern, text).unwrap()
    }

    #[test]
    fn 字面量与锚() {
        assert!(m("readme", "readme.md"));
        assert!(!m("readme", "index.md"));
        assert!(m("\\.md$", "notes.md"));
        assert!(!m("\\.md$", "notes.mdx"));
        assert!(!m("^index", "readme.md"));
        assert!(m("^index", "index.md"));
    }

    #[test]
    fn 通配与量词() {
        assert!(m("a.*b", "axxxb"));
        assert!(!m("a.*b", "axxx\nc")); // `.` 不吃换行
        assert!(m("colou?r", "color"));
        assert!(m("colou?r", "colour"));
        assert!(m("ab+", "abbb"));
        assert!(!m("ab+", "a"));
        assert!(m("a*b", "b"));
    }

    #[test]
    fn 字符类与分支() {
        assert!(m("[a-c]x", "bx"));
        assert!(!m("[^a-c]x", "bx"));
        assert!(m("(foo|bar)\\.md", "bar.md"));
        assert!(!m("(foo|bar)\\.md", "baz.md"));
        assert!(m("a[.]b", "a.b"));
        assert!(!m("a[.]b", "axb"));
    }

    #[test]
    fn 回溯() {
        // 贪心多吃后要能吐回来
        assert!(m("a.*a", "ababa"));
        assert!(m("(ab)*c", "ababc"));
    }

    #[test]
    fn 语法错误返回错误() {
        assert!(regex_search("(unclosed", "x").is_err());
        assert!(regex_search("a)b", "x").is_err());
        assert!(regex_search("[abc", "x").is_err());
    }

    #[test]
    fn 正则替换() {
        assert_eq!(regex_replace("\\d+", "a1b22c", &mut |s: &str| format!("<{}>", s)).unwrap(), "a<1>b<22>c");
        assert_eq!(regex_replace("o", "foo", &mut |_| "0".to_string()).unwrap(), "f00");
        // 零宽匹配不死循环
        assert_eq!(regex_replace("x*", "ab", &mut |_| "-".to_string()).unwrap(), "-a-b-");
        // 空 pattern 原样
        assert_eq!(regex_replace("", "abc", &mut |_| "!".to_string()).unwrap(), "abc");
        // 语法错误
        assert!(regex_replace("(unclosed", "x", &mut |_| String::new()).is_err());
    }
}
