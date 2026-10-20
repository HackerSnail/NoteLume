// gapcursor.test.mjs —— 块间隙落点的结构判定（文末块之后能不能放光标）
// 运行：cd src && node tests/gapcursor.test.mjs
//
// 装 prosemirror-gapcursor 后要回答两件事：哪些文末块给落点、落点会不会被写进文件。
// 判定全在 GapCursor.valid：邻块要满足 isAtom || isolating || spec.createGapCursor（读该包
// dist 的 needsGap），代码块三条都不占，所以 editor-schema.js 给它单独加了标记。
// 鼠标点击与方向键的取位要真实 DOM 几何，本文件只钉结构判定，键鼠手感见浏览器实测。

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
const { GapCursor } = await import('prosemirror-gapcursor')
const { Fragment } = await import('prosemirror-model')
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

const blocks = (doc) => Array.from(doc.content.content).map((n) => n.type.name)
const tailValid = (md) => {
  const doc = parseMarkdown(md)
  return GapCursor.valid(doc.resolve(doc.content.size))
}

check('表格收尾：表后可放间隙光标', () => {
  assert.strictEqual(tailValid('| a | b |\n| --- | --- |\n| c | d |'), true)
})

check('代码块收尾：靠 schema 的 createGapCursor 标记给落点', () => {
  assert.strictEqual(tailValid('```python\nlet a = 1\n```'), true)
  assert.strictEqual(schema.nodes.code_block.spec.createGapCursor, true)
})

check('mermaid 代码块收尾：同一节点类型，同样有落点', () => {
  assert.strictEqual(tailValid('```mermaid\ngraph TD\n  A-->B\n```'), true)
})

check('公式块收尾：原子块天然有落点', () => {
  assert.strictEqual(tailValid('$$\nE=mc^2\n$$'), true)
})

check('分割线收尾：原子块天然有落点', () => {
  assert.strictEqual(tailValid('正文一句\n\n---'), true)
})

check('普通段落收尾：不给间隙（负例，段末本来就能打字）', () => {
  assert.strictEqual(tailValid('正文一句\n'), false)
})

check('脚注区收尾：不给落点（范围边界，见方案 §4）', () => {
  assert.strictEqual(tailValid('正文[^1]。\n\n[^1]: 脚注正文'), false)
})

check('容器块收尾不给落点（引用 / 提示块 / 列表，范围边界：needsGap 只看外层块本身）', () => {
  assert.strictEqual(tailValid('> 引用正文'), false)
  assert.strictEqual(tailValid('> [!NOTE]\n> 提示正文'), false)
  assert.strictEqual(tailValid('- 一项'), false)
})

check('表内位置不放间隙，方向键越界落到表外（负例：行里的默认类型是单元格）', () => {
  const md = '| a | b |\n| --- | --- |\n| c | d |'
  const doc = parseMarkdown(md)
  const rowStarts = []
  let lastCell = null
  doc.descendants((n, p) => {
    if (n.type.name === 'table_row') rowStarts.push(p)
    if (n.type.name === 'table_cell' && n.textContent === 'd') lastCell = { n, p }
  })
  for (const p of rowStarts) assert.strictEqual(GapCursor.valid(doc.resolve(p + 1)), false, `行首位置 ${p} 不该可放`)
  assert.strictEqual(schema.nodes.table_row.spec.allowGapCursor, false)
  // 复刻 gapcursor 的 arrow()：dir>0 时先取 $to.after() 再找间隙
  const from = doc.resolve(doc.resolve(lastCell.p + 1).after())
  const found = GapCursor.findGapCursorFrom(from, 1, false)
  assert.ok(found, '末格 ArrowRight 该找到落点')
  assert.strictEqual(found.parent.type.name, 'doc', '落点父块必须是文档层，不是某一行')
  assert.strictEqual(found.pos, doc.content.size)
})

check('间隙光标只是选区：不改文档，因此不判脏', () => {
  const doc = parseMarkdown('| a | b |\n| --- | --- |\n| c | d |')
  const st = EditorState.create({ schema, doc })
  const at = doc.content.size
  const tr = st.tr.setSelection(new GapCursor(doc.resolve(at)))
  assert.strictEqual(JSON.stringify(st.apply(tr).doc.toJSON()), JSON.stringify(doc.toJSON()))
})

check('间隙段落存盘即被吃掉：落点只活在编辑器里', () => {
  const doc = parseMarkdown('| a | b |\n| --- | --- |\n| c | d |')
  const withPara = doc.type.create(null, doc.content.append(Fragment.from(schema.nodes.paragraph.create())))
  assert.deepStrictEqual(blocks(withPara), ['table', 'paragraph'])
  assert.strictEqual(serializeMarkdown(withPara), serializeMarkdown(doc))
})

console.log(`\n${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
