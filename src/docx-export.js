// docx-export.js —— 批次 F 子项目①：当前 ProseMirror 文档 → Docx-IR（JSON 节点树）
//
// 分工（见 docs/superpowers/specs/2026-10-16-docx-export-math-design.md §三）：
//   前端只做「理解语义」——遍历编辑器 doc，把方言构造（frontmatter / wikilink / callout / tag /
//   math / footnote）判定并降级为 Docx-IR；Rust（src-tauri/src/docx_export.rs）负责组装 OOXML。
//   方言判定只此一次，不在 Rust 侧重复。
//
// 为何遍历 PM doc 而非 markdown 文本：脚注/callout/math/wiki/tag 在模型层都是一等节点、attrs 干净，
//   直接读节点比再解析 md 更稳（frontmatter 由调用方剥离后再传入 doc，本模块只看正文）。
//
// IR 契约与 Rust serde 结构一一对应（block 以 type 判别，camelCase）；详见 docx_export.rs 顶部定义。

import { parseMarkdown } from './editor-schema.js'
import { htmlToPlain } from './html-sanitize.js'

// —— 行内收集：把一段落/单元格/列表项的 inline 子节点摊平成 IRInline[] ——
function collectInline(parent, ctx) {
  const out = []
  parent.forEach((node) => {
    if (node.isText) {
      const run = { text: node.text || '' }
      for (const m of node.marks) {
        switch (m.type.name) {
          case 'strong': run.bold = true; break
          case 'em': run.italic = true; break
          case 'strike': run.strike = true; break
          case 'code': run.code = true; break
          case 'link': run.link = (m.attrs && m.attrs.href) || ''; break
          default: break // 其余标记（如自定义）忽略
        }
      }
      if (run.text) out.push(run)
      return
    }
    switch (node.type.name) {
      case 'image':
        out.push({ image: { rel: node.attrs.src || '', width: node.attrs.width || null } })
        break
      case 'wikiLink':
        // 跨笔记链接无法在 Word 内导航 → 降级为可见文字（标签优先）。
        out.push({ text: node.attrs.label || node.attrs.target || '' })
        break
      case 'tag':
        out.push({ text: '#' + (node.attrs.tag || '') })
        break
      case 'math_inline':
        // ① 阶段：数学降级为纯文本（latex 原样保留）；③ 再换 OMML。
        out.push({ text: node.attrs.latex || '', math: true })
        break
      case 'footnote_ref': {
        const id = ctx.fnNumber(String(node.attrs.id || ''))
        if (id != null) out.push({ footnote: id })
        break
      }
      case 'hard_break':
        out.push({ text: ' ' }) // 降级为空格（Word 软换行留待后续）
        break
      default:
        // 未知内联：尽力取其文本
        if (node.textContent) out.push({ text: node.textContent })
    }
  })
  return out
}

// —— 块级：把 doc 顶层子节点映射为 IRBlock[] ——
function blockToIR(node, ctx, blocks) {
  switch (node.type.name) {
    case 'heading':
      blocks.push({ type: 'heading', level: Math.min(6, Math.max(1, node.attrs.level || 1)), inline: collectInline(node, ctx) })
      break
    case 'paragraph':
      blocks.push({ type: 'paragraph', inline: collectInline(node, ctx) })
      break
    case 'code_block': {
      const lang = (node.attrs.params || '').trim().split(/\s+/)[0] || null
      blocks.push({ type: 'code', text: node.textContent || '', lang })
      break
    }
    case 'math_block':
      // 块级公式：① 降级为一个含纯文本 latex 的段落。
      blocks.push({ type: 'paragraph', inline: [{ text: node.attrs.latex || '', math: true }] })
      break
    case 'html_block': {
      // 字面 HTML 块：Word 侧没有对应结构，降级为可见文字（不静默丢内容，也不把标签原样塞进正文）
      const text = htmlToPlain(node.attrs.source)
      if (text) blocks.push({ type: 'paragraph', inline: [{ text }] })
      break
    }
    case 'blockquote':
      // 导入侧无引用概念；仍产出 Quote 供 Word 缩进保真。多子块拆成多条 Quote。
      flattenToQuote(node, ctx, blocks)
      break
    case 'callout': {
      const title = node.attrs.title || node.attrs.type || ''
      if (title) blocks.push({ type: 'quote', inline: [{ text: title, bold: true }] })
      flattenToQuote(node, ctx, blocks)
      break
    }
    case 'bullet_list':
    case 'ordered_list': {
      const items = []
      collectList(node, node.type.name === 'ordered_list', 0, items, ctx)
      blocks.push({ type: 'list', ordered: node.type.name === 'ordered_list', items })
      break
    }
    case 'table':
      blocks.push(buildTable(node, ctx))
      break
    case 'horizontal_rule':
      // Word 分隔线留待后续；此处不产块（跳过）。
      break
    case 'footnote_section':
      // 定义已在 ctx.fnMap 收集；每个 item 作为 FootnoteDef 块输出。
      node.forEach((item) => {
        const id = ctx.fnNumber(String(item.attrs.id || ''))
        // 空 id 的孤立定义（无对应正文引用）：fnNumber 返回 null，若照发会让 Rust
        // FootnoteDef.id(usize) 反序列化失败（invalid type: null）。与 footnote_ref 同样跳过。
        if (id == null) return
        const para = item.firstChild
        blocks.push({ type: 'footnoteDef', id, inline: para ? collectInline(para, ctx) : [] })
      })
      break
    default:
      // 未知块：尽力当作段落
      if (node.textContent && node.textContent.trim()) {
        blocks.push({ type: 'paragraph', inline: [{ text: node.textContent }] })
      }
  }
}

