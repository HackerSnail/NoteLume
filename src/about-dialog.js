// about-dialog.js —— 「关于」模态：产品名 / 版本 / Slogan / 补充说明 / 版权 + 三个站外按钮
//
// 文案全部走词条（about.*，五种语言齐全），与工具条「更多 → 关于 NoteLume」同一份；
// 版本号取 package.json 的 version（Vite 构建时内联，与 src-tauri/tauri.conf.json 同源维护）。
// 三个按钮都指向站外地址：webview 里 window.open 被拦时退化为消息框贴链接，不至于点了没反应。
import { t } from './i18n.js'
import pkg from './package.json'
import { messageDialog } from './tauri-bridge.js'

const REPO = 'https://gitee.com/hackerSnail/note-lume'

let overlay = null

function onKey(e) {
  if (e.key === 'Escape') {
    e.preventDefault()
    close()
  }
}

function close() {
  if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay)
  overlay = null
  document.removeEventListener('keydown', onKey, true)
}

function openExternal(url) {
  const w = window.open(url, '_blank', 'noopener,noreferrer')
  if (!w) messageDialog(url)
}

export function openAboutDialog() {
  if (overlay) return
  overlay = document.createElement('div')
  overlay.className = 'nl-prompt-overlay'

  const box = document.createElement('div')
  box.className = 'nl-prompt nl-about'

  const h = document.createElement('div')
  h.className = 'nl-prompt-title'
  h.textContent = t('about.title')

  const name = document.createElement('div')
  name.className = 'nl-about-name'
  name.textContent = 'NoteLume'

  const ver = document.createElement('div')
  ver.className = 'nl-about-version'
  ver.textContent = t('about.version', { version: pkg.version })

  const slogan = document.createElement('div')
  slogan.className = 'nl-about-slogan'
  slogan.textContent = t('about.slogan')

  const desc = document.createElement('div')
  desc.className = 'nl-prompt-msg nl-about-desc'
  desc.textContent = t('about.desc')

  const row = document.createElement('div')
  row.className = 'nl-prompt-row nl-about-row'
  const mkBtn = (label, url) => {
    const b = document.createElement('button')
    b.className = 'nl-prompt-btn'
    b.textContent = label
    b.addEventListener('click', () => openExternal(url))
    return b
  }
  row.append(
    mkBtn(t('about.checkUpdate'), REPO + '/releases'),
    mkBtn(t('about.licenses'), REPO + '/blob/master/LICENSE'),
    mkBtn(t('about.website'), REPO),
  )

  const copyright = document.createElement('div')
  copyright.className = 'nl-about-copyright'
  copyright.textContent = t('about.copyright', { year: new Date().getFullYear() })

  box.append(h, name, ver, slogan, desc, row, copyright)
  overlay.appendChild(box)
  document.body.appendChild(overlay)

  overlay.addEventListener('pointerdown', (e) => {
    if (e.target === overlay) close()
  })
  document.addEventListener('keydown', onKey, true)
  setTimeout(() => {
    const first = row.querySelector('.nl-prompt-btn')
    if (first) first.focus()
  }, 0)
}
