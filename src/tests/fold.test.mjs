// fold.test.mjs —— 标题折叠（fold-plugin.js）纯逻辑回归：范围切分 / 位置平移与剪枝 / 选区避让 / 跳转展开
// 运行：cd src && node tests/fold.test.mjs
//
// 只测不依赖 DOM 的部分：analyzeFolds / toggleFold / unfoldCovering + 插件 state（Decoration 需要 view，不在此测）。

import assert from 'node:assert'
import { EditorState, TextSelection } from 'prosemirror-state'
import { schema, parseMarkdown } from '../editor-schema.js'
import { analyzeFolds, toggleFold, unfoldCovering, foldKey, createFoldPlugin } from '../fold-plugin.js'

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

const st = (md) => {
  const fold = createFoldPlugin()
  return EditorState.create({ schema, doc: parseMarkdown(md), plugins: [fold.plugin] })
}
// 顶层块起点序列（与 analyzeFolds 同一套遍历，用来按标题文本定位）
const headingPos = (state, text) => {
  let found = null
  state.doc.forEach((node, pos) => {
    if (found == null && node.type.name === 'heading' && node.textContent === text) found = pos
  })
  return found
}

// —— analyzeFolds：范围切分 ——
// 表：用例 | 文档 | 目标标题 | 期望可折块数 | 性质
//  1  h1 + 2 段            正例：整节可折
//  2  h1 含子标题          正例：子标题一起收
//  3  止于同级标题          边界：藏到下一个同级标题之前
//  4  止于更高级标题        边界：H3 遇 H2 即止
//  5  文末标题不可折        负例：其下无内容
//  6  无内容（仅标题）      负例：同上
//  7  表格与代码块计入      正例：非段落块同样成项
//  8  引用块算一块          正例：blockquote 作单个顶层块
//  9  引用内的标题不参与    负例：非顶层标题不进 foldable
// 10  标题后紧跟标题        边界：藏 3 块（H2 + 正文 + H3）
// 11  四级标题按级别判定    正例：level 4 亦按 <= 比较
const CASES = [
  ['h1 + 2 段', '# H1\n\n段落一\n\n段落二\n', 'H1', 2],
  ['h1 含子标题', '# H1\n\n## H2\n\n正文\n', 'H1', 2],
  ['止于同级标题', '## A\n\na1\n\n## B\n\nb1\n', 'A', 1],
  ['止于更高级标题', '### C\n\nc1\n\n## B\n\nb1\n', 'C', 1],
  ['文末标题不可折', '# Only\n', 'Only', null],
  ['无内容（仅标题）', '# T\n', 'T', null],
  ['表格与代码块计入', '# H\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n```js\nlet x=1\n```\n', 'H', 2],
  ['引用块算一块', '# H\n\n> 引用\n> 第二行\n\n段落\n', 'H', 2],
  ['引用内的标题不参与', '> ## 内标题\n>\n> 内容\n\n段落\n', '内标题', null],
  ['标题后紧跟标题', '# H1\n\n## H2\n\n正文\n\n## H3\n', 'H1', 3],
  ['四级标题按级别判定', '#### H4\n\nx\n\n### H3\n\ny\n', 'H4', 1],
]
for (const [name, md, target, wantCount] of CASES) {
  t('范围 · ' + name, () => {
    const state = st(md)
    const { foldable } = analyzeFolds(state.doc)
    const pos = headingPos(state, target)
    if (wantCount == null) {
      assert.ok(pos == null || !foldable.has(pos), '不应可折')
      return
    }
    assert.notEqual(pos, null, '找不到目标标题')
    const r = foldable.get(pos)
    assert.ok(r, '应可折')
    assert.equal(r.count, wantCount, '折叠块数')
    // 隐藏区间必须紧接标题之后、且不含下一个同级/更高级标题
    assert.ok(r.hideFrom > pos, 'hideFrom 在标题之后')
    assert.ok(r.textEnd > pos, 'textEnd 在标题内')
    assert.equal(r.items[0][0], r.hideFrom)
    assert.equal(r.items[r.items.length - 1][1], r.hideTo)
  })
}

