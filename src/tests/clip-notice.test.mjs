// clip-notice.test.mjs —— 剪藏结果确认条（extension/content/notice.js）回归
// 运行：cd src && node tests/clip-notice.test.mjs
// jsdom 里 eval 真文件，断言挂载位置、类名切换、空正文不渲染、计时收起与 HTML 转义。
import assert from 'node:assert'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { JSDOM } from 'jsdom'

const here = path.dirname(fileURLToPath(import.meta.url))
const noticeSrc = fs.readFileSync(
  path.resolve(here, '../../extension/content/notice.js'),
  'utf8'
)

let pass = 0
let fail = 0
function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      pass++
      console.log('  ok   ' + name)
    })
    .catch((e) => {
      fail++
      console.log('  FAIL ' + name + ' —— ' + ((e && e.message) || e))
    })
}

// 每个用例一个新文档：notice.js 里有模块级计时器与节点，跨用例串状态会假绿
function boot(html = '<html><body><p>正文</p></body></html>') {
  const dom = new JSDOM(html, {
    url: 'https://example.com/post',
    runScripts: 'outside-only', // 没有它 window.eval 跑的是 Node 作用域，报 window is not defined
  })
  dom.window.eval(noticeSrc)
  return dom.window
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const nodeOf = (w) => w.document.getElementById('nl-clip-notice')
const titleOf = (w) => {
  const n = nodeOf(w)
  return n && n.querySelector('.nl-clip-notice-title')
}
const bodyOf = (w) => {
  const n = nodeOf(w)
  return n && n.querySelector('.nl-clip-notice-body')
}

const cases = []
const t = (name, fn) => cases.push([name, fn])

t('成功提示挂出标题与正文', () => {
  const w = boot()
  assert.strictEqual(w.__NL_NOTICE.show({ title: '已剪藏到 NoteLume', body: 'A → Clippings/A.md', kind: 'ok', ms: 4000 }), true)
  assert.strictEqual(titleOf(w).textContent, '已剪藏到 NoteLume')
  assert.strictEqual(bodyOf(w).textContent, 'A → Clippings/A.md')
  assert.ok(nodeOf(w).classList.contains('nl-clip-notice'), '要挂上基础类')
  assert.ok(w.document.documentElement.contains(nodeOf(w)), '节点在文档里')
})

t('正文为空整块不渲染，只留标题一行', () => {
  const w = boot()
  w.__NL_NOTICE.show({ title: '剪藏失败', body: '', kind: 'bad' })
  assert.strictEqual(bodyOf(w), null, '空正文不能留下空节点')
  assert.strictEqual(titleOf(w).textContent, '剪藏失败')
})

t('同一元素复用：连续两次 show 不出现第二个确认条', () => {
  const w = boot()
  w.__NL_NOTICE.show({ title: '第一条', body: '一', kind: 'ok' })
  w.__NL_NOTICE.show({ title: '第二条', body: '二', kind: 'bad' })
  assert.strictEqual(w.document.querySelectorAll('#nl-clip-notice').length, 1)
  assert.strictEqual(titleOf(w).textContent, '第二条')
  assert.strictEqual(bodyOf(w).textContent, '二')
})

t('后一次 show 补得上正文节点（前一次是空的）', () => {
  const w = boot()
  w.__NL_NOTICE.show({ title: '只有标题', body: '', kind: 'info' })
  assert.strictEqual(bodyOf(w), null)
  w.__NL_NOTICE.show({ title: '换成了带正文的', body: '现在有了', kind: 'bad' })
  assert.strictEqual(bodyOf(w).textContent, '现在有了')
})

t('kind 三类互斥：bad → ok 要把红边类摘干净', () => {
  const w = boot()
  w.__NL_NOTICE.show({ title: '失败', body: '连不上', kind: 'bad' })
  assert.ok(nodeOf(w).classList.contains('nl-clip-bad'))
  assert.ok(!nodeOf(w).classList.contains('nl-clip-info'))
  w.__NL_NOTICE.show({ title: '取消', body: '', kind: 'info' })
  assert.ok(nodeOf(w).classList.contains('nl-clip-info'))
  assert.ok(!nodeOf(w).classList.contains('nl-clip-bad'), 'bad 类残留会一直显示红边')
  w.__NL_NOTICE.show({ title: '成功', body: '', kind: 'ok' })
  assert.ok(!nodeOf(w).classList.contains('nl-clip-bad'))
  assert.ok(!nodeOf(w).classList.contains('nl-clip-info'))
})

t('kind 缺省按成功态（不带 bad / info）', () => {
  const w = boot()
  w.__NL_NOTICE.show({ title: '没传 kind' })
  assert.ok(!nodeOf(w).classList.contains('nl-clip-bad'))
  assert.ok(!nodeOf(w).classList.contains('nl-clip-info'))
})

t('标题带 HTML 也只落文本，不生成元素', () => {
  const w = boot()
  const nasty = '<img src=x onerror=alert(1)>'
  w.__NL_NOTICE.show({ title: nasty, body: nasty, kind: 'bad' })
  assert.strictEqual(titleOf(w).textContent, nasty)
  assert.strictEqual(nodeOf(w).querySelector('img'), null, '不能解析成元素')
  assert.strictEqual(bodyOf(w).textContent, nasty)
})

t('ms 到点先撤 .nl-clip-on 再把节点摘掉', async () => {
  const w = boot()
  w.__NL_NOTICE.show({ title: '很快收', body: '', kind: 'ok', ms: 40 })
  await sleep(90)
  assert.ok(!nodeOf(w).classList.contains('nl-clip-on'), '到点应撤进场类')
  await sleep(260)
  assert.strictEqual(nodeOf(w), null, '过渡后节点要摘干净')
})

t('旧的收起计时不影响新一次 show（重新 show 会续命）', async () => {
  const w = boot()
  w.__NL_NOTICE.show({ title: '第一发', body: '', kind: 'ok', ms: 60 })
  await sleep(30)
  w.__NL_NOTICE.show({ title: '第二发', body: '', kind: 'ok', ms: 60 })
  await sleep(70) // 第一发的计时此刻早已到点
  assert.ok(nodeOf(w), '第二发不能被第一发的计时摘掉')
  await sleep(320)
  assert.strictEqual(nodeOf(w), null, '自己的时长到点后仍要收起')
})

t('重复注入后仍复用同一条，且上一发的收起计时不会抹掉新的', async () => {
  const dom = new JSDOM('<html><body></body></html>', {
    url: 'https://example.com/post',
    runScripts: 'outside-only',
  })
  const w = dom.window
  w.eval(noticeSrc)
  w.__NL_NOTICE.show({ title: '第一发', body: '', kind: 'ok', ms: 60 })
  await sleep(20)
  w.eval(noticeSrc) // background.js 每剪一次就重新执行一遍，模块变量换了新实例
  w.__NL_NOTICE.show({ title: '第二发', body: '', kind: 'ok', ms: 60 })
  await sleep(80) // 此刻第一发的收起计时早已到点
  assert.ok(nodeOf(w), '旧的定时不能把新一条摘掉')
  assert.strictEqual(w.document.querySelectorAll('#nl-clip-notice').length, 1)
  assert.strictEqual(titleOf(w).textContent, '第二发')
})

t('没有 <body> 的文档也挂得上（正文未解析时就注入）', () => {
  const w = boot('<html></html>')
  w.document.body.remove()
  assert.strictEqual(w.document.body, null)
  w.__NL_NOTICE.show({ title: '已剪藏', body: '正文', kind: 'ok' })
  assert.ok(w.document.documentElement.contains(nodeOf(w)), '要挂在 documentElement 上')
  assert.strictEqual(titleOf(w).textContent, '已剪藏')
})

t('show 传空对象不抛错，标题为空串', () => {
  const w = boot()
  assert.strictEqual(w.__NL_NOTICE.show({}), true)
  assert.strictEqual(titleOf(w).textContent, '')
  w.__NL_NOTICE.show()
  assert.strictEqual(titleOf(w).textContent, '')
})

;(async () => {
  for (const [name, fn] of cases) await test(name, fn)
  console.log(`\n${pass} passed, ${fail} failed`)
  if (fail) process.exit(1)
})()
