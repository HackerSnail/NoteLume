// ai-settings-presets.test.mjs —— AI 设置预设行的选中态与「自定义」那颗
// 运行：cd src && node tests/ai-settings-presets.test.mjs
//
// 现象：五颗预设点下去以后界面没有任何回落信息，看不出当前地址算哪一家；
// 手输一个不在预设里的地址（自建 / 兼容网关）同样一片空白。
// 现在选中态永远跟着接口地址走：等于哪家就亮哪家，都不等于就亮「自定义」，
// 点「自定义」清空地址与模型名并把光标交给地址框。
// Key 仍按地址分格：切走再切回各家的 Key 都还在自己那一格。

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

window.__TAURI_INTERNALS__ = {
  transformCallback() { return 1 },
  invoke(cmd) {
    if (cmd === 'ai_models_list') return Promise.resolve([])
    return Promise.resolve(null)
  },
}

const { createAiSettings } = await import('../ai-settings.js')

const DEEP = 'https://api.deepseek.com/v1'
const KIMI = 'https://api.moonshot.cn/v1'
const SELF = 'https://api.siliconflow.cn/v1/chat/completions'
const DEEP_KEY = 'sk-deepseek-AAAAAAAA'

let pass = 0
let fail = 0
async function t(name, fn) {
  try { await fn(); pass++; console.log('  ok   ' + name) }
  catch (e) { fail++; console.log('  FAIL ' + name + ' —— ' + ((e && e.message) || e)) }
}

async function until(fn, ms = 2000) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) { if (fn()) return true; await new Promise((r) => setTimeout(r, 10)) }
  return false
}

function makeStore(initial) {
  for (const stale of document.querySelectorAll('.nl-ap-overlay')) stale.remove()
  const state = { cfg: initial, applied: [] }
  const s = createAiSettings({
    getAi: () => state.cfg,
    apply: (cfg) => { state.applied.push(cfg); state.cfg = cfg },
    flush: () => Promise.resolve(),
    setStatus: () => {},
  })
  return { s, state }
}

const chips = () => [...document.querySelectorAll('.nl-ai-presets button')]
const active = () => chips().filter((b) => b.classList.contains('active')).map((b) => b.textContent)
const chip = (label) => chips().find((b) => b.textContent === label)
const urlInput = () => document.querySelector('.nl-ap-body input[placeholder="https://api.deepseek.com/v1"]')
const keyInput = () => document.querySelector('.nl-ap-body input[type=password]')
const modelInput = () => document.querySelector('.nl-ap-model input[type=text]')
function setValue(input, v) {
  input.value = v
  input.dispatchEvent(new dom.window.Event('change', { bubbles: true }))
}

await t('预设行有六颗：五家服务加「自定义」', async () => {
  const { s } = makeStore({ baseUrl: DEEP, apiKey: DEEP_KEY, model: 'deepseek-chat' })
  s.open()
  assert.ok(await until(() => chips().length === 6), '应有六颗，实得 ' + chips().length)
  assert.deepStrictEqual(chips().map((b) => b.textContent),
    ['DeepSeek', '智谱 GLM', 'Kimi', 'OpenAI', 'Ollama（本机）', '自定义'])
  s.close()
})

await t('打开时地址是哪家就亮哪家，且永远只亮一颗', async () => {
  const { s } = makeStore({ baseUrl: DEEP, keys: { 'api.deepseek.com': DEEP_KEY }, model: 'deepseek-chat' })
  s.open()
  await until(() => chips().length === 6)
  assert.deepStrictEqual(active(), ['DeepSeek'])
  chip('Kimi').click()
  assert.deepStrictEqual(active(), ['Kimi'], '点下去选中态要跟着走')
  s.close()
})

await t('手输一个不在预设里的地址：选中态落到「自定义」，五家全清', async () => {
  const { s } = makeStore({ baseUrl: DEEP, keys: { 'api.deepseek.com': DEEP_KEY }, model: 'deepseek-chat' })
  s.open()
  await until(() => chips().length === 6)
  setValue(urlInput(), SELF)
  assert.ok(await until(() => active()[0] === '自定义'), '实际亮的是：' + active().join(','))
  assert.strictEqual(urlInput().value, SELF, '手输的地址不该被预设覆盖')
  s.close()
})

await t('点「自定义」：清空地址与模型名，光标交给地址框', async () => {
  const { s } = makeStore({ baseUrl: DEEP, keys: { 'api.deepseek.com': DEEP_KEY }, model: 'deepseek-chat' })
  s.open()
  await until(() => chips().length === 6)
  chip('自定义').click()
  assert.deepStrictEqual(active(), ['自定义'])
  assert.strictEqual(urlInput().value, '')
  assert.strictEqual(modelInput().value, '')
  assert.strictEqual(keyInput().value, '', 'DeepSeek 那格的 Key 不该留在界面上')
  assert.strictEqual(document.activeElement, urlInput(), '光标要落在接口地址输入框')
  s.close()
})

await t('自定义地址保存：按 host:port 分格存 Key，切回预设还能拿回各家那格', async () => {
  const { s, state } = makeStore({ baseUrl: DEEP, keys: { 'api.deepseek.com': DEEP_KEY }, model: 'deepseek-chat' })
  s.open()
  await until(() => chips().length === 6)
  chip('自定义').click()
  setValue(urlInput(), SELF)
  setValue(keyInput(), 'sk-silicon-CCCCCC')
  setValue(modelInput(), 'Qwen/Qwen2.5-7B-Instruct')
  document.querySelectorAll('.nl-ap-top .nl-ks-btn')[0].click()
  assert.ok(await until(() => state.applied.length >= 1), '保存应触发 apply')
  const cfg = state.applied[0]
  assert.strictEqual(cfg.baseUrl, SELF)
  assert.strictEqual(cfg.model, 'Qwen/Qwen2.5-7B-Instruct')
  assert.strictEqual(cfg.apiKey, 'sk-silicon-CCCCCC')
  assert.deepStrictEqual(cfg.keys, {
    'api.deepseek.com': DEEP_KEY,
    'api.siliconflow.cn': 'sk-silicon-CCCCCC',
  }, '自建端点单独一格，不冲掉 DeepSeek 的')
  s.close()
  // 重开：停在自定义地址，选中态与 Key 都按那一格回填
  s.open()
  assert.ok(await until(() => chips().length === 6))
  assert.deepStrictEqual(active(), ['自定义'])
  assert.strictEqual(keyInput().value, 'sk-silicon-CCCCCC')
  chip('DeepSeek').click()
  assert.strictEqual(urlInput().value, DEEP)
  assert.strictEqual(keyInput().value, DEEP_KEY, '切回 DeepSeek 拿回它那格')
  s.close()
})

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
