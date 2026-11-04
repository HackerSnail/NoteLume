// table-select-delete.test.mjs —— 表格「选全了再删」必须一次连节点删掉，不留空壳
// 运行：cd src && node tests/table-select-delete.test.mjs
//
// 背景：框选整张表拿到的是 CellSelection，prosemirror-commands 的 deleteSelection 在这种选区上
// 只清单元格文字（prosemirror-tables 的语义），表格壳留下。而光标一旦落进壳里，单元格的
// isolating 边界会让退格与前向删除全部失效——键盘再也删不掉这张表，只剩右键「删除表格」。
// 与 coveredCodeBlock（选区覆盖整个代码块内容 → 一次删除连节点一起走）同一条手感，这里补表格。

import assert from 'node:assert'
import { JSDOM } from 'jsdom'
const dom = new JSDOM('<!doctype html><html><body></body></html>')
global.window = dom.window
global.document = dom.window.document
global.DOMParser = dom.window.DOMParser
global.Node = dom.window.Node
global.Element = dom.window.Element
global.HTMLElement = dom.window.HTMLElement

const { schema, parseMarkdown, serializeMarkdown } = await import('../editor-schema.js')
const { EditorState, TextSelection, AllSelection } = await import('prosemirror-state')
const { CellSelection, tableEditing } = await import('prosemirror-tables')
const { selectAll } = await import('prosemirror-commands')
const { nlBackspace, nlDelete } = await import('../block-commands.js')

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

// endOfTextblock 的忠实桩（与 backspace.test.mjs 同口径：非 RTL 只看模型位）
const view = {
  endOfTextblock(dir, state) {
    const $c = state.selection.$cursor
    if (!$c) return false
    return dir === 'forward' ? $c.parentOffset === $c.parent.content.size : $c.parentOffset === 0
  },
}

const MD = ['# 标题', '', '前一段', '', '| 功能 | Win/Linux |', '| ---- | --------- |', '| 新建 | Ctrl+N |', '| 保存 | Ctrl+S |', '', '后一段'].join('\n')

const topBlocks = (doc) => Array.from(doc.content.content).map((n) => n.type.name)
const tables = (doc) => {
  const out = []
  doc.forEach((n, off) => { if (n.type.name === 'table') out.push({ start: off, node: n }) })
  return out
}
// 每个单元格的「节点前位置」，按文档顺序
const cellPositions = (doc, tableStart) => {
  const out = []
  const table = doc.nodeAt(tableStart)
  table.forEach((row, rowOff) => {
    const rowStart = tableStart + 1 + rowOff
    row.forEach((cell, cellOff) => out.push(rowStart + 1 + cellOff))
  })
  return out
}
const makeState = (md) => EditorState.create({ doc: parseMarkdown(md), plugins: [tableEditing()] })
const apply = (state, cmd) => {
  let next = state
  const handled = cmd(state, (tr) => (next = state.apply(tr)), view)
  return { handled, state: next }
}
// 整张表的框选：给 CellSelection 的两个位置要「指在格子之前」（库的口径）
const selectAllCells = (state, index = 0) => {
  const cells = cellPositions(state.doc, tables(state.doc)[index].start)
  return CellSelection.create(state.doc, cells[0], cells[cells.length - 1])
}

check('框选整张表 + 退格：表格整块消失，前后段落留着', () => {
  let st = makeState(MD)
  st = st.apply(st.tr.setSelection(selectAllCells(st)))
  const r = apply(st, nlBackspace)
  assert.ok(r.handled, '退格应被接住')
  assert.deepStrictEqual(topBlocks(r.state.doc), ['heading', 'paragraph', 'paragraph'], `实际顶层块：${topBlocks(r.state.doc)}`)
  assert.strictEqual(r.state.doc.textContent, '标题前一段后一段')
})

check('框选整张表 + 前向删除：与退格同果', () => {
  let st = makeState(MD)
  st = st.apply(st.tr.setSelection(selectAllCells(st)))
  const r = apply(st, nlDelete)
  assert.ok(r.handled, '前向删除应被接住')
  assert.ok(!topBlocks(r.state.doc).includes('table'), `表格应消失，实际：${topBlocks(r.state.doc)}`)
})

