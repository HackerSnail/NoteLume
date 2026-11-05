// ai-model-filter.test.mjs —— /models 候选只留对话模型，选到向量模型要出提醒
// 运行：cd src && node tests/ai-model-filter.test.mjs
//
// 现象：接口地址填 https://api.siliconflow.cn/v1/chat/completions、模型名 BAAI/bge-m3，
// 发出去回 HTTP 400 {"code":20012,"message":"Model does not exist. Please check it carefully."}，
// 看着像「连不上」。实际是 bge-m3 是向量模型（embedding），SiliconFlow 的 /models 把它和
// 对话模型放在同一张表里，而设置面板按名称升序自动填第一个——B 打头的正好是它。
// 两道修：候选表摘掉非对话模型（chatModelsOnly），当前值看着不是对话模型时状态行出提醒；
// Rust 侧错误体另认顶层 message + code，界面不再糊一整串 JSON。

import assert from 'node:assert'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { JSDOM } from 'jsdom'

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' })
global.window = dom.window
global.document = dom.window.document
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true })
global.localStorage = dom.window.localStorage
global.HTMLElement = dom.window.HTMLElement
global.CustomEvent = dom.window.CustomEvent
global.Event = dom.window.Event
dom.window.localStorage.setItem('nl-lang', 'zh-CN')

// SiliconFlow /models 的真实形态节选：向量、重排、文生图、语音与对话模型混在一张表
const SILICON = [
  'BAAI/bge-m3',
  'BAAI/bge-reranker-v2-m3',
  'Pro/BAAI/bge-m3',
  'Qwen/Qwen3-Embedding-8B',
  'NetEase-MTC/src-embed-128k',
  'black-forest-labs/FLUX.1-schnell',
  'FunAudioLLM/CosyVoice2-0.5B',
  'deepseek-ai/DeepSeek-V3',
  'Qwen/Qwen2.5-VL-7B-Instruct',
  'Pro/deepseek-ai/DeepSeek-R1',
  'THUDM/glm-4-9b-chat',
  'Qwen/Qwen2.5-7B-Instruct',
]

let modelsReply = []
window.__TAURI_INTERNALS__ = {
  transformCallback() { return 1 },
  invoke(cmd) {
    if (cmd === 'ai_models_list') return Promise.resolve(modelsReply)
    return Promise.resolve(null)
  },
}

const { isNonChatModel, chatModelsOnly } = await import('../ai-tasks.js')
const { createAiSettings } = await import('../ai-settings.js')

async function until(fn, ms = 3000) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) { if (fn()) return true; await new Promise((r) => setTimeout(r, 10)) }
  return false
}
function makePanel(model = '') {
  for (const stale of document.querySelectorAll('.nl-ap-overlay')) stale.remove()
  const s = createAiSettings({
    getAi: () => ({ baseUrl: 'https://api.siliconflow.cn/v1/chat/completions', apiKey: 'k', model }),
    apply: () => {},
    flush: () => Promise.resolve(),
    setStatus: () => {},
  })
  return s
}
const hintEl = () => document.querySelector('.nl-ap-model .nl-ap-hint')
const modelInput = () => document.querySelector('.nl-ap-model input[type=text]')
// 候选行：拉到 /models 才出，里面是一个原生 select（首项是 value 为空的占位项）
const pickSel = () => document.querySelector('.nl-ap-model-pick select')
const pickOpts = () => (pickSel() ? [...pickSel().options].map((o) => o.value).filter(Boolean) : [])

let pass = 0
let fail = 0
async function t(name, fn) {
  try { await fn(); pass++; console.log('  ok   ' + name) }
  catch (e) { fail++; console.log('  FAIL ' + name + ' —— ' + ((e && e.message) || e)) }
}

await t('向量 / 重排 / 文生图 / 语音模型判为非对话模型', () => {
  for (const id of ['BAAI/bge-m3', 'BAAI/bge-reranker-v2-m3', 'Pro/BAAI/bge-m3',
    'Qwen/Qwen3-Embedding-8B', 'NetEase-MTC/src-embed-128k', 'black-forest-labs/FLUX.1-schnell',
    'FunAudioLLM/CosyVoice2-0.5B', 'BAAI/bge-large-zh-v1.5']) {
    assert.ok(isNonChatModel(id), `${id} 应判为非对话模型`)
  }
  assert.ok(!isNonChatModel(''), '空名不算')
})

await t('对话模型（含视觉对话与 chat 结尾的）不误删', () => {
  for (const id of ['deepseek-chat', 'deepseek-reasoner', 'Qwen/Qwen2.5-VL-7B-Instruct',
    'THUDM/glm-4-9b-chat', 'Pro/deepseek-ai/DeepSeek-R1', 'moonshotai/kimi-k2-instruct',
    'Qwen/Qwen2.5-7B-Instruct', 'gpt-4o']) {
    assert.ok(!isNonChatModel(id), `${id} 是对话模型，不该被摘掉`)
  }
})

