// web-strings.test.mjs —— 网页版专属文案的五语取词回归
// 运行：cd src && node tests/web-strings.test.mjs
//
// 钉住两个实际踩过的坑：
//   1) i18n 的 t() 在键缺失时把键名原样返回，所以 `t('ui.up') || '上级'` 的兜底是死代码，
//      界面上会直接渲染出 ui.up（网页版的目录弹窗就是这么露出键名的）。
//   2) 网页版专属词条不进 src/locales/（那是桌面版文件），必须由 src/web/web-strings.js 自带五语。

import assert from 'node:assert'
import { setLocale } from '../i18n.js'
import { wt } from '../web/web-strings.js'

let pass = 0
let fail = 0
function test(name, fn) {
  try {
    fn()
    pass++
    console.log('  ok   ' + name)
  } catch (e) {
    fail++
    console.log('  FAIL ' + name + ' —— ' + ((e && e.message) || e))
  }
}

const KEYS = ['ui.up', 'ui.fileName', 'ui.noFiles', 'web.banner', 'web.sandboxMode']

test('五个语言下都有词条，且不回退成键名本身', () => {
  for (const id of ['zh-CN', 'zh-Hant', 'en-US', 'fr-FR', 'de-DE']) {
    assert.equal(setLocale(id), true, id + ' 应可切换')
    for (const k of KEYS) {
      const v = wt(k)
      assert.ok(v && v !== k, `${id} 的 ${k} 缺词条（拿到 ${v}）`)
      assert.ok(!/^(ui|web|dlg|common)\./.test(v), `${id} 的 ${k} 不该是键名：${v}`)
    }
  }
})

test('键缺失时不泄漏键名：已知桌面键走桌面词表', () => {
  setLocale('zh-CN')
  // common.cancel 在 src/locales 里存在，wt 应原样取到桌面词条而不是自造
  assert.equal(wt('common.cancel'), '取消')
  // 表外又桌面没有的键，只能原样返回（用于暴露缺词，不是渲染给用户的路径）
  assert.equal(wt('definitely.absent.key'), 'definitely.absent.key')
})

test('切语言后取词立刻跟随（横幅靠这个在运行期重刷）', () => {
  setLocale('en-US')
  assert.equal(wt('ui.up'), 'Up')
  assert.equal(wt('web.sandboxMode'), 'Sandbox mode')
  setLocale('zh-CN')
  assert.equal(wt('ui.up'), '上级')
})

console.log('结果：' + pass + ' passed, ' + fail + ' failed')
if (fail) process.exit(1)
