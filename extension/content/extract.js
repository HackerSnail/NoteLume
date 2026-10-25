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

  // 尾部签名块：博客平台常在正文末尾挂一段签名页脚（本文作者 / 本文链接 / 版权声明 /
  // posted @ 阅读(…) 评论(…) 收藏 举报 / © …），不是正文，留着就是剪藏里一坨页脚垃圾。
  // Butterfly 那类主题的「文章作者：/ 文章链接：」不算——用户要留着。
  // 从结尾往前扫：跳过空行，命中签名行就把切口上移，签名块上方常挂的图（入群二维码
  // 之类）一并切掉，碰到正文行就停。只认整行以签名开头的，正文里提到这些词不受影响；
  // 切口落在内容前 60% 之内才动手，避免误伤以这类词开头的短文。
  var FOOTER_SIGNATURES = [
    /^posted @/i,
    /^本文(作者|链接|出处)[：:]/,
    /^关于博文[：:]/,
    /^版权声明[：:]/,
    /^日常交流[：:]/,
    /^copyright\b/i,
    /^©\s/,
  ]

  function stripFooterSignatures(md) {
    var lines = md.split('\n')
    var cut = -1
    for (var i = lines.length - 1; i >= 0; i--) {
      var line = lines[i].trim()
      if (!line) continue
      if (FOOTER_SIGNATURES.some(function (re) { return re.test(line) })) {
        cut = i
        continue
      }
      if (cut >= 0 && /^!\[[^\]]*\]\([^)]*\)$/.test(line)) {
        cut = i
        continue
      }
      break
    }
    if (cut <= 0 || cut < lines.length * 0.6) return md
    return lines.slice(0, cut).join('\n').replace(/\s+$/, '') + '\n'
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

  // Defuddle 可用性判断。它内部提取失败时不抛错，而是把整个 body 序列化后当作
  // content 返回（_fallbackResponse），wordCount 按全页算，轻易越过字数门槛；
  // 没有语义主标的页面（div 汤）也会退到 body 入口，把导航、侧栏一起留下来。
  // 三种情况都算没提取到，降级 Readability：content 长度接近整个 body、元数据全空
  // （_emptyMetadata 的特征）、wordCount 不足。误判的代价只是改用 Readability，
  // 它同样能提取这类页面。
  function defuddleUsable(d, doc) {
    if (!d || !d.content) return false
    if (d.wordCount != null && d.wordCount < MIN_WORD_COUNT) return false
    const bodyLen = doc.body ? doc.body.innerHTML.length : 0
    if (bodyLen > 0 && d.content.length >= bodyLen * 0.9) return false
    if (!(d.title || d.author || d.description || d.site || d.published)) return false
    return true
  }

  try {
    const doc = document.cloneNode(true)
    const imageUrls = []

    // 正文提取。两个提取器都会就地改文档（规范化属性、解 noscript 图、抽取时删噪声
    // 节点），各拿一份深拷贝，降级链不拿上一个收拾过的残页。
    let article = null
    try {
      const d = new Defuddle(doc.cloneNode(true), { url: location.href }).parse()
      if (defuddleUsable(d, doc)) {
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

    // 图片只收正文里的：在整页克隆上先收一遍会把页头头像、侧栏装饰算进来，本地化
    // 开着时前 30 张名额被它们占掉，正文里的图反而排不进去。提取结果是一段 HTML
    // 字符串，装回临时容器里再绝对化，正文之外的元素一个不碰
    let articleHtml = ''
    if (article) {
      const box = document.createElement('div')
      box.innerHTML = article.html
      absolutizeImages(box, imageUrls)
      articleHtml = box.innerHTML
    }
    const markdown = articleHtml ? stripFooterSignatures(toMarkdown(articleHtml).trim()) : ''

    // 选中片段：单独一份（src 同样绝对化）。isolated world 的 getSelection 读不到
    // iframe 里的选区与输入框里的选区，这两种情况用 background 经 opts 送来的
    // selectionText（Chrome 菜单点击时给的纯文本）兜底
    let selectionMarkdown = ''
    const frag = selectionFragment()
    if (frag) {
      absolutizeImages(frag, imageUrls)
      const text = toMarkdown(frag.innerHTML).trim()
      if (text) selectionMarkdown = text
    }
    if (!selectionMarkdown && opts().selectionText) {
      selectionMarkdown = String(opts().selectionText).trim()
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
