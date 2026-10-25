// print-paged.js —— Ctrl+P 打印排版增强（Paged.js 预分页）
//
// 设计见 docs/superpowers/specs/2026-10-25-print-pagedjs-design.md：
//  纯函数（锚点 / 目录 / 打印样式 / 选项存取）与 DOM 编排（printPaged）都在本模块，
//  前半可离线单测；预分页本体依赖真实布局引擎，归真机验收。

import { anchorSlug } from './heading-anchor.js'
import { getLocale, t } from './i18n.js'
import { numberingCss } from './heading-numbering.js'

// ============ 选项存取（localStorage，UI 偏好不进 settings.json） ============

export const PRINT_OPTIONS_KEY = 'nl-print-options'

// 首次默认只勾页码 + 页眉（最接近普通打印）；此后记住上次选择
export const DEFAULT_PRINT_OPTIONS = { toc: false, pageNumbers: true, h1Break: false, cover: false }

export function savePrintOptions(options) {
  try {
    localStorage.setItem(PRINT_OPTIONS_KEY, JSON.stringify(options || {}))
  } catch { /* 存储不可用时静默，下次仍按默认 */ }
}

export function loadPrintOptions() {
  const out = { ...DEFAULT_PRINT_OPTIONS }
  try {
    const raw = JSON.parse(localStorage.getItem(PRINT_OPTIONS_KEY))
    if (raw && typeof raw === 'object') {
      for (const key of Object.keys(DEFAULT_PRINT_OPTIONS)) {
        if (typeof raw[key] === 'boolean') out[key] = raw[key]
      }
    }
  } catch { /* 坏 JSON 回落默认 */ }
  return out
}

// ============ 锚点与目录 ============

/**
 * 给 rootEl 内的 H1/H2 补 id（已有 id 不覆盖，纯符号标题 slug 为空则跳过）。
 * @returns {number} 补上的数量
 */
export function assignHeadingIds(rootEl) {
  let count = 0
  for (const h of rootEl.querySelectorAll('h1, h2')) {
    if (h.id) continue
    const slug = anchorSlug(h.textContent || '')
    if (!slug) continue
    h.id = slug
    count++
  }
  return count
}

/**
 * 按文档序提取 H1/H2（文本取 textContent，空标题跳过；id 读已有——调用序：先 assignHeadingIds）。
 * @returns {Array<{ level: 1|2, text: string, id: string }>}
 */
export function buildTocNodes(rootEl) {
  const nodes = []
  for (const h of rootEl.querySelectorAll('h1, h2')) {
    const text = (h.textContent || '').trim()
    if (!text || !h.id) continue
    nodes.push({ level: h.tagName === 'H1' ? 1 : 2, text, id: h.id })
  }
  return nodes
}

// ============ 打印样式 ============

