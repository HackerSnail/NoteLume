// virtual-editor.js —— 超大文档虚拟化编辑内核（Phase 2：master/window 双层模型）
//
// 设计（见 docs/superpowers/plans/超大文件虚拟化编辑器_bb30a840.md）：
//   master 层 = 内存里的完整 PM 文档 + 唯一的 undo/redo 历史。大纲、查找、序列化（保存）
//   都在 master 上算，与 DOM 无关。
//   window 层 = EditorView 实际绑定的 doc，是 master 顶层块的一个连续切片 [i0, i1)，
//   首尾各挂一个不可编辑的 spacer（atom）撑出真实滚动高度。用户只在窗口内编辑。
//
// 同步规则：
//   窗口事务 -> 逐 step 平移 delta 回灌 master（slice 剥 spacer），master 是唯一事实源；
//   master 变更 -> 按影响区间分三类同步回窗口：
//     A 全在窗口前/后  -> 窗口 doc 不动，只重算块号账本（绝大多数增量更新走这条，零 DOM 重建）；
//     B 全在窗口内     -> master steps 反向平移进窗口 state（保 IME/选区映射，不重建）；
//     C 跨界/大变更    -> 整窗替换实块区间（罕见路径，replace 一发解决）。
//
// 历史桥接：master 用无 view 的 EditorState + prosemirror-history。窗口事务平移后照常进
// master 历史，undo/redo 在 master 上执行、变化同步回窗口，跨窗口操作因此天然连续。
//
// 本文件是纯内核：不建 EditorView、不量 DOM 高度、不接插件。接入层（Phase 2 后半 +
// Phase 3）负责：建 view、滚动监听调 viewportBlocks()、实测块高喂 setBlockHeight()、
// 装饰插件经 opts.plugins 进窗口 state。

import { Fragment, Node, Schema, Slice } from 'prosemirror-model'
import { EditorState, NodeSelection, TextSelection } from 'prosemirror-state'
import { ReplaceStep } from 'prosemirror-transform'
import { history, redo, undo } from 'prosemirror-history'
import { buildBlockIndex, blockRangePos, posToBlock } from './blocks.js'

const SPACER = 'nl_spacer'

// 窗口 schema = 编辑器 schema + spacer 节点。master/窗口必须共用同一 schema 实例：
// 窗口 slice 回灌 master 不做跨 schema 转换（同名节点跨实例混插会炸 content 校验）。
// spacer 只存在于窗口 doc；master doc 永不含 spacer（回灌前清洗 + Case A 判定兜住）。
function schemaWithSpacer(schema) {
  if (schema.nodes[SPACER]) return schema
  const nodes = schema.spec.nodes.addToEnd(SPACER, {
    group: 'block',
    atom: true,
    selectable: false, // 不可单独选中；全选会带上它，回灌时剥离（见 stripSpacers）
    attrs: { height: { default: 0 } },
    toDOM(node) {
      const h = Math.max(0, Math.round(node.attrs.height))
      return ['div', { class: 'nl-spacer', 'data-height': String(h), style: `height:${h}px`, contenteditable: 'false' }]
    },
  })
  return new Schema({ nodes, marks: schema.spec.marks })
}

/** 递归剥掉 fragment 里的 spacer 节点（正常只出现在顶层；atom 无子内容，递归防御性兜一层） */
function stripSpacers(fragment, schema) {
  const out = []
  fragment.forEach((child) => {
    if (child.type === schema.nodes[SPACER]) return
    if (child.content.size) out.push(child.copy(stripSpacers(child.content, schema)))
    else out.push(child)
  })
  return Fragment.fromArray(out)
}

/** 剥 spacer 后的 slice（open depths 只会因剥顶层 spacer 出入，spacer 是 atom/open=0，无需调整） */
function stripSpacersFromSlice(slice, schema) {
  const frag = stripSpacers(slice.content, schema)
  if (frag === slice.content) return slice
  return new Slice(frag, slice.openStart, slice.openEnd)
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))

/** step 里所有 pos 字段（ReplaceStep/ReplaceAroundStep/AddMarkStep/RemoveMarkStep/AttrStep） */
function stepPositions(st) {
  const ps = []
  for (const k of ['from', 'to', 'gapFrom', 'gapTo', 'pos']) {
    if (typeof st[k] === 'number') ps.push(st[k])
  }
  return ps
}

/** 把 step 的全部 pos 平移 delta（slice 原样携带，调用方保证 slice 已剥 spacer） */
function translateStep(st, delta) {
  const c = st.clone ? st.clone() : st
  for (const k of ['from', 'to', 'gapFrom', 'gapTo', 'pos']) {
    if (typeof c[k] === 'number') c[k] += delta
  }
  return c
}

