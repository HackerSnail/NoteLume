// split-pane.test.mjs —— 分栏引擎（p5plan §6.1）纯逻辑回归（不触 DOM）
// 运行：cd src && node tests/split-pane.test.mjs
import assert from 'node:assert'
import {
  SPLIT_MIN,
  SPLIT_MAX,
  SPLIT_DEFAULT,
  createTree,
  splitPane,
  closePane,
  setRatio,
  clampRatio,
  paneIds,
  parentSplit,
  normalizeTree,
  serializeTree,
  freshId,
  isLeaf,
} from '../split-pane.js'

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

test('单窗格起步；split 后原叶居第一位、新叶第二位', () => {
  const t0 = createTree('p1')
  assert.deepStrictEqual(paneIds(t0), ['p1'])
  const t1 = splitPane(t0, 'p1', 'horizontal', 'p2')
  assert.deepStrictEqual(paneIds(t1), ['p1', 'p2'])
  assert.strictEqual(t1.type, 'split')
  assert.strictEqual(t1.orientation, 'horizontal')
  assert.strictEqual(t1.ratio, SPLIT_DEFAULT)
  assert.strictEqual(t1.children[0].id, 'p1')
  assert.strictEqual(t1.children[1].id, 'p2')
  // 纯函数：旧树不动
  assert.deepStrictEqual(paneIds(t0), ['p1'])
})

test('嵌套：在已有分栏的叶里再分，树深度增加、顺序稳定', () => {
  let t = splitPane(createTree('p1'), 'p1', 'horizontal', 'p2')
  t = splitPane(t, 'p2', 'vertical', 'p3')
  assert.deepStrictEqual(paneIds(t), ['p1', 'p2', 'p3'])
  assert.strictEqual(t.children[1].orientation, 'vertical')
  assert.deepStrictEqual(paneIds(t.children[1]), ['p2', 'p3'])
  // 再往深层拆
  t = splitPane(t, 'p3', 'horizontal', 'p4')
  assert.deepStrictEqual(paneIds(t), ['p1', 'p2', 'p3', 'p4'])
  assert.strictEqual(t.children[1].children[1].orientation, 'horizontal')
})

test('splitPane 对不存在的 paneId 返回等价树', () => {
  const t0 = createTree('p1')
  const t1 = splitPane(t0, 'nope', 'horizontal', 'p2')
  assert.deepStrictEqual(paneIds(t1), ['p1'])
})

test('closePane：摘叶后父 split 由兄弟顶位（兄弟是子树时结构保留）', () => {
  let t = splitPane(createTree('p1'), 'p1', 'horizontal', 'p2')
  t = splitPane(t, 'p2', 'vertical', 'p3')
  // 关 p3：父 split（p2|p3 的竖栏）由 p2 顶位 → 回到 p1|p2 横栏
  t = closePane(t, 'p3')
  assert.deepStrictEqual(paneIds(t), ['p1', 'p2'])
  assert.strictEqual(t.orientation, 'horizontal')
  // 关 p1：根 split 由 p2 顶位 → 单叶
  t = closePane(t, 'p1')
  assert.strictEqual(isLeaf(t), true)
  assert.strictEqual(t.id, 'p2')
})

test('closePane：关的是子树一侧时，整棵兄弟子树保留', () => {
  let t = splitPane(createTree('p1'), 'p1', 'horizontal', 'p2')
  t = splitPane(t, 'p1', 'vertical', 'p3') // 左格再分：树 = 竖(p1|p3) | 横(p2 ...)
  // 在 p2 里再拆一个，让右格也是子树
  t = splitPane(t, 'p2', 'vertical', 'p4')
  assert.deepStrictEqual(paneIds(t), ['p1', 'p3', 'p2', 'p4'])
  // 关 p3：左竖栏由 p1 顶位
  t = closePane(t, 'p3')
  assert.deepStrictEqual(paneIds(t), ['p1', 'p2', 'p4'])
  assert.strictEqual(isLeaf(t.children[0]), true)
  assert.strictEqual(t.children[1].orientation, 'vertical')
})

