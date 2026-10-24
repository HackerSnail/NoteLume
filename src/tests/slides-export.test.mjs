// slides-export.test.mjs —— 幻灯片导出：切片规则与产物结构（无需浏览器 / Tauri）
// 运行：cd src && node tests/slides-export.test.mjs
//
// 覆盖 spec（2026-10-25-slides-export-design.md）§三切片规则与 §七测试计划：
//  --- 优先 / ## 兜底 / 引言首页 / fence 与引用内不切 / ::: notes 摘取 / 产物自包含。

import assert from 'node:assert'
import { splitSlides } from '../slides-export.js'

let pass = 0, fail = 0
function check(name, fn) {
  try { fn(); console.log(`✅ ${name}`); pass++ }
  catch (e) { console.error(`❌ ${name}: ${e.message}`); fail++ }
}

// —— 切片：hr 模式（--- 优先，*** 不切）——
check('有 --- 时按 --- 切片，*** 当普通水平线', () => {
  const r = splitSlides('# T\n\nA\n\n---\n\nB\n\n***\n\nC')
  assert.strictEqual(r.slides.length, 2)
  assert.ok(r.slides[1].body.includes('***'))
})

// —— 切片：h2 模式（无 --- 时按 ## 切，### 不切）——
check('无 --- 时按 ## 切片，### 不切', () => {
  const r = splitSlides('intro\n\n## One\n\nx\n\n### Sub\n\ny\n\n## Two\n\nz')
  assert.strictEqual(r.slides.length, 3)
  assert.ok(r.slides[0].body.includes('intro'))
  assert.ok(r.slides[1].body.startsWith('## One'))
  assert.ok(r.slides[1].body.includes('### Sub'))
})

// —— fence / 引用内的 --- 与 ## 不触发切片 ——
check('fence 与引用内的 --- / ## 不触发切片', () => {
  const r = splitSlides('```md\n## not a slide\n---\n```\n\n> ## quote\n> ---\n\n## Real')
  assert.strictEqual(r.slides.length, 2)
  assert.ok(r.slides[0].body.includes('## not a slide'))
})

// —— ::: notes 摘取：进 notes、离开正文；未闭合时吃到片尾 ——
check('::: notes 摘出且未闭合时吃到片尾', () => {
  const r = splitSlides('## S\n\n正文\n\n::: notes\n讲稿A\n:::\n\n后面\n\n---\n\n## T\n\n::: notes\n讲稿B')
  assert.ok(r.slides[0].body.includes('后面'))
  assert.ok(!r.slides[0].body.includes('讲稿A'))
  assert.strictEqual(r.slides[0].notes, '讲稿A')
  assert.strictEqual(r.slides[1].notes, '讲稿B')
  assert.ok(!r.slides[1].body.includes(':::'))
})

// —— fence 里的 ::: notes 是代码，不是备注 ——
check('fence 内的 ::: notes 不当备注摘取', () => {
  const r = splitSlides('## S\n\n```\n::: notes\nfake\n:::\n```\n\n正文')
  assert.strictEqual(r.notes || r.slides[0].notes, '')
  assert.ok(r.slides[0].body.includes('::: notes'))
})

// —— title 取首个一级标题 ——
check('title 取首个 # 标题', () => {
  assert.strictEqual(splitSlides('# T\n\nx').title, 'T')
  assert.strictEqual(splitSlides('x\n\n# T2').title, 'T2')
  assert.strictEqual(splitSlides('## 无一级标题').title, '')
})

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
