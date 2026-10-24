// html-block-images.js —— HTML 块里 <img> 的加载
// 块内图片多是相对当前文档的路径（WordPress 导出的表格配图等），webview 直接加载会
// 解析到应用自身 origin。与 Markdown 图片同一口径：远程 / 内联 / blob 透传，相对路径
// 读库内字节转 data: URI。只改 DOM，块源码（attrs.source）不动。
import { readImageDataUri } from './tauri-bridge.js'
import { t } from './i18n.js'

const PASSTHROUGH_RE = /^(https?:|data:|blob:)/i

export function hydrateBlockImages(root, getVault, cache) {
  for (const img of root.querySelectorAll('img[src]')) {
    const src = img.getAttribute('src') || ''
    if (!src) continue
    if (PASSTHROUGH_RE.test(src)) {
      // 外链图床对非本站 Referer 常直接 403
      img.referrerPolicy = 'no-referrer'
      continue
    }
    const ctx = getVault()
    if (!ctx || !ctx.vaultRoot || !ctx.mdRel) continue
    const key = ctx.vaultRoot + '|' + ctx.mdRel + '|' + src
    img.__key = key
    const cached = cache.get(key)
    if (cached) {
      img.src = cached
      continue
    }
    readImageDataUri(ctx.vaultRoot, ctx.mdRel, src)
      .then((uri) => {
        cache.set(key, uri)
        if (img.__key === key && img.isConnected) img.src = uri
      })
      .catch(() => {
        // 重绘（改块源码 / 切文档）会换掉整棵子树，旧元素的结果不再管
        if (img.__key !== key || !img.isConnected) return
        img.removeAttribute('src')
        img.classList.add('nl-img-missing')
        img.title = t('msg.imgNotFound', { src })
      })
  }
}
