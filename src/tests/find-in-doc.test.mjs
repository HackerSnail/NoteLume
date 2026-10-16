// find-in-doc.test.mjs —— 文档内查找命中逻辑的回归测试（纯模型，无需浏览器）
// 运行：cd src && node tests/find-in-doc.test.mjs
//
// 只覆盖可离线验证的纯逻辑 findMatches（高亮/跳转是 DOM+PM 视图层，靠人工/QA 验）。

import assert from 'node:assert'
import { EditorState } from 'prosemirror-state'
import { parseMarkdown, serializeMarkdown, schema } from '../editor-schema.js'
import { findMatches, buildReplaceTr } from '../find-in-doc.js'

// 由 md 构造一个 EditorState（供 buildReplaceTr 用）
function stateOf(md) {
  return EditorState.create({ schema, doc: parseMarkdown(md) })
}
function plainText(state) {
  return state.doc.textBetween(0, state.doc.content.size, '\n', '\n')
}

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

// —— 替换（buildReplaceTr） ——
check('全部替换：多命中合并为一个事务，一步改完', () => {
  const s = stateOf('a b a b a')
  const ms = findMatches(s.doc, 'a', false)
  const tr = buildReplaceTr(s, ms, 'x')
  assert.strictEqual(tr.steps.length, 3, '3 个命中→3 步，但同属一个事务')
  assert.strictEqual(plainText(s.apply(tr)), 'x b x b x')
})

check('空替换 = 删除命中', () => {
  const s = stateOf('foobar')
  const ms = findMatches(s.doc, 'foo', false)
  assert.strictEqual(plainText(s.apply(buildReplaceTr(s, ms, ''))), 'bar')
})

check('大小写不敏感命中一并替换', () => {
  const s = stateOf('a A b')
  const ms = findMatches(s.doc, 'a', false)
  assert.strictEqual(ms.length, 2)
  assert.strictEqual(plainText(s.apply(buildReplaceTr(s, ms, 'Z'))), 'Z Z b')
})

check('标记内替换保留原内联标记（粗体里换词仍是粗体）', () => {
  const s = stateOf('see **bold** end')
  const ms = findMatches(s.doc, 'bold', false)
  assert.strictEqual(ms.length, 1)
  const out = serializeMarkdown(s.apply(buildReplaceTr(s, ms, 'strong')).doc).trim()
  assert.strictEqual(out, 'see **strong** end', '替换后 markdown 应为 ' + JSON.stringify(out))
})

check('命中落在标记节点中部（非节点开头）仍保留粗体', () => {
  const s = stateOf('xx**bold**')
  const ms = findMatches(s.doc, 'ol', false) // 'ol' 在 bold 中间，from 不是文本节点开头
  assert.strictEqual(ms.length, 1)
  const out = serializeMarkdown(s.apply(buildReplaceTr(s, ms, 'XX')).doc).trim()
  assert.strictEqual(out, 'xx**bXXd**', '替换后 markdown 应为 ' + JSON.stringify(out))
})

check('无可替换目标：buildReplaceTr 返回 null', () => {
  const s = stateOf('nothing here')
  assert.strictEqual(buildReplaceTr(s, [], 'x'), null)
})

console.log(`\nfind-in-doc: ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
