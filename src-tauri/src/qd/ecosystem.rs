// ecosystem.rs —— Ecosystem（include / includeall / subdocument）+ Libraries 查询 + .extend（阶段 4）
//
// include 的四态入口对齐 Kotlin Ecosystem.kt（解析顺序：库名 → 包引用 → 文件路径）：
//  · 库名：stdlib 静默（已加载）；Libraries/ 目录下的 .qd 文件按文件名 stem 精确匹配加载
//    （Kotlin QdLibraries：只扫直接子级、库名 = 文件名 stem、loadLibrary 大小写敏感），
//    求值为 share 语义——声明并入当前文档，非定义内容照常进输出；重复 include 重求值覆盖定义。
//  · 包引用：`@scope/name:version` 只读本地包缓存（app data/qd-packages/<name>/<version>/，
//    atom.toml 清单的 entrypoint），未安装诊断降级——安装走 qd_package_install 命令显式进行，
//    打开陌生文档不会自动下载执行远端代码（Kotlin 侧有 Permission.PackageInstall 闸，同思路）。
//    只支持 atoms 源（Kotlin PackageRepositories 默认只注册 ATOMS_SCOPE）。
//  · 文件路径：读进来求值，工作目录跟着切（被包含文件里的 .read / .include 相对它自己的目录
//    解析），求值完恢复。sandbox 两档：share（默认，声明并入）、scope / subdocument（隔离求值，
//    声明不回传）。
//
// Libraries 查询四件套：libexists（大小写不敏感，Kotlin 同）/ functionexists / libraries /
// libfunctions（.qd 库扫源码里的 .function 定义名；已加载库恒定含 stdlib）。
//
// .extend {name} where:{cond} + body（FunctionExtension，Flow.kt 的 extendFunction）：
// 包装已有函数（用户 lambda 或内置），body 内 .super 调原函数，where: 条件不满足时透明回落；
// 链式扩展按声明顺序组合（后声明者紧贴原函数）。

use std::collections::HashMap;

use super::ast::{Block, InlineSeg};
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
            let v = include_path(ev, &p, "share")?;
            outs.push(v.to_output().trim().to_string());
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

    add(m, "libexists", |ev, call| {
        let name = call
            .pos
            .first()
            .and_then(|v| v.as_str())
            .ok_or_else(|| ".libexists 库名必须是文本".to_string())?;
        Ok(Value::Bool(library_exists(ev, name.trim())))
    });

    add(m, "functionexists", |ev, call| {
        let name = call
            .pos
            .first()
            .and_then(|v| v.as_str())
            .ok_or_else(|| ".functionexists 函数名必须是文本".to_string())?;
        Ok(Value::Bool(ev.has_function(name.trim())))
    });

    add(m, "libraries", |ev, _| {
        let mut names = vec![Value::Str("stdlib".to_string())];
        names.extend(ev.loaded_libs.iter().map(|n| Value::Str(n.clone())));
        Ok(Value::List(names))
    });

    add(m, "libfunctions", |ev, call| {
        let name = call
            .pos
            .first()
            .and_then(|v| v.as_str())
            .ok_or_else(|| ".libfunctions 库名必须是文本".to_string())?;
        if name.trim().eq_ignore_ascii_case("stdlib") {
            let mut names: Vec<Value> = ev.builtin_names().into_iter().map(Value::Str).collect();
            names.sort_by(|a, b| a.as_str().cmp(&b.as_str()));
            return Ok(Value::List(names));
        }
        // .qd 库：扫源码里的 .function 定义名；查无此库 → 空集合（Kotlin 同）
        let names = match find_library_file(ev, name.trim()) {
            Some(p) => match std::fs::read_to_string(&p) {
                Ok(src) => {
                    let mut out: Vec<String> = Vec::new();
                    collect_defined_functions(&parse_document(&src), &mut out);
                    out.sort();
                    out.dedup();
                    out.into_iter().map(Value::Str).collect()
                }
                Err(_) => Vec::new(),
            },
            None => Vec::new(),
        };
        Ok(Value::List(names))
    });

    // .extend {name} [where:{条件}] + body：包装已有函数（FunctionExtension / Flow.kt extendFunction）
    add_l(
        m,
        "extend",
        &["where"],
        |ev, call| {
            let name = call
                .pos
                .first()
                .and_then(|v| v.as_str())
                .ok_or_else(|| ".extend 目标函数名必须是文本".to_string())?
                .trim()
                .to_string();
            if name.is_empty() {
                return Err(".extend 目标函数名不能为空".to_string());
            }
            let body = match &call.body {
                Some(b) if !b.is_empty() => b.clone(),
                _ => return Err(".extend 需要 lambda 块参数作为扩展体".to_string()),
            };
            let (params, rest) = super::eval::Evaluator::lambda_params_pub(&body);
            // 目标：用户作用域优先；否则内置表（包 Builtin 占位，调用时按内置表原路求值）；
            // 都没有 → 诊断（Kotlin 抛 IllegalArgumentException）
            let base = match ev.lookup_value(&name) {
                Some(v) => v,
                None => {
                    if ev.has_function(&name) {
                        Value::Builtin(name.clone())
                    } else {
                        return Err(format!(".extend 找不到函数 .{}（内置函数与已定义函数才行）", name));
                    }
                }
            };
            let cond = call.named.iter().find(|(n, _)| n == "where").map(|(_, v)| v.clone());
            ev.define_value(&name, Value::Extended {
                params,
                body: rest.to_vec(),
                cond: cond.map(Box::new),
                base: Box::new(base),
            });
            Ok(Value::None)
        },
    );
}

