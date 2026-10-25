// slides.rs —— Slides 模块（阶段 2 批 4）
//
// Kotlin stdlib 的 Slides 模块只有三个函数：slides（放映配置）/ fragment（内容片断）/
// speakernote（演讲者备注）。HTML 渲染里它们分别落 window.slidesConfig、div.fragment、
// aside.notes；本引擎输出 Markdown，口径与批 3 一致：
//  · slides 的五个配置项在 Markdown 里无处安放（放映配置属于导出链路），收下校验后静默无输出，
//    与 Document 元数据 no-op 同一处理。值域照 Kotlin 枚举校验：transition none/fade/slide/zoom，
//    speed default/fast/slow。
//  · fragment 的翻页片断语义没有 Markdown 形态，标记丢弃、内容平铺（collapse 降级引用块同一取舍）。
//  · speakernote 落 `::: notes … :::` 容器——幻灯片导出管线（src/slides-export.js）本来就把
//    这个容器摘进 <aside class="notes">，正好接上既有链路，不用动前端。

use std::collections::HashMap;

use super::document::body_md;
use super::eval::{Builtin, BuiltinFn};
use super::value::Value;

pub fn register(m: &mut HashMap<String, Builtin>) {
    fn add(map: &mut HashMap<String, Builtin>, name: &str, f: BuiltinFn) {
        map.insert(name.to_string(), Builtin { f, lambda_args: &[] });
    }

    add(m, "slides", |_, call| {
        for name in ["center", "controls", "speakernotes"] {
            if let Some((_, v)) = call.named.iter().find(|(n, _)| n == name) {
                v.as_bool().ok_or_else(|| format!(".slides 的 {}: 必须是 yes / no", name))?;
            }
        }
        let transition = call
            .named
            .iter()
            .find(|(n, _)| n == "transition")
            .map(|(_, v)| v.as_str().ok_or_else(|| ".slides 的 transition: 必须是文本".to_string()))
            .transpose()?;
        if let Some(t) = transition {
            if !matches!(t.trim().to_lowercase().as_str(), "none" | "fade" | "slide" | "zoom") {
                return Err(".slides transition 只认 none / fade / slide / zoom".to_string());
            }
        }
        let speed = call
            .named
            .iter()
            .find(|(n, _)| n == "speed")
            .map(|(_, v)| v.as_str().ok_or_else(|| ".slides 的 speed: 必须是文本".to_string()))
            .transpose()?;
        if let Some(s) = speed {
            if !matches!(s.trim().to_lowercase().as_str(), "default" | "fast" | "slow") {
                return Err(".slides speed 只认 default / fast / slow".to_string());
            }
        }
        Ok(Value::None)
    });

    add(m, "fragment", |ev, call| {
        let behavior = call
            .named
            .iter()
            .find(|(n, _)| n == "behavior")
            .map(|(_, v)| v.as_str().ok_or_else(|| ".fragment 的 behavior: 必须是文本".to_string()))
            .transpose()?
            .map(|b| b.trim().to_lowercase().replace('-', ""))
            .unwrap_or_else(|| "show".to_string());
        if !matches!(behavior.as_str(), "show" | "hide" | "semihide" | "showhide") {
            return Err(".fragment behavior 只认 show / hide / semi-hide / show-hide".to_string());
        }
        // 片断标记（fade-in 等类）没有 Markdown 形态：内容平铺
        let body = body_md(ev, call)?;
        Ok(Value::Markdown(body))
    });

    add(m, "speakernote", |ev, call| {
        let body = body_md(ev, call)?;
        if body.trim().is_empty() {
            return Ok(Value::None);
        }
        Ok(Value::Markdown(format!("::: notes\n{}\n:::", body)))
    });
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
    fn slides_配置静默_值域校验() {
        assert_eq!(out(".slides center:{no} transition:{fade} speed:{fast}\n正文"), "正文");
        let (text, n) = run(".slides transition:{flip}");
        assert!(text.contains(".slides"));
        assert_eq!(n, 1);
        let (text, n) = run(".slides speed:{instant}");
        assert!(text.contains(".slides"));
        assert_eq!(n, 1);
        let (text, n) = run(".slides center:{maybe}");
        assert!(text.contains(".slides"));
        assert_eq!(n, 1);
    }

    #[test]
    fn speakernote_落notes容器() {
        assert_eq!(out(".speakernote\n    别念幻灯片"), "::: notes\n别念幻灯片\n:::");
        // 空备注无输出
        let (text, n) = run("x\n\n.speakernote\n    \n\ny");
        assert_eq!(n, 0);
        assert!(text.contains("x"));
        assert!(text.contains("y"));
        assert!(!text.contains(":::"));
    }

    #[test]
    fn fragment_标记丢弃内容平铺() {
        assert_eq!(out(".fragment\n    逐条出现"), "逐条出现");
        assert_eq!(out(".fragment behavior:{semi-hide}\n    内容"), "内容");
        let (text, n) = run(".fragment behavior:{warp}\n    内容");
        assert!(text.contains(".fragment"));
        assert_eq!(n, 1);
    }
}
