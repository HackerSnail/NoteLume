// content/shot.js —— 选区截图剪藏的页面侧助手（isolated world，与 vendor 三件套同一个世界）。
//
// 只做两件事，都不碰网络：
//   prepare()  量出当前选区在视口里的矩形（CSS 像素）。选区有一截在视口外时先把它
//              滚进视口再量一次——截图只能拍到可视视口，滚完的坐标才对得上
//   pageMeta() 取页面标题 / 作者 / 站点 / 关键词（og:* 与 meta 兜底）。截图剪藏是
//              拍画面，不必跑正文提取器
//
// background.js 注入本文件后，用 executeScript 的 func 调 window.__NL_SHOT 上的两个函数。
;(function () {
  'use strict'

  function meta(attr, key) {
    const el = document.querySelector('meta[' + attr + '="' + key + '"]')
    return el ? (el.getAttribute('content') || '').trim() : ''
  }

  function splitKeywords(s) {
    return String(s || '')
      .split(/[,，;；]/)
      .map((t) => t.trim())
      .filter(Boolean)
      .slice(0, 12)
  }

  // 某个 window 里的非空选区。跨域 iframe 读不到，catch 掉
  function selectionIn(win) {
    try {
      const sel = win.getSelection()
      if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null
      const range = sel.getRangeAt(0)
      const rect = range.getBoundingClientRect()
      if (!rect || (rect.width <= 0 && rect.height <= 0)) return null
      return { win: win, range: range, rect: rect, text: String(sel.toString() || '') }
    } catch (e) {
      return null
    }
  }

  // 找选区：先看本 frame，再看同源 iframe（iframe 里的选区本 frame 的 getSelection 读不到）
  function findSelection() {
    const own = selectionIn(window)
    if (own) return { found: own, frameEl: null }
    const frames = document.querySelectorAll('iframe')
    for (const f of frames) {
      let inner = null
      try {
        inner = selectionIn(f.contentWindow)
      } catch (e) {
        inner = null // 跨域 iframe：读不到
      }
      if (inner) return { found: inner, frameEl: f }
    }
    return null
  }

  // 选区矩形换算成页面坐标（iframe 里的选区要加 iframe 自己在页面里的位置）
  function pageBox(hit) {
    const r = hit.found.rect
    if (!hit.frameEl) {
      return { x: r.left, y: r.top, width: r.width, height: r.height }
    }
    const f = hit.frameEl.getBoundingClientRect()
    return { x: f.left + r.left, y: f.top + r.top, width: r.width, height: r.height }
  }

  function sleep(ms) {
    return new Promise(function (r) { setTimeout(r, ms) })
  }

  async function prepare() {
    let hit = findSelection()
    if (!hit) return { ok: false, reason: 'no-selection' }
    const vw = window.innerWidth
    const vh = window.innerHeight
    let box = pageBox(hit)
    const outside = box.x < 0 || box.y < 0 || box.x + box.width > vw || box.y + box.height > vh
    if (outside) {
      // 顶层 frame：滚选区所在的元素；iframe 里的选区：滚 iframe 本身（内层滚动管不了）
      const node = hit.found.range.startContainer
      const el = hit.frameEl || (node.nodeType === 1 ? node : node.parentElement)
      if (el && el.scrollIntoView) {
        el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' })
        await sleep(150)
        const again = findSelection()
        if (again) hit = again
        box = pageBox(hit)
      }
    }
    const clipped =
      box.x < 0 || box.y < 0 || box.x + box.width > vw || box.y + box.height > vh
    return {
      ok: true,
      rect: box,
      vw: vw,
      vh: vh,
      clipped: clipped,
      text: hit.found.text.trim().slice(0, 2000),
    }
  }

  function pageMeta() {
    return {
      title: meta('property', 'og:title') || (document.title || '').trim(),
      byline: meta('name', 'author') || meta('property', 'article:author'),
      published: meta('property', 'article:published_time') || meta('name', 'date'),
      description: (meta('property', 'og:description') || meta('name', 'description')).trim(),
      siteName: meta('property', 'og:site_name') || location.hostname,
      tags: splitKeywords(meta('name', 'keywords') || meta('property', 'article:tag')),
      url: location.href,
    }
  }

  // —— 手动框选 ——
  //
  // 浏览器的选区只能圈文字，圈不住图表与插图。这里让用户自己拖一个矩形：遮罩盖住
  // 视口，拖动时画出选框，松开即收工。遮罩与选框在报回结果前全部撤掉——截图拍的是
  // 当前画面，遮罩留在画面里就被拍进去了。矩形两路报回后台：runtime 消息（快）与
  // window.__NL_SHOT.lastPick（后台轮询兜底，页面里拿不到 chrome.runtime 时用）。
  function pickRect() {
    return new Promise(function (resolve) {
      const doc = document
      if (!doc.body) {
        resolve(null)
        return
      }
      const mask = doc.createElement('div')
      mask.className = 'nl-shot-mask'
      const box = doc.createElement('div')
      box.className = 'nl-shot-box'
      const hint = doc.createElement('div')
      hint.className = 'nl-shot-hint'
      hint.textContent = '拖动框选要截的区域　Esc 取消'
      mask.appendChild(box)
      mask.appendChild(hint)
      doc.body.appendChild(mask)

      let startX = 0
      let startY = 0
      let dragging = false
      let done = false

      function setBox(x, y, w, h) {
        box.style.left = x + 'px'
        box.style.top = y + 'px'
        box.style.width = w + 'px'
        box.style.height = h + 'px'
      }

      function cleanup() {
        doc.removeEventListener('mousemove', onMove, true)
        doc.removeEventListener('mouseup', onUp, true)
        doc.removeEventListener('keydown', onKey, true)
        if (mask.parentNode) mask.parentNode.removeChild(mask)
      }

      function report(pick) {
        try {
          if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.sendMessage) {
            chrome.runtime.sendMessage({ type: 'nl-shot-picked', pick: pick })
          }
        } catch (e) {
          /* 拿不到 runtime：后台轮询 lastPick 兜底 */
        }
      }

      function finish(pick) {
        if (done) return
        done = true
        cleanup()
        window.__NL_SHOT.lastPick = pick
        report(pick)
        resolve(pick)
      }

      function onDown(e) {
        if (e.button !== 0) return
        e.preventDefault()
        e.stopPropagation()
        dragging = true
        startX = e.clientX
        startY = e.clientY
        box.style.display = 'block'
        setBox(startX, startY, 0, 0)
      }

      function onMove(e) {
        if (!dragging) return
        e.preventDefault()
        setBox(
          Math.min(startX, e.clientX),
          Math.min(startY, e.clientY),
          Math.abs(e.clientX - startX),
          Math.abs(e.clientY - startY)
        )
      }

      function onUp(e) {
        if (!dragging) return
        dragging = false
        const x = Math.min(startX, e.clientX)
        const y = Math.min(startY, e.clientY)
        const w = Math.abs(e.clientX - startX)
        const h = Math.abs(e.clientY - startY)
        box.style.display = 'none'
        // 误点（没拖出面积）：当作取消
        if (w < 4 || h < 4) {
          finish(null)
          return
        }
        finish({
          rect: { x: x, y: y, width: w, height: h },
          vw: window.innerWidth,
          vh: window.innerHeight,
        })
      }

      function onKey(e) {
        if (e.key === 'Escape') {
          e.preventDefault()
          e.stopPropagation()
          finish(null)
        }
      }

      mask.addEventListener('mousedown', onDown)
      doc.addEventListener('mousemove', onMove, true)
      doc.addEventListener('mouseup', onUp, true)
      doc.addEventListener('keydown', onKey, true)
    })
  }

  // 开始框选。返回的 Promise 在用户拖完（或取消）时兑现
  function startPick() {
    window.__NL_SHOT.lastPick = null
    return pickRect()
  }

  window.__NL_SHOT = {
    prepare: prepare,
    pageMeta: pageMeta,
    startPick: startPick,
    lastPick: null,
  }
})()
