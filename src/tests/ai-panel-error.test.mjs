// ai-panel-error.test.mjs —— Ask 模式流中途报错：已流入的半截回答保留并归档（BUG-20261103-003）
// 运行：cd src && node tests/ai-panel-error.test.mjs
//
// 此前 finishError 用 el.innerHTML= 整体重写，把半截回答抹掉，且函数体无 history 追加，
// 与「半截也归档」的注释相反（实测存档只剩 user 一条）。这里走真 ai-panel.js：打桩事件通道
// （transformCallback 抓处理器、ai_chat_stream 记 reqId），先推两段增量再推 error，核对气泡
// 里半截回答仍在、下方有错误行，且 saveChat 落盘的存档里带了那条 assistant 半截。

import assert from 'node:assert'
import { JSDOM } from 'jsdom'

const dom = new JSDOM('<!doctype html><html><body><div id="ai-panel"></div></body></html>', { url: 'http://localhost/' })
global.window = dom.window
global.document = dom.window.document
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true })
global.localStorage = dom.window.localStorage
global.HTMLElement = dom.window.HTMLElement
global.CustomEvent = dom.window.CustomEvent
global.Event = dom.window.Event
dom.window.localStorage.setItem('nl-lang', 'zh-CN')
dom.window.localStorage.setItem('nl-ai-mode', 'ask') // 走 Ask 直连流（非 Agent 循环）

const handlers = [] // transformCallback 抓到的事件处理器
let streamReqId = null
let savedPayload = ''
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
        return Promise.resolve()
      case 'ai_chat_cancel':
        return Promise.resolve()
      case 'ai_skills_scan':
        return Promise.resolve([])
      case 'ai_chat_save':
        savedPayload = (args && args.json) || ''
        return Promise.resolve()
      case 'ai_chat_read':
        return Promise.resolve(null)
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
  // 广播给所有登记的处理器；只有 nl:ai-event 那个按 reqId 认领，其余按形状忽略
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
const panel = createAiPanel({
  root,
  getConfig: () => ({ baseUrl: 'http://x/v1', apiKey: '', model: 'm', contextTokens: 0 }),
  openSettings: () => {},
  getDocContext: () => '',
  insertToDoc: () => {},
  setStatus: () => {},
  vaultReady: () => false,
})

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

await t('流中途报错：半截回答保留在气泡里，下方出错误行', async () => {
  savedPayload = ''
  streamReqId = null
  send(root, '讲讲')
  assert.ok(await until(() => streamReqId), 'send 应触发 ai_chat_stream')
  const rid = streamReqId
  fire({ reqId: rid, kind: 'chunk', delta: '第一段' })
  fire({ reqId: rid, kind: 'chunk', delta: '第二段' })
  fire({ reqId: rid, kind: 'error', error: 'boom' })
  assert.ok(await until(() => root.querySelector('.ai-err')), '应出现错误行')
  const bot = root.querySelector('.ai-msg.ai-bot')
  assert.ok(bot.textContent.includes('第一段') && bot.textContent.includes('第二段'), '半截回答不得被抹掉: ' + bot.textContent)
  assert.ok(bot.querySelector('.ai-err').textContent.includes('boom'), '错误文案应在半截回答之后仍可见')
})

await t('流中途报错：半截回答进存档（saveChat 带 assistant 消息）', async () => {
  savedPayload = ''
  streamReqId = null
  send(root, '再来')
  assert.ok(await until(() => streamReqId), 'send 应触发 ai_chat_stream')
  const rid = streamReqId
  fire({ reqId: rid, kind: 'chunk', delta: '保留我' })
  fire({ reqId: rid, kind: 'error', error: 'x' })
  assert.ok(await until(() => savedPayload.includes('保留我')), '存档 JSON 里应含半截回答：' + savedPayload.slice(0, 200))
  const doc = JSON.parse(savedPayload)
  assert.ok(Array.isArray(doc.messages) && doc.messages.some((m) => m.role === 'assistant' && String(m.content).includes('保留我')), '存档应含带半截回答的 assistant 消息: ' + JSON.stringify(doc.messages))
})

panel.destroy()
root.remove()
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