// @page 边注的 CSS 字符串里标题要转义，引号 / 反斜杠不转义会让整条 @page 静默失效
function escapeCss(s) {
  return String(s == null ? '' : s).replace(/[\\"]/g, (c) => '\\' + c)
}

/**
 * 按勾选拼打印 CSS（Paged.js Previewer 只处理传给它的 styles，页面样式表不参与分页）。
 * @param {{ toc: boolean, pageNumbers: boolean, h1Break: boolean, cover: boolean, headingNumbering?: boolean }} options
 * @param {string} title 页眉标题（转义后进 @top-center）
 */
export function printStyles(options, title) {
  const o = options || {}
  const chunks = []
  chunks.push('@page { margin: 18mm 20mm; }')
  // 排版件之外的基版：克隆进来的 ProseMirror DOM 带的是屏幕样式类，纸面排印自给
  chunks.push(
    '.nl-print-doc { font-family: -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; font-size: 11pt; line-height: 1.65; color: #111; }' +
    '.nl-print-doc h1 { font-size: 1.7em; margin: 1.2em 0 .6em; }' +
    '.nl-print-doc h2 { font-size: 1.4em; margin: 1.1em 0 .5em; }' +
    '.nl-print-doc h3 { font-size: 1.2em; margin: 1em 0 .5em; }' +
    '.nl-print-doc code { font-family: Consolas, monospace; background: rgba(127,127,127,.12); padding: .1em .35em; border-radius: 4px; font-size: .9em; }' +
    '.nl-print-doc pre { background: rgba(127,127,127,.08); padding: 10px 12px; border-radius: 6px; white-space: pre-wrap; word-break: break-word; }' +
    '.nl-print-doc pre code { background: none; padding: 0; }' +
    '.nl-print-doc table { border-collapse: collapse; margin: 1em 0; width: 100%; }' +
    '.nl-print-doc th, .nl-print-doc td { border: 1px solid #ccc; padding: 5px 9px; }' +
    '.nl-print-doc img { max-width: 100%; }' +
    '.nl-print-doc a { color: inherit; }',
  )
  if (o.pageNumbers) {
    chunks.push(
      '@page {' +
      `@bottom-center { content: counter(page); font-size: 9pt; color: #666; }` +
      `@top-center { content: "${escapeCss(title)}"; font-size: 9pt; color: #666; }` +
      '}' +
      '@page :first { @top-center { content: none; } }',
    )
  }
  if (o.toc) {
    chunks.push(
      '.nl-ptoc { break-after: page; }' +
      '.nl-ptoc-title { font-size: 1.5em; font-weight: 650; margin: 0 0 1em; }' +
      '.nl-ptoc a { display: block; text-decoration: none; color: inherit; }' +
      '.nl-ptoc a.lv2 { padding-left: 1.5em; }' +
      '.nl-ptoc a::after { content: " " target-counter(attr(href url), page); }',
    )
  }
  if (o.cover) {
    chunks.push(
      '.nl-pcover { break-after: page; display: flex; flex-direction: column; justify-content: center; align-items: center; height: 100%; text-align: center; }' +
      '.nl-pcover-title { font-size: 2.2em; font-weight: 700; }' +
      '.nl-pcover-date { margin-top: 1.5em; color: #666; }',
    )
  }
  if (o.h1Break) {
    // 首个 H1 例外：封面 / 目录之后直接空出首页没有意义
    chunks.push('.nl-pbody h1 { break-before: page; } .nl-pbody h1:first-child { break-before: auto; }')
  }
  if (o.headingNumbering) {
    // 开关在设置页（features.headingNumbering），main.js 并进 options 传入
    chunks.push(numberingCss('.nl-pbody'))
  }
  return chunks.join('\n')
}

// ============ 编排：克隆 → 排版件 → 预分页 → 打印 → 清理 ============

/**
 * 打印排版主链路（Ctrl+P 确认选项后调用）。
 * @param {{ toc: boolean, pageNumbers: boolean, h1Break: boolean, cover: boolean, headingNumbering?: boolean }} options
 * @param {string} title 页眉 / 封面标题（main.js 传当前文件名主干）
 *  焦点窗格取不到内容时直接 window.print()（空态兜底）；预分页抛错向上抛，
 *  `#print-root` 与 body 标记在 finally 里摘除——打印完与抛错两条路都不留残骸。
 */
export async function printPaged(options, title = '') {
  const sourceEl = document.querySelector('.nl-pane.focused .ProseMirror')
  if (!sourceEl) {
    window.print()
    return
  }

  const doc = document.createElement('div')
  doc.className = 'nl-print-doc'

  if (options.cover) {
    const cover = document.createElement('div')
    cover.className = 'nl-pcover'
    const coverTitle = document.createElement('div')
    coverTitle.className = 'nl-pcover-title'
    coverTitle.textContent = title || t('print.untitled')
    const coverDate = document.createElement('div')
    coverDate.className = 'nl-pcover-date'
    coverDate.textContent = new Date().toLocaleDateString(getLocale())
    cover.append(coverTitle, coverDate)
    doc.appendChild(cover)
  }

  // 克隆屏幕上已渲染的节点：图片是 data URI、公式与 mermaid 已出图，应用内重渲染反而会裂图
  const clone = sourceEl.cloneNode(true)
  assignHeadingIds(clone)

  if (options.toc) {
    const nodes = buildTocNodes(clone)
    if (nodes.length) {
      const toc = document.createElement('div')
      toc.className = 'nl-ptoc'
      const tocTitle = document.createElement('div')
      tocTitle.className = 'nl-ptoc-title'
      tocTitle.textContent = t('dlg.printTocHeading')
      toc.appendChild(tocTitle)
      for (const n of nodes) {
        const a = document.createElement('a')
        a.href = '#' + n.id
        if (n.level === 2) a.className = 'lv2'
        a.textContent = n.text
        toc.appendChild(a)
      }
      doc.appendChild(toc)
    }
  }

  const pbody = document.createElement('div')
  pbody.className = 'nl-pbody'
  pbody.appendChild(clone)
  doc.appendChild(pbody)

  const printRoot = document.createElement('div')
  printRoot.id = 'print-root'
  printRoot.appendChild(doc)
  document.body.appendChild(printRoot)
  document.body.setAttribute('data-paged-print', '')

  try {
    // 动态 import：pagedjs 只在真打印时加载，node 单测不必拖它进来
    const { Previewer } = await import('pagedjs')
    const previewer = new Previewer()
    await previewer.preview(doc, [printStyles(options, title)], printRoot)
    window.print()
  } finally {
    if (printRoot.parentNode) printRoot.parentNode.removeChild(printRoot)
    document.body.removeAttribute('data-paged-print')
  }
}
