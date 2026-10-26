// paste-clean.js —— 富文本粘贴前的结构清理
//
// ProseMirror 拿到剪贴板的 text/html 后按 schema 解析，schema 管不住的只有一种东西：
// 结构垃圾。从 AI 对话框、飞书、公众号复制的内容里最常见的几样：
//   代码块头部的「复制 / Copy」按钮（schema 不认 button，按钮里的文字会被当正文留下）
//   行号装订线 span、代码块工具条、语言徽标
//   连续空段落（<p><br></p> 串联）、长串 <br> 撑开的空行
// 这层在 schema 解析之前把垃圾节点整棵摘掉。只删结构，不重排内容；
// class 白名单式的样式保留交给 schema 自己裁。
//
// class 判定用词元（classList 逐个 token）而不是 class 属性子串匹配：
// 「copyright」不能因为含 copy 被误杀，token 边界能区分 copy 和 copyright。

const JUNK_TAGS = new Set(
  ('script style iframe object embed noscript template form input select textarea button svg ' +
    'canvas audio video source track link meta base').split(' ')
)

// 词元命中任一即垃圾：copy 系按钮、代码块头/工具条、语言徽标、行号装订线
const JUNK_CLASS = new RegExp(
  [
    '(^|[-_ ])copy([-_ ]|$)', // 裸 copy、copy-button、code-copy、hljs-copy
    'copy[-_]?(button|btn|code|icon)',
    'clipboard',
    'toolbar',
    'code[-_]?block[-_]?(header|head|bar)',
    'language[-_]?(name|badge|label)',
    'lang[-_]?badge',
    'line[-_]?numbers?([-_ ]?rows)?$'
  ].join('|'),
  'i'
)

function isJunkEl(el) {
  if (el.nodeType !== 1) return false
  const tag = el.tagName.toLowerCase()
  if (JUNK_TAGS.has(tag)) return true
  // pre / code 本体挂着 line-numbers 这类 class（Prism 口径），内容永远不能整块丢
  if (tag === 'pre' || tag === 'code') return false
  for (const c of el.classList) {
    if (JUNK_CLASS.test(c)) return true
  }
  const label = el.getAttribute('aria-label') || el.getAttribute('data-testid') || ''
  if (label && /复制|copy/i.test(label)) return true
  return false
}

// 摘掉垃圾节点。querySelectorAll 按文档序返回，摘祖先时后代随之脱离文档树，
// 所以摘之前先查 isConnected，避免对已脱离的节点重复操作。
function removeJunk(root) {
  for (const el of root.querySelectorAll('*')) {
    if (!el.isConnected) continue
    if (isJunkEl(el)) el.remove()
  }
}

// 空节点清除：文本为空、子节点只有 <br> 或空白、里面没有 img / table / ul / pre 的
// 排版壳（p / div / span / section / 空标题 / 空 li / 空链接）摘掉。
// 表格单元格不摘——空 td 是合法内容。从深到浅迭代，父级被清空后下一轮跟着走。
const PRUNE_TAGS =
  'p, div, span, section, article, header, footer, h1, h2, h3, h4, h5, h6, li, a, em, strong, b, i, u, s, figure, figcaption'
const KEEP_IF_CONTAINS = 'img, picture, table, ul, ol, pre, code, blockquote, iframe, video, audio, svg'

function isEmptyShell(el) {
  if (el.querySelector(KEEP_IF_CONTAINS)) return false
  for (const child of el.childNodes) {
    if (child.nodeType === 3) {
      if (child.nodeValue.trim()) return false
    } else if (child.nodeType === 1 && child.tagName !== 'BR') {
      return false
    }
  }
  return true
}

function pruneEmpty(root) {
  for (let round = 0; round < 5; round++) {
    let removed = false
    const els = root.querySelectorAll(PRUNE_TAGS)
    for (let i = els.length - 1; i >= 0; i--) {
      const el = els[i]
      if (el.isConnected && isEmptyShell(el)) {
        el.remove()
        removed = true
      }
    }
    if (!removed) break
  }
}

// 连续 3 个以上的 <br> 收成 1 个。两个 br 还可能是刻意的段落间隔，三个往上只剩撑空行。
// 撑出来的空行一旦进文档，hard break 会序列化成行尾反斜杠写回 md 源文件。
function collapseBrRuns(root) {
  for (const parent of [root, ...root.querySelectorAll('*')]) {
    if (!parent.isConnected) continue
    let run = []
    const flush = () => {
      if (run.length >= 3) for (let i = 1; i < run.length; i++) run[i].remove()
      run = []
    }
    for (const child of Array.from(parent.childNodes)) {
      if (child.nodeType === 1 && child.tagName === 'BR') run.push(child)
      else flush()
    }
    flush()
  }
}

/** 粘贴的 text/html → 摘掉结构垃圾后的 html 串。输入不是文本或为空时原样返回空串。 */
export function cleanPastedHtml(source) {
  const html = String(source == null ? '' : source)
  if (!html.trim()) return ''
  const doc = new DOMParser().parseFromString('<body>' + html + '</body>', 'text/html')
  removeJunk(doc.body)
  pruneEmpty(doc.body)
  collapseBrRuns(doc.body)
  return doc.body.innerHTML
}
