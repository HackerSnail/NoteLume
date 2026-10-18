// prompt-dialog.js —— 应用内单行输入模态（Tauri webview 下 window.prompt 不可靠，故自建）
// 用法：const v = await promptDialog({ title, defaultValue, placeholder })；确认返回字符串、取消返回 null。
// 默认文案走 i18n，调用方不传用当前语言。
import { t } from './i18n.js'

export function promptDialog({
  title = t('common.input'),
  defaultValue = '',
  placeholder = '',
  confirmLabel = t('common.confirm'),
  cancelLabel = t('common.cancel'),
} = {}) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div')
    overlay.className = 'nl-prompt-overlay'

    const box = document.createElement('div')
    box.className = 'nl-prompt'

    const h = document.createElement('div')
    h.className = 'nl-prompt-title'
    h.textContent = title

    const input = document.createElement('input')
    input.type = 'text'
    input.className = 'nl-prompt-input'
    input.value = defaultValue
    input.placeholder = placeholder

    const row = document.createElement('div')
    row.className = 'nl-prompt-row'
    const ok = document.createElement('button')
    ok.className = 'nl-prompt-btn primary'
    ok.textContent = confirmLabel
    const cancel = document.createElement('button')
    cancel.className = 'nl-prompt-btn'
    cancel.textContent = cancelLabel
    row.append(cancel, ok)

    box.append(h, input, row)
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
    const submit = () => {
      const v = input.value.trim()
      if (!v) {
        input.classList.add('invalid')
        input.focus()
        return
      }
      close(v)
    }
    function onKey(e) {
      if (e.key === 'Enter') {
        e.preventDefault()
        submit()
      } else if (e.key === 'Escape') {
        e.preventDefault()
        close(null)
      }
    }
    ok.addEventListener('click', submit)
    cancel.addEventListener('click', () => close(null))
    input.addEventListener('input', () => input.classList.remove('invalid'))
    overlay.addEventListener('pointerdown', (e) => {
      if (e.target === overlay) close(null)
    })
    document.addEventListener('keydown', onKey, true)

    setTimeout(() => {
      input.focus()
      // 重命名时预选文件名主干、保留扩展名（点前不选）
      const dot = defaultValue.lastIndexOf('.')
      const slash = defaultValue.lastIndexOf('/')
      if (dot > slash + 1) input.setSelectionRange(0, dot)
      else input.select()
    }, 0)
  })
}
