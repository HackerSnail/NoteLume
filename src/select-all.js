// select-all.js —— Typora 式分段全选（Mod-a）
//
// 光标落在「成块容器」里时，第一次全选只选这一层，再按一次才到整篇：
//  · 表格 → 整表框选。用 prosemirror-tables 的 CellSelection，判定「已经选全了没」
//    取库自己的口径（isColSelection && isRowSelection），与 block-commands.js
//    coveredWholeTable（整表删除）那条同一对判据，colspan / rowspan 一并算对；
//  · 代码块 / 引用 / callout / 有序无序列表 → 选中该块的内容区间，光标仍留在块内。
// 顶层普通段落不插这一档：正文里按一次就是整篇，与原先一致。
//
// 入口只有一个：main.js 的应用级命令 app.selectAll（按当前焦点分派，mac 的 ⌘A 由原生
// 菜单 accelerator 转进来，Windows / Linux 与纯网页预览走窗口内 keydown 分发器）。
// editor-view.js 里要把 baseKeymap 的 Mod-a 让路掉，否则编辑器内那条整篇原生全选会
// 先一步吃掉按键，这一档就永远轮不到。

import { TextSelection } from 'prosemirror-state'
import { selectAll } from 'prosemirror-commands'
import { CellSelection, TableMap } from 'prosemirror-tables'

// 内容区间型容器：选中 [块内首, 块内尾]，表格另走 CellSelection
const RANGE_BLOCKS = new Set(['code_block', 'blockquote', 'callout', 'bullet_list', 'ordered_list'])

// 从选区锚点往上找最近的一层可分段容器（先内后外：引用里的表格先选表格）
function stageTarget(state) {
  const { $from } = state.selection
  const doc = state.doc
  for (let d = $from.depth; d > 0; d--) {
    const node = $from.node(d)
    if (node.type.name === 'table') return { kind: 'table', start: $from.start(d), node }
    if (RANGE_BLOCKS.has(node.type.name)) {
      // 端点先收进块内首尾的文本位：between 会做这一步，直接拿 start/end 会落在块边界上，
      // PM 只 warn 一句「endpoint not pointing into inline content」而选区是残缺的。
      // 收完的位同时当「已经选到位」的判据，否则第二次按键永远比不上下游。
      const span = TextSelection.between(doc.resolve($from.start(d)), doc.resolve($from.end(d)))
      return { kind: 'range', from: span.from, to: span.to }
    }
  }
  return null
}

// 当前选区是否已经盖住这一档：盖住了就该往上升一级（整篇），不再原地重放
function covered(sel, t) {
  if (t.kind === 'table') return sel instanceof CellSelection && sel.isColSelection() && sel.isRowSelection()
  return !sel.empty && sel.from <= t.from && sel.to >= t.to
}

/**
 * Mod-a：容器内先选容器，容器外（或已选到容器这一层）选整篇。
 * @returns {boolean} 是否消费了这次按键
 */
export function selectAllStaged(state, dispatch, view) {
  const t = stageTarget(state)
  if (!t || covered(state.selection, t)) return selectAll(state, dispatch, view)
  if (!dispatch) return true // 命令面板 / 菜单置灰查询：只看这条键此刻有没有事可做
  let sel
  if (t.kind === 'table') {
    const map = TableMap.get(t.node)
    // positionAt 给的是相对表格内容起点的格位，与库内 tableStart 同一口径
    const anchor = t.start + map.positionAt(0, 0, t.node)
    const head = t.start + map.positionAt(map.height - 1, map.width - 1, t.node)
    sel = CellSelection.create(state.doc, anchor, head)
  } else {
    sel = TextSelection.create(state.doc, t.from, t.to)
  }
  dispatch(state.tr.setSelection(sel).scrollIntoView())
  return true
}
