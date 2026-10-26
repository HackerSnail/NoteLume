// plain-export.js —— 整库导出标准 GFM 副本
//
// 「零锁定」的可验证形态：把库内全部 md 复制到目标文件夹，Obsidian 私有语法在写出时降级，
// 产物任何一个编辑器打开都不缺内容。目录结构与原库一致，引用到的图片镜像到同相对位置。
//
// 降级规则：
//   callout `> [!note] 标题` → `> **标题**`（无标题用类型名，`-` / `+` 折叠标记丢弃，正文行保持引用块）
//   `![[图片.png]]` → `![文件名](相对路径)`（数字别名是 Obsidian 的宽度语法，GFM 无对应形态，丢弃）
//   `![[另一篇笔记]]` → `[笔记名](相对路径.md)`
//   `[[目标]]` / `[[目标|别名]]` → `[别名](相对路径.md)`；解析不到的（未创建的链接）只留别名文字，不产坏链
//   `[[目标#锚]]` → 链到文件本身，锚丢弃（Obsidian 的锚是标题原文，GFM 锚是 slug，直译必坏）
//
// wikilink 解析复用 build_site_graph 的 wiki 表（Rust 单一实现，与编辑器跳转、站点导出同源）。
// 表里没有的 target 按库内文件名兜底再解一次；仍没有就当未创建链接。
// 围栏代码块与行内代码里的 [[ ]] / ![[ ]] 一律不动。

import { buildWikiLookup, collectImages, resolveImageRel } from './site-export.js'
import { t } from './i18n.js'

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
// fromDir → toRel 的相对路径，fromDir 为空时落 ./ 前缀
function relpath(fromDir, toRel) {
  const a = fromDir ? fromDir.split('/') : []
  const b = normRel(toRel).split('/')
  let i = 0
  while (i < a.length && i < b.length && a[i] === b[i]) i++
  const ups = a.length - i
  const tail = b.slice(i).join('/')
  return (ups ? '../'.repeat(ups) : './') + tail
}
// 链接地址里的空格与中文要编码，GFM 链接目标不能裸带空格
function encHref(p) {
  return encodeURI(normRel(p)).replace(/\(/g, '%28').replace(/\)/g, '%29')
}

// 拆 frontmatter：原样保留（含 --- 围栏），正文单独转换
function splitFrontmatterRaw(md) {
  let s = String(md == null ? '' : md)
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1)
  if (s.startsWith('---')) {
    const lines = s.split('\n')
    if (lines[0].trim() === '---') {
      for (let i = 1; i < lines.length; i++) {
        const t = lines[i].trim()
        if (t === '---' || t === '...') {
          return { fm: lines.slice(0, i + 1).join('\n') + '\n', body: lines.slice(i + 1).join('\n') }
        }
      }
    }
  }
  return { fm: '', body: s }
}

