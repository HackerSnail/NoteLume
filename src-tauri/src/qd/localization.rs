// localization.rs —— Localization 模块（阶段 2 批 4）
//
// 三个函数对齐 Kotlin stdlib：
//  · localization {name} merge:{no} + Markdown 嵌套列表 body —— 注册本地化表（顶层项是语言，
//    子项是 `- 键: 值`）；重名报错，merge:{yes} 时按语言合并、新条目优先。
//  · localize {表名:键名} separator:{":"} —— 查当前语言的条目；当前语言没有回退 en；再没有诊断降级。
//  · doclang {语言} —— 设置当前语言（无值回显当前 tag）。Kotlin 里属于 Document 模块，
//    本引擎此前是静默 no-op，本地化需要「当前语言」才有意义，从 no-op 名单里拿出来真做。
//
// 语言解析对齐 LocaleLoader：认语言 tag（en / zh-CN / zh-Hant ...）与英文名（Chinese、French...），
// 另加几个常用原生名（简体中文、Deutsch...）。Kotlin 没有地区回退链（fr-CA 不回退 fr），
// 这里补一层语言前缀回退：zh-CN 查不到时先试 zh 再回退 en，对用户更友好。
//
// std 内置表照抄 quarkdown-stdlib 的 LocalizationTable.kt（bibliography / error / figure 等
// 12 个键，10 种语言），启动即注册。

use std::collections::HashMap;

use super::ast::Block;
use super::eval::{Builtin, BuiltinFn, Evaluator};
use super::stdlib::pos;
use super::value::Value;

pub fn register(m: &mut HashMap<String, Builtin>) {
    fn add(map: &mut HashMap<String, Builtin>, name: &str, f: BuiltinFn) {
        map.insert(name.to_string(), Builtin { f, lambda_args: &[] });
    }

    add(m, "localization", |ev, call| {
        let name = pos(call, 0)?.as_str().ok_or_else(|| ".localization 表名必须是文本".to_string())?;
        let merge = match call.named.iter().find(|(n, _)| n == "merge") {
            Some((_, v)) => v.as_bool().ok_or_else(|| ".localization 的 merge: 必须是 yes / no".to_string())?,
            None => false,
        };
        let body = match &call.body {
            Some(b) if !b.is_empty() => b,
            _ => return Err(".localization 需要 Markdown 嵌套列表作为块参数".to_string()),
        };
        let groups = parse_table(ev, body)?;
        if groups.is_empty() {
            return Err(".localization 块参数里没有语言条目".to_string());
        }
        match ev.loc_tables.get_mut(&name) {
            None => {
                ev.loc_tables.insert(name, groups);
            }
            Some(existing) => {
                if !merge {
                    return Err(format!(".localization 表 {} 已存在（要合并用 merge:{{yes}}）", name));
                }
                for (tag, entries) in groups {
                    match existing.iter_mut().find(|(t, _)| *t == tag) {
                        Some((_, old)) => {
                            for (k, v) in entries {
                                match old.iter_mut().find(|(ok, _)| *ok == k) {
                                    Some(ov) => ov.1 = v,
                                    None => old.push((k, v)),
                                }
                            }
                        }
                        None => existing.push((tag, entries)),
                    }
                }
            }
        }
        Ok(Value::None)
    });

    add(m, "localize", |ev, call| {
        let raw = pos(call, 0)?.as_str().ok_or_else(|| ".localize 实参必须是文本".to_string())?;
        let sep = call
            .named
            .iter()
            .find(|(n, _)| n == "separator")
            .map(|(_, v)| v.as_str().ok_or_else(|| ".localize 的 separator: 必须是文本".to_string()))
            .transpose()?
            .unwrap_or_else(|| ":".to_string());
        let (table, key) = raw
            .split_once(sep.as_str())
            .ok_or_else(|| format!(".localize 实参格式是 表名{}键名: {}", sep, raw.trim()))?;
        let value = lookup(ev, table, key)
            .ok_or_else(|| format!(".localize 查不到 {}:{}", table, key))?;
        Ok(Value::Str(value))
    });

    // 从 Document 的 no-op 名单里拿出：有值设当前语言（认不出报错），无值回显当前 tag
    add(m, "doclang", |ev, call| match call.pos.first() {
        Some(v) => {
            let s = v.as_str().ok_or_else(|| ".doclang 语言必须是文本".to_string())?;
            let tag = resolve_locale(&s).ok_or_else(|| format!(".doclang 认不出语言: {}", s.trim()))?;
            ev.locale = tag;
            Ok(Value::None)
        }
        None => Ok(Value::Str(ev.locale.clone())),
    });
}

