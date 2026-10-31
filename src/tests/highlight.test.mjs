// highlight.test.mjs —— 选区高亮（p5plan §6.4）纯逻辑回归（不触 DOM）
// 运行：cd src && node tests/highlight.test.mjs
import assert from 'node:assert'
import { EditorState, TextSelection } from 'prosemirror-state'
import { schema, mdParser, serializeMarkdown, HL_PRESETS, normalizeHlColor } from '../editor-schema.js'
import { setHighlightMark, selectionHasHighlight, highlightColorAt } from '../highlight-mark.js'

let pass = 0
let fail = 0
function test(name, fn) {
  try {
    fn()
    pass++
    console.log('  ok   ' + name)
  } catch (e) {
    fail++
    console.log('  FAIL ' + name + ' —— ' + ((e && e.message) || e))
  }
}

// 取文档里第一段首个文本节点的 marks
function firstTextMarks(doc) {
  let out = null
  doc.descendants((n) => {
    if (!out && n.isText) out = n.marks
  })
  return out || []
}

test('预设七色与颜色归一：预设名 / 六位 hex 收（hex 转小写），垃圾值回落 yellow', () => {
  assert.deepStrictEqual(HL_PRESETS, ['yellow', 'orange', 'green', 'teal', 'blue', 'violet', 'pink'])
  assert.strictEqual(normalizeHlColor('green'), 'green')
  assert.strictEqual(normalizeHlColor('#AbCdEf'), '#abcdef')
  assert.strictEqual(normalizeHlColor('#abc'), 'yellow') // 三位 hex 不要
  assert.strictEqual(normalizeHlColor('red'), 'yellow')
  assert.strictEqual(normalizeHlColor(null), 'yellow')
  assert.strictEqual(normalizeHlColor(undefined), 'yellow')
})

test('schema 有 highlight 标记：默认黄色、inclusive 关', () => {
  const m = schema.marks.highlight
  assert.ok(m, 'schema 缺 highlight 标记')
  assert.strictEqual(m.create().attrs.color, 'yellow')
  assert.strictEqual(m.spec.inclusive, false)
})

test('toDOM：预设色不带行内样式（交给 CSS 变量），自定义色写背景', () => {
  const spec = schema.marks.highlight.spec
  const preset = spec.toDOM(schema.marks.highlight.create({ color: 'blue' }))
  assert.deepStrictEqual(preset, ['mark', { class: 'nl-hl', 'data-color': 'blue', style: null }])
  const custom = spec.toDOM(schema.marks.highlight.create({ color: '#ff0000' }))
  assert.strictEqual(custom[1]['data-color'], '#ff0000')
  assert.strictEqual(custom[1].style, 'background-color:#ff0000')
})

test('解析 <mark data-color>：颜色落到标记属性，支持嵌套行内格式', () => {
  const doc = mdParser.parse('<mark data-color="green">重点</mark>')
  const marks = firstTextMarks(doc)
  const hl = marks.find((m) => m.type === schema.marks.highlight)
  assert.ok(hl, '没解析出 highlight 标记')
  assert.strictEqual(hl.attrs.color, 'green')

  const nested = mdParser.parse('<mark data-color="blue">**粗体** 普通</mark>')
  const texts = []
  nested.descendants((n) => { if (n.isText) texts.push({ text: n.text, hl: n.marks.some((m) => m.type === schema.marks.highlight) }) })
  assert.deepStrictEqual(texts.map((x) => x.text), ['粗体', ' 普通'])
  assert.ok(texts.every((x) => x.hl), '标记应覆盖整段内容')
})

test('序列化写回 <mark data-color>：往返一致', () => {
  for (const md of [
    '<mark data-color="green">重点</mark>',
    '前缀 <mark data-color="#123456">hex 色</mark> 后缀',
  ]) {
    assert.strictEqual(serializeMarkdown(mdParser.parse(md)), md)
  }
})

test('高亮与加粗 / 行内代码交叉：层级重排，第二代起稳定、高亮不丢', () => {
  // 序列化器按 rank 重排标记（产出 **<mark>x</mark>** 这类嵌套顺序调换），观感不变。
  // 第一代写出时空格可能留在标记内，第二代被 expelEnclosingWhitespace 挤出，之后收敛；
  // 断言收敛点不再变形 + 高亮文字没丢
  const mixed = '<mark data-color="yellow">**粗** `码`</mark>'
  const out2 = serializeMarkdown(mdParser.parse(serializeMarkdown(mdParser.parse(mixed))))
  assert.strictEqual(serializeMarkdown(mdParser.parse(out2)), out2)
  const hlTexts = []
  mdParser.parse(out2).descendants((n) => {
    if (n.isText && n.marks.some((m) => m.type === schema.marks.highlight)) hlTexts.push(n.text)
  })
  assert.deepStrictEqual(hlTexts, ['粗', '码'])
})

