// emoji-text.js —— emoji 短代码的词表与文本替换（无 ProseMirror / DOM 依赖，可离线单测）
//
// 为什么不用 markdown-it-emoji 插件：它的 core 规则在 parse 阶段把 :name: 文本 token 换成
// emoji token，prosemirror-markdown 遇到未知 token 会跳过——编辑器文档直接丢字，保存即删内容。
// 这里的做法只在渲染层换脸：md.renderer.rules.text 里把命中的 :name: 输出成 emoji 字符，
// 解析流水线（tokenize / parse）零改动，md 文件里永远是原文。
// 词表：markdown-it-emoji 的 full 数据（约 1900 条，GitHub 同款）+ shortcuts 别名。

import emojiDefs from 'markdown-it-emoji/lib/data/full.mjs'
import emojiShortcuts from 'markdown-it-emoji/lib/data/shortcuts.mjs'

const EMOJI_RE = /:([a-zA-Z0-9_+-]+):/g

// name → emoji 字符。shortcuts 的值是别名 → 正名，先铺正名再铺别名，别名覆盖不到的丢掉
export const EMOJI_MAP = (() => {
  const map = Object.create(null)
  for (const [name, emoji] of Object.entries(emojiDefs)) map[name.toLowerCase()] = emoji
  for (const [alias, target] of Object.entries(emojiShortcuts)) {
    const emoji = map[String(target).toLowerCase()]
    if (emoji && !map[alias.toLowerCase()]) map[alias.toLowerCase()] = emoji
  }
  return map
})()

/**
 * 在一段文本里找可换脸的短代码。
 * @returns {Array<{ start: number, end: number, name: string, emoji: string }>} start/end 基于文本索引
 */
export function findEmojiInText(text) {
  const out = []
  EMOJI_RE.lastIndex = 0
  let m
  while ((m = EMOJI_RE.exec(text))) {
    const emoji = EMOJI_MAP[m[1].toLowerCase()]
    if (emoji) out.push({ start: m.index, end: m.index + m[0].length, name: m[1], emoji })
  }
  return out
}

/**
 * 给 markdown-it 实例挂 emoji 渲染：text token 命中 :name: 时输出 emoji 字符。
 * 只动 renderer.rules.text，解析流水线零改动——编辑器 tokenize / parse 不受影响。
 * 已挂过的不重复挂（shared tokenizer 可能被多个入口各挂一次）。
 */
export function mountEmojiRenderer(md) {
  if (md.renderer.rules.__nlEmoji) return
  const prevText = md.renderer.rules.text
  md.renderer.rules.text = (tokens, idx, options, env, self) => {
    const content = tokens[idx].content
    const hits = findEmojiInText(content)
    if (!hits.length) {
      return prevText ? prevText(tokens, idx, options, env, self) : md.utils.escapeHtml(content)
    }
    let out = ''
    let last = 0
    for (const h of hits) {
      out += md.utils.escapeHtml(content.slice(last, h.start)) + h.emoji
      last = h.end
    }
    return out + md.utils.escapeHtml(content.slice(last))
  }
  md.renderer.rules.__nlEmoji = true
}
