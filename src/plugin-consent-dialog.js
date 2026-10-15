// plugin-consent-dialog.js —— 批次 F1：插件权限同意模态（多插件合并为一次；全有/全无）
// 用法：const agreed = await pluginConsentDialog({ items })；true=全部同意 / false=全部拒绝
// items=[{ name, version, author, permissions:[...], added:[...] }]
// 与 prompt-dialog 同构（自建 overlay，Tauri webview 下原生弹窗不可靠）。全部用 textContent，无 XSS 面。
import { SCOPE_LABELS } from './plugin-manifest.js'

export function pluginConsentDialog({ items = [] } = {}) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div')
    overlay.className = 'nl-consent-overlay'

    const box = document.createElement('div')
    box.className = 'nl-consent'

    const h = document.createElement('div')
    h.className = 'nl-consent-title'
    h.textContent = '插件权限同意'

    const body = document.createElement('div')
    body.className = 'nl-consent-body'

    for (const it of items) {
      const row = document.createElement('div')
      row.className = 'nl-consent-item'

      const head = document.createElement('div')
      head.className = 'nl-consent-name'
      head.textContent = it.name
      const sub = [it.version && 'v' + it.version, it.author].filter(Boolean).join(' · ')
      if (sub) {
        const s = document.createElement('span')
        s.className = 'nl-consent-sub'
        s.textContent = ' ' + sub
        head.appendChild(s)
      }
      row.appendChild(head)

      const chips = document.createElement('div')
      chips.className = 'nl-plugin-perms'
      chips.appendChild(makeChip('仅编辑器功能', false, false))
      const added = new Set(it.added || [])
      for (const p of it.permissions || []) {
        const meta = SCOPE_LABELS[p] || { label: p }
        chips.appendChild(makeChip(meta.label, !!meta.danger, added.has(p)))
      }
      row.appendChild(chips)
      body.appendChild(row)
    }

    const note = document.createElement('div')
    note.className = 'nl-consent-note'
    note.textContent =
      '注：主线程插件无法被强制阻止未授权行为，此同意用于知情与授权留档（技术拦截在后续版本）。'

    const btnRow = document.createElement('div')
    btnRow.className = 'nl-consent-row'
    const deny = document.createElement('button')
    deny.className = 'nl-prompt-btn'
    deny.textContent = '全部拒绝'
    const ok = document.createElement('button')
    ok.className = 'nl-prompt-btn primary'
    ok.textContent = '全部同意'
    btnRow.append(deny, ok)

    box.append(h, body, note, btnRow)
    overlay.appendChild(box)
    document.body.appendChild(overlay)

    let done = false
    const close = (val) => {
      if (done) return
      done = true
      document.removeEventListener('keydown', onKey, true)
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay)
      resolve(val)
    }
    function onKey(e) {
      if (e.key === 'Escape') {
        e.preventDefault()
        close(false)
      }
    }
    ok.addEventListener('click', () => close(true))
    deny.addEventListener('click', () => close(false))
    document.addEventListener('keydown', onKey, true)
    // 点遮罩不关闭：避免误放行未读过的权限
  })
}

function makeChip(label, danger, added) {
  const s = document.createElement('span')
  s.className = 'nl-plugin-chip' + (danger ? ' danger' : '') + (added ? ' added' : '')
  s.textContent = added ? label + '（新增）' : label
  return s
}
