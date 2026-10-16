// editor-schema.js —— ProseMirror 文档模型 + Markdown 双向无损转换（纯逻辑，不依赖 DOM）
//
// 设计要点：
//  · 基于 prosemirror-markdown 的默认 schema，扩展 GFM 能力：删除线、任务列表、表格，
//    以及 NoteLume 自定义的 [[wikilink]] 与 #tag 行内节点。
//  · 转换完全走标准 GFM 语法，不引入任何私有格式，保证与 Typora/Obsidian 文件兼容。
//  · wikilink / tag 通过 markdown-it 自定义 inline 规则解析，序列化时原样写回。
//  · 任务列表用 markdown-it 原生产出的 `[ ]` / `[x]` 文本，在解析后做一次模型转换落到
//    list_item.checked 属性上，序列化时再写回，保证无损。

import { Schema, Fragment, DOMParser } from 'prosemirror-model'
import { Transform } from 'prosemirror-transform'
import {
  schema as baseSchema,
  MarkdownParser,
  MarkdownSerializer,
  defaultMarkdownParser,
  defaultMarkdownSerializer,
} from 'prosemirror-markdown'
import MarkdownIt from 'markdown-it'
import footnote from 'markdown-it-footnote'
import { tableNodes } from 'prosemirror-tables'

// —— 1. 扩展 schema ————————————————————————————————————————————————
// 复用默认 schema 的 OrderedMap，追加/覆写节点与标记，避免重写 DOM 规格。

// prosemirror-tables 的表格节点 spec：cell 只允许行内内容（对齐 GFM），
// alignment 通过 cellAttributes 读写（getFromDOM 读 style.textAlign，setDOMAttr 写回）。
// GFM 不支持合并单元格，故表格编辑只暴露 1×1 网格可无损往返的操作（不接 merge/split）。
const nlTableNodes = tableNodes({
  tableGroup: 'block',
  cellContent: 'inline*',
  cellAttributes: {
    alignment: {
      default: null,
      getFromDOM(dom) {
        return (dom && dom.style && dom.style.textAlign) || null
      },
      setDOMAttr(value, attrs) {
        if (value) attrs.style = (attrs.style ? attrs.style + ';' : '') + 'text-align:' + value
      },
    },
  },
})

// 尺寸字符串 → 正整数像素：'328' / '328px' 接受，其余（百分号、auto、小数）一律当未设尺寸
function pxNum(v) {
  if (v == null) return null
  const m = /^(\d+)(?:px)?$/.exec(String(v).trim())
  return m ? Number(m[1]) : null
}

// 目的地里的 `\(` `\)` 还原成真实括号：默认规则（parseLinkDestination）已解这一层转义，
// 自定义尺寸规则要与之对齐，否则同一张图带不带尺寸会解析出两个不同的 src
function unescDest(s) {
  return s.replace(/\\([()])/g, '$1')
}

