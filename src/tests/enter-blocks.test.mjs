// enter-blocks.test.mjs —— 回车的分块语义：段落 / 标题 / 代码块 / 列表 / 脚注项 / 引用
// 运行：cd src && node tests/enter-blocks.test.mjs
//
// 改前实测：Enter 键在编辑器里没被绑过，走 baseKeymap 的原生链，于是代码块里 Enter 只插换行、
// 永远出不去，Shift-Enter 反而跳出去（与键名相反）；脚注项里两个键都无事务。
// 现在 Enter = nlEnter（分块），Shift-Enter = nlHardBreak（换行），离开代码块改到 Mod-Enter。
// 脚注项与标题两条链各有一次往返实测支撑，见 block-commands.js 注释。

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
const { EditorState, TextSelection } = await import('prosemirror-state')
const { baseKeymap, exitCode } = await import('prosemirror-commands')
const { normalizeBinding } = await import('../keymap.js')
const { nlEnter, nlHardBreak } = await import('../block-commands.js')

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
const texts = (doc) => Array.from(doc.content.content).map((n) => n.textContent)

// 把光标放到「第一个满足 find 的文本块」内偏移 off 处；off='end' 取块内末尾
function caret(md, find, off = 0) {
  const doc = parseMarkdown(md)
  let target = null
  doc.descendants((n, p) => {
    if (!target && n.isTextblock && find(n)) target = { n, p }
  })
  if (!target) throw new Error('夹具未命中')
  const at = off === 'end' ? target.p + 1 + target.n.content.size : target.p + 1 + off
  const st = EditorState.create({ schema, doc })
  return st.apply(st.tr.setSelection(TextSelection.create(st.doc, at)))
}

// 跑一次命令，返回 [是否接管, 新 state（未接管则 null）]
function once(state, cmd) {
  let tr = null
  const ok = cmd(state, (t) => { tr = t })
  return [ok, ok ? state.apply(tr) : null]
}

check('段落回车：拆成两段，后半段文字进新段', () => {
  const s = caret('甲乙丙丁\n', (n) => n.textContent === '甲乙丙丁', 2)
  const [ok, s1] = once(s, nlEnter)
  assert.strictEqual(ok, true)
  assert.deepStrictEqual(blocks(s1.doc), ['paragraph', 'paragraph'])
  assert.deepStrictEqual(texts(s1.doc), ['甲乙', '丙丁'])
})

check('标题回车：后面新起正文段落，标题本身不拆', () => {
  const s = caret('# 标题一二\n', (n) => n.textContent === '标题一二', 2)
  const [ok, s1] = once(s, nlEnter)
  assert.strictEqual(ok, true)
  assert.deepStrictEqual(blocks(s1.doc), ['heading', 'paragraph'])
  assert.deepStrictEqual(texts(s1.doc), ['标题', '一二'])
  assert.strictEqual(serializeMarkdown(s1.doc), '# 标题\n\n一二')
})

check('标题行首回车：标题一字不动，上方多空段且光标留在空段（边界）', () => {
  const s = caret('# 标题一二\n', (n) => n.textContent === '标题一二', 0)
  const [ok, s1] = once(s, nlEnter)
  assert.strictEqual(ok, true)
  assert.deepStrictEqual(blocks(s1.doc), ['paragraph', 'heading'])
  assert.deepStrictEqual(texts(s1.doc), ['', '标题一二'])
  assert.strictEqual(s1.selection.$from.parent.content.size, 0)
})

check('代码块回车：留在块内加一行，围栏不新增块', () => {
  const s = caret('```python\nlet a = 1\n```\n', (n) => n.textContent.includes('let a'), 'end')
  const [ok, s1] = once(s, nlEnter)
  assert.strictEqual(ok, true)
  assert.deepStrictEqual(blocks(s1.doc), ['code_block'])
  assert.match(s1.doc.firstChild.textContent, /let a = 1\n$/)
})

