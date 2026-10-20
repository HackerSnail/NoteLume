// table-editing.js —— 表格编辑人体工学（基于 prosemirror-tables）
// 提供三块：① tablePlugins()：列宽拖拽 columnResizing + 单元格选择/规范化 tableEditing，
//   拖拽开始时由 pinColWidthsPlugin 先把当前列宽固化成 colwidth（原因见该插件处注释）；
// ② tableKeymap()：Tab / Shift-Tab 在单元格间跳转（仅在表内生效，否则交回默认键位）；
// ③ attachTableContextMenu(view)：在单元格上右键弹出行列操作菜单（复用全局 .cv-menu 样式）。
//
// 边界：功能项 J 起，本编辑器可无损往返合并单元格——含合并的表序列化为真 <table> HTML、
// 解析回节点由 editor-schema.js 两阶段预处理完成，故菜单开放「合并/拆分单元格」。
// 注意单元格内容受 cellContent:'inline*' 约束：一个格内不放多段落/块级列表（合并为单段内联）。

import { keymap } from 'prosemirror-keymap'
import { Plugin, TextSelection } from 'prosemirror-state'
import { t } from './i18n.js'
import {
  columnResizing,
  tableEditing,
  goToNextCell,
  isInTable,
  addRowBefore,
  addRowAfter,
  deleteRow,
  addColumnBefore,
  addColumnAfter,
  deleteColumn,
  toggleHeaderRow,
  setCellAttr,
  deleteTable,
  TableView,
  mergeCells,
  splitCell,
  cellAround,
  CellSelection,
  TableMap,
} from 'prosemirror-tables'

// 没有拖过列宽的表按内容分宽（table-layout:auto，同 Typora）；一旦 colwidth 写进文档
// （右键拖列 → updateColumnWidth）就回到 fixed，否则拖出来的宽度会被内容重新拉开。
function hasColwidth(tableNode) {
  const row = tableNode.firstChild
  if (!row) return false
  for (let i = 0; i < row.childCount; i++) {
    const cw = row.child(i).attrs.colwidth
    if (cw && cw.some((w) => w)) return true
  }
  return false
}

class AutoTableView extends TableView {
  constructor(node, defaultCellMinWidth, view) {
    super(node, defaultCellMinWidth, view)
    this.fitLayout()
  }

  update(node) {
    const ok = super.update(node)
    if (ok) this.fitLayout()
    return ok
  }

  // 放在 super.update 之后：基类刚铺好的 col 宽度/整表 min-width 在这里按模式清掉
  fitLayout() {
    if (hasColwidth(this.node)) {
      this.table.style.tableLayout = 'fixed'
      return
    }
    this.table.style.tableLayout = 'auto'
    this.table.style.width = ''
    this.table.style.minWidth = ''
    for (const col of this.colgroup.children) {
      col.style.width = ''
      col.style.minWidth = ''
    }
  }
}

// —— 拖列宽前先把当前列宽固化 ——
// 没拖过列宽的表是 table-layout:auto：<col> 上的 width 只是建议值，列宽最终按内容分，
// 浏览器随时重排。而 prosemirror-tables 的拖拽是在 mousemove 里直接写 <col> 宽度、
// 到 mouseup 才把 colwidth 写进文档，整段拖拽都跑在 auto 布局上——内容每重排一次，
// 拖着的那条边就跳一截，在单元格换行阈值附近左右来回晃、闪。
// 这里在 mousedown 命中手柄时，先把当前渲染列宽固化成 colwidth：fitLayout 随即转
// fixed，拖拽的起点与过程仍是库的逻辑（currentColWidth 改读固化值，起点不变）。
const HANDLE_WIDTH = 5 // 与 columnResizing 的 handleWidth 默认值一致

