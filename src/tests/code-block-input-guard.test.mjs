// code-block-input-guard.test.mjs —— 行内输入规则不在代码块里换节点
// 运行：cd src && node tests/code-block-input-guard.test.mjs
//
// 真机成因（CDP 复现）：cpp 代码块里敲 `#include` 补完指令、按空格落定，「# 标签」规则
// 把 #include 换成 tag 节点，而 code_block 的 content 是 text*、marks 只有 code，节点塞不进，
// PM 修补后整块内容消失。根因是 editor-view.js 的 handleTextInput 只挡了「非 textblock」，
// 没挡 code_block 这个「是 textblock 但只收纯文本」的块。守卫：code_block 内一律早退，
// # 标签 / ]] / $ / 强调 全部不生效；正文路径不受影响（对照用例）。

import assert from 'node:assert'
import { register } from 'node:module'
import { JSDOM } from 'jsdom'

register('./css-stub-loader.mjs', import.meta.url)

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost/' })
global.window = dom.window
global.document = dom.window.document
global.Node = dom.window.Node
global.Element = dom.window.Element
global.HTMLElement = dom.window.HTMLElement
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true })
global.DOMParser = dom.window.DOMParser
global.XMLSerializer = dom.window.XMLSerializer
global.NodeFilter = dom.window.NodeFilter
global.DocumentFragment = dom.window.DocumentFragment
global.getComputedStyle = dom.window.getComputedStyle
global.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 0)
global.cancelAnimationFrame = clearTimeout
global.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} }
global.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} }
dom.window.ResizeObserver = global.ResizeObserver
dom.window.IntersectionObserver = global.IntersectionObserver
dom.window.matchMedia = dom.window.matchMedia || (() => ({ matches: false, addEventListener() {}, removeEventListener() {} }))
global.matchMedia = dom.window.matchMedia
if (!dom.window.CSS) dom.window.CSS = { escape: (s) => String(s).replace(/["\\]/g, '\\$&') }
global.CSS = dom.window.CSS

window.__TAURI_INTERNALS__ = {
  async invoke(cmd) { throw new Error('unexpected invoke: ' + cmd) },
}

const { createEditor } = await import('../editor-view.js')
const { TextSelection } = await import('prosemirror-state')

const mountEl = document.getElementById('root')
const ed = createEditor({ mountEl, getVault: () => ({ vaultRoot: '/库', mdRel: 'a.md' }), onMetaChange() {}, onDirty() {} })
const view = ed.view

// 逐字符「敲」：先过 PM 的 handleTextInput 管线（规则命中即被接走），没人接就普通插入
function typeIn(text) {
  for (const ch of text) {
    const { from, to } = view.state.selection
    const handled = view.someProp('handleTextInput', (f) => f(view, from, to, ch))
    if (!handled) view.dispatch(view.state.tr.insertText(ch, from, to))
  }
}

// 光标放到第一个满足 name 的块内容末尾
function caretInBlock(name) {
  let pos = -1
  view.state.doc.descendants((n, p) => {
    if (pos < 0 && n.type.name === name) pos = p + 1 + n.content.size
  })
  assert.ok(pos > 0, '夹具里没有 ' + name)
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, pos)))
}

const setDoc = (md) => { ed.setMarkdown(md); caretInBlock(md.startsWith('```') ? 'code_block' : 'paragraph') }
const hasType = (name) => {
  let found = false
  view.state.doc.descendants((n) => { if (n.type.name === name) found = true })
  return found
}
const firstBlockText = () => view.state.doc.child(0).textContent

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

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

;(async () => {
  await sleep(80)

  // —— 代码块内：规则不接，字符原样进块 ——
  check('cpp 块里 #include 后按空格：内容原样保留（复刻真机 bug）', () => {
    setDoc('```cpp\n#include\n```')
    typeIn(' ')
    assert.equal(firstBlockText(), '#include ', JSON.stringify(view.state.doc.toJSON()))
    assert.equal(hasType('tag'), false, '块内不该转出 tag 节点')
  })

  check('块内敲 x]]：不出 wikiLink', () => {
    setDoc('```js\nx\n```')
    typeIn(']]')
    assert.equal(firstBlockText(), 'x]]')
    assert.equal(hasType('wikiLink'), false)
  })

  check('块内敲 a$b$：不出行内数学', () => {
    setDoc('```js\na\n```')
    typeIn('$b$')
    assert.equal(firstBlockText(), 'a$b$')
    assert.equal(hasType('math_inline'), false)
  })

  check('块内敲 **粗**：不出强调', () => {
    setDoc('```js\n\n```')
    typeIn('**粗**')
    assert.equal(firstBlockText(), '**粗**')
    let hasMark = false
    view.state.doc.descendants((n) => { if (n.marks.some((m) => m.type.name === 'strong')) hasMark = true })
    assert.equal(hasMark, false)
  })

  // —— 正文对照：守卫没误伤 ——
  check('正文 #tag 空格照旧转标签', () => {
    setDoc('aaa #tag\n')
    typeIn(' ')
    assert.equal(hasType('tag'), true, '正文里 #tag 空格应转 tag')
  })

  check('正文 [[目标]] 照旧出链接', () => {
    setDoc('正文\n')
    typeIn('[[目标]]')
    assert.equal(hasType('wikiLink'), true, '正文里 ]] 应转 wikiLink')
  })

  console.log(`\n结果: ${pass} passed, ${fail} failed`)
  if (fail) process.exitCode = 1
  process.exit(fail ? 1 : 0)
})()
