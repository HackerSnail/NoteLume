// highlight-mark.js —— 选区高亮的纯命令逻辑（p5plan §6.4）
//
// 与 editor-schema.js 的 highlight 标记配套：工具栏（highlight-toolbar.js）、
// 编辑器实例（editor-view.js）与单测（tests/highlight.test.mjs）共用，全程不碰 DOM。
// 放独立模块而不是塞进 editor-view：那边一 import 就拉进 Tauri bridge，单测跑不动。

import { schema, normalizeHlColor } from './editor-schema.js'

/**
 * 区间内每个重叠的文本节点都带该 mark，才算「整段都是这个色」。
 * nodesBetween 会给到与区间边界交叠的节点，压着半个节点也算数——与用户所见一致。
 */
export function rangeFullyMarked(doc, from, to, mark) {
  if (to <= from) return false
  let ok = true
  doc.nodesBetween(from, to, (node) => {
    if (node.isText && !mark.isInSet(node.marks)) ok = false
  })
  return ok
}

/** 选区内是否有高亮（工具栏「清除高亮」按钮的可用判定） */
export function selectionHasHighlight(doc, from, to) {
  let has = false
  doc.nodesBetween(from, to, (node) => {
    if (node.isText && node.marks.some((m) => m.type === schema.marks.highlight)) has = true
  })
  return has
}

/**
 * 选区起点处的文字 marks：起点恰在节点开头时 nodeAfter 即该文本节点；落在中间
 * （nodeAfter 为空）则取右侧一格的内部 marks——resolve().marks() 在起始边界返回
 * 空集，不能用（与 find-in-doc.js 取命中处 marks 同一手法）。
 */
export function highlightColorAt(doc, pos) {
  const $pos = doc.resolve(pos)
  const after = $pos.nodeAfter
  const marks = after && after.isText ? after.marks : doc.resolve(Math.min(pos + 1, doc.content.size)).marks()
  const m = marks.find((x) => x.type === schema.marks.highlight)
  return m ? m.attrs.color : null
}

/**
 * PM 命令（state, dispatch, view）：对当前选区设 / 换 / 取消高亮。
 *  · 整段已是该色 → 取消（与加粗一致的 toggle 手感，工具栏上再点一次当前色即擦掉）；
 *  · 否则先清掉选区内旧高亮色再上新色——addMark 的 addToSet 不会替换同类型异属性
 *    的 mark，不先清就会两种底色叠着。
 * 不用 prosemirror-commands 的 toggleMark：它按「类型在不在」决定增删，在绿色上点
 * 蓝色只会把高亮整个删掉，换不了色。
 */
export function setHighlightMark(state, dispatch, color) {
  const mark = schema.marks.highlight.create({ color: normalizeHlColor(color) })
  const { ranges } = state.selection
  if (!ranges.length) return false
  const allSame = ranges.every((r) => rangeFullyMarked(state.doc, r.$from.pos, r.$to.pos, mark))
  const tr = state.tr
  for (const { $from, $to } of ranges) {
    tr.removeMark($from.pos, $to.pos, schema.marks.highlight)
    if (!allSame) tr.addMark($from.pos, $to.pos, mark)
  }
  if (!tr.docChanged) return false
  dispatch(tr.scrollIntoView())
  return true
}
