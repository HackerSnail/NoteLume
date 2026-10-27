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
  chunks.push('@page { size: A4; margin: 18mm 20mm; }')
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

// ============ 编排：克隆 → 排版件 → 预分页 → 打印 / 出 PDF → 清理 ============

// 分页是一页一帧推出来的：Paged.js 的排版队列 `Queue.tick` 挂在 requestAnimationFrame 上，
// 窗口被遮挡 / 最小化时 WebKit 不再出帧，队列就停在半路（真实 WebKit 探针复现过：页面盒数
// 恒定不动，而 setInterval 照跑）。没有上限的话状态栏会一直停在「正在排版…」，
// 所以到点按排版失败处理——打印退回普通打印，导出给出错误提示。
const PREVIEW_TIMEOUT_MS = 60_000

/**
 * 关掉 Paged.js 挂在每个页面盒上的重排监听（`Page.removeListeners`）。
 * 这些监听是为了「页面内容变了就重排该页」，而排版一旦完成，逐页尺寸就该定死了；
 * 截取态改容器 transform、teardown 摘 #print-root 都会让回调落到已经被移走的节点上，
 * 进 `findEndToken` → `findElement` 读 null 的 `data-ref`。Blink 侧同一条链路 A/B：
 * 不关监听时四组夹具（9 / 7 / 3 / 22 页）抛 6 / 6 / 0 / 19 条
 * 「reading 'getAttribute'」，关掉后四组都是 0。更要紧的是逐页截取途中重排会把
 * 正在截的那一页换掉。
 */
function stopPagedObservers(chunker) {
  for (const page of (chunker && chunker.pages) || []) {
    if (typeof page.removeListeners === 'function') page.removeListeners()
  }
}

/**
 * 预分页共用链路：克隆焦点窗格 → 封面 / 目录 → Paged.js 分页。
 * @returns {Promise<{printRoot: HTMLElement, chunker: object}|null>} 挂好的容器与排版器
 *  （排版器用来关掉页面盒上的重排监听）。取不到焦点窗格返回 null；预览抛错或超时先把已挂载
 *  的容器摘干净再向上抛，调用方不必管残骸。
 */
async function previewPaged(options, title) {
  const sourceEl = document.querySelector('.nl-pane.focused .ProseMirror')
  if (!sourceEl) return null

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

  // 动态 import：pagedjs 只在真打印时加载，node 单测不必拖它进来
  const { Previewer } = await import('pagedjs')
  const previewer = new Previewer()
  // stylesheets 参数是「URL → CSS 文本」的对象：直接传 CSS 字符串会被当成 URL 去 fetch，
  // 拿回整份 index.html 再按 CSS 解析，报「... is not a valid selector」
  const running = previewer.preview(doc, [{ 'notelume-print.css': printStyles(options, title) }], printRoot)
  // 超时只是不再等它，这一路之后还会自己 settle；不接住就是一条无人处理的 rejection
  running.catch(() => {})
  let timer
  try {
    await Promise.race([
      running,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(t('print.timeout'))), PREVIEW_TIMEOUT_MS)
      }),
    ])
    clearTimeout(timer)
    // Paged.js 插进 head 的 @page 同时管着纸面：这里补一条更靠后的，把纸面钉成 A4 零边距，
    // 18mm/20mm 只留在页面盒内当版心，否则每个页面盒会被纸面边距再缩一次、还会被劈成两页
    const paper = document.createElement('style')
    paper.id = 'nl-print-paper'
    paper.textContent = '@media print { @page { size: 210mm 297mm; margin: 0 } }'
    document.head.appendChild(paper)
  } catch (e) {
    clearTimeout(timer)
    teardown(printRoot)
    throw e
  }
  return { printRoot, chunker: previewer.chunker }
}

function teardown(printRoot) {
  if (printRoot && printRoot.parentNode) printRoot.parentNode.removeChild(printRoot)
  document.body.removeAttribute('data-paged-print')
  document.body.removeAttribute('data-nl-pdf')
  for (const id of ['nl-pdf-capture', 'nl-print-paper']) {
    const el = document.getElementById(id)
    if (el) el.remove()
  }
  // Paged.js 每次 preview 都往 head 追加解析后的样式表，不清会带着上一篇的页眉一直堆下去
  for (const el of document.querySelectorAll('[data-pagedjs-inserted-styles]')) el.remove()
}

/**
 * 逐页截取几何（CSS 像素、网页坐标系）：每个 Paged.js 页面盒一个矩形。
 * 截取态把整叠页缩到 0.75，让盒宽从 794px（210mm @96dpi）回到 595px，
 * 配合 createPDF 的 1px = 1pt，出来的就是标准 A4（595×842pt）而不是 1.33 倍大的纸。
 */
function capturePages(printRoot) {
  const boxes = [...printRoot.querySelectorAll('.pagedjs_page')]
  if (!boxes.length) throw new Error('paged layout produced no pages')
  return boxes.map((el) => {
    const b = el.getBoundingClientRect()
    return { x: b.left + window.scrollX, y: b.top + window.scrollY, width: b.width, height: b.height }
  })
}

/**
 * 打印排版主链路（Ctrl+P 确认选项后调用）。
 * @param {{ toc: boolean, pageNumbers: boolean, h1Break: boolean, cover: boolean, headingNumbering?: boolean }} options
 * @param {string} title 页眉 / 封面标题（main.js 传当前文件名主干）
 *  焦点窗格取不到内容时直接 window.print()（空态兜底）；预分页抛错或超时向上抛，
 *  调用方（main.js printViaDialog）按「排版失败」退回普通打印。
 */
export async function printPaged(options, title = '') {
  const laid = await previewPaged(options, title)
  if (!laid) {
    window.print()
    return
  }
  const { printRoot, chunker } = laid
  try {
    stopPagedObservers(chunker)
    window.print()
  } finally {
    teardown(printRoot)
  }
}

/**
 * 导出 PDF 主链路（mac）：预分页后把每个页面盒交给 `onSave(rects)` 逐页截取，不弹打印面板。
 * @param {Function} onSave 拿到逐页矩形后写文件，返回 Promise
 */
export async function exportPdf(options, title = '', onSave) {
  const laid = await previewPaged(options, title)
  if (!laid) throw new Error('no focused pane')
  const { printRoot, chunker } = laid
  stopPagedObservers(chunker)
  const style = document.createElement('style')
  style.id = 'nl-pdf-capture'
  style.textContent = captureCss()
  document.head.appendChild(style)
  document.body.setAttribute('data-nl-pdf', '')
  window.scrollTo(0, 0)
  try {
    await onSave(capturePages(printRoot))
  } finally {
    teardown(printRoot)
  }
}

// 截取态样式不带媒体限定：createPDF 实测按网页坐标截 rect、忽略 @page size，
// 无论它用哪种介质，屏上都只剩 #print-root 这一叠页。
function captureCss() {
  return (
    '@page { margin: 0 }' +
    'body[data-nl-pdf] > :not(#print-root) { display: none !important; }' +
    'body[data-nl-pdf] #print-root { position: static; left: auto; top: 0; width: auto;' +
    ' transform: scale(.75); transform-origin: 0 0; }' +
    '#print-root .pagedjs_page { margin: 0 !important; box-shadow: none !important; }'
  )
}
