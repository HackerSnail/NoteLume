// 1. 必须有这行，否则打包 release 时就会有黑框
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
fn main() {
    notelume_lib::run()
}
