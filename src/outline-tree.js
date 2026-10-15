// outline-tree.js —— 大纲层级：纯逻辑（无 DOM、无编辑器依赖，可 Node 单测）
// 输入是编辑器 `onMetaChange` 给的扁平标题序列 `[{ level, text, pos }]`（文档顺序）。
// 大标题常显、其下子级整节收起，故需要「谁是谁的后代」而非只看紧邻下一级。

function normLevel(raw) {
  const n = Math.floor(Number(raw))
  if (!Number.isFinite(n) || n < 1) return 1
  return n > 6 ? 6 : n
}

/** 算出每个条目的父子关系
 *  @returns {Array<{level:number, parent:number|null, kids:number[], descendants:number[], depth:number, hasKids:boolean}>} 与入参同序 */
export function analyzeOutline(items) {
  const list = Array.isArray(items) ? items : []
  const lv = list.map((it) => normLevel(it && it.level))
  const rows = lv.map((level) => ({ level, parent: null, kids: [], descendants: [], depth: 0, hasKids: false }))
  const stack = []
  lv.forEach((level, i) => {
    while (stack.length && level <= stack[stack.length - 1].level) stack.pop()
    if (stack.length) {
      const p = stack[stack.length - 1].i
      rows[i].parent = p
      rows[p].kids.push(i)
    }
    stack.push({ level, i })
  })
  const collect = (i) => {
    for (let p = rows[i].parent; p != null; p = rows[p].parent) rows[p].descendants.push(i)
  }
  rows.forEach((r, i) => {
    r.hasKids = r.kids.length > 0
    collect(i)
  })
  rows.forEach((r) => {
    let depth = 0
    for (let p = r.parent; p != null; p = rows[p].parent) depth += 1
    r.depth = depth
  })
  return rows
}

/** @param collapsed 已收起的行号集合 @returns 需要隐藏的行号集合（折叠节点的全部后代） */
export function hiddenRows(rows, collapsed) {
  const out = new Set()
  if (!Array.isArray(rows) || !collapsed) return out
  for (const i of collapsed) {
    const r = rows[i]
    if (!r) continue
    for (const d of r.descendants) out.add(d)
  }
  return out
}
