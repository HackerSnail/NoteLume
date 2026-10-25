// ecosystem.rs —— Ecosystem（include / includeall / subdocument）+ Libraries 查询（阶段 2 批 4）
//
// include 的三态入口对齐 Kotlin Ecosystem.kt：
//  · 库名：只认 stdlib（本引擎唯一的内置库），已加载，静默无输出。Kotlin 还支持 --libs 目录里的
//    .qd 文件按名加载，NoteLume 没有 libs 目录概念（阶段 4 再议），先不做。
//  · 包引用：`@scope/name:version` 需要包仓库与安装通道，NoteLume 没有，诊断降级。
//  · 文件路径：读进来按 Quarkdown 求值，输出并入当前文档。工作目录跟着切（被包含文件里的
//    .read / .include 相对它自己的目录解析，与 Kotlin 的 fileSystem.branch 一致），求值完恢复。
//    sandbox 两档：share（默认，声明并入当前文档，Kotlin 的 SharedContext）；
//    scope / subdocument（隔离求值，声明不回传）。subdocument 输出的是链接而非内容，
//    与文件路径分不开：Kotlin 里 subdocument 是独立函数，这里同款独立函数，不走 include。
//
// Libraries 查询四件套：libexists / functionexists / libraries / libfunctions。
// 已加载库恒定只有 stdlib；functionexists 与 eval_call 的解析同一口径（用户作用域或内置表）。

use std::collections::HashMap;

use super::eval::{Builtin, BuiltinFn, Evaluator};
use super::io::QdIo;
use super::parser::parse_document;
use super::value::Value;

pub fn register(m: &mut HashMap<String, Builtin>) {
    fn add(map: &mut HashMap<String, Builtin>, name: &str, f: BuiltinFn) {
        map.insert(name.to_string(), Builtin { f, lambda_args: &[] });
    }

    add(m, "include", |ev, call| {
        let path = call
            .pos
            .first()
            .and_then(|v| v.as_str())
            .ok_or_else(|| ".include 路径必须是文本".to_string())?;
        let sandbox = call
            .named
            .iter()
            .find(|(n, _)| n == "sandbox")
            .map(|(_, v)| v.as_str().ok_or_else(|| ".include 的 sandbox: 必须是文本".to_string()))
            .transpose()?
            .unwrap_or_else(|| "share".to_string());
        include_path(ev, &path, &sandbox)
    });

    add(m, "includeall", |ev, call| {
        // iterable 两种来源：位置实参（常为链式注入的 listfiles 结果）或块参数列表
        let iterable = match call.pos.first() {
            Some(v) => v.clone(),
            None => match &call.body {
                Some(b) if !b.is_empty() => ev
                    .eval_blocks(b)
                    .map_err(|()| ".includeall 集合求值失败".to_string())?,
                _ => return Err(".includeall 需要路径集合（实参或块参数列表）".to_string()),
            },
        };
        let items = iterable
            .as_items()
            .ok_or_else(|| ".includeall 实参不可迭代".to_string())?;
        let mut outs: Vec<String> = Vec::new();
        for item in items {
            let p = item.as_str().ok_or_else(|| ".includeall 集合元素必须是文本路径".to_string())?;
            if p.trim().is_empty() {
                continue;
            }
            match include_path(ev, &p, "share") {
                Ok(v) => outs.push(v.to_output().trim().to_string()),
                Err(e) => return Err(e),
            }
        }
        Ok(Value::Markdown(outs.join("\n").trim().to_string()))
    });

    add(m, "subdocument", |_, call| {
        let path = call
            .pos
            .first()
            .and_then(|v| v.as_str())
            .ok_or_else(|| ".subdocument 路径必须是文本".to_string())?
            .trim()
            .to_string();
        // anchor 收下忽略（Markdown 链接表达不了分页锚语义）
        let label = call
            .named
            .iter()
            .find(|(n, _)| n == "label")
            .map(|(_, v)| v.as_str().ok_or_else(|| ".subdocument 的 label: 必须是文本".to_string()))
            .transpose()?
            .filter(|l| !l.trim().is_empty());
        match label {
            Some(l) => Ok(Value::Str(format!("[{}]({})", l, path))),
            None => Ok(Value::None), // 无 label 仅注册，不显示（Kotlin 同）
        }
    });

    add(m, "libexists", |_, call| {
        let name = call
            .pos
            .first()
            .and_then(|v| v.as_str())
            .ok_or_else(|| ".libexists 库名必须是文本".to_string())?;
        Ok(Value::Bool(name.trim().eq_ignore_ascii_case("stdlib")))
    });

    add(m, "functionexists", |ev, call| {
        let name = call
            .pos
            .first()
            .and_then(|v| v.as_str())
            .ok_or_else(|| ".functionexists 函数名必须是文本".to_string())?;
        Ok(Value::Bool(ev.has_function(name.trim())))
    });

    add(m, "libraries", |_, _| Ok(Value::List(vec![Value::Str("stdlib".to_string())])));

    add(m, "libfunctions", |ev, call| {
        let name = call
            .pos
            .first()
            .and_then(|v| v.as_str())
            .ok_or_else(|| ".libfunctions 库名必须是文本".to_string())?;
        if !name.trim().eq_ignore_ascii_case("stdlib") {
            return Ok(Value::List(Vec::new()));
        }
        let mut names: Vec<Value> = ev.builtin_names().into_iter().map(Value::Str).collect();
        names.sort_by(|a, b| a.as_str().cmp(&b.as_str()));
        Ok(Value::List(names))
    });
}

