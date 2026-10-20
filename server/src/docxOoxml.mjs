// docxOoxml.mjs —— 网页沙盒专用的 .docx → Markdown 同步解析器（JS 子集，非桌面 Rust 全量）
//
// 为什么同步：/api/invoke → dispatch 全程同步（这是需求①「按 sid 刷生效语言、并发请求不串」成立的前提），
// 所以这里用同步库遍历 OOXML：adm-zip 解包 + fast-xml-parser 解析 document.xml，像 Rust 那样按块映射。
//
// 覆盖范围（够“上传即试”）：标题、粗/斜/删除线、有序无序列表、超链接、图片、表格、普通段落与空行。
// 降级为 warnings（校对弹窗会列出，绝不抛错）：公式 m:oMath、域/交叉引用 w:fldSimple|instrText、
// 文本框 w:txbxContent、脚注尾注引用。保真度低于桌面 docx_import.rs——这条只是网页沙盒的轻量入口。
//
// 命名/派生约定严格对齐 Rust（docx_import.rs），否则复用桌面整条导入流程会对不上：
//   图片 fname = sha256[0..12] + '.' + ext，md 正文以 basename 内联（docx-review.js 靠 <sha12>.<ext> 匹配）；
//   doc_dir = <destDir>/<slug>，plannedDocRel = <doc_dir>/<slug>.md；frontmatter 为 source/imported。

import crypto from 'node:crypto'
import AdmZip from 'adm-zip'
import { XMLParser } from 'fast-xml-parser'

const parser = new XMLParser({ preserveOrder: true, ignoreAttributes: false, attributeNamePrefix: '@_', trimValues: false })

// ---------- 局部名（去命名空间前缀）与树访问 helper ----------
const localOf = (key) => {
  const i = key.indexOf(':')
  return i < 0 ? key : key.slice(i + 1)
}
function elemTag(n) {
  if (!n || typeof n !== 'object') return null
  for (const k of Object.keys(n)) {
    if (k === ':@' || k === '#text') continue
    return k
  }
  return null
}
const local = (n) => {
  const t = elemTag(n)
  return t ? localOf(t) : null
}
const attrsOf = (n) => (n && n[':@']) || {}
const attr = (n, name) => {
  const v = attrsOf(n)['@_' + name]
  return v == null ? null : String(v)
}
const kids = (n) => {
  const t = elemTag(n)
  return t && Array.isArray(n[t]) ? n[t] : []
}
const isText = (n) => !!(n && typeof n === 'object' && Object.prototype.hasOwnProperty.call(n, '#text'))

/** 递归取一个元素下的全部文本（含 w:t 里的 #text） */
function textOf(n) {
  if (isText(n)) return String(n['#text'])
  return kids(n).map(textOf).join('')
}

// ---------- zip 读取 ----------
/** XML 部件解码：Word 写 UTF-8，但总有别的工具写 UTF-16（带 BOM）；直接按 utf8 读会得到
 *  一串 NUL 垃圾、解析成空文档还不报错。BOM 优先，其余按 utf8，顺口剥掉开头 BOM。 */
function decodeXml(b) {
  if (b.length >= 2 && b[0] === 0xff && b[1] === 0xfe) return stripBom(b.toString('utf16le'))
  if (b.length >= 2 && b[0] === 0xfe && b[1] === 0xff) return stripBom(b.swap16().toString('utf16le'))
  return stripBom(b.toString('utf8'))
}
const stripBom = (s) => (s.charCodeAt(0) === 0xfeff ? s.slice(1) : s)

function readZip(buffer) {
  const zip = new AdmZip(buffer)
  const map = new Map()
  for (const e of zip.getEntries()) {
    if (e.isDirectory) continue
    map.set(e.entryName.replace(/\\/g, '/'), e.getData())
  }
  const txt = (name) => {
    const b = map.get(name)
    return b ? decodeXml(b) : null
  }
  return { map, document: txt('word/document.xml'), styles: txt('word/styles.xml'), rels: txt('word/_rels/document.xml.rels'), numbering: txt('word/numbering.xml'), footnotes: txt('word/footnotes.xml'), endnotes: txt('word/endnotes.xml') }
}

// ---------- rels：Id → { target, external } ----------
function parseRels(xml) {
  const out = new Map()
  if (!xml) return out
  let tree
  try {
    tree = parser.parse(xml)
  } catch {
    return out
  }
  walkAll(tree, (n) => {
    if (local(n) !== 'Relationship') return
    const id = attr(n, 'Id')
    const target = attr(n, 'Target')
    const external = (attr(n, 'TargetMode') || '').toLowerCase() === 'external'
    if (id && target) out.set(id, { target, external })
  })
  return out
}

