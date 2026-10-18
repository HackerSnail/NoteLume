// i18n.js —— 界面多语言基础设施
//
// 词条放在 locales/*.js，键名按 `命名空间.名字` 组织：cmd.<命令 id> 与命令注册表对齐，
// ui.* 给静态 DOM，dlg./status. 等给运行期文案。缺词条时回退 en-US，再缺回退键名本身。
// 静态文案不写死在 HTML：元素上挂 data-i18n（文本）/ data-i18n-title / data-i18n-placeholder /
// data-i18n-aria-label，语言切换时 applyStaticDom 统一刷。动态文案在渲染点调 t()，
// 需要整体重绘的模块订阅 onLocaleChange。
import { LOCALES, MESSAGES } from './locales/index.js'

const LANG_KEY = 'nl-lang'
const FALLBACK = 'en-US'

const supported = new Set(LOCALES.map((l) => l.id))

function hasStorage() {
  try {
    return typeof localStorage !== 'undefined' && localStorage !== null
  } catch {
    return false
  }
}

// 'zh-Hant-TW' / 'fr' 之类都要能落到内置 id：先整配，再按主语言配
function matchLocale(tag) {
  const raw = String(tag || '')
  if (!raw) return null
  if (supported.has(raw)) return raw
  const lower = raw.toLowerCase()
  for (const id of supported) if (id.toLowerCase() === lower) return id
  const lang = lower.split('-')[0]
  if (lang === 'zh') return /hant|tw|hk|mo/i.test(lower) ? 'zh-Hant' : 'zh-CN'
  for (const id of supported) if (id.toLowerCase().split('-')[0] === lang) return id
  return null
}

function detectLocale() {
  if (hasStorage()) {
    const saved = localStorage.getItem(LANG_KEY)
    if (saved && supported.has(saved)) return saved
  }
  // 只在真实浏览器里采信 navigator：Node ≥21 自带全局 navigator（language='en-US'），
  // 无 window 的环境（单测）采信它会把默认语言判成英文，与「默认 zh-CN」相反
  if (typeof window === 'undefined') return 'zh-CN'
  const nav = navigator.languages || [navigator.language]
  for (const tag of nav) {
    const hit = matchLocale(tag)
    if (hit) return hit
  }
  return 'zh-CN'
}

let locale = detectLocale()
const listeners = new Set()

// {name} 占位符替换（全局）
function interpolate(text, vars) {
  if (!vars) return text
  return text.replace(/\{(\w+)\}/g, (m, k) => (Object.prototype.hasOwnProperty.call(vars, k) ? String(vars[k]) : m))
}

export function t(key, vars) {
  const dict = MESSAGES[locale] || {}
  let text = dict[key]
  if (text == null) {
    const fb = MESSAGES[FALLBACK] || {}
    text = fb[key]
  }
  if (text == null) return key
  return interpolate(text, vars)
}

export function getLocale() {
  return locale
}

export function localeName(id) {
  const hit = LOCALES.find((l) => l.id === id)
  return hit ? hit.name : id
}

/** 切换语言：持久化、刷 <html lang>、重刷静态 DOM、通知订阅方。返回是否切换成功。 */
export function setLocale(id) {
  if (!supported.has(id)) return false
  const changed = id !== locale
  locale = id
  if (hasStorage()) localStorage.setItem(LANG_KEY, id)
  if (typeof document !== 'undefined') {
    document.documentElement.lang = id
    applyStaticDom(document)
  }
  if (changed) {
    for (const fn of [...listeners]) {
      try {
        fn(id)
      } catch (e) {
        console.warn('[i18n] 订阅方处理语言切换失败', e)
      }
    }
    if (typeof window !== 'undefined') window.dispatchEvent(new CustomEvent('nl:locale-change', { detail: { locale: id } }))
  }
  return true
}

/** 语言变化订阅（重绘动态 UI 用）。返回取消订阅函数。 */
export function onLocaleChange(fn) {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

// 静态 DOM 刷新：整棵文档扫一遍代价可忽略（元素量百级），切换语言又不是热路径
export function applyStaticDom(root) {
  if (!root) return
  const scope = root === document ? document : root
  const doEl = (el) => {
    const text = el.getAttribute && el.getAttribute('data-i18n')
    if (text != null) {
      const v = t(text)
      if (v !== text) el.textContent = v
    }
    const title = el.getAttribute && el.getAttribute('data-i18n-title')
    if (title != null) {
      const v = t(title)
      if (v !== title) el.title = v
    }
    const ph = el.getAttribute && el.getAttribute('data-i18n-placeholder')
    if (ph != null) {
      const v = t(ph)
      if (v !== ph) el.placeholder = v
    }
    const aria = el.getAttribute && el.getAttribute('data-i18n-aria-label')
    if (aria != null) {
      const v = t(aria)
      if (v !== aria) el.setAttribute('aria-label', v)
    }
  }
  if (root.matches && root.matches('[data-i18n],[data-i18n-title],[data-i18n-placeholder],[data-i18n-aria-label]')) doEl(root)
  scope.querySelectorAll('[data-i18n],[data-i18n-title],[data-i18n-placeholder],[data-i18n-aria-label]').forEach(doEl)
}
