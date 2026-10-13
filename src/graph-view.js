// P2 · 简易知识图谱：Canvas 2D 力导向布局
// 零外部依赖；数据来自 Rust get_graph_data()，节点=文档，边=已解析的双链（无向归一 + 权重）。
// 目标：轻量优先，节点数 ≤ 800 流畅；超过时降级为静态预布局并停止每帧迭代。
import { getGraphData } from './tauri-bridge.js'

const CFG = {
  MAX_DYNAMIC_NODES: 800,       // 超过则收敛后停动画
  REPULSION: 3200,              // 库仑斥力系数
  SPRING_LENGTH: 90,            // 边自然长度
  SPRING_K: 0.05,               // 弹簧系数
  CENTER_K: 0.006,              // 向心
  DAMPING: 0.86,                // 速度阻尼
  MAX_V: 12,                    // 单帧最大速度分量
  WARMUP_TICKS: 320,            // 收敛前预热帧数（每帧 5 次 tick）
  COOLDOWN_ALPHA: 0.02,         // 总动能阈值，低于此停止迭代（拖拽/新数据唤醒）
  NODE_MIN_R: 3,
  NODE_MAX_R: 14,
  ZOOM_MIN: 0.35,
  ZOOM_MAX: 3.5,
}

/** 打开图谱模态。onNodeClick(path) 决定点节点跳哪；vaultRoot 用于取数据。 */
export async function openGraph({ vaultRoot, currentPath, onNodeClick, onClose }) {
  const modal = document.getElementById('graph-modal')
  const canvas = document.getElementById('graph-canvas')
  const closeBtn = document.getElementById('graph-close')
  const infoEl = document.getElementById('graph-info')
  if (!modal || !canvas) return

  modal.classList.remove('hidden')
  const data = await getGraphData(vaultRoot)
  const nodes = data.nodes.map((n) => ({
    id: n.path,
    title: n.title || n.path,
    x: (Math.random() - 0.5) * 400,
    y: (Math.random() - 0.5) * 400,
    vx: 0, vy: 0,
    degree: 0,
    fixed: false,
  }))
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const edges = []
  for (const e of data.edges) {
    const a = byId.get(e.s), b = byId.get(e.t)
    if (!a || !b) continue
    a.degree += 1; b.degree += 1
    edges.push({ a, b, w: e.w || 1 })
  }
  const maxDeg = nodes.reduce((m, n) => Math.max(m, n.degree), 1)
  for (const n of nodes) {
    n.r = CFG.NODE_MIN_R + (CFG.NODE_MAX_R - CFG.NODE_MIN_R) * Math.sqrt(n.degree / maxDeg)
  }

  const ctx = canvas.getContext('2d')
  const view = { x: 0, y: 0, scale: 1 }  // 平移 + 缩放
  let hoverNode = null
  let dragNode = null
  let panOrigin = null
  let alpha = 1
  let warmup = CFG.WARMUP_TICKS
  let raf = 0
  let running = true

  function resize() {
    const rect = canvas.getBoundingClientRect()
    const dpr = window.devicePixelRatio || 1
    canvas.width = Math.max(1, Math.floor(rect.width * dpr))
    canvas.height = Math.max(1, Math.floor(rect.height * dpr))
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  }
  resize()
  const ro = new ResizeObserver(resize)
  ro.observe(canvas)

  function tick() {
    // 斥力：n² 但节点少时完全可承受
    for (let i = 0; i < nodes.length; i++) {
      const a = nodes[i]
      for (let j = i + 1; j < nodes.length; j++) {
        const b = nodes[j]
        let dx = b.x - a.x, dy = b.y - a.y
        let d2 = dx * dx + dy * dy
        if (d2 < 1) { dx = (Math.random() - 0.5); dy = (Math.random() - 0.5); d2 = 1 }
        if (d2 > 90000) continue      // 300px 外忽略
        const f = CFG.REPULSION / d2
        const d = Math.sqrt(d2)
        const fx = (dx / d) * f, fy = (dy / d) * f
        if (!a.fixed) { a.vx -= fx; a.vy -= fy }
        if (!b.fixed) { b.vx += fx; b.vy += fy }
      }
    }
    // 弹簧
    for (const e of edges) {
      const dx = e.b.x - e.a.x, dy = e.b.y - e.a.y
      const d = Math.sqrt(dx * dx + dy * dy) || 1
      const target = CFG.SPRING_LENGTH - Math.min(20, (e.w - 1) * 6) // 权重高略拉近
      const f = (d - target) * CFG.SPRING_K
      const fx = (dx / d) * f, fy = (dy / d) * f
      if (!e.a.fixed) { e.a.vx += fx; e.a.vy += fy }
      if (!e.b.fixed) { e.b.vx -= fx; e.b.vy -= fy }
    }
    // 向心 + 阻尼 + 位置更新，同时算总动能
    let ke = 0
    for (const n of nodes) {
      if (n.fixed) { n.vx = 0; n.vy = 0; continue }
      n.vx -= n.x * CFG.CENTER_K
      n.vy -= n.y * CFG.CENTER_K
      n.vx *= CFG.DAMPING; n.vy *= CFG.DAMPING
      // 速度上限
      n.vx = Math.max(-CFG.MAX_V, Math.min(CFG.MAX_V, n.vx))
      n.vy = Math.max(-CFG.MAX_V, Math.min(CFG.MAX_V, n.vy))
      n.x += n.vx; n.y += n.vy
      ke += n.vx * n.vx + n.vy * n.vy
    }
    alpha = Math.min(1, ke / Math.max(1, nodes.length))
  }

  function draw() {
    const rect = canvas.getBoundingClientRect()
    const W = rect.width, H = rect.height
    ctx.clearRect(0, 0, W, H)
    ctx.save()
    ctx.translate(W / 2 + view.x, H / 2 + view.y)
    ctx.scale(view.scale, view.scale)
    // 边
    for (const e of edges) {
      const hot = hoverNode && (e.a === hoverNode || e.b === hoverNode)
      ctx.strokeStyle = hot ? 'rgba(84, 120, 220, 0.85)' : 'rgba(130, 130, 150, 0.28)'
      ctx.lineWidth = (hot ? 1.8 : 1) * Math.min(3, 0.6 + e.w * 0.4)
      ctx.beginPath()
      ctx.moveTo(e.a.x, e.a.y); ctx.lineTo(e.b.x, e.b.y)
      ctx.stroke()
    }
    // 节点
    for (const n of nodes) {
      const isCur = n.id === currentPath
      const isHot = n === hoverNode
      ctx.beginPath()
      ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2)
      if (isCur) {
        ctx.fillStyle = '#e2574c'
      } else if (isHot) {
        ctx.fillStyle = '#5478dc'
      } else {
        ctx.fillStyle = n.degree === 0 ? 'rgba(150,150,160,0.55)' : 'rgba(90, 110, 160, 0.75)'
      }
      ctx.fill()
      if (isCur || isHot) {
        ctx.lineWidth = 1.5
        ctx.strokeStyle = 'rgba(30, 40, 70, 0.6)'
        ctx.stroke()
      }
    }
    // 高亮节点/当前文档显示标签
    ctx.fillStyle = 'rgba(30, 30, 50, 0.92)'
    ctx.font = '12px -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'top'
    for (const n of nodes) {
      if (n === hoverNode || n.id === currentPath || n.r >= 8) {
        const t = n.title.length > 18 ? n.title.slice(0, 17) + '…' : n.title
        ctx.fillText(t, n.x, n.y + n.r + 3)
      }
    }
    ctx.restore()
    // 信息条
    infoEl.textContent = `${nodes.length} 个文档 · ${edges.length} 条链接 · 滚轮缩放 / 拖拽平移 / 拖节点重定位 / 点击节点跳文档`
  }

  function loop() {
    if (!running) return
    // 预热阶段：每帧 5 次 tick 加速收敛
    const steps = warmup > 0 ? 5 : (alpha > CFG.COOLDOWN_ALPHA ? 1 : 0)
    for (let i = 0; i < steps; i++) tick()
    if (warmup > 0) warmup -= steps
    draw()
    raf = requestAnimationFrame(loop)
  }
  raf = requestAnimationFrame(loop)

  // ---- 交互 ----
  function toWorld(evt) {
    const rect = canvas.getBoundingClientRect()
    const sx = evt.clientX - rect.left - rect.width / 2 - view.x
    const sy = evt.clientY - rect.top - rect.height / 2 - view.y
    return { x: sx / view.scale, y: sy / view.scale }
  }
  function pickNode(evt) {
    const p = toWorld(evt)
    for (let i = nodes.length - 1; i >= 0; i--) {
      const n = nodes[i]
      const dx = p.x - n.x, dy = p.y - n.y
      if (dx * dx + dy * dy <= (n.r + 3) * (n.r + 3)) return n
    }
    return null
  }

  canvas.addEventListener('mousedown', (evt) => {
    const n = pickNode(evt)
    if (n) {
      dragNode = n
      n.fixed = true
      canvas.setPointerCapture?.(evt.pointerId)
    } else {
      panOrigin = { mx: evt.clientX, my: evt.clientY, vx: view.x, vy: view.y }
    }
  })
  canvas.addEventListener('mousemove', (evt) => {
    if (dragNode) {
      const p = toWorld(evt)
      dragNode.x = p.x; dragNode.y = p.y
      dragNode.vx = 0; dragNode.vy = 0
      alpha = Math.max(alpha, 0.5)   // 唤醒
      if (warmup === 0 && nodes.length > CFG.MAX_DYNAMIC_NODES) draw()
    } else if (panOrigin) {
      view.x = panOrigin.vx + (evt.clientX - panOrigin.mx)
      view.y = panOrigin.vy + (evt.clientY - panOrigin.my)
    } else {
      const n = pickNode(evt)
      if (n !== hoverNode) { hoverNode = n; canvas.style.cursor = n ? 'pointer' : 'default' }
    }
  })
  canvas.addEventListener('mouseup', (evt) => {
    if (dragNode) {
      const n = dragNode
      dragNode = null
      n.fixed = false
      // 命中判定：位移小于 3px 视为点击
      const p = toWorld(evt)
      const dx = p.x - n.x, dy = p.y - n.y
      if (dx * dx + dy * dy < 9 && onNodeClick) {
        onNodeClick(n.id)
        close()
      }
    }
    panOrigin = null
  })
  canvas.addEventListener('mouseleave', () => { hoverNode = null; panOrigin = null })
  canvas.addEventListener('wheel', (evt) => {
    evt.preventDefault()
    const factor = Math.exp(-evt.deltaY * 0.0015)
    const ns = Math.max(CFG.ZOOM_MIN, Math.min(CFG.ZOOM_MAX, view.scale * factor))
    const rect = canvas.getBoundingClientRect()
    const cx = evt.clientX - rect.left - rect.width / 2
    const cy = evt.clientY - rect.top - rect.height / 2
    // 保持鼠标下的世界点不动
    view.x = cx - (cx - view.x) * (ns / view.scale)
    view.y = cy - (cy - view.y) * (ns / view.scale)
    view.scale = ns
  }, { passive: false })

  function close() {
    if (!running) return
    running = false
    cancelAnimationFrame(raf)
    ro.disconnect()
    modal.classList.add('hidden')
    document.removeEventListener('keydown', onKey)
    closeBtn.removeEventListener('click', close)
    if (onClose) onClose()
  }
  function onKey(e) {
    if (e.key === 'Escape') { e.stopPropagation(); close() }
  }
  closeBtn.addEventListener('click', close)
  document.addEventListener('keydown', onKey)
  // 首次按 Esc 之外，也支持模态层背景点击关闭
  modal.addEventListener('click', (e) => { if (e.target === modal) close() }, { once: true })

  return { close }
}
