// pane-drag.js —— 窗格拖拽引擎（spec 2026-10-19-pane-drag）
//
// 标签 / 文件树条目 → 窗格：跨窗格移动、落边拆分、标签条内排序。
//
// 走 pointer 事件（与 .nl-resizer 同源），不用 HTML5 DnD：外部文件拖入已经占着
// .body 的 drop 事件（drop-open.js 只认 dataTransfer.files），两套 DnD 混在同一批
// 元素上会互相抢，且 dragover 里拿不到稳定的落区判定。
//
// 本模块只管「按下 → 过阈值 → 跟手 + 高亮落区 → 松手派发」，落定动作交给调用方
// （main.js 的 handlePaneDrop）。DOM 访问全在 createPaneDrag 里，纯函数部分
// （dropZoneFor / tabDropIndex）可在 Node 直接单测。

export const EDGE = 0.25
export const THRESHOLD = 4

/**
 * 落点属于窗格的哪一块：外圈 25% 是四个拆分落区，其余是中心（并入该窗格）。
 * 角落按「离哪条边更近」判定，不会同时命中两轴。
 * @returns {'left'|'right'|'top'|'bottom'|'center'}
 */
export function dropZoneFor(rect, x, y, { edge = EDGE } = {}) {
  const w = rect.width || 1
  const h = rect.height || 1
  const nearLeft = x - rect.left
  const nearRight = rect.left + w - x
  const nearTop = y - rect.top
  const nearBottom = rect.top + h - y
  const dx = Math.min(nearLeft, nearRight)
  const dy = Math.min(nearTop, nearBottom)
  const rx = dx / w
  const ry = dy / h
  if (rx > edge && ry > edge) return 'center'
  // 取更近的那一轴：横向给左 / 右，纵向给上 / 下
  if (rx <= ry) return nearLeft < nearRight ? 'left' : 'right'
  return nearTop < nearBottom ? 'top' : 'bottom'
}

/**
 * 标签条内排序的插入位置：数出中点 x 在指针左边的标签个数。
 * @param {Array<{left:number,width:number}>} rects 标签矩形（含被拖的那一项）
 * @param {number} x 指针横坐标
 * @param {number} skip 被拖项的下标（不在列表里传 -1）
 */
export function tabDropIndex(rects, x, skip = -1) {
  const list = Array.isArray(rects) ? rects : []
  let n = 0
  for (let i = 0; i < list.length; i++) {
    if (i === skip) continue
    const r = list[i]
    if (r.left + r.width / 2 < x) n++
  }
  // 被拖项要被摘出来再插回去，可插入的上限是摘出后的队尾
  const total = skip >= 0 && skip < list.length ? list.length - 1 : list.length
  const max = Math.max(0, total - 1)
  return Math.min(Math.max(0, n), max)
}

/** 窗格标签条里的标签元素（标签会被 render() 重建，每次现取） */
function tabEls(leaf) {
  if (!leaf || !leaf.querySelectorAll) return []
  return Array.from(leaf.querySelectorAll('.nl-pane-strip-scroll .tab'))
}

/**
 * 建一个拖拽控制器。
 * @param {object} deps
 * @param {(x:number, y:number) => HTMLElement|null} deps.hitLeaf 落点窗格（.nl-pane）
 * @param {(payload:object) => string} deps.labelFor 幽灵标签文案
 * @param {(drop:{payload:object, paneId:string|null, zone:string, tabIndex:number}) => void} deps.onDrop 松手派发
 */
