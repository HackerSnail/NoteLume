// ai-settings-per-key.test.mjs —— API Key 按接口地址分格：换服务商不串 Key
// 运行：cd src && node tests/ai-settings-per-key.test.mjs
//
// 现象：设置里点另一个预设（DeepSeek → Kimi）后，Key 输入框仍留着上一家的 Key，
// 于是拿 DeepSeek 的 Key 去请求 Kimi，接口回 401。Key 存成 ai.keys 按 host:port 分格后，
// 地址一变就换到那一格：没填过就是空，填过的切回来还在。
// 走真 ai-settings.js + 打桩 ai_models_list，逐格断言输入框的值与 apply 落盘的形状。

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
global.MouseEvent = dom.window.MouseEvent
dom.window.localStorage.setItem('nl-lang', 'zh-CN')

const DEEP = 'sk-deepseek-AAAAAAAA'
const KIMI = 'sk-kimi-BBBBBBBBBB'
const deepUrl = 'https://api.deepseek.com/v1'
const kimiUrl = 'https://api.moonshot.cn/v1'

const modelsCalls = [] // 每次 ai_models_list 的入参：地址与 Key 要成对
window.__TAURI_INTERNALS__ = {
  transformCallback() { return 1 },
  invoke(cmd, args) {
    if (cmd === 'ai_models_list') {
      modelsCalls.push(args)
      return Promise.resolve([]) // 拉不到列表不影响 Key 分格，走手输回落
    }
    return Promise.resolve(null)
  },
}

const { createAiSettings } = await import('../ai-settings.js')

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

// 一个假 settings.json：apply 写回，重开面板读回，串起「保存 → 再打开」这一圈
function makeStore(initial) {
  const state = { cfg: initial, applied: [] }
  const s = createAiSettings({
    getAi: () => state.cfg,
    apply: (cfg) => { state.applied.push(cfg); state.cfg = cfg },
    flush: () => Promise.resolve(),
    setStatus: () => {},
  })
  return { s, state }
}

const urlInput = () => document.querySelector('.nl-ap-body input[placeholder="https://api.deepseek.com/v1"]')
const keyInput = () => document.querySelector('.nl-ap-body input[type=password]')
const presetBtn = (label) => [...document.querySelectorAll('.nl-ai-presets button')].find((b) => b.textContent === label)
const saveBtn = () => document.querySelectorAll('.nl-ap-top .nl-ks-btn')[0]

function setValue(input, v) {
  input.value = v
  input.dispatchEvent(new dom.window.Event('change', { bubbles: true }))
}

await t('旧版单 Key 打开面板：回填到当前地址那一格，不弄丢用户已填的值', async () => {
  const { s } = makeStore({ baseUrl: deepUrl, apiKey: DEEP, model: 'deepseek-chat' })
  s.open()
  assert.ok(await until(() => keyInput()), 'Key 输入框应存在')
  assert.strictEqual(keyInput().value, DEEP)
  s.close()
})

await t('点 Kimi 预设：地址与模型换过去，Key 清空（DeepSeek 的不带过来）', async () => {
  const { s } = makeStore({ baseUrl: deepUrl, apiKey: DEEP, model: 'deepseek-chat' })
  s.open()
  assert.ok(await until(() => keyInput()), 'Key 输入框应存在')
  presetBtn('Kimi').click()
  assert.strictEqual(urlInput().value, kimiUrl, '地址应换成 Kimi')
  assert.strictEqual(keyInput().value, '', 'Kimi 没填过 Key，就该是空')
  s.close()
})

await t('两家各填各的：保存落盘是 ai.keys 两格 + 当前地址的 apiKey 镜像', async () => {
  const { s, state } = makeStore({ baseUrl: deepUrl, apiKey: DEEP, model: 'deepseek-chat' })
  s.open()
  await until(() => keyInput())
  presetBtn('Kimi').click()
  setValue(keyInput(), KIMI)
  saveBtn().click()
  assert.ok(await until(() => state.applied.length >= 1), '保存应触发 apply')
  const cfg = state.applied[0]
  assert.strictEqual(cfg.baseUrl, kimiUrl)
  assert.strictEqual(cfg.apiKey, KIMI, 'apiKey 是当前地址那一格的镜像')
  assert.deepStrictEqual(cfg.keys, { 'api.deepseek.com': DEEP, 'api.moonshot.cn': KIMI }, '两格互不覆盖')
  s.close()
})

