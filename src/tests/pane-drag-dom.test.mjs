// pane-drag-dom.test.mjs —— 拖拽引擎的 DOM 交互回归（jsdom，无布局）
// 运行：cd src && node tests/pane-drag-dom.test.mjs
//
// 锁三件事：位移过阈值才起拖（不抢单击 / 双击）、落区按指针位置算、
// 松手派发的 paneId / zone / tabIndex 齐全。布局与命中由 getBoundingClientRect
// 与 elementFromPoint 的桩顶替（jsdom 没有布局引擎）。

import assert from 'node:assert'
import { JSDOM } from 'jsdom'

const dom = new JSDOM(`<!doctype html><html><body>
<div class="nl-pane" data-pane-id="p1">
  <div class="nl-pane-strip" data-pane-id="p1">
    <div class="nl-pane-strip-scroll">
      <div class="tab" data-id="p1|0|a.md">a</div>
      <div class="tab" data-id="p1|0|b.md">b</div>
      <div class="tab" data-id="p1|0|c.md">c</div>
    </div>
  </div>
</div>
<div class="sidebar"></div>
</body></html>`)
globalThis.window = dom.window
globalThis.document = dom.window.document

const { createPaneDrag } = await import('../pane-drag.js')

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

const doc = dom.window.document
const pane = doc.querySelector('.nl-pane')
const tabs = Array.from(doc.querySelectorAll('.tab'))

// 窗格 800×600 在 (100, 50)；三个标签各 100 宽，排在 x 300 起（躲开左侧 25% 落边区）
function stubLayout() {
  pane.getBoundingClientRect = () => ({ left: 100, top: 50, width: 800, height: 600, right: 900, bottom: 650 })
  tabs.forEach((el, i) => {
    const left = 300 + i * 100
    el.getBoundingClientRect = () => ({ left, top: 50, width: 100, height: 28, right: left + 100, bottom: 78 })
  })
  doc.elementFromPoint = () => pane
}
stubLayout()

function mouse(type, x, y) {
  return new dom.window.MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0 })
}

/** 起拖 + 移动 + 松手，返回派发出来的 drop（没有派发则 null） */
function dragFrom(sourceEl, moves, { payload = { kind: 'tab', paneId: 'p1', tabId: 'p1|0|a.md' } } = {}) {
  const drops = []
  const controller = createPaneDrag({
    hitLeaf: (x, y) => {
      const el = doc.elementFromPoint(x, y)
      return el && el.closest ? el.closest('.nl-pane') : null
    },
    labelFor: (p) => p.rel || p.tabId,
    onDrop: (d) => drops.push(d),
  })
  controller.begin(mouse('pointerdown', 0, 0), payload, sourceEl)
  for (const [x, y] of moves) dom.window.dispatchEvent(mouse('pointermove', x, y))
  const last = moves.length ? moves[moves.length - 1] : [0, 0]
  dom.window.dispatchEvent(mouse('pointerup', last[0], last[1]))
  controller.destroy()
  return drops[0] || null
}

t('位移过阈值才起拖：不过阈值松手不派发', () => {
  assert.strictEqual(dragFrom(tabs[0], [[1, 1]]), null) // 位移 1.4px < 4：还是单击
})

t('落中心：zone=center，排序索引按落点算（拖第一个）', () => {
  // 落 x=380：跨过第一个中点（350），没到第二个（450）；摘掉被拖项后位置 0
  const drop = dragFrom(tabs[0], [[400, 350], [380, 350]])
  assert.ok(drop)
  assert.strictEqual(drop.paneId, 'p1')
  assert.strictEqual(drop.zone, 'center')
  assert.strictEqual(drop.tabIndex, 0)
  // 落 x=520：跨过前两个中点（450），被拖项摘掉后位置 1
  const right = dragFrom(tabs[0], [[400, 350], [520, 350]])
  assert.strictEqual(right.zone, 'center')
  assert.strictEqual(right.tabIndex, 1)
})

