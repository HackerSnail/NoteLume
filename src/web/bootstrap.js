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

import { invoke, sessionId } from './tauri-core.js'
import { getLocale } from '../i18n.js'

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
  text.textContent = '网页沙盒试用版 · 功能为桌面版子集'
  bar.appendChild(text)
  if (health && health.mode === 'sandbox') {
    const tag = document.createElement('span')
    tag.className = 'nl-web-banner-tag'
    tag.textContent = '沙盒模式'
    bar.appendChild(tag)
  }
  toolbar.insertAdjacentElement('afterend', bar)
}

export async function runBootstrap() {
  // 1) 先定 sid：即便 health 失败也保证后续 fetch 带头
  sessionId()

  // 2) health：拿模式与演示库位置
  const health = await fetchHealth()

  // 3) 沙盒首屏预置 workspace（本机模式不动，交给桌面恢复 / 空态）
  if (health.mode === 'sandbox' && health.demo && health.demo.vaultRoot) {
    const doc = readDoc() || {}
    const ws = doc.workspace
    if (!ws || !ws.lastVault) {
      writeDoc({ ...doc, workspace: { lastVault: health.demo.vaultRoot, lastFile: health.demo.file || null } })
    }
  }

  // 4) 语言上报（点火式，不等返回失败影响启动）
  try {
    await invoke('set_ui_lang', { lang: getLocale() })
  } catch {
    /* 上报失败不致命：后端默认 zh-CN */
  }

  // 5) 横幅
  insertBanner(health)

  return health
}
