// fold-plugin.js —— 标题折叠（Typora 式「整节收起」：含子标题一起藏）
//
// 取舍：
//  · 折叠只作用于**渲染**：Decoration.node 把被藏顶层块 display:none，文档模型 / 序列化 / 落盘字节不变。
//  · 折叠集合存插件 state（事务带 addToHistory=false，不进 undo 栈），按标题位置记录；
//    文档改动时用 tr.mapping 平移，并剪掉不再是可折标题的位置。
//  · 跨「源码模式往返」保留（工厂闭包镜像一份，EditorState 重建时 init 读回），换文档由调用方 api.reset() 清空。
//  · 入口两处：标题行首 hover 出现的三角（直接点）、editor.foldSection 命令（光标在标题上折该标题，
//    在正文里折其所属节）；两者共用 toggleFold()。
import { Plugin, PluginKey, TextSelection } from 'prosemirror-state'
import { Decoration, DecorationSet } from 'prosemirror-view'
import { iconHTML } from './icons.js'

export const foldKey = new PluginKey('nl-fold')
const NO_FOLDS = []

/**
 * 扫描顶层块，算出每个「其下有内容」的标题的可折范围。纯函数，可 Node 单测。
 * @returns {{ foldable: Map<number, {hideFrom:number, hideTo:number, items:Array, count:number, textEnd:number}> }}
 */
export function analyzeFolds(doc) {
  const blocks = []
  doc.forEach((node, pos) => {
    blocks.push({ pos, end: pos + node.nodeSize, level: node.type.name === 'heading' ? node.attrs.level : 0 })
  })
  const foldable = new Map()
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i]
    if (!b.level) continue
    let j = i + 1
    // 直到下一个同级或更高级标题为止：其间的子标题与正文一并收起
    while (j < blocks.length && !(blocks[j].level && blocks[j].level <= b.level)) j++
    if (j <= i + 1) continue // 标题后无内容：不可折
    const items = blocks.slice(i + 1, j).map((x) => [x.pos, x.end])
    foldable.set(b.pos, {
      hideFrom: items[0][0],
      hideTo: items[items.length - 1][1],
      items,
      count: items.length,
      textEnd: b.end - 1,
    })
  }
  return { foldable }
}

function toggleWidgetDOM(folded, pos) {
  const s = document.createElement('span')
  s.className = 'nl-fold-toggle' + (folded ? ' is-folded' : '')
  s.setAttribute('contenteditable', 'false')
  s.setAttribute('data-pos', String(pos))
  s.innerHTML = iconHTML('chevron-down')
  return s
}

function countWidgetDOM(count, pos) {
  const s = document.createElement('span')
  s.className = 'nl-fold-count'
  s.setAttribute('contenteditable', 'false')
  s.setAttribute('data-pos', String(pos))
  s.textContent = ' […] ' + count
  return s
}

function buildDecorations(doc, folded) {
  const { foldable } = analyzeFolds(doc)
  if (!foldable.size) return null
  const decos = []
  for (const [pos, r] of foldable) {
    const isFolded = folded.includes(pos)
    // key 让 PM 在重建装饰集时复用同一 DOM（否则每次按键都替换标题行首的三角）
    decos.push(Decoration.widget(pos + 1, toggleWidgetDOM(isFolded, pos), { inline: true, key: 'nl-fold-t-' + pos + (isFolded ? '-1' : '-0') }))
    if (!isFolded) continue
    for (const [from, to] of r.items) decos.push(Decoration.node(from, to, { class: 'nl-fold-hidden' }))
    decos.push(Decoration.widget(r.textEnd, countWidgetDOM(r.count, pos), { inline: true, key: 'nl-fold-c-' + pos }))
  }
  return DecorationSet.create(doc, decos)
}

/**
 * 折叠/展开 pos 处的标题节；pos 不是可折标题时返回 false。
 * 收起时若选区落在被藏区间内，把光标挪到该标题末尾（否则会编辑到看不见的文字）。
 */