check('代码块 Shift-Enter：块内换行，不再跳出去（改前是 exitCode）', () => {
  const s = caret('```python\nlet a = 1\n```\n', (n) => n.textContent.includes('let a'), 'end')
  const [ok, s1] = once(s, nlHardBreak)
  assert.strictEqual(ok, true)
  assert.deepStrictEqual(blocks(s1.doc), ['code_block'], '块数变了就是跳出了代码块')
  assert.strictEqual(s1.selection.$from.parent.type.name, 'code_block')
})

check('段落 Shift-Enter：插 hard_break，序列化成行尾反斜杠', () => {
  const s = caret('甲乙丙丁\n', (n) => n.textContent === '甲乙丙丁', 2)
  const [ok, s1] = once(s, nlHardBreak)
  assert.strictEqual(ok, true)
  assert.deepStrictEqual(blocks(s1.doc), ['paragraph'])
  assert.strictEqual(serializeMarkdown(s1.doc), '甲乙\\\n丙丁')
  assert.strictEqual(JSON.stringify(parseMarkdown(serializeMarkdown(s1.doc)).toJSON()), JSON.stringify(s1.doc.toJSON()))
})

check('引用块 Shift-Enter：引用内换行，不拆成两个引用块', () => {
  const s = caret('> 甲乙丙丁\n', (n) => n.textContent === '甲乙丙丁', 2)
  const [ok, s1] = once(s, nlHardBreak)
  assert.strictEqual(ok, true)
  assert.deepStrictEqual(blocks(s1.doc), ['blockquote'])
  assert.match(serializeMarkdown(s1.doc), /^> 甲乙\\\n> 丙丁$/)
})

check('标题 Shift-Enter：不接管、无事务（标题里的硬换行没有 markdown 形态）', () => {
  const s = caret('# 标题一二\n', (n) => n.textContent === '标题一二', 2)
  let tr = '未调用'
  const ok = nlHardBreak(s, (t) => { tr = t })
  assert.strictEqual(ok, false)
  assert.strictEqual(tr, '未调用', '返回 false 不该派发事务')
})

check('列表项回车：新起同列表的一项', () => {
  const s = caret('- 甲乙丙\n', (n) => n.textContent === '甲乙丙', 2)
  const [ok, s1] = once(s, nlEnter)
  assert.strictEqual(ok, true)
  assert.deepStrictEqual(blocks(s1.doc), ['bullet_list'])
  assert.strictEqual(s1.doc.firstChild.childCount, 2)
  assert.deepStrictEqual(texts(s1.doc.firstChild), ['甲乙', '丙'])
})

check('末项空项回车：退出列表而不是留下空项（边界）', () => {
  const s = caret('- 甲乙丙\n- \n', (n) => n.type.name === 'paragraph' && n.textContent === '')
  const [ok, s1] = once(s, nlEnter)
  assert.strictEqual(ok, true)
  assert.deepStrictEqual(blocks(s1.doc), ['bullet_list', 'paragraph'])
  assert.strictEqual(s1.doc.firstChild.childCount, 1, '空项该被 lifted 掉')
  assert.strictEqual(s1.selection.$from.parent.type.name, 'paragraph')
})

check('脚注项回车：落 hard_break，整区往返一致', () => {
  const s = caret('正文一句[^1]。\n\n[^1]: 脚注正文\n', (n) => n.textContent === '脚注正文', 2)
  const [ok, s1] = once(s, nlEnter)
  assert.strictEqual(ok, true)
  assert.strictEqual(serializeMarkdown(s1.doc), '正文一句[^1]。\n\n[^1]: 脚注\\\n正文')
  assert.deepStrictEqual(blocks(s1.doc), ['paragraph', 'footnote_section'])
  assert.strictEqual(JSON.stringify(parseMarkdown(serializeMarkdown(s1.doc)).toJSON()), JSON.stringify(s1.doc.toJSON()))
})

check('脚注项 Shift-Enter：与回车同语义（同一个 hard_break）', () => {
  const s = caret('正文一句[^1]。\n\n[^1]: 脚注正文\n', (n) => n.textContent === '脚注正文', 2)
  const [, a] = once(s, nlEnter)
  const [, b] = once(s, nlHardBreak)
  assert.strictEqual(JSON.stringify(a.doc.toJSON()), JSON.stringify(b.doc.toJSON()))
})

