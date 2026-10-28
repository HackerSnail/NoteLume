// html-block-click.test.mjs —— HTML 块落点分派：点图片放大、点别处才就地改源码
// 运行：cd src && node tests/html-block-click.test.mjs
//
// 走的是真 node view（createEditor + prosemirror-view 渲染），不是把 openIslandImage 单拎出来：
// 「点动图反倒弹出一段 HTML 源码」这条反馈坏在分派上，只有真视图能钉住。
// 后端用 window.__TAURI_INTERNALS__.invoke 打桩（read_image_data_uri 回可辨识的 data URI）。

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
global.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
}
global.IntersectionObserver = class {
  observe() {}
  disconnect() {}
}
dom.window.ResizeObserver = global.ResizeObserver
dom.window.IntersectionObserver = global.IntersectionObserver
dom.window.matchMedia = dom.window.matchMedia || (() => ({ matches: false, addEventListener() {}, removeEventListener() {} }))
global.matchMedia = dom.window.matchMedia
if (!dom.window.CSS) dom.window.CSS = { escape: (s) => String(s).replace(/["\\]/g, '\\$&') }
global.CSS = dom.window.CSS

const CTX = { vaultRoot: '/库', mdRel: 'README.md' }
window.__TAURI_INTERNALS__ = {
  async invoke(cmd, args) {
    if (cmd === 'read_image_data_uri') return 'data:image/png;base64,' + Buffer.from(args.src).toString('base64')
    throw new Error('unexpected invoke: ' + cmd)
  },
}

const { createEditor } = await import('../editor-view.js')
const { closeImage } = await import('../img-viewer.js')

// README 预览表同构：两格带 alt 的配图 + 格内文字
const MD = ['前言段落。', '', '<table align="center"><tr>', '<td align="center"><img src="img/preview/light.png" alt="浅色主题" width="100%"><br>浅色</td>', '<td align="center"><img src="img/preview/dark.png" alt="暗黑主题" width="100%"><br>暗黑</td>', '</tr></table>', '', '收尾段落。', ''].join('\n')

const mountEl = document.getElementById('root')
createEditor({ mountEl, getVault: () => CTX, onMetaChange() {}, onDirty() {} }).setMarkdown(MD)
await new Promise((r) => setTimeout(r, 60))

let pass = 0
let fail = 0
function check(name, fn) {
  try {
    fn()
    pass++
    console.log('ok  ' + name)
  } catch (e) {
    fail++
    console.error('FAIL ' + name + ': ' + e.message)
  }
}

const block = document.querySelector('.nl-html-block')
const img = block.querySelector('img')
const click = (el) => el.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true, cancelable: true, view: dom.window }))
const viewer = () => document.querySelector('.nl-imgv')

check('前置：块渲染成表格，块内图已按相对路径装成 data URI', () => {
  assert.ok(block, 'html_block 没渲染')
  assert.ok(img.getAttribute('src').startsWith('data:image/png;base64,'), img.getAttribute('src'))
})

check('单击块内图片：出全屏查看器，块不进源码态', () => {
  click(img)
  const v = viewer()
  assert.ok(v, '查看器没挂载')
  assert.strictEqual(v.classList.contains('hidden'), false, '查看器没打开')
  assert.strictEqual(v.querySelector('.nl-imgv-img').getAttribute('src'), img.getAttribute('src'), '用现成 data URI')
  assert.strictEqual(v.querySelector('.nl-imgv-title').textContent, '浅色主题', '标题优先 alt')
  assert.strictEqual(block.querySelector('textarea'), null, '不该切成源码')
  assert.ok(block.querySelector('table'), '块仍是渲染态')
})

check('关掉查看器后回到文档，块依旧渲染态', () => {
  closeImage()
  assert.strictEqual(viewer().classList.contains('hidden'), true)
  assert.strictEqual(block.querySelector('textarea'), null)
})

check('单击块内非图片落点（格内文字）：照旧就地改源码，Esc 退回', () => {
  click(block.querySelectorAll('td')[1])
  const ta = block.querySelector('textarea.nl-html-src')
  assert.ok(ta, '没进源码态')
  assert.ok(ta.value.includes('<table align="center">'), ta.value.slice(0, 40))
  ta.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  assert.strictEqual(block.querySelector('textarea'), null, 'Esc 要退回渲染态')
})

check('块外普通段落单击不弹出查看器', () => {
  click(document.querySelector('.ProseMirror > p'))
  assert.strictEqual(viewer().classList.contains('hidden'), true)
})

console.log(`\n结果：${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
