// mermaid-preview.js —— ```mermaid 代码块的渲染预览（视图层装饰，不改文档模型 / 不改 markdown 内容）
//
// 策略（与 hl-decorations.js 同构：纯 Decoration，编辑体验无损）：
//  · code_block 仍只保存纯文本 + attrs.params（语言 'mermaid'），
//    parse/serialize 走原生 fence <-> code_block 路径，GFM 往返零风险。
//  · 每个 mermaid 块“之后”挂一个 widget decoration 显示渲染图；源码仍可编辑、仍参与语法高亮。
//  · mermaid 是重依赖，用 await import('mermaid') 动态加载：vite 自动分包，
//    只有当文档里真的出现 mermaid 块、且首次要渲染时才拉取，不拖累主 bundle。

import { Plugin, PluginKey } from 'prosemirror-state'
import { Decoration, DecorationSet } from 'prosemirror-view'

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

function makeWidget(source) {
  const wrap = document.createElement('div')
  wrap.className = 'nl-mermaid'
  wrap.setAttribute('contenteditable', 'false')
  const theme = currentTheme()
  const cached = svgCache.get(theme + '\u0000' + source)
  if (cached) {
    wrap.innerHTML = cached
    return wrap
  }
  wrap.textContent = 'Mermaid 渲染中…'
  renderSvg(source)
    .then((svg) => {
      // 元素仍在文档内、且主题未变才写入（避免过期异步回调串图）
      if (currentTheme() === theme && document.contains(wrap)) wrap.innerHTML = svg
    })
    .catch((err) => {
      if (document.contains(wrap)) {
        wrap.className = 'nl-mermaid nl-mermaid-error'
        wrap.textContent = 'Mermaid 渲染失败：' + (err && err.message ? err.message : String(err))
      }
    })
  return wrap
}

function buildDecorations(doc) {
  const decos = []
  doc.descendants((node, pos) => {
    if (!isMermaid(node)) return
    const source = node.textContent
    const after = pos + node.nodeSize
    decos.push(
      Decoration.widget(
        after,
        () => makeWidget(source),
        {
          side: 1,
          // key 含主题+源码指纹：内容不变时 PM 复用 DOM，避免编辑别处时整块闪烁/重渲染
          key: 'nlmermaid:' + currentTheme() + ':' + hashStr(source),
          stopEvent: () => true,
        }
      )
    )
  })
  return DecorationSet.create(doc, decos)
}

export function mermaidPlugin() {
  return new Plugin({
    key: mmKey,
    state: {
      init(_, { doc }) {
        return buildDecorations(doc)
      },
      apply(tr, old) {
        if (!tr.docChanged && !tr.getMeta(mmKey)) return old.map(tr.mapping, tr.doc)
        return buildDecorations(tr.doc)
      },
    },
    props: {
      decorations(state) {
        return mmKey.getState(state)
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