// 行内代码 span 之外才做替换：按 `run 切段，段间是普通文本
function mapOutsideInlineCode(line, fn) {
  const re = /(`+)[\s\S]*?\1/g
  let out = ''
  let last = 0
  let m
  while ((m = re.exec(line))) {
    out += fn(line.slice(last, m.index)) + m[0]
    last = m.index + m[0].length
  }
  return out + fn(line.slice(last))
}

const CALLOUT_RE = /^((?:\s*>+)+\s*)\[!([A-Za-z]+)\]([-+])?[ \t]*(.*)$/
const CALLOUT_TYPES = ['note', 'abstract', 'info', 'todo', 'tip', 'success', 'question', 'warning', 'failure', 'danger', 'bug', 'example', 'quote', 'cite']

// wikiMap 命中不了时的兜底：rel 精确（含省略 .md 的写法）→ basename 唯一命中
function resolveDocRel(target, docsByRel, docByBase) {
  const t = normRel(target).replace(/\.(md|markdown)$/i, '')
  if (docsByRel.has(t) || docsByRel.has(t + '.md')) return docsByRel.has(t) ? t : t + '.md'
  const b = baseName(t).toLowerCase()
  return docByBase.get(b) || null
}

function resolveWiki(fromDir, selfRel, target, wikiMap, docsByRel, docByBase) {
  const clean = normRel(target.split('#')[0].trim())
  if (!clean) return null
  const key = selfRel + '\u0000' + target
  if (wikiMap.has(key)) {
    const to = wikiMap.get(key)
    return to == null ? null : to
  }
  return resolveDocRel(clean, docsByRel, docByBase)
}

// 单条 wikilink / 嵌入的降级。图片走 resolveImageRel（相对 → 库根相对 → basename 回退）。
function convertOne(selfRel, fromDir, inner, isEmbed, ctx) {
  const parts = inner.split('|')
  const target = parts[0].trim()
  const alias = parts.length > 1 ? parts.slice(1).join('|').trim() : ''
  const anchor = target.includes('#') ? target.slice(target.indexOf('#') + 1) : ''

  if (isEmbed) {
    const img = resolveImageRel(fromDir, target, ctx.imageSet, ctx.imgByBase)
    if (img) {
      ctx.assets.add(img)
      const alt = alias && !/^-?\d+$/.test(alias) ? alias : baseName(img).replace(/\.[^.]+$/, '')
      return `![${alt}](${encHref(relpath(fromDir, img))})`
    }
    const to = resolveWiki(fromDir, selfRel, target, ctx.wikiMap, ctx.docsByRel, ctx.docByBase)
    if (to) {
      const label = alias || baseName(to).replace(/\.(md|markdown)$/i, '')
      return `[${label}](${encHref(relpath(fromDir, to))})`
    }
    return null // 图片与文档都解不到：留给外层原样输出
  }

  const to = resolveWiki(fromDir, selfRel, target, ctx.wikiMap, ctx.docsByRel, ctx.docByBase)
  if (!to) return alias || target.replace(/#.*$/, '').trim() // 未创建：留文字，不产坏链
  const label = alias || (anchor ? `${baseName(to).replace(/\.(md|markdown)$/i, '')} > ${anchor}` : baseName(to).replace(/\.(md|markdown)$/i, ''))
  return `[${label}](${encHref(relpath(fromDir, to))})`
}

const WIKI_RE = /(!?)\[\[([^\][]+)\]\]/g

function convertLine(line, selfRel, fromDir, ctx) {
  return mapOutsideInlineCode(line, (seg) =>
    seg.replace(WIKI_RE, (whole, bang, inner) => {
      const out = convertOne(selfRel, fromDir, inner, bang === '!', ctx)
      return out == null ? whole : out
    })
  )
}

/**
 * 正文 Obsidian 语法 → 标准 GFM。frontmatter 已在上层拆掉。
 * 纯字符串函数，供单测。
 */
export function convertPlainMd(body, ctx) {
  const lines = String(body == null ? '' : body).split('\n')
  const out = []
  let inFence = false
  let fenceMark = ''
  for (const line of lines) {
    const fm = /^\s{0,3}(```+|~~~+)/.exec(line)
    if (fm) {
      if (!inFence) {
        inFence = true
        fenceMark = fm[1][0]
      } else if (fm[1][0] === fenceMark) {
        inFence = false
      }
      out.push(line)
      continue
    }
    if (inFence) {
      out.push(line)
      continue
    }
    const co = CALLOUT_RE.exec(line)
    if (co) {
      const [, prefix, type, , title] = co
      const name = title.trim() || type[0].toUpperCase() + type.slice(1).toLowerCase()
      out.push(`${prefix.replace(/\s+$/, '')} **${name}**`)
      continue
    }
    out.push(convertLine(line, ctx.selfRel, ctx.fromDir, ctx))
  }
  return out.join('\n')
}

/**
 * 整库导出。io 注入同 exportSite：{ buildGraph, scanTree, readMd, writeFile, copyAssets }
 * @returns {Promise<{ok:number, failed:number, total:number, assets:number}>}
 */
export async function exportPlainMd({ vaultRoot, outDir, io, setStatus = () => {} }) {
  const say = (m) => { try { setStatus(m) } catch { /* ignore */ } }
  say(t('plain.building'))
  const graph = await io.buildGraph(vaultRoot)
  const docs = ((graph && graph.docs) || []).map((d) => ({ rel: normRel(d.rel), title: d.title }))
  const docsByRel = new Map(docs.map((d) => [d.rel, d.rel]))
  const docByBase = new Map()
  for (const d of docs) {
    const b = baseName(d.rel).replace(/\.(md|markdown)$/i, '').toLowerCase()
    if (!docByBase.has(b)) docByBase.set(b, d.rel)
  }
  const wikiMap = buildWikiLookup(graph)

  let imageSet = new Set(), imgByBase = new Map()
  if (io.scanTree) {
    const ci = collectImages(await io.scanTree(vaultRoot))
    imageSet = ci.images
    imgByBase = ci.byBase
  }

  const assets = new Set()
  let failed = 0
  let done = 0
  for (const d of docs) {
    say(t('plain.exporting', { done: done + 1, total: docs.length, rel: d.rel }))
    try {
      const raw = await io.readMd(vaultRoot, d.rel)
      const { fm, body } = splitFrontmatterRaw(raw)
      const ctx = {
        selfRel: d.rel,
        fromDir: dirname(d.rel),
        wikiMap,
        docsByRel,
        docByBase,
        imageSet,
        imgByBase,
        assets,
      }
      await io.writeFile(`${outDir.replace(/[\\/]+$/, '')}/${d.rel}`, fm + convertPlainMd(body, ctx))
    } catch (e) {
      failed++
      console.warn('plain-export skip:', d.rel, e)
    }
    done++
  }

  if (assets.size) {
    try {
      await io.copyAssets(vaultRoot, [...assets], outDir)
    } catch (e) {
      console.warn('plain-export assets failed:', e)
    }
  }

  const ok = docs.length - failed
  say(t('plain.done', { ok, failed }))
  return { ok, failed, total: docs.length, assets: assets.size }
}
