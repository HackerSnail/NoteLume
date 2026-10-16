// anchor-link.test.mjs —— 批次 F 后续：编辑器 #锚点 点击跳转的锚点表（纯函数半边）。
// 运行：cd src && node tests/anchor-link.test.mjs
//
// 用 parseMarkdown 造含多标题（重名 / CJK / 标点）的 PM doc，断言 buildAnchorMap：
//  1) key 集合与顺序 = slugAllInOrder(标题纯文本)（与导入/站点同一套 dedup 规则）；
//  2) 每个 key 的 pos = 该标题节点在 doc 顶层的偏移（与大纲 jumpToPos 语义一致）。

import assert from 'node:assert'
import { parseMarkdown } from '../editor-schema.js'
import { slugAllInOrder } from '../heading-anchor.js'
import { buildAnchorMap } from '../anchor-link.js'

const MD = [
  '# Intro',
  '## 使用 指南',
  '## 使用 指南',
  '### Foo, Bar!',
  '正文段落，不是标题。',
  '# Intro',
  '',
].join('\n')

const doc = parseMarkdown(MD)

// 期望锚点（首现无后缀，重名按文档序加 -1/-2）
const expectAnchors = ['intro', '使用-指南', '使用-指南-1', 'foo-bar', 'intro-1']

const map = buildAnchorMap(doc)
assert.deepStrictEqual([...map.keys()], expectAnchors, '锚点集合与顺序应与 slugAllInOrder 一致')

// 顶层标题按序的 pos（独立复算，验证 value 而非仅 key）
const headPos = []
doc.forEach((node, pos) => { if (node.type.name === 'heading') headPos.push(pos) })
assert.strictEqual(headPos.length, expectAnchors.length, '标题数量应与锚点数量一致')
for (let i = 0; i < expectAnchors.length; i++) {
  assert.strictEqual(map.get(expectAnchors[i]), headPos[i], `${expectAnchors[i]} 的 pos 应为第 ${i} 个标题`)
}

// 非标题文本不应进入锚点表
assert.ok(!map.has('正文段落不是标题'), '段落不应成为锚点')

// —— 交叉引用锚点节点（`<a id>`，非标题目标）也应进入锚点表，以字面 id 为 key ——
const MD2 = ['# 引言', '见 [52](#_Ref52)。', '', '<a id="_Ref52"></a>文献条目全文', ''].join('\n')
const doc2 = parseMarkdown(MD2)
const map2 = buildAnchorMap(doc2)
assert.ok(map2.has('引言'), '标题 slug 仍应进入锚点表')
assert.ok(map2.has('_Ref52'), 'anchor 节点 id 应进入锚点表')
// anchor pos 与 doc.descendants 独立复算的偏移一致（跳转处 +1 落在目标文本起始）
let anchorPos = -1
doc2.descendants((n, p) => {
  if (n.type.name === 'anchor' && n.attrs.id === '_Ref52') anchorPos = p
})
assert.ok(anchorPos >= 0, '应找到 anchor 节点')
assert.strictEqual(map2.get('_Ref52'), anchorPos, 'anchor pos 应等于 descendants 给出的偏移')

console.log(`anchor-link: ${expectAnchors.length} 标题锚点 + 交叉引用锚点 ✓`)
