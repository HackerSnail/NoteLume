// empty-source-editor.test.mjs —— 源码模式空态不可编辑回归（jsdom）
// 运行：cd src && node tests/empty-source-editor.test.mjs
//
// 空态时 main.js 会把每个窗格的编辑器关成只读；源码态底下是 CodeMirror，
// 它的 editable facet 要跟着关，否则切到源码仍能在没有文档时打字。

import assert from 'node:assert'
import { JSDOM } from 'jsdom'

const dom = new JSDOM('<!doctype html><html><body><div id="mount"></div></body></html>')
globalThis.window = dom.window
globalThis.document = dom.window.document
globalThis.MutationObserver = dom.window.MutationObserver
globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window)
// jsdom 没有滚动布局，CM 首次 measure 会因为 requestAnimationFrame 立刻回调而抛错；
// 这里让 RAF 不回调，编辑器仍正常建起来，editable facet 的 reconfigure 照常生效。
dom.window.requestAnimationFrame = () => 0
globalThis.requestAnimationFrame = () => 0
globalThis.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
}

const { createSourceEditor } = await import('../source-editor.js')
const src = await createSourceEditor({ mountEl: document.getElementById('mount'), theme: 'light' })
const content = document.querySelector('.cm-content')

assert.strictEqual(content.getAttribute('contenteditable'), 'true')
src.setEditable(false)
assert.strictEqual(content.getAttribute('contenteditable'), 'false', '空态下 CodeMirror 应不可输入')
src.setEditable(true)
assert.strictEqual(content.getAttribute('contenteditable'), 'true', '打开文档后恢复输入')
console.log('ok 源码态 setEditable 开关生效')
