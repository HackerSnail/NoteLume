// desktop-only.js —— 把「网页版不支持此功能」那句提示真正落到屏幕上
//
// 为什么要有这一层：桌面版的 setStatus 早就从界面上去掉了（main.js 里只剩一句 console.debug），
// 而 Git / 插件这类失败在桌面版走的就是 setStatus。于是网页版访客点命令面板里的「Git：刷新」，
// 请求发出去、后端拒了、文案折进 console——屏幕上一个反应都没有，看起来像按钮坏了。
//
// 判定与文案都不在这里：后端 router 对 UNSUPPORTED 命令回 { ok:false, code:'desktop-only', error }，
// error 由 uiLang.mjs 按 set_ui_lang 上报的语言给出。这里只负责让它可见，遵守三条：
//   1. 访客动过之后才提示——开库时插件与 Git 面板的自检失败也会走到这里，那不该弹给访客看；
//   2. 同一句话同时只出现一条（面板重载会连着拒几条）；
//   3. 调用方自己会弹对话框的（导出 Word / 导出整站 / Git 那一类），不再补提示，
//      不让人对同一句话看两个框——弹框照弹，收起的只是我们这条 toast。
//      延时 600ms 就是给那条 catch 链留出弹框的时间；弹框出口在本文件末尾统一记录，
//      因为 bridge 的 dialogMessage 在无桌面环境里是直接调 window.alert 的（不走 alias 的替身）。
//      只记不拦：window.alert 是阻塞的，访客看框子那几秒 JS 根本跑不动，提示只能在框子关掉之后作数。

const SHOW_MS = 6000 // 一条提示在屏上停留多久
const GRACE_MS = 600 // 等一等调用方自己的弹框，再决定是否补提示
const ALERT_MEMORY_MS = 3000 // 弹框关掉之后多久以内的同句拒绝，当成同一次操作

let armed = false // 访客第一次操作之后才允许提示
let pending = null // { text, startedAt, timer }
const onScreen = new Set() // 当前在屏上的文案，去重用
let lastAlertAt = 0 // 最近一次 window.alert 的正文，与它结束的时刻
let lastAlertText = ''

function arm() {
  if (armed) return
  armed = true
  window.removeEventListener('pointerdown', arm, true)
  window.removeEventListener('keydown', arm, true)
  window.removeEventListener('wheel', arm, true)
}

function enableArming() {
  if (typeof window === 'undefined') return
  window.addEventListener('pointerdown', arm, true)
  window.addEventListener('keydown', arm, true)
  window.addEventListener('wheel', arm, true)
}
enableArming()

function container() {
  let box = document.getElementById('nl-web-toasts')
  if (box) return box
  box = document.createElement('div')
  box.id = 'nl-web-toasts'
  box.className = 'nl-web-toasts'
  box.setAttribute('role', 'status')
  document.body.appendChild(box)
  return box
}

function showToast(text) {
  if (onScreen.has(text)) return
  onScreen.add(text)
  const row = document.createElement('div')
  row.className = 'nl-web-toast'
  row.textContent = text
  container().appendChild(row)
  const drop = () => {
    onScreen.delete(text)
    if (row.parentNode) row.parentNode.removeChild(row)
  }
  row.addEventListener('click', drop)
  setTimeout(drop, SHOW_MS)
}

/**
 * 后端拒了一条桌面专属命令。先挂起一条提示；若这一句话已经由调用方的对话框弹给访客了，
 * 提示就不会上屏（见下面的 window.alert 挂钩），不会出现两个框。
 */
export function notifyDesktopOnly(text) {
  if (!armed || !text) return
  if (pending) clearTimeout(pending.timer)
  const entry = {
    text,
    startedAt: Date.now(),
    timer: setTimeout(() => {
      pending = null
      if (alertCovers(text, entry.startedAt)) return
      showToast(text)
    }, GRACE_MS),
  }
  pending = entry
}

/**
 * 挂起的这条提示要不要吞掉：调用方弹过的那句话里已有这句。
 * 两种算法：弹框发生在挂起之后（阻塞到访客关掉才返回，时刻只会更晚），
 * 或弹框刚关掉不久（push 失败弹完还会自动刷一次状态，那一下拒绝属于同一次操作）。
 */
function alertCovers(text, startedAt) {
  if (!lastAlertText.includes(text)) return false
  return startedAt <= lastAlertAt || Date.now() - lastAlertAt <= ALERT_MEMORY_MS
}

/** 记下一次原生弹框（bridge 的 dialogMessage / dialogConfirm 最终都落到 window.alert） */
export function noteAlertShown(text) {
  lastAlertAt = Date.now()
  lastAlertText = String(text == null ? '' : text)
}

/**
 * 网页里所有弹框的真实出口是 window.alert：tauri-bridge.js 的 dialogMessage 按 isDesktop() 分流，
 * 非桌面直接 window.alert(message)，根本不经过 alias 的 tauri-dialog.js。所以挂钩包在这里，
 * 而不是包在替身模块里——那样桌面代码一行都不用改，也拦得住所有调用点。
 */
function hookNativeAlert() {
  if (typeof window === 'undefined' || typeof window.alert !== 'function') return
  const real = window.alert
  if (real.__nlAlertHooked) return
  const wrapped = function (msg) {
    try {
      return real.call(window, msg)
    } finally {
      // 用结束时刻计时：alert 阻塞期间用户读框子花多久，不该把记忆窗口耗完
      noteAlertShown(msg)
    }
  }
  wrapped.__nlAlertHooked = true
  window.alert = wrapped
}
hookNativeAlert()