// 复刻 columnresizing.ts 的悬停判定（库未导出这两个函数）：鼠标落在单元格左/右
// HANDLE_WIDTH 内才算手柄；首列左沿不给手柄，其余边沿取该侧格子的 doc 位置。
function domCellAround(target) {
  while (target && target.nodeName != 'TD' && target.nodeName != 'TH') {
    target = target.classList && target.classList.contains('ProseMirror') ? null : target.parentNode
  }
  return target
}
function edgeCell(view, event, side) {
  const offset = side == 'right' ? -HANDLE_WIDTH : HANDLE_WIDTH
  const found = view.posAtCoords({ left: event.clientX + offset, top: event.clientY })
  if (!found) return -1
  const $cell = cellAround(view.state.doc.resolve(found.pos))
  if (!$cell) return -1
  if (side == 'right') return $cell.pos
  const map = TableMap.get($cell.node(-1)), start = $cell.start(-1)
  const index = map.map.indexOf($cell.pos - start)
  return index % map.width == 0 ? -1 : start + map.map[index - 1]
}
// mousedown 是否落在列宽手柄上：是则返回手柄格子的 doc 位置，否则 -1
function resizeHandlePos(view, event) {
  const target = domCellAround(event.target)
  if (!target) return -1
  const { left, right } = target.getBoundingClientRect()
  if (event.clientX - left <= HANDLE_WIDTH) return edgeCell(view, event, 'left')
  if (right - event.clientX <= HANDLE_WIDTH) return edgeCell(view, event, 'right')
  return -1
}

// 把表格当前的渲染列宽写进每个单元格的 colwidth。量第一行的格子（offsetWidth 与
// currentColWidth 同口径）；colspan 格按跨度均分；rowspan 的复用格只写一次。
// 返回事务；量不到（空表、DOM 异常）返回 null。
function snapshotColWidths(view, cellPos) {
  const state = view.state
  const $cell = state.doc.resolve(cellPos)
  const table = $cell.node(-1)
  const map = TableMap.get(table)
  const start = $cell.start(-1)
  if (!table.firstChild) return null

  const dom = view.domAtPos(cellPos)
  const cellDom = dom.node.childNodes && dom.node.childNodes[dom.offset]
  const tableDom = cellDom && cellDom.closest ? cellDom.closest('table') : null
  if (!tableDom) return null
  // :scope 保证只取本表 tbody 的行，不至于伸进单元格里嵌套表的行
  const rowDom = tableDom.querySelector(':scope > tbody > tr')
  if (!rowDom) return null

  const colWidths = []
  for (const td of rowDom.children) {
    const span = td.colSpan || 1
    for (let j = 0; j < span; j++) colWidths.push(td.offsetWidth / span)
  }
  if (colWidths.length != map.width) return null

  const tr = state.tr
  const seen = new Set()
  for (let row = 0; row < map.height; row++) {
    for (let col = 0; col < map.width; col++) {
      const pos = map.map[row * map.width + col]
      if (seen.has(pos)) continue
      seen.add(pos)
      const cell = table.nodeAt(pos)
      const span = cell.attrs.colspan
      const startCol = map.colCount(pos)
      const colwidth = []
      for (let j = 0; j < span; j++) colwidth.push(colWidths[startCol + j])
      tr.setNodeMarkup(start + pos, null, { ...cell.attrs, colwidth })
    }
  }
  return tr.docChanged ? tr : null
}

// mousedown 命中手柄且该表还没有 colwidth 时先固化列宽，再交回 columnResizing 开始
// 拖拽（始终返回 false，不抢事件）。已有 colwidth 的表本就是 fixed，不用这一下。
const pinColWidthsPlugin = new Plugin({
  props: {
    handleDOMEvents: {
      mousedown(view, event) {
        const cellPos = resizeHandlePos(view, event)
        if (cellPos < 0) return false
        const table = view.state.doc.resolve(cellPos).node(-1)
        if (!table || hasColwidth(table)) return false
        const tr = snapshotColWidths(view, cellPos)
        if (tr) view.dispatch(tr)
        return false
      },
    },
  },
})

// 装配进编辑器插件数组。pinColWidthsPlugin 要在 columnResizing 之前：mousedown 先
// 固化列宽，库的拖拽随后拿到的就是固定宽度。tableEditing 放在数组靠后（它对鼠标/
// 方向键处理较宽泛，让 columnResizing 等更具体的插件先取得事件权）。
export function tablePlugins() {
  return [pinColWidthsPlugin, columnResizing({ View: AutoTableView }), tableEditing()]
}

