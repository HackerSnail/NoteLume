// math-nodeviews.js —— KaTeX 数学公式的 ProseMirror NodeView
// schema 里的 math_inline / math_block 是无 DOM 依赖的原子节点，此处把它们渲染为公式；
// 双击可编辑（走应用内 promptDialog：mac 的 wry 没实现 JS 输入面板，window.prompt 直接返回 null）。

import katex from 'katex'
import 'katex/dist/katex.min.css'
import { t } from './i18n.js'
import { promptDialog } from './prompt-dialog.js'

function renderKatex(latex, el, displayMode) {
  try {
    katex.render(latex, el, { throwOnError: false, displayMode })
  } catch (e) {
    el.textContent = (displayMode ? '$$\n' : '$') + latex + (displayMode ? '\n$$' : '$')
    el.setAttribute('title', t('math.renderFailed', { err: e.message }))
  }
}

async function editLatex(current, apply) {
  const next = await promptDialog({ title: t('math.editPrompt'), defaultValue: current })
  if (next == null || next === current) return
  apply(next)
}

export function mathInlineView(node, view, getPos) {
  let cur = node
  const dom = document.createElement('span')
  dom.className = 'nl-math nl-math-inline'
  dom.setAttribute('contenteditable', 'false')
  dom.setAttribute('data-latex', cur.attrs.latex)
  dom.title = t('math.dblClickEdit')
  renderKatex(cur.attrs.latex, dom, false)
  dom.addEventListener('dblclick', () => {
    editLatex(cur.attrs.latex, (next) => {
      const pos = getPos()
      if (typeof pos !== 'number') return
      const tr = view.state.tr.replaceWith(
        pos,
        pos + cur.nodeSize,
        view.state.schema.nodes.math_inline.create({ latex: next })
      )
      view.dispatch(tr)
    })
  })
  return {
    dom,
    stopEvent: () => true,
    update(n) {
      if (n.type !== cur.type) return false
      if (n.attrs.latex === cur.attrs.latex) return false
      cur = n
      dom.setAttribute('data-latex', n.attrs.latex)
      renderKatex(n.attrs.latex, dom, false)
      return true
    },
    selectNode() {
      dom.classList.add('ProseMirror-selectednode')
    },
    deselectNode() {
      dom.classList.remove('ProseMirror-selectednode')
    },
  }
}

export function mathBlockView(node, view, getPos) {
  let cur = node
  const dom = document.createElement('div')
  dom.className = 'nl-math nl-math-block'
  dom.setAttribute('contenteditable', 'false')
  dom.setAttribute('data-latex', cur.attrs.latex)
  dom.title = t('math.dblClickEdit')
  renderKatex(cur.attrs.latex, dom, true)
  dom.addEventListener('dblclick', () => {
    editLatex(cur.attrs.latex, (next) => {
      const pos = getPos()
      if (typeof pos !== 'number') return
      const tr = view.state.tr.replaceWith(
        pos,
        pos + cur.nodeSize,
        view.state.schema.nodes.math_block.create({ latex: next })
      )
      view.dispatch(tr)
    })
  })
  return {
    dom,
    stopEvent: () => true,
    update(n) {
      if (n.type !== cur.type) return false
      if (n.attrs.latex === cur.attrs.latex) return false
      cur = n
      dom.setAttribute('data-latex', n.attrs.latex)
      renderKatex(n.attrs.latex, dom, true)
      return true
    },
    selectNode() {
      dom.classList.add('ProseMirror-selectednode')
    },
    deselectNode() {
      dom.classList.remove('ProseMirror-selectednode')
    },
  }
}
