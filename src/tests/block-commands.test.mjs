// block-commands.test.mjs —— 块类型命令的模型级回归（转换 / 包裹 / 追加 / 任务项 / 非法选区拒答）
// 运行：cd src && node tests/block-commands.test.mjs
//
// 只跑 EditorState（无 view）：命令签名 (state, dispatch, view)，dispatch 传 undefined 即「能否执行」查询。

import assert from 'node:assert'
import { EditorState, TextSelection, NodeSelection } from 'prosemirror-state'
import { schema, parseMarkdown, serializeMarkdown } from '../editor-schema.js'
import { BLOCK_COMMANDS, activeBlockKey, headingStep, createTable, insertTable } from '../block-commands.js'

let pass = 0
let fail = 0
function t(name, fn) {
  try {
    fn()
    pass++
    console.log('  ok   ' + name)
  } catch (e) {
    fail++
    console.log('  FAIL ' + name + ' —— ' + ((e && e.message) || e))
  }
}

// 光标放到「文本里第一个 anchor 处」的块上
function stateAt(md, anchor) {
  const doc = parseMarkdown(md)
  let pos = null
  doc.descendants((node, p) => {
    if (pos != null || !node.isText) return
    const i = node.text.indexOf(anchor)
    if (i >= 0) pos = p + i + 1
  })
  assert.notEqual(pos, null, '找不到锚点 ' + anchor)
  const st = EditorState.create({ schema, doc, selection: TextSelection.create(doc, pos) })
  return st
}

function run(st, cmd) {
  let applied = null
  const ok = cmd(st, (tr) => { applied = tr }, null)
  return { ok, md: applied ? serializeMarkdown(st.apply(applied).doc) : null }
}

t('h2：段落转标题且保留行内内容', () => {
  const r = run(stateAt('普通段落 anchor 文字\n\n下一段\n', 'anchor'), BLOCK_COMMANDS.h2)
  assert.equal(r.ok, true)
  assert.equal(r.md, '## 普通段落 anchor 文字\n\n下一段')
})

t('para：标题退回正文', () => {
  const r = run(stateAt('## 标题 anchor\n', 'anchor'), BLOCK_COMMANDS.para)
  assert.equal(r.md, '标题 anchor')
})

t('h1/h3 层级正确', () => {
  assert.equal(run(stateAt('段落 anchor\n', 'anchor'), BLOCK_COMMANDS.h1).md, '# 段落 anchor')
  assert.equal(run(stateAt('段落 anchor\n', 'anchor'), BLOCK_COMMANDS.h3).md, '### 段落 anchor')
})

t('quote：包成引用，内容不丢', () => {
  const r = run(stateAt('段落 anchor\n', 'anchor'), BLOCK_COMMANDS.quote)
  assert.equal(r.md, '> 段落 anchor')
})

t('code：转围栏代码块', () => {
  const r = run(stateAt('段落 anchor\n', 'anchor'), BLOCK_COMMANDS.code)
  assert.equal(r.md, '```\n段落 anchor\n```')
})

t('mermaid：当前块变 mermaid 围栏', () => {
  const r = run(stateAt('段落 anchor\n', 'anchor'), BLOCK_COMMANDS.mermaid)
  assert.equal(r.md, '```mermaid\n段落 anchor\n```')
})

t('bullet：包成无序列表', () => {
  const r = run(stateAt('段落 anchor\n', 'anchor'), BLOCK_COMMANDS.bullet)
  assert.equal(r.md, '* 段落 anchor')
})

t('ordered：包成有序列表', () => {
  const r = run(stateAt('段落 anchor\n', 'anchor'), BLOCK_COMMANDS.ordered)
  assert.equal(r.md, '1. 段落 anchor')
})

t('task：普通段落 → 任务项（未勾）', () => {
  const r = run(stateAt('段落 anchor\n', 'anchor'), BLOCK_COMMANDS.task)
  assert.equal(r.md, '* [ ] 段落 anchor')
})

t('task：多块选区 → 合成一个列表（两项）', () => {
  const doc = parseMarkdown('第一段 anchorA\n\n第二段 anchorB\n')
  const st = EditorState.create({ schema, doc, selection: TextSelection.create(doc, 3, doc.content.size - 3) })
  const r = run(st, BLOCK_COMMANDS.task)
  assert.equal(r.md, '* [ ] 第一段 anchorA\n\n* [ ] 第二段 anchorB')
})

t('bullet：表格里拒绝（非法位置返回 false，不改模型）', () => {
  const st = stateAt('| a | b |\n| - | - |\n| c | anchor |\n', 'anchor')
  const before = serializeMarkdown(st.doc)
  const r = run(st, BLOCK_COMMANDS.bullet)
  assert.equal(r.ok, false)
  assert.equal(r.md, null)
  assert.equal(serializeMarkdown(st.doc), before)
})