/// include 的公共执行体：stdlib 名 / 包引用 / 文件三态。文件态返回展开后的 Markdown。
fn include_path(ev: &mut Evaluator, path: &str, sandbox: &str) -> Result<Value, String> {
    let trimmed = path.trim();
    if trimmed.eq_ignore_ascii_case("stdlib") {
        return Ok(Value::None);
    }
    if trimmed.starts_with('@') {
        return Err(".include 包引用（@scope/name:version）暂不支持：没有包仓库与安装通道".to_string());
    }
    if !matches!(sandbox.trim().to_lowercase().as_str(), "share" | "scope" | "subdocument") {
        return Err(".include sandbox 只认 share / scope / subdocument".to_string());
    }
    let io = QdIo::new(ev.doc_dir.clone());
    let p = io.resolve(trimmed)?;
    let text = std::fs::read_to_string(&p).map_err(|e| format!(".include 读取失败: {}", e))?;
    let blocks = parse_document(&text);
    let saved = ev.doc_dir.clone();
    // 被包含文件里的相对路径以它自己所在目录为基准
    ev.doc_dir = p.parent().map(|d| d.to_path_buf());
    let r = match sandbox.trim().to_lowercase().as_str() {
        "share" => ev.eval_blocks(&blocks),
        _ => ev.eval_isolated(&blocks), // scope / subdocument：声明不回传
    };
    ev.doc_dir = saved;
    r.map_err(|()| ".include 内容求值失败".to_string())
}

#[cfg(test)]
mod tests {
    use super::super::eval::eval_document;
    use super::super::parser::parse_document;
    use super::super::stdlib::builtins;
    use std::sync::atomic::{AtomicU32, Ordering};

    fn temp_dir() -> std::path::PathBuf {
        static SEQ: AtomicU32 = AtomicU32::new(0);
        let dir = std::env::temp_dir().join(format!(
            "nl-qd-eco-{}-{}",
            std::process::id(),
            SEQ.fetch_add(1, Ordering::SeqCst)
        ));
        std::fs::create_dir_all(dir.join("lib")).unwrap();
        dir
    }

    fn out_in(src: &str, dir: &std::path::Path) -> (String, usize) {
        let blocks = parse_document(src);
        let (t, d) = eval_document(&blocks, builtins(), Some(dir.to_path_buf()));
        (t, d.len())
    }

    fn out(src: &str) -> String {
        let blocks = parse_document(src);
        eval_document(&blocks, builtins(), None).0
    }

