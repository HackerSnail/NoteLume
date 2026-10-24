// html-sanitize.test.mjs —— html_block 渲染前的白名单净化
// 运行：cd src && node tests/html-sanitize.test.mjs
//
// 判定口径：净化只影响渲染串，文档源码不动；夹具全部手写。

import assert from 'node:assert'
import { JSDOM } from 'jsdom'
const dom = new JSDOM('<!doctype html><html><body></body></html>')
global.window = dom.window
global.document = dom.window.document
global.DOMParser = dom.window.DOMParser
global.Node = dom.window.Node
global.Element = dom.window.Element
global.HTMLElement = dom.window.HTMLElement

const { sanitizeHtml, htmlHeadings } = await import('../html-sanitize.js')

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
// 净化结果再进一次 DOM，断言「真的没有这个元素」，而不是只断言字符串里没出现标签名
function nodesOf(html, sel) {
  const d = new JSDOM('<body>' + html + '</body>')
  return d.window.document.querySelectorAll(sel)
}

check('常规排版标签与 class 原样留下', () => {
  const src = '<h2 class="wp-block-heading has-large-font-size" id="这是什么">建站初衷</h2>'
  const out = sanitizeHtml(src)
  assert.ok(out.includes('<h2'), out)
  assert.ok(out.includes('class="wp-block-heading has-large-font-size"'), 'class 不映射但保留：' + out)
  assert.ok(out.includes('id="这是什么"'), out)
})

check('script 整块丢弃（连内容），大小写与换行都挡', () => {
  assert.strictEqual(sanitizeHtml('<script>alert(1)</script>'), '')
  assert.strictEqual(sanitizeHtml('<SCRIPT >window.x=1</SCRIPT >'), '')
  assert.strictEqual(sanitizeHtml('<p>前</p><script\n>alert(1)</\nscript>'), '<p>前</p>')
  assert.strictEqual(nodesOf(sanitizeHtml('<div><script>x()</script></div>'), 'script').length, 0)
})

check('on* 事件属性一律不进渲染串', () => {
  const out = sanitizeHtml('<img src="a.png" onerror="alert(1)"><p onclick="alert(2)" ONMOUSEOVER="x">字</p>')
  assert.ok(!/onerror|onclick|onmouseover/i.test(out), out)
  assert.ok(out.includes('src="a.png"'), out)
  assert.ok(out.includes('字'), out)
})

check('href 只收 http/https/mailto/tel 与相对/锚点', () => {
  assert.ok(sanitizeHtml('<a href="https://x.com/a?b=1">x</a>').includes('href="https://x.com/a?b=1"'))
  assert.ok(sanitizeHtml('<a href="/2024/07/19/my/">x</a>').includes('href="/2024/07/19/my/"'))
  assert.ok(sanitizeHtml('<a href="#sec">x</a>').includes('href="#sec"'))
  assert.ok(sanitizeHtml('<a href="mailto:a@b.c">x</a>').includes('href="mailto:a@b.c"'))
  for (const bad of ['javascript:alert(1)', 'JaVaScRiPt:alert(1)', 'data:text/html,<script>1</script>', 'vbscript:x', '//evil.com/a']) {
    const out = sanitizeHtml('<a href="' + bad + '">字</a>')
    assert.ok(!out.includes('href'), bad + ' 不该留 href：' + out)
    assert.ok(out.includes('字'), bad + ' 文字要留下：' + out)
  }
})

check('img 的 src 收 http/相对/data:image，拒 data:text/html 与协议相对', () => {
  assert.ok(sanitizeHtml('<img src="/uploads/2024/09/a.jpg">').includes('src="/uploads/2024/09/a.jpg"'))
  assert.ok(sanitizeHtml('<img src="https://x.com/a.png">').includes('src="https://x.com/a.png"'))
  assert.ok(sanitizeHtml('<img src="data:image/png;base64,AA">').includes('src="data:image/png;base64,AA"'))
  assert.ok(!sanitizeHtml('<img src="data:text/html,<script>1</script>">').includes('src='))
  assert.ok(!sanitizeHtml('<img src="//evil.com/a.png">').includes('src='))
})

check('style 只留白名单属性，url()/expression 一律拒', () => {
  assert.strictEqual(sanitizeHtml('<p style="TEXT-ALIGN: center ; color:#fff">x</p>'), '<p style="text-align:center;color:#fff">x</p>')
  assert.strictEqual(sanitizeHtml('<p style="text-align:center">x</p>').includes('text-align:center'), true)
  assert.ok(!sanitizeHtml('<div style="position:fixed;top:0;left:0;width:100%;height:100%">x</div>').includes('position'))
  assert.ok(!sanitizeHtml('<div style="background:url(javascript:alert(1))">x</div>').includes('background'))
  assert.ok(!sanitizeHtml('<p style="width:expression(alert(1))">x</p>').includes('width'))
  assert.strictEqual(sanitizeHtml('<p style="">x</p>'), '<p>x</p>')
})

