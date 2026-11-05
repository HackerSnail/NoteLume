// ai-settings-model.test.mjs —— AI 设置「模型名」：候选可选 + 输入框可手输，两样都要
// 运行：cd src && node tests/ai-settings-model.test.mjs
//
// 期望：拉到 /models 就在输入框下方画一层可点候选（升序、草稿为空时自动填第一个、敲字即筛、
// Enter 取第一条），同时输入框全程可直接敲——候选里没有的名字也要存得下。
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
const modelInput = () => document.querySelector('.nl-ap-combo input[type=text]')
const comboList = () => document.querySelector('.nl-ap-combo-list')
const items = () => [...document.querySelectorAll('.nl-ap-combo-item')]
const shown = () => items().filter((it) => !it.classList.contains('hidden'))
const openList = () => comboList() && !comboList().classList.contains('hidden')
const type = (el, value) => {
  el.value = value
  el.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
}

let pass = 0
let fail = 0
async function t(name, fn) {
  try { await fn(); pass++; console.log('  ok   ' + name) }
  catch (e) { fail++; console.log('  FAIL ' + name + ' —— ' + ((e && e.message) || e)) }
}

await t('拉到模型：候选全在（升序）、草稿为空自动填第一个、输入框不禁用', async () => {
  const { s } = makePanel()
  s.open()
  assert.ok(await until(() => comboList()), '应出现候选列表')
  assert.deepStrictEqual(items().map((it) => it.textContent), ['a-model', 'b-model'], '候选应按名称升序')
  const input = modelInput()
  assert.ok(input, '模型名应是输入框')
  assert.ok(!input.disabled, '拉到列表后输入框不该禁用')
  assert.strictEqual(input.value, 'a-model', '草稿为空时填第一个')
  assert.ok(!openList(), '没聚焦时列表先收起')
  s.close()
})

await t('点输入框出列表，点候选即选中并写入草稿，保存后 apply 带上该模型', async () => {
  const { s, applied } = makePanel()
  s.open()
  assert.ok(await until(() => comboList()), '应出现候选列表')
  modelInput().focus()
  assert.ok(openList(), '聚焦后候选要可见')
  shown()[1].click()
  assert.strictEqual(modelInput().value, 'b-model', '点候选要回填输入框')
  assert.ok(!openList(), '选中后列表收起')
  saveBtnClick()
  assert.ok(await until(() => applied.length >= 1), '保存应触发 apply')
  assert.strictEqual(applied[0].model, 'b-model', 'apply 的 model 应是点选的候选')
  s.close()
})

await t('候选里的当前值有高亮标记', async () => {
  const { s } = makePanel()
  s.open()
  assert.ok(await until(() => comboList()), '应出现候选列表')
  modelInput().focus()
  assert.deepStrictEqual(items().filter((it) => it.classList.contains('active')).map((it) => it.textContent),
    ['a-model'], '当前值那一项要标出来')
  s.close()
})

await t('敲字即筛：只留匹配项；全无匹配时列表收起不挡路', async () => {
  const { s } = makePanel()
  s.open()
  assert.ok(await until(() => comboList()), '应出现候选列表')
  modelInput().focus()
  type(modelInput(), 'b-')
  assert.deepStrictEqual(shown().map((it) => it.textContent), ['b-model'], '只该留下含 b- 的候选')
  type(modelInput(), 'zzz')
  assert.ok(!openList(), '一条都不匹配时不该撑开空列表')
  s.close()
})

await t('候选里没有的名字：手输照样存得下，保存后输入框仍显示该值', async () => {
  const { s, applied } = makePanel()
  s.open()
  assert.ok(await until(() => comboList()), '应出现候选列表')
  const input = modelInput()
  input.focus()
  type(input, 'Qwen/Qwen2.5-7B-Instruct')
  input.dispatchEvent(new dom.window.Event('change', { bubbles: true }))
  saveBtnClick()
  assert.ok(await until(() => applied.length >= 1))
  assert.strictEqual(applied[0].model, 'Qwen/Qwen2.5-7B-Instruct', '列表外的名字不该被候选覆盖')
  assert.strictEqual(modelInput().value, 'Qwen/Qwen2.5-7B-Instruct', '保存后输入框仍显示手输的值')
  s.close()
})

await t('手输留下的名字重开面板也算一个候选（不是只存在于输入框里）', async () => {
  const { s } = makePanel()
  s.open()
  assert.ok(await until(() => comboList()), '应出现候选列表')
  const input = modelInput()
  input.focus()
  type(input, 'my-custom-model')
  saveBtnClick()
  s.close()

  for (const stale of document.querySelectorAll('.nl-ap-overlay')) stale.remove()
  const applied = []
  const s2 = createAiSettings({
    getAi: () => ({ baseUrl: 'http://x/v1', apiKey: '', model: 'my-custom-model' }),
    apply: (cfg) => applied.push(cfg),
    flush: () => Promise.resolve(),
    setStatus: () => {},
  })
  s2.open()
  assert.ok(await until(() => comboList()), '重开后应出现候选列表')
  assert.ok(items().map((it) => it.textContent).includes('my-custom-model'), '草稿里的名字要进候选')
  assert.strictEqual(modelInput().value, 'my-custom-model', '重开仍显示原值，不该被列表首项覆盖')
  s2.close()
})

await t('Enter 取当前筛出的第一条，Esc 收起列表', async () => {
  const { s } = makePanel()
  s.open()
  assert.ok(await until(() => comboList()), '应出现候选列表')
  const input = modelInput()
  input.focus()
  type(input, 'b')
  input.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  assert.strictEqual(input.value, 'b-model', 'Enter 要落进筛出的第一条')
  input.click() // 光标没离开输入框，再点一次唤回列表
  assert.ok(openList(), '点输入框应再展开')
  assert.deepStrictEqual(shown().map((it) => it.textContent), ['a-model', 'b-model'], '展开要看到全部候选，不是只剩当前值')
  input.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  assert.ok(!openList(), 'Esc 后列表收起')
  s.close()
})

await t('拉取失败：没有候选列表，输入框仍可编辑并保存', async () => {
  modelsThrow = true
  try {
    const { s, applied } = makePanel()
    s.open()
    // 等拉取真正失败（错误提示只在 reject 之后才出现；加载中先显示禁用输入）
    assert.ok(await until(() => document.querySelector('.nl-ap-model .nl-ap-hint.err')), '应出失败提示')
    assert.ok(!comboList(), '没有列表就不该画空候选层')
    assert.ok(!document.querySelector('.nl-ap-model select'), '不该再有下拉')
    const input = modelInput()
    assert.ok(input && !input.disabled, '失败后仍要能直接敲模型名（旧版这里出只有一项的下拉，改不动）')
    type(input, 'deepseek-chat')
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
