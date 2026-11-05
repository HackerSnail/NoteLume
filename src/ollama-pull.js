// ollama-pull.js —— Ollama 模型拉取的编排（一次只拉一个，进度可订阅）
//
// Rust 侧 ollama_pull 只发事件不管界面（ai.rs），这里把 reqId、进度状态与退订时序收在一处：
// AI 设置那一行和首启引导共用同一个实例，避免出现两条各拉各的进度。
// IPC 与取消都由 deps 注入，Node 里拿桩测状态机，不碰 Tauri 事件通道。

import { ollamaPull as ipcPull, ollamaPullListen, aiChatCancel } from './tauri-bridge.js'

/**
 * @param {object} [deps]
 * @param {(reqId: string, model: string) => Promise<void>} [deps.pull]
 * @param {(handler: (e: object) => void) => Promise<() => void>} [deps.listen]
 * @param {(reqId: string) => Promise<boolean>} [deps.cancel]
 */
export function createOllamaPull(deps = {}) {
  const pull = deps.pull || ipcPull
  const listen = deps.listen || ollamaPullListen
  const cancel = deps.cancel || aiChatCancel

  let cur = null // { reqId, model, state:'pulling'|'done'|'error', status, pct, error }
  let off = null
  let listening = null
  const subs = new Set()

  function emit() {
    for (const fn of [...subs]) {
      try { fn(cur) } catch { /* 订阅方出错不该断掉拉取 */ }
    }
  }

  function onEvent(e) {
    if (!cur || !e || e.reqId !== cur.reqId) return
    if (e.kind === 'progress') {
      cur = { ...cur, status: e.status || cur.status, pct: pctOf(e, cur.pct) }
      emit()
      return
    }
    if (e.kind === 'done') {
      cur = { ...cur, state: 'done', status: 'success', pct: 100 }
      emit()
      return
    }
    cur = { ...cur, state: 'error', error: String(e.error || '') }
    emit()
  }

  // 订阅是异步的（Tauri listen 先返回 Promise），挂上前就已经结束的事件不能丢退订句柄
  async function ensureListening() {
    if (off) return
    if (!listening) listening = Promise.resolve(listen(onEvent)).then((un) => { off = typeof un === 'function' ? un : () => {}; return off })
    try { await listening } catch { listening = null } // 订阅失败照旧拉取，只是没有进度
  }

  /** 起一次拉取。已在拉返回 false（一次只拉一个，不排队） */
  async function start(model, onState) {
    const m = String(model || '').trim()
    if (!m) return false
    if (cur && cur.state === 'pulling') return false
    if (onState) subs.add(onState)
    const reqId = 'ollama-pull-' + Date.now().toString(36) + '-' + (++seq)
    cur = { reqId, model: m, state: 'pulling', status: '', pct: 0, error: '' }
    await ensureListening()
    emit()
    try {
      await pull(reqId, m)
    } catch (e) {
      cur = { ...cur, state: 'error', error: (e && e.message) || String(e) }
      emit()
    }
    return true
  }

  /** 中止当前拉取（Rust abort 后不再有事件，这里当场置 error 并给出文案键） */
  function stop() {
    if (!cur || cur.state !== 'pulling') return false
    const rid = cur.reqId
    Promise.resolve(cancel(rid)).catch(() => {})
    cur = { ...cur, state: 'error', error: 'cancelled' }
    emit()
    return true
  }

  function subscribe(fn) {
    subs.add(fn)
    return () => subs.delete(fn)
  }

  function current() { return cur }

  return { start, stop, subscribe, current }
}

let seq = 0

/** completed / total → 百分比；缺一个就沿用上一次的（Ollama 的 manifest / verify 行不带计数） */
function pctOf(e, prev) {
  const total = Number(e && e.total)
  const done = Number(e && e.completed)
  if (!Number.isFinite(total) || total <= 0 || !Number.isFinite(done)) return prev || 0
  return Math.min(100, Math.round((done / total) * 100))
}
