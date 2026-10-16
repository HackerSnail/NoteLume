// anchor-link.js —— 文档内 `#锚点` 链接的点击跳转（编辑器 WYSIWYG 侧）。
//
// 为什么需要：docx 导入把 Word 交叉引用（REF 指向标题）转成 `[可见文本](#slug)`，站点导出给标题发
// `id=slug`，二者共用 heading-anchor.js 的同一套 slug 规则。但编辑器此前无 `#` 点击处理 → 内部锚点是
// 死链。本模块补齐「编辑器」这一边：点 `[文本](#slug)` 时按同一规则反查标题位置并跳转，令三处联动闭合。
//
// 纯函数 buildAnchorMap 只依赖 ProseMirror doc（顶层标题遍历 + slugAllInOrder），可脱离 DOM 单测；
// 位置语义与大纲跳转完全一致（doc.forEach 给出的节点偏移，跳转处再 +1 进入节点）。

import { slugAllInOrder } from './heading-anchor.js'

/**
 * 从 ProseMirror doc 顺序收集顶层标题（按同一 slug 规则）与被交叉引用命中的非标题锚点节点，
 * 返回锚点表 `Map<id, pos>`。
 * 标题部分与 emitMeta 的大纲提取同用 doc.forEach，保证 pos 语义与既有大纲跳转逐字一致（跳转处 +1 进入节点）；
 * slugAllInOrder 已按文档序对重名加 `-1`/`-2` 后缀，故 key 天然唯一。
 * 非标题锚点（`anchor` 原子节点，携带导入时发的 `<a id="…">`）用 doc.descendants 收集（可嵌套于任意块），
 * id 即字面锚点名（非重算 slug），与标题 slug 命名空间不同；万一重名以标题优先（先入表）。
 */
export function buildAnchorMap(doc) {
  const heads = []
  const positions = []
  doc.forEach((node, pos) => {
    if (node.type.name === 'heading') {
      heads.push(node.textContent)
      positions.push(pos)
    }
  })
  const anchors = slugAllInOrder(heads)
  const map = new Map()
  for (let i = 0; i < anchors.length; i++) map.set(anchors[i], positions[i])
  doc.descendants((node, pos) => {
    if (node.type.name === 'anchor') {
      const id = node.attrs.id
      if (id && !map.has(id)) map.set(id, pos)
    }
  })
  return map
}
