// canvas-view.js —— P2 画布 / 白板（类 Obsidian Canvas）
// 数据格式遵循 JSON Canvas 规范（.canvas，与 Obsidian 互操作）：
//   { nodes:[{id,type:"text"|"file",x,y,width,height,color?,text?|file?}],
//     edges:[{id,fromNode,fromSide?,toNode,toSide?,label?,color?}] }
// 渲染：SVG + 视口变换（平移/缩放）；交互：拖拽移动、端口连线、角点缩放、双击编辑、删除。
// 文件读写在本模块内完成（复用通用文本命令），脏标记经 onDirty 上报给 main.js 统一驱动保存/切换确认。
import { readMdFile, writeMdFile } from './tauri-bridge.js'

const SVGNS = 'http://www.w3.org/2000/svg'
const PALETTE = {
  '1': '#e5484d', // red
  '2': '#e2922e', // orange
  '3': '#27a83d', // green
  '4': '#0a8dda', // blue
  '5': '#926bcf', // purple
  '6': '#d6589e', // pink
}
const NORMAL = { left: [-1, 0], right: [1, 0], top: [0, -1], bottom: [0, 1] }
const DEFAULT_SIZE = { width: 220, height: 120 }

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7)
}
function el(tag, attrs) {
  const e = document.createElementNS(SVGNS, tag)
  if (attrs) for (const k in attrs) e.setAttribute(k, attrs[k])
  return e
}
function resolveColor(c) {
  if (!c) return null
  return PALETTE[c] || (/^#/.test(c) ? c : null)
}

export function createCanvasView(deps) {
  const { mountEl, setStatus, onDirty, onOpenFile } = deps

  let data = { nodes: [], edges: [] }
  let rel = null // 当前画布库内相对路径
  let dirty = false
  const view = { tx: 0, ty: 0, k: 1 }
  const selected = new Set()
  let drag = null // 进行中的交互
  let editing = null // 正在编辑文本的 textarea
  let zoomLabel = null // 工具条缩放百分比标签（buildToolbar 内赋值，需先于调用声明）
  let undoBtn = null // 撤销/重做按钮（buildToolbar 内赋值，置灰态由 updateHistoryButtons 驱动）
  let redoBtn = null

  // —— DOM 骨架 ——
  mountEl.classList.add('canvas-view')
  mountEl.innerHTML = ''
  const toolbar = document.createElement('div')
  toolbar.className = 'cv-toolbar'
  const surface = document.createElement('div')
  surface.className = 'cv-surface'
  const svg = el('svg')
  svg.setAttribute('class', 'cv-svg')
  const defs = el('defs')
  const marker = el('marker', { id: 'cv-arrow', viewBox: '0 0 10 10', refX: '9', refY: '5', markerWidth: '10', markerHeight: '10', markerUnits: 'userSpaceOnUse', orient: 'auto-start-reverse' })
  marker.appendChild(el('path', { d: 'M0,0 L10,5 L0,10 z', class: 'cv-arrow' }))
  defs.appendChild(marker)
  svg.appendChild(defs)
  const viewport = el('g', { class: 'cv-viewport' })
  const edgeLayer = el('g', { class: 'cv-edges' })
  const nodeLayer = el('g', { class: 'cv-nodes' })
  viewport.appendChild(edgeLayer)
  viewport.appendChild(nodeLayer)
  svg.appendChild(viewport)
  surface.appendChild(svg)
  mountEl.appendChild(toolbar)
  mountEl.appendChild(surface)
  buildToolbar()

  // —— 坐标变换 ——
  function screenToWorld(clientX, clientY) {
    const r = svg.getBoundingClientRect()
    return { x: (clientX - r.left - view.tx) / view.k, y: (clientY - r.top - view.ty) / view.k }
  }
  function applyView() {
    viewport.setAttribute('transform', `translate(${view.tx} ${view.ty}) scale(${view.k})`)
    if (zoomLabel) zoomLabel.textContent = Math.round(view.k * 100) + '%'
  }

  function nodeById(id) {
    return data.nodes.find((n) => n.id === id)
  }
  function anchor(n, side) {
    switch (side) {
      case 'left': return { x: n.x, y: n.y + n.height / 2 }
      case 'right': return { x: n.x + n.width, y: n.y + n.height / 2 }
      case 'top': return { x: n.x + n.width / 2, y: n.y }
      case 'bottom': return { x: n.x + n.width / 2, y: n.y + n.height }
      default: return { x: n.x + n.width / 2, y: n.y + n.height / 2 }
    }
  }
  function autoSide(a, b) {
    const ac = { x: a.x + a.width / 2, y: a.y + a.height / 2 }
    const bc = { x: b.x + b.width / 2, y: b.y + b.height / 2 }
    const dx = bc.x - ac.x
    const dy = bc.y - ac.y
    if (Math.abs(dx) > Math.abs(dy)) return dx > 0 ? 'right' : 'left'
    return dy > 0 ? 'bottom' : 'top'
  }
  function edgeD(e) {
    const src = nodeById(e.fromNode)
    const dst = nodeById(e.toNode)
    if (!src || !dst) return ''
    const fs = e.fromSide || autoSide(src, dst)
    const ts = e.toSide || autoSide(dst, src)
    const a = anchor(src, fs)
    const b = anchor(dst, ts)
    const off = Math.max(30, Math.min(180, Math.hypot(b.x - a.x, b.y - a.y) * 0.4))
    const na = NORMAL[fs]
    const nb = NORMAL[ts]
    const c1 = { x: a.x + na[0] * off, y: a.y + na[1] * off }
    const c2 = { x: b.x + nb[0] * off, y: b.y + nb[1] * off }
    e._mid = { x: (a.x + 3 * c1.x + 3 * c2.x + b.x) / 8, y: (a.y + 3 * c1.y + 3 * c2.y + b.y) / 8 }
    return `M ${a.x} ${a.y} C ${c1.x} ${c1.y} ${c2.x} ${c2.y} ${b.x} ${b.y}`
  }

  // —— 渲染 ——
  function render() {
    edgeLayer.innerHTML = ''
    nodeLayer.innerHTML = ''
    for (const e of data.edges) {
      const col = resolveColor(e.color)
      const path = el('path', { d: edgeD(e), class: 'cv-edge' })
      if (col) path.setAttribute('stroke', col)
      if (e.toEnd === 'arrow') path.setAttribute('marker-end', 'url(#cv-arrow)')
      if (e.fromEnd === 'arrow') path.setAttribute('marker-start', 'url(#cv-arrow)')
      if (selected.has(e.id)) path.classList.add('selected')
      path.addEventListener('pointerdown', (ev) => {
        ev.stopPropagation()
        selected.clear()
        selected.add(e.id)
        render()
      })
      path.addEventListener('dblclick', (ev) => {
        ev.stopPropagation()
        startEditEdge(e)
      })
      edgeLayer.appendChild(path)
      if (e.label) {
        const t = el('text', { x: e._mid ? e._mid.x : 0, y: e._mid ? e._mid.y : 0, class: 'cv-edge-label', 'text-anchor': 'middle' })
        t.textContent = e.label
        edgeLayer.appendChild(t)
      }
    }
    // 分组框先画（垫底），普通卡片后画（在上）
    const ordered = [...data.nodes].sort((a, b) => (a.type === 'group' ? 0 : 1) - (b.type === 'group' ? 0 : 1))
    for (const n of ordered) {
      nodeLayer.appendChild(renderNode(n))
    }
  }

  function renderNode(n) {
    const g = el('g', { class: 'cv-node', transform: `translate(${n.x} ${n.y})`, 'data-node-id': n.id })
    if (selected.has(n.id)) g.classList.add('selected')
    if (drag && drag.kind === 'connect' && drag.hover === n.id) g.classList.add('cv-connect-target')
    const col = resolveColor(n.color)
    if (n.type === 'group') {
      // 分组框（Obsidian 兼容 type:"group"）：填充可穿透，仅边框/标签可点选
      const fill = el('rect', { width: n.width, height: n.height, rx: 14, class: 'cv-group-fill' })
      fill.style.pointerEvents = 'none'
      g.appendChild(fill)
      const border = el('rect', { width: n.width, height: n.height, rx: 14, class: 'cv-group-border' })
      if (col) border.setAttribute('stroke', col)
      g.appendChild(border)
      if (n.label) {
        const t = el('text', { x: 14, y: -10, class: 'cv-group-label' })
        if (col) t.setAttribute('fill', col)
        t.textContent = n.label
        g.appendChild(t)
      }
      if (selected.has(n.id)) {
        const rh = el('rect', { x: n.width - 8, y: n.height - 8, width: 12, height: 12, rx: 2, class: 'cv-resize', 'data-resize': '1' })
        g.appendChild(rh)
      }
      return g
    }
    const rect = el('rect', { width: n.width, height: n.height, rx: 10, class: 'cv-node-rect' })
    if (col) {
      rect.setAttribute('stroke', col)
      rect.setAttribute('stroke-width', '2.5')
    }
    g.appendChild(rect)

    const fo = el('foreignObject', { x: 0, y: 0, width: n.width, height: n.height })
    const box = document.createElement('div')
    box.className = 'cv-node-body'
    if (n.type === 'file') {
      box.classList.add('cv-node-file')
      const name = String(n.file || '').split(/[\\/]/).pop() || '（空文件）'
      box.textContent = '📄 ' + name
      box.title = n.file || ''
    } else {
      box.textContent = n.text || ''
    }
    fo.appendChild(box)
    g.appendChild(fo)

    // 选中态：端口 + 缩放手柄
    if (selected.has(n.id)) {
      for (const side of ['left', 'right', 'top', 'bottom']) {
        const p = anchor({ x: 0, y: 0, width: n.width, height: n.height }, side)
        const port = el('circle', { cx: p.x, cy: p.y, r: 6, class: 'cv-port', 'data-port': side })
        g.appendChild(port)
      }
      const rh = el('rect', { x: n.width - 8, y: n.height - 8, width: 12, height: 12, rx: 2, class: 'cv-resize', 'data-resize': '1' })
      g.appendChild(rh)
    }
    return g
  }

  // —— 脏标记 ——
  function markDirty() {
    if (!dirty) {
      dirty = true
      onDirty && onDirty(true)
    }
  }

  // —— 撤销 / 重做（快照式历史栈，按手势/离散操作粒度入栈）——
  const undoStack = []
  const redoStack = []
  function snapshot() {
    // 深拷数据，并剔除下划线开头的渲染临时字段（_mid 等）
    return JSON.parse(JSON.stringify(data, (k, v) => (k.startsWith('_') ? undefined : v)))
  }
  function updateHistoryButtons() {
    if (undoBtn) undoBtn.disabled = !undoStack.length
    if (redoBtn) redoBtn.disabled = !redoStack.length
  }
  function pushUndo(prev) {
    if (!prev) return
    undoStack.push(prev)
    if (undoStack.length > 100) undoStack.shift()
    redoStack.length = 0
    updateHistoryButtons()
  }
  function undo() {
    if (!undoStack.length) return
    redoStack.push(snapshot())
    data = undoStack.pop()
    selected.clear()
    markDirty()
    render()
    updateHistoryButtons()
  }
  function redo() {
    if (!redoStack.length) return
    undoStack.push(snapshot())
    data = redoStack.pop()
    selected.clear()
    markDirty()
    render()
    updateHistoryButtons()
  }
  // 方向键微调：连按合并为一条撤销记录
  let nudgeSnapshot = null
  let nudgeTimer = null
  function nudge(dx, dy) {
    const set = new Set()
    for (const id of selected) {
      const n = nodeById(id)
      if (!n) continue
      set.add(n)
      if (n.type === 'group') for (const m of membersOf(n)) set.add(m)
    }
    if (!set.size) return
    if (!nudgeSnapshot) nudgeSnapshot = snapshot()
    for (const n of set) {
      n.x += dx
      n.y += dy
    }
    markDirty()
    render()
    clearTimeout(nudgeTimer)
    nudgeTimer = setTimeout(() => {
      pushUndo(nudgeSnapshot)
      nudgeSnapshot = null
    }, 400)
  }

  // —— 交互：pointerdown 分派 ——
  svg.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return
    commitEdit()
    const portEl = e.target.closest('[data-port]')
    const resizeEl = e.target.closest('[data-resize]')
    const nodeEl = e.target.closest('[data-node-id]')
    const w = screenToWorld(e.clientX, e.clientY)

    if (portEl && nodeEl) {
      drag = { kind: 'connect', fromNode: nodeEl.getAttribute('data-node-id'), fromSide: portEl.getAttribute('data-port'), cur: w, hover: null, snapshot: snapshot() }
    } else if (resizeEl && nodeEl) {
      const n = nodeById(nodeEl.getAttribute('data-node-id'))
      drag = { kind: 'resize', node: n, startW: n.width, startH: n.height, origin: w, snapshot: snapshot() }
    } else if (nodeEl) {
      const id = nodeEl.getAttribute('data-node-id')
      if (!selected.has(id)) {
        if (!e.shiftKey) selected.clear()
        selected.add(id)
        render()
      }
      const starts = {}
      for (const nid of selected) {
        const nn = nodeById(nid)
        if (nn) starts[nid] = { x: nn.x, y: nn.y }
      }
      // 拖动分组框时，把落在框内的成员一并带上
      for (const nid of selected) {
        const nn = nodeById(nid)
        if (nn && nn.type === 'group') {
          for (const m of membersOf(nn)) if (!starts[m.id]) starts[m.id] = { x: m.x, y: m.y }
        }
      }
      drag = { kind: 'move', starts, origin: w, moved: false, snapshot: snapshot() }
    } else if (e.shiftKey) {
      // 背景 + Shift：框选（marquee），不平移
      drag = { kind: 'marquee', origin: w, base: new Set(selected) }
    } else {
      // 背景：平移；若几乎没移动则视为点击 → 取消选择
      drag = { kind: 'pan', sx: e.clientX, sy: e.clientY, tx0: view.tx, ty0: view.ty, moved: false }
    }
    window.addEventListener('pointermove', onDragMove)
    window.addEventListener('pointerup', onDragEnd)
    e.preventDefault()
  })

  function onDragMove(e) {
    if (!drag) return
    const w = screenToWorld(e.clientX, e.clientY)
    if (drag.kind === 'pan') {
      view.tx = drag.tx0 + (e.clientX - drag.sx)
      view.ty = drag.ty0 + (e.clientY - drag.sy)
      if (Math.abs(e.clientX - drag.sx) + Math.abs(e.clientY - drag.sy) > 3) drag.moved = true
      applyView()
    } else if (drag.kind === 'move') {
      const dx = w.x - drag.origin.x
      const dy = w.y - drag.origin.y
      if (Math.abs(dx) + Math.abs(dy) > 0.5) drag.moved = true
      for (const nid in drag.starts) {
        const n = nodeById(nid)
        if (n) {
          n.x = Math.round(drag.starts[nid].x + dx)
          n.y = Math.round(drag.starts[nid].y + dy)
        }
      }
      // 智能对齐：拖近其他卡片边缘/中心时磁吸并显示参考线（按住 Alt 临时禁用）
      const moving = Object.keys(drag.starts).map((id) => nodeById(id)).filter(Boolean)
      if (moving.length && !e.altKey) {
        const ids = new Set(Object.keys(drag.starts))
        const snap = computeSnap(moving, ids)
        if (snap.dx || snap.dy) for (const n of moving) { n.x += snap.dx; n.y += snap.dy }
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity
        for (const n of moving) { x0 = Math.min(x0, n.x); y0 = Math.min(y0, n.y); x1 = Math.max(x1, n.x + n.width); y1 = Math.max(y1, n.y + n.height) }
        drawGuides(snap, { x0, y0, x1, y1 })
      } else {
        clearGuides()
      }
      render()
    } else if (drag.kind === 'resize') {
      drag.node.width = Math.max(80, Math.round(drag.startW + (w.x - drag.origin.x)))
      drag.node.height = Math.max(50, Math.round(drag.startH + (w.y - drag.origin.y)))
      render()
    } else if (drag.kind === 'connect') {
      drag.cur = w
      const tol = 28 / view.k // 命中容差（随缩放换算）：允许在目标节点边缘/端口附近放下即算连接
      const hit = hitNode(w, tol)
      drag.hover = hit && hit.id !== drag.fromNode ? hit.id : null
      render()
      drawTempEdge()
    } else if (drag.kind === 'marquee') {
      drawMarquee(drag.origin, w)
      selected.clear()
      for (const id of drag.base) selected.add(id)
      for (const n of nodesInRect(drag.origin, w)) selected.add(n.id)
      render()
    }
  }

  function onDragEnd(e) {
    window.removeEventListener('pointermove', onDragMove)
    window.removeEventListener('pointerup', onDragEnd)
    if (!drag) return
    const d = drag
    drag = null
    if (d.kind === 'pan') {
      if (!d.moved) {
        selected.clear()
        render()
      }
    } else if (d.kind === 'marquee') {
      clearMarquee()
      render()
    } else if (d.kind === 'move') {
      clearGuides()
      if (d.moved) {
        pushUndo(d.snapshot)
        markDirty()
      }
    } else if (d.kind === 'resize') {
      if (d.node && (d.node.width !== d.startW || d.node.height !== d.startH)) {
        pushUndo(d.snapshot)
        markDirty()
      }
    } else if (d.kind === 'connect') {
      removeTempEdge()
      if (d.hover) {
        const src = nodeById(d.fromNode)
        const dst = nodeById(d.hover)
        pushUndo(d.snapshot)
        data.edges.push({
          id: uid(),
          fromNode: d.fromNode,
          fromSide: d.fromSide || autoSide(src, dst),
          toNode: d.hover,
          toSide: autoSide(dst, src),
          toEnd: 'arrow',
        })
        markDirty()
      }
      render()
    }
  }

  function hitNode(w, margin = 0) {
    for (let i = data.nodes.length - 1; i >= 0; i--) {
      const n = data.nodes[i]
      if (n.type === 'group') continue // 连线目标不含分组框
      if (w.x >= n.x - margin && w.x <= n.x + n.width + margin && w.y >= n.y - margin && w.y <= n.y + n.height + margin) return n
    }
    return null
  }

  // 框选 marquee
  let marqueeRect = null
  function drawMarquee(a, b) {
    if (!marqueeRect) {
      marqueeRect = el('rect', { class: 'cv-marquee' })
      viewport.appendChild(marqueeRect)
    }
    marqueeRect.setAttribute('x', Math.min(a.x, b.x))
    marqueeRect.setAttribute('y', Math.min(a.y, b.y))
    marqueeRect.setAttribute('width', Math.abs(a.x - b.x))
    marqueeRect.setAttribute('height', Math.abs(a.y - b.y))
  }
  function clearMarquee() {
    if (marqueeRect && marqueeRect.parentNode) marqueeRect.parentNode.removeChild(marqueeRect)
    marqueeRect = null
  }
  function nodesInRect(a, b) {
    const x0 = Math.min(a.x, b.x), x1 = Math.max(a.x, b.x)
    const y0 = Math.min(a.y, b.y), y1 = Math.max(a.y, b.y)
    return data.nodes.filter((n) => n.type !== 'group' && n.x < x1 && n.x + n.width > x0 && n.y < y1 && n.y + n.height > y0)
  }

  // 智能对齐：磁吸 + 参考线
  let guideEls = []
  function computeSnap(moving, idsSet) {
    const tol = 8 / view.k
    let mnx = Infinity, mny = Infinity, mxx = -Infinity, mxy = -Infinity
    for (const n of moving) {
      mnx = Math.min(mnx, n.x); mny = Math.min(mny, n.y)
      mxx = Math.max(mxx, n.x + n.width); mxy = Math.max(mxy, n.y + n.height)
    }
    const mxC = (mnx + mxx) / 2, myC = (mny + mxy) / 2
    const xs = [], ys = []
    for (const n of data.nodes) {
      if (idsSet.has(n.id)) continue
      xs.push(n.x, n.x + n.width / 2, n.x + n.width)
      ys.push(n.y, n.y + n.height / 2, n.y + n.height)
    }
    let dx = 0, dxAbs = tol, vx = null
    for (const mv of [mnx, mxC, mxx]) for (const s of xs) {
      const d = s - mv
      if (Math.abs(d) < dxAbs) { dxAbs = Math.abs(d); dx = d; vx = s }
    }
    let dy = 0, dyAbs = tol, hy = null
    for (const mv of [mny, myC, mxy]) for (const s of ys) {
      const d = s - mv
      if (Math.abs(d) < dyAbs) { dyAbs = Math.abs(d); dy = d; hy = s }
    }
    return { dx: Math.round(dx), dy: Math.round(dy), vx, hy }
  }
  function drawGuides(g, bbox) {
    clearGuides()
    if (g.vx != null) {
      const l = el('line', { x1: g.vx, y1: bbox.y0 - 20, x2: g.vx, y2: bbox.y1 + 20, class: 'cv-guide' })
      viewport.appendChild(l); guideEls.push(l)
    }
    if (g.hy != null) {
      const l = el('line', { x1: bbox.x0 - 20, y1: g.hy, x2: bbox.x1 + 20, y2: g.hy, class: 'cv-guide' })
      viewport.appendChild(l); guideEls.push(l)
    }
  }
  function clearGuides() {
    for (const e of guideEls) if (e.parentNode) e.parentNode.removeChild(e)
    guideEls = []
  }

  // 连线预览临时线
  let tempEdge = null
  function drawTempEdge() {
    removeTempEdge()
    const src = nodeById(drag.fromNode)
    if (!src) return
    const dst = drag.hover ? nodeById(drag.hover) : null
    const ref = dst || { x: drag.cur.x, y: drag.cur.y, width: 0, height: 0 }
    const a = anchor(src, drag.fromSide || autoSide(src, ref))
    const end = dst ? anchor(dst, autoSide(dst, src)) : { x: drag.cur.x, y: drag.cur.y }
    tempEdge = el('path', { d: `M ${a.x} ${a.y} L ${end.x} ${end.y}`, class: 'cv-temp-edge' })
    edgeLayer.appendChild(tempEdge)
  }
  function removeTempEdge() {
    if (tempEdge && tempEdge.parentNode) tempEdge.parentNode.removeChild(tempEdge)
    tempEdge = null
  }

  // 双击：节点编辑文字 / 背景新建卡片 / 文件节点打开
  svg.addEventListener('dblclick', (e) => {
    const nodeEl = e.target.closest('[data-node-id]')
    if (nodeEl) {
      const n = nodeById(nodeEl.getAttribute('data-node-id'))
      if (!n) return
      if (n.type === 'file') {
        onOpenFile && onOpenFile(n.file)
        return
      }
      startEdit(n, n.type === 'group' ? 'label' : 'text')
      return
    }
    const w = screenToWorld(e.clientX, e.clientY)
    addNode(w.x - DEFAULT_SIZE.width / 2, w.y - DEFAULT_SIZE.height / 2)
  })

  // 滚轮缩放（以光标为锚）
  svg.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault()
      const r = svg.getBoundingClientRect()
      const sx = e.clientX - r.left
      const sy = e.clientY - r.top
      const wx = (sx - view.tx) / view.k
      const wy = (sy - view.ty) / view.k
      const factor = Math.exp(-e.deltaY * 0.0015)
      view.k = Math.min(3, Math.max(0.2, view.k * factor))
      view.tx = sx - wx * view.k
      view.ty = sy - wy * view.k
      applyView()
    },
    { passive: false }
  )

  // —— 文本编辑浮层 ——
  function startEdit(n, field = 'text') {
    commitEdit()
    const undoPrev = snapshot()
    const ta = document.createElement('textarea')
    ta.className = field === 'label' ? 'cv-edit cv-edit-edge' : 'cv-edit'
    ta.value = n[field] || ''
    const sx = n.x * view.k + view.tx
    const sy = n.y * view.k + view.ty
    ta.style.left = sx + 'px'
    ta.style.top = (field === 'label' ? sy - 30 : sy) + 'px'
    ta.style.width = (field === 'label' ? Math.max(160, n.width * view.k) : n.width * view.k) + 'px'
    ta.style.height = (field === 'label' ? 32 : n.height * view.k) + 'px'
    surface.appendChild(ta)
    ta.focus()
    ta.setSelectionRange(ta.value.length, ta.value.length)
    editing = { node: n, ta, field, undoPrev }
    ta.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape') {
        ev.stopPropagation()
        commitEdit()
      }
    })
    ta.addEventListener('blur', () => commitEdit())
  }
  function commitEdit() {
    if (!editing) return
    const { node, ta, field, undoPrev } = editing
    const v = ta.value
    editing = null
    if (ta.parentNode) ta.parentNode.removeChild(ta)
    if ((node[field] || '') !== v) {
      if (undoPrev) pushUndo(undoPrev)
      node[field] = v
      markDirty()
      render()
    }
  }

  function startEditEdge(edge) {
    commitEdit()
    const undoPrev = snapshot()
    const ta = document.createElement('textarea')
    ta.className = 'cv-edit cv-edit-edge'
    ta.value = edge.label || ''
    const mid = edge._mid || { x: 0, y: 0 }
    const sx = mid.x * view.k + view.tx
    const sy = mid.y * view.k + view.ty
    ta.style.left = sx - 70 + 'px'
    ta.style.top = sy - 13 + 'px'
    ta.style.width = '140px'
    ta.style.height = '26px'
    surface.appendChild(ta)
    ta.focus()
    ta.setSelectionRange(ta.value.length, ta.value.length)
    editing = { node: edge, ta, field: 'label', undoPrev }
    ta.addEventListener('keydown', (ev) => {
      if (ev.key === 'Escape') {
        ev.stopPropagation()
        commitEdit()
      }
    })
    ta.addEventListener('blur', () => commitEdit())
  }

  // —— 模型操作 ——
  function addNode(x, y, type) {
    pushUndo(snapshot())
    const n = { id: uid(), type: type || 'text', x: Math.round(x), y: Math.round(y), width: DEFAULT_SIZE.width, height: DEFAULT_SIZE.height, text: '' }
    data.nodes.push(n)
    selected.clear()
    selected.add(n.id)
    markDirty()
    render()
    if (n.type === 'text') startEdit(n)
    return n
  }
  function deleteSelection() {
    if (!selected.size) return
    pushUndo(snapshot())
    const ids = new Set(selected)
    data.nodes = data.nodes.filter((n) => !ids.has(n.id))
    data.edges = data.edges.filter((e) => !ids.has(e.id) && !ids.has(e.fromNode) && !ids.has(e.toNode))
    selected.clear()
    markDirty()
    render()
  }
  function setColor(c) {
    const prev = snapshot()
    let hit = false
    for (const id of selected) {
      const n = nodeById(id)
      if (n) {
        n.color = c
        hit = true
      }
    }
    if (hit) {
      pushUndo(prev)
      markDirty()
      render()
    }
  }
  function membersOf(g) {
    return data.nodes.filter(
      (n) =>
        n.id !== g.id && n.type !== 'group' &&
        n.x + n.width / 2 > g.x && n.x + n.width / 2 < g.x + g.width &&
        n.y + n.height / 2 > g.y && n.y + n.height / 2 < g.y + g.height
    )
  }
  function selectedCards() {
    return data.nodes.filter((n) => selected.has(n.id) && n.type !== 'group')
  }
  function alignSelection(mode) {
    const nodes = selectedCards()
    if (nodes.length < 2) return
    pushUndo(snapshot())
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    for (const n of nodes) {
      minX = Math.min(minX, n.x); minY = Math.min(minY, n.y)
      maxX = Math.max(maxX, n.x + n.width); maxY = Math.max(maxY, n.y + n.height)
    }
    for (const n of nodes) {
      if (mode === 'left') n.x = minX
      else if (mode === 'right') n.x = maxX - n.width
      else if (mode === 'hcenter') n.x = Math.round(minX + (maxX - minX - n.width) / 2)
      else if (mode === 'top') n.y = minY
      else if (mode === 'bottom') n.y = maxY - n.height
      else if (mode === 'vcenter') n.y = Math.round(minY + (maxY - minY - n.height) / 2)
    }
    markDirty(); render()
  }
  function distributeSelection(axis) {
    const nodes = selectedCards()
    if (nodes.length < 3) return
    pushUndo(snapshot())
    nodes.sort((a, b) => (axis === 'h' ? a.x - b.x : a.y - b.y))
    const first = nodes[0], last = nodes[nodes.length - 1]
    const startC = axis === 'h' ? first.x + first.width / 2 : first.y + first.height / 2
    const endC = axis === 'h' ? last.x + last.width / 2 : last.y + last.height / 2
    const step = (endC - startC) / (nodes.length - 1)
    nodes.forEach((n, i) => {
      const target = startC + step * i
      if (axis === 'h') n.x = Math.round(target - n.width / 2)
      else n.y = Math.round(target - n.height / 2)
    })
    markDirty(); render()
  }
  function groupSelection() {
    const nodes = selectedCards()
    if (nodes.length < 2) return
    pushUndo(snapshot())
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    for (const n of nodes) {
      minX = Math.min(minX, n.x); minY = Math.min(minY, n.y)
      maxX = Math.max(maxX, n.x + n.width); maxY = Math.max(maxY, n.y + n.height)
    }
    const pad = 48
    const g = { id: uid(), type: 'group', x: minX - pad, y: minY - pad, width: maxX - minX + pad * 2, height: maxY - minY + pad * 2, label: '' }
    data.nodes.unshift(g)
    selected.clear(); selected.add(g.id)
    markDirty(); render()
  }
  function ungroupSelection() {
    const ids = [...selected].filter((id) => { const n = nodeById(id); return n && n.type === 'group' })
    if (!ids.length) return
    pushUndo(snapshot())
    data.nodes = data.nodes.filter((n) => !ids.includes(n.id))
    selected.clear(); markDirty(); render()
  }
  // —— 复制 / 粘贴 / 重复 ——
  let clipboard = { nodes: [], edges: [] }
  function clone(v) {
    return JSON.parse(JSON.stringify(v, (k, val) => (k.startsWith('_') ? undefined : val)))
  }
  function copySelection() {
    const ids = new Set(selected)
    if (!ids.size) return
    const nodes = data.nodes.filter((n) => ids.has(n.id)).map(clone)
    const edges = data.edges.filter((e) => ids.has(e.fromNode) && ids.has(e.toNode)).map(clone)
    clipboard = { nodes, edges }
    setStatus && setStatus('已复制 ' + nodes.length + ' 个元素')
  }
  function pasteClipboard() {
    if (!clipboard.nodes.length) return
    pushUndo(snapshot())
    const idMap = {}
    const newNodes = clipboard.nodes.map((n) => {
      const id = uid()
      idMap[n.id] = id
      const c = clone(n)
      c.id = id
      c.x = (n.x || 0) + 24
      c.y = (n.y || 0) + 24
      return c
    })
    const newEdges = clipboard.edges
      .map((e) => {
        const c = clone(e)
        c.id = uid()
        c.fromNode = idMap[e.fromNode]
        c.toNode = idMap[e.toNode]
        return c
      })
      .filter((e) => e.fromNode && e.toNode)
    data.nodes.push(...newNodes)
    data.edges.push(...newEdges)
    selected.clear()
    newNodes.forEach((n) => selected.add(n.id))
    clipboard = { nodes: newNodes.map(clone), edges: newEdges.map(clone) } // 连续粘贴逐级错开
    markDirty()
    render()
  }
  function duplicateSelection() {
    if (!selected.size) return
    copySelection()
    pasteClipboard()
  }
  function fitView() {
    const r = svg.getBoundingClientRect()
    if (r.width < 10 || r.height < 10) {
      requestAnimationFrame(fitView) // 容器尚未完成布局（0×0），下一帧再试，避免用零尺寸算出负平移把卡片甩出屏幕
      return
    }
    if (!data.nodes.length) {
      view.k = 1
      view.tx = 40
      view.ty = 40
      applyView()
      return
    }
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    for (const n of data.nodes) {
      minX = Math.min(minX, n.x)
      minY = Math.min(minY, n.y)
      maxX = Math.max(maxX, n.x + n.width)
      maxY = Math.max(maxY, n.y + n.height)
    }
    const pad = 60
    const k = Math.min(1, Math.max(0.2, Math.min((r.width - pad * 2) / (maxX - minX || 1), (r.height - pad * 2) / (maxY - minY || 1))))
    view.k = k
    view.tx = (r.width - (maxX + minX) * k) / 2
    view.ty = (r.height - (maxY + minY) * k) / 2
    applyView()
  }

  // 缩放控件：以视口中心为锚（键盘/按钮用）
  function zoomAt(factor, sx, sy) {
    const r = svg.getBoundingClientRect()
    if (sx == null) {
      sx = r.width / 2
      sy = r.height / 2
    }
    const wx = (sx - view.tx) / view.k
    const wy = (sy - view.ty) / view.k
    view.k = Math.min(3, Math.max(0.2, view.k * factor))
    view.tx = sx - wx * view.k
    view.ty = sy - wy * view.k
    applyView()
  }
  function resetZoom() {
    const r = svg.getBoundingClientRect()
    const sx = r.width / 2
    const sy = r.height / 2
    const wx = (sx - view.tx) / view.k
    const wy = (sy - view.ty) / view.k
    view.k = 1
    view.tx = sx - wx
    view.ty = sy - wy
    applyView()
  }

  // —— 键盘 ——
  function onKeyDown(e) {
    if (mountEl.classList.contains('hidden')) return
    if (editing) return
    const mod = e.ctrlKey || e.metaKey
    if (mod && (e.key === 'z' || e.key === 'Z')) {
      e.preventDefault()
      if (e.shiftKey) redo()
      else undo()
      return
    }
    if (mod && (e.key === 'y' || e.key === 'Y')) {
      e.preventDefault()
      redo()
      return
    }
    if (mod && (e.key === 'a' || e.key === 'A')) {
      e.preventDefault()
      selected.clear()
      for (const n of data.nodes) if (n.type !== 'group') selected.add(n.id)
      render()
      return
    }
    if (mod && (e.key === 'c' || e.key === 'C')) {
      e.preventDefault()
      copySelection()
      return
    }
    if (mod && (e.key === 'v' || e.key === 'V')) {
      e.preventDefault()
      pasteClipboard()
      return
    }
    if (mod && (e.key === 'd' || e.key === 'D')) {
      e.preventDefault()
      duplicateSelection()
      return
    }
    if (mod && (e.key === '=' || e.key === '+')) {
      e.preventDefault()
      zoomAt(1.2)
      return
    }
    if (mod && (e.key === '-' || e.key === '_')) {
      e.preventDefault()
      zoomAt(1 / 1.2)
      return
    }
    if (mod && e.key === '0') {
      e.preventDefault()
      resetZoom()
      return
    }
    if (e.key.indexOf('Arrow') === 0 && selected.size) {
      const s = e.shiftKey ? 10 : 1
      if (e.key === 'ArrowLeft') {
        e.preventDefault()
        nudge(-s, 0)
      } else if (e.key === 'ArrowRight') {
        e.preventDefault()
        nudge(s, 0)
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        nudge(0, -s)
      } else if (e.key === 'ArrowDown') {
        e.preventDefault()
        nudge(0, s)
      }
      return
    }
    if (e.key === 'Delete' || e.key === 'Backspace') {
      if (selected.size) {
        e.preventDefault()
        deleteSelection()
      }
    } else if (e.key === 'Escape') {
      selected.clear()
      render()
    }
  }
  document.addEventListener('keydown', onKeyDown)

  // —— 工具条 ——
  function buildToolbar() {
    const mk = (label, title, fn) => {
      const b = document.createElement('button')
      b.textContent = label
      b.title = title
      b.addEventListener('click', fn)
      return b
    }
    undoBtn = mk('↶', '撤销（Ctrl+Z）', undo)
    redoBtn = mk('↷', '重做（Ctrl+Shift+Z / Ctrl+Y）', redo)
    toolbar.appendChild(undoBtn)
    toolbar.appendChild(redoBtn)
    const sepU = document.createElement('span'); sepU.className = 'cv-sep'; toolbar.appendChild(sepU)
    toolbar.appendChild(mk('➕ 卡片', '新建文本卡片（或双击画布空白处）', () => {
      const c = centerWorld()
      addNode(c.x - DEFAULT_SIZE.width / 2, c.y - DEFAULT_SIZE.height / 2)
    }))
    toolbar.appendChild(mk('🗑 删除', '删除选中（Delete）', deleteSelection))
    toolbar.appendChild(mk('⤢ 适应', '缩放至显示全部卡片', fitView))

    const sepA = document.createElement('span'); sepA.className = 'cv-sep'; toolbar.appendChild(sepA)
    toolbar.appendChild(mk('⬅', '左对齐（选中≥２）', () => alignSelection('left')))
    toolbar.appendChild(mk('↔', '水平居中对齐', () => alignSelection('hcenter')))
    toolbar.appendChild(mk('➡', '右对齐', () => alignSelection('right')))
    toolbar.appendChild(mk('⬆', '顶对齐', () => alignSelection('top')))
    toolbar.appendChild(mk('↕', '垂直居中对齐', () => alignSelection('vcenter')))
    toolbar.appendChild(mk('⬇', '底对齐', () => alignSelection('bottom')))
    toolbar.appendChild(mk('⇄', '水平等距分布（选中≥３）', () => distributeSelection('h')))
    toolbar.appendChild(mk('⇅', '垂直等距分布（选中≥３）', () => distributeSelection('v')))

    const sepG = document.createElement('span'); sepG.className = 'cv-sep'; toolbar.appendChild(sepG)
    toolbar.appendChild(mk('⬚ 编组', '把选中卡片收进一个分组框（拖框边可整体移动）', groupSelection))
    toolbar.appendChild(mk('⬚ 解组', '删除选中的分组框（卡片保留）', ungroupSelection))

    const sep = document.createElement('span')
    sep.className = 'cv-sep'
    toolbar.appendChild(sep)
    const sw = document.createElement('span')
    sw.className = 'cv-colors'
    sw.appendChild(colorSwatch(null, '默认'))
    for (const key of Object.keys(PALETTE)) sw.appendChild(colorSwatch(key, '颜色 ' + key))
    toolbar.appendChild(sw)

    const sp = document.createElement('span')
    sp.className = 'spacer'
    toolbar.appendChild(sp)
    toolbar.appendChild(mk('−', '缩小（Ctrl -）', () => zoomAt(1 / 1.2)))
    zoomLabel = document.createElement('span')
    zoomLabel.className = 'cv-zoom'
    zoomLabel.title = '点击重置为 100%（Ctrl+0）'
    zoomLabel.style.cursor = 'pointer'
    zoomLabel.addEventListener('click', resetZoom)
    toolbar.appendChild(zoomLabel)
    toolbar.appendChild(mk('＋', '放大（Ctrl+）', () => zoomAt(1.2)))
  }
  function colorSwatch(c, title) {
    const s = document.createElement('button')
    s.className = 'cv-swatch'
    s.title = title
    s.style.background = resolveColor(c) || 'var(--bg)'
    s.addEventListener('click', () => setColor(c))
    return s
  }
  function centerWorld() {
    const r = svg.getBoundingClientRect()
    return screenToWorld(r.left + r.width / 2, r.top + r.height / 2)
  }

  // —— 对外 API ——
  async function open(path) {
    commitEdit()
    const text = await readMdFile(deps.getVaultRoot(), path)
    let parsed
    try {
      parsed = text.trim() ? JSON.parse(text) : { nodes: [], edges: [] }
    } catch (err) {
      throw new Error('画布 JSON 解析失败：' + ((err && err.message) || err))
    }
    data = {
      nodes: Array.isArray(parsed.nodes) ? parsed.nodes : [],
      edges: Array.isArray(parsed.edges) ? parsed.edges : [],
    }
    rel = path
    dirty = false
    onDirty && onDirty(false)
    selected.clear()
    undoStack.length = 0
    redoStack.length = 0
    updateHistoryButtons()
    render()
    fitView()
  }

  async function newBlank(path) {
    data = { nodes: [], edges: [] }
    rel = path
    dirty = true
    onDirty && onDirty(true)
    selected.clear()
    view.k = 1
    view.tx = 80
    view.ty = 80
    applyView()
    addNode(0, 0) // 固定放在世界原点 → 屏幕 (80,80)，不依赖容器尺寸，永不出屏
    undoStack.length = 0
    redoStack.length = 0
    updateHistoryButtons()
  }

  async function save() {
    if (!rel) return
    await writeMdFile(deps.getVaultRoot(), rel, JSON.stringify(data, (k, v) => (k.startsWith('_') ? undefined : v), 2))
    dirty = false
    onDirty && onDirty(false)
  }

  function isDirty() {
    return dirty
  }
  function currentRel() {
    return rel
  }
  function destroy() {
    document.removeEventListener('keydown', onKeyDown)
  }

  applyView()
  updateHistoryButtons()
  return { open, newBlank, save, isDirty, currentRel, render, destroy }
}
