// merged-table.test.mjs —— 功能项 J：合并表格的两阶段解析 + HTML 序列化往返
// 运行：cd src && node tests/merged-table.test.mjs
//
// 合并表的「解析回节点」用到 DOMParser.parseSlice（需真实 DOM），故本文件用 jsdom 引导全局；
// 不含顶层 <table> 的普通往返仍走 DOM-free 路径（见 roundtrip.test.mjs）。

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
const { CellSelection, mergeCells, splitCell } = await import('prosemirror-tables')
const { EditorState } = await import('prosemirror-state')

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

function collectCells(doc) {
  const cells = []
  doc.descendants((n) => { if (n.type.name === 'table_cell' || n.type.name === 'table_header') cells.push(n) })
  return cells
}
function hasTableNode(doc) {
  let t = false
  doc.descendants((n) => { if (n.type.name === 'table') t = true })
  return t
}

check('横向合并 <table> 解析→序列化幂等，且 colspan 保真', () => {
  const md = '<table><tr><th colspan="2">ab</th></tr><tr><td>c</td><td>d</td></tr></table>'
  const doc1 = parseMarkdown(md)
  assert.ok(hasTableNode(doc1), '应还原出 table 节点')
  const cells = collectCells(doc1)
  assert.ok(cells.some((c) => c.attrs.colspan === 2), '应有一个 colspan=2 的格')
  const out1 = serializeMarkdown(doc1)
  assert.ok(out1.startsWith('<table') && out1.includes('colspan="2"'), '合并表须输出真 <table> HTML：' + out1)
  const out2 = serializeMarkdown(parseMarkdown(out1))
  assert.strictEqual(out1, out2, '再往返须幂等')
})

check('纵向+横向复合合并 幂等', () => {
  const md = '<table><tr><td colspan="2" rowspan="2">X</td><td>a</td></tr><tr><td>b</td></tr></table>'
  const out1 = serializeMarkdown(parseMarkdown(md))
  const out2 = serializeMarkdown(parseMarkdown(out1))
  assert.strictEqual(out1, out2, '复合合并往返须幂等')
  assert.ok(/rowspan="2"/.test(out1) && /colspan="2"/.test(out1), 'colspan/rowspan 均须保留：' + out1)
})

check('合并格内对齐与内联标记保真', () => {
  const md = '<table><tr><th colspan="2" style="text-align:center">标<strong>题</strong></th></tr><tr><td>1</td><td>2</td></tr></table>'
  const doc1 = parseMarkdown(md)
  const merged = collectCells(doc1).find((c) => c.attrs.colspan === 2)
  assert.strictEqual(merged.attrs.alignment, 'center', '合并格对齐须保真')
  let boldText = ''
  merged.forEach((k) => { if (k.marks.some((m) => m.type.name === 'strong')) boldText += k.text })
  assert.strictEqual(boldText, '题', 'strong 标记应还原到内联节点')
  const out1 = serializeMarkdown(doc1)
  assert.ok(out1.includes('text-align:center') && out1.includes('<strong>'), '序列化须带回 style 与 <strong>：' + out1)
  assert.strictEqual(out1, serializeMarkdown(parseMarkdown(out1)), '幂等')
})

check('无合并的 GFM 表仍走 GFM（不误升级成 HTML）', () => {
  const md = '| a | b |\n| --- | --- |\n| c | d |\n'
  const out = serializeMarkdown(parseMarkdown(md))
  assert.ok(out.includes('|'), '仍应是 GFM 管道表')
  assert.ok(!out.includes('<table'), '不应输出 HTML 表')
})

check('围栏代码块内的 <table> 字面量不被预处理误吞', () => {
  const md = '示例：\n\n```\n<table><tr><td>x</td></tr></table>\n```\n\n结束。\n'
  const doc1 = parseMarkdown(md)
  assert.ok(!hasTableNode(doc1), '代码块内的 <table> 不应被还原为表格节点')
  let codeText = ''
  doc1.descendants((n) => { if (n.type.name === 'code_block') codeText = n.textContent })
  assert.ok(codeText.includes('<table>'), '代码块文本须原样保留 <table>：' + codeText)
  const out1 = serializeMarkdown(doc1)
  assert.strictEqual(out1, serializeMarkdown(parseMarkdown(out1)), '幂等')
})

check('mergeCells 造出的合并可无损往返', () => {
  const cell = (t, hdr) => schema.nodes[hdr ? 'table_header' : 'table_cell'].create({ alignment: null, colspan: 1, rowspan: 1, colwidth: null }, schema.text(t))
  const table = schema.nodes.table.create(null, [
    schema.nodes.table_row.create(null, [cell('a', true), cell('b', true), cell('c', true)]),
    schema.nodes.table_row.create(null, [cell('d'), cell('e'), cell('f')]),
  ])
  let st = EditorState.create({ schema, doc: schema.node('doc', null, [table]) })
  const starts = []
  st.doc.descendants((n, pos) => { if (n.type.name === 'table_header' || n.type.name === 'table_cell') starts.push(pos) })
  st = st.apply(st.tr.setSelection(CellSelection.create(st.doc, starts[0], starts[1])))
  let merged = null
  assert.ok(mergeCells(st, (tr) => { merged = st.apply(tr) }), 'mergeCells 应被处理')
  const md = serializeMarkdown(merged.doc)
  assert.ok(md.includes('<table') && md.includes('colspan="2"'), '合并后应序列化为 HTML 表：' + md)
  // 再解析回来：合并属性保真、幂等
  const md2 = serializeMarkdown(parseMarkdown(md))
  assert.strictEqual(md, md2, 'mergeCells 产物往返幂等')
  assert.ok(collectCells(parseMarkdown(md)).some((c) => c.attrs.colspan === 2), '重解析后仍有 colspan=2')
})

check('splitCell 拆分合并格→回落 GFM', () => {
  // 从合并 HTML 表解析出节点，对 colspan=2 的格执行 splitCell
  const md = '<table><tr><th colspan="2">ab</th></tr><tr><td>c</td><td>d</td></tr></table>'
  const doc = parseMarkdown(md)
  let mergedPos = null
  doc.descendants((n, pos) => { if (mergedPos == null && (n.type.name === 'table_header' || n.type.name === 'table_cell') && n.attrs.colspan > 1) mergedPos = pos })
  assert.ok(mergedPos != null, '应先有合并格')
  let st = EditorState.create({ schema, doc })
  st = st.apply(st.tr.setSelection(CellSelection.create(st.doc, mergedPos)))
  let out = null
  const handled = splitCell(st, (tr) => { out = st.apply(tr) })
  assert.ok(handled, 'splitCell 应被处理')
  const ser = serializeMarkdown(out.doc)
  assert.ok(!ser.includes('<table'), '拆分后应回到 GFM：' + ser)
  assert.ok(collectCells(out.doc).every((c) => c.attrs.colspan === 1 && c.attrs.rowspan === 1), '所有格应为 1x1')
})

console.log(`\n结果：${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
