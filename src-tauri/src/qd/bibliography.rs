// bibliography.rs —— Bibliography 模块（阶段 2 批 4）
//
// 两个函数对齐 Kotlin stdlib：bibliography {path} 读参考文献文件出条目列表，cite {keys} 出引文标记。
// 口径与批 3 一致：输出 Markdown，不产 HTML 片段。
//
// 与 Kotlin 的差距（刻意简化，都算文档级取舍）：
//  · 参考文献文件只支持 BibTeX（.bib）。CSL JSON / RIS / EndNote 与 CSL 样式引擎（kotlin-bibliographer）
//    不搬——CSL 全量是大工程，本引擎只有文本输出，先落 ieee 数字编号这一种形态。
//  · 条目内容是简化 ieee 拼装：作者、斜体标题、出处、卷期页、年份。不做姓名缩写等字段的精细排版。
//  · 条目编号按文件内出现顺序（经典 BibTeX 数字样式的口径），不是 Kotlin 的「按首次引用顺序重排」。
//
// cite 的编号是文档级后处理：cite 常出现在 bibliography 之前，求值期拿不到编号，
// 先落占位符 {{nlcite-N}}，eval_document 出口统一替换成 [n] / [n, m]；键查不到时 [?]。

use super::eval::{Builtin, BuiltinCall, BuiltinFn, Evaluator};
use super::io::QdIo;
use super::value::Value;

pub struct BibEntry {
    pub key: String,
    pub fields: Vec<(String, String)>,
}

pub fn register(m: &mut std::collections::HashMap<String, Builtin>) {
    fn add(map: &mut std::collections::HashMap<String, Builtin>, name: &str, f: BuiltinFn) {
        map.insert(name.to_string(), Builtin { f, lambda_args: &[] });
    }

    add(m, "bibliography", |ev, call| {
        let path = call
            .pos
            .first()
            .and_then(|v| v.as_str())
            .ok_or_else(|| ".bibliography 路径必须是文本".to_string())?;
        // style 只认 ieee（数字编号）；apa 等走 CSL 引擎，不搬
        let style = named_str(call, "style")?.unwrap_or_else(|| "ieee".to_string());
        if !style.eq_ignore_ascii_case("ieee") {
            return Err(format!(".bibliography 只支持 ieee 数字样式，不支持 {}", style));
        }
        let depth = match named_str(call, "headingdepth")? {
            Some(s) => s
                .trim()
                .parse::<usize>()
                .ok()
                .filter(|d| (1..=6).contains(d))
                .ok_or_else(|| ".bibliography 的 headingdepth: 必须是 1–6".to_string())?,
            None => 1,
        };
        // breakpage / numberheading / indexheading 是分页渲染与编号系统的参数，Markdown 里无处安放，收下忽略
        let title = named_str(call, "title")?.filter(|t| !t.trim().is_empty());
        let io = QdIo::new(ev.doc_dir.clone());
        let text = io.read_text(&path)?;
        let entries = parse_bibtex(&text);
        if entries.is_empty() {
            return Err(format!(".bibliography 没有解析到 BibTeX 条目: {}", path.trim()));
        }
        let heading = match title {
            Some(t) => t,
            None => super::localization::localize_or(ev, "std", "bibliography", "References"),
        };
        let bib: Vec<(String, Vec<(String, String)>)> = entries
            .into_iter()
            .map(|e| (e.key, e.fields))
            .collect();
        ev.bibs.push(bib);
        let bib = ev.bibs.last().unwrap();
        let mut out = format!("{} {}\n", "#".repeat(depth), heading);
        for (i, (key, fields)) in bib.iter().enumerate() {
            let _ = key;
            out.push_str(&format!("\n[{}] {}\n", i + 1, entry_content(fields)));
        }
        Ok(Value::Markdown(out.trim_end().to_string()))
    });

    add(m, "cite", |ev, call| {
        // cite {key} / cite {key1, key2}：逗号分隔多键，合成一个组合 label
        let raw = call
            .pos
            .first()
            .and_then(|v| v.as_str())
            .ok_or_else(|| ".cite 引用键必须是文本".to_string())?;
        let keys: Vec<String> = raw.split(',').map(|k| k.trim().to_string()).filter(|k| !k.is_empty()).collect();
        if keys.is_empty() {
            return Err(".cite 缺少引用键".to_string());
        }
        let idx = ev.cites.len();
        ev.cites.push(keys);
        // 占位符在 eval_document 出口由 resolve_citations 替换；键查不到时落 [?]
        Ok(Value::Str(format!("{{{{nlcite-{}}}}}", idx)))
    });
}

