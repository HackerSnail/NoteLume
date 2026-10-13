// roundtrip.test.mjs —— Markdown <-> ProseMirror 双向转换回归测试（纯模型，无需浏览器）
// 运行：cd src && node tests/roundtrip.test.mjs
//
// 校验策略：对每个样例做「解析 -> 序列化 -> 再解析 -> 再序列化」，
// 若两次序列化结果一致（幂等），说明转换稳定、无损（不丢内容、不产生私有格式）。

import assert from 'node:assert'
import { parseMarkdown, serializeMarkdown } from '../editor-schema.js'
import { splitFrontmatter, joinFrontmatter } from '../frontmatter.js'

const SAMPLES = {
  headings: '# H1\n## H2\n### H3\n',
  inline: '这是一段 **粗体**、*斜体*、~~删除线~~、`行内代码`、[链接](https://a.b) 混排。\n',
  quote_list:
    '> 引用第一行\n>\n> 引用第二行\n\n- 无序 a\n- 无序 b\n\n1. 有序一\n2. 有序二\n',
  tasklist: '- [x] 已完成\n- [ ] 未完成\n- 普通项\n',
  codeblock: '```js\nfunction f() {\n  return 1\n}\n```\n',
  image: '![图注](./assets/pic.png "标题")\n',
  wikilink: '参见 [[另一个文档]] 和 [[目标|自定义显示文字]]。\n',
  tag: '本文打标记 #work 和 #study-notes，C# 语言里的井号不应误判。\n',
  table:
    '| 名称 | 数量 | 说明 |\n| --- | :---: | ---: |\n| 苹果 | 3 | 红 |\n| 香蕉 | 10 | 黄 |\n',
  math_inline: '行内公式 $e^{i\\pi}+1=0$ 与 价格 $5 不是公式（开导后空白不匹配）。\n',
  math_block: '块公式：\n\n$$\n\\int_{0}^{\\infty} e^{-x^2}\\,dx = \\frac{\\sqrt{\\pi}}{2}\n$$\n\n正文。\n',
  combined:
    '# 总览\n\n前言文字 [[页A]] #idx\n\n| A | B |\n| --- | --- |\n| 1 | ~~2~~ |\n\n- [x] done\n',
}

let pass = 0
let fail = 0
for (const [name, md] of Object.entries(SAMPLES)) {
  try {
    const doc1 = parseMarkdown(md)
    const out1 = serializeMarkdown(doc1)
    const doc2 = parseMarkdown(out1)
    const out2 = serializeMarkdown(doc2)
    assert.strictEqual(out1, out2, `幂等失败：\n--- out1 ---\n${out1}\n--- out2 ---\n${out2}`)
    console.log(`✅ ${name}`)
    pass++
  } catch (e) {
    console.error(`❌ ${name}: ${e.message}`)
    fail++
  }
}

// 额外断言：任务列表 / wikilink / tag / 行内公式 / 块公式 落到正确的模型上
const taskDoc = parseMarkdown('- [x] A\n- [ ] B\n')
const firstItem = taskDoc.firstChild.firstChild
assert.strictEqual(firstItem.attrs.checked, true, '任务项 checked 应为 true')

const wikiDoc = parseMarkdown('[[文档X]]')
let foundWiki = false
wikiDoc.descendants((n) => { if (n.type.name === 'wikiLink') foundWiki = true })
assert.ok(foundWiki, '应解析出 wikiLink 节点')

const tagDoc = parseMarkdown('#tag1 普通 #nothash')
let foundTag = false
tagDoc.descendants((n) => { if (n.type.name === 'tag') foundTag = true })
assert.ok(foundTag, '应解析出 tag 节点')

const mInDoc = parseMarkdown('行内 $x^2$ 公式')
let foundMathIn = false
mInDoc.descendants((n) => { if (n.type.name === 'math_inline') { foundMathIn = true; assert.strictEqual(n.attrs.latex, 'x^2', '行内公式 latex 应无损') } })
assert.ok(foundMathIn, '应解析出 math_inline 节点')

const mBlkDoc = parseMarkdown('$$\nx+y\\ge 0\n$$\n')
let foundMathBlk = false
mBlkDoc.descendants((n) => { if (n.type.name === 'math_block') { foundMathBlk = true; assert.strictEqual(n.attrs.latex, 'x+y\\ge 0', '块公式 latex 应无损') } })
assert.ok(foundMathBlk, '应解析出 math_block 节点')

// —— frontmatter 剥离/补回：字节级往返 + 幂等 ——
const FM_CASES = [
  '---\ntitle: Hi\ntags: [a, b]\n---\n\n正文一\n',
  '---\na: 1\n---\nbody',
  '# 无 frontmatter，正文以标题开头\n---\n分隔线\n',
  '---\n# 注释\nc: 3  # 行尾注释\n---\n\nbody\n',
  '---\n---\nbody\n',
  '---\nunclosed: 1\n正文没有收尾围栏\n',
]
for (const md of FM_CASES) {
  try {
    const { yaml } = splitFrontmatter(md)
    const joined = joinFrontmatter(yaml, splitFrontmatter(md).body)
    const second = splitFrontmatter(joined)
    const again = joinFrontmatter(second.yaml, second.body)
    assert.strictEqual(joined, again, `frontmatter 往返不幂等：\n${joined}\n---\n${again}`)
    // 能识别 frontmatter 的，补回后应与原文逐字节相等（保留原文）
    if (yaml != null) assert.strictEqual(joined, md, `应原样还原：\n${joined}\n≠\n${md}`)
    else assert.strictEqual(joined, md, `无 fm 情形不应改动原文`)
    console.log('✅ frontmatter 往返')
    pass++
  } catch (e) {
    console.error(`❌ frontmatter(${JSON.stringify(md)}): ${e.message}`)
    fail++
  }
}
// 具体断言：正常剥离与 body 归属
{
  const { yaml, body } = splitFrontmatter('---\ntitle: Hi\n---\n\n正文\n')
  assert.strictEqual(yaml, 'title: Hi\n', '应剥离出 yaml 原文（不含围栏）')
  assert.strictEqual(body, '\n正文\n', 'body 为闭合围栏之后')
  assert.strictEqual(joinFrontmatter(yaml, body), '---\ntitle: Hi\n---\n\n正文\n', '补回应与原文一致')
}
// 未闭合：当作无 frontmatter，正文不被吞
{
  const { yaml, body } = splitFrontmatter('---\nunclosed: 1\n正文\n')
  assert.strictEqual(yaml, null, '未闭合应识别为无 frontmatter')
  assert.strictEqual(body, '---\nunclosed: 1\n正文\n', '原文不动')
}
// 空 yaml 也能无损往返
{
  const { yaml, body } = splitFrontmatter('---\n---\nbody\n')
  assert.strictEqual(yaml, '')
  assert.strictEqual(joinFrontmatter(yaml, body), '---\n---\nbody\n')
}

console.log(`\n结果：${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
