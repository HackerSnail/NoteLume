// html-block.test.mjs —— HTML 块透传 P0：两阶段解析 + 序列化幂等（模型层）
// 运行：cd src && node tests/html-block.test.mjs
//
// 夹具全部手写，不用仓库外的真实文章。
// html_block 的表格特例还原要用 DOMParser.parseSlice（需真实 DOM），故本文件用 jsdom 引导全局。

import assert from 'node:assert'
import { JSDOM } from 'jsdom'
const dom = new JSDOM('<!doctype html><html><body></body></html>')
global.window = dom.window
global.document = dom.window.document
global.DOMParser = dom.window.DOMParser
global.Node = dom.window.Node
global.Element = dom.window.Element
global.HTMLElement = dom.window.HTMLElement

const { schema, parseMarkdown, serializeMarkdown } = await import('../editor-schema.js')

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

function topBlocks(doc) {
  const out = []
  doc.forEach((n) => out.push(n.type.name))
  return out
}
function htmlBlocks(doc) {
  const out = []
  doc.descendants((n) => {
    if (n.type.name === 'html_block') out.push(n.attrs.source)
  })
  return out
}
function hasNode(doc, name) {
  let hit = false
  doc.descendants((n) => {
    if (n.type.name === name) hit = true
  })
  return hit
}
// 解析 → 序列化 → 再解析 → 再序列化：第二次输出必须与第一次逐字节相同，且块序列不变
function idempotent(md, label) {
  const d1 = parseMarkdown(md)
  const s1 = serializeMarkdown(d1)
  const d2 = parseMarkdown(s1)
  const s2 = serializeMarkdown(d2)
  assert.strictEqual(s2, s1, (label || '') + ' 二次序列化不一致')
  assert.deepStrictEqual(topBlocks(d2), topBlocks(d1), (label || '') + ' 二次解析块序列不一致')
  return { doc: d1, md: s1 }
}

check('标题块 <h2 class=…> 独占成 html_block，源码原样保留', () => {
  const { doc, md } = idempotent('<h2 class="wp-block-heading" id="这是什么">这是什么</h2>', 'h2')
  assert.deepStrictEqual(topBlocks(doc), ['html_block'])
  assert.strictEqual(htmlBlocks(doc)[0], '<h2 class="wp-block-heading" id="这是什么">这是什么</h2>')
  assert.ok(md.includes('id="这是什么"'), 'id 属性不能被吃掉：' + md)
})

check('多行 <p> 含内联标签与实体：整块一块，实体不被二次转义', () => {
  const src = '<p>零依赖。只用 <code>http</code>、<code>fs</code>，\n输出 <code>a &gt; b &amp; c</code>。</p>'
  const { doc } = idempotent(src, '多行 p')
  assert.deepStrictEqual(topBlocks(doc), ['html_block'])
  assert.strictEqual(htmlBlocks(doc)[0], src)
})

check('<pre class="wp-block-code"> 单行块：闭标签前是一整块', () => {
  const src = '<pre class="wp-block-code"><code>node a.cjs\nlsof -ti tcp:43210</code></pre>'
  const { doc } = idempotent(src, 'pre')
  assert.deepStrictEqual(topBlocks(doc), ['html_block'])
})

check('多行 <figure><table>…<figcaption> 走 html_block，不落成可编辑表', () => {
  const src =
    '<figure class="wp-block-table"><table><thead><tr><th>项</th><th>说明</th></tr></thead><tbody>\n' +
    '<tr><td>入口</td><td>不写进 <code>package.json</code></td></tr>\n' +
    '</tbody></table><figcaption class="wp-element-caption">启动参数</figcaption></figure>'
  const { doc } = idempotent(src, 'figure 表')
  assert.deepStrictEqual(topBlocks(doc), ['html_block'])
  assert.ok(!hasNode(doc, 'table'), 'figure 包着的表不该变成 table 节点')
})

check('独占一行的 <table>…</table> 仍还原成真表（既有快路径不回归）', () => {
  const doc = parseMarkdown('<table><tr><td>a</td><td>b</td></tr></table>')
  assert.deepStrictEqual(topBlocks(doc), ['table'])
  assert.strictEqual(htmlBlocks(doc).length, 0)
})

