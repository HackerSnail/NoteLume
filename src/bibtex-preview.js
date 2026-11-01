// bibtex-preview.js —— ```bibtex 代码块的参考文献渲染（视图层装饰，不改文档模型 / 不改 markdown 内容）
//
// 交互与 mermaid-preview.js / csv-preview.js 同族（Typora 式「只见条目，点块就地出码」）：
//  · code_block 仍只存纯文本 + attrs.params（语言 'bibtex' / 'bib'），parse/serialize 走原生 fence 路径，
//    源文件保持标准 GFM 代码块，导出件里保留代码块（同 mermaid / csv 先例，导出側不渲染条目）。
//  · 光标不在块内 → 隐藏源码、块尾挂条目列表；光标进块 → 源码可见可编辑。Esc / 点别处回表态。
//  · 解析口径与 Rust 侧 .bibliography 一致（src-tauri/src/qd/bibliography.rs 的 parse_bibtex /
//    entry_content）：手写花括号配平、字段名小写、值剥花括号折空白、@comment/@string/@preamble 跳过，
//    条目内容 = 作者、斜体标题、出处、卷期页、年份；编号按块内出现顺序。同一份口径两处实现，
//    编辑器里看到的参考文献与 Quarkdown 求值产物对得上。
//  · 解析容错：畸形字段跳过该字段继续，整块一条都解析不出来时退回显示源码原文（csv 同策略）。

import { Plugin, PluginKey, TextSelection } from 'prosemirror-state'
import { Decoration, DecorationSet } from 'prosemirror-view'
import { t } from './i18n.js'

const bibKey = new PluginKey('nl-bib')
const BIB_LANGS = ['bibtex', 'bib']

/**
 * BibTeX 条目解析（纯函数，可离线单测）。返回 [{ type, key, fields: [[名, 值], ...] }]。
 * @param {string} text
 */
export function parseBibEntries(text) {
  const src = String(text == null ? '' : text)
  const n = src.length
  const out = []
  let i = 0
  while (i < n) {
    if (src[i] !== '@') {
      i++
      continue
    }
    const t0 = i + 1
    let j = t0
    while (j < n && /[A-Za-z0-9]/.test(src[j])) j++
    const type = src.slice(t0, j).toLowerCase()
    while (j < n && /\s/.test(src[j])) j++
    if (j >= n || src[j] !== '{') {
      i = t0
      continue
    }
    j++ // 跳过开头的 {
    if (type === 'comment' || type === 'string' || type === 'preamble') {
      i = skipGroup(src, j)
      continue
    }
    // 引用键：到逗号 / 收括号 / 换行为止
    const k0 = j
    while (j < n && src[j] !== ',' && src[j] !== '}' && src[j] !== '\n') j++
    const key = src.slice(k0, j).trim()
    const fields = []
    if (src[j] === ',') {
      j++
      for (;;) {
        while (j < n && /\s/.test(src[j])) j++
        if (j >= n || src[j] === '}') {
          j++
          break
        }
        const f0 = j
        while (j < n && src[j] !== '=' && src[j] !== '\n' && src[j] !== '}') j++
        const name = src.slice(f0, j).trim().toLowerCase()
        if (src[j] === '=') {
          j++
          while (j < n && /\s/.test(src[j])) j++
          const [val, nj] = readBibValue(src, j)
          j = nj
          if (name) fields.push([name, val])
        } else {
          while (j < n && src[j] !== '\n' && src[j] !== '}') j++ // 畸形字段：跳到行尾
        }
        while (j < n && (src[j] === ',' || /\s/.test(src[j]))) j++
      }
    }
    if (key) {
      const entry = { type, key, fields }
      const at = out.findIndex((e) => e.key === key)
      if (at >= 0) out[at] = entry // 同键重复：后者覆盖（与 Rust 侧同语义）
      else out.push(entry)
    }
    i = j
  }
  return out
}

// 跳过一组花括号（j 指向开括号之后），返回闭括号之后的位置
function skipGroup(src, j) {
  let depth = 1
  while (j < src.length && depth > 0) {
    if (src[j] === '{') depth++
    else if (src[j] === '}') depth--
    j++
  }
  return j
}

// 读一个字段值：花括号（配平嵌套）/ 双引号 / 裸值三种形态
function readBibValue(src, j) {
  let val = ''
  if (src[j] === '{') {
    let depth = 1
    j++
    while (j < src.length && depth > 0) {
      const c = src[j]
      if (c === '{') {
        depth++
        val += '{'
      } else if (c === '}') {
        depth--
        if (depth > 0) val += '}'
      } else val += c
      j++
    }
  } else if (src[j] === '"') {
    j++
    while (j < src.length && src[j] !== '"') {
      val += src[j]
      j++
    }
    if (j < src.length) j++
  } else {
    while (j < src.length && src[j] !== ',' && src[j] !== '}' && src[j] !== '\n') {
      val += src[j]
      j++
    }
  }
  return [cleanBibValue(val), j]
}

// 值清洗：剥花括号（{“o} 这类记号只留字母）、空白折成单空格（字段值常跨行）
function cleanBibValue(v) {
  return String(v).replace(/[{}]/g, '').split(/\s+/).filter(Boolean).join(' ')
}

