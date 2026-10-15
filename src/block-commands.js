// block-commands.js —— 块类型命令（与斜杠菜单同一份项表的可执行侧，供 mac 原生「段落」菜单 / 命令面板复用）
//
// 与 slash-menu 的分工：slash 只在「空段落敲 /」时就地把该块替换掉；这里是**显式命令**，
// 作用于当前选区覆盖的块：标题/正文/引用/代码块走 setBlockType（保留行内内容），
// 列表走包裹，分割线/表格/卡片走当前块之后插入（不销毁已有内容）。
import { setBlockType, wrapIn } from 'prosemirror-commands'
import { wrapInList } from 'prosemirror-schema-list'
import { schema } from './editor-schema.js'

const N = schema.nodes
const para = () => N.paragraph.create()

const twoRowTable = () =>
  N.table.create(null, [
    N.table_row.create(null, [N.table_header.create(null, []), N.table_header.create(null, [])]),
    N.table_row.create(null, [N.table_cell.create(null, []), N.table_cell.create(null, [])]),
  ])

// 在当前块之后插入若干块（分割线/表格/提示卡片：属于「追加」而非「转换」）
function insertBelow(build) {
  return (state, dispatch) => {
    const $head = state.selection.$head
    if (!$head) return false
    const depth = $head.depth === 0 ? 0 : $head.depth
    const at = $head.after(depth)
    const built = build()
    const nodes = Array.isArray(built) ? built : [built]
    if (dispatch) dispatch(state.tr.insert(at, nodes).scrollIntoView())
    return true
  }
}

// 任务列表：选区已覆盖 list_item → 就地置 checked:false；否则把选区覆盖的顶层块包成
// 无序列表（每项 checked:false）。setNodeMarkup 不改节点尺寸，故收集到的位置可连续使用。
function taskList(state, dispatch) {
  const { $from, $to } = state.selection
  const items = []
  state.doc.nodesBetween($from.pos, $to.pos, (node, pos) => {
    if (node.type === N.list_item) items.push({ pos, node })
  })
  if (items.length) {
    if (dispatch) {
      const tr = state.tr
      for (const it of items) {
        if (it.node.attrs.checked == null) tr.setNodeMarkup(it.pos, undefined, { ...it.node.attrs, checked: false })
      }
      dispatch(tr.scrollIntoView())
    }
    return true
  }
  const range = $from.blockRange($to)
  if (!range) return false
  const cells = []
  for (let i = range.startIndex; i < range.endIndex; i++) {
    cells.push(N.list_item.create({ checked: false }, range.parent.child(i)))
  }
  if (!cells.length) return false
  // replaceWith（非 replace）：replace 会把相邻同名块做 open-join，这里会吞掉整个列表
  if (dispatch) dispatch(state.tr.replaceWith(range.start, range.end, N.bullet_list.create(null, cells)).scrollIntoView())
  return true
}

// 标题升 / 降级：作用于选区所在的标题（含更深层级里的标题，如引用内的 H2）。
// 到顶 / 到底（越出 1..6）即返回 false → 菜单项置灰，不做静默无操作。
export function headingStep(delta) {
  return (state, dispatch) => {
    const $ = state.selection.$head
    if (!$) return false
    let at = null
    for (let d = $.depth; d >= 1; d--) {
      if ($.node(d).type.name === 'heading') {
        at = { pos: $.start(d) - 1, node: $.node(d) }
        break
      }
    }
    if (!at) return false
    const level = at.node.attrs.level + delta
    if (level < 1 || level > 6) return false
    if (dispatch) dispatch(state.tr.setNodeMarkup(at.pos, undefined, { ...at.node.attrs, level }).scrollIntoView())
    return true
  }
}

// 当前块类型（mac「段落」菜单的勾）：由内向外判定，返回 BLOCK_COMMANDS 的键或 null。
// 内层优先——引用里的标题算「引用」、列表项里的段落算列表而非正文；
// 四~六级标题照实返回 h4/h5/h6（菜单里没有对应项时自然无勾，但不是「读不出来」）。
export function activeBlockKey(state) {
  const sel = state.selection
  if (!sel) return null
  const picked = sel.node && sel.node.type ? sel.node : null // NodeSelection（点选分割线 / 图片 / 表格）
  const $ = sel.$head
  if (!$ && !picked) return null
  const code = (node) => (/\bmermaid\b/.test(String(node.attrs.params || '')) ? 'mermaid' : 'code')
  if (picked) {
    const n = picked.type.name
    if (n === 'horizontal_rule') return 'hr'
    if (n === 'table') return 'table'
    if (n === 'callout') return 'callout'
    if (n === 'code_block') return code(picked)
    if (n === 'heading') return 'h' + picked.attrs.level
  }
  if (!$) return null
  for (let d = $.depth; d >= 1; d--) {
    const node = $.node(d)
    const n = node.type.name
    if (n === 'code_block') return code(node)
    if (n === 'table' || n === 'table_cell' || n === 'table_header') return 'table'
    if (n === 'callout') return 'callout'
    if (n === 'blockquote') return 'quote'
    if (n === 'list_item') {
      const parent = d > 1 ? $.node(d - 1) : null
      if (parent && parent.type.name === 'ordered_list') return 'ordered'
      return node.attrs.checked == null ? 'bullet' : 'task'
    }
  }
  // depth 0 = 位置落在顶层块之间（或被点选的块不在上面这套类型里）：没有「所在块」可读
  if ($.depth < 1) return null
  const top = $.node(1)
  if (!top) return null
  if (top.type.name === 'heading') return 'h' + top.attrs.level
  if (top.type.name === 'paragraph') return 'para'
  return null
}

export const BLOCK_COMMANDS = {
  para: setBlockType(N.paragraph),
  h1: setBlockType(N.heading, { level: 1 }),
  h2: setBlockType(N.heading, { level: 2 }),
  h3: setBlockType(N.heading, { level: 3 }),
  h4: setBlockType(N.heading, { level: 4 }),
  h5: setBlockType(N.heading, { level: 5 }),
  h6: setBlockType(N.heading, { level: 6 }),
  quote: wrapIn(N.blockquote),
  code: setBlockType(N.code_block, { params: '' }),
  mermaid: setBlockType(N.code_block, { params: 'mermaid' }),
  bullet: wrapInList(N.bullet_list),
  ordered: wrapInList(N.ordered_list),
  task: taskList,
  hr: insertBelow(() => [N.horizontal_rule.create(), para()]),
  table: insertBelow(() => [twoRowTable(), para()]),
  callout: insertBelow(() => [N.callout.create({ type: 'note', title: 'NOTE' }, para()), para()]),
}