/** 选区 -> master 坐标：夹进窗口实块区间再平移。NodeSelection 尽量保持，其余降级
 *  TextSelection；落点经 between() 收敛到最近文本位（夹取后可能贴 doc 边界） */
function selectionToMaster(sel, delta, realStart, realEnd, masterDoc) {
  if (sel instanceof NodeSelection && sel.from === sel.to && sel.from >= realStart && sel.from <= realEnd) {
    return NodeSelection.create(masterDoc, sel.from + delta)
  }
  const f = clamp(sel.from, realStart, realEnd) + delta
  const t = clamp(sel.to, realStart, realEnd) + delta
  return TextSelection.between(masterDoc.resolve(f), masterDoc.resolve(t), 1)
}

export class VirtualEditor {
  /**
   * @param {Node} masterDoc 完整文档（原编辑器 schema；内部统一重建到含 spacer 的派生 schema）
   * @param {object} opts
   *   windowSize   初始窗口实块数（默认 40）
   *   overscan     滚动扩缩时可视区外多留的块数（默认 6）
   *   estimateHeight 未实测块的估算高度 px（默认 64，接入层用实测值覆盖）
   *   plugins      窗口 state 的插件（装饰类；重建窗口时随 EditorState.create 重挂）
   *   onChange     窗口 state 每次变化后的回调（接入层在此 view.updateState）
   */
  constructor(masterDoc, opts = {}) {
    this.schema = schemaWithSpacer(masterDoc.type.schema)
    this.doc =
      masterDoc.type.schema === this.schema
        ? masterDoc
        : Node.fromJSON(this.schema, JSON.parse(JSON.stringify(masterDoc.toJSON())))
    // master 是唯一事实源：无 view 的 state 挂 history，undo/redo 都在这里执行
    this.masterState = EditorState.create({ doc: this.doc, plugins: [history()] })
    this.blocks = buildBlockIndex(this.doc)
    this.windowSize = opts.windowSize ?? 40
    this.overscan = opts.overscan ?? 6
    this.estimateHeight = opts.estimateHeight ?? 64
    this.plugins = opts.plugins || []
    this.onChange = opts.onChange || null
    this.heights = new Map() // 块号 -> 实测高度 px；块号随增删漂移，接入层负责过期清理
    this.i0 = 0
    this.i1 = 0
    this.winState = null
    this.delta = 0 // 窗口 pos + delta = master pos（窗口内实块区间恒定平移）
    this.openWindow(0, Math.min(this.windowSize, this.blocks.length))
  }

  // ———— 账本 ————

  get blockCount() {
    return this.blocks.length
  }

  /** 窗口实块在窗口 doc 里的 pos 区间 [realStart, realEnd]（top spacer 之后 ~ bottom spacer 之前）。
   *  空窗态（实块全删后 PM 只留一个兜底空段，childCount <= 2）返回空区间——此态所有
   *  step 都触界，统一走整窗替换路径。 */
  winRealRange() {
    const size = this.winState.doc.content.size
    const kids = this.winState.doc.childCount
    if (kids <= 2) return { realStart: 1, realEnd: 0, realSize: 0 }
    return { realStart: 1, realEnd: size - 1, realSize: size - 2 }
  }

  masterWinRange() {
    return blockRangePos(this.blocks, this.i0, this.i1)
  }

  winToMasterPos(p) {
    return p + this.delta
  }

  /** master pos -> 窗口 pos；窗口外返回 null（调用方先移窗再落位） */
  masterToWinPos(p) {
    const r = this.masterWinRange()
    if (!r || p < r.start || p > r.end) return null
    return p - this.delta
  }

  /** 块号 i 的 master pos 区间与节点 */
  blockAt(i) {
    return this.blocks[i]
  }

  // ———— 窗口构建 ————

  spacerNode(height) {
    return this.schema.nodes[SPACER].create({ height: Math.max(0, Math.round(height)) })
  }

  /** 块号区间 [a, b) 的 spacer 高度：实测优先，缺的用估算补 */
  heightFor(a, b) {
    let h = 0
    for (let i = a; i < b; i++) h += this.heights.get(i) ?? this.estimateHeight
    return h
  }

  /** 接入层喂实测块高（块滚出窗口时从 DOM 量） */
  setBlockHeight(i, h) {
    this.heights.set(i, h)
  }

  /** 块号从 from 起的缓存过期（前面插删导致号漂移时由接入层调用） */
  clearHeightsFrom(from) {
    for (const k of [...this.heights.keys()]) {
      if (k >= from) this.heights.delete(k)
    }
  }

