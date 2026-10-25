// appearance-settings.js —— 「设置-外观」：纯逻辑（默认值 / 归一化 / CSS 变量补丁）+ 设置面板
//
// 持久化：所有外观状态并进 settings.json（settings-store.js 读写，Rust 端落在
// <app_config_dir>/settings.json）。启动时 main.js 的 boot 先 await 读回，再
// applyTheme + applyAppearance，重启后与上次退出时一致；文件不存在或损坏时
// normalizeAppearance 回落代码里的默认值。
//
// 颜色分两层（p5plan §6.2 / §6.3）：style.css 的各主题块把 --bg-primary 等声明为
// 「源」，旧名（--bg / --fg / --accent…）是别名。面板改色只写源变量的行内值，
// 全站引用别名的规则自动跟随；「重置」删掉行内值即回落主题默认。
//
// 纯逻辑部分不碰 DOM，可 Node 单测（tests/appearance.test.mjs）。
import { t, onLocaleChange } from './i18n.js'
import { setIcon } from './icons.js'

/** 主题选项：前三个是具体主题，system 跟随 OS 的 prefers-color-scheme */
export const THEME_CHOICES = ['light', 'dark', 'vampire', 'system']

/** 工具条主题按钮与设置页主题选项共用的图标（图形数据在 index.html 的 sprite 表） */
export const THEME_ICON = { light: 'sun', dark: 'moon', vampire: 'contrast', system: 'monitor' }

/** 界面颜色（§6.2）：设置 key → CSS 变量名 */
export const THEME_COLORS = [
  { key: 'bgPrimary', varName: '--bg-primary' },
  { key: 'bgSecondary', varName: '--bg-secondary' },
  { key: 'textPrimary', varName: '--text-primary' },
  { key: 'textSecondary', varName: '--text-secondary' },
  { key: 'borderColor', varName: '--border-color' },
  { key: 'accentColor', varName: '--accent-color' },
]

/** 文字颜色（§6.3）：作为预设主题之上的覆盖层，逐项可重置 */
export const TEXT_COLORS = [
  { key: 'editor', varName: '--text-editor' },
  { key: 'heading', varName: '--text-heading' },
  { key: 'code', varName: '--text-code' },
  { key: 'link', varName: '--text-link' },
  { key: 'quote', varName: '--text-quote' },
  { key: 'list', varName: '--text-list' },
]

/** 侧栏宽度比例（侧栏占 .body 的比例）取值范围；null = 未设置，跟随分隔条拖动记忆 */
export const SIDEBAR_RATIO = { min: 0.15, max: 0.45, def: 0.22 }

/** 字体预设（§6.5）：name 为写入 --editor-font-family 的字体栈，'' = 默认正文栈 */
export const FONT_PRESETS = [
  { name: '', labelKey: 'ap.fontDefault' },
  { name: "'Inter', 'HarmonyOS Sans', 'Noto Sans SC', sans-serif", labelKey: 'ap.fontSans' },
  { name: "'Microsoft YaHei', 'PingFang SC', sans-serif", labelKey: 'ap.fontYaHei' },
  { name: "'JetBrains Mono', 'Fira Code', Consolas, monospace", labelKey: 'ap.fontMono' },
  { name: "Consolas, 'Courier New', monospace", labelKey: 'ap.fontConsolas' },
  { name: "Georgia, 'Times New Roman', serif", labelKey: 'ap.fontSerif' },
  { name: "'KaiTi', 'STKaiti', serif", labelKey: 'ap.fontKai' },
]

/** 默认外观：与 style.css 里各变量的默认值一致（改这里要同步改 CSS） */
export const DEFAULT_APPEARANCE = {
  theme: 'light',
  colors: {}, // 缺项 = 跟随主题，如 { bgPrimary: '#ffffff' }
  textColors: {},
  fontFamily: '', // '' = 跟随默认正文栈
  fontSize: 17, // px
  lineHeight: 1.75,
  autoWrap: true,
  sidebarRatio: null, // null = 未设置（用分隔条拖动的记忆宽度 / 默认 280px）
}

const HEX6 = /^#[0-9a-fA-F]{6}$/

