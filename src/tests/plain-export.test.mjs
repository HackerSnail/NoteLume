// plain-export.test.mjs —— 整库导出标准 GFM：Obsidian 语法降级回归测试
// 运行：cd src && node tests/plain-export.test.mjs
//
// 转换是纯字符串函数，不需要 DOM；模块顶层 import 了 site-export（拖进 editor-schema），
// 所以照 site-export.test.mjs 的口径先备好 jsdom 全局。

import assert from 'node:assert'
import { JSDOM } from 'jsdom'
import { convertPlainMd } from '../plain-export.js'
import { buildWikiLookup } from '../site-export.js'

const jsdom = new JSDOM('<!doctype html><html><body></body></html>')
global.DOMParser = jsdom.window.DOMParser
global.Node = jsdom.window.Node
global.Element = jsdom.window.Element
global.HTMLElement = jsdom.window.HTMLElement

let pass = 0
let fail = 0
function check(name, fn) {
  try {
    fn()
    pass++
    console.log(`ok  ${name}`)
  } catch (e) {
    fail++
    console.error(`FAIL ${name}: ${e.message}`)
  }
}

function ctx(over = {}) {
  return {
    selfRel: 'notes/a.md',
    fromDir: 'notes',
    wikiMap: new Map(),
    docsByRel: new Map(),
    docByBase: new Map(),
    imageSet: new Set(),
    imgByBase: new Map(),
    assets: new Set(),
    ...over,
  }
}

check('callout 首行降级为粗体标题，正文行保持引用块', () => {
  const out = convertPlainMd('> [!note] 记一下\n> 正文第一行\n> 正文第二行', ctx())
  assert.strictEqual(out, '> **记一下**\n> 正文第一行\n> 正文第二行')
})

check('callout 无标题用类型名，折叠标记丢弃', () => {
  assert.strictEqual(convertPlainMd('> [!tip]-', ctx()), '> **Tip**')
  assert.strictEqual(convertPlainMd('> [!warning]+ 注意', ctx()), '> **注意**')
})

check('嵌套引用前缀下的 callout 同样降级', () => {
  assert.strictEqual(convertPlainMd('> > [!info] 里层', ctx()), '> > **里层**')
})

check('图片嵌入按相对路径重写并进 assets，数字别名（宽度语法）丢弃', () => {
  const c = ctx({ imageSet: new Set(['assets/pic.png']), imgByBase: new Map([['pic.png', 'assets/pic.png']]) })
  const out = convertPlainMd('![[pic.png|300]]', c)
  assert.strictEqual(out, '![pic](../assets/pic.png)')
  assert.ok(c.assets.has('assets/pic.png'))
})

check('文档嵌入降级为普通链接', () => {
  const c = ctx({ wikiMap: buildWikiLookup({ wiki: [{ from: 'notes/a.md', target: 'b', to: 'refs/b.md' }] }) })
  assert.strictEqual(convertPlainMd('![[b]]', c), '[b](../refs/b.md)')
})

check('wikilink 带别名落到相对 .md 链接', () => {
  const c = ctx({
    wikiMap: buildWikiLookup({ wiki: [{ from: 'notes/a.md', target: '某篇', to: 'refs/b.md' }] }),
    docsByRel: new Map([['refs/b.md', 'refs/b.md']]),
  })
  const out = convertPlainMd('见[[某篇|自己]]和[[refs/b.md]]', c)
  assert.strictEqual(out, '见[自己](../refs/b.md)和[b](../refs/b.md)')
})

check('未创建的 wikilink 只留别名文字，不产坏链', () => {
  assert.strictEqual(convertPlainMd('待写：[[还不存在]]', ctx()), '待写：还不存在')
})

check('锚点链到文件本身（href 丢锚，锚保留在链接文字里）', () => {
  const c = ctx({ docsByRel: new Map([['b.md', 'b.md']]) })
  const out = convertPlainMd('[[b#第二节]]', c)
  assert.strictEqual(out, '[b > 第二节](../b.md)')
})

check('带空格与括号的图片路径编码后进链接', () => {
  const c = ctx({ imageSet: new Set(['assets/my (1) 图.png']), imgByBase: new Map([['my (1) 图.png', 'assets/my (1) 图.png']]) })
  const out = convertPlainMd('![[my (1) 图.png]]', c)
  // encodeURI 转空格与中文；括号 GFM 链接目标不允许裸写，显式转 %28 %29
  assert.strictEqual(out, '![my (1) 图](../assets/my%20%281%29%20%E5%9B%BE.png)')
})

check('行内代码与围栏代码块里的 wiki 语法不动', () => {
  const src = '正文`[[a]]`与\n```\n![[pic.png]]\n[[x]]\n```\n收尾[[b]]'
  const c = ctx({ docsByRel: new Map([['b.md', 'b.md']]) })
  const out = convertPlainMd(src, c)
  assert.ok(out.includes('`[[a]]`'), out)
  assert.ok(out.includes('![[pic.png]]\n[[x]]'), out)
  assert.ok(out.includes('收尾[b](../b.md)'), out)
})

check('frontmatter 不在本函数处理范围（上层已拆），普通 md 原样通过', () => {
  const src = '# 标题\n\n普通段落，含 [标准链接](https://x.com) 与 `代码`。\n'
  assert.strictEqual(convertPlainMd(src, ctx()), src)
})

check('basename 兜底解析：wiki 表没有时按文件名找', () => {
  const c = ctx({ docByBase: new Map([['b', 'refs/b.md']]) })
  assert.strictEqual(convertPlainMd('[[b]]', c), '[b](../refs/b.md)')
})

console.log(`\n${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
