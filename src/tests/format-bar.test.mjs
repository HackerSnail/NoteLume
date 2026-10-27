// format-bar.test.mjs —— 内联格式按钮条的 jsdom 冒烟（六颗按钮 / 显隐 / 按下态 / 派发）
// 运行：cd src && node tests/format-bar.test.mjs

import assert from 'node:assert'
import { JSDOM } from 'jsdom'

const dom = new JSDOM('<!doctype html><html><body><div class="nl-pane" id="leaf"></div></body></html>')
globalThis.window = dom.window
globalThis.document = dom.window.document

const { createFormatBar } = await import('../format-bar.js')
const { t: tr } = await import('../i18n.js')

let pass = 0
let fail = 0
function t(name, fn) {
  try {
    fn()
    pass++
    console.log('  ok   ' + name)
  } catch (e) {
    fail++
    console.log('  FAIL ' + name + ' —— ' + ((e && e.message) || e))
  }
}

function mount() {
  const leaf = document.getElementById('leaf')
  leaf.textContent = ''
  const strip = document.createElement('div')
  strip.className = 'nl-pane-strip'
  const body = document.createElement('div')
  body.className = 'nl-pane-body'
  leaf.append(strip, body)
  const calls = []
  const bar = createFormatBar({
    paneEl: leaf,
    runCommand: (cmd) => calls.push(['cmd', cmd]),
    pickImages: () => calls.push(['images']),
    bindingFor: (id) => (id === 'editor.bold' ? 'Ctrl+B' : null),
  })
  return { leaf, strip, body, bar, calls }
}

t('六颗按钮按粗体→图片的顺序排在标签条之后', () => {
  const { leaf, strip, bar } = mount()
  assert.strictEqual(bar.el.children.length, 6)
  assert.strictEqual(strip.nextSibling, bar.el)
  assert.strictEqual(bar.el.nextElementSibling, leaf.querySelector('.nl-pane-body'))
  assert.deepStrictEqual(
    [...bar.el.children].map((b) => b.className.includes('glyph') ? b.textContent : b.querySelector('use').getAttribute('href')),
    ['B', 'I', 'S', '#i-code', '#i-link', '#i-image'],
  )
})

t('无标签条时挂在窗格最前', () => {
  const leaf = document.getElementById('leaf')
  leaf.textContent = ''
  const bar = createFormatBar({ paneEl: leaf, runCommand() {}, pickImages() {} })
  assert.strictEqual(leaf.firstChild, bar.el)
})

t('初始隐藏，sync(visible) 才出', () => {
  const { bar } = mount()
  assert.ok(bar.el.classList.contains('hidden'))
  bar.sync(new Set(), true)
  assert.ok(!bar.el.classList.contains('hidden'))
  bar.sync(new Set(), false)
  assert.ok(bar.el.classList.contains('hidden'))
})

t('按下态按 mark 集合逐颗切，未命中的不带 active', () => {
  const { bar } = mount()
  bar.sync(new Set(['strong', 'link']), true)
  const on = [...bar.el.children].filter((b) => b.classList.contains('active')).map((b) => b.dataset.mark)
  assert.deepStrictEqual(on, ['strong', 'link'])
  bar.sync(new Set(['em']), true)
  assert.deepStrictEqual(
    [...bar.el.children].filter((b) => b.classList.contains('active')).map((b) => b.dataset.mark),
    ['em'],
  )
})

t('标题用当前语言文案，有键位时带括号，无键位只剩文案', () => {
  const { bar } = mount()
  bar.sync(new Set(), true)
  const [bold, italic] = bar.el.children
  assert.strictEqual(bold.title, `${tr('cmd.editor.bold')} (Ctrl+B)`)
  assert.strictEqual(italic.title, tr('cmd.editor.italic'))
})

t('前五颗转对应编辑器命令，图片走选图入口', () => {
  const { bar, calls } = mount()
  bar.sync(new Set(), true)
  for (const b of bar.el.children) b.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  assert.deepStrictEqual(calls, [
    ['cmd', 'editor.bold'],
    ['cmd', 'editor.italic'],
    ['cmd', 'editor.strike'],
    ['cmd', 'editor.code'],
    ['cmd', 'editor.link'],
    ['images'],
  ])
})

t('mousedown 被吃掉：点按钮不打断编辑器选区', () => {
  const { bar } = mount()
  const ev = new window.MouseEvent('mousedown', { bubbles: true, cancelable: true })
  bar.el.children[0].dispatchEvent(ev)
  assert.ok(ev.defaultPrevented)
})

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
