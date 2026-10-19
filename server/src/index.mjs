// index.mjs —— 扫描式知识库索引：链接 / 标签 / 标题 / 摘要，以及按会话存放的内存表
//
// 逐条对着 src-tauri/src/lib.rs 的 build_index / DocEntry / VaultIndex 抄，
// 只在两处刻意与 Rust 不同（spec §8 的抽取规则，§12 有对应单测）：
//   1) [[链接]] 也跳过围栏代码块与行内代码。Rust 只对 #tag 做了这件事，
//      结果是演示库里一段展示 `[[示例]]` 语法的代码块会被抽成一条真链接。
//   2) 目标尾部的 `#段` 锚不参与解析（[[alpha#用法]] 解析到 alpha.md）。
//      Rust 带着锚去解析必然落进 unresolved，反链面板与图谱就少一条边。
// 其余语义（标题优先级、摘要剥离、标签左右边界、排序规则）保持与 Rust 一致，
// 同一份库在桌面版和网页版看到的链接关系必须相同。

import fs from 'node:fs'
import path from 'node:path'
import { SKIP_DIRS, isMd } from './vault.mjs'
import { resolveOne } from './fsCommands.mjs'

const MAX_DEPTH = 12
const codePointChars = (s) => Array.from(String(s))
// Rust 的 is_alphanumeric 覆盖 CJK；\p{L}\p{N} 是它的近亲
const ALNUM = /[\p{L}\p{N}]/u
const isTagChar = (c) => (c ? ALNUM.test(c) || c === '_' || c === '-' || c === '/' : false)
const cmpStr = (a, b) => (a < b ? -1 : a > b ? 1 : 0)

// —— 抽取：链接 ——

/** 去掉行内代码段：`x` 整段换成一个空格（防止前后文本粘连出新 token），未闭合则吃到行尾 */
function stripInlineCode(line) {
  const cs = codePointChars(line)
  let out = ''
  for (let k = 0; k < cs.length; k++) {
    const c = cs[k]
    if (c === '`') {
      let e = k + 1
      while (e < cs.length && cs[e] !== '`') e++
      out += ' '
      if (e >= cs.length) return out // 未闭合：本行余下都是代码
      k = e
      continue
    }
    out += c
  }
  return out
}

/** 逐行给出「不在围栏代码块内、且已剥掉行内代码」的文本 */
function plainLines(md) {
  const out = []
  let inFence = false
  for (const line of String(md).replace(/\r\n?/g, '\n').split('\n')) {
    const head = line.replace(/^\s+/, '')
    if (head.startsWith('```') || head.startsWith('~~~')) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    out.push(stripInlineCode(line))
  }
  return out
}

/** 提取所有 [[...]] 目标（去掉 |显示 段）。不跨行、不嵌套，与 Rust 同 */
export function extractWikilinks(md) {
  const out = []
  for (const line of plainLines(md)) {
    const cs = codePointChars(line)
    let i = 0
    while (i + 1 < cs.length) {
      if (cs[i] === '[' && cs[i + 1] === '[') {
        let j = i + 2
        let ok = false
        while (j + 1 < cs.length) {
          if (cs[j] === ']') {
            if (cs[j + 1] === ']') {
              ok = true
              break
            }
            j++ // 单只 ] 继续找
            continue
          }
          j++
        }
        if (ok) {
          const inner = cs.slice(i + 2, j).join('')
          if (!inner.includes('[')) {
            const target = (inner.split('|')[0] || '').trim()
            if (target) out.push(target)
          }
          i = j + 2
          continue
        }
      }
      i++
    }
  }
  return out
}

/** 目标去掉 `#段` 锚；剩下的才是可解析的文件名部分 */
export const stripAnchor = (target) => {
  const hash = target.indexOf('#')
  return (hash >= 0 ? target.slice(0, hash) : target).trim()
}

// —— 抽取：标签 / 标题 / 摘要 ——（与 lib.rs 一致）

