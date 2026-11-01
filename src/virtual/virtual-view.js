// virtual-view.js —— 虚拟化窗口的 DOM 接入层（Phase 2 后半）
//
// 把 VirtualEditor 内核接到一个 EditorView 上，职责三件：
//   1. 建 view：窗口 state + dispatchTransaction 全部转交内核（applyWindowTr 里回灌 master、
//      同步窗口，onChange 回来再 updateState——view 自己不 apply tr）。
//   2. 滚动/resize：量可视块号喂 viewportBlocks（内核决定是否扩缩窗口）；rAF 去抖。
//   3. 块高测量：窗口内每个顶层块的 offsetHeight 喂 setBlockHeight，重切后的 spacer
//      用实测值代替估算，滚动条高度不跳。
//
// 刻意不做（Phase 3）：装饰插件装配、undo/redo 键位（master 历史经 editor.undo/redo）、
// 查找/大纲跳转面板接线。本层只保证「打开大文件只有窗口块进 DOM、编辑与滚动正确」。

import { EditorView } from 'prosemirror-view'
import { VirtualEditor } from './virtual-editor.js'
import { serializeMarkdown } from '../editor-schema.js'

/**
 * @param {HTMLElement} mountEl 编辑器挂载点
 * @param {Node} masterDoc 完整文档（原编辑器 schema；Rust 解析或 JS 解析产物皆可）
 * @param {object} opts
 *   scrollEl      滚动容器（默认 mountEl 自己）
 *   getViewport   视口覆写：() => ({ top, bottom })，文档坐标；测试/非常规布局注入
 *   windowSize / overscan / plugins   透传内核
 */
export function createVirtualView(mountEl, masterDoc, opts = {}) {
  const scrollEl = opts.scrollEl || mountEl
  let view = null
  let rafId = 0

  const editor = new VirtualEditor(masterDoc, {
    windowSize: opts.windowSize,
    overscan: opts.overscan,
    estimateHeight: opts.estimateHeight,
    plugins: opts.plugins || [],
    onChange(winState) {
      if (view && view.state !== winState) view.updateState(winState)
      scheduleMeasure()
    },
  })

  view = new EditorView(mountEl, {
    state: editor.winState,
    attributes: { 'data-virtual': 'true' },
    dispatchTransaction(tr) {
      editor.applyWindowTr(tr)
    },
  })

  /** 量窗口 DOM：返回可视块的 master 块号区间与各块实测高度。可视判定用 offsetTop/
   *  offsetHeight（编辑器 DOM 顶层级元素顺序 = 窗口 doc 顶层级：top spacer + 实块 +
   *  bottom spacer）；窗口内序号 k 对应 master 块号 i0 + k。 */
  function measureBlocks(vp) {
    const kids = view.dom.children
    const heights = []
    let first = null
    let last = null
    for (let i = 1; i < kids.length - 1; i++) {
      const el = kids[i]
      const top = el.offsetTop
      const h = el.offsetHeight
      heights.push(h)
      if (top + h >= vp.top && top <= vp.bottom) {
        const blockNo = editor.i0 + i - 1
        if (first == null) first = blockNo
        last = blockNo
      }
    }
    return { first, last, heights }
  }

  function defaultViewport() {
    return { top: scrollEl.scrollTop, bottom: scrollEl.scrollTop + (scrollEl.clientHeight || 1e9) }
  }

  function measure(vpOverride) {
    if (!view) return
    const vp = vpOverride || (opts.getViewport ? opts.getViewport() : defaultViewport())
    const { first, last, heights } = measureBlocks(vp)
    for (let k = 0; k < heights.length; k++) {
      if (heights[k] > 0) editor.setBlockHeight(editor.i0 + k, heights[k])
    }
    if (first != null) editor.viewportBlocks(first, last)
  }

  function scheduleMeasure() {
    if (rafId || typeof requestAnimationFrame !== 'function') {
      measure()
      return
    }
    rafId = requestAnimationFrame(() => {
      rafId = 0
      measure()
    })
  }

  const onScroll = () => scheduleMeasure()
  const onResize = () => scheduleMeasure()
  scrollEl.addEventListener('scroll', onScroll, { passive: true })
  window.addEventListener('resize', onResize)

  scheduleMeasure()

  return {
    view,
    editor,
    /** master doc 序列化（保存走这里，与窗口无关） */
    getMarkdown() {
      return serializeMarkdown(editor.doc)
    },
    /** 手动触发一次测量（布局就绪 / 挂载完成后调用） */
    measure,
    destroy() {
      scrollEl.removeEventListener('scroll', onScroll)
      window.removeEventListener('resize', onResize)
      if (rafId) cancelAnimationFrame(rafId)
      view.destroy()
      view = null
    },
  }
}
