// content/extract.js —— 页面正文提取。与 vendor/defuddle.js、vendor/Readability.js、
// vendor/turndown.js 同批注入到页面的 isolated world，直接用它们暴露的全局
// Defuddle / Readability / TurndownService。
// 提取四级优先级（v2 spec §1）：Defuddle → Readability →（设置开了才有的）整页兜底；
// 选区模式优先于前两者——用户划了什么就存什么，提取器不参与。background 经
// window.__NL_CLIP_OPTS 把设置 clip.fullPageFallback 送进来（默认关）。
// 一次返回两份 markdown：整页与选中片段（有选区才有），由 background.js 按剪藏类型挑。
// 图片 src 一律绝对化——Turndown 原样输出 src，相对路径的图在 NoteLume 里打不开。
;(function () {
  'use strict'

  // Defuddle 最低字数：低于它按提取失败降级 Readability（v2 spec §1）
  var MIN_WORD_COUNT = 120

  function opts() {
    return (typeof window !== 'undefined' && window.__NL_CLIP_OPTS) || {}
  }

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

  // metaInfo 两级取值（v2 spec §1）：提取器结果里的 author / description / site /
  // published 优先，og:* / article:* / keywords 兜底；site 一路空下来才回落 hostname。
  // Readability 的字段名是 byline / excerpt / siteName / publishedTime。
  function metaInfo(m) {
    m = m || {}
    return {
      title: m.title || meta('property', 'og:title') || (document.title || '').trim(),
      byline: m.byline || m.author || meta('name', 'author') || meta('property', 'article:author'),
      published:
        m.published ||
        m.publishedTime ||
        meta('property', 'article:published_time') ||
        meta('name', 'date'),
      description: (
        m.description ||
        m.excerpt ||
        meta('property', 'og:description') ||
        meta('name', 'description')
      ).trim(),
      siteName: m.site || m.siteName || meta('property', 'og:site_name') || location.hostname,
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
    const doc = document.cloneNode(true)
    const imageUrls = []
    absolutizeImages(doc, imageUrls)

    // 正文提取。两个提取器都会就地改文档（规范化属性、解 noscript 图、抽取时删噪声
    // 节点），各拿一份深拷贝，降级链不拿上一个收拾过的残页。
    let article = null
    try {
      const d = new Defuddle(doc.cloneNode(true), { url: location.href }).parse()
      if (d && d.content && (d.wordCount == null || d.wordCount >= MIN_WORD_COUNT)) {
        article = { html: d.content, meta: d }
      }
    } catch (e) {
      /* Defuddle 抛错：降级 Readability */
    }
    if (!article) {
      try {
        const a = new Readability(doc.cloneNode(true), { charThreshold: 120 }).parse()
        if (a && a.content) article = { html: a.content, meta: a }
      } catch (e) {
        /* Readability 也抛错：落到整页兜底 */
      }
    }
    if (!article && opts().fullPageFallback && doc.body) {
      article = { html: doc.body.innerHTML, meta: null }
    }

    const markdown = article ? toMarkdown(article.html).trim() : ''

    // 选中片段：单独一份（src 同样绝对化）
    let selectionMarkdown = ''
    const frag = selectionFragment()
    if (frag) {
      absolutizeImages(frag, imageUrls)
      const text = toMarkdown(frag.innerHTML).trim()
      if (text) selectionMarkdown = text
    }

    if (!markdown && !selectionMarkdown) {
      return { ok: false, reason: '正文提取器都没有结果' }
    }

    return {
      ok: true,
      markdown,
      selectionMarkdown: selectionMarkdown || null,
      imageUrls: imageUrls.slice(0, 30),
      url: location.href,
      ...metaInfo(article && article.meta),
    }
  } catch (e) {
    return { ok: false, reason: String((e && e.message) || e) }
  }
})()
