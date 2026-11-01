// blocks.js —— master doc 顶层块索引（虚拟化窗口内核的位置账本）
//
// 虚拟化方案的坐标换算全靠这份索引：master doc 的顶层块（doc 直接子节点）逐个记下
// pos 区间，窗口切片、窗口 <-> master 的位置平移、滚动定位都以它为唯一依据。
// 纯函数、无依赖，node 单测直接覆盖。

/**
 * 建立 master doc 的顶层块索引。
 * 每块记 { offset, size, node }：块节点占 [offset, offset + size)。
 * offset 是块节点开边界前的 pos（第一个块为 0）。
 */
export function buildBlockIndex(doc) {
  const blocks = []
  let offset = 0
  doc.forEach((node) => {
    const size = node.nodeSize
    blocks.push({ offset, size, node })
    offset += size
  })
  return blocks
}

/**
 * pos -> 块号。pos 落在两块交界（前块结束 = 后块开始）归后一块，
 * 因为交界 pos 同时是前块尾边界与后块开边界，编辑落点归属后块更自然。
 * pos == doc 末尾返回最后一块。空文档（无块）返回 -1。
 */
export function posToBlock(blocks, pos) {
  const n = blocks.length
  if (n === 0) return -1
  let lo = 0
  let hi = n - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (blocks[mid].offset <= pos) lo = mid
    else hi = mid - 1
  }
  return lo
}

/** 块号区间 [a, b) 对应的 master pos 区间（首块开边界 ~ 末块尾边界） */
export function blockRangePos(blocks, a, b) {
  if (a >= b || a < 0 || b > blocks.length) return null
  return { start: blocks[a].offset, end: blocks[b - 1].offset + blocks[b - 1].size }
}