// ---------- styles：styleId → { name, outline } ----------
function parseStyles(xml) {
  const out = new Map()
  if (!xml) return out
  let tree
  try {
    tree = parser.parse(xml)
  } catch {
    return out
  }
  walkAll(tree, (n) => {
    if (local(n) !== 'style') return
    const sid = attr(n, 'styleId')
    if (!sid) return
    let name = ''
    let outline = null
    for (const c of kids(n)) {
      const l = local(c)
      if (l === 'name') name = attr(c, 'val') || ''
      else if (l === 'outlineLvl') {
        const v = parseInt(attr(c, 'val') || '', 10)
        if (!Number.isNaN(v)) outline = v
      }
    }
    out.set(sid, { name, outline })
  })
  return out
}

/** 深度遍历一棵 preserveOrder 树，对每个元素节点回调 */
function walkAll(node, cb) {
  if (Array.isArray(node)) {
    for (const x of node) walkAll(x, cb)
    return
  }
  if (!node || typeof node !== 'object') return
  if (isText(node)) return
  cb(node)
  for (const c of kids(node)) walkAll(c, cb)
}

// ---------- 命名/派生（对齐 Rust slugify / join_rel / sanitize_rel / relpath_from）----------
function slugify(title) {
  let out = ''
  let lastDash = false
  for (const ch of String(title || '')) {
    const code = ch.codePointAt(0)
    const keep = /[\p{L}\p{N}]/u.test(ch) || ch === '-' || ch === '_' || ch === '.' || ch === ' ' || (code >= 0x4e00 && code <= 0x9fff)
    const illegal = ch === '/' || ch === '\\' || ch === ':' || ch === '*' || ch === '?' || ch === '"' || ch === '<' || ch === '>' || ch === '|' || code < 0x20
    if (keep && !illegal) {
      if (ch === ' ') {
        if (!lastDash && out.length) {
          out += '-'
          lastDash = true
        }
      } else {
        out += ch
        lastDash = false
      }
    }
  }
  out = out.replace(/^[-.]+|[-.]+$/g, '')
  return out || 'Untitled'
}
function joinRel(dir, name) {
  return !dir ? name : `${dir.replace(/\/+$/, '')}/${name}`
}
function sanitizeRel(rel) {
  const norm = String(rel || '').trim().replace(/\\/g, '/')
  const segs = []
  for (const s of norm.split('/').filter((x) => x !== '' && x !== '.')) {
    if (s === '..') return { err: true }
    segs.push(s)
  }
  return { ok: segs.join('/') }
}
function relpathFrom(docDir, target) {
  const from = String(docDir || '').split('/').filter(Boolean)
  const to = String(target || '').split('/').filter(Boolean)
  let i = 0
  while (i < from.length && i < to.length - 1 && from[i] === to[i]) i++
  const ups = from.length - i
  const rest = to.slice(i).join('/')
  return (ups ? '../'.repeat(ups) : '') + rest
}
const sha256Hex = (buf) => crypto.createHash('sha256').update(buf).digest('hex')

// ---------- 主转换 ----------
/**
 * @param {Buffer} buffer  .docx 字节
 * @param {object} opts    { titleOverride, destDir, dedupIndex, withFrontmatter, maxImageBytes, srcName }
 * @returns {{ md, title, slug, plannedDocRel, images, warnings, stats }}
 */
