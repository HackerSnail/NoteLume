// background.js —— NoteLume 剪藏扩展的 service worker。
//
// 五个入口：工具栏图标（mode='page'，恒定剪整页——图标是「剪这一页」的心理模型，
// 页面上残留的一段选区（读文时随手划的、双击代码行留下的）不该让整页缩成几个字）；
// 右键菜单「剪藏选中内容」（mode='selection'，只剪选区，选中的文字就在鼠标下面，
// 意图明确）；右键菜单「剪藏整页」（mode='page'，选中文字时也在，明确要整页）；
// 右键菜单「截取选区图片」与快捷键 Alt+Shift+S（mode='shot'，把选区那块画面截下来
// 存成图）；右键菜单「框选区域截图」与快捷键 Alt+Shift+D（mode='shot-box'，页面上
// 拖一个矩形，截那一块——浏览器的选区只能圈文字，圈不住图表与插图）。
// 提取在页面里跑（executeScript 注入 vendor + content/extract.js）；图片由本后台
// fetch 成 data URI（host_permissions 覆盖任意源，不受页面 CORS 限制），再 POST 到
// NoteLume 主进程起的本地 HTTP 服务（只绑 127.0.0.1；来源闸门是 Rust 侧的 Origin /
// Host 检查，无令牌，装上填个地址就能用）。
//
// 截图剪藏走另一条路：页面侧量出选区矩形（content/shot.js）→ captureVisibleTab 拍下
// 可视视口 → 本后台用 OffscreenCanvas 裁出那块 → 连同选中的文字一起 POST，Rust 落成
// 一篇带图的笔记。截图是剪藏内容本身，与 localizeImages 开关无关，恒定落盘。
//
// 每次剪藏前先 GET 一次 /health，读 NoteLume 剪藏设置里的两个开关：localizeImages
// （图片本地化，默认关）与 fullPageFallback（提取失败时退化整页，默认关）。截图剪藏
// 不取正文、不取远程图，这两个开关对它没有影响，不读。
//
// 服务契约：docs/superpowers/specs/2026-10-21-web-clip-design.md
// v2 增量：docs/superpowers/specs/2026-10-21-web-clip-v2-design.md
// 截图增量：docs/superpowers/specs/2026-10-22-web-clip-screenshot-design.md

const DEFAULTS = {
  serverUrl: 'http://127.0.0.1:3210',
  folder: '',
  template: '',
}

const MAX_IMAGE_BYTES = 5 * 1024 * 1024
const MAX_IMAGES = 30
const POST_TIMEOUT_MS = 15000
const BADGE_COLOR = '#8b5cf6'

// 截图裁剪后的长边像素上限：截图按设备像素比拍，2 倍屏上一块大区域能到几千像素，
// 整块 base64 发过去会顶到 8MB 的载荷上限，先等比缩到这条线以内
const MAX_SHOT_EDGE = 2000
// PNG 超过这个体积就转 JPEG（截图里的照片、渐变图压不小）
const MAX_SHOT_BYTES = 3.5 * 1024 * 1024

// 手动框选的遮罩样式。用 insertCSS 注入（页面的 CSP 管不到它；写成元素的 style
// 属性反而会被严格 CSP 拦下），选框与提示都不吃鼠标事件，只有遮罩接拖动。
const SHOT_CSS = `
.nl-shot-mask{position:fixed;left:0;top:0;right:0;bottom:0;z-index:2147483647;background:rgba(0,0,0,.35);cursor:crosshair}
.nl-shot-box{position:absolute;display:none;border:1px solid #fff;box-shadow:0 0 0 1px rgba(0,0,0,.65);background:rgba(255,255,255,.10);pointer-events:none}
.nl-shot-hint{position:absolute;left:50%;top:24px;transform:translateX(-50%);padding:6px 12px;border-radius:6px;background:rgba(20,20,20,.88);color:#fff;font:13px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;pointer-events:none}
`

// 剪藏结果确认条的样式，同样走 insertCSS（见 SHOT_CSS 上面那段注释）。定位右下角、
// 不吃鼠标事件、不改页面布局；进出场靠 .nl-clip-on 这一个类的开关。
const NOTICE_CSS = `
#nl-clip-notice{position:fixed;right:16px;bottom:16px;z-index:2147483647;max-width:min(360px,80vw);padding:10px 14px;border-radius:8px;border-left:3px solid #8b5cf6;background:rgba(20,20,20,.92);color:#fff;font:13px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;pointer-events:none;opacity:0;transform:translateY(8px);transition:opacity .2s ease,transform .2s ease}
#nl-clip-notice.nl-clip-on{opacity:1;transform:none}
#nl-clip-notice.nl-clip-bad{border-left-color:#e5484d}
#nl-clip-notice.nl-clip-info{border-left-color:#8a8a8f}
.nl-clip-notice-title{font-weight:600}
.nl-clip-notice-body{margin-top:2px;opacity:.82;word-break:break-word}
`

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

