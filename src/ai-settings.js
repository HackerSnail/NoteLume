// ai-settings.js —— 「AI 设置」面板：接口地址 / API Key / 模型名（OpenAI 兼容）
//
// 持久化并进 settings.json 的 ai 段（settings-store.js 读写）；归一化与预设表在
// ai-tasks.js（纯逻辑，Node 单测）。Rust 侧不存任何配置，调用时前端经 IPC 传参。
// 模态壳沿用 appearance-settings.js / clip-settings.js 的模式。

import { t, onLocaleChange } from './i18n.js'
import { setIcon } from './icons.js'
import { normalizeAiConfig, AI_PRESETS } from './ai-tasks.js'
import { ollamaProbe, openUrl, confirmDialog } from './tauri-bridge.js'

/**
 * 「AI 设置」面板。
 * @param {object} deps
 * @param {() => object} deps.getAi 当前 AI 设置（main.js 从 settings.json 归一化后给出）
 * @param {(next: object) => void} deps.apply 应用改动：main.js 负责写 settings.json 的 ai 段
 * @param {() => Promise} [deps.flush] 立即落盘（不等防抖）
 * @param {(msg: string) => void} deps.setStatus
 */
export function createAiSettings(deps) {
  const { getAi, apply, flush, setStatus } = deps
  let overlay = null
  let bodyEl = null
  let statusEl = null
  let offLocale = null
  let draft = null // 打开时拷一份；「保存」才 apply，关闭不提交

  function section(titleKey) {
    const head = document.createElement('div')
    head.className = 'nl-ap-head'
    head.textContent = t(titleKey)
    bodyEl.appendChild(head)
  }

  function hint(key, vars) {
    const p = document.createElement('div')
    p.className = 'nl-ap-hint'
    p.textContent = t(key, vars)
    bodyEl.appendChild(p)
    return p
  }

  function textRow(labelKey, value, onChange, opts = {}) {
    const row = document.createElement('div')
    row.className = 'nl-ap-row'
    const label = document.createElement('span')
    label.className = 'nl-ap-label'
    label.textContent = t(labelKey)
    const input = document.createElement('input')
    input.type = opts.password ? 'password' : 'text'
    input.className = 'nl-ap-text'
    input.value = value
    if (opts.placeholder) input.placeholder = opts.placeholder
    input.autocomplete = 'off'
    input.spellcheck = false
    input.setAttribute('aria-label', t(labelKey))
    input.addEventListener('change', () => onChange(input.value))
    row.append(label, input)
    bodyEl.appendChild(row)
    return input
  }

  function render() {
    bodyEl.innerHTML = ''
    section('ai.set.section')

    // 预设：一键填地址 + 模型名（输入框的 change 监听读 DOM，先改 DOM 值再同步草稿）
    const presetRow = document.createElement('div')
    presetRow.className = 'nl-ap-row'
    const presetLabel = document.createElement('span')
    presetLabel.className = 'nl-ap-label'
    presetLabel.textContent = t('ai.set.presets')
    const btns = document.createElement('div')
    btns.className = 'nl-ai-presets'
    for (const p of AI_PRESETS) {
      const b = document.createElement('button')
      b.type = 'button'
      b.className = 'nl-ks-btn'
      b.textContent = t('ai.set.preset.' + p.id)
      b.addEventListener('click', async () => {
        // 选 Ollama 预设且此前拒绝过安装：再探一次并提示（刚装好的用户探测通过就不再烦）
        if (p.id === 'ollama' && localStorage.getItem('nl-ollama-skip') === '1') {
          localStorage.removeItem('nl-ollama-skip')
          let ok = false
          try { ok = await ollamaProbe() } catch { ok = false }
          if (!ok) {
            const yes = await confirmDialog(t('ollama.retryBody'), t('ollama.installBtn'))
            if (yes) {
              openUrl('https://ollama.com/download').catch(() => {})
              return
            }
          }
        }
        draft.baseUrl = p.baseUrl
        draft.model = p.model
        render()
      })
      btns.appendChild(b)
    }
    presetRow.append(presetLabel, btns)
    bodyEl.appendChild(presetRow)
    hint('ai.set.presetHint')

    textRow('ai.set.baseUrl', draft.baseUrl, (v) => { draft.baseUrl = v }, {
      placeholder: 'https://api.deepseek.com/v1',
    })
    textRow('ai.set.apiKey', draft.apiKey, (v) => { draft.apiKey = v }, { password: true })
    hint('ai.set.keyHint')
    textRow('ai.set.model', draft.model, (v) => { draft.model = v }, {
      placeholder: 'deepseek-chat',
    })
    hint('ai.set.hint')
  }

  function buildDom() {
    overlay = document.createElement('div')
    overlay.className = 'nl-prompt-overlay nl-ap-overlay'

    const box = document.createElement('div')
    box.className = 'nl-prompt nl-ap'

    const head = document.createElement('div')
    head.className = 'nl-ap-top'
    const title = document.createElement('div')
    title.className = 'nl-prompt-title'
    setIcon(title, 'sparkle', '')
    title.appendChild(document.createTextNode(t('ai.set.title')))
    const saveBtn = document.createElement('button')
    saveBtn.type = 'button'
    saveBtn.className = 'nl-ks-btn'
    saveBtn.textContent = t('common.save')
    saveBtn.addEventListener('click', save)
    const closeBtn = document.createElement('button')
    closeBtn.type = 'button'
    closeBtn.className = 'nl-ks-btn'
    closeBtn.textContent = t('common.close')
    closeBtn.addEventListener('click', close)
    head.append(title, saveBtn, closeBtn)

    bodyEl = document.createElement('div')
    bodyEl.className = 'nl-ap-body'

    box.append(head, bodyEl)
    statusEl = document.createElement('div')
    statusEl.className = 'nl-panel-status'
    box.appendChild(statusEl)
    overlay.appendChild(box)
    overlay.addEventListener('pointerdown', (e) => {
      if (e.target === overlay) close()
    })
  }

  function showStatus(msg, isErr) {
    if (!statusEl) return
    statusEl.textContent = msg
    statusEl.classList.toggle('err', !!isErr)
  }

  async function save() {
    apply(normalizeAiConfig(draft))
    if (flush) await flush()
    showStatus(t('ai.set.saved'))
    setStatus(t('ai.set.saved'))
  }

  function onEsc(e) {
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      close()
    }
  }

  function open() {
    if (!overlay) buildDom()
    if (overlay.parentNode) return
    draft = normalizeAiConfig(getAi())
    document.body.appendChild(overlay)
    document.addEventListener('keydown', onEsc, true)
    offLocale = onLocaleChange(() => {
      if (overlay.parentNode) render()
    })
    render()
  }

  function close() {
    document.removeEventListener('keydown', onEsc, true)
    if (offLocale) {
      offLocale()
      offLocale = null
    }
    if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay)
  }

  return { open, close }
}