check('只框选两个格：仍按库语义清文字、留表格', () => {
  let st = makeState(MD)
  const cells = cellPositions(st.doc, tables(st.doc)[0].start)
  st = st.apply(st.tr.setSelection(CellSelection.create(st.doc, cells[2], cells[3])))
  const r = apply(st, nlBackspace)
  assert.ok(r.handled, '退格应被接住')
  assert.ok(topBlocks(r.state.doc).includes('table'), '部分框选不得整块删表')
  const t = r.state.doc.content.content.find((n) => n.type.name === 'table')
  assert.strictEqual(t.childCount, 3, '行数不变')
  assert.strictEqual(t.child(1).textContent, '', '被选那一行两格的文字应清掉')
  assert.strictEqual(t.child(2).textContent, '保存Ctrl+S', '未被选的行留着')
  assert.strictEqual(t.child(0).textContent, '功能Win/Linux', '表头行留着')
})

check('表格是文档唯一块：框选后删掉留一个空段落，不留壳也不崩', () => {
  let st = makeState('| 甲 | 乙 |\n| -- | -- |\n| 1  | 2  |')
  assert.deepStrictEqual(topBlocks(st.doc), ['table'])
  st = st.apply(st.tr.setSelection(selectAllCells(st)))
  const r = apply(st, nlBackspace)
  assert.deepStrictEqual(topBlocks(r.state.doc), ['paragraph'], `实际顶层块：${topBlocks(r.state.doc)}`)
  r.state.doc.check()
  assert.strictEqual(serializeMarkdown(r.state.doc), '')
})

check('Ctrl+A 全选 + 退格：全文清空（含表格），现有行为不回退', () => {
  let st = makeState(MD)
  selectAll(st, (tr) => (st = st.apply(tr)))
  assert.ok(st.selection instanceof AllSelection, `全选后应是 AllSelection，实际 ${st.selection.constructor.name}`)
  const r = apply(st, nlBackspace)
  assert.deepStrictEqual(topBlocks(r.state.doc), ['paragraph'])
  assert.strictEqual(r.state.doc.textContent, '')
})

check('合并表（colspan + rowspan）整表框选：一次删掉', () => {
  const merged = schema.topNodeType.create(null, [
    schema.nodes.paragraph.create(null, schema.text('前')),
    schema.nodes.table.create(null, [
      schema.nodes.table_row.create(null, [
        schema.nodes.table_cell.create({ colspan: 1, rowspan: 2 }, [schema.text('a')]),
        schema.nodes.table_cell.create({ colspan: 2 }, [schema.text('b')]),
      ]),
      schema.nodes.table_row.create(null, [schema.nodes.table_cell.create({ colspan: 2 }, [schema.text('c')])]),
    ]),
    schema.nodes.paragraph.create(null, schema.text('后')),
  ])
  merged.check()
  let st = EditorState.create({ doc: merged, plugins: [tableEditing()] })
  const cells = cellPositions(st.doc, tables(st.doc)[0].start)
  st = st.apply(st.tr.setSelection(CellSelection.create(st.doc, cells[0], cells[cells.length - 1])))
  const r = apply(st, nlBackspace)
  assert.deepStrictEqual(topBlocks(r.state.doc), ['paragraph', 'paragraph'], `实际顶层块：${topBlocks(r.state.doc)}`)
  assert.strictEqual(r.state.doc.textContent, '前后')
})

check('格内光标按退格：不越 isolating 边界，表格一字不动', () => {
  let st = makeState(MD)
  const cells = cellPositions(st.doc, tables(st.doc)[0].start)
  st = st.apply(st.tr.setSelection(TextSelection.create(st.doc, cells[0] + 1)))
  const r = apply(st, nlBackspace)
  assert.ok(topBlocks(r.state.doc).includes('table'), '表格应留着')
  assert.strictEqual(serializeMarkdown(r.state.doc), serializeMarkdown(st.doc), '空选区的格内退格不该改文档')
})

console.log(`\n结果：${pass} passed, ${fail} failed`)
if (fail) process.exitCode = 1
