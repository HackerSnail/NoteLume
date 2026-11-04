// ai-panel-reasoning.test.mjs —— 推理模型的思考流 & 空回答兜底
// 运行：cd src && node tests/ai-panel-reasoning.test.mjs
//
// 背景：Ollama qwen3 走 OpenAI 兼容流时，正文可能整段为空，内容全在
// choices[].delta.reasoning 里（Rust 侧已转成 kind:'reasoning' 事件）。此前面板只认
// kind:'chunk'，于是回答完只剩一个空气泡 + 操作按钮。
//
// 这里走真 ai-panel.js，打桩事件通道，覆盖：
//  - 思考增量 → 气泡上方折叠块，流式中展开；
//  - 正文 + 思考 → 结束后收起思考块、正文与操作行都在；
//  - 只有思考 → 思考块保持展开 + 原因提示，不提供「插入到文档」；
//  - 什么都没回 → emptyReply 提示，不再空气泡；
//  - _reasoning 进存档，恢复会话仍重绘；发给 API 前被剥掉。

import assert from 'node:assert'
import { JSDOM } from 'jsdom'

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' })
global.window = dom.window
global.document = dom.window.document
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true })
global.localStorage = dom.window.localStorage
global.HTMLElement = dom.window.HTMLElement
global.CustomEvent = dom.window.CustomEvent
global.Event = dom.window.Event
dom.window.localStorage.setItem('nl-lang', 'zh-CN')
dom.window.localStorage.setItem('nl-ai-mode', 'ask') // 走 Ask 直连流（非 Agent 循环）
dom.window.localStorage.setItem('nl-ai-chat-id', 'c-test')

const handlers = [] // transformCallback 抓到的事件处理器
let streamReqId = null
let streamMessages = null
let savedPayload = ''
let readPayload = null
let idSeq = 0
window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} }
window.__TAURI_INTERNALS__ = {
  transformCallback(callback) {
    handlers.push(callback)
    return ++idSeq
  },
  invoke(cmd, args) {
    switch (cmd) {
      case 'ai_chat_stream':
        streamReqId = (args && args.args && args.args.reqId) || null
        streamMessages = (args && args.args && args.args.messages) || null
        return Promise.resolve()
      case 'ai_chat_cancel':
        return Promise.resolve()
      case 'ai_skills_scan':
        return Promise.resolve([])
      case 'ai_chat_save':
        savedPayload = (args && args.json) || ''
        return Promise.resolve()
      case 'ai_chat_read':
        return Promise.resolve(readPayload)
      case 'ai_models_list':
        return Promise.resolve(['m'])
      case 'plugin:event|listen':
        return Promise.resolve(() => {})
      default:
        return Promise.resolve(null)
    }
  },
}

const { createAiPanel } = await import('../ai-panel.js')

function fire(payload) {
  for (const h of handlers) {
    try { h({ payload }) } catch { /* 非本事件的处理器 */ }
  }
}

function send(root, text) {
  const input = root.querySelector('.ai-input')
  input.value = text
  root.querySelector('.ai-send').click()
}

async function until(fn, ms = 3000) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    if (fn()) return true
    await new Promise((r) => setTimeout(r, 10))
  }
  return false
}

const root = document.createElement('div')
document.body.appendChild(root)
let panel = createAiPanel({
  root,
  getConfig: () => ({ baseUrl: 'http://x/v1', apiKey: '', model: 'm', contextTokens: 0 }),
  openSettings: () => {},
  getDocContext: () => '',
  insertToDoc: () => {},
  setStatus: () => {},
  vaultReady: () => false,
})

const lastBot = (r = root) => {
  const list = r.querySelectorAll('.ai-msg.ai-bot')
  return list.length ? list[list.length - 1] : null
}

async function ask(text) {
  streamReqId = null
  streamMessages = null
  send(root, text)
  assert.ok(await until(() => streamReqId), 'send 应触发 ai_chat_stream')
  return streamReqId
}

let pass = 0
let fail = 0
async function t(name, fn) {
  try {
    await fn()
    pass++
    console.log('  ok   ' + name)
  } catch (e) {
    fail++
    console.log('  FAIL ' + name + ' —— ' + ((e && e.message) || e))
    if (e && e.stack) console.log(e.stack.split('\n').slice(1, 6).join('\n'))
  }
}

let reasoningArchive = ''

