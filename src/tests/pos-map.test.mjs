// pos-map.test.mjs —— 源码 ⇄ 所见即所得 光标位置映射单测（纯模型，无需浏览器）
// 运行：cd src && node tests/pos-map.test.mjs
//
// 覆盖：
//   ① 精确模式（源码 === 序列化正文）：所有文本位置 pmToSrc → srcToPm 字符级往返一致
//   ② frontmatter：base 偏移下映射仍落在正文、往返一致
//   ③ 行级回退（原文字节与序列化不一致）：光标落在正确行、回落后仍在同一块
//   ④ 退出源码场景（用户在源码里增删过行）：行级回退仍能落到对应段落
//   ⑤ 边界：空文档 / 越界位置一律夹紧不抛

import assert from 'node:assert'
import { parseMarkdown, serializeMarkdown, serializeMarkdownMapped } from '../editor-schema.js'
import { createPosMapper } from '../pos-map.js'
import { splitFrontmatter } from '../frontmatter.js'

let pass = 0
const ok = (name) => {
  console.log('✅ ' + name)
  pass++
}

// 文档内所有文本位置（textblock 内每个字符边界）；表格单元格不在精确范围内，跳过
function textPositions(doc, skipIn) {
  const out = []
  doc.descendants((node, pos, parent) => {
    if (node.isText && (!parent || !skipIn.includes(parent.type.name))) {
      for (let i = 0; i <= node.text.length; i++) out.push(pos + i)
    }
  })
  return out
}

// 找子串首次出现处的文档位置（用于构造“光标在某段某字”的场景）
function posOfText(doc, needle) {
  let found = null
  doc.descendants((node, pos) => {
    if (found != null || !node.isText) return
    const i = node.text.indexOf(needle)
    if (i >= 0) found = pos + i
  })
  if (found == null) throw new Error('样文中找不到：' + needle)
  return found
}

function lineAt(text, off) {
  return text.slice(0, off).split('\n').length
}

// —— ① 精确模式：字符级往返 ————————————————————————————————
{
  const md = [
    '# 标题一',
    '',
    '第一段有 **粗体**、*斜体*、`行内代码` 与 [[链接]] 和 #标签。',
    '',
    '- 列表甲',
    '- 列表乙',
    '',
    '> 引用一段',
    '',
    '```js',
    'const a = 1;',
    '```',
    '',
    '结尾段落。',
  ].join('\n')
  const doc = parseMarkdown(md)
  // 精确模式即「模型改过 → 展示重新序列化的全文」：源码取序列化产物本身
  const src = serializeMarkdown(doc)
  const m = createPosMapper({ doc, serialize: serializeMarkdownMapped, source: src, base: 0 })
  assert.ok(m.exact, '源码 === 序列化正文 → 精确模式')

  const positions = textPositions(doc, ['table_cell', 'table_header'])
  assert.ok(positions.length > 50, '样例须覆盖足够多的文本位置')
  for (const pos of positions) {
    const off = m.pmToSrc(pos)
    assert.ok(off >= 0 && off <= src.length, '偏移越界：' + pos + ' -> ' + off)
    assert.strictEqual(m.srcToPm(off), pos, '往返不一致：pos=' + pos + ' off=' + off + ' 字符=' + JSON.stringify(src[off]))
  }
  ok('精确模式：' + positions.length + ' 个文本位置字符级往返一致')

  // 选区范围也一起带过去（from/to 分别映射）
  const from = posOfText(doc, '粗体')
  const to = posOfText(doc, '斜体')
  assert.ok(m.pmToSrc(from) < m.pmToSrc(to))
  ok('精确模式：选区起止分别映射且保持先后')
}

// —— ② frontmatter：base 偏移 ——————————————————————————————
{
  const bodyMd = '# 标题\n\n正文第二段在这里。\n'
  const doc = parseMarkdown(bodyMd) // 与 editor-view 一致：模型只含正文
  const src = '---\ntitle: 测试\n---\n' + serializeMarkdown(doc)
  const base = src.length - serializeMarkdown(doc).length
  const m = createPosMapper({ doc, serialize: serializeMarkdownMapped, source: src, base })
  assert.ok(m.exact, '正文与序列化逐字节一致 → 精确模式')
  const pos = posOfText(doc, '正文')
  const off = m.pmToSrc(pos)
  assert.strictEqual(src.slice(off, off + 2), '正文', '映射点须落在正文“正文”二字上')
  assert.strictEqual(m.srcToPm(off), pos, '带 frontmatter 前缀仍须字符级往返')
  ok('frontmatter：base 偏移下往返一致')
}

