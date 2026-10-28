// qd.test.mjs —— Quarkdown 编辑器集成：区域收集与源码重组（纯函数，无需 Tauri）
// 运行：cd src && node tests/qd.test.mjs
//
// 覆盖：区域判定（指令调用段 + 连续 code_block / 列表）、缩进体还原（4 空格前缀）、
// 列表体序列化、相邻两条指令切成两个区域、无指令文档空数组、from/to 位置语义。

import assert from 'node:assert'
import { parseMarkdown } from '../editor-schema.js'
import { collectQdRegions } from '../qd/editor.js'
import zhCN from '../locales/zh-CN.js'

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

check('列表体归入区域并还原成 4 空格块参数', () => {
  const doc = parseMarkdown('.var {letters}\n\n    - A\n    - B')
  const regions = collectQdRegions(doc)
  assert.strictEqual(regions.length, 1)
  // 缩进列表落成 code_block 还是 bullet_list 取决于解析路径，两条分支都得还原出带 4 空格的
  // `- ` 行：Rust 侧只认缩进体，掉缩进等于把循环体丢成顶层正文。
  assert.strictEqual(regions[0].source, '.var {letters}\n    - A\n    - B')
})

check('顶格列表成员补回块参数缩进', () => {
  const regions = collectQdRegions(parseMarkdown('.foreach {1..3}\n- 条目 .1'))
  assert.strictEqual(regions.length, 1)
  assert.strictEqual(regions[0].source, '.foreach {1..3}\n    - 条目 .1')
})

check('指令行与缩进体之间缺空行会被并成同一段落', () => {
  // 模板曾经写成 `.foreach {1..3}\n    - 条目 .1`（中间没空行）。CommonMark 的懒惰续行
  // 把两行并成一个段落，区域源码就成了 `.foreach {1..3} - 条目 .1`，快照里只剩一条不展开的
  // 条目和「未知函数 .1」。这条锁住模板的正确形态。
  const merged = collectQdRegions(parseMarkdown('.foreach {1..3}\n    - 条目 .1'))
  assert.strictEqual(merged[0].source, '.foreach {1..3} - 条目 .1')
  const spaced = collectQdRegions(parseMarkdown('.foreach {1..3}\n\n    - 条目 .1'))
  assert.strictEqual(spaced[0].source, '.foreach {1..3}\n    - 条目 .1')
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

check('内置 Quarkdown 模板的指令行后面不接正文行', () => {
  // CommonMark 的懒惰续行会把「指令行 + 紧随其后的缩进行」并成一个段落，区域源码就成了
  // `.foreach {1..3} - 条目 .1`，快照里只剩一条不展开的条目。模板里每条指令行后面必须留空行。
  for (const key of ['tpl.qd.weekly.body', 'tpl.qd.vars.body', 'tpl.qd.xref.body']) {
    const lines = zhCN[key].split('\n')
    lines.forEach((l, i) => {
      if (!/^\.\w/.test(l) || i === lines.length - 1) return
      assert.strictEqual(lines[i + 1], '', `${key}: 第 ${i + 1} 行指令后面缺空行`)
    })
  }
})

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