/// 表名:键名查值：当前语言 → 语言前缀（zh-CN → zh，Kotlin 没有这层，补的友好回退）→ en → None
pub fn lookup(ev: &Evaluator, table: &str, key: &str) -> Option<String> {
    let entries = ev.loc_tables.get(table)?;
    for tag in locale_chain(&ev.locale) {
        if let Some((_, kv)) = entries.iter().find(|(t, _)| *t == tag) {
            // Kotlin 口径：先按小写键查、再按原文查
            if let Some(v) = kv.iter().find(|(k, _)| k.to_lowercase() == key.to_lowercase()).or_else(|| kv.iter().find(|(k, _)| k == key)) {
                return Some(v.1.clone());
            }
        }
    }
    None
}

/// bibliography 等模块取本地化标题：查不到用英文缺省，不降级报错
pub fn localize_or(ev: &Evaluator, table: &str, key: &str, default: &str) -> String {
    lookup(ev, table, key).unwrap_or_else(|| default.to_string())
}

fn locale_chain(tag: &str) -> Vec<String> {
    let mut chain = vec![tag.to_string()];
    if let Some((lang, _)) = tag.split_once('-') {
        chain.push(lang.to_string());
    }
    if chain.last().map(|s| s.as_str()) != Some("en") {
        chain.push("en".to_string());
    }
    chain
}

/// 语言名 / tag → 规整 tag。认 tag（en / en-us / zh-CN）、英文名、常用原生名
pub fn resolve_locale(s: &str) -> Option<String> {
    let t = s.trim();
    if t.is_empty() {
        return None;
    }
    // 英文名与原生名 → tag
    const NAMES: &[(&str, &str)] = &[
        ("english", "en"),
        ("chinese", "zh"),
        ("simplified chinese", "zh-CN"),
        ("traditional chinese", "zh-Hant"),
        ("french", "fr"),
        ("german", "de"),
        ("italian", "it"),
        ("japanese", "ja"),
        ("korean", "ko"),
        ("polish", "pl"),
        ("portuguese", "pt"),
        ("russian", "ru"),
        ("ukrainian", "uk"),
        ("spanish", "es"),
        ("dutch", "nl"),
        // 原生名
        ("简体中文", "zh-CN"),
        ("繁體中文", "zh-Hant"),
        ("中文", "zh"),
        ("français", "fr"),
        ("deutsch", "de"),
        ("日本語", "ja"),
        ("español", "es"),
        ("italiano", "it"),
        ("português", "pt"),
    ];
    let lower = t.to_lowercase();
    if let Some((_, tag)) = NAMES.iter().find(|(n, _)| *n == lower || *n == t) {
        return Some(tag.to_string());
    }
    // tag：字母语言码 + 可选地区 / 文字段，规整成 zh-CN / zh-Hant 形态
    let parts: Vec<&str> = t.split('-').collect();
    let lang = parts[0];
    if !(2..=3).contains(&lang.len()) || !lang.chars().all(|c| c.is_ascii_alphabetic()) {
        return None;
    }
    match parts.get(1) {
        None => Some(lang.to_lowercase()),
        Some(rest) if (2..=8).contains(&rest.len()) && rest.chars().all(|c| c.is_ascii_alphanumeric()) => {
            if rest.len() == 4 {
                // 文字码：Hant
                Some(format!("{}-{}", lang.to_lowercase(), title_case(rest)))
            } else {
                Some(format!("{}-{}", lang.to_lowercase(), rest.to_uppercase()))
            }
        }
        _ => None,
    }
}

fn title_case(s: &str) -> String {
    let mut c = s.chars();
    match c.next() {
        Some(f) => f.to_uppercase().collect::<String>() + c.as_str(),
        None => String::new(),
    }
}

