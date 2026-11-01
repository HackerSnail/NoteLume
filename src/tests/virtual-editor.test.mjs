// virtual-editor.test.mjs —— 虚拟化窗口内核测试（Phase 2，纯模型无浏览器）
// 运行：cd src && node tests/virtual-editor.test.mjs
//
// 核心不变式 assertConsistent：任意操作后，「窗口实块内容 == master 窗口区间内容」
// 且「窗口 pos <-> master pos 平移互逆」。编辑（打字/分块/全选删除）、窗口前增量、
// undo/redo、跨窗跳转、跨界大变更全部以它兜底。

import assert from 'node:assert'
import { Fragment, Slice } from 'prosemirror-model'
import { AllSelection, TextSelection } from 'prosemirror-state'
import { ReplaceStep, Transform } from 'prosemirror-transform'
import { parseMarkdown } from '../editor-schema.js'
import { VirtualEditor } from '../virtual/virtual-editor.js'
import { buildBlockIndex, posToBlock } from '../virtual/blocks.js'

function makeDoc(n) {
  const lines = Array.from({ length: n }, (_, i) => `段落${i}内容`)
  return parseMarkdown(lines.join('\n\n') + '\n')
}

function makeVE(n = 20, opts = {}) {
  return new VirtualEditor(makeDoc(n), { windowSize: 5, estimateHeight: 40, ...opts })
}

/** 核心不变式：窗口实块 == master 窗口区间；坐标平移互逆；master 无 spacer 混入 */
function assertConsistent(ve, msg = '') {
  const win = ve.winState.doc
  const winKids = []
  win.forEach((child, _o, i) => {
    if (i > 0 && i < win.childCount - 1) winKids.push(child)
  })
  const masterKids = []
  for (let i = ve.i0; i < ve.i1; i++) masterKids.push(ve.blockAt(i).node)
  assert.deepStrictEqual(
    winKids.map((k) => JSON.stringify(k.toJSON())),
    masterKids.map((k) => JSON.stringify(k.toJSON())),
    `窗口与 master 失同步${msg}`,
  )
  assert.strictEqual(ve.i1 - ve.i0, winKids.length, `窗口区间块数与窗口 doc 不符${msg}`)
  ve.doc.descendants((node) => {
    assert.notStrictEqual(node.type.name, 'nl_spacer', `master 混入 spacer${msg}`)
  })
  if (winKids.length) {
    const rr = ve.winRealRange()
    for (let p = rr.realStart; p <= rr.realEnd; p++) {
      const m = ve.winToMasterPos(p)
      assert.strictEqual(ve.masterToWinPos(m), p, `坐标平移不互逆 win=${p}${msg}`)
    }
  }
}

function masterText(ve, a, b) {
  const s = ve.blockAt(a).offset
  const e = ve.blockAt(b - 1).offset + ve.blockAt(b - 1).size
  return ve.doc.textBetween(s + 1, e - 1, '\n')
}

// ———— 窗口切片与映射 ————

{
  const ve = makeVE(20)
  assert.strictEqual(ve.i0, 0)
  assert.strictEqual(ve.i1, 5)
  const win = ve.winState.doc
  assert.strictEqual(win.childCount, 7, '窗口 = top spacer + 5 实块 + bottom spacer')
  assert.strictEqual(win.firstChild.type.name, 'nl_spacer')
  assert.strictEqual(win.lastChild.type.name, 'nl_spacer')
  assert.strictEqual(ve.delta, ve.blockAt(0).offset - 1)
  // 窗口实块内容与 master 对应块一致
  for (let k = 0; k < 5; k++) {
    assert.strictEqual(win.child(k + 1).textContent, ve.blockAt(k).node.textContent)
  }
  assertConsistent(ve, '(初始窗口)')
  // 窗口外 pos 不可映射（块 7 在窗口 [0,5) 外）
  assert.strictEqual(ve.masterToWinPos(ve.blockAt(7).offset), null)
  console.log('ok 窗口切片结构与映射')
}

// ———— 窗口内打字回灌 master ————

{
  const ve = makeVE(20)
  // 第一实块（段落0）第 1 个字符后打 X：pos 2 是块内容起点，+1 落在「段」后
  const tr = ve.winState.tr.insertText('X', 3)
  ve.applyWindowTr(tr)
  assert.strictEqual(masterText(ve, 0, 1), '段X落0内容', `实际 ${masterText(ve, 0, 1)}`)
  assert.strictEqual(ve.blockCount, 20, '打字不改块数')
  assertConsistent(ve, '(打字)')
  console.log('ok 窗口打字回灌 master')
}