const extendedNodes = baseSchema.spec.nodes
  // 任务列表：list_item 增加 checked 属性（null=普通项，true/false=任务项）
  .update('list_item', {
    content: 'block+',
    defining: true,
    attrs: { checked: { default: null } },
    parseDOM: [
      {
        // 本应用自身 DOM（toDOM 产出 li[data-checked]）优先匹配，保证复制粘贴往返不丢状态
        tag: 'li[data-checked]',
        getAttrs(dom) {
          return { checked: dom.getAttribute('data-checked') === 'true' }
        },
      },
      {
        // 兼容外部 HTML（Typora/Obsidian 等用真实 <input type=checkbox>）
        tag: 'li',
        getAttrs(dom) {
          const cb = dom.querySelector(':scope > input[type=checkbox]')
          return { checked: cb ? cb.checked : null }
        },
      },
    ],
    toDOM(node) {
      // content hole(0) 必须是父元素唯一子节点，否则 ProseMirror 报
      // “Content hole must be the only child”。勾选框交给 CSS ::before/::after 画。
      if (node.attrs.checked != null) {
        return ['li', { class: 'nl-task', 'data-checked': String(node.attrs.checked) }, 0]
      }
      return ['li', 0]
    },
  })
  // 表格：采用 prosemirror-tables 生成的 spec（带 colspan/rowspan/colwidth + TableMap），
  // 使增删行列 / Tab 跨格 / 列宽拖拽可用；节点名仍为 table/table_row/table_header/table_cell，
  // 故 Markdown 解析 tokens 与 serializeTable 无需改动。
  .addToEnd('table', nlTableNodes.table)
  .addToEnd('table_row', nlTableNodes.table_row)
  .addToEnd('table_header', nlTableNodes.table_header)
  .addToEnd('table_cell', nlTableNodes.table_cell)
  // [[wikilink]] —— 行内叶节点
  .addToEnd('wikiLink', {
    inline: true,
    group: 'inline',
    attrs: { target: {}, label: { default: null } },
    toDOM(node) {
      const label = node.attrs.label || node.attrs.target
      return [
        'span',
        {
          class: 'nl-wiki',
          'data-target': node.attrs.target,
          contenteditable: 'false',
          title: '跳转到文档：' + node.attrs.target,
        },
        label,
      ]
    },
    parseDOM: [
      {
        tag: 'span.nl-wiki',
        getAttrs(dom) {
          return { target: dom.getAttribute('data-target'), label: dom.textContent || null }
        },
      },
    ],
  })
  // #tag —— 行内叶节点
  .addToEnd('tag', {
    inline: true,
    group: 'inline',
    attrs: { tag: {} },
    toDOM(node) {
      return [
        'span',
        { class: 'nl-tag', 'data-tag': node.attrs.tag, contenteditable: 'false', title: '标签：' + node.attrs.tag },
        '#' + node.attrs.tag,
      ]
    },
    parseDOM: [
      {
        tag: 'span.nl-tag',
        getAttrs(dom) {
          return { tag: dom.getAttribute('data-tag') }
        },
      },
    ],
  })
  // 交叉引用锚点（批次 F 后续）：`<a id="…"></a>`。被交叉引用命中的非标题目标（图/表/公式/参考文献）
  // 在导入时于其正文里发一个字面 <a id>，作为 `[文本](#id)` 的跳转落点；编辑器需一个原子行内节点承载它
  // （否则 html:false 会把它当转义文本显示）。零宽、无内容，仅作定位标记，由 buildAnchorMap 按 id 收集。
  .addToEnd('anchor', {
    inline: true,
    group: 'inline',
    atom: true,
    attrs: { id: { default: '' } },
    toDOM(node) {
      return ['a', { id: node.attrs.id, class: 'nl-anchor', contenteditable: 'false' }]
    },
    parseDOM: [
      { tag: 'a.nl-anchor[id]', getAttrs: (dom) => ({ id: dom.getAttribute('id') || '' }) },
    ],
  })
  // $...$ 行内数学（KaTeX）：schema 层无 DOM 依赖，浏览器里由 nodeView 重新渲染
  .addToEnd('math_inline', {
    inline: true,
    group: 'inline',
    atom: true,
    attrs: { latex: { default: '' } },
    toDOM(node) {
      return [
        'span',
        {
          class: 'nl-math nl-math-inline',
          'data-latex': node.attrs.latex,
          contenteditable: 'false',
          title: '公式：' + node.attrs.latex,
        },
        '$' + node.attrs.latex + '$',
      ]
    },
    parseDOM: [
      {
        tag: 'span.nl-math-inline',
        getAttrs(dom) {
          return { latex: dom.getAttribute('data-latex') || '' }
        },
      },
    ],
  })
  // $$..$$ 块级数学（多行）
  .addToEnd('math_block', {
    block: true,
    group: 'block',
    atom: true,
    attrs: { latex: { default: '' } },
    toDOM(node) {
      return [
        'div',
        {
          class: 'nl-math nl-math-block',
          'data-latex': node.attrs.latex,
          contenteditable: 'false',
        },
        '$$\n' + node.attrs.latex + '\n$$',
      ]
    },
    parseDOM: [
      {
        tag: 'div.nl-math-block',
        getAttrs(dom) {
          return { latex: dom.getAttribute('data-latex') || '' }
        },
      },
    ],
  })
  // 代码块：右上角可点击语言标签（Typora 式）。
  // 语言只存于 attrs.params（即围栏 info string ```lang），绝不进入正文；
  // 标签渲染为空 span（文本由 CSS ::after 从 data-lang 取），故 parseDOM 读 pre 不会把它当代码内容。
  .update('code_block', {
    content: 'text*',
    marks: 'code',
    group: 'block',
    code: true,
    defining: true,
    attrs: { params: { default: '' } },
    parseDOM: [{ tag: 'pre', preserveWhitespace: 'full' }],
    toDOM(node) {
      const lang = (node.attrs.params || '').trim().split(/\s+/)[0]
      const label = ['span', { class: 'nl-code-lang', 'data-lang': lang, 'data-empty': lang ? '0' : '1', contenteditable: 'false' }]
      return ['pre', lang ? { 'data-language': lang } : {}, label, ['code', 0]]
    },
  })
  // Obsidian callout：`> [!TYPE] Title` 渲染为带标题的彩色卡片。
  // 内层块（正文）可继续编辑，type/fold/title 存于 attrs，序列化时原样写回 marker 行。
  .addToEnd('callout', {
    content: 'block*',
    group: 'block',
    defining: true,
    attrs: {
      type: { default: 'note' },
      fold: { default: '' },
      title: { default: null },
    },
    parseDOM: [
      {
        tag: 'div.nl-callout',
        contentElement: (dom) => dom.querySelector('.nl-callout-body') || dom,
        getAttrs(dom) {
          const titleEl = dom.querySelector('.nl-callout-title')
          return {
            type: dom.getAttribute('data-type') || 'note',
            fold: dom.getAttribute('data-fold') || '',
            title: (titleEl && titleEl.getAttribute('data-title')) || null,
          }
        },
      },
    ],
    toDOM(node) {
      const type = node.attrs.type || 'note'
      const fold = node.attrs.fold || ''
      const title = node.attrs.title || ''
      const cls =
        'nl-callout nl-callout-' +
        String(type).toLowerCase() +
        (fold === '-' ? ' nl-callout-closed' : fold === '+' ? ' nl-callout-open' : '')
      return [
        'div',
        { class: cls, 'data-type': type, 'data-fold': fold },
        ['div', { class: 'nl-callout-title', 'data-title': title }, title || type],
        ['div', { class: 'nl-callout-body' }, 0],
      ]
    },
  })
  // 图片：在默认 image 基础上增加 embed 标记，无损承载 Obsidian 的 ![[图片.png]] 嵌入语法；
  // width 承载 Typora/Obsidian 的拖拽尺寸（![a](a.png =328x) / ![[a.png|328]]），高度随比例自适应
  .update('image', {
    inline: true,
    group: 'inline',
    draggable: true,
    attrs: {
      src: {},
      alt: { default: null },
      title: { default: null },
      embed: { default: false },
      width: { default: null },
    },
    parseDOM: [
      {
        tag: 'img[src]',
        getAttrs(dom) {
          return {
            src: dom.getAttribute('src'),
            title: dom.getAttribute('title'),
            alt: dom.getAttribute('alt'),
            embed: dom.getAttribute('data-embed') === '1',
            width: pxNum(dom.style && dom.style.width),
          }
        },
      },
    ],
    toDOM(node) {
      const { src, alt, title, embed, width } = node.attrs
      const attrs = { src, alt: alt || null, title: title || null }
      if (embed) attrs['data-embed'] = '1'
      if (width) attrs.style = 'width:' + width + 'px'
      return ['img', attrs]
    },
  })
  // —— 功能项 J：脚注（Typora 式：正文上标角标 + 文末脚注区）——
  // footnote_ref：正文内的行内原子引用节点（存稳定 id；显示序号由 nodeView 按文档序现算）
  .addToEnd('footnote_ref', {
    inline: true,
    group: 'inline',
    atom: true,
    attrs: { id: { default: '' } },
    toDOM(node) {
      return ['sup', { class: 'nl-footnote-ref', 'data-id': node.attrs.id, contenteditable: 'false' }, '[' + node.attrs.id + ']']
    },
    parseDOM: [
      {
        tag: 'sup.nl-footnote-ref',
        getAttrs(dom) {
          return { id: dom.getAttribute('data-id') || '' }
        },
      },
    ],
  })
  // footnote_section：文末脚注容器（全文至多一个、置末尾；标题由 CSS ::before 画，content hole 须唯一子节点）
  .addToEnd('footnote_section', {
    content: 'footnote_item+',
    group: 'block',
    defining: true,
    toDOM() {
      return ['div', { class: 'nl-footnote-section' }, 0]
    },
    parseDOM: [{ tag: 'div.nl-footnote-section' }],
  })
  // footnote_item：单条脚注正文（按 inline* 承载于一个段落；存与 ref 对应的稳定 id）
  .addToEnd('footnote_item', {
    content: 'paragraph',
    defining: true,
    attrs: { id: { default: '' } },
    toDOM(node) {
      return ['div', { class: 'nl-footnote-item', 'data-id': node.attrs.id }, 0]
    },
    parseDOM: [
      {
        tag: 'div.nl-footnote-item',
        getAttrs(dom) {
          return { id: dom.getAttribute('data-id') || '' }
        },
      },
    ],
  })

