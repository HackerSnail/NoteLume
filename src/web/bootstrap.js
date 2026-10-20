// bootstrap.js —— 网页版引导：在桌面 boot() 之前把环境接好
//
// entry.js 会 await runBootstrap() 之后再动态 import('../main.js')，因此这里做完的事，
// main.js 的 boot() 一定能看到（尤其沙盒首屏的 workspace 预置）。不改桌面代码，只在它前面铺路：
//   1. 定下 sessionId（沙盒靠它分工作区），后续所有 fetch 都带 x-notelume-session。
//   2. 拉 /api/health：知道是 local 还是 sandbox、演示库位置、临时目录。
//   3. 沙盒首屏：nl-settings 里没有 workspace 时写入 demo.vaultRoot / demo.file，
//      桌面现成的工作区恢复（main.js handleLaunchArgs）自己会把演示库开起来——网页端一行首屏逻辑都不写（§2 决策 7）。
//   4. set_ui_lang：让后端错误文案跟前端当前语言一致。
//   5. 顶部插一条「网页沙盒试用版」横幅。
//   6. 把模式写到 <html data-mode>：web.css 据此在沙盒里藏「打开知识库」。
//   7. 脏时关页守卫（浏览器只给原生提示）。

import { invoke, sessionId } from './tauri-core.js'
import { getLocale, onLocaleChange } from '../i18n.js'
import { wt } from './web-strings.js'

const LS_KEY = 'nl-settings'

function readDoc() {
  try {
    const v = JSON.parse(localStorage.getItem(LS_KEY) || 'null')
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null
  } catch {
    return null
  }
}

function writeDoc(doc) {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(doc))
  } catch {
    /* 存不下就用内存态，本次会话照常 */
  }
}

async function fetchHealth() {
  try {
    const res = await fetch('/api/health', { headers: { 'x-notelume-session': sessionId() } })
    return await res.json()
  } catch (e) {
    throw new Error('无法读取 /api/health（server/serve.mjs 是否已启动？）：' + ((e && e.message) || e))
  }
}

function insertBanner(health) {
  const toolbar = document.querySelector('header.toolbar') || document.querySelector('.toolbar')
  if (!toolbar || document.getElementById('nl-web-banner')) return
  const bar = document.createElement('div')
  bar.id = 'nl-web-banner'
  bar.className = 'nl-web-banner'
  const text = document.createElement('span')
  text.className = 'nl-web-banner-text'
  text.textContent = wt('web.banner')
  bar.appendChild(text)
  let tag = null
  if (health && health.mode === 'sandbox') {
    tag = document.createElement('span')
    tag.className = 'nl-web-banner-tag'
    tag.textContent = wt('web.sandboxMode')
    bar.appendChild(tag)
  }
  toolbar.insertAdjacentElement('afterend', bar)
  // 横幅是网页版新插的 DOM，桌面的 applyStaticDom 扫不到它（那些靠 data-i18n），所以自己订阅一次
  onLocaleChange(() => {
    text.textContent = wt('web.banner')
    if (tag) tag.textContent = wt('web.sandboxMode')
  })
}

/** 把界面语言报给后端，让错误文案跟着切；浏览器里没有 __TAURI_INTERNALS__，桌面那条上报路径整段跳过 */
async function reportLang() {
  try {
    await invoke('set_ui_lang', { lang: getLocale() })
  } catch {
    /* 上报失败不致命：后端默认 zh-CN */
  }
}

/**
 * 脏时关页守卫：桌面版靠 onCloseRequested + 三选确认框，网页里两样都没有
 * （beforeunload 弹不出我们自己的对话框，也无法 await）。降到浏览器标准做法：
 * 只要有脏标签就 preventDefault，由原生「离开此网站？」接手；没改过就完全不拦刷新。
 * 脏标记从 DOM 读：tabs.js 给脏标签上 .tab.dirty，main.js 给标题栏上 .filename.dirty，
 * 桌面代码本来就维护着它们，不必去 main.js 里插钩子（替身路线：不碰桌面文件）。
 */
function installCloseGuard() {
  const isDirty = () => !!document.querySelector('.tab.dirty, .filename.dirty')
  window.addEventListener('beforeunload', (e) => {
    if (!isDirty()) return
    e.preventDefault()
    e.returnValue = ''
  })
}

/**
 * 沙盒心跳：每 25s 打一次 /api/heartbeat，后端据此判会话“还活着”。
 * 关浏览器→心跳停→后端约 180s 后销毁该工作区；刷新期间同 sid、心跳很快恢复→不误删。
 * 本机模式不需要（无临时工作区），不挂定时器。
 */
function startHeartbeat() {
  const beat = () => fetch('/api/heartbeat', { method: 'POST', headers: { 'x-notelume-session': sessionId() } }).catch(() => {})
  beat()
  setInterval(beat, 25000)
}

export async function runBootstrap() {
  // 1) 先定 sid：即便 health 失败也保证后续 fetch 带头
  sessionId()

  // 2) health：拿模式与演示库位置
  const health = await fetchHealth()

  // 3) 模式先落到 <html> 上：早于 main.js 建任何东西，避免「打开知识库」先闪出来再被藏
  try {
    document.documentElement.dataset.mode = health.mode || 'local'
  } catch {
    /* 拿不到 DOM 就不写，CSS 的沙盒规则就当不生效 */
  }

  // 4) 沙盒首屏预置 workspace（本机模式不动，交给桌面恢复 / 空态）
  // 库根每次访问都校准，不是「没有才写」：演示库按会话分（sid 跨访问保留，但会话工作区
  // 可能已被 180s 空闲扫描销毁）。留着上一次的库值会让启动恢复去打一个不存在的库 →
  // 空态 +「未开库」，导入 Word 还会因此走进独立模式。lastFile 只在首次访问时补演示
  // 首页，之后那是用户自己的文档位，不覆盖。
  if (health.mode === 'sandbox' && health.demo && health.demo.vaultRoot) {
    const doc = readDoc() || {}
    const ws = doc.workspace || {}
    if (ws.lastVault !== health.demo.vaultRoot) {
      const lastFile = ws.lastVault ? ws.lastFile : health.demo.file || null
      writeDoc({ ...doc, workspace: { ...ws, lastVault: health.demo.vaultRoot, lastFile } })
    }
  }

  // 5) 语言上报，并跟随后续的语言切换（后端错误文案要用当前语言）
  await reportLang()
  onLocaleChange(reportLang)

  // 6) 横幅
  insertBanner(health)

  // 7) 关页守卫
  installCloseGuard()

  // 8) 沙盒心跳（关浏览器即销毁会话）
  if (health.mode === 'sandbox') startHeartbeat()

  return health
}
