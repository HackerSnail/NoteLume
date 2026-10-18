// suggest-plugin.js —— `[[` 文档名 / `#` 标签 输入自动补全下拉（手搓 ProseMirror 插件，零新依赖）
// 机制：不拦截文本输入；每次 doc/选区变化后在光标前识别 `[[query` 或 `#query`，命中候选则弹下拉；
// ↑/↓ 移动、Enter/Tab 选当前、Esc 关闭；选中后用 schema 已有的 wikiLink / tag 节点替换原始 `[[…`/`#…`。

import { Plugin, PluginKey, TextSelection } from 'prosemirror-state'
import { schema } from './editor-schema.js'
import { t } from './i18n.js'

export const suggestKey = new PluginKey('nl-suggest')

export function createSuggestPlugin({ getDocs, getTags }) {
  let menu = null // { el, spec, items, index }

  const displayLabel = (kind, value) => (kind === 'tag' ? '#' + value : value)

  function filterItems(source, query) {
    const arr = (typeof source === 'function' && source()) || []
    const q = (query || '').toLowerCase()
    let out
    if (!q) {
      out = arr.slice()
    } else {
      out = arr.filter((v) => String(v).toLowerCase().includes(q))
      out.sort((a, b) => {
        const ap = String(a).toLowerCase().startsWith(q) ? 0 : 1
        const bp = String(b).toLowerCase().startsWith(q) ? 0 : 1
        return ap - bp || String(a).localeCompare(String(b))
      })
    }
    // 去重 + 截断
    const seen = new Set()
    const res = []
    for (const v of out) {
      if (seen.has(v)) continue
      seen.add(v)
      res.push(v)
      if (res.length >= 12) break
    }
    return res
  }

  // 在光标前识别补全上下文；返回 { kind, from, to, query, items } 或 null
  function detect(state) {
    const sel = state.selection
    if (!sel.empty) return null
    const $head = sel.$head
    if (!$head.parent || !$head.parent.isTextblock) return null
    const blockFrom = $head.start()
    const caret = $head.pos
    const before = state.doc.textBetween(blockFrom, caret, '\u0000', '\u0000')

    let m = /\[\[([^\[\]\n]*)$/.exec(before)
    if (m) {
      const from = caret - m[0].length
      const items = filterItems(getDocs, m[1])
      if (items.length) return { kind: 'wiki', from, to: caret, query: m[1], items }
      return null
    }

    m = /(?:^|[\s(\u0000])#([A-Za-z0-9_\-/]*)$/.exec(before)
    if (m) {
      const whole = m[0]
      const hashIdx = whole.indexOf('#')
      const from = caret - (whole.length - hashIdx)
      const items = filterItems(getTags, m[1])
      if (items.length) return { kind: 'tag', from, to: caret, query: m[1], items }
      return null
    }
    return null
  }

  function applyCompletion(view, spec, value) {
    const state = view.state
    let node
    if (spec.kind === 'wiki') node = schema.nodes.wikiLink.create({ target: value, label: null })
    else node = schema.nodes.tag.create({ tag: value })
    const tr = state.tr.replaceWith(spec.from, spec.to, node)
    tr.setSelection(TextSelection.create(tr.doc, spec.from + node.nodeSize))
    view.dispatch(tr.scrollIntoView())
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
      el.className = 'nl-suggest'
      el.addEventListener('mousedown', (e) => e.preventDefault()) // 不夺编辑器焦点
      document.body.appendChild(el)
      menu = { el, spec: null, items: [], index: 0 }
    }
    if (!spec) {
      removeMenu()
      return
    }
    menu.spec = spec
    menu.items = spec.items
    menu.index = 0
    const el = menu.el
    el.innerHTML = ''
    const head = document.createElement('div')
    head.className = 'nl-suggest-head'
    head.textContent = spec.kind === 'wiki' ? t('suggest.wikiHead') : t('suggest.tagHead')
    el.appendChild(head)
    spec.items.forEach((value, i) => {
      const item = document.createElement('div')
      item.className = 'nl-suggest-item' + (i === 0 ? ' active' : '')
      item.textContent = displayLabel(spec.kind, value)
      item.addEventListener('click', () => {
        applyCompletion(view, menu.spec, value)
        removeMenu()
      })
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
    const value = menu.items[menu.index]
    if (value == null) return
    applyCompletion(view, menu.spec, value)
    removeMenu()
  }

  return new Plugin({
    key: suggestKey,
    props: {
      handleKeyDown(view, event) {
        if (!menu) return false
        if (event.key === 'ArrowDown') {
          event.preventDefault()
          moveActive(1)
          return true
        }
        if (event.key === 'ArrowUp') {
          event.preventDefault()
          moveActive(-1)
          return true
        }
        if (event.key === 'Enter' && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey) {
          event.preventDefault()
          applyActive(view)
          return true
        }
        if (event.key === 'Tab' && !event.shiftKey) {
          event.preventDefault()
          applyActive(view)
          return true
        }
        if (event.key === 'Escape') {
          event.preventDefault()
          removeMenu()
          return true
        }
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
          if (!spec) {
            removeMenu()
            return
          }
          renderMenu(view, spec)
        },
        destroy() {
          removeMenu()
        },
      }
    },
  })
}
