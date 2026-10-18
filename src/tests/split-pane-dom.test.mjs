// split-pane-dom.test.mjs —— mountSplitTree 的 DOM 手术回归（jsdom，无布局）
// 运行：cd src && node tests/split-pane-dom.test.mjs
//
// 覆盖两类曾出过的问题：
//   1. 第一子没退出剩余空间分配（flex-grow 没清零），50% 实际渲染成 75%；
//   2. 拆分 / 关闭手术后按 ref 里缓存的旧子节点刷样式，刷到已搬走的元素上，
//      第一子带着第二子的样式。
// jsdom 没有布局，比例的正确渲染由无头浏览器冒烟验；这里只锁 DOM 结构与 inline 样式。

import assert from 'node:assert'
import { JSDOM } from 'jsdom'
import { mountSplitTree, paneIds } from '../split-pane.js'

const dom = new JSDOM('<!doctype html><html><body><div id="mount"></div></body></html>')
globalThis.window = dom.window
globalThis.document = dom.window.document

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

const styleOf = (el) => ({ basis: el.style.flexBasis, grow: el.style.flexGrow })
const paneEl = (root, paneId) => root.querySelector(`.nl-pane[data-pane-id="${paneId}"]`)
const firstOf = (paneId) => paneEl(document, paneId).parentElement.firstElementChild
const secondOf = (paneId) => paneEl(document, paneId).parentElement.lastElementChild

/** 挂一个单窗格；contentFor 每次返回新壳（同一 paneId 由调用方保证同一元素，这里简单处理） */
function mountOne() {
  document.getElementById('mount').textContent = ''
  const bodies = new Map()
  return mountSplitTree({
    mountEl: document.getElementById('mount'),
    tree: { type: 'leaf', id: 'p1' },
    contentFor: (paneId) => {
      if (!bodies.has(paneId)) {
        const body = document.createElement('div')
        body.className = 'nl-pane-body'
        bodies.set(paneId, body)
      }
      return bodies.get(paneId)
    },
    onPaneFocus: () => {},
    onRatioCommit: () => {},
  })
}

t('单窗格：一个叶子、无分割条', () => {
  mountOne()
  assert.equal(document.querySelectorAll('.nl-pane').length, 1)
  assert.equal(document.querySelectorAll('.nl-resizer').length, 0)
})

t('拆分：原叶居第一位带比例样式，新叶第二位吃剩余', () => {
  const view = mountOne()
  view.split('p1', 'horizontal', 'p2')
  assert.deepEqual(paneIds(view.tree), ['p1', 'p2'])
  assert.equal(document.querySelectorAll('.nl-resizer').length, 1)
  assert.equal(styleOf(firstOf('p1')).grow, '0')
  assert.match(styleOf(firstOf('p1')).basis, /^calc\(50/)
  assert.equal(styleOf(secondOf('p1')).grow, '1')
  assert.equal(styleOf(secondOf('p1')).basis, '0px')
})

t('嵌套拆分：新 split 的第一子是原叶，样式归位（不被缓存引用刷错）', () => {
  const view = mountOne()
  view.split('p1', 'horizontal', 'p2')
  view.split('p2', 'vertical', 'p3')
  assert.deepEqual(paneIds(view.tree), ['p1', 'p2', 'p3'])
  // p2 搬进了新竖向 split 的第一位：必须是第一子样式
  assert.equal(firstOf('p2'), paneEl(document, 'p2'))
  assert.equal(styleOf(paneEl(document, 'p2')).grow, '0')
  assert.match(styleOf(paneEl(document, 'p2')).basis, /^calc\(50/)
  // 新 split 自己是外层 split 的第二子：吃剩余
  const vSplit = paneEl(document, 'p2').parentElement
  assert.equal(styleOf(vSplit).grow, '1')
  assert.equal(styleOf(vSplit).basis, '0px')
  // 外层 split 的第一子仍是 p1，样式没被连带刷坏
  assert.equal(styleOf(paneEl(document, 'p1')).grow, '0')
})

t('关闭第二子：兄弟（第一子）顶位后按新位置重算样式', () => {
  const view = mountOne()
  view.split('p1', 'horizontal', 'p2')
  view.split('p2', 'vertical', 'p3') // p1 | [p2 / p3]
  view.close('p3') // p2 顶位成外层 split 的第二子
  assert.deepEqual(paneIds(view.tree), ['p1', 'p2'])
  assert.equal(secondOf('p1'), paneEl(document, 'p2'))
  assert.equal(styleOf(paneEl(document, 'p2')).grow, '1')
  assert.equal(styleOf(paneEl(document, 'p2')).basis, '0px')
})

t('关闭第一子：剩下的子树直接当根，inline 样式清空交回 CSS', () => {
  const view = mountOne()
  view.split('p1', 'horizontal', 'p2')
  view.split('p2', 'vertical', 'p3') // p1 | [p2 / p3]
  view.close('p1') // [p2 / p3] 整体顶到根
  assert.deepEqual(paneIds(view.tree), ['p2', 'p3'])
  const rootSplit = paneEl(document, 'p2').parentElement
  assert.equal(rootSplit.parentElement, document.getElementById('mount'))
  assert.equal(styleOf(rootSplit).grow, '')
  assert.equal(styleOf(rootSplit).basis, '')
  // 内部比例样式不受影响
  assert.equal(styleOf(paneEl(document, 'p2')).grow, '0')
})

t('关到最后一个：元素与引用都干净', () => {
  const view = mountOne()
  view.split('p1', 'horizontal', 'p2')
  view.close('p2')
  assert.deepEqual(paneIds(view.tree), ['p1'])
  assert.equal(document.querySelectorAll('.nl-resizer').length, 0)
  assert.equal(document.querySelectorAll('.nl-pane').length, 1)
  // 唯一根孩子的 inline 样式已清（不会停在 50% 宽）
  assert.equal(styleOf(paneEl(document, 'p1')).grow, '')
  assert.equal(styleOf(paneEl(document, 'p1')).basis, '')
})

console.log('结果：' + pass + ' passed, ' + fail + ' failed')
if (fail) process.exit(1)
