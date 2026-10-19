// inline-input-rules.js —— 行内 Markdown 输入规则（纯逻辑，不依赖 DOM）
//
// 输入即渲染：结束符落定的那次输入里，把整段字面量换成带标记的文本，与 [[..]] / #tag /
// $..$ 同一时机，由 editor-view.js 的 handleTextInput 调用。
//
// 覆盖强调家族：**粗** / *斜* / ~~删~~ / __粗__ / _斜_。转换前把候选串连同开标记左侧
// 那个字符一起过一遍解析器，只有确实产出对应标记才换——判定复用解析器本身（含
// editor-schema.js 的中文标点放宽），屏幕上看到的与存盘后再解析的结果不会分叉。不认的
// 形态留着字面量：内容首尾带空格（`**foo **`）、`_` 的词内写法（`word_斜_`、`文件_备份`）。
//
// 已知边界：`**foo:**` 这类 ASCII 标点紧贴收尾的写法，光标处成立所以会转换，但转换后
// 紧接着打 ASCII 文字才与解析器分叉（CommonMark 不认 `**foo:**bar`）；内容里再嵌
// Markdown（`**a `b` c**`、`**a [x](y) b**`）只换外层标记，内层留字面量，存盘内容不变；
// `***粗**` 这类三重标记不接；区间跨叶子节点（图片 / [[链接]] / 行内公式）时不换。

import { TextSelection } from 'prosemirror-state'
import { schema, mdParser } from './editor-schema.js'

// 同一结束符长的在前：** 先于 *、__ 先于 _，半程状态（`**粗*`）才不会被短规则抢先
const EMPH_RULES = [
  { char: '*', mark: 'strong', re: /(^|[^*])\*\*([^*\n]+)\*\*$/ },
  { char: '*', mark: 'em', re: /(^|[^*])\*([^*\n]+)\*$/ },
  { char: '~', mark: 'strike', re: /(^|[^~])~~([^~\n]+)~~$/ },
  { char: '_', mark: 'strong', re: /(^|[^_])__([^_\n]+)__$/ },
  { char: '_', mark: 'em', re: /(^|[^_])_([^_\n]+)_$/ },
]

// 候选串（含左边界字符）走一遍解析器：产物里出现目标标记才认。markdown-it 只在定界符
// 真正配平后才发开标记，未配平的留着字面文本，所以「有标记」即「这段是强调」。
function parsesWithMark(candidate, markName) {
  let ok = false
  mdParser.parse(candidate).descendants((n) => {
    if (n.isText && n.marks.some((m) => m.type.name === markName)) ok = true
  })
  return ok
}

/**
 * 强调结束符（* / ~ / _）落定时，把 `**粗**` 这类整段字面量换成带标记文本。
 * @param {import('prosemirror-state').EditorState} state
 * @param {import('prosemirror-model').ResolvedPos} $head 光标（调用方已确认 sel.empty 且在 textblock 内）
 * @param {string} before 块首到光标的文本，叶子节点需由调用方换成 '\u0000'
 * @param {string} text 本次输入的字符
 * @returns {import('prosemirror-transform').Transform|null} 命中返回 transform（含光标后移），未命中 null
 */
export function emphasisInputTr(state, $head, before, text) {
  if (text !== '*' && text !== '~' && text !== '_') return null
  const caret = $head.pos
  const blockFrom = $head.start()
  const full = before + text
  for (const r of EMPH_RULES) {
    if (r.char !== text) continue
    const m = r.re.exec(full)
    if (!m) continue
    // 代码块等只放行 code 标记的块里不转换（schema: code_block marks='code'）
    if (!$head.parent.type.allowsMarkType(schema.marks[r.mark])) continue
    const ctx = m[1] // 开标记左侧那个字符（'' = 块首），不属于替换范围
    if (m[2].includes('\u0000')) continue // 内容区跨叶子节点，不换
    const startAbs = caret - (m[0].length - text.length - ctx.length)
    if (startAbs < blockFrom) continue
    if (!parsesWithMark(ctx + m[0].slice(ctx.length), r.mark)) continue
    const node = schema.text(m[2], [schema.marks[r.mark].create()])
    const tr = state.tr.replaceWith(startAbs, caret, node)
    tr.setSelection(TextSelection.create(tr.doc, startAbs + node.nodeSize))
    // 清空 storedMarks：光标紧贴带标记文本，不显式清的话下一个字符会按 $from.marks()
    // 继承加粗（Transaction.insertText 取 storedMarks ?? $from.marks()），打出来的
    // `**粗**尾` 会是 strong(粗尾)，与解析器给的 strong(粗)+尾 不一致。
    // setSelection 会把 storedMarks 重置为 null，故须放在它之后。
    tr.setStoredMarks([])
    return tr
  }
  return null
}