// 结果提示走两条通道：系统通知 + 被剪页面右下角的确认条（content/notice.js）。
// mac 上系统通知会被系统设置与专注模式静默挡掉（扩展读不到被挡的反馈，成功和失败
// 看起来一模一样），页面那一条不吃任何系统权限；Windows 上两条都到，重复但不冲突。
// 没有可注入文档的路径（浏览器内置页面）只剩系统通知那一条。
async function report(tab, title, body, kind) {
  await notify(title, body)
  if (!tab || !tab.id) return
  try {
    await chrome.scripting.insertCSS({ target: { tabId: tab.id }, css: NOTICE_CSS })
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['content/notice.js'],
    })
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: (o) => (window.__NL_NOTICE ? window.__NL_NOTICE.show(o) : false),
      args: [{ title, body, kind, ms: kind === 'bad' ? 8000 : 4000 }],
    })
  } catch (e) {
    /* 注入失败（frame 已销毁、扩展自己的页面等）：系统通知那条已经发过 */
  }
}

// 落盘成功后的那一行正文：标题 → 库内相对路径（关联篇数与图片数有才算）
function savedBody(out, fallbackTitle, extra) {
  const parts = [out.title || fallbackTitle, out.rel].filter(Boolean)
  const tail = []
  if (out.imagesSaved) tail.push(out.imagesSaved + ' 张图')
  if (out.linked) tail.push('关联 ' + out.linked + ' 篇')
  if (extra) tail.push(extra)
  return parts.join('　→　') + (tail.length ? '（' + tail.join('，') + '）' : '')
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

// mode：'page'（工具栏图标与右键「剪藏整页」）/ 'selection'（右键剪藏选中内容）
async function clipActiveTab(mode, selectionText) {
  const tab = await activeTab()
  if (!tab) return
  await setBadge('…')
  try {
    const cfg = await getConfig()
    const sw = await getSwitches(cfg)
    // 提取开关先送进 isolated world：func 与 files 注入同一个 world，全局可续
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: (opts) => { window.__NL_CLIP_OPTS = opts },
      args: [{ fullPageFallback: sw.fullPageFallback, selectionText: selectionText || '' }],
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
    // 只有右键「剪藏选中内容」剪选区。工具栏图标与「剪藏整页」恒定整页——页面上
    // 残留的选区不该把整页缩成几个字（读文时随手划一段、双击代码行都会留下选区）
    const wantSelection = mode === 'selection'
    if (wantSelection && !extracted.selectionMarkdown) {
      throw new Error('没有选中内容：先在页面上选中要剪藏的文字')
    }
    const payload = await buildPayload(extracted, wantSelection, cfg, sw)
    const out = await postClip(payload, cfg)
    await setBadge('')
    await report(tab, '已剪藏到 NoteLume', savedBody(out, payload.title), 'ok')
  } catch (e) {
    await setBadge('!')
    await report(tab, '剪藏失败', errMessage(e), 'bad')
  }
}

chrome.action.onClicked.addListener(() => clipActiveTab('page'))

// 裁剪框：选区矩形（CSS 像素）∩ 视口，再按图片尺寸换算成图上的像素坐标。
// 选区有一截在视口外时只能截到看得见的那部分，clipped 标出来给通知用。
function cropBox(prep, imgW, imgH) {
  const vw = prep.vw || imgW
  const vh = prep.vh || imgH
  const scaleX = imgW / vw
  const scaleY = imgH / vh
  const x0 = Math.max(0, prep.rect.x)
  const y0 = Math.max(0, prep.rect.y)
  const x1 = Math.min(vw, prep.rect.x + prep.rect.width)
  const y1 = Math.min(vh, prep.rect.y + prep.rect.height)
  const sw = Math.round((x1 - x0) * scaleX)
  const sh = Math.round((y1 - y0) * scaleY)
  if (sw <= 0 || sh <= 0) return null
  return {
    sx: Math.round(x0 * scaleX),
    sy: Math.round(y0 * scaleY),
    sw: sw,
    sh: sh,
    clipped:
      prep.rect.x < 0 ||
      prep.rect.y < 0 ||
      x1 < prep.rect.x + prep.rect.width ||
      y1 < prep.rect.y + prep.rect.height,
  }
}

// 截图剪藏：选区 → 画面 → 一篇带图的笔记
//
// 只拍得到可视视口：captureVisibleTab 给的是当前窗口里那个活动标签的视口画面，
// 所以选区要先滚进视口（页面侧 prepare 干这事），截不全的部分（选区比视口还大）
// 按可见的那部分截，通知里会说明。
async function captureRegion(tab, prep) {  const shotUrl = await chrome.tabs.captureVisibleTab(tab.windowId, { format: 'png' })
  const blob = await (await fetch(shotUrl)).blob()
  const bmp = await createImageBitmap(blob)
  try {
    const box = cropBox(prep, bmp.width, bmp.height)
    if (!box) throw new Error('选区不在当前视口里')
    let dw = box.sw
    let dh = box.sh
    const long = Math.max(box.sw, box.sh)
    if (long > MAX_SHOT_EDGE) {
      const k = MAX_SHOT_EDGE / long
      dw = Math.max(1, Math.round(box.sw * k))
      dh = Math.max(1, Math.round(box.sh * k))
    }
    const canvas = new OffscreenCanvas(dw, dh)
    const ctx = canvas.getContext('2d')
    ctx.drawImage(bmp, box.sx, box.sy, box.sw, box.sh, 0, 0, dw, dh)
    let out = await canvas.convertToBlob({ type: 'image/png' })
    if (out.size > MAX_SHOT_BYTES) {
      out = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.85 })
    }
    return {
      dataUri: await blobToDataUri(out),
      width: dw,
      height: dh,
      clipped: box.clipped,
    }
  } finally {
    bmp.close()
  }
}

