// split-pane.js —— 高级拖拽分栏引擎（p5plan §6.1）
//
// 模型：两种节点——
//   { type: 'leaf', id }                        叶子 = 一个编辑窗格
//   { type: 'split', id, orientation, ratio, children: [node, node] }
// ratio 是第一个子占父级空间的比例，夹在 [SPLIT_MIN, SPLIT_MAX]（每侧最小 20%、
// 最大 80%，防止拖没）。orientation: 'horizontal' 左右分，'vertical' 上下分。
//
// DOM：split 节点渲染成 flex 容器（row / column），两个子之间插 4px 分割条；
// 子宽度用 flex-basis: calc(ratio% - 2px)（分割条居中被两厢各摊 2px），
// 第二个子 flex: 1 吃剩下的。改比例只写 flex-basis，不碰 DOM 结构。
//
// 拖拽：pointerdown 落在分割条上即 setPointerCapture——指针后续事件全归这条，
// 窗格里的文字选区、表格手柄都抢不走（p5plan §6.1 要的「跨组件顺滑」）。
// 松手（pointerup）经 onCommit 回调交给调用方即时落盘（§8：拖拽结束即写盘）。
//
// 拆分 / 关闭只做定向 DOM 手术：各搬动一个元素，不整树重建。整树重建会把
// ProseMirror 的 DOM 连根拔起，选中态与插件内部缓存都可能丢。
//
// 纯逻辑（树操作与归一化）不碰 DOM，可 Node 单测（tests/split-pane.test.mjs）。

export const SPLIT_MIN = 0.2
export const SPLIT_MAX = 0.8
export const SPLIT_DEFAULT = 0.5
export const RESIZER_PX = 4

let idSeq = 1

/** 取树里还没用过的最小 id（持久化恢复 + 新建都走它，避免与文件里的旧 id 撞） */
export function freshId(tree, prefix) {
  const used = new Set()
  const walk = (n) => {
    if (!n || typeof n !== 'object') return
    if (n.id) used.add(String(n.id))
    if (Array.isArray(n.children)) n.children.forEach(walk)
  }
  walk(tree)
  let i = idSeq
  while (used.has(prefix + i)) i++
  idSeq = i + 1
  return prefix + i
}

export function isLeaf(n) {
  return !!n && n.type === 'leaf'
}

export function createTree(leafId) {
  return { type: 'leaf', id: leafId }
}

/** 深拷贝一份树（改树前先拷，调用方持有旧树不被动） */
function clone(n) {
  if (isLeaf(n)) return { type: 'leaf', id: n.id }
  return {
    type: 'split',
    id: n.id,
    orientation: n.orientation === 'vertical' ? 'vertical' : 'horizontal',
    ratio: n.ratio,
    children: [clone(n.children[0]), clone(n.children[1])],
  }
}

export function clampRatio(r) {
  // 类型严格：null / '' / 布尔 / 数组都算没给值（Number(null)=0 会混进下限）
  if (r == null || r === '' || typeof r === 'boolean' || Array.isArray(r)) return SPLIT_DEFAULT
  const n = Number(r)
  if (!Number.isFinite(n)) return SPLIT_DEFAULT
  return Math.min(SPLIT_MAX, Math.max(SPLIT_MIN, n))
}

export function paneIds(tree) {
  const out = []
  const walk = (n) => {
    if (!n) return
    if (isLeaf(n)) out.push(n.id)
    else n.children.forEach(walk)
  }
  walk(tree)
  return out
}

/** 叶子所在的父 split（没有父 = 根就是叶子，返回 null） */
function parentSplitOf(node, paneId) {
  if (isLeaf(node)) return null
  for (const c of node.children) {
    if (isLeaf(c) && c.id === paneId) return node
    const hit = parentSplitOf(c, paneId)
    if (hit) return hit
  }
  return null
}

export function parentSplit(tree, paneId) {
  return parentSplitOf(tree, paneId)
}

/**
 * 在 paneId 窗格内插入新分栏：该叶子换成 split，原叶子居第一个子位，新叶子第二。
 * orientation 由调用方给（横 = 左右，竖 = 上下）；新 split 的 ratio 取默认值。
 * 返回新树；paneId 不存在时原样返回。
 */