// Tab / Shift-Tab 跨格。放在普通 keymap 之前；不在表内时返回 false 交回后续键位。
export function tableKeymap() {
  return keymap({
    Tab: (state, dispatch, view) => (isInTable(state) ? goToNextCell(1)(state, dispatch, view) : false),
    'Shift-Tab': (state, dispatch, view) => (isInTable(state) ? goToNextCell(-1)(state, dispatch, view) : false),
    ArrowUp: cellArrow(-1),
    ArrowDown: cellArrow(1),
  })
}

// —— 表格里上下方向键移格 ——
// prosemirror-tables 自带上下键（tableEditing 的 handleKeyDown → arrow('vert') →
// atEndOfCell），但那条链路在本项目是死的：atEndOfCell 的深度循环从 $head.depth - 1
// 起找 tableRole == 'cell' 的层，而本项目 cellContent 是 'inline*'（文字直接在单元格里，
// 单元格就是最内层，$head.depth 即单元格那一层），循环永远少看一层、恒返回 null。
// 落空后上下键交回浏览器原生行为，而 Chromium 原生不做表格内的上下移格（裸
// contenteditable 表格对照实验：ArrowUp / Down 不跨行，ArrowLeft / Right 才跨格），
// 表现就是只能左右移。这里自己补：格内没得走了（首行按上 / 末行按下）才移格，
// 多行格子的中间行照样让给原生。带 CellSelection 时不接——那条路库的分支还活着
// （在 atEndOfCell 之前判），让它把选区收进邻格。
function cellPosUnder($pos) {
  for (let d = $pos.depth; d > 0; d--) {
    const role = $pos.node(d).type.spec.tableRole
    if (role === 'cell' || role === 'header_cell') return $pos.before(d)
  }
  return null
}

// 同列上 / 下一格的内容起点；到表缘（首行之上 / 末行之下）返回 'edge'；
// 邻格就是自己（rowspan 复用格）返回 null——那种格上下是一个整体，不挪，交回原生。
// 合并格按 TableMap 定位：取格子在 map 里的首个下标算行号，colspan 格取起始列
function verticalCellPos(state, cellPos, dir) {
  const $cell = state.doc.resolve(cellPos)
  const table = $cell.node(-1)
  if (!table || table.type.spec.tableRole !== 'table') return null
  const map = TableMap.get(table)
  const start = $cell.start(-1)
  const index = map.map.indexOf(cellPos - start)
  if (index < 0) return null
  const col = index % map.width
  const row = (index - col) / map.width
  const targetRow = row + dir
  if (targetRow < 0 || targetRow >= map.height) return 'edge'
  const target = map.map[targetRow * map.width + col]
  if (target === cellPos - start) return null
  return start + target + 1 // 单元格内容起点
}

function cellArrow(dir) {
  return (state, dispatch, view) => {
    if (!view || !isInTable(state)) return false
    const sel = state.selection
    if (!sel.empty || sel instanceof CellSelection) return false
    // 格内还能朝该方向走（多行格子的中间行）就让给原生
    if (!view.endOfTextblock(dir < 0 ? 'up' : 'down')) return false
    const cellPos = cellPosUnder(sel.$head)
    if (cellPos == null) return false
    const target = verticalCellPos(state, cellPos, dir)
    if (target === 'edge') {
      // 到头 / 到尾：出表。上方已有块就把光标搬过去；表就是文档首块则无处可去（不动）
      if (dir < 0) {
        const before = sel.$head.before(1)
        if (before <= 0) return false
        const out = TextSelection.near(state.doc.resolve(before), -1)
        if (!out) return false
        if (dispatch) dispatch(state.tr.setSelection(out).scrollIntoView())
        return true
      }
      return exitTableBelow(state, dispatch)
    }
    if (target == null) return false
    if (dispatch) dispatch(state.tr.setSelection(TextSelection.near(state.doc.resolve(target), 1)).scrollIntoView())
    return true
  }
}

