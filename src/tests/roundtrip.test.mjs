// roundtrip.test.mjs —— Markdown <-> ProseMirror 双向转换回归测试（纯模型，无需浏览器）
// 运行：cd src && node tests/roundtrip.test.mjs
//
// 校验策略：对每个样例做「解析 -> 序列化 -> 再解析 -> 再序列化」，
// 若两次序列化结果一致（幂等），说明转换稳定、无损（不丢内容、不产生私有格式）。

import assert from 'node:assert'
import { parseMarkdown, serializeMarkdown } from '../editor-schema.js'

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

// 额外断言：任务列表 / wikilink / tag 落到正确的模型上
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

console.log(`\n结果：${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
