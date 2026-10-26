// find-in-doc.js —— 当前文档内查找 / 替换（Ctrl+F 查找，Ctrl+H 查找+替换）
//
// 设计：查找高亮是纯渲染层装饰；替换走 ProseMirror 事务（撤销/重做、markdown 序列化均无损），
// 不产生任何私有 markdown 语法（符合 GFM 约束）。
//  · findMatches：在 doc 的每个文本节点内做子串匹配，命中不跨块（与 Typora/Obsidian 一致）。
//  · buildReplaceTr：把命中替换成给定文本，保留该处内联标记；多个命中合并为一个事务（一步可撤销）。
//  · findPlugin：把命中区间叠成 inline Decoration（全部命中一种色、当前命中另一种色）。
//  · createFindBar：悬浮查找栏 UI（查找 + 替换，命令式驱动插件）。

import { Plugin, PluginKey, TextSelection } from 'prosemirror-state'
import { Decoration, DecorationSet } from 'prosemirror-view'
import { setIcon } from './icons.js'
import { t } from './i18n.js'
import { confirmDialog } from './tauri-bridge.js'

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

/**
 * 纯逻辑：在 state 上构造一个「把给定命中替换成 replacement」的事务（可离线测）。
 * - 多个命中合并到同一个事务 = 一步撤销即可全撤回；从后往前替换避免位置串动。
 * - replacement 为空串时等价于删除该命中。
 * - 命中落在加粗/斜体/行内代码等标记内时，替换文本沿用该处 marks（不把粗体里的词替成正文字）。
 * @param {import('prosemirror-state').EditorState} state
 * @param {Array<{from:number,to:number}>} targets 命中区间（原文档坐标）
 * @param {string} replacement 替换文本
 * @returns {import('prosemirror-state').Transaction|null} 无可替换返回 null
 */
export function buildReplaceTr(state, targets, replacement) {
  if (!targets || !targets.length) return null
  const tr = state.tr
  // 降序处理：先替换靠后的，靠前命中的原始坐标不受后方改动影响（前面文本长度未变）
  const sorted = targets.slice().sort((a, b) => b.from - a.from)
  for (const m of sorted) {
    if (replacement === '') {
      tr.delete(m.from, m.to)
    } else {
      const marks = marksOfTextAt(state.doc, m.from)
      tr.replaceWith(m.from, m.to, state.schema.text(replacement, marks))
    }
  }
  return tr
}