fn add_l(map: &mut HashMap<String, Builtin>, name: &str, lambda_args: &'static [&'static str], f: BuiltinFn) {
    map.insert(name.to_string(), Builtin { f, lambda_args });
}

/// include 的公共执行体：stdlib 名 → 可加载库 → 包引用 → 文件四态。
fn include_path(ev: &mut Evaluator, path: &str, sandbox: &str) -> Result<Value, String> {
    let trimmed = path.trim();
    if trimmed.eq_ignore_ascii_case("stdlib") {
        return Ok(Value::None);
    }
    if !matches!(sandbox.trim().to_lowercase().as_str(), "share" | "scope" | "subdocument") {
        return Err(".include sandbox 只认 share / scope / subdocument".to_string());
    }
    // 可加载库：裸名字（无路径分隔与扩展名）先查 Libraries/ 目录
    if !trimmed.contains('/') && !trimmed.contains('\\') && !trimmed.contains('.') {
        if let Some(src) = read_library_source(ev, trimmed)? {
            if !ev.loaded_libs.iter().any(|n| n == trimmed) {
                ev.loaded_libs.push(trimmed.to_string());
            }
            return eval_source(ev, &src, None, sandbox, ".include");
        }
    }
    if trimmed.starts_with('@') {
        return include_package(ev, trimmed, sandbox);
    }
    let io = QdIo::new(ev.doc_dir.clone());
    let p = io.resolve(trimmed)?;
    let text = std::fs::read_to_string(&p).map_err(|e| format!(".include 读取失败: {}", e))?;
    // 被包含文件里的相对路径以它自己所在目录为基准
    eval_source(ev, &text, p.parent().map(|d| d.to_path_buf()), sandbox, ".include")
}

/// 求值一段 qd 源码（share 并入当前文档；scope / subdocument 隔离不回传）。
/// work_dir = Some 时临时切换工作目录（文件 / 包的相对路径以自己所在目录为基准）。
fn eval_source(
    ev: &mut Evaluator,
    text: &str,
    work_dir: Option<std::path::PathBuf>,
    sandbox: &str,
    label: &str,
) -> Result<Value, String> {
    let blocks = parse_document(text);
    let saved = ev.doc_dir.clone();
    ev.doc_dir = work_dir;
    let r = match sandbox.trim().to_lowercase().as_str() {
        "share" => ev.eval_blocks(&blocks),
        _ => ev.eval_isolated(&blocks), // scope / subdocument：声明不回传
    };
    ev.doc_dir = saved;
    r.map_err(|()| format!("{} 内容求值失败", label))
}