/** 提取 #tag：跳过标题行、围栏代码块、行内代码、链接目标里的锚点；左边界须是空白或标点 */
export function extractTags(md) {
  const out = []
  const seen = new Set()
  let inCodeBlock = false
  for (const line of String(md).replace(/\r\n?/g, '\n').split('\n')) {
    const trimmed = line.replace(/^\s+/, '')
    if (trimmed.startsWith('```') || trimmed.startsWith('~~~')) {
      inCodeBlock = !inCodeBlock
      continue
    }
    if (inCodeBlock) continue
    if (trimmed.startsWith('#')) continue // 标题行里的 # 不是标签
    const cs = codePointChars(line)
    let k = 0
    while (k < cs.length) {
      const c = cs[k]
      if (c === '`') {
        let e = k + 1
        while (e < cs.length && cs[e] !== '`') e++
        k = Math.min(e + 1, cs.length)
        continue
      }
      if (c === '#' && k + 1 < cs.length && isTagChar(cs[k + 1])) {
        // ](#anchor) 与 ](<#anchor) 里的 # 是文内锚点，不是标签
        const isLinkDest =
          (k >= 2 && cs[k - 1] === '(' && cs[k - 2] === ']') ||
          (k >= 3 && cs[k - 1] === '<' && cs[k - 2] === '(' && cs[k - 3] === ']')
        if (isLinkDest) {
          k += 1
          continue
        }
        const leftOk =
          k === 0 ||
          (/\s/.test(cs[k - 1]) || '()><"\'[]*_,.;:!?'.includes(cs[k - 1]) || cs[k - 1] === '~')
        if (!leftOk) {
          k += 1
          continue
        }
        let n = 1
        while (k + n < cs.length && isTagChar(cs[k + n])) n++
        const tag = cs.slice(k + 1, k + n).join('')
        if (!seen.has(tag)) {
          seen.add(tag)
          out.push(tag)
        }
        k += n
        continue
      }
      k += 1
    }
  }
  return out
}