export function splitPane(tree, paneId, orientation, newPaneId) {
  const next = clone(tree)
  const dir = orientation === 'vertical' ? 'vertical' : 'horizontal'
  // 新 split 当场领 id：持久化（settings.json）与 DOM 的 data-split-id 都认它，
  // 不然后续 setRatio / normalizeTree 全对不上
  const splitId = freshId(tree, 's')
  const walk = (n) => {
    if (isLeaf(n)) {
      if (n.id !== paneId) return false
      const fresh = { type: 'leaf', id: newPaneId }
      n.type = 'split'
      n.id = splitId
      n.orientation = dir
      n.ratio = SPLIT_DEFAULT
      n.children = [{ type: 'leaf', id: paneId }, fresh]
      return true
    }
    return n.children.some(walk)
  }
  walk(next)
  return next
}

/**
 * 关闭 paneId 窗格：从父 split 上摘掉它，父 split 只剩一个子时由那个子顶位
 * （递归向上，可能一路顶到根）。只剩最后一个窗格时调用方应阻止，这里也兜底
 * 返回原树。返回新树。
 */
export function closePane(tree, paneId) {
  if (isLeaf(tree)) return tree // 就一个窗格：不允许关（调用方已挡）
  const next = clone(tree)
  const removeIn = (n) => {
    if (isLeaf(n)) return false
    if (n.children.some((c) => isLeaf(c) && c.id === paneId)) {
      const keep = n.children.find((c) => !(isLeaf(c) && c.id === paneId))
      // 把 keep 整棵子树搬上来顶位（keep 可能是 split，保持其结构）
      n.type = keep.type
      n.id = keep.id
      if (isLeaf(keep)) {
        delete n.orientation
        delete n.ratio
        delete n.children
      } else {
        n.orientation = keep.orientation
        n.ratio = keep.ratio
        n.children = keep.children
      }
      return true
    }
    return n.children.some(removeIn)
  }
  removeIn(next)
  // 顶位后根可能仍是「单子 split」（close 的叶子在深层、其上是单子链）——不会：
  // removeIn 每次都把单子父顶掉，根只剩叶子或双子 split
  return next
}

export function setRatio(tree, splitId, ratio) {
  const next = clone(tree)
  const walk = (n) => {
    if (isLeaf(n)) return false
    if (n.id === splitId) {
      n.ratio = clampRatio(ratio)
      return true
    }
    return n.children.some(walk)
  }
  walk(next)
  return next
}

/** 供设置面板 / 调试：把树拍成可 JSON 化的纯数据 */
export function serializeTree(tree) {
  if (isLeaf(tree)) return { type: 'leaf', id: tree.id }
  return {
    type: 'split',
    id: tree.id,
    orientation: tree.orientation,
    ratio: tree.ratio,
    children: [serializeTree(tree.children[0]), serializeTree(tree.children[1])],
  }
}

/** 校验并就地归一一棵树（orientation / ratio）；不合法返回 null */
function validateTree(raw) {
  const ids = new Set()
  const ok = (n) => {
    if (!n || typeof n !== 'object') return false
    if (isLeaf(n)) {
      if (typeof n.id !== 'string' || !n.id || ids.has(n.id)) return false
      ids.add(n.id)
      return true
    }
    if (n.type !== 'split' || !Array.isArray(n.children) || n.children.length !== 2) return false
    if (typeof n.id !== 'string' || !n.id || ids.has(n.id)) return false
    ids.add(n.id)
    if (!ok(n.children[0]) || !ok(n.children[1])) return false
    n.orientation = n.orientation === 'vertical' ? 'vertical' : 'horizontal'
    n.ratio = clampRatio(n.ratio)
    return true
  }
  return ok(raw) ? raw : null
}

/** 单窗格空布局（坏数据的归宿） */
function singleLayout(fallbackPaneId) {
  return {
    tree: createTree(fallbackPaneId),
    focused: fallbackPaneId,
    tabs: { [fallbackPaneId]: { items: [], active: -1 } },
  }
}

