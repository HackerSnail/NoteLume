// desktop-gate.js —— 桌面能力的唯一环境判断
//
// 网页沙盒（vite 直开 / dist 静态站）没有 Tauri 后端，invoke / 系统对话框 / 路径 API 全不可用，
// 直接调用只会抛「Cannot read properties of undefined (reading 'invoke')」——看不出是谁调的。
// 判定只认注入标记 __TAURI_INTERNALS__：不 import @tauri-apps（导入本身不报错，调用才报错）。
// 规矩见 docs/SERVER.MD：桌面实现一律保留，靠环境判断分流，不删代码。

import { t } from './i18n.js'

/** 被隔离掉的调用统一带这个 code，调用方 catch 里可据此区分「没后端」和「后端报错」 */
export const DESKTOP_ONLY_CODE = 'desktop-only'

export function isDesktop() {
  return typeof window !== 'undefined' && !!window.__TAURI_INTERNALS__
}

/**
 * 有没有可调用的后端：Tauri 原生，或网页版的构建期替身（src/web/tauri-core.js 挂上标记）。
 *
 * bridge 里的 invoke / 系统对话框 / 路径 API 按这条分流，而不是按 isDesktop()：
 * 网页版拿到的是 HTTP 版后端，不是「无后端」，用 isDesktop() 拦会把整个网页版打死。
 * 反过来窗口按钮 / 设置存储的 localStorage 回落 / 启动参数探测仍须看 isDesktop()，
 * 所以这里不去伪造 __TAURI_INTERNALS__，另立一个只表示「后端可用」的标记。
 */
export function hasBackend() {
  if (isDesktop()) return true
  return typeof window !== 'undefined' && window.__NOTELUME_BACKEND__ === true
}

/** op 只进 Error.op（控制台排查用），不进用户可见文案 */
export function desktopOnlyError(op) {
  const e = new Error(t('msg.desktopOnly'))
  e.code = DESKTOP_ONLY_CODE
  e.op = op
  return e
}
