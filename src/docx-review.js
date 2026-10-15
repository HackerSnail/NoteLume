// docx-review.js —— Word(.docx) 导入的逐个校对模态（功能项 I·P1）
//
// 左：只读渲染预览（独立 MarkdownIt({html:true}) + markdown-it-footnote，绝不碰主 tokenizer，
//     图片用 preview.images 的 data_b64 拼 data: URL 内联）；
// 右：源码编辑器（复用 source-editor.js 的 CodeMirror），可编辑最终 md；
// 顶：warnings 列表（降级/跳过项，点击尽力定位）+ 标题输入（改标题 → commit 重命名）。
//
// 用法：const decision = await openDocxReview(entry, ctx)
//   返回 { action:'accept', md, newTitle } | { action:'skip' }（Esc / 跳过 = 'skip'）。

import MarkdownIt from 'markdown-it'
import { setIcon } from './icons.js'
import footnote from 'markdown-it-footnote'

// 独立预览实例：html:true（合并表是裸 <table> HTML）、footnote（[^n] 脚注）；
// 'default' preset 已含 table + strikethrough。与主编辑器 tokenizer 完全隔离。
let _md = null
function previewRenderer() {
  if (_md) return _md
  _md = MarkdownIt({ html: true, linkify: false }).use(footnote)
  return _md
}

function basename(p) {
  const s = String(p || '').replace(/\\/g, '/')
  return s.slice(s.lastIndexOf('/') + 1)
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
}

/** 建 basename(<sha12>.<ext>) → data: URL 映射，供预览内联图片 */
function imageMap(images) {
  const m = new Map()
  for (const im of images || []) {
    if (!im.dataB64) continue
    const key = (im.sha256 || '').slice(0, 12) + '.' + (im.ext || 'png')
    m.set(key, `data:image/${mimeSub(im.ext)};base64,${im.dataB64}`)
  }
  return m
}
function mimeSub(ext) {
  const e = String(ext || 'png').toLowerCase()
  return e === 'jpg' ? 'jpeg' : e
}

/**
 * 打开校对模态。
 * @param {object} entry  队列项：{ preview:{ md, title, images, warnings, stats } }
 * @param {object} ctx    { index, total, theme, acceptLabel? }
 */
