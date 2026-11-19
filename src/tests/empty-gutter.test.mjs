// empty-gutter.test.mjs —— 空窗格不显示行号装订线
// 运行：cd src && node tests/empty-gutter.test.mjs
//
// WYSIWYG 行号插件把 PM 的空段落算作第 1 行，源码态 CM 也自带行号槽；
// showPaneEmpty 给 .nl-pane-body 挂 nl-no-doc，CSS 把两种装订线一起藏掉。

import assert from 'node:assert'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { JSDOM } from 'jsdom'

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const cssText = fs.readFileSync(path.join(SRC, 'style.css'), 'utf8')
const mainText = fs.readFileSync(path.join(SRC, 'main.js'), 'utf8')

const dom = new JSDOM(`<!doctype html><html><head><style id="app"></style></head><body></body></html>`)
dom.window.document.getElementById('app').textContent = cssText
const sheet = [...dom.window.document.styleSheets][0]

function ruleOf(selector) {
  for (const r of sheet.cssRules) {
    if (r.selectorText && r.selectorText.split(',').map((s) => s.trim()).includes(selector)) return r.style.cssText
  }
  return ''
}

// 1. 两条装订线都在空态被藏掉
{
  const sel = '.nl-pane-body.nl-no-doc .nl-ln-gutter, .nl-pane-body.nl-no-doc .cm-gutters'
  const css = ruleOf('.nl-pane-body.nl-no-doc .nl-ln-gutter') + ruleOf('.nl-pane-body.nl-no-doc .cm-gutters')
  assert.ok(css, `style.css 里没有空态装订线规则：${sel}`)
  assert.match(css, /display:\s*none\s*!important/, '空态装订线需要 display:none !important')
  console.log('ok CSS 空态藏掉两种行号槽')
}

// 2. showPaneEmpty 真的挂/摘 nl-no-doc
{
  assert.ok(
    /function showPaneEmpty\(paneId, on\)[\s\S]{0,400}body\.classList\.toggle\('nl-no-doc', on\)/.test(mainText),
    'showPaneEmpty 没有按空态开关挂 nl-no-doc',
  )
  console.log('ok showPaneEmpty 挂/摘 nl-no-doc')
}
