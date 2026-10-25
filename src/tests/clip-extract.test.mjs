// clip-extract.test.mjs —— 扩展页面提取（extension/content/extract.js）回归
// 运行：cd src && node tests/clip-extract.test.mjs
// 不加载 Defuddle / Readability，只挂 Turndown：走「都提取不出来 → 整页兜底」
// 这条路，夹具本身就是正文，断言尾部签名块与选区分拣。
import assert from 'node:assert'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { JSDOM } from 'jsdom'

const here = path.dirname(fileURLToPath(import.meta.url))
const ext = path.resolve(here, '../../extension')
const extractSrc = fs.readFileSync(path.join(ext, 'content/extract.js'), 'utf8')
const turndownSrc = fs.readFileSync(path.join(ext, 'vendor/turndown.js'), 'utf8')

let pass = 0
let fail = 0
function test(name, fn) {
  try {
    fn()
    pass++
    console.log('  ok   ' + name)
  } catch (e) {
    fail++
    console.log('  FAIL ' + name + ' —— ' + ((e && e.message) || e))
  }
}

// fullPageFallback 默认开：夹具没有语义主标，两个提取器也都没加载
function run(html, { fullPageFallback = true, select = null } = {}) {
  const dom = new JSDOM(html, {
    url: 'https://example.com/post',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  })
  const { window } = dom
  window.__NL_CLIP_OPTS = { fullPageFallback }
  window.eval(turndownSrc)
  if (select) {
    const node = window.document.querySelector(select)
    const range = window.document.createRange()
    range.selectNodeContents(node)
    window.getSelection().removeAllRanges()
    window.getSelection().addRange(range)
  }
  const out = window.eval(extractSrc)
  dom.window.close()
  return out
}

const body = (inner) => `<!doctype html><html><body>${inner}</body></html>`

test('尾部签名块：本文作者 / 本文链接整段切掉', () => {
  const out = run(
    body(`
      <h2>正文章节</h2>
      <p>第一段正文，内容足够长。</p>
      <p>第二段正文，内容足够长。</p>
      <p>第三段正文，内容足够长。</p>
      <div class="post-copyright">
        <span>本文作者: </span><span><a href="https://example.com/">作者甲</a></span>
        <span>本文链接: </span><span><a href="https://example.com/post">https://example.com/post</a></span>
      </div>`)
  )
  assert.strictEqual(out.ok, true, out.reason)
  assert.ok(out.markdown.includes('第三段正文'), out.markdown)
  assert.ok(!out.markdown.includes('本文作者'), out.markdown)
  assert.ok(!out.markdown.includes('本文链接'), out.markdown)
})

test('尾部签名块：文章作者 / 文章链接保留（Butterfly 主题）', () => {
  const out = run(
    body(`
      <h2>正文章节</h2>
      <p>第一段正文，内容足够长。</p>
      <p>第二段正文，内容足够长。</p>
      <p>第三段正文，内容足够长。</p>
      <div class="post-copyright">
        <span>文章作者: </span><span><a href="https://example.com/">作者甲</a></span>
        <span>文章链接: </span><span><a href="https://example.com/post">https://example.com/post</a></span>
      </div>`)
  )
  assert.strictEqual(out.ok, true, out.reason)
  assert.ok(out.markdown.includes('第三段正文'), out.markdown)
  assert.ok(out.markdown.includes('文章作者'), out.markdown)
  assert.ok(out.markdown.includes('文章链接'), out.markdown)
})

test('正文里提到签名词（不在结尾）不动', () => {
  const out = run(
    body(`
      <p>本文作者: 这一句是正文内容，不是页脚。</p>
      <p>后面还有正文第二段。</p>
      <p>后面还有正文第三段。</p>`)
  )
  assert.ok(out.markdown.includes('这一句是正文内容'), out.markdown)
})

test('选区单独成一份，整页 markdown 同时保留', () => {
  const out = run(
    body(`
      <article>
        <p id="pick">要剪的这一句</p>
        <p>同一页的其余正文</p>
      </article>`),
    { select: '#pick' }
  )
  assert.strictEqual(out.ok, true, out.reason)
  assert.ok(out.selectionMarkdown.includes('要剪的这一句'), out.selectionMarkdown)
  assert.ok(out.markdown.includes('同一页的其余正文'), out.markdown)
})

test('没有选区时 selectionMarkdown 为 null', () => {
  const out = run(body('<p>只有正文</p>'))
  assert.strictEqual(out.selectionMarkdown, null)
})

test('整页兜底关着且提取器都没结果 → 报提取失败', () => {
  const out = run(body('<p>只有正文</p>'), { fullPageFallback: false })
  assert.strictEqual(out.ok, false)
  assert.ok(String(out.reason || '').length > 0)
})

console.log(`\n${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
