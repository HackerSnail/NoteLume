// backspace.test.mjs —— 退格守卫：块首合并回原位，代码块 / 表格 / 原子块仍走「按一下选中整块」
// 运行：cd src && node tests/backspace.test.mjs
//
// 背景：仓库曾把 Backspace 裸绑 selectNodeBackward，跳过 joinBackward，任意块首按一次退格
// 就选中上一整块、再按一次整块消失。本文件钉住新链路的分派：能并的块并、不该并的块选。
// 断言只到「命令返回值 + 结果文档 + 选区类型」，不依赖 DOM 光标测量，故 view 传恒真桩
// （等价于光标确实在块首 / 块尾，夹具都按此构造）。

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

const view = { endOfTextblock: () => true }
const N = schema.nodes
const blocks = (doc) => Array.from(doc.content.content).map((n) => n.type.name)
const text = (doc) => {
  const t = []
  doc.descendants((n) => { if (n.isText) t.push(n.text) })
  return t.join('')
}
// 光标放到「文本内容匹配 re 的第一个文本块」开头
function caretAtStart(doc, re) {
  let at = null
  doc.descendants((n, p) => {
    if (at === null && n.isTextblock && re.test(n.textContent)) at = p + 1
  })
  assert.ok(at !== null, `夹具里没有匹配 ${re} 的文本块`)
  return TextSelection.create(doc, at)
}
function pressTimes(doc, mk, times) {
  const st = EditorState.create({ schema, doc })
  let s = st.apply(st.tr.setSelection(mk(doc)))
  const out = []
  for (let i = 0; i < times; i++) {
    let tr = null
    const r = nlBackspace(s, (t) => { tr = t }, view)
    if (tr) s = s.apply(tr)
    out.push({ r, sel: s.selection })
  }
  return { s, out }
}
const top = (md) => parseMarkdown(md)

check('段落块首：合并回上一块，正文一个字不丢', () => {
  const { s, out } = pressTimes(top('第一段。\n\n第二段。\n'), (d) => caretAtStart(d, /第二段/), 1)
  assert.strictEqual(out[0].r, true)
  assert.ok(!(s.selection instanceof NodeSelection), '不该选中整块')
  assert.deepStrictEqual(blocks(s.doc), ['paragraph'])
  assert.strictEqual(text(s.doc), '第一段。第二段。')
})

check('标题块首：并入标题行，不选中也不删', () => {
  const { s, out } = pressTimes(top('# 标题\n\n下面正文。\n'), (d) => caretAtStart(d, /下面/), 1)
  assert.strictEqual(out[0].r, true)
  assert.ok(!(s.selection instanceof NodeSelection))
  assert.strictEqual(text(s.doc), '标题下面正文。')
})

check('列表后段落块首：并回列表末项，列表还在', () => {
  const { s, out } = pressTimes(top('- 一\n- 二\n\n下面正文。\n'), (d) => caretAtStart(d, /下面/), 1)
  assert.strictEqual(out[0].r, true)
  assert.ok(!(s.selection instanceof NodeSelection))
  assert.deepStrictEqual(blocks(s.doc), ['bullet_list'])
  assert.strictEqual(text(s.doc), '一二下面正文。')
})

check('代码块后段落块首：第一次选中代码块，正文不动', () => {
  const { s, out } = pressTimes(top('```js\nlet a = 1\n```\n\n下面正文。\n'), (d) => caretAtStart(d, /下面/), 1)
  assert.strictEqual(out[0].r, true)
  assert.ok(s.selection instanceof NodeSelection, '代码块该走选中整块')
  assert.strictEqual(s.selection.node.type.name, 'code_block')
  assert.deepStrictEqual(blocks(s.doc), ['code_block', 'paragraph'])
  assert.match(text(s.doc), /下面正文。/)
})

check('代码块选中后第二次退格：删整块，段落正文保留（不并成一行）', () => {
  const { s, out } = pressTimes(top('```js\nlet a = 1\n```\n\n下面正文。\n'), (d) => caretAtStart(d, /下面/), 2)
  assert.strictEqual(out[1].r, true)
  assert.deepStrictEqual(blocks(s.doc), ['paragraph'])
  assert.strictEqual(text(s.doc), '下面正文。')
  assert.ok(!text(s.doc).includes('let a = 1'), '代码内容随块一起消失才对')
})

check('mermaid 围栏同代码块一档：选中而非并入', () => {
  const doc = parseMarkdown('```mermaid\ngraph TD;\nA-->B;\n```\n\n下面正文。\n')
  const { s, out } = pressTimes(doc, (d) => caretAtStart(d, /下面/), 1)
  assert.strictEqual(out[0].r, true)
  assert.ok(s.selection instanceof NodeSelection)
  assert.strictEqual(s.selection.node.attrs.params, 'mermaid')
})