test('嵌套高亮摊平为不交叉单层段（内层色优先），且写出后稳定', () => {
  // PM 的 flat open/close 表达不了同类型交叉标记，解析时按「最内层色优先」摊平，
  // 与渲染器里内层 <mark> 盖住外层的观感一致；摊平结果再吃一遍不再变形
  const md = '<mark data-color="pink">a <mark data-color="yellow">b</mark> c</mark>'
  const flat = '<mark data-color="pink">a</mark> <mark data-color="yellow">b</mark> <mark data-color="pink">c</mark>'
  assert.strictEqual(serializeMarkdown(mdParser.parse(md)), flat)
  assert.strictEqual(serializeMarkdown(mdParser.parse(flat)), flat)
})

test('非法颜色与未闭合标签：不当高亮，按普通文本保留', () => {
  const doc = mdParser.parse('<mark data-color="zzz">x</mark>')
  const hl = firstTextMarks(doc).find((m) => m.type === schema.marks.highlight)
  assert.ok(hl && hl.attrs.color === 'yellow', '非法颜色应回落 yellow 而不是丢掉标记')
  assert.strictEqual(serializeMarkdown(mdParser.parse('<mark data-color="yellow">y</mark>')), '<mark data-color="yellow">y</mark>')

  // 只有闭标签：整体当普通文本（html:false 下 < 不会触发其它规则）
  const broken = mdParser.parse('结束标签 </mark> 在这里')
  assert.ok(!firstTextMarks(broken).some((m) => m.type === schema.marks.highlight))
  assert.strictEqual(serializeMarkdown(broken), '结束标签 </mark> 在这里')
})

test('空白被挤出标记外（expelEnclosingWhitespace），再序列化稳定', () => {
  const md = 'a <mark data-color="yellow"> b </mark> c'
  const once = serializeMarkdown(mdParser.parse(md))
  // 首尾空格挪到标记外面：荧光笔只盖文字，不盖空格
  assert.strictEqual(once, 'a  <mark data-color="yellow">b</mark>  c')
  // 吐出串再吃回去，结果不再变化（幂等）
  assert.strictEqual(serializeMarkdown(mdParser.parse(once)), once)
})

test('setHighlightMark 语义：加 → 换色（清旧上新）→ 再点同色取消', () => {
  const doc = mdParser.parse('hello world')
  let state = EditorState.create({ schema, doc, selection: TextSelection.create(doc, 1, 6) })
  const run = (color) => setHighlightMark(state, (tr) => { state = state.apply(tr) }, color)

  assert.strictEqual(run('green'), true)
  let marks = firstTextMarks(state.doc)
  let hl = marks.find((m) => m.type === schema.marks.highlight)
  assert.ok(hl && hl.attrs.color === 'green', '第一次点击应加上绿色')

  assert.strictEqual(run('blue'), true)
  marks = firstTextMarks(state.doc)
  hl = marks.find((m) => m.type === schema.marks.highlight)
  assert.ok(hl && hl.attrs.color === 'blue', '换色应替换旧色，而不是两种底色叠加')
  assert.strictEqual(marks.filter((m) => m.type === schema.marks.highlight).length, 1)

  assert.strictEqual(run('blue'), true)
  marks = firstTextMarks(state.doc)
  assert.ok(!marks.some((m) => m.type === schema.marks.highlight), '再点同色应取消高亮')

  // 选区外文字不受影响：PM 会把相邻同 marks 的文本并回一个节点，取消后仍是整段无高亮
  const all = []
  state.doc.descendants((n) => { if (n.isText) all.push(n) })
  assert.strictEqual(all.length, 1)
  assert.strictEqual(all[0].text, 'hello world')
  assert.ok(!all[0].marks.some((m) => m.type === schema.marks.highlight))
})

test('取数助手：selectionHasHighlight / highlightColorAt', () => {
  const doc = mdParser.parse('<mark data-color="green">ab</mark>cd')
  // 文本 'ab' 在 pos 1..3，'cd' 在 4..6（paragraph 从 0 开始）
  assert.strictEqual(selectionHasHighlight(doc, 1, 3), true)
  assert.strictEqual(selectionHasHighlight(doc, 4, 6), false)
  assert.strictEqual(selectionHasHighlight(doc, 1, 6), true)
  assert.strictEqual(highlightColorAt(doc, 1), 'green')
  assert.strictEqual(highlightColorAt(doc, 4), null)
})

console.log('结果：' + pass + ' passed, ' + fail + ' failed')
if (fail) process.exit(1)
