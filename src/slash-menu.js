// slash-menu.js —— 空行输入 `/` 弹出块类型菜单（Typora 式，手搓 ProseMirror 插件，零新依赖）
//
// 机制（复用 suggest-plugin 的下拉观感与 ↑/↓/Enter/Tab/Esc 交互）：
//  · 当光标在**空段落**行首输入 `/`（其后是过滤词）时弹菜单；继续打字过滤，命中则替换整个块。
//  · 只在"块内容为 `/query`"时触发，故不会干扰正文中部的斜杠（路径 / URL / 日期等）。
//  · 选中后把当前段落整块替换为目标节点，用 Selection.near 把光标放进块内首个可编辑位置。
import { Plugin, PluginKey, Selection } from 'prosemirror-state'
import { schema } from './editor-schema.js'
import { setIcon } from './icons.js'

const N = schema.nodes
const para = () => N.paragraph.create()

// 项表对外可见：mac 原生「段落」菜单与 editor 命令注册共用同一份标签（不另写一套文案）
export const SLASH_ITEMS = [
  { id: 'para', icon: 'pilcrow', label: '正文', kw: 'text plain 正文 段落', build: () => para() },
  { id: 'h1', text: 'H1', label: '一级标题', kw: 'h1 heading 标题', build: () => N.heading.create({ level: 1 }) },
  { id: 'h2', text: 'H2', label: '二级标题', kw: 'h2 heading 标题', build: () => N.heading.create({ level: 2 }) },
  { id: 'h3', text: 'H3', label: '三级标题', kw: 'h3 heading 标题', build: () => N.heading.create({ level: 3 }) },
  { id: 'h4', text: 'H4', label: '四级标题', kw: 'h4 heading 标题', build: () => N.heading.create({ level: 4 }) },
  { id: 'h5', text: 'H5', label: '五级标题', kw: 'h5 heading 标题', build: () => N.heading.create({ level: 5 }) },
  { id: 'h6', text: 'H6', label: '六级标题', kw: 'h6 heading 标题', build: () => N.heading.create({ level: 6 }) },
  { id: 'bullet', icon: 'list-bullet', label: '无序列表', kw: 'ul bullet list 列表', build: () => N.bullet_list.create(null, N.list_item.create(null, para())) },
  { id: 'ordered', text: '1.', label: '有序列表', kw: 'ol ordered list 列表 有序', build: () => N.ordered_list.create(null, N.list_item.create(null, para())) },
  { id: 'task', icon: 'task', label: '任务列表', kw: 'task todo checkbox 任务 待办', build: () => N.bullet_list.create(null, N.list_item.create({ checked: false }, para())) },
  { id: 'code', icon: 'code', label: '代码块', kw: 'code codeblock 代码', build: () => N.code_block.create({ params: '' }) },
  { id: 'quote', icon: 'quote', label: '引用', kw: 'quote blockquote 引用', build: () => N.blockquote.create(null, para()) },
  { id: 'hr', icon: 'hr', label: '分割线', kw: 'hr divider rule 分割线 分隔', build: () => [N.horizontal_rule.create(), para()] },
  { id: 'table', icon: 'table', label: '表格', kw: 'table 表格', build: () =>
    N.table.create(null, [
      N.table_row.create(null, [N.table_header.create(null, []), N.table_header.create(null, [])]),
      N.table_row.create(null, [N.table_cell.create(null, []), N.table_cell.create(null, [])]),
    ]) },
  { id: 'callout', icon: 'lightbulb', label: '提示卡片', kw: 'callout note tip info 提示 标注', build: () => N.callout.create({ type: 'note', title: 'NOTE' }, para()) },
  { id: 'math', icon: 'math', label: '公式块', kw: 'math formula latex 公式', build: () => N.math_block.create({ latex: '' }) },
  { id: 'mermaid', icon: 'diagram', label: 'Mermaid 图', kw: 'mermaid diagram chart 图表 流程图', build: () => N.code_block.create({ params: 'mermaid' }) },
]

export const slashKey = new PluginKey('nl-slash')

export function createSlashMenuPlugin() {
  let menu = null // { el, spec, items, index }

  function filterItems(query) {
    const q = (query || '').toLowerCase().trim()
    if (!q) return SLASH_ITEMS.slice()
    const scored = []
    for (const it of SLASH_ITEMS) {
      const hay = (it.label + ' ' + it.kw).toLowerCase()
      if (hay.includes(q)) scored.push({ it, pref: it.label.toLowerCase().startsWith(q) || it.id.startsWith(q) ? 0 : 1 })
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
    head.textContent = '插入块'
    el.appendChild(head)
    spec.items.forEach((it, i) => {
      const item = document.createElement('div')
      item.className = 'nl-suggest-item' + (i === 0 ? ' active' : '')
      const ic = document.createElement('span')
      ic.className = 'nl-slash-ico'
      if (it.icon) setIcon(ic, it.icon); else ic.textContent = it.text
      const lab = document.createElement('span')
      lab.textContent = it.label
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
