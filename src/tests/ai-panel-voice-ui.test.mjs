// ai-panel-voice-ui.test.mjs —— 语音按钮的点亮 / 灭灯只跟 voiceState 走
// 运行：cd src && node tests/ai-panel-voice-ui.test.mjs
// 约定：麦克风不录音时与同行其他图标一样是灰的（不带 .active），只有真在用
// （录音中 / 原生听写中 / Web Speech 中）才点成 accent 蓝。CSS 只有
// `.ai-icon-btn{color:var(--muted)}` 与 `.ai-icon-btn.active{color:var(--accent)}`
// 两条规则，所以按钮上有没有 `.active` 就是全部判据。
// 这里盯的是几个会把类和状态拆开的口子：
// ① 录音收尾（识别请求还在飞）→ 类要立刻摘掉；
// ② 原生听写靠 Rust 的 end 事件灭灯，而停命令本身失败时那个事件永远不会来；
// ③ 换语言重建 DOM 后新按钮默认不带类，会话还在跑就变成灰着听；
// ④ 会话建立中的连点（Rust 那边只允许一场）；
// ⑤ Rust 的各类自终哨兵该对上各自的文案，引擎自终还要能原地续场（自终不是故障）。
// 桌面版（三个平台）默认把麦克风与优化输入两个入口藏掉了，所以这一批用例都显式传
// voiceUiHidden:false 把麦克风摆回来——藏的是图标，不是那条走 IPC 的路，路本身还得测。
// （优化钮没有这种路要测，就没开接缝，桌面版一律不挂。）

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
const { DICT_RESUME_MAX } = await import('../ai-tasks.js')

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms))
const emit = (ev) => { for (const fn of dictHandlers) fn({ payload: ev }); return tick() }
// 面板附件条上那条可见提示（语音的状态与错误全走它，不再只进 console）
const noteOf = (pane) => { const n = pane.root.querySelector('.ai-att-note'); return n ? n.textContent : null }

