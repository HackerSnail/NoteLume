// wysiwyg-gutter.js —— 所见即所得编辑器的视觉行号装订线
// 源码模式（CodeMirror）自带行号，这里给 WYSIWYG 对齐同款口径：按折行后的视觉行
// 编号。开关是 features.lineNumbers（设置页「功能开关」，关掉后装订线和左侧留白一起
// 消失）。行号采用窗口化：每帧对全部顶层块只做一次 getBoundingClientRect + 行高估行数的
// 廉价扫描（得连续行号前缀），逐行 top 只在视口窗口内按 startN + i*lineHeight 展开，
// 不再对每个块调 getClientRects（旧做法在 MB 级文档上每次编辑卡数分钟）。mergeLineTops /
// clipToBox 作为行合并纯函数保留（单测覆盖）。overlay 挂在 .editor 里，源码模式 .editor
// 整体 display:none，装订线跟着消失，不会和 CM 叠罗汉。
import { Plugin } from 'prosemirror-state'

// 纯函数：把一组矩形按视觉行合并，返回每行 {top, height}（按 top 升序）。
// 同一视觉行内的矩形（行内 span / 粗体片段 / 基线微差）垂直重叠过半；折行的下一行
// top 至少差一个行盒高度，重叠不过半，不会并进来。jsdom 无布局，测试直接喂数组。
export function mergeLineTops(rects) {
  const list = rects
    .filter((r) => r.bottom > r.top)
    .map((r) => ({ top: r.top, bottom: r.bottom }))
    .sort((a, b) => a.top - b.top || a.bottom - b.bottom)
  const lines = []
  let lineTop = 0
  let lineBottom = -1
  for (const r of list) {
    if (lineBottom >= 0 && r.top < lineBottom - (r.bottom - r.top) * 0.5) {
      lineBottom = Math.max(lineBottom, r.bottom)
      continue
    }
    lineTop = r.top
    lineBottom = r.bottom
    lines.push({ top: lineTop, height: lineBottom - lineTop })
  }
  return lines
}

// 纯函数：丢掉整块落在盒子左右之外的矩形。标题左侧的折叠三角是绝对定位的装饰件，
// 它的盒子会混进 Range 矩形里；它和正文行盒垂直重叠不足一半时会被当成多出一行，
// 装订线就在同一处叠两个号、后面的号全往下串一位。盒子里的矩形（含通栏图片）保留。
// jsdom 无布局，测试直接喂数组。
export function clipToBox(rects, box) {
  return rects.filter((r) => r.right > box.left && r.left < box.right)
}

// 从编辑器 DOM 向上找滚动容器（.nl-pane）：虚拟化窗口按它的 scrollTop / clientHeight 取
function findScroller(dom) {
  let el = dom.parentElement
  while (el && el !== document.body) {
    const cs = getComputedStyle(el)
    if (/(auto|scroll)/.test(cs.overflowY) && el.scrollHeight > el.clientHeight) return el
    el = el.parentElement
  }
  return document.scrollingElement
}

// 纯函数：功能开关是否放行号。读不到（未注入 / 老 settings 无该键）一律算开，
// 与引入开关之前的行为逐字一致。
export function lineNumbersOn(flags) {
  return !flags || flags.lineNumbers !== false
}

class GutterView {
  constructor(view, getFeatures) {
    this.view = view
    this.host = view.dom.parentNode // .editor
    this.getFeatures = getFeatures || null
    this.enabled = false // 当前是否挂载，构造时由 setEnabled 按开关决定
    this.blocks = [] // 每顶层块 {top, h, lh, count, startN}，坐标为 .editor 内容系
    this.lhCache = new Map() // 行高缓存，键 tagName|class（字号变化随实例重建失效）
    this.raf = 0
    this.overlay = document.createElement('div')
    this.overlay.className = 'nl-ln-gutter'
    this.overlay.setAttribute('aria-hidden', 'true')
    this.scroller = findScroller(view.dom)
    this.onScroll = () => this.renderWindow()
    // 窗格宽 / 字号 / 折叠展开等任何引起编辑器尺寸变化的，都要重算行位
    this.ro = new ResizeObserver(() => this.schedule())
    this.setEnabled(this.wanted())
  }

  wanted() {
    return lineNumbersOn(this.getFeatures && this.getFeatures())
  }

  setEnabled(on) {
    if (on === this.enabled) return
    this.enabled = on
    if (on) {
      this.host.classList.add('nl-has-gutter')
      this.host.appendChild(this.overlay)
      if (this.scroller) this.scroller.addEventListener('scroll', this.onScroll, { passive: true })
      this.ro.observe(this.view.dom)
      this.schedule()
      return
    }
    if (this.raf) {
      cancelAnimationFrame(this.raf)
      this.raf = 0
    }
    this.ro.disconnect()
    if (this.scroller) this.scroller.removeEventListener('scroll', this.onScroll)
    this.blocks = []
    this.overlay.remove()
    this.host.classList.remove('nl-has-gutter')
  }