const extendedMarks = baseSchema.spec.marks.addToEnd('strike', {
  parseDOM: [{ tag: 's' }, { tag: 'del' }, { tag: 'strike' }, { style: 'strike-through' }],
  toDOM() {
    return ['s']
  },
})

export const schema = new Schema({ nodes: extendedNodes, marks: extendedMarks })

// —— 2. tokenizer（markdown-it）———————————————————————————————————
// commonmark 基底 + 开启 table / strikethrough，再叠加 wikilink / tag / math / callout 自定义规则。
// 导出该实例供整站导出复用：编辑器只用它 tokenize→ProseMirror（mdParser.parse），从不调 .render()，
// 故导出侧在其上挂 HTML 渲染规则不会影响编辑器解析（见 site-export.js）。
export const tokenizer = MarkdownIt('commonmark', { html: false }).enable(['table', 'strikethrough'])
// 功能项 J：并入脚注（[^n] 引用 + 文末定义）；无脚注时对本管线惰性，不改既有 commonmark 行为
tokenizer.use(footnote)

// Typora 的拖拽尺寸语法 `![alt](src =328x)`：宽度夹在目的地与右括号之间。markdown-it 的 image
// 规则只接受「目的地 + 引号 title」，遇到 `=328x` 会把整段判成纯文本，故在 image 规则之前截获；
// 只认带尺寸的写法，其余一律 return false 交回默认规则（不重复实现链接解析）。
// 范围边界：`=328x200`（宽高都写死）与 `=50%` 不接，仍按原样留给默认规则处理。
const IMG_SIZE_TAIL = /\s*=(\d+)x\s*$/
tokenizer.inline.ruler.before('image', 'image_size', (state, silent) => {
  const src = state.src
  const pos = state.pos
  if (src.charCodeAt(pos) !== 0x21 /* ! */ || src.charCodeAt(pos + 1) !== 0x5b /* [ */) return false
  let label = pos + 2
  while (label < src.length) {
    const c = src[label]
    if (c === '\\') {
      label += 2
      continue
    }
    if (c === '[') return false // 嵌套方括号（含 ![[..]] 嵌入）：交回默认规则
    if (c === ']') break
    label++
  }
  if (label >= src.length || src.charCodeAt(label + 1) !== 0x28 /* ( */) return false
  let end = label + 2
  let depth = 1
  while (end < src.length) {
    const c = src[end]
    if (c === '\\') {
      end += 2
      continue
    }
    if (c === '(') depth++
    else if (c === ')' && --depth === 0) break
    end++
  }
  if (end >= src.length) return false
  const inner = src.slice(label + 2, end)
  const m = IMG_SIZE_TAIL.exec(inner)
  if (!m) return false
  const rest = inner.slice(0, inner.length - m[0].length).trim()
  if (rest.startsWith('<')) return false // 尖括号目的地（内可含空格）不接：按空格切会改写路径，形态交回默认规则
  const sp = rest.search(/\s/)
  const dest = unescDest(sp < 0 ? rest : rest.slice(0, sp))
  const href = state.md.normalizeLink(dest)
  if (!state.md.validateLink(href)) return false // 非法目的地：交回默认规则，与 image 规则同进退
  if (!silent) {
    const alt = src.slice(pos + 2, label).replace(/\\([\\[\]()])/g, '$1')
    const token = state.push('image', 'img', 0)
    token.content = alt
    token.attrSet('src', href) // 与默认规则同一套目的地处理：先解 `\(` 转义，再 normalizeLink
    token.attrSet('width', m[1])
    const title = sp < 0 ? '' : rest.slice(sp + 1).trim()
    if (title) token.attrSet('title', title.replace(/^["']|["']$/g, ''))
  }
  state.pos = end + 1
  return true
})

// [[Target]] 或 [[Target|显示文字]]；![[图片]] 为 Obsidian 图片嵌入（仅当扩展名是图片时）
const WIKI_IMG_RE = /\.(png|jpe?g|gif|svg|webp|bmp|ico|avif)$/i
tokenizer.inline.ruler.push('wikilink', (state, silent) => {
  const src = state.src
  const pos = state.pos
  // 嵌入形态 ![[...]]：仅当目标看起来是图片文件时才当图片处理，否则退回普通链接（![[笔记]]）
  const isEmbed =
    src.charCodeAt(pos) === 0x21 /* ! */ &&
    src.charCodeAt(pos + 1) === 0x5b /* [ */ &&
    src.charCodeAt(pos + 2) === 0x5b /* [ */
  const isLink = src.charCodeAt(pos) === 0x5b /* [ */ && src.charCodeAt(pos + 1) === 0x5b
  if (!isEmbed && !isLink) return false
  const open = pos + (isEmbed ? 3 : 2)
  const end = src.indexOf(']]', open)
  if (end < 0) return false
  const inner = src.slice(open, end)
  if (!inner || inner.includes('[') || inner.includes('\n')) return false
  const bar = inner.indexOf('|')
  const target = (bar < 0 ? inner : inner.slice(0, bar)).trim()
  const alias = bar < 0 ? null : inner.slice(bar + 1)
  if (isEmbed && !WIKI_IMG_RE.test(target)) return false // 非图片的 ![[..]]：让 ! 落为文本、[[..]] 走链接
  if (!silent) {
    if (isEmbed) {
      const token = state.push('wiki_img', 'img', 0)
      token.attrSet('src', target)
      // Obsidian 的 ![[图.png|328]]：竖线段是纯数字时是宽度，不是别名
      const w = pxNum(alias)
      if (w) token.attrSet('width', String(w))
      token.attrSet('alt', w ? target : alias || target)
    } else {
      const token = state.push('wiki_link', 'span', 0)
      token.attrSet('target', target)
      token.attrSet('label', alias)
    }
  }
  state.pos = end + 2
  return true
})

// #tag（词首的 # 不会进到这里：标题在 block 阶段已被消费；行内 # 视为标签）
const TAG_RE = /[A-Za-z0-9_\-/]/
tokenizer.inline.ruler.push('tag', (state, silent) => {
  const src = state.src
  const pos = state.pos
  if (src.charCodeAt(pos) !== 0x23 /* # */) return false
  const next = src[pos + 1]
  if (!next || !TAG_RE.test(next)) return false
  let n = 1
  while (pos + n < src.length && TAG_RE.test(src[pos + n])) n++
  const tag = src.slice(pos + 1, pos + n)
  if (!silent) {
    const token = state.push('tag', 'span', 0)
    token.attrSet('tag', tag)
  }
  state.pos = pos + n
  return true
})

// <a id="…"></a> 交叉引用锚点（html:false 下默认会当转义文本，故自定义行内规则截获）：只认
// 导入侧序列化的空锚形态 `<a id="X"></a>`（X 为净化后的书签名，不含引号）；其余 <a> 交回默认规则。
const ANCHOR_RE = /^<a id="([^"]*)"><\/a>/
tokenizer.inline.ruler.push('anchor', (state, silent) => {
  const src = state.src
  const pos = state.pos
  if (src.charCodeAt(pos) !== 0x3c /* < */) return false
  const m = ANCHOR_RE.exec(src.slice(pos))
  if (!m) return false
  if (!silent) {
    const token = state.push('anchor', 'a', 0)
    token.attrSet('id', m[1])
  }
  state.pos = pos + m[0].length
  return true
})

// $...$ 行内数学（KaTeX）。规则：
//  • 开头 `$` 后一个字符不能是空白，结尾 `$` 前一个字符不能是空白
//  • 不跳行；内容里不能包含未转义的 `$`
//  • 跟 $$..$$ 块不交叉（块在 block.ruler 中优先处理）
tokenizer.inline.ruler.before('escape', 'math_inline', (state, silent) => {
  const src = state.src
  const pos = state.pos
  if (src.charCodeAt(pos) !== 0x24 /* $ */) return false
  // 避免跟 $$ 块列首冲突（块已在上层处理，这里不会看到开场的 $$ 配对行）
  if (src.charCodeAt(pos + 1) === 0x24) return false
  const nextCh = src[pos + 1]
  if (!nextCh || /\s/.test(nextCh)) return false
  let end = pos + 1
  while (end < src.length && src.charCodeAt(end) !== 0x24) {
    if (src[end] === '\\') {
      end += 2
      continue
    }
    if (src[end] === '\n') return false
    end++
  }
  if (end >= src.length) return false
  if (/\s/.test(src[end - 1])) return false
  const latex = src.slice(pos + 1, end)
  if (!latex) return false
  if (!silent) {
    const token = state.push('math_inline', '', 0)
    token.latex = latex
  }
  state.pos = end + 1
  return true
})

// $$..$$ 块级数学：开始行仅 `$$`、结束行仅 `$$`，中间多行为 LaTeX
// 这种约定与 Obsidian/Typora 默认写法一致，保证文件互通
tokenizer.block.ruler.before('fence', 'math_block', (state, startLine, endLine, silent) => {
  const start = state.bMarks[startLine] + state.tShift[startLine]
  const max = state.eMarks[startLine]
  const first = state.src.slice(start, max).trim()
  if (first !== '$$') return false
  let nextLine = startLine + 1
  const limit = endLine == null ? state.lineMax : Math.min(endLine, state.lineMax)
  let closed = false
  while (nextLine < limit) {
    const s = state.bMarks[nextLine] + state.tShift[nextLine]
    const m = state.eMarks[nextLine]
    if (state.src.slice(s, m).trim() === '$$') {
      closed = true
      break
    }
    nextLine++
  }
  if (!closed) return false
  if (silent) return true
  const contentStart = state.bMarks[startLine + 1] + state.tShift[startLine + 1]
  const contentEnd = state.bMarks[nextLine] // 不含尾行行首，下面 slice 会自动不包含换行
  const latex = state.src.slice(contentStart, contentEnd).replace(/\s+$/, '')
  state.line = nextLine + 1
  const token = state.push('math_block', '', 0)
  token.block = true
  token.map = [startLine, state.line]
  token.latex = latex
  return true
})

// Obsidian callout 识别：不改写 markdown-it 的 blockquote 机制，而是在 block 分析完成后
// （此时 inline token 仅带 .content、children 尚未解析）、inline 分析之前，
// 把以 `> [!TYPE]` 起始的 blockquote token 改写为 callout_open/close，并把首行拆成
// marker(type/fold/title) + 剩余正文。后续 inline 规则会按新 .content 重新解析子节点。
tokenizer.core.ruler.after('block', 'nl_callout', (state) => {
  const toks = state.tokens
  const markerRe = /^\[!([^\]\s]+)\]([+-])?[ \t]*(.*)$/
  for (let i = 0; i < toks.length; i++) {
    if (toks[i].type !== 'blockquote_open') continue
    const po = i + 1
    const paraOpen = toks[po]
    const inlineT = toks[po + 1]
    if (!paraOpen || paraOpen.type !== 'paragraph_open' || !inlineT || inlineT.type !== 'inline') continue
    const content = inlineT.content || ''
    const nl = content.indexOf('\n')
    const line0 = nl < 0 ? content : content.slice(0, nl)
    const m = markerRe.exec(line0.trim())
    if (!m) continue
    const rest = nl < 0 ? '' : content.slice(nl + 1)
    toks[i].type = 'callout_open'
    toks[i].calloutType = m[1]
    toks[i].calloutFold = m[2] || ''
    toks[i].calloutTitle = (m[3] || '').trim()
    if (rest === '') {
      // 标题行（或纯 marker）：移除这个段落，余下兄弟块自然成为正文
      toks.splice(po, 3)
    } else {
      inlineT.content = rest
    }
    i = po - 1 // 从 open 之后重新扫描，以支持嵌套 callout
  }
  // 按嵌套配对把对应的 blockquote_close 改为 callout_close
  const stack = []
  for (let k = 0; k < toks.length; k++) {
    const t = toks[k]
    if (t.type === 'blockquote_open' || t.type === 'callout_open') stack.push(t.type === 'callout_open' ? 'c' : 'b')
    else if (t.type === 'blockquote_close') {
      if (stack.pop() === 'c') t.type = 'callout_close'
    }
  }
})

