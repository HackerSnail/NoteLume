// fence-lang-suggest.test.mjs —— 代码块语言联想：候选表过滤（纯函数）+ 确认转换 fenceLangTr
// 运行：cd src && node tests/fence-lang-suggest.test.mjs
//
// 浮层显隐 / ↑↓/Enter/Esc 交互归真机（jsdom 跑不了 PM 视图，同 bibtex 装饰层的分工），这里测：
//  · filterFenceLangs 的前缀口径（对齐 Typora：敲 j 不出 json）、常用置顶、预览语言、截断；
//  · fenceLangTr 的确认语义：语言取选中值（不是敲入值）、语言名整段删除不进块内、
//    整段形态校验（围栏后带内容交回 fenceEnter）、父块与容器守卫、光标落块内起点。

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
const { EditorState, TextSelection } = await import('prosemirror-state')
const { fenceLangTr } = await import('../block-input-rules.js')
const { filterFenceLangs, fenceLangList } = await import('../code-lang-list.js')

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

// 顶层段落 state，光标 at（默认段尾）
const paraState = (text, at) => {
  const doc = schema.nodes.doc.create(null, schema.nodes.paragraph.create(null, text ? schema.text(text) : null))
  const st = EditorState.create({ schema, doc })
  const pos = at == null ? 1 + text.length : at
  return st.apply(st.tr.setSelection(TextSelection.create(st.doc, pos)))
}

const applyLang = (state, lang) => {
  const tr = fenceLangTr(state, lang)
  return tr ? state.apply(tr) : null
}

const codeBlocks = (doc) => Array.from(doc.content.content).filter((n) => n.type.name === 'code_block')

// —— 候选表：filterFenceLangs ——

check('前缀过滤：j 只出 j 开头，含 js 别名（敲 js 不出 javascript 等于没联想）', () => {
  const items = filterFenceLangs('j')
  assert.ok(items.includes('java') && items.includes('javascript') && items.includes('js'))
  for (const l of items) assert.ok(l.startsWith('j'), l)
})

check('空 query：常用语言置顶', () => {
  const items = filterFenceLangs('', 40) // 放开默认截断，覆盖整个置顶区（主名 + 别名）
  assert.equal(items[0], 'javascript')
  const head = items.slice(0, 14)
  for (const l of ['javascript', 'typescript', 'python', 'java', 'go', 'rust', 'c', 'cpp']) {
    assert.ok(head.includes(l), `${l} 应置顶`)
  }
})

check('预览语言可联想：mermaid / bibtex / csv 都在候选表', () => {
  assert.deepEqual(filterFenceLangs('merm'), ['mermaid'])
  assert.ok(filterFenceLangs('bib').includes('bibtex'))
  assert.ok(filterFenceLangs('cs').includes('csv'))
})

check('无匹配返回空数组', () => {
  assert.deepEqual(filterFenceLangs('zzzqqq'), [])
})

check('limit 截断生效', () => {
  assert.equal(filterFenceLangs('', 5).length, 5)
  assert.equal(filterFenceLangs('c', 3).length, 3)
})

check('候选表稳定：同 query 两次结果一致，含主名 / 别名 / 预览语言', () => {
  assert.deepEqual(filterFenceLangs('py'), filterFenceLangs('py'))
  const all = fenceLangList()
  assert.ok(all.includes('javascript') && all.includes('cpp') && all.includes('mermaid'))
  assert.ok(all.includes('js') && all.includes('c++'), '常用别名应在候选表')
  assert.equal(new Set(all).size, all.length, '候选表不该有重复')
  // 常用置顶：PREFERRED 的主名都排在字母序段之前
  const tail = all.slice(36)
  for (const l of ['javascript', 'python', 'java', 'rust']) assert.ok(!tail.includes(l), `${l} 不该落在字母序段`)
})

// —— 确认转换：fenceLangTr ——

check('选中语言即 params（不是敲入的那串）', () => {
  const st = applyLang(paraState('```j'), 'java') // 敲到一半选中了别的
  const cbs = codeBlocks(st.doc)
  assert.equal(cbs.length, 1)
  assert.equal(cbs[0].attrs.params, 'java')
  assert.equal(cbs[0].textContent, '') // 语言名整段删除，不进块内
})

check('光标落块内起点', () => {
  const st = applyLang(paraState('```'), 'js')
  const $head = st.selection.$head
  assert.equal($head.parent.type.name, 'code_block')
  assert.equal($head.parentOffset, 0)
})

check('光标在语言名中间也按整段形态算', () => {
  const st = applyLang(paraState('```js', 1 + 4), 'js') // 光标落在 j|s 之间
  const cbs = codeBlocks(st.doc)
  assert.equal(cbs.length, 1)
  assert.equal(cbs[0].attrs.params, 'js')
  assert.equal(cbs[0].textContent, '')
})

check('纯文本（空语言）也走确认路径', () => {
  const cbs = codeBlocks(applyLang(paraState('```'), '').doc)
  assert.equal(cbs.length, 1)
  assert.equal(cbs[0].attrs.params, '')
})

check('围栏后带内容不接（交回 fenceEnter：保留内容进块内）', () => {
  assert.equal(applyLang(paraState('```js 代码'), 'js'), null)
})

check('前缀非围栏不接', () => {
  assert.equal(applyLang(paraState('x```js'), 'js'), null)
})

check('非空选区不接', () => {
  const doc = schema.nodes.doc.create(null, schema.nodes.paragraph.create(null, schema.text('```js')))
  const st = EditorState.create({ schema, doc })
  const st2 = st.apply(st.tr.setSelection(TextSelection.create(st.doc, 1, 6)))
  assert.equal(fenceLangTr(st2, 'js'), null)
})

check('代码块里不接（块内 ``` 是代码内容，退出走 codeFenceExit）', () => {
  const doc = schema.nodes.doc.create(null, schema.nodes.code_block.create({ params: '' }, schema.text('```')))
  const st = EditorState.create({ schema, doc })
  const st2 = st.apply(st.tr.setSelection(TextSelection.create(st.doc, 4)))
  assert.equal(fenceLangTr(st2, 'js'), null)
})

check('脚注项容器放不下不接', () => {
  // footnote_item 的 content 只收一个段落：手工造脚注 > 段落('```js')，
  // markdown 夹具 '[^1]: ```js' 会解析成 code_block（围栏在脚注项里也生效），测不到容器守卫
  const doc = schema.nodes.doc.create(null, schema.nodes.footnote_section.create(
    null,
    schema.nodes.footnote_item.create({ id: '1' }, schema.nodes.paragraph.create(null, schema.text('```js'))),
  ))
  // 脚注项段落：doc 0 + section 打开 1 + item 打开 1 = 内容起点 2，'```js' 5 字符，光标落段尾
  const st = EditorState.create({ schema, doc })
  const st2 = st.apply(st.tr.setSelection(TextSelection.create(st.doc, 2 + 5)))
  assert.equal(fenceLangTr(st2, 'js'), null)
})

console.log(`\n结果: ${pass} passed, ${fail} failed`)
if (fail) process.exitCode = 1
