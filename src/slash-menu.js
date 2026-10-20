// slash-menu.js —— 空行输入 `/` 弹出块类型菜单（Typora 式，手搓 ProseMirror 插件，零新依赖）
//
// 机制（复用 suggest-plugin 的下拉观感与 ↑/↓/Enter/Tab/Esc 交互）：
//  · 当光标在**空段落**行首输入 `/`（其后是过滤词）时弹菜单；继续打字过滤，命中则替换整个块。
//  · 只在"块内容为 `/query`"时触发，故不会干扰正文中部的斜杠（路径 / URL / 日期等）。
//  · 选中后把当前段落整块替换为目标节点，用 Selection.near 把光标放进块内首个可编辑位置。
import { Plugin, PluginKey, Selection } from 'prosemirror-state'
import { schema } from './editor-schema.js'
import { createTable, insertTable } from './block-commands.js'
import { showTableSizePicker } from './table-picker.js'
import { setIcon } from './icons.js'
import { t } from './i18n.js'

const N = schema.nodes
const para = () => N.paragraph.create()

// 项表对外可见：mac 原生「段落」菜单与 editor 命令注册共用同一份标签（不另写一套文案）。
// label 是词条键，渲染时按当前语言取值（slashLabel），切换语言即刻生效，不必重建插件。
export const SLASH_ITEMS = [
  { id: 'para', icon: 'pilcrow', labelKey: 'cmd.block.para', kwKey: 'slash.kw.para', build: () => para() },
  { id: 'h1', text: 'H1', labelKey: 'cmd.block.h1', kwKey: 'slash.kw.h1', build: () => N.heading.create({ level: 1 }) },
  { id: 'h2', text: 'H2', labelKey: 'cmd.block.h2', kwKey: 'slash.kw.h2', build: () => N.heading.create({ level: 2 }) },
  { id: 'h3', text: 'H3', labelKey: 'cmd.block.h3', kwKey: 'slash.kw.h3', build: () => N.heading.create({ level: 3 }) },
  { id: 'h4', text: 'H4', labelKey: 'cmd.block.h4', kwKey: 'slash.kw.h4', build: () => N.heading.create({ level: 4 }) },
  { id: 'h5', text: 'H5', labelKey: 'cmd.block.h5', kwKey: 'slash.kw.h5', build: () => N.heading.create({ level: 5 }) },
  { id: 'h6', text: 'H6', labelKey: 'cmd.block.h6', kwKey: 'slash.kw.h6', build: () => N.heading.create({ level: 6 }) },
  { id: 'bullet', icon: 'list-bullet', labelKey: 'cmd.block.bullet', kwKey: 'slash.kw.bullet', build: () => N.bullet_list.create(null, N.list_item.create(null, para())) },
  { id: 'ordered', text: '1.', labelKey: 'cmd.block.ordered', kwKey: 'slash.kw.ordered', build: () => N.ordered_list.create(null, N.list_item.create(null, para())) },
  { id: 'task', icon: 'task', labelKey: 'cmd.block.task', kwKey: 'slash.kw.task', build: () => N.bullet_list.create(null, N.list_item.create({ checked: false }, para())) },
  { id: 'code', icon: 'code', labelKey: 'cmd.block.code', kwKey: 'slash.kw.code', build: () => N.code_block.create({ params: '' }) },
  { id: 'quote', icon: 'quote', labelKey: 'cmd.block.quote', kwKey: 'slash.kw.quote', build: () => N.blockquote.create(null, para()) },
  { id: 'hr', icon: 'hr', labelKey: 'cmd.block.hr', kwKey: 'slash.kw.hr', build: () => [N.horizontal_rule.create(), para()] },
  { id: 'table', icon: 'table', labelKey: 'cmd.block.table', kwKey: 'slash.kw.table', build: () =>
    N.table.create(null, [
      N.table_row.create(null, [N.table_header.create(null, []), N.table_header.create(null, [])]),
      N.table_row.create(null, [N.table_cell.create(null, []), N.table_cell.create(null, [])]),
    ]) },
  { id: 'callout', icon: 'lightbulb', labelKey: 'cmd.block.callout', kwKey: 'slash.kw.callout', build: () => N.callout.create({ type: 'note', title: 'NOTE' }, para()) },
  { id: 'math', icon: 'math', labelKey: 'cmd.block.math', kwKey: 'slash.kw.math', build: () => N.math_block.create({ latex: '' }) },
  { id: 'mermaid', icon: 'diagram', labelKey: 'cmd.block.mermaid', kwKey: 'slash.kw.mermaid', build: () => N.code_block.create({ params: 'mermaid' }) },
]

export function slashLabel(item) {
  return t(item.labelKey)
}

export const slashKey = new PluginKey('nl-slash')