test('closePane：最后一个窗格不允许关，原样返回', () => {
  const t = createTree('p1')
  assert.strictEqual(closePane(t, 'p1'), t)
})

test('setRatio：按 id 命中并夹紧；未命中返回等价树', () => {
  let t = splitPane(createTree('p1'), 'p1', 'horizontal', 'p2')
  t = setRatio(t, t.id, 0.7)
  assert.strictEqual(t.ratio, 0.7)
  const before = JSON.stringify(serializeTree(t))
  const same = setRatio(t, 'no-such-split', 0.1)
  assert.strictEqual(JSON.stringify(serializeTree(same)), before)
})

test('clampRatio：每侧 20%–80%，非数字回落默认', () => {
  assert.strictEqual(clampRatio(0.1), SPLIT_MIN)
  assert.strictEqual(clampRatio(0.9), SPLIT_MAX)
  assert.strictEqual(clampRatio(0.42), 0.42)
  assert.strictEqual(clampRatio('x'), SPLIT_DEFAULT)
  assert.strictEqual(clampRatio(null), SPLIT_DEFAULT)
})

test('parentSplit：找叶子的父分栏；根叶子没有父', () => {
  let t = splitPane(createTree('p1'), 'p1', 'horizontal', 'p2')
  t = splitPane(t, 'p2', 'vertical', 'p3')
  assert.strictEqual(parentSplit(t, 'p1').id, t.id)
  assert.strictEqual(parentSplit(t, 'p3').id, t.children[1].id)
  assert.strictEqual(parentSplit(createTree('p1'), 'p1'), null)
})

test('normalizeTree：合法树原样收（ratio 夹紧）；坏树退回单窗格', () => {
  const good = serializeTree(splitPane(createTree('p1'), 'p1', 'horizontal', 'p2'))
  const ok = normalizeTree(JSON.parse(JSON.stringify(good)), 'p1')
  assert.deepStrictEqual(paneIds(ok), ['p1', 'p2'])

  const wide = { type: 'split', id: 's1', orientation: 'weird', ratio: 5, children: [good.children[0], good.children[1]] }
  const fixed = normalizeTree(wide, 'p1')
  assert.strictEqual(fixed.orientation, 'horizontal') // 非法方向回落横
  assert.strictEqual(fixed.ratio, SPLIT_MAX) // 越界夹紧

  for (const bad of [null, 42, {}, { type: 'leaf' }, { type: 'split', id: 's', children: [{ type: 'leaf', id: 'a' }] }, { type: 'split', id: 's', children: [{ type: 'leaf', id: 'a' }, { type: 'leaf', id: 'a' }] }]) {
    assert.deepStrictEqual(paneIds(normalizeTree(bad, 'p9')), ['p9'], '坏树应退回单窗格：' + JSON.stringify(bad))
  }
})

test('serializeTree：往返稳定', () => {
  let t = splitPane(createTree('p1'), 'p1', 'vertical', 'p2')
  t = setRatio(t, t.id, 0.31)
  const data = JSON.parse(JSON.stringify(serializeTree(t)))
  const back = normalizeTree(data, 'p1')
  assert.deepStrictEqual(serializeTree(back), data)
})

test('freshId：不给已占用的 id，前缀可不同', () => {
  const t = splitPane(createTree('p1'), 'p1', 'horizontal', 'p2')
  const a = freshId(t, 'p')
  const b = freshId(t, 'p')
  assert.notStrictEqual(a, b)
  assert.ok(!paneIds(t).includes(a))
  assert.ok(!paneIds(t).includes(b))
  assert.ok(a.startsWith('p') && b.startsWith('p'))
  // 空树也能发
  assert.ok(freshId(null, 'p').startsWith('p'))
})

console.log('结果：' + pass + ' passed, ' + fail + ' failed')
if (fail) process.exit(1)
