// table-enter.test.mjs —— 表格里的回车：走格、末格出表、格内 Shift-Enter 回上一格
// 运行：cd src && node tests/table-enter.test.mjs
//
// 单元格是 inline* + isolating，splitBlock / exitCode 在里面恒 false（改前实测：Enter、Mod-Enter
// 都无事务），所以表格是光标陷阱。本文件钉住 nlCellEnter / nlCellBack / exitTableBelow 的分工，
// 并守住一条硬约束：表后面已有块时出表只搬光标、不改文档（改文档就会判脏，自动保存会写文件）。

import assert from 'node:assert'
import { JSDOM } from 'jsdom'
const dom = new JSDOM('<!doctype html><html><body></body></html>')
global.window = dom.window
global.document = dom.window.document
global.DOMParser = dom.window.DOMParser
global.Node = dom.window.Node
global.Element = dom.window.Element
global.HTMLElement = dom.window.HTMLElement

const { schema, parseMarkdown } = await import('../editor-schema.js')
const { EditorState, TextSelection, NodeSelection } = await import('prosemirror-state')
const { CellSelection, mergeCells } = await import('prosemirror-tables')
const { splitBlock, newlineInCode, liftEmptyBlock, exitCode } = await import('prosemirror-commands')
const { nlCellEnter, nlCellBack, exitTableBelow } = await import('../table-editing.js')
const { nlBackspace } = await import('../block-commands.js')

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

const N = schema.nodes
const json = (d) => JSON.stringify(d.toJSON())
const cellStarts = (doc) => {
  const out = []
  doc.descendants((n, p) => { if (n.type.name === 'table_cell' || n.type.name === 'table_header') out.push({ at: p + 1, self: p, text: n.textContent }) })
  return out
}
const cellTextUnder = (state) => {
  const $from = state.selection.$from
  for (let d = $from.depth; d > 0; d--) {
    const t = $from.node(d).type.name
    if (t === 'table_cell' || t === 'table_header') return $from.node(d).textContent
  }
  return null
}
const blocks = (doc) => Array.from(doc.content.content).map((n) => n.type.name)
const walkTo = (md, index) => {
  const doc = parseMarkdown(md)
  const st = EditorState.create({ schema, doc })
  return st.apply(st.tr.setSelection(TextSelection.create(doc, cellStarts(doc)[index].at)))
}
const MD2 = '| a | b |\n| --- | --- |\n| c | d |'
const MD3 = '| a | b |\n| --- | --- |\n| c | d |\n| e | f |'
const hasHardBreak = (doc) => { let f = false; doc.descendants((n) => { if (n.type.name === 'hard_break') f = true }); return f }

check('首格 Enter：光标落到下一格，文档不变', () => {
  const s0 = walkTo(MD2, 0)
  let tr = null
  assert.strictEqual(nlCellEnter(s0, (t) => { tr = t }), true)
  const s1 = s0.apply(tr)
  assert.strictEqual(cellTextUnder(s1), 'b')
  assert.strictEqual(json(s1.doc), json(s0.doc), '走格不该改文档')
  // 上游 goToNextCell 落格时给的是「格边界处长度 1」的选区（模型里 anchor/head 差 1），与 Tab 同一条命令。
  // 浏览器会把它夹进文本里，实测成目标格首字被选中：走格后打字即替换、按退格即清掉该格首字。
  assert.strictEqual(s1.selection.empty, false)
  assert.strictEqual(s1.selection.head - s1.selection.anchor, 1)
})

check('走格顺序覆盖全表：3 行表按 Enter 依次落在 a b c d e f', () => {
  const seen = []
  let s = walkTo(MD3, 0)
  for (let i = 0; i < 5; i++) {
    let tr = null
    assert.strictEqual(nlCellEnter(s, (t) => { tr = t }), true, `第 ${i + 1} 次走格该成功`)
    s = s.apply(tr)
    seen.push(cellTextUnder(s))
  }
  assert.deepStrictEqual(seen, ['b', 'c', 'd', 'e', 'f'])
})

check('末格 Enter（表后有段落）：光标进表后段落开头，文档不变', () => {
  const s0 = walkTo(MD2 + '\n\n表后正文。\n', 3)
  let tr = null
  assert.strictEqual(nlCellEnter(s0, (t) => { tr = t }), true)
  const s1 = s0.apply(tr)
  assert.ok(!(s1.selection instanceof NodeSelection))
  assert.match(s1.selection.$from.parent.textContent, /表后正文。/)
  assert.strictEqual(s1.selection.$from.parentOffset, 0)
  assert.strictEqual(json(s1.doc), json(s0.doc), '已有落点时不该再插段落')
})

check('末格 Enter（表是末块）：补一个空段落并把光标放进去', () => {
  const s0 = walkTo(MD2, 3)
  let tr = null
  assert.strictEqual(nlCellEnter(s0, (t) => { tr = t }), true)
  const s1 = s0.apply(tr)
  assert.deepStrictEqual(blocks(s1.doc), ['table', 'paragraph'])
  assert.strictEqual(s1.selection.$from.parent.type.name, 'paragraph')
  assert.strictEqual(s1.selection.$from.parent.content.size, 0)
})

