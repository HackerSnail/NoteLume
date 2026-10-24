// emoji-decorations.js —— emoji 短代码显示（:smile: → 😄，视图层装饰，不改文档模型）
//
// 策略（与 hl-decorations.js 同族）：
//  · 文档里的文本永远是 :name: 原文（GFM 兼容，Obsidian / Typora 打开照旧）。
//  · 扫描文本节点命中词表时，叠加「emoji widget + 原文隐藏」两个装饰——
//    显示层换脸，光标 / 编辑 / 序列化全走原文。
//  · 行内代码与代码块里不换脸：代码里的 :x: 是字面量，动了就是改语义。
// 词表与文本查找在 emoji-text.js（无 PM 依赖，导出渲染同用一份）。

import { Plugin, PluginKey } from 'prosemirror-state'
import { Decoration, DecorationSet } from 'prosemirror-view'
import { findEmojiInText } from './emoji-text.js'

const emojiKey = new PluginKey('nl-emoji')

// 行内代码标记 / 代码块内的文本节点不参与换脸
function isLiteralCode(node) {
  if (node.marks && node.marks.some((mk) => mk.type.name === 'code')) return true
  return node.parent && node.parent.type && node.parent.type.name === 'code_block'
}

function buildEmojiDecos(doc) {
  const decos = []
  doc.descendants((node, pos) => {
    if (!node.isText || !node.text || isLiteralCode(node)) return
    for (const hit of findEmojiInText(node.text)) {
      const from = pos + hit.start
      const to = pos + hit.end
      // 原文藏起（宽度归零，光标仍可落）、emoji 摆在原位；title 留短代码名方便反查
      decos.push(Decoration.widget(from, () => {
        const span = document.createElement('span')
        span.className = 'nl-emoji'
        span.textContent = hit.emoji
        span.title = ':' + hit.name + ':'
        return span
      }, { side: -1, ignoreSelection: true, key: hit.name }))
      decos.push(Decoration.inline(from, to, { style: 'font-size:0' }))
    }
  })
  return DecorationSet.create(doc, decos)
}

export function emojiPlugin() {
  return new Plugin({
    key: emojiKey,
    state: {
      init: (_, state) => buildEmojiDecos(state.doc),
      apply: (tr, old) => (tr.docChanged ? buildEmojiDecos(tr.doc) : old),
    },
    props: {
      decorations: (state) => emojiKey.getState(state),
    },
  })
}