export function createSlashMenuPlugin() {
  let menu = null // { el, spec, items, index }

  function filterItems(query) {
    const q = (query || '').toLowerCase().trim()
    if (!q) return SLASH_ITEMS.slice()
    const scored = []
    for (const it of SLASH_ITEMS) {
      const hay = (slashLabel(it) + ' ' + t(it.kwKey)).toLowerCase()
      if (hay.includes(q)) scored.push({ it, pref: slashLabel(it).toLowerCase().startsWith(q) || it.id.startsWith(q) ? 0 : 1 })
    }
    scored.sort((a, b) => a.pref - b.pref)
    return scored.map((s) => s.it)
  }

  // 空段落且内容为 `/query` → 触发
  function detect(state) {
    const sel = state.selection
    if (!sel.empty) return null
    const $h = sel.$head
    if (!$h.parent || $h.parent.type.name !== 'paragraph') return null
    const blockFrom = $h.start()
    const caret = $h.pos
    const before = state.doc.textBetween(blockFrom, caret, '\u0000', '\u0000')
    const m = /^\/([A-Za-z0-9_\u4e00-\u9fff]*)$/.exec(before)
    if (!m) return null
    // 仅当整块内容就是 `/query`（即块是从空开始敲的），避免命中行中斜杠
    const fullText = $h.parent.textContent || ''
    if (fullText !== before) return null
    const items = filterItems(m[1])
    if (!items.length) return null
    return { from: blockFrom, to: caret, blockStart: $h.before($h.depth), blockEnd: $h.after($h.depth), items }
  }

  function applyItem(view, spec, item) {
    const state = view.state
    // 表格：先选 N×M 范围，选中后把 `/表格` 所在块整块换成表（与其它项同一落点）。
    // 选择器开着的时候文档被动过（用户切走打了字），落回「当前块之后插入」，与 Ctrl+T 同路。
    if (item.id === 'table') {
      removeMenu()
      const doc0 = state.doc
      showTableSizePicker(view, {
        pos: spec.from,
        onPick: (rows, cols) => {
          const st = view.state
          if (st.doc === doc0) {
            const tr = st.tr.replaceWith(spec.blockStart, spec.blockEnd, [createTable(rows, cols), para()])
            try { tr.setSelection(Selection.near(tr.doc.resolve(spec.blockStart), 1)) } catch (_) {}
            view.dispatch(tr.scrollIntoView())
          } else {
            insertTable(st, view.dispatch, rows, cols)
          }
          view.focus()
        },
      })
      return
    }
    let built
    try { built = item.build() } catch (_) { return }
    const content = Array.isArray(built) ? built : [built]
    const tr = state.tr.replaceWith(spec.blockStart, spec.blockEnd, content)
    try { tr.setSelection(Selection.near(tr.doc.resolve(spec.blockStart), 1)) } catch (_) {}
    view.dispatch(tr.scrollIntoView())
    view.focus()
  }

  function removeMenu() {
    if (menu && menu.el && menu.el.parentNode) menu.el.parentNode.removeChild(menu.el)
    menu = null
  }

  function positionMenu(view) {
    if (!menu) return
    const coords = view.coordsAtPos(menu.spec.from)
    const rect = menu.el.getBoundingClientRect()
    let left = coords.left
    if (left + rect.width > window.innerWidth - 4) left = Math.max(4, window.innerWidth - rect.width - 4)
    let top = coords.bottom + 4
    if (top + rect.height > window.innerHeight - 4) top = Math.max(4, coords.top - rect.height - 4)
    menu.el.style.left = left + 'px'
    menu.el.style.top = top + 'px'
  }

  function renderMenu(view, spec) {
    if (!menu) {
      const el = document.createElement('div')
      el.className = 'nl-suggest nl-slash'
      el.addEventListener('mousedown', (e) => e.preventDefault())
      document.body.appendChild(el)
      menu = { el, spec: null, items: [], index: 0 }
    }
    menu.spec = spec
    menu.items = spec.items
    menu.index = 0
    const el = menu.el
    el.innerHTML = ''
    const head = document.createElement('div')
    head.className = 'nl-suggest-head'
    head.textContent = t('slash.head')
    el.appendChild(head)
    spec.items.forEach((it, i) => {
      const item = document.createElement('div')
      item.className = 'nl-suggest-item' + (i === 0 ? ' active' : '')
      const ic = document.createElement('span')
      ic.className = 'nl-slash-ico'
      if (it.icon) setIcon(ic, it.icon); else ic.textContent = it.text
      const lab = document.createElement('span')
      lab.textContent = slashLabel(it)
      item.append(ic, lab)
      item.addEventListener('click', () => { applyItem(view, menu.spec, it); removeMenu() })
      el.appendChild(item)
    })
    positionMenu(view)
  }

  function moveActive(delta) {
    if (!menu) return
    const n = menu.items.length
    if (!n) return
    menu.index = (menu.index + delta + n) % n
    const kids = menu.el.querySelectorAll('.nl-suggest-item')
    kids.forEach((k, i) => k.classList.toggle('active', i === menu.index))
    if (kids[menu.index]) kids[menu.index].scrollIntoView({ block: 'nearest' })
  }

  function applyActive(view) {
    if (!menu) return
    const it = menu.items[menu.index]
    if (!it) return
    applyItem(view, menu.spec, it)
    removeMenu()
  }

  return new Plugin({
    key: slashKey,
    props: {
      handleKeyDown(view, event) {
        if (!menu) return false
        if (event.key === 'ArrowDown') { event.preventDefault(); moveActive(1); return true }
        if (event.key === 'ArrowUp') { event.preventDefault(); moveActive(-1); return true }
        if (event.key === 'Enter' && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey) { event.preventDefault(); applyActive(view); return true }
        if (event.key === 'Tab') { event.preventDefault(); applyActive(view); return true }
        if (event.key === 'Escape') { event.preventDefault(); removeMenu(); return true }
        return false
      },
    },
    view() {
      return {
        update(view, prevState) {
          const state = view.state
          const docChanged = !state.doc.eq(prevState.doc)
          const selChanged = !state.selection.eq(prevState.selection)
          if (!docChanged && !selChanged) return
          const spec = detect(state)
          if (!spec) { removeMenu(); return }
          renderMenu(view, spec)
        },
        destroy() { removeMenu() },
      }
    },
  })
}
