// footnotes.js —— 功能项 J：脚注的编辑期命令 + 序号/定位插件（Typora 式）
//
// 模型层（节点/parser/serializer）在 editor-schema.js；这里只负责「活编辑器」交互：
//  · insertFootnote：分配一个当前文档未用的最小数字 id，在光标处插入 footnote_ref，
//    并确保文末有 footnote_section、在其中追加对应 footnote_item（空段落，供键入正文）。
//  · deleteFootnote：删除光标处/相邻的 footnote_ref，连带删掉同 id 的 footnote_item；
//    若删空则移除整个 footnote_section，避免残留无引用的孤立定义。
//  · footnotePlugin：文档序现算显示序号（正文角标 [1][2]…；文末条目 data-ordinal 交 CSS 画），
//    并支持点击正文角标滚动定位到对应脚注条目。
//
// id 存的是稳定标识（数字字符串），序号只是显示层按 ref 文档序现算，绝不写回 md。

import { Plugin, PluginKey, NodeSelection } from 'prosemirror-state'

/** 当前文档未使用的最小正整数 id（ref 与 item 共用命名空间） */
export function nextFootnoteId(doc) {
  const used = new Set()
  doc.descendants((n) => {
    if (n.type.name === 'footnote_ref' || n.type.name === 'footnote_item') used.add(String(n.attrs.id))
  })
  let i = 1
  while (used.has(String(i))) i++
  return String(i)
}

/** 插入脚注（ProseMirror 命令：state, dispatch, view） */
export function insertFootnote(state, dispatch, view) {
  const s = state.schema
  if (!s.nodes.footnote_ref || !s.nodes.footnote_section || !s.nodes.footnote_item) return false
  const id = nextFootnoteId(state.doc)
  if (!dispatch) return true
  const ref = s.nodes.footnote_ref.create({ id })
  const item = s.nodes.footnote_item.create({ id }, s.nodes.paragraph.create())
  const tr = state.tr
  // 先处理文末区（在文档末尾增删不影响正文光标位置）：已有 section 则追加 item，否则新建
  const last = tr.doc.lastChild
  if (last && last.type.name === 'footnote_section') {
    tr.insert(tr.doc.content.size - 1, item)
  } else {
    tr.insert(tr.doc.content.size, s.nodes.footnote_section.create(null, item))
  }
  // 再在光标处放入角标
  tr.replaceSelectionWith(ref, false)
  dispatch(tr.scrollIntoView())
  if (view) view.focus()
  return true
}

/** 删除脚注：移除光标处/相邻的 ref 及其同 id 的 item（连带清理空 section） */
export function deleteFootnote(state, dispatch, view) {
  const s = state.schema
  if (!s.nodes.footnote_ref) return false
  const refPos = findRefPos(state)
  if (refPos == null) return false
  if (!dispatch) return true
  const id = String(state.doc.nodeAt(refPos).attrs.id)
  const tr = state.tr
  // footnote_ref 是行内原子节点，nodeSize = 1
  tr.delete(refPos, refPos + 1)
  // 在「已删 ref」后的文档中定位同 id 的 item 与其所属顶层 section
  let sectionPos = null
  let sectionNode = null
  let itemPos = null
  let itemNode = null
  tr.doc.forEach((child, offset) => {
    if (child.type.name !== 'footnote_section') return
    sectionPos = offset
    sectionNode = child
    child.forEach((it, itOff) => {
      if (String(it.attrs.id) === id) {
        itemNode = it
        itemPos = offset + 1 + itOff
      }
    })
  })
  if (itemPos != null) {
    if (sectionNode.childCount === 1) {
      // section 只剩这一条：整体移除，避免空 section
      tr.delete(sectionPos, sectionPos + sectionNode.nodeSize)
    } else {
      tr.delete(itemPos, itemPos + itemNode.nodeSize)
    }
  }
  dispatch(tr.scrollIntoView())
  if (view) view.focus()
  return true
}

/** 选中节点是 ref，或光标紧邻 ref（前/后）时，返回 ref 的绝对位置；否则 null */
function findRefPos(state) {
  const sel = state.selection
  if (sel instanceof NodeSelection && sel.node.type.name === 'footnote_ref') return sel.from
  const { $from } = sel
  const before = $from.nodeBefore
  if (before && before.type.name === 'footnote_ref') return $from.pos - before.nodeSize
  const after = $from.nodeAfter
  if (after && after.type.name === 'footnote_ref') return $from.pos
  return null
}

/** 序号现算 + 点击定位插件 */
export function footnotePlugin() {
  return new Plugin({
    key: new PluginKey('nlFootnote'),
    view(editorView) {
      // 正文角标按文档序现算 [1][2]…；文末条目按同 id 取对应序号，写入 data-ordinal 交 CSS ::before 画
      function renumber() {
        const dom = editorView.dom
        const refs = dom.querySelectorAll('sup.nl-footnote-ref')
        const ordinalById = {}
        refs.forEach((el, i) => {
          const n = i + 1
          el.textContent = '[' + n + ']'
          const id = el.getAttribute('data-id')
          if (id != null && ordinalById[id] == null) ordinalById[id] = n
        })
        const items = dom.querySelectorAll('div.nl-footnote-item')
        items.forEach((el, i) => {
          const id = el.getAttribute('data-id')
          const ord = ordinalById[id] != null ? ordinalById[id] : i + 1
          el.setAttribute('data-ordinal', String(ord))
        })
      }
      renumber()
      let raf = 0
      const schedule = () => {
        if (raf) return
        raf = requestAnimationFrame(() => {
          raf = 0
          renumber()
        })
      }
      return {
        update() {
          schedule()
        },
        destroy() {
          if (raf) cancelAnimationFrame(raf)
        },
      }
    },
    props: {
      // 点击正文角标 → 滚动定位到文末对应条目
      handleClickOn(view, pos, node) {
        if (node.type.name !== 'footnote_ref') return false
        const id = String(node.attrs.id)
        const item = view.dom.querySelector('div.nl-footnote-item[data-id="' + cssEscape(id) + '"]')
        if (item) {
          item.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
          item.classList.add('nl-footnote-flash')
          setTimeout(() => item.classList.remove('nl-footnote-flash'), 900)
        }
        return true
      },
    },
  })
}

// data-id 目前只会是数字字符串，仍做最小转义以防将来引入特殊字符
function cssEscape(s) {
  return String(s).replace(/["\\]/g, '\\$&')
}
