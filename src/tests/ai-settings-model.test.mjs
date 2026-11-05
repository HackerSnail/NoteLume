// ai-settings-model.test.mjs —— AI 设置「模型名」：候选下拉常显 + 输入框可手输，两样都要
// 运行：cd src && node tests/ai-settings-model.test.mjs
//
// 期望：拉到 /models 就在输入框下面常显一个原生下拉（升序、草稿为空时自动填第一个并选中），
// 输入框同时随时可直接敲——列表里没有的名字也存得下，且下拉退回占位项不谎报选中。
// 旧版两处都不对：拉取失败时把草稿里那个模型名塞成唯一选项的下拉（看着可选、实际改不动），
// 换成 datalist 后 WKWebView 基本不弹候选表（选项等于没了）。
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
function makePanel(getAi) {
  // 上一支用例断言失败时不会走到 s.close()，面板留在 DOM 里会把后面的查询带偏
  for (const stale of document.querySelectorAll('.nl-ap-overlay')) stale.remove()
  const applied = []
  const s = createAiSettings({
    getAi: getAi || (() => ({ baseUrl: 'http://x/v1', apiKey: '', model: '' })),
    apply: (cfg) => applied.push(cfg),
    flush: () => Promise.resolve(),
    setStatus: () => {},
  })
  return { s, applied }
}

const saveBtnClick = () => document.querySelectorAll('.nl-ap-top .nl-ks-btn')[0].click()
const modelInput = () => document.querySelector('.nl-ap-model input[type=text]')
const pickRow = () => document.querySelector('.nl-ap-model-pick')
const pickSel = () => document.querySelector('.nl-ap-model-pick select')
const pickOptions = () => [...document.querySelectorAll('.nl-ap-model-pick option')].map((o) => o.value)
const pickShown = () => pickRow() && !pickRow().classList.contains('hidden')
function setValue(el, v) {
  el.value = v
  el.dispatchEvent(new dom.window.Event('change', { bubbles: true }))
}

let pass = 0
let fail = 0
async function t(name, fn) {
  try { await fn(); pass++; console.log('  ok   ' + name) }
  catch (e) { fail++; console.log('  FAIL ' + name + ' —— ' + ((e && e.message) || e)) }
}

await t('拉到模型：下拉常显且候选升序，草稿为空自动填第一个并选中，输入框仍可改', async () => {
  const { s } = makePanel()
  s.open()
  assert.ok(await until(() => pickSel()), '应出现候选下拉')
  assert.ok(pickShown(), '没点没聚焦也该看得见')
  assert.deepStrictEqual(pickOptions(), ['', 'a-model', 'b-model'], '首项是占位，其余按名称升序')
  const input = modelInput()
  assert.ok(input, '模型名应是输入框')
  assert.ok(!input.disabled, '拉到列表后输入框不该禁用')
  assert.strictEqual(input.value, 'a-model', '草稿为空时填第一个')
  assert.strictEqual(pickSel().value, 'a-model', '下拉要选中当前值')
  s.close()
})

await t('下拉选一项即回填输入框并写进草稿，保存后 apply 带上该模型', async () => {
  const { s, applied } = makePanel()
  s.open()
  assert.ok(await until(() => pickSel()), '应出现候选下拉')
  setValue(pickSel(), 'b-model')
  assert.strictEqual(modelInput().value, 'b-model', '下拉选完要回填输入框')
  saveBtnClick()
  assert.ok(await until(() => applied.length >= 1), '保存应触发 apply')
  assert.strictEqual(applied[0].model, 'b-model', 'apply 的 model 应是选中的候选')
  s.close()
})

await t('手输列表外的名字：照样存得下，下拉退回占位不谎报选中', async () => {
  const { s, applied } = makePanel()
  s.open()
  assert.ok(await until(() => pickSel()), '应出现候选下拉')
  setValue(modelInput(), 'Qwen/Qwen2.5-7B-Instruct')
  assert.strictEqual(pickSel().value, '', '列表外的值不该让下拉停在某一项上')
  saveBtnClick()
  assert.ok(await until(() => applied.length >= 1))
  assert.strictEqual(applied[0].model, 'Qwen/Qwen2.5-7B-Instruct', '列表外的名字不该被候选覆盖')
  assert.strictEqual(modelInput().value, 'Qwen/Qwen2.5-7B-Instruct', '保存后输入框仍显示手输的值')
  s.close()
})

await t('手输留下的名字重开面板仍是下拉里的一项，且是选中态', async () => {
  const { s } = makePanel(() => ({ baseUrl: 'http://x/v1', apiKey: '', model: 'my-custom-model' }))
  s.open()
  assert.ok(await until(() => pickSel()), '重开后应出现候选下拉')
  assert.ok(pickOptions().includes('my-custom-model'), '草稿里的名字要进候选')
  assert.strictEqual(pickSel().value, 'my-custom-model')
  assert.strictEqual(modelInput().value, 'my-custom-model', '重开仍显示原值，不该被列表首项覆盖')
  s.close()
})

await t('拉取失败：没有候选下拉那一行，输入框仍可编辑并保存', async () => {
  modelsThrow = true
  try {
    const { s, applied } = makePanel()
    s.open()
    // 等拉取真正失败（错误提示只在 reject 之后才出现；加载中先显示禁用输入）
    assert.ok(await until(() => document.querySelector('.nl-ap-model .nl-ap-hint.err')), '应出失败提示')
    assert.ok(!pickShown(), '没有列表就不该摆一行空下拉')
    const input = modelInput()
    assert.ok(input && !input.disabled, '失败后仍要能直接敲模型名（旧版这里出只有一项的下拉，改不动）')
    setValue(input, 'deepseek-chat')
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
