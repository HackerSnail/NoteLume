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
// 围栏代码块同一条时机（见文末 fenceInputTr）：行首敲 ``` 或 ```lang，落一个空格就地转
// 代码块，围栏标记吃掉、语言名进 attrs.params。回车路径同规则，在 block-commands.js 的
// nlEnter 里（fenceEnter），连同块内 ``` 回车的退出（codeFenceExit），进出对称。
//
// 不转换的场合：非段落文本块（代码块、标题）；容器放不下列表（表格单元格）；列表标记
// 不在块首（`x[ ] ` 这种）；标记右侧还有内容时也照样转换（`- abc` 中间补敲的空格同样生效，
// abc 进列表项——Typora 同行为）。

import { TextSelection } from 'prosemirror-state'
import { Fragment } from 'prosemirror-model'
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

// —— 围栏代码块输入规则 ——
// 行首敲 ``` 或 ```lang，落一个空格就地转代码块（与列表规则同时机：空格落定即转换）。
// 围栏标记吃掉，光标后的内容原样进块内；语言名落 attrs.params（即围栏 info string），
// 与解析器对同形态输入的判定一致。回车路径在 block-commands.js 的 nlEnter（fenceEnter），
// 连同块内 ``` 回车的退出（codeFenceExit），进出对称。
// 语言联想（敲 ``` 后弹语言下拉，Typora 式）在 suggest-plugin.js 的 fence 分支，
// 确认选中语言走下面的 fenceLangTr——与空格 / 回车路径共用同一条转换规则。
export const FENCE_RE = /^`{3,}([A-Za-z0-9_+#-]*)$/

/**
 * 光标所在段落整段就是围栏时，把段落换成代码块；否则 null。
 * 块首约束由 before 的形态保证：before 是块首到光标的文本，`x``` ` 这类前缀不匹配。
 * @param {import('prosemirror-state').EditorState} state
 * @param {import('prosemirror-state').ResolvedPos} $head 光标（段落内，sel.empty）
 * @param {string} before 块首到光标的文本
 * @returns {import('prosemirror-transform').Transform|null}
 */
export function fenceTr(state, $head, before) {
  if ($head.parent.type.name !== 'paragraph') return null
  const m = FENCE_RE.exec(before)
  if (!m) return null
  // 容器要放得下代码块（脚注项只收一个段落，放不下不转）
  if (!$head.node(-1).type.contentMatch.matchType(schema.nodes.code_block)) return null
  const paraFrom = $head.before($head.depth)
  const paraTo = $head.after($head.depth)
  // 只收纯文本：段落里可能有 hard_break 等行内节点，代码块的 content 是 text*，
  // 原样塞进去会被 Node.create 拒掉（剔掉好过抛错——围栏前的那段本就是刚敲的同一段）
  const rest = []
  state.doc.slice($head.pos, paraTo - 1).content.forEach((n) => { if (n.isText) rest.push(n) })
  const cb = schema.nodes.code_block.create({ params: m[1] }, Fragment.from(rest))
  const tr = state.tr.replaceWith(paraFrom, paraTo, cb)
  tr.setSelection(TextSelection.create(tr.doc, paraFrom + 1))
  return tr
}

/**
 * 空格落定时的围栏转换（listInputTr 的兄弟，同一时机不同规则，形态互斥不会互相挡）。
 * @returns {import('prosemirror-transform').Transform|null} 命中返回 transform，未命中 null
 */
export function fenceInputTr(state, $head, before, text) {
  if (text !== ' ') return null
  return fenceTr(state, $head, before)
}

/**
 * 语言联想的确认路径（suggest-plugin.js 的 fence 分支，Enter / Tab / 点击选中时调）：
 * 段首围栏 + 已敲的语言名整段换成代码块，语言取联想选中值（不是 before 里敲的那串——
 * 用户可能敲到一半就选中了别的），语言名文本整段删除、不进块内。
 * 只认「整段就是围栏 + 语言名」的形态；光标后还挂着内容时交给 nlEnter 的 fenceEnter
 * （那边保留光标后内容进块内，是「```js 代码」的既有语义，与空格路径同一口径）。
 * @param {import('prosemirror-state').EditorState} state
 * @param {string} lang 选中的语言（hljs 注册名或预览语言；'' = 纯文本）
 * @returns {import('prosemirror-transform').Transform|null}
 */
export function fenceLangTr(state, lang) {
  const { $from, empty } = state.selection
  if (!empty || $from.parent.type.name !== 'paragraph') return null
  const start = $from.start()
  const paraTo = $from.after($from.depth)
  const paraText = state.doc.textBetween(start, paraTo - 1, '\u0000', '\u0000')
  if (!FENCE_RE.test(paraText)) return null
  // 容器要放得下代码块（脚注项只收一个段落，放不下不转）
  if (!$from.node(-1).type.contentMatch.matchType(schema.nodes.code_block)) return null
  const paraFrom = $from.before($from.depth)
  const cb = schema.nodes.code_block.create({ params: lang })
  const tr = state.tr.replaceWith(paraFrom, paraTo, cb)
  tr.setSelection(TextSelection.create(tr.doc, paraFrom + 1))
  return tr
}
