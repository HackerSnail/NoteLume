// 运行：cd src && node tests/delete-forward.test.mjs
//
// 背景：前向删除（Delete 键）与退格同构、方向相反——原生链 deleteSelection → joinForward →
// selectNodeForward。joinForward 的 deleteBarrier 会把下一块并进代码块末行（一次按键整块
// 被吸走），又自带「邻居是 atom 就直接删」分支。仓库键位绑 nlDelete 后，代码块边界的第一下
// 只选中整块，第二下才删。本文件钉住这条分派。
// view 桩与 backspace.test.mjs 同款：prosemirror-view 的 endOfTextblockHorizontal 对非 RTL
// 文本只看模型位（offset===0 / offset===content.size），恒真桩会把代码块里第二行行尾也当块尾。

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
const { nlDelete } = await import('../block-commands.js')

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

const view = {
  endOfTextblock(dir, state) {
    const $c = state.selection.$cursor
    if (!$c) return false
    return dir === 'forward' ? $c.parentOffset === $c.parent.content.size : $c.parentOffset === 0
  },
}
const blocks = (doc) => Array.from(doc.content.content).map((n) => n.type.name)
const text = (doc) => {
  const t = []
  doc.descendants((n) => { if (n.isText) t.push(n.text) })
  return t.join('')
}
// 光标放到「文本内容匹配 re 的第一个文本块」开头 / 末尾
function caretAtStart(doc, re) {
  let at = null
  doc.descendants((n, p) => {
    if (at === null && n.isTextblock && re.test(n.textContent)) at = p + 1
  })
  assert.ok(at !== null, `夹具里没有匹配 ${re} 的文本块`)
  return TextSelection.create(doc, at)
}
// 光标放到「needle 在任意文本块里首次出现处」之前 / 之后（代码块内的行中 / 行尾定位用）
function caretAt(doc, needle, atEnd = false) {
  let at = null
  doc.descendants((n, p) => {
    if (at === null && n.isTextblock && n.textContent.includes(needle)) {
      at = p + 1 + n.textContent.indexOf(needle) + (atEnd ? needle.length : 0)
    }
  })
  assert.ok(at !== null, `夹具里没有 ${needle}`)
  return TextSelection.create(doc, at)
}
// 选区覆盖「re 匹配的整个文本块」的内容
function selectBlockText(doc, re) {
  let from = null, to = null
  doc.descendants((n, p) => {
    if (from === null && n.isTextblock && re.test(n.textContent)) { from = p + 1; to = p + 1 + n.textContent.length }
  })
  assert.ok(from !== null, `夹具里没有匹配 ${re} 的文本块`)
  return TextSelection.create(doc, from, to)
}
// 选中「类型名为 name 的第一个节点」本身
function selectNode(doc, name) {
  let pos = null
  doc.descendants((n, p) => { if (pos === null && n.type.name === name) pos = p })
  assert.ok(pos !== null, `夹具里没有 ${name}`)
  return NodeSelection.create(doc, pos)
}
function pressTimes(doc, mk, times) {
  const st = EditorState.create({ schema, doc })
  let s = st.apply(st.tr.setSelection(mk(doc)))
  const out = []
  for (let i = 0; i < times; i++) {
    let tr = null
    const r = nlDelete(s, (t) => { tr = t }, view)
    if (tr) s = s.apply(tr)
    out.push({ r, sel: s.selection })
  }
  return { s, out }
}
const top = (md) => parseMarkdown(md)

check('段中光标 Delete：命令不接管，交回按键默认按字符删', () => {
  const { s, out } = pressTimes(top('段落一\n\n```js\nlet a = 1\nlet b = 2\n```\n\n段落二。\n'), (d) => caretAt(d, '落一'), 1)
  assert.strictEqual(out[0].r, false)
  assert.deepStrictEqual(blocks(s.doc), ['paragraph', 'code_block', 'paragraph'])
  assert.strictEqual(text(s.doc), '段落一let a = 1\nlet b = 2段落二。')
})

check('段末下一块是段落：合并下一块内容进本段，正文不丢', () => {
  const { s, out } = pressTimes(top('第一段。\n\n第二段。\n'), (d) => caretAt(d, '第一段。', true), 1)
  assert.strictEqual(out[0].r, true)
  assert.ok(!(s.selection instanceof NodeSelection), '普通段落不该走选中整块')
  assert.deepStrictEqual(blocks(s.doc), ['paragraph'])
  assert.strictEqual(text(s.doc), '第一段。第二段。')
})

check('段末下一块是代码块：第一次选中代码块，正文不动', () => {
  // 改前：joinForward 的 deleteBarrier 会把代码块内容并进上一段，一次按键整块消失
  const { s, out } = pressTimes(top('段落一\n\n```js\nlet a = 1\nlet b = 2\n```\n\n段落二。\n'), (d) => caretAt(d, '段落一', true), 1)
  assert.strictEqual(out[0].r, true)
  assert.ok(s.selection instanceof NodeSelection, '代码块该走选中整块')
  assert.strictEqual(s.selection.node.type.name, 'code_block')
  assert.deepStrictEqual(blocks(s.doc), ['paragraph', 'code_block', 'paragraph'])
  assert.strictEqual(text(s.doc), '段落一let a = 1\nlet b = 2段落二。')
})

