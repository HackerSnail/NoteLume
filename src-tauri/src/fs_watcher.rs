// fs_watcher.rs —— 文件系统监听：监听库根目录，检测外部增删改，触发前端刷新树。
//
// 使用 notify 6.0（crossbeam-channel），在独立线程里跑，只发事件不阻塞主循环。
// 事件类型：Created / Removed / Modified —— 只要有变动就让前端重扫，
// 细分类型交给前端决定怎么处理（当前策略：任意变动 → 重扫 scan_vault + 重建索引）。
//
// 设计约束：
// - 只监听库根，不监听子目录递归（notify 自带递归）
// - 防抖 500ms：短时间内多次事件合并一次，避免频繁重扫
// - 同一库根只能有一个 watcher；切库时停旧起新
// - 事件发给前端 `nl:vault-changed`，携带 { vaultRoot, kind }

use notify::{Config, Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;
use tauri::{AppHandle, Emitter, State};

/// 监听器状态。每个库根对应一个 watcher，切库时切换。
#[derive(Default)]
pub struct FsWatcherState(pub Arc<Mutex<Option<FsWatcherInner>>>);

/// 监听器内部状态。pub(crate) 让 FsWatcherState 能公开引用它。
pub(crate) struct FsWatcherInner {
    watcher: RecommendedWatcher,
    _root: PathBuf,
}

impl FsWatcherState {
    /// 为库根启动/重启监听。已有同根则直接返回；不同根则停旧起新。
    pub fn ensure_watching(
        &self,
        app: &AppHandle,
        vault_root: String,
    ) -> Result<(), String> {
        let root = PathBuf::from(&vault_root);
        let root_canon = std::fs::canonicalize(&root).map_err(|e| e.to_string())?;

        let mut guard = self.0.lock().map_err(|e| e.to_string())?;

        // 已有同根监听，直接返回
        if let Some(inner) = guard.as_ref() {
            if inner._root == root_canon {
                return Ok(());
            }
        }

        // 停止旧监听
        if let Some(old) = guard.take() {
            drop(old.watcher); // 显式 drop 停止监听
        }

        // 创建新监听
        let root_for_watcher = root_canon.clone();
        let debounce = Duration::from_millis(500);

        let (tx, rx) = std::sync::mpsc::channel::<Event>();

        let mut watcher = RecommendedWatcher::new(
            move |res: Result<Event, notify::Error>| {
                if let Ok(ev) = res {
                    let _ = tx.send(ev);
                }
            },
            Config::default(),
        )
        .map_err(|e| e.to_string())?;

        watcher
            .watch(&root_for_watcher, RecursiveMode::Recursive)
            .map_err(|e| e.to_string())?;

        *guard = Some(FsWatcherInner {
            watcher,
            _root: root_for_watcher.clone(),
        });

        // 后台线程处理事件，做防抖
        let root_for_thread = root_for_watcher;
        let app_handle = app.clone();
        thread::spawn(move || {
            let mut last_emit = std::time::Instant::now();
            for ev in rx {
                // 过滤：只关心文件/目录的增删改
                let relevant = matches!(
                    ev.kind,
                    EventKind::Create(_) | EventKind::Remove(_) | EventKind::Modify(_)
                );
                if !relevant {
                    continue;
                }
                // 忽略隐藏文件/目录、临时文件、.git 等
                let skip = ev.paths.iter().any(|p| {
                    p.file_name()
                        .and_then(|n| n.to_str())
                        .map(|s| s.starts_with('.') || s.starts_with("~$") || s == "Thumbs.db")
                        .unwrap_or(false)
                });
                if skip {
                    continue;
                }
                // 忽略 assets 目录内的变动（图片由应用自己管理，不触发树刷新）
                let in_assets = ev.paths.iter().any(|p| {
                    p.components().any(|c| c.as_os_str() == "assets")
                });
                if in_assets {
                    continue;
                }

                let now = std::time::Instant::now();
                if now.duration_since(last_emit) < debounce {
                    continue;
                }
                last_emit = now;

                let _ = app_handle.emit(
                    "nl:vault-changed",
                    serde_json::json!({
                        "vaultRoot": root_for_thread.to_string_lossy(),
                        "kind": format!("{:?}", ev.kind),
                    }),
                );
            }
        });

        Ok(())
    }

    /// 停止当前监听
    pub fn stop(&self) {
        let mut guard = match self.0.lock() {
            Ok(g) => g,
            Err(_) => return,
        };
        if let Some(inner) = guard.take() {
            drop(inner.watcher);
        }
    }
}

/// Tauri 命令：开始监听库根
#[tauri::command]
pub fn start_vault_watcher(
    app: AppHandle,
    state: State<'_, FsWatcherState>,
    vault_root: String,
) -> Result<(), String> {
    state.ensure_watching(&app, vault_root)
}

/// Tauri 命令：停止监听
#[tauri::command]
pub fn stop_vault_watcher(state: State<'_, FsWatcherState>) -> Result<(), String> {
    state.stop();
    Ok(())
}