// ai-panel-voice-ui.test.mjs —— 语音按钮的点亮 / 灭灯只跟 voiceState 走
// 运行：cd src && node tests/ai-panel-voice-ui.test.mjs
//
// 约定：麦克风不录音时与同行其他图标一样是灰的（不带 .active），只有真在用
// （录音中 / 原生听写中 / Web Speech 中）才点成 accent 蓝。CSS 只有
// `.ai-icon-btn{color:var(--muted)}` 与 `.ai-icon-btn.active{color:var(--accent)}`
// 两条规则，所以按钮上有没有 `.active` 就是全部判据。
// 这里盯的是三个会把类和状态拆开的口子：
// ① 录音收尾（识别请求还在飞）→ 类要立刻摘掉；
// ② 原生听写靠 Rust 的 end 事件灭灯，而停命令本身失败时那个事件永远不会来；
// ③ 换语言重建 DOM 后新按钮默认不带类，会话还在跑就变成灰着听。

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

const cbById = new Map()
const dictHandlers = []
let idSeq = 0
const cmds = []
let asrGate = null // ai_asr_transcribe 的挂起闸门：手动放行才回文本

window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} }
window.__TAURI_INTERNALS__ = {
  transformCallback(callback) {
    ++idSeq
    cbById.set(idSeq, callback)
    return idSeq
  },
  invoke(cmd, args) {
    cmds.push(cmd)
    switch (cmd) {
      case 'ai_chat_stream':
      case 'ai_chat_cancel':
      case 'ai_skills_scan':
        return Promise.resolve(cmd === 'ai_skills_scan' ? [] : null)
      case 'ai_chat_save':
        return Promise.resolve()
      case 'ai_chat_read':
        return Promise.resolve(null)
      case 'ai_models_list':
        return Promise.resolve(['m'])
      case 'ai_rec_start':
        return Promise.resolve()
      case 'ai_rec_stop':
        return Promise.resolve('/tmp/nl-test.wav')
      case 'ai_asr_transcribe':
        return new Promise((resolve) => { asrGate = () => resolve('识别出的字') })
      case 'ai_dictation_probe':
        return Promise.resolve(true)
      case 'ai_dictation_start':
        dictReqId = args.reqId
        return Promise.resolve()
      case 'ai_dictation_stop':
        return dictStopFails ? Promise.reject(new Error('no session')) : Promise.resolve(null)
      case 'plugin:event|listen': {
        const fn = cbById.get(args.handler)
        if (args.event === 'nl:dictation' && fn) dictHandlers.push(fn)
        return Promise.resolve(args.handler)
      }
      case 'plugin:event|unlisten':
        return Promise.resolve()
      default:
        return Promise.resolve(null)
    }
  },
}

let dictReqId = null
let dictStopFails = false

const { createAiPanel } = await import('../ai-panel.js')
const { setLocale } = await import('../i18n.js')

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms))
const emit = (ev) => { for (const fn of dictHandlers) fn({ payload: ev }); return tick() }

// 两个面板：A 配了 ASR 模型（走录音 + 服务商识别），B 没配（回落系统原生听写）
const mk = (cfg) => {
  const root = document.createElement('div')
  document.body.appendChild(root)
  const panel = createAiPanel({
    root,
    getConfig: () => cfg,
    openSettings: () => {},
    getDocContext: () => '',
    insertToDoc: () => {},
    setStatus: () => {},
    vaultReady: () => false,
  })
  const mic = () => root.querySelector('.ai-voice')
  const others = () => [...root.querySelectorAll('.ai-icon-btn')].filter((b) => !b.classList.contains('ai-voice'))
  return { panel, root, mic, others }
}

const A = mk({ baseUrl: 'http://x/v1', apiKey: 'k', model: 'm', asrModel: 'asr-m', contextTokens: 0 })
const B = mk({ baseUrl: 'http://x/v1', apiKey: 'k', model: 'm', asrModel: '', contextTokens: 0 })

let pass = 0
let fail = 0
async function t(name, fn) {
  try {
    await fn()
    pass++
    console.log('  ok -', name)
  } catch (e) {
    fail++
    console.error('  FAIL -', name)
    console.error('   ', e && e.message)
  }
}

console.log('ai-panel 语音按钮：不用时灰、用时蓝，且类与状态不分离')

await t('刚挂上（没录过音）：麦克风不带 .active，与同行其他图标同基准', () => {
  assert.ok(A.mic(), '麦克风按钮应存在')
  assert.ok(!A.mic().classList.contains('active'), '空闲态不该带 .active')
  assert.ok(A.others().length >= 2, '同行应还有其他图标按钮')
  for (const b of A.others()) assert.ok(!b.classList.contains('active'), '空闲态其他按钮也不该带 .active')
})

await t('点一下开始录音（ASR 那路）：麦克风点亮', async () => {
  await tick() // 让面板初始化跑完
  cmds.length = 0
  A.mic().click()
  await tick()
  assert.ok(cmds.includes('ai_rec_start'), '应调 ai_rec_start')
  assert.ok(A.mic().classList.contains('active'), '录音中应带 .active（蓝）')
})

await t('再点一下收尾：识别请求还挂着时也立刻变灰', async () => {
  A.mic().click()
  await tick()
  assert.ok(!A.mic().classList.contains('active'), '停止录音后不该再亮着，即使识别未返回')
  assert.ok(asrGate, '识别请求应还挂着（闸门未放行）')
})

await t('识别回来只往输入框写字，不会把按钮点回去', async () => {
  asrGate()
  await tick(30)
  assert.ok(!A.mic().classList.contains('active'), '识别回填后仍是空闲态')
  assert.ok(A.root.querySelector('.ai-input').value.includes('识别出的字'), '识别文本应落进输入框')
})

await t('没配 ASR 时走原生听写：点一下点亮', async () => {
  await tick()
  B.mic().click()
  await tick()
  assert.ok(dictReqId, '应调 ai_dictation_start 并带上 reqId')
  assert.ok(B.mic().classList.contains('active'), '听写中应带 .active')
})

await t('换语言重建 DOM 后，会话还在跑就把新按钮点回蓝色', async () => {
  const old = B.mic()
  setLocale('en-US')
  await tick()
  assert.notEqual(B.mic(), old, '换语言应重建出新的按钮元素')
  assert.ok(B.mic().classList.contains('active'), '重建后不该灰着继续听写')
  setLocale('zh-CN')
  await tick()
  assert.ok(B.mic().classList.contains('active'), '再切回来仍按状态点灯')
})

await t('原生听写的 end 事件灭灯', async () => {
  await emit({ reqId: dictReqId, kind: 'end', text: '' })
  assert.ok(!B.mic().classList.contains('active'), 'end 事件后应回到灰色')
})

await t('别的 reqId 的 end 事件不动当前状态（重新点亮后不误灭）', async () => {
  B.mic().click()
  await tick()
  assert.ok(B.mic().classList.contains('active'), '新会话应点亮')
  await emit({ reqId: 'dict-not-mine', kind: 'end', text: '' })
  assert.ok(B.mic().classList.contains('active'), 'reqId 不匹配的事件不该灭灯')
})

await t('停命令本身失败时就地灭灯：那种情况不会再有 end 事件', async () => {
  dictStopFails = true
  B.mic().click() // 走 native 分支的停止
  await tick()
  assert.ok(!B.mic().classList.contains('active'), '停不下来时不该蓝住')
  dictStopFails = false
})

console.log('')
console.log(`${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
