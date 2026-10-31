// ai-panel.js —— 侧栏「AI」页签：针对当前文档的对话面板
//
// 每轮把「当前文档上下文（系统消息）+ 全部历史」发给 Rust 代理的 OpenAI 兼容接口，
// 增量经 nl:ai-event 事件流回，实时渲染进最后一个气泡。历史只存内存（换文档不清，
// 主动「清空」才清）；配置缺失时给引导，不弹窗打断。
// 渲染用独立 markdown-it 实例：html:false（模型输出里的字面 HTML 一律转义，天然防注入），
// 开 table / strikethrough 与正文渲染观感一致。

import { t, onLocaleChange } from './i18n.js'
import { setIcon } from './icons.js'
import MarkdownIt from 'markdown-it'
import { aiChatStream, aiChatCancel, aiChatListen } from './tauri-bridge.js'
import { aiConfigured, stripFences, parseAgentReply, modelSupportsVision } from './ai-tasks.js'

let reqSeq = 0
function nextReqId() {
  reqSeq += 1
  return 'chat-' + Date.now().toString(36) + '-' + reqSeq
}

// Ask / Agent 模式：Ask 只问答（现状）；Agent 在回答完整结束后自动把内容写进当前文档末尾
// （走 insertToDoc 同一条 ProseMirror 链路，可撤销）。模式持久化 nl-ai-mode。
let mode = (() => {
  try { return localStorage.getItem('nl-ai-mode') === 'agent' ? 'agent' : 'ask' } catch { return 'ask' }
})()

/**
 * 侧栏 AI 对话面板。
 * @param {object} deps
 * @param {HTMLElement} deps.root 侧栏里的挂载点（#ai-panel）
 * @param {() => object} deps.getConfig 当前 AI 设置（main.js 归一化后给出）
 * @param {() => void} deps.openSettings 打开 AI 设置面板
 * @param {() => string} deps.getDocContext 当前文档上下文文本（ai-tasks.buildDocContext 的产物，'' 表示无文档）
 * @param {(text: string) => void} deps.insertToDoc 把一段文本插入当前文档光标处
 * @param {(text: string, anchor?: {dir:'after'|'before', target:string}|null) => {ok:boolean, where?:string, missed?:boolean}|boolean} [deps.appendToDoc]
 *   Agent 模式收尾时把回答写进当前文档：有锚点先按 resolveAnchorPos 定位（未命中回退光标落点并标 missed）
 * @param {(msg: string) => void} deps.setStatus
 */
