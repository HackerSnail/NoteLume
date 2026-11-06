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
import { aiChatStream, aiChatCancel, aiChatListen, aiSkillsScan, aiModelsList, aiChatSave, aiChatRead, aiRecStart, aiRecStop, aiRecCancel, aiAsrTranscribe, aiDictationStart, aiDictationStop, aiDictationProbe, aiDictationListen } from './tauri-bridge.js'
import { aiConfigured, stripFences, parseAgentReply, stripInsertMarkers, isPlaceholderReply, modelSupportsVision, buildTaskMessages, aiQueryTerms, estimateTokens, aiContextWindow, chatModelsOnly, AI_MAX_IMAGES, supportsToolCalling, voicePath, dictationDoneInfo, dictationAudioInfo, shouldResumeDictation, DICT_SESSION_MAX_MS } from './ai-tasks.js'
import { runAgentLoop, pickTools, summarizeToolArgs, repairHangingToolCalls } from './ai-agent.js'

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
 * @param {(question: string) => Promise<string>} [deps.getVaultContext] 全库检索上下文（有知识库时按问题分词查索引，无库回 ''）
 * @param {(text: string) => void} deps.insertToDoc 把一段文本插入当前文档光标处
 * @param {(text: string, anchor?: {dir:'after'|'before', target:string}|null) => {ok:boolean, where?:string, missed?:boolean}|boolean} [deps.appendToDoc]
 *   Agent 模式收尾时把回答写进当前文档：有锚点先按 resolveAnchorPos 定位（未命中回退光标落点并标 missed）
 * @param {(msg: string) => void} deps.setStatus
 * @param {() => object} [deps.getOllamaStatus] 本机 Ollama 探测结果（{ state, models, toolModels, hasCaps }），Agent 能力门控用；没有就当拿不到信号
 * @param {boolean} [deps.voiceUiHidden] 语音入口是否藏掉。默认桌面版（三个平台）全藏、纯网页预览留着；
 *   留这一格是给语音状态机的测试接缝——藏了入口也要能按桌面那条路（走 IPC）测下去
 */