fn named_str(call: &BuiltinCall, name: &str) -> Result<Option<String>, String> {
    match call.named.iter().find(|(n, _)| n == name) {
        Some((_, v)) => v
            .as_str()
            .map(Some)
            .ok_or_else(|| format!(".{} 的 {}: 必须是文本", call.name, name)),
        None => Ok(None),
    }
}

/// 引文占位符统一解析：键在 ev.bibs 里查（多份 bibliography 时取第一份含该键的），
/// 编号 = 条目在该 bibliography 里的顺序（1 起）。组合引用 [1, 2]；有键查不到整组 [?]。
pub fn resolve_citations(ev: &mut Evaluator, out: &mut String) {
    if ev.cites.is_empty() {
        return;
    }
    for (i, keys) in ev.cites.iter().enumerate() {
        let label = citation_label(&ev.bibs, keys);
        *out = out.replace(&format!("{{{{nlcite-{}}}}}", i), &label);
    }
}

fn citation_label(bibs: &[Vec<(String, Vec<(String, String)>)>], keys: &[String]) -> String {
    let mut nums: Vec<usize> = Vec::new();
    for key in keys {
        match bibs.iter().filter_map(|bib| bib.iter().position(|(k, _)| k == key)).next() {
            Some(i) => nums.push(i + 1),
            None => return "[?]".to_string(),
        }
    }
    let parts: Vec<String> = nums.iter().map(|n| n.to_string()).collect();
    format!("[{}]", parts.join(", "))
}

/// 条目内容（简化 ieee）：作者、*标题*、出处（journal / booktitle / publisher 取第一个非空的）、
/// 卷期页、年份，逗号拼接，结尾补句点。
fn entry_content(fields: &[(String, String)]) -> String {
    let f = |name: &str| fields.iter().find(|(k, _)| k == name).map(|(_, v)| v.clone()).filter(|v| !v.is_empty());
    let mut parts: Vec<String> = Vec::new();
    if let Some(a) = f("author").or_else(|| f("editor")) {
        parts.push(a);
    }
    if let Some(t) = f("title") {
        parts.push(format!("*{}*", t));
    }
    for k in ["journal", "booktitle", "publisher", "school", "howpublished"] {
        if let Some(v) = f(k) {
            parts.push(v);
            break;
        }
    }
    if let Some(v) = f("volume") {
        parts.push(format!("vol. {}", v));
    }
    if let Some(v) = f("number") {
        parts.push(format!("no. {}", v));
    }
    if let Some(v) = f("pages") {
        parts.push(format!("pp. {}", v.replace("--", "-")));
    }
    if let Some(v) = f("year") {
        parts.push(v);
    }
    let mut s = parts.join(", ");
    if !s.ends_with('.') {
        s.push('.');
    }
    s
}

