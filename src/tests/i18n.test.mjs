// i18n.test.mjs —— 多语言基础设施的纯逻辑回归（不触 DOM）
// 运行：cd src && node tests/i18n.test.mjs
import assert from 'node:assert'
import { t as tr, getLocale, setLocale, localeName, onLocaleChange, applyStaticDom } from '../i18n.js'
import { LOCALES, MESSAGES } from '../locales/index.js'

let pass = 0
let fail = 0
function t(name, fn) {
  try {
    fn()
    pass++
    console.log('  ok   ' + name)
  } catch (e) {
    fail++
    console.log('  FAIL ' + name + ' —— ' + ((e && e.message) || e))
  }
}

t('五种语言登记齐全，id 与词条束一一对应', () => {
  assert.deepStrictEqual(LOCALES.map((l) => l.id), ['zh-CN', 'zh-Hant', 'en-US', 'fr-FR', 'de-DE'])
  for (const { id } of LOCALES) assert.ok(MESSAGES[id], id + ' 缺词条束')
})

t('默认 locale 为 zh-CN（Node 无 localStorage / navigator）', () => {
  setLocale('zh-CN')
  assert.strictEqual(getLocale(), 'zh-CN')
})

t('tr() 按当前语言取值；切换后立刻换语言', () => {
  setLocale('zh-CN')
  assert.strictEqual(tr('common.save'), '保存')
  setLocale('en-US')
  assert.strictEqual(tr('common.save'), 'Save')
  setLocale('zh-Hant')
  assert.strictEqual(tr('common.save'), '儲存')
})

t('缺词条回退 en-US，再缺回退键名', () => {
  setLocale('de-DE')
  assert.strictEqual(tr('__nope__.x'), '__nope__.x')
  assert.strictEqual(tr('cmd.editor.undo'), 'Rückgängig') // de 有翻译时用 de
})

t('{name} 插值：缺变量时保留占位符', () => {
  setLocale('zh-CN')
  assert.strictEqual(tr('dlg.newFileTitle', { dir: 'docs' }), '新建 Markdown 文件（于 docs）')
  assert.strictEqual(tr('dlg.newFileTitle', {}), '新建 Markdown 文件（于 {dir}）')
})

t('命令类词条与注册表 id 对齐（五个语言都有）', () => {
  const ids = [
    'cmd.app.save', 'cmd.app.git.pullMerge',
    'cmd.editor.headingUp', 'cmd.editor.block.mermaid', 'cmd.block.h1', 'cmd.block.mermaid',
    'cmd.app.about', 'cmd.app.appearance', 'cmd.app.splitH', 'cmd.app.splitV',
  ]
  for (const id of ids) {
    for (const { id: loc } of LOCALES) {
      const v = MESSAGES[loc][id]
      assert.ok(v && !v.includes('{name}'), loc + ' 的 ' + id + ' 异常：' + v)
    }
  }
})

t('段落前缀词条在各语言都存在（mac 菜单剥前缀用）', () => {
  for (const { id } of LOCALES) assert.ok(MESSAGES[id]['menu.paraPrefix'].length > 1)
})

t('setLocale 拒绝未知 id；localeName 返回各语言自称', () => {
  assert.strictEqual(setLocale('xx-XX'), false)
  assert.strictEqual(localeName('zh-Hant'), '繁體中文')
  assert.strictEqual(localeName('de-DE'), 'Deutsch')
})

t('onLocaleChange 订阅与退订', () => {
  setLocale('zh-CN')
  let hits = []
  const off = onLocaleChange((id) => hits.push(id))
  setLocale('en-US')
  off()
  setLocale('zh-CN')
  assert.deepStrictEqual(hits, ['en-US'])
})

t('applyStaticDom 对空 / 非 DOM 输入安全退出', () => {
  assert.strictEqual(applyStaticDom(null), undefined)
})

console.log('结果：' + pass + ' passed, ' + fail + ' failed')
if (fail) process.exit(1)