check('代码块选中后第二次 Delete：删整块，只留两侧段落', () => {
  const { s, out } = pressTimes(top('段落一\n\n```js\nlet a = 1\nlet b = 2\n```\n\n段落二。\n'), (d) => caretAt(d, '段落一', true), 2)
  assert.strictEqual(out[1].r, true)
  assert.deepStrictEqual(blocks(s.doc), ['paragraph', 'paragraph'])
  assert.strictEqual(text(s.doc), '段落一段落二。')
  assert.ok(!text(s.doc).includes('let a = 1'), '代码内容随块一起消失才对')
})

check('光标在代码块末行行尾：第一次选中当前代码块，下一段不动', () => {
  // 改前：joinForward 把下一段吸进代码块末行，一次按键少一整段
  const { s, out } = pressTimes(top('段落一\n\n```js\nlet a = 1\nlet b = 2\n```\n\n段落二。\n'), (d) => caretAt(d, 'let b = 2', true), 1)
  assert.strictEqual(out[0].r, true)
  assert.ok(s.selection instanceof NodeSelection, '该走选中整块')
  assert.strictEqual(s.selection.node.type.name, 'code_block')
  assert.deepStrictEqual(blocks(s.doc), ['paragraph', 'code_block', 'paragraph'])
  assert.strictEqual(text(s.doc), '段落一let a = 1\nlet b = 2段落二。')
})

check('代码块选中后第二次 Delete（块内方向）：删整块，两段正文保留', () => {
  const { s, out } = pressTimes(top('段落一\n\n```js\nlet a = 1\nlet b = 2\n```\n\n段落二。\n'), (d) => caretAt(d, 'let b = 2', true), 2)
  assert.strictEqual(out[1].r, true)
  assert.deepStrictEqual(blocks(s.doc), ['paragraph', 'paragraph'])
  assert.strictEqual(text(s.doc), '段落一段落二。')
})

check('代码块第二行行中 Delete：不接管，交回按键默认按字符删', () => {
  // 视觉行尾不是块尾：代码块里的换行是文本 \n，模型位 parentOffset<content.size
  const { s, out } = pressTimes(top('段落一\n\n```js\nlet a = 1\nlet b = 2\n```\n\n段落二。\n'), (d) => caretAt(d, 'let b'), 1)
  assert.strictEqual(out[0].r, false, '块内第二行行中不该选中整块')
  assert.deepStrictEqual(blocks(s.doc), ['paragraph', 'code_block', 'paragraph'])
})

check('段末下一块是分割线：原子块走选中，分割线不消失', () => {
  const { s, out } = pressTimes(top('段落一\n\n---\n\n段落二。\n'), (d) => caretAt(d, '段落一', true), 1)
  assert.strictEqual(out[0].r, true)
  assert.ok(s.selection instanceof NodeSelection)
  assert.strictEqual(s.selection.node.type.name, 'horizontal_rule')
  assert.deepStrictEqual(blocks(s.doc), ['paragraph', 'horizontal_rule', 'paragraph'])
})

check('段末下一块是表格：isolating 挡住合并，选中整表', () => {
  const { s, out } = pressTimes(top('段落一\n\n| a | b |\n| --- | --- |\n| c | d |\n\n段落二。\n'), (d) => caretAt(d, '段落一', true), 1)
  assert.strictEqual(out[0].r, true)
  assert.ok(s.selection instanceof NodeSelection)
  assert.strictEqual(s.selection.node.type.name, 'table')
  assert.deepStrictEqual(blocks(s.doc), ['paragraph', 'table', 'paragraph'])
})

check('拖选覆盖整个代码块内容后按一次：连块删除，不留空围栏', () => {
  // 改前：deleteSelection 只删文本，剩一个空 ``` 壳
  const doc = top('段落一\n\n```js\nlet a = 1\n```\n\n段落二。\n')
  const st = EditorState.create({ schema, doc })
  const s0 = st.apply(st.tr.setSelection(selectBlockText(doc, /let a = 1/)))
  let tr = null
  assert.strictEqual(nlDelete(s0, (t) => { tr = t }, view), true)
  const s = s0.apply(tr)
  assert.deepStrictEqual(blocks(s.doc), ['paragraph', 'paragraph'])
  assert.strictEqual(text(s.doc), '段落一段落二。')
})

check('NodeSelection 选中代码块时 Delete：删整块，段落正文保留', () => {
  const doc = top('段落一\n\n```js\nlet a = 1\n```\n\n段落二。\n')
  const st = EditorState.create({ schema, doc })
  const s0 = st.apply(st.tr.setSelection(selectNode(doc, 'code_block')))
  let tr = null
  assert.strictEqual(nlDelete(s0, (t) => { tr = t }, view), true)
  const s = s0.apply(tr)
  assert.deepStrictEqual(blocks(s.doc), ['paragraph', 'paragraph'])
  assert.strictEqual(text(s.doc), '段落一段落二。')
})

check('文档末段段尾 Delete：无事发生', () => {
  const { s, out } = pressTimes(top('段落一\n'), (d) => caretAt(d, '段落一', true), 1)
  assert.strictEqual(out[0].r, false)
  assert.deepStrictEqual(blocks(s.doc), ['paragraph'])
  assert.strictEqual(text(s.doc), '段落一')
})

console.log(`\n${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
