// tauri-path.js —— @tauri-apps/api/path 的网页替身：tempDir / join
//
// main.js 的 ensureScratchDir 用 tempDir() 当库根去 create_dir(<base>/NoteLume/scratch)，
// 再 join(base,'NoteLume','scratch') 记住临时目录位置。所以：
//   - tempDir() 必须回一个后端真实存在、且 create_dir 能在其下建目录的绝对路径
//     ——取 /api/health 的 scratchDir（本机 <tmp>/notelume-web，沙盒 <会话>/tmp）。
//   - join() 的分隔符要跟后端 realpath 的原生分隔符一致，否则 scratch 前缀判定会错开：
//     base 里出现反斜杠（Windows 的 C:\…）就按 \ 拼，否则按 / 拼。

import { sessionId } from './tauri-core.js'

let scratchCache = null

export async function tempDir() {
  if (scratchCache) return scratchCache
  try {
    const res = await fetch('/api/health', { headers: { 'x-notelume-session': sessionId() } })
    const data = await res.json()
    if (data && typeof data.scratchDir === 'string') {
      scratchCache = data.scratchDir
      return scratchCache
    }
  } catch {
    /* 拿不到就退回一个前端能自洽用的名字，真正的落盘位置以后端为准 */
  }
  return '/tmp'
}

/** 拼路径：与后端原生分隔符对齐；折叠段与段之间的重复分隔符，跳过空段 */
export async function join(...parts) {
  const flat = parts.filter((p) => p != null && String(p) !== '')
  if (!flat.length) return ''
  const hasBack = flat.some((p) => String(p).includes('\\'))
  const sep = hasBack ? '\\' : '/'
  let out = ''
  for (const raw of flat) {
    let seg = String(raw)
    if (out === '') {
      out = seg.replace(/[\\/]+$/, '')
      continue
    }
    seg = seg.replace(/^[\\/]+/, '').replace(/[\\/]+$/, '')
    if (seg === '') continue
    out += sep + seg
  }
  return out
}

// 其余 @tauri-apps/api/path 的导出：桌面代码目前没用到，给最小实现以防万一。
export async function sep() {
  return scratchCache && scratchCache.includes('\\') ? '\\' : '/'
}
export async function delimiter() {
  return ';'
}
export async function basename(p) {
  return String(p).replace(/[\\/]+$/, '').split(/[\\/]/).pop() || ''
}
export async function extname(p) {
  const b = await basename(p)
  const i = b.lastIndexOf('.')
  return i > 0 ? b.slice(i) : ''
}
export async function dirname(p) {
  const s = String(p).replace(/[\\/]+$/, '')
  const i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'))
  return i > 0 ? s.slice(0, i) : ''
}
export async function isAbsolute(p) {
  return /^([a-zA-Z]:[\\/]|[\\/])/.test(String(p))
}
export async function normalize(p) {
  return String(p)
}
