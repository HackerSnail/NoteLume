// heading-anchor.test.mjs —— 批次 F 后续：标题锚点 slug 跨语言契约（JS 半边）。
// 运行：cd src && node tests/heading-anchor.test.mjs
//
// 读共享 fixture tests/fixtures/heading-slug.json，断言 slugAllInOrder 对每个 case 逐字符命中 expected。
// Rust 侧 assign_anchors 读同一份 fixture 做同样断言——两边必须同时绿，规则漂移即红。

import assert from 'node:assert'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { anchorSlug, slugAllInOrder } from '../heading-anchor.js'

const FIXTURE = JSON.parse(
  readFileSync(fileURLToPath(new URL('./fixtures/heading-slug.json', import.meta.url)), 'utf8')
)

let n = 0
for (const c of FIXTURE.cases) {
  n++
  assert.deepStrictEqual(slugAllInOrder(c.in), c.expected, `case: ${JSON.stringify(c.in)}`)
}
console.log(`heading-anchor: ${n} fixture cases ✓`)

// 额外单函数断言（不依赖 fixture 的补充边界）
assert.strictEqual(anchorSlug('Hello, World!'), 'hello-world')
assert.strictEqual(anchorSlug('!!!'), '')            // 全标点 → 空 slug
assert.strictEqual(anchorSlug('只  有  空  格'), '只-有-空-格') // 连续空白折叠
console.log('heading-anchor: 单函数边界 ✓')