// 引用/callout 内层摊平为 Quote：段落→一条 quote（其 inline）；列表/代码等降级为其文本行。
function flattenToQuote(container, ctx, blocks) {
  container.forEach((child) => {
    if (child.type.name === 'paragraph') {
      const inline = collectInline(child, ctx)
      if (inline.length) blocks.push({ type: 'quote', inline })
    } else if (child.type.name === 'bullet_list' || child.type.name === 'ordered_list') {
      const items = []
      collectList(child, child.type.name === 'ordered_list', 0, items, ctx)
      blocks.push({ type: 'list', ordered: child.type.name === 'ordered_list', items })
    } else if (child.type.textContent && child.type.textContent.trim()) {
      blocks.push({ type: 'quote', inline: [{ text: child.textContent }] })
    }
  })
}

// 列表递归摊平为带 level 的扁平 items（嵌套子表 level+1，继承父 ordered；简化）。
function collectList(listNode, ordered, level, items, ctx) {
  listNode.forEach((li) => {
    let inline = []
    const subs = []
    li.forEach((ch) => {
      if (ch.type.name === 'bullet_list' || ch.type.name === 'ordered_list') subs.push(ch)
      else if (ch.type.name === 'paragraph') inline = inline.concat(collectInline(ch, ctx))
    })
    const checked = li.attrs && li.attrs.checked != null ? !!li.attrs.checked : undefined
    const item = { level, inline }
    if (checked !== undefined) item.checked = checked
    items.push(item)
    for (const sub of subs) collectList(sub, sub.type.name === 'ordered_list', level + 1, items, ctx)
  })
}

// 表格 → IR：首行若为 table_header 视作表头；单元格取段落 inline 合并。合并单元格暂按网格展平（记警告）。
function buildTable(tableNode, ctx) {
  const rows = []
  tableNode.forEach((row) => {
    const cells = []
    let isHeader = false
    row.forEach((cell) => {
      if (cell.type.name === 'table_header') isHeader = true
      // 此 schema 下单元格直接承载 inline（无包裹段落），故从单元格本身收集。
      cells.push(collectInline(cell, ctx))
    })
    rows.push({ header: isHeader, cells })
  })
  let header = null
  const dataRows = []
  for (let i = 0; i < rows.length; i++) {
    if (i === 0 && rows[i].header) header = rows[i].cells
    else dataRows.push(rows[i].cells)
  }
  const block = { type: 'table', header, rows: dataRows }
  return block
}

// 脚注 id（字符串）→ Word 数字序号：按文末 footnote_section 出现顺序稳定编号，正文引用与定义共用命名空间。
function makeCtx(doc) {
  const fnMap = new Map()
  let counter = 0
  doc.forEach((top) => {
    if (top.type.name === 'footnote_section') {
      top.forEach((item) => {
        const key = String(item.attrs && item.attrs.id ? item.attrs.id : '')
        if (key && !fnMap.has(key)) fnMap.set(key, ++counter)
      })
    }
  })
  return {
    fnNumber(idKey) {
      if (!idKey) return null
      if (fnMap.has(idKey)) return fnMap.get(idKey)
      fnMap.set(idKey, ++counter) // 正文有引用但文末无定义：兜底分配
      return fnMap.get(idKey)
    },
  }
}

/** 遍历 ProseMirror doc → Docx-IR（{ title, blocks }）。frontmatter 应由调用方先行剥离。 */
export function docToIR(doc) {
  const ctx = makeCtx(doc)
  const blocks = []
  doc.forEach((node) => blockToIR(node, ctx, blocks))
  return { title: null, blocks }
}

/** 便捷：Markdown 正文串 → doc → IR（供单测与无编辑器上下文复用）。 */
export function mdToIR(mdBody) {
  return docToIR(parseMarkdown(mdBody || ''))
}
