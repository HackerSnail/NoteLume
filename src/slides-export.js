// slides-export.js —— 单文档导出 reveal.js 演示文稿（纯逻辑；渲染与产物见下方 buildSlidesHtml）
//
// 设计见 docs/superpowers/specs/2026-10-25-slides-export-design.md：
//  切片在 markdown-it 的 token 流上做（fence / 引用 / 列表里的 --- 与 ## 天然不参与），
//  md 源文件保持标准 GFM：切片只依赖标准语法，--- 是普通水平线、::: notes 是普通文本。

import { tokenizer } from './editor-schema.js'

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
