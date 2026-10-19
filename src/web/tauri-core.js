// tauri-core.js —— @tauri-apps/api/core 的网页替身：invoke 走 HTTP
//
// 构建期由 src/web/vite.config.web.js 的 resolve.alias 把 '@tauri-apps/api/core' 指到这里，
// 于是原样进产物的 tauri-bridge.js 拿到的 invoke 就是这个函数——桌面文件一行不用改（§2 决策 1）。
//
// 协议（§3）：POST /api/invoke，body {cmd, params}，头 x-notelume-session:<sid>。
// 响应一律 200 + {ok:true,result} / {ok:false,error}；error 原样抛成 Error，
// 保留 [invalid_path] / [not_found] / [unsupported] 前串，前端按前串分派的既有约定不变。

let sidCache = null

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
  throw new Error((data && data.error) || 'invoke failed: ' + cmd)
}