function clampNum(v, min, max, def) {
  const n = Number(v)
  if (!Number.isFinite(n)) return def
  return Math.min(max, Math.max(min, n))
}

function pickHexColors(raw, defs) {
  const out = {}
  if (!raw || typeof raw !== 'object') return out
  for (const { key } of defs) {
    const v = raw[key]
    // 只收六位小写 hex：<input type="color"> 与 getComputedStyle 都只认这个形式
    if (typeof v === 'string' && HEX6.test(v)) out[key] = v.toLowerCase()
  }
  return out
}

/** 把任意来源的原始设置合并成合法外观设置（坏类型 / 越界 / 坏颜色一律回落默认） */
export function normalizeAppearance(raw) {
  const s = { ...DEFAULT_APPEARANCE, colors: {}, textColors: {} }
  if (!raw || typeof raw !== 'object') return s
  if (THEME_CHOICES.includes(raw.theme)) s.theme = raw.theme
  s.colors = pickHexColors(raw.colors, THEME_COLORS)
  s.textColors = pickHexColors(raw.textColors, TEXT_COLORS)
  if (typeof raw.fontFamily === 'string') s.fontFamily = raw.fontFamily.trim().slice(0, 200)
  s.fontSize = clampNum(raw.fontSize, 12, 24, DEFAULT_APPEARANCE.fontSize)
  s.lineHeight = clampNum(raw.lineHeight, 1.2, 2.2, DEFAULT_APPEARANCE.lineHeight)
  s.autoWrap = raw.autoWrap !== false // 只有显式 false 算关
  s.sidebarRatio =
    raw.sidebarRatio == null ? null : clampNum(raw.sidebarRatio, SIDEBAR_RATIO.min, SIDEBAR_RATIO.max, SIDEBAR_RATIO.def)
  return s
}

export function clampSidebarRatio(n) {
  return clampNum(n, SIDEBAR_RATIO.min, SIDEBAR_RATIO.max, SIDEBAR_RATIO.def)
}

/**
 * 外观设置 → CSS 变量补丁。set 写行内值，remove 删行内值（回落 style.css 的主题默认）。
 * 颜色只在用户覆盖过时才进 set，否则进 remove——预设主题永远说得上话。
 */
export function appearanceVarPatch(s) {
  const ap = normalizeAppearance(s)
  const set = {}
  const remove = []
  for (const group of [THEME_COLORS, TEXT_COLORS]) {
    for (const { key, varName } of group) {
      const bag = group === THEME_COLORS ? ap.colors : ap.textColors
      if (bag[key]) set[varName] = bag[key]
      else remove.push(varName)
    }
  }
  if (ap.fontFamily) set['--editor-font-family'] = ap.fontFamily
  else remove.push('--editor-font-family')
  set['--editor-font-size'] = ap.fontSize + 'px'
  set['--editor-line-height'] = String(ap.lineHeight)
  // 关自动换行用 pre 而非 normal：pre 同样不折叠空格，PM 的光标映射不受影响
  set['--editor-white-space'] = ap.autoWrap ? 'pre-wrap' : 'pre'
  return { set, remove }
}

/** 把补丁写到样式对象上（传 document.documentElement.style；单测传桩） */
export function applyAppearanceVarPatch(style, patch) {
  for (const name of patch.remove) style.removeProperty(name)
  for (const [name, value] of Object.entries(patch.set)) style.setProperty(name, value)
}

/** 一步到位：外观设置 → 行内 CSS 变量 */
export function applyAppearance(style, s) {
  applyAppearanceVarPatch(style, appearanceVarPatch(s))
}

// —— 以下为设置面板（模态壳沿用 shortcut-settings.js 的模式） ——

