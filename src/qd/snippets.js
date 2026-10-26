// qd/snippets.js —— Quarkdown 入门片段（斜杠菜单、编辑器右键菜单共用）
//
// 可发现性是 Quarkdown 这张牌的第一道坎：藏在设置与文档里的功能约等于没做。
// 这里给出几个一行就能跑的片段，新用户在 / 菜单里偶然点出来就能看到
// 「指令 → 求值结果」的效果（features.quarkdown 默认开，无需任何设置）。
//
// 片段以 PM 节点形式插入：指令行落段落，块参数体落 code_block——与 qd/editor.js
// 收集求值区域的结构（指令段 + 连续 code_block / 列表）一致，插入即出快照，
// 序列化按既有规则还原 4 空格缩进，源文件不受影响。
// 片段文案走词条（qd.snip.* / slash.qd.*），五语言跟随界面切换。

import { Fragment } from 'prosemirror-model'
import { schema } from '../editor-schema.js'
import { t } from '../i18n.js'

const para = (text) => schema.nodes.paragraph.create(null, text ? schema.text(text) : null)
const code = (text) => schema.nodes.code_block.create({ params: '' }, schema.text(text))

/**
 * 片段清单。nodes() 每次调用现建节点（同一片段可重复插入）。
 * text 字段给右键菜单与命令面板的提示（labelKey / kwKey 走词条）。
 */
export const QD_SNIPPETS = [
  {
    id: 'var',
    icon: 'terminal',
    labelKey: 'slash.qd.var',
    kwKey: 'slash.kw.qd.var',
    nodes: () => [para(t('qd.snip.var'))],
  },
  {
    id: 'foreach',
    icon: 'list-bullet',
    labelKey: 'slash.qd.foreach',
    kwKey: 'slash.kw.qd.foreach',
    nodes: () => [para('.foreach {1..3}'), code(t('qd.snip.foreachBody'))],
  },
  {
    id: 'ifnot',
    icon: 'question',
    labelKey: 'slash.qd.ifnot',
    kwKey: 'slash.kw.qd.ifnot',
    nodes: () => [para('.ifnot {done}'), code(t('qd.snip.ifnotBody'))],
  },
  {
    id: 'text',
    icon: 'code',
    labelKey: 'slash.qd.text',
    kwKey: 'slash.kw.qd.text',
    nodes: () => [para('.text {hello} case:{uppercase}')],
  },
]

/** 把片段插到当前选区（右键菜单入口；斜杠菜单走自己的块替换路径，不经这里） */
export function insertSnippet(view, snip) {
  view.focus()
  const tr = view.state.tr
  const sel = view.state.selection
  if (!sel.empty) tr.delete(sel.from, sel.to)
  tr.replaceSelection(Fragment.fromArray(snip.nodes()))
  view.dispatch(tr.scrollIntoView())
}