// 当前活动标签（只支持 http/https 页面；浏览器内置页面截不了也剪不了）
async function activeTab() {
  let tab = null
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true })
    tab = tabs && tabs[0]
  } catch (e) {
    /* 查询失败按下面无 tab 分支处理 */
  }
  if (!tab || !tab.id || !/^https?:/i.test(tab.url || '')) {
    await report(tab, '无法剪藏', '只支持 http/https 页面（浏览器内置页面不行）', 'bad')
    return null
  }
  return tab
}

// 页面 meta（标题 / 作者 / 站点 / 关键词）
async function pageMeta(tabId) {
  const res = await chrome.scripting.executeScript({
    target: { tabId: tabId },
    func: () => (window.__NL_SHOT ? window.__NL_SHOT.pageMeta() : {}),
  })
  return (res && res[0] && res[0].result) || {}
}

// 截好的一块 → 落盘成一篇带图的笔记（选区截图与手动框选共用这一段）
async function clipShotPrep(tab, cfg, prep, meta) {
  let shot
  try {
    shot = await captureRegion(tab, prep)
  } catch (e) {
    throw new Error('截取当前标签页失败：' + String((e && e.message) || e))
  }
  const text = String(prep.text || '').trim()
  const payload = {
    title: meta.title || '',
    url: meta.url || tab.url || '',
    byline: meta.byline || '',
    excerpt: (text || meta.description || '').slice(0, 200),
    siteName: meta.siteName || '',
    published: meta.published || '',
    markdown: text.slice(0, 2000),
    tags: meta.tags || [],
    images: [],
    clipType: 'screenshot',
    screenshot: { dataUri: shot.dataUri },
  }
  // 选项页填了默认目录 / 模板才作为单次覆盖发过去；空值由 NoteLume 设置里的值决定
  if (cfg.folder) payload.folder = cfg.folder
  if (cfg.template) payload.template = cfg.template
  const out = await postClip(payload, cfg)
  await setBadge('')
  const cutNote = shot.clipped || prep.clipped ? '选区比视口大，只截到看得见的那部分' : ''
  await report(tab, '已截取并剪藏到 NoteLume', savedBody(out, payload.title, cutNote), 'ok')
}

// 选区截图：浏览器给的选区（文字、图片都算）→ 画面 → 一篇带图的笔记
async function clipShot() {
  const tab = await activeTab()
  if (!tab) return
  await setBadge('…')
  try {
    const cfg = await getConfig()
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['content/shot.js'],
    })
    const [prepRes] = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: async () => (window.__NL_SHOT ? await window.__NL_SHOT.prepare() : { ok: false }),
    })
    const prep = prepRes && prepRes.result
    if (!prep || !prep.ok) {
      throw new Error('没有选中内容：先在页面上选中要截的那一块（图片、图表、段落都行）')
    }
    const meta = await pageMeta(tab.id)
    await clipShotPrep(tab, cfg, prep, meta)
  } catch (e) {
    await setBadge('!')
    await report(tab, '剪藏失败', errMessage(e), 'bad')
  }
}

