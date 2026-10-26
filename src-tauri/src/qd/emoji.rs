// emoji.rs —— Emoji 模块（Emoji.kt）：.emoji / .allemojis
//
// Kotlin 侧 emojiCatalog 的 replaceShortcodes：短代码换 emoji 字符。此前刻意未移植
// （不想在 Rust 侧复制 1900 条词表），现在从 markdown-it-emoji 的 full 数据生成
// emoji_data.rs——与前端 emoji-text.js 显示层同一份词表，口径一致。
//
//  · .emoji {smile} → 😀；未知短代码诊断降级（Kotlin 抛错，本引擎输出原文）
//  · .allemojis → 全量短代码 → emoji 的字典（Kotlin 返回 Dictionary，as_items 可迭代）

use std::collections::HashMap;

use super::emoji_data::EMOJI;
use super::eval::{Builtin, BuiltinFn};
use super::value::Value;

pub fn register(m: &mut HashMap<String, Builtin>) {
    fn add(map: &mut HashMap<String, Builtin>, name: &str, f: BuiltinFn) {
        map.insert(name.to_string(), Builtin { f, lambda_args: &[] });
    }

    add(m, "emoji", |_, call| {
        let name = call
            .pos
            .first()
            .and_then(|v| v.as_str())
            .ok_or_else(|| ".emoji 的短代码必须是文本".to_string())?
            .trim()
            .trim_start_matches(':')
            .trim_end_matches(':')
            .to_string();
        if name.is_empty() {
            return Err(".emoji 的短代码不能为空".to_string());
        }
        match EMOJI.iter().find(|(k, _)| *k == name) {
            Some((_, ch)) => Ok(Value::Str(ch.to_string())),
            None => Err(format!(".emoji 未知短代码 {}", name)),
        }
    });

    add(m, "allemojis", |_, _| {
        Ok(Value::Dict(
            EMOJI
                .iter()
                .map(|(k, v)| (k.to_string(), Value::Str(v.to_string())))
                .collect(),
        ))
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
    fn emoji_短代码换字符() {
        assert_eq!(out(".emoji {smile}"), "😄");
        // 冒号包裹的形态也认（Kotlin replaceShortcodes 吃 ":smile:"）
        assert_eq!(out(".emoji {:smile:}"), "😄");
    }

    #[test]
    fn emoji_未知短代码降级() {
        let (t, n) = {
            let blocks = parse_document(".emoji {notanemoji}");
            eval_document(&blocks, builtins(), None)
        };
        assert!(t.contains(".emoji"));
        assert_eq!(n.len(), 1);
    }

    #[test]
    fn allemojis_出全量字典() {
        let src = ".var {all}\n    .allemojis\n\n.all::get {smile}";
        assert_eq!(out(src), "😄");
        assert_eq!(out(".var {all}\n    .allemojis\n\n.size {.all}"), "1903");
    }
}
