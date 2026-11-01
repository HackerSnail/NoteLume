// serialize-escape.test.mjs —— 序列化转义口径：段首 # 只加一个反斜杠，往返幂等
// 运行：cd src && node tests/serialize-escape.test.mjs
//
// 对应实测缺陷 TC-010（往返脏化）：prosemirror-markdown 的 esc() 先按「行首 #」补一个反斜杠，
// escapeExtraCharacters 再对同一个 # 补第二个，段首字面 # 落成 `\\#`——文件里多出一个可见反斜杠，
// 且要往返两次才稳定（`\#` → `\\#` → `\\\#`）。现在改在 esc() 返回后补额外转义，
// 已经紧跟反斜杠的字符跳过（见 editor-schema.js 的 escExtra）。

import assert from 'node:assert'
import { schema, parseMarkdown, serializeMarkdown } from '../editor-schema.js'

let pass = 0, fail = 0
function check(name, fn) {
  try { fn(); console.log(`✅ ${name}`); pass++ }
  catch (e) { console.error(`❌ ${name}: ${e.message}`); fail++ }
}

const para = (text) => schema.nodes.paragraph.create(null, schema.text(text))
const docOf = (...nodes) => schema.nodes.doc.create(null, nodes)
// md → doc → md
const rt = (md) => serializeMarkdown(parseMarkdown(md))
// 往返三次必须一次到位（第二次起不再变形）
function assertStable(md, expect, name) {
  const a = rt(md)
  assert.strictEqual(a, expect, name + '：首次序列化 ' + JSON.stringify(a))
  const b = rt(a)
  assert.strictEqual(b, a, name + '：二次序列化漂移 ' + JSON.stringify(b))
  const c = rt(b)
  assert.strictEqual(c, b, name + '：三次序列化漂移 ' + JSON.stringify(c))
}

check('段首字面 # 只加一个反斜杠，往返幂等', () => {
  assertStable('\\# 一级标题', '\\# 一级标题', '从 md 侧')
  // 从模型侧（用户在 WYSIWYG 里敲出来的字面文本）：过去输出 `\\# 一级标题`
  assert.strictEqual(serializeMarkdown(docOf(para('# 一级标题'))), '\\# 一级标题')
})

check('段首字面 > 同口径（PM 的行首转义不叠加）', () => {
  assert.strictEqual(serializeMarkdown(docOf(para('> 引用半角'))), '\\> 引用半角')
  assertStable('\\> 引用半角', '\\> 引用半角', '引用段首')
})

check('文中 # 仍转义，不会重载成标签节点', () => {
  assert.strictEqual(serializeMarkdown(docOf(para('C# 语言'))), 'C\\# 语言')
  assert.strictEqual(serializeMarkdown(docOf(para('见 issue #12 单'))), '见 issue \\#12 单')
  const doc = parseMarkdown(serializeMarkdown(docOf(para('见 issue #12 单'))))
  let tags = 0
  doc.descendants((n) => { if (n.type.name === 'tag') tags++ })
  assert.strictEqual(tags, 0, '重载后 #12 变成了标签节点')
  assert.strictEqual(doc.textBetween(0, doc.content.size), '见 issue #12 单')
})

check('字面「反斜杠 + #」不叠到三层，往返稳定', () => {
  assertStable('\\# 一次', '\\# 一次', '单反斜杠形')
  const doc = parseMarkdown('\\\\# 多级') // 文档文本 = \# 多级
  assert.strictEqual(serializeMarkdown(doc), '\\\\# 多级')
  assert.strictEqual(doc.textBetween(0, doc.content.size), '\\# 多级')
  assertStable('\\\\# 多级', '\\\\# 多级', '两层形')
})

check('$ 一律转义，行内公式与字面 $ 各行其道', () => {
  assert.strictEqual(serializeMarkdown(docOf(para('价格 $5'))), '价格 \\$5')
  assert.strictEqual(serializeMarkdown(docOf(para('两端 $x$ 夹'))), '两端 \\$x\\$ 夹')
  assertStable('价格 \\$5', '价格 \\$5', '$ 段')
  // 真公式不受影响
  assertStable('$E=mc^2$', '$E=mc^2$', '行内公式')
})

check('表格单元格里的段首 # 同口径（cellToMarkdown 走同一序列化）', () => {
  // 序列化会把列宽补齐，不断字面相等，只断 # 的转义层数与幂等
  const md = '| \\# 单元格 | b |\n| --- | --- |\n| 1 | 2 |'
  const a = rt(md)
  assert.ok(/\| \\# 单元格 \|/.test(a), '单元格里的 # 不是单反斜杠：' + JSON.stringify(a))
  assert.ok(!a.includes('\\\\#'), '单元格里的 # 反斜杠叠加：' + JSON.stringify(a))
  assert.strictEqual(rt(a), a, '表格往返漂移')
})

check('标题文本以 # 开头时转义，不被解析成标签', () => {
  const h = schema.nodes.heading.create({ level: 1 }, schema.text('#号开头'))
  const out = serializeMarkdown(docOf(h))
  assert.strictEqual(out, '# \\#号开头')
  assert.strictEqual(rt(out), out)
})

console.log(`\n结果：${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
