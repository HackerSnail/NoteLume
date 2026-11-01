// windowed-model.js —— 超大文档「窗口化渲染」的模型层内核（Phase 0 spike，纯逻辑、无 DOM）
//
// 思路：内存里留一份完整 master doc 作唯一事实源；EditorView 只绑一个「窗口 doc」
// （master 顶层块的连续切片 [i0..i1]）。窗口内编辑产出的事务，按块偏移回灌到 master
// 对应区间；master 变化再驱动窗口重切。本模块只做坐标映射 / 切片 / 回灌这些纯模型运算，
// 用来在写任何 DOM 之前，先验证「光标 / 选区 / undo / 边界拆分合并」在模型层是否自洽。
//
// ProseMirror 坐标约定：doc.forEach 给的 offset 就是该节点的绝对位置（首块为 0），块
// 占据 [offset, offset + nodeSize)。下面一律用这套绝对位置。

import { Fragment } from 'prosemirror-model'
import { TextSelection } from 'prosemirror-state'

/** 每个顶层块的绝对区间：{start, size, end}（end 不含，= start + size）。 */
export function blockOffsets(doc) {
  const out = []
  doc.forEach((node, offset) => {
    out.push({ start: offset, size: node.nodeSize, end: offset + node.nodeSize })
  })
  return out
}

/** 取 master 顶层块 [i0..i1]（含端点）拼成一个同类型窗口 doc。 */
export function sliceWindow(doc, i0, i1) {
  const nodes = []
  doc.forEach((node, _offset, index) => {
    if (index >= i0 && index <= i1) nodes.push(node)
  })
  return doc.copy(Fragment.fromArray(nodes))
}

/** 窗口坐标 → master 坐标的位移：master 第 i0 块起点（窗口首块起点为 0）。 */
export function windowDelta(doc, i0) {
  return blockOffsets(doc)[i0].start
}

export function windowToMasterPos(doc, i0, windowPos) {
  return windowPos + windowDelta(doc, i0)
}

export function masterToWindowPos(doc, i0, masterPos) {
  return masterPos - windowDelta(doc, i0)
}

/**
 * 把窗口编辑后的结果回灌进 master：用新窗口内容替换 master 的 [i0 块起, i1 块止] 区间。
 * 窗口内的拆分 / 合并（块数变化）都能覆盖——因为替换的是整段区间、塞进新的 Fragment。
 * 返回一个作用在 masterState 上的事务（未 apply）。
 */
export function syncWindowToMaster(masterState, i0, i1, windowDocAfter) {
  const offs = blockOffsets(masterState.doc)
  const from = offs[i0].start
  const to = offs[i1].end
  return masterState.tr.replaceWith(from, to, windowDocAfter.content)
}

/**
 * 回灌时把窗口内的选区一并映射到 master 新坐标。
 * 简化：先按位移落到 master 旧坐标，再用回灌事务的位置映射推到新 master 坐标。
 */
export function remapSelectionToMaster(masterState, i0, i1, windowDocAfter, windowSel) {
  const tr = syncWindowToMaster(masterState, i0, i1, windowDocAfter)
  const delta = windowDelta(masterState.doc, i0)
  const mappedFrom = tr.mapping.map(windowSel.from + delta, 1)
  const mappedTo = tr.mapping.map(windowSel.to + delta, -1)
  return { tr, sel: TextSelection.between(tr.doc.resolve(mappedFrom), tr.doc.resolve(mappedTo)) }
}

// —— 窗口选择（渲染层用；spike 里用「块数 × 估算块高」近似，真实实现按实测高度）——

/**
 * 给定滚动偏移与视口高，算要渲染的块下标区间 [i0..i1]（含 overscan 块缓冲）。
 * heights 为逐块高度数组；scrollTop/viewportH 为像素。
 */
export function windowForScroll(heights, scrollTop, viewportH, overscan = 5) {
  const tops = []
  let acc = 0
  for (const h of heights) { tops.push(acc); acc += h }
  const bottom = scrollTop + viewportH
  let i0 = tops.findIndex((t, i) => t + heights[i] >= scrollTop)
  if (i0 < 0) i0 = 0
  let i1 = i0
  while (i1 < tops.length - 1 && tops[i1] <= bottom) i1++
  i0 = Math.max(0, i0 - overscan)
  i1 = Math.min(tops.length - 1, i1 + overscan)
  return { i0, i1, totalHeight: acc }
}