// —— 3. parser（Markdown -> ProseMirror）————————————————————————————
// 在默认 token 规格上叠加表格 / 删除线 / wiki_link / tag。
const parserTokens = {
  ...defaultMarkdownParser.tokens,
  s: { mark: 'strike' },
  table: { block: 'table' },
  thead: { ignore: true },
  tbody: { ignore: true },
  tr: { block: 'table_row' },
  th: { block: 'table_header', getAttrs: (tok) => ({ alignment: alignFromStyle(tok.attrGet('style')) }) },
  td: { block: 'table_cell', getAttrs: (tok) => ({ alignment: alignFromStyle(tok.attrGet('style')) }) },
  wiki_link: {
    node: 'wikiLink',
    getAttrs: (tok) => ({ target: tok.attrGet('target'), label: tok.attrGet('label') }),
  },
  // 默认 image 处理只读 markdown-it 生成的 children；自定义尺寸规则产出的 token 没有 children，
  // 故在此统一取 alt，并把 width 落到节点属性上
  image: {
    node: 'image',
    getAttrs: (tok) => ({
      src: tok.attrGet('src'),
      title: tok.attrGet('title') || null,
      alt: (tok.children && tok.children[0] && tok.children[0].content) || tok.content || null,
      width: pxNum(tok.attrGet('width')),
    }),
  },
  wiki_img: {
    node: 'image',
    getAttrs: (tok) => ({
      src: tok.attrGet('src'),
      alt: tok.attrGet('alt'),
      title: null,
      embed: true,
      width: pxNum(tok.attrGet('width')),
    }),
  },
  tag: { node: 'tag', getAttrs: (tok) => ({ tag: tok.attrGet('tag') }) },
  anchor: { node: 'anchor', getAttrs: (tok) => ({ id: tok.attrGet('id') || '' }) },
  math_inline: { node: 'math_inline', getAttrs: (tok) => ({ latex: tok.latex || '' }) },
  math_block: { node: 'math_block', getAttrs: (tok) => ({ latex: tok.latex || '' }) },
  callout: {
    block: 'callout',
    getAttrs: (tok) => ({
      type: tok.calloutType || 'note',
      fold: tok.calloutFold || '',
      title: tok.calloutTitle || null,
    }),
  },
  // —— 功能项 J：脚注 token 映射（markdown-it-footnote）——
  footnote_ref: {
    node: 'footnote_ref',
    getAttrs: (tok) => ({ id: String((tok.meta && (tok.meta.label != null ? tok.meta.label : tok.meta.id)) || '') }),
  },
  footnote_block: { block: 'footnote_section' },
  footnote: {
    block: 'footnote_item',
    getAttrs: (tok) => ({ id: String((tok.meta && (tok.meta.label != null ? tok.meta.label : tok.meta.id)) || '') }),
  },
  footnote_anchor: { ignore: true, noCloseToken: true },
}

