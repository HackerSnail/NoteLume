//! pdf_export.rs —— mac「导出 PDF」直出文件。
//!
//! 探针实测：WKWebView 的 createPDFWithConfiguration:completionHandler: **不分页**——
//! `rect` 直接成为 PDF 页面尺寸（1 CSS px = 1 pt），`@page size` 被完全忽略。
//! 所以按 Paged.js 已排好的页面盒逐页截取（每份单页 PDF），再用 PDFKit 合并成一个文件。
//! 不用 NSPrintOperation 静默打印：同一条探针里它把 3 页内容排成无限页（几分钟写出 1.3 GB），
//! 分页边界不可控，逐页截取更稳。
//!
//! 仅 mac 有实现：Windows 的 WebView2 PrintToPdf 未被 tauri 的 PlatformWebview 暴露，
//! 非 mac 走同名桩命令，前端按平台仍用打印面板。

use crate::ui_msg;

/// 单个页面盒（CSS 像素，网页坐标系，由前端按 Paged.js 实测给出）
#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfRect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// 完成回调在主线程投递，命令协程只等这一条 channel；单页/合并各留 60s
#[cfg(target_os = "macos")]
const PDF_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(60);

/// 逐页截取 → 主线程合并落盘。返回页数。
#[cfg(target_os = "macos")]
#[tauri::command]
pub async fn export_pdf(
    window: tauri::WebviewWindow,
    path: String,
    pages: Vec<PdfRect>,
) -> Result<usize, String> {
    use std::path::Path;

    if pages.is_empty() {
        return Err(ui_msg!("exportPdfFailed"));
    }
    if let Some(parent) = Path::new(&path).parent() {
        std::fs::create_dir_all(parent).map_err(|e| ui_msg!("createDirFailed", "err" => e))?;
    }
    let mut parts: Vec<Vec<u8>> = Vec::with_capacity(pages.len());
    for rect in pages {
        parts.push(grab_page(&window, rect)?);
    }
    let count = parts.len();
    merge_and_write(&window, &path, parts)?;
    Ok(count)
}

#[cfg(target_os = "macos")]
fn grab_page(window: &tauri::WebviewWindow, rect: PdfRect) -> Result<Vec<u8>, String> {
    use std::sync::mpsc;

    use block2::RcBlock;
    use objc2::MainThreadMarker;
    use objc2_core_foundation::{CGPoint, CGRect, CGSize};
    use objc2_foundation::{NSData, NSError};
    use objc2_web_kit::{WKPDFConfiguration, WKWebView};

    let (tx, rx) = mpsc::channel::<Result<Vec<u8>, String>>();
    window
        .with_webview(move |wv| {
            let Some(mtm) = MainThreadMarker::new() else {
                let _ = tx.send(Err(ui_msg!("exportPdfNoMainThread")));
                return;
            };
            let config = unsafe { WKPDFConfiguration::new(mtm) };
            unsafe {
                config.setRect(CGRect::new(
                    CGPoint::new(rect.x, rect.y),
                    CGSize::new(rect.width, rect.height),
                ));
            }
            let block: RcBlock<dyn Fn(*mut NSData, *mut NSError)> = RcBlock::new(
                move |data: *mut NSData, _err: *mut NSError| {
                    let out = if data.is_null() {
                        Err(ui_msg!("exportPdfFailed"))
                    } else {
                        Ok(unsafe { (*data).to_vec() })
                    };
                    let _ = tx.send(out);
                },
            );
            let wk: &WKWebView = unsafe { &*(wv.inner() as *const WKWebView) };
            unsafe { wk.createPDFWithConfiguration_completionHandler(Some(&config), &block) };
        })
        .map_err(|_| ui_msg!("exportPdfFailed"))?;

    rx.recv_timeout(PDF_TIMEOUT)
        .map_err(|_| ui_msg!("exportPdfTimeout"))?
}

/// 合并必须在主线程做（PDFKit 非线程安全），命令线程只等结果
#[cfg(target_os = "macos")]
fn merge_and_write(window: &tauri::WebviewWindow, path: &str, parts: Vec<Vec<u8>>) -> Result<(), String> {
    use std::sync::mpsc;

    use objc2::MainThreadMarker;

    let path = path.to_string();
    let (tx, rx) = mpsc::channel::<Result<(), String>>();
    window
        .with_webview(move |wv| {
            let _ = wv;
            let out = match MainThreadMarker::new() {
                None => Err(ui_msg!("exportPdfNoMainThread")),
                Some(_) => merge(&path, parts),
            };
            let _ = tx.send(out);
        })
        .map_err(|_| ui_msg!("exportPdfFailed"))?;

    rx.recv_timeout(PDF_TIMEOUT).map_err(|_| ui_msg!("exportPdfTimeout"))?
}

#[cfg(target_os = "macos")]
fn merge(path: &str, parts: Vec<Vec<u8>>) -> Result<(), String> {
    use objc2::AnyThread;
    use objc2_foundation::{NSData, NSString, NSURL};
    use objc2_pdf_kit::PDFDocument;

    let doc = unsafe { PDFDocument::init(PDFDocument::alloc()) };
    for bytes in parts {
        let data = NSData::from_vec(bytes);
        let Some(one) = (unsafe { PDFDocument::initWithData(PDFDocument::alloc(), &data) }) else {
            return Err(ui_msg!("exportPdfFailed"));
        };
        for i in 0..unsafe { one.pageCount() } {
            let Some(page) = (unsafe { one.pageAtIndex(i) }) else {
                return Err(ui_msg!("exportPdfFailed"));
            };
            unsafe { doc.insertPage_atIndex(&page, doc.pageCount()) };
        }
    }
    let url = NSURL::fileURLWithPath(&NSString::from_str(path));
    if unsafe { doc.writeToURL(&url) } {
        Ok(())
    } else {
        Err(ui_msg!("writeFailed", "path" => path, "err" => "pdfkit"))
    }
}

#[cfg(not(target_os = "macos"))]
#[tauri::command]
pub async fn export_pdf(_path: String, _pages: Vec<PdfRect>) -> Result<usize, String> {
    Err(ui_msg!("exportPdfUnsupported"))
}
