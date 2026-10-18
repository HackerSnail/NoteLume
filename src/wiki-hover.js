// wiki-hover.js —— [[链接]] 悬浮预览
// 策略：DOM 事件委托监听编辑器 .nl-wiki 元素；hover 400ms 触发；先查索引 getDocInfo，
// 未就绪时回落到后端 docPreview。预览卡片挂在 body 上（fixed 定位），移出即关闭。

import { getDocInfo, docPreview, resolveWikiLink } from './tauri-bridge.js'
import { t } from './i18n.js'

const SHOW_DELAY = 380
const HIDE_DELAY = 220
const MAX_CHARS = 240

export function attachWikiHover(mountEl, getVault) {
  let hideTimer = null
  let showTimer = null
  let card = null
  let currentTarget = null

  function ensureCard() {
    if (card) return card
    card = document.createElement('div')
    card.className = 'nl-hover-card'
    card.style.display = 'none'
    document.body.appendChild(card)
    // 卡片自身不参与 hover 消失：鼠标进入卡片可保持可见
    card.addEventListener('mouseenter', () => {
      if (hideTimer) {
        clearTimeout(hideTimer)
        hideTimer = null
      }
    })
    card.addEventListener('mouseleave', scheduleHide)
    return card
  }

  function scheduleHide() {
    if (hideTimer) clearTimeout(hideTimer)
    hideTimer = setTimeout(() => {
      if (card) card.style.display = 'none'
      currentTarget = null
    }, HIDE_DELAY)
  }

  function placeCard(anchorRect) {
    const c = ensureCard()
    c.style.visibility = 'hidden'
    c.style.display = 'block'
    // 先重置，再按实际尺寸摆放
    c.style.left = '0px'
    c.style.top = '0px'
    const cr = c.getBoundingClientRect()
    let left = anchorRect.left
    let top = anchorRect.bottom + 6
    const vw = document.documentElement.clientWidth
    const vh = document.documentElement.clientHeight
    if (left + cr.width > vw - 12) left = Math.max(12, vw - cr.width - 12)
    if (top + cr.height > vh - 12) top = Math.max(12, anchorRect.top - cr.height - 6)
    c.style.left = left + 'px'
    c.style.top = top + 'px'
    c.style.visibility = 'visible'
  }

  async function showFor(el) {
    const target = el.getAttribute('data-target')
    if (!target) return
    currentTarget = el
    const ctx = getVault()
    ensureCard()
    card.innerHTML = '<div class="muted">' + t('common.loading') + '</div>'
    placeCard(el.getBoundingClientRect())
    let title = target
    let summary = ''
    let resolvedPath = null
    try {
      // 优先索引里的快照（含标题/摘要）
      const infoCache = await tryResolveViaIndex(ctx, target)
      if (infoCache) {
        title = infoCache.title || target
        summary = infoCache.summary || ''
        resolvedPath = infoCache.path
      }
      if (!summary && ctx.vaultRoot && resolvedPath) {
        summary = await docPreview(ctx.vaultRoot, resolvedPath, MAX_CHARS)
      }
    } catch (e) {
      summary = t('hover.previewFailed', { err: (e && e.message) || e })
    }
    const safeTitle = escapeHtml(title)
    const safeSum = escapeHtml(summary || t('hover.noContent'))
    card.innerHTML =
      '<div class="nl-hover-title">' + safeTitle + '</div>' +
      '<div class="nl-hover-body">' + safeSum + '</div>' +
      '<div class="nl-hover-foot">' + t('hover.clickToJump') + '</div>'
    placeCard(el.getBoundingClientRect())
  }

  async function tryResolveViaIndex(ctx, targetName) {
    if (!ctx.vaultRoot) return null
    // 先走 resolve_wiki_link 定位库内路径，再拿索引快照 (标题/摘要)
    try {
      const res = await resolveWikiLink(ctx.vaultRoot, ctx.mdRel || '', targetName)
      if (!res.exists) return { title: t('hover.docMissing', { name: targetName }), summary: t('hover.clickToCreate'), path: null }
      const info = await getDocInfo(res.path)
      if (info) return info
      return { path: res.path, title: targetName, summary: '' }
    } catch {
      return null
    }
  }

  mountEl.addEventListener('mouseover', (e) => {
    const wiki = e.target.closest && e.target.closest('.nl-wiki')
    if (!wiki) return
    if (wiki === currentTarget && hideTimer) {
      clearTimeout(hideTimer)
      hideTimer = null
      return
    }
    if (showTimer) clearTimeout(showTimer)
    showTimer = setTimeout(() => showFor(wiki), SHOW_DELAY)
  })
  mountEl.addEventListener('mouseout', (e) => {
    const wiki = e.target.closest && e.target.closest('.nl-wiki')
    if (!wiki) return
    if (showTimer) {
      clearTimeout(showTimer)
      showTimer = null
    }
    scheduleHide()
  })
  // 编辑器滚动时立即隐藏，避免卡片锚点漂移
  mountEl.addEventListener('scroll', () => {
    if (card && card.style.display !== 'none') {
      card.style.display = 'none'
    }
  })
}

function escapeHtml(s) {
  return String(s)
    .replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}