// 手动框选截图：页面上拖一个矩形，截那一块。浏览器的选区只能圈文字，
// 圈不住图表与插图，框选是补这一段。
async function clipShotBox() {
  const tab = await activeTab()
  if (!tab) return
  await setBadge('…')
  try {
    const cfg = await getConfig()
    // 遮罩样式走 insertCSS：页面的 CSP 管不到它，内联 style 属性反而会被拦
    await chrome.scripting.insertCSS({ target: { tabId: tab.id }, css: SHOT_CSS })
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ['content/shot.js'],
    })
    // startPick 里的 Promise 不在这儿等：拖完由页面自己报回来（消息 + 轮询两路）
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: () => {
        if (window.__NL_SHOT) window.__NL_SHOT.startPick()
      },
    })
    const pick = await waitForPick(tab.id)
    if (!pick) {
      // 用户自己取消的（Esc 或误点），不算失败
      await setBadge('')
      await report(tab, '已取消', '没有框选区域，剪藏未执行', 'info')
      return
    }
    const meta = await pageMeta(tab.id)
    await clipShotPrep(
      tab,
      cfg,
      { rect: pick.rect, vw: pick.vw, vh: pick.vh, clipped: false, text: '' },
      meta
    )
  } catch (e) {
    await setBadge('!')
    await report(tab, '剪藏失败', errMessage(e), 'bad')
  }
}

// 等页面把框选结果报回来：runtime 消息优先（页面里拿不到 chrome.runtime 时靠轮询兜底）
function waitForPick(tabId, timeoutMs) {
  const limit = timeoutMs || 180000
  return new Promise(function (resolve) {
    let done = false
    function finish(v) {
      if (done) return
      done = true
      chrome.runtime.onMessage.removeListener(onMsg)
      resolve(v)
    }
    function onMsg(msg) {
      if (msg && msg.type === 'nl-shot-picked') finish(msg.pick || null)
    }
    chrome.runtime.onMessage.addListener(onMsg)
    const t0 = Date.now()
    async function poll() {
      if (done) return
      try {
        const res = await chrome.scripting.executeScript({
          target: { tabId: tabId },
          func: () => (window.__NL_SHOT && window.__NL_SHOT.lastPick) || null,
        })
        const pick = res && res[0] && res[0].result
        if (pick) {
          finish(pick)
          return
        }
      } catch (e) {
        finish(null) // 页面跳走了：按取消处理
        return
      }
      if (Date.now() - t0 > limit) {
        finish(null)
        return
      }
      setTimeout(poll, 200)
    }
    poll()
  })
}

// 右键菜单幂等重建。菜单注册在浏览器侧，扛不过浏览器重启与扩展重载，而重建代码跑在
// 可能被逐出的 service worker 里：只在 onInstalled 里建一次不够——浏览器重启后
// onInstalled 不触发，菜单会静默消失，用户只剩工具栏图标（那就「只能剪整页」）。
// 安装 / 更新 / 重载走 onInstalled，浏览器启动走 onStartup，两个入口都重建；
// removeAll + create 天然幂等，重复触发不会报 duplicate id。
function installMenus() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'nl-clip-selection',
      title: '剪藏选中内容到 NoteLume',
      contexts: ['selection'],
    })
    chrome.contextMenus.create({
      id: 'nl-clip-shot',
      title: '截取选区图片剪藏到 NoteLume',
      contexts: ['selection'],
    })
    chrome.contextMenus.create({
      id: 'nl-clip-shot-box',
      title: '框选区域截图剪藏到 NoteLume',
      contexts: ['page', 'selection'],
    })
    chrome.contextMenus.create({
      id: 'nl-clip-page',
      title: '剪藏整页到 NoteLume',
      // 选中文字时右键也要能选「整页」：contexts 只有 page 时，选区上的右键菜单
      // 只出 selection 那几项
      contexts: ['page', 'selection'],
    })
  })
}

chrome.runtime.onInstalled.addListener(installMenus)
chrome.runtime.onStartup.addListener(installMenus)

chrome.contextMenus.onClicked.addListener((info) => {
  // selectionText 是 Chrome 在点击选区菜单项时给的选中文本。isolated world 的
  // getSelection 有两个盲区——iframe 里的选区和输入框里的选区都读不到，这段纯文本
  // 经 opts 传给 extract.js 兜底（没有图片与链接，但总比报「没有选中内容」好）
  if (info.menuItemId === 'nl-clip-selection') clipActiveTab('selection', info.selectionText || '')
  else if (info.menuItemId === 'nl-clip-page') clipActiveTab('page')
  else if (info.menuItemId === 'nl-clip-shot') clipShot()
  else if (info.menuItemId === 'nl-clip-shot-box') clipShotBox()
})

// 快捷键：Alt+Shift+S 截取选区，Alt+Shift+D 手动框选。
// manifest 的 commands 段登记，浏览器自己派发
if (chrome.commands && chrome.commands.onCommand) {
  chrome.commands.onCommand.addListener((cmd) => {
    if (cmd === 'clip-shot') clipShot()
    else if (cmd === 'clip-shot-box') clipShotBox()
  })
}