/// Libraries/ 目录直接子级里按 stem 精确匹配 .qd 文件，读到源码；目录未配置或无命中返回 None
fn read_library_source(ev: &mut Evaluator, name: &str) -> Result<Option<String>, String> {
    let dir = match &ev.libs_dir {
        Some(d) => d.clone(),
        None => return Ok(None),
    };
    let entries = match std::fs::read_dir(&dir) {
        Ok(e) => e,
        Err(_) => return Ok(None), // 没有 Libraries/ 目录不算错
    };
    for entry in entries.flatten() {
        let p = entry.path();
        if p.extension().map(|e| e.to_string_lossy().to_lowercase()) != Some("qd".to_string()) {
            continue;
        }
        if p.file_stem().map(|s| s.to_string_lossy()) == Some(name.to_string().into()) {
            let src = std::fs::read_to_string(&p).map_err(|e| format!(".include 读取库失败: {}", e))?;
            return Ok(Some(src));
        }
    }
    Ok(None)
}

/// 库文件查找（libexists / libfunctions 用，大小写不敏感——对齐 Kotlin 的 findLibrary）
fn find_library_file(ev: &Evaluator, name: &str) -> Option<std::path::PathBuf> {
    let dir = ev.libs_dir.as_ref()?;
    let entries = std::fs::read_dir(dir).ok()?;
    for entry in entries.flatten() {
        let p = entry.path();
        if p.extension().map(|e| e.to_string_lossy().to_lowercase()) != Some("qd".to_string()) {
            continue;
        }
        if p.file_stem().map(|s| s.to_string_lossy().to_lowercase()) == Some(name.to_lowercase()) {
            return Some(p);
        }
    }
    None
}

fn library_exists(ev: &Evaluator, name: &str) -> bool {
    if name.eq_ignore_ascii_case("stdlib") {
        return true;
    }
    if ev.loaded_libs.iter().any(|n| n.eq_ignore_ascii_case(name)) {
        return true;
    }
    find_library_file(ev, name).is_some()
}

/// 包引用解析：@scope/name:version → (scope, name, version)。
/// Kotlin 正则 ^@([^/:]*)/([^/:]*):(.*)$；version 是单个路径段，禁 .. 与反斜杠。
fn parse_package_ref(s: &str) -> Result<(String, String, String), String> {
    let body = &s[1..];
    let (scope, rest) = body
        .split_once('/')
        .ok_or_else(|| ".include 包引用格式是 @scope/name:version".to_string())?;
    let (name, version) = rest
        .split_once(':')
        .ok_or_else(|| ".include 包引用缺版本：@scope/name:version".to_string())?;
    let (scope, name, version) = (scope.trim(), name.trim(), version.trim());
    if scope.is_empty() || name.is_empty() || version.is_empty() {
        return Err(".include 包引用的 scope / name / version 不能为空".to_string());
    }
    if name.contains("..") || name.contains('\\') || name.contains('/') {
        return Err(format!(".include 包名不合法: {}", name));
    }
    if version.contains("..") || version.contains('\\') || version.contains('/') {
        return Err(format!(".include 包版本不合法: {}", version));
    }
    Ok((scope.to_string(), name.to_string(), version.to_string()))
}

/// 包引用：只读本地缓存 <packages_dir>/<name>/<version>/，atom.toml 的 entrypoint 为入口，
/// 工作目录切到包根（Kotlin resolvePackage 后 include entrypoint 同口径）。
fn include_package(ev: &mut Evaluator, reference: &str, sandbox: &str) -> Result<Value, String> {
    let (scope, name, version) = parse_package_ref(reference)?;
    if scope != "atoms" {
        return Err(format!(".include 只支持 atoms 包源，不支持 @{}", scope));
    }
    let dir = ev
        .packages_dir
        .as_ref()
        .ok_or_else(|| ".include 没有包缓存目录".to_string())?;
    let pkg = dir.join(&name).join(&version);
    let toml_path = pkg.join("atom.toml");
    if !toml_path.is_file() {
        return Err(format!(
            ".include 包 {} 未安装：在命令面板用「安装 Quarkdown 包…」显式安装（打开陌生文档不会自动下载执行远端代码）",
            reference.trim()
        ));
    }
    let manifest = std::fs::read_to_string(&toml_path).map_err(|e| format!(".include 读取 atom.toml 失败: {}", e))?;
    let entry = parse_atom_entrypoint(&manifest)?;
    let text = std::fs::read_to_string(pkg.join(&entry)).map_err(|e| format!(".include 读取包入口失败: {}", e))?;
    eval_source(ev, &text, Some(pkg), sandbox, ".include")
}

