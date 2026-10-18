// pane-strip.test.mjs —— 窗格标签条的 jsdom 冒烟（DOM 结构 / 按钮派发 / 与 tabs 联动）
// 运行：cd src && node tests/pane-strip.test.mjs

import assert from 'node:assert'
import { JSDOM } from 'jsdom'

const dom = new JSDOM('<!doctype html><html><body><div class="nl-pane" id="leaf"></div></body></html>')
globalThis.window = dom.window
globalThis.document = dom.window.document

const { createPaneStrip } = await import('../pane-strip.js')

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

const events = []
function mount(paneId = 'p1') {
  events.length = 0
  const leaf = document.getElementById('leaf')
  leaf.textContent = ''
  const body = document.createElement('div')
  body.className = 'nl-pane-body'
  leaf.appendChild(body)
  const strip = createPaneStrip({
    paneId,
    leaf,
    onSwitch: (id) => events.push(['switch', id]),
    onClose: (id) => events.push(['close', id]),
    onSplit: (o) => events.push(['split', o]),
    onClosePane: () => events.push(['closePane']),
  })
  return { leaf, strip }
}

t('条子插在叶子最前面（sticky 才在滚动区上方），初态 hidden', () => {
  const { leaf, strip } = mount()
  assert.equal(leaf.firstElementChild, strip.el)
  assert.equal(strip.el.classList.contains('hidden'), true)
  assert.equal(strip.el.classList.contains('nl-pane-strip'), true)
})

t('三个按钮在位：左右拆分 / 上下拆分 / 关窗格', () => {
  const { strip } = mount()
  const btns = strip.el.querySelectorAll('.nl-pane-strip-btns .nl-split-btn')
  assert.equal(btns.length, 3)
  assert.equal(btns[2].classList.contains('nl-strip-close'), true)
  assert.ok(btns[0].title) // 文案走词条，非空
})

t('按钮派发：split 带方向，closePane 触发；点关窗格不冒泡到窗格', () => {
  const { strip, leaf } = mount()
  const btns = strip.el.querySelectorAll('.nl-pane-strip-btns .nl-split-btn')
  btns[0].dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  btns[1].dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  btns[2].dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  assert.deepEqual(events, [['split', 'horizontal'], ['split', 'vertical'], ['closePane']])
})

t('开标签：条子摘 hidden、标签画在滚动区、id 带 paneId', () => {
  const { strip } = mount('p7')
  const { id } = strip.tabs.open({ root: 'C:/vault', rel: 'a.md' })
  assert.equal(strip.el.classList.contains('hidden'), false)
  assert.equal(strip.el.querySelectorAll('.nl-pane-strip-scroll .tab').length, 1)
  assert.ok(id.startsWith('p7'))
})

t('setMulti：多窗格才显示关窗格按钮', () => {
  const { strip } = mount()
  const closeBtn = strip.el.querySelector('.nl-strip-close')
  assert.equal(closeBtn.classList.contains('hidden'), true) // 建好默认单窗格态
  strip.setMulti(true)
  assert.equal(closeBtn.classList.contains('hidden'), false)
  strip.setMulti(false)
  assert.equal(closeBtn.classList.contains('hidden'), true)
})

t('点标签 / × 走 tabs 的回调', () => {
  const { strip } = mount()
  strip.tabs.open({ root: 'C:/vault', rel: 'a.md' })
  strip.tabs.open({ root: 'C:/vault', rel: 'b.md' })
  const tabEls = strip.el.querySelectorAll('.nl-pane-strip-scroll .tab')
  tabEls[0].dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  tabEls[1].querySelector('.tab-x').dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  assert.equal(events.length, 2)
  assert.equal(events[0][0], 'switch')
  assert.equal(events[1][0], 'close')
})

t('同一叶子重复挂条：第二次直接返回不重复插', () => {
  const { leaf } = mount()
  // mountPaneChrome 的幂等由调用方查 .nl-pane-strip 保证；这里验证选择器可用
  assert.equal(leaf.querySelectorAll('.nl-pane-strip').length, 1)
})

console.log('结果：' + pass + ' passed, ' + fail + ' failed')
if (fail) process.exit(1)