  update(update) {
    // ViewUpdate 上没有本次事务（getMeta 只在 Transaction 上），逐次对一下开关即可，
    // 读的是内存里的 settings，代价与 emoji / 目录块插件同量级
    this.setEnabled(this.wanted())
    if (this.enabled && update.docChanged) this.schedule()
  }

  schedule() {
    if (!this.enabled || this.raf) return
    this.raf = requestAnimationFrame(() => {
      this.raf = 0
      this.recompute()
      this.renderWindow()
    })
  }

  recompute() {
    const view = this.view
    const base = this.host.getBoundingClientRect().top
    const blocks = []
    let n = 1
    // 一次全量廉价扫描：每块只读一次 getBoundingClientRect（定 top）+ clientHeight，
    // 用「内容高（扣 padding）/ 行高」得行数，行号连续。行高按块类型缓存（每种只实测
    // 一次），不再对每块调 getClientRects（旧做法在 MB 级文档上每次编辑卡数分钟的根因）。
    // 逐行 top 在 renderWindow 里只对窗口内的块按 startN + i*lineHeight 展开。
    view.state.doc.forEach((node, offset) => {
      const dom = view.nodeDOM(offset)
      if (!dom || dom.nodeType !== 1) return
      const rect = dom.getBoundingClientRect()
      if (rect.height <= 0) return
      const m = this.metricsOf(dom)
      const contentH = Math.max(0, dom.clientHeight - m.padV)
      const count = Math.max(1, Math.round(contentH / m.lh))
      blocks.push({ top: rect.top - base, h: rect.height, lh: m.lh, count, startN: n })
      n += count
    })
    this.blocks = blocks
  }

  // 块的行高与纵向内边距：按 tagName|class 缓存（每种块型只算一次）。line-height:normal
  // 时用首行文本的实际行盒高兜底（一次 getClientRects，缓存后不再重复）。
  metricsOf(dom) {
    const key = dom.tagName + '|' + (dom.className || '')
    let m = this.lhCache.get(key)
    if (m) return m
    const cs = getComputedStyle(dom)
    let lh = parseFloat(cs.lineHeight)
    if (!lh || Number.isNaN(lh)) lh = this.firstLineHeight(dom) || (parseFloat(cs.fontSize) || 16) * 1.5
    const padV = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0)
    m = { lh, padV }
    this.lhCache.set(key, m)
    return m
  }

  firstLineHeight(dom) {
    try {
      const r = document.createRange()
      r.selectNodeContents(dom)
      const rects = r.getClientRects()
      return rects.length ? rects[0].height : 0
    } catch (_) {
      return 0
    }
  }

  renderWindow() {
    const sc = this.scroller
    if (!sc) return
    const hostRect = this.host.getBoundingClientRect()
    const scRect = sc.getBoundingClientRect()
    // 视口在 .editor 内容坐标里的上下界（hostRect 随滚动走，相减即得，无需再算 scrollTop）
    const top = scRect.top - hostRect.top
    const bottom = top + sc.clientHeight
    const frag = document.createDocumentFragment()
    // blocks 按 top 升序（文档序即视觉序）：越过下界即 break，只处理与视口相交的块
    for (const b of this.blocks) {
      if (b.top > bottom + 100) break
      if (b.top + b.h < top - 100) continue
      // 只在视口 ±40px 的行区间内展开，单个超长块（数万字一段）也不会遍历它的全部行
      const i0 = Math.max(0, Math.floor((top - 40 - b.top) / b.lh))
      const i1 = Math.min(b.count - 1, Math.ceil((bottom + 40 - b.top) / b.lh))
      for (let i = i0; i <= i1; i++) {
        const y = b.top + i * b.lh
        const d = document.createElement('div')
        d.className = 'nl-ln-num'
        d.textContent = b.startN + i
        d.style.top = Math.round(y + Math.max(0, (b.lh - 14) / 2)) + 'px'
        frag.appendChild(d)
      }
    }
    this.overlay.replaceChildren(frag)
  }

  destroy() {
    if (this.raf) cancelAnimationFrame(this.raf)
    this.ro.disconnect()
    if (this.scroller) this.scroller.removeEventListener('scroll', this.onScroll)
    this.overlay.remove()
    this.host.classList.remove('nl-has-gutter')
  }
}

export function createLineNumbersPlugin(getFeatures) {
  return new Plugin({
    view(editorView) {
      return new GutterView(editorView, getFeatures)
    },
  })
}