export function createAiPanel(deps) {
  const { root, getConfig, openSettings, getDocContext, getVaultContext, getVaultRootForChat, insertToDoc, appendToDoc, persistModel, setStatus, execTool, vaultReady, revertAgentEdit, canRevertAgentEdit, streamRequest, getRevertDoc, getOllamaStatus, voiceUiHidden } = deps
  const md = MarkdownIt('commonmark', { html: false, linkify: true, breaks: true })
    .enable(['table', 'strikethrough'])

  let msgsEl = null // 消息滚动区
  let inputEl = null
  let sendBtn = null
  let stopBtn = null
  let optBtn = null // 「AI 优化输入」按钮（流式润色回填）
  let voiceBtn = null // 语音输入按钮（桌面走 Rust 录音 + 服务商 ASR / 原生听写，浏览器走 Web Speech）
  let skillBtn = null // 技能按钮（自动探测本机 AI skills，选中后注入对话）
  let skillChips = null // 选中技能的回显 chip 行（composer 内 textarea 上方，可多个、可删）
  let skills = [] // 探测到的技能 [{id,name,description,source,path,content}]
  let skillsLoaded = false
  // 选中的技能（多选）：nl-ai-skill 兼容旧单值字符串——数组存新档，字符串视为单元素
  let activeSkillPaths = (() => {
    try {
      const v = JSON.parse(localStorage.getItem('nl-ai-skill'))
      if (Array.isArray(v)) return v.filter((x) => typeof x === 'string')
      if (typeof v === 'string' && v) return [v]
    } catch {
      try {
        const v0 = localStorage.getItem('nl-ai-skill')
        if (v0) return [v0]
      } catch { /* 无 localStorage 就只留会话内 */ }
    }
    return []
  })()

  function saveActiveSkills() {
    try { localStorage.setItem('nl-ai-skill', JSON.stringify(activeSkillPaths)) } catch { /* 存不上只留会话内 */ }
  }

  function syncSkillBtn() {
    if (skillBtn) skillBtn.classList.toggle('active', activeSkillPaths.length > 0)
  }

  // 技能是一次性上下文：随这条消息发出后即消费掉（与附件同口径），下一条不再自动带上
  function consumeSkills() {
    if (!activeSkillPaths.length) return
    activeSkillPaths = []
    saveActiveSkills()
    syncSkillBtn()
    renderSkillChips()
    updateCtxRing()
  }

  // 技能发送即从 composer 消费，但要在发出的用户消息上留痕（用了哪些技能），否则回退会话后看不出
  function appendSkillEcho(bubbleEl, names) {
    if (!bubbleEl || !names || !names.length) return
    const echo = document.createElement('div')
    echo.className = 'ai-skill-echo'
    const ic = document.createElement('span')
    ic.className = 'ai-skill-echo-ic'
    setIcon(ic, 'box')
    const tx = document.createElement('span')
    tx.className = 'ai-skill-echo-tx'
    tx.textContent = t('ai.skillEcho', { names: names.join('、') })
    echo.append(ic, tx)
    bubbleEl.insertBefore(echo, bubbleEl.firstChild) // 放消息顶部，像给这条消息打的标签
  }
  let modelPill = null // 底行模型选择器：多模型可下拉切换，单模型/未拉到列表只显示名称
  let modelsCache = { key: '', items: [] } // /models 拉取缓存（key = baseUrl）
  let emptyHint = null
  let attEl = null // 附件预览条（附图 chip 列表，空时隐藏）
  let attachments = [] // 待发送图片 [{ dataUrl, name }]，随消息一起发出后清空
  let history = [] // { role:'user'|'assistant', content }（content 为 string 或 OpenAI 多模态数组）
  let streaming = null // { reqId, el, text } 流式中的气泡（Agent 循环时 reqId 随轮次更新）
  // Agent 工具循环运行态：多轮流式请求共用一个气泡，事件按 agentReq.reqId 分发
  let agentActive = false
  let agentUsesTools = true // 本轮 Agent 是否走工具循环；能力门控判出不支持时置 false，收尾不自动写文档
  let agentReq = null // { reqId, resolve, reject, text } 等待中的一轮流式请求
  let agentStopFlag = false
  let agentOnDelta = () => {}
  let lastRevertRecord = null // 最近一次 autoApply 的回退记录（pos 是会话内坐标）
  let liveRevertEl = null //  live 标签元素（撤销钮所在标签）；重建消息区后 isConnected 为假，快照行据此恢复

  // —— 回退记录跨重启持久化（localStorage nl-ai-revert）——
  // 自动写入带回退记录，写入时存一份；重开面板 / 重启应用后按「root + rel」认
  // 同一文档，并经 canRevertAgentEdit 校验区间内容与记录一致才放开按钮——
  // 用户中途改过那段，或开了别的文档时，按钮置灰或干脆不出现
  let restoreRevertEl = null
  const normIdPath = (p) => String(p || '').replace(/[\\/]+$/, '').toLowerCase()
  function revertDocId() {
    try {
      const id = typeof getRevertDoc === 'function' ? getRevertDoc() : null
      if (!id || typeof id !== 'object') return null
      return { root: String(id.root || ''), file: String(id.file || '') }
    } catch { return null }
  }
  function persistRevert(record) {
    const id = revertDocId()
    if (!id || !id.file) return
    try {
      localStorage.setItem('nl-ai-revert', JSON.stringify({ v: 1, root: id.root, file: id.file, record, ts: Date.now() }))
    } catch { /* 存不上就只留会话内 */ }
  }
  function clearPersistedRevert() {
    try { localStorage.removeItem('nl-ai-revert') } catch { /* 忽略 */ }
  }
  function readPersistedRevert() {
    try {
      const raw = localStorage.getItem('nl-ai-revert')
      if (!raw) return null
      const d = JSON.parse(raw)
      if (!d || d.v !== 1 || !d.record) return null
      const { from, to, md, prev } = d.record
      if (!Number.isInteger(from) || !Number.isInteger(to)) return null
      if (typeof md !== 'string' || typeof prev !== 'string') return null
      return d
    } catch { return null }
  }
  function clearRestoredRevert() {
    if (restoreRevertEl) { restoreRevertEl.remove(); restoreRevertEl = null }
  }
  function syncRestoredRevert() {
    clearRestoredRevert()
    if (typeof revertAgentEdit !== 'function') return
    // 会话里刚自动写入过且 live 标签还挂在消息区时（lastRevertRecord 非空、按钮仍在），
    // 不重复出第二个入口；消息区重建后标签已离线，快照行照常恢复
    if (liveRevertEl && liveRevertEl.isConnected) return
    if (streaming || agentActive) return
    const saved = readPersistedRevert()
    if (!saved) { clearPersistedRevert(); return } // 坏记录清掉
    const id = revertDocId()
    if (!id) return
    if (normIdPath(id.root) !== normIdPath(saved.root) || String(id.file).toLowerCase() !== String(saved.file).toLowerCase()) {
      return // 不是同一文档：不显示
    }
    const can = typeof canRevertAgentEdit === 'function' ? !!canRevertAgentEdit(saved.record) : false
    const el = document.createElement('div')
    el.className = 'ai-stopped ai-applied ai-restored'
    el.textContent = t('ai.restoreRevert')
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'nl-ks-btn ai-revert-btn'
    btn.textContent = t('ai.revert')
    btn.disabled = !can
    btn.title = can ? t('ai.revert') : t('ai.revertGone')
    btn.addEventListener('click', () => {
      if (!revertAgentEdit(saved.record)) {
        btn.disabled = true
        btn.title = t('ai.revertGone')
        return
      }
      clearPersistedRevert()
      el.textContent = t('ai.reverted')
      btn.remove()
      setStatus(t('ai.reverted'))
    })
    el.appendChild(btn)
    msgsEl.appendChild(el)
    restoreRevertEl = el
  }
  let offLocale = null
  let offEvent = null
  let eventStreamDisposed = false // 面板销毁先于订阅 resolve 时，挂上即退订

  // —— 消息渲染 ——

  /** 推理模型的「思考过程」折叠块：流式中展开；结束后默认收起（仅思考无正文时保持展开） */
  function reasoningBlock(text, live) {
    const details = document.createElement('details')
    details.className = 'ai-reasoning'
    if (live) details.open = true
    const sum = document.createElement('summary')
    setIcon(sum, 'lightbulb', t('ai.reasoning'))
    const body = document.createElement('div')
    body.className = 'ai-reasoning-body'
    body.textContent = text
    details.append(sum, body)
    return details
  }

  /**
   * 绘制助手气泡内容：思考块在上，正文在下。
   * 正文为空时给可读兜底（有思考 → reasoningOnly，连思考都没有 → emptyReply），
   * 不再留下一个什么都没有的空气泡。live = 仍在流式中，此时不画兜底提示。
   * 只吐一个占位标记（`<empty>` 之类）同样算没有正文：流式途中就不把它当答案画出来，
   * 免得收尾前闪一记伪回答。
   */
  function paintAssistant(el, body, reasoning, live) {
    el.innerHTML = ''
    const hasReasoning = !!(reasoning && String(reasoning).trim())
    const hasBody = !!(body && String(body).trim()) && !isPlaceholderReply(body)
    if (hasReasoning) el.appendChild(reasoningBlock(String(reasoning), live || !hasBody))
    if (hasBody) {
      const ans = document.createElement('div')
      ans.className = 'ai-answer'
      ans.innerHTML = md.render(String(body))
      el.appendChild(ans)
    } else if (!live) {
      const note = document.createElement('div')
      note.className = 'ai-note'
      note.textContent = hasReasoning ? t('ai.reasoningOnly') : t('ai.emptyReply')
      el.appendChild(note)
    }
    return { hasReasoning, hasBody }
  }

  function bubble(role, text, reasoning) {
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
      paintAssistant(wrap, text, reasoning, false)
    }
    return wrap
  }

  // 发给 API 的消息剥掉本地元字段（用户消息的 _skills 技能回显、助手消息的 _reasoning
  // 思考过程），只留协议字段——严格的服务端会因多余字段 400；这些只进 history / 存档 /
  // 渲染，不进请求体（思考过程回灌也没有意义）。
  const apiMsg = (m) => {
    if (!m || (!m._skills && !m._reasoning)) return m
    const { _skills, _reasoning, ...rest } = m
    return rest
  }

  function renderHistory() {
    msgsEl.innerHTML = ''
    // 重放：assistant.tool_calls 与其后的 role:'tool' 消息重放成工具行，
    // 只有工具调用没有文本的 assistant 不出空气泡（与实时链路同一规则）
    const toolResults = new Map()
    for (const m of history) {
      if (m && m.role === 'tool' && m.tool_call_id) toolResults.set(m.tool_call_id, String(m.content ?? ''))
    }
    for (const m of history) {
      if (m && m.role === 'tool') continue
      if (m && m.role === 'assistant' && Array.isArray(m.tool_calls)) {
        for (const c of m.tool_calls) {
          if (!c || !c.id) continue
          const name = (c.function && c.function.name) || '?'
          msgsEl.appendChild(toolRowEl(name, summarizeToolArgs(name, c.function && c.function.arguments), 'done', toolResults.get(c.id) || ''))
        }
        if (m.content || m._reasoning) msgsEl.appendChild(bubble('assistant', m.content || '', m._reasoning))
        continue
      }
      const b = bubble(m.role, m.content, m.role === 'assistant' ? m._reasoning : undefined)
      // 用户消息上的技能回显：_skills 存在档里，恢复会话时一并渲染（发送即消费芯片已消失）
      if (m && m.role === 'user' && Array.isArray(m._skills) && m._skills.length) appendSkillEcho(b, m._skills)
      msgsEl.appendChild(b)
    }
    // 空态提示常驻消息区末尾（buildDom 挂过一次，这里会 innerHTML 清掉，得重新挂）
    msgsEl.appendChild(emptyHint)
    emptyHint.classList.toggle('hidden', history.length > 0)
    // 恢复「撤销上次自动写入」入口：每次重建消息区都按当前文档 identity + canRevert 校验一遍
    syncRestoredRevert()
    scrollEnd()
  }

  /** 工具行小条目：工具名 + 参数摘要 + 状态；点击展开结果文本（可复制） */
  function toolRowEl(name, argsSummary, state, result) {
    const row = document.createElement('div')
    row.className = 'ai-tool-row ' + state
    const lab = document.createElement('span')
    lab.className = 'ai-tool-name'
    lab.textContent = name
    const args = document.createElement('span')
    args.className = 'ai-tool-args'
    args.textContent = argsSummary || ''
    const st = document.createElement('span')
    st.className = 'ai-tool-state'
    st.textContent = state === 'running' ? t('ai.toolRunning') : state === 'fail' ? t('ai.toolFail') : t('ai.toolDone')
    const pre = document.createElement('pre')
    pre.className = 'ai-tool-result hidden'
    pre.textContent = result || ''
    row.append(lab, args, st, pre)
    row._result = result || ''
    row.addEventListener('click', () => {
      pre.textContent = row._result || pre.textContent || ''
      pre.classList.toggle('hidden')
      row.classList.toggle('open')
    })
    return row
  }

  function scrollEnd() {
    msgsEl.scrollTop = msgsEl.scrollHeight
  }

  function syncModelChip() {
    const cfg = getConfig()
    const on = aiConfigured(cfg)
    if (!modelPill) return
    modelPill.classList.toggle('off', !on)
    const label = modelPill.querySelector('.ai-model-label')
    if (label) label.textContent = on ? cfg.model : t('ai.notConfigured')
    const multi = modelsCache.key === cfg.baseUrl && modelsCache.items.length > 1
    const chev = modelPill.querySelector('.ai-model-chev')
    if (chev) chev.classList.toggle('hidden', !multi)
  }

  /** 模型选择菜单：首次点击拉 /models（按 baseUrl 缓存）；≤1 个模型不出菜单 */
  async function toggleModelsMenu() {
    if (floatMenuOpenFor(modelPill)) {
      closeFloatMenu()
      return
    }
    const cfg = getConfig()
    if (!aiConfigured(cfg)) {
      setStatus(t('ai.needConfig'))
      openSettings()
      return
    }
    if (modelsCache.key !== cfg.baseUrl) {
      try {
        const r = await aiModelsList(cfg.baseUrl, cfg.apiKey)
        // 与设置面板同一口径：/models 里的向量 / 重排 / 文生图模型不能对话，不混进切换菜单
        modelsCache = { key: cfg.baseUrl, items: chatModelsOnly(r) }
      } catch (e) {
        setStatus(t('ai.modelsFail', { err: (e && e.message) || String(e) }))
        return
      }
    }
    syncModelChip()
    if (modelsCache.items.length <= 1) return // 单模型：只显示名称，无可切
    const menu = document.createElement('div')
    menu.className = 'ai-mode-menu ai-model-menu'
    for (const id of modelsCache.items) {
      const item = document.createElement('button')
      item.type = 'button'
      item.className = 'ai-mode-item' + (id === cfg.model ? ' active' : '')
      const mark = document.createElement('span')
      mark.className = 'ai-mode-mark'
      if (id === cfg.model) setIcon(mark, 'check')
      const name = document.createElement('span')
      name.textContent = id
      item.append(mark, name)
      item.title = id
      item.addEventListener('click', (e) => {
        e.stopPropagation()
        if (typeof persistModel === 'function') persistModel(id)
        closeFloatMenu()
        syncModelChip()
        setStatus(t('ai.modelSet', { name: id }))
      })
      menu.appendChild(item)
    }
    openFloatMenu(modelPill, menu)
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
    const userMsg = { role: 'user', content: userContent }
    history.push(userMsg)
    emptyHint.classList.add('hidden')
    const userBubble = bubble('user', userContent)
    msgsEl.appendChild(userBubble)
    inputEl.value = ''
    attachments = []
    renderAtt()
    autosize()
    updateCtxRing()

    const bot = document.createElement('div')
    bot.className = 'ai-msg ai-bot'
    bot.innerHTML = '<span class="ai-dots">' + t('ai.thinking') + '</span>'
    msgsEl.appendChild(bot)
    streaming = { reqId: nextReqId(), el: bot, text: '', reasoning: '' }
    setStreamingUi(true)
    scrollEnd()

    // Agent 模式走工具循环：模型多轮调用只读工具后给最终回答。
    // 一次性全库检索注入跳过——检索交给 search_vault 工具按需多轮做，Ask 模式保留。
    if (mode === 'agent') {
      runAgentFlow(userBubble, userMsg)
      return
    }

    const messages = []
    const ctx = getDocContext ? getDocContext() : ''
    if (ctx) messages.push({ role: 'system', content: ctx })
    // 选中的本机技能（可多个）：每条 SKILL.md 指引各作一条 system 消息（扫描未完成时视为无）
    if (skillsLoaded) {
      const used = []
      for (const p of activeSkillPaths) {
        const skill = skills.find((s) => s.path === p)
        if (skill && skill.content) {
          messages.push({ role: 'system', content: t('ai.skillInject', { name: skill.name }) + '\n\n' + skill.content })
          used.push(skill.name)
        }
      }
      consumeSkills() // 发出即消费：技能只作用于这一条消息，发完清空 chip
      appendSkillEcho(userBubble, used) // 消息上回显用了哪些技能
      if (used.length) userMsg._skills = used // 记进 history，随存档持久化（重启后仍回显）
    }
    // Agent 模式的提示词在 runAgentFlow 里注入（本函数在 mode === 'agent' 时已提前返回）
    // 全库检索：有知识库时按问题分词查索引注入相关片段；无知识库回 ''（只带当前文档上下文）
    if (typeof getVaultContext === 'function') {
      try {
        const vctx = await getVaultContext(text)
        if (vctx) messages.push({ role: 'system', content: vctx })
      } catch { /* 检索失败不阻断对话 */ }
    }
    messages.push(...history.map(apiMsg))
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
    // Agent 工具循环：置停旗 + 取消在跑的请求，并当场以 cancelled 收掉等待中的
    // streamRequest（Rust abort 后不再有事件，不能挂起等 done）
    if (agentActive) {
      agentStopFlag = true
      if (agentReq) {
        aiChatCancel(agentReq.reqId).catch(() => {})
        const a = agentReq
        agentReq = null
        a.resolve({ text: a.text, cancelled: true })
      }
      return
    }
    if (!streaming) return
    aiChatCancel(streaming.reqId).catch(() => {})
    // Rust 侧 abort 后不再有事件，这里直接按「已停止」收尾（半截回答保留，可继续追问）
    finishDone(true)
  }

  function renderStreaming() {
    // 流式过程中实时剥掉落点标记：模型重复输出 <insert…> 时用户不必盯着标记看
    paintAssistant(streaming.el, stripInsertMarkers(streaming.text), streaming.reasoning, true)
    scrollEnd()
  }

  // —— Agent 工具循环链路 ——

  /** 一轮流式请求。测试接缝：deps.streamRequest 提供时直接委托（不打 Rust 事件通道） */
  function agentStreamRequest(messages, tools) {
    if (typeof streamRequest === 'function') return streamRequest(messages, tools)
    return new Promise((resolve, reject) => {
      const cfg = getConfig()
      const reqId = nextReqId()
      if (streaming) streaming.reqId = reqId
      agentReq = { reqId, resolve, reject, text: '' }
      aiChatStream({
        reqId,
        messages,
        tools,
        baseUrl: cfg.baseUrl,
        apiKey: cfg.apiKey,
        model: cfg.model,
      }).catch((e) => {
        if (agentReq && agentReq.reqId === reqId) {
          agentReq = null
          reject(e)
        }
      })
    })
  }

  async function runAgentFlow(userBubble, userMsg) {
    agentActive = true
    agentStopFlag = false
    // 能力门控：本机 Ollama 的 /api/tags 带 capabilities，明确不支持工具的模型不再发 tools，
    // 也不再自动写文档（降级成「只给建议」）；拿不到信号（远程服务、旧版 Ollama、模型不在列表）
    // 按现状走工具循环，不猜
    const cap = supportsToolCalling(getConfig(), typeof getOllamaStatus === 'function' ? getOllamaStatus() : null)
    agentUsesTools = cap !== false
    const rows = []
    let currentRow = null
    const base = []
    const ctx = getDocContext ? getDocContext() : ''
    if (ctx) base.push({ role: 'system', content: ctx })
    if (skillsLoaded) {
      const used = []
      for (const p of activeSkillPaths) {
        const skill = skills.find((s) => s.path === p)
        if (skill && skill.content) {
          base.push({ role: 'system', content: t('ai.skillInject', { name: skill.name }) + '\n\n' + skill.content })
          used.push(skill.name)
        }
      }
      consumeSkills() // 发出即消费：技能只作用于本轮，发完清空 chip（与 Ask 模式同口径）
      appendSkillEcho(userBubble, used) // 消息上回显用了哪些技能
      if (used.length) userMsg._skills = used // 记进 history，随存档持久化（重启后仍回显）
    }
    base.push({ role: 'system', content: agentUsesTools ? t('ai.agentHint') : t('ai.suggestHint') })
    // 循环返回的 seq = 系统前缀 + history + 本轮新增；newMsgs 的切片起点必须是
    // history 的结束位置。只记前缀长度会把旧历史当本轮新增二次追加（历史整段翻倍）
    base.push(...history.map(apiMsg))
    const histEnd = base.length
    const tools = agentUsesTools
      ? pickTools({ vaultReady: typeof vaultReady === 'function' ? !!vaultReady() : false })
      : []
    try {
      const res = await runAgentLoop({
        messages: base,
        tools,
        streamRequest: (messages) => agentStreamRequest(messages, tools),
        execTool: async (name, args) => {
          const content = typeof execTool === 'function' ? await execTool(name, args) : '{"error":"tools unavailable"}'
          if (currentRow) currentRow._result = String(content)
          return content
        },
        onDelta: (chunk) => {
          agentOnDelta(chunk)
        },
        onTool: (name, argsSummary, st) => {
          if (st === 'running') {
            currentRow = toolRowEl(name, argsSummary, 'running', '')
            rows.push(currentRow)
            if (streaming) msgsEl.insertBefore(currentRow, streaming.el)
            scrollEnd()
          } else if (currentRow) {
            currentRow.classList.remove('running')
            currentRow.classList.add(st === 'fail' ? 'fail' : 'done')
            currentRow.querySelector('.ai-tool-state').textContent = st === 'fail' ? t('ai.toolFail') : t('ai.toolDone')
          }
        },
        shouldStop: () => agentStopFlag,
      })
      finishAgent(res, histEnd)
    } catch (e) {
      finishError((e && e.message) || String(e), t('ai.noToolsTip'))
    } finally {
      agentActive = false
      agentReq = null
    }
  }

  function finishAgent(res, histEnd) {
    if (!streaming) return
    const el = streaming.el
    if (res.error) {
      finishError(res.error, t('ai.noToolsTip'))
      return
    }
    // 采纳循环推进的消息（assistant / tool）进历史；起点取 seq 里 history 段之后，
    // 否则旧历史会被重复追加；最后一段助手文本剥掉锚点标记再存
    const newMsgs = (res.messages || []).slice(histEnd)
    const finalText = String(res.text || '')
    const { anchor, body } = parseAgentReply(finalText)
    const reasoning = String(streaming.reasoning || '')
    let lastAssistant = null
    for (let i = newMsgs.length - 1; i >= 0; i--) {
      const m = newMsgs[i]
      if (m && m.role === 'assistant' && !m.tool_calls) {
        m.content = body
        lastAssistant = m
        break
      }
    }
    if (lastAssistant && reasoning.trim()) lastAssistant._reasoning = reasoning
    history.push(...newMsgs)
    // 气泡显示 = 多轮流式文本的拼接（中间轮的「让我查一下…」保留），末段剥锚点标记；
    // 全局再剥一遍：模型在循环里重复吐出的 <insert…> / </insert> 残留一律不进气泡、不进文档
    const prefixLen = streaming.text.length - finalText.length
    const shown = stripInsertMarkers((prefixLen > 0 ? streaming.text.slice(0, prefixLen) : '') + body).trim()
    paintAssistant(el, shown.trim(), reasoning, false)
    // 降级成本轮不自动应用：先给一句为什么，再给操作行（没写进文档，「插入到文档」得留着）
    if (!agentUsesTools) {
      const note = document.createElement('div')
      note.className = 'ai-note'
      note.textContent = t('ai.suggestOnly')
      el.appendChild(note)
    }
    const acts = body ? assistantActions(body) : null
    if (acts) el.appendChild(acts)
    // Agent 模式：回答完整结束才自动应用（手动停止说明用户想留半截自己处理）；
    // 真写进去了就摘掉「插入到文档」，避免同一段内容被插第二次
    if (agentUsesTools && !res.stopped && !res.maxed && body) {
      if (autoApply(body, el, anchor) && acts) acts.hideInsert()
    }
    if (res.maxed) {
      const tag = document.createElement('div')
      tag.className = 'ai-stopped'
      tag.textContent = t('ai.toolMaxSteps')
      el.appendChild(tag)
      setStatus(tag.textContent)
    }
    if (res.stopped) {
      const tag = document.createElement('div')
      tag.className = 'ai-stopped'
      tag.textContent = t('ai.stopped')
      el.appendChild(tag)
    }
    streaming = null
    setStreamingUi(false)
    syncModelChip()
    updateCtxRing()
    saveChat() // 回答结束自动存档（fire and forget）
    scrollEnd()
  }

  function finishDone(stopped) {
    if (!streaming) return
    // Agent 锚点协议在这里统一解析（Ask 模式模型不会输出标记，解析无害）：
    // 气泡、历史、动作行都用剥掉标记后的正文，锚点只留给自动应用定位
    const { anchor, body, anchorBroken } = parseAgentReply(streaming.text)
    const reasoning = String(streaming.reasoning || '')
    const el = streaming.el
    // 正文 / 思考分开展示；正文为空时把思考当兜底内容画出来，并给出原因提示
    const { hasReasoning } = paintAssistant(el, body, reasoning, false)
    const histMsg = { role: 'assistant', content: body }
    if (hasReasoning) histMsg._reasoning = reasoning
    history.push(histMsg)
    // 没有正文时不画操作行：思考过程不是回答，不该提供「插入到文档」
    const acts = body ? assistantActions(body) : null
    if (acts) el.appendChild(acts)
    // Agent 模式：回答完整结束才自动应用（手动停止说明用户想留半截自己处理）；
    // 真写进去了就摘掉「插入到文档」，避免同一段内容被插第二次
    if (mode === 'agent' && !stopped && body) {
      if (autoApply(body, el, anchor, anchorBroken) && acts) acts.hideInsert()
    }
    if (stopped) {
      const tag = document.createElement('div')
      tag.className = 'ai-stopped'
      tag.textContent = t('ai.stopped')
      el.appendChild(tag)
    }
    streaming = null
    setStreamingUi(false)
    syncModelChip()
    updateCtxRing()
    saveChat() // 回答结束自动存档（fire and forget）
    scrollEnd()
  }

  function finishError(msg, tip) {
    if (!streaming) return
    const el = streaming.el
    // 出错前已流入的半截回答保留在气泡里并计入历史。此前直接 innerHTML= 整体重写、函数体无
    // history 追加（对比 finishDone），与下面「半截也归档」的注释相反——实测存档只剩 user 一条。
    const partial = parseAgentReply(String(streaming.text || '')).body
    const reasoning = String(streaming.reasoning || '')
    const hasReasoning = !!reasoning.trim()
    el.innerHTML = ''
    if (hasReasoning) el.appendChild(reasoningBlock(reasoning, false))
    if (partial.trim()) {
      const ans = document.createElement('div')
      ans.className = 'ai-answer'
      ans.innerHTML = md.render(partial)
      el.appendChild(ans)
      const histMsg = { role: 'assistant', content: partial }
      if (hasReasoning) histMsg._reasoning = reasoning
      history.push(histMsg)
    } else if (hasReasoning) {
      // 只有思考过程也归档：重开面板时还能看到模型想过什么
      history.push({ role: 'assistant', content: '', _reasoning: reasoning })
    }
    const err = document.createElement('div')
    err.className = 'ai-err'
    err.textContent = t('ai.errRequest', { err: msg || t('ai.errUnknown') })
    el.appendChild(err)
    if (tip) {
      // Agent 模式的错误统一附「切回 Ask」建议：不区分错误原因（模型不支持工具与
      // 网络失败从文案上分不开），不猜原因只给出路
      const hint = document.createElement('div')
      hint.className = 'ai-err-tip'
      hint.textContent = tip
      el.appendChild(hint)
    }
    streaming = null
    setStreamingUi(false)
    syncModelChip()
    updateCtxRing()
    saveChat() // 半截回答（出错前已流入的）也归档
    scrollEnd()
  }

  /** 助手气泡尾部的操作行：插入到文档 / 复制。
   *  hideInsert() 给 Agent 模式收尾用：回答已经由 autoApply 写进文档，再留「插入到文档」就是给
   *  同一段内容一个第二次插入的入口；没写成的那几条路径（手动停止 / 步数到顶 / 写入失败）照旧留着。*/
  function assistantActions(text) {
    const row = document.createElement('div')
    row.className = 'ai-actions'
    const ins = document.createElement('button')
    ins.type = 'button'
    ins.className = 'nl-ks-btn ai-insert'
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
    row.hideInsert = () => ins.remove()
    return row
  }

  /** Agent 模式收尾：按锚点（自然语言位置）或光标智能落点写进文档，结果都给一条小标签；
   *  应用带回退记录时标签上加「撤销」按钮（pos 是会话内坐标，切文档 / 重启后校验不过自然置灰）。
   *  返回是否真写进去了，调用点据此决定还留不留「插入到文档」 */
  function autoApply(text, el, anchor, anchorBroken) {
    if (!appendToDoc) return false
    let res = null
    try { res = appendToDoc(text, anchor || null) } catch { res = null }
    const tag = document.createElement('div')
    const ok = !!(res && res.ok)
    tag.className = 'ai-stopped' + (ok ? ' ai-applied' : ' ai-apply-fail')
    if (ok && anchor && !res.missed) {
      tag.textContent = t(anchor.dir === 'before' ? 'ai.appliedAtBefore' : 'ai.appliedAtAfter', { where: res.where || anchor.target })
    } else if (ok && anchor && res.missed) {
      tag.textContent = t('ai.anchorMiss', { where: anchor.target })
    } else if (ok && anchorBroken) {
      // 标记本身已被 parseAgentReply 从正文剥掉，这里只告诉用户落点没认出来
      tag.textContent = t('ai.anchorUnresolved')
    } else if (ok) {
      tag.textContent = t('ai.applied')
    } else {
      tag.textContent = t('ai.applyFail')
    }
    if (ok && res && res.record && typeof revertAgentEdit === 'function') {
      lastRevertRecord = res.record
      persistRevert(res.record) // 跨重启可撤销：存一份，面板重建后能恢复入口
      liveRevertEl = tag // 消息区重建后离线，快照行据此判断要不要再出一个入口
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.className = 'nl-ks-btn ai-revert-btn'
      btn.textContent = t('ai.revert')
      const syncBtn = () => {
        const can = typeof canRevertAgentEdit === 'function' ? !!canRevertAgentEdit(lastRevertRecord) : true
        btn.disabled = !lastRevertRecord || !can
        btn.title = lastRevertRecord && !can ? t('ai.revertGone') : t('ai.revert')
      }
      syncBtn()
      btn.addEventListener('click', () => {
        if (!lastRevertRecord) return
        if (revertAgentEdit(lastRevertRecord)) {
          tag.textContent = t('ai.reverted')
          lastRevertRecord = null
          liveRevertEl = null
          clearPersistedRevert() // 已撤销，别让重开面板再出一条「可撤销」
          btn.remove()
        } else {
          btn.disabled = true
          btn.title = t('ai.revertGone')
        }
        setStatus(tag.textContent)
      })
      tag.appendChild(btn)
    }
    el.appendChild(tag)
    setStatus(tag.textContent)
    return ok
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
    if (attachments.length >= AI_MAX_IMAGES) {
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
      messages: msgs, // buildTaskMessages 已是 OpenAI 数组形态，与选区浮层同一条出口
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

  // —— 语音输入：桌面版录音与识别都在 Rust 侧（voice.rs），浏览器版退回 Web Speech API。
  // 桌面 WebView2 没有可用的 Web Speech 识别后端（Chrome 专属云服务），此前这条路
  // 在桌面上永远走不通。优先级见 ai-tasks.voicePath：服务商 ASR > Windows 原生听写 > Web Speech ——

  let voiceState = 'idle' // idle | starting（建立会话的 IPC 在飞）| rec（录等待 ASR）| native（原生听写中）| webspeech
  // 桌面版（mac / Windows / Linux）把语音入口整个藏掉：三条路现在都没跑通——mac 没配 ASR 模型时
  // 点了只会判 'none'，配了模型还要服务商真有 /audio/transcriptions 才回得来；Windows 那条原生
  // 听写与 Linux 也各自有问题。状态机、词条、Rust 侧全留着，纯网页预览（Chrome Web Speech）不受影响。
  const desktopApp = !!window.__TAURI_INTERNALS__
  const hideVoice = voiceUiHidden !== undefined ? !!voiceUiHidden : desktopApp
  // 「AI 优化输入」同一口径藏掉：这个钮是就地润色的唯一入口（`buildTaskMessages('polish')`
  // 全仓库只有这一处调用），所以藏掉就等于桌面版没有这条功能，不是挪到别处还能用。
  const hideOptimize = desktopApp
  let rec = null // Web Speech 的 SpeechRecognition 实例（浏览器版）
  let recTimer = null // 录音上限看门狗（120s 自动停并送识别）
  let committed = '' // 本次语音已定稿文本（interim 覆盖显示、final 逐段追加）
  let dictReqId = null // 原生听写会话 id（事件广播到所有窗口，按它过滤）
  let nativeDictOk = null // 原生识别探测缓存：null 没探过 / true / false（探测有 IPC 开销）
  let offDictation = null
  let dictDeadline = 0 // 本场听写的总预算到期时刻（自动续场不能把麦克风无限开着）
  let dictResumes = 0 // 连续自动续场次数（真说过话就清零，它只是循环刹车）

  function webspeechSupported() {
    return !!(window.SpeechRecognition || window.webkitSpeechRecognition)
  }

  function voiceLang() {
    const loc = getLocale()
    return loc === 'zh-Hant' ? 'zh-TW' : (loc || 'zh-CN')
  }

  async function nativeAvailable() {
    if (nativeDictOk !== null) return nativeDictOk
    try {
      nativeDictOk = await aiDictationProbe(voiceLang())
    } catch {
      nativeDictOk = false
    }
    return nativeDictOk
  }

  /** 语音按钮的蓝色只跟 voiceState 走：置灰 / 点亮都从这里出，
   *  buildDom 重建 DOM（换语言）后也按它回灌一次，否则类和状态会各说各话 */
  function syncVoiceUi() {
    if (voiceBtn) voiceBtn.classList.toggle('active', voiceState !== 'idle')
  }

  function stopVoiceUi() {
    voiceState = 'idle'
    syncVoiceUi()
  }

  function appendVoiceText(text) {
    const s = String(text || '').trim()
    if (!s) return
    committed = committed ? committed + ' ' + s : s
    inputEl.value = committed
    autosize()
    inputEl.focus()
  }

  const errText = (e) => (e && e.message) || String(e)

  /** ASR 路径收尾：停录、上传、结果追加进输入框。上限看门狗与手动点击可能都触发，只放行第一个 */
  async function finishAsr() {
    if (voiceState !== 'rec') return
    if (recTimer) { clearTimeout(recTimer); recTimer = null }
    stopVoiceUi()
    showAttNote(t('ai.voiceAsrBusy'))
    let wavPath = null
    try {
      wavPath = await aiRecStop()
      const cfg = getConfig ? getConfig() : {}
      const text = await aiAsrTranscribe(cfg.baseUrl, cfg.apiKey, cfg.asrModel, wavPath)
      appendVoiceText(text)
    } catch (e) {
      showAttNote(t('ai.voiceErr', { err: errText(e) }))
    }
  }

  /** 浏览器版 Web Speech（Chrome）。桌面 WebView2 没有识别后端，不会走到这里 */
  function startWebSpeech() {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition
    if (!SR) { showAttNote(t('ai.voiceNo')); return }
    rec = new SR()
    rec.lang = voiceLang()
    rec.interimResults = true
    rec.continuous = true
    committed = inputEl.value
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
      rec = null
      stopVoiceUi()
    }
    rec.onerror = (e) => {
      if (e.error !== 'aborted' && e.error !== 'no-speech') showAttNote(t('ai.voiceFail'))
    }
    voiceState = 'webspeech'
    syncVoiceUi()
    try {
      rec.start()
    } catch {
      rec = null
      stopVoiceUi()
    }
  }

  async function toggleVoice() {
    if (voiceState === 'starting') return // 探测 + StartAsync 还在飞：这一下不再发第二个 start，
                                          // 否则 Rust 回「已在听写中」，看着像语音整个打不开
    if (voiceState === 'rec') { finishAsr(); return }
    if (voiceState === 'native') {
      // 原生听写靠 Rust 的 end 事件收尾；停不下来（没有会话可停 / IPC 报错 / 引擎卡住
      // 而停止等到超时）那个事件可能永远不会来，所以就地灭灯并把原因说出来
      aiDictationStop().catch((e) => {
        dictReqId = null
        stopVoiceUi()
        setStatus('')
        showAttNote(t('ai.voiceErr', { err: errText(e) }))
      })
    }
    else if (voiceState === 'webspeech') { if (rec) rec.stop() }
    else await startVoice()
  }

  async function startVoice() {
    if (voiceState !== 'idle') return
    // 灯在探测之前点亮：探测与建立会话要几百毫秒，期间按钮没反应用户就连点，
    // 第二下落到 Rust 上是「已在听写中」（原生）或「已在录音中」（ASR）
    voiceState = 'starting'
    syncVoiceUi()
    const tauri = !!window.__TAURI_INTERNALS__
    let native = false
    if (tauri) native = await nativeAvailable()
    const cfg = getConfig ? getConfig() : { asrModel: '' }
    const path = voicePath(cfg, { tauri, webSpeech: webspeechSupported(), native })
    // 语音的状态与错误一律走面板内可见提示（showAttNote）：main.js 的 setStatus 只写
    // console 不上屏，走它用户看到的就是「点了没反应」
    if (path === 'asr') {
      try {
        await aiRecStart()
      } catch (e) {
        stopVoiceUi()
        showAttNote(t('ai.voiceErr', { err: errText(e) }))
        return
      }
      voiceState = 'rec'
      syncVoiceUi()
      committed = inputEl.value
      showAttNote(t('ai.voiceRec'))
      recTimer = setTimeout(() => { if (voiceState === 'rec') finishAsr() }, 120000)
    } else if (path === 'native') {
      const rid = 'dict-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6)
      try {
        await aiDictationStart(rid, voiceLang())
      } catch (e) {
        const msg = errText(e)
        stopVoiceUi()
        // speech-privacy：系统「在线语音识别」没开，Rust 侧已代为打开设置页。
        // 引擎本身在（probe 是过的），不污染探测缓存，用户开完开关下次点击就能用
        if (msg.includes('speech-privacy')) showAttNote(t('ai.voicePrivacy'))
        else showAttNote(t('ai.voiceErr', { err: msg }))
        return
      }
      dictReqId = rid
      voiceState = 'native'
      syncVoiceUi()
      committed = inputEl.value
      dictDeadline = Date.now() + DICT_SESSION_MAX_MS
      dictResumes = 0
      showAttNote(t('ai.voiceListening'))
    } else if (path === 'webspeech') {
      startWebSpeech()
    } else {
      stopVoiceUi()
      showAttNote(t('ai.voiceNo'))
    }
  }

  /** 引擎自终后原地续一场：先挂上新 reqId 再发 start——反过来写的话，新会话的收尾事件
   *  可能比本地 id 先到，被 reqId 过滤掉，按钮就蓝住不灭（引擎已经停了） */
  async function resumeDictation() {
    const rid = 'dict-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6)
    dictReqId = rid
    try {
      await aiDictationStart(rid, voiceLang())
      return true
    } catch (e) {
      dictReqId = null
      dictDeadline = 0
      stopVoiceUi()
      showAttNote(t('ai.voiceErr', { err: errText(e) }))
      return false
    }
  }

  /** 该续就续：回 true 表示这一场 end 已被续场吃掉，调用方不再收尾 */
  async function maybeResumeDictation(text) {
    if (!shouldResumeDictation({
      text, state: voiceState, now: Date.now(), deadline: dictDeadline, resumes: dictResumes,
    })) return false
    dictResumes += 1
    return await resumeDictation()
  }

  // —— 输入卡浮层小菜单（模式切换 / 技能共用）：点外 / Esc 关闭，贴底往上弹 ——

  let floatMenuEl = null
  let floatAnchorEl = null

  function closeFloatMenu() {
    if (floatMenuEl) {
      floatMenuEl.remove()
      floatMenuEl = null
      floatAnchorEl = null
    }
    document.removeEventListener('click', onFloatDocClick, true)
    document.removeEventListener('keydown', onFloatEsc, true)
  }

  function onFloatDocClick(e) {
    if (floatMenuEl && !floatMenuEl.contains(e.target) && !(floatAnchorEl && floatAnchorEl.contains(e.target))) closeFloatMenu()
  }

  function onFloatEsc(e) {
    if (e.key === 'Escape') closeFloatMenu()
  }

  function openFloatMenu(anchorEl, menu) {
    closeFloatMenu()
    document.body.appendChild(menu) // 先挂载才有尺寸可量
    const mw = menu.offsetWidth
    const mh = menu.offsetHeight
    const r = anchorEl.getBoundingClientRect()
    // 左对齐锚点，右溢出窗口就改右缘对齐（窄窗口时技能菜单不再伸出屏外）
    let left = r.left
    if (left + mw > window.innerWidth - 4) left = Math.max(4, window.innerWidth - mw - 4)
    // 菜单底边贴锚点上方；上方放不下翻到下方，再放不下就贴窗口底
    let top = r.top - 8 - mh
    if (top < 4) top = Math.min(window.innerHeight - mh - 4, r.bottom + 8)
    menu.style.left = left + 'px'
    menu.style.top = top + 'px'
    floatMenuEl = menu
    floatAnchorEl = anchorEl
    document.addEventListener('click', onFloatDocClick, true)
    document.addEventListener('keydown', onFloatEsc, true)
  }

  const floatMenuOpenFor = (anchorEl) => floatMenuEl && floatAnchorEl === anchorEl

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
      pill.setAttribute('aria-expanded', floatMenuOpenFor(pill) ? 'true' : 'false')
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
          closeFloatMenu()
          syncPill()
        })
        return item
      }
      menu.append(mk('ask', 'ai.modeAskTip'), mk('agent', 'ai.modeAgentTip'))
      openFloatMenu(pill, menu)
      syncPill()
    }
    pill.addEventListener('click', (e) => {
      e.stopPropagation()
      if (floatMenuOpenFor(pill)) closeFloatMenu()
      else openMenu()
    })
    syncPill()
    wrap.append(pill)
    return wrap
  }

  // —— 技能菜单：自动探测本机其它 AI 软件安装的 skills（~/.claude/skills 等），按来源分组 ——

  async function renderSkills(container, force) {
    container.innerHTML = '<div class="ai-skill-empty">' + t('ai.skillsProbing') + '</div>'
    if (force || !skillsLoaded) {
      const r = await aiSkillsScan().catch(() => null)
      if (Array.isArray(r)) skills = r // 桥接异常/桩环境返回非数组时保留原值，不让 TypeError 断渲染
      skillsLoaded = true
    }
    if (floatMenuEl && !floatMenuEl.contains(container)) return // 菜单已关，丢弃结果
    container.innerHTML = ''
    if (!skills.length) {
      container.innerHTML = '<div class="ai-skill-empty">' + t('ai.skillsEmpty') + '</div>'
      return
    }
    const groups = {}
    for (const s of skills) (groups[s.source] = groups[s.source] || []).push(s)
    for (const src of Object.keys(groups)) {
      const gh = document.createElement('div')
      gh.className = 'ai-skill-group'
      gh.textContent = src
      container.appendChild(gh)
      for (const s of groups[src]) {
        const on = () => activeSkillPaths.includes(s.path)
        const item = document.createElement('button')
        item.type = 'button'
        item.className = 'ai-mode-item ai-skill-item' + (on() ? ' active' : '')
        const mark = document.createElement('span')
        mark.className = 'ai-mode-mark'
        if (on()) setIcon(mark, 'check')
        const txt = document.createElement('span')
        txt.className = 'ai-skill-txt'
        const nm = document.createElement('span')
        nm.className = 'ai-skill-name'
        nm.textContent = s.name
        const de = document.createElement('span')
        de.className = 'ai-skill-desc'
        de.textContent = s.description
        txt.append(nm, de)
        item.append(mark, txt)
        item.title = s.description || s.name
        item.addEventListener('click', (e) => {
          e.stopPropagation()
          // 多选：点一次选中即收起菜单（要再加 skills 再点技能钮）；chips 同步回显
          if (on()) activeSkillPaths = activeSkillPaths.filter((q) => q !== s.path)
          else activeSkillPaths.push(s.path)
          saveActiveSkills()
          syncSkillBtn()
          renderSkillChips()
          closeFloatMenu()
          setStatus(on() ? t('ai.skillOn', { name: s.name }) : t('ai.skillOff'))
        })
        container.appendChild(item)
      }
    }
  }

  /** 选中技能的回显 chips（输入框内顶部一行，对齐参考样式：[图标 名称 ×]，可多个可删） */
  function renderSkillChips() {
    if (!skillChips) return
    skillChips.innerHTML = ''
    skillChips.classList.toggle('hidden', !activeSkillPaths.length)
    for (const p of activeSkillPaths) {
      const s = skills.find((x) => x.path === p)
      const chip = document.createElement('span')
      chip.className = 'ai-skill-chip'
      const ic = document.createElement('span')
      ic.className = 'ai-skill-chip-ic'
      setIcon(ic, 'box')
      const nm = document.createElement('span')
      nm.className = 'ai-skill-chip-name'
      nm.textContent = s ? s.name : (p.split(/[\\/]/).slice(-2, -1)[0] || p)
      const x = document.createElement('button')
      x.type = 'button'
      x.className = 'ai-skill-chip-x'
      x.title = t('ai.removeSkill')
      x.setAttribute('aria-label', t('ai.removeSkill'))
      x.textContent = '×'
      x.addEventListener('click', (e) => {
        e.stopPropagation()
        activeSkillPaths = activeSkillPaths.filter((q) => q !== p)
        saveActiveSkills()
        syncSkillBtn()
        renderSkillChips()
        updateCtxRing()
      })
      chip.append(ic, nm, x)
      skillChips.appendChild(chip)
    }
    updateCtxRing()
  }

  function buildSkillsMenu() {
    const menu = document.createElement('div')
    menu.className = 'ai-mode-menu ai-skill-menu'
    const head = document.createElement('div')
    head.className = 'ai-skill-head'
    const ttl = document.createElement('span')
    ttl.textContent = t('ai.skills')
    const refresh = document.createElement('button')
    refresh.type = 'button'
    refresh.className = 'ai-icon-btn'
    refresh.title = t('ai.skillsRefresh')
    refresh.setAttribute('aria-label', t('ai.skillsRefresh'))
    setIcon(refresh, 'reload')
    refresh.addEventListener('click', (e) => {
      e.stopPropagation()
      skillsLoaded = false
      renderSkills(menu.querySelector('.ai-skill-body'), true)
    })
    head.append(ttl, refresh)
    const body = document.createElement('div')
    body.className = 'ai-skill-body'
    menu.append(head, body)
    renderSkills(body, false)
    return menu
  }

  // —— 输入框自适应高度（提示词条完整可见：下限 64px 约两行） ——

  function autosize() {
    inputEl.style.height = 'auto'
    inputEl.style.height = Math.min(140, Math.max(64, inputEl.scrollHeight)) + 'px'
  }

  // —— 上下文用量圆环：估算 system（文档/技能/库检索）+ 历史 + 输入的 token 占参考窗口比例 ——

  let ctxRing = null // { el, circle } SVG 圆环

  /** 会话将随下一条消息发送的全部文本（估算用）；空对话回 ''（圆环归零） */
  function ctxText() {
    // 空对话（无历史消息且输入框为空）：文档上下文 / 技能要到第一条消息真正发出后才计入，
    // 一打开面板就显示"已有用量"是误导
    if (history.length === 0 && (!inputEl || !inputEl.value)) return ''
    let s = ''
    const ctx = getDocContext ? getDocContext() : ''
    if (ctx) s += ctx
    if (skillsLoaded) {
      for (const p of activeSkillPaths) {
        const sk = skills.find((x) => x.path === p)
        if (sk && sk.content) s += sk.content
      }
    }
    for (const m of history) s += typeof m.content === 'string' ? m.content : JSON.stringify(m.content)
    if (inputEl) s += inputEl.value
    return s
  }

  function updateCtxRing() {
    if (!ctxRing || !ctxRing.circle) return
    const tokens = estimateTokens(ctxText())
    // 分母优先取用户在 AI 设置里填的真实上下文窗口（ai.contextTokens），未填回落参考值；
    // 小窗口模型（本地 2K/4K）填上后，圆环能在超限前就转热报警，不再拿 32K 谎报余量。
    const win = aiContextWindow(getConfig())
    const pct = Math.min(1, tokens / win)
    const C = 2 * Math.PI * 7 // r=7 的周长
    ctxRing.circle.setAttribute('stroke-dasharray', C.toFixed(1))
    ctxRing.circle.setAttribute('stroke-dashoffset', (C * (1 - pct)).toFixed(1))
    const cls = pct > 0.9 ? 'ai-ctx-hot' : pct > 0.7 ? 'ai-ctx-warm' : 'ai-ctx-ok'
    ctxRing.circle.setAttribute('class', 'ai-ctx-arc ' + cls)
    ctxRing.el.title = t('ai.ctxTip', { pct: Math.round(pct * 100), tokens })
  }

  // —— 会话存档：有知识库存 <vault>/.notelume-ai/chats/<id>.json，无库存系统 temp；
  // 「开启新对话」归档当前会话再开新，回答结束自动保存，重开面板恢复最近会话 ——

  let chatId = (() => {
    try { return localStorage.getItem('nl-ai-chat-id') || '' } catch { return '' }
  })()

  function genChatId() {
    return 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
  }

  async function saveChat() {
    if (!history.length) return
    if (!chatId) {
      chatId = genChatId()
      try { localStorage.setItem('nl-ai-chat-id', chatId) } catch { /* 存不上只留会话内 */ }
    }
    const firstUser = history.find((m) => m.role === 'user')
    const title = (typeof firstUser?.content === 'string' ? firstUser.content : '') || t('ai.title')
    // 存档前补齐悬挂 tool_calls（协议要求 assistant.tool_calls 与 role:'tool' 成对，
    // 缺了下次带这段历史续聊会被服务端 400）；内存里的 history 不动
    const doc = { v: 1, id: chatId, title: title.slice(0, 40), messages: repairHangingToolCalls(history) }
    try {
      await aiChatSave(getVaultRootForChat ? getVaultRootForChat() : null, chatId + '.json', JSON.stringify(doc))
    } catch { /* 存档失败不打断对话 */ }
  }

  /** 恢复最近会话（nl-ai-chat-id 指向的存档；读不到/坏档就当新会话） */
  async function restoreChat() {
    if (!chatId) return
    let raw = null
    try {
      raw = await aiChatRead(getVaultRootForChat ? getVaultRootForChat() : null, chatId + '.json')
    } catch { raw = null }
    if (!raw) return
    try {
      const doc = JSON.parse(raw)
      if (doc && Array.isArray(doc.messages) && doc.messages.length) {
        history = doc.messages
        renderHistory()
        updateCtxRing()
      }
    } catch { /* 坏档当新会话 */ }
  }

  /** 开启新对话：归档当前会话，然后清空重来 */
  async function newChat() {
    await saveChat()
    history = []
    chatId = ''
    try { localStorage.removeItem('nl-ai-chat-id') } catch { /* 无 localStorage 就只留会话内 */ }
    renderHistory()
    updateCtxRing()
    setStatus(t('ai.newChatStarted'))
  }

  // —— 静态骨架 ——

  function buildDom() {
    closeFloatMenu() // 语言切换重建 DOM 时清掉可能挂着的浮层菜单
    root.innerHTML = ''
    // 显隐归右栏独立开关（syncInspector）管，这里不碰 className——否则切语言会把面板藏掉

    const head = document.createElement('div')
    head.className = 'ai-head'
    const title = document.createElement('span')
    title.className = 'ai-head-title'
    setIcon(title, 'sparkle', t('ai.title'))
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
    clear.title = t('ai.newChat')
    clear.setAttribute('aria-label', t('ai.newChat'))
    setIcon(clear, 'pen') // ChatGPT 式「开启新对话」：归档当前会话再开新（存档见 saveChat）
    clear.addEventListener('click', () => {
      if (streaming) stop()
      if (optStreaming) {
        aiChatCancel(optStreaming.reqId).catch(() => {})
        optStreaming = null
        optBtn.classList.remove('active')
      }
      newChat()
    })
    head.append(title, gear, clear)

    msgsEl = document.createElement('div')
    msgsEl.className = 'ai-msgs'
    emptyHint = document.createElement('div')
    emptyHint.className = 'ai-empty'
    emptyHint.textContent = t('ai.emptyHint')
    msgsEl.appendChild(emptyHint)

    // 附件预览条：附图 chip / 面板内提示（模型不支持等），空时隐藏；只收粘贴上传
    attEl = document.createElement('div')
    attEl.className = 'ai-att hidden'
    // 选中技能回显 chips（textarea 上方一行，多选可删）
    skillChips = document.createElement('div')
    skillChips.className = 'ai-skill-chips hidden'

    const composer = document.createElement('div')
    composer.className = 'ai-composer'
    inputEl = document.createElement('textarea')
    inputEl.className = 'ai-input'
    inputEl.rows = 1
    inputEl.placeholder = t('ai.inputPh')
    inputEl.addEventListener('input', () => {
      autosize()
      updateCtxRing()
    })
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
    optBtn.className = 'ai-icon-btn ai-optimize'
    optBtn.title = t('ai.optimize')
    optBtn.setAttribute('aria-label', t('ai.optimize'))
    setIcon(optBtn, 'pen')
    optBtn.addEventListener('click', toggleOptimize)
    voiceBtn = document.createElement('button')
    voiceBtn.type = 'button'
    voiceBtn.className = 'ai-icon-btn ai-voice'
    voiceBtn.title = t('ai.voice')
    voiceBtn.setAttribute('aria-label', t('ai.voice'))
    setIcon(voiceBtn, 'mic')
    // 不在创建时置灰：走哪条路（ASR / 原生听写 / Web Speech / 都不行）到点击时才判定，
    // 原生识别探测有 IPC 开销且配置中途会变，按钮常亮、不可用时给状态行提示
    voiceBtn.addEventListener('click', toggleVoice)
    skillBtn = document.createElement('button')
    skillBtn.type = 'button'
    skillBtn.className = 'ai-icon-btn'
    skillBtn.title = t('ai.skills')
    skillBtn.setAttribute('aria-label', t('ai.skills'))
    setIcon(skillBtn, 'box')
    skillBtn.classList.toggle('active', activeSkillPaths.length > 0)
    skillBtn.addEventListener('click', (e) => {
      e.stopPropagation()
      if (floatMenuOpenFor(skillBtn)) closeFloatMenu()
      else openFloatMenu(skillBtn, buildSkillsMenu())
    })
    const bar = document.createElement('div')
    bar.className = 'ai-composer-bar'
    // 底行模型选择器（红框样式）：多模型 pill+▾ 可切换，单模型只显示名称
    modelPill = document.createElement('button')
    modelPill.type = 'button'
    modelPill.className = 'ai-model-pill'
    const mLabel = document.createElement('span')
    mLabel.className = 'ai-model-label'
    const mChev = document.createElement('span')
    mChev.className = 'ai-model-chev'
    setIcon(mChev, 'chevron-down')
    modelPill.append(mLabel, mChev)
    modelPill.addEventListener('click', (e) => {
      e.stopPropagation()
      toggleModelsMenu()
    })
    // 上下文用量圆环：底行右侧（语音与发送之间），环形进度表示估算 token 占参考窗口比例
    ctxRing = { el: document.createElement('span'), circle: null }
    ctxRing.el.className = 'ai-ctx-ring'
    const ringSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    ringSvg.setAttribute('viewBox', '0 0 18 18')
    ringSvg.setAttribute('width', '16')
    ringSvg.setAttribute('height', '16')
    const ringBg = document.createElementNS('http://www.w3.org/2000/svg', 'circle')
    ringBg.setAttribute('cx', '9')
    ringBg.setAttribute('cy', '9')
    ringBg.setAttribute('r', '7')
    ringBg.setAttribute('class', 'ai-ctx-bg')
    const ringArc = document.createElementNS('http://www.w3.org/2000/svg', 'circle')
    ringArc.setAttribute('cx', '9')
    ringArc.setAttribute('cy', '9')
    ringArc.setAttribute('r', '7')
    ringArc.setAttribute('class', 'ai-ctx-arc ai-ctx-ok')
    ringArc.setAttribute('transform', 'rotate(-90 9 9)') // 从顶部顺时针
    ringSvg.append(ringBg, ringArc)
    ctxRing.circle = ringArc
    ctxRing.el.appendChild(ringSvg)
    // 整体排布：左组（模式 · 技能 · 模型）+ 右组（用量圆环 · 优化 · 语音 · 发送/停止）。
    // 圆环那条 margin-left:auto 吃掉中段留白，所以右组恒贴右边缘：优化与语音藏掉后
    // 圆环自己右移补位，不会在发送钮左边留出两个空档。
    bar.append(buildModeMenu(), skillBtn, modelPill, ctxRing.el, ...(hideOptimize ? [] : [optBtn]), ...(hideVoice ? [] : [voiceBtn]), sendBtn, stopBtn)
    composer.append(skillChips, inputEl, bar)

    root.append(head, msgsEl, attEl, composer)
    syncModelChip()
    renderHistory()
    setStreamingUi(false)
    updateCtxRing()
    renderSkillChips()
    syncVoiceUi() // 换语言重建 DOM 时若还在录音 / 听写，新按钮要点回蓝色
    // 技能无感探测：面板建好就静默扫一次（本地几个目录，毫秒级）
    aiSkillsScan().then((r) => {
      if (Array.isArray(r)) skills = r
      skillsLoaded = true
    }).catch(() => {
      skillsLoaded = true
    })
    // 恢复最近会话（nl-ai-chat-id 指向的存档；无/坏档即新会话）
    restoreChat()
  }

  function mount() {
    buildDom()
    // 流式事件：全局一路订阅，按 reqId 分发（选区浮层有自己的订阅，互不干扰）。
    // aiChatListen 是异步订阅，退订函数在 .then 里挂进来；挂上之前面板已销毁就立刻退订
    aiChatListen((ev) => {
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
      // Agent 工具循环的按轮请求：按 agentReq.reqId 分发（streaming.reqId 此时也在跟随，
      // 但循环的 chunk 要走 onDelta 统一路径，这里先行拦截）
      if (agentReq && ev && ev.reqId === agentReq.reqId) {
        if (ev.kind === 'chunk' && ev.delta) {
          agentReq.text += ev.delta
          agentOnDelta(ev.delta)
        } else if (ev.kind === 'reasoning' && ev.delta) {
          // 思考增量只进气泡上方的折叠块，不混进本轮正文
          if (streaming) {
            streaming.reasoning += ev.delta
            renderStreaming()
          }
        } else if (ev.kind === 'done') {
          const a = agentReq
          agentReq = null
          a.resolve({ text: a.text, toolCalls: ev.toolCalls || null })
        } else if (ev.kind === 'error') {
          const a = agentReq
          agentReq = null
          a.reject(new Error(ev.error || t('ai.errUnknown')))
        }
        return
      }
      if (!streaming || !ev || ev.reqId !== streaming.reqId) return
      if (ev.kind === 'chunk' && ev.delta) {
        if (streaming.text === '') streaming.el.innerHTML = '' // 顶掉「思考中」占位
        streaming.text += ev.delta
        renderStreaming()
      } else if (ev.kind === 'reasoning' && ev.delta) {
        streaming.reasoning += ev.delta
        renderStreaming()
      } else if (ev.kind === 'done') {
        finishDone(false)
      } else if (ev.kind === 'error') {
        finishError(ev.error)
      }
    }).then((un) => {
      if (eventStreamDisposed) un()
      else offEvent = un
    })
    // 原生听写事件：事件广播到所有窗口，按本会话 reqId 过滤
    aiDictationListen(async (ev) => {
      if (!ev || ev.reqId !== dictReqId) return
      if (ev.kind === 'audio') {
        // 引擎报的音频质量问题（声音太轻 / 没信号 / 太吵…）：会话继续、灯不灭，但得把
        // 「为什么不出字」说出来——不说的话就是「说了话、一个字没、也没提示」
        const key = dictationAudioInfo(ev.text)
        if (key) showAttNote(t(key))
      } else if (ev.kind === 'hypothesis') {
        const interim = String(ev.text || '')
        inputEl.value = interim ? (committed ? committed + ' ' + interim : interim) : committed
        autosize()
      } else if (ev.kind === 'result') {
        appendVoiceText(ev.text)
        dictResumes = 0 // 真说过话：循环刹车松掉，下一段静默还可以接着续
      } else if (ev.kind === 'end') {
        // 引擎几秒听不到可用语音就会自己收场（真机实测 status 7 约 6 秒、status 5 约 22 秒），
        // 而 Rust 对这一档把引擎留着了：就地续一场，灯不灭，用户看不出中间断过。
        // 不续的情形（用户已停 / 预算用完 / 循环跑飞）才走下面的收尾。
        if (await maybeResumeDictation(ev.text)) return
        dictReqId = null
        dictDeadline = 0
        inputEl.value = committed
        autosize()
        stopVoiceUi()
        setStatus('')
        // 引擎自己收的场也走 end，靠 text 分：自终说一句就够，不是故障
        const info = dictationDoneInfo('end', ev.text)
        if (info.key) showAttNote(t(info.key, info.params))
      } else if (ev.kind === 'error') {
        dictReqId = null
        stopVoiceUi()
        // 哨兵码由 voice.rs 的 dictation_done_signal 给齐：麦克风被拒 / 网络不可用 /
        // 引擎异常都各有句话说，不能统一成一句「拿不到麦克风」
        const info = dictationDoneInfo('error', ev.text)
        showAttNote(t(info.key, info.params))
      }
    }).then((un) => {
      if (eventStreamDisposed) un()
      else offDictation = un
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
    /** 切文档 / 换库后重算上下文圆环与模型胶囊（getDocContext 读的是焦点窗格活动标签，
     *  不重算圆环会停在上一篇文档的用量上） */
    refresh() {
      syncModelChip()
      updateCtxRing()
      syncRestoredRevert() // 切文档后按新文档 identity 重新决定是否展示恢复撤销入口
    },
    destroy() {
      eventStreamDisposed = true
      clearRestoredRevert()
      if (typeof offEvent === 'function') offEvent()
      if (offDictation) offDictation()
      if (offLocale) offLocale()
      if (agentReq) aiChatCancel(agentReq.reqId).catch(() => {})
      if (streaming && streaming.reqId) aiChatCancel(streaming.reqId).catch(() => {})
      // 语音收尾：录音丢弃、原生听写停止、Web Speech 停止
      if (voiceState === 'rec') {
        if (recTimer) clearTimeout(recTimer)
        aiRecCancel().catch(() => {})
      } else if (voiceState === 'native' || voiceState === 'starting') {
        // starting 也得停：不然 start 随后成了，会话挂在后台收音，面板已经没了
        aiDictationStop().catch(() => {})
      } else if (voiceState === 'webspeech' && rec) {
        rec.stop()
      }
    },
  }
}