/** 条目内容拆成渲染片段（纯函数）：作者 / 斜体标题 / 出处 / 卷期页 / 年，与 Rust 侧同一拼装 */
export function bibEntryParts(fields) {
  const f = (name) => {
    const hit = fields.find(([k]) => k === name)
    return hit && hit[1] ? hit[1] : null
  }
  const parts = []
  const author = f('author') || f('editor')
  if (author) parts.push({ text: author })
  const title = f('title')
  if (title) parts.push({ text: title, em: true })
  for (const k of ['journal', 'booktitle', 'publisher', 'school', 'howpublished']) {
    const v = f(k)
    if (v) {
      parts.push({ text: v })
      break
    }
  }
  if (f('volume')) parts.push({ text: 'vol. ' + f('volume') })
  if (f('number')) parts.push({ text: 'no. ' + f('number') })
  if (f('pages')) parts.push({ text: 'pp. ' + f('pages').replace(/--/g, '-') })
  if (f('year')) parts.push({ text: f('year') })
  const texts = parts.map((p) => p.text)
  if (texts.length) {
    const last = texts[texts.length - 1]
    if (!last.endsWith('.')) parts[parts.length - 1] = { ...parts[parts.length - 1], text: last + '.' }
  }
  return parts
}

function isBib(node) {
  if (node.type.name !== 'code_block') return false
  const lang = (node.attrs.params || '').trim().split(/\s+/)[0].toLowerCase()
  return BIB_LANGS.includes(lang)
}

function makeWidget(source, view, getPos) {
  const wrap = document.createElement('div')
  wrap.className = 'nl-bib'
  wrap.setAttribute('contenteditable', 'false')
  // 点条目 = 把光标送进该块（与 mermaid / csv 同一交互：源码可见性由光标位置决定）
  wrap.addEventListener('click', (e) => {
    e.preventDefault()
    const state = view.state
    const $at = state.doc.resolve(getPos())
    const block = $at.nodeBefore
    if (!block || !isBib(block)) return
    const tr = state.tr.setSelection(TextSelection.near(state.doc.resolve($at.pos - block.nodeSize + 1), 1))
    tr.setMeta('addToHistory', false)
    view.dispatch(tr.scrollIntoView())
    view.focus()
  })
  const entries = parseBibEntries(source)
  if (entries.length) {
    const head = document.createElement('div')
    head.className = 'nl-bib-head'
    head.textContent = t('bib.count', { n: entries.length })
    wrap.appendChild(head)
    const list = document.createElement('ol')
    list.className = 'nl-bib-list'
    for (const e of entries) {
      const li = document.createElement('li')
      li.className = 'nl-bib-item'
      const ref = document.createElement('div')
      ref.className = 'nl-bib-ref'
      ref.textContent = e.key + (e.type ? ' · ' + e.type : '')
      const body = document.createElement('div')
      body.className = 'nl-bib-text'
      const parts = bibEntryParts(e.fields)
      let prev = null
      for (const p of parts) {
        if (prev) body.appendChild(document.createTextNode(', '))
        prev = p
        if (p.em) {
          const em = document.createElement('em')
          em.textContent = p.text
          body.appendChild(em)
        } else {
          body.appendChild(document.createTextNode(p.text))
        }
      }
      if (!parts.length) body.textContent = source // 有条目但没可用字段：不空着
      li.append(ref, body)
      list.appendChild(li)
    }
    wrap.appendChild(list)
  } else {
    wrap.appendChild(document.createTextNode(source.trim() || ' '))
  }
  return wrap
}

function buildDecorations(doc, editing) {
  const decos = []
  doc.descendants((node, pos) => {
    if (!isBib(node)) return
    const source = node.textContent
    const after = pos + node.nodeSize
    if (pos === editing) {
      // 出码态：源码可见可编辑，只描边提示，不挂条目
      decos.push(Decoration.node(pos, after, { class: 'nl-bib-editing' }))
      return
    }
    decos.push(Decoration.node(pos, after, { class: 'nl-bib-source' }))
    decos.push(
      Decoration.widget(after, (view, getPos) => makeWidget(source, view, getPos), {
        side: 1,
        // key 含源码指纹：内容不变时 PM 复用 DOM，编辑别处不重渲
        key: 'nlbib:' + source,
        stopEvent: () => true,
      })
    )
  })
  return DecorationSet.create(doc, decos)
}

// 光标落在哪个 bibtex 块内（返回该块位置，否则 null）——出码态的唯一判据
function editingPosIn(doc, sel) {
  const $h = sel.$head || doc.resolve(sel.head)
  for (let d = $h.depth; d > 0; d--) {
    if (isBib($h.node(d))) return $h.before(d)
  }
  return null
}

export function bibtexPlugin() {
  return new Plugin({
    key: bibKey,
    state: {
      init(_, { doc }) {
        return { set: buildDecorations(doc, null), editing: null }
      },
      apply(tr, prev, oldState, newState) {
        const editing = newState ? editingPosIn(tr.doc, newState.selection) : prev.editing
        if (!tr.docChanged && editing === prev.editing && tr.getMeta(bibKey) !== 'refresh') {
          return { set: prev.set.map(tr.mapping, tr.doc), editing }
        }
        return { set: buildDecorations(tr.doc, editing), editing }
      },
    },
    props: {
      decorations(state) {
        return bibKey.getState(state).set
      },
      handleKeyDown(view, ev) {
        if (ev.key !== 'Escape') return false
        const st = bibKey.getState(view.state)
        if (!st || st.editing == null) return false
        const pos = st.editing
        const node = view.state.doc.nodeAt(pos)
        const tr = view.state.tr
        if (node) {
          const sel = TextSelection.near(view.state.doc.resolve(pos), -1)
          if (sel.from < pos || sel.to > pos + node.nodeSize) tr.setSelection(sel)
        }
        tr.setMeta('addToHistory', false)
        view.dispatch(tr)
        return true
      },
    },
  })
}
