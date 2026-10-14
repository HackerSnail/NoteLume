// confirm3-dialog.js —— 应用内三选确认模态（保存 / 不保存 / 取消），复用 .nl-prompt 观感
//
// Tauri 原生 confirm 只有「确定/取消」两键，无法表达「保存 / 不保存 / 留在原地」三态，故自建。
// 用法：const choice = await confirm3Dialog({ title, message, confirmLabel, neutralLabel, cancelLabel })
//   返回 'confirm' | 'neutral' | 'cancel'（Esc / 点遮罩空白 = 'cancel'）。
export function confirm3Dialog({
  title = '未保存的更改',
  message = '',
  confirmLabel = '保存',
  neutralLabel = '不保存',
  cancelLabel = '取消',
} = {}) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div')
    overlay.className = 'nl-prompt-overlay'

    const box = document.createElement('div')
    box.className = 'nl-prompt'

    const h = document.createElement('div')
    h.className = 'nl-prompt-title'
    h.textContent = title

    const msg = document.createElement('div')
    msg.className = 'nl-prompt-msg'
    msg.textContent = message

    const row = document.createElement('div')
    row.className = 'nl-prompt-row'

    let done = false
    const close = (val) => {
      if (done) return
      done = true
      document.removeEventListener('keydown', onKey, true)
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay)
      resolve(val)
    }
    const mk = (label, cls, val) => {
      const b = document.createElement('button')
      b.className = 'nl-prompt-btn' + (cls ? ' ' + cls : '')
      b.textContent = label
      b.addEventListener('click', () => close(val))
      return b
    }
    function onKey(e) {
      if (e.key === 'Escape') {
        e.preventDefault()
        close('cancel')
      }
    }

    // 顺序：取消 · 不保存 · 保存（保存为主按钮靠右；默认聚焦主按钮）
    row.append(mk(cancelLabel, '', 'cancel'), mk(neutralLabel, '', 'neutral'), mk(confirmLabel, 'primary', 'confirm'))
    box.append(h, msg, row)
    overlay.appendChild(box)
    document.body.appendChild(overlay)

    overlay.addEventListener('pointerdown', (e) => {
      if (e.target === overlay) close('cancel')
    })
    document.addEventListener('keydown', onKey, true)
    setTimeout(() => {
      const primary = row.querySelector('.primary')
      if (primary) primary.focus()
    }, 0)
  })
}
