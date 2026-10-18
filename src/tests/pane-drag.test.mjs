// pane-drag.test.mjs —— 窗格拖拽引擎的纯逻辑回归（不触 DOM）
// 运行：cd src && node tests/pane-drag.test.mjs
//
// 落区判定与排序索引是拖拽最容易算偏的两处：落区偏了会把「并入窗格」做成「拆成两半」，
// 索引偏一格则松手后标签跑到隔壁位置。
import assert from 'node:assert'
import { dropZoneFor, tabDropIndex } from '../pane-drag.js'

let pass = 0
let fail = 0
function test(name, fn) {
  try {
    fn()
    pass++
    console.log('  ok   ' + name)
  } catch (e) {
    fail++
    console.log('  FAIL ' + name + ' —— ' + ((e && e.message) || e))
  }
}

// 800×600 的窗格，左上角在 (100, 50)
const R = { left: 100, top: 50, width: 800, height: 600 }
const midX = 500
const midY = 350

test('dropZoneFor：正中 = center', () => {
  assert.strictEqual(dropZoneFor(R, midX, midY), 'center')
})

test('dropZoneFor：四边内 = 对应方向', () => {
  assert.strictEqual(dropZoneFor(R, R.left + 80, midY), 'left') // 左 10%
  assert.strictEqual(dropZoneFor(R, R.left + 704, midY), 'right') // 右 12%
  assert.strictEqual(dropZoneFor(R, midX, R.top + 48), 'top') // 上 8%
  assert.strictEqual(dropZoneFor(R, midX, R.top + 552), 'bottom') // 下 8%
})

test('dropZoneFor：角落按更近的那条边算，不两轴都中', () => {
  // 左 10% / 上 30%：横轴更近 → left
  assert.strictEqual(dropZoneFor(R, R.left + 80, R.top + 180), 'left')
  // 右 10% / 上 30% → right
  assert.strictEqual(dropZoneFor(R, R.left + 720, R.top + 180), 'right')
  // 左 30% / 下 10%：纵轴更近 → bottom
  assert.strictEqual(dropZoneFor(R, R.left + 240, R.top + 540), 'bottom')
  // 上 10% / 左 30% → top
  assert.strictEqual(dropZoneFor(R, R.left + 240, R.top + 60), 'top')
})

test('dropZoneFor：25% 门槛内外各一刀', () => {
  assert.strictEqual(dropZoneFor(R, R.left + 192, midY), 'left') // 24% 在门槛内
  assert.strictEqual(dropZoneFor(R, R.left + 208, midY), 'center') // 26% 已出门槛
  assert.strictEqual(dropZoneFor(R, midX, R.top + 144), 'top') // 24%
  assert.strictEqual(dropZoneFor(R, midX, R.top + 156), 'center') // 26%
})

test('dropZoneFor：窄窗格按自身比例算，不按像素', () => {
  const small = { left: 0, top: 0, width: 200, height: 100 }
  assert.strictEqual(dropZoneFor(small, 10, 50), 'left') // 5% 宽
  assert.strictEqual(dropZoneFor(small, 100, 50), 'center')
})

// 三个标签各 100 宽：0-100 / 100-200 / 200-300
const rects = [
  { left: 0, width: 100 },
  { left: 100, width: 100 },
  { left: 200, width: 100 },
]

test('tabDropIndex：数指针跨过几个标签中点，结果就是插入位置', () => {
  assert.strictEqual(tabDropIndex(rects, 40, -1), 0) // 还没到第一个中点（50）
  assert.strictEqual(tabDropIndex(rects, 60, -1), 1) // 跨过第一个
  assert.strictEqual(tabDropIndex(rects, 140, -1), 1) // 还没到第二个中点（150）
  assert.strictEqual(tabDropIndex(rects, 160, -1), 2) // 跨过第二个
})

test('tabDropIndex：跳过被拖的那一项', () => {
  // 拖第 1 个（下标 0），指针落在第二标签右半：摘掉它后前面只剩 1 个（第二标签）→ 1
  assert.strictEqual(tabDropIndex(rects, 180, 0), 1)
  // 拖第 2 个（下标 1），指针在第一标签里：前面 0 个 → 0
  assert.strictEqual(tabDropIndex(rects, 40, 1), 0)
})

test('tabDropIndex：越界夹取与空列表', () => {
  assert.strictEqual(tabDropIndex(rects, -50, -1), 0)
  assert.strictEqual(tabDropIndex(rects, 9999, -1), 2) // 三标签的队尾
  assert.strictEqual(tabDropIndex(rects, 9999, 0), 1) // 摘掉一个后队尾是 1
  assert.strictEqual(tabDropIndex([], 50, -1), 0)
})

console.log('结果：' + pass + ' passed, ' + fail + ' failed')
if (fail) process.exit(1)