await t('重开面板切回 DeepSeek：那一格的 Key 还在，切走再切回不丢', async () => {
  const { s, state } = makeStore({ baseUrl: deepUrl, apiKey: DEEP, model: 'deepseek-chat' })
  s.open()
  await until(() => keyInput())
  presetBtn('Kimi').click()
  setValue(keyInput(), KIMI)
  saveBtn().click()
  await until(() => state.applied.length >= 1)
  s.close()
  s.open()
  assert.ok(await until(() => keyInput()), '重开后 Key 输入框应存在')
  assert.strictEqual(keyInput().value, KIMI, '重开时停在 Kimi，显示 Kimi 的 Key')
  presetBtn('DeepSeek').click()
  assert.strictEqual(keyInput().value, DEEP)
  assert.strictEqual(urlInput().value, deepUrl)
  s.close()
})

await t('手输地址也换格：改成没填过的地址，Key 就地清空', async () => {
  const { s } = makeStore({ baseUrl: deepUrl, apiKey: DEEP, model: 'deepseek-chat' })
  s.open()
  await until(() => keyInput())
  setValue(urlInput(), 'https://api.openai.com/v1')
  assert.ok(await until(() => keyInput()), 'change 后输入框仍在')
  assert.strictEqual(keyInput().value, '', 'OpenAI 那格没填过')
  setValue(urlInput(), deepUrl)
  assert.strictEqual(keyInput().value, DEEP, '改回 DeepSeek 又拿回那一格')
  s.close()
})

await t('地址还没填合法时敲的 Key：归到新地址那一格，不串也不丢', async () => {
  const { s, state } = makeStore({ baseUrl: '', apiKey: '', model: '' })
  s.open()
  await until(() => keyInput())
  setValue(keyInput(), DEEP)
  setValue(urlInput(), deepUrl)
  assert.strictEqual(keyInput().value, DEEP, '先敲的 Key 跟着新地址落到那一格')
  saveBtn().click()
  assert.ok(await until(() => state.applied.length >= 1))
  assert.deepStrictEqual(state.applied[0].keys, { 'api.deepseek.com': DEEP })
  s.close()
})

await t('清空 Key：那一格整条删掉，不留空串', async () => {
  const { s, state } = makeStore({ baseUrl: deepUrl, keys: { 'api.deepseek.com': DEEP, 'api.moonshot.cn': KIMI }, model: 'deepseek-chat' })
  s.open()
  await until(() => keyInput())
  setValue(keyInput(), '   ')
  saveBtn().click()
  assert.ok(await until(() => state.applied.length >= 1))
  const cfg = state.applied[0]
  assert.strictEqual(cfg.apiKey, '')
  assert.deepStrictEqual(cfg.keys, { 'api.moonshot.cn': KIMI }, '只删当前格，别家不动')
  s.close()
})

await t('拉模型列表带的 Key 就是当前地址那一格', async () => {
  modelsCalls.length = 0
  const { s } = makeStore({ baseUrl: deepUrl, keys: { 'api.deepseek.com': DEEP, 'api.moonshot.cn': KIMI }, model: 'deepseek-chat' })
  s.open()
  assert.ok(await until(() => modelsCalls.length >= 1), '打开面板应拉一次模型')
  assert.deepStrictEqual(modelsCalls[0], { baseUrl: deepUrl, apiKey: DEEP })
  presetBtn('Kimi').click()
  assert.ok(await until(() => modelsCalls.length >= 2), '换地址应重拉一次')
  assert.deepStrictEqual(modelsCalls[1], { baseUrl: kimiUrl, apiKey: KIMI }, '重拉要带 Kimi 那格的 Key')
  s.close()
})

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
