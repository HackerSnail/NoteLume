// ai-inline.js —— 选区 AI 的浮动结果卡：流式预览 + 写回文档
//
// 编辑器选中文字 → 右键/命令面板触发任务，在选区附近弹出小浮层：
// 模型增量实时打进预览区，完成后「替换选区 / 插入到下方 / 复制」写回文档。
// 写回动作由 main.js 注入（捕获选区范围），本模块只管浮层与流式。
// 单例：同屏只允许一张浮层，再触发先关旧的。

import { t, onLocaleChange } from './i18n.js'
import { setIcon } from './icons.js'
import { aiChatStream, aiChatCancel, aiChatListen } from './tauri-bridge.js'
import { aiConfigured, stripFences } from './ai-tasks.js'

let POP_W = 380
const POP_MAX_H = 340

let current = null // 当前浮层控制器

export function closeAiInline() {
  if (current) current.close()
}

let reqSeq = 0
function nextReqId() {
  reqSeq += 1
  return 'inline-' + Date.now().toString(36) + '-' + reqSeq
}

/**
 * 打开选区 AI 浮层并开始流式。
 * @param {object} opts
 * @param {string} opts.title 任务名（菜单词条）
 * @param {{x:number,y:number,bottom:number}} opts.anchorRect 选区屏幕坐标（coordsAtPos 求得）
 * @param {() => object} opts.getConfig 当前 AI 设置
 * @param {Array<{role:string,content:string}>} opts.messages 完整请求消息（含 system）
 * @param {(text: string) => void} opts.onReplace 用结果替换选区
 * @param {(text: string) => void} opts.onInsert 把结果插入选区下方
 * @param {(msg: string) => void} [opts.setStatus]
 * @returns {{ close: () => void }}
 */
export function openAiInline(opts) {
  closeAiInline() // 单例
  const { title, anchorRect, getConfig, messages, onReplace, onInsert, setStatus } = opts

  const overlay = document.createElement('div')
  overlay.className = 'nl-ai-pop'
  const head = document.createElement('div')
  head.className = 'nl-ai-pop-head'
  const headTitle = document.createElement('span')
  setIcon(headTitle, 'sparkle', title)
  headTitle.appendChild(document.createTextNode(title))
  const closeBtn = document.createElement('button')
  closeBtn.type = 'button'
  closeBtn.className = 'ai-icon-btn'
  closeBtn.title = t('common.close')
  setIcon(closeBtn, 'close', t('common.close'))
  head.append(headTitle, closeBtn)
  const body = document.createElement('div')
  body.className = 'nl-ai-pop-body'
  const foot = document.createElement('div')
  foot.className = 'nl-ai-pop-foot'
  const statusEl = document.createElement('span')
  statusEl.className = 'nl-ai-pop-status'
  statusEl.textContent = t('ai.thinking')
  const replaceBtn = document.createElement('button')
  replaceBtn.type = 'button'
  replaceBtn.className = 'nl-ks-btn primary'
  replaceBtn.textContent = t('ai.popReplace')
  const insertBtn = document.createElement('button')
  insertBtn.type = 'button'
  insertBtn.className = 'nl-ks-btn'
  insertBtn.textContent = t('ai.popInsert')
  const copyBtn = document.createElement('button')
  copyBtn.type = 'button'
  copyBtn.className = 'nl-ks-btn'
  copyBtn.textContent = t('ai.copy')
  foot.append(statusEl, replaceBtn, insertBtn, copyBtn)
  overlay.append(head, body, foot)
  document.body.appendChild(overlay)

  // 定位：优先选区下方，放不下翻上方；x 钳在窗口内
  {
    const w = Math.min(POP_W, window.innerWidth - 24)
    let x = anchorRect.x
    let y = anchorRect.bottom + 6
    if (x + w > window.innerWidth - 8) x = Math.max(8, window.innerWidth - w - 8)
    const probeH = 120
    if (y + probeH > window.innerHeight - 8) {
      y = Math.max(8, anchorRect.y - POP_MAX_H - 6)
    }
    overlay.style.left = x + 'px'
    overlay.style.top = y + 'px'
    overlay.style.width = w + 'px'
  }

  let reqId = nextReqId()
  let text = ''
  let running = true
  let offLocale = null

  function dispose() {
    if (offEvent) offEvent()
    if (offLocale) offLocale()
    if (running) aiChatCancel(reqId).catch(() => {})
    running = false
    if (overlay.parentNode) overlay.parentNode.removeChild(overlay)
    if (current === api) current = null
  }

  function syncButtons() {
    const has = stripFences(text).length > 0
    replaceBtn.disabled = !has
    insertBtn.disabled = !has
    copyBtn.disabled = !has
  }

  function renderBody() {
    body.textContent = stripFences(text)
    body.scrollTop = body.scrollHeight
  }

  function finish(ok, err) {
    running = false
    if (ok) {
      statusEl.textContent = t('ai.popDone')
      body.textContent = stripFences(text)
    } else {
      statusEl.textContent = t('ai.errRequest', { err: err || t('ai.errUnknown') })
      statusEl.classList.add('err')
      const retry = document.createElement('button')
      retry.type = 'button'
      retry.className = 'nl-ks-btn'
      retry.textContent = t('ai.popRetry')
      retry.addEventListener('click', start)
      statusEl.after(retry)
    }
    syncButtons()
  }

  function start() {
    text = ''
    body.textContent = ''
    statusEl.classList.remove('err')
    statusEl.textContent = t('ai.thinking')
    running = true
    reqId = nextReqId()
    syncButtons()
    const cfg = getConfig()
    if (!aiConfigured(cfg)) {
      finish(false, t('ai.needConfig'))
      return
    }
    aiChatStream({
      reqId,
      messages,
      baseUrl: cfg.baseUrl,
      apiKey: cfg.apiKey,
      model: cfg.model,
    }).catch((e) => finish(false, (e && e.message) || String(e)))
  }

  const offEvent = aiChatListen((ev) => {
    if (!ev || ev.reqId !== reqId) return
    if (ev.kind === 'chunk' && ev.delta && running) {
      text += ev.delta
      renderBody()
      syncButtons()
    } else if (ev.kind === 'done') {
      finish(true)
    } else if (ev.kind === 'error') {
      finish(false, ev.error)
    }
  })

  closeBtn.addEventListener('click', dispose)
  replaceBtn.addEventListener('click', () => {
    if (running) aiChatCancel(reqId).catch(() => {})
    const out = stripFences(text)
    if (!out) return
    dispose()
    onReplace(out)
  })
  insertBtn.addEventListener('click', () => {
    if (running) aiChatCancel(reqId).catch(() => {})
    const out = stripFences(text)
    if (!out) return
    dispose()
    onInsert(out)
  })
  copyBtn.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(stripFences(text))
      if (setStatus) setStatus(t('ai.copied'))
    } catch { /* 剪贴板失败静默：浮层内已有内容可看 */ }
  })

  // 点浮层外面关（含滚轮 / Esc，与 placeMenu 的关闭行为一致）
  const onDocDown = (e) => { if (!overlay.contains(e.target)) dispose() }
  const onKey = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); dispose() }
  }
  document.addEventListener('mousedown', onDocDown, true)
  window.addEventListener('keydown', onKey, true)
  window.addEventListener('resize', dispose)
  offLocale = onLocaleChange(dispose) // 语言切换直接关：内容是模型产出，不重译

  const api = {
    close: dispose,
  }
  current = api
  start()
  return api
}
