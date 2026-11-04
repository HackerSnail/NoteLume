// ai-settings-model.test.mjs —— AI 设置「模型名」自动检测出下拉（检测不到回落手输）回归
// 运行：cd src && node tests/ai-settings-model.test.mjs
//
// 期望：模型名不再是纯手输——填了合法地址后自动 GET /models 拉列表出下拉（升序、可选中即用），
// 草稿为空时选第一个；拉取失败 / 服务不提供 /models 时回落手动输入并给提示。
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
  const applied = []
  const s = createAiSettings({
    getAi: () => ({ baseUrl: 'http://x/v1', apiKey: '', model: '' }),
    apply: (cfg) => applied.push(cfg),
    flush: () => Promise.resolve(),
    setStatus: () => {},
  })
  return { s, applied }
}

let pass = 0
let fail = 0
async function t(name, fn) {
  try { await fn(); pass++; console.log('  ok   ' + name) }
  catch (e) { fail++; console.log('  FAIL ' + name + ' —— ' + ((e && e.message) || e)) }
}

await t('拉到模型：出下拉、升序、草稿为空选第一个', async () => {
  const { s } = makePanel()
  s.open()
  assert.ok(await until(() => document.querySelector('.nl-ap-model select')), '应出现模型下拉')
  const sel = document.querySelector('.nl-ap-model select')
  assert.deepStrictEqual([...sel.options].map((o) => o.value), ['a-model', 'b-model'], '应按名称升序')
  assert.strictEqual(sel.value, 'a-model', '草稿为空时选第一个')
  s.close()
})

await t('下拉选中即写进草稿，保存后 apply 带上该模型', async () => {
  const { s, applied } = makePanel()
  s.open()
  assert.ok(await until(() => document.querySelector('.nl-ap-model select')), '应出现模型下拉')
  const sel = document.querySelector('.nl-ap-model select')
  sel.value = 'b-model'
  sel.dispatchEvent(new dom.window.Event('change', { bubbles: true }))
  const saveBtn = document.querySelectorAll('.nl-ap-top .nl-ks-btn')[0]
  saveBtn.click()
  assert.ok(await until(() => applied.length >= 1), '保存应触发 apply')
  assert.strictEqual(applied[0].model, 'b-model', 'apply 的 model 应是下拉选中值')
  s.close()
})

await t('拉取失败：回落手动输入，不出下拉、给失败提示', async () => {
  modelsThrow = true
  try {
    const { s } = makePanel()
    s.open()
    // 等拉取真正失败（错误提示只在 reject 之后才出现；加载中先显示禁用输入）
    assert.ok(await until(() => document.querySelector('.nl-ap-model .nl-ap-hint.err')), '应出失败提示')
    assert.ok(!document.querySelector('.nl-ap-model select'), '不应有下拉')
    const input = document.querySelector('.nl-ap-model input[type=text]')
    assert.ok(input && !input.disabled, '应回落可编辑的手动输入')
    s.close()
  } finally {
    modelsThrow = false
  }
})

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
