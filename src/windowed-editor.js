// windowed-editor.js —— Phase 2 DOM 层 spike：窗口化 EditorView 原型（仅验证可行性，非产品实现）
//
// 单例 EditorView 绑「窗口 doc」（master 顶层块切片）。滚动 / 编辑时：
//  - 编辑：窗口事务按块偏移回灌 master（syncWindowToMaster），master 为唯一事实源；
//  - 滚动：算新窗口区间，用 view.updateState 换切片（复用同一 view，保焦点 / IME），选区经
//    master 坐标往返重映射；上下 spacer 用估算块高撑出真实滚动条高度。
// 目的：在真实布局引擎里验证「光标 / 选区 / 滚动重切 / 回灌」不崩，据此定 go/no-go。

import { EditorState, TextSelection } from 'prosemirror-state'
import { EditorView } from 'prosemirror-view'
import { schema, parseMarkdown } from './editor-schema.js'
import { blockOffsets, sliceWindow, syncWindowToMaster, windowDelta } from './windowed-model.js'

const LH = 26 // 估算行高（px）

function estHeights(doc) {
  const hs = []
  doc.forEach((node) => {
    const chars = node.textContent.length
    const lines = Math.max(1, Math.ceil(chars / 46)) // 粗略：每行 ~46 字符
    hs.push(lines * LH)
  })
  return hs
}

function windowFor(scrollTop, vh, heights, overscan) {
  const tops = []
  let acc = 0
  for (const h of heights) { tops.push(acc); acc += h }
  const bottom = scrollTop + vh
  let i0 = heights.length ? 0 : 0
  for (let i = 0; i < tops.length; i++) { if (tops[i] + heights[i] >= scrollTop) { i0 = i; break } }
  let i1 = i0
  for (let i = i0; i < tops.length; i++) { if (tops[i] <= bottom) i1 = i }
  i0 = Math.max(0, i0 - overscan)
  i1 = Math.min(heights.length - 1, i1 + overscan)
  const above = tops[i0]
  const below = acc - (tops[i1] + heights[i1])
  return { i0, i1, above, below, total: acc }
}

export function createWindowedEditor({ mountEl, scroller, mdText, overscan = 6, onDebug }) {
  let master = EditorState.create({ schema, doc: parseMarkdown(mdText) })
  let heights = estHeights(master.doc)

  const top = document.createElement('div')
  const bot = document.createElement('div')
  const host = document.createElement('div')
  host.className = 'ProseMirror spike-host'
  mountEl.append(top, host, bot)
  top.style.height = '0px'

  let range = windowFor(scroller.scrollTop, scroller.clientHeight, heights, overscan)
  let i0 = range.i0
  let i1 = range.i1

  function windowState(selMasterPos) {
    const doc = sliceWindow(master.doc, i0, i1)
    let st = EditorState.create({ schema, doc })
    if (selMasterPos != null) {
      const wp = Math.max(1, Math.min(doc.content.size, selMasterPos - windowDelta(master.doc, i0)))
      st = st.apply(st.tr.setSelection(TextSelection.create(st.doc, wp)))
    }
    return st
  }

  let view = new EditorView(host, {
    state: windowState(null),
    dispatchTransaction(tr) {
      const next = view.state.apply(tr)
      if (tr.docChanged) {
        // 只把窗口编辑回灌 master（master 为事实源），视图照常推进；不在每次击键重切窗口，
        // 否则 updateState 会冲掉 IME 组合与刚落的编辑。重切只在滚动时做。
        const mtr = syncWindowToMaster(master, i0, i1, next.doc)
        master = master.apply(mtr)
        heights = estHeights(master.doc)
      }
      view.updateState(next)
      report()
    },
  })

  function applySpacers(r) {
    top.style.height = r.above + 'px'
    bot.style.height = r.below + 'px'
  }
  applySpacers(range)

  let raf = 0
  function onScroll() {
    if (raf) return
    raf = requestAnimationFrame(() => {
      raf = 0
      const selMaster = view.state.selection.from + windowDelta(master.doc, i0)
      const r = windowFor(scroller.scrollTop, scroller.clientHeight, heights, overscan)
      if (r.i0 !== i0 || r.i1 !== i1) {
        i0 = r.i0; i1 = r.i1
        applySpacers(r)
        view.updateState(windowState(selMaster)) // 复用 view，保焦点
        report()
      }
    })
  }
  scroller.addEventListener('scroll', onScroll, { passive: true })

  function report() {
    if (!onDebug) return
    onDebug({
      blocks: master.doc.childCount,
      window: [i0, i1],
      selMaster: view.state.selection.from + windowDelta(master.doc, i0),
      scrollTop: Math.round(scroller.scrollTop),
      total: Math.round(heights.reduce((a, b) => a + b, 0)),
      domBlocks: host.querySelectorAll('p,h1,h2,h3,pre,ul,ol,table,blockquote').length,
    })
  }
  report()

  return {
    view,
    master: () => master,
    focus: () => view.focus(),
    destroy() { scroller.removeEventListener('scroll', onScroll); view.destroy() },
  }
}
