// virtual-view-dom.test.mjs —— 虚拟化接入层 DOM 回归（jsdom，无布局引擎）
// 运行：cd src && node tests/virtual-view-dom.test.mjs
//
// 锁四件事：只有窗口块进 DOM（含首尾 spacer）、spacer 渲染真实高度、窗口编辑经
// dispatchTransaction 回灌 master、滚动量块触发扩缩。jsdom 没有布局，offsetTop/
// offsetHeight/getViewport 全部按桩值走（与 pane-drag-dom 同模式）。

import assert from 'node:assert'
import { JSDOM } from 'jsdom'

const dom = new JSDOM(`<!doctype html><html><body><div id="mount"></div></body></html>`)
globalThis.window = dom.window
globalThis.document = dom.window.document
// jsdom 的 rAF 存在但无节拍，测试里手动驱动；接入层对 rAF 缺席也有同步兜底
dom.window.requestAnimationFrame = (cb) => {
  globalThis.__rafQueue = globalThis.__rafQueue || []
  globalThis.__rafQueue.push(cb)
  return globalThis.__rafQueue.length
}
dom.window.cancelAnimationFrame = () => {}

const { parseMarkdown } = await import('../editor-schema.js')
const { createVirtualView } = await import('../virtual/virtual-view.js')

function makeDoc(n) {
  const lines = Array.from({ length: n }, (_, i) => `段落${i}内容`)
  return parseMarkdown(lines.join('\n\n') + '\n')
}

/** 给每个顶层级元素按序号设桩：块高 40px、块 i 的 offsetTop = i*40 */
function stubLayout(view, { blockH = 40 } = {}) {
  const kids = view.dom.children
  for (let i = 0; i < kids.length; i++) {
    const el = kids[i]
    Object.defineProperty(el, 'offsetTop', { configurable: true, get: () => i * blockH })
    Object.defineProperty(el, 'offsetHeight', { configurable: true, get: () => blockH })
  }
}

function flushRaf() {
  const q = globalThis.__rafQueue || []
  globalThis.__rafQueue = []
  for (const cb of q) cb()
}

const mount = document.getElementById('mount')
const vv = createVirtualView(mount, makeDoc(20), { windowSize: 5, overscan: 2, estimateHeight: 40 })

// 1. 只有窗口块进 DOM
{
  const kids = vv.view.dom.children
  assert.strictEqual(kids.length, 7, `DOM 顶层级应为 top spacer + 5 块 + bottom spacer，实际 ${kids.length}`)
  assert.strictEqual(kids[0].className, 'nl-spacer')
  assert.strictEqual(kids[6].className, 'nl-spacer')
  assert.strictEqual(kids[1].textContent, '段落0内容')
  assert.strictEqual(kids[5].textContent, '段落4内容')
  console.log('ok 仅窗口块入 DOM')
}

// 2. spacer 渲染真实高度（估算 40 × 窗口外块数）
{
  const top = vv.view.dom.children[0]
  assert.strictEqual(top.style.height, '0px', '文档头 spacer 高度应为 0')
  const bottom = vv.view.dom.children[6]
  assert.strictEqual(bottom.style.height, '600px', '文档尾 spacer = 15 块 × 40px')
  console.log('ok spacer 高度渲染')
}

// 3. 窗口编辑：dispatchTransaction → master 回灌 → DOM 更新
{
  const tr = vv.view.state.tr.insertText('X', 3)
  vv.view.dispatch(tr)
  assert.strictEqual(vv.view.dom.children[1].textContent, '段X落0内容', '窗口 DOM 应更新')
  assert.strictEqual(vv.editor.blockCount, 20)
  const md = vv.getMarkdown()
  assert.ok(md.includes('段X落0内容'), 'master 序列化应含插入文本')
  console.log('ok 窗口编辑回灌与序列化')
}

// 4. 滚动扩缩：滚窗到块 10 → measure 量出可视块（绝对块号）→ 窗口重切覆盖
{
  vv.editor.viewportBlocks(10, 10) // 模拟滚动量块结果
  assert.ok(vv.editor.i0 <= 10 && 10 < vv.editor.i1, '窗口应覆盖块 10')
  stubLayout(vv.view)
  // 视口桩：可视高度 480px（12 块），滚动位置 0
  Object.defineProperty(mount, 'scrollTop', { configurable: true, get: () => 0 })
  Object.defineProperty(mount, 'clientHeight', { configurable: true, get: () => 480 })
  flushRaf() // measure → viewportBlocks(8..12) → 可视区已被 [8,13) 覆盖，窗口不重切
  stubLayout(vv.view)
  const kids = vv.view.dom.children
  assert.strictEqual(kids.length, 7, '可视区已覆盖时不重切，DOM 保持窗口结构')
  assert.ok(vv.editor.i0 <= 10 && 10 < vv.editor.i1, '窗口仍覆盖块 10')
  let found = false
  for (const el of kids) {
    if (el.textContent === '段落10内容') found = true
  }
  assert.ok(found, '窗口 DOM 应含段落10（从段落0-4 整组换成了 8-12）')
  assert.strictEqual(kids[1].textContent, '段落8内容', '窗口首块应为段落8')
  console.log('ok 滚动扩缩')
}

// 5. measure 用视口注入量块、实测高度喂回：可视块 12（文档坐标 480-520）
{
  stubLayout(vv.view)
  vv.measure({ top: 12 * 40 + 5, bottom: 12 * 40 + 39 })
  flushRaf()
  assert.ok(vv.editor.i0 <= 12 && 12 < vv.editor.i1, 'measure 应驱动窗口覆盖可视块')
  // 块高已按 stub 值喂入内核：滚到文档尾，spacer 高度用实测 40px
  vv.editor.openWindow(17, 20)
  const bottom = vv.view.dom.children[vv.view.dom.children.length - 1]
  assert.strictEqual(bottom.style.height, '0px', '文档尾 bottom spacer 应为 0')
  const top = vv.view.dom.children[0]
  assert.strictEqual(top.style.height, '680px', 'top spacer = 17 块 × 40px')
  console.log('ok measure 驱动扩缩与实测高度')
}

vv.destroy()
console.log('virtual-view-dom: all ok')