export function docxToMarkdown(buffer, opts = {}) {
  const warnings = []
  const stats = { words: 0, images: 0, tables: 0, mergedTables: 0, footnotes: 0, droppedTextboxes: 0, math: 0, xrefResolved: 0, xrefDegraded: 0 }
  const warn = (code, message, locator) => warnings.push({ code, message, locator: locator || '' })

  let zip
  try {
    zip = readZip(buffer)
  } catch (e) {
    throw new Error('docxInvalid: 无法解开该 .docx（' + ((e && e.message) || e) + '）')
  }
  if (!zip.document) throw new Error('docxInvalid: 缺少 word/document.xml')

  let tree
  try {
    tree = parser.parse(zip.document)
  } catch (e) {
    throw new Error('docxInvalid: document.xml 解析失败（' + ((e && e.message) || e) + '）')
  }

  const rels = parseRels(zip.rels)
  const styles = parseStyles(zip.styles)

  const srcName = opts.srcName || 'document.docx'
  const stem = srcName.includes('.') ? srcName.slice(0, srcName.lastIndexOf('.')) : srcName
  const bodyEl = findFirst(tree, 'body')
  if (!bodyEl) throw new Error('docxInvalid: document.xml 里找不到正文（w:body），可能不是 Word 存出的 .docx')

  const ctx = {
    rels, styles, zip, opts, warnings, stats, warn,
    images: [], imgSeen: new Map(), docDir: '',
    dedupIndex: opts.dedupIndex || {},
    maxImageBytes: Math.max(1, opts.maxImageBytes || 8 * 1024 * 1024),
  }

  // 标题：override → 首个标题段落 → 文件名主干
  const firstHeading = detectFirstHeading(bodyEl, ctx)
  const override = opts.titleOverride != null ? String(opts.titleOverride).trim() : ''
  const title = override || firstHeading || stem
  const slug = slugify(title)
  const dest = sanitizeRel(opts.destDir || '')
  if (dest.err) throw new Error('docxInvalid: 非法的目标目录')
  ctx.docDir = joinRel(dest.ok, slug)

  const blocks = mapBody(bodyEl, ctx)
  let md = blocks.filter((b) => b != null).join('\n\n')
  if (!md.trim()) ctx.warn('emptyDoc', '未解析出正文内容（空文档，或格式不被网页解析支持）', '')
  if (opts.withFrontmatter) {
    const imported = localDate()
    md = `---\nsource: "${srcName}"\nimported: "${imported}"\n---\n\n` + md
  }
  stats.words = countWords(md)

  return { md, title, slug, plannedDocRel: joinRel(ctx.docDir, `${slug}.md`), images: ctx.images, warnings, stats }
}

function localDate() {
  const d = new Date()
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}
function countWords(md) {
  const ascii = (md.match(/[A-Za-z0-9]+/g) || []).length
  const cjk = (md.match(/[\u4e00-\u9fff]/g) || []).length
  return ascii + cjk
}
function findFirst(node, wantLocal) {
  let found = null
  walkAll(node, (n) => {
    if (!found && local(n) === wantLocal) found = n
  })
  return found
}

/** 一个段落是否标题样式，回标题级别（1..6）或 null */
function headingLevel(pEl, ctx) {
  const pPr = childEl(pEl, 'pPr')
  const styleId = pPr && childEl(pPr, 'pStyle') ? attr(childEl(pPr, 'pStyle'), 'w:val') : null
  if (styleId) {
    const m = /^heading([1-6])$/i.exec(styleId)
    if (m) return Number(m[1])
    if (/^title$/i.test(styleId)) return 1
    const st = ctx.styles.get(styleId)
    if (st) {
      if (st.outline != null) return Math.min(6, st.outline + 1)
      const nm = /^heading\s*([1-6])$/i.exec(st.name || '')
      if (nm) return Number(nm[1])
      if (/^title$/i.test(st.name || '')) return 1
    }
  }
  if (pPr) {
    const ol = childEl(pPr, 'outlineLvl')
    if (ol) {
      const v = parseInt(attr(ol, 'w:val'), 10)
      if (!Number.isNaN(v)) return Math.min(6, v + 1)
    }
  }
  return null
}
function childEl(n, wantLocal) {
  for (const c of kids(n)) if (local(c) === wantLocal) return c
  return null
}

function detectFirstHeading(bodyEl, ctx) {
  if (!bodyEl) return null
  for (const c of kids(bodyEl)) {
    if (local(c) !== 'p') continue
    if (headingLevel(c, ctx)) return textOf(c).trim() || null
  }
  return null
}

// ---------- 正文块 ----------
// 顶层可无声跳过的元素：节属性、结构锚点、编辑限制、各种 *Pr 属性袋
const BODY_SKIP = new Set([
  'sectPr', 'sdtPr', 'sdtEndPr', 'customXmlPr', 'smartTagPr',
  'bookmarkStart', 'bookmarkEnd', 'commentRangeStart', 'commentRangeEnd',
  'proofErr', 'permStart', 'permEnd',
  'moveFromRangeStart', 'moveFromRangeEnd', 'moveToRangeStart', 'moveToRangeEnd',
])

function mapBody(bodyEl, ctx) {
  if (!bodyEl) return []
  const out = []
  for (const c of kids(bodyEl)) {
    if (isText(c)) continue
    const l = local(c)
    if (l === 'p') out.push(mapParagraph(c, ctx))
    else if (l === 'tbl') out.push(mapTable(c, ctx))
    else if (l === 'sdt') {
      // 内容控件（Word Online / 模板常见）：外壳跳过，sdtContent 里的块照常映射
      const content = childEl(c, 'sdtContent')
      if (content) out.push(...mapBody(content, ctx))
    } else if (l === 'customXml' || l === 'smartTag') {
      // 同 sdt：一层包装外壳，直接拆开取内容
      out.push(...mapBody(c, ctx))
    } else if (!BODY_SKIP.has(l)) {
      // 其余顶层块（AltChunk、未登记的自定义元素）：解析不了，丢内容可以，但要出声
      ctx.warn('blockDropped', `不支持的块级元素 <w:${l}> 已跳过`, '')
    }
  }
  return out
}