/** 归一一个窗格的标签列：items 去重 / 剔坏项，active 夹到 [-1, len-1] */
function normalizeTabsEntry(entry) {
  const items = []
  if (entry && Array.isArray(entry.items)) {
    for (const it of entry.items) {
      if (!it || typeof it.root !== 'string' || typeof it.rel !== 'string') continue
      if (items.some((x) => x.root === it.root && x.rel === it.rel)) continue
      items.push({ root: it.root, rel: it.rel, canvas: !!it.canvas, scratch: !!it.scratch })
    }
  }
  let active = entry && Number.isInteger(entry.active) ? entry.active : -1
  if (active < 0 || active >= items.length) active = items.length ? 0 : -1
  return { items, active }
}

/**
 * settings.json 里的 panes 段 → 合法布局 { tree, focused, tabs }。两种形状都认：
 *   新形状 { tree, focused, tabs: { paneId: { items, active } } }
 *   旧形状（裸树，完整分栏之前的版本）：迁移——树保留，首个叶子按 fallbackDoc
 *   （workspace.lastFile 那一条）建一个固定标签，其余窗格空列。
 * 坏数据（缺子、类型错、id 撞车、tabs 结构非法）一律修：修不动就退回单窗格——
 * 启动不能因为一份坏分栏配置起不来。
 * @param {any} raw settings.json 的 panes 段
 * @param {string} fallbackPaneId 退回单窗格时用的 id
 * @param {{root:string, rel:string}|null} [fallbackDoc] 旧形状迁移时首窗格的文档
 */
export function normalizeTree(raw, fallbackPaneId, fallbackDoc = null) {
  // 旧形状：raw 自己就是一棵树
  if (raw && (raw.type === 'leaf' || raw.type === 'split')) {
    const tree = validateTree(raw)
    if (!tree) return singleLayout(fallbackPaneId)
    const ids = paneIds(tree)
    const tabs = {}
    for (const id of ids) tabs[id] = { items: [], active: -1 }
    const first = ids[0]
    if (first && fallbackDoc && fallbackDoc.root && fallbackDoc.rel) {
      tabs[first] = { items: [{ root: fallbackDoc.root, rel: fallbackDoc.rel }], active: 0 }
    }
    return { tree, focused: first || fallbackPaneId, tabs }
  }
  // 新形状
  if (raw && typeof raw === 'object' && !Array.isArray(raw) && raw.tree && (raw.tree.type === 'leaf' || raw.tree.type === 'split')) {
    const tree = validateTree(raw.tree)
    if (!tree) return singleLayout(fallbackPaneId)
    const ids = paneIds(tree)
    const tabs = {}
    for (const id of ids) tabs[id] = normalizeTabsEntry(raw.tabs && raw.tabs[id])
    const focused = typeof raw.focused === 'string' && ids.includes(raw.focused) ? raw.focused : ids[0]
    return { tree, focused, tabs }
  }
  return singleLayout(fallbackPaneId)
}

// —— 以下为 DOM 渲染与拖拽 ————————————————————————————————

function basis(ratio) {
  // 分割条居中被两厢各摊 2px：第一个子的可用宽度 = ratio% - 2px
  return `calc(${(ratio * 100).toFixed(4)}% - ${RESIZER_PX / 2}px)`
}

/**
 * 把树挂到 DOM 并返回控制器。
 * @param {object} opts
 * @param {HTMLElement} opts.mountEl 容器（.editor-pane）
 * @param {object} opts.tree 初始树
 * @param {(paneId:string) => HTMLElement} opts.contentFor 叶子内容元素（须同一窗格返回同一元素）
 * @param {(paneId:string) => void} opts.onPaneFocus 窗格获焦（指针落在窗格内）
 * @param {(splitId:string, ratio:number) => void} opts.onRatioCommit 拖拽松手：调用方落盘
 * @param {(splitId:string) => void} [opts.onRatioReset] 双击分割条回默认比例
 */
