// outline-tree.test.mjs —— 大纲层级纯逻辑回归：父子切分 / 多级后代 / 收起集合
// 运行：cd src && node tests/outline-tree.test.mjs
//
// 表：用例 | 输入（标题层级序列） | 期望 | 性质
//  1  1,2,3        链式父子，depth 0/1/2，H1 的后代含 H3      正例
//  2  1,2,1,2      第二个 H1 不吞第一个的子级                  正例（兄弟根）
//  3  2,2          无 H1 时两个 H2 都是根                      边界（文档以低级别开头）
//  4  1,3          跳级不产生幽灵父，H3 直挂 H1                边界
//  5  1,2,2        同级是兄弟不是父子                          正例
//  6  3,2,1        逐级回升，全部为根                          边界
//  7  空序列       []                                          负例
//  8  非数组入参   []                                          负例
//  9  level 0/缺省/9/'x'  归一为 1 / 1 / 6 / 1                 负例（脏数据）
// 10  折叠 H1      隐藏其全部后代（跨多级）                    正例
// 11  折叠叶子     空集                                        负例
// 12  折叠父 + 折叠其子  并集，子树不重复                      正例
// 13  collapsed 越界 / null / 非数组 rows   忽略不抛            负例
// 14  hasKids 与 kids 一致：仅真有子级的行有                   正例

import assert from 'node:assert'
import { analyzeOutline, hiddenRows } from '../outline-tree.js'

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

const H = (...levels) => levels.map((lv, i) => ({ level: lv, text: 'h' + (i + 1), pos: i * 10 }))
const pick = (rows, key) => rows.map((r) => r[key])

t('1 链式父子：parent / depth / 多级后代', () => {
  const r = analyzeOutline(H(1, 2, 3))
  assert.deepEqual(pick(r, 'parent'), [null, 0, 1])
  assert.deepEqual(pick(r, 'depth'), [0, 1, 2])
  assert.deepEqual(r[0].descendants, [1, 2], 'H1 的后代应含孙级 H3')
  assert.deepEqual(pick(r, 'hasKids'), [true, true, false])
})

t('2 兄弟根：第二个 H1 不吞前一个的子级', () => {
  const r = analyzeOutline(H(1, 2, 1, 2))
  assert.deepEqual(pick(r, 'parent'), [null, 0, null, 2])
  assert.deepEqual(r[0].descendants, [1])
  assert.deepEqual(r[2].descendants, [3])
})

t('3 文档以 H2 开头：无 H1 时 H2 即根', () => {
  const r = analyzeOutline(H(2, 2))
  assert.deepEqual(pick(r, 'parent'), [null, null])
  assert.deepEqual(pick(r, 'depth'), [0, 0])
})

t('4 跳级（H1→H3）不产生幽灵父', () => {
  const r = analyzeOutline(H(1, 3))
  assert.equal(r[1].parent, 0)
  assert.equal(r[1].depth, 1, '层级深度按父子链算，不按 level 数值')
})

t('5 同级为兄弟', () => {
  const r = analyzeOutline(H(1, 2, 2))
  assert.deepEqual(pick(r, 'parent'), [null, 0, 0])
  assert.deepEqual(r[0].descendants, [1, 2])
})

t('6 逐级回升（3,2,1）全部为根', () => {
  const r = analyzeOutline(H(3, 2, 1))
  assert.deepEqual(pick(r, 'parent'), [null, null, null])
  assert.deepEqual(pick(r, 'hasKids'), [false, false, false])
})

t('7 空序列', () => {
  assert.deepEqual(analyzeOutline([]), [])
})

t('8 非数组入参不抛', () => {
  assert.deepEqual(analyzeOutline(undefined), [])
  assert.deepEqual(analyzeOutline(null), [])
})

t('9 脏 level 归一：0/缺省/字符串→1，9→6', () => {
  const r = analyzeOutline(H(0, undefined, 'x'))
  assert.deepEqual(pick(r, 'parent'), [null, null, null], '三者都归一为 1 → 同级为根')
  assert.deepEqual(pick(r, 'depth'), [0, 0, 0])
  assert.deepEqual(pick(r, 'level'), [1, 1, 1], '行上带归一后的 level，渲染层直接取用')
  const sib = analyzeOutline(H(6, 9))
  assert.deepEqual(pick(sib, 'parent'), [null, null], '9 截为 6 后与 6 同级 → 兄弟')
  const kid = analyzeOutline(H(1, 9))
  assert.equal(kid[1].parent, 0, '截为 6 仍挂在 H1 下')
})

t('10 折叠 H1 → 隐藏跨多级全部后代', () => {
  const items = H(1, 2, 3, 2, 1)
  const r = analyzeOutline(items)
  assert.deepEqual([...hiddenRows(r, new Set([0]))].sort((a, b) => a - b), [1, 2, 3])
})

t('11 折叠叶子 → 空集', () => {
  const r = analyzeOutline(H(1, 2, 1))
  assert.equal(hiddenRows(r, new Set([1])).size, 0)
})

t('12 折叠父与折叠子的并集不重复', () => {
  const r = analyzeOutline(H(1, 2, 3, 3))
  const hid = hiddenRows(r, new Set([0, 1]))
  assert.deepEqual([...hid].sort((a, b) => a - b), [1, 2, 3])
})

t('13 collapsed 越界 / 空 / rows 非数组 → 忽略不抛', () => {
  const r = analyzeOutline(H(1, 2))
  assert.equal(hiddenRows(r, new Set([9])).size, 0)
  assert.equal(hiddenRows(r, new Set([-1])).size, 0)
  assert.equal(hiddenRows(r, null).size, 0)
  assert.equal(hiddenRows(undefined, new Set([0])).size, 0)
  assert.deepEqual([...hiddenRows(r, [])], [], '空集合可为数组')
})

t('14 hasKids 与 kids 一致，且只有真有子级的行可折', () => {
  const r = analyzeOutline(H(1, 2, 1))
  assert.deepEqual(
    r.map((x, i) => [i, x.hasKids, x.kids.length > 0]),
    [
      [0, true, true],
      [1, false, false],
      [2, false, false],
    ]
  )
})

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