    #[test]
    fn include_share_声明并入当前文档() {
        let dir = temp_dir();
        std::fs::write(dir.join("lib").join("greet.qd"), ".function {hello}\n    who:\n    hi .who").unwrap();
        let (text, n) = out_in(".include {lib/greet.qd}\n\n.hello {qd}", &dir);
        assert_eq!(text, "hi qd");
        assert_eq!(n, 0);
    }

    #[test]
    fn include_scope_声明不回传() {
        let dir = temp_dir();
        std::fs::write(dir.join("scoped.qd"), ".var {secret} {hidden}\nvisible").unwrap();
        // scope：变量不出文件；正文里 .secret 未定义 → 降级原文 + 诊断
        let (text, n) = out_in(".include {scoped.qd} sandbox:{scope}\n\n.secret", &dir);
        assert!(text.contains("visible"));
        assert!(text.contains(".secret"));
        assert_eq!(n, 1);
        // share：变量回传（顶层块间的空行照常保留）
        let (text, n) = out_in(".include {scoped.qd}\n\n.secret", &dir);
        assert_eq!(text, "visible\n\nhidden");
        assert_eq!(n, 0);
    }

    #[test]
    fn include_相对路径以被包含文件目录为基准() {
        let dir = temp_dir();
        std::fs::write(dir.join("lib").join("note.txt"), "inner").unwrap();
        std::fs::write(dir.join("lib").join("reader.qd"), ".read {note.txt}").unwrap();
        let (text, n) = out_in(".include {lib/reader.qd}", &dir);
        assert_eq!(text, "inner");
        assert_eq!(n, 0);
    }

    #[test]
    fn include_自包含递归有上限不炸栈() {
        let dir = temp_dir();
        std::fs::write(dir.join("self.qd"), ".include {self.qd}").unwrap();
        let (text, n) = out_in(".include {self.qd}", &dir);
        assert!(text.contains(".include"));
        assert!(n >= 1);
    }

    #[test]
    fn include_包引用与缺文件降级() {
        let dir = temp_dir();
        let (text, n) = out_in(".include {@std/tables:1.0}", &dir);
        assert!(text.contains(".include"));
        assert_eq!(n, 1);
        let (text, n) = out_in(".include {missing.qd}", &dir);
        assert!(text.contains(".include"));
        assert_eq!(n, 1);
        // 库名静默
        let (text, n) = out_in(".include {stdlib}\n正文", &dir);
        assert_eq!(text, "正文");
        assert_eq!(n, 0);
    }

    #[test]
    fn includeall_批量并入() {
        let dir = temp_dir();
        std::fs::write(dir.join("a.qd"), "A").unwrap();
        std::fs::write(dir.join("b.qd"), "B").unwrap();
        let (text, n) = out_in(".includeall\n    - a.qd\n    - b.qd", &dir);
        assert_eq!(text, "A\nB");
        assert_eq!(n, 0);
    }

    #[test]
    fn subdocument_有label出链接无label静默() {
        assert_eq!(out(".subdocument {chapters/two.md} label:{第二章}"), "[第二章](chapters/two.md)");
        assert_eq!(out(".subdocument {chapters/two.md}\n正文"), "正文");
    }

    #[test]
    fn libraries_查询四件套() {
        assert_eq!(out(".libexists {stdlib}"), "yes");
        assert_eq!(out(".libexists {nope}"), "no");
        assert_eq!(out(".functionexists {sum}"), "yes");
        assert_eq!(out(".functionexists {nosuchfn}"), "no");
        assert_eq!(out(".function {myfn}\n    x\n\n.functionexists {myfn}"), "yes");
        assert_eq!(out(".libraries"), "stdlib");
        // libfunctions 列出全部内置函数名，抽查首尾
        let text = out(".libfunctions {stdlib}");
        assert!(text.contains("sum"));
        assert!(text.contains("include"));
        assert!(text.contains("localize"));
        assert_eq!(out(".libfunctions {nope}"), "");
    }
}
