// find-in-doc.test.mjs —— 文档内查找命中逻辑的回归测试（纯模型，无需浏览器）
// 运行：cd src && node tests/find-in-doc.test.mjs
//
// 只覆盖可离线验证的纯逻辑 findMatches（高亮/跳转是 DOM+PM 视图层，靠人工/QA 验）。

import assert from 'node:assert'
import { parseMarkdown } from '../editor-schema.js'
import { findMatches } from '../find-in-doc.js'

let pass = 0, fail = 0
function check(name, fn) {
  try { fn(); console.log(`✅ ${name}`); pass++ }
  catch (e) { console.error(`❌ ${name}: ${e.message}`); fail++ }
}

// 命中区间还原成原文片段（同一文本节点内，textBetween 即子串）
function slice(doc, m) {
  return doc.textBetween(m.from, m.to, '\n', '\n')
}

check('基本子串匹配：大小写不敏感命中全部，位置还原为原文', () => {
  const doc = parseMarkdown('Hello world, hello again. HELLO')
  const ms = findMatches(doc, 'hello', false)
  assert.strictEqual(ms.length, 3, '应命中 3 处')
  assert.deepStrictEqual(ms.map((m) => slice(doc, m)), ['Hello', 'hello', 'HELLO'])
  ms.forEach((m) => assert.ok(m.to > m.from, '区间应非零宽'))
})

check('大小写敏感开关：只连同形命中', () => {
  const doc = parseMarkdown('Hello hello HELLO')
  assert.strictEqual(findMatches(doc, 'Hello', true).length, 1)
  assert.strictEqual(findMatches(doc, 'hello', true).length, 1)
  assert.strictEqual(findMatches(doc, 'HELLO', true).length, 1)
})

check('空查询：无命中', () => {
  const doc = parseMarkdown('anything')
  assert.deepStrictEqual(findMatches(doc, '', false), [])
})

check('命中不重叠：aaa 中找 aa 只 1 处', () => {
  const doc = parseMarkdown('aaa')
  assert.strictEqual(findMatches(doc, 'aa', false).length, 1)
})

check('命中按文档序（先出现的排前）', () => {
  const doc = parseMarkdown('b a b a')
  const ms = findMatches(doc, 'a', false)
  assert.strictEqual(ms.length, 2)
  assert.ok(ms[0].from < ms[1].from, '文档坐标应递增')
})

check('命中不跨块：跨段落的词不匹配', () => {
  const doc = parseMarkdown('foo\n\nbar')
  assert.strictEqual(findMatches(doc, 'foobar', false).length, 0)
  assert.strictEqual(findMatches(doc, 'foo', false).length, 1)
  assert.strictEqual(findMatches(doc, 'bar', false).length, 1)
})

check('标记内文本可命中（bold 单独成文本节点）', () => {
  const doc = parseMarkdown('see **bold** text')
  const ms = findMatches(doc, 'bold', false)
  assert.strictEqual(ms.length, 1)
  assert.strictEqual(slice(doc, ms[0]), 'bold')
})

check('CJK 子串匹配', () => {
  const doc = parseMarkdown('本章介绍交叉引用，交叉引用可跳转')
  const ms = findMatches(doc, '交叉引用', false)
  assert.strictEqual(ms.length, 2)
})

console.log(`\nfind-in-doc: ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
