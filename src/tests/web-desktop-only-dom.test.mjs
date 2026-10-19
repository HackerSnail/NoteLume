// web-desktop-only-dom.test.mjs —— 「网页版不支持」提示的可见化回归（jsdom）
// 运行：npm run web:test（server/tests/run.mjs 会收 src/tests/web-*）
//
// 钉住这条链路的由来：桌面版的 setStatus 只剩 console.debug（界面上早就没有状态栏了），
// 于是命令面板里的 Git / 插件类命令在网页版「点了没反应」。后端把桌面专属命令拒掉时带
// code:'desktop-only'，前端 tauri-core 调 notifyDesktopOnly 让它上屏。这里锁四条规矩：
//   1) 访客没动过之前不提示（开库时插件与 Git 的自检也会被拒，首屏不该冒提示）；
//   2) 动过之后，同一句话只有一条提示，重复拒不会堆一屏；
//   3) 调用方自己会弹对话框的（导出 Word / 整站 / Git push 那几条），刚弹过同一句话就不上屏；
//      无关弹框不误收，且挂钩只记框、不拦框（桌面代码的弹框必须照弹）。
//   4) 普通失败（没有 code）完全不进这条路。

import assert from 'node:assert'
import { JSDOM } from 'jsdom'

const dom = new JSDOM('<!doctype html><html><body></body></html>')
globalThis.window = dom.window
globalThis.document = dom.window.document

// 先换成可记录的 stub，再 import：desktop-only.js 挂钩时包的就是它，既验挂钩也免得把
// jsdom 的「Not implemented: window.alert」错误刷进测试输出
const alerted = []
dom.window.alert = function (msg) { alerted.push(String(msg == null ? '' : msg)) }

const { notifyDesktopOnly } = await import('../web/desktop-only.js')

let pass = 0
let fail = 0
async function test(name, fn) {
  try {
    await fn()
    pass++
    console.log('  ok   ' + name)
  } catch (e) {
    fail++
    console.log('  FAIL ' + name + ' —— ' + ((e && e.message) || e))
  }
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const SENT = '网页版不支持此功能，请下载桌面版。'
const EN = 'This feature isn’t supported in the web version.'
const shown = (text) => [...document.querySelectorAll('.nl-web-toast')].filter((e) => e.textContent === text).length
const armVisitor = () => window.dispatchEvent(new dom.window.Event('pointerdown', { bubbles: true }))

await test('没动过之前不提示（开库自检的拒绝不上屏）', async () => {
  notifyDesktopOnly(SENT)
  await wait(800) // 超过 600ms 的宽限期，确认真的没弹
  assert.equal(shown(SENT), 0, '未武装就该一条都不弹')
})

await test('访客动过之后，提示真的出现在屏幕上', async () => {
  armVisitor()
  notifyDesktopOnly(SENT)
  assert.equal(shown(SENT), 0, '宽限期内先不弹，给调用方的弹框留位置')
  await wait(800)
  assert.equal(shown(SENT), 1, '到期该弹一条')
})

await test('同一句话同时只有一条（插件与 Git 会连着拒好几次）', async () => {
  notifyDesktopOnly(SENT)
  notifyDesktopOnly(SENT)
  await wait(800)
  assert.equal(shown(SENT), 1, '去重失效：' + shown(SENT))
  // 另一句文案（切了界面语言）该另起一条
  notifyDesktopOnly(EN)
  await wait(800)
  assert.equal(shown(EN), 1, '不同文案该各有一条')
})

await test('点一下提示就收起', async () => {
  const row = [...document.querySelectorAll('.nl-web-toast')].find((e) => e.textContent === SENT)
  row.dispatchEvent(new dom.window.Event('click'))
  assert.equal(shown(SENT), 0, '点掉的该立刻移除')
  assert.equal(shown(EN), 1, '另一条不受影响')
})

await test('调用方自己弹框时不起 toast；无关弹框不误收，弹框本身照弹', async () => {
  const before = alerted.length
  notifyDesktopOnly(SENT)
  window.alert('整站导出失败：\n\n' + SENT)
  assert.equal(alerted.length, before + 1, '挂钩只能记一笔，不能把桌面代码的弹框拦掉')
  await wait(800)
  assert.equal(shown(SENT), 0, '同一句话已经弹给访客了，不该再补一条 toast')

  notifyDesktopOnly(SENT)
  window.alert('保存失败')
  await wait(800)
  assert.equal(shown(SENT), 1, '与提示无关的弹框不能影响提示落地')
  ;[...document.querySelectorAll('.nl-web-toast')].forEach((e) => e.click()) // 清场

  // 另一句话的弹框不算「访客已经看到了」（只认正文里含这句的）
  window.alert('同步失败')
  await wait(5)
  notifyDesktopOnly(EN)
  await wait(800)
  assert.equal(shown(EN), 1, '弹框正文里没有这句，该照常提示')
})

await test('弹框关掉不久的连击不补提示（push 弹完还会自动刷一次状态）', async () => {
  ;[...document.querySelectorAll('.nl-web-toast')].forEach((e) => e.click()) // 清场
  window.alert('推送失败：' + SENT)
  await wait(5)
  notifyDesktopOnly(SENT) // 弹框之后的再一次拒绝：同一次操作，不该再弹一条
  await wait(800)
  assert.equal(shown(SENT), 0, '紧跟弹框的同句拒绝不该再补一条')
})

console.log('结果：' + pass + ' passed, ' + fail + ' failed')
if (fail) process.exit(1)