function firstFamily(stack) {
  const first = String(stack).split(',')[0].trim()
  return first.replace(/^['"]|['"]$/g, '')
}

// document.fonts.check 对「本机装得上 / 渲染得了」的字体返回 true，未装返回 false。
// Web 没有枚举系统字体的 API，这个探针加手动输入就是实际的「读系统字体」方案。
function fontAvailable(stack) {
  const fam = firstFamily(stack)
  if (!fam) return true
  try {
    return document.fonts.check('16px "' + fam + '"')
  } catch {
    return true
  }
}

function toHex6(v) {
  const s = String(v || '').trim()
  return HEX6.test(s) ? s.toLowerCase() : '#000000'
}

/**
 * 「设置-外观」面板。
 * @param {object} deps
 * @param {() => object} deps.getAppearance 当前外观设置（main.js 从 settings.json 归一化后给出）
 * @param {(next: object) => void} deps.apply 应用一次改动：main.js 负责写 CSS 变量、（防抖）落盘
 * @param {() => Promise} [deps.flush] 立即落盘（分栏滑块拖拽结束时调）
 * @param {(msg: string) => void} deps.setStatus
 */
export function createAppearanceSettings(deps) {
  const { getAppearance, apply, flush, setStatus, getFeatures, setFeature } = deps
  let overlay = null
  let bodyEl = null
  let offLocale = null
  // 草稿：打开时拷一份，每次改动立即 apply（所见即所存）；关闭不额外提交
  let draft = null

  function effColor(varName) {
    // 行内有覆盖取覆盖，否则取主题默认（计算样式会解析别名链，拿到的已是最终 hex）
    return getComputedStyle(document.documentElement).getPropertyValue(varName).trim()
  }

  function bodyWidth() {
    const body = document.querySelector('.body')
    return body ? body.clientWidth : 0
  }

  // 侧栏比例未设置时，滑块停在实际生效的位置（CSS 变量里的像素值折算）
  function effSidebarRatio() {
    if (draft.sidebarRatio != null) return draft.sidebarRatio
    const body = document.querySelector('.body')
    const px = body ? Number.parseFloat(getComputedStyle(body).getPropertyValue('--nl-side-w')) : NaN
    const w = bodyWidth()
    return clampSidebarRatio(w > 0 && Number.isFinite(px) ? px / w : SIDEBAR_RATIO.def)
  }

  function section(titleKey) {
    const head = document.createElement('div')
    head.className = 'nl-ap-head'
    head.textContent = t(titleKey)
    bodyEl.appendChild(head)
  }

  function hint(key) {
    const p = document.createElement('div')
    p.className = 'nl-ap-hint'
    p.textContent = t(key)
    bodyEl.appendChild(p)
  }

  function renderTheme() {
    const row = document.createElement('div')
    row.className = 'nl-ap-themes'
    for (const name of THEME_CHOICES) {
      const b = document.createElement('button')
      b.type = 'button'
      b.className = 'nl-ap-theme' + (draft.theme === name ? ' active' : '')
      setIcon(b, THEME_ICON[name], t('theme.' + name))
      b.addEventListener('click', () => {
        draft.theme = name
        apply(draft)
        for (const btn of row.children) btn.classList.toggle('active', btn === b)
      })
      row.appendChild(b)
    }
    bodyEl.appendChild(row)
  }

  function renderColorGroup(defs, group, labelPrefix) {
    for (const def of defs) {
      const row = document.createElement('div')
      row.className = 'nl-ap-row'

      const label = document.createElement('span')
      label.className = 'nl-ap-label'
      label.textContent = t(labelPrefix + def.key)
      row.appendChild(label)

      const input = document.createElement('input')
      input.type = 'color'
      input.className = 'nl-ap-color'
      input.setAttribute('aria-label', t(labelPrefix + def.key))
      row.appendChild(input)

      const reset = document.createElement('button')
      reset.type = 'button'
      reset.className = 'nl-ks-btn'
      reset.textContent = t('ap.colReset')
      row.appendChild(reset)

      const sync = () => {
        input.value = toHex6(draft[group][def.key] || effColor(def.varName))
        reset.disabled = !draft[group][def.key]
      }
      // 取色器拖动会连续触发 input：只改草稿 + 生效，不重渲（原生取色面板开着，换 DOM 节点会闪）
      input.addEventListener('input', () => {
        draft[group][def.key] = input.value
        apply(draft)
        reset.disabled = false
      })
      reset.addEventListener('click', () => {
        delete draft[group][def.key]
        apply(draft)
        sync()
      })
      sync()
      bodyEl.appendChild(row)
    }
  }

  function renderPreview() {
    const box = document.createElement('div')
    box.className = 'nl-ap-preview'

    const h = document.createElement('h5')
    h.textContent = t('ap.previewHeading')
    const p = document.createElement('p')
    p.append(document.createTextNode(t('ap.previewText') + ' '))
    const code = document.createElement('code')
    code.textContent = 'inline code'
    p.append(code, document.createTextNode(' '))
    const a = document.createElement('a')
    a.href = '#'
    a.textContent = t('ap.previewLink')
    a.addEventListener('click', (e) => e.preventDefault())
    p.appendChild(a)
    const q = document.createElement('blockquote')
    q.textContent = t('ap.previewQuote')
    const ul = document.createElement('ul')
    const li = document.createElement('li')
    li.textContent = t('ap.previewList')
    ul.appendChild(li)
    box.append(h, p, q, ul)
    bodyEl.appendChild(box)
  }

  function renderFont() {
    const row = document.createElement('div')
    row.className = 'nl-ap-row'

    const sel = document.createElement('select')
    sel.className = 'nl-ap-select'
    for (const p of FONT_PRESETS) {
      const opt = document.createElement('option')
      opt.value = p.name
      opt.textContent = t(p.labelKey)
      sel.appendChild(opt)
    }
    const custom = document.createElement('option')
    custom.value = '__custom__'
    custom.textContent = t('ap.fontCustom')
    sel.appendChild(custom)
    row.appendChild(sel)

    const input = document.createElement('input')
    input.type = 'text'
    input.className = 'nl-ap-text'
    input.placeholder = t('ap.fontPh')
    input.setAttribute('aria-label', t('ap.font'))
    row.appendChild(input)
    bodyEl.appendChild(row)

    const note = document.createElement('div')
    note.className = 'nl-ap-hint'
    bodyEl.appendChild(note)

    const sync = () => {
      const inPreset = FONT_PRESETS.some((p) => p.name === draft.fontFamily)
      sel.value = inPreset ? draft.fontFamily : '__custom__'
      if (document.activeElement !== input) input.value = draft.fontFamily
      note.textContent = draft.fontFamily
        ? t(fontAvailable(draft.fontFamily) ? 'ap.fontInstalled' : 'ap.fontMissing')
        : t('ap.fontHint')
    }
    sel.addEventListener('change', () => {
      if (sel.value === '__custom__') {
        input.focus()
        return
      }
      draft.fontFamily = sel.value
      apply(draft)
      sync()
    })
    input.addEventListener('change', () => {
      draft.fontFamily = input.value.trim()
      apply(draft)
      sync()
    })
    sync()
  }

  function renderRange(labelKey, min, max, step, get, set, fmt) {
    const row = document.createElement('div')
    row.className = 'nl-ap-row'

    const label = document.createElement('span')
    label.className = 'nl-ap-label'
    label.textContent = t(labelKey)
    row.appendChild(label)

    const range = document.createElement('input')
    range.type = 'range'
    range.className = 'nl-ap-range'
    range.min = String(min)
    range.max = String(max)
    range.step = String(step)
    range.value = String(get())
    row.appendChild(range)

    const val = document.createElement('span')
    val.className = 'nl-ap-val'
    val.textContent = fmt(get())
    row.appendChild(val)

    range.addEventListener('input', () => {
      const n = Number(range.value)
      set(n)
      val.textContent = fmt(n)
      apply(draft)
    })
    // 拖动结束（change 在松手时触发）立即落盘，不等防抖
    range.addEventListener('change', () => {
      if (flush) flush()
    })
    bodyEl.appendChild(row)
  }

  function renderWrap() {
    const row = document.createElement('div')
    row.className = 'nl-ap-row'

    const label = document.createElement('span')
    label.className = 'nl-ap-label'
    label.textContent = t('ap.wrap')
    row.appendChild(label)

    const chk = document.createElement('input')
    chk.type = 'checkbox'
    chk.checked = draft.autoWrap
    row.appendChild(chk)

    const val = document.createElement('span')
    val.className = 'nl-ap-val'
    val.textContent = t(draft.autoWrap ? 'common.on' : 'common.off')
    row.appendChild(val)

    chk.addEventListener('change', () => {
      draft.autoWrap = chk.checked
      val.textContent = t(chk.checked ? 'common.on' : 'common.off')
      apply(draft)
    })
    bodyEl.appendChild(row)
  }

  function renderSplit() {
    const w = bodyWidth()
    renderRange('ap.split', 15, 45, 1,
      () => Math.round(effSidebarRatio() * 100),
      (n) => { draft.sidebarRatio = n / 100 },
      (n) => t('ap.splitValue', { n, px: Math.round((n / 100) * w) }))
    hint('ap.splitHint')
  }

  // 功能开关（feature-flags）：全部关闭即标准模式，关掉的只是显示 / 输出层增强，源文件不变。
  // 改动经 setFeature 落 settings.json 并广播各编辑器重扫装饰。
  const FEATURE_ROWS = [
    { key: 'tocBlock', labelKey: 'feature.tocBlock' },
    { key: 'csvTable', labelKey: 'feature.csvTable' },
    { key: 'emoji', labelKey: 'feature.emoji' },
    { key: 'headingNumbering', labelKey: 'feature.headingNumbering' },
  ]
  function renderFeatures() {
    if (!getFeatures) return
    const flags = getFeatures()
    for (const { key, labelKey } of FEATURE_ROWS) {
      const row = document.createElement('div')
      row.className = 'nl-ap-row'
      const label = document.createElement('span')
      label.className = 'nl-ap-label'
      label.textContent = t(labelKey)
      row.appendChild(label)
      const chk = document.createElement('input')
      chk.type = 'checkbox'
      chk.checked = !!flags[key]
      row.appendChild(chk)
      const val = document.createElement('span')
      val.className = 'nl-ap-val'
      const syncVal = () => { val.textContent = t(chk.checked ? 'common.on' : 'common.off') }
      syncVal()
      chk.addEventListener('change', () => {
        setFeature && setFeature(key, chk.checked)
        syncVal()
      })
      bodyEl.appendChild(row)
    }
    hint('ap.featuresHint')
  }

  function render() {
    bodyEl.innerHTML = ''
    section('ap.theme')
    renderTheme()
    hint('ap.themeHint')
    section('ap.colors')
    renderColorGroup(THEME_COLORS, 'colors', 'ap.col.')
    section('ap.textColors')
    renderColorGroup(TEXT_COLORS, 'textColors', 'ap.text.')
    renderPreview()
    section('ap.font')
    renderFont()
    renderRange('ap.fontSize', 12, 24, 1,
      () => draft.fontSize,
      (n) => { draft.fontSize = n },
      (n) => n + ' px')
    renderRange('ap.lineHeight', 1.2, 2.2, 0.05,
      () => draft.lineHeight,
      (n) => { draft.lineHeight = n },
      (n) => n.toFixed(2))
    section('ap.wrap')
    renderWrap()
    hint('ap.wrapHint')
    section('ap.split')
    renderSplit()
    section('ap.features')
    renderFeatures()
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
    title.textContent = t('ap.title')
    const resetAll = document.createElement('button')
    resetAll.className = 'nl-ks-btn'
    resetAll.textContent = t('ap.resetAll')
    resetAll.addEventListener('click', () => {
      draft = normalizeAppearance(null)
      apply(draft)
      render()
      setStatus(t('ap.resetAllDone'))
    })
    const closeBtn = document.createElement('button')
    closeBtn.className = 'nl-ks-btn'
    closeBtn.textContent = t('common.close')
    closeBtn.addEventListener('click', close)
    head.append(title, resetAll, closeBtn)

    bodyEl = document.createElement('div')
    bodyEl.className = 'nl-ap-body'

    box.append(head, bodyEl)
    overlay.appendChild(box)
    overlay.addEventListener('pointerdown', (e) => {
      if (e.target === overlay) close()
    })
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
    draft = normalizeAppearance(getAppearance())
    document.body.appendChild(overlay)
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
    if (flush) flush() // 关闭前把防抖里没写出去的设置落盘
  }

  return { open, close }
}
