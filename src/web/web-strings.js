// web-strings.js —— 网页版专属文案的五语言表
//
// 为什么不复用 src/locales/：那是桌面版拥有的文件，本轮的硬约束是一个桌面文件都不改
// （spec §「网页版隔离」）。i18n.js 的 t() 在键缺失时把键名原样返回，所以「桌面没有的键」
// 必须在这儿自带词条，否则会直接渲染出 ui.up 这样的键名。
//
// 取词顺序：桌面词表里有同名键就用桌面的（将来 locales 补了词条会自动生效），
// 否则用本表按当前语言取，再否则退回 zh-CN。语言每次取时现读，切语言后重开对话框即是新文案。

import { t, getLocale } from '../i18n.js'

// key -> [zh-CN, zh-Hant, en-US, fr-FR, de-DE]
const LANGS = ['zh-CN', 'zh-Hant', 'en-US', 'fr-FR', 'de-DE']

const TABLE = {
  // 目录浏览器弹窗（path-picker.js）
  'ui.up': ['上级', '上層', 'Up', 'Niveau supérieur', 'Aufwärts'],
  'ui.fileName': ['文件名', '檔名', 'File name', 'Nom du fichier', 'Dateiname'],
  'ui.noFiles': [
    '此目录没有可选文件',
    '此目錄沒有可選檔案',
    'No files to pick in this folder',
    'Aucun fichier à choisir dans ce dossier',
    'Keine auswählbaren Dateien in diesem Ordner',
  ],
  // 从本机上传一个文件进沙盒（path-picker.js）
  'ui.uploadLocal': [
    '上传本机文件',
    '上傳本機檔案',
    'Upload from this device',
    'Téléverser depuis cet appareil',
    'Von diesem Gerät hochladen',
  ],
  'ui.uploading': [
    '正在上传并导入…',
    '正在上傳並匯入…',
    'Uploading and importing…',
    'Téléversement et import…',
    'Wird hochgeladen und importiert…',
  ],
  // 顶部横幅（bootstrap.js）
  'web.banner': [
    '网页沙盒试用版 · 功能为桌面版子集',
    '網頁沙盒試用版 · 功能為桌面版子集',
    'Web sandbox trial · a subset of the desktop app',
    'Essai en bac à sable · sous-ensemble de l’application de bureau',
    'Web-Sandbox-Version · Teilmenge der Desktop-App',
  ],
  'web.sandboxMode': ['沙盒模式', '沙盒模式', 'Sandbox mode', 'Mode bac à sable', 'Sandbox-Modus'],
}

export function wt(key) {
  const fromDesktop = t(key)
  if (fromDesktop !== key) return fromDesktop
  const row = TABLE[key]
  if (!row) return key
  const i = LANGS.indexOf(getLocale())
  return row[i >= 0 ? i : 0]
}