function mapParagraph(pEl, ctx) {
  const inline = inlineOf(pEl, ctx)
  const trimmed = inline.trim()
  if (!trimmed) return ''
  const lvl = headingLevel(pEl, ctx)
  if (lvl) return '#'.repeat(lvl) + ' ' + trimmed
  const pPr = childEl(pEl, 'pPr')
  const numPr = pPr && childEl(pPr, 'numPr')
  if (numPr) {
    const ilvlEl = childEl(numPr, 'ilvl')
    const ilvl = ilvlEl ? parseInt(attr(ilvlEl, 'w:val'), 10) || 0 : 0
    return '  '.repeat(ilvl) + '- ' + trimmed
  }
  return inline.replace(/\s+$/, '')
}

/** 收集一个块容器（段落/单元格）里的行内内容 */
function inlineOf(node, ctx) {
  let s = ''
  for (const c of kids(node)) {
    if (isText(c)) continue
    const l = local(c)
    if (l === 'pPr') continue // 段落属性不算文本
    if (l === 'r') s += runInline(c, ctx)
    else if (l === 'hyperlink') s += hyperlinkInline(c, ctx)
    else if (l === 'ins') s += inlineOf(c, ctx) // 修订插入：取内容
    else if (l === 'del') { /* 修订删除：丢弃 */ }
    else if (l === 'oMath' || l === 'oMathPara') {
      ctx.stats.math++
      ctx.warn('mathDropped', '公式已降级为文本（网页解析不支持数学渲染）', '')
      s += textOf(c)
    } else if (l === 'fldSimple') {
      ctx.stats.xrefDegraded++
      ctx.warn('fieldDropped', '域代码已降级为可见文本', attr(c, 'w:instr') || '')
      s += inlineOf(c, ctx)
    } else if (l === 'instrText') {
      // 域指令片段（复杂域的一部分）：吞掉，由 fldChar 外层处理
      ctx.warn('fieldDropped', '域代码已降级为可见文本', textOf(c).trim())
    } else if (l === 'txbxContent') {
      ctx.stats.droppedTextboxes++
      ctx.warn('textboxDropped', '文本框内容已丢弃', '')
    } else if (l === 'footnoteReference' || l === 'endnoteReference') {
      ctx.stats.footnotes++
      ctx.warn('footnoteDropped', '脚注/尾注引用已降级（网页解析不展开脚注）', '')
    } else if (l === 'bookmarkStart' || l === 'bookmarkEnd' || l === 'commentReference') {
      // 结构锚点，忽略
    } else s += inlineOf(c, ctx)
  }
  return s
}

function runInline(rEl, ctx) {
  let plain = ''
  for (const c of kids(rEl)) {
    const l = local(c)
    if (l === 't') plain += textOf(c)
    else if (l === 'tab') plain += ' '
    else if (l === 'br') plain += '  \n'
    else if (l === 'cr') plain += '  \n'
    else if (l === 'drawing') plain += drawingInline(c, ctx)
    else if (l === 'pict') plain += drawingInline(c, ctx)
    else if (l === 'rPr') continue
  }
  if (!plain) return ''
  const rPr = childEl(rEl, 'rPr')
  const b = rPr && childEl(rPr, 'b') ? attr(childEl(rPr, 'b'), 'w:val') !== 'false' && attr(childEl(rPr, 'b'), 'w:val') !== '0' : false
  const i = rPr && childEl(rPr, 'i') ? attr(childEl(rPr, 'i'), 'w:val') !== 'false' && attr(childEl(rPr, 'i'), 'w:val') !== '0' : false
  const s = rPr && (childEl(rPr, 'strike') || childEl(rPr, 'dstrike')) ? true : false
  return wrapEmphasis(plain, { b, i, s })
}

function wrapEmphasis(t, { b, i, s }) {
  if (!t.trim()) return t
  let out = t
  if (i) out = '*' + out + '*'
  if (b) out = '**' + out + '**'
  if (s) out = '~~' + out + '~~'
  return out
}

