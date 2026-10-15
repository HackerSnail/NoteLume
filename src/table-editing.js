// table-editing.js —— 表格编辑人体工学（基于 prosemirror-tables）
// 提供三块：① tablePlugins()：列宽拖拽 columnResizing + 单元格选择/规范化 tableEditing；
// ② tableKeymap()：Tab / Shift-Tab 在单元格间跳转（仅在表内生效，否则交回默认键位）；
// ③ attachTableContextMenu(view)：在单元格上右键弹出行列操作菜单（复用全局 .cv-menu 样式）。
//
// 边界：GFM 表格不支持合并单元格，故菜单只暴露能无损往返的操作（增删行列 / 切换表头 /
// 单元格对齐 / 删除表格），不接 merge/split——那会写出 GFM 表达不了的 colspan/rowspan。

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

    // 把光标落到右键命中的单元格，后续命令都基于该单元格选区
    const coords = view.posAtCoords({ left: e.clientX, top: e.clientY })
    if (coords) {
      const $pos = view.state.doc.resolve(coords.pos)
      view.dispatch(view.state.tr.setSelection(TextSelection.near($pos)))
    }
    // 绑定当前 view：命令读取此刻（选区已更新）的 state
    const run = (cmd) => () => {
      cmd(view.state, view.dispatch)
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