check('脚注项末位回车后不打字：换行节点被序列化吃掉，不产生孤立定义（边界）', () => {
  const s = caret('正文一句[^1]。\n\n[^1]: 脚注正文\n', (n) => n.textContent === '脚注正文', 'end')
  const [ok, s1] = once(s, nlEnter)
  assert.strictEqual(ok, true)
  const md = serializeMarkdown(s1.doc)
  assert.strictEqual(md, '正文一句[^1]。\n\n[^1]: 脚注正文')
  assert.ok(!/^\[\^]:/m.test(md), '不该出现空标签的孤立定义')
})

check('多个脚注项各带一个换行：往返仍一致', () => {
  let s = caret('甲[^1]乙[^2]。\n\n[^1]: 第一项正文\n[^2]: 第二项正文\n', (n) => n.textContent === '第一项正文', 2)
  s = once(s, nlEnter)[1]
  const doc2 = s.doc
  let s2 = caretFrom(doc2, (n) => n.textContent === '第二项正文', 2)
  s2 = once(s2, nlEnter)[1]
  const md = serializeMarkdown(s2.doc)
  assert.match(md, /\[\^1\]: 第一\\\n项正文/)
  assert.strictEqual(JSON.stringify(parseMarkdown(md).toJSON()), JSON.stringify(s2.doc.toJSON()))
})

function caretFrom(doc, find, off) {
  let target = null
  doc.descendants((n, p) => {
    if (!target && n.isTextblock && find(n)) target = { n, p }
  })
  if (!target) throw new Error('夹具未命中')
  const st = EditorState.create({ schema, doc })
  return st.apply(st.tr.setSelection(TextSelection.create(st.doc, target.p + 1 + off)))
}

check('文末段落末尾回车：追加一个空段，光标落在新段', () => {
  const s = caret('正文一句\n', (n) => n.textContent === '正文一句', 'end')
  const [ok, s1] = once(s, nlEnter)
  assert.strictEqual(ok, true)
  assert.strictEqual(s1.doc.childCount, s.doc.childCount + 1)
  assert.strictEqual(s1.selection.$from.parent.type.name, 'paragraph')
})

check('分割线回车不吞块：hr 之后仍留 hr（负例：原子块不参与分块链）', () => {
  const s = caret('正文一句\n\n---\n', (n) => n.textContent === '正文一句', 'end')
  const [ok, s1] = once(s, nlEnter)
  assert.strictEqual(ok, true)
  assert.ok(blocks(s1.doc).includes('horizontal_rule'))
  assert.ok(blocks(s1.doc).filter((t) => t === 'horizontal_rule').length === 1)
})

check('代码块里回车与 Shift-Enter 结果相同（都只在块内加换行）', () => {
  const s = caret('```\na\n```\n', (n) => n.textContent.includes('a'), 'end')
  const [, a] = once(s, nlEnter)
  const [, b] = once(s, nlHardBreak)
  assert.strictEqual(a.doc.firstChild.textContent, 'a\n')
  assert.strictEqual(JSON.stringify(a.doc.toJSON()), JSON.stringify(b.doc.toJSON()))
})

check('Mod-Enter 的离开代码块仍由 baseKeymap 提供，Enter 系键位不可重绑', () => {
  assert.strictEqual(typeof baseKeymap['Mod-Enter'], 'function')
  assert.strictEqual(normalizeBinding('Mod-Enter'), null)
  assert.strictEqual(normalizeBinding('Enter'), null)
  const s = caret('```python\nlet a = 1\n```', (n) => n.textContent.includes('let a'), 'end')
  const [ok, s1] = once(s, exitCode)
  assert.strictEqual(ok, true)
  assert.deepStrictEqual(blocks(s1.doc), ['code_block', 'paragraph'])
  assert.strictEqual(s1.selection.$from.parent.type.name, 'paragraph')
})

console.log(`\n${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