  buildWinDoc(i0, i1) {
    const kids = [this.spacerNode(this.heightFor(0, i0))]
    for (let i = i0; i < i1; i++) kids.push(this.blocks[i].node)
    kids.push(this.spacerNode(this.heightFor(i1, this.blocks.length)))
    return this.schema.topNodeType.create(null, kids)
  }

  /**
   * (重)切窗口到实块区间 [i0, i1)。选区恢复：master 选区落在新窗口内则映射回窗口，
   * 否则落窗口首块开头（纯浏览滚动不保光标是可接受的；编辑处必可见由编辑路径保证）。
   */
  openWindow(i0, i1) {
    const n = this.blocks.length
    if (n === 0) return
    this.i0 = clamp(i0, 0, n - 1)
    this.i1 = clamp(Math.max(i1, this.i0 + 1), 1, n)
    const winDoc = this.buildWinDoc(this.i0, this.i1)
    this.delta = this.blocks[this.i0].offset - 1
    const sel = this.masterSelectionToWin(winDoc)
    this.winState = EditorState.create({
      doc: winDoc,
      selection: sel || TextSelection.atStart(winDoc),
      plugins: this.plugins,
    })
    this.emit()
  }

  /** master 选区 -> 指定窗口 doc 的 Selection；落点夹进实块区间，near() 找最近的
   *  文本位（master 选区在窗外时落到块开边界，between 消掉「无行内内容」告警） */
  masterSelectionToWin(winDoc = this.winState?.doc) {
    if (!winDoc) return null
    if (!this.blocks.length || this.i0 >= this.blocks.length) return null
    const size = winDoc.content.size
    if (size <= 2) return null // 空窗口（只剩首尾 spacer 或兜底段）
    const sel = this.masterState.selection
    // master 端窗口实块区间按「块 i0 起 + 窗口实块总 size」算，不依赖 i1——
    // Case B 里窗口 doc 已先 step，账本 i1 尚未重算，以窗口 doc 实际内容为准
    const mStart = this.blocks[this.i0].offset
    const mEnd = mStart + (size - 2)
    const f = clamp(clamp(sel.from, mStart, mEnd) - this.delta, 1, size - 1)
    const t = clamp(clamp(sel.to, mStart, mEnd) - this.delta, 1, size - 1)
    return TextSelection.between(winDoc.resolve(f), winDoc.resolve(t), 1)
  }

  /** 滚动扩缩入口：接入层把可视首/末块号喂进来，窗口扩到 ±overscan，差异足够大才重切 */
  viewportBlocks(firstVisible, lastVisible) {
    const n = this.blockCount
    const want0 = clamp(firstVisible - this.overscan, 0, n)
    const want1 = clamp(lastVisible + 1 + this.overscan, want0 + 1, n)
    const cur0 = this.i0
    const cur1 = this.i1
    // 可视区已被覆盖就不折腾（重切 = 全窗口 DOM 重建，代价大）
    if (firstVisible >= cur0 && lastVisible < cur1) return
    const same = want0 === cur0 && want1 === cur1
    if (same) return
    // 邻近扩展走平移式重建没必要，直接重切（Phase 2 内核先保正确性，重切频率由 overscan 压低）
    this.openWindow(want0, want1)
  }

  /** 跳到 master pos：目标在窗外先移窗覆盖它，再落选区（大纲 / 查找跳转用） */
  jumpToPos(pos) {
    const n = this.blockCount
    if (n === 0) return
    pos = clamp(pos, 0, this.doc.content.size)
    const r = this.masterWinRange()
    if (!(r && pos >= r.start && pos <= r.end)) {
      const b = posToBlock(this.blocks, pos)
      // 先落 master 选区再重切，openWindow 恢复选区时读到的就是目标位置
      const mTr = this.masterState.tr.setSelection(TextSelection.create(this.masterState.doc, pos))
      this.masterState = this.masterState.apply(mTr)
      this.openWindow(clamp(b - this.overscan, 0, n), clamp(b + this.overscan + 1, 1, n))
      return
    }
    const mTr = this.masterState.tr.setSelection(TextSelection.create(this.masterState.doc, pos))
    this.masterState = this.masterState.apply(mTr)
    const sel = this.masterSelectionToWin()
    if (sel) this.winState = this.winState.apply(this.winState.tr.setSelection(sel))
    this.emit()
  }

  emit() {
    if (this.onChange) this.onChange(this.winState)
  }

  // ———— 窗口事务 -> master ————

