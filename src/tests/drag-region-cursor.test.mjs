// drag-region-cursor.test.mjs —— 标题栏拖拽区显示箭头光标，不是 I 型输入光标
// 运行：cd src && node tests/drag-region-cursor.test.mjs
//
// .appbar-lead 上的应用名是可选文本，浏览器默认在上面画 I 型光标；它是窗口拖拽区，
// 不是输入框。CSS 钉死 cursor:default + user-select:none，中部 spacer 同口径。

import assert from 'node:assert'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { JSDOM } from 'jsdom'

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const cssText = fs.readFileSync(path.join(SRC, 'style.css'), 'utf8')
const html = fs.readFileSync(path.join(SRC, 'index.html'), 'utf8')

const dom = new JSDOM(`<!doctype html><html><head><style id="app"></style></head><body></body></html>`)
dom.window.document.getElementById('app').textContent = cssText
const sheet = [...dom.window.document.styleSheets][0]

function cssOf(selector) {
  for (const r of sheet.cssRules) {
    if (r.selectorText && r.selectorText.split(',').map((s) => s.trim()).includes(selector)) return r.style.cssText
  }
  return ''
}

// 1. 应用名拖拽区：箭头光标 + 禁选
{
  const css = cssOf('.appbar-lead')
  assert.match(css, /cursor:\s*default/, '.appbar-lead 缺 cursor:default')
  assert.match(css, /user-select:\s*none/, '.appbar-lead 缺 user-select:none')
  console.log('ok 应用名拖拽区光标与禁选')
}

// 1b. 左右留白相等：.toolbar 左 12px，右侧 = padding-right 10 + gap 8 = 18px，
//     所以这里必须补 padding-left 6px，两侧才都是 18px。
{
  const css = cssOf('.appbar-lead')
  assert.match(css, /padding-left:\s*6px/, '.appbar-lead 缺 padding-left:6px（左右留白会差 6px）')
  assert.match(css, /padding-right:\s*10px/, '.appbar-lead 的 padding-right 变了，6px 补偿不再成立')
  const toolbar = cssOf('.toolbar')
  assert.match(toolbar, /gap:\s*8px/, '.toolbar 的 gap 变了，18px 的计算不再成立')
  assert.match(toolbar, /padding:\s*8px 12px/, '.toolbar 的左 padding 变了，18px 的计算不再成立')
  console.log('ok 应用名左右留白算齐')
}

// 2. 中部空白拖拽区同样不显示输入光标
{
  assert.match(cssOf('.toolbar \.spacer'), /cursor:\s*default/)
  console.log('ok 中部拖拽区光标')
}

// 3. 两个区域确实是 Tauri 拖拽区（改选择器时别断线）
{
  assert.match(html, /class="appbar-lead"[^>]*data-tauri-drag-region/)
  assert.match(html, /class="spacer" data-tauri-drag-region/)
  console.log('ok 拖拽区标记')
}