// —— 插件 state：折叠集合的演进 ——
t('state · 折叠后位置进入集合', () => {
  let state = st('# A\n\na1\n\n# B\n\nb1\n')
  const p = headingPos(state, 'A')
  assert.ok(toggleFold(state, (tr) => { state = state.apply(tr) }, p))
  assert.deepEqual(foldKey.getState(state), [p])
})
t('state · 折叠不进 undo 栈（addToHistory=false）', () => {
  let tr = null
  const state = st('# A\n\na1\n')
  toggleFold(state, (x) => { tr = x }, 0)
  assert.equal(tr.getMeta('addToHistory'), false)
  assert.equal(tr.docChanged, false, '折叠事务不得改文档')
})
t('state · 再点一次展开', () => {
  let s = st('# A\n\na1\n\n# B\n\nb1\n')
  toggleFold(s, (tr) => { s = s.apply(tr) }, 0)
  toggleFold(s, (tr) => { s = s.apply(tr) }, 0)
  assert.deepEqual(foldKey.getState(s), [])
})
t('state · 标题前插入文字后位置平移仍指向该标题', () => {
  let s = st('# A\n\na1\n')
  const p = headingPos(s, 'A')
  toggleFold(s, (tr) => { s = s.apply(tr) }, p)
  // 在文档最前面插一段（折叠集应随之 +新块大小）
  const para = schema.nodes.paragraph.create(null, schema.text('前言'))
  s = s.apply(s.tr.insert(0, para))
  const np = headingPos(s, 'A')
  assert.notEqual(np, p, '标题位置应已移动')
  assert.deepEqual(foldKey.getState(s), [np], '折叠位置应随文档平移')
})
t('state · 删除已折叠的标题后集合剪空', () => {
  let s = st('# A\n\na1\n\n# B\n\nb1\n')
  toggleFold(s, (tr) => { s = s.apply(tr) }, 0)
  assert.equal(foldKey.getState(s).length, 1)
  const p = headingPos(s, 'A')
  const size = s.doc.nodeAt(p).nodeSize
  s = s.apply(s.tr.delete(p, p + size))
  assert.deepEqual(foldKey.getState(s), [], '失效位置须被剪掉')
})
t('state · 不可折（其下无内容）时 toggleFold 返回 false', () => {
  const s = st('# A\n')
  assert.equal(toggleFold(s, () => {}, 0), false)
})
t('state · 非标题块位置 toggleFold 返回 false', () => {
  const s = st('段落\n\n# A\n\na1\n')
  assert.equal(toggleFold(s, () => {}, 0), false, '顶层段落不是标题')
})

// —— 选区避让 ——
t('选区 · 折叠时把落在隐藏区的光标挪到标题末尾', () => {
  let s = st('# A\n\n段落内容\n')
  const inPara = s.doc.content.size - 3
  s = s.apply(s.tr.setSelection(TextSelection.create(s.doc, inPara)))
  toggleFold(s, (tr) => { s = s.apply(tr) }, 0)
  const sel = s.selection.from
  const r = analyzeFolds(s.doc).foldable.get(0)
  assert.ok(sel <= r.hideFrom, '光标应已离开被藏区间')
})
t('选区 · 折叠未涉及的标题不挪光标', () => {
  let s = st('# A\n\na1\n\n# B\n\nb1\n')
  const inB = headingPos(s, 'B')
  s = s.apply(s.tr.setSelection(TextSelection.create(s.doc, inB + 1)))
  const before = s.selection.from
  toggleFold(s, (tr) => { s = s.apply(tr) }, 0) // 折 A
  assert.equal(s.selection.from, before, 'A 的折叠不应动 B 处的光标')
})

// —— 跳转前展开 ——
t('展开 · unfoldCovering 命中被藏位置', () => {
  let s = st('# A\n\na1\n\n段落2\n')
  toggleFold(s, (tr) => { s = s.apply(tr) }, 0)
  const hidden = analyzeFolds(s.doc).foldable.get(0).hideFrom + 2
  const tr = unfoldCovering(s, hidden)
  assert.ok(tr, '应返回展开事务')
  s = s.apply(tr)
  assert.deepEqual(foldKey.getState(s), [])
})
t('展开 · 目标就是标题本身时不返回事务', () => {
  let s = st('# A\n\na1\n')
  toggleFold(s, (tr) => { s = s.apply(tr) }, 0)
  assert.equal(unfoldCovering(s, 0), null)
})
t('展开 · 无折叠时返回 null', () => {
  const s = st('# A\n\na1\n')
  assert.equal(unfoldCovering(s, 5), null)
})
t('展开 · 只展开祖先、保留其它折叠', () => {
  let s = st('# A\n\n## B\n\nb1\n\n# C\n\nc1\n')
  const pb = headingPos(s, 'B')
  toggleFold(s, (tr) => { s = s.apply(tr) }, 0) // 折 A（含 B）
  toggleFold(s, (tr) => { s = s.apply(tr) }, headingPos(s, 'C'))
  assert.equal(foldKey.getState(s).length, 2)
  s = s.apply(unfoldCovering(s, pb + 1))
  assert.deepEqual(foldKey.getState(s), [headingPos(s, 'C')], 'A 展开、C 保持折叠')
})

console.log('\n结果：' + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
