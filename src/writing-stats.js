// writing-stats.js —— 写作统计（纯函数，无 DOM，可 Node 单测）
//
// 口径：中日韩（含韩文谚文、平/片假名、扩展A）按"字"逐个计；拉丁/西里尔等按空白分词计"词"。
// 阅读时长按 ~300 字/分钟粗估（纯展示用，四舍五入、至少 1 分钟；
// 不足一分钟不四舍五入成「约 1 分钟」，由 statsLabel 写「不到 1 分钟」）。

import { t } from './i18n.js'

const CJK = '[\\u3400-\\u4dbf\\u4e00-\\u9fff\\u3040-\\u30ff\\uac00-\\ud7af\\uf900-\\ufaff]'

export function countWords(text) {
  // 局部名用 s 不用 t：避开与 i18n 的 t 撞名
  const s = String(text || '')
  const cjkRe = new RegExp(CJK, 'g')
  const cjk = (s.match(cjkRe) || []).length
  const stripped = s.replace(new RegExp(CJK, 'g'), ' ')
  const latin = (stripped.match(/[A-Za-z0-9\u00c0-\u024f'\u2019-]+/g) || []).length
  return cjk + latin
}

export function readingMinutes(words, wpm = 300) {
  if (!words || words <= 0) return 0
  return Math.max(1, Math.round(words / wpm))
}

// 统计结果的可读串（供工具条展示；前缀图标由调用方挂 .nl-ico）
export function statsLabel(words, wpm = 300) {
  const w = Number(words) || 0
  if (w <= 0) return t('stats.zero')
  if (w < wpm) return t('stats.under1min', { n: w })
  return t('stats.minutes', { n: w, min: readingMinutes(w, wpm) })
}
