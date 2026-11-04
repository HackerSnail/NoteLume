// gettext-atoms.test.mjs —— editor.getText() 对原子 / 叶节点的代表文字回归（BUG-20261103-001）
// 运行：cd src && node tests/gettext-atoms.test.mjs
//
// getText 同时喂写作统计与 AI 文档上下文（buildDocContext / read_current_doc）。此前
// textBetween 的 leafText 传的是统一占位串 '\n'，把 wikilink 目标与别名、行内/块级公式、
// 图片 alt、#标签 全抹掉，模型看不到这些内容。这里走真 createEditor + jsdom，钉住这些内容仍在。

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
global.IntersectionObserver = class { observe() {} disconnect() {} }
dom.window.ResizeObserver = global.ResizeObserver
dom.window.IntersectionObserver = global.IntersectionObserver
dom.window.matchMedia = dom.window.matchMedia || (() => ({ matches: false, addEventListener() {}, removeEventListener() {} }))
global.matchMedia = dom.window.matchMedia
if (!dom.window.CSS) dom.window.CSS = { escape: (s) => String(s).replace(/["\\]/g, '\\$&') }
global.CSS = dom.window.CSS

const CTX = { vaultRoot: '/库', mdRel: 'note.md' }
window.__TAURI_INTERNALS__ = {
  async invoke(cmd, args) {
    if (cmd === 'read_image_data_uri') return 'data:image/png;base64,' + Buffer.from(String(args.src)).toString('base64')
    throw new Error('unexpected invoke: ' + cmd)
  },
}

const { createEditor } = await import('../editor-view.js')

const MD = [
  '这段指向 [[目标笔记]]，还有带别名的 [[另一个|别名文字]]。',
  '',
  '行内公式 $E=mc^2$ 混在正文里。',
  '',
  '$$',
  '\\int_{0}^{1} x\\,dx',
  '$$',
  '',
  '配图 ![落日照片](./assets/a.png)。',
  '',
  '标签 #随手记 收尾。',
].join('\n')

const mountEl = document.getElementById('root')
const ed = createEditor({ mountEl, getVault: () => CTX, onMetaChange() {}, onDirty() {} })
ed.setMarkdown(MD)
await new Promise((r) => setTimeout(r, 60))

let pass = 0
let fail = 0
function check(name, fn) {
  try {
    fn()
    pass++
    console.log('  ok   ' + name)
  } catch (e) {
    fail++
    console.error('  FAIL ' + name + ' —— ' + ((e && e.message) || e))
  }
}

const txt = ed.getText()

check('getText：wikilink 目标名保留', () => assert.ok(txt.includes('目标笔记'), txt))
check('getText：wikilink 别名保留', () => assert.ok(txt.includes('别名文字'), txt))
check('getText：行内公式 latex 保留', () => assert.ok(txt.includes('E=mc^2'), txt))
check('getText：块级公式 latex 保留', () => assert.ok(txt.includes('x\\,dx'), txt))
check('getText：图片 alt 保留', () => assert.ok(txt.includes('落日照片'), txt))
check('getText：#标签保留', () => assert.ok(txt.includes('#随手记'), txt))
check('getText：不把标记语法本身漏进文本', () => {
  assert.ok(!txt.includes('[['), '不应有 [[')
  assert.ok(!txt.includes('!['), '不应有 ![')
  assert.ok(!txt.includes('$'), '不应有裸 $')
})

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