t('task：已在列表内 → 只加复选框，不套第二层列表', () => {
  const r = run(stateAt('- 段落 anchor\n', 'anchor'), BLOCK_COMMANDS.task)
  assert.equal(r.md, '* [ ] 段落 anchor')
})

t('task：已是任务项 → 幂等（仍为未勾）', () => {
  const r = run(stateAt('- [ ] 段落 anchor\n', 'anchor'), BLOCK_COMMANDS.task)
  assert.equal(r.md, '* [ ] 段落 anchor')
})

t('task：勾状态不被抹掉（[x] 保持 [x]）', () => {
  const r = run(stateAt('- [x] 段落 anchor\n', 'anchor'), BLOCK_COMMANDS.task)
  assert.equal(r.md, '* [x] 段落 anchor')
})

t('hr：分割线追加在当前块之后，原文不丢', () => {
  const r = run(stateAt('段落 anchor\n\n下一段\n', 'anchor'), BLOCK_COMMANDS.hr)
  assert.equal(r.md, '段落 anchor\n\n---\n\n下一段')
})

t('table：追加 2×2 表', () => {
  const r = run(stateAt('段落 anchor\n', 'anchor'), BLOCK_COMMANDS.table)
  assert.ok(r.md.includes('|'), r.md)
  assert.ok(r.md.startsWith('段落 anchor\n'), r.md)
  assert.equal(serializeMarkdown(parseMarkdown(r.md)), r.md, '表格应可无损往返')
})

t('createTable：N×M 结构（首行表头，其余单元格）', () => {
  const tb = createTable(3, 4)
  assert.equal(tb.type.name, 'table')
  assert.equal(tb.childCount, 3)
  assert.equal(tb.firstChild.childCount, 4)
  assert.equal(tb.firstChild.firstChild.type.name, 'table_header')
  assert.equal(tb.lastChild.firstChild.type.name, 'table_cell')
})

t('insertTable：按选中尺寸追加（3×4 → 表头 + 分隔行 + 2 数据行），可无损往返', () => {
  const r = run(stateAt('段落 anchor\n', 'anchor'), (st, d) => insertTable(st, d, 3, 4))
  assert.equal(r.ok, true)
  const lines = r.md.split('\n').filter((l) => l.startsWith('|'))
  assert.equal(lines.length, 4)
  assert.equal(lines[0].split('|').length - 2, 4) // 每行 4 格
  assert.equal(serializeMarkdown(parseMarkdown(r.md)), r.md)
})

t('callout：追加提示卡片', () => {
  const r = run(stateAt('段落 anchor\n', 'anchor'), BLOCK_COMMANDS.callout)
  assert.ok(r.md.includes('NOTE'), r.md)
  assert.ok(r.md.startsWith('段落 anchor\n'), r.md)
})

t('dispatch=undefined 时只查询、不产生副作用', () => {
  const st = stateAt('段落 anchor\n', 'anchor')
  const before = serializeMarkdown(st.doc)
  assert.equal(BLOCK_COMMANDS.h2(st, undefined, null), true)
  assert.equal(serializeMarkdown(st.doc), before)
})

t('代码块内不重复转换：mermaid 围栏仍可由 code_block 命中', () => {
  const r = run(stateAt('```js\nvar anchor = 1\n```\n', 'anchor'), BLOCK_COMMANDS.mermaid)
  assert.equal(r.md, '```mermaid\nvar anchor = 1\n```')
})

t('表格单元格内不崩：命令返回布尔且模型仍可序列化', () => {
  const md = '| a | b |\n| - | - |\n| c | anchor |\n'
  const r = run(stateAt(md, 'anchor'), BLOCK_COMMANDS.h2)
  assert.ok(r.ok === true || r.ok === false)
  if (r.md != null) assert.equal(serializeMarkdown(parseMarkdown(r.md)), r.md)
})

t('未知：BLOCK_COMMANDS 的键全覆盖且皆为函数', () => {
  for (const [k, v] of Object.entries(BLOCK_COMMANDS)) {
    assert.equal(typeof v, 'function', k + ' 不是命令')
  }
  const ids = Object.keys(BLOCK_COMMANDS).sort()
  assert.deepEqual(ids, ['bullet', 'callout', 'code', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'mermaid', 'ordered', 'para', 'quote', 'table', 'task'])
})