await t('chatModelsOnly：混表只留对话项，顺序不动', () => {
  assert.deepStrictEqual(chatModelsOnly(SILICON), [
    'deepseek-ai/DeepSeek-V3',
    'Qwen/Qwen2.5-VL-7B-Instruct',
    'Pro/deepseek-ai/DeepSeek-R1',
    'THUDM/glm-4-9b-chat',
    'Qwen/Qwen2.5-7B-Instruct',
  ])
})

await t('chatModelsOnly：全表都是非对话模型时回原表，不给空候选', () => {
  const only = ['BAAI/bge-m3', 'BAAI/bge-reranker-v2-m3']
  assert.deepStrictEqual(chatModelsOnly(only), only)
  assert.deepStrictEqual(chatModelsOnly([]), [])
  assert.deepStrictEqual(chatModelsOnly(null), [])
  assert.deepStrictEqual(chatModelsOnly(['a', '', 'a', '  ']), ['a'], '空串与重复先清掉')
})

await t('设置面板：候选下拉不含向量模型，自动填的是对话模型', async () => {
  modelsReply = SILICON
  const s = makePanel('')
  s.open()
  assert.ok(await until(() => pickSel()), '应出现候选下拉')
  const opts = pickOpts()
  assert.ok(!opts.some((o) => /bge-|embed|FLUX|CosyVoice/i.test(o)), `候选里还有非对话模型：${opts.join(',')}`)
  // 升序后第一个是 deepseek-ai/DeepSeek-V3（改前会填到 BAAI/bge-m3）
  assert.strictEqual(modelInput().value, 'deepseek-ai/DeepSeek-V3', '草稿为空应填第一个对话模型')
  assert.strictEqual(pickSel().value, 'deepseek-ai/DeepSeek-V3', '下拉选中态要与输入框一致')
  assert.ok(!hintEl().classList.contains('err'), '正常模型不该出提醒')
  s.close()
})

await t('当前模型名是向量模型：候选保留它，状态行出红字提醒', async () => {
  modelsReply = SILICON
  const s = makePanel('BAAI/bge-m3')
  s.open()
  assert.ok(await until(() => pickSel()), '应出现候选下拉')
  assert.ok(pickOpts().includes('BAAI/bge-m3'), '用户已存的值不能从候选里消失')
  assert.strictEqual(modelInput().value, 'BAAI/bge-m3', '已有值不能被自动改掉')
  assert.strictEqual(pickSel().value, 'BAAI/bge-m3', '已存的值在下拉里就是选中项')
  assert.ok(await until(() => hintEl().classList.contains('err')), '状态行应报错态')
  assert.match(hintEl().textContent, /向量|重排/, `提醒文案不对：${hintEl().textContent}`)
  s.close()
})

await t('手输改成对话模型后提醒收掉（change 走 syncModelStatus）', async () => {
  modelsReply = SILICON
  const s = makePanel('BAAI/bge-m3')
  s.open()
  assert.ok(await until(() => hintEl().classList.contains('err')), '先要有提醒')
  const input = modelInput()
  input.value = 'deepseek-chat'
  input.dispatchEvent(new dom.window.Event('change'))
  assert.ok(!hintEl().classList.contains('err'), '换成对话模型后提醒应消失')
  assert.strictEqual(hintEl().textContent, '', '状态行要清空')
  s.close()
})

await t('手输敲个列表外的名字：下拉退回占位项，不谎报选中', async () => {
  modelsReply = SILICON
  const s = makePanel('BAAI/bge-m3')
  s.open()
  assert.ok(await until(() => pickSel()), '先要拉到候选')
  const input = modelInput()
  input.value = 'my-gateway-local-chat'
  input.dispatchEvent(new dom.window.Event('change'))
  assert.strictEqual(pickSel().value, '', '下拉该退回占位项')
  assert.strictEqual(modelInput().value, 'my-gateway-local-chat', '输入框的值不能被打回')
  s.close()
})

await t('从下拉改选对话模型：输入框回填、提醒收掉', async () => {
  modelsReply = SILICON
  const s = makePanel('BAAI/bge-m3')
  s.open()
  assert.ok(await until(() => hintEl().classList.contains('err')), '先要有提醒')
  const sel = pickSel()
  sel.value = 'deepseek-ai/DeepSeek-V3'
  sel.dispatchEvent(new dom.window.Event('change'))
  assert.strictEqual(modelInput().value, 'deepseek-ai/DeepSeek-V3', '选中项要回填输入框')
  assert.ok(!hintEl().classList.contains('err'), '选到对话模型后提醒应收掉')
  s.close()
})

await t('接线：AI 面板的模型切换菜单也走同一张过滤表', () => {
  const src = fs.readFileSync(path.join(SRC, 'ai-panel.js'), 'utf8')
  assert.match(src, /items: chatModelsOnly\(r\)/, '面板切换菜单没接 chatModelsOnly')
  assert.match(src, /chatModelsOnly.*from '.\/ai-tasks\.js'/s, '面板没从 ai-tasks 导入过滤函数')
})

console.log(`\n结果: ${pass} passed, ${fail} failed`)
if (fail) process.exitCode = 1
