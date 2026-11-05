// ai-settings-model.test.mjs —— AI 设置「模型名」：可手输的输入框，/models 只当候选
// 运行：cd src && node tests/ai-settings-model.test.mjs
//
// 期望：模型名永远改得动——拉到 /models 就把列表挂成 datalist 候选（升序、草稿为空时自动填第一个），
// 拉不到、或要用的模型不在候选里（自建与兼容网关常见），敲进去照样能存。
// 旧版拉取失败时会把草稿里那个模型名塞成唯一选项的下拉，看着可选，实际一个值都改不动。
// 走真 ai-settings.js + 打桩 ai_models_list。

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

let modelsReply = ['b-model', 'a-model'] // 故意乱序，验升序
let modelsThrow = false
window.__TAURI_INTERNALS__ = {
  transformCallback() { return 1 },
  invoke(cmd) {
    if (cmd === 'ai_models_list') {
      return modelsThrow ? Promise.reject(new Error('boom')) : Promise.resolve(modelsReply)
    }
    return Promise.resolve(null)
  },
}

const { createAiSettings } = await import('../ai-settings.js')

async function until(fn, ms = 3000) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) { if (fn()) return true; await new Promise((r) => setTimeout(r, 10)) }
  return false
}
function makePanel() {
  // 上一支用例断言失败时不会走到 s.close()，面板留在 DOM 里会把后面的查询带偏
  for (const stale of document.querySelectorAll('.nl-ap-overlay')) stale.remove()
  const applied = []
  const s = createAiSettings({
    getAi: () => ({ baseUrl: 'http://x/v1', apiKey: '', model: '' }),
    apply: (cfg) => applied.push(cfg),
    flush: () => Promise.resolve(),
    setStatus: () => {},
  })
  return { s, applied }
}

const saveBtnClick = () => document.querySelectorAll('.nl-ap-top .nl-ks-btn')[0].click()

let pass = 0
let fail = 0
async function t(name, fn) {
  try { await fn(); pass++; console.log('  ok   ' + name) }
  catch (e) { fail++; console.log('  FAIL ' + name + ' —— ' + ((e && e.message) || e)) }
}

await t('拉到模型：候选表升序挂上，草稿为空自动填第一个，输入框仍可改', async () => {
  const { s } = makePanel()
  s.open()
  assert.ok(await until(() => document.querySelector('.nl-ap-model datalist')), '应出现候选表')
  const list = document.querySelector('.nl-ap-model datalist')
  assert.deepStrictEqual([...list.options].map((o) => o.value), ['a-model', 'b-model'], '候选应按名称升序')
  const input = document.querySelector('.nl-ap-model input[type=text]')
  assert.ok(input, '模型名应是输入框')
  assert.ok(!input.disabled, '拉到列表后输入框不该禁用')
  assert.strictEqual(input.value, 'a-model', '草稿为空时填第一个')
  assert.strictEqual(input.getAttribute('list'), list.id, '输入框要挂上这张候选表')
  s.close()
})

await t('选中候选即写进草稿，保存后 apply 带上该模型', async () => {
  const { s, applied } = makePanel()
  s.open()
  assert.ok(await until(() => document.querySelector('.nl-ap-model datalist')), '应出现候选表')
  const input = document.querySelector('.nl-ap-model input[type=text]')
  input.value = 'b-model'
  input.dispatchEvent(new dom.window.Event('change', { bubbles: true }))
  const saveBtn = document.querySelectorAll('.nl-ap-top .nl-ks-btn')[0]
  saveBtn.click()
  assert.ok(await until(() => applied.length >= 1), '保存应触发 apply')
  assert.strictEqual(applied[0].model, 'b-model', 'apply 的 model 应是选中的候选')
  s.close()
})

await t('候选里没有的模型名也能手输保存（自建与兼容网关的常态）', async () => {
  const { s, applied } = makePanel()
  s.open()
  assert.ok(await until(() => document.querySelector('.nl-ap-model datalist')), '应出现候选表')
  const input = document.querySelector('.nl-ap-model input[type=text]')
  input.value = 'Qwen/Qwen2.5-7B-Instruct'
  input.dispatchEvent(new dom.window.Event('change', { bubbles: true }))
  saveBtnClick()
  assert.ok(await until(() => applied.length >= 1))
  assert.strictEqual(applied[0].model, 'Qwen/Qwen2.5-7B-Instruct', '列表外的名字不该被候选覆盖')
  assert.strictEqual(document.querySelector('.nl-ap-model input[type=text]').value,
    'Qwen/Qwen2.5-7B-Instruct', '保存后输入框仍显示手输的值')
  s.close()
})

await t('拉取失败：模型名仍是可编辑输入框，并给失败提示', async () => {
  modelsThrow = true
  try {
    const { s, applied } = makePanel()
    s.open()
    // 等拉取真正失败（错误提示只在 reject 之后才出现；加载中先显示禁用输入）
    assert.ok(await until(() => document.querySelector('.nl-ap-model .nl-ap-hint.err')), '应出失败提示')
    assert.ok(!document.querySelector('.nl-ap-model select'), '不该再有下拉')
    assert.ok(!document.querySelector('.nl-ap-model datalist'), '拉取失败时不该挂候选')
    const input = document.querySelector('.nl-ap-model input[type=text]')
    assert.ok(input && !input.disabled, '失败后仍要能直接敲模型名（旧版这里出只有一项的下拉，改不动）')
    input.value = 'deepseek-chat'
    input.dispatchEvent(new dom.window.Event('change', { bubbles: true }))
    saveBtnClick()
    assert.ok(await until(() => applied.length >= 1), '失败态下也要存得下')
    assert.strictEqual(applied[0].model, 'deepseek-chat')
    s.close()
  } finally {
    modelsThrow = false
  }
})

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
