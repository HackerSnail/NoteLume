// background.js —— NoteLume 剪藏扩展的 service worker。
//
// 三个入口：点工具栏图标 = 剪藏整页；右键菜单「剪藏选中内容」/「剪藏整页」。
// 提取在页面里跑（executeScript 注入 vendor + content/extract.js）；图片由本后台
// fetch 成 data URI（host_permissions 覆盖任意源，不受页面 CORS 限制），再 POST 到
// NoteLume 主进程起的本地 HTTP 服务（只绑 127.0.0.1；来源闸门是 Rust 侧的 Origin /
// Host 检查，无令牌，装上填个地址就能用）。
//
// 每次剪藏前先 GET 一次 /health，读 NoteLume 剪藏设置里的两个开关：localizeImages
// （图片本地化，默认关）与 fullPageFallback（提取失败时退化整页，默认关）。
//
// 服务契约：docs/superpowers/specs/2026-10-21-web-clip-design.md
// v2 增量：docs/superpowers/specs/2026-10-21-web-clip-v2-design.md

const DEFAULTS = {
  serverUrl: 'http://127.0.0.1:3210',
  folder: '',
  template: '',
}

const MAX_IMAGE_BYTES = 5 * 1024 * 1024
const MAX_IMAGES = 30
const POST_TIMEOUT_MS = 15000
const BADGE_COLOR = '#8b5cf6'

// /health 读不到时的开关默认值：不取图（剪藏快）、提取失败不退化整页（噪声最多）。
// NoteLume 没起来时按默认值继续，后面的 POST 会以「连不上」报错，提示一致。
const SWITCH_DEFAULTS = { localizeImages: false, fullPageFallback: false }

async function getConfig() {
  const cfg = await chrome.storage.sync.get(DEFAULTS)
  return {
    serverUrl: String(cfg.serverUrl || DEFAULTS.serverUrl).trim().replace(/\/+$/, ''),
    folder: String(cfg.folder || '').trim(),
    template: String(cfg.template || '').trim(),
  }
}

// 读本地服务的两个开关。连不上 / 响应异常都按默认值走，不阻断剪藏
async function getSwitches(cfg) {
  try {
    const resp = await fetch(cfg.serverUrl + '/health')
    const data = await resp.json().catch(() => null)
    if (resp.ok && data && data.ok === true) {
      return {
        localizeImages: !!data.localizeImages,
        fullPageFallback: !!data.fullPageFallback,
      }
    }
  } catch (e) {
    /* NoteLume 没在跑：按默认值走，POST 那一步再报连不上 */
  }
  return { ...SWITCH_DEFAULTS }
}

function setBadge(text) {
  return chrome.action
    .setBadgeBackgroundColor({ color: BADGE_COLOR })
    .then(() => chrome.action.setBadgeText({ text }))
    .catch(() => {})
}

function notify(title, message) {
  return chrome.notifications
    .create('', {
      type: 'basic',
      title,
      message,
      iconUrl: 'icons/icon128.png',
      priority: 2,
    })
    .catch(() => {})
}

function blobToDataUri(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result))
    r.onerror = () => reject(r.error)
    r.readAsDataURL(blob)
  })
}

// 图片取本地副本。后台 fetch 带 <all_urls> 权限，跨域图也能取；取不到只留远程 URL
// （Rust 侧 Windows 上还会兜底下载一次），不阻断剪藏。
async function fetchImageDataUri(url) {
  try {
    const resp = await fetch(url, { credentials: 'omit' })
    if (!resp.ok) return null
    const blob = await resp.blob()
    if (!/^image\//i.test(blob.type)) return null
    if (blob.size > MAX_IMAGE_BYTES) return null
    return await blobToDataUri(blob)
  } catch (e) {
    return null
  }
}

async function buildPayload(extracted, selection, cfg, sw) {
  const images = []
  // 本地化关着（默认）不取图：载荷 images 传空数组，Rust 完全不碰图，正文保留原链接
  if (sw.localizeImages) {
    for (const url of (extracted.imageUrls || []).slice(0, MAX_IMAGES)) {
      images.push({ url, dataUri: await fetchImageDataUri(url) })
    }
  }
  const isSelection = !!(selection && extracted.selectionMarkdown)
  const payload = {
    title: extracted.title || '',
    url: extracted.url || '',
    byline: extracted.byline || '',
    excerpt: isSelection
      ? String(extracted.selectionMarkdown).slice(0, 200)
      : extracted.description || '',
    siteName: extracted.siteName || '',
    published: extracted.published || '',
    markdown: isSelection ? extracted.selectionMarkdown : extracted.markdown,
    tags: extracted.tags || [],
    images,
    clipType: isSelection ? 'selection' : 'page',
  }
  // 选项页填了默认目录 / 模板才作为单次覆盖发过去；空值由 NoteLume 设置里的值决定
  if (cfg.folder) payload.folder = cfg.folder
  if (cfg.template) payload.template = cfg.template
  return payload
}

async function postClip(payload, cfg) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), POST_TIMEOUT_MS)
  let resp
  try {
    resp = await fetch(cfg.serverUrl + '/clip', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    })
  } finally {
    clearTimeout(timer)
  }
  let data = null
  try {
    data = await resp.json()
  } catch (e) {
    /* 非 JSON 响应（代理插页等）：按状态码走 */
  }
  if (!resp.ok) {
    const err = new Error((data && data.message) || 'HTTP ' + resp.status)
    err.status = resp.status
    err.code = (data && data.code) || ''
    throw err
  }
  return data || {}
}

