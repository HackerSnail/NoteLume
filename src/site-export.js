// site-export.js —— 批次 C：整库导出 HTML 静态站（纯逻辑 + 渲染；Tauri I/O 由调用方注入）
//
// 设计要点（见 docs/superpowers/specs/2026-10-14-site-export-html-design.md）：
//  • 渲染复用编辑器同一 markdown-it 管线（tokenizer），token 化与编辑器逐字节一致，保真度天然对齐。
//    只在 tokenizer.renderer 上「挂 HTML 渲染规则」，不改任何 ruler（解析流水线）——
//    编辑器只用 tokenizer.tokenize→ProseMirror（mdParser.parse），从不调 .render()，故挂规则零污染。
//  • 任务清单不靠 core 规则打标记（那会改动解析流水线、破坏编辑器 convertTasks），
//    改为渲染后对 HTML 做定点替换 + CSS :has 收拢，纯输出层处理。
//  • 跨笔记链接：wikilink 走 build_site_graph 解析表（Rust 单一实现）；普通 .md 相对链接只换扩展名。
//    图片镜像到同相对位置，href 统一改写成「当前页 → 资源」的相对路径，规避 Obsidian 相对/最短路径歧义。
//  • 本模块不 import tauri-bridge：读写/建图/拷贝均以 io 依赖注入，便于 Node 纯逻辑单测。

import katex from 'katex'
import { tokenizer } from './editor-schema.js'
import { anchorSlug } from './heading-anchor.js'
import { t, getLocale } from './i18n.js'

// —— 路径小工具（一律用 / 分隔；库内 rel 由 Rust collect_md_paths 以 / 产出）——
function normRel(p) {
  return String(p == null ? '' : p).replace(/\\/g, '/').replace(/^\.\//, '')
}
function dirname(p) {
  const n = normRel(p)
  const i = n.lastIndexOf('/')
  return i < 0 ? '' : n.slice(0, i)
}
function baseName(p) {
  const n = normRel(p)
  return n.slice(n.lastIndexOf('/') + 1)
}
// 相对路径拼接后归一化 . 与 ..（纯字符串，不碰文件系统）
function resolveRel(baseDir, rel) {
  const segs = (baseDir ? baseDir.split('/') : []).concat(rel.split('/'))
  const out = []
  for (const s of segs) {
    if (s === '.' || s === '') continue
    if (s === '..') { if (out.length && out[out.length - 1] !== '..') out.pop(); else out.push('..') }
    else out.push(s)
  }
  return out.join('/')
}
// 从「当前页所在目录」到「站内根相对目标」的相对路径（含 ./ 前缀）
function relpath(fromDir, toRel) {
  const a = fromDir ? fromDir.split('/') : []
  const b = normRel(toRel).split('/')
  let i = 0
  while (i < a.length && i < b.length && a[i] === b[i]) i++
  const ups = a.length - i
  const tail = b.slice(i).join('/')
  return (ups ? '../'.repeat(ups) : './') + tail
}
function swapExtHtml(rel) {
  return normRel(rel).replace(/\.(md|markdown)$/i, '') + '.html'
}
function isExternal(href) {
  return /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i.test(href) // scheme: 或 //host 或 #anchor
}

const IMG_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'bmp', 'ico', 'avif'])
function isImageRel(p) {
  const n = normRel(p).toLowerCase()
  const dot = n.lastIndexOf('.')
  return dot > 0 && IMG_EXT.has(n.slice(dot + 1))
}

