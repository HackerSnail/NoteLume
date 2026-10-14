// editor-modes.js —— 专注模式 + 打字机模式（视图层，不改文档、零新依赖）
//
//  · 专注：给顶层块挂 Decoration.node 类，非当前块淡出（CSS `.nl-focus`）。
//  · 打字机：选区变化时把当前顶层块滚到视口竖直中部（scrollIntoView block:center）。
//  · 开关通过插件 meta 事务切换，状态存于插件（切换后重算 decorations / 触发滚动）。
import { Plugin, PluginKey } from 'prosemirror-state'
import { Decoration, DecorationSet } from 'prosemirror-view'

const key = new PluginKey('nl-modes')

export function createModesPlugin({ focus = false, typewriter = false } = {}) {
  let view = null

  const plugin = new Plugin({
    key,
    state: {
      init: () => ({ focus, typewriter }),
      apply(tr, val) {
        const m = tr.getMeta(key)
        return m ? { ...val, ...m } : val
      },
    },
    props: {
      decorations(state) {
        const st = key.getState(state)
        if (!st || !st.focus) return null
        const { doc, selection } = state
        const $h = selection.$head
        const activeTop = $h.depth >= 1 ? $h.before(1) : -1
        const decos = []
        doc.forEach((node, pos) => {
          decos.push(Decoration.node(pos, pos + node.nodeSize, { class: 'nl-blk' + (pos === activeTop ? ' nl-blk-active' : '') }))
        })
        return DecorationSet.create(doc, decos)
      },
    },
    view(v) {
      view = v
      const applyRootClass = () => {
        const st = key.getState(v.state)
        v.dom.classList.toggle('nl-focus', !!(st && st.focus))
      }
      applyRootClass()
      return {
        update(updatedView, prevState) {
          applyRootClass()
          const st = key.getState(updatedView.state)
          if (!st || !st.typewriter) return
          const prevSel = prevState && prevState.selection
          const sel = updatedView.state.selection
          if (prevSel && prevSel.eq(sel)) return
          const $h = sel.$head
          const top = $h.depth >= 1 ? $h.before(1) : null
          if (top == null) return
          const dom = updatedView.nodeDOM(top)
          const el = dom && dom.nodeType === 1 ? dom : dom && dom.parentElement
          if (el && typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'center' })
        },
        destroy() {
          if (view) view.dom.classList.remove('nl-focus')
        },
      }
    },
  })

  const api = {
    setFocus(on) { if (view) view.dispatch(view.state.tr.setMeta(key, { focus: !!on })) },
    setTypewriter(on) { if (view) view.dispatch(view.state.tr.setMeta(key, { typewriter: !!on })) },
  }
  return { plugin, api }
}
