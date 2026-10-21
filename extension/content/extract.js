// content/extract.js —— 页面正文提取。与 vendor/Readability.js、vendor/turndown.js
// 同批注入到页面的 isolated world，直接用它们暴露的全局 Readability / TurndownService。
// 一次返回两份 markdown：整页（Readability 提取）与选中片段（有选区才有），由
// background.js 按剪藏类型挑一份。图片 src 一律绝对化——Turndown 原样输出 src，
// 相对路径的图在 NoteLume 里打不开。
(function () {
  'use strict'

  function absUrl(u) {
    try {
      return new URL(u, location.href).href
    } catch (e) {
      return u || ''
    }
  }

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

  // 在克隆节点上把图片 src 绝对化，并收集图片 URL（后台按这份列表取本地副本）
  function absolutizeImages(root, urls) {
    const imgs = root.querySelectorAll('img')
    for (const img of imgs) {
      const abs = absUrl(img.getAttribute('src') || '')
      if (!/^https?:/i.test(abs)) {
        img.remove()
        continue
      }
      img.setAttribute('src', abs)
      img.removeAttribute('srcset')
      if (!urls.includes(abs)) urls.push(abs)
    }
  }

  let td = null
  function toMarkdown(html) {
    if (!td) {
      td = new TurndownService({
        headingStyle: 'atx',
        codeBlockStyle: 'fenced',
        bulletListMarker: '-',
        emDelimiter: '*',
      })
    }
    return td.turndown(html)
  }

  function metaInfo() {
    return {
      title: meta('property', 'og:title') || (document.title || '').trim(),
      siteName: meta('property', 'og:site_name') || location.hostname,
      byline: meta('name', 'author') || meta('property', 'article:author'),
      published: meta('property', 'article:published_time') || meta('name', 'date'),
      description: (meta('property', 'og:description') || meta('name', 'description')).trim(),
      tags: splitKeywords(meta('name', 'keywords') || meta('property', 'article:tag')),
    }
  }

  function selectionFragment() {
    const sel = window.getSelection()
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null
    const div = document.createElement('div')
    div.appendChild(sel.getRangeAt(0).cloneContents())
    return div
  }

  try {
    const imageUrls = []
    const doc = document.cloneNode(true)
    absolutizeImages(doc, imageUrls)

    // 正文：Readability 提取；结构太散提取失败时退化为整页 body
    let article = null
    try {
      article = new Readability(doc, { charThreshold: 120 }).parse()
    } catch (e) {
      article = null
    }
    const html = article && article.content
      ? article.content
      : (doc.body ? doc.body.innerHTML : '')
    const markdown = html ? toMarkdown(html).trim() : ''

    // 选中片段：单独一份（src 同样绝对化）
    let selectionMarkdown = ''
    const frag = selectionFragment()
    if (frag) {
      absolutizeImages(frag, imageUrls)
      const text = toMarkdown(frag.innerHTML).trim()
      if (text) selectionMarkdown = text
    }

    if (!markdown && !selectionMarkdown) return { ok: false, reason: '页面没有可提取的正文' }

    return {
      ok: true,
      markdown,
      selectionMarkdown: selectionMarkdown || null,
      imageUrls: imageUrls.slice(0, 30),
      url: location.href,
      ...metaInfo(),
    }
  } catch (e) {
    return { ok: false, reason: String((e && e.message) || e) }
  }
})()