await t('思考增量先到：折叠块出现且流式中展开', async () => {
  const rid = await ask('问一下')
  fire({ reqId: rid, kind: 'reasoning', delta: '先想一' })
  fire({ reqId: rid, kind: 'reasoning', delta: '想' })
  const bot = lastBot()
  const details = bot.querySelector('.ai-reasoning')
  assert.ok(details, '应出现思考块')
  assert.strictEqual(details.open, true, '流式中思考块应展开')
  assert.ok(details.textContent.includes('先想一想'))
  assert.ok(!bot.textContent.includes('思考中…'), '有增量后应顶掉占位')
})

await t('正文 + 思考：结束后思考块收起，正文与操作行都在', async () => {
  const rid = streamReqId
  fire({ reqId: rid, kind: 'chunk', delta: '答案内容' })
  fire({ reqId: rid, kind: 'done' })
  assert.ok(await until(() => !lastBot().querySelector('.ai-dots')), 'done 后不应再显示思考中占位')
  const bot = lastBot()
  const details = bot.querySelector('.ai-reasoning')
  assert.ok(details, '结束后思考块仍保留')
  assert.strictEqual(details.open, false, '有正文时结束后应收起思考块')
  assert.ok(bot.querySelector('.ai-answer').textContent.includes('答案内容'))
  assert.ok(bot.querySelector('.ai-actions'), '有正文时应有操作行')
})

await t('_reasoning 进存档（供重开面板重绘）', async () => {
  assert.ok(await until(() => savedPayload.includes('_reasoning')), '存档 JSON 应含 _reasoning：' + savedPayload.slice(0, 300))
  const doc = JSON.parse(savedPayload)
  const last = doc.messages[doc.messages.length - 1]
  assert.strictEqual(last.role, 'assistant')
  assert.strictEqual(last.content, '答案内容')
  assert.ok(String(last._reasoning).includes('先想一想'))
  reasoningArchive = savedPayload
})

await t('续聊请求体不带 _reasoning 元字段', async () => {
  await ask('接着问')
  assert.ok(streamMessages, '应捕获请求消息')
  const raw = JSON.stringify(streamMessages)
  assert.ok(!raw.includes('_reasoning'), '请求体不应带 _reasoning：' + raw.slice(0, 300))
  assert.ok(!raw.includes('_skills'), '请求体不应带 _skills')
})

await t('只有思考没有正文：思考块保持展开 + 原因提示，不给操作行', async () => {
  const rid = streamReqId
  fire({ reqId: rid, kind: 'reasoning', delta: '我在想但没有答案' })
  fire({ reqId: rid, kind: 'done' })
  assert.ok(await until(() => lastBot().querySelector('.ai-note')), '应出现兜底提示')
  const bot = lastBot()
  const details = bot.querySelector('.ai-reasoning')
  assert.ok(details, '应显示思考内容')
  assert.strictEqual(details.open, true, '仅思考时保持展开当兜底内容')
  assert.ok(bot.querySelector('.ai-note').textContent.includes('只返回了思考过程'))
  assert.ok(!bot.querySelector('.ai-actions'), '思考过程不是回答，不应给插入/复制按钮')
})

await t('完全没有内容：给可读提示，不留空气泡', async () => {
  const rid = await ask('再来一个')
  fire({ reqId: rid, kind: 'done' })
  assert.ok(await until(() => lastBot().querySelector('.ai-note')), '应出现空回答提示')
  const bot = lastBot()
  assert.ok(bot.querySelector('.ai-note').textContent.includes('没有返回内容'))
  assert.ok(!bot.querySelector('.ai-actions'), '空回答不应有操作行')
})

await t('恢复会话：_reasoning 随存档重绘思考块（默认收起）', async () => {
  panel.destroy()
  root.remove()
  readPayload = reasoningArchive
  const root2 = document.createElement('div')
  document.body.appendChild(root2)
  panel = createAiPanel({
    root: root2,
    getConfig: () => ({ baseUrl: 'http://x/v1', apiKey: '', model: 'm', contextTokens: 0 }),
    openSettings: () => {},
    getDocContext: () => '',
    insertToDoc: () => {},
    setStatus: () => {},
    vaultReady: () => false,
  })
  assert.ok(await until(() => root2.querySelector('.ai-msg.ai-bot')), '应恢复历史气泡')
  const feedback = root2.querySelector('.ai-reasoning')
  assert.ok(feedback, '恢复后应重绘思考块')
  assert.strictEqual(feedback.open, false, '历史消息里的思考块默认收起')
  assert.ok(feedback.textContent.includes('先想一想'))
  assert.ok(root2.textContent.includes('答案内容'), '正文也应恢复')
})

panel.destroy()
document.body.innerHTML = ''
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
