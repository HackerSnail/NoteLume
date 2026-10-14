// writing-stats.js —— 写作统计（纯函数，无 DOM，可 Node 单测）
//
// 口径：中日韩（含韩文谚文、平/片假名、扩展A）按"字"逐个计；拉丁/西里尔等按空白分词计"词"。
// 阅读时长按 ~300 字/分钟粗估（纯展示用，向上取整、至少 1 分钟）。

const CJK = '[\\u3400-\\u4dbf\\u4e00-\\u9fff\\u3040-\\u30ff\\uac00-\\ud7af\\uf900-\\ufaff]'

export function countWords(text) {
  const t = String(text || '')
  const cjkRe = new RegExp(CJK, 'g')
  const cjk = (t.match(cjkRe) || []).length
  const stripped = t.replace(new RegExp(CJK, 'g'), ' ')
  const latin = (stripped.match(/[A-Za-z0-9\u00c0-\u024f'\u2019-]+/g) || []).length
  return cjk + latin
}

export function readingMinutes(words, wpm = 300) {
  if (!words || words <= 0) return 0
  return Math.max(1, Math.round(words / wpm))
}

// 统计结果的可读串（供工具条展示）
export function statsLabel(words) {
  const m = readingMinutes(words)
  return '✍️ ' + words + ' 字 · 约 ' + m + ' 分钟'
}
