// block-input-rules.test.mjs —— 列表族 / 围栏代码块输入规则（纯模型，无需浏览器）
// 运行：cd src && node tests/block-input-rules.test.mjs
//
// 逐字符模拟击键：空格落定时调 listInputTr / fenceInputTr（即 editor-view.js handleTextInput
// 里那段），命中就应用 transform，未命中按普通插入文本。核心断言：会话得到的文档 == 把这串字符
// 当 md 解析得到的文档（所见即所得不与解析器分叉），以及序列化写回的标准 GFM 形态。

import assert from 'node:assert'
import { EditorState, TextSelection } from 'prosemirror-state'
import { schema, parseMarkdown, serializeMarkdown } from '../editor-schema.js'
import { listInputTr, fenceInputTr } from '../block-input-rules.js'

let pass = 0
let fail = 0
function t(name, fn) {
  try { fn(); console.log(`✅ ${name}`); pass++ } catch (e) { console.error(`❌ ${name}: ${e.message}`); fail++ }
}

// 逐字符输入；doc 起始文档，selPos 缺省落在第一个段落的文本内（编辑器里光标总在文本块内）
function typeChars(doc, chars, selPos) {
  let state = EditorState.create({ schema, doc })
  state = state.apply(state.tr.setSelection(TextSelection.create(doc, selPos == null ? 1 : selPos)))
  for (const ch of chars) {
    const $head = state.selection.$head
    const before = state.doc.textBetween($head.start(), $head.pos, '\u0000', '\u0000')
    const tr = listInputTr(state, $head, before, ch) || fenceInputTr(state, $head, before, ch)
    state = state.apply(tr || state.tr.insertText(ch))
  }
  return state
}

const EMPTY = parseMarkdown('')

// —— 手敲任务列表：三步转出可勾选的任务项，与会话串的解析产物一致 ——
// 序列化期望统一取「解析产物再序列化」的结果，只要求会话产物与解析器口径一致
t('敲 - [ ] 待办 → 无序任务列表（未勾）', () => {
  const st = typeChars(EMPTY, [...'- [ ] 待办'])
  assert.ok(st.doc.eq(parseMarkdown('- [ ] 待办')), st.doc.toString())
  assert.strictEqual(serializeMarkdown(st.doc), serializeMarkdown(parseMarkdown('- [ ] 待办')))
})

t('敲 - [x] 已完成 → 已勾任务项', () => {
  const st = typeChars(EMPTY, [...'- [x] 已完成'])
  assert.ok(st.doc.eq(parseMarkdown('- [x] 已完成')), st.doc.toString())
  assert.strictEqual(serializeMarkdown(st.doc), serializeMarkdown(parseMarkdown('- [x] 已完成')))
})

t('大写 - [X] 同样认已勾', () => {
  const st = typeChars(EMPTY, [...'- [X] 大写也认'])
  assert.ok(st.doc.eq(parseMarkdown('- [X] 大写也认')), st.doc.toString())
})

t('敲 * [ ] 星号标记同样接任务', () => {
  const st = typeChars(EMPTY, [...'* [ ] 星号'])
  assert.ok(st.doc.eq(parseMarkdown('* [ ] 星号')), st.doc.toString())
})

t('已有列表项的空段落里敲 [ ] 照转（回车新项的场景）', () => {
  // 回车新出的列表项是空段落；'- ' 解析出来正是这个形态，光标放进去敲 [ ]
  const doc = parseMarkdown('- ')
  const st = typeChars(doc, [...'[ ] 第二项'], 3) // 空列表项段落的内容起点
  const list = st.doc.content.child(0)
  assert.strictEqual(list.type.name, 'bullet_list')
  const li = list.child(0)
  assert.strictEqual(li.attrs.checked, false, '应转为未勾任务项')
  assert.strictEqual(li.textContent, '第二项')
})

t('回车新项里敲整串 - [x] 事项 → 干净的已勾项（标记吞掉不嵌套）', () => {
  const doc = parseMarkdown('- [ ] 第一项\n')
  // 光标放到列表项末尾（模拟回车后的新项是空段落，等价于 '- ' 解析的形态）
  const doc2 = parseMarkdown('- ')
  const st = typeChars(doc2, [...'- [x] 第二项'], 3)
  const list = st.doc.content.child(0)
  assert.strictEqual(list.content.childCount, 1, '不应嵌套出新列表：' + st.doc.toString())
  const li = list.child(0)
  assert.strictEqual(li.attrs.checked, true, '应转为已勾任务项')
  assert.strictEqual(li.textContent, '第二项', '标记不应残留在文本里')
})

t('项内有内容时敲 - 保持字面量', () => {
  const doc = parseMarkdown('- 文字\n')
  // 光标放在「文字」末尾：ul enter(1) + li enter(1) + p enter(1) + 文本(2)
  const st = typeChars(doc, [...'- '], 5)
  const list = st.doc.content.child(0)
  assert.strictEqual(list.type.name, 'bullet_list')
  assert.strictEqual(list.content.childCount, 1, '不应嵌套出新列表：' + st.doc.toString())
  assert.ok(list.child(0).textContent.startsWith('文字-'), list.child(0).textContent)
})

// —— 无序 / 有序 ——
t('敲 - 文字 → 无序列表', () => {
  const st = typeChars(EMPTY, [...'- 文字'])
  assert.ok(st.doc.eq(parseMarkdown('- 文字')), st.doc.toString())
})

t('敲 1. 文字 → 有序列表', () => {
  const st = typeChars(EMPTY, [...'1. 文字'])
  assert.ok(st.doc.eq(parseMarkdown('1. 文字')), st.doc.toString())
})

