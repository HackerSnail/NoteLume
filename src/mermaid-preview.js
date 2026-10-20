// mermaid-preview.js —— ```mermaid 代码块的渲染预览（视图层装饰，不改文档模型 / 不改 markdown 内容）
//
// 策略（与 hl-decorations.js 同构：纯 Decoration，编辑体验无损）：
//  · code_block 仍只保存纯文本 + attrs.params（语言 'mermaid'），
//    parse/serialize 走原生 fence <-> code_block 路径，GFM 往返零风险。
//  · Typora 式「只见图，点图就地出码」：源码块的可见性完全由**光标位置**决定——光标不在该块内
//    → 挂 .nl-mm-source（display:none）并在块尾挂图 widget；光标在块内 → 换成 .nl-mm-editing 描边、
//    摘掉图。于是「斜杠菜单刚建好块」「点图把光标送进块」两种进入方式天然成立，Esc / Mod-Enter /
//    点击别处让光标离开即回到图态（Shift-Enter 归位成块内换行，不再兼作摘图）；同一时刻最多一块出码。
//  · 图 widget 上的点击由元素自己的监听器处理（PM 对 widget 的 stopEvent 事件会先忽略，
//    handleDOMEvents 收不到），监听器只做一件事：把光标放进该块。
//  · mermaid 是重依赖，用 await import('mermaid') 动态加载：vite 自动分包，
//    只有当文档里真的出现 mermaid 块、且首次要渲染时才拉取，不拖累主 bundle。

import { Plugin, PluginKey, TextSelection } from 'prosemirror-state'
import { Decoration, DecorationSet } from 'prosemirror-view'
import { t } from './i18n.js'

const mmKey = new PluginKey('nl-mermaid')

// `${theme}\0${source}` -> svg，按主题分别缓存（换主题需重渲染）
const svgCache = new Map()
let mermaidLoader = null // 动态 import 的 Promise，只创建一次
let lastInitTheme = null
let idSeq = 0

function currentTheme() {
  const t = document.documentElement.getAttribute('data-theme')
  return t === 'dark' || t === 'vampire' ? 'dark' : 'default'
}

function loadMermaid() {
  if (!mermaidLoader) {
    mermaidLoader = import('mermaid').then((mod) => mod.default || mod)
  }
  return mermaidLoader
}

async function renderSvg(source) {
  const theme = currentTheme()
  const ck = theme + '\u0000' + source
  if (svgCache.has(ck)) return svgCache.get(ck)
  const mermaid = await loadMermaid()
  // initialize 会重置内部状态；仅在主题变化时调用，避免每次渲染都重配
  if (theme !== lastInitTheme) {
    mermaid.initialize({
      startOnLoad: false,
      theme,
      securityLevel: 'strict',
      suppressErrorRendering: true,
    })
    lastInitTheme = theme
  }
  const id = 'nl-mermaid-' + ++idSeq
  const { svg } = await mermaid.render(id, source)
  svgCache.set(ck, svg)
  return svg
}

function isMermaid(node) {
  if (node.type.name !== 'code_block') return false
  const lang = (node.attrs.params || '').trim().split(/\s+/)[0].toLowerCase()
  return lang === 'mermaid'
}

function hashStr(s) {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0
  return h.toString(36)
}

