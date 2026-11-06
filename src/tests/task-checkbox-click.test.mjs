// task-checkbox-click.test.mjs —— 任务列表勾选框可直接点（issue #IKR91E）
// 运行：cd src && node tests/task-checkbox-click.test.mjs
//
// 勾选框是 CSS ::before 画的（li 的 content hole 只能有一个子节点，不能塞 <input>），
// 点击判定走 editor-view 里 view.dom 的 click 监听：按 li 左侧 padding 区几何算命中，
// 命中后把 list_item 的 checked 取反。本文件用真 createEditor（jsdom）+ 合成 click
// 钉住这条接线：点框能勾 / 再点能取消 / 点正文区不勾 / 有序列表与嵌套项同样可点。

import assert from 'node:assert'
import { register } from 'node:module'
import { JSDOM } from 'jsdom'

register('./css-stub-loader.mjs', import.meta.url)

const dom = new JSDOM('<!doctype html><html><body><div id="mount"></div></body></html>', { url: 'http://localhost/' })
globalThis.window = dom.window
globalThis.document = dom.window.document
globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window)
globalThis.requestAnimationFrame = (cb) => cb()
globalThis.localStorage = dom.window.localStorage
globalThis.HTMLElement = dom.window.HTMLElement
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true })
if (!dom.window.ResizeObserver) {
  dom.window.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} }
}
globalThis.ResizeObserver = dom.window.ResizeObserver
dom.window.localStorage.setItem('nl-lang', 'zh-CN')

const { createEditor } = await import('../editor-view.js')

let pass = 0
let fail = 0
function t(name, fn) {
  try {
    fn()
    pass++
    console.log('  ok   ' + name)
  } catch (e) {
    fail++
    console.log('  FAIL ' + name + ' —— ' + ((e && e.message) || e))
  }
}

const mount = document.getElementById('mount')
const inst = createEditor({
  mountEl: mount,
  getVault: () => ({ vaultRoot: '/tmp/vault', mdRel: 'a.md' }),
  getFeatures: () => ({}),
})
inst.setMarkdown('* [ ] 甲\n- [x] 乙\n')

function clickAt(el, x, y) {
  el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true, clientX: x, clientY: y }))
}

// 命中区：li 左缘 0..20px、首行顶往下 0.32em 起 20px（与 CSS 的 14px 框对齐，
// jsdom 无布局，getBoundingClientRect 全零，故按同一公式取坐标）。
function clickBox(el) {
  // jsdom 的 getComputedStyle 对继承字号只回 "medium"（真浏览器回 "17px"），
  // 被测代码 parseFloat 会得 NaN。这里给 li 一个内联字号，让命中公式拿到数值。
  el.style.fontSize = '16px'
  const fs = 16
  clickAt(el, 10, fs * 0.32 + 7)
}

t('点框：未勾变已勾', () => {
  const li = mount.querySelectorAll('li.nl-task')[0]
  assert.equal(li.getAttribute('data-checked'), 'false')

  clickBox(li)
  assert.equal(mount.querySelectorAll('li.nl-task')[0].getAttribute('data-checked'), 'true')
  assert.match(inst.getMarkdown(), /\* \[x\] 甲/)
})

t('再点一次：已勾变未勾', () => {
  const li = mount.querySelectorAll('li.nl-task')[0]
  clickBox(li)
  assert.equal(mount.querySelectorAll('li.nl-task')[0].getAttribute('data-checked'), 'false')
  assert.match(inst.getMarkdown(), /\* \[ \] 甲/)
})

t('点正文区（框外右侧）：不触发勾选', () => {
  const li = mount.querySelectorAll('li.nl-task')[0]
  const before = li.getAttribute('data-checked')
  clickAt(li, 60, 10)
  assert.equal(mount.querySelectorAll('li.nl-task')[0].getAttribute('data-checked'), before)
})

t('已勾选的项可直接取消', () => {
  const li = mount.querySelectorAll('li.nl-task')[1]
  assert.equal(li.getAttribute('data-checked'), 'true')
  clickBox(li)
  assert.equal(mount.querySelectorAll('li.nl-task')[1].getAttribute('data-checked'), 'false')
})

t('有序列表与嵌套列表项同样可点', () => {
  inst.setMarkdown('1. [ ] 有序\n\n- [ ] 外层\n\n  - [ ] 嵌套\n')
  const items = mount.querySelectorAll('li.nl-task')
  assert.equal(items.length, 3, '三个任务项都应渲染成 li.nl-task')
  for (const li of items) clickBox(li)
  const md = inst.getMarkdown()
  assert.match(md, /1\. \[x\] 有序/)
  assert.match(md, /\* \[x\] 外层/)
  assert.match(md, /\* \[x\] 嵌套/)
})

console.log('\n结果：' + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)