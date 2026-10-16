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

console.log(`anchor-link: ${expectAnchors.length} 锚点映射 ✓`)
