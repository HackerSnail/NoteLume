// ai-inline-dom.test.mjs —— 选区 AI 浮层的请求边界：messages 必须是 OpenAI 数组
// 运行：cd src && node tests/ai-inline-dom.test.mjs
//
// 背景缺陷：main.js 曾把 buildTaskMessages 的 {system,user} 对象原样递进 messages，
// Rust 侧 AiChatArgs.messages 是 Vec<AiMessage>，IPC 反序列化当场失败，
// 五项选区任务在桌面上全不可用（真机报 invalid type: map, expected a sequence）。
// 本文件两头都钉住：生产方出数组、消费方对非数组就地拦下并发不出请求。
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

const streamCalls = [] // 每次 ai_chat_stream 的 args
const handlers = [] // transformCallback 收到的事件回调（用来投 nl:ai-event）
window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} }
window.__TAURI_INTERNALS__ = {
  transformCallback(callback) {
    handlers.push(callback)
    return handlers.length
  },
  invoke(cmd, payload) {
    if (cmd === 'ai_chat_stream') {
      streamCalls.push(payload.args)
      return Promise.resolve()
    }
    if (cmd === 'ai_chat_cancel') return Promise.resolve(false)
    return Promise.resolve(null)
  },
}

const { openAiInline, closeAiInline } = await import('../ai-inline.js')
const { buildTaskMessages } = await import('../ai-tasks.js')

let pass = 0
let fail = 0
function t(name, fn) {
  try {
    fn()
    pass++
    console.log('  ok   ' + name)
  } catch (e) {
    fail++
    console.log('  FAIL ' + name + ' —— ' + ((e && e.message) || e))
  }
}

const baseOpts = (messages) => ({
  title: '润色',
  anchorRect: { x: 40, y: 60, bottom: 80 },
  getConfig: () => ({ baseUrl: 'http://127.0.0.1:9/v1', apiKey: '', model: 'm' }),
  messages,
  onReplace: () => {},
  onInsert: () => {},
  setStatus: () => {},
})
const pop = () => document.querySelector('.nl-ai-pop')
const status = () => (pop() ? pop().querySelector('.nl-ai-pop-status').textContent : '')

t('buildTaskMessages 的产物直接喂给浮层，IPC 收到的是 role/content 数组', () => {
  streamCalls.length = 0
  closeAiInline()
  const msgs = buildTaskMessages('polish', '旧的句子', '')
  openAiInline(baseOpts(msgs))
  assert.strictEqual(streamCalls.length, 1, '应发出一次请求')
  const sent = streamCalls[0].messages
  assert.ok(Array.isArray(sent), 'messages 必须是数组（Rust Vec<AiMessage>）')
  assert.deepStrictEqual(sent.map((m) => m.role), ['system', 'user'])
  for (const m of sent) assert.strictEqual(typeof m.content, 'string')
  assert.ok(sent[1].content.includes('旧的句子'))
  closeAiInline()
})

t('非数组的 messages 就地拦下：不发请求，浮层出可读文案', () => {
  streamCalls.length = 0
  closeAiInline()
  // 复刻出事的旧形状
  openAiInline(baseOpts({ system: 'sys', user: 'usr' }))
  assert.strictEqual(streamCalls.length, 0, '坏形状不得发往 IPC')
  assert.ok(status().includes('消息必须是非空的数组'), '实际：' + status())
  closeAiInline()
})

t('空数组同样拦下（没消息就没有可发的请求）', () => {
  streamCalls.length = 0
  closeAiInline()
  openAiInline(baseOpts([]))
  assert.strictEqual(streamCalls.length, 0)
  assert.ok(pop(), '浮层仍要存在并显示错误态')
  closeAiInline()
})

t('流式增量渲染进正文，收尾后「替换选区」可点', () => {
  streamCalls.length = 0
  closeAiInline()
  openAiInline(baseOpts(buildTaskMessages('summarize', '一段长文', '')))
  const reqId = streamCalls[0].reqId
  // listen 是异步订阅，退订函数在 .then 里挂上；事件投递要等这一拍
  const fire = (payload) => handlers.forEach((h) => h({ payload }))
  fire({ reqId, kind: 'chunk', delta: '结论：' })
  fire({ reqId, kind: 'chunk', delta: '要点若干' })
  const body = pop().querySelector('.nl-ai-pop-body')
  assert.strictEqual(body.textContent, '结论：要点若干')
  assert.ok(!pop().querySelector('.nl-ks-btn.primary').disabled, '有结果后替换按钮即可点')
  fire({ reqId, kind: 'done' })
  assert.ok(status().length > 0)
  assert.ok(!pop().querySelector('.nl-ks-btn.primary').disabled, '收尾后替换按钮应可点')
  closeAiInline()
})

