// suggest-plugin.js —— `[[` 文档名 / `#` 标签 / 段首 ``` 语言 输入自动补全下拉（手搓 ProseMirror 插件，零新依赖）
// 机制：不拦截文本输入；每次 doc/选区变化后在光标前识别 `[[query`、`#query` 或段首
// ``` / ```lang，命中候选则弹下拉；↑/↓ 移动、Enter/Tab 选当前、Esc 关闭；
// 选中后用 schema 已有的 wikiLink / tag 节点替换原始 `[[…`/`#…`，围栏语言则整段转
// code_block（fenceLangTr，与空格 / 回车进入路径同一条转换规则）。

import { Plugin, PluginKey, TextSelection } from 'prosemirror-state'
import { schema } from './editor-schema.js'
import { FENCE_RE, fenceLangTr } from './block-input-rules.js'
import { filterFenceLangs } from './code-lang-list.js'
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

    // 字符集与 editor-schema.js 的标签行内规则、Rust 侧 is_tag_char 同一口径（含中文标签）
    m = /(?:^|[\s(\u0000])#([\p{L}\p{N}_\-/]*)$/u.exec(before)
    if (m) {
      const whole = m[0]
      const hashIdx = whole.indexOf('#')
      const from = caret - (whole.length - hashIdx)
      const items = filterItems(getTags, m[1])
      if (items.length) return { kind: 'tag', from, to: caret, query: m[1], items }
      return null
    }

    // 段首 ``` / ```lang 的语言联想（Typora 式）：只认段落——代码块里敲 ``` 是代码内容，
    // 块内退出走 block-commands.js 的 codeFenceExit，不在这弹；候选为 hljs 注册语言
    // （含 bibtex / csv / mermaid 预览语言），前缀过滤，常用置顶。
    // 锚点取语言名起点（没敲语言时落在围栏末端即光标处），浮层贴着正在打的语言名
    m = FENCE_RE.exec(before)
    if (m) {
      if ($head.parent.type.name !== 'paragraph') return null
      const items = filterFenceLangs(m[1])
      if (items.length) return { kind: 'fence', from: caret - m[1].length, to: caret, query: m[1], items }
      return null
    }
    return null
  }

  function applyCompletion(view, spec, value) {
    const state = view.state
    // 围栏语言：整段转代码块（params = 选中语言），光标落块内，之后直接打代码
    if (spec.kind === 'fence') {
      const tr = fenceLangTr(state, value)
      if (tr) view.dispatch(tr.scrollIntoView())
      return
    }
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
    head.textContent = spec.kind === 'wiki' ? t('suggest.wikiHead') : spec.kind === 'tag' ? t('suggest.tagHead') : t('suggest.fenceHead')
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
