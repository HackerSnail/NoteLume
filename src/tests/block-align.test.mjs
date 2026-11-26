// block-align.test.mjs —— 图片/表格「整体位置」的落盘往返（含 width / embed 保真）
// 运行：cd src && node tests/block-align.test.mjs
//
// 对齐语法是真 HTML <img align=…> / <table align=…>：其它 Markdown 工具直接渲染，
// 本项目靠 tokenizer 行内规则与 HTML 块预处理无损读回。故这里同时验解析、回写与再次解析。

import assert from 'node:assert'
import { JSDOM } from 'jsdom'

const dom = new JSDOM('<!doctype html><html><body></body></html>')
global.window = dom.window
global.document = dom.window.document
global.DOMParser = dom.window.DOMParser
global.Node = dom.window.Node
global.Element = dom.window.Element
global.HTMLElement = dom.window.HTMLElement

const { parseMarkdown, serializeMarkdown } = await import('../editor-schema.js')
const { renderSite } = await import('../site-export.js')
const { Transform } = await import('prosemirror-transform')

let pass = 0
let fail = 0
function check(name, fn) {
  try {
    fn()
    console.log(`ok   ${name}`)
    pass++
  } catch (e) {
    console.error(`FAIL ${name}: ${e.message}`)
    fail++
  }
}

function find(doc, name) {
  let hit = null
  doc.descendants((node, pos) => {
    if (!hit && node.type.name === name) hit = { node, pos }
  })
  return hit
}
function imgAttrs(doc) {
  const img = find(doc, 'image')
  assert.ok(img, '应解析出 image 节点')
  return img.node.attrs
}

check('图片 align + width + data-embed 同一次落盘，重开三者都在', () => {
  const md = '<img src="a.png" alt="a" align="center" style="width:328px" data-embed="1">'
  const doc = parseMarkdown(md)
  const a = imgAttrs(doc)
  assert.strictEqual(a.align, 'center')
  assert.strictEqual(a.width, 328)
  assert.strictEqual(a.embed, true)

  const out = serializeMarkdown(doc)
  assert.match(out, /align="center"/)
  assert.match(out, /width:328px/)
  assert.match(out, /data-embed="1"/)

  const b = imgAttrs(parseMarkdown(out))
  assert.strictEqual(b.align, 'center')
  assert.strictEqual(b.width, 328)
  assert.strictEqual(b.embed, true)
})

check('恢复默认只清 align，width / embed 仍走原语法往返', () => {
  const doc = parseMarkdown('<img src="a.png" align="right" style="width:328px" data-embed="1">')
  const img = find(doc, 'image')
  const cleared = new Transform(doc).setNodeMarkup(img.pos, undefined, { ...img.node.attrs, align: null }).doc
  const out = serializeMarkdown(cleared)
  assert.ok(!/align=/.test(out), '恢复默认后不应再有 align：' + out)
  assert.match(out, /!\[\[a\.png\|328\]\]/, '嵌入图应回到 ![[...|width]] 语法')

  const a = imgAttrs(parseMarkdown(out))
  assert.strictEqual(a.align, null)
  assert.strictEqual(a.width, 328)
  assert.strictEqual(a.embed, true)
})

check('表格整体 align 与单元格文字 alignment 互不覆盖', () => {
  const md = '<table align="center"><tr><th style="text-align:right">h</th></tr><tr><td>b</td></tr></table>'
  const doc = parseMarkdown(md)
  assert.strictEqual(find(doc, 'table').node.attrs.align, 'center')
  let cellAlign = null
  doc.descendants((n) => { if (n.type.name === 'table_header') cellAlign = n.attrs.alignment })
  assert.strictEqual(cellAlign, 'right', '单元格原有 GFM 对齐不能被表格整体对齐吃掉')

  const out = serializeMarkdown(doc)
  assert.match(out, /^<table align="center">/)
  assert.match(out, /text-align:right/)

  const again = parseMarkdown(out)
  assert.strictEqual(find(again, 'table').node.attrs.align, 'center')
  let cellAgain = null
  again.descendants((n) => { if (n.type.name === 'table_header') cellAgain = n.attrs.alignment })
  assert.strictEqual(cellAgain, 'right')
})

check('未设整体对齐的管道表仍是 GFM，不引入 HTML', () => {
  const md = '| a | b |\n| --- | --- |\n| c | d |\n'
  const out = serializeMarkdown(parseMarkdown(md))
  assert.ok(!out.includes('<table'), '默认表格不应变成 HTML：' + out)
  assert.match(out, /^\|/)
  assert.strictEqual(find(parseMarkdown(out), 'table').node.attrs.align, null)
})

check('合并表 + 表格整体对齐：colspan 与 align 一起幂等', () => {
  const md = '<table align="right"><tr><th colspan="2">ab</th></tr><tr><td>c</td><td>d</td></tr></table>'
  const out = serializeMarkdown(parseMarkdown(md))
  assert.match(out, /<table align="right">/)
  assert.match(out, /colspan="2"/)
  assert.strictEqual(serializeMarkdown(parseMarkdown(out)), out, '再往返须幂等')
  assert.strictEqual(find(parseMarkdown(out), 'table').node.attrs.align, 'right')
})

check('站点导出保留图片与表格的 align（html-sanitize 已放行 align 属性）', () => {
  const imgHtml = renderSite('<img src="a.png" alt="a" align="center">')
  assert.match(imgHtml, /align="center"/, '导出图片应带 align：' + imgHtml)
  const tableHtml = renderSite('<table align="center"><tr><td>a</td></tr></table>')
  assert.match(tableHtml, /align="center"/, '导出表格应带 align：' + tableHtml)
})

console.log(`block-align: ${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