t('敲 3. 起始号保留', () => {
  const st = typeChars(EMPTY, [...'3. 文字'])
  assert.strictEqual(serializeMarkdown(st.doc), '3. 文字')
})

// —— 标记右侧已有内容：中途补敲的空格同样转换 ——
t('光标在行首给 abc 前补敲 - → abc 进列表', () => {
  const doc = parseMarkdown('abc')
  const st = typeChars(doc, [...'- '], 1)
  assert.ok(st.doc.eq(parseMarkdown('- abc')), st.doc.toString())
})

// —— 不转换的场合 ——
t('代码块里敲 - 不转换', () => {
  const doc = parseMarkdown('```\n```\n')
  // 光标放进代码块内容里
  let pos = 0
  doc.descendants((n, p) => { if (n.type.name === 'code_block') pos = p + 1 })
  const st = typeChars(doc, [...'- '], pos)
  assert.strictEqual(st.doc.content.childCount, 1)
  assert.strictEqual(st.doc.content.child(0).type.name, 'code_block')
})

t('标题里敲 - 不转换', () => {
  const doc = parseMarkdown('# 标题\n')
  const st = typeChars(doc, [...'- '], 3) // 标题文本末尾（内容 1..3）
  assert.strictEqual(st.doc.content.child(0).type.name, 'heading')
})

t('有序列表项里敲 [ ] 不转任务（GFM 任务只在无序列表上）', () => {
  const doc = parseMarkdown('1. 第一\n')
  const st = typeChars(doc, [...'[ ] x'], 5) // 1. 第一 的段内末尾
  assert.strictEqual(st.doc.resolve(5).node(1).type.name, 'ordered_list')
})

t('普通段落里敲 [ ] 不转任务', () => {
  const st = typeChars(EMPTY, [...'[ ] 直接敲'])
  assert.strictEqual(st.doc.content.child(0).type.name, 'paragraph')
})

t('块中间的 - 不转换（x- 这种）', () => {
  const st = typeChars(EMPTY, [...'x- '])
  assert.strictEqual(st.doc.content.child(0).type.name, 'paragraph')
})

// —— 围栏代码块：敲 ``` / ```lang 落空格就地转 ——
t('敲 ``` 空格 → 空代码块（无语言）', () => {
  const st = typeChars(EMPTY, [...'``` '])
  const cb = st.doc.content.child(0)
  assert.strictEqual(cb.type.name, 'code_block')
  assert.strictEqual(cb.attrs.params, '')
  assert.strictEqual(cb.textContent, '')
})

t('敲 ```js 空格 → 代码块带语言，光标落块内', () => {
  const st = typeChars(EMPTY, [...'```js '])
  const cb = st.doc.content.child(0)
  assert.strictEqual(cb.type.name, 'code_block')
  assert.strictEqual(cb.attrs.params, 'js')
  assert.strictEqual(st.selection.from, 1, '光标应落在代码块内容起点')
})

t('围栏后带内容：```js console.log(1) → 内容进块内', () => {
  const st = typeChars(EMPTY, [...'```js console.log(1)'])
  const cb = st.doc.content.child(0)
  assert.strictEqual(cb.type.name, 'code_block')
  assert.strictEqual(cb.attrs.params, 'js')
  assert.strictEqual(cb.textContent, 'console.log(1)')
})

t('会话产物 == 解析产物：敲 ```js let a = 1 与解析同形态', () => {
  const st = typeChars(EMPTY, [...'```js let a = 1'])
  assert.ok(st.doc.eq(parseMarkdown('```js\nlet a = 1\n```')), st.doc.toString())
})

t('四个反引号同样认（GFM 围栏 3+）', () => {
  const st = typeChars(EMPTY, [...'```` '])
  assert.strictEqual(st.doc.content.child(0).attrs.params, '')
})

t('语言名带符号：c++ / c# 都落 params', () => {
  assert.strictEqual(typeChars(EMPTY, [...'```c++ ']).doc.content.child(0).attrs.params, 'c++')
  assert.strictEqual(typeChars(EMPTY, [...'```c# ']).doc.content.child(0).attrs.params, 'c#')
})

t('```mermaid 转出 mermaid 参数（预览插件按 params 生效）', () => {
  const st = typeChars(EMPTY, [...'```mermaid '])
  assert.strictEqual(st.doc.content.child(0).attrs.params, 'mermaid')
})

t('代码块里敲 ``` 空格不转换（块内是内容）', () => {
  const doc = parseMarkdown('```\n```\n')
  let pos = 0
  doc.descendants((n, p) => { if (n.type.name === 'code_block') pos = p + 1 })
  const st = typeChars(doc, [...'``` '], pos)
  assert.strictEqual(st.doc.content.childCount, 1)
  assert.strictEqual(st.doc.content.child(0).textContent, '``` ')
})

t('标题里敲 ``` 空格不转换', () => {
  const doc = parseMarkdown('# 标题\n')
  const st = typeChars(doc, [...'``` '], 3)
  assert.strictEqual(st.doc.content.child(0).type.name, 'heading')
})

t('块中间的 ``` 不转换（x``` 这种）', () => {
  const st = typeChars(EMPTY, [...'x``` '])
  assert.strictEqual(st.doc.content.child(0).type.name, 'paragraph')
})

t('脚注项里敲 ``` 不转换（容器只收一个段落）', () => {
  const doc = parseMarkdown('文字[^1]\n\n[^1]: 脚注\n')
  let pos = 0
  doc.descendants((n, p) => {
    if (n.type.name === 'footnote_item') pos = p + 1 + 1 // 项内段落的内容起点
  })
  const st = typeChars(doc, [...'``` '], pos)
  assert.strictEqual(st.doc.content.child(1).type.name, 'footnote_section')
})

console.log(`\n结果：${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
