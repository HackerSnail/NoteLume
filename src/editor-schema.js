// editor-schema.js —— ProseMirror 文档模型 + Markdown 双向无损转换（纯逻辑，不依赖 DOM）
//
// 设计要点：
//  · 基于 prosemirror-markdown 的默认 schema，扩展 GFM 能力：删除线、任务列表、表格，
//    以及 NoteLume 自定义的 [[wikilink]] 与 #tag 行内节点。
//  · 转换完全走标准 GFM 语法，不引入任何私有格式，保证与 Typora/Obsidian 文件兼容。
//  · wikilink / tag 通过 markdown-it 自定义 inline 规则解析，序列化时原样写回。
//  · 任务列表用 markdown-it 原生产出的 `[ ]` / `[x]` 文本，在解析后做一次模型转换落到
//    list_item.checked 属性上，序列化时再写回，保证无损。

import { Schema, Fragment } from 'prosemirror-model'
import {
  schema as baseSchema,
  MarkdownParser,
  MarkdownSerializer,
  defaultMarkdownParser,
  defaultMarkdownSerializer,
} from 'prosemirror-markdown'
import MarkdownIt from 'markdown-it'
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
  // 图片：在默认 image 基础上增加 embed 标记，无损承载 Obsidian 的 ![[图片.png]] 嵌入语法
  .update('image', {
    inline: true,
    group: 'inline',
    draggable: true,
    attrs: {
      src: {},
      alt: { default: null },
      title: { default: null },
      embed: { default: false },
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
          }
        },
      },
    ],
    toDOM(node) {
      const { src, alt, title, embed } = node.attrs
      const attrs = { src, alt: alt || null, title: title || null }
      if (embed) attrs['data-embed'] = '1'
      return ['img', attrs]
    },
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
      token.attrSet('alt', alias || target)
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
  wiki_img: {
    node: 'image',
    getAttrs: (tok) => ({ src: tok.attrGet('src'), alt: tok.attrGet('alt'), title: null, embed: true }),
  },
  tag: { node: 'tag', getAttrs: (tok) => ({ tag: tok.attrGet('tag') }) },
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

/** Markdown 字符串 -> ProseMirror doc */
export function parseMarkdown(mdText) {
  const doc = mdParser.parse(mdText || '')
  return convertTasks(doc) || schema.topNodeType.createAndFill()
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

function serializeTable(state, node) {
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
  // 图片：embed（Obsidian ![[..]]）原样写回 `![[src|别名]]`；否则走默认 `![alt](src "title")`
  image(state, node) {
    if (node.attrs.embed) {
      const alt = node.attrs.alt && node.attrs.alt !== node.attrs.src ? '|' + node.attrs.alt : ''
      state.write('![[' + node.attrs.src + alt + ']]')
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
