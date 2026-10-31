// editor-schema.js —— ProseMirror 文档模型 + Markdown 双向无损转换（纯逻辑，不依赖 DOM）
//
// 设计要点：
//  · 基于 prosemirror-markdown 的默认 schema，扩展 GFM 能力：删除线、任务列表、表格，
//    以及 NoteLume 自定义的 [[wikilink]] 与 #tag 行内节点。
//  · 转换完全走标准 GFM 语法，不引入任何私有格式，保证与 Typora/Obsidian 文件兼容。
//  · wikilink / tag 通过 markdown-it 自定义 inline 规则解析，序列化时原样写回。
//  · 中文标点紧邻的强调（`**总结：**大`、`这是**「重要」**的内容`）按 Typora / Obsidian
//    的行为渲染：CommonMark 的 flanking 规则在无空格的中文里不构成贴合，挂载 tokenizer 时
//    对 scanDelims 做了放宽（见下方「中文标点紧邻的强调」）。
//  · 任务列表用 markdown-it 原生产出的 `[ ]` / `[x]` 文本，在解析后做一次模型转换落到
//    list_item.checked 属性上，序列化时再写回，保证无损。

import { Schema, Fragment, DOMParser } from 'prosemirror-model'
import { Transform } from 'prosemirror-transform'
import {
  schema as baseSchema,
  MarkdownParser,
  MarkdownSerializer,
  MarkdownSerializerState,
  defaultMarkdownParser,
  defaultMarkdownSerializer,
} from 'prosemirror-markdown'
import MarkdownIt from 'markdown-it'
import footnote from 'markdown-it-footnote'
import { full as emoji } from 'markdown-it-emoji'
import { tableNodes } from 'prosemirror-tables'
import { t } from './i18n.js'
import { mountEmojiRenderer } from './emoji-text.js'

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
  // allowGapCursor:false 挡表内落点：间隙光标的判定看「所在父块」，行首/行尾位置的父块是 table_row，
  // 其 contentMatch 默认类型是 table_cell，方向键从格内左右越界就会停在那里（实测 dir=-1 得 pos=10
  // 父=table_row），再敲一次键就往行里插一个格。表前后的落点父块是 doc，不受这条影响。
  .addToEnd('table', { ...nlTableNodes.table, allowGapCursor: false })
  .addToEnd('table_row', { ...nlTableNodes.table_row, allowGapCursor: false })
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
          title: t('schema.wikiTitle', { target: node.attrs.target }),
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
        { class: 'nl-tag', 'data-tag': node.attrs.tag, contenteditable: 'false', title: t('schema.tagTitle', { tag: node.attrs.tag }) },
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
          title: t('schema.mathTitle', { latex: node.attrs.latex }),
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
    // 文末代码块下方的可点落点：gapcursor 判定「相邻块是否需要间隙」时看这个标记
    // （源码 needsGap = isAtom || isolating || createGapCursor），代码块三者都不占，
    // 不写就点不出落点，实测见 tests/gapcursor.test.mjs
    createGapCursor: true,
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
  // HTML 块：原样承载一段字面 HTML 源码（WordPress / 各类导出器写的正文都是这种形态）。
  // 源码只存 attrs.source，渲染侧交 nodeview 净化后注入，序列化原样写回，未经编辑时字节一致。
  .addToEnd('html_block', {
    atom: true,
    group: 'block',
    attrs: { source: { default: '' } },
    parseDOM: [
      {
        tag: 'div.nl-html-block[data-source]',
        getAttrs(dom) {
          return { source: dom.getAttribute('data-source') || '' }
        },
      },
    ],
    toDOM(node) {
      // 无 nodeview 的环境（如站点导出的临时 DOM 解析）退回显示源码，不至于整块消失
      return [
        'div',
        { class: 'nl-html-block', 'data-source': node.attrs.source, contenteditable: 'false' },
        ['pre', { class: 'nl-html-src' }, node.attrs.source],
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
  // footnote_ref：正文内的行内原子引用节点（存稳定 id；显示序号由 footnotePlugin.renumber 按文档序现算）。
  // 序号只走 data-ordinal 属性 + CSS ::before 画，绝不在 toDOM 里塞文本子节点——否则 renumber 每次
  // 改写 textContent 会替换 PM 所属文本节点，在 WebView 里冲掉原生光标，导致「脚注文档点不动光标」。
  .addToEnd('footnote_ref', {
    inline: true,
    group: 'inline',
    atom: true,
    attrs: { id: { default: '' } },
    toDOM(node) {
      // data-ordinal 初值给 id（renumber 会校正为文档序）；无文本子节点，序号交 CSS ::before
      return ['sup', { class: 'nl-footnote-ref', 'data-id': node.attrs.id, 'data-ordinal': node.attrs.id, contenteditable: 'false' }]
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

// 选区高亮（p5plan §6.4）：颜色存 attrs——七个预设名（光谱序）走 --highlight-* 变量（跟主题
// 换色），自定义色是六位 hex，toDOM 直接写行内背景。inclusive: false：在标记边界接着打字不会
// 把新高亮文字吞进来（Notion 式选区操作，不是连续输入格式）。
// 用 addBefore('code', …) 而不是 addToEnd：序列化按 rank 顺序包标签，排在 code 之后
// 会把 <mark> 写进行内代码的反引号里（`<mark>x</mark>` 在反引号内），重载时整段变成
// 代码文本，高亮丢失还污染内容。排在 code 之前写出来是 <mark>`x`</mark>，能正常回吃。
export const HL_PRESETS = ['yellow', 'orange', 'green', 'teal', 'blue', 'violet', 'pink']

/** 颜色入站校验：预设名或六位 hex 原样收（hex 转小写），其余回落 yellow */
export function normalizeHlColor(v) {
  const s = String(v == null ? '' : v).trim()
  if (HL_PRESETS.includes(s)) return s
  if (/^#[0-9a-fA-F]{6}$/.test(s)) return s.toLowerCase()
  return 'yellow'
}

const extendedMarks = baseSchema.spec.marks
  .addToEnd('strike', {
    parseDOM: [{ tag: 's' }, { tag: 'del' }, { tag: 'strike' }, { style: 'strike-through' }],
    toDOM() {
      return ['s']
    },
  })
  .addBefore('code', 'highlight', {
    attrs: { color: { default: 'yellow' } },
    inclusive: false,
    parseDOM: [
      {
        tag: 'mark.nl-hl',
        getAttrs(dom) {
          return { color: normalizeHlColor(dom.getAttribute('data-color')) }
        },
      },
    ],
    toDOM(mark) {
      const color = normalizeHlColor(mark.attrs.color)
      // 预设色不写行内样式：交给 CSS 按 data-color 取 --highlight-* 变量，主题切换即跟随
      const style = HL_PRESETS.includes(color) ? null : `background-color:${color}`
      return ['mark', { class: 'nl-hl', 'data-color': color, style }]
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
// emoji 短代码（:smile: → 😄）：只动 renderer（整站 / 幻灯片导出走 .render()），解析流水线零改动——
// markdown-it-emoji 插件的 core 规则会把 parse 产物里的文本换成 emoji token，prosemirror-markdown
// 对未知 token 跳过，编辑器会丢字，故不能用那个插件（见 emoji-text.js 头注）
mountEmojiRenderer(tokenizer)

// —— 中文标点紧邻的强调（加粗 / 斜体 / 删除线）———————————————————
// CommonMark 的 flanking 判定假设文字按空白分词：定界符串外侧紧贴标点时，要构成可开合的
// 左 / 右侧贴合，另一侧还必须紧跟空白或标点。中文行文没有空格，`**总结：**大` 收尾处的 **
// 前面是全角冒号（Unicode 标点）、后面紧跟汉字（非空白非标点），按规范不构成右侧贴合，
// 整段加粗失效，文档里留着字面星号；序列化时这些 ** 又被当普通文本转义写回，用户保存
// 一次文件就被改坏（`**总结：**大` 存成 `\*\*总结：\*\*大`）。`这是**「重要」**的内容`、
// `**“注意”**请看`、`~~提示：~~如下` 同理。Typora / Obsidian 对这些写法照常渲染，本项目
// 对齐：flanking 计算时把非 ASCII 的 Unicode 标点（全角标点、中文引号、弯引号、破折号
// 等）当作普通文字，不当标点。
// 实现：包一层 StateInline.prototype.scanDelims，调用期间把 state.src 里这些字符掩码成
// ASCII 字母后走原逻辑，返回前还原。ASCII 标点的判定不动（`**foo:**bar` 仍不渲染，与
// GitHub / VS Code 一致），`_` 的词内限制也不动（`文件_备份` 不会变斜体）。掩码按 state
// 缓存：同一次 inline 解析里强调 / 删除线规则会多次调 scanDelims，而 state.src 在解析
// 期间不变；无目标字符时掩码与原串相等，直接走原逻辑。
const NON_ASCII_RE = /[^\x00-\x7F]/gu
const UNICODE_PUNCT_RE = /\p{P}/u
const StateInline = tokenizer.inline.State
const scanDelimsBase = StateInline.prototype.scanDelims
StateInline.prototype.scanDelims = function (start, canSplitWord) {
  const src = this.src
  if (this.__nlPunctMaskedFor !== src) {
    this.__nlPunctMaskedFor = src
    this.__nlPunctMasked = src.replace(NON_ASCII_RE, (ch) => (UNICODE_PUNCT_RE.test(ch) ? 'x' : ch))
  }
  const masked = this.__nlPunctMasked
  if (masked === src) return scanDelimsBase.call(this, start, canSplitWord)
  this.src = masked
  try {
    return scanDelimsBase.call(this, start, canSplitWord)
  } finally {
    this.src = src
  }
}

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
// 字符集与左边界白名单对齐 Rust 侧的 is_tag_char / extract_tags（src-tauri/src/lib.rs）：
// 两边不一致时，全局标签面板有、文档标签面板空，中文标签正好踩中这个缝。
const TAG_RE = /[\p{L}\p{N}_\-/]/u
const TAG_LEFT_OK = (c) => c === undefined || /\s/.test(c) || '()>"\'[]*~,.;:!?'.includes(c)
tokenizer.inline.ruler.push('tag', (state, silent) => {
  const src = state.src
  const pos = state.pos
  if (src.charCodeAt(pos) !== 0x23 /* # */) return false
  const next = src[pos + 1]
  if (!next || !TAG_RE.test(next)) return false
  if (!TAG_LEFT_OK(src[pos - 1])) return false // C# 这类词中井号不算标签
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
// 排在 html_inline 之前：站点导出那一趟要临时打开 html（认字面 HTML 块），编辑器侧写的空锚仍须归本规则。
const ANCHOR_RE = /^<a id="([^"]*)"><\/a>/
tokenizer.inline.ruler.before('html_inline', 'anchor', (state, silent) => {
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

// <mark data-color="…">…</mark> 选区高亮（§6.4）：html:false 下 <mark> 默认会被当转义文本，
// 故与 anchor 同样自定义行内规则截获。写成 HTML 标签而不是私有语法，是为了让 Typora /
// Obsidian 打开同一文件时高亮不丢；颜色只收预设名或六位 hex，不合法的当普通文本。
// 内层内容过一遍完整 inline 规则（加粗 / 链接 / 标签 / 再嵌套高亮都能嵌），
// 与 markdown-it 的 link 同构。注册顺序同 anchor：排在 html_inline 之前，站点导出开 html 时也不被抢。
const HL_OPEN_RE = /^<mark\s+data-color="([^"]*)"\s*>/i
// 配对闭标签要数嵌套深度：直接 indexOf 会把内层 <mark> 的闭标签当成自己的
const HL_TAG_RE = /<mark\s+data-color="[^"]*"\s*>|<\/mark\s*>/gi
function findHlClose(src, from, limit) {
  let depth = 1
  HL_TAG_RE.lastIndex = from
  for (let m = HL_TAG_RE.exec(src); m; m = HL_TAG_RE.exec(src)) {
    if (m.index >= limit) break
    if (m[0][1] === '/') {
      depth--
      if (depth === 0) return m.index
    } else {
      depth++
    }
  }
  return -1
}
tokenizer.inline.ruler.before('html_inline', 'highlight', (state, silent) => {
  const pos = state.pos
  const max = state.posMax
  const src = state.src
  if (src.charCodeAt(pos) !== 0x3c /* < */) return false
  const m = HL_OPEN_RE.exec(src.slice(pos))
  if (!m) return false
  const color = normalizeHlColor(m[1])
  const openEnd = pos + m[0].length
  const closeIdx = findHlClose(src, openEnd, max)
  if (closeIdx < 0 || closeIdx > max) return false
  if (src.slice(openEnd, closeIdx).length === 0) return false
  if (!silent) {
    const open = state.push('highlight_open', 'mark', 1)
    open.attrSet('color', color)
    // 只 tokenize 开标签到闭标签之间的内容，完事还原外层边界（link 规则的同一手法）
    state.pos = openEnd
    state.posMax = closeIdx
    state.md.inline.tokenize(state)
    state.push('highlight_close', 'mark', -1)
  }
  state.pos = closeIdx + '</mark>'.length
  state.posMax = max
  return true
})

// 嵌套 <mark> 摊平：prosemirror-markdown 的标记机制是 flat 的 open/close 对，
// closeMark 按类型整组移除——`<mark A>x <mark B>y</mark> z</mark>` 这类交叉高亮
// 解析后内层色会污染整段（原来的 bug：z 丢色、y 只剩内层色）。
// 这里在 inline 解析完成后把 token 流改成不交叉的单层段：每段文字取其「最内层」
// 打开的高亮色，与任何渲染器里内层 <mark> 盖住外层的观感一致。
// 本应用的编辑器不会产出交叉高亮（上色前先清掉选区内旧色），这条规则只兜住
// 手写或外部工具生成的文件；摊平后写回即固化，不会反复变形。
const HL_CLOSE_TOK = { type: 'highlight_close', tag: 'mark', nesting: -1, attrs: null }
function flattenHlLevel(toks) {
  let has = false
  for (const t of toks) {
    if (t.type === 'highlight_open' || t.type === 'highlight_close') {
      has = true
      break
    }
  }
  if (!has) return
  const out = []
  const stack = [] // 当前打开的高亮 open token（最后一个 = 最内层）
  let cur = null // 当前段：{ openTok|null, items[] }
  const flush = () => {
    if (!cur) return
    if (cur.openTok) {
      out.push(cur.openTok)
      for (const it of cur.items) out.push(it)
      out.push(HL_CLOSE_TOK)
    } else {
      for (const it of cur.items) out.push(it)
    }
    cur = null
  }
  for (const t of toks) {
    if (t.type === 'highlight_open') {
      stack.push(t)
      continue
    }
    if (t.type === 'highlight_close') {
      stack.pop()
      continue
    }
    const top = stack.length ? stack[stack.length - 1] : null
    const color = top ? top.attrGet('color') : null
    if (cur && cur.color === color) cur.items.push(t)
    else {
      flush()
      cur = { color, openTok: top, items: [t] }
    }
  }
  flush()
  toks.length = 0
  toks.push(...out)
}
tokenizer.core.ruler.after('inline', 'nl_hl_flatten', (state) => {
  const walk = (toks) => {
    for (const t of toks) {
      if (t.type === 'inline' && t.children) walk(t.children)
    }
    flattenHlLevel(toks)
  }
  walk(state.tokens)
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
  // 选区高亮（§6.4）：open/close 成对；attr color 经 getAttrs 落到标记属性
  // （不写 getAttrs 时 prosemirror-markdown 只认 spec.attrs 里列的名字，颜色会丢）
  highlight: { mark: 'highlight', getAttrs: (tok) => ({ color: normalizeHlColor(tok.attrGet('color')) }) },
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

// —— 功能项 J/X：HTML 块的两阶段解析（合并表格是其中一种特例，边界见合并表 spec）——
// 主 tokenizer 是 html:false，字面 HTML 会被当转义文本。故在 markdown 解析前：
//  ① 预处理器把顶格的 HTML 块（含独占一行的 <table>…</table>）换成占位段落行；
//  ② 照常走 mdParser 得到含占位段落的 doc；
//  ③ 表格类还原为可编辑 table 节点，其余装进 html_block 节点，原位替换占位段落。
// 块边界直接问 markdown-it（把共享 tokenizer 的 html 临时打开再解析一遍拿 token.map），
// 不自己数行：类型 1（<pre>/<script>/…）要到闭标签才结束、类型 6 到空行结束、围栏内不算，
// 这些规则手写一遍必然和真正那次解析对不齐。
const TABLE_LINE_RE = /^<table\b[\s\S]*<\/table>$/i
const HTML_BLOCK_RE = /^\{\{nl-html-(\d+)\}\}$/

// 只认这些起始标签：CommonMark 类型 6 名单 + 类型 1 的 pre/script/style/textarea + 注释/声明/CDATA。
// 刻意不收类型 7（任意标签独占一行）：<a id="x"></a> 与 <mark data-color=…> 是自定义行内规则
// （anchor / highlight）的载体，独占一行时也得继续走行内规则，不能被整块接管。
const HTML_BLOCK_TAGS = new Set(
  ('address article aside base basefont blockquote body caption center col colgroup dd details ' +
    'dialog dir div dl dt fieldset figcaption figure footer form frame frameset h1 h2 h3 h4 h5 h6 ' +
    'head header hr html iframe legend li link main menu menuitem nav noframes ol optgroup option p ' +
    'param search section summary table tbody td tfoot th thead title tr track ul ' +
    ' pre script style textarea'
  ).split(' ')
)

// 块首行 → 标签名（注释 / <!DOCTYPE / <?xml / <![CDATA[ 归一为 '#'，一律收）
function htmlBlockTag(line) {
  const m = /^<\s*\/?\s*([a-zA-Z][a-zA-Z0-9-]*)/.exec(line)
  if (m) return m[1].toLowerCase()
  if (/^<!--/.test(line) || /^<\?/.test(line) || /^<!\[CDATA\[/.test(line) || /^<![a-zA-Z]/.test(line)) return '#'
  return null
}

function scanHtmlBlocks(md) {
  const lines = md.split('\n')
  const prev = tokenizer.options.html
  tokenizer.options.html = true
  let tokens
  try {
    tokens = tokenizer.parse(md, Object.create(null))
  } finally {
    tokenizer.options.html = prev
  }
  const found = []
  for (const tk of tokens) {
    if (tk.type !== 'html_block' || !tk.map) continue
    const [l0, l1] = tk.map
    // 只接管顶格块：列表项 / 引用里缩进的 HTML 块交回原样（占位符要插回原行位置，缩进一丢就散架）
    if (!lines[l0] || lines[l0][0] !== '<') continue
    const tag = htmlBlockTag(lines[l0])
    if (tag == null || (!HTML_BLOCK_TAGS.has(tag) && tag !== '#')) continue
    found.push({ start: l0, end: l1, source: lines.slice(l0, l1).join('\n') })
  }
  return found
}

function extractHtmlBlocks(md) {
  const found = scanHtmlBlocks(md)
  const blocks = []
  if (!found.length) return { text: md, blocks }
  const lines = md.split('\n')
  const at = new Map()
  for (const f of found) {
    const single = f.end === f.start + 1
    blocks.push({ kind: single && TABLE_LINE_RE.test(f.source.trim()) ? 'table' : 'html', source: f.source })
    at.set(f.start, { end: f.end, idx: blocks.length - 1 })
  }
  const out = []
  for (let i = 0; i < lines.length; i++) {
    const span = at.get(i)
    if (span) {
      // 用空行夹住占位，确保它独占成一个段落
      out.push('', '{{nl-html-' + span.idx + '}}', '')
      i = span.end - 1
    } else {
      out.push(lines[i])
    }
  }
  return { text: out.join('\n'), blocks }
}


// 把列数不齐的畸形表格补成矩形：docx 导入的合并表常出现「表头行 colspan 加总 ≠ 数据行」，
// 还原出的 ProseMirror 表格非矩形会让 prosemirror-tables 的 TableMap 在选区/点击计算时崩，
// 表现为「光标点哪都不动、但能打字」。这里按真实占位（含 colspan/rowspan）求列宽，行末补空单元格。
export function normalizeTableRect(table, sc) {
  const rows = []
  table.forEach((r) => { const cells = []; r.forEach((c) => cells.push(c)); rows.push(cells) })
  const H = rows.length
  if (!H) return table
  const occFor = () => Array.from({ length: H }, () => new Set())
  // ① 模拟逐格占位（colspan 占多列、rowspan 顺延覆盖后续行），求出真实列宽 width
  let occ = occFor()
  let width = 0
  for (let r = 0; r < H; r++) {
    let col = 0
    for (const c of rows[r]) {
      while (occ[r].has(col)) col++
      const cs = c.attrs.colspan || 1
      const rs = c.attrs.rowspan || 1
      for (let i = 0; i < rs; i++) { const rr = r + i; if (rr < H) for (let j = 0; j < cs; j++) occ[rr].add(col + j) }
      col += cs
    }
    let used = 0
    occ[r].forEach((x) => { if (x + 1 > used) used = x + 1 })
    if (used > width) width = used
  }
  // ② 同规则重摆，行末不足 width 处补一个空单元格（colspan = 缺口）；已矩形则原样返回
  occ = occFor()
  const newRows = []
  let dirty = false
  for (let r = 0; r < H; r++) {
    const rowCells = []
    let col = 0
    for (const c of rows[r]) {
      while (occ[r].has(col)) col++
      const cs = c.attrs.colspan || 1
      const rs = c.attrs.rowspan || 1
      for (let i = 0; i < rs; i++) { const rr = r + i; if (rr < H) for (let j = 0; j < cs; j++) occ[rr].add(col + j) }
      col += cs
      rowCells.push(c)
    }
    while (occ[r].has(col)) col++
    if (col < width) { dirty = true; rowCells.push(sc.nodes.table_cell.create({ colspan: width - col })) }
    newRows.push(sc.nodes.table_row.create(null, rowCells))
  }
  return dirty ? sc.nodes.table.create(table.attrs, newRows) : table
}

function parseTableSlice(html) {
  const box = document.createElement('div')
  box.innerHTML = html
  const frag = DOMParser.fromSchema(schema).parseSlice(box).content
  // 还原出的 HTML 表若列数不齐，补成矩形再交回，避免畸形表拖垮选区交互
  const fixed = []
  let changed = false
  frag.forEach((n) => {
    if (n.type.name === 'table') { const t = normalizeTableRect(n, schema); if (t !== n) changed = true; fixed.push(t) }
    else fixed.push(n)
  })
  return changed ? Fragment.from(fixed) : frag
}

function restoreHtmlBlocks(doc, blocks) {
  const hits = []
  doc.descendants((node, pos) => {
    if (node.type.name === 'paragraph') {
      const m = HTML_BLOCK_RE.exec(node.textContent.trim())
      if (m && blocks[Number(m[1])] != null) hits.push({ pos, size: node.nodeSize, idx: Number(m[1]) })
    }
  })
  if (!hits.length) return doc
  const tr = new Transform(doc)
  // 由后往前替换，低位位置不受高位替换影响
  for (const h of hits.sort((a, b) => b.pos - a.pos)) {
    const b = blocks[h.idx]
    const content =
      b.kind === 'table'
        ? parseTableSlice(b.source)
        : schema.nodes.html_block.create({ source: b.source })
    tr.replaceWith(h.pos, h.pos + h.size, content)
  }
  return tr.doc
}

/** Markdown 字符串 -> ProseMirror doc */
export function parseMarkdown(mdText) {
  const { text, blocks } = extractHtmlBlocks(mdText || '')
  const doc = mdParser.parse(text)
  const filled = convertTasks(doc) || schema.topNodeType.createAndFill()
  return blocks.length ? restoreHtmlBlocks(filled, blocks) : filled
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

// 位置记账：表格行锚点。单元格文本走 cellToMarkdown 的临时文档序列化、不进文本段记账，
// 光标落在单元格里时会退到“所在行”的行首——有行锚点就落到正确的行，没有则退到表头行。
// 只在带记账的 state 上生效（普通序列化路径完全不受影响）。
function noteRowAnchor(state, pm, pmEnd, line) {
  if (state.nlRowPm && pm >= 0) {
    state.nlRowPm.push(pm)
    state.nlRowPmEnd.push(pmEnd)
    state.nlRowSrc.push(state.out.length - line.length)
    state.nlRowSrcEnd.push(state.out.length)
  }
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
  const rowPms = [] // 与 rows 平行：每行的 [起点, 终点] 文档位置（表格本体位置 + 1 起逐行累加）
  const rowEnds = []
  const tableAbs = state.nlCurrentAbs ? state.nlCurrentAbs() : -1
  let rowAbs = tableAbs + 1
  node.forEach((row) => {
    const cells = []
    let hasHeader = false
    row.forEach((c) => {
      if (c.type.name === 'table_header') hasHeader = true
      cells.push({ md: cellToMarkdown(c), header: c.type.name === 'table_header', align: c.attrs.alignment })
    })
    rows.push({ cells, hasHeader })
    rowPms.push(rowAbs)
    rowEnds.push(rowAbs + row.nodeSize)
    rowAbs += row.nodeSize
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
  const headLine = lineOf(rows[0].cells)
  state.write(headLine)
  noteRowAnchor(state, rowPms[0], rowEnds[0], headLine)
  state.write('\n')
  // 分隔行
  const sep = aligns.map((a, i) => ' ' + alignColMarker(a).padEnd(widths[i], '-') + ' ').join('|')
  state.write('|' + sep + '|')
  // 数据行
  for (let r = 1; r < rows.length; r++) {
    state.write('\n')
    const line = lineOf(rows[r].cells)
    state.write(line)
    noteRowAnchor(state, rowPms[r], rowEnds[r], line)
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
  // HTML 块：源码原样写回，不转义、不重排（写它的就是 WordPress / 别的编辑器，改一个字节都是差异）
  html_block(state, node) {
    state.write(node.attrs.source)
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
  // 选区高亮（§6.4）：写回 <mark data-color> 而非私有语法，颜色随标签走，重载不丢；
  // Typora / Obsidian 打开时按行内 HTML 透传，不至于把高亮变成乱码文本。
  // 不设 mixable：HTML 标签要严格嵌套，mixable 的重排逻辑会把嵌套高亮拆出乱序的闭标签。
  highlight: {
    open: (state, mark) => `<mark data-color="${mark.attrs.color}">`,
    close: '</mark>',
    expelEnclosingWhitespace: true,
  },
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

// —— 5. 位置记账序列化：源码模式与所见即所得之间的光标对齐 ————————————————————————
// 两个编辑器（CodeMirror / ProseMirror）位置坐标系不同，切换模式时不管光标，两边都会跳回
// 文档开头。这里复用同一个 SERIALIZER，把内部 state 换成一个记账子类，渲染时顺手记录文档
// 位置与输出偏移的对应关系，给 pos-map.js 做双向换算：
//   · anchorPm/anchorSrc  节点起止边界 → 输出偏移（单调，可二分）
//   · segPm/segSrc/segSrcEnd/segDoc  文本段。文档侧只存节点文本引用，不拷贝；输出侧只存
//     起止偏移。两侧文本只差转义反斜杠、行间定界、围栏前缀这些插入字符，字符级对齐放在
//     查询时按需做（pos-map.js 的 charMap）
//   · blkPm/blkSrc/blkAt  块记录。src 是渲染入口偏移，常落在上一行行尾；at 是本块第一次
//     落字的位置（write() 钩子回填），那才是它所在行的起点；at 为 -1 表示空块
//   · rowPm/rowPmEnd/rowSrc/rowSrcEnd  表格行锚点。单元格文本不走文本段记账，光标落在
//     单元格里时靠它落到所在行
// 记账全部用平行数字数组，不建每段一个的对象、不拷贝字符串：一次切换要过整个序列化器，
// 这些分配会拉高 GC 时间（实测对输出串 slice 反算落点，28 万字符文档多花 4 秒，长串
// slice 是 O(n)，所以首字符落点改由 write() 钩子回填）。
class MappedSerializerState extends MarkdownSerializerState {
  constructor(nodes, marks, options) {
    super(nodes, marks, options)
    this.nlAnchorPm = []
    this.nlAnchorSrc = []
    this.nlSegPm = []
    this.nlSegSrc = []
    this.nlSegSrcEnd = []
    this.nlSegDoc = []
    this.nlBlkPm = []
    this.nlBlkSrc = []
    this.nlBlkAt = []
    this.nlRowPm = []
    this.nlRowPmEnd = []
    this.nlRowSrc = []
    this.nlRowSrcEnd = []
    this.nlNodePos = null // node -> 绝对位置（首次 renderContent 时由 doc.descendants 一次建成）
    this.nlAbsStack = [] // 渲染栈：栈顶 = 正在渲染节点的绝对位置
    this.nlPendingPm = -1 // 待落账的文本 / 代码块内容的文档位置（render 置、text 落账）
    this.nlPendingText = null
    this.nlPendingBlocks = [] // 待记账块下标栈：等各自第一次落字回填 at（见 write()）
    this.nlCaptureWrite = false // text() 置位：等 write() 回填本行正文首字符落点
    this.nlFirstWriteEnd = -1
    this.nlQPm = [] // 行内文本子节点位置（renderInline 每段重建；code 标记内容不走 render()）
    this.nlQText = []
  }
  // 节点绝对位置：优先查预建表；被 withText 替换过的节点（标记空白驱逐）按
  // 「父内容起点 + 之前兄弟尺寸和」现算
  nlAbsOf(node, parent, index) {
    if (this.nlNodePos) {
      const known = this.nlNodePos.get(node)
      if (known != null) return known
    }
    const parentAbs = this.nlAbsStack.length ? this.nlAbsStack[this.nlAbsStack.length - 1] : -1
    let off = 0
    for (let i = 0; i < index; i++) off += parent.child(i).nodeSize
    return parentAbs + 1 + off
  }
  render(node, parent, index) {
    const abs = this.nlAbsOf(node, parent, index)
    this.nlAbsStack.push(abs)
    const outStart = this.out.length
    // 文本节点 / 代码块整体内容：等 text() 里按字符对齐落账
    if (node.isText) {
      this.nlPendingPm = abs
      this.nlPendingText = node.text
    } else if (node.type.name === 'code_block') {
      this.nlPendingPm = abs + 1
      this.nlPendingText = node.textContent
    }
    // 起点锚点必须“子节点之前”入账：父节点的序列化函数会先写前缀（如 callout 的 marker 行）
    // 再渲染内容，若等到 super.render 返回再记，锚点/块记录的 pm、src 都会乱序，二分全废
    let blkIdx = -1
    if (!node.isText) {
      this.nlAnchorPm.push(abs)
      this.nlAnchorSrc.push(outStart)
      if (node.isBlock) {
        blkIdx = this.nlBlkPm.length
        this.nlBlkPm.push(abs)
        this.nlBlkSrc.push(outStart)
        this.nlBlkAt.push(-1)
        this.nlPendingBlocks.push(blkIdx)
      }
    }
    try {
      super.render(node, parent, index)
    } finally {
      this.nlPendingPm = -1
      this.nlPendingText = null
      this.nlAbsStack.pop()
      // 渲染结束仍未落字（空段落等）：从待记账栈摘掉，不影响外层块
      if (blkIdx >= 0 && this.nlBlkAt[blkIdx] < 0) {
        const i = this.nlPendingBlocks.indexOf(blkIdx)
        if (i >= 0) this.nlPendingBlocks.splice(i, 1)
      }
    }
    if (node.isText) return
    this.nlAnchorPm.push(abs + node.nodeSize)
    this.nlAnchorSrc.push(this.out.length)
  }
  write(content) {
    super.write(content)
    // 每个块第一次落字时回填内容起点：此刻 flushClose 的块间空行、wrapBlock 的行间定界
    // 都已补齐，这个位置才落在“本块第一行”上（入口偏移则落在上一块行尾）
    const chain = this.nlPendingBlocks
    if (chain.length) {
      const idx = chain[chain.length - 1]
      if (this.nlBlkAt[idx] < 0) {
        this.nlBlkAt[idx] = content ? this.out.length - content.length : this.out.length
        chain.pop()
      }
    }
    // text() 正在等“本行正文写入前”的位置：write() 返回时定界/空行都已补齐，这个长度
    // 就是正文首字符的落点（比事后 slice 输出串反算快几个数量级——长串 slice 是 O(n)）
    if (this.nlCaptureWrite) {
      this.nlFirstWriteEnd = this.out.length
      this.nlCaptureWrite = false
    }
  }
  // 当前正在渲染节点的绝对位置（栈顶）：serializeTable 算行位置用
  nlCurrentAbs() {
    return this.nlAbsStack.length ? this.nlAbsStack[this.nlAbsStack.length - 1] : -1
  }
  text(text, escape = true) {
    const pendingText = this.nlPendingText
    // 只有“文档自身的文本”才记账；标记定界符（escape=false）、被驱逐的空白一概跳过
    if (pendingText != null && text === pendingText) {
      const start = this.out.length
      this.nlFirstWriteEnd = -1
      this.nlCaptureWrite = true
      super.text(text, escape)
      // super.text 里的 write() 会先补块间空行 / 行间定界（插入字符），首字符落点由 write()
      // 钩子回填；输出侧只记起止偏移，文本本体与字符级对齐都留到查询时按需做
      const from = this.nlFirstWriteEnd >= 0 ? this.nlFirstWriteEnd - start : 0
      this.nlSegPm.push(this.nlPendingPm)
      this.nlSegSrc.push(start + from)
      this.nlSegSrcEnd.push(this.out.length)
      this.nlSegDoc.push(text)
      return
    }
    // code 标记的内容被合并进一次 `` `xxx` `` 输出（不走 render()），按反引号对切分补账。
    // 落点按「写入后总长 - 闭引号长 - 节点文本长」回算：合并串整体追加在输出末尾，
    // 不受前面 write() 补定界影响。
    if (escape === false && this.nlQText.length) {
      const hit = this.nlMatchCodeSpan(text)
      if (hit && !text.includes('\n')) {
        super.text(text, escape)
        this.nlSegPm.push(hit.pm)
        this.nlSegSrc.push(this.out.length - hit.closeLen - hit.text.length)
        this.nlSegSrcEnd.push(this.out.length)
        this.nlSegDoc.push(hit.text)
        return
      }
    }
    super.text(text, escape)
  }
  // 形如 `开引号 + 节点文本 + 闭引号` 的反引号合并输出：在行内子节点队列里找文本相符的
  nlMatchCodeSpan(text) {
    for (const re of [/^(`+)([\s\S]*)(`+)$/, /^(`+)([\s\S]*?)(`+)$/]) {
      const m = re.exec(text)
      if (!m) continue
      for (let i = 0; i < this.nlQText.length; i++) {
        if (this.nlQText[i] === m[2]) {
          this.nlQText[i] = null // 消费掉，避免同段后续误配
          return { pm: this.nlQPm[i], text: m[2], closeLen: m[3].length }
        }
      }
    }
    return null
  }
  renderInline(parent, fromBlockStart = true) {
    // 预排队内联文本子节点的位置，供上面 code 合并输出补账（复用同一对数组，避免每段分配）
    const base = this.nlAbsStack.length ? this.nlAbsStack[this.nlAbsStack.length - 1] + 1 : 0
    this.nlQPm.length = 0
    this.nlQText.length = 0
    let off = 0
    parent.forEach((child) => {
      if (child.isText) {
        this.nlQPm.push(base + off)
        this.nlQText.push(child.text)
      }
      off += child.nodeSize
    })
    try {
      super.renderInline(parent, fromBlockStart)
    } finally {
      this.nlQPm.length = 0
      this.nlQText.length = 0
    }
  }
  renderContent(parent) {
    // 首次（parent 即 doc）建 node->pos 表；内层 renderContent 不重建
    if (!this.nlNodePos) {
      this.nlNodePos = new Map()
      parent.descendants((n, pos) => this.nlNodePos.set(n, pos))
    }
    super.renderContent(parent)
  }
}

/**
 * 带位置记账的序列化：除文本外，还返回「文档位置 ↔ 输出偏移」的映射原料（平行数组）。
 * 各数组含义见 MappedSerializerState 顶部注释；除 text 外全部单调不减。
 * @returns {{text:string,
 *            anchorPm:number[], anchorSrc:number[],
 *            segPm:number[], segSrc:number[], segSrcEnd:number[], segDoc:string[],
 *            blkPm:number[], blkSrc:number[], blkAt:number[],
 *            rowPm:number[], rowSrc:number[]}}
 */
export function serializeMarkdownMapped(doc) {
  const state = new MappedSerializerState(SERIALIZER.nodes, SERIALIZER.marks, SERIALIZER.options)
  state.renderContent(doc)
  return {
    text: state.out,
    anchorPm: state.nlAnchorPm,
    anchorSrc: state.nlAnchorSrc,
    segPm: state.nlSegPm,
    segSrc: state.nlSegSrc,
    segSrcEnd: state.nlSegSrcEnd,
    segDoc: state.nlSegDoc,
    blkPm: state.nlBlkPm,
    blkSrc: state.nlBlkSrc,
    blkAt: state.nlBlkAt,
    rowPm: state.nlRowPm,
    rowPmEnd: state.nlRowPmEnd,
    rowSrc: state.nlRowSrc,
    rowSrcEnd: state.nlRowSrcEnd,
  }
}

// 供大纲/标签面板复用
export { schema as docSchema }
