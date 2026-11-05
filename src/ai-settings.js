// ai-settings.js —— 「AI 设置」面板：接口地址 / API Key / 模型名（OpenAI 兼容）
//
// 持久化并进 settings.json 的 ai 段（settings-store.js 读写）；归一化与预设表在
// ai-tasks.js（纯逻辑，Node 单测）。Key 按接口地址的 host:port 分格存在 ai.keys，
// 切服务商互不影响。Rust 侧不存任何配置，调用时前端经 IPC 传参。
// 模态壳沿用 appearance-settings.js / clip-settings.js 的模式。

import { t, onLocaleChange } from './i18n.js'
import { setIcon } from './icons.js'
import { normalizeAiConfig, validateAiConfig, isHttpUrl, aiKeyHost, AI_LIMITS, AI_CTX_WINDOW_MAX, AI_PRESETS } from './ai-tasks.js'
import { ollamaProbe, openUrl, confirmDialog, aiModelsList } from './tauri-bridge.js'

const MODEL_DATALIST_ID = 'nl-ap-model-list' // 模型名候选表：与输入框同面板内唯一

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
  let models = [] // 自动检测到的模型列表（aiModelsList / GET /models）
  let modelsLoading = false
  let modelsError = ''
  let modelRowEl = null // 模型行控制容器（下拉 / 手输 + 刷新钮）
  let modelStatusEl = null // 模型行下方的状态行（拉取中 / 失败）
  let apiKeyInputEl = null // Key 输入框：改地址后按新地址那一格回填
  let baseUrlInputEl = null // 接口地址输入框：点「自定义」后把光标交给它
  let presetBtnEls = [] // 预设行的 [id, button]，选中态按当前地址同步

  // —— 地址与 Key 是一对 ——
  // Key 存在 ai.keys 里按 host:port 分格，切服务商不会把上一家的 Key 带过去。
  // draft.apiKey 始终是当前地址那一格的镜像，调用方与落盘口径都照旧读它。

  /** 当前地址落在哪一格：等于某个预设就是它，其余（含空地址）都算自定义 */
  function activePresetId(url) {
    const v = String(url || '').trim()
    const hit = AI_PRESETS.find((p) => p.baseUrl === v)
    return hit ? hit.id : 'custom'
  }

  function syncPresetActive() {
    const id = activePresetId(draft && draft.baseUrl)
    for (const [btnId, el] of presetBtnEls) el.classList.toggle('active', btnId === id)
  }

  /** 改地址时换到那一格的 Key；地址还没填合法就敲的 Key 归到新地址 */
  function syncKeyWithBaseUrl(nextUrl) {
    const prevHost = aiKeyHost(draft.baseUrl)
    const pending = prevHost ? '' : draft.apiKey
    draft.baseUrl = nextUrl
    const host = aiKeyHost(nextUrl)
    if (!host) {
      draft.apiKey = pending
    } else {
      if (pending && !draft.keys[host]) draft.keys[host] = pending
      draft.apiKey = draft.keys[host] || ''
    }
    if (apiKeyInputEl) apiKeyInputEl.value = draft.apiKey
  }

  function setApiKey(value) {
    draft.apiKey = value
    const host = aiKeyHost(draft.baseUrl)
    if (host) {
      const val = String(value || '').trim()
      if (val) draft.keys[host] = val
      else delete draft.keys[host]
    }
  }

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

  // —— 模型名：可手输，拉到 /models 时把列表挂成候选（datalist） ——
  async function loadModels() {
    const url = (draft && draft.baseUrl || '').trim()
    if (!isHttpUrl(url)) {
      models = []
      modelsError = ''
      modelsLoading = false
      renderModelRow()
      return
    }
    modelsLoading = true
    modelsError = ''
    renderModelRow()
    let list = []
    try {
      const r = await aiModelsList(url, draft.apiKey || '')
      list = Array.isArray(r) ? r.map((x) => String(x || '').trim()).filter(Boolean) : []
      list = [...new Set(list)].sort((a, b) => a.localeCompare(b))
    } catch (e) {
      modelsError = (e && e.message) || String(e)
    }
    modelsLoading = false
    // 草稿里的模型不在列表（手动留的旧值 / 预设默认值）时也算一个候选，别从候选里消失
    if (draft.model && !list.includes(draft.model)) list.unshift(draft.model)
    // 有列表而草稿为空：填第一个，省一次输入
    if (!draft.model && list.length) draft.model = list[0]
    models = list
    renderModelRow()
  }

  function renderModelRow() {
    if (!modelRowEl) return
    modelRowEl.innerHTML = ''
    const label = document.createElement('span')
    label.className = 'nl-ap-label'
    label.textContent = t('ai.set.model')
    modelRowEl.appendChild(label)

    // 一个输入框走到底：列表拉得到就挂成候选，拉不到照样能敲。旧版拉取失败时会把草稿里
    // 那个模型名当成唯一选项塞进下拉，界面上看着可选、实际改不动任何值。
    const input = document.createElement('input')
    input.type = 'text'
    input.className = 'nl-ap-text'
    input.value = draft.model || ''
    input.placeholder = 'deepseek-chat'
    input.autocomplete = 'off'
    input.spellcheck = false
    input.setAttribute('aria-label', t('ai.set.model'))
    if (models.length) {
      const list = document.createElement('datalist')
      list.id = MODEL_DATALIST_ID
      for (const m of models) {
        const o = document.createElement('option')
        o.value = m
        list.appendChild(o)
      }
      modelRowEl.appendChild(list)
      input.setAttribute('list', MODEL_DATALIST_ID)
    }
    input.addEventListener('change', () => { draft.model = input.value })
    if (modelsLoading) input.disabled = true
    modelRowEl.appendChild(input)

    // 刷新：改完地址 / Key 后手动重拉（模型启动晚了、首次打开时还没起来）
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className = 'nl-ks-btn'
    btn.style.padding = '4px 7px'
    setIcon(btn, 'reload')
    btn.title = t('ai.set.modelRefresh')
    btn.setAttribute('aria-label', t('ai.set.modelRefresh'))
    btn.addEventListener('click', () => loadModels())
    modelRowEl.appendChild(btn)

    if (modelStatusEl) {
      modelStatusEl.textContent = modelsLoading ? t('ai.set.modelsLoading') : (modelsError ? t('ai.set.modelFail') : '')
      modelStatusEl.classList.toggle('err', !modelsLoading && !!modelsError)
      modelStatusEl.classList.toggle('hidden', !modelStatusEl.textContent)
    }
  }

  function render() {
    bodyEl.innerHTML = ''
    section('ai.set.section')

    // 预设：一键填地址 + 模型名（输入框的 change 监听读 DOM，先改 DOM 值再同步草稿）
    // 预设：一键填地址 + 模型名。当前地址落在哪一格，哪颗就一直是选中态；
    // 都不等于就是「自定义」（清空两项，等用户手填自己的兼容接口）。
    const presetRow = document.createElement('div')
    presetRow.className = 'nl-ap-row'
    const presetLabel = document.createElement('span')
    presetLabel.className = 'nl-ap-label'
    presetLabel.textContent = t('ai.set.presets')
    const btns = document.createElement('div')
    btns.className = 'nl-ai-presets'
    presetBtnEls = []
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
        draft.model = p.model
        syncKeyWithBaseUrl(p.baseUrl)
        render()
      })
      btns.appendChild(b)
      presetBtnEls.push([p.id, b])
    }
    const customBtn = document.createElement('button')
    customBtn.type = 'button'
    customBtn.className = 'nl-ks-btn'
    customBtn.textContent = t('ai.set.preset.custom')
    customBtn.addEventListener('click', () => {
      draft.model = ''
      syncKeyWithBaseUrl('') // 地址清空后当前 Key 归回原格留着，这一格从空开始
      render()
      if (baseUrlInputEl) baseUrlInputEl.focus()
    })
    btns.appendChild(customBtn)
    presetBtnEls.push(['custom', customBtn])
    presetRow.append(presetLabel, btns)
    bodyEl.appendChild(presetRow)
    syncPresetActive()
    hint('ai.set.presetHint')

    baseUrlInputEl = textRow('ai.set.baseUrl', draft.baseUrl, (v) => { syncKeyWithBaseUrl(v); syncPresetActive(); models = []; modelsError = ''; loadModels() }, {
      placeholder: 'https://api.deepseek.com/v1',
    })
    apiKeyInputEl = textRow('ai.set.apiKey', draft.apiKey, (v) => { setApiKey(v); models = []; modelsError = ''; loadModels() }, { password: true })
    hint('ai.set.keyHint')

    // 模型名：一个可手输的输入框，拉到 /models 时把列表挂成候选。外层 wrap 纵放：上行控制 + 下行状态。
    const modelWrap = document.createElement('div')
    modelWrap.className = 'nl-ap-model'
    modelRowEl = document.createElement('div')
    modelRowEl.className = 'nl-ap-row'
    modelWrap.appendChild(modelRowEl)
    modelStatusEl = document.createElement('div')
    modelStatusEl.className = 'nl-ap-hint hidden'
    modelWrap.appendChild(modelStatusEl)
    bodyEl.appendChild(modelWrap)
    renderModelRow()
    hint('ai.set.hint')
    loadModels() // 打开时若已有合法地址，自动拉一次模型列表

    // 上下文窗口（token）：圆环分母。留空 = 用保守参考值 32K；本地小窗口模型（Ollama 常见
    // 2048/4096）填上后，圆环会在超限前转热报警，不再谎报余量。
    textRow('ai.set.context', draft.contextTokens ? String(draft.contextTokens) : '', (v) => {
      draft.contextTokens = Math.min(AI_CTX_WINDOW_MAX, Math.max(0, Math.floor(Number(v) || 0)))
    }, { placeholder: String(32768) })
    hint('ai.set.contextHint')
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
    const { ok, errors, cfg } = validateAiConfig(draft)
    if (!ok) {
      const field = ['baseUrl', 'apiKey', 'model'].find((k) => errors[k])
      const msg = errors[field] === 'badUrl'
        ? t('ai.set.errBaseUrl')
        : t('ai.set.errTooLong', { field: t('ai.set.' + field), max: AI_LIMITS[field] })
      showStatus(msg, true)
      setStatus(msg)
      return
    }
    apply(cfg)
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