// ———— 窗口前增量：窗口不动、账本重算 ————

{
  const ve = makeVE(20)
  const winBefore = JSON.stringify(ve.winState.doc.toJSON())
  const selBefore = ve.winState.selection.toJSON()
  // 在块 0 内部打字（窗口区间 [0,5)，块 0 是首块——改用窗口后编辑验证 Case A'，窗口前用插块验证）
  const off3 = ve.blockAt(7).offset // 窗口外块 7
  const tr = ve.masterState.tr // 直接在 master 上构造事务（窗口 [0,5) 外的块 7）
  tr.step(new ReplaceStep(off3 + 1, off3 + 1, new Slice(Fragment.fromArray([ve.schema.text('X')]), 0, 0)))
  ve.applyMasterTr(tr)
  assert.strictEqual(JSON.stringify(ve.winState.doc.toJSON()), winBefore, '窗口后增量不应动窗口 doc')
  assertConsistent(ve, '(窗口后打字)')

  // 窗口内插入一个新块（在块 1 末尾 split，块 1 ∈ 窗口 [0,5)）：走 Case B 平移，窗口跟着分块
  const ve2 = makeVE(20)
  const off1 = ve2.blockAt(1).offset + ve2.blockAt(1).size - 1 // 块 1 内容末尾
  const tf = new Transform(ve2.doc)
  tf.split(off1, 1)
  const mTr = ve2.masterState.tr
  for (const s of tf.steps) mTr.step(s)
  ve2.applyMasterTr(mTr)
  assert.strictEqual(ve2.blockCount, 21)
  assert.strictEqual(ve2.winState.doc.childCount, 8, '窗口实块应变 6（+1）')
  assertConsistent(ve2, '(窗口内插块)')

  // 窗口前插入一个新块：窗口 doc 不动，i0 前移（块号随插入后移）
  const ve3 = makeVE(20)
  ve3.openWindow(5, 10)
  const win3 = JSON.stringify(ve3.winState.doc.toJSON())
  const off1b = ve3.blockAt(1).offset + ve3.blockAt(1).size - 1
  const tf3 = new Transform(ve3.doc)
  tf3.split(off1b, 1)
  const mTr3 = ve3.masterState.tr
  for (const s of tf3.steps) mTr3.step(s)
  ve3.applyMasterTr(mTr3)
  assert.strictEqual(ve3.blockCount, 21)
  assert.strictEqual(JSON.stringify(ve3.winState.doc.toJSON()), win3, '窗口前插块不应动窗口 doc')
  assert.strictEqual(ve3.i0, 6, '窗口首块号应随插入后移')
  assertConsistent(ve3, '(窗口前插块)')
  console.log('ok 窗口外增量同步（前/后）')
}

// ———— undo / redo 跨窗口桥接 ————

{
  const ve = makeVE(20)
  ve.applyWindowTr(ve.winState.tr.insertText('X', 3))
  assert.ok(masterText(ve, 0, 1).includes('X'))
  assert.ok(ve.undo(), 'undo 应有历史可退')
  assert.ok(!masterText(ve, 0, 1).includes('X'), 'undo 后 master 应还原')
  assertConsistent(ve, '(undo)')
  assert.ok(ve.redo(), 'redo 应有历史可进')
  assert.ok(masterText(ve, 0, 1).includes('X'), 'redo 后 master 恢复')
  assertConsistent(ve, '(redo)')
  console.log('ok undo/redo 跨窗口')
}

// ———— 窗口内分块（回车）：块数变化同步 ————

{
  const ve = makeVE(20)
  // 在第一实块段落中间（pos 4，即「段落|0」之间）split
  const tf = new Transform(ve.winState.doc)
  tf.split(4, 1)
  const tr = ve.winState.tr
  for (const s of tf.steps) tr.step(s)
  ve.applyWindowTr(tr)
  assert.strictEqual(ve.blockCount, 21, '分块后 master 块数 +1')
  assert.strictEqual(masterText(ve, 0, 1), '段落')
  assert.strictEqual(masterText(ve, 1, 2), '0内容')
  assertConsistent(ve, '(分块)')
  // 分块后的块号账本：窗口实块数变 6
  assert.strictEqual(ve.i1 - ve.i0, 6)
  console.log('ok 窗口内分块同步')
}

// ———— 全选删除：spacer 剥离、master 区间删空 ————

