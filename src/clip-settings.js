// clip-settings.js —— 「网页剪藏」设置：配置归一化（纯逻辑，可 Node 单测）+ 设置面板
//
// 剪藏链路：浏览器扩展 POST 到本机 Rust 起的 HTTP 服务（只绑 127.0.0.1，来源闸门是
// Origin + Host 检查，不带令牌），Rust 按模板落盘并自动关联库内笔记。这里管的是设置：
// 开关、端口、目标目录、模板、文件名模式、自动关联、剪藏后是否打开。
//
// 持久化：并进 settings.json 的 clip 段（settings-store.js 读写）；「保存」时除写设置
// 外还调 clip_server_apply 让 Rust 侧停旧起新服务。面板关着时服务照常运行。
//
// 设计依据：docs/superpowers/specs/2026-10-21-web-clip-design.md

import { t, onLocaleChange } from './i18n.js'
import { setIcon } from './icons.js'
import { clipServerApply, clipServerStatus } from './tauri-bridge.js'

/** 剪藏配置默认值。与 Rust 侧 webclip.rs 的 ClipConfig::default() 一一对应 */
export const DEFAULT_CLIP = {
  enabled: false,
  port: 3210,
  folder: 'Clippings',
  template: '',
  filename: '{{date}}-{{title}}',
  autoLink: true,
  maxLinks: 5,
  openAfterSave: false,
}

function clampNum(v, min, max, def) {
  const n = Number(v)
  if (!Number.isFinite(n)) return def
  return Math.min(max, Math.max(min, n))
}

/** 把任意来源的原始设置合并成合法剪藏设置（坏类型 / 越界回落默认） */
export function normalizeClip(raw) {
  const s = { ...DEFAULT_CLIP }
  if (!raw || typeof raw !== 'object') return s
  if (typeof raw.enabled === 'boolean') s.enabled = raw.enabled
  if (typeof raw.openAfterSave === 'boolean') s.openAfterSave = raw.openAfterSave
  if (typeof raw.autoLink === 'boolean') s.autoLink = raw.autoLink
  if (raw.port != null) s.port = clampNum(raw.port, 1024, 65535, DEFAULT_CLIP.port)
  if (raw.maxLinks != null) s.maxLinks = clampNum(raw.maxLinks, 0, 20, DEFAULT_CLIP.maxLinks)
  if (typeof raw.template === 'string') s.template = raw.template.trim().slice(0, 200)
  const folder = typeof raw.folder === 'string' ? raw.folder.trim().replace(/[\\]+/g, '/').replace(/^\/+|\/+$/g, '') : ''
  s.folder = folder || DEFAULT_CLIP.folder
  const filename = typeof raw.filename === 'string' ? raw.filename.trim() : ''
  s.filename = filename || DEFAULT_CLIP.filename
  return s
}

/** 扩展里要填的服务器地址（端口取草稿值，可能与实际绑定不同——以保存后状态栏为准） */
export function clipServerUrl(port) {
  return 'http://127.0.0.1:' + (Number(port) || DEFAULT_CLIP.port)
}

// —— 以下为设置面板（模态壳沿用 appearance-settings.js / shortcut-settings.js 的模式）——

/**
 * 「网页剪藏」设置面板。
 * @param {object} deps
 * @param {() => object} deps.getClip 当前剪藏设置（main.js 从 settings.json 归一化后给出）
 * @param {(next: object) => void} deps.apply 应用改动：main.js 负责写 settings.json 的 clip 段
 * @param {() => Promise} [deps.flush] 立即落盘（不等防抖）
 * @param {(msg: string) => void} deps.setStatus
 * @param {() => string[]} [deps.listTemplates] 库内 Templates/ 下的模板相对路径；未开库返回空数组
 */
