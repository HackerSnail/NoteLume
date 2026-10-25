// toc-block.js —— [[toc]] 目录块（视图层装饰，不改文档模型）
//
// 语法：单独一行 [[toc]]（Obsidian 目录插件同款，本质是普通 wikilink，target 为 toc）。
// 编辑器里该段换成可点目录块（H1–H3），条目渲染成 <a href="#slug">，点击走 editor-view
// 既有锚点拦截（buildAnchorMap 反查 pos → jumpToPos），零新增跳转链路。
// slug 去重覆盖全部标题（slugAllInOrder 按全量标题序算），条目只取 H1–H3——与站点导出
// 的 heading id 必须同源，否则点了跳不准。
// 文档没有标题时不渲染目录块，[[toc]] 按普通 wikilink 显示。

import { Plugin, PluginKey } from 'prosemirror-state'
import { Decoration, DecorationSet } from 'prosemirror-view'
import { slugAllInOrder } from './heading-anchor.js'

/**
 * 收集目录条目：全量标题算 slug（与锚点 / 站点导出同源），H1–H3 出条目。
 * @param {Node} doc PM 文档（标题均为顶层块）
 * @returns {Array<{ level: number, text: string, slug: string, pos: number }>}
 */
export function collectTocEntries(doc) {
  const heads = [] // [{ level, text, pos }]，文档序
  doc.forEach((node, pos) => {
    if (node.type.name === 'heading') {
      heads.push({ level: node.attrs.level || 1, text: node.textContent, pos })
    }
  })
  const slugs = slugAllInOrder(heads.map((h) => h.text))
  return heads
    .map((h, i) => ({ ...h, slug: slugs[i] }))
    .filter((h) => h.level <= 3)
}

const tocKey = new PluginKey('nl-toc')

// 判断一个顶层段落是否为「[[toc]] 单独一行」：唯一子节点是 wikiLink 且 target 为 toc
function tocParagraph(doc) {
  let found = null
  doc.forEach((node, pos) => {
    if (found || node.type.name !== 'paragraph' || node.childCount !== 1) return
    const child = node.child(0)
    if (child.type.name === 'wikiLink' && String(child.attrs.target || '').trim().toLowerCase() === 'toc') {
      found = { pos, size: node.nodeSize }
    }
  })
  return found
}

function buildTocDeco(doc, getFeatures) {
  const flags = getFeatures ? getFeatures() : null
  if (flags && flags.tocBlock === false) return DecorationSet.empty
  const para = tocParagraph(doc)
  if (!para) return DecorationSet.empty
  const entries = collectTocEntries(doc)
  const hide = Decoration.node(para.pos, para.pos + para.size, { style: 'display:none' })
  if (!entries.length) return DecorationSet.create(doc, [hide]) // 没标题：只藏掉 toc 段
  const widget = Decoration.widget(para.pos, () => {
    const box = document.createElement('div')
    box.className = 'nl-toc'
    const title = document.createElement('div')
    title.className = 'nl-toc-title'
    title.textContent = tocTitleText
    const nav = document.createElement('nav')
    for (const e of entries) {
      const a = document.createElement('a')
      a.href = '#' + e.slug
      if (e.level > 1) a.className = 'lv' + e.level
      a.textContent = e.text
      nav.appendChild(a)
    }
    box.appendChild(title)
    box.appendChild(nav)
    return box
  }, { side: -1, key: 'nl-toc-block' })
  return DecorationSet.create(doc, [hide, widget])
}

export function tocPlugin(getFeatures) {
  return new Plugin({
    key: tocKey,
    state: {
      init: (_, state) => buildTocDeco(state.doc, getFeatures),
      apply: (tr, old) => (tr.docChanged || tr.getMeta('nl-features') ? buildTocDeco(tr.doc, getFeatures) : old),
    },
    props: {
      decorations: (state) => tocKey.getState(state),
    },
  })
}

// 由 main.js 注入标题文案（i18n），模块层不直接引 t() 以便 Node 单测
export let tocTitleText = '目录'
export function setTocTitle(text) {
  tocTitleText = text
}
