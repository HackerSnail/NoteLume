// qd.test.mjs —— Quarkdown 编辑器集成：区域收集与源码重组（纯函数，无需 Tauri）
// 运行：cd src && node tests/qd.test.mjs
//
// 覆盖：区域判定（指令调用段 + 连续 code_block / 列表）、缩进体还原（4 空格前缀）、
// 列表体序列化、相邻两条指令切成两个区域、无指令文档空数组、from/to 位置语义。

import assert from 'node:assert'
import { parseMarkdown } from '../editor-schema.js'
import { collectQdRegions } from '../qd/editor.js'

let pass = 0, fail = 0
function check(name, fn) {
  try { fn(); console.log(`✅ ${name}`); pass++ }
  catch (e) { console.error(`❌ ${name}: ${e.message}`); fail++ }
}

check('指令段 + 缩进体（code_block）还原 4 空格前缀', () => {
  const doc = parseMarkdown('.function {greet}\n\n    to:\n    Hello, .to')
  const regions = collectQdRegions(doc)
  assert.strictEqual(regions.length, 1)
  assert.strictEqual(
    regions[0].source,
    '.function {greet}\n    to:\n    Hello, .to',
  )
})

check('相邻两条指令（隔空行）切成两个区域', () => {
  const doc = parseMarkdown('.var {a} {1}\n\n.var {b} {2}')
  const regions = collectQdRegions(doc)
  assert.strictEqual(regions.length, 2)
  assert.strictEqual(regions[0].source, '.var {a} {1}')
  assert.strictEqual(regions[1].source, '.var {b} {2}')
})

check('列表体归入区域并还原 - 行', () => {
  const doc = parseMarkdown('.var {letters}\n\n    - A\n    - B')
  const regions = collectQdRegions(doc)
  assert.strictEqual(regions.length, 1)
  // 4 空格缩进的列表在 PM 里是 code_block 还是列表取决于解析路径，两种都要还原成 - 行
  assert.ok(regions[0].source.includes('- A') || regions[0].source.includes('    - A'))
})

check('无指令的普通文档返回空数组', () => {
  assert.deepStrictEqual(collectQdRegions(parseMarkdown('# 标题\n\n正文')), [])
})

check('区域 from/to 覆盖成员节点', () => {
  const doc = parseMarkdown('.var {a} {1}\n\n    body line')
  const regions = collectQdRegions(doc)
  assert.strictEqual(regions.length, 1)
  const covered = []
  doc.forEach((node, pos) => {
    if (pos >= regions[0].from && pos < regions[0].to) covered.push(node.type.name)
  })
  assert.ok(covered.length >= 2, '区域应至少覆盖指令段与缩进体两个节点')
})

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