/// body → [(tag, [(键, 值)])]。顶层 `- 语言` 是语言行，嵌套 `- 键: 值` 是条目；
/// 行内调用在收集行时照常求值（filetree 同一手法）。键原文入库，值经字面量推断
/// （数字 / yes|no 落型，其余文本）。
fn parse_table(ev: &mut Evaluator, body: &[Block]) -> Result<Vec<(String, Vec<(String, String)>)>, String> {
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
    let mut entries: Vec<(usize, String)> = Vec::new();
    for l in &lines {
        let t = l.trim_end();
        if let Some(rest) = t.trim_start().strip_prefix("- ") {
            let text = rest.trim();
            if !text.is_empty() {
                entries.push((t.len() - t.trim_start().len(), text.to_string()));
            }
        }
    }
    if entries.is_empty() {
        return Err(".localization 块参数里没有 Markdown 列表".to_string());
    }
    let base = entries[0].0;
    let mut groups: Vec<(String, Vec<(String, String)>)> = Vec::new();
    for (ind, text) in entries {
        if ind == base {
            let tag = resolve_locale(&text).ok_or_else(|| format!(".localization 认不出语言: {}", text))?;
            groups.push((tag, Vec::new()));
        } else {
            let (k, v) = match text.split_once(':') {
                Some((k, v)) => (k.trim().to_string(), v.trim().to_string()),
                None => (text.clone(), String::new()),
            };
            if k.is_empty() {
                return Err(format!(".localization 条目缺键: {}", text));
            }
            match groups.last_mut() {
                Some((_, kv)) => kv.push((k, v)),
                None => return Err(".localization 语言行必须在最前".to_string()),
            }
        }
    }
    Ok(groups)
}

/// std 内置表，键值照抄 quarkdown-stdlib LocalizationTable.kt
pub fn std_table() -> Vec<(String, Vec<(String, String)>)> {
    fn loc(tag: &str, pairs: &[(&str, &str)]) -> (String, Vec<(String, String)>) {
        (tag.to_string(), pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect())
    }
    vec![
        loc("zh", &[("bibliography", "参考文献"), ("error", "错误"), ("figure", "图"), ("important", "重要"), ("listing", "代码"), ("note", "注意"), ("section", "章节"), ("table", "表"), ("tableofcontents", "目录"), ("tableofcontents/docs", "本页目录"), ("tip", "提示"), ("todo", "待办"), ("warning", "警告")]),
        loc("en", &[("bibliography", "References"), ("error", "Error"), ("figure", "Figure"), ("important", "Important"), ("listing", "Listing"), ("note", "Note"), ("section", "Section"), ("table", "Table"), ("tableofcontents", "Table of Contents"), ("tableofcontents/docs", "On this page"), ("tip", "Tip"), ("todo", "To do"), ("warning", "Warning")]),
        loc("fr", &[("bibliography", "Sources"), ("error", "Erreur"), ("figure", "Figure"), ("important", "Important"), ("listing", "Liste"), ("note", "Remarque"), ("section", "Section"), ("table", "Tableau"), ("tableofcontents", "Table des matières"), ("tableofcontents/docs", "Sur cette page"), ("tip", "Astuce"), ("todo", "À faire"), ("warning", "Attention")]),
        loc("de", &[("bibliography", "Literaturverzeichnis"), ("error", "Fehler"), ("figure", "Abbildung"), ("important", "Wichtig"), ("listing", "Auflistung"), ("note", "Anmerkung"), ("section", "Abschnitt"), ("table", "Tabelle"), ("tableofcontents", "Inhaltsverzeichnis"), ("tableofcontents/docs", "Auf dieser Seite"), ("tip", "Tipp"), ("todo", "Aufgabe"), ("warning", "Warnung")]),
        loc("it", &[("bibliography", "Riferimenti"), ("error", "Errore"), ("figure", "Figura"), ("important", "Importante"), ("listing", "Elenco"), ("note", "Nota"), ("section", "Sezione"), ("table", "Tabella"), ("tableofcontents", "Indice"), ("tableofcontents/docs", "In questa pagina"), ("tip", "Consiglio"), ("todo", "Da fare"), ("warning", "Attenzione")]),
        loc("ja", &[("bibliography", "参考文献"), ("error", "エラー"), ("figure", "図"), ("important", "重要"), ("listing", "リスト"), ("note", "注記"), ("section", "セクション"), ("table", "表"), ("tableofcontents", "目次"), ("tableofcontents/docs", "このページの内容"), ("tip", "ヒント"), ("todo", "タスク"), ("warning", "警告")]),
        loc("pl", &[("bibliography", "Bibliografia"), ("error", "Błąd"), ("figure", "Rysunek"), ("important", "Ważne"), ("listing", "Wykaz"), ("note", "Uwaga"), ("section", "Sekcja"), ("table", "Tabela"), ("tableofcontents", "Spis treści"), ("tableofcontents/docs", "Na tej stronie"), ("tip", "Wskazówka"), ("todo", "Do zrobienia"), ("warning", "Ostrzeżenie")]),
        loc("pt", &[("bibliography", "Bibliografia"), ("error", "Erro"), ("figure", "Figura"), ("important", "Importante"), ("listing", "Lista"), ("note", "Nota"), ("section", "Seção"), ("table", "Tabela"), ("tableofcontents", "Índice"), ("tableofcontents/docs", "Nesta página"), ("tip", "Dica"), ("todo", "A fazer"), ("warning", "Aviso")]),
        loc("ru", &[("bibliography", "Библиография"), ("error", "Ошибка"), ("figure", "Рисунок"), ("important", "Важно"), ("listing", "Список"), ("note", "Примечание"), ("section", "Раздел"), ("table", "Таблица"), ("tableofcontents", "Содержание"), ("tableofcontents/docs", "На этой странице"), ("tip", "Совет"), ("todo", "К выполнению"), ("warning", "Предупреждение")]),
        loc("uk", &[("bibliography", "Бібліографія"), ("error", "Помилка"), ("figure", "Рисунок"), ("important", "Важливо"), ("listing", "Список"), ("note", "Примітка"), ("section", "Розділ"), ("table", "Таблиця"), ("tableofcontents", "Зміст"), ("tableofcontents/docs", "На цій сторінці"), ("tip", "Порада"), ("todo", "До роботи"), ("warning", "Попередження")]),
    ]
}

