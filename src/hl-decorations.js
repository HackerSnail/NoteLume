// hl-decorations.js —— 代码块语法高亮（视图层装饰，不改文档模型，不改 markdown 内容）
//
// 策略：
//  · ProseMirror 的 code_block 节点仍然只保存纯文本 + attrs.params（语言标识）。
//  · 每次 state 更新时，把每个 code_block 的文本喂给 highlight.js，
//    解析其输出的 HTML（含 <span class="hljs-xx">…</span>）到 [起点,终点,类名] 序列，
//    转成 inline Decoration 叠加在编辑视图上。
//  · 编辑体验无损：光标 / 选区 / 键盘输入完全走 ProseMirror 原路径；装饰只影响渲染。

import { Plugin, PluginKey } from 'prosemirror-state'
import { Decoration, DecorationSet } from 'prosemirror-view'
import hljs from 'highlight.js/lib/common'

const hlKey = new PluginKey('nl-hl')

// 把 hljs 输出的 HTML 映射回原文的字符区间与类名
// 输入：raw（原始纯文本）、html（hljs.value，即 raw 转义 + 包裹 span 的 HTML）
// 输出：[[start, end, className], ...]，start/end 基于 raw 的字符索引（非字节）
function mapTokens(html) {
  const out = []
  const stack = []
  let i = 0
  let off = 0
  while (i < html.length) {
    const c = html[i]
    if (c === '<') {
      if (html[i + 1] === '/') {
        const end = html.indexOf('>', i)
        if (end < 0) break
        const cls = stack.pop()
        if (cls) out.push([cls.start, off, 'hljs-' + cls.name])
        i = end + 1
      } else {
        const end = html.indexOf('>', i)
        if (end < 0) break
        const tag = html.slice(i + 1, end)
        const m = /class="hljs-([^"]+)"/.exec(tag)
        if (m) stack.push({ name: m[1], start: off })
        i = end + 1
      }
    } else if (c === '&') {
      const semi = html.indexOf(';', i)
      if (semi < 0) {
        off += 1
        i += 1
      } else {
        const ent = html.slice(i, semi + 1)
        // hljs 只会输出 5 种实体；其它原样保留
        if (ent === '&amp;') off += 1
        else if (ent === '&lt;') off += 1
        else if (ent === '&gt;') off += 1
        else if (ent === '&quot;') off += 1
        else if (ent === '&#39;' || ent === '&apos;') off += 1
        else off += 1 // 兜底：当作 1 字符前进
        i = semi + 1
      }
    } else {
      off += 1
      i += 1
    }
  }
  while (stack.length) {
    const cls = stack.pop()
    out.push([cls.start, off, 'hljs-' + cls.name])
  }
  return out
}

// C 系预处理指令的中间态不上色：hljs 的 PREPROCESSOR 规则「# 后跟一个字母」即匹配，
// 于是 #i / #in / #inc 也整段染成 meta——Typora（lezer 解析）要完整指令名才变色。
// 借 hljs 自己的词表判定：完整指令的指令词会被单独包一层 hljs-keyword
// （#include → meta(#) + keyword(include)、# define → meta(# ) + keyword(define)），
// 中间态只有一层不含 keyword 的 meta。丢掉后者，前者原样保留。
// 只碰「# + 字母/空白」这一种 meta 形态：yaml 的 --- 等其它 meta 用法不受影响。
export function dropPartialPreprocessor(text, toks) {
  const keywords = toks.filter(([, , c]) => c === 'hljs-keyword')
  return toks.filter(([s, e, c]) => {
    if (c !== 'hljs-meta') return true
    if (!/^#\s*[a-z]*$/i.test(text.slice(s, e))) return true
    // 区间里套着 keyword（完整指令名）才留
    return keywords.some(([ks, ke]) => s <= ks && ke <= e)
  })
}

export function buildDecorations(doc) {
  const decos = []
  doc.descendants((node, pos) => {
    if (node.type.name !== 'code_block') return
    const params = (node.attrs.params || '').trim()
    const lang = params.split(/\s+/)[0].toLowerCase()
    const text = node.textContent
    if (!lang || !text || !hljs.getLanguage(lang)) return
    let result
    try {
      result = hljs.highlight(text, { language: lang, ignoreIllegals: true }).value
    } catch {
      return
    }
    const base = pos + 1 // code_block 内容起点（跳过 node 打开位）
    for (const [s, e, cls] of dropPartialPreprocessor(text, mapTokens(result))) {
      if (e > s) {
        decos.push(Decoration.inline(base + s, base + e, { class: cls }))
      }
    }
  })
  return DecorationSet.create(doc, decos)
}

export function highlightPlugin() {
  return new Plugin({
    key: hlKey,
    state: {
      init(_, { doc }) {
        return buildDecorations(doc)
      },
      apply(tr, old) {
        // 未改文档且未强制刷新：按 mapping 平移旧装饰即可
        if (!tr.docChanged && !tr.getMeta(hlKey)) return old.map(tr.mapping, tr.doc)
        return buildDecorations(tr.doc)
      },
    },
    props: {
      decorations(state) {
        return hlKey.getState(state)
      },
    },
  })
}
