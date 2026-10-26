// qd-snippets.test.mjs —— Quarkdown 入门片段的插入回归
// 运行：cd src && node tests/qd-snippets.test.mjs
//
// 回归点：insertSnippet 的 replaceSelection 参数必须是 Slice。曾传 Fragment 导致
// openStart / openEnd 为 undefined，ReplaceStep 里 NaN 比较恒不等，
// 恒抛 ReplaceError("Inconsistent open depths")——右键菜单插片段永远失败（点了没反应）。

import assert from 'node:assert'
import { JSDOM } from 'jsdom'
const dom = new JSDOM('<!doctype html><html><body></body></html>')
global.window = dom.window
global.document = dom.window.document
global.DOMParser = dom.window.DOMParser
global.Node = dom.window.Node
global.Element = dom.window.Element
global.HTMLElement = dom.window.HTMLElement

import { EditorState, TextSelection } from 'prosemirror-state'
import { schema } from '../editor-schema.js'
import { QD_SNIPPETS, insertSnippet } from '../qd/snippets.js'

let pass = 0
let fail = 0
function check(name, fn) {
  try {
    fn()
    pass++
    console.log(`ok  ${name}`)
  } catch (e) {
    fail++
    console.error(`FAIL ${name}: ${e.message}`)
  }
}

// mock view：够 insertSnippet 用的最小面（focus / state / dispatch）
function mockView(doc) {
  const state = EditorState.create({ schema, doc })
  let last = null
  return {
    state,
    dispatch(tr) { last = tr },
    focus() {},
    get applied() { return last },
  }
}

check('四个片段节点结构合法（node.check 不抛）', () => {
  for (const s of QD_SNIPPETS) {
    const nodes = s.nodes()
    assert.ok(nodes.length >= 1, s.id)
    for (const n of nodes) n.check()
  }
})

check('foreach 片段 = 指令段落 + 块参数 code_block（与 qd 求值区域结构同构）', () => {
  const s = QD_SNIPPETS.find((x) => x.id === 'foreach')
  const nodes = s.nodes()
  assert.strictEqual(nodes[0].type.name, 'paragraph')
  assert.ok(nodes[0].textContent.includes('.foreach'))
  assert.strictEqual(nodes[1].type.name, 'code_block')
})

check('insertSnippet 把片段插进文档（Fragment 传法会在此恒抛 ReplaceError）', () => {
  const doc = schema.nodes.doc.create(null, schema.nodes.paragraph.create())
  const view = mockView(doc)
  const s = QD_SNIPPETS.find((x) => x.id === 'var')
  insertSnippet(view, s)
  assert.ok(view.applied, '事务未派发')
  const text = view.applied.doc.textBetween(0, view.applied.doc.content.size, '\n', '\n')
  assert.ok(text.includes('.var'), text)
})

check('空文档（选区 depth 0）里插入同样成功', () => {
  const doc = schema.nodes.doc.create()
  const view = mockView(doc)
  const s = QD_SNIPPETS.find((x) => x.id === 'foreach')
  insertSnippet(view, s)
  assert.ok(view.applied, '事务未派发')
  assert.ok(view.applied.doc.textContent.includes('.foreach'))
})

check('非空选区被替换', () => {
  const doc = schema.nodes.doc.create(null, [
    schema.nodes.paragraph.create(null, schema.text('hello')),
  ])
  const state = EditorState.create({ schema, doc })
  const sel = TextSelection.create(state.doc, 1, state.doc.content.size - 1)
  let last = null
  const view = {
    state: state.apply(state.tr.setSelection(sel)),
    dispatch(tr) { last = tr },
    focus() {},
  }
  insertSnippet(view, QD_SNIPPETS.find((x) => x.id === 'var'))
  assert.ok(last, '事务未派发')
  assert.ok(!last.doc.textContent.includes('hello'), '选区未被替换')
  assert.ok(last.doc.textContent.includes('.var'))
})

console.log(`\n${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
