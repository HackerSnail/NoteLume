// csv-preview.js —— ```csv 代码块的表格渲染（视图层装饰，不改文档模型 / 不改 markdown 内容）
//
// 策略与 mermaid-preview.js 同构（Typora 式「只见表格，点表就地出码」）：
//  · code_block 仍只存纯文本 + attrs.params（语言 'csv'），parse/serialize 走原生 fence 路径，
//    源文件保持标准 GFM 代码块。
//  · 光标不在块内 → 隐藏源码、块尾挂表格 widget；光标进块 → 源码可见可编辑。Esc / 点别处回表态。
//  · CSV 是本地解析（无依赖、同步），RFC4180 口径：引号包裹、字段内逗号 / 换行 / 双写引号。
//  · 开关 features.csvTable 关掉时不挂任何装饰，块按普通代码块显示（feature-flags.js）。
//  · 导出件里 mermaid 的先例是保留代码块，CSV 跟随——导出側不渲染表格。

import { Plugin, PluginKey, TextSelection } from 'prosemirror-state'
import { Decoration, DecorationSet } from 'prosemirror-view'

const csvKey = new PluginKey('nl-csv')

/**
 * 解析 CSV 文本为二维数组（RFC4180 口径：引号包裹、字段内逗号 / 换行 / 双写引号转义）。
 * 尾部空行忽略；每行列数不齐时短行补空串。纯函数，可离线单测。
 * @param {string} text
 * @returns {string[][]}
 */
export function parseCsv(text) {
  const rows = []
  let row = []
  let field = ''
  let inQuotes = false
  const src = String(text == null ? '' : text)
  const pushField = () => { row.push(field); field = '' }
  const pushRow = () => { pushField(); rows.push(row); row = [] }
  for (let i = 0; i < src.length; i++) {
    const c = src[i]
    if (inQuotes) {
      if (c === '"') {
        if (src[i + 1] === '"') { field += '"'; i++ } // 双写引号 = 字面引号
        else inQuotes = false
      } else {
        field += c
      }
    } else if (c === '"') {
      inQuotes = true
    } else if (c === ',') {
      pushField()
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && src[i + 1] === '\n') i++
      pushRow()
    } else {
      field += c
    }
  }
  // 末尾无换行时最后一段还在手里；整行全空（末尾连续换行产生的空行）不另计一行
  if (field !== '' || row.length) pushRow()
  while (rows.length && rows[rows.length - 1].length === 1 && rows[rows.length - 1][0] === '') rows.pop()
  // 短行补空串：表格要矩形，缺格补齐
  let maxLen = 0
  for (const r of rows) maxLen = Math.max(maxLen, r.length)
  for (const r of rows) while (r.length < maxLen) r.push('')
  return rows
}

function isCsv(node) {
  if (node.type.name !== 'code_block') return false
  const lang = (node.attrs.params || '').trim().split(/\s+/)[0].toLowerCase()
  return lang === 'csv'
}

function buildTable(source) {
  const rows = parseCsv(source)
  if (!rows.length) return null
  const table = document.createElement('table')
  table.className = 'nl-csv-table'
  rows.forEach((cells, r) => {
    const tr = document.createElement('tr')
    for (const cell of cells) {
      const el = document.createElement(r === 0 ? 'th' : 'td')
      el.textContent = cell
      tr.appendChild(el)
    }
    table.appendChild(tr)
  })
  return table
}

function makeWidget(source, view, getPos) {
  const wrap = document.createElement('div')
  wrap.className = 'nl-csv'
  wrap.setAttribute('contenteditable', 'false')
  // 点表 = 把光标送进该块（与 mermaid 同一交互：源码可见性由光标位置决定）
  wrap.addEventListener('click', (e) => {
    e.preventDefault()
    const state = view.state
    const $at = state.doc.resolve(getPos())
    const block = $at.nodeBefore
    if (!block || !isCsv(block)) return
    const tr = state.tr.setSelection(TextSelection.near(state.doc.resolve($at.pos - block.nodeSize + 1), 1))
    tr.setMeta('addToHistory', false)
    view.dispatch(tr.scrollIntoView())
    view.focus()
  })
  const table = buildTable(source)
  if (table) {
    wrap.appendChild(table)
  } else {
    wrap.appendChild(document.createTextNode(source.trim() || ' '))
  }
  return wrap
}

function buildDecorations(doc, editing, getFeatures) {
  const flags = getFeatures ? getFeatures() : null
  if (flags && flags.csvTable === false) return DecorationSet.empty
  const decos = []
  doc.descendants((node, pos) => {
    if (!isCsv(node)) return
    const source = node.textContent
    const after = pos + node.nodeSize
    if (pos === editing) {
      // 出码态：源码可见可编辑，只描边提示，不挂表
      decos.push(Decoration.node(pos, after, { class: 'nl-csv-editing' }))
      return
    }
    decos.push(Decoration.node(pos, after, { class: 'nl-csv-source' }))
    decos.push(Decoration.widget(after, (view, getPos) => makeWidget(source, view, getPos), {
      side: 1,
      // key 含源码指纹：内容不变时 PM 复用 DOM，编辑别处不重渲
      key: 'nlcsv:' + source,
      stopEvent: () => true,
    }))
  })
  return DecorationSet.create(doc, decos)
}

// 光标落在哪个 csv 块内（返回该块位置，否则 null）——出码态的唯一判据
function editingPosIn(doc, sel) {
  const $h = sel.$head || doc.resolve(sel.head)
  for (let d = $h.depth; d > 0; d--) {
    if (isCsv($h.node(d))) return $h.before(d)
  }
  return null
}

export function csvPlugin(getFeatures) {
  return new Plugin({
    key: csvKey,
    state: {
      init(_, { doc }) {
        return { set: buildDecorations(doc, null, getFeatures), editing: null }
      },
      apply(tr, prev, oldState, newState) {
        const editing = newState ? editingPosIn(tr.doc, newState.selection) : prev.editing
        if (!tr.docChanged && editing === prev.editing && !tr.getMeta('nl-features') && tr.getMeta(csvKey) !== 'refresh') {
          return { set: prev.set.map(tr.mapping, tr.doc), editing }
        }
        return { set: buildDecorations(tr.doc, editing, getFeatures), editing }
      },
    },
    props: {
      decorations(state) {
        return csvKey.getState(state).set
      },
      handleKeyDown(view, ev) {
        if (ev.key !== 'Escape') return false
        const st = csvKey.getState(view.state)
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