check('表格后段落块首：isolating 挡住合并，选中整表', () => {
  const { s, out } = pressTimes(top('| a | b |\n| --- | --- |\n| c | d |\n\n下面正文。\n'), (d) => caretAtStart(d, /下面/), 1)
  assert.strictEqual(out[0].r, true)
  assert.ok(s.selection instanceof NodeSelection)
  assert.strictEqual(s.selection.node.type.name, 'table')
})

check('公式块后段落块首：原子块选中', () => {
  const doc = schema.topNodeType.create(null, [N.math_block.create({ latex: 'E=mc2' }), N.paragraph.create(null, schema.text('下面正文。'))])
  const { s, out } = pressTimes(doc, (d) => caretAtStart(d, /下面/), 1)
  assert.strictEqual(out[0].r, true)
  assert.ok(s.selection instanceof NodeSelection)
  assert.strictEqual(s.selection.node.type.name, 'math_block')
})

check('行中退格：命令不接管（返回 false，交回按键默认按字符删）', () => {
  const doc = top('第一段。\n\n第二段还有字。\n')
  let at = null
  doc.descendants((n, p) => { if (at === null && /还有/.test(n.textContent)) at = p + 1 + n.textContent.indexOf('还有') })
  const st = EditorState.create({ schema, doc })
  const s = st.apply(st.tr.setSelection(TextSelection.create(doc, at)))
  let tr = null
  assert.strictEqual(nlBackspace(s, (t) => { tr = t }, { endOfTextblock: () => false }), false)
  assert.strictEqual(tr, null, '不该产生事务')
})

check('有选区退格：先删选区，块结构不变', () => {
  const doc = top('第一段。\n\n第二段。\n')
  let a = null, b = null
  doc.descendants((n, p) => {
    if (a === null && n.isTextblock && /第二段/.test(n.textContent)) { a = p + 1; b = p + 1 + 2 }
  })
  const st = EditorState.create({ schema, doc })
  const s = st.apply(st.tr.setSelection(TextSelection.create(doc, a, b)))
  let tr = null
  assert.strictEqual(nlBackspace(s, (t) => { tr = t }, view), true)
  const out = s.apply(tr).doc
  assert.deepStrictEqual(blocks(out), ['paragraph', 'paragraph'], '不该把两段并成一段')
  assert.strictEqual(text(out), '第一段。段。')
})

check('单元格内块首退格：不越 isolating 边界', () => {
  const doc = top('| a | b |\n| --- | --- |\n| c | d |')
  let at = null
  doc.descendants((n, p) => { if (at === null && n.type.name === 'table_cell') at = p + 1 })
  const st = EditorState.create({ schema, doc })
  const s = st.apply(st.tr.setSelection(TextSelection.create(doc, at)))
  let tr = null
  assert.strictEqual(nlBackspace(s, (t) => { tr = t }, view), false, '格首退格既不选表也不并表')
  assert.strictEqual(tr, null)
})

check('文档首块行首退格：没有上一块，命令不接管', () => {
  const doc = top('只有这一段。\n')
  const st = EditorState.create({ schema, doc })
  const s0 = st.apply(st.tr.setSelection(TextSelection.create(doc, 1)))
  let tr = null
  assert.strictEqual(nlBackspace(s0, (t) => { tr = t }, view), false)
  assert.strictEqual(tr, null)
})

check('分割线后段落块首：原子块走选中，分割线不消失', () => {
  const doc = parseMarkdown('---\n\n下面正文。\n')
  const { s, out } = pressTimes(doc, (d) => caretAtStart(d, /下面/), 1)
  assert.strictEqual(out[0].r, true)
  assert.ok(s.selection instanceof NodeSelection)
  assert.strictEqual(s.selection.node.type.name, 'horizontal_rule')
  assert.match(text(s.doc), /下面正文。/)
})

check('引用内多段：末段并入上一段，引用块不被整块选中', () => {
  const { s, out } = pressTimes(parseMarkdown('> 引用首行\n> 引用次行\n\n> 引用末行\n'), (d) => caretAtStart(d, /引用末行/), 1)
  assert.strictEqual(out[0].r, true)
  assert.ok(!(s.selection instanceof NodeSelection), '引用容器不该一次按键就被选中')
  assert.deepStrictEqual(blocks(s.doc), ['blockquote'])
  assert.strictEqual(text(s.doc), '引用首行 引用次行引用末行')
})

check('引用后段落块首：跨容器合并只去引用标记，正文一字不丢', () => {
  const doc = parseMarkdown('> 引用一段\n\n下面正文。\n')
  const { s, out } = pressTimes(doc, (d) => caretAtStart(d, /下面/), 1)
  assert.strictEqual(out[0].r, true)
  assert.strictEqual(text(s.doc), '引用一段下面正文。')
})

console.log(`\n${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
