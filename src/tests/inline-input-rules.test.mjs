// inline-input-rules.test.mjs —— 输入即渲染的强调规则（纯模型，无需浏览器）
// 运行：cd src && node tests/inline-input-rules.test.mjs
//
// 逐字符模拟击键：每输入一个字符调一次 emphasisInputTr（即 editor-view.js handleTextInput
// 里那段），命中就把 transform 应用到 state（光标随 tr 的选区走），未命中按普通插入文本。
// 断言落点：标记与文本、光标位置、以及「会话里得到的文档 == 把这串字符当 md 解析得到的
// 文档」——后者是所见即所得的核心，屏幕上换出来的标记必须和存盘后再解析的一致。

import assert from 'node:assert'
import { EditorState, TextSelection } from 'prosemirror-state'
import { schema, parseMarkdown, serializeMarkdown } from '../editor-schema.js'
import { emphasisInputTr } from '../inline-input-rules.js'

let pass = 0
let fail = 0
function t(name, fn) {
  try { fn(); console.log(`✅ ${name}`); pass++ } catch (e) { console.error(`❌ ${name}: ${e.message}`); fail++ }
}

// 逐字符输入；selPos 可指定起始光标（默认文档开头）
function typeChars(doc, chars, selPos) {
  let state = EditorState.create({ schema, doc })
  if (selPos != null) state = state.apply(state.tr.setSelection(TextSelection.create(doc, selPos)))
  for (const ch of chars) {
    const $head = state.selection.$head
    const before = state.doc.textBetween($head.start(), $head.pos, '\u0000', '\u0000')
    const tr = emphasisInputTr(state, $head, before, ch)
    state = state.apply(tr || state.tr.insertText(ch))
  }
  return state
}

// 摊平行内内容：[{ text, marks: ['strong'] }, ...]
function inline(state) {
  const out = []
  state.doc.descendants((n) => { if (n.isText) out.push({ text: n.text, marks: n.marks.map((m) => m.type.name) }) })
  return out
}

const EMPTY = parseMarkdown('') // 一段空段落

// —— 正例：五种形态各自换出对应标记，且与解析器对同一串字符的产物一致 ——
const POSITIVE = [
  ['**粗**', 'strong'],
  ['*斜*', 'em'],
  ['~~删~~', 'strike'],
  ['__粗__', 'strong'],
  ['_斜_', 'em'],
  ['前**粗**后', 'strong'],
  ['这是**「重要」**的内容', 'strong'],
  ['x**“引”**', 'strong'], // 弯引号邻接：中文标点放宽后解析器认这段是强调，输入规则跟着认
  ['**总结：**大段说明', 'strong'],
  ['~~提示：~~如下', 'strike'],
  ['*斜：*体', 'em'],
  ['中*斜*中', 'em'],
  ['**粗**b', 'strong'],
  ['**注：**123', 'strong'],
]
for (const [src, mark] of POSITIVE) {
  t(`输入 ${JSON.stringify(src)} → ${mark}`, () => {
    const st = typeChars(EMPTY, [...src])
    const got = inline(st)
    assert.ok(got.some((it) => it.marks.includes(mark)), `应有 ${mark} 标记：${JSON.stringify(got)}`)
    // 所见即所得：会话产物与把这串字符当 md 解析的产物一致
    assert.ok(st.doc.eq(parseMarkdown(src)), `文档应与解析产物一致：${JSON.stringify(got)}`)
  })
}

// —— 半程状态不抢先：差最后一个结束符时必须还是字面量 ——
for (const src of ['**粗*', '~~删~', '__粗_', '*斜', '**']) {
  t(`半程状态 ${JSON.stringify(src)} 不转换`, () => {
    const st = typeChars(EMPTY, [...src])
    assert.deepStrictEqual(inline(st), [{ text: src, marks: [] }])
  })
}

// —— 负例：解析器不认的形态留字面量（与 CommonMark 一致）——
const NEGATIVE = [
  '**foo **', // 内容尾部空格
  '** foo**', // 内容首部空格
  'word_斜_', // _ 词内
  '文件_备份',
  '报告_2024_终版',
  'x**2', // 指数写法
  '3*4',
]
for (const src of NEGATIVE) {
  t(`输入 ${JSON.stringify(src)} 不转换`, () => {
    const st = typeChars(EMPTY, [...src])
    assert.deepStrictEqual(inline(st), [{ text: src, marks: [] }])
  })
}

// —— 光标落在换出文本之后 ——
t('转换后光标在标记文本末尾', () => {
  const st = typeChars(EMPTY, [...'前**粗**'])
  assert.strictEqual(st.selection.$head.pos, 3, '光标应落在 strong 文本之后')
  assert.strictEqual(st.selection.$head.parentOffset, 2, '块内偏移 = 前(1) + 粗(1)')
})

// —— 连续输入：换完之后接着打字，标记不被吃掉 ——
t('**粗** 后继续输入', () => {
  const st = typeChars(EMPTY, [...'**粗**尾'])
  assert.deepStrictEqual(inline(st), [{ text: '粗', marks: ['strong'] }, { text: '尾', marks: [] }])
  assert.ok(st.doc.eq(parseMarkdown('**粗**尾')))
})

// —— 代码块内不转换（schema: code_block marks='code'）——
t('代码块内输入 **粗** 不转换', () => {
  const doc = parseMarkdown('```js\ncode\n```\n')
  let pos = null
  doc.descendants((n, p) => { if (n.isText && n.text === 'code') pos = p + 2 })
  const st = typeChars(doc, [...'**粗**'], pos)
  const got = []
  st.doc.descendants((n) => { if (n.isText) got.push({ text: n.text, marks: n.marks.map((m) => m.type.name) }) })
  assert.ok(got.every((it) => it.marks.length === 0), `代码块内不应出现标记：${JSON.stringify(got)}`)
  assert.ok(st.doc.textContent.includes('**粗**'), '星号应原样留在代码块里')
})

// —— 区间跨叶子节点时不换（** 与 ** 之间已是 [[链接]] 节点）——
// 不换的含义：这个 * 按普通字符落进去，星号与链接节点都原样保留，且不产生标记
t('内容跨 [[链接]] 节点时不转换', () => {
  const wiki = schema.nodes.wikiLink.create({ target: '页', label: null })
  const doc = schema.nodes.doc.create(null, schema.nodes.paragraph.create(null, [schema.text('**'), wiki, schema.text('*')]))
  const st = typeChars(doc, ['*'], 5)
  assert.deepStrictEqual(inline(st), [{ text: '**', marks: [] }, { text: '**', marks: [] }])
  let hasWiki = false
  st.doc.descendants((n) => { if (n.type.name === 'wikiLink') hasWiki = true })
  assert.ok(hasWiki, '[[链接]] 节点应原样保留')
})

// —— 序列化：换出来的文档写回的就是用户敲的那串字符 ——
t('序列化写回原形态', () => {
  const st = typeChars(EMPTY, [...'这是**重点**。'])
  assert.strictEqual(serializeMarkdown(st.doc), '这是**重点**。')
  assert.strictEqual(serializeMarkdown(parseMarkdown(serializeMarkdown(st.doc))), '这是**重点**。', '二次往返仍幂等')
})

console.log(`\n结果：${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
