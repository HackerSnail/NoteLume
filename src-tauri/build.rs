use std::path::PathBuf;

fn main() {
    write_bare_binary_info_plist();
    tauri_build::build()
}

/// `tauri dev` 跑的是 target/debug 里的裸二进制：没有 Info.plist，AppKit / WebKit 就按
/// 「开发区域 = 英文」本地化它们自己注入的条目（窗口菜单的系统项、编辑菜单的自动填充与
/// 表情与符号、右键上下文菜单），打包后又自动变中文。裸二进制同级的 Info.plist 会被
/// NSBundle 当作扁平 bundle 采纳（实测有效），故在构建时补一份最小 plist，让 dev 与包
/// 装形态一致。只写内容变化时的这份文件，不触碰 bundle 阶段由 tauri.conf 生成的 plist。
fn write_bare_binary_info_plist() {
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() != Ok("macos") {
        return;
    }
    let out = match std::env::var("OUT_DIR") {
        Ok(v) => PathBuf::from(v),
        Err(_) => return,
    };
    // OUT_DIR = target/<profile>/build/<pkg>-<hash>/out —— 上溯三级即可执行文件所在目录
    let exe_dir = match out.ancestors().nth(3) {
        Some(d) => d,
        None => return,
    };
    let file = exe_dir.join("Info.plist");
    let content = concat!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n",
        "<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n",
        "<plist version=\"1.0\">\n",
        "<dict>\n",
        "  <key>CFBundleExecutable</key><string>notelume</string>\n",
        "  <key>CFBundleIdentifier</key><string>app.notelume.desktop</string>\n",
        "  <key>CFBundleDevelopmentRegion</key><string>zh_CN</string>\n",
        "  <key>CFBundleLocalizations</key>\n",
        "  <array><string>zh_CN</string><string>zh-Hans</string><string>en</string></array>\n",
        "</dict>\n",
        "</plist>\n",
    );
    if std::fs::read_to_string(&file).map(|s| s == content).unwrap_or(false) {
        return;
    }
    let _ = std::fs::write(&file, content);
}