// —— activeBlockKey：当前块类型（mac「段落」菜单的勾）——
// 表：用例 | 文档 | 光标 | 期望键 | 性质
//  1  普通段落 / 二~六级标题        para / h2 / h4 / h6   正例（标题补齐到六级）
//  2  引用块                       quote                  正例
//  3  普通围栏 / mermaid 围栏        code / mermaid         正例（同一节点靠 params 分流）
//  4  无序 / 有序 / 任务列表          bullet / ordered / task 正例
//  5  表格单元格内 / 提示卡片内        table / callout        正例
//  6  引用里的标题                   quote                  边界：内层优先，不报 h2
//  7  列表项里的段落                  bullet                 边界：不报 para
//  8  NodeSelection 点选分割线        hr                     正例（叶子块）
//  9  NodeSelection 点选公式块        null                   负例：项表里没有这类块
//  10 标题升 / 降级正常移动            # ↔ ######             正例
//  11 一 / 六级端点越界               拒                     边界：菜单据此置灰
//  12 非标题块升降 / 引用内标题        拒 / 生效                负例 + 边界
const AK = (md, anchor) => activeBlockKey(stateAt(md, anchor))
t('当前块：正文与各级标题', () => {
  assert.equal(AK('普通段落 anchor\n', 'anchor'), 'para')
  assert.equal(AK('## 二级 anchor\n', 'anchor'), 'h2')
  assert.equal(AK('#### 四级 anchor\n', 'anchor'), 'h4')
  assert.equal(AK('###### 六级 anchor\n', 'anchor'), 'h6')
})
t('当前块：引用 / 代码块 / Mermaid（同节点按 params 分流）', () => {
  assert.equal(AK('> 引用 anchor\n', 'anchor'), 'quote')
  assert.equal(AK('```js\nvar anchor = 1\n```\n', 'anchor'), 'code')
  assert.equal(AK('```mermaid\ngraph LR; anchor-->B\n```\n', 'anchor'), 'mermaid')
})
t('当前块：无序 / 有序 / 任务列表', () => {
  assert.equal(AK('- 普通项 anchor\n', 'anchor'), 'bullet')
  assert.equal(AK('1. 有序项 anchor\n', 'anchor'), 'ordered')
  assert.equal(AK('- [ ] 任务项 anchor\n', 'anchor'), 'task')
})
t('当前块：表格单元格与提示卡片（内层优先）', () => {
  assert.equal(AK('| a | b |\n| - | - |\n| c | anchor |\n', 'anchor'), 'table')
  assert.equal(AK('> [!note] 标题\n> 卡片正文 anchor\n', 'anchor'), 'callout')
})
t('边界：引用里的标题算引用、列表项里的段落算列表', () => {
  assert.equal(AK('> ## 标题 anchor\n', 'anchor'), 'quote')
  assert.equal(AK('- 项目 anchor\n', 'anchor'), 'bullet')
})
t('正例：NodeSelection 点选分割线读作 hr', () => {
  const doc = parseMarkdown('上文\n\n---\n\n下文 anchor\n')
  let at = null
  doc.forEach((node, pos) => {
    if (at == null && node.type.name === 'horizontal_rule') at = pos
  })
  assert.notEqual(at, null, '文档里没有分割线')
  const st = EditorState.create({ schema, doc, selection: NodeSelection.create(doc, at) })
  assert.equal(activeBlockKey(st), 'hr')
})
t('负例：点选公式块这类不在项表里的顶层块 → null 且不抛（位置落在块之间）', () => {
  const doc = parseMarkdown('$$\nx^2\n$$\n\n下文 anchor\n')
  let at = null
  doc.forEach((node, pos) => {
    if (at == null && node.type.name === 'math_block') at = pos
  })
  assert.notEqual(at, null, '文档里没有公式块')
  const st = EditorState.create({ schema, doc, selection: NodeSelection.create(doc, at) })
  assert.equal(activeBlockKey(st), null)
})

// —— headingStep：提升 / 降低标题级别 ——
t('提升 / 降级：层级正确移动并保留内容', () => {
  assert.equal(run(stateAt('## 标题 anchor\n', 'anchor'), headingStep(-1)).md, '# 标题 anchor')
  assert.equal(run(stateAt('#### 标题 anchor\n', 'anchor'), headingStep(1)).md, '##### 标题 anchor')
})
t('边界：一~六级为端点，越界即拒（菜单据此置灰）', () => {
  assert.equal(run(stateAt('# 标题 anchor\n', 'anchor'), headingStep(-1)).ok, false)
  assert.equal(run(stateAt('###### 标题 anchor\n', 'anchor'), headingStep(1)).ok, false)
})
t('负例：非标题块拒答；引用内的标题仍可升降', () => {
  assert.equal(run(stateAt('正文 anchor\n', 'anchor'), headingStep(-1)).ok, false)
  assert.equal(run(stateAt('> ## 标题 anchor\n', 'anchor'), headingStep(1)).md, '> ### 标题 anchor')
})

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
