// docx-export.test.mjs —— 批次 F ①：ProseMirror doc → Docx-IR 序列化器回归测试（纯模型，无需浏览器）
// 运行：cd src && node tests/docx-export.test.mjs
//
// 校验：docToIR 输出的 block/inline 形状与 Rust 侧 docx_export.rs 的 serde 契约一致
// （type 判别、camelCase、方言降级：wikilink→文字、tag→#文字、math→纯文本、footnote→数字 id）。

import assert from 'node:assert'
import { mdToIR, docToIR } from '../docx-export.js'
import { schema } from '../editor-schema.js'

const SAMPLE = [
  '# 一级标题',
  '## 二级标题',
  '',
  '这是一段 **粗体**、*斜体*、~~删除线~~、`行内码`、[链接](https://a.b)、参见 [[另一页|别名]]、标签 #work。',
  '',
  '- 无序甲',
  '- 无序乙',
  '',
  '1. 有序一',
  '2. 有序二',
  '',
  '- [x] 已完成',
  '- [ ] 未完成',
  '',
  '> 引用第一行',
  '',
  '```js',
  'const x = 1',
  '```',
  '',
  '| 名称 | 数量 |',
  '| --- | --- |',
  '| 苹果 | 3 |',
  '| 香蕉 | 10 |',
  '',
  '行内公式 $e^{i\\pi}+1=0$ 与脚注引用[^1]。',
  '',
  '[^1]: 脚注正文。',
].join('\n')

const ir = mdToIR(SAMPLE)
const blocks = ir.blocks

const find = (pred) => blocks.find(pred)
const all = (pred) => blocks.filter(pred)
// 收集所有块（含列表项/表格单元格）里的行内单元，便于跨段断言
const allInlines = []
for (const b of blocks) {
  if (b.inline) allInlines.push(...b.inline)
  if (b.items) for (const it of b.items) allInlines.push(...(it.inline || []))
}

// 标题
const h1 = find((b) => b.type === 'heading' && b.level === 1)
assert.ok(h1, 'expected h1')
assert.strictEqual(h1.inline[0].text, '一级标题')
const h2 = find((b) => b.type === 'heading' && b.level === 2)
assert.ok(h2, 'expected h2')

// 段落行内标记
const para = find(
  (b) => b.type === 'paragraph' && b.inline.some((i) => i.bold && i.text === '粗体'),
)
assert.ok(para, 'bold run missing')
assert.ok(para.inline.some((i) => i.italic && i.text === '斜体'), 'italic missing')
assert.ok(para.inline.some((i) => i.strike && i.text === '删除线'), 'strike missing')
assert.ok(para.inline.some((i) => i.code && i.text === '行内码'), 'inline code missing')
assert.ok(
  para.inline.some((i) => i.link === 'https://a.b' && i.text === '链接'),
  'link missing: ' + JSON.stringify(para.inline),
)
// wikilink 降级为文字（别名优先）
assert.ok(para.inline.some((i) => i.text === '别名'), 'wikilink not degraded to label')
// tag 降级为 #文字
assert.ok(para.inline.some((i) => i.text === '#work'), 'tag not degraded')
// 行内数学降级为纯文本 + math 标志
assert.ok(
  allInlines.some((i) => i.math === true && /e\^/.test(i.text)),
  'math_inline not degraded: ' + JSON.stringify(allInlines),
)
// 脚注引用降级为数字 footnote
assert.ok(allInlines.some((i) => typeof i.footnote === 'number'), 'footnote ref missing')

// 列表
const bullets = find((b) => b.type === 'list' && b.ordered === false && b.items.some((i) => i.inline[0] && i.inline[0].text === '无序甲'))
assert.ok(bullets, 'bullet list missing')
const ordered = find((b) => b.type === 'list' && b.ordered === true)
assert.ok(ordered, 'ordered list missing')
// 任务项 checked 透传
const tasks = all((b) => b.type === 'list').flatMap((l) => l.items)
assert.ok(tasks.some((i) => i.checked === true), 'checked task missing')
assert.ok(tasks.some((i) => i.checked === false), 'unchecked task missing')

// 引用 → Quote
assert.ok(find((b) => b.type === 'quote' && b.inline.some((i) => /引用第一行/.test(i.text))), 'quote missing')

// 代码围栏 + lang
const code = find((b) => b.type === 'code')
assert.ok(code && code.lang === 'js' && /const x = 1/.test(code.text), 'code block missing/wrong lang')

// 表格
const table = find((b) => b.type === 'table')
assert.ok(table, 'table missing')
assert.ok(table.header && table.header.length === 2, 'table header wrong')
assert.strictEqual(table.header[0][0].text, '名称')
assert.strictEqual(table.rows.length, 2, 'table data rows wrong')
assert.strictEqual(table.rows[1][0][0].text, '香蕉')

// 脚注定义
const fndef = find((b) => b.type === 'footnoteDef')
assert.ok(fndef && typeof fndef.id === 'number', 'footnoteDef missing')
assert.ok(fndef.inline.some((i) => /脚注正文/.test(i.text)), 'footnoteDef text missing')

// 引用与定义序号一致
const refId = allInlines.find((i) => typeof i.footnote === 'number').footnote
assert.strictEqual(refId, fndef.id, 'footnote ref/def id mismatch')

// 回归：活文档里的空 id 孤立 footnote_item 不得让 footnoteDef.id 变成 null
// （否则 Rust FootnoteDef.id(usize) 反序列化报「invalid type: null, expected usize」，整个导出崩）。
const orphanDoc = schema.nodeFromJSON({
  type: 'doc',
  content: [
    {
      type: 'footnote_section',
      content: [
        { type: 'footnote_item', attrs: { id: '' }, content: [{ type: 'paragraph', content: [{ type: 'text', text: '孤立定义' }] }] },
        { type: 'footnote_item', attrs: { id: '1' }, content: [{ type: 'paragraph', content: [{ type: 'text', text: '正常定义' }] }] },
      ],
    },
  ],
})
const orphanDefs = docToIR(orphanDoc).blocks.filter((b) => b.type === 'footnoteDef')
assert.ok(orphanDefs.every((d) => typeof d.id === 'number'), 'footnoteDef.id 必须是数字（空 id 应被跳过）')
assert.strictEqual(orphanDefs.length, 1, '空 id 的孤立定义应被跳过，只保留正常那条')

console.log('docx-export.test.mjs: 全部通过（block 数=' + blocks.length + '）')
