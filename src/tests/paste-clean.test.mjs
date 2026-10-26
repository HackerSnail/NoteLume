// paste-clean.test.mjs —— 富文本粘贴前的结构清理
// 运行：cd src && node tests/paste-clean.test.mjs
//
// 夹具按真实来源手写：Claude Code 的代码块头部、Prism 行号装订线、空段落串联。

import assert from 'node:assert'
import { JSDOM } from 'jsdom'
const dom = new JSDOM('<!doctype html><html><body></body></html>')
global.window = dom.window
global.document = dom.window.document
global.DOMParser = dom.window.DOMParser
global.Node = dom.window.Node

const { cleanPastedHtml } = await import('../paste-clean.js')

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

check('代码块头部的复制按钮连内容摘掉，pre 正文留下', () => {
  const src =
    '<div class="code-block"><div class="code-block-header"><span class="language-name">python</span>' +
    '<button class="copy-button" aria-label="复制代码">复制</button></div>' +
    '<pre><code>print(1)</code></pre></div>'
  const out = cleanPastedHtml(src)
  assert.ok(!/复制/.test(out), out)
  assert.ok(!/button/.test(out), out)
  assert.ok(out.includes('<pre') && out.includes('print(1)'), out)
})

check('裸 copy 词元才杀，copyright 不误伤', () => {
  const out = cleanPastedHtml('<p class="copyright">© 2026 某公司</p>')
  assert.ok(out.includes('© 2026 某公司'), out)
})

check('aria-label 带复制 / copy 的元素整棵摘掉', () => {
  const out = cleanPastedHtml('<p>前</p><span aria-label="复制代码">复制</span><span data-testid="copy-code">Copy</span>')
  assert.ok(!/复制|Copy/.test(out), out)
  assert.ok(out.includes('前'), out)
})

check('行号装订线摘掉，代码内容保留', () => {
  const src =
    '<pre class="line-numbers"><code><span class="line-numbers-rows"><span></span><span></span></span>' +
    'const a = 1</code></pre>'
  const out = cleanPastedHtml(src)
  assert.ok(!/line-numbers-rows/.test(out), out)
  assert.ok(!/<span/.test(out), out)
  assert.ok(out.includes('const a = 1'), out)
})

check('空段落串联收掉，有字的段落留下', () => {
  const out = cleanPastedHtml('<p>第一段</p><p><br></p><p><br></p><p>第二段</p>')
  assert.ok(out.includes('第一段') && out.includes('第二段'), out)
  assert.strictEqual((out.match(/<p>/g) || []).length, 2, out)
})

check('父级只剩垃圾时整壳跟着走（工具条 div 清空后不留空 div）', () => {
  const src =
    '<div class="code-toolbar"><div class="toolbar"><span class="copy-icon">Copy</span></div></div>' +
    '<pre><code>x = 1</code></pre>'
  const out = cleanPastedHtml(src)
  assert.ok(!/toolbar|Copy/.test(out), out)
  assert.ok(out.includes('x = 1'), out)
})

check('连续 3 个以上的 br 收成 1 个，两个 br 不动', () => {
  const out = cleanPastedHtml('<p>a</p><br><br><br><br><p>b</p>')
  assert.strictEqual((out.match(/<br>/g) || []).length, 1, out)
  const two = cleanPastedHtml('<p>a<br><br>b</p>')
  assert.strictEqual((two.match(/<br>/g) || []).length, 2, two)
})

check('普通排版内容原样通过', () => {
  const src = '<h2>标题</h2><p>正文 <strong>加粗</strong> 与<a href="https://x.com">链接</a></p><ul><li>条目</li></ul>'
  const out = cleanPastedHtml(src)
  assert.ok(out.includes('<h2>标题</h2>') && out.includes('<strong>加粗</strong>') && out.includes('href="https://x.com"'), out)
  assert.ok(out.includes('<li>条目</li>'), out)
})

check('表格空单元格不摘，脚本整块丢弃', () => {
  const out = cleanPastedHtml('<table><tr><td></td><td>有字</td></tr></table><script>alert(1)</script>')
  assert.ok(out.includes('<td></td>') && out.includes('有字'), out)
  assert.ok(!/script/.test(out), out)
})

check('空输入与纯空白原样返回空串', () => {
  assert.strictEqual(cleanPastedHtml(''), '')
  assert.strictEqual(cleanPastedHtml('   '), '')
  assert.strictEqual(cleanPastedHtml(null), '')
})

console.log(`\n${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
