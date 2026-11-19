// split-source.js —— 分栏时「复制哪一篇」的判定
//
// 源窗格的活动标签是唯一权威：ctx 可能停在切标签前的那篇（装载是异步的），
// 拿它复制会让新窗格的标签名和正文对不上。标签条没活动标签时才退回 ctx。

/** 返回要复制的文档 {root, rel, scratch}，空态 / 画布返回 null。 */
export function splitSourceTab(active, ctx, isCanvasPath) {
  const src = active || ctx || {}
  const rel = src.rel || null
  if (!rel || (typeof isCanvasPath === 'function' && isCanvasPath(rel))) return null
  return {
    root: src.root || src.vaultRoot || null,
    rel,
    scratch: !!src.scratch,
    preview: false,
  }
}