/// BibTeX 最小解析：@type{key, name = value, ...}。value 认花括号（配平嵌套）、双引号、
/// 裸数字三种；@comment / @string / @preamble 整体跳过；字段名统一小写；值内花括号剥掉、
/// 空白折叠成单空格（字段值常跨行）。解析容错：畸形字段跳过该行继续，不让整个文件报废。
fn parse_bibtex(src: &str) -> Vec<BibEntry> {
    let b: Vec<char> = src.chars().collect();
    let mut i = 0;
    let mut out: Vec<BibEntry> = Vec::new();
    while i < b.len() {
        if b[i] != '@' {
            i += 1;
            continue;
        }
        let start = i + 1;
        let mut j = start;
        while j < b.len() && b[j].is_alphanumeric() {
            j += 1;
        }
        let typ: String = b[start..j].iter().collect::<String>().to_lowercase();
        while j < b.len() && b[j].is_whitespace() {
            j += 1;
        }
        if j >= b.len() || b[j] != '{' {
            i = start;
            continue;
        }
        j += 1;
        if typ == "comment" || typ == "string" || typ == "preamble" {
            j = skip_group(&b, j);
            i = j;
            continue;
        }
        // 引用键：到逗号 / 收括号 / 换行为止
        let kstart = j;
        while j < b.len() && b[j] != ',' && b[j] != '}' && b[j] != '\n' {
            j += 1;
        }
        let key: String = b[kstart..j].iter().collect::<String>().trim().to_string();
        let mut fields: Vec<(String, String)> = Vec::new();
        if j < b.len() && b[j] == ',' {
            j += 1;
            loop {
                while j < b.len() && b[j].is_whitespace() {
                    j += 1;
                }
                if j >= b.len() || b[j] == '}' {
                    break;
                }
                let fs = j;
                while j < b.len() && b[j] != '=' && b[j] != '\n' && b[j] != '}' {
                    j += 1;
                }
                let name: String = b[fs..j].iter().collect::<String>().trim().to_lowercase();
                if j < b.len() && b[j] == '=' {
                    j += 1;
                    while j < b.len() && b[j].is_whitespace() {
                        j += 1;
                    }
                    let (val, nj) = read_value(&b, j);
                    j = nj;
                    if !name.is_empty() {
                        fields.push((name, val));
                    }
                } else {
                    // 畸形字段：跳到行尾继续
                    while j < b.len() && b[j] != '\n' && b[j] != '}' {
                        j += 1;
                    }
                }
                while j < b.len() && (b[j] == ',' || b[j].is_whitespace()) {
                    j += 1;
                }
            }
        }
        if !key.is_empty() {
            // 同键重复：后者覆盖（Kotlin 侧 Map.put 同语义）
            match out.iter().position(|e| e.key == key) {
                Some(p) => out[p] = BibEntry { key, fields },
                None => out.push(BibEntry { key, fields }),
            }
        }
        i = j;
    }
    out
}

fn skip_group(b: &[char], mut j: usize) -> usize {
    let mut depth = 1;
    while j < b.len() && depth > 0 {
        match b[j] {
            '{' => depth += 1,
            '}' => depth -= 1,
            _ => {}
        }
        j += 1;
    }
    j
}

fn read_value(b: &[char], mut j: usize) -> (String, usize) {
    let mut val = String::new();
    if j < b.len() && b[j] == '{' {
        let mut depth = 1;
        j += 1;
        while j < b.len() && depth > 0 {
            match b[j] {
                '{' => {
                    depth += 1;
                    val.push('{');
                }
                '}' => {
                    depth -= 1;
                    if depth > 0 {
                        val.push('}');
                    }
                }
                c => val.push(c),
            }
            j += 1;
        }
    } else if j < b.len() && b[j] == '"' {
        j += 1;
        while j < b.len() && b[j] != '"' {
            val.push(b[j]);
            j += 1;
        }
        if j < b.len() {
            j += 1;
        }
    } else {
        while j < b.len() && b[j] != ',' && b[j] != '}' && b[j] != '\n' {
            val.push(b[j]);
            j += 1;
        }
    }
    (clean_bib_value(&val), j)
}