t('别的 reqId 的事件不吃（浮层只认自己那一路请求）', () => {
  streamCalls.length = 0
  closeAiInline()
  openAiInline(baseOpts(buildTaskMessages('continue', '前文', '')))
  const body = pop().querySelector('.nl-ai-pop-body')
  const fire = (payload) => handlers.forEach((h) => h({ payload }))
  fire({ reqId: 'not-mine', kind: 'chunk', delta: '串台内容' })
  assert.ok(!body.textContent.includes('串台内容'))
  closeAiInline()
})

t('连点重试只留一个「重试」按钮：失败态复用同一颗，不在底行铺一排', () => {
  streamCalls.length = 0
  closeAiInline()
  const unconfigured = { baseUrl: '', apiKey: '', model: '' }
  openAiInline({ ...baseOpts(buildTaskMessages('polish', '旧的句子', '')), getConfig: () => unconfigured })
  const retries = () => [...pop().querySelectorAll('.nl-ai-pop-foot button')].filter((b) => b.textContent === '重试')
  assert.strictEqual(retries().length, 1, '失败后底行只有一颗重试')
  assert.ok(!retries()[0].classList.contains('hidden'), '失败态要可见')
  for (const n of [2, 3, 4]) {
    retries()[0].click()
    assert.strictEqual(retries().length, 1, `第 ${n} 次失败后仍只有一颗`)
  }
  closeAiInline()
})

t('重试按钮随状态显隐：请求中收起，失败显形，成功后再收起', () => {
  streamCalls.length = 0
  closeAiInline()
  const fire = (payload) => handlers.forEach((h) => h({ payload }))
  openAiInline(baseOpts(buildTaskMessages('summarize', '一段长文', '')))
  const btn = [...pop().querySelectorAll('.nl-ai-pop-foot button')].find((b) => b.textContent === '重试')
  assert.ok(btn.classList.contains('hidden'), '刚发起时不该有重试')
  fire({ reqId: streamCalls[0].reqId, kind: 'error', error: '上游 500' })
  assert.ok(!btn.classList.contains('hidden'), '失败后显形')
  btn.click()
  assert.ok(btn.classList.contains('hidden'), '重发即收起')
  assert.strictEqual(streamCalls.length, 2, '点击重试重发一次请求')
  assert.notStrictEqual(streamCalls[1].reqId, streamCalls[0].reqId, '重发要换 reqId，否则旧流事件会串进来')
  fire({ reqId: streamCalls[1].reqId, kind: 'chunk', delta: '补上了' })
  fire({ reqId: streamCalls[1].reqId, kind: 'done' })
  assert.ok(btn.classList.contains('hidden'), '成功收尾后保持收起')
  assert.strictEqual(pop().querySelector('.nl-ai-pop-body').textContent, '补上了')
  closeAiInline()
})

// 结果卡的落位：按满高预留选边，流式长起来之后整张卡（连同底行按钮）都必须在窗口内
const openAt = (anchorRect, vh) => {
  Object.defineProperty(window, 'innerHeight', { value: vh, configurable: true, writable: true })
  closeAiInline()
  openAiInline({ ...baseOpts(buildTaskMessages('polish', '旧的句子', '')), anchorRect })
  return pop().style
}
const fits = (st, vh) => {
  const h = parseFloat(st.maxHeight)
  const top = st.top ? parseFloat(st.top) : vh - parseFloat(st.bottom) - h
  return top >= 8 && top + h <= vh - 8
}

t('选区在上方、下方空间够：卡开在下方，且预留满高 340 也不出窗口', () => {
  streamCalls.length = 0
  const st = openAt({ x: 40, y: 60, bottom: 80 }, 760)
  assert.strictEqual(st.top, '86px')
  assert.strictEqual(st.bottom, '', '下方放得下就不该用 bottom 锚定')
  assert.strictEqual(st.maxHeight, '340px')
  assert.ok(fits(st, 760))
  closeAiInline()
})

t('选区贴窗口底部时结果卡翻到上方：底行三颗按钮不能出窗口', () => {
  streamCalls.length = 0
  const st = openAt({ x: 40, y: 700, bottom: 720 }, 760)
  assert.strictEqual(st.top, '', '该走上方，不该留 top')
  assert.strictEqual(st.bottom, '66px')
  assert.ok(fits(st, 760), `满高 ${st.maxHeight} 应落在窗口内`)
  closeAiInline()
})

t('窗口压到最小高度、选区在中间：取宽的一侧并把 max-height 收到该侧可视高度', () => {
  streamCalls.length = 0
  const st = openAt({ x: 40, y: 300, bottom: 320 }, 560)
  assert.strictEqual(st.bottom, '266px')
  assert.strictEqual(st.maxHeight, '286px', '上方 286 比下方 226 宽，按上方留')
  assert.ok(fits(st, 560))
  closeAiInline()
})

console.log(`\n${pass} passed, ${fail} failed`)
process.exitCode = fail ? 1 : 0