export function createPaneDrag({ hitLeaf, labelFor, onDrop }) {
  let st = null
  let swallowClick = false

  function teardown() {
    if (!st) return
    const { ghost, hint, sourceEl } = st
    if (ghost && ghost.parentNode) ghost.parentNode.removeChild(ghost)
    if (hint && hint.parentNode) hint.parentNode.removeChild(hint)
    if (sourceEl && sourceEl.classList) sourceEl.classList.remove('dragging')
    document.documentElement.classList.remove('nl-dragging')
    st = null
  }

  function activate(ev) {
    st.active = true
    document.documentElement.classList.add('nl-dragging')
    if (st.sourceEl && st.sourceEl.classList) st.sourceEl.classList.add('dragging')
    const ghost = document.createElement('div')
    ghost.className = 'nl-drag-ghost'
    ghost.textContent = labelFor ? labelFor(st.payload) || '' : ''
    document.body.appendChild(ghost)
    st.ghost = ghost
    const hint = document.createElement('div')
    hint.className = 'nl-drop-hint hidden'
    document.body.appendChild(hint)
    st.hint = hint
    place(ev)
  }

  function place(ev) {
    const { ghost, hint } = st
    if (ghost) ghost.style.transform = `translate(${ev.clientX + 12}px, ${ev.clientY + 12}px)`
    if (!hint) return
    const leaf = hitLeaf ? hitLeaf(ev.clientX, ev.clientY) : null
    if (!leaf) {
      st.leaf = null
      st.zone = 'center'
      hint.classList.add('hidden')
      return
    }
    const r = leaf.getBoundingClientRect()
    const zone = dropZoneFor(r, ev.clientX, ev.clientY)
    st.leaf = leaf
    st.zone = zone
    const box =
      zone === 'left'
        ? { left: r.left, top: r.top, width: r.width / 2, height: r.height }
        : zone === 'right'
          ? { left: r.left + r.width / 2, top: r.top, width: r.width / 2, height: r.height }
          : zone === 'top'
            ? { left: r.left, top: r.top, width: r.width, height: r.height / 2 }
            : zone === 'bottom'
              ? { left: r.left, top: r.top + r.height / 2, width: r.width, height: r.height / 2 }
              : { left: r.left, top: r.top, width: r.width, height: r.height }
    hint.style.left = box.left + 'px'
    hint.style.top = box.top + 'px'
    hint.style.width = box.width + 'px'
    hint.style.height = box.height + 'px'
    hint.classList.remove('hidden')
  }

  function onMove(ev) {
    if (!st) return
    if (!st.active) {
      const d = Math.hypot(ev.clientX - st.x0, ev.clientY - st.y0)
      if (d < THRESHOLD) return
      st.active = true
      activate(ev)
      return
    }
    place(ev)
  }

  function onUp(ev) {
    if (!st) return
    const s = st
    if (!s.active) {
      teardown()
      return
    }
    const leaf = s.leaf
    const zone = s.zone
    const paneId = leaf && leaf.dataset ? leaf.dataset.paneId || null : null
    // 排序落点只在「标签落回自己窗格的中心」时算：矩形与下标都现取（标签会重建）
    let tabIndex = -1
    if (paneId && zone === 'center' && s.payload && s.payload.kind === 'tab') {
      const els = tabEls(leaf)
      const rects = els.map((el) => el.getBoundingClientRect())
      tabIndex = tabDropIndex(rects, ev.clientX, els.indexOf(s.sourceEl))
    }
    teardown()
    swallowClick = true
    if (onDrop) onDrop({ payload: s.payload, paneId, zone, tabIndex })
  }

  function cancel() {
    if (!st) return
    teardown()
  }

  function onKey(ev) {
    if (ev.key === 'Escape') cancel()
  }

  // 起拖后松手会跟着来一次 click（切标签 / 打开文件树项）：吞掉紧跟的那一次
  const onCaptureClick = (ev) => {
    if (!swallowClick) return
    swallowClick = false
    ev.stopPropagation()
    ev.preventDefault()
  }
  document.addEventListener('click', onCaptureClick, true)
  window.addEventListener('pointermove', onMove)
  window.addEventListener('pointerup', onUp)
  window.addEventListener('pointercancel', cancel)
  window.addEventListener('keydown', onKey)

  return {
    /**
     * 记录一次按下（真正起拖要等位移过阈值）。
     * @param {PointerEvent} ev
     * @param {{kind:'tab'|'tree', ...}} payload
     * @param {HTMLElement} sourceEl 拖动源（标签元素 / 文件树项）
     */
    begin: (ev, payload, sourceEl) => {
      if (st) return
      swallowClick = false
      st = {
        payload,
        sourceEl,
        x0: ev.clientX,
        y0: ev.clientY,
        active: false,
        ghost: null,
        hint: null,
        leaf: null,
        zone: 'center',
      }
    },
    /** 中断（换知识库 / 关闭窗格时用） */
    cancel,
    destroy() {
      teardown()
      document.removeEventListener('click', onCaptureClick, true)
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', cancel)
      window.removeEventListener('keydown', onKey)
    },
  }
}