check('围栏代码块里的假标签不成块', () => {
  const md = '```html\n<div class="x">不是块</div>\n<h2>也不是</h2>\n```\n\n正文\n'
  const { doc } = idempotent(md, '围栏')
  assert.deepStrictEqual(topBlocks(doc), ['code_block', 'paragraph'])
  assert.strictEqual(htmlBlocks(doc).length, 0)
})

check('<a id="x"></a> 独占一行仍走 anchor 行内规则，不被整块接管', () => {
  const doc = parseMarkdown('<a id="_Ref52"></a>\n')
  assert.ok(hasNode(doc, 'anchor'), '应产出 anchor 节点')
  assert.strictEqual(htmlBlocks(doc).length, 0, '不该产出 html_block')
})

check('<mark data-color=…> 独占一行仍走 highlight，不被整块接管', () => {
  const doc = parseMarkdown('<mark data-color="red">高亮</mark>\n')
  assert.ok(hasNode(doc, 'paragraph'), '应是段落')
  assert.strictEqual(htmlBlocks(doc).length, 0, '不该产出 html_block')
  let marked = false
  doc.descendants((n) => {
    if (n.isText && n.marks.some((m) => m.type.name === 'highlight')) marked = true
  })
  assert.ok(marked, 'highlight mark 应保留')
})

check('列表项里缩进的 HTML 块不接管（范围边界：只认顶格）', () => {
  const md = '- 项目\n  <p>缩进块</p>\n'
  const doc = parseMarkdown(md)
  assert.strictEqual(htmlBlocks(doc).length, 0, '缩进块不该产出 html_block')
  assert.ok(hasNode(doc, 'bullet_list'))
})

check('未闭合的 <div> 收整块到空行为止', () => {
  const src = '<div class="wrap">\n<span>甲</span>\n<span>乙</span>'
  const { doc } = idempotent(src + '\n\n后一段\n', 'div 未闭合')
  assert.strictEqual(htmlBlocks(doc)[0], src)
})

check('HTML 块打断段落：前段与块分成两块', () => {
  const { doc } = idempotent('前一段文字\n<h3>块标题</h3>\n', '打断')
  assert.deepStrictEqual(topBlocks(doc).slice(0, 2), ['paragraph', 'html_block'])
})

check('混合文档整篇幂等：块数与源码位置对得上', () => {
  const md = [
    '# 大标题',
    '',
    '<h2 class="wp-block-heading" id="a">甲</h2>',
    '',
    '普通段落，带 `行内码` 与 **加粗**。',
    '',
    '<blockquote class="wp-block-quote">',
    '<p>引文一<br>引文二</p>',
    '</blockquote>',
    '',
    '| 列 | 列 |',
    '| --- | --- |',
    '| a | b |',
    '',
    '<figure class="wp-block-image"><img src="/u/x.png" style="width:200px" alt="图" /></figure>',
    '',
    '收尾。',
    '',
  ].join('\n')
  const { doc, md: out } = idempotent(md, '混合')
  assert.deepStrictEqual(
    topBlocks(doc),
    ['heading', 'html_block', 'paragraph', 'html_block', 'table', 'html_block', 'paragraph']
  )
  assert.ok(out.includes('<img src="/u/x.png" style="width:200px" alt="图" />'), 'img 属性要原样：' + out)
  assert.ok(out.includes('<br>'), 'br 不该被补成 <br />：' + out)
})

check('空文档与纯 markdown 文档不受影响', () => {
  assert.strictEqual(topBlocks(parseMarkdown('')).length, 1)
  const doc = parseMarkdown('只有一段\n\n- 甲\n- 乙\n')
  assert.strictEqual(htmlBlocks(doc).length, 0)
  assert.deepStrictEqual(topBlocks(doc), ['paragraph', 'bullet_list'])
})

check('html_block 是 atom：无内容子节点、可落在 doc 顶层', () => {
  const t = schema.nodes.html_block
  assert.ok(t.spec.atom, '应为 atom')
  assert.strictEqual(t.contentMatch.defaultType, null)
  const n = t.create({ source: '<p>x</p>' })
  assert.strictEqual(n.childCount, 0)
  schema.topNodeType.create(null, [schema.node('paragraph'), n, schema.node('paragraph')])
})

console.log(`\n结果：${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