// —— 表格内的回车 ——
// 单元格是 inline* + isolating，splitBlock 与 exitCode 在里面恒 false：回车必须给专用命令。
// 出表时表后面已有块就只搬光标（不改文档，也就不判脏）；表是末块才补一个空段落，
// 该段落存盘时会被序列化吃掉（实测），持久落点靠 gapcursor。
function tablePos($from) {
  for (let d = $from.depth; d > 0; d--) if ($from.node(d).type.name === 'table') return d
  return 0
}

export function exitTableBelow(state, dispatch) {
  const $from = state.selection.$from
  const d = tablePos($from)
  if (!d) return false
  const after = $from.after(d)
  const tr = state.tr
  if (after < state.doc.content.size) {
    const sel = TextSelection.near(tr.doc.resolve(after), 1)
    if (!sel) return false
    if (dispatch) dispatch(tr.setSelection(sel).scrollIntoView())
    return true
  }
  const para = state.schema.nodes.paragraph.create()
  if (dispatch) dispatch(tr.insert(after, para).setSelection(TextSelection.near(tr.doc.resolve(after), 1)).scrollIntoView())
  return true
}

// Enter：非末格走下一格，末格出表。表内一律接管、不看选区：goToNextCell 会留下一个同格内长度 1
// 的跨边界选区，按「有选区就让行」判定会把连按的第二下挡断；而放行交回后续回车链，
// splitBlock / newlineInCode / liftEmptyBlock 在 inline* + isolating 的格内实测全 false，等于回到陷阱。
export function nlCellEnter(state, dispatch, view) {
  if (!isInTable(state)) return false
  if (goToNextCell(1)(state, dispatch, view)) return true
  return exitTableBelow(state, dispatch)
}

// Shift-Enter：上一格。格内插 hard_break 会把表写坏（序列化出行内换行，反解后行数与格数都变）
export function nlCellBack(state, dispatch, view) {
  if (!isInTable(state)) return false
  return goToNextCell(-1)(state, dispatch, view)
}

// —— 功能项 J：合并/拆分的选区判定 ——
// 选区跨越 ≥2 个单元格（CellSelection）才可合并
function isMultiCellSel(sel) {
  if (!(sel instanceof CellSelection)) return false
  let c = 0
  sel.forEachCell(() => c++)
  return c >= 2
}
// 从 $pos 上溯找到所在表格单元格节点
function cellNodeUnder($pos) {
  for (let d = $pos.depth; d > 0; d--) {
    const n = $pos.node(d)
    if (n.type.name === 'table_cell' || n.type.name === 'table_header') return n
  }
  return null
}
// 当前单元格是否处于合并态（colspan/rowspan>1）才可拆分
function isMergedSel(sel) {
  const n = cellNodeUnder(sel.$from)
  return !!(n && (n.attrs.colspan > 1 || n.attrs.rowspan > 1))
}

