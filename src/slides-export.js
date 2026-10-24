// slides-export.js —— 单文档导出 reveal.js 演示文稿（纯逻辑；渲染与产物见下方 buildSlidesHtml）
//
// 设计见 docs/superpowers/specs/2026-10-25-slides-export-design.md：
//  切片在 markdown-it 的 token 流上做（fence / 引用 / 列表里的 --- 与 ## 天然不参与），
//  md 源文件保持标准 GFM：切片只依赖标准语法，--- 是普通水平线、::: notes 是普通文本。

import { tokenizer } from './editor-schema.js'
import { renderSite } from './site-export.js'

// 把切片边界行号收集出来。模式判定（spec §三）：
//  文档里存在顶层连字符水平线（---）→ hr 模式，按它切；否则 → h2 模式，按 ## 切。
//  setext 式标题（文字下接 --- 下划线）在 markdown-it 里产出 heading_open 而非 hr token，
//  故 hr 模式下不切、h2 模式下与 ## 同类，均符合预期，不做特判。
function collectBoundaries(md) {
  const tokens = tokenizer.parse(md, {})
  let hrMode = false
  const hrLines = []
  const h2Lines = []
  for (const tok of tokens) {
    if (tok.level !== 0) continue // fence 内容是 fence token、引用/列表内容 level > 0，天然跳过
    if (tok.type === 'hr' && /^-{3,}$/.test(tok.markup || '')) {
      hrMode = true
      hrLines.push(tok.map[0])
    } else if (tok.type === 'heading_open' && tok.tag === 'h2') {
      h2Lines.push(tok.map[0])
    }
  }
  return { hrMode, lines: hrMode ? hrLines : h2Lines }
}

// 片内 ::: notes 摘取：标记行与内容行从正文剔除，内容进 notes（多段用空行连接）。
// 逐行扫时跟踪 fence 开合，代码块里的 ::: 是示例不是备注（测试有覆盖）。
// 未闭合（只有 ::: notes 没有 :::）时吃到片尾。
function extractNotes(text) {
  const lines = text.split('\n')
  const body = []
  const notes = []
  let fence = null // 当前所在 fence 的起始标记（``` 或 ~~~），null = 不在代码块里
  let inNotes = false
  for (const line of lines) {
    const fenceMatch = /^\s*(`{3,}|~{3,})/.exec(line)
    if (fence) {
      if (fenceMatch && line.trim().startsWith(fence)) fence = null
      if (inNotes) notes.push(line)
      else body.push(line)
      continue
    }
    if (fenceMatch) { fence = fenceMatch[1][0].repeat(3) } // 任意 3+ 反引号/波浪线都开块，闭合按字符类型
    if (!fence && /^\s*:::\s*$/.test(line)) { inNotes = false; continue }
    if (!fence && /^\s*:::\s+notes\s*$/.test(line)) { inNotes = true; continue }
    if (inNotes) notes.push(line)
    else body.push(line)
  }
  return { body: body.join('\n'), notes: notes.join('\n').trim() }
}

/**
 * 把一篇 md 切成幻灯片（不渲染）。
 * @returns {{ title: string, slides: Array<{ body: string, notes: string }> }}
 *  title 为 md 首个 atx 一级标题文本（无则空串，调用方兜底）；body / notes 为原始 md 片段。
 */
export function splitSlides(md) {
  const { hrMode, lines: boundaries } = collectBoundaries(md)
  const all = md.split('\n')
  // hr 模式下边界行本身丢弃（分隔符）；h2 模式下 ## 行留在片内作页标题
  const starts = [0, ...boundaries.map(i => (hrMode ? i + 1 : i))]
  const ends = [...boundaries, all.length]
  const slides = starts.map((s, k) => extractNotes(all.slice(s, ends[k]).join('\n')))
    .filter(s => s.body.trim() !== '' || s.notes !== '') // 文档以 ## / --- 开头时引言片为空，丢掉
  const titleMatch = /^#\s+(.+)$/m.exec(md)
  return { title: titleMatch ? titleMatch[1].trim() : '', slides }
}

// ============ 产物拼装 ============

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, c => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ))
}

// 片内排印：reveal 默认居中且字号偏大，改成贴近 NoteLume 阅读排版的左对齐
function slidesCss() {
  return `
.reveal section{text-align:left;font-size:.72em}
.reveal section h1,.reveal section h2,.reveal section h3{line-height:1.3;margin:0 0 .6em;text-transform:none}
.reveal section p,.reveal section li{line-height:1.65}
.reveal section code{font-family:"SFMono-Regular",Consolas,monospace;background:rgba(127,127,127,.15);padding:.1em .35em;border-radius:4px}
.reveal section pre{width:100%;box-shadow:none}
.reveal section pre code{background:none;padding:0}
.reveal section table{border-collapse:collapse;margin:1em 0;font-size:.9em}
.reveal section th,.reveal section td{border:1px solid rgba(127,127,127,.4);padding:6px 10px}
.reveal section img{max-width:100%;max-height:70vh}
.reveal section blockquote{border-left:3px solid rgba(127,127,127,.4);padding:.1em 1em;font-style:normal}
.reveal section .nl-math-block{overflow-x:auto}
`
}

/**
 * 拼装自包含 reveal.js 产物（单个 HTML 字符串，reveal 本体零外部依赖）。
 * @param {string} md 已剥 frontmatter 的正文
 * @param {object} opts { title?: string, assets: { revealJs, revealCss, themeCss, notesJs } }
 *  assets 四项均为字符串：真实值由构建期 vite ?raw 注入（src/slides-assets.js），测试传占位串。
 *  title 回退顺序：入参 → md 首个 H1 → 'Slides'。
 */
export function buildSlidesHtml(md, opts = {}) {
  const assets = opts.assets || {}
  const { title: autoTitle, slides } = splitSlides(md)
  const title = opts.title || autoTitle || 'Slides'

  const sections = slides.map(s => {
    const notes = s.notes
      ? `<aside class="notes">${renderSite(s.notes, {})}</aside>`
      : ''
    return `<section>${renderSite(s.body, {})}${notes}</section>`
  }).join('\n')

  // 演讲者视图：reveal 5 的 notes 插件按 S 时 window.open('about:blank') 后 document.write
  // 内嵌的演讲者页面（marked 也在插件里自带），不请求任何外部资源，单文件开箱即用。
  const initScript = 'Reveal.initialize({ hash: true, plugins: [RevealNotes] });'

  return `<!DOCTYPE html>
<html lang="zh-CN"><head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(title)}</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/katex.min.css">
<style>${assets.revealCss || ''}</style>
<style>${assets.themeCss || ''}</style>
<style>${slidesCss()}</style>
</head><body>
<div class="reveal"><div class="slides">
${sections}
</div></div>
<script>${assets.revealJs || ''}</script>
<script>${assets.notesJs || ''}</script>
<script>
${initScript}
</script>
</body></html>
`
}