/// 值清洗：剥花括号（{\"o} → o 的粗略口径）、空白折叠
fn clean_bib_value(v: &str) -> String {
    let s: String = v.chars().filter(|c| *c != '{' && *c != '}').collect();
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::qd::eval::eval_document;
    use crate::qd::parser::parse_document;
    use crate::qd::stdlib::builtins;
    use std::sync::atomic::{AtomicU32, Ordering};

    fn temp_bib(content: &str) -> std::path::PathBuf {
        static SEQ: AtomicU32 = AtomicU32::new(0);
        let dir = std::env::temp_dir().join(format!(
            "nl-qd-bib-{}-{}",
            std::process::id(),
            SEQ.fetch_add(1, Ordering::SeqCst)
        ));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("refs.bib"), content).unwrap();
        dir
    }

    const BIB: &str = r#"@article{einstein1905,
  author = {Albert Einstein},
  title = {Zur Elektrodynamik bewegter K{\"o}rper},
  journal = {Annalen der Physik},
  volume = {322},
  number = {10},
  pages = {891--921},
  year = {1905}
}

@book{knuth1984,
  author = {Donald Knuth},
  title = {The TeXbook},
  publisher = {Addison-Wesley},
  year = {1984}
}"#;

    #[test]
    fn bibtex_解析字段() {
        let entries = parse_bibtex(BIB);
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].key, "einstein1905");
        let f = |n: &str| entries[0].fields.iter().find(|(k, _)| k == n).map(|(_, v)| v.clone());
        assert_eq!(f("author").as_deref(), Some("Albert Einstein"));
        // 花括号剥掉、重音命令留字母
        assert_eq!(f("title").as_deref(), Some("Zur Elektrodynamik bewegter K\\\"orper"));
        assert_eq!(f("volume").as_deref(), Some("322"));
    }

    #[test]
    fn bibliography_出条目列表并编号cite() {
        let dir = temp_bib(BIB);
        let src = "见 .cite {knuth1984} 与 .cite {einstein1905, knuth1984}。\n\n.bibliography {refs.bib}";
        let blocks = parse_document(src);
        let (text, diags) = eval_document(&blocks, builtins(), Some(dir));
        assert!(diags.is_empty());
        assert!(text.contains("见 [2] 与 [1, 2]。"));
        assert!(text.contains("# References"));
        assert!(text.contains("[1] Albert Einstein, *Zur Elektrodynamik"));
        assert!(text.contains("vol. 322, no. 10, pp. 891-921, 1905."));
        assert!(text.contains("[2] Donald Knuth, *The TeXbook*, Addison-Wesley, 1984."));
    }

    #[test]
    fn cite_键查不到落问号() {
        let dir = temp_bib(BIB);
        let src = ".cite {missing}\n\n.bibliography {refs.bib}";
        let blocks = parse_document(src);
        let (text, _) = eval_document(&blocks, builtins(), Some(dir));
        assert!(text.starts_with("[?]"));
    }

    #[test]
    fn bibliography_自定义标题与层级() {
        let dir = temp_bib(BIB);
        let src = ".bibliography {refs.bib} title:{文献} headingdepth:{2}";
        let blocks = parse_document(src);
        let (text, diags) = eval_document(&blocks, builtins(), Some(dir));
        assert!(diags.is_empty());
        assert!(text.starts_with("## 文献"));
    }

    #[test]
    fn bibliography_非ieee样式与缺文件降级() {
        let (text, n) = {
            let blocks = parse_document(".bibliography {refs.bib} style:{apa}");
            let (t, d) = eval_document(&blocks, builtins(), None);
            (t, d.len())
        };
        assert!(text.contains(".bibliography"));
        assert_eq!(n, 1);
        let dir = temp_bib(BIB);
        let (text, n) = {
            let blocks = parse_document(".bibliography {nope.bib}");
            let (t, d) = eval_document(&blocks, builtins(), Some(dir));
            (t, d.len())
        };
        assert!(text.contains(".bibliography"));
        assert_eq!(n, 1);
    }

    #[test]
    fn 文件为空_条目缺失诊断() {
        let dir = temp_bib("不是 BibTeX 的普通文本");
        let (text, n) = {
            let blocks = parse_document(".bibliography {refs.bib}");
            let (t, d) = eval_document(&blocks, builtins(), Some(dir));
            (t, d.len())
        };
        assert!(text.contains(".bibliography"));
        assert_eq!(n, 1);
    }
}
