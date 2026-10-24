// print-options-dialog.js —— 打印排版选项窗（Ctrl+P 的第一个弹层）
// 用法：const options = await printOptionsDialog()；确认返回勾选对象（并记住）、取消返回 null。
// 结构照 prompt-dialog.js 的 overlay + box 模式；勾选存 localStorage（print-paged.js 的存取）。
import { t } from './i18n.js'
import { loadPrintOptions, savePrintOptions } from './print-paged.js'

// 项顺序即窗内顺序；label 走词条
const ITEMS = [
  { key: 'toc', label: () => t('dlg.printOptToc') },
  { key: 'pageNumbers', label: () => t('dlg.printOptPageNumbers') },
  { key: 'h1Break', label: () => t('dlg.printOptH1') },
  { key: 'cover', label: () => t('dlg.printOptCover') },
]

export function printOptionsDialog() {
  return new Promise((resolve) => {
    const current = loadPrintOptions()
    const overlay = document.createElement('div')
    overlay.className = 'nl-prompt-overlay'

    const box = document.createElement('div')
    box.className = 'nl-prompt'

    const h = document.createElement('div')
    h.className = 'nl-prompt-title'
    h.textContent = t('dlg.printTitle')

    const checks = ITEMS.map((item) => {
      const label = document.createElement('label')
      label.className = 'nl-print-opt'
      const input = document.createElement('input')
      input.type = 'checkbox'
      input.checked = !!current[item.key]
      const span = document.createElement('span')
      span.textContent = item.label()
      label.append(input, span)
      box.appendChild(label)
      return { key: item.key, input }
    })

    const row = document.createElement('div')
    row.className = 'nl-prompt-row'
    const ok = document.createElement('button')
    ok.className = 'nl-prompt-btn primary'
    ok.textContent = t('common.confirm')
    const cancel = document.createElement('button')
    cancel.className = 'nl-prompt-btn'
    cancel.textContent = t('common.cancel')
    row.append(cancel, ok)

    box.appendChild(row)
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
      const options = {}
      for (const { key, input } of checks) options[key] = input.checked
      savePrintOptions(options)
      close(options)
    }
    function onKey(e) {
      if (e.key === 'Escape') {
        e.preventDefault()
        close(null)
      }
    }
    ok.addEventListener('click', submit)
    cancel.addEventListener('click', () => close(null))
    overlay.addEventListener('pointerdown', (e) => {
      if (e.target === overlay) close(null)
    })
    document.addEventListener('keydown', onKey, true)

    setTimeout(() => checks[0] && checks[0].input.focus(), 0)
  })
}
