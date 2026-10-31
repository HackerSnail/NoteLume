// ai-panel.js —— 侧栏「AI」页签：针对当前文档的对话面板
//
// 每轮把「当前文档上下文（系统消息）+ 全部历史」发给 Rust 代理的 OpenAI 兼容接口，
// 增量经 nl:ai-event 事件流回，实时渲染进最后一个气泡。历史只存内存（换文档不清，
// 主动「清空」才清）；配置缺失时给引导，不弹窗打断。
// 渲染用独立 markdown-it 实例：html:false（模型输出里的字面 HTML 一律转义，天然防注入），
// 开 table / strikethrough 与正文渲染观感一致。

import { t, onLocaleChange, getLocale } from './i18n.js'
import { setIcon } from './icons.js'
import MarkdownIt from 'markdown-it'
import { aiChatStream, aiChatCancel, aiChatListen } from './tauri-bridge.js'
import { aiConfigured, stripFences, parseAgentReply, modelSupportsVision, buildTaskMessages } from './ai-tasks.js'

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
  let optBtn = null // 「AI 优化输入」按钮（流式润色回填）
  let voiceBtn = null // 语音输入按钮（Web Speech API，环境不支持则置灰）
  let modelChip = null
  let emptyHint = null
  let attEl = null // 附件预览条（附图 chip 列表，空时隐藏）
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

  // —— AI 优化输入：把输入框草稿交给模型流式润色，结果实时回填（再点一次取消） ——

  let optStreaming = null // { reqId, base } 流式优化中的状态

  function toggleOptimize() {
    if (optStreaming) {
      aiChatCancel(optStreaming.reqId).catch(() => {})
      inputEl.value = optStreaming.base // 取消恢复原文
      optStreaming = null
      optBtn.classList.remove('active')
      autosize()
      return
    }
    const text = inputEl.value.trim()
    if (!text) {
      setStatus(t('ai.optimizeEmpty'))
      return
    }
    const cfg = getConfig()
    if (!aiConfigured(cfg)) {
      setStatus(t('ai.needConfig'))
      openSettings()
      return
    }
    const msgs = buildTaskMessages('polish', text, '') // 复用润色任务的提示词（只回结果、保语言、保结构）
    optStreaming = { reqId: nextReqId(), base: inputEl.value }
    inputEl.value = ''
    optBtn.classList.add('active')
    autosize()
    aiChatStream({
      reqId: optStreaming.reqId,
      messages: [
        { role: 'system', content: msgs.system },
        { role: 'user', content: msgs.user },
      ],
      baseUrl: cfg.baseUrl,
      apiKey: cfg.apiKey,
      model: cfg.model,
    }).catch((e) => {
      if (optStreaming) inputEl.value = optStreaming.base
      optStreaming = null
      optBtn.classList.remove('active')
      setStatus(t('ai.errRequest', { err: (e && e.message) || String(e) }))
    })
  }

  // —— 语音输入（Web Speech API）：识别文本实时追加进输入框；环境不支持则按钮置灰 ——

  let rec = null // SpeechRecognition 实例
  let listening = false

  function voiceSupported() {
    return !!(window.SpeechRecognition || window.webkitSpeechRecognition)
  }

  function voiceLang() {
    const loc = getLocale()
    return loc === 'zh-Hant' ? 'zh-TW' : (loc || 'zh-CN')
  }

  function toggleVoice() {
    if (listening) {
      if (rec) rec.stop() // onend 收尾
      return
    }
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition
    if (!SR) {
      setStatus(t('ai.voiceNo'))
      return
    }
    rec = new SR()
    rec.lang = voiceLang()
    rec.interimResults = true
    rec.continuous = true
    let committed = inputEl.value // 已定稿文本（final 逐段追加）
    rec.onresult = (e) => {
      let final = ''
      let interim = ''
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const txt = e.results[i][0].transcript
        if (e.results[i].isFinal) final += txt
        else interim += txt
      }
      if (final) committed = (committed ? committed + ' ' : '') + final.trim()
      inputEl.value = committed + (interim ? (committed ? ' ' : '') + interim : '')
      autosize()
      inputEl.focus()
    }
    rec.onend = () => {
      listening = false
      rec = null
      if (voiceBtn) voiceBtn.classList.remove('active')
    }
    rec.onerror = (e) => {
      if (e.error !== 'aborted' && e.error !== 'no-speech') setStatus(t('ai.voiceFail'))
    }
    listening = true
    voiceBtn.classList.add('active')
    try {
      rec.start()
    } catch {
      listening = false
      voiceBtn.classList.remove('active')
    }
  }

  // —— Ask / Agent 模式切换菜单（CodeBuddy 式 pill ▾ 下拉；品牌词不翻译，解释走项悬停提示） ——

  let modeMenuEl = null
  let modePillEl = null

  function closeModeMenu() {
    if (modeMenuEl) {
      modeMenuEl.remove()
      modeMenuEl = null
    }
    document.removeEventListener('click', onDocClick, true)
    document.removeEventListener('keydown', onMenuEsc, true)
  }

  function onDocClick(e) {
    if (modeMenuEl && !modeMenuEl.contains(e.target) && !(modePillEl && modePillEl.contains(e.target))) closeModeMenu()
  }

  function onMenuEsc(e) {
    if (e.key === 'Escape') closeModeMenu()
  }

  function buildModeMenu() {
    const wrap = document.createElement('span')
    wrap.className = 'ai-mode-wrap'
    const pill = document.createElement('button')
    pill.type = 'button'
    pill.className = 'ai-mode-pill'
    const label = document.createElement('span')
    const chev = document.createElement('span')
    chev.className = 'ai-mode-chev'
    setIcon(chev, 'chevron-down')
    const syncPill = () => {
      label.textContent = mode === 'ask' ? 'Ask' : 'Agent'
      pill.title = t(mode === 'ask' ? 'ai.modeAskTip' : 'ai.modeAgentTip')
      pill.setAttribute('aria-expanded', modeMenuEl ? 'true' : 'false')
    }
    pill.append(label, chev)
    const openMenu = () => {
      const menu = document.createElement('div')
      menu.className = 'ai-mode-menu'
      const mk = (id, tipKey) => {
        const item = document.createElement('button')
        item.type = 'button'
        item.className = 'ai-mode-item' + (mode === id ? ' active' : '')
        const mark = document.createElement('span')
        mark.className = 'ai-mode-mark'
        if (mode === id) setIcon(mark, 'check')
        const name = document.createElement('span')
        name.textContent = id === 'ask' ? 'Ask' : 'Agent'
        item.title = t(tipKey)
        item.append(mark, name)
        item.addEventListener('click', (e) => {
          e.stopPropagation()
          if (mode !== id) {
            mode = id
            try { localStorage.setItem('nl-ai-mode', id) } catch { /* 存不上就只留会话内 */ }
          }
          closeModeMenu()
          syncPill()
        })
        return item
      }
      menu.append(mk('ask', 'ai.modeAskTip'), mk('agent', 'ai.modeAgentTip'))
      // 面板贴底：往上弹
      const r = pill.getBoundingClientRect()
      menu.style.left = Math.max(4, r.left) + 'px'
      menu.style.top = Math.max(4, r.top - 8) + 'px'
      menu.style.transform = 'translateY(-100%)'
      document.body.appendChild(menu)
      modeMenuEl = menu
      modePillEl = pill
      syncPill()
      document.addEventListener('click', onDocClick, true)
      document.addEventListener('keydown', onMenuEsc, true)
    }
    pill.addEventListener('click', (e) => {
      e.stopPropagation()
      if (modeMenuEl) closeModeMenu()
      else openMenu()
    })
    syncPill()
    wrap.append(pill)
    return wrap
  }

  // —— 输入框自适应高度（提示词条完整可见：下限 64px 约两行） ——

  function autosize() {
    inputEl.style.height = 'auto'
    inputEl.style.height = Math.min(140, Math.max(64, inputEl.scrollHeight)) + 'px'
  }

  // —— 静态骨架 ——

  function buildDom() {
    closeModeMenu() // 语言切换重建 DOM 时清掉可能挂着的模式菜单
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
      if (optStreaming) {
        aiChatCancel(optStreaming.reqId).catch(() => {})
        optStreaming = null
        optBtn.classList.remove('active')
      }
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

    // 附件预览条：附图 chip / 面板内提示（模型不支持等），空时隐藏；只收粘贴上传
    attEl = document.createElement('div')
    attEl.className = 'ai-att hidden'

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
    // 底行：左侧模式菜单 + AI 优化输入 + 语音输入，右侧圆形发送/停止（互斥同位）；图片只收粘贴
    optBtn = document.createElement('button')
    optBtn.type = 'button'
    optBtn.className = 'ai-icon-btn'
    optBtn.title = t('ai.optimize')
    optBtn.setAttribute('aria-label', t('ai.optimize'))
    setIcon(optBtn, 'pen')
    optBtn.addEventListener('click', toggleOptimize)
    voiceBtn = document.createElement('button')
    voiceBtn.type = 'button'
    voiceBtn.className = 'ai-icon-btn'
    voiceBtn.title = t('ai.voice')
    voiceBtn.setAttribute('aria-label', t('ai.voice'))
    setIcon(voiceBtn, 'mic')
    if (!voiceSupported()) voiceBtn.disabled = true // 无语音引擎的环境（如无头/部分 WebView）置灰
    voiceBtn.addEventListener('click', toggleVoice)
    const bar = document.createElement('div')
    bar.className = 'ai-composer-bar'
    bar.append(buildModeMenu(), optBtn, voiceBtn, sendBtn, stopBtn)
    composer.append(inputEl, bar)

    root.append(head, msgsEl, attEl, composer)
    syncModelChip()
    renderHistory()
    setStreamingUi(false)
  }

  function mount() {
    buildDom()
    // 流式事件：全局一路订阅，按 reqId 分发（选区浮层有自己的订阅，互不干扰）
    offEvent = aiChatListen((ev) => {
      // 输入优化流先分发（独立 reqId，不进对话）
      if (optStreaming && ev && ev.reqId === optStreaming.reqId) {
        if (ev.kind === 'chunk' && ev.delta) {
          inputEl.value += ev.delta
          autosize()
        } else if (ev.kind === 'done') {
          optStreaming = null
          optBtn.classList.remove('active')
        } else if (ev.kind === 'error') {
          inputEl.value = optStreaming.base
          optStreaming = null
          optBtn.classList.remove('active')
          setStatus(t('ai.errRequest', { err: ev.error || t('ai.errUnknown') }))
        }
        return
      }
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
