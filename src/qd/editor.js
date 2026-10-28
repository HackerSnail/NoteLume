// qd/editor.js —— Quarkdown 指令块的编辑器集成（求值快照 + 诊断呈现，视图层装饰）
//
// 交互与 mermaid / csv 同族（Typora 式「只见结果，点进源码」）：
//  · 区域 = 指令调用段（段落文本以 `.`+名字开头）+ 其后连续的 code_block / 列表节点。
//    缩进的块参数在 CommonMark 里落成 code_block（4 空格）或列表，重组源码时按此还原。
//    含段落体的块参数（1–3 空格缩进）不在区域里——v1 已知限制，正文段落体罕见。
//  · 光标不在区域内 → 成员节点隐藏（.nl-qd-source），区域尾挂快照 widget：
//    区域源码经 evalQd（Rust qd_eval）展开，展开文本本地 markdown-it 渲染；诊断出灰字条。
//  · 光标进入区域 → 源码可见可编辑，摘快照；Esc / 点别处回快照态。
//  · 缓存键 = 区域源码：源码不变不重求值。features.quarkdown 关闭时不挂装饰（标准模式）。
//  · 导出（site / slides / 单篇 HTML）在渲染前对整篇调 evalQd 展开，不经此插件。

import { Plugin, PluginKey, TextSelection } from 'prosemirror-state'
import { Decoration, DecorationSet } from 'prosemirror-view'
import MarkdownIt from 'markdown-it'
import { mountEmojiRenderer } from '../emoji-text.js'
import { openIslandImage } from '../html-block-images.js'
import { t } from '../i18n.js'

// 快照渲染：与单篇 HTML 导出同配方的本地实例（不开 html，字面标签按文本显示更安全）
const snapshotMd = MarkdownIt('commonmark', { html: false }).enable(['table', 'strikethrough'])
mountEmojiRenderer(snapshotMd)

const QD_CALL_RE = /^\.\s*([a-zA-Z0-9_])/

/** 段落是否为指令调用行（`.name` 开头） */
export function isQdCallPara(node) {
  return node.type.name === 'paragraph' && QD_CALL_RE.test(node.textContent || '')
}

/**
 * 收集 Quarkdown 区域（顶层遍历）。
 * @param {Node} doc
 * @returns {Array<{ from: number, to: number, source: string }>} from/to 覆盖成员节点；source 供 qd_eval
 */
export function collectQdRegions(doc) {
  const nodes = []
  doc.forEach((node, pos) => nodes.push({ node, pos, end: pos + node.nodeSize }))
  const regions = []
  let i = 0
  while (i < nodes.length) {
    const { node, pos, end } = nodes[i]
    if (!isQdCallPara(node)) {
      i += 1
      continue
    }
    const parts = [node.textContent]
    let lastEnd = end
    let j = i + 1
    while (j < nodes.length) {
      const t = nodes[j].node.type.name
      if (t !== 'code_block' && t !== 'bullet_list' && t !== 'ordered_list') break
      parts.push(serializeRegionNode(nodes[j].node))
      lastEnd = nodes[j].end
      j += 1
    }
    regions.push({ from: pos, to: lastEnd, source: parts.join('\n') })
    i = j
  }
  return regions
}

/** 区域成员节点 → 源码行：code_block 与列表都还原成 4 空格缩进的块参数 */
function serializeRegionNode(node) {
  if (node.type.name === 'code_block') {
    return node.textContent
      .split('\n')
      .map((l) => '    ' + l)
      .join('\n')
  }
  if (node.type.name === 'bullet_list' || node.type.name === 'ordered_list') {
    return serializeList(node)
  }
  return node.textContent
}

function serializeList(list) {
  const ordered = list.type.name === 'ordered_list'
  const lines = []
  list.forEach((item) => {
    const text = item.textContent
    lines.push((ordered ? '1. ' : '- ') + text)
  })
  // 列表成员也是块参数：不补 4 空格，Rust 侧就把 `- 条目 .1` 当成顶层正文，
  // `.foreach` 收不到循环体，`.1` 反倒被解析成一个不存在的函数调用。
  return lines.map((l) => '    ' + l).join('\n')
}

// ============ 装饰插件 ============

const qdKey = new PluginKey('nl-qd')

// 区域源码 → 渲染后的快照 HTML（含诊断条），跨区域共享
const snapshotCache = new Map()

function renderSnapshotHtml(expanded, diagnostics) {
  let html = snapshotMd.render(expanded)
  if (diagnostics && diagnostics.length) {
    const items = diagnostics
      .map((d) => `<div class="nl-qd-diag">${d.line ? `L${d.line} · ` : ''}${escapeHtmlQd(d.message)}</div>`)
      .join('')
    html += `<div class="nl-qd-diags">${items}</div>`
  }
  return html
}

function escapeHtmlQd(s) {
  return String(s == null ? '' : s).replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))
}

