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

// —— 1. 扩展 schema ————————————————————————————————————————————————
// 复用默认 schema 的 OrderedMap，追加/覆写节点与标记，避免重写 DOM 规格。

function alignmentStyle(node) {
  const a = node.attrs.alignment
  return a ? { style: `text-align:${a}` } : {}
}

const extendedNodes = baseSchema.spec.nodes
  // 任务列表：list_item 增加 checked 属性（null=普通项，true/false=任务项）
  .update('list_item', {
    content: 'block+',
    defining: true,
    attrs: { checked: { default: null } },
    parseDOM: [
      {
        tag: 'li',
        getAttrs(dom) {
          const cb = dom.querySelector(':scope > input[type=checkbox]')
          return { checked: cb ? cb.checked : null }
        },
      },
    ],
    toDOM(node) {
      if (node.attrs.checked != null) {
        return [
          'li',
          { 'data-checked': String(node.attrs.checked) },
          ['input', { type: 'checkbox', checked: node.attrs.checked ? 'checked' : null }],
          0,
        ]
      }
      return ['li', 0]
    },
  })
  // 表格（GFM 单元格仅支持行内内容，故 cell content = inline*）
  .addToEnd('table', {
    content: 'table_row+',
    group: 'block',
    isolating: true,
    parseDOM: [{ tag: 'table' }],
    toDOM() {
      return ['table', ['tbody', 0]]
    },
  })
  .addToEnd('table_row', {
    content: '(table_cell | table_header)+',
    isolating: true,
    parseDOM: [{ tag: 'tr' }],
    toDOM() {
      return ['tr', 0]
    },
  })
  .addToEnd('table_header', {
    content: 'inline*',
    attrs: { alignment: { default: null } },
    parseDOM: [
      {
        tag: 'th',
        getAttrs(dom) {
          return { alignment: dom.style.textAlign || null }
        },
      },
    ],
    toDOM(node) {
      return ['th', alignmentStyle(node), 0]
    },
  })
  .addToEnd('table_cell', {
    content: 'inline*',
    attrs: { alignment: { default: null } },
    parseDOM: [
      {
        tag: 'td',
        getAttrs(dom) {
          return { alignment: dom.style.textAlign || null }
        },
      },
    ],
    toDOM(node) {
      return ['td', alignmentStyle(node), 0]
    },
  })
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
  // 代码块：显示语言标签（Typora 风格，右下角）
  .update('code_block', {
    group: 'block',
    code: true,
    defining: true,
    attrs: { params: { default: '' } },
    parseDOM: [{ tag: 'pre', preserveWhitespace: 'full' }],
    toDOM(node) {
      const lang = (node.attrs.params || '').trim().split(/\s+/)[0]
      return ['pre', lang ? { 'data-language': lang } : {}, ['code', 0]]
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
// commonmark 基底 + 开启 table / strikethrough，再叠加 wikilink / tag 自定义行内规则。
const tokenizer = MarkdownIt('commonmark', { html: false }).enable(['table', 'strikethrough'])

// [[Target]] 或 [[Target|显示文字]]
tokenizer.inline.ruler.push('wikilink', (state, silent) => {
  const src = state.src
  const pos = state.pos
  if (src.charCodeAt(pos) !== 0x5b /* [ */ || src.charCodeAt(pos + 1) !== 0x5b) return false
  const end = src.indexOf(']]', pos + 2)
  if (end < 0) return false
  const inner = src.slice(pos + 2, end)
  if (!inner || inner.includes('[') || inner.includes('\n')) return false
  if (!silent) {
    const token = state.push('wiki_link', 'span', 0)
    const bar = inner.indexOf('|')
    token.attrSet('target', bar < 0 ? inner : inner.slice(0, bar).trim())
    token.attrSet('label', bar < 0 ? null : inner.slice(bar + 1))
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
  tag: { node: 'tag', getAttrs: (tok) => ({ tag: tok.attrGet('tag') }) },
  math_inline: { node: 'math_inline', getAttrs: (tok) => ({ latex: tok.latex || '' }) },
  math_block: { node: 'math_block', getAttrs: (tok) => ({ latex: tok.latex || '' }) },
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
  list_item(state, node) {
    if (node.attrs.checked != null) state.write(node.attrs.checked ? '[x] ' : '[ ] ')
    state.renderContent(node)
  },
  table: serializeTable,
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
