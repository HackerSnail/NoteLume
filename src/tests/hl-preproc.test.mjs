// hl-preproc.test.mjs —— 代码块高亮的预处理指令中间态不过早上色（对齐 Typora）
// 运行：cd src && node tests/hl-preproc.test.mjs
//
// 背景：hljs 的 C 系 PREPROCESSOR 规则「# 后跟一个字母」即匹配，敲 #i / #inc 也整段
// 染 meta 色；Typora（lezer）要完整指令名才变色。hl-decorations.js 借 hljs 自己的
// 词表信号（完整指令的指令词单独包 hljs-keyword）丢中间态。这里钉三个面：
// 中间态无色、完整指令原样保留（含 # define 写法）、其它语言的 meta 不误伤。

import assert from 'node:assert'
import { JSDOM } from 'jsdom'
const dom = new JSDOM('<!doctype html><html><body></body></html>')
global.window = dom.window
global.document = dom.window.document
global.DOMParser = dom.window.DOMParser
global.Node = dom.window.Node
global.Element = dom.window.Element
global.HTMLElement = dom.window.HTMLElement

const { parseMarkdown } = await import('../editor-schema.js')
const { buildDecorations, dropPartialPreprocessor } = await import('../hl-decorations.js')

let pass = 0
let fail = 0
function check(name, fn) {
  try {
    fn()
    console.log(`✅ ${name}`)
    pass++
  } catch (e) {
    console.error(`❌ ${name}: ${e.message}`)
    fail++
  }
}

// 取 md 里第一个 code_block 的装饰，坐标归一成块内字符下标：[[start, end, class], ...]
const decosOf = (md) => {
  const doc = parseMarkdown(md)
  const set = buildDecorations(doc)
  let start = -1
  let size = -1
  doc.descendants((n, p) => {
    if (start < 0 && n.type.name === 'code_block') { start = p + 1; size = n.content.size }
  })
  assert.ok(start >= 0, '夹具里没有 code_block')
  return [...set.find(start, start + size)].map((d) => [d.from - start, d.to - start, d.type.attrs.class])
}
const has = (decos, cls, from, to) => decos.some(([s, e, c]) => c === cls && s === from && e === to)
const anyCls = (decos, cls) => decos.some(([, , c]) => c === cls)

// —— 中间态：不上色 ——
check('# 单独：无装饰（hljs 本来就不匹配，钉住不回归）', () => {
  const d = decosOf('```cpp\n#\n```')
  assert.equal(d.length, 0, JSON.stringify(d))
})
check('#i / #in / #inc：无 meta 装饰（修复点）', () => {
  for (const mid of ['#i', '#in', '#inc', '#incLude']) {
    const d = decosOf('```cpp\n' + mid + '\n```')
    assert.ok(!anyCls(d, 'hljs-meta'), `${mid} 仍被染 meta: ${JSON.stringify(d)}`)
  }
})
check('多行里行尾的 #inc：无 meta，其余行装饰照旧', () => {
  const d = decosOf('```cpp\nlet a = 1\n#inc\n```')
  assert.ok(!anyCls(d, 'hljs-meta'), JSON.stringify(d))
  assert.ok(has(d, 'hljs-number', 8, 9), 'number 装饰应在: ' + JSON.stringify(d))
})

// —— 完整指令：原样保留 ——
check('#include：meta(整段) + keyword(include) 都在', () => {
  const d = decosOf('```cpp\n#include\n```')
  assert.ok(has(d, 'hljs-meta', 0, 8), JSON.stringify(d))
  assert.ok(has(d, 'hljs-keyword', 1, 8), JSON.stringify(d))
})
check('#include <iostream>：meta / keyword / string 齐全', () => {
  const d = decosOf('```cpp\n#include <iostream>\n```')
  assert.ok(has(d, 'hljs-meta', 0, 19), JSON.stringify(d))
  assert.ok(has(d, 'hljs-keyword', 1, 8), JSON.stringify(d))
  assert.ok(has(d, 'hljs-string', 9, 19), JSON.stringify(d))
})
check('# define X（# 后有空格）：meta 保留', () => {
  const d = decosOf('```cpp\n# define X\n```')
  assert.ok(has(d, 'hljs-meta', 0, 10), JSON.stringify(d))
  assert.ok(has(d, 'hljs-keyword', 2, 8), JSON.stringify(d))
})
check('#pragma once：保留', () => {
  const d = decosOf('```cpp\n#pragma once\n```')
  assert.ok(has(d, 'hljs-meta', 0, 12), JSON.stringify(d))
  assert.ok(has(d, 'hljs-keyword', 1, 7), JSON.stringify(d))
})

// —— 其它形态的 meta 不误伤 ——
check('yaml 的 ---（meta 但不是 # 形态）：保留', () => {
  const d = decosOf('```yaml\n---\nkey: 1\n```')
  assert.ok(anyCls(d, 'hljs-meta'), JSON.stringify(d))
})
check('纯函数：形态守卫（非 # 开头 / 含 keyword 子区间 都保留）', () => {
  assert.deepEqual(dropPartialPreprocessor('---', [[0, 3, 'hljs-meta']]), [[0, 3, 'hljs-meta']])
  assert.deepEqual(dropPartialPreprocessor('#inc', [[0, 4, 'hljs-meta']]), [])
  assert.deepEqual(
    dropPartialPreprocessor('#include', [[0, 8, 'hljs-meta'], [1, 8, 'hljs-keyword']]),
    [[0, 8, 'hljs-meta'], [1, 8, 'hljs-keyword']],
  )
  // keyword 不完全在 meta 区间内时，meta 丢、keyword 原样留（区间错位不当真）
  const shifted = dropPartialPreprocessor('#inc', [[0, 4, 'hljs-meta'], [4, 6, 'hljs-keyword']])
  assert.ok(!shifted.some(([, , c]) => c === 'hljs-meta'), JSON.stringify(shifted))
  assert.deepEqual(shifted, [[4, 6, 'hljs-keyword']])
})

console.log(`\n结果: ${pass} passed, ${fail} failed`)
if (fail) process.exitCode = 1
