// table-picker.js —— 插入表格前的行×列范围选择器（Word 式）
//
// 入口：Ctrl+T / 命令面板 / mac「段落」菜单（editor.block.table）与斜杠菜单的「表格」项。
// 选中范围后回调 onPick(rows, cols)，由调用方落进文档——本模块只管选，不管插。
// 机制：纯 DOM 浮层（定位 / 关闭套路同 slash-menu、code-lang-picker），网格 10×8，
// 悬停高亮 + 底部尺寸提示；方向键 / Tab 移动、Enter 落定、Esc 或点外面关闭。
// 同刻只开一个：入口可能连点，或快捷键与斜杠菜单前后脚触发。

import { t } from './i18n.js'

export const MAX_ROWS = 8
export const MAX_COLS = 10

let open = null // { el, close }，单例

export function closeTableSizePicker() {
  if (open) open.close()
}

/**
 * @param {object} view ProseMirror view（取光标坐标定位）
 * @param {object} opts
 * @param {number} opts.pos 定位用的文档位置（一般是光标处）
 * @param {(rows:number, cols:number)=>void} opts.onPick 落定回调
 */
export function showTableSizePicker(view, { pos, onPick }) {
  closeTableSizePicker()

  const el = document.createElement('div')
  el.className = 'nl-table-picker'
  const grid = document.createElement('div')
  grid.className = 'nl-tp-grid'
  const hint = document.createElement('div')
  hint.className = 'nl-tp-hint'

  const cells = []
  for (let r = 0; r < MAX_ROWS; r++) {
    for (let c = 0; c < MAX_COLS; c++) {
      const cell = document.createElement('span')
      cell.className = 'nl-tp-cell'
      cell.dataset.row = String(r)
      cell.dataset.col = String(c)
      grid.appendChild(cell)
      cells.push(cell)
    }
  }
  el.append(grid, hint)
  document.body.appendChild(el)

  let cur = { row: 1, col: 1 } // 默认 2×2

  function paint() {
    for (const cell of cells) {
      const on = +cell.dataset.row <= cur.row && +cell.dataset.col <= cur.col
      cell.classList.toggle('on', on)
    }
    hint.textContent = t('table.sizeHint', { rows: cur.row + 1, cols: cur.col + 1 })
  }

  function close() {
    document.removeEventListener('mousedown', onDocDown, true)
    window.removeEventListener('keydown', onKeyDown, true)
    if (el.parentNode) el.parentNode.removeChild(el)
    open = null
  }

  function pick() {
    const { row, col } = cur
    close()
    if (onPick) onPick(row + 1, col + 1)
  }

  // 点浮层外面关闭；浮层自身不拦 mousedown，点格子即落定
  function onDocDown(e) {
    if (!el.contains(e.target)) close()
  }
  // 键盘：方向键移、Tab 同右移（Shift+Tab 左移）、Enter 落定、Esc 关。capture 阶段拿，
  // 免得编辑器 keymap 先处理。Tab 走到最后一格再按 = 直接落定（QA GU-019：此前穿透给
  // 编辑器 keymap，不建行不退出还丢焦点）
  function onKeyDown(e) {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); return }
    if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); pick(); return }
    let dr = 0
    let dc = 0
    if (e.key === 'ArrowUp') dr = -1
    else if (e.key === 'ArrowDown') dr = 1
    else if (e.key === 'ArrowLeft') dc = -1
    else if (e.key === 'ArrowRight') dc = 1
    else if (e.key === 'Tab') { e.preventDefault(); e.stopPropagation(); if (e.shiftKey) move(-1, 0); else next(); return }
    else return
    e.preventDefault()
    e.stopPropagation()
    move(dr, dc)
  }

  function move(dr, dc) {
    cur = {
      row: Math.min(MAX_ROWS - 1, Math.max(0, cur.row + dr)),
      col: Math.min(MAX_COLS - 1, Math.max(0, cur.col + dc)),
    }
    paint()
  }

  // Tab 前进：到右边界换行，最后一格（8×10）再按 = 落定
  function next() {
    if (cur.row === MAX_ROWS - 1 && cur.col === MAX_COLS - 1) { pick(); return }
    if (cur.col === MAX_COLS - 1) move(1, -cur.col)
    else move(0, 1)
  }

  grid.addEventListener('mousemove', (e) => {
    const cell = e.target.closest('.nl-tp-cell')
    if (!cell) return
    cur = { row: +cell.dataset.row, col: +cell.dataset.col }
    paint()
  })
  grid.addEventListener('click', (e) => {
    const cell = e.target.closest('.nl-tp-cell')
    if (!cell) return
    cur = { row: +cell.dataset.row, col: +cell.dataset.col }
    pick()
  })
  el.addEventListener('mousedown', (e) => e.preventDefault()) // 不夺编辑器焦点

  // 定位到光标左下，越界翻转（同 slash-menu）；view.coordsAtPos 抛（位置过期）就停在原地
  let left = 4
  let top = 4
  try {
    const coords = view.coordsAtPos(pos)
    const rect = el.getBoundingClientRect()
    left = coords.left
    if (left + rect.width > window.innerWidth - 4) left = Math.max(4, window.innerWidth - rect.width - 4)
    top = coords.bottom + 4
    if (top + rect.height > window.innerHeight - 4) top = Math.max(4, coords.top - rect.height - 4)
  } catch (_) {}
  el.style.left = left + 'px'
  el.style.top = top + 'px'

  paint()
  document.addEventListener('mousedown', onDocDown, true)
  window.addEventListener('keydown', onKeyDown, true)
  open = { el, close }
}
