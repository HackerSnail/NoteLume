// tauri-core.js —— @tauri-apps/api/core 的网页替身：invoke 走 HTTP
//
// 构建期由 src/web/vite.config.web.js 的 resolve.alias 把 '@tauri-apps/api/core' 指到这里，
// 于是原样进产物的 tauri-bridge.js 拿到的 invoke 就是这个函数——桌面文件一行不用改（§2 决策 1）。
//
// 协议（§3）：POST /api/invoke，body {cmd, params}，头 x-notelume-session:<sid>。
// 响应一律 200 + {ok:true,result} / {ok:false,error[,code]}；error 原样抛成 Error，
// 保留 [invalid_path] / [not_found] / [unsupported] 前串，前端按前串分派的既有约定不变。
// code:'desktop-only'（后端 router 对桌面专属命令的标记）额外做一件事：把那句话提示到屏幕上。

import { notifyDesktopOnly } from './desktop-only.js'

let sidCache = null

// 本模块就是网页版的后端入口，而 src/tauri-bridge.js 会用 hasBackend() 分流桌面原语：
// 没有这个标记，bridge 会把 alias 进来的 HTTP invoke 也当成「无后端」拒掉，整个网页版一个请求都发不出去。
// 这里故意不伪造 __TAURI_INTERNALS__：那是 isDesktop() 的判据，窗口按钮、settings-store 的
// localStorage 回落、main.js 的启动参数探测都要它保持 false，伪造等于把浏览器冒充成桌面端。
if (typeof window !== 'undefined') window.__NOTELUME_BACKEND__ = true

/** 会话 id：localStorage 里有就用，没有生成一个存下（沙盒模式据此分工作区） */
export function sessionId() {
  if (sidCache) return sidCache
  let stored = null
  try {
    stored = localStorage.getItem('nl-web-sid')
  } catch {
    /* 隐私模式读不到：就地生成，不落盘 */
  }
  if (stored && /^[A-Za-z0-9_-]{1,64}$/.test(stored)) {
    sidCache = stored
    return sidCache
  }
  const made =
    (typeof crypto !== 'undefined' && crypto.randomUUID && crypto.randomUUID()) ||
    'sid-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10)
  sidCache = made
  try {
    localStorage.setItem('nl-web-sid', made)
  } catch {
    /* 存不下也不影响本次会话 */
  }
  return sidCache
}

export async function invoke(cmd, params) {
  let res
  try {
    res = await fetch('/api/invoke', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-notelume-session': sessionId() },
      body: JSON.stringify({ cmd, params: params === undefined ? {} : params }),
    })
  } catch (e) {
    throw new Error('无法连接本地服务（server/serve.mjs 是否已启动？）：' + ((e && e.message) || e))
  }
  let data
  try {
    data = await res.json()
  } catch (e) {
    throw new Error('本地服务返回非 JSON（HTTP ' + res.status + '）')
  }
  if (data && data.ok) return data.result
  const text = (data && data.error) || 'invoke failed: ' + cmd
  const err = new Error(text)
  if (data && data.code) {
    err.code = String(data.code)
    // 所有后端调用都过这一个漏斗，桌面专属命令的判定因此只需要 router.mjs 一处
    if (err.code === 'desktop-only') notifyDesktopOnly(text)
  }
  throw err
}