t('落左 / 右 / 上 / 下四个边：zone 与手势一致', () => {
  assert.strictEqual(dragFrom(tabs[1], [[500, 350], [180, 350]]).zone, 'left')
  assert.strictEqual(dragFrom(tabs[1], [[500, 350], [820, 350]]).zone, 'right')
  assert.strictEqual(dragFrom(tabs[1], [[500, 350], [500, 110]]).zone, 'top')
  assert.strictEqual(dragFrom(tabs[1], [[500, 350], [500, 590]]).zone, 'bottom')
})

t('落在非窗格区域：paneId 为 null，痕迹清干净', () => {
  const sidebar = doc.querySelector('.sidebar')
  const saved = doc.elementFromPoint
  doc.elementFromPoint = () => sidebar
  const drop = dragFrom(tabs[0], [[500, 350], [20, 400]])
  doc.elementFromPoint = saved
  assert.strictEqual(drop.paneId, null)
  assert.strictEqual(doc.querySelectorAll('.nl-drop-hint').length, 0)
})

t('起拖期间挂 nl-dragging 与幽灵标签，收尾全部摘掉', () => {
  const controller = createPaneDrag({
    hitLeaf: () => pane,
    labelFor: (p) => p.rel || 'x',
    onDrop: () => {},
  })
  controller.begin(mouse('pointerdown', 0, 0), { kind: 'tab', rel: 'a.md' }, tabs[0])
  dom.window.dispatchEvent(mouse('pointermove', 300, 300))
  assert.equal(doc.documentElement.classList.contains('nl-dragging'), true)
  assert.equal(doc.querySelectorAll('.nl-drag-ghost').length, 1)
  assert.equal(doc.querySelector('.nl-drag-ghost').textContent, 'a.md')
  assert.equal(tabs[0].classList.contains('dragging'), true)
  dom.window.dispatchEvent(mouse('pointerup', 300, 300))
  assert.equal(doc.documentElement.classList.contains('nl-dragging'), false)
  assert.equal(doc.querySelectorAll('.nl-drag-ghost').length, 0)
  assert.equal(tabs[0].classList.contains('dragging'), false)
  controller.destroy()
})

t('Esc 取消：不派发，取消后再松手也不补派发', () => {
  const drops = []
  const controller = createPaneDrag({ hitLeaf: () => pane, labelFor: () => 'x', onDrop: (d) => drops.push(d) })
  controller.begin(mouse('pointerdown', 0, 0), { kind: 'tab' }, tabs[0])
  dom.window.dispatchEvent(mouse('pointermove', 300, 300))
  dom.window.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  assert.equal(drops.length, 0)
  assert.equal(doc.querySelectorAll('.nl-drag-ghost').length, 0)
  assert.equal(tabs[0].classList.contains('dragging'), false)
  dom.window.dispatchEvent(mouse('pointerup', 300, 300))
  assert.equal(drops.length, 0)
  controller.destroy()
})

t('松手后紧跟的那次 click 被吞掉（否则会连带切标签 / 开文件）', () => {
  let reached = 0
  const sink = () => {
    reached++
  }
  doc.body.addEventListener('click', sink)
  const controller = createPaneDrag({ hitLeaf: () => pane, labelFor: () => 'x', onDrop: () => {} })
  controller.begin(mouse('pointerdown', 0, 0), { kind: 'tab' }, tabs[0])
  dom.window.dispatchEvent(mouse('pointermove', 300, 300))
  dom.window.dispatchEvent(mouse('pointerup', 300, 300))
  const click = new dom.window.MouseEvent('click', { bubbles: true, cancelable: true })
  tabs[0].dispatchEvent(click)
  assert.equal(reached, 0)
  assert.equal(click.defaultPrevented, true)
  // 只吞一次：之后的点击照常到达
  tabs[0].dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true }))
  assert.equal(reached, 1)
  doc.body.removeEventListener('click', sink)
  controller.destroy()
})

console.log('结果：' + pass + ' passed, ' + fail + ' failed')
if (fail) process.exit(1)