check('会引外部文档或可交互的标签整块丢，不脱壳留内容', () => {
  for (const src of [
    '<iframe src="https://x"></iframe>',
    '<object data="x"></object>',
    '<embed src="x">',
    '<link rel="stylesheet" href="x.css">',
    '<meta http-equiv="refresh" content="0;url=x">',
    '<form action="/x"><button>提交</button></form>',
    '<style>body{display:none}</style>',
    '<svg><circle/></svg>',
  ]) {
    assert.strictEqual(sanitizeHtml(src), '', '应整块丢：' + src)
  }
})

check('未知标签脱壳留文字，注释不进渲染', () => {
  assert.strictEqual(sanitizeHtml('<small>小字</small>'), '小字')
  assert.strictEqual(sanitizeHtml('<p>a<!-- 注释 -->b</p>'), '<p>ab</p>')
  assert.strictEqual(sanitizeHtml('<font face="x" color="red">字</font>'), '字')
})

check('表格结构、colspan/rowspan 与单元格内联标签保留', () => {
  const out = sanitizeHtml(
    '<figure class="wp-block-table"><table><thead><tr><th colspan="2">项</th></tr></thead>' +
      '<tbody><tr><td rowspan="2">a</td><td><code>b</code></td></tr></tbody></table>' +
      '<figcaption>启动参数</figcaption></figure>'
  )
  const d = new JSDOM('<body>' + out + '</body>')
  assert.strictEqual(d.window.document.querySelectorAll('table').length, 1)
  assert.strictEqual(d.window.document.querySelector('th').getAttribute('colspan'), '2')
  assert.strictEqual(d.window.document.querySelector('td').getAttribute('rowspan'), '2')
  assert.strictEqual(d.window.document.querySelectorAll('figcaption').length, 1)
})

check('文本里的尖括号与 & 转义后不产生新元素', () => {
  const out = sanitizeHtml('<p>a &lt; b &amp; c</p>')
  assert.strictEqual(nodesOf(out, 'b').length, 0, out)
  assert.ok(out.includes('&lt;') && out.includes('&amp;'), out)
  // 源码里裸写的 a<b 被解析器当标签起始，净化后不能凭空多出 <b>
  assert.strictEqual(nodesOf(sanitizeHtml('<p>a<b</p>'), 'b').length, 0)
})

check('mXSS 探针：嵌套写法不产出脚本或事件属性', () => {
  const probes = [
    '<noscript><p><style>x</style></p></noscript>',
    '<p><svg><style><a id="</style><img src=1 onerror=alert(1)>">',
    '<listing><img src=1 onerror=alert(1)></listing>',
    '<xmp><script>alert(1)</script></xmp>',
    '<textarea><img src=1 onerror=alert(1)></textarea>',
    '<title><img src=1 onerror=alert(1)></title>',
  ]
  for (const p of probes) {
    const out = sanitizeHtml(p)
    assert.ok(!/<script|<style|<svg/i.test(out), p + ' → 不该出现这些标签：' + out)
    const d = new JSDOM('<body>' + out + '</body>')
    const doc = d.window.document
    assert.strictEqual(doc.body.querySelectorAll('script,style,svg,foreignObject').length, 0, p + ' → ' + out)
    for (const el of doc.body.querySelectorAll('*'))
      for (const a of el.attributes) assert.ok(!/^on/i.test(a.name), p + ' → 残留事件属性 ' + a.name + '：' + out)
  }
})

check('空输入与纯空白返回空串', () => {
  assert.strictEqual(sanitizeHtml(''), '')
  assert.strictEqual(sanitizeHtml('   \n '), '')
  assert.strictEqual(sanitizeHtml(null), '')
  assert.strictEqual(sanitizeHtml('纯文字没有标签'), '纯文字没有标签')
})

check('ol 的 type 只收编号样式，其余 type 属性丢掉', () => {
  assert.ok(sanitizeHtml('<ol type="a"><li>x</li></ol>').includes('type="a"'))
  assert.ok(!sanitizeHtml('<p type="submit">x</p>').includes('type='))
})

check('大纲穿透：按文档序给出 level / text / 字面 id', () => {
  const src = '<h2 id="b">二级</h2>\n<p>正文</p>\n<h1>一级</h1>\n<H4 class="x">四级</H4>'
  assert.deepStrictEqual(htmlHeadings(src), [
    { level: 2, text: '二级', id: 'b' },
    { level: 1, text: '一级', id: '' },
    { level: 4, text: '四级', id: '' },
  ])
})

check('标题文本压平内联标记与换行、还原实体', () => {
  const list = htmlHeadings('<h2>建站 <strong>初衷</strong>\n与&nbsp;经过</h2>')
  assert.strictEqual(list.length, 1)
  assert.strictEqual(list[0].text, '建站 初衷 与 经过')
})

check('无标题 / 空文本标题不进大纲', () => {
  assert.deepStrictEqual(htmlHeadings('<p>x</p>'), [])
  assert.deepStrictEqual(htmlHeadings(''), [])
  assert.deepStrictEqual(htmlHeadings(null), [])
  assert.deepStrictEqual(htmlHeadings('<h2>   </h2><h3>有</h3>'), [{ level: 3, text: '有', id: '' }])
})

console.log(`\n结果：${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
