// html-sanitize.js —— 字面 HTML 源码的白名单净化
//
// 编辑器 nodeview 与站点 / 单篇 HTML 导出共用这一套：三处产出的都是「给人看的 HTML」，白名单只有一份。
// 编辑器侧只影响「显示成什么样」，不改文档里的源码：序列化写回的始终是节点 attrs.source 原文。
// 解析用 DOMParser（生成的文档是惰性的，脚本不执行），再按白名单重新拼字符串输出，
// 不走 innerHTML = tree.innerHTML 那条路——重序列化会引入 mXSS 差异，宁可自己拼。

// 允许出现的标签：正文排版用得上的那些，其余未知标签脱壳留内容（<small>、<font> 之类不丢字）
const KEEP_TAGS = new Set(
  ('p div span h1 h2 h3 h4 h5 h6 hr br wbr strong em b i u s sup sub mark code pre kbd samp var ' +
    'q cite blockquote ul ol li dl dt dd table thead tbody tfoot tr th td caption colgroup col ' +
    'figure figcaption img a details summary time abbr bdi bdo ruby rt rp').split(' ')
)
// 整块丢弃（连内容一起）：会执行、会引外部文档、或本身就是不可见声明的标签
const DROP_TAGS = new Set(
  ('script style iframe object embed link meta base form input button textarea select option ' +
    'noscript template svg math canvas head body html frame frameset applet audio video source track portal'
  ).split(' ')
)
const VOID_TAGS = new Set('br wbr hr img col area base embed link param source track'.split(' '))
const KEEP_ATTRS = new Set(
  'class id title href src alt style colspan rowspan start reversed type width height headers scope abbr align valign'.split(
    ' '
  )
)
// style 只收排版属性，不收 position / z-index / background-image 这类能盖层或引外部资源的
const STYLE_PROPS = new Set(
  ('text-align width height max-width min-width object-fit font-weight font-style color ' +
    'background-color margin margin-left margin-right padding padding-left border-collapse'
  ).split(' ')
)
const URL_SCHEMES = new Set(['http', 'https', 'mailto', 'tel'])

function safeUrl(v, allowDataImage) {
  const s = String(v).trim()
  if (!s) return null
  const m = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(s)
  if (m) {
    const scheme = m[1].toLowerCase()
    if (URL_SCHEMES.has(scheme)) return s
    if (allowDataImage && scheme === 'data' && /^data:image\/(png|gif|jpe?g|webp|avif)[;,]/i.test(s)) return s
    return null
  }
  if (/^\/\//.test(s)) return null // 协议相对地址跟随页面协议，不收
  return s // 相对地址与 #锚点
}

function safeStyle(v) {
  const kept = []
  for (const decl of String(v).split(';')) {
    const i = decl.indexOf(':')
    if (i < 0) continue
    const prop = decl.slice(0, i).trim().toLowerCase()
    const val = decl.slice(i + 1).trim()
    if (!STYLE_PROPS.has(prop) || !val) continue
    if (/url\s*\(|expression|javascript:|@import|</i.test(val)) continue
    kept.push(prop + ':' + val)
  }
  return kept.join(';')
}

function escText(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}
function escAttr(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;')
}

function attrsOf(el, opts) {
  const out = []
  for (const attr of el.attributes) {
    const name = attr.name.toLowerCase()
    const value = attr.value
    if (!KEEP_ATTRS.has(name)) continue
    if (name === 'href') {
      const u = safeUrl(value, false)
      if (u) out.push('href="' + escAttr(u) + '"')
      continue
    }
    if (name === 'src') {
      // opts.image：站点导出侧要把字面 HTML 里的 <img> 也镜像到 assets/，故留一个改写口（返回 null 即不改）
      let v = value
      if (opts && opts.image && el.tagName.toLowerCase() === 'img') {
        const mapped = opts.image(value)
        if (mapped != null) v = mapped
      }
      const u = safeUrl(v, true)
      if (u) out.push('src="' + escAttr(u) + '"')
      continue
    }
    if (name === 'style') {
      const s = safeStyle(value)
      if (s) out.push('style="' + escAttr(s) + '"')
      continue
    }
    if (name === 'type' && !/^(1|a|A|i|I)$/.test(value.trim())) continue // 只留 <ol> 的编号样式
    out.push(name + '="' + escAttr(value) + '"')
  }
  return out.length ? ' ' + out.join(' ') : ''
}

function walk(node, out, opts) {
  for (const child of node.childNodes) {
    if (child.nodeType === 3) {
      out.push(escText(child.nodeValue))
      continue
    }
    if (child.nodeType !== 1) continue // 注释、CDATA 段一律不进渲染
    const tag = child.tagName.toLowerCase()
    if (DROP_TAGS.has(tag)) continue
    if (!KEEP_TAGS.has(tag)) {
      walk(child, out, opts) // 未知标签脱壳，保住里面的文字
      continue
    }
    const attrs = attrsOf(child, opts)
    if (VOID_TAGS.has(tag)) {
      out.push('<' + tag + attrs + '>')
      continue
    }
    out.push('<' + tag + attrs + '>')
    walk(child, out, opts)
    out.push('</' + tag + '>')
  }
}

/** 字面 HTML 源码 → 可安全注入的 HTML 串（无脚本、无事件属性、地址与样式过白名单）
 *  @param {{ image?: (src: string) => string|null }} [opts] image：改写 <img src> 的钩子 */
export function sanitizeHtml(source, opts) {
  const src = String(source == null ? '' : source)
  if (!src.trim()) return ''
  const doc = new DOMParser().parseFromString('<body>' + src + '</body>', 'text/html')
  const out = []
  walk(doc.body, out, opts)
  return out.join('').trim()
}

/** 字面 HTML 源码 → 纯文本（Word 导出的降级口径）：整块丢弃的标签连内容一起去掉，其余剥标签、还原基础实体 */
export function htmlToPlain(source) {
  return String(source == null ? '' : source)
    .replace(/<(script|style|textarea)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim()
}

/** 字面 HTML 源码里的标题（大纲用）：按文档序返回 [{ level, text, id }]，id 为标签自带的字面锚 */
export function htmlHeadings(source) {
  const src = String(source == null ? '' : source)
  if (!/<h[1-6]\b/i.test(src)) return []
  const doc = new DOMParser().parseFromString('<body>' + src + '</body>', 'text/html')
  const list = []
  for (const el of doc.body.querySelectorAll('h1,h2,h3,h4,h5,h6')) {
    const text = (el.textContent || '').replace(/\s+/g, ' ').trim()
    if (!text) continue
    list.push({ level: Number(el.tagName[1]), text, id: el.getAttribute('id') || '' })
  }
  return list
}