export function toggleFold(state, dispatch, pos) {
  const { foldable } = analyzeFolds(state.doc)
  const r = foldable.get(pos)
  if (!r) return false
  const cur = foldKey.getState(state) || []
  const isFolded = cur.includes(pos)
  const tr = state.tr
  if (isFolded) {
    tr.setMeta(foldKey, { set: cur.filter((p) => p !== pos) })
  } else {
    tr.setMeta(foldKey, { set: cur.concat([pos]) })
    const { from, to } = state.selection
    // 选区严格落在被藏区间内才挪（hideTo 是末块的非包含端点，别把紧邻的下一块也算进去）
    if (from >= r.hideFrom && to <= r.hideTo) tr.setSelection(TextSelection.near(state.doc.resolve(r.textEnd), 1))
  }
  tr.setMeta('addToHistory', false)
  if (dispatch) dispatch(tr)
  return true
}

// editor.foldSection：光标在标题上 → 折该标题；在正文里 → 折它所属（最近的前置）标题
export function foldSectionCommand(state, dispatch) {
  const $h = state.selection.$head
  if ($h.depth < 1) return false
  const { foldable } = analyzeFolds(state.doc)
  const top = $h.before(1)
  let target = foldable.has(top) ? top : null
  if (target == null) {
    for (const p of foldable.keys()) if (p < top && (target == null || p > target)) target = p
  }
  if (target == null) return false
  return toggleFold(state, dispatch, target)
}

// 大纲/搜索跳转前调用：展开任何把 pos 藏起来的节（pos 是标题本身时不受影响）
export function unfoldCovering(state, pos) {
  const cur = foldKey.getState(state) || []
  if (!cur.length) return null
  const { foldable } = analyzeFolds(state.doc)
  const drop = new Set()
  for (const h of cur) {
    const r = foldable.get(h)
    if (r && pos >= r.hideFrom && pos < r.hideTo) drop.add(h)
  }
  if (!drop.size) return null
  return state.tr.setMeta(foldKey, { set: cur.filter((p) => !drop.has(p)) }).setMeta('addToHistory', false)
}

export function createFoldPlugin() {
  // 闭包镜像：EditorState 重建（源码模式往返）时 init 读它，折叠态因此不丢
  let folded = []
  // 装饰集缓存：apply 只在文档/折叠态真变化时产出新数组，故按引用相等即可判定复用
  let cache = null

  const plugin = new Plugin({
    key: foldKey,
    state: {
      init: () => folded.slice(),
      apply(tr, old) {
        const m = tr.getMeta(foldKey)
        if (!m && !tr.docChanged) return old // 纯选区变化：保持同一数组引用，令装饰缓存命中
        let next = m && Array.isArray(m.set) ? m.set.slice() : old.slice()
        if (tr.docChanged) {
          const { foldable } = analyzeFolds(tr.doc)
          const seen = new Set()
          next = next
            .map((p) => (m ? p : tr.mapping.map(p)))
            .filter((p) => foldable.has(p) && !seen.has(p) && seen.add(p))
        }
        folded = next
        return next
      },
    },
    props: {
      decorations(state) {
        const cur = foldKey.getState(state) || NO_FOLDS
        if (cache && cache.folded === cur && cache.doc === state.doc) return cache.set
        const set = buildDecorations(state.doc, cur)
        cache = { folded: cur, doc: state.doc, set }
        return set
      },
      handleDOMEvents: {
        mousedown(view, ev) {
          const t = ev.target && ev.target.closest ? ev.target.closest('.nl-fold-toggle, .nl-fold-count') : null
          if (!t) return false
          ev.preventDefault()
          toggleFold(view.state, view.dispatch, Number(t.getAttribute('data-pos')))
          return true
        },
      },
    },
  })

  return {
    plugin,
    api: {
      reset() {
        folded = []
      },
    },
  }
}