function hyperlinkInline(hEl, ctx) {
  const text = inlineOf(hEl, ctx).trim()
  const rid = attr(hEl, 'r:id')
  const anchor = attr(hEl, 'w:anchor')
  if (rid && ctx.rels.has(rid)) {
    const { target, external } = ctx.rels.get(rid)
    const url = external ? target : target.replace(/^#/, '')
    return `[${text || url}](${url})`
  }
  if (anchor) {
    ctx.stats.xrefDegraded++
    ctx.warn('xrefDegraded', '文档内交叉引用已降级为文本', anchor)
    return text
  }
  return text
}

function drawingInline(node, ctx) {
  let blip = null
  walkAll([node], (n) => {
    if (!blip && local(n) === 'blip') blip = n
  })
  let descr = ''
  walkAll([node], (n) => {
    if (local(n) === 'docPr') descr = attr(n, 'descr') || descr
  })
  const rid = blip && attr(blip, 'r:embed')
  if (!rid || !ctx.rels.has(rid)) {
    ctx.warn('imageDropped', '图片无法定位（缺关系或外链），已跳过', rid || '')
    return ''
  }
  const target = ctx.rels.get(rid).target
  return pushImageByTarget(target, descr, ctx)
}

function pushImageByTarget(target, alt, ctx) {
  const clean = String(target).replace(/\\/g, '/').replace(/^\/+/, '')
  const entryName = clean.startsWith('word/') ? clean : 'word/' + clean
  let buf = ctx.zip.map.get(entryName)
  if (!buf) buf = ctx.zip.map.get('../' + clean) // 极少见的相对写法
  if (!buf) {
    ctx.warn('imageDropped', '图片数据缺失：' + clean, clean)
    return ''
  }
  const ext = (clean.includes('.') ? clean.split('.').pop() : 'png').toLowerCase()
  const sha = sha256Hex(buf)
  const fname = `${sha.slice(0, 12)}.${ext}`
  if (ctx.imgSeen.has(sha)) {
    // 同一文档内同图收敛为一份
    const ref = ctx.imgSeen.get(sha)
    return `![${alt || ''}](${ref})`
  }
  if (buf.length > ctx.maxImageBytes) {
    ctx.warn('imageTooLarge', `图片超过 ${Math.round(ctx.maxImageBytes / 1024 / 1024)}MB，已省略`, fname)
    ctx.imgSeen.set(sha, '')
    return ''
  }
  let plannedRel, ref, reused = false
  const existing = ctx.dedupIndex[sha]
  if (existing) {
    reused = true
    plannedRel = existing
    ref = relpathFrom(ctx.docDir, existing)
  } else {
    plannedRel = joinRel(ctx.docDir, fname)
    ref = fname
  }
  ctx.images.push({ sha256: sha, ext, dataB64: buf.toString('base64'), plannedRel, reused, bytes: buf.length })
  ctx.imgSeen.set(sha, ref)
  ctx.stats.images++
  return `![${alt || ''}](${ref})`
}

// ---------- 表格 ----------
function mapTable(tblEl, ctx) {
  ctx.stats.tables++
  const rows = kids(tblEl).filter((r) => local(r) === 'tr')
  const grid = rows.map((tr) => kids(tr).filter((c) => local(c) === 'tc').map((tc) => cellText(tc, ctx)))
  // 合并单元格：gridSpan / vMerge 存在即视为复杂表，降级为普通网格 + warning
  if (hasMerge(tblEl)) {
    ctx.stats.mergedTables++
    ctx.warn('mergedTable', '含合并单元格的表格已按矩形网格降级', '')
  }
  if (!grid.length) return ''
  const width = Math.max(...grid.map((r) => r.length))
  for (const r of grid) while (r.length < width) r.push('')
  const esc = (s) => String(s).replace(/\|/g, '\\|').replace(/\n/g, ' ')
  const head = grid[0].map(esc)
  const sep = new Array(width).fill('---')
  const lines = ['| ' + head.join(' | ') + ' |', '| ' + sep.join(' | ') + ' |']
  for (const r of grid.slice(1)) lines.push('| ' + r.map(esc).join(' | ') + ' |')
  return lines.join('\n')
}
function cellText(tcEl, ctx) {
  const parts = []
  for (const c of kids(tcEl)) {
    if (local(c) === 'p') {
      const t = inlineOf(c, ctx).trim()
      if (t) parts.push(t)
    }
  }
  return parts.join(' ')
}
function hasMerge(tblEl) {
  let found = false
  walkAll([tblEl], (n) => {
    const l = local(n)
    if (l === 'gridSpan' || l === 'vMerge') found = true
  })
  return found
}