export function openDocxReview(entry, ctx = {}) {
  const preview = entry.preview || {}
  const imgMap = imageMap(preview.images)

  return new Promise((resolve) => {
    const overlay = document.createElement('div')
    overlay.className = 'nl-docx-overlay'

    const box = document.createElement('div')
    box.className = 'nl-docx'

    // ---- 顶栏：标题 + 进度 + 文件标题输入 ----
    const head = document.createElement('div')
    head.className = 'nl-docx-head'
    const titleEl = document.createElement('div')
    titleEl.className = 'nl-docx-title'
    const pos = ctx.total > 1 ? ` · 第 ${ctx.index + 1}/${ctx.total}` : ''
    titleEl.textContent = '校对导入 Word 文档' + pos
    head.appendChild(titleEl)

    const nameRow = document.createElement('div')
    nameRow.className = 'nl-docx-namerow'
    const nameLabel = document.createElement('span')
    nameLabel.textContent = '标题'
    const nameInput = document.createElement('input')
    nameInput.type = 'text'
    nameInput.className = 'nl-docx-name'
    nameInput.value = preview.title || ''
    nameRow.append(nameLabel, nameInput)
    head.appendChild(nameRow)
    box.appendChild(head)

    // ---- 警告 / 图片报告区 ----
    const warn = (preview.warnings || []).filter((w) => w && (w.message || w.code))
    const reused = (preview.images || []).filter((im) => im.reused).length
    if (warn.length || reused) {
      const wbox = document.createElement('div')
      wbox.className = 'nl-docx-warn'
      if (reused) {
        const r = document.createElement('div')
        r.className = 'nl-docx-warn-item dedup'
        setIcon(r, 'image', `${reused} 张图片命中去重，将引用库中已有文件、不重复存储`)
        wbox.appendChild(r)
      }
      for (const w of warn) {
        const it = document.createElement('div')
        it.className = 'nl-docx-warn-item'
        setIcon(it, 'warning', `[${w.code}] ${w.message}` + (w.locator ? `（${w.locator}）` : ''))
        wbox.appendChild(it)
      }
      box.appendChild(wbox)
    }

    // ---- 主体：左预览 / 右源码 ----
    const body = document.createElement('div')
    body.className = 'nl-docx-body'

    const left = document.createElement('div')
    left.className = 'nl-docx-pane nl-docx-preview'
    const lhead = document.createElement('div')
    lhead.className = 'nl-docx-pane-h'
    lhead.textContent = '渲染预览（只读）'
    const prevWrap = document.createElement('div')
    prevWrap.className = 'nl-docx-render'
    left.append(lhead, prevWrap)

    const right = document.createElement('div')
    right.className = 'nl-docx-pane nl-docx-src'
    const rhead = document.createElement('div')
    rhead.className = 'nl-docx-pane-h'
    rhead.textContent = 'Markdown 源码（可编辑）'
    const cmMount = document.createElement('div')
    cmMount.className = 'nl-docx-cm'
    right.append(rhead, cmMount)

    body.append(left, right)
    box.appendChild(body)

    // ---- 底栏按钮 ----
    const row = document.createElement('div')
    row.className = 'nl-docx-row'
    const skipBtn = document.createElement('button')
    skipBtn.className = 'nl-docx-btn'
    skipBtn.textContent = '跳过此文档'
    const okBtn = document.createElement('button')
    okBtn.className = 'nl-docx-btn primary'
    okBtn.textContent = ctx.acceptLabel || '接受并落库'
    row.append(skipBtn, okBtn)
    box.appendChild(row)

    overlay.appendChild(box)
    document.body.appendChild(overlay)

    // ---- 渲染：md → HTML + 内联图片 ----
    let srcEd = null
    let curMd = preview.md || ''
    const render = () => {
      const html = previewRenderer().render(curMd)
      prevWrap.innerHTML = html
      prevWrap.querySelectorAll('img').forEach((img) => {
        const key = basename(img.getAttribute('src') || '')
        if (imgMap.has(key)) img.setAttribute('src', imgMap.get(key))
      })
    }

    // ---- 关闭 ----
    let done = false
    const close = (val) => {
      if (done) return
      done = true
      document.removeEventListener('keydown', onKey, true)
      if (srcEd) { try { srcEd.destroy() } catch { /* ignore */ } }
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay)
      resolve(val)
    }
    const accept = () => close({ action: 'accept', md: curMd, newTitle: nameInput.value.trim() || null })
    function onKey(e) {
      if (e.key === 'Escape') { e.preventDefault(); close({ action: 'skip' }) }
    }

    skipBtn.addEventListener('click', () => close({ action: 'skip' }))
    okBtn.addEventListener('click', accept)
    overlay.addEventListener('pointerdown', (e) => { if (e.target === overlay) close({ action: 'skip' }) })
    document.addEventListener('keydown', onKey, true)

    // 先画一次预览（用原 md），再异步挂 CodeMirror（编辑后同步回预览）
    render()
    // 动态加载源码编辑器（沿用 editor-view 的懒加载，避免把 CodeMirror 拉进主 chunk）
    // 注意：CM6 的 .cm-editor 默认 height:auto（随内容撑高），而挂载点 .nl-docx-cm 是 overflow:hidden，
    // 不显式声明填充高度+自滚就会“超出被裁切、无法滚动”（主编辑区源码模式靠外层 pane 滚，这里需自滚）。
    import('./source-editor.js').then((m) => m.createSourceEditor({
      mountEl: cmMount,
      theme: ctx.theme || 'light',
      onChange: (text) => { curMd = text; render() },
      themeExtra: {
        '&': { height: '100%' },
        '.cm-scroller': { overflow: 'auto' },
      },
    })).then((ed) => {
      srcEd = ed
      ed.setDoc(curMd)
      if (!done) setTimeout(() => { try { okBtn.focus() } catch { /* ignore */ } }, 0)
    }).catch(() => {
      // CodeMirror 加载失败：退化为原生 textarea，仍保证可编辑与接受
      const ta = document.createElement('textarea')
      ta.className = 'nl-docx-ta'
      ta.value = curMd
      ta.addEventListener('input', () => { curMd = ta.value; render() })
      cmMount.appendChild(ta)
      setTimeout(() => { try { okBtn.focus() } catch { /* ignore */ } }, 0)
    })
  })
}
