// highlight-toolbar.js —— 选区高亮浮动工具栏（p5plan §6.4）
//
// 选中正文文字后贴在选区上方：四个预设色（走 --highlight-* 变量，跟主题换色）+ 自定义
// 取色器 + 清除高亮。点预设色块若选区已是该色则取消（toggle 语义，与加粗一致）。
//  · 按钮统一 mousedown + preventDefault：点下去不抢编辑器的 DOM 选区，否则一碰就散。
//  · 定位容器是 .editor-pane（与查找栏同层，position:relative 且是滚动容器），
//    滚动时按 scrollTop / scrollLeft 补正；上方放不下贴选区下方。
//  · 取色器是原生 input[type=color]，无法 preventDefault 保住选区，但它点完不改变
//    PM 的 state 选区，change 时照常对 view.state.selection 生效。

import { HL_PRESETS } from './editor-schema.js'
import { t, onLocaleChange } from './i18n.js'

/**
 * @param {object} deps
 * @param {HTMLElement} deps.paneEl 定位容器（.editor-pane）
 * @param {() => ({rect:DOMRect, has:boolean, color:string|null}|null)} deps.readState 当前选区状态；null = 不显示
 * @param {(color:string) => void} deps.applyColor 应用（或取消）一个高亮色
 * @param {() => void} deps.clear 清除选区内高亮
 */
export function createHighlightToolbar(deps) {
  const { paneEl, readState, applyColor, clear } = deps
  let bar = null
  let swatches = []
  let clearBtn = null
  let customInput = null
  let lastRect = null
  let scrolling = false

  function build() {
    bar = document.createElement('div')
    bar.className = 'nl-hl-bar'
    bar.setAttribute('role', 'toolbar')
    bar.setAttribute('aria-label', t('hl.bar'))

    swatches = HL_PRESETS.map((name) => {
      const b = document.createElement('button')
      b.type = 'button'
      b.className = 'nl-hl-swatch'
      b.dataset.color = name
      b.title = t('hl.' + name)
      b.setAttribute('aria-label', t('hl.' + name))
      const dot = document.createElement('span')
      dot.className = 'nl-hl-dot'
      dot.style.background = 'var(--highlight-' + name + ')'
      b.appendChild(dot)
      // 保住编辑器选区：按下不移动焦点，click 时才动手
      b.addEventListener('mousedown', (e) => e.preventDefault())
      b.addEventListener('click', () => {
        applyColor(name)
        sync()
      })
      bar.appendChild(b)
      return b
    })

    const sep = document.createElement('span')
    sep.className = 'nl-hl-sep'
    bar.appendChild(sep)

    customInput = document.createElement('input')
    customInput.type = 'color'
    customInput.className = 'nl-hl-custom'
    customInput.value = '#ffd400'
    customInput.title = t('hl.custom')
    customInput.setAttribute('aria-label', t('hl.custom'))
    customInput.addEventListener('change', () => {
      applyColor(customInput.value)
      sync()
    })
    bar.appendChild(customInput)

    clearBtn = document.createElement('button')
    clearBtn.type = 'button'
    clearBtn.className = 'nl-ks-btn'
    clearBtn.textContent = t('hl.clear')
    clearBtn.addEventListener('mousedown', (e) => e.preventDefault())
    clearBtn.addEventListener('click', () => {
      clear()
      sync()
    })
    bar.appendChild(clearBtn)

    paneEl.appendChild(bar)
  }

  function place(rect) {
    const pane = paneEl.getBoundingClientRect()
    const bw = bar.offsetWidth
    const bh = bar.offsetHeight
    let x = rect.left + rect.width / 2 - bw / 2
    x = Math.max(pane.left + 6, Math.min(x, pane.right - bw - 6))
    let y = rect.top - bh - 8
    if (y < pane.top + 4) y = rect.bottom + 8 // 上方贴边：改到选区下方
    y = Math.min(y, pane.bottom - bh - 4)
    // 容器是滚动容器：坐标换算成内容坐标（与查找栏同一套补正）
    bar.style.left = x - pane.left + paneEl.scrollLeft + 'px'
    bar.style.top = y - pane.top + paneEl.scrollTop + 'px'
  }

  function refreshActive(st) {
    for (const b of swatches) b.classList.toggle('active', st.color === b.dataset.color)
    clearBtn.disabled = !st.has
    // 当前选区已是某个色时，取色器显示那个色，方便在此基础上微调
    if (st.color && /^#[0-9a-f]{6}$/i.test(st.color)) customInput.value = st.color
  }

  /** 语言切换：文案直接重取，不重建 DOM（可见状态下位置与激活态不动） */
  function relabel() {
    if (!bar) return
    bar.setAttribute('aria-label', t('hl.bar'))
    swatches.forEach((b) => {
      b.title = t('hl.' + b.dataset.color)
      b.setAttribute('aria-label', t('hl.' + b.dataset.color))
    })
    customInput.title = t('hl.custom')
    customInput.setAttribute('aria-label', t('hl.custom'))
    clearBtn.textContent = t('hl.clear')
  }

  function onScroll() {
    if (lastRect && bar.classList.contains('show')) place(lastRect)
  }

  /** 每次选区变化（PM 事务 / 语言切换）后调用：按 readState 决定显隐与位置 */
  function sync() {
    if (!bar) build()
    const st = readState()
    if (!st || !st.rect) {
      hide()
      return
    }
    lastRect = st.rect
    if (!bar.classList.contains('show')) {
      bar.classList.add('show')
      paneEl.addEventListener('scroll', onScroll)
      document.addEventListener('keydown', onEsc, true)
    }
    place(st.rect)
    refreshActive(st)
  }

  function onEsc(e) {
    if (e.key === 'Escape' && bar.classList.contains('show')) {
      e.preventDefault()
      e.stopPropagation()
      hide()
    }
  }

  function hide() {
    if (!bar) return
    bar.classList.remove('show')
    paneEl.removeEventListener('scroll', onScroll)
    document.removeEventListener('keydown', onEsc, true)
  }

  return { sync, hide, relabel }
}
