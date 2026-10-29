// block-input-rules.js —— 块级 Markdown 输入规则（纯逻辑，不依赖 DOM）
//
// 列表族的输入即转换，与 Typora 的手感一致：敲完标记加空格的那一刻段落就地变成列表。
// 覆盖三种：`- ` / `* ` / `+ ` → 无序列表；`1. ` → 有序列表（起始号取输入的数字）；
// `[ ] ` / `[x] ` → 任务项（只在无序列表项内生效——GFM 的任务语法只定义在 bullet list 上，
// 有序列表里敲 `[ ] ` 留字面量）。此前手敲 `- [ ] 待办` 只会留下字面文本，没有勾选框可点。
//
// 触发时机是空格落定（editor-view.js 的 handleTextInput，text === ' '）：
// 敲 `- ` 的空格时整段换成无序列表，接着敲 `[ ] ` 的空格把该项转为任务——两步自然衔接，
// 与 Typora 相同。标记文字（含那个空格）从段落里删掉，光标后的内容原样保留。
//
// 不转换的场合：非段落文本块（代码块、标题）；容器放不下列表（表格单元格）；列表标记
// 不在块首（`x[ ] ` 这种）；标记右侧还有内容时也照样转换（`- abc` 中间补敲的空格同样生效，
// abc 进列表项——Typora 同行为）。

import { TextSelection } from 'prosemirror-state'
import { schema } from './editor-schema.js'

const BULLET_MARKERS = ['- ', '* ', '+ ']
const TASK_RE = /^\[( |x|X)\]$/

/**
 * 空格落定时的块级转换。
 * @param {import('prosemirror-state').EditorState} state
 * @param {import('prosemirror-state').ResolvedPos} $head 光标（调用方已确认 sel.empty 且在 textblock 内）
 * @param {string} before 块首到光标的文本（不含本次输入的空格）
 * @param {string} text 本次输入的字符，只处理 ' '
 * @returns {import('prosemirror-transform').Transform|null} 命中返回 transform（含新光标），未命中 null
 */
export function listInputTr(state, $head, before, text) {
  if (text !== ' ') return null
  // 只在段落里转：代码块 / 标题等别的文本块不动
  if ($head.parent.type.name !== 'paragraph') return null
  const full = before + text
  const blockFrom = $head.start()
  const caret = $head.pos

  // 任务项：光标在无序列表项的段落里，敲完 `[ ] ` / `[x] `
  if (TASK_RE.test(before) && $head.depth >= 2) {
    const li = $head.node(-1)
    const list = $head.node(-2)
    if (li.type.name === 'list_item' && list.type.name === 'bullet_list') {
      const tr = state.tr.delete(blockFrom, caret)
      tr.setNodeMarkup($head.before(-1), null, { ...li.attrs, checked: before[1] !== ' ' })
      tr.setSelection(TextSelection.create(tr.doc, blockFrom))
      return tr
    }
    return null
  }

  // 无序 / 有序：整段（含标记）换成 列表 > 列表项 > 段落，光标后的内容进列表项。
  // tight 置 true：敲出来的列表项之间没有空行，与解析器对同形态输入的判定一致，
  // 否则「敲出来的文档 == 存盘再解析的文档」不成立
  let listType = null
  let attrs = { tight: true }
  if (BULLET_MARKERS.includes(full)) {
    listType = schema.nodes.bullet_list
  } else {
    const m = /^(\d{1,9})\. $/.exec(full)
    if (m) {
      listType = schema.nodes.ordered_list
      attrs.order = Number(m[1]) || 1
    }
  }
  if (!listType) return null

  // 光标已在列表项里：新敲的标记是冗余的（回车新项自带标记），整串 `- [x] 事项` 的
  // 输入习惯不该被搅成嵌套列表。空项里把标记吞掉，后面接着敲的 `[x] ` 走任务规则；
  // 项内有内容（光标后有字）时保持字面量
  let inListItem = false
  for (let d = $head.depth; d > 0; d--) {
    if ($head.node(d).type.name === 'list_item') { inListItem = true; break }
  }
  if (inListItem) {
    if (caret === $head.end()) {
      const tr = state.tr.delete(blockFrom, caret)
      tr.setSelection(TextSelection.create(tr.doc, blockFrom))
      return tr
    }
    return null
  }

  // 容器要放得下列表（表格单元格等放不下的不转）
  if (!$head.node(-1).type.contentMatch.matchType(listType)) return null

  // 替换整个段落节点（不是它的内容区间）：把列表塞进段落内容里，PM 修补后会多出空段落
  const paraFrom = $head.before($head.depth)
  const paraTo = $head.after($head.depth)
  const rest = state.doc.slice(caret, paraTo - 1).content
  const item = schema.nodes.list_item.create(
    null,
    schema.nodes.paragraph.create(null, rest),
  )
  const list = listType.create(attrs, item)
  const tr = state.tr.replaceWith(paraFrom, paraTo, list)
  tr.setSelection(TextSelection.create(tr.doc, paraFrom + 3))
  return tr
}
