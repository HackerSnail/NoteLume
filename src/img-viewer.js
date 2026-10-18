// img-viewer.js —— 库内图片附件的独立查看器（全屏浮层，可缩放/平移）。
// 从文件树点击 PNG/JPG 等附件时调用 openImage(rel, { vaultRoot })，像 Obsidian
// 那样把图单独放大看清楚。图片只读、不进编辑器，故与当前文档/脏状态完全解耦：
// 查看某张图不会打断底下正打开的笔记，Esc 关掉即回到原状。
//
// 读图复用 read_image_data_uri（Rust 读字节转 data: URL，绕开 asset 协议/scope）。
// 传 mdRel='' 让 src 直接相对库根解析——文件树给的正是库内相对路径。

import { readImageDataUri } from './tauri-bridge.js'
import { setIcon, iconHTML } from './icons.js'
import { t } from './i18n.js'

const MIN_ZOOM = 0.1
const MAX_ZOOM = 16

let overlay = null // 浮层根节点（懒建，常驻复用）
let cur = null // 当前查看状态 { rel, vaultRoot, zoom, fitW, natW, natH }
let seq = 0 // 竞态令牌：切图时丢弃过期的异步读图/测量回调

function ensureOverlay() {
  if (overlay) return overlay
  overlay = document.createElement('div')
  overlay.className = 'nl-imgv hidden'
  overlay.innerHTML =
    '<div class="nl-imgv-bar">' +
    '<span class="nl-imgv-title"></span>' +
    '<span class="nl-imgv-spacer"></span>' +
    '<button class="nl-imgv-btn" data-act="out" title="' + t('imgv.zoomOut') + '">' + iconHTML('zoom-out') + '</button>' +
    '<button class="nl-imgv-btn nl-imgv-zoom" data-act="reset" title="' + t('imgv.fitWindow') + '">100%</button>' +
    '<button class="nl-imgv-btn" data-act="in" title="' + t('imgv.zoomIn') + '">' + iconHTML('zoom-in') + '</button>' +
    '<button class="nl-imgv-btn" data-act="actual" title="' + t('imgv.actualSize') + '">1:1</button>' +
    '<button class="nl-imgv-close" data-act="close" title="' + t('imgv.close') + '">' + iconHTML('close') + '</button>' +
    '</div>' +
    '<div class="nl-imgv-stage">' +
    '<img class="nl-imgv-img" alt="" draggable="false" />' +
    '<div class="nl-imgv-hint"></div>' +
    '</div>'
  document.body.appendChild(overlay)

  const bar = overlay.querySelector('.nl-imgv-bar')
  const stage = overlay.querySelector('.nl-imgv-stage')
  const img = overlay.querySelector('.nl-imgv-img')

  bar.addEventListener('click', (e) => {
    const b = e.target.closest('[data-act]')
    if (!b || !cur) return
    const act = b.dataset.act
    if (act === 'close') closeImage()
    else if (act === 'in') setZoom(cur.zoom * 1.25)
    else if (act === 'out') setZoom(cur.zoom / 1.25)
    else if (act === 'reset') setZoom(1)
    else if (act === 'actual') zoomToActual()
  })

  // 点空白（舞台本身，非图片）关闭
  stage.addEventListener('mousedown', (e) => {
    if (e.target === stage) closeImage()
  })
  // 双击图片在「适应」与「放大一档」间切换
  img.addEventListener('dblclick', () => {
    if (cur) setZoom(cur.zoom > 1.01 ? 1 : 2)
  })
  // 滚轮缩放（以鼠标位置无感放大缩小，此处仅按比例缩放，保持简单稳定）
  stage.addEventListener(
    'wheel',
    (e) => {
      if (!cur) return
      e.preventDefault()
      const f = e.deltaY < 0 ? 1.12 : 1 / 1.12
      setZoom(cur.zoom * f)
    },
    { passive: false }
  )

  window.addEventListener('keydown', onKey)
  window.addEventListener('resize', onResize)
  return overlay
}

function onKey(e) {
  if (!overlay || overlay.classList.contains('hidden')) return
  if (e.key === 'Escape') {
    e.preventDefault()
    e.stopPropagation()
    closeImage()
  }
}

function onResize() {
  if (!cur || !overlay || overlay.classList.contains('hidden')) return
  computeFit()
  applySize()
}

// 依据图片自然尺寸与舞台可视区，算出「适应窗口」时的显示宽度（px）。
// fitW 作为 zoom=1 的基准，缩放倍率都相对它计算。
function computeFit() {
  const stage = overlay.querySelector('.nl-imgv-stage')
  const cs = getComputedStyle(stage)
  const boxW = Math.max(40, stage.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight))
  const boxH = Math.max(40, stage.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom))
  if (!cur.natW || !cur.natH) {
    // SVG 等可能报不出自然尺寸：退化为按宽铺满
    cur.fitW = boxW
    return
  }
  const scale = Math.min(boxW / cur.natW, boxH / cur.natH, 1)
  cur.fitW = cur.natW * scale
}

function applySize() {
  const img = overlay.querySelector('.nl-imgv-img')
  const dispW = Math.max(1, cur.fitW * cur.zoom)
  img.style.width = dispW + 'px'
  img.style.height = 'auto'
  const label = overlay.querySelector('.nl-imgv-zoom')
  if (label) label.textContent = Math.round(cur.zoom * 100) + '%'
}

function setZoom(z) {
  if (!cur) return
  cur.zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z))
  applySize()
}

// 1:1：让显示宽度回到图片真实像素宽度（相对 fitW 反算倍率）
function zoomToActual() {
  if (!cur || !cur.fitW) return
  setZoom((cur.natW || cur.fitW) / cur.fitW)
}

function setHint(text, icon) {
  const h = overlay.querySelector('.nl-imgv-hint')
  if (h) {
    setIcon(h, text ? icon : '', text || '')
    h.style.display = text ? 'block' : 'none'
  }
}

/**
 * 打开一张库内图片到查看器。
 * @param {string} rel 库内相对路径（文件树给出，`/` 分隔）
 * @param {{vaultRoot:string}} ctx 当前知识库根
 */
export function openImage(rel, ctx) {
  const vaultRoot = ctx && ctx.vaultRoot
  if (!vaultRoot) return
  ensureOverlay()
  const my = ++seq
  const img = overlay.querySelector('.nl-imgv-img')
  const title = overlay.querySelector('.nl-imgv-title')
  title.textContent = rel
  img.removeAttribute('src')
  img.style.width = ''
  img.style.height = ''
  cur = { rel, vaultRoot, zoom: 1, fitW: 0, natW: 0, natH: 0 }
  overlay.classList.remove('hidden')
  setHint(t('common.loading'))

  img.onload = () => {
    if (my !== seq) return // 已切到别的图，丢弃
    cur.natW = img.naturalWidth || img.videoWidth || 0
    cur.natH = img.naturalHeight || img.videoHeight || 0
    cur.zoom = 1
    computeFit()
    applySize()
    setHint('')
  }
  img.onerror = () => {
    if (my !== seq) return
    setHint(t('imgv.cannotShow'), 'warning')
  }

  readImageDataUri(vaultRoot, '', rel)
    .then((uri) => {
      if (my !== seq) return
      img.src = uri
    })
    .catch((e) => {
      if (my !== seq) return
      setHint(t('imgv.readFailed', { err: (e && e.message) || e }), 'warning')
    })
}

/** 关闭查看器（若未打开则无操作） */
export function closeImage() {
  seq++ // 让任何在途的异步回调作废
  cur = null
  if (overlay) overlay.classList.add('hidden')
}
