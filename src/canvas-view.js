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
  const marker = el('marker', { id: 'cv-arrow', viewBox: '0 0 10 10', refX: '9', refY: '5', markerWidth: '7', markerHeight: '7', orient: 'auto-start-reverse' })
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
      const path = el('path', { d: edgeD(e), class: 'cv-edge' })
      const col = resolveColor(e.color)
      if (col) path.setAttribute('stroke', col)
      if (selected.has(e.id)) path.classList.add('selected')
      path.addEventListener('pointerdown', (ev) => {
        ev.stopPropagation()
        selected.clear()
        selected.add(e.id)
        render()
      })
      edgeLayer.appendChild(path)
      if (e.label) {
        const t = el('text', { x: e._mid ? e._mid.x : 0, y: e._mid ? e._mid.y : 0, class: 'cv-edge-label', 'text-anchor': 'middle' })
        t.textContent = e.label
        edgeLayer.appendChild(t)
      }
    }
    for (const n of data.nodes) {
      nodeLayer.appendChild(renderNode(n))
    }
  }

  function renderNode(n) {
    const g = el('g', { class: 'cv-node', transform: `translate(${n.x} ${n.y})`, 'data-node-id': n.id })
    if (selected.has(n.id)) g.classList.add('selected')
    if (drag && drag.kind === 'connect' && drag.hover === n.id) g.classList.add('cv-connect-target')
    const col = resolveColor(n.color)
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

  // —— 交互：pointerdown 分派 ——
  svg.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return
    commitEdit()
    const portEl = e.target.closest('[data-port]')
    const resizeEl = e.target.closest('[data-resize]')
    const nodeEl = e.target.closest('[data-node-id]')
    const w = screenToWorld(e.clientX, e.clientY)

    if (portEl && nodeEl) {
      drag = { kind: 'connect', fromNode: nodeEl.getAttribute('data-node-id'), fromSide: portEl.getAttribute('data-port'), cur: w, hover: null }
    } else if (resizeEl && nodeEl) {
      const n = nodeById(nodeEl.getAttribute('data-node-id'))
      drag = { kind: 'resize', node: n, startW: n.width, startH: n.height, origin: w }
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
      drag = { kind: 'move', starts, origin: w, moved: false }
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
    } else if (d.kind === 'move') {
      if (d.moved) markDirty()
    } else if (d.kind === 'resize') {
      markDirty()
    } else if (d.kind === 'connect') {
      removeTempEdge()
      if (d.hover) {
        const src = nodeById(d.fromNode)
        const dst = nodeById(d.hover)
        data.edges.push({
          id: uid(),
          fromNode: d.fromNode,
          fromSide: d.fromSide || autoSide(src, dst),
          toNode: d.hover,
          toSide: autoSide(dst, src),
        })
        markDirty()
      }
      render()
    }
  }

  function hitNode(w, margin = 0) {
    for (let i = data.nodes.length - 1; i >= 0; i--) {
      const n = data.nodes[i]
      if (w.x >= n.x - margin && w.x <= n.x + n.width + margin && w.y >= n.y - margin && w.y <= n.y + n.height + margin) return n
    }
    return null
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
      startEdit(n)
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
  function startEdit(n) {
    commitEdit()
    const ta = document.createElement('textarea')
    ta.className = 'cv-edit'
    ta.value = n.text || ''
    const sx = n.x * view.k + view.tx
    const sy = n.y * view.k + view.ty
    ta.style.left = sx + 'px'
    ta.style.top = sy + 'px'
    ta.style.width = n.width * view.k + 'px'
    ta.style.height = n.height * view.k + 'px'
    surface.appendChild(ta)
    ta.focus()
    ta.setSelectionRange(ta.value.length, ta.value.length)
    editing = { node: n, ta }
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
    const { node, ta } = editing
    const v = ta.value
    editing = null
    if (ta.parentNode) ta.parentNode.removeChild(ta)
    if ((node.text || '') !== v) {
      node.text = v
      markDirty()
      render()
    }
  }

  // —— 模型操作 ——
  function addNode(x, y, type) {
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
    const ids = new Set(selected)
    data.nodes = data.nodes.filter((n) => !ids.has(n.id))
    data.edges = data.edges.filter((e) => !ids.has(e.id) && !ids.has(e.fromNode) && !ids.has(e.toNode))
    selected.clear()
    markDirty()
    render()
  }
  function setColor(c) {
    let hit = false
    for (const id of selected) {
      const n = nodeById(id)
      if (n) {
        n.color = c
        hit = true
      }
    }
    if (hit) {
      markDirty()
      render()
    }
  }
  function fitView() {
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
    const r = svg.getBoundingClientRect()
    const pad = 60
    const k = Math.min(3, Math.max(0.2, Math.min((r.width - pad * 2) / (maxX - minX || 1), (r.height - pad * 2) / (maxY - minY || 1))))
    view.k = k
    view.tx = (r.width - (maxX + minX) * k) / 2
    view.ty = (r.height - (maxY + minY) * k) / 2
    applyView()
  }

  // —— 键盘 ——
  function onKeyDown(e) {
    if (mountEl.classList.contains('hidden')) return
    if (editing) return
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
    toolbar.appendChild(mk('➕ 卡片', '新建文本卡片（或双击画布空白处）', () => {
      const c = centerWorld()
      addNode(c.x - DEFAULT_SIZE.width / 2, c.y - DEFAULT_SIZE.height / 2)
    }))
    toolbar.appendChild(mk('🗑 删除', '删除选中（Delete）', deleteSelection))
    toolbar.appendChild(mk('⤢ 适应', '缩放至显示全部卡片', fitView))

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
    zoomLabel = document.createElement('span')
    zoomLabel.className = 'cv-zoom'
    toolbar.appendChild(zoomLabel)
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
    render()
    fitView()
  }

  async function newBlank(path) {
    data = { nodes: [], edges: [] }
    rel = path
    dirty = true
    onDirty && onDirty(true)
    selected.clear()
    render()
    view.k = 1
    view.tx = 60
    view.ty = 60
    applyView()
    const c = centerWorld()
    addNode(c.x - DEFAULT_SIZE.width / 2, c.y - DEFAULT_SIZE.height / 2)
  }

  async function save() {
    if (!rel) return
    await writeMdFile(deps.getVaultRoot(), rel, JSON.stringify(data, null, 2))
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
  return { open, newBlank, save, isDirty, currentRel, render, destroy }
}
