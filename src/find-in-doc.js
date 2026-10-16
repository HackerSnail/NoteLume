// find-in-doc.js —— 当前文档内查找（Ctrl+F）：视图层高亮 + 上下跳转
//
// 设计：纯渲染层，不改文档模型、不产生任何私有 markdown 语法（符合 GFM 约束）。
//  · findMatches：在 doc 的每个文本节点内做子串匹配，命中不跨块（与 Typora/Obsidian 一致）。
//  · findPlugin：把命中区间叠成 inline Decoration（全部命中一种色、当前命中另一种色）。
//  · createFindBar：悬浮查找栏 UI（输入框 / 计数 / 上下 / 大小写 / 关闭），命令式驱动插件。

import { Plugin, PluginKey, TextSelection } from 'prosemirror-state'
import { Decoration, DecorationSet } from 'prosemirror-view'

export const findKey = new PluginKey('nl-find')

/**
 * 纯逻辑：按文档序收集 query 在 doc 中的所有命中区间（PM 文档坐标）。
 * @param {import('prosemirror-model').Node} doc
 * @param {string} query 查找词（空串 → 无命中）
 * @param {boolean} caseSensitive 默认不敏感
 * @returns {Array<{from:number,to:number}>}
 */
export function findMatches(doc, query, caseSensitive = false) {
  const matches = []
  if (!query) return matches
  const needle = caseSensitive ? query : query.toLowerCase()
  doc.descendants((node, pos) => {
    // 只在文本节点内匹配：块（段落/标题/列表项/代码行）之间不跨越
    if (!node.isText || !node.text) return
    const hay = caseSensitive ? node.text : node.text.toLowerCase()
    let i = 0
    for (;;) {
      const idx = hay.indexOf(needle, i)
      if (idx < 0) break
      matches.push({ from: pos + idx, to: pos + idx + needle.length })
      i = idx + needle.length // 不重叠：下一处从本次结束继续
    }
  })
  return matches
}

export function findPlugin() {
  return new Plugin({
    key: findKey,
    state: {
      init() {
        return { query: '', matches: [], activeIndex: -1, caseSensitive: false }
      },
      apply(tr, old) {
        const meta = tr.getMeta(findKey)
        if (meta) return { ...old, ...meta } // 控制器算好命中后整体覆盖
        if (!tr.docChanged) return old
        // 文档被编辑：用 mapping 平移既有命中，删除导致的空命中丢弃（下次输入会重算）
        const mapped = []
        for (const m of old.matches) {
          const f = tr.mapping.mapResult(m.from)
          const t = tr.mapping.mapResult(m.to)
          if (f.deleted || t.deleted) continue
          if (t.pos > f.pos) mapped.push({ from: f.pos, to: t.pos })
        }
        const activeIndex = mapped.length ? Math.min(Math.max(old.activeIndex, 0), mapped.length - 1) : -1
        return { ...old, matches: mapped, activeIndex }
      },
    },
    props: {
      decorations(state) {
        const st = findKey.getState(state)
        if (!st || !st.matches.length) return null
        const decos = st.matches.map((m, i) =>
          Decoration.inline(m.from, m.to, {
            class: 'nl-find-match' + (i === st.activeIndex ? ' nl-find-match-active' : ''),
          })
        )
        return DecorationSet.create(state.doc, decos)
      },
    },
  })
}

/**
 * 创建查找栏控制器。
 * @param {{view:import('prosemirror-view').EditorView, paneEl:HTMLElement}} opts
 *   paneEl：查找栏挂载容器（.editor-pane，position:relative 且为滚动容器）
 */