// 取命中起点所在文本节点的 marks：起点恰好是节点开头时 nodeAfter 即该文本节点；
// 落在节点中间（nodeAfter 为空）则回退到起点右侧一格取内部 marks。
// （resolve(pos).marks() 在节点起始边界会返回空集，不能用它）
function marksOfTextAt(doc, pos) {
  const $pos = doc.resolve(pos)
  const after = $pos.nodeAfter
  if (after && after.isText) return after.marks
  return doc.resolve(Math.min(pos + 1, doc.content.size)).marks()
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
  let bar, input, replaceInput, countEl, caseBtn
  let caseSensitive = false
  let visible = false
  let lastMatches = []

  function build() {
    bar = document.createElement('div')
    bar.className = 'nl-find-bar'

    // —— 第一行：查找输入 + 计数 + 大小写 + 上下 + 关闭 ——
    const row1 = document.createElement('div')
    row1.className = 'nl-find-row'

    input = document.createElement('input')
    input.type = 'text'
    input.className = 'nl-find-input'
    input.placeholder = t('find.placeholder')
    input.setAttribute('aria-label', t('find.aria'))

    countEl = document.createElement('span')
    countEl.className = 'nl-find-count'
    countEl.textContent = '0/0'

    caseBtn = document.createElement('button')
    caseBtn.className = 'nl-find-btn nl-find-case'
    caseBtn.type = 'button'
    caseBtn.textContent = 'Aa'
    caseBtn.title = t('find.caseTip')
    caseBtn.addEventListener('click', () => {
      caseSensitive = !caseSensitive
      caseBtn.classList.toggle('on', caseSensitive)
      runFind(true)
      input.focus()
    })

    const mk = (label, title, fn, cls) => {
      const b = document.createElement('button')
      b.className = 'nl-find-btn' + (cls ? ' ' + cls : '')
      b.type = 'button'
      b.textContent = label
      b.title = title
      b.addEventListener('click', fn)
      return b
    }
    const mkIcon = (icon, title, fn) => {
      const b = mk('', title, fn)
      setIcon(b, icon, '')
      return b
    }
    const prev = mkIcon('arrow-up', t('find.prevTip'), () => { step(-1); input.focus() })
    const next = mkIcon('arrow-down', t('find.nextTip'), () => { step(1); input.focus() })
    const closeBtn = mkIcon('close', t('find.closeTip'), () => closeBar())

    row1.append(input, countEl, caseBtn, prev, next, closeBtn)

    // —— 第二行：替换输入 + 替换 / 全部替换（常显） ——
    const row2 = document.createElement('div')
    row2.className = 'nl-find-row nl-find-row-replace'

    replaceInput = document.createElement('input')
    replaceInput.type = 'text'
    replaceInput.className = 'nl-find-input nl-find-replace-input'
    replaceInput.placeholder = t('find.replacePh')
    replaceInput.setAttribute('aria-label', t('find.replaceAria'))

    const replaceOneBtn = mk(t('find.replaceOne'), t('find.replaceOneTip'), () => { doReplaceOne(); replaceInput.focus() }, 'nl-find-replace-btn')
    const replaceAllBtn = mk(t('find.replaceAll'), t('find.replaceAllTip'), () => { doReplaceAll() }, 'nl-find-replace-btn')

    row2.append(replaceInput, replaceOneBtn, replaceAllBtn)
    bar.append(row1, row2)
    paneEl.appendChild(bar)

    // 查找框：输入实时刷新；Enter 下一个、Shift+Enter 上一个、Esc 关闭
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
    // 替换框：Enter 替换当前项、Shift+Enter 上一个、Esc 关闭
    replaceInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault()
        if (e.shiftKey) step(-1)
        else doReplaceOne()
      } else if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        closeBar()
      }
    })
  }

  // 把查找栏钉在滚动容器可视顶部（pane 本身滚动，绝对定位会随内容走，需补 scrollTop）。
  // 偏移含窗格标签条高度（完整分栏后每条 pane 顶部有 sticky 条子，压上去会重叠）
  const STRIP_H = 34
  function pin() {
    if (bar) bar.style.top = paneEl.scrollTop + 12 + STRIP_H + 'px'
  }

  function setState(patch) {
    view.dispatch(view.state.tr.setMeta(findKey, patch))
  }

  function updateCount() {
    const st = findState()
    const total = st.matches.length
    const cur = total ? Math.min(total, Math.max(0, st.activeIndex) + 1) : 0
    countEl.textContent = total ? `${cur}/${total}` : '0/0'
  }

  // 计数与命中一律以插件 state 为准：文档被外部改动（撤销 / 手改）后 mapped 命中
  // 已平移，控制器若另存一份就会出现「还原后计数仍是 0/0」这类不同步
  function findState() {
    const st = findKey.getState(view.state)
    return st || { query: '', matches: [], activeIndex: -1, caseSensitive }
  }

  function runFind(resetIndex) {
    const query = input.value
    lastMatches = findMatches(view.state.doc, query, caseSensitive)
    let idx
    if (!lastMatches.length) idx = -1
    else idx = resetIndex ? 0 : Math.min(Math.max(findState().activeIndex, 0), lastMatches.length - 1)
    setState({ query, matches: lastMatches, activeIndex: idx, caseSensitive })
    updateCount()
    if (idx >= 0) reveal(idx)
  }

  function step(dir) {
    const st = findState()
    const n = st.matches.length
    if (!n) return
    const idx = (((st.activeIndex + dir) % n) + n) % n // 回绕
    setState({ activeIndex: idx })
    updateCount()
    reveal(idx)
  }

  // 滚动到第 idx 个命中并选中（选区让 PM 原生把它滚入视野）；不动 DOM 焦点（由调用方决定焦点落哪）
  function reveal(idx) {
    const m = findState().matches[idx]
    if (!m) return
    const tr = view.state.tr.setSelection(TextSelection.create(view.state.doc, m.from, m.to))
    view.dispatch(tr.scrollIntoView())
  }

  // 替换当前高亮项，随后重算命中（被替换项消失后 activeIndex 自然落到下一个）
  function doReplaceOne() {
    const st = findState()
    if (st.activeIndex < 0 || !st.matches[st.activeIndex]) return
    const tr = buildReplaceTr(view.state, [st.matches[st.activeIndex]], replaceInput.value)
    if (tr) view.dispatch(tr)
    runFind(false)
  }

  // 全部替换：一个事务改完全部命中（一步撤销即可全撤回）
  async function doReplaceAll() {
    const st = findState()
    if (!st.matches.length) return
    // 替换框留空 = 删除全部命中，属破坏性操作，先确认（确认框不可用则视为放弃，不静默删文）
    if (replaceInput.value === '') {
      try {
        const ok = await confirmDialog(t('find.confirmDeleteAll', { n: st.matches.length }), t('find.replaceAll'))
        if (!ok) return
      } catch (_) {
        return
      }
    }
    const tr = buildReplaceTr(view.state, st.matches, replaceInput.value)
    if (tr) view.dispatch(tr)
    runFind(true)
    view.focus() // 焦点留在替换框时 Ctrl+Z 撤的是输入框内容，撤不到刚做的替换
  }

  // focus：'find'（Ctrl+F）或 'replace'（Ctrl+H）；决定打开后光标落在哪个输入框
  function openBar(focus = 'find') {
    if (!bar) build()
    visible = true
    bar.classList.add('show')
    paneEl.addEventListener('scroll', pin)
    pin()
    // 若编辑器有非空文本选区，用它预填查找词并立刻定位
    const sel = view.state.selection
    const selText = sel && !sel.empty ? view.state.doc.textBetween(sel.from, sel.to, '\n', '\n') : ''
    if (selText && !/[\n\r]/.test(selText)) input.value = selText
    runFind(true)
    if (focus === 'replace') replaceInput.focus()
    else {
      input.focus()
      input.select()
    }
  }

  function closeBar() {
    if (!bar) return
    visible = false
    bar.classList.remove('show')
    paneEl.removeEventListener('scroll', pin)
    lastMatches = []
    setState({ query: '', matches: [], activeIndex: -1 })
    // reveal() 留下的是范围选区：不收掉的话 Esc 关栏后命中词仍是选中态，接着打字
    // 会把正文覆盖掉（QA GU-012）。收成光标再还焦点
    const sel = view.state.selection
    if (sel && !sel.empty) {
      const tr = view.state.tr.setSelection(TextSelection.create(view.state.doc, sel.from))
      view.dispatch(tr)
    }
    view.focus()
  }

  function toggle(focus) {
    if (visible) closeBar()
    else openBar(focus)
  }

  return {
    open: openBar, // open('find' | 'replace')
    openReplace: () => openBar('replace'),
    close: closeBar,
    toggle,
    isOpen: () => visible,
  }
}
