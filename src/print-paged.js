// print-paged.js —— Ctrl+P 打印排版增强（Paged.js 预分页）
//
// 设计见 docs/superpowers/specs/2026-10-25-print-pagedjs-design.md：
//  纯函数（锚点 / 目录 / 打印样式 / 选项存取）与 DOM 编排（printPaged）都在本模块，
//  前半可离线单测；预分页本体依赖真实布局引擎，归真机验收。

import { anchorSlug } from './heading-anchor.js'

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
 * @param {{ toc: boolean, pageNumbers: boolean, h1Break: boolean, cover: boolean }} options
 * @param {string} title 页眉标题（转义后进 @top-center）
 */
export function printStyles(options, title) {
  const o = options || {}
  const chunks = []
  chunks.push('@page { margin: 18mm 20mm; }')
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
  return chunks.join('\n')
}