/// atom.toml 最小解析：只取 [atom] 表里的 entrypoint（带引号或不带引号都吃）。
/// Kotlin 的 PackageManifest 是完整 TOML，本引擎只需要这一个字段。
pub fn parse_atom_entrypoint(text: &str) -> Result<String, String> {
    let mut in_atom = false;
    for line in text.lines() {
        let t = line.trim();
        if t.starts_with('[') && t.ends_with(']') {
            in_atom = t == "[atom]";
            continue;
        }
        if !in_atom {
            continue;
        }
        if let Some((k, v)) = t.split_once('=') {
            if k.trim() == "entrypoint" {
                let v = v.trim().trim_matches('"').trim_matches('\'').trim();
                if v.is_empty() {
                    return Err("atom.toml 的 entrypoint 为空".to_string());
                }
                return Ok(v.to_string());
            }
        }
    }
    Err("atom.toml 缺 entrypoint 字段".to_string())
}

/// 扫 AST 收集 .function 定义名（libfunctions 对 .qd 库的函数清单）
fn collect_defined_functions(blocks: &[Block], out: &mut Vec<String>) {
    for b in blocks {
        match b {
            Block::Call(c) => {
                if c.head.name == "function" {
                    if let Some(a) = c.head.args.first() {
                        let n = a.raw.trim();
                        if !n.is_empty() {
                            out.push(n.to_string());
                        }
                    }
                }
                if let Some(body) = &c.body {
                    collect_defined_functions(body, out);
                }
            }
            Block::Inline(segs) => {
                for s in segs {
                    if let InlineSeg::Call(c) = s {
                        if c.head.name == "function" {
                            if let Some(a) = c.head.args.first() {
                                let n = a.raw.trim();
                                if !n.is_empty() {
                                    out.push(n.to_string());
                                }
                            }
                        }
                        if let Some(body) = &c.body {
                            collect_defined_functions(body, out);
                        }
                    }
                }
            }
            Block::Text(_) => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::super::eval::{eval_document, eval_document_with};
    use super::super::parser::parse_document;
    use super::super::stdlib::builtins;
    use std::sync::atomic::{AtomicU32, Ordering};

    fn temp_dir(tag: &str) -> std::path::PathBuf {
        static SEQ: AtomicU32 = AtomicU32::new(0);
        let dir = std::env::temp_dir().join(format!(
            "nl-qd-pm-{}-{}-{}",
            tag,
            std::process::id(),
            SEQ.fetch_add(1, Ordering::SeqCst)
        ));
        std::fs::create_dir_all(dir.join("lib")).unwrap();
        std::fs::create_dir_all(dir.join("Libraries")).unwrap();
        dir
    }

    fn out_in(src: &str, dir: &std::path::Path) -> (String, usize) {
        out_in_dirs(src, Some(dir.to_path_buf()), None, None)
    }

    fn out_in_dirs(
        src: &str,
        doc: Option<std::path::PathBuf>,
        libs: Option<std::path::PathBuf>,
        pkgs: Option<std::path::PathBuf>,
    ) -> (String, usize) {
        let blocks = parse_document(src);
        let (t, d) = eval_document_with(&blocks, builtins(), doc, libs, pkgs);
        (t, d.len())
    }

    fn out(src: &str) -> String {
        let blocks = parse_document(src);
        eval_document(&blocks, builtins(), None).0
    }

    // —— 既有：文件 include 与查询（带库目录参数回归）——

    #[test]
    fn include_share_声明并入当前文档() {
        let dir = temp_dir("share");
        std::fs::write(dir.join("lib").join("greet.qd"), ".function {hello}\n    who:\n    hi .who").unwrap();
        let (text, n) = out_in(".include {lib/greet.qd}\n\n.hello {qd}", &dir);
        assert_eq!(text, "hi qd");
        assert_eq!(n, 0);
    }

    #[test]
    fn include_scope_声明不回传() {
        let dir = temp_dir("scope");
        std::fs::write(dir.join("scoped.qd"), ".var {secret} {hidden}\nvisible").unwrap();
        let (text, n) = out_in(".include {scoped.qd} sandbox:{scope}\n\n.secret", &dir);
        assert!(text.contains("visible"));
        assert!(text.contains(".secret"));
        assert_eq!(n, 1);
        let (text, n) = out_in(".include {scoped.qd}\n\n.secret", &dir);
        assert_eq!(text, "visible\n\nhidden");
        assert_eq!(n, 0);
    }

    #[test]
    fn include_相对路径以被包含文件目录为基准() {
        let dir = temp_dir("reldir");
        std::fs::write(dir.join("lib").join("note.txt"), "inner").unwrap();
        std::fs::write(dir.join("lib").join("reader.qd"), ".read {note.txt}").unwrap();
        let (text, n) = out_in(".include {lib/reader.qd}", &dir);
        assert_eq!(text, "inner");
        assert_eq!(n, 0);
    }

    #[test]
    fn include_自包含递归有上限不炸栈() {
        let dir = temp_dir("rec");
        std::fs::write(dir.join("self.qd"), ".include {self.qd}").unwrap();
        let (text, n) = out_in(".include {self.qd}", &dir);
        assert!(text.contains(".include"));
        assert!(n >= 1);
    }

    #[test]
    fn includeall_批量并入() {
        let dir = temp_dir("all");
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
    fn include_包引用与缺文件降级() {
        let dir = temp_dir("pkgmiss");
        let (text, n) = out_in(".include {@std/tables:1.0}", &dir);
        assert!(text.contains(".include"));
        assert_eq!(n, 1);
        let (text, n) = out_in(".include {missing.qd}", &dir);
        assert!(text.contains(".include"));
        assert_eq!(n, 1);
        let (text, n) = out_in(".include {stdlib}\n正文", &dir);
        assert_eq!(text, "正文");
        assert_eq!(n, 0);
    }

    // —— 阶段 4：Libraries 目录 ——

    #[test]
    fn 库按名加载_声明并入_非定义进输出() {
        let dir = temp_dir("lib");
        std::fs::write(
            dir.join("Libraries").join("paper.qd"),
            ".function {cite}\n    n:\n    [Paper .n]\n\n库说明文字",
        )
        .unwrap();
        let libs = dir.join("Libraries");
        let (text, n) = out_in_dirs(".include {paper}\n\n.cite {3}", Some(dir.clone()), Some(libs), None);
        assert!(text.contains("库说明文字"));
        assert!(text.contains("[Paper 3]"));
        assert_eq!(n, 0);
    }

    #[test]
    fn 库查询四件套() {
        let dir = temp_dir("libq");
        std::fs::write(dir.join("Libraries").join("paper.qd"), ".function {alpha}\n    x\n\n.function {beta}\n    x").unwrap();
        let libs = dir.join("Libraries");
        let run = |src: &str| out_in_dirs(src, Some(dir.clone()), Some(libs.clone()), None);
        assert_eq!(run(".libexists {paper}").0, "yes");
        assert_eq!(run(".libexists {PAPER}").0, "yes"); // libexists 大小写不敏感（Kotlin findLibrary 同）
        assert_eq!(run(".libexists {nope}").0, "no");
        assert_eq!(run(".libraries").0, "stdlib");
        assert_eq!(run(".libfunctions {paper}").0, "alpha\nbeta");
        assert_eq!(run(".libfunctions {stdlib}").0.contains("sum"), true);
        assert_eq!(run(".libfunctions {nope}").0, "");
    }

    #[test]
    fn include_裸名未命中库回落文件路径() {
        let dir = temp_dir("libfb");
        std::fs::write(dir.join("loose.qd"), "loose").unwrap();
        let libs = dir.join("Libraries");
        let (text, n) = out_in_dirs(".include {loose.qd}", Some(dir.clone()), Some(libs), None);
        assert_eq!(text, "loose");
        assert_eq!(n, 0);
    }

    // —— 阶段 4：包缓存 ——

    #[test]
    fn 包include_读本地缓存_未安装降级() {
        let dir = temp_dir("pkg");
        let pkgs = dir.join("pkgs");
        let pkg = pkgs.join("demo").join("1.0.0");
        std::fs::create_dir_all(&pkg).unwrap();
        std::fs::write(pkg.join("atom.toml"), "[atom]\nname = \"demo\"\nversion = \"1.0.0\"\nentrypoint = \"main.qd\"\n").unwrap();
        std::fs::write(pkg.join("main.qd"), ".function {hello}\n    who:\n    pkg hi .who\n\n包内容").unwrap();
        let run = |src: &str| out_in_dirs(src, Some(dir.clone()), None, Some(pkgs.clone()));
        let (text, n) = run(".include {@atoms/demo:1.0.0}\n\n.hello {qd}");
        assert!(text.contains("pkg hi qd"));
        assert!(text.contains("包内容"));
        assert_eq!(n, 0);
        // 未安装 → 诊断降级
        let (text, n) = run(".include {@atoms/other:2.0}");
        assert!(text.contains(".include"));
        assert_eq!(n, 1);
        // 非 atoms 源
        let (text, n) = run(".include {@evil/pkg:1.0}");
        assert!(text.contains(".include"));
        assert_eq!(n, 1);
    }

    #[test]
    fn 包引用解析_非法形态() {
        assert!(super::parse_package_ref("@atoms/demo:1.0").is_ok());
        assert!(super::parse_package_ref("@/demo:1.0").is_err());
        assert!(super::parse_package_ref("@atoms/demo").is_err());
        assert!(super::parse_package_ref("@atoms/../etc:1.0").is_err());
        assert!(super::parse_package_ref("@atoms/demo:1.0/x").is_err());
    }

    #[test]
    fn atom_toml_取entrypoint() {
        assert_eq!(
            super::parse_atom_entrypoint("[atom]\nname = \"demo\"\nentrypoint = \"src/main.qd\"").unwrap(),
            "src/main.qd"
        );
        assert_eq!(super::parse_atom_entrypoint("[other]\nentrypoint = \"x\"\n[atom]\nentrypoint = main.qd").unwrap(), "main.qd");
        assert!(super::parse_atom_entrypoint("[atom]\nname = \"demo\"").is_err());
    }

    // —— 阶段 4：.extend ——

    #[test]
    fn extend_包装用户函数_super可用() {
        let src = ".function {greet}\n    who:\n    hi .who\n\n.extend {greet}\n    who:\n    .super 扩展\n\n.greet {qd}";
        assert_eq!(out(src), "hi qd 扩展");
    }

    #[test]
    fn extend_where条件不满足回落super() {
        let src = ".function {f}\n    n:\n    base .n\n\n.extend {f} where:{.1::iseven}\n    n:\n    even .n\n\n.f {2} .f {3}";
        assert_eq!(out(src), "even 2 base 3");
    }

    #[test]
    fn extend_包装内置函数() {
        // 两调用分行（行内连写会带上跳过 .if 的空串与间隔文本，既有口径）
        let src = ".extend {uppercase}\n    s:\n    .if {.s::equals {skip}}\n        原文\n    .ifnot {.s::equals {skip}}\n        .super\n\n.uppercase {skip}\n\n.uppercase {abc}";
        assert_eq!(out(src), "原文\n\nABC");
    }

    #[test]
    fn extend_链式组合() {
        let src = ".function {f}\n    n:\n    0\n\n.extend {f}\n    n:\n    A .super\n\n.extend {f}\n    n:\n    B .super\n\n.f {x}";
        // 后声明的扩展紧贴原函数：B 先于 A
        assert_eq!(out(src), "B A 0");
    }

    #[test]
    fn extend_目标不存在降级() {
        let (t, n) = {
            let blocks = parse_document(".extend {nope}\n    x");
            eval_document(&blocks, builtins(), None)
        };
        assert!(t.contains(".extend"));
        assert_eq!(n.len(), 1);
    }

    #[test]
    fn collect_函数名() {
        let mut out: Vec<String> = Vec::new();
        super::collect_defined_functions(&parse_document(".function {a}\n    x\n\n.function {b}\n    .function {inner}\n        y"), &mut out);
        out.sort();
        assert_eq!(out, vec!["a", "b", "inner"]);
    }
}
