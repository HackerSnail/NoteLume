// ai-skill-consume.test.mjs —— 技能「发送即消费 + 消息回显 + 跨重启持久化」回归
// 运行：cd src && node tests/ai-skill-consume.test.mjs
//
// 期望：
//  1) 选中的技能随这条消息发出（进 system），发完即从 composer 消费掉，下一条不再带上；
//  2) 发出的用户消息顶部带技能回显；
//  3) 回显持久化：history / 存档里用户消息带 _skills（重启后恢复会话仍渲染），但不进 API 请求体（严格服务端会因多余字段 400）。
// 走真 ai-panel.js：ai_skills_scan / ai_chat_stream / ai_chat_save / ai_chat_read 全打桩。

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
dom.window.localStorage.setItem('nl-ai-skill', JSON.stringify(['/skills/demo/SKILL.md']))

const streamMsgs = [] // 每次 ai_chat_stream 收到的完整 messages（原始对象，验 _skills 不被发出）
const handlers = []
let streamReqId = null
let savedJson = ''
let restorePayload = null // ai_chat_read 返回值（恢复会话用）
let idSeq = 0
window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} }
window.__TAURI_INTERNALS__ = {
  transformCallback(cb) { handlers.push(cb); return ++idSeq },
  invoke(cmd, args) {
    switch (cmd) {
      case 'ai_chat_stream':
        streamReqId = (args && args.args && args.args.reqId) || null
        streamMsgs.push((args && args.args && args.args.messages) || [])
        return Promise.resolve()
      case 'ai_chat_cancel':
        return Promise.resolve()
      case 'ai_skills_scan':
        return Promise.resolve([{ id: 'demo', name: 'demo', path: '/skills/demo/SKILL.md', content: 'DESKILL-CONTENT' }])
      case 'ai_chat_save':
        savedJson = (args && args.json) || ''
        return Promise.resolve()
      case 'ai_chat_read':
        return Promise.resolve(restorePayload)
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
async function until(fn, ms = 3000) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) { if (fn()) return true; await new Promise((r) => setTimeout(r, 10)) }
  return false
}
function makePanel() {
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
  return { panel, root }
}
function send(root, text) {
  const input = root.querySelector('.ai-input')
  input.value = text
  root.querySelector('.ai-send').click()
}

let pass = 0
let fail = 0
async function t(name, fn) {
  try { await fn(); pass++; console.log('  ok   ' + name) }
  catch (e) { fail++; console.log('  FAIL ' + name + ' —— ' + ((e && e.message) || e)) }
}

await t('第一问：技能注入请求、消息带回显', async () => {
  const { panel, root } = makePanel()
  await new Promise((r) => setTimeout(r, 30)) // 等 ai_skills_scan 置 skillsLoaded
  streamMsgs.length = 0
  savedJson = ''
  send(root, '第一问')
  assert.ok(await until(() => streamMsgs.length >= 1), 'send 应触发一次 ai_chat_stream')
  const contents = streamMsgs[0].map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
  assert.ok(contents.some((c) => c.includes('DESKILL-CONTENT')), '首条请求应含技能正文')
  assert.ok(streamMsgs[0].every((m) => !('_skills' in m)), '请求体不得带 _skills 元字段（严格服务端会 400）')
  const echo = root.querySelector('.ai-msg.ai-user .ai-skill-echo')
  assert.ok(echo && echo.textContent.includes('demo'), '发出的用户消息应带技能回显')
  fire({ reqId: streamReqId, kind: 'done' }) // 收尾 → saveChat
  panel.destroy(); root.remove()
})

await t('发送后消费：选择清空、chip 撤下、第二问不带技能', async () => {
  const { panel, root } = makePanel()
  await new Promise((r) => setTimeout(r, 30))
  streamMsgs.length = 0
  send(root, '第二问')
  assert.ok(await until(() => streamMsgs.length >= 1), 'send 应触发一次 ai_chat_stream')
  assert.strictEqual(JSON.parse(localStorage.getItem('nl-ai-skill')).length, 0, 'nl-ai-skill 应已被上一问清空')
  assert.ok(!root.querySelector('.ai-skill-chip'), 'composer 不应再有技能 chip')
  const contents = streamMsgs[0].map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
  assert.ok(!contents.some((c) => c.includes('DESKILL-CONTENT')), '第二问请求不应含技能正文')
  fire({ reqId: streamReqId, kind: 'done' })
  panel.destroy(); root.remove()
})

await t('持久化：存档里用户消息带 _skills', async () => {
  dom.window.localStorage.setItem('nl-ai-skill', JSON.stringify(['/skills/demo/SKILL.md'])) // 上一问已消费，重新选上
  const { panel, root } = makePanel()
  await new Promise((r) => setTimeout(r, 30))
  savedJson = ''
  send(root, '存档问')
  assert.ok(await until(() => streamMsgs.length >= 1), 'send 应触发 ai_chat_stream')
  fire({ reqId: streamReqId, kind: 'done' }) // finishDone → saveChat
  assert.ok(await until(() => savedJson.includes('_skills')), '存档应含 _skills：' + savedJson.slice(0, 200))
  const doc = JSON.parse(savedJson)
  const u = doc.messages.find((m) => m.role === 'user')
  assert.ok(Array.isArray(u._skills) && u._skills.includes('demo'), '用户消息应带 _skills=[demo]')
  panel.destroy(); root.remove()
})

await t('跨重启：恢复会话时按存档 _skills 渲染回显', async () => {
  restorePayload = JSON.stringify({ v: 1, id: 'cX', messages: [
    { role: 'user', content: '旧问题', _skills: ['demo'] },
    { role: 'assistant', content: '旧回答' },
  ] })
  dom.window.localStorage.setItem('nl-ai-chat-id', 'cX')
  const { panel, root } = makePanel()
  assert.ok(await until(() => root.querySelector('.ai-msg.ai-user .ai-skill-echo')), '恢复会话应渲染技能回显')
  const echo = root.querySelector('.ai-msg.ai-user .ai-skill-echo')
  assert.ok(echo.textContent.includes('demo'), '回显应含技能名：' + echo.textContent)
  panel.destroy(); root.remove()
  dom.window.localStorage.removeItem('nl-ai-chat-id')
  restorePayload = null
})

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
