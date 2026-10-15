// footnote.test.mjs —— 功能项 J：脚注命令（insertFootnote / deleteFootnote）事务级测试
// 运行：cd src && node tests/footnote.test.mjs
//
// 命令只依赖 EditorState（view 仅用于 focus），故纯 Node 可测，无需 DOM。

import assert from 'node:assert'
import { EditorState, TextSelection } from 'prosemirror-state'
import { schema, parseMarkdown, serializeMarkdown } from '../editor-schema.js'
import { insertFootnote, deleteFootnote, nextFootnoteId } from '../footnotes.js'

let pass = 0
let fail = 0
function check(name, fn) {
  try {
    fn()
    console.log(`✅ ${name}`)
    pass++
  } catch (e) {
    console.error(`❌ ${name}: ${e.message}`)
    fail++
  }
}

// 在 md 首段末尾放一个光标，构造可分派的 state
function stateAtCursor(md) {
  let st = EditorState.create({ schema, doc: parseMarkdown(md) })
  const firstParaEnd = st.doc.firstChild.nodeSize - 1
  st = st.apply(st.tr.setSelection(TextSelection.create(st.doc, firstParaEnd)))
  return st
}
// 执行一条 PM 命令并把结果事务落到新 state
function run(st, cmd) {
  let next = null
  const handled = cmd(st, (tr) => { next = st.apply(tr) }, undefined)
  return { handled, next }
}
function countNodes(st, name) {
  let n = 0
  st.doc.descendants((node) => { if (node.type.name === name) n++ })
  return n
}
function findNodePos(st, name) {
  let pos = null
  st.doc.descendants((node, p) => { if (node.type.name === name && pos == null) pos = p })
  return pos
}

check('nextFootnoteId 取最小未用整数', () => {
  const st = stateAtCursor('正文[^1]尾[^3]。\n\n[^1]: a\n\n[^3]: b\n')
  assert.strictEqual(nextFootnoteId(st.doc), '2', '已有 1、3 → 应给 2')
})

check('insertFootnote 建 ref + 文末 section/item', () => {
  const { handled, next } = run(stateAtCursor('正文。'), insertFootnote)
  assert.ok(handled, '命令应被处理')
  assert.ok(next, '应产生事务')
  assert.strictEqual(countNodes(next, 'footnote_ref'), 1, '应插入 1 个角标')
  assert.strictEqual(countNodes(next, 'footnote_section'), 1, '应建 1 个文末区')
  assert.strictEqual(countNodes(next, 'footnote_item'), 1, '应建 1 条脚注')
  const md = serializeMarkdown(next.doc)
  assert.ok(/\[\^1\]/.test(md), '序列化应含正文角标 [^1]：' + md)
  assert.ok(/\[\^1\]:/.test(md), '序列化应含文末定义 [^1]: ：' + md)
})

check('连插两次 id 递增、复用同一 section', () => {
  let { next } = run(stateAtCursor('正文。'), insertFootnote)
  // 第二次：把光标移到首段末尾（section 之后不放）
  let st = next
  const firstParaEnd = st.doc.firstChild.nodeSize - 1
  st = st.apply(st.tr.setSelection(TextSelection.create(st.doc, firstParaEnd)))
  const r = run(st, insertFootnote)
  assert.strictEqual(countNodes(r.next, 'footnote_ref'), 2, '应有 2 个角标')
  assert.strictEqual(countNodes(r.next, 'footnote_section'), 1, '仍应只有一个文末区')
  assert.strictEqual(countNodes(r.next, 'footnote_item'), 2, '应有 2 条脚注')
  const ids = []
  r.next.doc.descendants((n) => { if (n.type.name === 'footnote_ref') ids.push(String(n.attrs.id)) })
  assert.deepStrictEqual(ids, ['1', '2'], 'id 应依次为 1、2')
})

check('deleteFootnote 删 ref 连带删 item、末条清空 section', () => {
  let { next } = run(stateAtCursor('正文。'), insertFootnote)
  let st = next
  const refPos = findNodePos(st, 'footnote_ref')
  st = st.apply(st.tr.setSelection(TextSelection.create(st.doc, refPos + 1))) // 光标紧贴 ref 之后
  const r = run(st, deleteFootnote)
  assert.ok(r.handled, '删除命令应被处理')
  assert.strictEqual(countNodes(r.next, 'footnote_ref'), 0, 'ref 应已删')
  assert.strictEqual(countNodes(r.next, 'footnote_section'), 0, '末条删除后 section 应整体移除')
  assert.strictEqual(countNodes(r.next, 'footnote_item'), 0, 'item 应已删')
})

check('deleteFootnote 保留其余 item（多条时只删其一）', () => {
  let { next } = run(stateAtCursor('正文。'), insertFootnote)
  let st = next
  st = st.apply(st.tr.setSelection(TextSelection.create(st.doc, st.doc.firstChild.nodeSize - 1)))
  st = run(st, insertFootnote).next
  const refPos = findNodePos(st, 'footnote_ref') // 第一个 ref
  st = st.apply(st.tr.setSelection(TextSelection.create(st.doc, refPos + 1)))
  const r = run(st, deleteFootnote)
  assert.strictEqual(countNodes(r.next, 'footnote_ref'), 1, '应剩 1 个角标')
  assert.strictEqual(countNodes(r.next, 'footnote_item'), 1, '应剩 1 条脚注')
  assert.strictEqual(countNodes(r.next, 'footnote_section'), 1, 'section 应保留')
})

check('无 ref 时光标处 deleteFootnote 返回 false 不动文档', () => {
  const { handled } = run(stateAtCursor('纯正文无脚注。'), deleteFootnote)
  assert.strictEqual(handled, false, '无可删对象应返回 false')
})

console.log(`\n结果：${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
