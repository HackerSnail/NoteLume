// pos-map.js —— 源码模式与所见即所得之间的光标位置映射（纯逻辑，无 DOM，可 Node 单测）
//
// 两个编辑器（ProseMirror / CodeMirror）位置坐标系不同，切换时不管光标就会跳回文档开头。
// 做法是序列化时记账，留下文档位置与输出偏移的对应关系，查询时双向换算：
//
//   serialize(doc) → { text, anchorPm/anchorSrc, segPm/segSrc/segSrcEnd/segDoc,
//     blkPm/blkSrc/blkAt, rowPm/rowPmEnd/rowSrc/rowSrcEnd }（见 editor-schema.js 的
//     serializeMarkdownMapped）：anchors 是节点边界，segments 是文本段，blocks 是块首行，
//     rows 是表格行。segments 两侧文本只差转义反斜杠、行间定界、围栏前缀这些插入字符，
//     字符级对齐只在查询时对命中那一处算，不在序列化路上。
//
// 两档精度：
//   · 源码文本与序列化正文逐字节一致时（模型改过会重新序列化；用户在源码里只敲普通文字
//     也一致），文档位置与源码偏移按字符互换。
//   · 源码是手写原文、或改得较多时，按块在两边文本里找同一行（块签名匹配 + 顺序推进），
//     块内按行差平移。
//
// doc 位置以正文为准，frontmatter 由调用方剥掉；source 是含 frontmatter 的源码全文，
// base 是正文在 source 里的起始偏移。

const SEARCH_WINDOW = 8 // 非区分度签名（纯符号行）的行搜索窗口

function clamp(v, lo, hi) {
  return v < lo ? lo : v > hi ? hi : v
}

function lineStarts(text) {
  const starts = [0]
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) starts.push(i + 1)
  }
  return starts
}

// 偏移 → 行号（starts 由 lineStarts 生成，单调）
function lineOf(starts, off) {
  let lo = 0
  let hi = starts.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (starts[mid] <= off) lo = mid
    else hi = mid - 1
  }
  return lo
}

// docText → srcText 只可能“插入字符”（转义反斜杠、行间定界、围栏前缀），不会删改，
// 因此双指针对齐即可得到每个文档字符在源码里的落点；插入的字符归到前一位置，
// 于是 map 单调不减，反向查找可二分。
export function charMap(docText, srcText) {
  const map = new Array(docText.length + 1)
  let j = 0
  for (let i = 0; i <= docText.length; i++) {
    while (i < docText.length && j < srcText.length && srcText[j] !== docText[i]) j++
    map[i] = j
    if (i < docText.length && j < srcText.length) j++
  }
  return map
}

// —— 平行数组上的查找（全部单调，二分） ————————————————————————————

// 最后一个 src ≤ s 且 s 仍在其输出文本范围内的文本段下标
function segmentAtSrc(segSrc, segSrcEnd, s) {
  let lo = 0
  let hi = segSrc.length - 1
  let hit = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (segSrc[mid] <= s) {
      hit = mid
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  if (hit < 0) return -1
  return s <= segSrcEnd[hit] ? hit : -1
}

// 最后一个 pm ≤ pos 且 pos 仍在其文档文本范围内的文本段下标
function segmentAtPm(segPm, segDoc, pos) {
  let lo = 0
  let hi = segPm.length - 1
  let hit = -1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (segPm[mid] <= pos) {
      hit = mid
      lo = mid + 1
    } else {
      hi = mid - 1
    }
  }
  if (hit < 0) return -1
  return pos <= segPm[hit] + segDoc[hit].length ? hit : -1
}

// 表格行锚点：pos 落在某行范围内 → 该行在输出里的起点（单元格文本没有文本段记账）
function rowSrcForPm(rowPm, rowPmEnd, rowSrc, pos) {
  for (let i = 0; i < rowPm.length; i++) {
    if (rowPm[i] > pos) break
    if (pos < rowPmEnd[i]) return rowSrc[i]
  }
  return -1
}

// 行锚点的逆：输出偏移落在某行范围内 → 该行的文档位置
function rowPmForSrc(rowPm, rowSrc, rowSrcEnd, s) {
  for (let i = 0; i < rowSrc.length; i++) {
    if (rowSrc[i] > s) break
    if (s < rowSrcEnd[i]) return rowPm[i]
  }
  return -1
}

// 锚点查找：线性扫到第一个越界者即止（每次切换只调一两次，锚点虽多但不会扫到尾）
function anchorSrcForPm(anchorPm, anchorSrc, pos) {
  let src = 0
  let found = false
  for (let i = 0; i < anchorPm.length; i++) {
    if (anchorPm[i] > pos) break
    src = anchorSrc[i]
    found = true
  }
  return found ? src : 0
}

function anchorPmForSrc(anchorPm, anchorSrc, s) {
  let pm = 0
  let found = false
  for (let i = 0; i < anchorSrc.length; i++) {
    if (anchorSrc[i] > s) break
    pm = anchorPm[i]
    found = true
  }
  return found ? pm : 0
}

