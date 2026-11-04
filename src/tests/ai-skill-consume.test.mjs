// ai-skill-consume.test.mjs —— 对话框里选中的技能「发送即消费」回归
// 运行：cd src && node tests/ai-skill-consume.test.mjs
//
// 期望：技能是一次性上下文——选中后随这条消息发出（进 system），发完即从 composer 消费掉，
// 下一条消息不再自动带上。此前它会一直挂着（chip 不消失、每轮都注入）。
// 走真 ai-panel.js：ai_skills_scan 打桩回一条技能，抓 ai_chat_stream 的 messages 断注入与不再注入；
// 每问之后推一个 done 事件收尾（清 streaming），否则下一问被「streaming 中」拦下发不出去。

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
dom.window.localStorage.setItem('nl-ai-mode', 'ask')
// 预置一个选中技能（activeSkillPaths 在模块加载时读它）
dom.window.localStorage.setItem('nl-ai-skill', JSON.stringify(['/skills/demo/SKILL.md']))

const streamMsgs = [] // 每次 ai_chat_stream 收到的 messages 快照
const handlers = [] // transformCallback 抓到的事件处理器
let streamReqId = null
let idSeq = 0
window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} }
window.__TAURI_INTERNALS__ = {
  transformCallback(cb) { handlers.push(cb); return ++idSeq },
  invoke(cmd, args) {
    switch (cmd) {
      case 'ai_chat_stream':
        streamReqId = (args && args.args && args.args.reqId) || null
        streamMsgs.push(((args && args.args && args.args.messages) || []).map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))))
        return Promise.resolve()
      case 'ai_chat_cancel':
        return Promise.resolve()
      case 'ai_skills_scan':
        return Promise.resolve([{ id: 'demo', name: 'demo', path: '/skills/demo/SKILL.md', content: 'DESKILL-CONTENT' }])
      case 'ai_chat_save':
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
  for (const h of handlers) { try { h({ payload }) } catch { /* 非本事件的处理器 */ } }
}
function send(root, text) {
  const input = root.querySelector('.ai-input')
  input.value = text
  root.querySelector('.ai-send').click()
}
async function until(fn, ms = 3000) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) { if (fn()) return true; await new Promise((r) => setTimeout(r, 10)) }
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
// 等 ai_skills_scan 的 .then 跑完（skillsLoaded=true），桩是微任务级，给一次宏任务足够
await new Promise((r) => setTimeout(r, 30))

let pass = 0
let fail = 0
async function t(name, fn) {
  try { await fn(); pass++; console.log('  ok   ' + name) }
  catch (e) { fail++; console.log('  FAIL ' + name + ' —— ' + ((e && e.message) || e)) }
}

await t('第一问：选中的技能作为 system 注入请求', async () => {
  streamMsgs.length = 0
  send(root, '第一问')
  assert.ok(await until(() => streamMsgs.length >= 1), 'send 应触发一次 ai_chat_stream')
  assert.ok(streamMsgs[0].some((m) => m.includes('DESKILL-CONTENT')), '首条请求应含技能正文：' + JSON.stringify(streamMsgs[0]))
  fire({ reqId: streamReqId, kind: 'done' }) // 收尾清 streaming
})

await t('发送后技能被消费：localStorage 选择清空、chip 撤下', async () => {
  assert.strictEqual(JSON.parse(localStorage.getItem('nl-ai-skill')).length, 0, 'nl-ai-skill 应清空')
  assert.ok(await until(() => !root.querySelector('.ai-skill-chip')), 'chip 行应消失')
})

await t('第二问：不再自动带上该技能', async () => {
  streamMsgs.length = 0
  send(root, '第二问')
  assert.ok(await until(() => streamMsgs.length >= 1), 'send 应触发一次 ai_chat_stream')
  assert.ok(!streamMsgs[0].some((m) => m.includes('DESKILL-CONTENT')), '第二条请求不应含技能正文：' + JSON.stringify(streamMsgs[0]))
  fire({ reqId: streamReqId, kind: 'done' })
})

panel.destroy()
root.remove()
console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