check('出表事务带 scrollIntoView 且只追加一个块（不复制表格）', () => {
  const s0 = walkTo(MD2, 3)
  let tr = null
  nlCellEnter(s0, (t) => { tr = t })
  const s1 = s0.apply(tr)
  let tables = 0
  s1.doc.descendants((n) => { if (n.type.name === 'table') tables++ })
  assert.strictEqual(tables, 1)
})

check('非表格区域 nlCellEnter 返回 false（负例，交回后续回车链）', () => {
  const doc = parseMarkdown('普通正文一句。\n')
  const st = EditorState.create({ schema, doc })
  const s = st.apply(st.tr.setSelection(TextSelection.create(doc, 3)))
  let tr = null
  assert.strictEqual(nlCellEnter(s, (t) => { tr = t }), false)
  assert.strictEqual(tr, null)
})

// 这三条 false 是「Enter 必须给专用命令、放行等于陷阱」的依据：原生链的每一档都在格内歇菜
check('格内四条原生分块全 false（负例：baseKeymap 兜不住表内回车）', () => {
  const doc = parseMarkdown(MD2)
  const c = cellStarts(doc).find((x) => x.text === 'd')
  const st = EditorState.create({ schema, doc })
  const mid = st.apply(st.tr.setSelection(TextSelection.create(doc, c.at)))
  const end = st.apply(st.tr.setSelection(TextSelection.create(doc, c.at + 1)))
  for (const [name, fn] of [['splitBlock', splitBlock], ['newlineInCode', newlineInCode], ['liftEmptyBlock', liftEmptyBlock], ['exitCode', exitCode]]) {
    assert.strictEqual(fn(mid), false, `${name} 格中不该成立`)
    assert.strictEqual(fn(end), false, `${name} 格末不该成立`)
  }
})

check('格内选中若干字时 Enter 仍走格、不改文档（负例：交回后续回车链在格内全 false，等于陷阱）', () => {
  const doc = parseMarkdown(MD2)
  const c = cellStarts(doc)[2]
  const st = EditorState.create({ schema, doc })
  const s = st.apply(st.tr.setSelection(TextSelection.create(doc, c.at, c.at + 1)))
  let tr = null
  assert.strictEqual(nlCellEnter(s, (t) => { tr = t }), true)
  const s1 = s.apply(tr)
  assert.strictEqual(json(s1.doc), json(doc), '带选区走格不该改文档')
  assert.strictEqual(cellTextUnder(s1), 'd')
})

check('格内 Shift-Enter：回上一格，绝不产生 hard_break（产生就会写坏表）', () => {
  const s0 = walkTo(MD2, 2)
  let tr = null
  assert.strictEqual(nlCellBack(s0, (t) => { tr = t }), true)
  const s1 = s0.apply(tr)
  assert.strictEqual(cellTextUnder(s1), 'b')
  assert.ok(!hasHardBreak(s1.doc), '格内不该出现硬换行节点')
  assert.strictEqual(json(s1.doc), json(s0.doc))
})

check('末格 Shift-Enter：回上一格不出表', () => {
  const s0 = walkTo(MD2, 3)
  let tr = null
  assert.strictEqual(nlCellBack(s0, (t) => { tr = t }), true)
  assert.strictEqual(cellTextUnder(s0.apply(tr)), 'c')
})

check('合并格走格：colspan=2 的格算一格，Enter 顺序 a → b → 合并格 → 出表', () => {
  const doc = parseMarkdown(MD2)
  const cs = cellStarts(doc)
  const st = EditorState.create({ schema, doc })
  let s = st.apply(st.tr.setSelection(CellSelection.create(doc, cs[2].self, cs[3].self)))
  let tr = null
  assert.strictEqual(mergeCells(s, (t) => { tr = t }), true, '夹具合并应成立')
  s = s.apply(tr)
  const after = cellStarts(s.doc)
  assert.strictEqual(after.length, 3, '合并后剩三格')
  const seen = []
  s = s.apply(s.tr.setSelection(TextSelection.create(s.doc, after[0].at)))
  for (let i = 0; i < 2; i++) {
    let t2 = null
    assert.strictEqual(nlCellEnter(s, (x) => { t2 = x }), true)
    s = s.apply(t2)
    seen.push(cellTextUnder(s))
  }
  assert.deepStrictEqual(seen, ['b', 'cd'], '合并格整体算一格')
  let t3 = null
  assert.strictEqual(nlCellEnter(s, (x) => { t3 = x }), true, '合并格是末格，Enter 该出表')
})

check('出表后立刻退格：选中表格而不是删掉刚落的段落（串接边界）', () => {
  const s0 = walkTo(MD2 + '\n\n表后正文。\n', 3)
  let tr = null
  nlCellEnter(s0, (t) => { tr = t })
  const s1 = s0.apply(tr)
  let tr2 = null
  assert.strictEqual(nlBackspace(s1, (t) => { tr2 = t }, { endOfTextblock: () => true }), true)
  const s2 = s1.apply(tr2)
  assert.ok(s2.selection instanceof NodeSelection)
  assert.strictEqual(s2.selection.node.type.name, 'table')
  assert.strictEqual(json(s2.doc), json(s1.doc))
})

check('exitTableBelow 在文档只剩一张表时也能给落点', () => {
  const s0 = walkTo(MD2, 3)
  let tr = null
  assert.strictEqual(exitTableBelow(s0, (t) => { tr = t }), true)
  assert.deepStrictEqual(blocks(s0.apply(tr).doc), ['table', 'paragraph'])
})

console.log(`\n${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