export function createClipSettings(deps) {
  const { getClip, apply, flush, setStatus, listTemplates } = deps
  let overlay = null
  let bodyEl = null
  let offLocale = null
  let draft = null // 打开时拷一份；「保存」才apply + 重启服务，关闭不提交

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
  }

  function textRow(labelKey, value, onChange, placeholder) {
    const row = document.createElement('div')
    row.className = 'nl-ap-row'
    const label = document.createElement('span')
    label.className = 'nl-ap-label'
    label.textContent = t(labelKey)
    const input = document.createElement('input')
    input.type = 'text'
    input.className = 'nl-ap-text'
    input.value = value
    if (placeholder) input.placeholder = placeholder
    input.setAttribute('aria-label', t(labelKey))
    input.addEventListener('change', () => onChange(input.value))
    row.append(label, input)
    bodyEl.appendChild(row)
    return input
  }

  function numRow(labelKey, value, onChange) {
    const row = document.createElement('div')
    row.className = 'nl-ap-row'
    const label = document.createElement('span')
    label.className = 'nl-ap-label'
    label.textContent = t(labelKey)
    const input = document.createElement('input')
    input.type = 'number'
    input.className = 'nl-ap-text'
    input.style.maxWidth = '96px'
    input.style.flex = 'none'
    input.value = String(value)
    input.addEventListener('change', () => onChange(Number(input.value)))
    row.append(label, input)
    bodyEl.appendChild(row)
    return input
  }

  function checkRow(labelKey, value, onChange) {
    const row = document.createElement('div')
    row.className = 'nl-ap-row'
    const label = document.createElement('span')
    label.className = 'nl-ap-label'
    label.textContent = t(labelKey)
    const chk = document.createElement('input')
    chk.type = 'checkbox'
    chk.checked = value
    chk.addEventListener('change', () => onChange(chk.checked))
    row.append(label, chk)
    bodyEl.appendChild(row)
    return chk
  }

  function renderServer() {
    section('clip.sectionServer')
    checkRow('clip.enable', draft.enabled, (v) => { draft.enabled = v })
    hint('clip.enableHint')
    numRow('clip.port', draft.port, (v) => { draft.port = v })
    hint('clip.portHint')
  }

  function renderSave() {
    section('clip.sectionSave')
    textRow('clip.folder', draft.folder, (v) => { draft.folder = v })
    hint('clip.folderHint')

    // 模板：列库内 Templates/ 下的 md；未开库时禁用并给说明
    const row = document.createElement('div')
    row.className = 'nl-ap-row'
    const label = document.createElement('span')
    label.className = 'nl-ap-label'
    label.textContent = t('clip.template')
    const sel = document.createElement('select')
    sel.className = 'nl-ap-select'
    const none = document.createElement('option')
    none.value = ''
    none.textContent = t('clip.templateNone')
    sel.appendChild(none)
    const templates = (listTemplates ? listTemplates() : []) || []
    for (const rel of templates) {
      const opt = document.createElement('option')
      opt.value = rel
      opt.textContent = rel
      sel.appendChild(opt)
    }
    sel.value = templates.includes(draft.template) ? draft.template : ''
    if (!templates.length) sel.disabled = true
    sel.addEventListener('change', () => { draft.template = sel.value })
    row.append(label, sel)
    bodyEl.appendChild(row)
    hint(templates.length ? 'clip.templateHint' : 'clip.templateNoVault')

    textRow('clip.filename', draft.filename, (v) => { draft.filename = v })
    hint('clip.filenameHint')
  }

  function renderLink() {
    section('clip.sectionLink')
    checkRow('clip.autoLink', draft.autoLink, (v) => { draft.autoLink = v })
    hint('clip.autoLinkHint')
    numRow('clip.maxLinks', draft.maxLinks, (v) => { draft.maxLinks = v })
    checkRow('clip.openAfterSave', draft.openAfterSave, (v) => { draft.openAfterSave = v })
  }

  function render() {
    bodyEl.innerHTML = ''
    renderServer()
    renderSave()
    renderLink()
    // 扩展侧要填的地址说明（端口随草稿变）
    const p = document.createElement('div')
    p.className = 'nl-ap-hint'
    p.textContent = t('clip.extHint', { url: clipServerUrl(draft.port) })
    bodyEl.appendChild(p)
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
    setIcon(title, 'clipboard', '')
    title.appendChild(document.createTextNode(t('clip.title')))
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
    overlay.appendChild(box)
    overlay.addEventListener('pointerdown', (e) => {
      if (e.target === overlay) close()
    })
  }

  async function save() {
    const next = normalizeClip(draft)
    apply(next)
    if (flush) await flush()
    try {
      const st = await clipServerApply(next)
      setStatus(st && st.running ? t('clip.statusRunning', { port: st.port }) : t('clip.statusStopped'))
    } catch (e) {
      setStatus(t('clip.applyFailed', { err: (e && e.message) || e }))
    }
    close()
  }

  function onEsc(e) {
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      close()
    }
  }

  async function open() {
    if (!overlay) buildDom()
    if (overlay.parentNode) return
    draft = normalizeClip(getClip())
    document.body.appendChild(overlay)
    // 拉一次运行态：端口可能顺延过、令牌可能是 Rust 生成的，以运行态为准修正草稿
    try {
      const st = await clipServerStatus()
      if (st && st.running && st.port) draft.port = st.port
    } catch {
      /* 纯 web 构建没有这条命令：用设置里的值 */
    }
    render()
    document.addEventListener('keydown', onEsc, true)
    offLocale = onLocaleChange(() => {
      if (overlay.parentNode) render()
    })
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