function alignFromStyle(style) {
  if (!style) return null
  const m = /text-align:\s*(left|center|right)/.exec(style)
  return m ? m[1] : null
}

export const mdParser = new MarkdownParser(schema, tokenizer, parserTokens)

// 解析后把 `[ ]` / `[x]` 文本转成 list_item.checked，保证任务列表落到模型上。
function convertTasks(node) {
  let mutated = false
  const children = []
  node.forEach((child) => {
    const c = convertTasks(child)
    children.push(c)
    if (c !== child) mutated = true
  })
  let rebuilt = mutated ? node.copy(Fragment.from(children)) : node
  if (rebuilt.type.name === 'list_item') {
    const asTask = tryAsTask(rebuilt)
    if (asTask) return asTask
  }
  return rebuilt
}

function tryAsTask(item) {
  const para = item.firstChild
  if (!para || para.type.name !== 'paragraph') return null
  const first = para.firstChild
  if (!first || !first.isText) return null
  const m = /^\[([ xX])\]\s?([\s\S]*)$/.exec(first.text)
  if (!m) return null
  const checked = m[1] !== ' '
  const rest = m[2]
  const paraKids = []
  if (rest.length) paraKids.push(schema.text(rest, first.marks))
  for (let i = 1; i < para.childCount; i++) paraKids.push(para.child(i))
  const newPara = para.copy(Fragment.from(paraKids))
  const itemKids = [newPara]
  for (let i = 1; i < item.childCount; i++) itemKids.push(item.child(i))
  return item.type.create({ checked }, Fragment.from(itemKids))
}

