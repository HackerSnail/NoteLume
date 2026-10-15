// table-editing.js —— 表格编辑人体工学（基于 prosemirror-tables）
// 提供三块：① tablePlugins()：列宽拖拽 columnResizing + 单元格选择/规范化 tableEditing；
// ② tableKeymap()：Tab / Shift-Tab 在单元格间跳转（仅在表内生效，否则交回默认键位）；
// ③ attachTableContextMenu(view)：在单元格上右键弹出行列操作菜单（复用全局 .cv-menu 样式）。
//
// 边界：功能项 J 起，本编辑器可无损往返合并单元格——含合并的表序列化为真 <table> HTML、
// 解析回节点由 editor-schema.js 两阶段预处理完成，故菜单开放「合并/拆分单元格」。
// 注意单元格内容受 cellContent:'inline*' 约束：一个格内不放多段落/块级列表（合并为单段内联）。

import { keymap } from 'prosemirror-keymap'
import { TextSelection } from 'prosemirror-state'
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

// 装配进编辑器插件数组。tableEditing 放在数组靠后（它对鼠标/方向键处理较宽泛，
// 让 columnResizing 等更具体的插件先取得事件权）。
export function tablePlugins() {
  return [columnResizing({ View: AutoTableView }), tableEditing()]
}

// Tab / Shift-Tab 跨格。放在普通 keymap 之前；不在表内时返回 false 交回后续键位。
export function tableKeymap() {
  return keymap({
    Tab: (state, dispatch, view) => (isInTable(state) ? goToNextCell(1)(state, dispatch, view) : false),
    'Shift-Tab': (state, dispatch, view) => (isInTable(state) ? goToNextCell(-1)(state, dispatch, view) : false),
  })
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

// 在单元格上右键：弹出行列操作菜单。非表格区域不拦截（保留浏览器/应用默认行为）。
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
    const cell = e.target && e.target.closest ? e.target.closest('td, th') : null
    if (!cell) return
    e.preventDefault()
    close()

    // 把光标落到右键命中的单元格，后续命令都基于该单元格选区。
    // 但若已有跨格 CellSelection（多选准备合并），保留它不重置。
    const coords = view.posAtCoords({ left: e.clientX, top: e.clientY })
    if (coords && !(view.state.selection instanceof CellSelection)) {
      const $pos = view.state.doc.resolve(coords.pos)
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
    menu.appendChild(item('上方插入行', run(addRowBefore)))
    menu.appendChild(item('下方插入行', run(addRowAfter)))
    menu.appendChild(item('删除本行', run(deleteRow), true))
    menu.appendChild(sep())
    menu.appendChild(item('左侧插入列', run(addColumnBefore)))
    menu.appendChild(item('右侧插入列', run(addColumnAfter)))
    menu.appendChild(item('删除本列', run(deleteColumn), true))
    menu.appendChild(sep())
    menu.appendChild(item('左对齐单元格', run(setCellAttr('alignment', 'left'))))
    menu.appendChild(item('居中对齐单元格', run(setCellAttr('alignment', 'center'))))
    menu.appendChild(item('右对齐单元格', run(setCellAttr('alignment', 'right'))))
    menu.appendChild(item('清除对齐', run(setCellAttr('alignment', null))))
    menu.appendChild(sep())
    menu.appendChild(item('切换首行为表头', run(toggleHeaderRow)))
    // 合并/拆分（仅在对应手势下出现）：多选≥ 2 格→合并；光标/选区落在合并态格→拆分
    if (isMultiCellSel(view.state.selection)) {
      menu.appendChild(sep())
      menu.appendChild(item('合并单元格', run(mergeCells)))
    }
    if (isMergedSel(view.state.selection)) {
      menu.appendChild(item('拆分单元格', runSplit))
    }
    menu.appendChild(sep())
    menu.appendChild(item('删除整个表格', run(deleteTable), true))

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
