// block-commands.js —— 块类型命令（与斜杠菜单同一份项表的可执行侧，供 mac 原生「段落」菜单 / 命令面板复用）
//
// 与 slash-menu 的分工：slash 只在「空段落敲 /」时就地把该块替换掉；这里是**显式命令**，
// 作用于当前选区覆盖的块：标题/正文/引用/代码块走 setBlockType（保留行内内容），
// 列表走包裹，分割线/表格/卡片走当前块之后插入（不销毁已有内容）。
import { setBlockType, wrapIn, chainCommands, deleteSelection, joinBackward, selectNodeBackward, newlineInCode, createParagraphNear, liftEmptyBlock, splitBlock } from 'prosemirror-commands'
import { wrapInList, splitListItem } from 'prosemirror-schema-list'
import { TextSelection } from 'prosemirror-state'
import { schema } from './editor-schema.js'
import { nlCellEnter, nlCellBack } from './table-editing.js'

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

// —— 退格 ——
// 原生链是 deleteSelection → joinBackward → selectNodeBackward；裸绑 selectNodeBackward 会跳过
// joinBackward，于是任意一块的开头按一次退格就选中上一整块、再按一次整块消失。
// 这里恢复原生链，只把两类上一块挑出来走「选中整块」：代码块（joinBackward 会把当前段落
// 的正文并进代码最后一行）与原子块（joinBackward 自带「上一块是 atom 就直接删」分支，
// 一次按键就把公式 / 图片 / hr 删掉，绕过按一下选中再删的手感）。表格由 isolating 自然
// 被 joinBackward 拒绝，落到选中分支。
const backspaceChain = chainCommands(deleteSelection, joinBackward, selectNodeBackward)

// findCutBefore 的同构实现（该函数未导出）：沿祖先上溯找左侧兄弟，撞 isolating 即止
function cutBefore($pos) {
  if ($pos.parent.type.spec.isolating) return null
  for (let d = $pos.depth - 1; d >= 0; d--) {
    if ($pos.index(d) > 0) return $pos.doc.resolve($pos.before(d + 1))
    if ($pos.node(d).type.spec.isolating) break
  }
  return null
}

export function nlBackspace(state, dispatch, view) {
  const $cursor = state.selection.$cursor
  if ($cursor && (view ? view.endOfTextblock('backward', state) : $cursor.parentOffset === 0)) {
    const cut = cutBefore($cursor)
    const before = cut && cut.nodeBefore
    if (before && (before.type.spec.code || before.isAtom)) return selectNodeBackward(state, dispatch, view)
  }
  return backspaceChain(state, dispatch, view)
}

// 硬换行命令（固定结构键 Shift-Enter）。表格里=上一格（格内插 hard_break 会把表写坏，见 §3 实测），
// 代码块里=块内换行（同 Enter），标题里=无事发生（见下），其余=插 hard_break。
// 离开代码块走 Mod-Enter（注册表 exitBlock）。
function insertBreak(state, dispatch) {
  dispatch(state.tr.replaceSelectionWith(N.hard_break.create()).scrollIntoView())
  return true
}

// 标题里的硬换行没有 markdown 形态：实测序列化出 `# 标` + 空行 + `\` + `题一二`，
// 反解后标题少半截、多出一个乱段，故不接管该键（改前同样插入，属既有损坏路径）。
function inHeading(state) {
  return state.selection.$from.parent.type.name === 'heading'
}

export const nlHardBreak = chainCommands(
  nlCellBack,
  (state, dispatch, view) => (state.selection.$from.parent.type.spec.code ? newlineInCode(state, dispatch, view) : false),
  (state, dispatch) => (inHeading(state) ? false : insertBreak(state, dispatch))
)

// 脚注项只允许一个段落（content: 'paragraph'），splitBlock 在里面恒 false，回车原本无事发生。
// 落 hard_break 的往返实测可行：`[^1]: 正文\` + 换行的三种落点（段中 / 段末 / 换行后接着打字）
// 反解后文档全等，多项脚注区各自带一个换行也全等；末位仅换行不带后续文字时该节点被序列化吃掉，
// 与空段落同性质，不产生损坏。
function inFootnoteItem(state) {
  const $from = state.selection.$from
  for (let d = $from.depth; d > 0; d--) if ($from.node(d).type.name === 'footnote_item') return true
  return false
}

// 标题里回车：光标后的文字降到标题下方的段落。原生 splitBlock 会把 heading 拆成两个 heading
// （实测 `# 标题一二` 中间回车得 ['heading','heading']），markdown 里凭空多一个标题。
// 行首光标没有「后半截」可搬，改为在标题上方空一段，光标跟过去，标题本体不动。
function splitHeadingDown(state, dispatch) {
  const { $from, empty } = state.selection
  if (!empty) return false
  let d = 0
  for (let k = $from.depth; k > 0; k--) if ($from.node(k).type.name === 'heading') { d = k; break }
  if (!d) return false
  if (!dispatch) return true
  if ($from.parentOffset === 0) {
    const at = $from.before(d)
    const tr = state.tr
    tr.insert(at, para())
    dispatch(tr.setSelection(TextSelection.create(tr.doc, at + 1)).scrollIntoView())
    return true
  }
  const rest = $from.parent.content.cut($from.parentOffset)
  const tr = state.tr
  tr.delete($from.pos, $from.end(d))
  const at = $from.pos + 1 // 删除后标题闭合 token 仍占 1，+1 即标题节点之后
  tr.insert(at, rest.size ? N.paragraph.create(null, rest) : para())
  tr.setSelection(TextSelection.create(tr.doc, at + 1))
  dispatch(tr.scrollIntoView())
  return true
}

// 分块命令（固定结构键 Enter）：表格里走格 / 末格出表，列表项内新起一项，标题降正文，
// 脚注项内换行，其余照原生链。
// splitListItem 在空列表项上返回 false，交回 liftEmptyBlock 退出列表，与 Typora 一致。
export const nlEnter = chainCommands(
  nlCellEnter,
  splitListItem(N.list_item),
  splitHeadingDown,
  (state, dispatch) => (inFootnoteItem(state) ? insertBreak(state, dispatch) : false),
  newlineInCode,
  createParagraphNear,
  liftEmptyBlock,
  splitBlock
)
