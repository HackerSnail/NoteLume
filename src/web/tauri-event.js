// tauri-event.js —— @tauri-apps/api/event 的网页替身
//
// 桌面版靠 Rust 侧 emit 转发菜单 / 文件打开等原生事件；网页没有这条通道。
// main.js 里未被 __TAURI_INTERNALS__ 包裹的 listen('file-opened', …).catch(…) 会照常跑到这里，
// 所以 listen 必须返回一个 Promise（resolve 出一个 no-op 的 unlisten），否则 .catch 就是 TypeError。
// 事件永不触发 = 这些入口在网页里天然静默，不需要改调用点。

export function listen(_event, _handler) {
  return Promise.resolve(function unlisten() {})
}

export function once(_event, _handler) {
  return Promise.resolve(function unlisten() {})
}

export function emit(_event, _payload) {
  return Promise.resolve()
}

export function emitTo(_label, _event, _payload) {
  return Promise.resolve()
}