function errMessage(e) {
  if (e && e.name === 'AbortError') return '请求超时（15 秒）：NoteLume 可能没有在运行'
  if (e && e.status === 409) return '请先在 NoteLume 里打开一个知识库'
  if (e && e.status === 413) return '内容超过大小上限（载荷 8MB / 正文 2MB / 单图 5MB）：换小一些的页面，或只剪藏选中片段'
  if (e && (e.status === 400 || e.status === 404 || e.status === 500)) {
    return 'NoteLume 返回：' + (e.message || e.status)
  }
  if (e instanceof TypeError) {
    return '连不上 NoteLume：请确认应用已启动、剪藏服务已启用，且选项页的地址与端口正确'
  }
  // 提取失败 / 没有选中内容等页面侧错误：消息在抛出点写全
  return String((e && e.message) || e)
}

async function clipActiveTab(selection) {
  let tab = null
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true })
    tab = tabs && tabs[0]
  } catch (e) {
    /* 查询失败按下面无 tab 分支处理 */
  }
  if (!tab || !tab.id || !/^https?:/i.test(tab.url || '')) {
    await notify('无法剪藏', '只支持 http/https 页面（浏览器内置页面不行）')
    return
  }
  await setBadge('…')
  try {
    const cfg = await getConfig()
    const sw = await getSwitches(cfg)
    // 提取开关先送进 isolated world：func 与 files 注入同一个 world，全局可续
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: (opts) => { window.__NL_CLIP_OPTS = opts },
      args: [{ fullPageFallback: sw.fullPageFallback }],
    })
    // 注入顺序即提取优先级：defuddle → Readability → turndown → extract.js
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['vendor/defuddle.js', 'vendor/Readability.js', 'vendor/turndown.js', 'content/extract.js'],
    })
    const extracted = results && results[0] && results[0].result
    if (!extracted || extracted.ok === false) {
      throw new Error(
        extracted && extracted.reason ? '页面提取失败：' + extracted.reason : '页面提取失败'
      )
    }
    if (selection && !extracted.selectionMarkdown) {
      throw new Error('没有选中内容：先在页面上选中要剪藏的文字')
    }
    const payload = await buildPayload(extracted, selection, cfg, sw)
    const out = await postClip(payload, cfg)
    await setBadge('')
    const parts = [out.title || payload.title, out.rel].filter(Boolean)
    const tail = []
    if (out.imagesSaved) tail.push(out.imagesSaved + ' 张图')
    if (out.linked) tail.push('关联 ' + out.linked + ' 篇')
    await notify(
      '已剪藏到 NoteLume',
      parts.join('　→　') + (tail.length ? '（' + tail.join('，') + '）' : '')
    )
  } catch (e) {
    await setBadge('!')
    await notify('剪藏失败', errMessage(e))
  }
}

chrome.action.onClicked.addListener(() => clipActiveTab(false))

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'nl-clip-selection',
      title: '剪藏选中内容到 NoteLume',
      contexts: ['selection'],
    })
    chrome.contextMenus.create({
      id: 'nl-clip-page',
      title: '剪藏整页到 NoteLume',
      contexts: ['page'],
    })
  })
})

chrome.contextMenus.onClicked.addListener((info) => {
  if (info.menuItemId === 'nl-clip-selection') clipActiveTab(true)
  else if (info.menuItemId === 'nl-clip-page') clipActiveTab(false)
})