export function createAiPanel(deps) {
  const { root, getConfig, openSettings, getDocContext, insertToDoc, appendToDoc, setStatus } = deps
  const md = MarkdownIt('commonmark', { html: false, linkify: true, breaks: true })
    .enable(['table', 'strikethrough'])

  let msgsEl = null // 消息滚动区
  let inputEl = null
  let sendBtn = null
  let stopBtn = null
  let modelChip = null
  let emptyHint = null
  let attEl = null // 附件预览条（附图 chip 列表，空时隐藏）
  let fileInput = null // 隐藏的选图 input（点击附图按钮触发）
  let attachments = [] // 待发送图片 [{ dataUrl, name }]，随消息一起发出后清空
  let history = [] // { role:'user'|'assistant', content }（content 为 string 或 OpenAI 多模态数组）
  let streaming = null // { reqId, el, text } 流式中的气泡
  let offLocale = null
  let offEvent = null

  // —— 消息渲染 ——

  function bubble(role, text) {
    const wrap = document.createElement('div')
    wrap.className = 'ai-msg ' + (role === 'user' ? 'ai-user' : 'ai-bot')
    if (role === 'user' && Array.isArray(text)) {
      // 多模态消息：图片缩略 + 文本
      for (const part of text) {
        if (part && part.type === 'image_url' && part.image_url && part.image_url.url) {
          const img = document.createElement('img')
          img.className = 'ai-att-img'
          img.src = part.image_url.url
          img.alt = ''
          wrap.appendChild(img)
        } else if (part && part.type === 'text' && part.text) {
          const p = document.createElement('div')
          p.textContent = part.text
          wrap.appendChild(p)
        }
      }
    } else if (role === 'user') {
      wrap.textContent = text
    } else {
      wrap.innerHTML = md.render(text)
    }
    return wrap
  }

  function renderHistory() {
    msgsEl.innerHTML = ''
    for (const m of history) msgsEl.appendChild(bubble(m.role, m.content))
    // 空态提示常驻消息区末尾（buildDom 挂过一次，这里会 innerHTML 清掉，得重新挂）
    msgsEl.appendChild(emptyHint)
    emptyHint.classList.toggle('hidden', history.length > 0)
    scrollEnd()
  }

  function scrollEnd() {
    msgsEl.scrollTop = msgsEl.scrollHeight
  }

  function syncModelChip() {
    const cfg = getConfig()
    const on = aiConfigured(cfg)
    modelChip.textContent = on ? cfg.model : t('ai.notConfigured')
    modelChip.classList.toggle('off', !on)
  }

  // —— 发送 / 接收 ——

  function setStreamingUi(on) {
    sendBtn.classList.toggle('hidden', on)
    stopBtn.classList.toggle('hidden', !on)
    inputEl.disabled = on
  }

  async function send() {
    const text = inputEl.value.trim()
    if (!text || streaming) return
    const cfg = getConfig()
    if (!aiConfigured(cfg)) {
      setStatus(t('ai.needConfig'))
      openSettings()
      return
    }
    // 有附件但模型不在视觉名单里：拦下（模型不支持就发不出去，提示在附件条上）
    if (attachments.length && !modelSupportsVision(cfg.model)) {
      showAttNote(t('ai.noVision'))
      return
    }
    const userContent = attachments.length
      ? [{ type: 'text', text }, ...attachments.map((a) => ({ type: 'image_url', image_url: { url: a.dataUrl } }))]
      : text
    history.push({ role: 'user', content: userContent })
    emptyHint.classList.add('hidden')
    msgsEl.appendChild(bubble('user', userContent))
    inputEl.value = ''
    attachments = []
    renderAtt()
    autosize()

    const bot = document.createElement('div')
    bot.className = 'ai-msg ai-bot'
    bot.innerHTML = '<span class="ai-dots">' + t('ai.thinking') + '</span>'
    msgsEl.appendChild(bot)
    streaming = { reqId: nextReqId(), el: bot, text: '' }
    setStreamingUi(true)
    scrollEnd()

    const messages = []
    const ctx = getDocContext ? getDocContext() : ''
    if (ctx) messages.push({ role: 'system', content: ctx })
    // Agent 模式：让模型直接给可写进文档的内容本身（应用动作由本地收尾时执行）
    if (mode === 'agent') messages.push({ role: 'system', content: t('ai.agentHint') })
    messages.push(...history)
    try {
      await aiChatStream({
        reqId: streaming.reqId,
        messages,
        baseUrl: cfg.baseUrl,
        apiKey: cfg.apiKey,
        model: cfg.model,
      })
    } catch (e) {
      finishError((e && e.message) || String(e))
    }
  }

  function stop() {
    if (!streaming) return
    aiChatCancel(streaming.reqId).catch(() => {})
    // Rust 侧 abort 后不再有事件，这里直接按「已停止」收尾（半截回答保留，可继续追问）
    finishDone(true)
  }

  function renderStreaming() {
    streaming.el.innerHTML = md.render(streaming.text)
    scrollEnd()
  }

  function finishDone(stopped) {
    if (!streaming) return
    // Agent 锚点协议在这里统一解析（Ask 模式模型不会输出标记，解析无害）：
    // 气泡、历史、动作行都用剥掉标记后的正文，锚点只留给自动应用定位
    const { anchor, body } = parseAgentReply(streaming.text)
    history.push({ role: 'assistant', content: body })
    const el = streaming.el
    el.innerHTML = md.render(body)
    el.appendChild(assistantActions(body))
    // Agent 模式：回答完整结束才自动应用（手动停止说明用户想留半截自己处理）
    if (mode === 'agent' && !stopped && body) autoApply(body, el, anchor)
    if (stopped) {
      const tag = document.createElement('div')
      tag.className = 'ai-stopped'
      tag.textContent = t('ai.stopped')
      el.appendChild(tag)
    }
    streaming = null
    setStreamingUi(false)
    syncModelChip()
    scrollEnd()
  }

  function finishError(msg) {
    if (!streaming) return
    const el = streaming.el
    el.innerHTML = '<div class="ai-err"></div>'
    el.querySelector('.ai-err').textContent = t('ai.errRequest', { err: msg || t('ai.errUnknown') })
    streaming = null
    setStreamingUi(false)
    scrollEnd()
  }

  /** 助手气泡尾部的操作行：插入到文档 / 复制 */
  function assistantActions(text) {
    const row = document.createElement('div')
    row.className = 'ai-actions'
    const ins = document.createElement('button')
    ins.type = 'button'
    ins.className = 'nl-ks-btn'
    ins.textContent = t('ai.insertDoc')
    ins.addEventListener('click', () => {
      insertToDoc(text)
      setStatus(t('ai.inserted'))
    })
    const copy = document.createElement('button')
    copy.type = 'button'
    copy.className = 'nl-ks-btn'
    copy.textContent = t('ai.copy')
    copy.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(text)
        setStatus(t('ai.copied'))
      } catch { setStatus(t('ai.copyFail')) }
    })
    row.append(ins, copy)
    return row
  }

  /** Agent 模式收尾：按锚点（自然语言位置）或光标智能落点写进文档，结果都给一条小标签 */
  function autoApply(text, el, anchor) {
    if (!appendToDoc) return
    let res = null
    try { res = appendToDoc(text, anchor || null) } catch { res = null }
    const tag = document.createElement('div')
    const ok = !!(res && res.ok)
    tag.className = 'ai-stopped' + (ok ? ' ai-applied' : ' ai-apply-fail')
    if (ok && anchor && !res.missed) {
      tag.textContent = t(anchor.dir === 'before' ? 'ai.appliedAtBefore' : 'ai.appliedAtAfter', { where: res.where || anchor.target })
    } else if (ok && anchor && res.missed) {
      tag.textContent = t('ai.anchorMiss', { where: anchor.target })
    } else if (ok) {
      tag.textContent = t('ai.applied')
    } else {
      tag.textContent = t('ai.applyFail')
    }
    el.appendChild(tag)
    setStatus(tag.textContent)
  }

  // —— 多模态附件（图片）：选图 / 粘贴 → dataURL，发送时随 content 数组一起走 ——

  function showAttNote(msg) {
    if (!attEl) return
    attEl.innerHTML = ''
    const note = document.createElement('div')
    note.className = 'ai-att-note'
    note.textContent = msg
    attEl.appendChild(note)
    attEl.classList.remove('hidden')
    clearTimeout(showAttNote._tm)
    showAttNote._tm = setTimeout(renderAtt, 4000)
  }

  function addAttachment(dataUrl, name) {
    const cfg = getConfig()
    // 模型不在视觉名单（或未配置）就不让上传，给面板内提示
    if (!aiConfigured(cfg) || !modelSupportsVision(cfg.model)) {
      showAttNote(t('ai.noVision'))
      return
    }
    if (attachments.length >= 4) {
      showAttNote(t('ai.attMax'))
      return
    }
    attachments.push({ dataUrl, name: name || 'image' })
    renderAtt()
  }

  function renderAtt() {
    if (!attEl) return
    clearTimeout(showAttNote._tm)
    attEl.innerHTML = ''
    if (!attachments.length) {
      attEl.classList.add('hidden')
      return
    }
    attEl.classList.remove('hidden')
    attachments.forEach((a, i) => {
      const chip = document.createElement('span')
      chip.className = 'ai-att-chip'
      const img = document.createElement('img')
      img.src = a.dataUrl
      img.alt = ''
      const name = document.createElement('span')
      name.className = 'ai-att-name'
      name.textContent = a.name
      const x = document.createElement('button')
      x.type = 'button'
      x.className = 'ai-att-x'
      x.title = t('ai.removeAtt')
      x.setAttribute('aria-label', t('ai.removeAtt'))
      x.textContent = '×'
      x.addEventListener('click', () => {
        attachments.splice(i, 1)
        renderAtt()
      })
      chip.append(img, name, x)
      attEl.appendChild(chip)
    })
  }

  function readFile(file) {
    if (!file || !/^image\//.test(file.type)) return
    const fr = new FileReader()
    fr.onload = () => addAttachment(String(fr.result), file.name)
    fr.readAsDataURL(file)
  }

  // —— Ask / Agent 模式分段（品牌词不翻译，解释走悬停提示） ——

  function buildModes() {
    const wrap = document.createElement('div')
    wrap.className = 'ai-modes'
    const mk = (id, tipKey) => {
      const b = document.createElement('button')
      b.type = 'button'
      b.className = 'ai-mode' + (mode === id ? ' active' : '')
      b.textContent = id === 'ask' ? 'Ask' : 'Agent'
      b.title = t(tipKey)
      b.setAttribute('aria-pressed', mode === id ? 'true' : 'false')
      b.dataset.mode = id
      b.addEventListener('click', () => {
        if (mode === id) return
        mode = id
        try { localStorage.setItem('nl-ai-mode', id) } catch { /* 隐私模式存不上就只留会话内 */ }
        for (const p of wrap.children) {
          const on = p.dataset.mode === id
          p.classList.toggle('active', on)
          p.setAttribute('aria-pressed', on ? 'true' : 'false')
        }
      })
      return b
    }
    wrap.append(mk('ask', 'ai.modeAskTip'), mk('agent', 'ai.modeAgentTip'))
    return wrap
  }

  // —— 输入框自适应高度（2~5 行） ——

  function autosize() {
    inputEl.style.height = 'auto'
    inputEl.style.height = Math.min(120, Math.max(38, inputEl.scrollHeight)) + 'px'
  }

  // —— 静态骨架 ——

  function buildDom() {
    root.innerHTML = ''
    // 显隐归右栏独立开关（syncInspector）管，这里不碰 className——否则切语言会把面板藏掉

    const head = document.createElement('div')
    head.className = 'ai-head'
    const title = document.createElement('span')
    title.className = 'ai-head-title'
    setIcon(title, 'sparkle', t('ai.title'))
    modelChip = document.createElement('span')
    modelChip.className = 'ai-model-chip'
    const gear = document.createElement('button')
    gear.type = 'button'
    gear.className = 'ai-icon-btn'
    gear.setAttribute('data-i18n-title', 'ai.settings')
    gear.title = t('ai.settings')
    gear.setAttribute('aria-label', t('ai.settings'))
    setIcon(gear, 'sliders') // 图标钮不传第三参：setIcon 的 label 是可见文本，塞进 22px 钮里会被压成竖排字
    gear.addEventListener('click', () => openSettings())
    const clear = document.createElement('button')
    clear.type = 'button'
    clear.className = 'ai-icon-btn'
    clear.title = t('ai.clear')
    clear.setAttribute('aria-label', t('ai.clear'))
    setIcon(clear, 'eraser')
    clear.addEventListener('click', () => {
      if (streaming) stop()
      history = []
      renderHistory()
    })
    head.append(title, modelChip, gear, clear)

    msgsEl = document.createElement('div')
    msgsEl.className = 'ai-msgs'
    emptyHint = document.createElement('div')
    emptyHint.className = 'ai-empty'
    emptyHint.textContent = t('ai.emptyHint')
    msgsEl.appendChild(emptyHint)

    // 附件预览条：附图 chip / 面板内提示（模型不支持等），空时隐藏
    attEl = document.createElement('div')
    attEl.className = 'ai-att hidden'
    fileInput = document.createElement('input')
    fileInput.type = 'file'
    fileInput.accept = 'image/*'
    fileInput.multiple = true
    fileInput.hidden = true
    fileInput.addEventListener('change', () => {
      for (const f of fileInput.files || []) readFile(f)
      fileInput.value = ''
    })

    const composer = document.createElement('div')
    composer.className = 'ai-composer'
    inputEl = document.createElement('textarea')
    inputEl.className = 'ai-input'
    inputEl.rows = 1
    inputEl.placeholder = t('ai.inputPh')
    inputEl.addEventListener('input', autosize)
    inputEl.addEventListener('keydown', (e) => {
      // Enter 发送，Shift+Enter 换行（与主流 AI 面板一致）
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault()
        send()
      }
    })
    inputEl.addEventListener('paste', (e) => {
      // 粘贴截图直上附件（多模态面板惯例），文本粘贴不拦
      const items = e.clipboardData && e.clipboardData.items
      if (!items) return
      const imgs = [...items].filter((it) => it.kind === 'file' && /^image\//.test(it.type))
      if (!imgs.length) return
      e.preventDefault()
      for (const it of imgs) readFile(it.getAsFile())
    })
    const attachBtn = document.createElement('button')
    attachBtn.type = 'button'
    attachBtn.className = 'ai-icon-btn'
    attachBtn.title = t('ai.attach')
    attachBtn.setAttribute('aria-label', t('ai.attach'))
    setIcon(attachBtn, 'image')
    attachBtn.addEventListener('click', () => fileInput.click())
    sendBtn = document.createElement('button')
    sendBtn.type = 'button'
    sendBtn.className = 'ai-send'
    sendBtn.title = t('ai.send')
    sendBtn.setAttribute('aria-label', t('ai.send'))
    setIcon(sendBtn, 'arrow-up')
    sendBtn.addEventListener('click', send)
    stopBtn = document.createElement('button')
    stopBtn.type = 'button'
    stopBtn.className = 'ai-send ai-stop hidden'
    stopBtn.title = t('ai.stop')
    stopBtn.setAttribute('aria-label', t('ai.stop'))
    stopBtn.textContent = '■'
    stopBtn.addEventListener('click', stop)
    // CodeBuddy 式输入卡：输入框在上，底行左侧附图 + 模式分段、右侧圆形发送/停止（互斥同位）
    const bar = document.createElement('div')
    bar.className = 'ai-composer-bar'
    bar.append(attachBtn, buildModes(), sendBtn, stopBtn)
    composer.append(inputEl, bar)

    root.append(head, msgsEl, attEl, fileInput, composer)
    syncModelChip()
    renderHistory()
    setStreamingUi(false)
  }

  function mount() {
    buildDom()
    // 流式事件：全局一路订阅，按 reqId 分发（选区浮层有自己的订阅，互不干扰）
    offEvent = aiChatListen((ev) => {
      if (!streaming || !ev || ev.reqId !== streaming.reqId) return
      if (ev.kind === 'chunk' && ev.delta) {
        if (streaming.text === '') streaming.el.innerHTML = '' // 顶掉「思考中」占位
        streaming.text += ev.delta
        renderStreaming()
      } else if (ev.kind === 'done') {
        finishDone(false)
      } else if (ev.kind === 'error') {
        finishError(ev.error)
      }
    })
    offLocale = onLocaleChange(() => {
      buildDom()
    })
  }

  mount()
  return {
    /** 侧栏切到本页签时让输入框可键入 */
    focus() {
      if (inputEl && !streaming) inputEl.focus()
    },
    destroy() {
      if (offEvent) offEvent()
      if (offLocale) offLocale()
      if (streaming) aiChatCancel(streaming.reqId).catch(() => {})
    },
  }
}
