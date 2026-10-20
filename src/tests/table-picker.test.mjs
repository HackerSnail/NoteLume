// table-picker.test.mjs —— N×M 选择器的 DOM 交互回归（jsdom，无布局）
// 运行：cd src && node tests/table-picker.test.mjs
//
// 锁：网格规模、默认 2×2、悬停高亮与提示、点击落定尺寸、Esc / 点外面关闭不落定、
// 方向键移动（越界钳住）+ Enter 落定、单例。

import assert from 'node:assert'
import { JSDOM } from 'jsdom'

const dom = new JSDOM('<!doctype html><html><body></body></html>')
globalThis.window = dom.window
globalThis.document = dom.window.document

const { showTableSizePicker, closeTableSizePicker, MAX_ROWS, MAX_COLS } = await import('../table-picker.js')

const doc = dom.window.document
const view = { coordsAtPos: () => ({ left: 100, top: 100, bottom: 120 }) }

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

function openPicker() {
  const picks = []
  showTableSizePicker(view, { pos: 5, onPick: (rows, cols) => picks.push([rows, cols]) })
  return picks
}
function cellAt(r, c) {
  return doc.querySelector('.nl-tp-cell[data-row="' + r + '"][data-col="' + c + '"]')
}
function mouse(el, type) {
  el.dispatchEvent(new dom.window.MouseEvent(type, { bubbles: true, cancelable: true }))
}
function key(k) {
  dom.window.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }))
}

t('网格规模：10×8，默认 2×2', () => {
  openPicker()
  assert.equal(doc.querySelectorAll('.nl-tp-cell').length, MAX_ROWS * MAX_COLS)
  assert.deepStrictEqual([MAX_ROWS, MAX_COLS], [8, 10])
  assert.equal(doc.querySelector('.nl-tp-hint').textContent, '2 × 2')
  assert.ok(cellAt(1, 1).classList.contains('on'))
  assert.ok(!cellAt(1, 2).classList.contains('on'))
  closeTableSizePicker()
})

t('悬停：高亮到命中的格子，提示给出范围', () => {
  const picks = openPicker()
  mouse(cellAt(2, 3), 'mousemove')
  assert.equal(doc.querySelector('.nl-tp-hint').textContent, '3 × 4')
  assert.ok(cellAt(0, 0).classList.contains('on'))
  assert.ok(cellAt(2, 3).classList.contains('on'))
  assert.ok(!cellAt(2, 4).classList.contains('on'))
  assert.ok(!cellAt(3, 3).classList.contains('on'))
  closeTableSizePicker()
  assert.deepEqual(picks, [])
})

t('点击：落定 rows×cols 并关闭', () => {
  const picks = openPicker()
  mouse(cellAt(2, 3), 'click')
  assert.deepEqual(picks, [[3, 4]])
  assert.equal(doc.querySelector('.nl-table-picker'), null)
})

t('Esc：关闭不落定', () => {
  const picks = openPicker()
  key('Escape')
  assert.equal(doc.querySelector('.nl-table-picker'), null)
  assert.deepEqual(picks, [])
})

t('点外面：关闭不落定', () => {
  const picks = openPicker()
  doc.body.dispatchEvent(new dom.window.MouseEvent('mousedown', { bubbles: true, cancelable: true }))
  assert.equal(doc.querySelector('.nl-table-picker'), null)
  assert.deepEqual(picks, [])
})

t('键盘：方向键移动（越界钳住）+ Enter 落定', () => {
  const picks = openPicker()
  key('ArrowDown')
  key('ArrowDown')
  key('ArrowRight')
  assert.equal(doc.querySelector('.nl-tp-hint').textContent, '4 × 3')
  key('ArrowUp')
  key('ArrowUp')
  key('ArrowUp') // 钳回第 1 行
  assert.equal(doc.querySelector('.nl-tp-hint').textContent, '1 × 3')
  key('Enter')
  assert.deepEqual(picks, [[1, 3]])
  assert.equal(doc.querySelector('.nl-table-picker'), null)
})

t('单例：连开两个只保留一个', () => {
  openPicker()
  openPicker()
  assert.equal(doc.querySelectorAll('.nl-table-picker').length, 1)
  closeTableSizePicker()
  assert.equal(doc.querySelector('.nl-table-picker'), null)
})

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
