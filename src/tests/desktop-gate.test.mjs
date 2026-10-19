// desktop-gate.test.mjs —— 桌面能力的环境隔离回归（不触真后端）
// 运行：cd src && node tests/desktop-gate.test.mjs
//
// 三条线：① 无后端时每个桌面调用都 reject 同一个带 code 的 Error，绝不漏出原生 TypeError
// ② 有后端标记时原样透传给 Tauri（桌面实现没被删）③ 全仓只有一处读注入标记、一处导入 Tauri 原语
import assert from 'node:assert'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

let pass = 0
let fail = 0
async function t(name, fn) {
  try {
    await fn()
    pass++
    console.log('  ok   ' + name)
  } catch (e) {
    fail++
    console.log('  FAIL ' + name + ' —— ' + ((e && e.message) || e))
  }
}

const SRC = path.join(fileURLToPath(new URL('.', import.meta.url)), '..')

// —— 浏览器沙盒桩：有 window / alert / confirm / FileReader，没有 __TAURI_INTERNALS__ ——
const alerts = []
const confirms = []
globalThis.window = {
  alert: (m) => alerts.push(m),
  confirm: (m) => { confirms.push(m); return true },
  dispatchEvent: () => true, // i18n 切语言时广播事件用，桩只需不炸
}
globalThis.FileReader = class {
  readAsDataURL() {
    this.result = 'data:image/png;base64,AAAA'
    this.onload()
  }
}

const gate = await import('../desktop-gate.js')
const bridge = await import('../tauri-bridge.js')
const { setLocale } = await import('../i18n.js')
setLocale('zh-CN')

// 纯前端工具（不碰后端），扫描时跳过
const PURE = new Set(['isImagePath', 'isImportableFileName', 'fileToBase64'])
// 无后端时有意换成 Web 等价物的两个（单独测，见下）
const WEB_FALLBACK = new Set(['confirmDialog', 'messageDialog'])
const backendFns = Object.entries(bridge)
  .filter(([k, v]) => typeof v === 'function' && !PURE.has(k) && !WEB_FALLBACK.has(k))
  .map(([k, v]) => [k, v])

await t('无后端时 isDesktop() 为假', () => {
  assert.strictEqual(gate.isDesktop(), false)
})

await t('无后端时全部桌面调用 reject 同一 code，且不是原生 TypeError', async () => {
  const file = { name: 'a.png', type: 'image/png' }
  for (const [name, fn] of backendFns) {
    let err = null
    try {
      await fn('/vault', 'doc.md', 'x', file)
    } catch (e) {
      err = e
    }
    assert.ok(err, name + ' 没有 reject')
    assert.strictEqual(err.code, 'desktop-only', name + ' 的 code 不是 desktop-only：' + err.code)
    assert.strictEqual(err.message, '此功能需在桌面应用中使用', name + ' 文案漂移：' + err.message)
    assert.ok(!(err instanceof TypeError), name + ' 漏出原生 TypeError')
    assert.ok(err.op, name + ' 缺 op（控制台无从定位）')
  }
})

await t('桌面调用点数量不缩水（导出即全部后端 wrapper）', () => {
  assert.ok(backendFns.length > 60, '只扫到 ' + backendFns.length + ' 个')
})

await t('文件选择类 reject，不静默当成「用户取消」', async () => {
  for (const name of ['pickFolder', 'pickFile', 'pickDocxFiles', 'pickSaveAs']) {
    const err = await bridge[name]().then(() => null, (e) => e)
    assert.strictEqual(err && err.code, 'desktop-only', name + ' 未 reject')
  }
})

await t('原生对话框在无后端时换成 Web 等价物', async () => {
  alerts.length = 0
  confirms.length = 0
  assert.strictEqual(await bridge.confirmDialog('确定吗'), true)
  assert.deepStrictEqual(confirms, ['确定吗'])
  assert.strictEqual(await bridge.messageDialog('导入失败：x'), true)
  assert.deepStrictEqual(alerts, ['导入失败：x'])
})

await t('桌面路径：装好 __TAURI_INTERNALS__ 后原样透传', async () => {
  const calls = []
  globalThis.window.__TAURI_INTERNALS__ = {
    invoke: async (cmd, args) => {
      calls.push(cmd)
      return '/stub'
    },
  }
  assert.strictEqual(gate.isDesktop(), true)
  assert.strictEqual(await bridge.scanVault('/v'), '/stub')
  assert.ok(calls.includes('scan_vault'), 'Rust 命令名没透传：' + calls.join(','))
  assert.strictEqual(await bridge.readMdFile('/v', 'a.md'), '/stub')
  assert.strictEqual(await bridge.tempDir(), '/stub')
  assert.strictEqual(await bridge.join('/a', 'b'), '/stub')
  assert.ok(calls.includes('plugin:path|resolve_directory'), 'path API 没走 invoke：' + calls.join(','))
})

await t('五个语言都有 msg.desktopOnly 词条', async () => {
  const { LOCALES, MESSAGES } = await import('../locales/index.js')
  for (const { id } of LOCALES) {
    const v = MESSAGES[id]['msg.desktopOnly']
    assert.ok(v && v.length > 4 && !v.includes('{'), id + ' 词条异常：' + v)
  }
})

await t('全仓只有 desktop-gate.js 读注入标记', () => {
  const hits = fs
    .readdirSync(SRC)
    .filter((f) => f.endsWith('.js'))
    .filter((f) => fs.readFileSync(path.join(SRC, f), 'utf8').includes('__TAURI_INTERNALS__'))
  assert.deepStrictEqual(hits, ['desktop-gate.js'])
})

await t('Tauri 原语只在 tauri-bridge.js / titlebar.js / main.js 导入', () => {
  const allow = new Set(['tauri-bridge.js', 'titlebar.js', 'main.js'])
  const hits = fs
    .readdirSync(SRC)
    .filter((f) => f.endsWith('.js'))
    .filter((f) => fs.readFileSync(path.join(SRC, f), 'utf8').includes("from '@tauri-apps"))
  for (const f of hits) assert.ok(allow.has(f), '意外的 Tauri 导入点：' + f)
  // core（invoke）/ plugin-dialog / api-path 三个必须只归 bridge 一处
  for (const spec of ['@tauri-apps/api/core', '@tauri-apps/plugin-dialog', '@tauri-apps/api/path']) {
    const users = hits.filter((f) => fs.readFileSync(path.join(SRC, f), 'utf8').includes(spec))
    assert.deepStrictEqual(users, ['tauri-bridge.js'], spec + ' 的导入点不止 bridge')
  }
})

console.log('结果：' + pass + ' passed, ' + fail + ' failed')
if (fail) process.exit(1)