{
  const ve = makeVE(20)
  const winDoc = ve.winState.doc
  const tr = ve.winState.tr.setSelection(new AllSelection(winDoc)).deleteSelection()
  ve.applyWindowTr(tr)
  assert.strictEqual(ve.blockCount, 20 - 5, '窗口实块应整体删除')
  ve.doc.descendants((node) => {
    assert.notStrictEqual(node.type.name, 'nl_spacer', 'master 不得混入 spacer')
  })
  assertConsistent(ve, '(全选删除)')
  // 空窗口态（实块 0）下 undo 能恢复
  assert.ok(ve.undo())
  assert.strictEqual(ve.blockCount, 20)
  assertConsistent(ve, '(全选删除后 undo)')
  console.log('ok 全选删除与 spacer 剥离')
}

// ———— Case C：跨界删除触发整窗重建 ————

{
  const ve = makeVE(20)
  // 删除范围从窗口前块 2 内部一直到窗口内块 3 中部（跨窗口首边界）
  const from = ve.blockAt(2).offset + 2
  const to = ve.blockAt(3).offset + 4
  const tr = ve.masterState.tr
  tr.step(new ReplaceStep(from, to, Slice.empty))
  ve.applyMasterTr(tr)
  assertConsistent(ve, '(跨界删除)')
  // 窗口内容与 master 一致（由 assertConsistent 保证），块数应 -1（两块缝合内容被删没产生新块）
  assert.strictEqual(ve.blockCount, 19)
  console.log('ok 跨界删除整窗重建')
}

// ———— 跨窗跳转 ————

{
  const ve = makeVE(20)
  const target = ve.blockAt(15).offset + 3 // 块 15 内部
  ve.jumpToPos(target)
  assert.ok(ve.i0 <= 15 && 15 < ve.i1, '窗口应覆盖目标块')
  assert.strictEqual(ve.masterState.selection.from, target, 'master 选区落目标')
  const sel = ve.winState.selection
  assert.ok(ve.masterToWinPos(target) === sel.from, '窗口选区应映射到目标')
  assertConsistent(ve, '(跳转)')
  // 窗内跳转只动选区不重切
  const i0 = ve.i0
  const i1 = ve.i1
  ve.jumpToPos(ve.blockAt(15).offset + 5)
  assert.strictEqual(ve.i0, i0)
  assert.strictEqual(ve.i1, i1)
  console.log('ok 跨窗跳转')
}

// ———— 滚动扩缩 ————

{
  const ve = makeVE(20)
  ve.viewportBlocks(8, 9)
  assert.ok(ve.i0 <= 8 && ve.i1 > 9, '扩缩后窗口覆盖可视区')
  assertConsistent(ve, '(扩缩)')
  // 可视区已在窗口内：不动窗口
  const i0 = ve.i0
  const i1 = ve.i1
  ve.viewportBlocks(ve.i0 + 1, ve.i1 - 2)
  assert.strictEqual(ve.i0, i0)
  assert.strictEqual(ve.i1, i1)
  console.log('ok 滚动扩缩')
}

// ———— 连续混合编辑：不变式贯穿 ————

{
  const ve = makeVE(30, { windowSize: 4 })
  ve.jumpToPos(ve.blockAt(10).offset + 2)
  // 窗口内连打三次
  for (let i = 0; i < 3; i++) {
    const p = ve.winState.selection.from
    ve.applyWindowTr(ve.winState.tr.insertText(String(i), p))
  }
  assertConsistent(ve, '(连打)')
  // 窗口外某块删除一个块（块 20 整块删）
  const off20 = ve.blockAt(20).offset
  const mTr = ve.masterState.tr
  mTr.step(new ReplaceStep(off20, off20 + ve.blockAt(20).size, Slice.empty))
  ve.applyMasterTr(mTr)
  assertConsistent(ve, '(窗口外删块)')
  assert.strictEqual(ve.blockCount, 29)
  // undo 一次（窗口外删块）→ 块数回 30，窗口保持
  assert.ok(ve.undo())
  assert.strictEqual(ve.blockCount, 30)
  assertConsistent(ve, '(窗口外删块 undo)')
  console.log('ok 混合编辑不变式贯穿')
}

// ———— blocks.js 纯函数边界 ————

{
  const doc = makeDoc(4)
  const blocks = buildBlockIndex(doc)
  assert.strictEqual(blocks.length, 4)
  assert.strictEqual(blocks[0].offset, 0)
  // 交界 pos 归后一块
  const boundary = blocks[1].offset
  assert.strictEqual(posToBlock(blocks, boundary), 1)
  assert.strictEqual(posToBlock(blocks, doc.content.size), 3, '文档末尾归最后一块')
  console.log('ok blocks 纯函数边界')
}

console.log('virtual-editor: all ok')