export function mountSplitTree(opts) {
  const { mountEl, contentFor, onPaneFocus, onRatioCommit, onRatioReset } = opts
  let tree = opts.tree
  const leafEls = new Map() // paneId -> 叶子元素（跨手术保持稳定）
  const splitRefs = new Map() // splitId -> { wrap, first, bar, second }

  function buildLeaf(paneId) {
    let el = leafEls.get(paneId)
    if (!el) {
      el = document.createElement('div')
      el.className = 'nl-pane'
      el.dataset.paneId = paneId
      // capture 阶段：窗格内任何指针落下都算焦点切换，晚于冒泡会被子元素吃掉
      el.addEventListener('pointerdown', () => onPaneFocus(paneId), true)
      el.appendChild(contentFor(paneId))
      leafEls.set(paneId, el)
    }
    return el
  }

  function buildSplit(node) {
    const wrap = document.createElement('div')
    wrap.className = 'nl-split nl-split-' + node.orientation
    wrap.dataset.splitId = node.id
    const first = buildNode(node.children[0])
    const bar = document.createElement('div')
    bar.className = 'nl-resizer nl-resizer-' + node.orientation
    bar.setAttribute('role', 'separator')
    bar.setAttribute('aria-orientation', node.orientation === 'horizontal' ? 'vertical' : 'horizontal')
    bar.title = node.orientation === 'horizontal' ? '拖动调整左右比例（双击回默认）' : '拖动调整上下比例（双击回默认）'
    const second = buildNode(node.children[1])
    wrap.append(first, bar, second)
    const ref = { wrap, bar, node }
    splitRefs.set(node.id, ref)
    applyRatioStyle(ref, node.ratio)
    bindResizer(ref, node)
    return wrap
  }

  function buildNode(node) {
    return isLeaf(node) ? buildLeaf(node.id) : buildSplit(node)
  }

  // 按 split 的「当前」两个子节点刷比例样式。子节点必须从 DOM 现取：拆分 / 关闭的
  // DOM 手术后容器的孩子换了人（旧引用指向已搬走的元素），按缓存引用刷会刷到已经
  // 不在这个容器里的元素上——表现就是第一子带着第二子的样式，占比全乱。
  function applyRatioStyle(ref, ratio) {
    const first = ref.wrap.firstElementChild
    const second = ref.wrap.lastElementChild
    if (!first || !second || first === second) return
    // 第一子必须退出剩余空间分配：.nl-pane / .nl-split 的 CSS 都带 flex-grow:1，
    // 不清零的话第一子会跟第二子对半分剩余空间，实际占比被摊薄（50% 会变成 75%），
    // 拖拽时按指针位置算出的比例也与眼见的分割线位置对不上
    first.style.flexBasis = basis(ratio)
    first.style.flexGrow = '0'
    second.style.flexBasis = '0' // flex:1 已在 CSS 里，这里显式清零避免残留
    second.style.flexGrow = '1'
  }

  // 拆分 / 关闭的 DOM 手术会把一个元素搬去别的位置（原叶子的父 split 换人、兄弟子树
  // 顶位），元素上带着旧位置的 inline flex 样式（第一子 grow:0 + 比例 basis，第二子
  // grow:1 + basis:0）。搬完按新位置的 split 重算一次，否则占比与拖拽映射全错。
  function restyleAncestorSplit(el) {
    const parent = el && el.parentElement ? el.parentElement.closest('.nl-split') : null
    if (parent) {
      const ref = splitRefs.get(parent.dataset.splitId)
      if (ref && ref.node) applyRatioStyle(ref, ref.node.ratio)
      return
    }
    // 直接挂在挂载点下（成了唯一的根孩子）：清掉 inline 样式，交给 CSS 的 flex:1 填满
    if (el && el.style) {
      el.style.flexGrow = ''
      el.style.flexBasis = ''
    }
  }

  function bindResizer(ref, node) {
    let live = node.ratio
    const bar = ref.bar
    bar.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return
      e.preventDefault()
      bar.setPointerCapture(e.pointerId)
      document.documentElement.classList.add('nl-resizing')
      document.documentElement.setAttribute('data-resize-dir', node.orientation)
      const move = (ev) => {
        const r = ref.wrap.getBoundingClientRect()
        const raw =
          node.orientation === 'horizontal'
            ? (ev.clientX - r.left) / r.width
            : (ev.clientY - r.top) / r.height
        live = clampRatio(raw)
        applyRatioStyle(ref, live) // 只改样式：实时预览不重排 DOM
      }
      const up = (ev) => {
        bar.releasePointerCapture(ev.pointerId)
        window.removeEventListener('pointermove', move)
        window.removeEventListener('pointerup', up)
        window.removeEventListener('pointercancel', up)
        document.documentElement.classList.remove('nl-resizing')
        document.documentElement.removeAttribute('data-resize-dir')
        // 拖拽结束即时落盘（§8）；比例没变不打扰调用方
        if (Math.abs(live - node.ratio) > 1e-6) {
          node.ratio = live
          tree = setRatio(tree, node.id, live)
          onRatioCommit(node.id, live)
        }
      }
      window.addEventListener('pointermove', move)
      window.addEventListener('pointerup', up)
      window.addEventListener('pointercancel', up)
    })
    bar.addEventListener('dblclick', () => {
      node.ratio = SPLIT_DEFAULT
      tree = setRatio(tree, node.id, SPLIT_DEFAULT)
      applyRatioStyle(ref, SPLIT_DEFAULT)
      if (onRatioReset) onRatioReset(node.id)
      onRatioCommit(node.id, SPLIT_DEFAULT)
    })
  }

  function render() {
    mountEl.appendChild(buildNode(tree))
  }

  /**
   * 在 paneId 里插入新分栏（DOM 手术：叶子元素原节点搬进新容器，不重建）。
   * 返回新树；调用方据此更新自己的状态与持久化。
   */
  function split(paneId, orientation, newPaneId) {
    const leaf = leafEls.get(paneId)
    if (!leaf) return tree
    const next = splitPane(tree, paneId, orientation, newPaneId)
    // 找到新 split 节点对象（splitPane 是纯函数，这里按 id 找回引用）
    const findSplit = (n) => {
      if (isLeaf(n)) return null
      if (n.children.some((c) => isLeaf(c) && c.id === newPaneId)) return n
      for (const c of n.children) {
        const hit = findSplit(c)
        if (hit) return hit
      }
      return null
    }
    const node = findSplit(next)
    const wrap = document.createElement('div')
    wrap.className = 'nl-split nl-split-' + node.orientation
    wrap.dataset.splitId = node.id
    const bar = document.createElement('div')
    bar.className = 'nl-resizer nl-resizer-' + node.orientation
    bar.setAttribute('role', 'separator')
    bar.setAttribute('aria-orientation', node.orientation === 'horizontal' ? 'vertical' : 'horizontal')
    bar.title = node.orientation === 'horizontal' ? '拖动调整左右比例（双击回默认）' : '拖动调整上下比例（双击回默认）'
    const fresh = buildLeaf(newPaneId)
    // 先让 wrap 顶上空位（leaf 此刻脱离文档），再把 leaf 搬进 wrap 第一位——
    // 顺序反了的话 append 会先把 leaf 搬走，replaceChild 就找不到它了
    leaf.parentNode.replaceChild(wrap, leaf)
    wrap.append(leaf, bar, fresh)
    const ref = { wrap, bar, node }
    splitRefs.set(node.id, ref)
    applyRatioStyle(ref, node.ratio)
    bindResizer(ref, node)
    // wrap 顶了 leaf 的位置，它现在所在的那个 split 的比例样式要按新布局重算
    restyleAncestorSplit(wrap)
    tree = next
    return next
  }

  /** 关闭 paneId（DOM 手术：用兄弟子树顶掉父 split 的位置） */
  function close(paneId) {
    const leaf = leafEls.get(paneId)
    if (!leaf) return tree
    const wrap = leaf.parentNode
    if (!wrap || !wrap.classList.contains('nl-split')) return tree
    const parentId = wrap.dataset.splitId
    // wrap 固定三个子：[first, bar, second]；leaf 是其一，兄弟取另一个
    const sibling = leaf === wrap.firstElementChild ? wrap.lastElementChild : wrap.firstElementChild
    if (!sibling) return tree
    // 记录 splitId → 新树里它已不存在，清掉引用
    splitRefs.delete(parentId)
    const next = closePane(tree, paneId)
    // replaceChild 会先把 sibling 从 wrap 里摘出来再放到 wrap 的位置，子树整体保留
    wrap.parentNode.replaceChild(sibling, wrap)
    // sibling 换了位置（第二子顶上来当第一子 / 或直接成为唯一根孩子），按新位置重算
    restyleAncestorSplit(sibling)
    leafEls.delete(paneId)
    tree = next
    return next
  }

  render()

  return {
    get tree() {
      return tree
    },
    split,
    close,
    /** 窗格内容元素换绑（关闭后再开同一 paneId 时重建用） */
    releaseLeaf(paneId) {
      leafEls.delete(paneId)
    },
  }
}
