// roundtrip.test.mjs —— Markdown <-> ProseMirror 双向转换回归测试（纯模型，无需浏览器）
// 运行：cd src && node tests/roundtrip.test.mjs
//
// 校验策略：对每个样例做「解析 -> 序列化 -> 再解析 -> 再序列化」，
// 若两次序列化结果一致（幂等），说明转换稳定、无损（不丢内容、不产生私有格式）。

import assert from 'node:assert'
import { load as yamlLoad } from 'js-yaml'
import { parseMarkdown, serializeMarkdown } from '../editor-schema.js'
import { splitFrontmatter, joinFrontmatter, hasYamlDoc } from '../frontmatter.js'

const SAMPLES = {
  headings: '# H1\n## H2\n### H3\n',
  inline: '这是一段 **粗体**、*斜体*、~~删除线~~、`行内代码`、[链接](https://a.b) 混排。\n',
  // 中文标点紧邻强调定界符：CommonMark 的 flanking 规则在这里不构成贴合（收尾 ** 前是全角
  // 标点、后是汉字），editor-schema.js 已按 Typora/Obsidian 的行为放宽，往返须幂等
  cjk_bold_colon: '- 数字图像\n  **总结：**大段说明\n',
  cjk_bold_quote: '这是**「重要」**的内容。\n',
  cjk_bold_curly: '**“注意”**请看这里。\n',
  cjk_strike_colon: '~~提示：~~如下。\n',
  cjk_em_colon: '选*斜体：*这个词。\n',
  quote_list:
    '> 引用第一行\n>\n> 引用第二行\n\n- 无序 a\n- 无序 b\n\n1. 有序一\n2. 有序二\n',
  tasklist: '- [x] 已完成\n- [ ] 未完成\n- 普通项\n',
  codeblock: '```js\nfunction f() {\n  return 1\n}\n```\n',
  image: '![图注](./assets/pic.png "标题")\n',
  wikilink: '参见 [[另一个文档]] 和 [[目标|自定义显示文字]]。\n',
  tag: '本文打标记 #work 和 #study-notes，C# 语言里的井号不应误判。\n',
  table:
    '| 名称 | 数量 | 说明 |\n| --- | :---: | ---: |\n| 苹果 | 3 | 红 |\n| 香蕉 | 10 | 黄 |\n',
  // 批次 5（prosemirror-tables）边界：空单元格 / 仅表头行 / 单元格内联标记，均须幂等
  table_empty: '| A | B | C |\n| --- | --- | --- |\n|  | b |  |\n| x |  | y |\n',
  table_header_only: '| A | B | C |\n| --- | :---: | ---: |\n',
  table_inline: '| 列 | 值 |\n| --- | --- |\n| **粗** | `c` |\n| [链](https://a.b) | ~~删~~ |\n',
  math_inline: '行内公式 $e^{i\\pi}+1=0$ 与 价格 $5 不是公式（开导后空白不匹配）。\n',
  math_block: '块公式：\n\n$$\n\\int_{0}^{\\infty} e^{-x^2}\\,dx = \\frac{\\sqrt{\\pi}}{2}\n$$\n\n正文。\n',
  // 批次 6（Obsidian callout）：标题行 / 折叠标记 / 多块正文 / 空卡片 / 内层行内标记，均须幂等
  callout_basic: '> [!NOTE] 提示标题\n> 这是正文内容。\n',
  callout_fold: '> [!TIP]- 折叠提示\n> 内容行。\n',
  callout_multiblock: '> [!WARNING] 注意\n>\n> 段落一\n>\n> - 列表项\n> - 第二项\n',
  callout_empty: '> [!quote]\n',
  callout_inline: '> [!INFO] 见 [[页]] 与 `code`\n> 正文 **粗** 结尾。\n',
  // 批次 7（mermaid）：```mermaid 围栏作为普通 code_block(params='mermaid') 往返，不丢图定义
  mermaid: '```mermaid\ngraph TD\n  A[开始] --> B{判断}\n  B -->|是| C[处理]\n  B -->|否| D[跳过]\n```\n',
  // 图片附件查看：Obsidian ![[图片]] 嵌入无损往返（裸名 / 带别名 / 带路径）；非图片的 ![[笔记]] 仍走链接
  wiki_img_embed: '![[Pasted image 2026.PNG]]\n',
  wiki_img_alias: '看这张 ![[diagram.png|架构图]] 图\n',
  wiki_img_path: '![[./assets/x.png]]\n',
  wiki_note_embed: '参见 ![[另一篇笔记]] 结尾。\n',
  // 拖拽缩放：Typora 的 `![..](src =宽x)` 与 Obsidian 的 `![[src|宽]]`，尺寸是节点属性、双向幂等
  img_size: '![图注](./assets/pic.png =328x)\n',
  img_size_title: '![图注](./assets/pic.png "标题" =420x)\n',
  img_size_inline: '正文 ![a](x.png =100x) 尾部 ![b](y.png) 结尾\n',
  wiki_img_size: '![[diagram.png|328]]\n',
  wiki_img_size_mixed: '看这张 ![[a.png|架构图]] 和这张 ![[b.png|200]]\n',
  // 功能项 J（脚注）：正文 [^id] 角标 + 文末 [^id]: 定义；往返须幂等（id 稳定、序号不落 md）
  footnote_basic: '正文[^1]结束。\n\n[^1]: 脚注内容。\n',
  footnote_multi: 'A[^a]B[^b]C\n\n[^a]: 甲\n\n[^b]: 乙\n',
  footnote_inline: '带引用[^1]的正文。\n\n[^1]: 注里有 **粗** 和 `code` 与 [[页]]。\n',
  // 批次 F 后续：交叉引用锚点 <a id> + [文本](#id) 内部链接，往返须幂等（锚点是原子节点、不退化为转义文本）
  xref_anchor: '见 [52](#_Ref52) 处。\n\n<a id="_Ref52"></a>文献条目全文\n',
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

// 具体断言：中文标点紧邻的强调落到标记上，序列化原样写回（不把 ** 转义后存盘）
{
  const marksOf = (md) => {
    const marks = []
    parseMarkdown(md).descendants((n) => { if (n.isText) n.marks.forEach((m) => marks.push(m.type.name)) })
    return marks
  }
  assert.ok(marksOf('**总结：**大段').includes('strong'), '全角冒号后的 ** 应构成加粗')
  assert.strictEqual(serializeMarkdown(parseMarkdown('**总结：**大段')), '**总结：**大段', '加粗段序列化不应转义 **')
  assert.ok(marksOf('这是**「重要」**的内容。').includes('strong'), '中文引号邻接的 ** 应构成加粗')
  assert.ok(marksOf('**“注意”**请看').includes('strong'), '弯引号邻接的 ** 应构成加粗')
  assert.ok(marksOf('*斜：*体').includes('em'), '全角冒号邻接的 * 应构成斜体')
  assert.ok(marksOf('~~提示：~~如下').includes('strike'), '全角冒号邻接的 ~~ 应构成删除线')
  // 列表项续行（软换行后的第二行）同样生效
  assert.ok(marksOf('- 数字图像\n  **总结：**大段说明\n').includes('strong'), '列表项续行里的 ** 应构成加粗')
  // 边界：ASCII 标点仍按 CommonMark 不渲染；_ 的词内限制不动
  assert.ok(!marksOf('**foo:**bar').includes('strong'), 'ASCII 冒号邻接仍按 CommonMark 不渲染')
  assert.strictEqual(marksOf('文件_备份').length, 0, '汉字之间的 _ 不构成斜体')
  console.log('✅ 中文标点邻接的强调')
  pass++
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

// 中文标签：字符集与 Rust 侧 is_tag_char 同口径（不一致时全局标签面板有、文档标签面板空）；
// 词中井号（C#）仍不算标签，靠左边界白名单挡住
const cjkTagDoc = parseMarkdown('化学式 #能力/标签 与 C# 语言混排。\n')
const cjkTags = []
cjkTagDoc.descendants((n) => { if (n.type.name === 'tag') cjkTags.push(n.attrs.tag) })
assert.deepStrictEqual(cjkTags, ['能力/标签'], '中文多级标签应解析出且 C# 不误判')
const cjkOnce = serializeMarkdown(cjkTagDoc)
assert.ok(cjkOnce.includes('#能力/标签'), '中文标签序列化应原样写回')
assert.strictEqual(cjkOnce, serializeMarkdown(parseMarkdown(cjkOnce)), '中文标签序列化应幂等')

// 交叉引用锚点：`<a id="…"></a>` 应解析为原子 anchor 节点（而非 html:false 下的转义文本），序列化原样写回
const anchorDoc = parseMarkdown('见 [52](#_Ref52)。\n\n<a id="_Ref52"></a>文献全文\n')
let foundAnchor = false
anchorDoc.descendants((n) => {
  if (n.type.name === 'anchor') {
    foundAnchor = true
    assert.strictEqual(n.attrs.id, '_Ref52', 'anchor id 应无损')
  }
})
assert.ok(foundAnchor, '应解析出 anchor 节点（非转义文本）')
assert.ok(
  serializeMarkdown(anchorDoc).includes('<a id="_Ref52"></a>'),
  'anchor 序列化应原样输出字面 <a id>，不被转义'
)

const mInDoc = parseMarkdown('行内 $x^2$ 公式')
let foundMathIn = false
mInDoc.descendants((n) => { if (n.type.name === 'math_inline') { foundMathIn = true; assert.strictEqual(n.attrs.latex, 'x^2', '行内公式 latex 应无损') } })
assert.ok(foundMathIn, '应解析出 math_inline 节点')

const mBlkDoc = parseMarkdown('$$\nx+y\\ge 0\n$$\n')
let foundMathBlk = false
mBlkDoc.descendants((n) => { if (n.type.name === 'math_block') { foundMathBlk = true; assert.strictEqual(n.attrs.latex, 'x+y\\ge 0', '块公式 latex 应无损') } })
assert.ok(foundMathBlk, '应解析出 math_block 节点')

// 具体断言：callout 节点 attrs 与正文拆分的无损性
{
  const cDoc = parseMarkdown('> [!IMPORTANT] 重要标题\n> 第一行正文\n')
  let callout = null
  cDoc.descendants((n) => { if (n.type.name === 'callout' && !callout) callout = n })
  assert.ok(callout, '应解析出 callout 节点')
  assert.strictEqual(callout.attrs.type, 'IMPORTANT', 'type 应原样保留大小写')
  assert.strictEqual(callout.attrs.title, '重要标题', '标题行应折进 title attr')
  assert.strictEqual(callout.attrs.fold, '', '无折叠标记时 fold 为空')
  assert.ok(callout.textContent.includes('第一行正文'), 'marker 行以下应作为正文块保留')
  // 折叠标记
  const fDoc = parseMarkdown('> [!tip]- 收起\n')
  let fcallout = null
  fDoc.descendants((n) => { if (n.type.name === 'callout' && !fcallout) fcallout = n })
  assert.ok(fcallout && fcallout.attrs.fold === '-', '折叠标记 - 应落入 fold attr')
  assert.ok(fcallout.attrs.type === 'tip', '小写 type 也应保留')
  console.log('✅ callout 节点 attrs/拆分')
  pass++
}

// 具体断言：mermaid 围栏落在 code_block 上且 params 保留 'mermaid'（渲染插件据此识别）
{
  const mDoc = parseMarkdown('> 图：\n\n```mermaid\nflowchart LR\nX-->Y\n```\n')
  let cb = null
  mDoc.descendants((n) => { if (n.type.name === 'code_block' && !cb) cb = n })
  assert.ok(cb, '应解析出 code_block')
  assert.strictEqual((cb.attrs.params || '').trim().split(/\s+/)[0].toLowerCase(), 'mermaid', 'code_block.params 应保留 mermaid')
  assert.ok(cb.textContent.includes('flowchart LR'), '图定义文本应无损保留')
  console.log('✅ mermaid 围栏→code_block params')
  pass++
}

// 具体断言：Obsidian ![[图片]] 嵌入→image 节点且 embed=true；非图片 ![[笔记]] 不当图；普通 ![]() embed=false
{
  const eDoc = parseMarkdown('看这张 ![[diagram.png|架构图]] 图\n')
  let img = null
  eDoc.descendants((n) => { if (n.type.name === 'image' && !img) img = n })
  assert.ok(img, '![[图片]] 应解析为 image 节点')
  assert.strictEqual(img.attrs.embed, true, 'embed 应为 true')
  assert.strictEqual(img.attrs.src, 'diagram.png', 'src 应为目标')
  assert.strictEqual(img.attrs.alt, '架构图', '别名应落入 alt')

  const nDoc = parseMarkdown('参见 ![[另一篇笔记]]。\n')
  let img2 = null
  nDoc.descendants((n) => { if (n.type.name === 'image' && !img2) img2 = n })
  assert.ok(!img2, '非图片的 ![[笔记]] 不应解析为 image')

  const sDoc = parseMarkdown('![图注](./assets/pic.png)\n')
  let img3 = null
  sDoc.descendants((n) => { if (n.type.name === 'image' && !img3) img3 = n })
  assert.ok(img3 && img3.attrs.embed === false, '标准 ![]() 图 embed 应为 false')
  console.log('✅ Obsidian ![[图片]] 嵌入解析/标记')
  pass++
}

// 具体断言：图片尺寸的两种外来形态都落 width attr，且写回原形态；不认的形态整段退让为文本（不改写路径）
{
  const firstImage = (doc) => {
    let img = null
    doc.descendants((n) => { if (n.type.name === 'image' && !img) img = n })
    return img
  }
  const a = parseMarkdown('![图注](./assets/pic.png =328x)\n')
  const ia = firstImage(a)
  assert.ok(ia && ia.attrs.width === 328, '=328x 应落 width')
  assert.strictEqual(ia.attrs.alt, '图注', '带尺寸时 alt 仍取标签')
  assert.strictEqual(serializeMarkdown(a), '![图注](./assets/pic.png =328x)', '写回须是 Typora 尺寸形态')

  const b = parseMarkdown('![图注](./assets/pic.png "标题" =420x)\n')
  const ib = firstImage(b)
  assert.ok(ib && ib.attrs.width === 420 && ib.attrs.title === '标题', '尺寸与 title 共存时都要读到')

  const c = parseMarkdown('![[diagram.png|328]]\n')
  const ic = firstImage(c)
  assert.ok(ic && ic.attrs.embed === true && ic.attrs.width === 328, '![[src|宽]] 应落 width')
  assert.strictEqual(ic.attrs.alt, 'diagram.png', '纯数字段是宽度，不当别名')
  assert.strictEqual(serializeMarkdown(c), '![[diagram.png|328]]', '写回须是 Obsidian 尺寸形态')

  const d = parseMarkdown('![[diagram.png|300x200]]\n')
  const id = firstImage(d)
  assert.ok(id && id.attrs.width === null && id.attrs.alt === '300x200', '宽高同时写死不接，原样留作别名')
  assert.strictEqual(serializeMarkdown(d), '![[diagram.png|300x200]]', '不接的形态不得改写')

  for (const md of ['![a](pic.png =50%)\n', '![a](pic.png =328x200)\n']) {
    const e = parseMarkdown(md)
    assert.ok(!firstImage(e), md.trim() + ' 不该被当成图片')
    const o1 = serializeMarkdown(e)
    assert.strictEqual(o1, serializeMarkdown(parseMarkdown(o1)), '退让为文本后仍需幂等')
  }

  const f = parseMarkdown('![a](p\\(1.png =100x)\n')
  const ifile = firstImage(f)
  assert.ok(ifile && ifile.attrs.width === 100, '路径含转义括号时尺寸照常生效')
  assert.strictEqual(serializeMarkdown(f), '![a](p\\(1.png =100x)', '转义不得被二次编码（与默认规则同一处理）')
  console.log('✅ 图片尺寸 =宽x / |宽 解析与写回')
  pass++
}

// 具体断言：表格对齐属性无损 + prosemirror-tables 结构 attrs 默认值齐备
{
  const tDoc = parseMarkdown(SAMPLES.table)
  const aligns = []
  let cellShapeOk = true
  tDoc.descendants((n) => {
    if (n.type.name === 'table_header' || n.type.name === 'table_cell') {
      aligns.push(n.attrs.alignment)
      if (n.attrs.colspan !== 1 || n.attrs.rowspan !== 1 || n.attrs.colwidth !== null) cellShapeOk = false
    }
  })
  // 表头三列对齐依次是 null(默认左)、center、right
  assert.deepStrictEqual(aligns.slice(0, 3), [null, 'center', 'right'], '对齐分隔行应解析到 alignment 属性')
  assert.ok(cellShapeOk, 'cell 应带 colspan=1/rowspan=1/colwidth=null（prosemirror-tables 依赖）')
  console.log('✅ table 对齐/结构 attrs')
  pass++
}

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

// —— hasYamlDoc：判定「有没有可解析的文档」（js-yaml 5.4 对空/纯注释输入抛错，面板据此免误报）——
const YD_CASES = [
  ['', false],
  ['   \n\t\n', false],
  ['# 只有注释\n# 两行\n', false],
  ['   # 缩进的注释\n', false],
  ['title: x\n', true],
  ['# 注释\ntitle: x\n', true],
  ['a: 1 # 行尾注释\n', true],
  ['null\n', true],
  ['- 1\n- 2\n', true],
]
for (const [text, want] of YD_CASES) {
  assert.strictEqual(hasYamlDoc(text), want, `hasYamlDoc(${JSON.stringify(text)}) 应为 ${want}`)
  // 与真实依赖对齐：判定为有文档的，js-yaml 必须能 load；判定为空的，js-yaml 正是抛错的那类
  let throws = false
  try { yamlLoad(text) } catch (_) { throws = true }
  assert.strictEqual(throws, !want, `hasYamlDoc 与 js-yaml 行为不一致：${JSON.stringify(text)}`)
  pass++
}
console.log('✅ hasYamlDoc 判定（含与 js-yaml 一致性）')

// 未闭合围栏 / CRLF / BOM 等边界不误判
assert.strictEqual(hasYamlDoc('title: "a\nb"\n'), true, '跨行引号值仍算有文档')
assert.strictEqual(hasYamlDoc(null), false, 'null 输入视为空')
assert.strictEqual(hasYamlDoc(undefined), false, 'undefined 输入视为空')
assert.strictEqual(hasYamlDoc('\r\n  \r\n'), false, 'CRLF 全空白视为空')
pass += 4
console.log('✅ hasYamlDoc 边界')

console.log(`\n结果：${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