  /**
   * 窗口 view 的 dispatchTransaction 转发进来。
   * 先把窗口 tr 应用到窗口 state（这是 view 的最终 state），再回灌 master。
   */
  applyWindowTr(tr) {
    const oldMasterWin = this.masterWinRange()
    const newState = this.winState.apply(tr)
    const mTr = this.masterState.tr
    let ok = true
    for (const st of tr.steps) {
      const shifted = this.shiftWinStepToMaster(st)
      if (shifted) mTr.step(shifted)
      else {
        ok = false
        break
      }
    }
    if (ok) {
      const rr = this.winRealRange()
      mTr.setSelection(selectionToMaster(tr.selection, this.delta, rr.realStart, rr.realEnd, mTr.doc))
      this.masterState = this.masterState.apply(mTr)
      this.doc = this.masterState.doc
      this.blocks = buildBlockIndex(this.doc)
      this.winState = newState
      this.recomputeBookkeepingFromWinDoc()
    } else {
      // 罕见：step 跨 spacer 且不是可夹取的 ReplaceStep。整窗替换 master 对应区间
      // （把窗口当前实块序列整体写回 master），语义安全，代价是这一步在 master
      // 历史里退化为单个大 step（undo 一次退整步）。
      this.fullWindowWriteback(newState, tr, oldMasterWin)
    }
    this.emit()
  }

  /** 窗口 step -> master step；触碰 spacer 区间（含空窗态）返回 null，走整窗替换。
   *  不做夹取：全选删除等操作里 PM 会往 slice 塞 fit 兜底空段，夹取分不清兜底与用户内容，
   *  整窗替换以「窗口新实块序列」为准，语义永远安全（代价是该步在 master 历史里退化为单 step）。 */
  shiftWinStepToMaster(st) {
    const rr = this.winRealRange()
    if (rr.realEnd < rr.realStart) return null // 空窗态
    const ps = stepPositions(st)
    if (ps.every((p) => p >= rr.realStart && p <= rr.realEnd)) {
      return translateStep(st, this.delta)
    }
    return null
  }

  /** master 端整窗替换：master[旧窗口区间] <- 窗口当前实块序列（空窗时区间删空） */
  fullWindowWriteback(newState, winTr, oldMasterWin) {
    const mTr = this.masterState.tr
    const kids = []
    newState.doc.forEach((child, _off, idx) => {
      if (idx > 0 && idx < newState.doc.childCount - 1) kids.push(child)
    })
    // 空窗（oldMasterWin 为 null，区间已在上一轮删空）时退化为插入点
    const at = oldMasterWin || { start: this.blocks[this.i0].offset, end: this.blocks[this.i0].offset }
    mTr.replace(at.start, at.end, kids.length ? new Slice(Fragment.fromArray(kids), 0, 0) : Slice.empty)
    // 选区跟窗口走：窗口选区夹进实块区再平移
    const kidsSize = kids.reduce((s, k) => s + k.nodeSize, 0)
    const rr = { realStart: 1, realEnd: Math.max(1, 1 + kidsSize) }
    mTr.setSelection(selectionToMaster(winTr.selection, this.delta, rr.realStart, rr.realEnd, mTr.doc))
    this.masterState = this.masterState.apply(mTr)
    this.doc = this.masterState.doc
    this.blocks = buildBlockIndex(this.doc)
    this.winState = newState
    this.recomputeBookkeepingFromWinDoc()
    // 空窗态写回后立即重切，让兜底空段被真实块取代（master 端已有对应内容）
    if (newState.doc.childCount < 3) {
      this.openWindow(this.i0, Math.min(this.blockCount, this.i0 + Math.max(1, this.windowSize)))
    }
  }

  /** 窗口 doc 没动（或已定型）时，从窗口实块数反推 i1、从 master 首块 offset 反推 delta */
  recomputeBookkeepingFromWinDoc() {
    const winBlockCount = this.winState.doc.childCount - 2
    this.i1 = this.i0 + winBlockCount
    this.delta = this.blocks[this.i0].offset - 1
  }

  // ———— master 变更 -> 窗口 ————

  /** 外部对 master 的变更（undo/redo 内部走这里；查找替换、AI 写回等 Phase 3 也走这里） */
  applyMasterTr(tr) {
    const oldBlocks = this.blocks
    this.masterState = this.masterState.apply(tr)
    this.doc = this.masterState.doc
    this.blocks = buildBlockIndex(this.doc)
    this.syncWindowFromMaster(tr, oldBlocks)
    this.emit()
  }