/// 启动时把 std 表灌进求值器（Evaluator::new 之后调用）
pub fn install_std(ev: &mut Evaluator) {
    ev.loc_tables.insert("std".to_string(), std_table());
}

#[cfg(test)]
mod tests {
    use super::super::eval::eval_document;
    use super::super::parser::parse_document;
    use super::super::stdlib::builtins;

    fn run(src: &str) -> (String, usize) {
        let blocks = parse_document(src);
        let (t, d) = eval_document(&blocks, builtins(), None);
        (t, d.len())
    }

    fn out(src: &str) -> String {
        run(src).0
    }

    #[test]
    fn std表_按doclang查词条() {
        assert_eq!(out(".localize {std:tableofcontents}"), "Table of Contents");
        assert_eq!(out(".doclang {Chinese}\n.localize {std:tableofcontents}"), "目录");
        assert_eq!(out(".doclang {zh-CN}\n.localize {std:tip}"), "提示");
        assert_eq!(out(".doclang {fr}\n.localize {std:table}"), "Tableau");
        assert_eq!(out(".doclang\n前文"), "en\n前文");
    }

    #[test]
    fn 自定义表_注册与查询() {
        let src = ".localization {ui}\n    - English\n        - greeting: Hello\n    - Chinese\n        - greeting: 你好\n\n.doclang {Chinese}\n.localize {ui:greeting}";
        assert_eq!(out(src), "你好");
        assert_eq!(out(".localization {ui}\n    - English\n        - greeting: Hello\n\n.localize {ui:greeting}"), "Hello");
    }

    #[test]
    fn 表重名报错_merge合并() {
        let (text, n) = run(".localization {t}\n    - English\n        - a: 1\n\n.localization {t}\n    - English\n        - b: 2");
        assert!(text.contains(".localization"));
        assert_eq!(n, 1);
        // merge：新条目优先，旧条目保留
        let src = ".localization {t}\n    - English\n        - a: old\n\n.localization {t} merge:{yes}\n    - English\n        - a: new\n        - b: added\n\n.localize {t:a} .localize {t:b}";
        assert_eq!(out(src), "new added");
    }

    #[test]
    fn 查不到键_语言回退en() {
        // 当前语言缺键回退 en（localizeOrDefault 口径）
        let src = ".localization {t}\n    - English\n        - a: fallback\n    - Chinese\n        - b: 值\n\n.doclang {Chinese}\n.localize {t:a}";
        assert_eq!(out(src), "fallback");
        // 键彻底不存在 → 诊断降级
        let (text, n) = run(".localization {t}\n    - English\n        - a: x\n\n.localize {t:zzz}");
        assert!(text.contains(".localize"));
        assert_eq!(n, 1);
    }

    #[test]
    fn 语言解析_名字与tag() {
        assert_eq!(super::resolve_locale("Chinese"), Some("zh".to_string()));
        assert_eq!(super::resolve_locale("简体中文"), Some("zh-CN".to_string()));
        assert_eq!(super::resolve_locale("en-us"), Some("en-US".to_string()));
        assert_eq!(super::resolve_locale("ZH-hant"), Some("zh-Hant".to_string()));
        assert_eq!(super::resolve_locale("zz"), Some("zz".to_string()));
        assert_eq!(super::resolve_locale("Klingonish"), None);
    }

    #[test]
    fn doclang_认不出的语言降级() {
        let (text, n) = run(".doclang {Klingonish}\n正文");
        assert!(text.contains(".doclang"));
        assert_eq!(n, 1);
    }
}