// —— ③ 行级回退：原文字节格式不同 ——————————————————————————
{
  // Typora/Obsidian 手写风格：段间两个空行、列表用 * 加宽、表格列宽不齐
  const raw = '# 手写标题\n\n\n第一段正文。\n\n*  列表甲\n*  列表乙\n\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n最后一段收尾。'
  const doc = parseMarkdown(raw)
  const ser = serializeMarkdown(doc)
  assert.notStrictEqual(raw, ser, '样例须与序列化结果不同（否则不是回退模式）')
  const m = createPosMapper({ doc, serialize: serializeMarkdownMapped, source: raw, base: 0 })
  assert.ok(!m.exact, '原文字节 → 行级回退')

  const pos = posOfText(doc, '最后一段收尾。') + 2
  const off = m.pmToSrc(pos)
  assert.strictEqual(raw.split('\n')[lineAt(raw, off) - 1], '最后一段收尾。', '光标须落在“最后一段收尾。”所在行')
  const back = m.srcToPm(off)
  assert.ok(back >= 0 && back <= doc.content.size)
  assert.ok(doc.resolve(back).parent.textContent.includes('收尾'), '回落后仍应在同一段落内')

  // 前中段各抽查一次，确保不是只对最后一段有效
  const pos2 = posOfText(doc, '列表甲') + 1
  const off2 = m.pmToSrc(pos2)
  const line2 = raw.split('\n')[lineAt(raw, off2) - 1]
  assert.ok(line2.includes('甲'), '列表甲行对齐，实际落在：' + JSON.stringify(line2))
  ok('行级回退：手写格式原文下光标落在正确行')
}

// —— ④ 退出源码：用户在源码里增删过行 ——————————————————————
{
  const userTyped = '> 便签\n\n' + '# 标题\n\n段落一。\n\n段落二。\n'
  const doc = parseMarkdown(userTyped)
  const m = createPosMapper({ doc, serialize: serializeMarkdownMapped, source: userTyped, base: 0 })
  const off = userTyped.indexOf('段落二')
  const pos = m.srcToPm(off)
  assert.ok(doc.resolve(pos).parent.textContent.includes('段落二'), '源码光标回到所见即所得须落在同一段')
  ok('退出源码：源码增删行后仍落到对应段落')
}

// —— ⑤ 边界：空文档 / 越界 ————————————————————————————————
{
  // 空文档在 PM 里也是一个空段落（content.size=2）：两边的“唯一光标点”须互达
  const m0 = createPosMapper({ doc: parseMarkdown(''), serialize: serializeMarkdownMapped, source: '', base: 0 })
  assert.strictEqual(m0.pmToSrc(0), 0)
  assert.strictEqual(m0.srcToPm(0), 2)
  assert.strictEqual(m0.pmToSrc(2), 0)

  const md = '# 标题\n\n正文。'
  const doc = parseMarkdown(md)
  const m = createPosMapper({ doc, serialize: serializeMarkdownMapped, source: md, base: 0 })
  assert.strictEqual(m.pmToSrc(doc.content.size + 100), md.length, '越界位置夹到文末')
  const end = m.srcToPm(md.length + 100)
  assert.ok(end >= posOfText(doc, '。') && end <= doc.content.size, '越界偏移夹到文末（最后一个字符处）')
  assert.strictEqual(m.pmToSrc(-5), 0, '负位置夹到文首')
  // 文档末位 ↔ 文本末字符之后：往返仍成立
  assert.strictEqual(m.pmToSrc(posOfText(doc, '。') + 1), md.length)
  assert.strictEqual(m.srcToPm(md.length), posOfText(doc, '。') + 1)
  ok('边界：空文档与越界一律夹紧')
}

// —— ⑥ 杂项文档：行级回退下各类型块都要落在正确行 ————————————————
{
  const md = [
    '---',
    'title: 杂项',
    '---',
    '',
    '# 标题',
    '',
    '> [!NOTE] 提示',
    '> 标注正文 **粗体**。',
    '',
    '| 名称 | 数量 |',
    '| --- | --- |',
    '| 苹果 | 3 |',
    '',
    '公式 $e^{i\\pi}$ 与块：',
    '',
    '$$',
    'x = 1',
    '$$',
    '',
    '脚注[^1] 参考。',
    '',
    '[^1]: 脚注内容。',
    '',
    '![[diagram.png|架构图]] 收尾。',
    '',
    '- 列表项甲',
    '- 列表项乙',
    '',
    '> 普通引用',
  ].join('\n')
  const { body } = splitFrontmatter(md)
  const doc = parseMarkdown(body)
  const m = createPosMapper({ doc, serialize: serializeMarkdownMapped, source: md, base: md.length - body.length })
  assert.ok(!m.exact, '手写格式原文 → 行级回退')
  const srcLines = md.split('\n')
  // 单元格文本不走文本段记账，但应靠行锚点落到所在行（而非表头行）
  const cases = [
    ['标注正文', '> 标注正文 **粗体**。'],
    ['数量', '| 名称 | 数量 |'],
    ['苹果', '| 苹果 | 3 |'],
    ['公式', '公式'],
    ['脚注内容', '[^1]: 脚注内容。'],
    ['收尾', '![[diagram.png|架构图]] 收尾。'],
    ['列表项甲', '- 列表项甲'],
    ['列表项乙', '- 列表项乙'],
    ['普通引用', '> 普通引用'],
  ]
  for (const [needle, expectLine] of cases) {
    const pos = posOfText(doc, needle)
    const off = m.pmToSrc(pos)
    const line = srcLines[lineAt(md, off) - 1]
    assert.ok(line.includes(expectLine), needle + ' 应落在含 ' + JSON.stringify(expectLine) + ' 的行，实际 ' + JSON.stringify(line))
  }
  ok('杂项文档（标注/表格/公式/脚注/嵌入图/列表/引用）行级回退全部落对行')
}

console.log('\n结果：' + pass + ' passed')
