// ai-panel-ctx-ring.test.mjs —— 空对话时上下文圆环归零的回归测试
// 运行：cd src && node tests/ai-panel-ctx-ring.test.mjs
//
// 背景：圆环把「当前文档上下文（system 消息）」计入估算，于是对话还没开始、
// 输入框为空时就显示出用量（qwen3 空对话截图里圆环已有填充弧）。
// 约定：空对话（无历史消息且输入框为空）圆环为 0；有输入草稿或有历史消息后才按
// 「文档上下文 + 历史 + 输入」估算。

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
dom.window.localStorage.setItem('nl-ai-chat-id', 'c-ctx-ring-test')

const handlers = [] // transformCallback 抓到的事件处理器
let streamReqId = null
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
        return Promise.resolve()
      case 'ai_chat_read':
        return Promise.resolve(null) // 最近存档不存在 → 当新会话
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

const root = document.createElement('div')
document.body.appendChild(root)
let panel = createAiPanel({
  root,
  getConfig: () => ({ baseUrl: 'http://x/v1', apiKey: '', model: 'm', contextTokens: 0 }),
  openSettings: () => {},
  // 大文档上下文：没有「空对话归零」的修复时圆环必然非零
  getDocContext: () => '文档正文'.repeat(2000),
  insertToDoc: () => {},
  setStatus: () => {},
  vaultReady: () => false,
})

const ring = () => root.querySelector('.ai-ctx-ring circle.ai-ctx-arc')
const dashoffset = () => parseFloat(ring().getAttribute('stroke-dashoffset'))
// r=7，周长约 44.0：pct=0 时 dashoffset 等于周长
const FULL = 2 * Math.PI * 7

const input = root.querySelector('.ai-input')
const type = (text) => {
  input.value = text
  input.dispatchEvent(new window.Event('input', { bubbles: true }))
}

let pass = 0
let fail = 0
async function t(name, fn) {
  try {
    await fn()
    pass++
    console.log('  ok -', name)
  } catch (e) {
    fail++
    console.error('  FAIL -', name)
    console.error('   ', e && e.message)
  }
}

console.log('ai-panel 上下文圆环：空对话归零')

await t('挂载后空对话（空输入、空历史、文档上下文非空）圆环为 0', () => {
  assert.ok(Math.abs(dashoffset() - FULL) < 0.05, 'dashoffset 应等于周长（0%），实为 ' + dashoffset())
  assert.ok(root.querySelector('.ai-ctx-ring').title.includes('0%'), '提示应显示 0%，实为 ' + root.querySelector('.ai-ctx-ring').title)
})

await t('空对话里敲进草稿：按「文档上下文 + 输入」估算，圆环非零', () => {
  type('你好')
  assert.ok(dashoffset() < FULL - 0.05, '有输入后圆环应有填充，实为 ' + dashoffset())
})

await t('草稿清空后圆环回到 0', () => {
  type('')
  assert.ok(Math.abs(dashoffset() - FULL) < 0.05, '清空后应归零，实为 ' + dashoffset())
})

await t('发出第一条消息后（草稿被清空但历史非空）圆环按「文档上下文 + 历史」估算，非零', async () => {
  streamReqId = null
  type('第一问')
  root.querySelector('.ai-send').click()
  // 发送链路上 history.push 与 updateCtxRing 都在同步段完成
  await new Promise((r) => setTimeout(r, 20))
  assert.ok(input.value === '', '发送后输入框应清空')
  assert.ok(dashoffset() < FULL - 0.05, '有历史后圆环应有填充，实为 ' + dashoffset())
  assert.ok(streamReqId, 'send 应触发 ai_chat_stream')
})

console.log('')
console.log(`${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
