// print-toc.test.mjs —— 打印排版增强：锚点 / 目录 / 打印样式 / 选项存取（无需浏览器 / Tauri）
// 运行：cd src && node tests/print-toc.test.mjs
//
// 覆盖 spec（2026-10-25-print-pagedjs-design.md）§六测试计划：
//  H1/H2 补锚点、目录提取、按勾选产出打印样式（标题转义、首个 H1 例外）、
//  nl-print-options 的默认值 / 往返 / 坏数据回落。
// Paged.js 预分页本体依赖真实布局引擎，jsdom 覆盖不了，归真机验收。

import assert from 'node:assert'
import { JSDOM } from 'jsdom'
import { assignHeadingIds, buildTocNodes, printStyles, DEFAULT_PRINT_OPTIONS, loadPrintOptions, savePrintOptions } from '../print-paged.js'

// url 给个 origin，否则 jsdom 的 localStorage 因 opaque origin 不可用
const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' })
global.document = dom.window.document
global.localStorage = dom.window.localStorage

let pass = 0, fail = 0
function check(name, fn) {
  try { fn(); console.log(`✅ ${name}`); pass++ }
  catch (e) { console.error(`❌ ${name}: ${e.message}`); fail++ }
}

// —— 锚点：补 id、不覆盖已有、H3 不参与、返回数量 ——
check('assignHeadingIds 给 H1/H2 补 id，已有 id 不覆盖，H3 不管', () => {
  const el = document.createElement('div')
  el.innerHTML = '<h1>一</h1><h2 id="keep">二</h2><h3>三</h3><h2>二</h2>'
  const n = assignHeadingIds(el)
  assert.strictEqual(n, 2)
  assert.strictEqual(el.querySelector('h1').id, '一') // anchorSlug('一') === '一'
  assert.strictEqual(el.querySelector('h2#keep').id, 'keep')
  assert.notStrictEqual(el.querySelectorAll('h2')[1].id, '') // 重名走 anchorSlug 的 dedup 后缀
  assert.strictEqual(el.querySelector('h3').id, '')
})

// —— 目录提取：文档序、层级、空标题跳过（契约：先 assignHeadingIds 再 buildTocNodes）——
check('buildTocNodes 按文档序提取 H1/H2，空标题跳过', () => {
  const el = document.createElement('div')
  el.innerHTML = '<h1>A</h1><h3>x</h3><h2><em>B</em></h2><h1></h1>'
  assignHeadingIds(el)
  const nodes = buildTocNodes(el)
  assert.deepStrictEqual(nodes, [
    { level: 1, text: 'A', id: 'a' }, // anchorSlug 转小写
    { level: 2, text: 'B', id: 'b' },
  ])
})

// —— 打印样式：按勾选产出；标题转义；首个 H1 例外 ——
check('printStyles 按勾选产出对应规则', () => {
  const all = printStyles({ toc: true, pageNumbers: true, h1Break: true, cover: true }, 'T')
  assert.ok(all.includes('@bottom-center') && all.includes('counter(page)'))
  assert.ok(all.includes('@top-center') && all.includes('T'))
  assert.ok(all.includes('target-counter'))
  assert.ok(all.includes('break-before: page'))
  assert.ok(all.includes('break-after: page')) // 封面 / 目录落页
  const none = printStyles({ toc: false, pageNumbers: false, h1Break: false, cover: false }, 'T')
  assert.ok(!none.includes('@bottom-center') && !none.includes('target-counter'))
  assert.ok(!none.includes('break-before: page'))
  assert.ok(all.includes('h1:first-child')) // 首个 H1 例外，封面 / 目录后不空出首页
})

check('printStyles 标题含引号反斜杠不产生非法 CSS', () => {
  const css = printStyles({ pageNumbers: true }, 'a"b\\c')
  assert.ok(css.includes('\\"')) // 引号已转义，@top-center 的字符串没被截断
})

// —— 选项存取：默认值、往返、坏数据回落 ——
check('选项存取与坏数据回落', () => {
  localStorage.clear()
  assert.deepStrictEqual(loadPrintOptions(), DEFAULT_PRINT_OPTIONS)
  savePrintOptions({ toc: true, pageNumbers: false, h1Break: true, cover: true })
  assert.deepStrictEqual(loadPrintOptions(), { toc: true, pageNumbers: false, h1Break: true, cover: true })
  localStorage.setItem('nl-print-options', '{bad json')
  assert.deepStrictEqual(loadPrintOptions(), DEFAULT_PRINT_OPTIONS)
  localStorage.setItem('nl-print-options', '{"toc":true}')
  const merged = loadPrintOptions()
  assert.strictEqual(merged.toc, true) // 缺字段按默认补齐
  assert.strictEqual(merged.pageNumbers, DEFAULT_PRINT_OPTIONS.pageNumbers)
})

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
