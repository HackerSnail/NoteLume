// html-block-images.js —— 正文里 <img> 的加载（HTML 块与 Markdown 图共用）
// 块内图片多是相对当前文档的路径（WordPress 导出的表格配图等），webview 直接加载会
// 解析到应用自身 origin。统一口径：远程 / 内联 / blob 透传，相对路径读库内字节转
// data: URI。只改 DOM，块源码（attrs.source）不动。
import { readImageDataUri } from './tauri-bridge.js'
import { openImage, openImageSource } from './img-viewer.js'
import { t } from './i18n.js'

const PASSTHROUGH_RE = /^(https?:|data:|blob:)/i

// 相对 src 另存一份在 data-nl-src 上：读失败时 src 属性要被摘掉（不留破图），
// 有了这份记录，后面任何一次补跑都还能认出这是哪张图；读成功即清掉。
export const PENDING_ATTR = 'data-nl-src'
// 滚进视口最多补跑几趟（首趟paint 不算）。真读不到的图不该被反复回源。
const MAX_RETRIES = 3

/** 图装回来：清掉失败态（失败时留的虚线占位与 title 都不能跟着成功态一起留） */
function applyImgUri(img, uri) {
  img.src = uri
  img.classList.remove('nl-img-missing')
  if (img.__nlTitleless) {
    img.removeAttribute('title')
    img.__nlTitleless = false
  }
  img.removeAttribute(PENDING_ATTR)
}

/** 读不到：摘破图、留虚线占位与 title，但保住原路径等补跑 */
function markImgMissing(img, src) {
  img.removeAttribute('src')
  img.classList.add('nl-img-missing')
  if (!img.hasAttribute('title')) {
    img.setAttribute('title', t('msg.imgNotFound', { src }))
    img.__nlTitleless = true
  }
  img.setAttribute(PENDING_ATTR, src)
}

/**
 * 把 root 子树里的 <img> 按库内路径装成 data URI。
 * 库还没就绪 / 上一趟还在路上的图都不算失败，留着标记等下一次补跑。
 */
export function hydrateBlockImages(root, getVault, cache) {
  for (const img of root.querySelectorAll(`img[src], img[${PENDING_ATTR}]`)) {
    const src = img.getAttribute('src') || img.getAttribute(PENDING_ATTR) || ''
    if (!src) continue
    if (PASSTHROUGH_RE.test(src)) {
      // 外链图床对非本站 Referer 常直接 403
      img.referrerPolicy = 'no-referrer'
      continue
    }
    img.setAttribute(PENDING_ATTR, src)
    img.__rel = src // 查看器标题用：装成 data URI 之后原路径就不在属性里了
    const ctx = getVault()
    if (!ctx || !ctx.vaultRoot || !ctx.mdRel) continue
    const key = ctx.vaultRoot + '|' + ctx.mdRel + '|' + src
    img.__key = key
    if (img.__reading === key) continue // 这一张还在路上，补跑不能重复回源
    const cached = cache.get(key)
    if (cached) {
      applyImgUri(img, cached)
      continue
    }
    img.__reading = key
    const settle = () => {
      if (img.__reading === key) img.__reading = null
    }
    readImageDataUri(ctx.vaultRoot, ctx.mdRel, src)
      .then((uri) => {
        settle()
        cache.set(key, uri)
        if (img.__key === key && img.isConnected) applyImgUri(img, uri)
      })
      .catch(() => {
        settle()
        // 重绘（改块源码 / 切文档）会换掉整棵子树，旧元素的结果不再管
        if (img.__key !== key || !img.isConnected) return
        markImgMissing(img, src)
      })
  }
}

/**
 * 元素滚进视口时补跑一次 `retry()`，直到没有待读的图、或补满 `MAX_RETRIES` 趟。
 * 冷启动那趟读图可能落空（库还没就绪、换装后首次授权前后读盘失败），而正文不会自己
 * 重画——块源码没改就不重绘，于是落空变成永久空白。用可见性当触发器补跑，滚到哪儿修到哪儿。
 */
export function retryWhenVisible(el, getVault, cache, hydrate) {
  if (typeof IntersectionObserver === 'undefined') return { disconnect() {} }
  let retries = 0
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (!e.isIntersecting) return
      if (!e.target.querySelector(`img[${PENDING_ATTR}]`)) {
        io.disconnect() // 都装好了，不必再看
        return
      }
      if (retries++ >= MAX_RETRIES) {
        for (const img of e.target.querySelectorAll(`img[${PENDING_ATTR}]`)) img.removeAttribute(PENDING_ATTR)
        io.disconnect()
        return
      }
      hydrate(e.target, getVault, cache)
    }
  })
  io.observe(el)
  return io
}

/**
 * 单击岛状块（HTML 块）里的图片：进全屏查看器放大，而不是把整块切成源码。
 * 已装成 data URI / 外链的直接用现成 src；相对路径还没装成的（冷启动读空、读失败留的
 * data-nl-src）回库读一趟，与就地渲染同一口径。返回 true 表示这一击已被图片吃掉。
 */
export function openIslandImage(target, getVault) {
  if (!target || target.tagName !== 'IMG') return false
  const src = target.getAttribute('src')
  if (src) {
    openImageSource(src, target.getAttribute('alt') || target.__rel || (/^https?:/i.test(src) ? src : ''))
    return true
  }
  const pending = target.getAttribute(PENDING_ATTR)
  const ctx = getVault && getVault()
  if (!pending || !ctx || !ctx.vaultRoot) return false
  openImage(pending, ctx)
  return true
}