  syncWindowFromMaster(tr, oldBlocks) {
    const oldWin = blockRangePos(oldBlocks, this.i0, this.i1)
    if (!oldWin) {
      // master 被清空等极端情况：重切到文档头
      this.openWindow(0, Math.min(this.windowSize, this.blocks.length))
      return
    }
    let allMin = Infinity
    let allMax = -Infinity
    let anyOpen = false
    for (const st of tr.steps) {
      for (const p of stepPositions(st)) {
        allMin = Math.min(allMin, p)
        allMax = Math.max(allMax, p)
      }
      if (st instanceof ReplaceStep && (st.slice.openStart || st.slice.openEnd)) anyOpen = true
    }
    if (allMin === Infinity) {
      // 纯选区/属性事务（无位置 step）：账本不动
      return
    }
    if (allMax < oldWin.start) {
      // Case A（全在窗口前）：窗口 doc 与选区不动，用 mapping（assoc +1 偏右）找
      // 原窗口首块的新位置换算新 i0，窗口外的块数变化由 spacer 高度吸收。
      const newFirst = tr.mapping.map(oldWin.start, 1)
      this.i0 = clamp(posToBlock(this.blocks, newFirst), 0, this.blocks.length - 1)
      this.recomputeBookkeepingFromWinDoc()
      return
    }
    if (allMin > oldWin.end) {
      // Case A（全在窗口后）：i0/delta 与窗口后无关，账本原样。
      this.recomputeBookkeepingFromWinDoc()
      return
    }
    if (allMax === oldWin.start && allMin === oldWin.start && !anyOpen) {
      // 恰在窗口首块边界的块级插入/删除（slice 闭合）：不触窗口内容，按窗口前处理
      const newFirst = tr.mapping.map(oldWin.start, 1)
      this.i0 = clamp(posToBlock(this.blocks, newFirst), 0, this.blocks.length - 1)
      this.recomputeBookkeepingFromWinDoc()
      return
    }
    if (allMin === oldWin.end && allMax === oldWin.end && !anyOpen) {
      // 恰在窗口末块边界的块级操作（slice 闭合）：不影响窗口内容，账本原样
      this.recomputeBookkeepingFromWinDoc()
      return
    }
    const fullyInside = allMin >= oldWin.start && allMax <= oldWin.end
    if (fullyInside) {
      // Case B：变更全在窗口内。master steps 反平移进窗口 state（保 IME/选区映射）。
      const wTr = this.winState.tr
      let ok = true
      for (const st of tr.steps) {
        const shifted = this.shiftMasterStepToWin(st)
        if (shifted) {
          try {
            wTr.step(shifted)
          } catch {
            ok = false
            break
          }
        } else {
          ok = false
          break
        }
      }
      if (ok) {
        // 选区按 step 后的窗口 doc 换算（setSelection 校验 doc 引用必须一致）
        const sel = this.masterSelectionToWin(wTr.doc)
        if (sel) wTr.setSelection(sel)
        this.winState = this.winState.apply(wTr)
        this.recomputeBookkeepingFromWinDoc()
        return
      }
    }
    // Case C：跨界 / 大变更 / 平移失败。窗口端整窗替换为新 master 区间的实块。
    this.rebuildWindowFromMaster()
  }

  shiftMasterStepToWin(st) {
    const rr = this.winRealRange()
    const ps = stepPositions(st)
    if (!ps.every((p) => p >= rr.realStart && p <= rr.realEnd)) return null
    return translateStep(st, -this.delta)
  }

  /** 窗口端整窗替换：窗口实块区间 <- master 新窗口区间内容；选区从 master 恢复 */
  rebuildWindowFromMaster() {
    const newWin = this.masterWinRange()
    const wTr = this.winState.tr
    const rr = this.winRealRange()
    const kids = []
    for (let i = this.i0; i < this.i1; i++) kids.push(this.blocks[i].node)
    wTr.replace(rr.realStart, rr.realEnd, new Slice(Fragment.fromArray(kids), 0, 0))
    // 选区按 replace 后的窗口 doc 换算
    const sel = this.masterSelectionToWin(wTr.doc)
    if (sel) wTr.setSelection(sel)
    this.winState = this.winState.apply(wTr)
    this.recomputeBookkeepingFromWinDoc()
    // i1 可能因窗口端块数变化而不同，统一以窗口 doc 实块数为准（recompute 已做）
  }

  // ———— 历史 ————

  /** 窗口事务平移后照常进 master 历史；undo/redo 在 master 执行、变化同步回窗口 */
  undo() {
    return this.runHistoryCmd(undo)
  }

  redo() {
    return this.runHistoryCmd(redo)
  }

  runHistoryCmd(cmd) {
    let applied = false
    cmd(this.masterState, (tr) => {
      applied = true
      this.applyMasterTr(tr)
    })
    return applied
  }
}
