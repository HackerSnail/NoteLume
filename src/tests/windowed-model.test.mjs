// windowed-model.test.mjs —— Phase 0 spike：窗口化模型层不变量（无头 PM，无需浏览器）
// 运行：cd src && node tests/windowed-model.test.mjs
//
// 目的：在写任何 DOM 之前，验证「master 切片 ↔ 窗口编辑回灌」在模型层是否自洽——
// 往返一致、窗口内拆分、跨窗口边界合并、选区双向映射、master undo。
// 结论直接决定全可编辑虚拟化是 go 还是 no-go。

import assert from 'node:assert'
import { EditorState, TextSelection } from 'prosemirror-state'
import { history, undo } from 'prosemirror-history'
import { schema, parseMarkdown, serializeMarkdown } from '../editor-schema.js'
import {
  blockOffsets, sliceWindow, windowDelta, windowToMasterPos, masterToWindowPos,
  syncWindowToMaster, windowForScroll,
} from '../windowed-model.js'

let pass = 0
let fail = 0
function t(name, fn) {
  try { fn(); console.log(`✅ ${name}`); pass++ } catch (e) { console.error(`❌ ${name}: ${e.message}`); fail++ }
}

// 6 个单字段落，每块 nodeSize=3，绝对位置：A[0,3) B[3,6) C[6,9) D[9,12) E[12,15) F[15,18)
const MD = 'A\n\nB\n\nC\n\nD\n\nE\n\nF'
const eq = (a, b, msg) => assert.strictEqual(serializeMarkdown(a).trim(), serializeMarkdown(b).trim(), msg)

t('blockOffsets：每块绝对区间 0 基、首尾相接、覆盖到 content.size', () => {
  const doc = parseMarkdown(MD)
  const offs = blockOffsets(doc)
  assert.strictEqual(offs.length, 6)
  assert.strictEqual(offs[0].start, 0)
  for (const o of offs) assert.strictEqual(o.end, o.start + o.size)
  for (let i = 1; i < offs.length; i++) assert.strictEqual(offs[i].start, offs[i - 1].end)
  assert.strictEqual(offs[offs.length - 1].end, doc.content.size)
})

t('切片 + 无编辑回灌 == 原文（往返无损）', () => {
  const doc = parseMarkdown(MD)
  const ms = EditorState.create({ schema, doc })
  const win = sliceWindow(doc, 1, 3) // B,C,D
  eq(ms.apply(syncWindowToMaster(ms, 1, 3, win)).doc, doc, '无编辑回灌不应改动 master')
})

t('窗口内插入文本 → 回灌 == 直接改整篇', () => {
  const doc = parseMarkdown(MD)
  const ms = EditorState.create({ schema, doc })
  let ws = EditorState.create({ schema, doc: sliceWindow(doc, 1, 3) })
  // 窗口首块 B 文本末尾 = 窗口 pos 2（para 开于 0，文本 1..2）
  ws = ws.apply(ws.tr.setSelection(TextSelection.create(ws.doc, 2)).insertText('!'))
  const newMaster = ms.apply(syncWindowToMaster(ms, 1, 3, ws.doc))
  eq(newMaster.doc, parseMarkdown('A\n\nB!\n\nC\n\nD\n\nE\n\nF'))
})

t('窗口末块 Enter 拆分 → 回灌后 master 块数 +1 且 == 直接拆', () => {
  const doc = parseMarkdown(MD)
  const ms = EditorState.create({ schema, doc })
  let ws = EditorState.create({ schema, doc: sliceWindow(doc, 1, 3) }) // B,C,D
  const before = ws.doc.childCount
  ws = ws.apply(ws.tr.split(8)) // D 文本末尾（窗口 pos 8）拆成 D + 空段
  assert.strictEqual(ws.doc.childCount, before + 1, '窗口内拆分块数应 +1')
  const newMaster = ms.apply(syncWindowToMaster(ms, 1, 3, ws.doc))
  assert.strictEqual(newMaster.doc.childCount, 7, 'master 应长出一个空段')
  eq(newMaster.doc, parseMarkdown('A\n\nB\n\nC\n\nD\n\n\n\nE\n\nF'))
})

t('跨窗口顶边合并：邻居不在窗口时无法表示（overscan 必留）', () => {
  const doc = parseMarkdown(MD)
  const ms = EditorState.create({ schema, doc })
  let ws = EditorState.create({ schema, doc: sliceWindow(doc, 1, 3) }) // 不含 A
  let threw = false
  try { ws = ws.apply(ws.tr.join(0)) } catch (_) { threw = true } // 文档边界处 join
  const newMaster = ms.apply(syncWindowToMaster(ms, 1, 3, ws.doc))
  const unchanged = serializeMarkdown(newMaster.doc).trim() === serializeMarkdown(doc).trim()
  assert.ok(threw || unchanged, '边界外邻居的合并不应污染 master（要么抛错要么无变化）')
})

t('overscan 把邻居纳入窗口后，顶边合并可正确回灌', () => {
  const doc = parseMarkdown(MD)
  const ms = EditorState.create({ schema, doc })
  let ws = EditorState.create({ schema, doc: sliceWindow(doc, 0, 3) }) // A,B,C,D
  ws = ws.apply(ws.tr.join(3)) // A|B 边界（窗口 pos 3）合并 → "AB"
  const newMaster = ms.apply(syncWindowToMaster(ms, 0, 3, ws.doc))
  eq(newMaster.doc, parseMarkdown('AB\n\nC\n\nD\n\nE\n\nF'))
})

t('选区双向映射：窗口 pos ↔ master pos 落在同一块', () => {
  const doc = parseMarkdown(MD)
  const wpos = 2 // 窗口里 B 文本末尾
  const mpos = windowToMasterPos(doc, 1, wpos)
  assert.strictEqual(masterToWindowPos(doc, 1, mpos), wpos, '往返应相等')
  assert.strictEqual(mpos, 5, 'B 在 master 起点 3 + 窗口 2 = 5')
  assert.ok(doc.resolve(mpos).parent.textContent.includes('B'), '映射应落在 B 内')
  assert.ok(windowDelta(doc, 1) > 0)
})

t('master 上的 undo 能撤销一次窗口回灌', () => {
  const doc = parseMarkdown(MD)
  const ms = EditorState.create({ schema, doc, plugins: [history()] })
  let ws = EditorState.create({ schema, doc: sliceWindow(doc, 1, 3) })
  ws = ws.apply(ws.tr.setSelection(TextSelection.create(ws.doc, 2)).insertText('!'))
  const edited = ms.apply(syncWindowToMaster(ms, 1, 3, ws.doc))
  eq(edited.doc, parseMarkdown('A\n\nB!\n\nC\n\nD\n\nE\n\nF'))
  let tr2 = null
  const ok = undo(edited, (tr) => { tr2 = tr })
  assert.ok(ok && tr2, 'history 应能撤销窗口回灌这一步')
  eq(edited.apply(tr2).doc, doc, 'undo 后应还原为原文')
})

t('windowForScroll：窗口随滚动移动且带 overscan', () => {
  const heights = new Array(100).fill(20) // 100 块，每块 20px
  const w1 = windowForScroll(heights, 0, 100, 5)
  assert.strictEqual(w1.i0, 0)
  assert.ok(w1.i1 > w1.i0)
  const w2 = windowForScroll(heights, 500, 100, 5) // 滚到 500px（第 25 块附近）
  assert.ok(w2.i0 > w1.i0 && w2.i0 <= 25, '窗口应随滚动前移')
  assert.strictEqual(w2.totalHeight, 2000)
})

console.log(`\nwindowed-model: ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
