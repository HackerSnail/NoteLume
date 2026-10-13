// math-nodeviews.js —— KaTeX 数学公式的 ProseMirror NodeView
// schema 里的 math_inline / math_block 是无 DOM 依赖的原子节点，此处把它们渲染为公式；
// 双击可编辑，编辑走 prompt（Tauri v2 WebView2/WebKit 已支持）。

import katex from 'katex'
import 'katex/dist/katex.min.css'

function renderKatex(latex, el, displayMode) {
  try {
    katex.render(latex, el, { throwOnError: false, displayMode })
  } catch (e) {
    el.textContent = (displayMode ? '$$\n' : '$') + latex + (displayMode ? '\n$$' : '$')
    el.setAttribute('title', 'KaTeX 渲染失败：' + e.message)
  }
}

function editLatex(current, apply) {
  // 简单可靠：window.prompt；后续 P2 可以换成更好的编辑器
  const next = window.prompt('编辑 LaTeX 公式', current)
  if (next == null) return
  if (next === current) return
  apply(next)
}

export function mathInlineView(node, view, getPos) {
  let cur = node
  const dom = document.createElement('span')
  dom.className = 'nl-math nl-math-inline'
  dom.setAttribute('contenteditable', 'false')
  dom.setAttribute('data-latex', cur.attrs.latex)
  dom.title = '双击编辑公式'
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
  dom.title = '双击编辑公式'
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