/** 光标是否落在任一区域内（返回命中区域下标，否则 -1）——出码态的唯一判据 */
function regionAt(regions, doc, sel) {
  const $h = sel.$head || doc.resolve(sel.head)
  const pos = $h.before(1)
  return regions.findIndex((r) => pos >= r.from && pos < r.to)
}

function buildQdDecos(doc, getFeatures, evalQd, editingIdx) {
  const flags = getFeatures ? getFeatures() : null
  if (flags && flags.quarkdown === false) return DecorationSet.empty
  const regions = collectQdRegions(doc)
  const decos = []
  regions.forEach((region, idx) => {
    // 成员节点全部隐藏（快照态）；编辑态全部可见
    if (idx !== editingIdx) {
      doc.nodesBetween(region.from, region.to, (n, p) => {
        if (n.isTextblock || n.type.name === 'code_block') {
          decos.push(Decoration.node(p, p + n.nodeSize, { class: 'nl-qd-source' }))
        }
        return false
      })
      decos.push(
        Decoration.widget(region.to, (view, getPos) => makeSnapshotWidget(region, view, getPos, evalQd, idx), {
          side: 1,
          key: 'nlqd:' + region.source,
          stopEvent: () => true,
        }),
      )
    } else {
      decos.push(Decoration.node(region.from, region.to, { class: 'nl-qd-editing' }))
    }
  })
  return DecorationSet.create(doc, decos)
}

/** 快照 widget：先占位，异步求值回来后原位填充（过期回写用 document.contains 挡掉） */
function makeSnapshotWidget(region, view, getPos, evalQd, idx) {
  const wrap = document.createElement('div')
  wrap.className = 'nl-qd'
  wrap.setAttribute('contenteditable', 'false')
  wrap.addEventListener('click', (e) => {
    e.preventDefault()
    // 快照里的图片：单击只看图，不把光标送进区域源码
    if (openIslandImage(e.target.closest && e.target.closest('img'))) return
    const state = view.state
    const $at = state.doc.resolve(getPos())
    // 把光标送进区域首段（mermaid 同款：源码可见性由光标位置决定）
    const tr = state.tr.setSelection(TextSelection.near(state.doc.resolve($at.pos - 1), 1))
    tr.setMeta('addToHistory', false)
    view.dispatch(tr.scrollIntoView())
    view.focus()
  })
  const cached = snapshotCache.get(region.source)
  if (cached != null) {
    wrap.innerHTML = cached
    return wrap
  }
  wrap.textContent = t('qd.evaling')
  Promise.resolve()
    .then(() => evalQd(region.source))
    .then((res) => {
      const html = renderSnapshotHtml(res.expanded, res.diagnostics)
      snapshotCache.set(region.source, html)
      if (document.contains(wrap)) wrap.innerHTML = html
    })
    .catch((err) => {
      if (document.contains(wrap)) {
        wrap.className = 'nl-qd nl-qd-error'
        wrap.textContent = t('qd.evalFailed', { err: err && err.message ? err.message : String(err) })
      }
    })
  return wrap
}

/** 光标所在区域的下标（-1 = 无） */
function editingRegionIndex(doc, sel, regions) {
  const $h = sel.$head || doc.resolve(sel.head)
  const pos = $h.depth >= 1 ? $h.before(1) : -1
  return regions.findIndex((r) => pos >= r.from && pos < r.to)
}

export function qdPlugin(getFeatures, evalQd) {
  return new Plugin({
    key: qdKey,
    state: {
      init(_, state) {
        const regions = collectQdRegions(state.doc)
        return { set: buildQdDecos(state.doc, getFeatures, evalQd, -1), editing: -1, regions }
      },
      apply(tr, prev, oldState, newState) {
        const regions = collectQdRegions(tr.doc)
        const editing = newState ? editingRegionIndex(tr.doc, newState.selection, regions) : prev.editing
        if (!tr.docChanged && editing === prev.editing && !tr.getMeta('nl-features') && tr.getMeta(qdKey) !== 'refresh') {
          return { set: prev.set.map(tr.mapping, tr.doc), editing, regions }
        }
        return { set: buildQdDecos(tr.doc, getFeatures, evalQd, editing), editing, regions }
      },
    },
    props: {
      decorations(state) {
        return qdKey.getState(state).set
      },
      handleKeyDown(view, ev) {
        if (ev.key !== 'Escape') return false
        const st = qdKey.getState(view.state)
        if (!st || st.editing < 0) return false
        // 光标移出区域（区域前），回快照态
        const region = st.regions[st.editing]
        const sel = TextSelection.near(view.state.doc.resolve(region.from), -1)
        const tr = view.state.tr.setSelection(sel)
        tr.setMeta('addToHistory', false)
        view.dispatch(tr)
        return true
      },
    },
  })
}

/** 供 main.js 在设置开关变化外手动刷新（预留） */
export function refreshQdCache() {
  snapshotCache.clear()
}