function makeWidget(source, view, getPos) {
  const wrap = document.createElement('div')
  wrap.className = 'nl-mermaid'
  wrap.setAttribute('contenteditable', 'false')
  // 点图 = 把光标送进该块，源码可见性由光标位置决定（见文件头）
  wrap.addEventListener('click', (e) => {
    e.preventDefault()
    const state = view.state
    const $at = state.doc.resolve(getPos())
    const block = $at.nodeBefore
    if (!block || !isMermaid(block)) return
    const tr = state.tr.setSelection(TextSelection.near(state.doc.resolve($at.pos - block.nodeSize + 1), 1))
    tr.setMeta('addToHistory', false)
    view.dispatch(tr.scrollIntoView())
    view.focus()
  })
  const theme = currentTheme()
  const cached = svgCache.get(theme + '\u0000' + source)
  if (cached) {
    wrap.innerHTML = cached
    return wrap
  }
  wrap.textContent = t('mermaid.rendering')
  renderSvg(source)
    .then((svg) => {
      // 元素仍在文档内、且主题未变才写入（避免过期异步回调串图）
      if (currentTheme() === theme && document.contains(wrap)) wrap.innerHTML = svg
    })
    .catch((err) => {
      if (document.contains(wrap)) {
        wrap.className = 'nl-mermaid nl-mermaid-error'
        wrap.textContent = t('mermaid.renderFailed', { err: err && err.message ? err.message : String(err) })
      }
    })
  return wrap
}

function buildDecorations(doc, editing) {
  const decos = []
  doc.descendants((node, pos) => {
    if (!isMermaid(node)) return
    const source = node.textContent
    const after = pos + node.nodeSize
    if (pos === editing) {
      // 出码态：源码可见可编辑，只描个边提示「正在编辑」，不挂图
      decos.push(Decoration.node(pos, after, { class: 'nl-mm-editing' }))
      return
    }
    decos.push(Decoration.node(pos, after, { class: 'nl-mm-source' }))
    decos.push(Decoration.widget(after, (view, getPos) => makeWidget(source, view, getPos), {
      side: 1,
      // key 含主题+源码指纹：内容不变时 PM 复用 DOM，避免编辑别处时整块闪烁/重渲染
      key: 'nlmermaid:' + currentTheme() + ':' + hashStr(source),
      stopEvent: () => true,
    }))
  })
  return DecorationSet.create(doc, decos)
}

// 光标落在哪个 mermaid 块内（返回该块位置，否则 null）——出码态的唯一判据
function editingPosIn(doc, sel) {
  const $h = sel.$head || doc.resolve(sel.head)
  for (let d = $h.depth; d > 0; d--) {
    if (isMermaid($h.node(d))) return $h.before(d)
  }
  return null
}

export function mermaidPlugin() {
  return new Plugin({
    key: mmKey,
    state: {
      init(_, { doc }) {
        return { set: buildDecorations(doc, null), editing: null }
      },
      apply(tr, prev, oldState, newState) {
        const editing = newState ? editingPosIn(tr.doc, newState.selection) : prev.editing
        if (!tr.docChanged && editing === prev.editing && tr.getMeta(mmKey) !== 'refresh') {
          return { set: prev.set.map(tr.mapping, tr.doc), editing }
        }
        return { set: buildDecorations(tr.doc, editing), editing }
      },
    },
    props: {
      decorations(state) {
        return mmKey.getState(state).set
      },
      handleKeyDown(view, ev) {
        if (ev.key !== 'Escape') return false
        const st = mmKey.getState(view.state)
        if (!st || st.editing == null) return false
        const pos = st.editing
        const node = view.state.doc.nodeAt(pos)
        const tr = view.state.tr
        if (node) {
          const sel = TextSelection.near(view.state.doc.resolve(pos), -1)
          // 只有确实落到块外才搬（该块是文档首块时无处可去，宁可光标留在隐藏源码内）
          if (sel.from < pos || sel.to > pos + node.nodeSize) tr.setSelection(sel)
        }
        tr.setMeta('addToHistory', false)
        view.dispatch(tr)
        return true
      },
    },
    view(view) {
      // 主题切换（applyTheme 派发 nl-theme-change）：清空缓存并重建装饰以按新配色重渲染
      const onTheme = () => {
        svgCache.clear()
        lastInitTheme = null
        view.dispatch(view.state.tr.setMeta(mmKey, 'refresh'))
      }
      window.addEventListener('nl-theme-change', onTheme)
      return {
        destroy() {
          window.removeEventListener('nl-theme-change', onTheme)
        },
      }
    },
  })
}