// 编辑器内右键：表格上弹本菜单，其余位置不接——通用菜单（main.js 的 attachEditorContextMenu，
// 挂在窗格上）负责压掉 WebView2 原生菜单与出「剪切 / 复制 / 粘贴 / 插入」那一套。
// 两个监听器都听 contextmenu：本监听器挂 view.dom（事件先到它这儿），通用那个挂 .nl-pane
// 且见 defaultPrevented 就让路，所以表格右键不会出两个菜单。
// 落在表格上但不在格里（表格元素 / 包裹层空白 / 边框）时按指针位置找最近格，
// 找不到（如表外包一层空白）就不弹，别甩一个对空气说话的菜单出去。
export function attachTableContextMenu(view) {
  let menuEl = null
  const close = () => {
    if (menuEl && menuEl.parentNode) menuEl.parentNode.removeChild(menuEl)
    menuEl = null
  }

  const item = (label, onClick, danger) => {
    const b = document.createElement('button')
    b.className = 'cv-menu-item' + (danger ? ' danger' : '')
    const chk = document.createElement('span')
    chk.className = 'cv-menu-check'
    b.appendChild(chk)
    const lab = document.createElement('span')
    lab.className = 'cv-menu-label'
    lab.textContent = label
    b.appendChild(lab)
    b.addEventListener('mousedown', (e) => e.preventDefault()) // 不夺编辑器焦点
    b.addEventListener('click', () => {
      close()
      if (onClick) onClick()
    })
    return b
  }
  const sep = () => {
    const d = document.createElement('div')
    d.className = 'cv-menu-sep'
    return d
  }

  view.dom.addEventListener('contextmenu', (e) => {
    const onTable = !!(e.target && e.target.closest && e.target.closest('table'))
    if (!onTable) return // 非表格：交给窗格上的通用右键菜单
    e.preventDefault()
    close()

    // 把光标落到右键命中的单元格，后续命令都基于该单元格选区。
    // 但若已有跨格 CellSelection（多选准备合并），保留它不重置。
    const coords = view.posAtCoords({ left: e.clientX, top: e.clientY })
    if (!coords) return
    const $pos = view.state.doc.resolve(coords.pos)
    if (!cellAround($pos)) return
    if (!(view.state.selection instanceof CellSelection)) {
      view.dispatch(view.state.tr.setSelection(TextSelection.near($pos)))
    }
    // 绑定当前 view：命令读取此刻（选区已更新）的 state
    const run = (cmd) => () => {
      cmd(view.state, view.dispatch)
      view.focus()
    }
    // 拆分需把光标格升级为单选 CellSelection 再交 splitCell
    const runSplit = () => {
      let s = view.state
      if (!(s.selection instanceof CellSelection)) {
        const cr = cellAround(s.selection.$from)
        if (cr != null) s = s.apply(s.tr.setSelection(CellSelection.create(s.doc, cr.pos)))
      }
      splitCell(s, view.dispatch)
      view.focus()
    }

    const menu = document.createElement('div')
    menu.className = 'cv-menu table-menu'
    menu.appendChild(item(t('table.rowAbove'), run(addRowBefore)))
    menu.appendChild(item(t('table.rowBelow'), run(addRowAfter)))
    menu.appendChild(item(t('table.afterPara'), run(exitTableBelow)))
    menu.appendChild(item(t('table.rowDelete'), run(deleteRow), true))
    menu.appendChild(sep())
    menu.appendChild(item(t('table.colLeft'), run(addColumnBefore)))
    menu.appendChild(item(t('table.colRight'), run(addColumnAfter)))
    menu.appendChild(item(t('table.colDelete'), run(deleteColumn), true))
    menu.appendChild(sep())
    menu.appendChild(item(t('table.alignLeft'), run(setCellAttr('alignment', 'left'))))
    menu.appendChild(item(t('table.alignCenter'), run(setCellAttr('alignment', 'center'))))
    menu.appendChild(item(t('table.alignRight'), run(setCellAttr('alignment', 'right'))))
    menu.appendChild(item(t('table.alignClear'), run(setCellAttr('alignment', null))))
    menu.appendChild(sep())
    menu.appendChild(item(t('table.headerToggle'), run(toggleHeaderRow)))
    // 合并/拆分（仅在对应手势下出现）：多选≥ 2 格→合并；光标/选区落在合并态格→拆分
    if (isMultiCellSel(view.state.selection)) {
      menu.appendChild(sep())
      menu.appendChild(item(t('table.mergeCells'), run(mergeCells)))
    }
    if (isMergedSel(view.state.selection)) {
      menu.appendChild(item(t('table.splitCells'), runSplit))
    }
    menu.appendChild(sep())
    menu.appendChild(item(t('table.tableDelete'), run(deleteTable), true))

    document.body.appendChild(menu)
    let x = e.clientX
    let y = e.clientY
    const mw = menu.offsetWidth
    const mh = menu.offsetHeight
    if (x + mw > window.innerWidth - 4) x = Math.max(4, window.innerWidth - mw - 4)
    if (y + mh > window.innerHeight - 4) y = Math.max(4, window.innerHeight - mh - 4)
    menu.style.left = x + 'px'
    menu.style.top = y + 'px'
    menuEl = menu
  })

  document.addEventListener('mousedown', (ev) => {
    if (menuEl && !menuEl.contains(ev.target)) close()
  })
  window.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape') close()
  })
}