// 行“签名键”：同一行在两边文本里可能只差转义 / 表格留白 / 行首块记号，
// 各生成一个候选键，任一共存即认为配对成功（顺序猜错时才靠它校正）。
function lineKeys(line) {
  const t = line.trim()
  const keys = new Set()
  const add = (s) => {
    s = s.trim()
    if (s) keys.add(s)
  }
  add(t)
  add(t.replace(/\\([`*\\~\[\]_#$])/g, '$1'))
  const pipe = t.replace(/[ \t]*\|[ \t]*/g, '|')
  add(pipe)
  add(pipe.replace(/\\([`*\\~\[\]_#$])/g, '$1'))
  // 去掉行首块级记号后的“正文键”（标题/列表/引用/callout/有序列表）
  const stripped = t
    .replace(/^(?:>+[ \t]*)+/, '')
    .replace(/^\[![^\]\s]+\][+-]?[ \t]*/, '')
    .replace(/^(?:#{1,6}|[-*+]|\d+\.)[ \t]+/, '')
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .trim()
  add(stripped)
  add(stripped.replace(/\\([`*\\~\[\]_#$])/g, '$1'))
  return keys
}

function keysIntersect(a, b) {
  for (const k of a) {
    if (b.has(k)) return true
  }
  return false
}

// 序列化文本里 off 所在行的行号；跳过开头的空行
function firstNonBlankLine(lines, starts, off) {
  let line = lineOf(starts, off)
  while (line < lines.length - 1 && lines[line].trim() === '') line++
  return line
}

/**
 * 块级行对齐：把序列化侧每个块的首个非空行 ↔ 源码侧的对应行。
 * 策略：顺序推进（默认两边每块占同样行数），猜错时按签名找最近的一处。
 * 空块（at < 0：渲染不产出任何字符，如空段落）不占行、只把光标落到当前行。
 * @returns {{blkPm:number[], serLine:number[], srcLine:number[]}}
 */
function alignBlocks(blkPm, blkSrc, blkAt, serText, serLines, srcLines) {
  const serStarts = lineStarts(serText)
  const outPm = []
  const outSer = []
  const outSrc = []
  let cursor = 0
  for (let i = 0; i < blkPm.length; i++) {
    // at = 该块第一次落字的位置（落在本块第一行上）；<0 = 空块
    const anchor = blkAt[i] >= 0 ? blkAt[i] : blkSrc[i]
    const serLine = firstNonBlankLine(serLines, serStarts, anchor)
    if (blkAt[i] < 0) {
      outPm.push(blkPm[i])
      outSer.push(serLine)
      outSrc.push(clamp(cursor, 0, Math.max(0, srcLines.length - 1)))
      continue
    }
    const nextAnchor = i + 1 < blkPm.length ? (blkAt[i + 1] >= 0 ? blkAt[i + 1] : blkSrc[i + 1]) : serText.length
    const nextSerLine = i + 1 < blkPm.length ? firstNonBlankLine(serLines, serStarts, nextAnchor) : serLines.length
    const span = Math.max(1, nextSerLine - serLine)
    let srcLine = clamp(cursor, 0, Math.max(0, srcLines.length - 1))
    const sig = serLines[serLine] || ''
    const sigKeys = lineKeys(sig)
    const matched = srcLines[srcLine] != null && keysIntersect(sigKeys, lineKeys(srcLines[srcLine]))
    if (!matched) {
      // 顺序猜的不对（源码里增删了行，或块顺序不同，如脚注定义被序列化器移到文末）：
      // 按签名重找。签名含字母数字且够长，就在全文找最近的一处，源码里增删的行数不限；
      // 纯符号行（$$、---、空）只在小窗口内找，容易误配。
      let found = -1
      if (isDistinctive(sig)) {
        let fwd = -1
        for (let j = srcLine + 1; j < srcLines.length; j++) {
          if (keysIntersect(sigKeys, lineKeys(srcLines[j]))) {
            fwd = j
            break
          }
        }
        let bwd = -1
        for (let j = srcLine - 1; j >= 0; j--) {
          if (keysIntersect(sigKeys, lineKeys(srcLines[j]))) {
            bwd = j
            break
          }
        }
        if (fwd >= 0 && (bwd < 0 || fwd - srcLine <= srcLine - bwd)) found = fwd
        else if (bwd >= 0) found = bwd
      } else {
        const lo = Math.max(0, cursor - SEARCH_WINDOW)
        const hi = Math.min(srcLines.length - 1, cursor + SEARCH_WINDOW)
        for (let j = lo; j <= hi; j++) {
          if (srcLines[j] != null && keysIntersect(sigKeys, lineKeys(srcLines[j]))) {
            found = j
            break
          }
        }
      }
      if (found >= 0) srcLine = found
    }
    outPm.push(blkPm[i])
    outSer.push(serLine)
    outSrc.push(srcLine)
    cursor = srcLine + span
  }
  return { blkPm: outPm, serLine: outSer, srcLine: outSrc }
}

// 签名有没有区分度：含字母数字、去空白后够长。纯符号行不配全文搜索，否则文档里任意一个
// 同类符号行都可能被当成目标。
function isDistinctive(sig) {
  const t = sig.trim()
  return t.length >= 3 && /[\p{L}\p{N}]/u.test(t)
}

/**
 * 创建「文档位置 ↔ 源码偏移」双向映射器。
 * @param {object} cfg
 * @param {import('prosemirror-model').Node} cfg.doc    正文文档（不含 frontmatter）
 * @param {(doc)=>any} cfg.serialize                  带记账的序列化（serializeMarkdownMapped）
 * @param {string} cfg.source                         展示用源码全文（可含 frontmatter）
 * @param {number} [cfg.base]                         正文在 source 里的起始偏移
 * @returns {{exact:boolean, pmToSrc:(pos:number)=>number, srcToPm:(offset:number)=>number}}
 */
export function createPosMapper({ doc, serialize, source, base = 0 }) {
  const ser = serialize(doc)
  const serText = ser.text
  const srcBody = base > 0 ? source.slice(base) : source
  const exact = srcBody === serText
  const serStarts = lineStarts(serText)
  const serLines = exact ? null : serText.split('\n')
  const srcStarts = exact ? null : lineStarts(srcBody)
  const srcLines = exact ? null : srcBody.split('\n')
  const blocks = exact ? null : alignBlocks(ser.blkPm, ser.blkSrc, ser.blkAt, serText, serLines, srcLines)
  const max = doc.content.size

  // 文档位置 → 序列化文本偏移（文本段内字符级；表格行 → 行首；否则最近节点边界锚点）
  function serOffsetForPm(pos) {
    const i = segmentAtPm(ser.segPm, ser.segDoc, pos)
    if (i >= 0) {
      const idx = clamp(pos - ser.segPm[i], 0, ser.segDoc[i].length)
      return ser.segSrc[i] + charMap(ser.segDoc[i], serText.slice(ser.segSrc[i], ser.segSrcEnd[i]))[idx]
    }
    const row = rowSrcForPm(ser.rowPm, ser.rowPmEnd, ser.rowSrc, pos)
    if (row >= 0) return row
    return anchorSrcForPm(ser.anchorPm, ser.anchorSrc, pos)
  }

  // 序列化文本偏移 → 文档位置（对称）
  function pmForSerOffset(s) {
    const i = segmentAtSrc(ser.segSrc, ser.segSrcEnd, s)
    if (i >= 0) {
      const docText = ser.segDoc[i]
      const m = charMap(docText, serText.slice(ser.segSrc[i], ser.segSrcEnd[i]))
      const j = clamp(s - ser.segSrc[i], 0, ser.segSrcEnd[i] - ser.segSrc[i])
      let lo = 0
      let hi = m.length - 1
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1
        if (m[mid] <= j) lo = mid
        else hi = mid - 1
      }
      return ser.segPm[i] + lo
    }
    const row = rowPmForSrc(ser.rowPm, ser.rowSrc, ser.rowSrcEnd, s)
    if (row >= 0) return row
    return anchorPmForSrc(ser.anchorPm, ser.anchorSrc, s)
  }

  // 序列化偏移 → 源码全文偏移（行级回退：所属块 + 块内行差）
  function srcOffsetForSer(s) {
    if (!blocks) return clamp(s, 0, srcBody.length)
    let k = -1
    for (let i = 0; i < blocks.blkPm.length; i++) {
      if (ser.blkSrc[i] <= s) k = i
      else break
    }
    if (k < 0) return clamp(s, 0, srcBody.length)
    // 块锚点常落在上一行行尾（块间空行是懒刷新的），故行号不小于该块首个内容行
    const serLine = Math.max(lineOf(serStarts, s), blocks.serLine[k])
    const srcLine = clamp(blocks.srcLine[k] + (serLine - blocks.serLine[k]), 0, srcLines.length - 1)
    const col = Math.max(0, Math.min(s - serStarts[serLine], srcLines[srcLine].length))
    return srcStarts[srcLine] + col
  }

  // 源码全文偏移 → 序列化偏移（行级回退的逆）
  function serOffsetForSrc(o) {
    if (!blocks) return clamp(o, 0, serText.length)
    const srcLine = lineOf(srcStarts, o)
    let k = -1
    for (let i = 0; i < blocks.srcLine.length; i++) {
      if (blocks.srcLine[i] <= srcLine) k = i
      else break
    }
    if (k < 0) return clamp(o, 0, serText.length)
    const serLine = clamp(blocks.serLine[k] + (srcLine - blocks.srcLine[k]), 0, serLines.length - 1)
    const col = o - srcStarts[srcLine]
    return serStarts[serLine] + Math.min(col, serLines[serLine].length)
  }

  return {
    exact,
    pmToSrc(pos) {
      const s = serOffsetForPm(pos)
      return clamp(base + (exact ? s : srcOffsetForSer(s)), 0, source.length)
    },
    srcToPm(offset) {
      const o = clamp(offset - base, 0, srcBody.length)
      const s = exact ? o : serOffsetForSrc(o)
      return clamp(pmForSerOffset(s), 0, max)
    },
  }
}