// —— 功能项 J：合并表格的两阶段解析（最脆一环，见 spec §8）——
// 主 tokenizer 是 html:false，裸 <table> 会被当转义文本。故在 markdown 解析前：
//  ① 预处理器把「独占一行、顶层」的 <table>…</table>（跳过围栏代码块）换成占位段落行；
//  ② 照常走 mdParser 得到含占位段落的 doc；
//  ③ 用 DOMParser.parseSlice 把原始 HTML 还原为 table 节点，原位替换占位段落。
// 我们自身序列化的合并表是单行 HTML，故按「整行即一张表」识别；外部多行 HTML 表不在保真范围。
const TABLE_LINE_RE = /^<table\b[\s\S]*<\/table>$/i
const PLACEHOLDER_RE = /^\{\{nl-table-(\d+)\}\}$/

function extractTableHTML(md) {
  const lines = md.split('\n')
  const tables = []
  const out = []
  let inFence = false
  let fenceChar = ''
  for (const line of lines) {
    const t = line.trim()
    const fm = /^(`{3,}|~{3,})/.exec(t)
    if (fm) {
      const ch = fm[1][0]
      if (!inFence) {
        inFence = true
        fenceChar = ch
      } else if (ch === fenceChar) {
        inFence = false
        fenceChar = ''
      }
      out.push(line)
      continue
    }
    if (!inFence && TABLE_LINE_RE.test(t)) {
      const idx = tables.length
      tables.push(t)
      // 用空行夹住占位，确保它独占成一个段落
      out.push('', '{{nl-table-' + idx + '}}', '')
    } else {
      out.push(line)
    }
  }
  return { text: out.join('\n'), tables }
}

function parseTableSlice(html) {
  const box = document.createElement('div')
  box.innerHTML = html
  return DOMParser.fromSchema(schema).parseSlice(box).content
}

function restoreTables(doc, tables) {
  const hits = []
  doc.descendants((node, pos) => {
    if (node.type.name === 'paragraph') {
      const m = PLACEHOLDER_RE.exec(node.textContent.trim())
      if (m && tables[Number(m[1])] != null) hits.push({ pos, size: node.nodeSize, idx: Number(m[1]) })
    }
  })
  if (!hits.length) return doc
  const tr = new Transform(doc)
  // 由后往前替换，低位位置不受高位替换影响
  for (const h of hits.sort((a, b) => b.pos - a.pos)) {
    tr.replaceWith(h.pos, h.pos + h.size, parseTableSlice(tables[h.idx]))
  }
  return tr.doc
}

/** Markdown 字符串 -> ProseMirror doc */
export function parseMarkdown(mdText) {
  const { text, tables } = extractTableHTML(mdText || '')
  const doc = mdParser.parse(text)
  const filled = convertTasks(doc) || schema.topNodeType.createAndFill()
  return tables.length ? restoreTables(filled, tables) : filled
}

// —— 4. serializer（ProseMirror -> Markdown）——————————————————————————
// 单元格内联内容借助同一序列化器递归输出（把 cell 内容临时包成段落再序列化）。
function cellToMarkdown(cell) {
  const kids = []
  cell.forEach((k) => kids.push(k))
  const tempDoc = schema.node('doc', null, [schema.node('paragraph', null, kids)])
  let s = SERIALIZER.serialize(tempDoc).replace(/\n+$/, '')
  // 表格单元格里的竖线必须转义，否则会破坏列结构
  s = s.replace(/\|/g, '\\|')
  return s
}

function alignColMarker(align) {
  if (align === 'center') return ':---:'
  if (align === 'left') return ':---'
  if (align === 'right') return '---:'
  return '---'
}

// —— 功能项 J：合并表的 HTML 序列化（与两阶段解析对倒）——
// prosemirror-tables 把合并单元格表达为“被盖 cell 直接删除 + 跨格 cell 带 colspan/rowspan”，
// 因此逐行遍历现有 cell 直接输出正好符合 HTML 表格语义（无需补占位）。
function escapeText(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
function escapeAttr(s) {
  return escapeText(s).replace(/"/g, '&quot;')
}
function wrapMarkHTML(m, inner) {
  switch (m.type.name) {
    case 'strong': return '<strong>' + inner + '</strong>'
    case 'em': return '<em>' + inner + '</em>'
    case 'code': return '<code>' + inner + '</code>'
    case 'strike': return '<s>' + inner + '</s>'
    case 'link': {
      const href = escapeAttr(m.attrs.href || '')
      const title = m.attrs.title ? ' title="' + escapeAttr(m.attrs.title) + '"' : ''
      return '<a href="' + href + '"' + title + '>' + inner + '</a>'
    }
    default: return inner
  }
}
function inlineNodeToHTML(node) {
  let html
  if (node.isText) html = escapeText(node.text)
  else if (node.type.name === 'hard_break') html = '<br>'
  else if (node.type.name === 'image')
    html =
      '<img src="' + escapeAttr(node.attrs.src) + '"' +
      (node.attrs.alt ? ' alt="' + escapeAttr(node.attrs.alt) + '"' : '') + '>'
  else html = escapeText(node.textContent || '') // 其他行内原子：退化为纯文本
  const marks = node.marks.slice().sort((a, b) => a.type.name.localeCompare(b.type.name))
  for (let i = marks.length - 1; i >= 0; i--) html = wrapMarkHTML(marks[i], html)
  return html
}
function cellInlineToHTML(cell) {
  let out = ''
  cell.forEach((k) => {
    out += inlineNodeToHTML(k)
  })
  return out
}
function tableHasMerge(node) {
  let m = false
  node.descendants((n) => {
    if ((n.type.name === 'table_cell' || n.type.name === 'table_header') && (n.attrs.colspan > 1 || n.attrs.rowspan > 1)) m = true
  })
  return m
}
function serializeTableHTML(node) {
  const parts = ['<table>']
  node.forEach((row) => {
    parts.push('<tr>')
    row.forEach((cell) => {
      const tag = cell.type.name === 'table_header' ? 'th' : 'td'
      let attrs = ''
      if (cell.attrs.colspan > 1) attrs += ' colspan="' + cell.attrs.colspan + '"'
      if (cell.attrs.rowspan > 1) attrs += ' rowspan="' + cell.attrs.rowspan + '"'
      if (cell.attrs.alignment) attrs += ' style="text-align:' + cell.attrs.alignment + '"'
      parts.push('<' + tag + attrs + '>' + cellInlineToHTML(cell) + '</' + tag + '>')
    })
    parts.push('</tr>')
  })
  parts.push('</table>')
  return parts.join('') // 单行，供预处理器按行识别
}

function serializeTable(state, node) {
  // 含合并单元格 → 输出真 <table> HTML（GitHub/Obsidian 原生渲染、保互操作）
  if (tableHasMerge(node)) {
    state.ensureNewLine()
    state.write(serializeTableHTML(node))
    state.closeBlock(node)
    return
  }
  const rows = []
  node.forEach((row) => {
    const cells = []
    let hasHeader = false
    row.forEach((c) => {
      if (c.type.name === 'table_header') hasHeader = true
      cells.push({ md: cellToMarkdown(c), header: c.type.name === 'table_header', align: c.attrs.alignment })
    })
    rows.push({ cells, hasHeader })
  })
  if (!rows.length) {
    state.closeBlock(node)
    return
  }
  const ncols = Math.max(...rows.map((r) => r.cells.length))
  // 规范化每行列数
  rows.forEach((r) => {
    while (r.cells.length < ncols) r.cells.push({ md: '', header: false, align: null })
  })
  const aligns = []
  for (let i = 0; i < ncols; i++) aligns[i] = rows[0].cells[i].align

  const widths = new Array(ncols).fill(3) // 分隔行最少 3 个 '-'
  for (let i = 0; i < ncols; i++) {
    for (const r of rows) widths[i] = Math.max(widths[i], r.cells[i].md.length)
  }

  const lineOf = (cells) => {
    const body = cells
      .map((c, i) => ' ' + c.md.padEnd(widths[i], ' ') + ' ')
      .join('|')
    return '|' + body + '|'
  }

  state.ensureNewLine()
  // 表头（第一行）
  state.write(lineOf(rows[0].cells))
  state.write('\n')
  // 分隔行
  const sep = aligns.map((a, i) => ' ' + alignColMarker(a).padEnd(widths[i], '-') + ' ').join('|')
  state.write('|' + sep + '|')
  // 数据行
  for (let r = 1; r < rows.length; r++) {
    state.write('\n')
    state.write(lineOf(rows[r].cells))
  }
  state.closeBlock(node)
}

const serializerNodes = {
  ...defaultMarkdownSerializer.nodes,
  // Obsidian callout：首行写 marker 行（含 title/fold），后续行统一 `> ` 前缀，与 blockquote 一致。
  callout(state, node) {
    const type = node.attrs.type || 'note'
    const fold = node.attrs.fold || ''
    const title = node.attrs.title ? ' ' + node.attrs.title : ''
    const marker = '> [!' + type + ']' + fold + title + '\n'
    state.wrapBlock('> ', marker, node, () => state.renderContent(node))
  },
  list_item(state, node) {
    if (node.attrs.checked != null) state.write(node.attrs.checked ? '[x] ' : '[ ] ')
    state.renderContent(node)
  },
  table: serializeTable,
  // 图片：embed（Obsidian ![[..]]）原样写回 `![[src|别名]]`；带宽度时走 Typora/Obsidian 的尺寸形态；
  // 否则走默认 `![alt](src "title")`
  image(state, node) {
    const w = node.attrs.width
    if (node.attrs.embed) {
      const alt = node.attrs.alt && node.attrs.alt !== node.attrs.src ? '|' + node.attrs.alt : ''
      state.write('![[' + node.attrs.src + alt + (w ? '|' + w : '') + ']]')
      return
    }
    if (w) {
      const src = String(node.attrs.src).replace(/[\(\)]/g, (c) => '\\' + c)
      const title = node.attrs.title ? ' ' + state.quote(node.attrs.title) : ''
      state.write('![' + state.esc(node.attrs.alt || '') + '](' + src + title + ' =' + w + 'x)')
      return
    }
    defaultMarkdownSerializer.nodes.image(state, node)
  },
  wikiLink(state, node) {
    const label = node.attrs.label
    state.write(label && label !== node.attrs.target ? `[[${node.attrs.target}|${label}]]` : `[[${node.attrs.target}]]`)
  },
  tag(state, node) {
    state.write('#' + node.attrs.tag)
  },
  anchor(state, node) {
    // 原样写回字面空锚 <a id="…"></a>（与导入侧发锚、与上方 anchor 行内规则对倒）
    state.write('<a id="' + escapeAttr(node.attrs.id) + '"></a>')
  },
  math_inline(state, node) {
    // 原样写回，不转义反斜杠/花括号（KaTeX 需要）
    state.write('$' + node.attrs.latex + '$')
  },
  math_block(state, node) {
    state.write('$$\n')
    state.write(node.attrs.latex)
    state.ensureNewLine()
    state.write('$$')
    state.closeBlock(node)
  },
  // —— 功能项 J：脚注序列化 ——
  // 正文角标：原样写回 [^id]（序号不落入 md，仅存稳定 id）
  footnote_ref(state, node) {
    state.write('[^' + node.attrs.id + ']')
  },
  // 文末脚注区：每条 [^id]: <内联内容>，项间空行
  footnote_section(state, node) {
    let first = true
    node.forEach((item) => {
      if (!first) state.write('\n\n')
      first = false
      state.write('[^' + item.attrs.id + ']: ')
      const para = item.firstChild
      if (para) state.renderInline(para)
    })
    state.closeBlock(node)
  },
}

const serializerMarks = {
  ...defaultMarkdownSerializer.marks,
  strike: { open: '~~', close: '~~', mixable: true, expelEnclosingWhitespace: true },
}

const SERIALIZER = new MarkdownSerializer(serializerNodes, serializerMarks, {
  // 文本节点里的 '#' 一律转义：真正的标签是独立 tag 节点（原样写 '#xxx'），
  // 而普通文字中的 '#'（如 "C#"）必须转义以免重新解析时被误判为标签。
  // '$' 也一律转义：普通文本中的 $ 不应被误当行内数学开导。
  escapeExtraCharacters: /[#$]/g,
})

/** ProseMirror doc -> Markdown 字符串 */
export function serializeMarkdown(doc) {
  return SERIALIZER.serialize(doc)
}

// 供大纲/标签面板复用
export { schema as docSchema }