export function createFindBar({ view, paneEl }) {
  let bar, input, countEl, caseBtn
  let caseSensitive = false
  let visible = false
  let lastMatches = []

  function build() {
    bar = document.createElement('div')
    bar.className = 'nl-find-bar'

    input = document.createElement('input')
    input.type = 'text'
    input.className = 'nl-find-input'
    input.placeholder = '在本篇文档中查找…'
    input.setAttribute('aria-label', '文档内查找')

    countEl = document.createElement('span')
    countEl.className = 'nl-find-count'
    countEl.textContent = '0/0'

    caseBtn = document.createElement('button')
    caseBtn.className = 'nl-find-btn nl-find-case'
    caseBtn.type = 'button'
    caseBtn.textContent = 'Aa'
    caseBtn.title = '区分大小写'
    caseBtn.addEventListener('click', () => {
      caseSensitive = !caseSensitive
      caseBtn.classList.toggle('on', caseSensitive)
      runFind(true)
    })

    const mk = (label, title, fn) => {
      const b = document.createElement('button')
      b.className = 'nl-find-btn'
      b.type = 'button'
      b.textContent = label
      b.title = title
      b.addEventListener('click', fn)
      return b
    }
    const prev = mk('↑', '上一个（Shift+Enter）', () => step(-1))
    const next = mk('↓', '下一个（Enter）', () => step(1))
    const closeBtn = mk('×', '关闭（Esc）', () => closeBar())

    bar.append(input, countEl, caseBtn, prev, next, closeBtn)
    paneEl.appendChild(bar)

    // 输入实时刷新；Enter 下一个、Shift+Enter 上一个、Esc 关闭
    input.addEventListener('input', () => runFind(true))
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault()
        step(e.shiftKey ? -1 : 1)
      } else if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        closeBar()
      }
    })
  }

  // 把查找栏钉在滚动容器可视顶部（pane 本身滚动，绝对定位会随内容走，需补 scrollTop）
  function pin() {
    if (bar) bar.style.top = paneEl.scrollTop + 12 + 'px'
  }

  function setState(patch) {
    view.dispatch(view.state.tr.setMeta(findKey, patch))
  }

  function updateCount() {
    const total = lastMatches.length
    const cur = total ? Math.min(lastMatches.length, Math.max(0, activeIndex()) + 1) : 0
    countEl.textContent = total ? `${cur}/${total}` : '0/0'
  }

  // 从插件当前 state 读 activeIndex（控制器不额外持有，避免与插件态分叉）
  function activeIndex() {
    const st = findKey.getState(view.state)
    return st ? st.activeIndex : -1
  }

  function runFind(resetIndex) {
    const query = input.value
    lastMatches = findMatches(view.state.doc, query, caseSensitive)
    let idx
    if (!lastMatches.length) idx = -1
    else idx = resetIndex ? 0 : Math.min(Math.max(activeIndex(), 0), lastMatches.length - 1)
    setState({ query, matches: lastMatches, activeIndex: idx, caseSensitive })
    updateCount()
    if (idx >= 0) reveal(idx)
  }

  function step(dir) {
    if (!lastMatches.length) return
    const n = lastMatches.length
    const idx = (((activeIndex() + dir) % n) + n) % n // 回绕
    setState({ activeIndex: idx })
    updateCount()
    reveal(idx)
  }

  // 滚动到第 idx 个命中并选中（选区让 PM 原生把它滚入视野），随后把焦点还给输入框以便继续打字
  function reveal(idx) {
    const m = lastMatches[idx]
    if (!m) return
    const tr = view.state.tr.setSelection(TextSelection.create(view.state.doc, m.from, m.to))
    view.dispatch(tr.scrollIntoView())
    input.focus()
  }

  function openBar() {
    if (!bar) build()
    visible = true
    bar.classList.add('show')
    paneEl.addEventListener('scroll', pin)
    pin()
    // 若编辑器有非空文本选区，用它预填查找词并立刻定位
    const sel = view.state.selection
    const selText = sel && !sel.empty ? view.state.doc.textBetween(sel.from, sel.to, '\n', '\n') : ''
    if (selText && !/[\n\r]/.test(selText)) input.value = selText
    input.focus()
    input.select()
    runFind(true)
  }

  function closeBar() {
    if (!bar) return
    visible = false
    bar.classList.remove('show')
    paneEl.removeEventListener('scroll', pin)
    lastMatches = []
    setState({ query: '', matches: [], activeIndex: -1 })
    view.focus()
  }

  function toggle() {
    if (visible) closeBar()
    else openBar()
  }

  return {
    open: openBar,
    close: closeBar,
    toggle,
    isOpen: () => visible,
  }
}