/** 首个 ATX 标题作标题；没有就用文件名去 .md */
export function extractTitle(md, rel) {
  for (const line of String(md).replace(/\r\n?/g, '\n').split('\n')) {
    const t = line.replace(/^\s+/, '')
    if (t.startsWith('#')) {
      const s = t.replace(/^#+/, '').trim()
      if (s) return s
    }
  }
  const name = String(rel).split('/').pop()
  const dot = name.lastIndexOf('.')
  return dot > 0 ? name.slice(0, dot) : name
}

/** 各级 ATX 标题文本（索引内部留存，供后续「文档大纲/段内锚」类命令取用） */
export function extractHeadings(md) {
  const out = []
  let inFence = false
  for (const line of String(md).replace(/\r\n?/g, '\n').split('\n')) {
    const t = line.replace(/^\s+/, '')
    if (t.startsWith('```') || t.startsWith('~~~')) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    const m = /^(#{1,6})\s+(.*)$/.exec(t)
    if (m && m[2].trim()) out.push({ level: m[1].length, text: m[2].trim() })
  }
  return out
}

/** 剥掉行内 md 语法：加粗/删除线标记、#tag、[[a|b]] 取 b、[t](u) 取 t、单反引号 */
export function stripInline(s) {
  const cs = codePointChars(s)
  let out = ''
  let i = 0
  while (i < cs.length) {
    const c = cs[i]
    if ((c === '*' || c === '_' || c === '~') && i + 1 < cs.length && cs[i + 1] === c) {
      i += 2
      continue
    }
    if (c === '#' && i + 1 < cs.length && isTagChar(cs[i + 1])) {
      let n = 1
      while (i + n < cs.length && isTagChar(cs[i + n])) n++
      i += n
      continue
    }
    if (c === '[' && i + 1 < cs.length && cs[i + 1] === '[') {
      let j = i + 2
      while (j + 1 < cs.length && !(cs[j] === ']' && cs[j + 1] === ']')) j++
      if (j + 1 < cs.length) {
        const parts = cs.slice(i + 2, j).join('').split('|')
        const label = (parts[parts.length - 1] || '').trim()
        if (label) out += label
        i = j + 2
        continue
      }
    }
    if (c === '[' && i + 1 < cs.length) {
      let j = i + 1
      while (j < cs.length && cs[j] !== ']') j++
      if (j < cs.length) {
        out += cs.slice(i + 1, j).join('')
        i = j + 1
        if (i < cs.length && cs[i] === '(') {
          let k = i + 1
          while (k < cs.length && cs[k] !== ')') k++
          i = Math.min(k + 1, cs.length)
        }
        continue
      }
    }
    if (c === '`' || c === '*' || c === '_' || c === '~') {
      i++
      continue
    }
    out += c
    i++
  }
  return out
}

/** 摘要：逐行剥行内语法后取前 n 字，行间以空格分隔 */
export function summaryFrom(md, n) {
  let buf = ''
  let count = 0
  for (const line of String(md).replace(/\r\n?/g, '\n').split('\n')) {
    const t = line.trim()
    if (!t) continue
    for (const ch of codePointChars(stripInline(t))) {
      buf += ch
      count++
      if (count >= n) return buf
    }
    buf += ' '
    count++
    if (count >= n) return buf
  }
  return buf
}

/** 命中位置前后 radius 字的上下文，换行折成空格，两端截了才加省略号 */
export function makeSnippet(md, qLower, radius) {
  const lower = String(md).toLowerCase()
  const at = lower.indexOf(qLower)
  if (at < 0) return summaryFrom(md, radius * 2)
  const cs = codePointChars(md)
  // indexOf 给的是 UTF-16 下标，换成码点下标
  const beforeChars = codePointChars(lower.slice(0, at)).length
  const qChars = codePointChars(qLower).length
  const start = Math.max(0, beforeChars - radius)
  const end = Math.min(cs.length, beforeChars + qChars + radius)
  const body = cs.slice(start, end).join('').replace(/\n/g, ' ')
  return (start > 0 ? '…' : '') + body + (end < cs.length ? '…' : '')
}

// —— 索引表：每个会话一份（桌面版是进程内单份全局状态，网页版要多会话隔离） ——

class VaultIndex {
  constructor() {
    this.vaultRoot = ''
    this.docs = new Map() // rel -> { path,title,tags,headings,outgoing,unresolved,content }
    this.backlinks = new Map() // target rel -> [src rel...]
    this.ready = false
    this.token = 0 // 重建令牌：切库时旧扫描发现自己过时就停手
  }
}

const STORE = new Map() // sid -> VaultIndex

export function indexOf(sid) {
  let idx = STORE.get(sid)
  if (!idx) {
    idx = new VaultIndex()
    STORE.set(sid, idx)
  }
  return idx
}

export function dropIndex(sid) {
  STORE.delete(sid)
}

/** 仅测试用：清空全部会话索引 */
export function resetStore() {
  STORE.clear()
}

/** 库内所有 md 的相对路径（与 lib.rs 的 collect_md_paths 同：跳过点开头与 SKIP_DIRS，深度 12 封顶） */
export function collectMdPaths(dir, rel, depth, out) {
  if (depth > MAX_DEPTH) return out
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch (e) {
    return out
  }
  for (const e of entries) {
    const name = e.name
    if (name.startsWith('.') || SKIP_DIRS.includes(name)) continue
    const childRel = rel ? `${rel}/${name}` : name
    const full = path.join(dir, name)
    if (e.isDirectory()) collectMdPaths(full, childRel, depth + 1, out)
    else if (e.isFile() && isMd(name)) out.push(childRel)
  }
  return out
}

/** 由正文算出一条文档的索引条目（链接解析要拿 canonical 库根） */
function computeDoc(root, rel, content) {
  const outgoing = []
  const unresolved = []
  for (const raw of extractWikilinks(content)) {
    const target = stripAnchor(raw)
    const hit = target ? resolveOne(root, rel, target) : null
    if (hit) {
      if (hit !== rel) outgoing.push(hit)
    } else {
      unresolved.push(raw)
    }
  }
  outgoing.sort(cmpStr)
  return {
    path: rel,
    title: extractTitle(content, rel),
    tags: extractTags(content),
    headings: extractHeadings(content),
    outgoing: dedupSorted(outgoing),
    unresolved: dedupSorted(unresolved),
    content,
  }
}

const dedupSorted = (arr) => arr.filter((v, i) => i === 0 || v !== arr[i - 1])

function rebuildBacklinks(index) {
  index.backlinks.clear()
  for (const [src, entry] of index.docs) {
    for (const tgt of entry.outgoing) {
      const lst = index.backlinks.get(tgt) || []
      lst.push(src)
      index.backlinks.set(tgt, lst)
    }
  }
  for (const lst of index.backlinks.values()) {
    lst.sort(cmpStr)
    dedupInPlace(lst)
  }
}

function dedupInPlace(lst) {
  let w = 1
  for (let r = 1; r < lst.length; r++) if (lst[r] !== lst[w - 1]) lst[w++] = lst[r]
  lst.length = w
}

/**
 * 触发全量重建：同步置 ready=false 并清表，立刻返回给前端的那份状态与 Rust 一致
 * （vaultRoot 用调用方传进来的原值，不是 canonical 后的）。扫描放到微任务里逐批让出，
 * 不阻塞 HTTP 响应——前端继续轮询 get_index_status。
 */
export function startRebuild(index, vaultRootRaw, rootCanonical) {
  const token = ++index.token
  index.ready = false
  index.vaultRoot = rootCanonical
  index.docs.clear()
  index.backlinks.clear()
  const paths = collectMdPaths(rootCanonical, '', 0, [])
  pump(index, rootCanonical, paths, token)
  return { vaultRoot: vaultRootRaw, docs: 0, ready: false }
}

async function pump(index, root, paths, token) {
  try {
    for (let i = 0; i < paths.length; i++) {
      if (index.token !== token) return // 已被更新的切库动作接管，停手
      const rel = paths[i]
      let content = ''
      try {
        content = fs.readFileSync(path.join(root, ...rel.split('/')), 'utf8')
      } catch (e) {
        content = '' // 与 Rust 的 unwrap_or_default 同：读不到就当空文档
      }
      index.docs.set(rel, computeDoc(root, rel, content))
      if (i % 24 === 23) await yieldTurn()
    }
    if (index.token !== token) return
    rebuildBacklinks(index)
    index.vaultRoot = root
    index.ready = true
  } catch (e) {
    index.ready = false // 与 Rust 一致：扫描异常就不置 ready，前端超时提示自然出现
  }
}

const yieldTurn = () => new Promise((resolve) => setImmediate(resolve))

/** 保存/新建后增量更新一条文档；rebuild 进行中直接忽略（重建结束会读到最新文件） */
export function updateDoc(index, rel, content) {
  if (!index.ready) return
  const root = index.vaultRoot
  const entry = computeDoc(root, rel, content)
  const oldOutgoing = index.docs.get(rel)?.outgoing || []
  index.docs.set(rel, entry)
  for (const tgt of oldOutgoing) {
    const lst = index.backlinks.get(tgt)
    if (lst) {
      const kept = lst.filter((p) => p !== rel)
      if (kept.length) index.backlinks.set(tgt, kept)
      else index.backlinks.delete(tgt)
    }
  }
  for (const tgt of entry.outgoing) {
    const lst = index.backlinks.get(tgt) || []
    if (!lst.includes(rel)) {
      lst.push(rel)
      lst.sort(cmpStr)
      index.backlinks.set(tgt, lst)
    }
  }
}

/** 删除文档后清理：去掉它写进别人 backlinks 的贡献，再删自身条目与作为目标的 backlinks */
export function removeDoc(index, rel) {
  if (!index.ready) return
  const entry = index.docs.get(rel)
  if (entry) {
    for (const tgt of entry.outgoing) {
      const lst = index.backlinks.get(tgt)
      if (lst) {
        const kept = lst.filter((p) => p !== rel)
        if (kept.length) index.backlinks.set(tgt, kept)
        else index.backlinks.delete(tgt)
      }
    }
    index.docs.delete(rel)
  }
  index.backlinks.delete(rel)
}

const getDoc = (index, rel) => index.docs.get(rel) || null

// —— 查询：反链 / 出链 / 文档信息 / 搜索 / 标签 / 图谱 ——

export function queryBacklinks(index, rel) {
  const lst = index.backlinks.get(rel)
  if (!lst) return []
  const out = []
  for (const p of lst) {
    const d = getDoc(index, p)
    if (d) out.push({ path: p, title: d.title })
  }
  return out
}

export function queryOutgoing(index, rel) {
  const d = getDoc(index, rel)
  if (!d) return []
  const out = []
  for (const p of d.outgoing) {
    const t = getDoc(index, p)
    if (t) out.push({ path: p, title: t.title })
  }
  return out
}

export function docInfo(index, rel) {
  const d = getDoc(index, rel)
  if (!d) return null
  return {
    path: d.path,
    title: d.title,
    tags: d.tags.slice(),
    outgoing: d.outgoing.slice(),
    unresolved: d.unresolved.slice(),
    summary: summaryFrom(d.content, 200),
  }
}

/** 大小写不敏感子串：标题 > 标签 > 正文（Rust 的 matchedBy 排序按字符串比较，故 content 会排在最前） */
export function searchVault(index, query, limit) {
  const q = String(query || '').trim().toLowerCase()
  const cap = Math.max(1, Number(limit) || 60)
  if (!q) return []
  const hits = []
  for (const d of index.docs.values()) {
    let matchedBy
    if (d.title.toLowerCase().includes(q)) matchedBy = 'title'
    else if (d.tags.some((t) => t.toLowerCase().includes(q))) matchedBy = 'tag'
    else if (d.content.toLowerCase().includes(q)) matchedBy = 'content'
    else continue
    hits.push({ path: d.path, title: d.title, snippet: makeSnippet(d.content, q, 90), matchedBy })
    if (hits.length >= Math.max(cap * 3, 50)) break
  }
  hits.sort((a, b) => (a.matchedBy === b.matchedBy ? cmpStr(a.path, b.path) : cmpStr(a.matchedBy, b.matchedBy)))
  return hits.slice(0, cap)
}

/** 全库标签计数：按出现次数降序、同数按标签名序 */
export function listAllTags(index) {
  const map = new Map()
  for (const d of index.docs.values()) {
    for (const t of d.tags) map.set(t, (map.get(t) || 0) + 1)
  }
  const v = [...map].map(([tag, count]) => ({ tag, count }))
  v.sort((a, b) => (b.count !== a.count ? b.count - a.count : cmpStr(a.tag, b.tag)))
  return v
}

/** 含指定标签的文档：忽略大小写与开头的 #，按路径排序 */
export function queryTag(index, tag) {
  const t = String(tag || '').trim().replace(/^#/, '').toLowerCase()
  const out = []
  for (const d of index.docs.values()) {
    if (d.tags.some((x) => x.toLowerCase() === t)) out.push({ path: d.path, title: d.title })
  }
  out.sort((a, b) => cmpStr(a.path, b.path))
  return out
}

/** 图谱：只保留已解析且仍在索引里的链接，双向合并成一条无向边，权重为两个方向链接次数之和 */
export function graphData(index) {
  const nodes = []
  for (const p of [...index.docs.keys()].sort(cmpStr)) {
    const d = index.docs.get(p)
    nodes.push({ path: d.path, title: d.title })
  }
  const agg = new Map()
  for (const [src, entry] of index.docs) {
    for (const tgt of entry.outgoing) {
      const resolved = resolveOne(index.vaultRoot, '', tgt)
      if (!resolved || resolved === src) continue
      if (!index.docs.has(resolved)) continue
      const key = src <= resolved ? [src, resolved] : [resolved, src]
      const k = key.join('\u0000')
      agg.set(k, (agg.get(k) || 0) + 1)
    }
  }
  const edges = [...agg].map(([k, w]) => {
    const [s, t] = k.split('\u0000')
    return { s, t, w }
  })
  edges.sort((a, b) => (a.s === b.s ? cmpStr(a.t, b.t) : cmpStr(a.s, b.s)))
  return { nodes, edges }
}
