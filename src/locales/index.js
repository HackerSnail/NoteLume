// locales/index.js —— 语言清单与词条束
//
// 新增语言：在 locales/ 下加一份同名文件（默认导出一个键值对象），再在这里登记一行。
// 语言下拉显示的是各语言自己的名字，不做翻译。
import zhCN from './zh-CN.js'
import zhHant from './zh-Hant.js'
import enUS from './en-US.js'
import frFR from './fr-FR.js'
import deDE from './de-DE.js'

export const LOCALES = [
  { id: 'zh-CN', name: '简体中文' },
  { id: 'zh-Hant', name: '繁體中文' },
  { id: 'en-US', name: 'English' },
  { id: 'fr-FR', name: 'Français' },
  { id: 'de-DE', name: 'Deutsch' },
]

export const MESSAGES = {
  'zh-CN': zhCN,
  'zh-Hant': zhHant,
  'en-US': enUS,
  'fr-FR': frFR,
  'de-DE': deDE,
}
