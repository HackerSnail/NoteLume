// app-name.test.mjs —— 产品名按界面语言切换：中文「文溯」，其它语言「NoteLume」
// 运行：cd src && node tests/app-name.test.mjs
//
// 覆盖 UI 文案、关于框、OS 窗口标题、NSIS 快捷方式名四处口径。

import assert from 'node:assert'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (rel) => fs.readFileSync(path.join(SRC, rel), 'utf8')
const { MESSAGES } = await import('../locales/index.js')

// 1. 词条：两种中文是「文溯」，其余三种语言保留 NoteLume
{
  assert.strictEqual(MESSAGES['zh-CN']['ui.appName'], '文溯')
  assert.strictEqual(MESSAGES['zh-Hant']['ui.appName'], '文溯')
  for (const id of ['en-US', 'fr-FR', 'de-DE']) {
    assert.strictEqual(MESSAGES[id]['ui.appName'], 'NoteLume', `${id} 应保留 NoteLume`)
  }
  for (const id of ['zh-CN', 'zh-Hant']) {
    for (const key of ['ui.docTitle', 'cmd.app.about', 'about.title', 'about.copyright']) {
      assert.ok(MESSAGES[id][key].includes('文溯'), `${id}.${key} 没换成文溯`)
    }
  }
  console.log('ok 五语言产品名词条')
}

// 2. 标题栏与关于框都走词条，不写死
{
  const html = read('index.html')
  assert.match(html, /class="appbar-lead" data-i18n="ui\.appName"/)
  const about = read('about-dialog.js')
  assert.match(about, /name\.textContent = t\('ui\.appName'\)/)
  console.log('ok 标题栏与关于框接线')
}

// 3. OS 窗口标题跟界面语言走（mac 仍写文档名，不在此列）
{
  const main = read('main.js')
  assert.match(main, /function syncAppWindowTitle\(\)[\s\S]{0,300}setTitle\(t\('ui\.docTitle'\)\)/)
  assert.match(main, /applyStaticDom\(document\)\r?\n\s*syncAppWindowTitle\(\)/g)
  console.log('ok 窗口标题接线（启动与切语言）')
}

// 4. 安装器按系统 UI 语言给快捷方式改名，卸载时补删
{
  const nsi = read('../src-tauri/nsis-hooks.nsh')
  assert.match(nsi, /GetUserDefaultUILanguage/)
  assert.match(nsi, /Rename "\$DESKTOP\\\$\{PRODUCTNAME\}\.lnk" "\$DESKTOP\\文溯\.lnk"/)
  assert.match(nsi, /Delete "\$DESKTOP\\文溯\.lnk"/)
  console.log('ok NSIS 快捷方式名接线')
}

// 5. 应用按界面语言二次校正快捷方式（安装器只能按系统语言猜）
{
  const main = read('main.js')
  const bridge = read('tauri-bridge.js')
  const lib = read('../src-tauri/src/lib.rs')
  assert.match(main, /syncShortcutName\(getLocale\(\)\)\.catch/)
  assert.match(bridge, /invoke\('sync_shortcut_name', \{ lang \}\)/)
  assert.match(lib, /fn shortcut_name_pair\(lang: &str\)/)
  assert.match(lib, /sync_shortcut_name,/)
  console.log('ok 应用侧快捷方式校正接线')
}