// 两个面板：A 配了 ASR 模型（走录音 + 服务商识别），B 没配（回落系统原生听写）
// voiceUiHidden:false 是显式把入口摆回来：桌面版默认已经藏掉了，而这一整批用例测的
// 正是桌面那条路（点击 → IPC → 事件回灌），入口不在就无从点起。
const mk = (cfg, deps = {}) => {
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
    voiceUiHidden: false,
    ...deps,
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
  assert.ok(A.others().length >= 1, '同行应还有其他图标按钮（技能钮；优化钮在桌面版已同语音一起藏掉）')
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

await t('停命令本身失败时就地灭灯并说出原因（引擎卡住时停止会等到超时）', async () => {
  dictStopFails = true
  B.mic().click() // 走 native 分支的停止
  await tick()
  assert.ok(!B.mic().classList.contains('active'), '停不下来时不该蓝住')
  assert.ok(String(noteOf(B) || '').includes('语音识别失败'), '要说出来为什么没停成，实际：' + noteOf(B))
  dictStopFails = false
})

// —— 2026-11-06 补：探测与 StartAsync 要几百毫秒，期间按钮没反应就会招来第二次点击；
//    Rust 那边回「已在听写中」，用户看到的就是「语音功能打不开」。同样在这一天补上的
//    还有引擎自终的续场与停止的等待上限。

await t('第一下就点亮（不等 IPC），连点两下只发一次 start', async () => {
  cmds.length = 0
  B.mic().click()
  assert.ok(B.mic().classList.contains('active'), '点击当场就该点亮，不能等探测与启动跑完')
  B.mic().click() // 同步第二下：会话还在建立中，这一下必须就地丢掉
  await tick()
  assert.strictEqual(cmds.filter((c) => c === 'ai_dictation_start').length, 1, '一次会话只能有一个 start')
  assert.ok(!String(noteOf(B) || '').includes('已在听写中'), '不该出「已在听写中」，实际：' + noteOf(B))
  await emit({ reqId: dictReqId, kind: 'end', text: '' })
})

await t('引擎自终不结束会话：原地续一场，灯不灭、也不出错', async () => {
  B.mic().click()
  await tick()
  assert.ok(B.mic().classList.contains('active'), '先进入听写')
  const rid1 = dictReqId
  cmds.length = 0
  await emit({ reqId: rid1, kind: 'end', text: 'auto-ended' })
  assert.ok(B.mic().classList.contains('active'), '引擎几秒听不到可用语音就自终，这时候用户还没说完，不该灭灯')
  assert.ok(cmds.includes('ai_dictation_start'), '要再发一次 start 把这一场接上')
  assert.notStrictEqual(dictReqId, rid1, '续场得换新会话 id，否则新会话的收尾会被旧 id 过滤掉')
  assert.ok(!String(noteOf(B) || '').includes('到此结束'), '续场不该收场，实际：' + noteOf(B))
})

await t('用户点停的 end 不续场：那个 text 是空的，收尾就收尾', async () => {
  B.mic().click()
  await tick()
  const rid = dictReqId
  cmds.length = 0
  await emit({ reqId: rid, kind: 'end', text: '' })
  assert.ok(!B.mic().classList.contains('active'), '用户自己停的就该灭灯')
  assert.ok(!cmds.includes('ai_dictation_start'), '停完不能再偷偷开一场')
})

await t('续场有循环刹车：次数用完才真收场，并说一句结束', async () => {
  B.mic().click()
  await tick()
  assert.ok(B.mic().classList.contains('active'), '重新进入听写（续场计数归零）')
  for (let i = 0; i <= DICT_RESUME_MAX; i++) {
    await emit({ reqId: dictReqId, kind: 'end', text: 'auto-ended' })
  }
  assert.ok(!B.mic().classList.contains('active'), '到刹车次数就该停下，不能围着麦克风转圈')
  assert.ok(String(noteOf(B) || '').includes('到此结束'), '真收场时要说一句，实际：' + noteOf(B))
})

await t('续场计数在出字后归零：说一段停一段不会把刹车用完', async () => {
  B.mic().click()
  await tick()
  for (let i = 0; i < DICT_RESUME_MAX - 5; i++) await emit({ reqId: dictReqId, kind: 'end', text: 'auto-ended' })
  await emit({ reqId: dictReqId, kind: 'result', text: '今天试验一下语音输入' })
  await tick()
  for (let i = 0; i < DICT_RESUME_MAX - 5; i++) await emit({ reqId: dictReqId, kind: 'end', text: 'auto-ended' })
  assert.ok(B.mic().classList.contains('active'), '说过话之后计数清零，刹车不该在这一轮用完')
  assert.ok(String((B.root.querySelector('.ai-input') || {}).value || '').includes('语音输入'), '识别出的字要留在输入框')
})

await t('引擎报音频问题：说一句原因，但会话不断、灯不灭、也不报错', async () => {
  B.mic().click()
  await tick()
  assert.ok(B.mic().classList.contains('active'), '先进入听写')
  cmds.length = 0
  await emit({ reqId: dictReqId, kind: 'audio', text: 'too-quiet' })
  assert.ok(B.mic().classList.contains('active'), '音频质量提示不是会话结束，灯不该灭')
  assert.ok(!cmds.includes('ai_dictation_start'), '也不该因此重开一场')
  assert.ok(String(noteOf(B) || '').includes('几乎收不到声音'), '要把原因说出来，实际：' + noteOf(B))
  await emit({ reqId: dictReqId, kind: 'end', text: '' })
})

await t('麦克风被拒与网络不可用各说一条，不再共用一句', async () => {
  B.mic().click()
  await tick()
  await emit({ reqId: dictReqId, kind: 'error', text: 'network-unavailable' })
  assert.ok(String(noteOf(B) || '').includes('联网'), '网络那一档要说联网，实际：' + noteOf(B))
  assert.ok(!B.mic().classList.contains('active'), '出错就回空闲态')
  B.mic().click()
  await tick()
  await emit({ reqId: dictReqId, kind: 'error', text: 'mic-unavailable' })
  assert.ok(String(noteOf(B) || '').includes('拿不到麦克风'), '麦克风那一档才是专项指引，实际：' + noteOf(B))
})

await t('引擎异常带上状态码（旧代码把静默超时归成麦克风被拒，缺的就是这一档）', async () => {
  B.mic().click()
  await tick()
  await emit({ reqId: dictReqId, kind: 'error', text: 'engine-error:3' })
  const s = String(noteOf(B) || '')
  assert.ok(s.includes('状态') && s.includes('3'), '要把状态码上屏，实际：' + s)
})

await t('桌面版默认不挂麦克风与优化钮（三个平台同一口径，与 navigator 无关）', async () => {
  // 这里 jsdom 的 navigator 是 Win 形态，照样藏——证明藏不藏只看「是不是桌面版」，不看哪个平台
  const D = mk({ baseUrl: 'http://x/v1', apiKey: 'k', model: 'm', asrModel: '', contextTokens: 0 }, { voiceUiHidden: undefined })
  await tick()
  assert.ok(!D.root.querySelector('.ai-voice'), '桌面版不该挂出麦克风（本机跑的是 jsdom 的 Win 形态 navigator）')
  assert.ok(!D.root.querySelector('.ai-optimize'), '桌面版不该挂出优化输入钮（与语音同一口径）')
  assert.ok(D.root.querySelector('.ai-composer-bar button'), '底行其余按钮照旧')
})

await t('两个入口藏掉后不留空位：圆环就贴在发送钮左边', async () => {
  const D = mk({ baseUrl: 'http://x/v1', apiKey: 'k', model: 'm', asrModel: '', contextTokens: 0 }, { voiceUiHidden: undefined })
  await tick()
  const bar = D.root.querySelector('.ai-composer-bar')
  const kids = [...bar.children]
  const send = kids.find((el) => el.classList.contains('ai-send') && !el.classList.contains('hidden'))
  assert.ok(send, '发送钮要在底行')
  assert.ok(!kids.some((el) => el.classList.contains('ai-voice') || el.classList.contains('ai-optimize')), '语音与优化那两格是整块拿掉，不是留空元素')
  assert.strictEqual(kids[kids.indexOf(send) - 1].className, 'ai-ctx-ring', '发送钮左边直接是圆环（右组靠 margin-left:auto 恒贴右缘，少两格就整体右移两格）')
})

await t('纯网页预览（没有 Tauri）麦克风与优化钮照挂：藏入口只藏桌面版', async () => {
  const internals = window.__TAURI_INTERNALS__
  delete window.__TAURI_INTERNALS__
  const W = mk({ baseUrl: 'http://x/v1', apiKey: 'k', model: 'm', asrModel: '', contextTokens: 0 }, { voiceUiHidden: undefined })
  await tick()
  assert.ok(W.mic(), '网页版应有麦克风入口（Chrome Web Speech 那条路是通的）')
  assert.ok(W.root.querySelector('.ai-optimize'), '网页版应有优化输入入口')
  window.__TAURI_INTERNALS__ = internals
})

console.log('')
console.log(`${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
