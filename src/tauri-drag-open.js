// tauri-drag-open.js —— Windows / Linux 的拖入打开（Tauri drag-drop 事件通道）
//
// Tauri v2 窗口默认 dragDropEnabled: true，Windows / Linux 上原生拖放被 Tauri 拦截，
// DOM 收不到 HTML5 drop 事件；作为交换，getCurrentWebview().onDragDropEvent 给出
// 真实绝对路径（WebView2 的 webkitGetAsEntry 出于浏览器安全只给 /文件名，给不了全路径）。
// mac 的 WKWebView 不拦截 HTML5，那边继续走 drop-open.js 的 DOM 通道，本模块不挂。
//
// 事件只给路径不给类型，目录判定走 drop_path_is_dir 命令。
// 高亮与落点窗格判定和 HTML5 通道同口径：enter / over 挂 .nl-drop-on，
// drop 时把物理坐标换算成客户端坐标，elementFromPoint 找落点窗格。

import { getCurrentWebview } from '@tauri-apps/api/webview'
import { invoke } from '@tauri-apps/api/core'

export function bindTauriDragOpen({ rootEl, onTargets }) {
  let highlighting = false
  const setHighlight = (on) => {
    if (on === highlighting) return
    highlighting = on
    rootEl.classList.toggle('nl-drop-on', on)
  }
  getCurrentWebview().onDragDropEvent((event) => {
    const payload = event.payload || {}
    if (payload.type === 'enter' || payload.type === 'over') {
      setHighlight(true)
      return
    }
    if (payload.type === 'leave') {
      setHighlight(false)
      return
    }
    if (payload.type !== 'drop') return
    setHighlight(false)
    const paths = payload.paths || []
    if (!paths.length) return
    // position 是物理像素：换算成客户端坐标再找落点窗格
    const dpr = window.devicePixelRatio || 1
    const pos = payload.position || { x: 0, y: 0 }
    const el = document.elementFromPoint(pos.x / dpr, pos.y / dpr)
    ;(async () => {
      const targets = []
      for (const path of paths) {
        let isDir = false
        try { isDir = await invoke('drop_path_is_dir', { path }) } catch { isDir = false }
        targets.push({ path, isDir })
      }
      await onTargets(targets, { target: el })
    })()
  })
}