// —— HTML 转义 ——
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}
function escAttr(s) { return esc(s).replace(/'/g, '&#39;') }

// ============ 纯逻辑：建图消费（供单测）============

/** (from,target) → to（md rel | null）。与 Rust build_site_graph 的 wiki 表一一对应。 */
export function buildWikiLookup(graph) {
  const map = new Map()
  for (const w of (graph && graph.wiki) || []) {
    map.set(w.from + '\u0000' + w.target, w.to == null ? null : normRel(w.to))
  }
  return map
}

/** 反链：被引用 md rel → [引用它的 md rel…]（去自身、去未解析）。 */
export function buildBacklinks(graph) {
  const bl = new Map()
  for (const w of (graph && graph.wiki) || []) {
    if (!w.to) continue
    const to = normRel(w.to)
    if (to === normRel(w.from)) continue
    if (!bl.has(to)) bl.set(to, [])
    bl.get(to).push(normRel(w.from))
  }
  for (const arr of bl.values()) {
    const uniq = [...new Set(arr)]
    arr.length = 0
    arr.push(...uniq.sort())
  }
  return bl
}

/** 从库树（scanVault TreeNode）扁平化出图片 rel 列表 + basename→rel 索引（首个命中）。
 *  兼容两种入参形状：scan_vault 实际返回的是顶层 TreeNode **数组**（库根下的各子项），
 *  而单测/调用方也可能传入一个合成的根节点——故对数组逐元素递归，对单节点按原逻辑走。*/
export function collectImages(tree) {
  const images = []
  const byBase = new Map()
  ;(function walk(node) {
    if (!node) return
    if (Array.isArray(node)) {
      for (const n of node) walk(n)
      return
    }
    if (node.type === 'folder') {
      for (const c of node.children || []) walk(c)
    } else if (isImageRel(node.path)) {
      const rel = normRel(node.path)
      images.push(rel)
      const b = baseName(rel).toLowerCase()
      if (!byBase.has(b)) byBase.set(b, rel)
    }
  })(tree)
  return { images, byBase }
}

// —— 图片解析：普通 ![]() 与嵌入 ![[ ]] 统一落到库内真实 rel ——
// 候选顺序：① 相对当前页解析 ② 视作库根相对 ③ basename 全库回退。命中 imageSet 才算数。
export function resolveImageRel(fromDir, rawSrc, imageSet, byBase) {
  const clean = normRel(rawSrc.split('#')[0].split('?')[0])
  if (!clean || isExternal(rawSrc)) return null
  const cands = [resolveRel(fromDir, clean), clean]
  const b = baseName(clean).toLowerCase()
  if (byBase.has(b)) cands.push(byBase.get(b))
  for (const c of cands) {
    if (imageSet.has(c)) return c
  }
  return null
}

/** 普通 markdown 链接里的 .md/.markdown → .html（外部/锚点原样）。 */
export function rewriteMdLink(href) {
  if (!href || isExternal(href)) return href
  const hash = href.indexOf('#')
  const path = hash < 0 ? href : href.slice(0, hash)
  const anchor = hash < 0 ? '' : href.slice(hash)
  if (/\.(md|markdown)$/i.test(path)) return swapExtHtml(path) + anchor
  return href
}

/** 渲染后把紧/松列表项开头的 [ ] / [x] 变成禁用复选框（纯输出层）。 */
export function taskFixup(html) {
  return String(html)
    .replace(/<li(\s[^>]*)?>\s*\[ \]\s?/gi, (m, attrs) => `<li${attrs || ''} class="nl-task-item"><input type="checkbox" class="nl-task-box" disabled> `)
    .replace(/<li(\s[^>]*)?>\s*\[[xX]\]\s?/gi, (m, attrs) => `<li${attrs || ''} class="nl-task-item"><input type="checkbox" class="nl-task-box" checked disabled> `)
}

/** 去标记纯文本（搜索索引用）：去 HTML 标签 + 基础实体还原 + 收拢空白。 */
export function htmlToText(html) {
  return String(html)
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** 搜索索引：[{ title, href(root 相对), text }] */
export function buildSearchIndex(entries) {
  return entries.map((e) => ({ title: e.title, href: swapExtHtml(e.rel), text: e.text }))
}

// ============ 侧栏树 / 反链（HTML 片段）============

/** 由 docs[{rel,title}] 构造嵌套树：文件夹在前、文件在后，均按名排序（与文件树一致）。 */
function buildTree(docs) {
  const root = { name: '', dirs: new Map(), files: [] }
  for (const d of docs) {
    const rel = normRel(d.rel)
    const parts = rel.split('/')
    let node = root
    for (let i = 0; i < parts.length - 1; i++) {
      const seg = parts[i]
      if (!node.dirs.has(seg)) node.dirs.set(seg, { name: seg, dirs: new Map(), files: [] })
      node = node.dirs.get(seg)
    }
    node.files.push({ rel, name: parts[parts.length - 1].replace(/\.(md|markdown)$/i, ''), title: d.title })
  }
  return root
}

function renderTree(node, fromDir, activeRel) {
  let html = '<ul class="nl-nav-list">'
  const dirs = [...node.dirs.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  for (const [name, child] of dirs) {
    html += `<li class="nl-nav-dir"><span class="nl-nav-dir-name">${esc(name)}</span>${renderTree(child, fromDir, activeRel)}</li>`
  }
  const files = node.files.slice().sort((a, b) => a.name.localeCompare(b.name))
  for (const f of files) {
    const active = normRel(activeRel) === f.rel ? ' active' : ''
    html += `<li><a class="nl-nav-item${active}" href="${escAttr(relpath(fromDir, swapExtHtml(f.rel)))}">${esc(f.title || f.name)}</a></li>`
  }
  html += '</ul>'
  return html
}

export function buildSidebar(docs, activeRel, fromDir) {
  return `<nav class="nl-nav"><div class="nl-nav-cap">${esc(t('site.docs'))}</div>${renderTree(buildTree(docs), fromDir, activeRel)}</nav>`
}

export function buildBacklinksHtml(selfRel, backlinks, titleOf, fromDir) {
  const list = backlinks.get(normRel(selfRel))
  if (!list || !list.length) return ''
  const items = list.map((from) =>
    `<li><a class="nl-wiki" href="${escAttr(relpath(fromDir, swapExtHtml(from)))}">${esc(titleOf(from))}</a></li>`).join('')
  return `<section class="nl-backlinks"><h2 class="nl-bl-title">${esc(t('site.backlinksTitle'))}</h2><ul>${items}</ul></section>`
}

// ============ 渲染规则挂载（tokenizer 单例，只加 renderer.rules，不改解析流水线）============

function ensureRenderRules() {
  const R = tokenizer.renderer.rules

  R.wiki_link = (tokens, idx, options, env) => {
    const t = tokens[idx]
    const target = t.attrGet('target') || ''
    const label = t.attrGet('label') || target
    if (!env || !env.__site) return `<span class="nl-wiki">${esc(label)}</span>`
    const key = env.selfRel + '\u0000' + target
    const to = env.wikiMap.has(key) ? env.wikiMap.get(key) : null
    if (to == null) return `<span class="nl-wiki nl-wiki-missing">${esc(label)}</span>` // 不产坏链
    return `<a class="nl-wiki" href="${escAttr(relpath(env.fromDir, swapExtHtml(to)))}">${esc(label)}</a>`
  }

  R.wiki_img = (tokens, idx, options, env) => {
    const t = tokens[idx]
    const target = t.attrGet('src') || ''
    const alt = t.attrGet('alt') || target
    const rel = env && env.__site
      ? resolveImageRel(env.fromDir, target, env.imageSet, env.imgByBase)
      : null
    if (!rel) return `<span class="nl-wiki nl-wiki-missing">![[${esc(target)}]]</span>`
    env.assets.add(rel)
    const w = t.attrGet('width')
    return `<img class="nl-embed" src="${escAttr(relpath(env.fromDir, rel))}" alt="${escAttr(alt)}"${w ? ` style="width:${escAttr(w)}px"` : ''}>`
  }

  R.tag = (tokens, idx) => {
    const tag = tokens[idx].attrGet('tag') || ''
    return `<span class="nl-tag">#${esc(tag)}</span>`
  }

  R.math_inline = (tokens, idx) => {
    const latex = tokens[idx].latex || ''
    try { return katex.renderToString(latex, { throwOnError: false, displayMode: false }) }
    catch { return `<code class="nl-math-fallback">${esc(latex)}</code>` }
  }

  R.math_block = (tokens, idx) => {
    const latex = tokens[idx].latex || ''
    let inner
    try { inner = katex.renderToString(latex, { throwOnError: false, displayMode: true }) }
    catch { inner = `<code class="nl-math-fallback">${esc(latex)}</code>` }
    return `<div class="nl-math-block">${inner}</div>`
  }

  R.callout_open = (tokens, idx) => {
    const t = tokens[idx]
    const type = (t.calloutType || 'note').toLowerCase()
    const fold = t.calloutFold || ''
    const title = t.calloutTitle || t.calloutType || 'Note'
    const head = `<div class="nl-callout-title">${esc(title)}</div>`
    if (fold) {
      const open = fold === '+' ? ' open' : ''
      return `<details class="nl-callout nl-callout-${esc(type)} nl-callout-fold"${open}><summary>${head}</summary>`
    }
    return `<div class="nl-callout nl-callout-${esc(type)}">${head}`
  }
  // callout_close 与 open 配对：open 用了 <details> 就关 </details>，否则 </div>。
  // close token 本身不带 fold 信息，故回看最近一个未配对的 callout_open。
  R.callout_close = (tokens, idx) => {
    // 找到与之配对的 callout_open（此前最近、未被配对 close 消费的一个）
    let depth = 0
    for (let k = idx - 1; k >= 0; k--) {
      if (tokens[k].type === 'callout_close') depth++
      else if (tokens[k].type === 'callout_open' && depth === 0) {
        return tokens[k].calloutFold ? '</details>' : '</div>'
      } else if (tokens[k].type === 'callout_open') depth--
    }
    return '</div>'
  }

  // 普通图片：镜像 + 改写 href 到「当前页→资源」相对路径
  R.image = (tokens, idx, options, env) => {
    const t = tokens[idx]
    const rawSrc = t.attrGet('src') || ''
    const alt = esc(t.content || '')
    const titleAttr = t.attrGet('title')
    let src = rawSrc
    if (env && env.__site) {
      const rel = resolveImageRel(env.fromDir, rawSrc, env.imageSet, env.imgByBase)
      if (rel) { env.assets.add(rel); src = relpath(env.fromDir, rel) }
    }
    let out = `<img src="${escAttr(src)}" alt="${alt}"`
    if (titleAttr) out += ` title="${escAttr(titleAttr)}"`
    const w = t.attrGet('width')
    if (w) out += ` style="width:${escAttr(w)}px"`
    out += '>'
    return out
  }

  // 普通链接：.md → .html 换扩展名（其余交默认渲染）
  const defaultLinkOpen = R.link_open || ((tokens, idx, opts, env, self) => self.renderToken(tokens, idx, opts))
  R.link_open = (tokens, idx, opts, env, self) => {
    const t = tokens[idx]
    const h = t.attrGet('href')
    if (env && env.__site && h) t.attrSet('href', rewriteMdLink(h))
    return defaultLinkOpen(tokens, idx, opts, env, self)
  }

  // 交叉引用锚点（批次 F 后续）：编辑器/导入侧的 `<a id="…"></a>`（非标题目标的跳转落点）。tokenizer 是
  // html:false，默认渲染会把自定义 anchor token 当转义文本，故显式输出字面锚（id 已在导入侧净化为
  // [A-Za-z0-9_-]，再走 escAttr 双保险），使站点里 `[文本](#id)` 能落到该锚点。
  R.anchor = (tokens, idx) => {
    const id = tokens[idx].attrGet('id') || ''
    return id ? `<a id="${escAttr(id)}"></a>` : ''
  }

  // 标题锚定：给每个 <hN> 发 id=共享锚点（与导入侧 Rust assign_anchors / 编辑器点击同一套 slugAllInOrder）。
  // 标题纯文本 = inline token 子节点里 text/code_inline 的 content 拼接（强调/删除线等标记非 text token → 自然剔除，
  // 与编辑器 heading.textContent 一致）；同文档重名按渲染序（=文档序） dedup 加 -1/-2。env 每篇新建 → 天然 per-doc。
  R.heading_open = (tokens, idx, options, env, self) => {
    const openTok = tokens[idx]
    const inline = tokens[idx + 1]
    let plain = ''
    if (inline && Array.isArray(inline.children)) {
      for (const ch of inline.children) {
        if (ch.type === 'text' || ch.type === 'code_inline') plain += ch.content
      }
    }
    const base = anchorSlug(plain)
    if (base) {
      if (!env.__anchor) env.__anchor = Object.create(null)
      const cnt = env.__anchor[base] || 0
      env.__anchor[base] = cnt + 1
      openTok.attrSet('id', cnt === 0 ? base : `${base}-${cnt}`)
    }
    return self.renderToken(tokens, idx, options)
  }
}
let rulesReady = false

/** 渲染单页正文为站内 HTML（确保渲染规则已挂载）。ctx 见 exportSite 内部结构。 */
export function renderSite(md, ctx = {}) {
  if (!rulesReady) { ensureRenderRules(); rulesReady = true }
  const env = { __site: true, selfRel: '', fromDir: '', wikiMap: new Map(), imageSet: new Set(), imgByBase: new Map(), assets: new Set(), ...ctx }
  if (!(env.wikiMap instanceof Map)) env.wikiMap = new Map()
  return taskFixup(tokenizer.render(md, env))
}

// ============ 页面外壳 / CSS / 首页 / 搜索页 ============

function siteCss() {
  return `:root{--fg:#24292e;--muted:#6a737d;--bg:#fff;--line:#e1e4e8;--link:#2f6feb;--side-w:288px}
@media (prefers-color-scheme:dark){:root{--fg:#c9d1d9;--muted:#8b949e;--bg:#0d1117;--line:#30363d;--link:#58a6ff}}
*{box-sizing:border-box}
body.site{margin:0;font-family:-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;color:var(--fg);background:var(--bg);line-height:1.75}
.nl-layout{display:flex;align-items:flex-start;max-width:1200px;margin:0 auto;gap:0}
.nl-side{position:sticky;top:0;width:var(--side-w);max-height:100vh;overflow:auto;padding:20px 12px;border-right:1px solid var(--line);flex:0 0 auto}
.nl-main{flex:1 1 auto;min-width:0;padding:32px 40px;max-width:860px}
.nl-nav-cap{font-size:12px;text-transform:uppercase;letter-spacing:.06em;color:var(--muted);margin:6px 8px}
.nl-nav-list{list-style:none;margin:0;padding-left:14px}
.nl-nav>ul.nl-nav-list{padding-left:4px}
.nl-nav-dir{margin:2px 0}
.nl-nav-dir-name{display:block;color:var(--muted);font-size:13px;padding:2px 8px;font-weight:600}
.nl-nav-item{display:block;color:var(--fg);text-decoration:none;font-size:14px;padding:3px 8px;border-radius:6px}
.nl-nav-item:hover{background:rgba(127,127,127,.12)}
.nl-nav-item.active{background:rgba(47,111,235,.14);color:var(--link);font-weight:600}
.nl-toolbar{margin:0 0 14px;display:flex;gap:10px;font-size:13px}
.nl-toolbar a{color:var(--link);text-decoration:none}
article h1,article h2,article h3,article h4,article h5,article h6{line-height:1.3;margin:1.4em 0 .6em;font-weight:650}
article h1{font-size:1.9em;border-bottom:1px solid var(--line);padding-bottom:.3em}
article h2{font-size:1.5em;border-bottom:1px solid var(--line);padding-bottom:.3em}
article h3{font-size:1.25em}
article blockquote{border-left:3px solid var(--line);margin:.8em 0;padding:.1em 1em;color:var(--muted)}
article code{font-family:"SFMono-Regular",Consolas,monospace;background:rgba(127,127,127,.15);padding:.1em .35em;border-radius:4px;font-size:.9em}
article pre{background:rgba(127,127,127,.1);padding:12px 14px;border-radius:6px;overflow-x:auto}
article pre code{background:none;padding:0}
article table{border-collapse:collapse;margin:1em 0;width:100%}
article th,article td{border:1px solid var(--line);padding:6px 10px;max-width:20em}
article th{background:rgba(127,127,127,.08);font-weight:600;text-align:left}
article img{max-width:100%}
article a{color:var(--link)}
article hr{border:none;border-top:1px solid var(--line);margin:1.6em 0}
.nl-wiki{color:var(--link);text-decoration:none}
.nl-wiki:hover{text-decoration:underline}
.nl-wiki-missing{color:var(--muted);border-bottom:1px dashed var(--muted)}
.nl-tag{display:inline-block;color:var(--link);background:rgba(47,111,235,.12);border-radius:999px;padding:0 .6em;font-size:.85em;line-height:1.7}
ul:has(> li.nl-task-item){list-style:none;padding-left:1.1em}
li.nl-task-item input.nl-task-box{margin-right:.5em}
.nl-math-block{overflow-x:auto;overflow-y:hidden;margin:1em 0;padding:2px 0}
.nl-callout{border:1px solid var(--line);border-left-width:4px;border-radius:8px;padding:10px 14px;margin:1em 0;background:rgba(127,127,127,.05)}
.nl-callout-title{font-weight:650;margin-bottom:4px}
.nl-callout summary{cursor:pointer;list-style:none}
.nl-callout summary::-webkit-details-marker{display:none}
.nl-callout-note{border-left-color:#539ae5}.nl-callout-tip{border-left-color:#2ecc71}
.nl-callout-important{border-left-color:#b45ce5}.nl-callout-warning{border-left-color:#e5a553}
.nl-callout-caution{border-left-color:#e5534b}.nl-callout-quote{border-left-color:#9aa0a6}
.nl-backlinks{margin-top:40px;padding-top:16px;border-top:1px solid var(--line)}
.nl-bl-title{font-size:1.1em;margin:0 0 8px}
.nl-backlinks ul{list-style:none;padding-left:0}
.nl-backlinks li{margin:4px 0}
.nl-home{max-width:860px;margin:0 auto;padding:36px 24px}
.nl-home h1{border-bottom:1px solid var(--line);padding-bottom:.3em}
.nl-home .nl-nav-cap{font-size:14px;margin:18px 0 6px}
.nl-search{max-width:720px;margin:0 auto;padding:32px 20px}
.nl-search input{width:100%;padding:10px 12px;font-size:16px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--fg)}
.nl-hit{padding:12px 0;border-bottom:1px solid var(--line)}
.nl-hit-title a{color:var(--link);text-decoration:none;font-weight:600}
.nl-hit-path{color:var(--muted);font-size:12px;margin:2px 0}
.nl-hit-snippet{font-size:14px}`
}

function buildPage({ title, bodyHtml, sidebar, backlinks, fromDir, toolbar }) {
  const toRoot = relpath(fromDir, '')
  return `<!DOCTYPE html>
<html lang="zh-CN"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/katex.min.css">
<link rel="stylesheet" href="${escAttr(toRoot + 'assets/site.css')}">
</head><body class="site">
<div class="nl-layout">
<div class="nl-side">${sidebar}</div>
<main class="nl-main">${toolbar}<article>${bodyHtml}</article>${backlinks}</main>
</div></body></html>`
}

function buildHome({ vaultTitle, docs, backlinks }) {
  const sidebar = buildSidebar(docs, null, '')
  const toolbar = buildToolbar('')
  return `<!DOCTYPE html>
<html lang="${getLocale()}"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(vaultTitle)}</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/katex.min.css">
<link rel="stylesheet" href="./assets/site.css">
</head><body class="site">
<div class="nl-home">${toolbar}<h1>${esc(vaultTitle)}</h1>${sidebar}</div>
</body></html>`
}

function buildToolbar(toRoot) {
  return `<div class="nl-toolbar"><a href="${escAttr(toRoot + 'index.html')}">${esc(t('site.home'))}</a><a href="${escAttr(toRoot + 'search.html')}">${esc(t('site.search'))}</a></div>`
}

function buildSearchPage() {
  return `<!DOCTYPE html>
<html lang="${getLocale()}"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(t('site.searchPageTitle'))}</title>
<link rel="stylesheet" href="./assets/site.css">
</head><body class="site">
<div class="nl-search">
<h1>${esc(t('site.searchPageTitle'))}</h1>
<input id="q" type="search" placeholder="${escAttr(t('site.searchPlaceholder'))}" autofocus>
<div id="out"></div>
</div>
<script>
(function(){
  var IDX=null;
  fetch('search-index.json').then(function(r){return r.json()}).then(function(d){IDX=d;}).catch(function(){IDX=[];});
  var q=document.getElementById('q'), out=document.getElementById('out');
  function esc(s){return String(s).replace(/[&<>"']/g,function(c){return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];});}
  function snippet(text,toks){var i=text.toLowerCase().indexOf(toks[0]||'');if(i<0)i=0;var s=text.slice(Math.max(0,i-30),i+90);return (i>30?'…':'')+esc(s)+'…';}
  function run(){
    if(!IDX){out.textContent='${t('site.indexLoading')}';return;}
    var raw=q.value.trim();if(!raw){out.innerHTML='';return;}
    var toks=raw.toLowerCase().split(/\\s+/).filter(Boolean);
    var res=[];
    IDX.forEach(function(e){var t=(e.title+' '+e.text).toLowerCase();
      if(toks.every(function(k){return t.indexOf(k)>=0;}))res.push(e);});
    res.sort(function(a,b){return b.title.length-a.title.length;});
    out.innerHTML=res.slice(0,80).map(function(e){
      return '<div class="nl-hit"><div class="nl-hit-title"><a href="'+esc(e.href)+'">'+esc(e.title)+'</a></div>'
        +'<div class="nl-hit-snippet">'+snippet(e.text,toks)+'</div>'
        +'<div class="nl-hit-path">'+esc(e.href)+'</div></div>';
    }).join('')||'<p>${t('site.noResults')}</p>';
  }
  q.addEventListener('input',run);q.addEventListener('keydown',run);
})();
</script>
</body></html>`
}

// ============ 编排：exportSite（I/O 注入）============

/**
 * @param {object} opts
 * @param {string} opts.vaultRoot  知识库根（绝对）
 * @param {string} opts.outDir      输出目录（绝对）
 * @param {object} opts.io          注入依赖：{ buildGraph, scanTree, readMd, writeFile, copyAssets }
 * @param {(msg:string)=>void} [opts.setStatus]
 * @returns {Promise<{ok:number,failed:number,total:number}>}
 */
export async function exportSite({ vaultRoot, outDir, io, setStatus = () => {} }) {
  if (!rulesReady) { ensureRenderRules(); rulesReady = true }
  const say = (m) => { try { setStatus(m) } catch { /* ignore */ } }

  say(t('site.building'))
  const graph = await io.buildGraph(vaultRoot)
  const docs = ((graph && graph.docs) || []).map((d) => ({ rel: normRel(d.rel), title: d.title }))
  const docsByRel = new Map(docs.map((d) => [d.rel, d.title]))
  const titleOf = (rel) => docsByRel.get(normRel(rel)) || baseName(rel).replace(/\.(md|markdown)$/i, '')

  const wikiMap = buildWikiLookup(graph)
  const backlinks = buildBacklinks(graph)

  let imageSet = new Set(), imgByBase = new Map()
  if (io.scanTree) {
    const tree = await io.scanTree(vaultRoot)
    const ci = collectImages(tree)
    imageSet = new Set(ci.images)
    imgByBase = ci.byBase
  }

  const assets = new Set()
  const searchEntries = []
  const outBase = String(outDir).replace(/\\/g, '/').replace(/\/+$/, '')
  const joinOut = (rel) => outBase + '/' + normRel(rel)

  let done = 0, failed = 0
  for (const d of docs) {
    say(t('site.exporting', { done: done + 1, total: docs.length, rel: d.rel }))
    try {
      const raw = await io.readMd(vaultRoot, d.rel)
      const body = stripFrontmatter(raw)
      const ctx = { __site: true, selfRel: d.rel, fromDir: dirname(d.rel), wikiMap, imageSet, imgByBase, assets }
      const rendered = tokenizer.render(body, ctx)
      const bodyHtml = taskFixup(rendered)
      searchEntries.push({ rel: d.rel, title: d.title, text: htmlToText(bodyHtml) })
      const fromDir = dirname(d.rel)
      const sidebar = buildSidebar(docs, d.rel, fromDir)
      const bl = buildBacklinksHtml(d.rel, backlinks, titleOf, fromDir)
      const page = buildPage({
        title: d.title || titleOf(d.rel),
        bodyHtml, sidebar, backlinks: bl, fromDir,
        toolbar: buildToolbar(relpath(fromDir, '')),
      })
      await io.writeFile(joinOut(swapExtHtml(d.rel)), page)
    } catch (e) {
      failed++
      console.warn(t('site.skipWarn'), d.rel, e)
    }
    done++
  }

  // 首页 + 搜索页 + 搜索索引 + 共享样式
  try {
    const vaultTitle = baseName(String(vaultRoot).replace(/[\\/]+$/, '')) || t('site.vaultFallback')
    await io.writeFile(joinOut('index.html'), buildHome({ vaultTitle, docs }))
    await io.writeFile(joinOut('search.html'), buildSearchPage())
    await io.writeFile(joinOut('search-index.json'), JSON.stringify(buildSearchIndex(searchEntries), null, 0))
    await io.writeFile(joinOut('assets/site.css'), siteCss())
  } catch (e) {
    console.warn(t('site.skeletonFailed'), e)
  }

  // 图片镜像拷贝（仅被引用到的）
  try {
    if (assets.size) await io.copyAssets(vaultRoot, [...assets], outDir)
  } catch (e) {
    console.warn(t('site.assetsFailed'), e)
  }

  const ok = docs.length - failed
  say(t('site.done', { ok, failed }))
  return { ok, failed, total: docs.length }
}

// frontmatter 剥离：站点正文只看正文（与单篇导出一致）。本地实现避免 import 触发 tauri 依赖。
function stripFrontmatter(md) {
  if (md == null) return ''
  let s = md
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1)
  if (s.startsWith('---')) {
    const lines = s.split('\n')
    if (lines[0].trim() === '---') {
      for (let i = 1; i < lines.length; i++) {
        const t = lines[i].trim()
        if (t === '---' || t === '...') return lines.slice(i + 1).join('\n')
      }
    }
  }
  return md
}
