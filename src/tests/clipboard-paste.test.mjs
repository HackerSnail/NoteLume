// clipboard-paste.test.mjs —— 粘贴读剪贴板走桌面插件通道，不再碰网页 Clipboard API
// 运行：cd src && node tests/clipboard-paste.test.mjs
//
// 背景：WebView2 里 navigator.clipboard.readText() 属受网页权限管的操作，每回粘贴就在窗口
// 里弹一条「想要 查看复制到剪贴板的文本和图像」；点「阻止」或直接关掉则粘贴无声失败。
// tauri-bridge.js 的 readClipboardText() 改成有 IPC 通道时懒加载 clipboard-manager 插件
// （Rust 侧 arboard 直读，不进网页权限模型），只有纯 web 预览才落回 navigator.clipboard。
// 这里钉四面：桌面分支真的只发那条 IPC 命令、剪贴板无文字时归一成空串、其它错误不吞、
// 三个读取点与插件接线到位。写入方向不在本条改动内，另用一条守住「只改读不改写」。

import assert from 'node:assert'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { JSDOM } from 'jsdom'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SRC = path.resolve(HERE, '..')
const TAURI = path.resolve(SRC, '..', 'src-tauri')

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' })
global.window = dom.window
global.document = dom.window.document
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true })
global.localStorage = dom.window.localStorage
global.HTMLElement = dom.window.HTMLElement
dom.window.localStorage.setItem('nl-lang', 'zh-CN')

let ipcCalls = []
let ipcReply = '桌面剪贴板文本'
let ipcError = null

window.__TAURI_INTERNALS__ = {
  transformCallback() { return 1 },
  unregisterCallback() {},
  invoke(cmd, args) {
    ipcCalls.push({ cmd, args: args || {} })
    if (ipcError) return Promise.reject(ipcError)
    return Promise.resolve(ipcReply)
  },
}

// tauri-bridge 的 invoke 在模块加载时绑定，打桩必须先装好再 import
const { readClipboardText } = await import('../tauri-bridge.js')

const WEB_TEXT = '网页剪贴板文本'
let webReadCalls = 0
function installWebClipboard(api) {
  // jsdom 的 Navigator 没有 clipboard，网页分支要打在 navigator 对象上而不是 window 上
  Object.defineProperty(dom.window.navigator, 'clipboard', { value: api, configurable: true })
}
installWebClipboard({
  readText() {
    webReadCalls++
    return Promise.resolve(WEB_TEXT)
  },
})

let pass = 0
let fail = 0
async function check(name, fn) {
  ipcCalls = []
  ipcError = null
  ipcReply = '桌面剪贴板文本'
  webReadCalls = 0
  try {
    await fn()
    console.log(`✅ ${name}`)
    pass++
  } catch (e) {
    console.error(`❌ ${name}: ${e.message}`)
    fail++
  }
}

const READ_CMD = 'plugin:clipboard-manager|read_text'

// —— 桌面分支 ——
await check('桌面：有 IPC 时发且只发 clipboard-manager 的 read_text', async () => {
  const got = await readClipboardText()
  assert.equal(got, '桌面剪贴板文本')
  assert.deepEqual(ipcCalls.map((c) => c.cmd), [READ_CMD])
  assert.deepEqual(ipcCalls[0].args, {}, 'read_text 不带参数')
})

await check('桌面：不碰网页 Clipboard API（回归即授权条会重弹）', async () => {
  await readClipboardText()
  assert.equal(webReadCalls, 0, `桌面分支调用网页 readText ${webReadCalls} 次`)
})

await check('边界：插件回空串按空串透传，不改写也不报错', async () => {
  ipcReply = ''
  assert.equal(await readClipboardText(), '')
})

await check('异常：剪贴板只有图（arboard 报 not available）归成空串', async () => {
  ipcError = new Error('clipboard: text is not available on the clipboard')
  assert.equal(await readClipboardText(), '')
})

await check('边界：同类错误大小写混排也归空串（empty 匹配不分大小写）', async () => {
  ipcError = new Error('Clipboard is Empty')
  assert.equal(await readClipboardText(), '')
})

await check('异常：非「无文字」类错误原样抛出，不被静默成空串', async () => {
  ipcError = new Error('permission denied by capability')
  await assert.rejects(() => readClipboardText(), /permission denied/)
})

// —— 纯 web 分支 ——
await check('纯 web：没有 IPC 通道才落回 navigator.clipboard.readText', async () => {
  delete window.__TAURI_INTERNALS__
  try {
    assert.equal(await readClipboardText(), WEB_TEXT)
    assert.equal(webReadCalls, 1)
    assert.equal(ipcCalls.length, 0)
  } finally {
    // 后面的用例仍按桌面环境跑
    window.__TAURI_INTERNALS__ = {
      transformCallback() { return 1 },
      unregisterCallback() {},
      invoke(cmd, args) {
        ipcCalls.push({ cmd, args: args || {} })
        if (ipcError) return Promise.reject(ipcError)
        return Promise.resolve(ipcReply)
      },
    }
  }
})

await check('异常：web 分支里 clipboard 不可用（非安全上下文）时错误外抛给调用方', async () => {
  installWebClipboard(undefined)
  delete window.__TAURI_INTERNALS__
  try {
    await assert.rejects(() => readClipboardText(), TypeError)
  } finally {
    window.__TAURI_INTERNALS__ = {
      transformCallback() { return 1 },
      unregisterCallback() {},
      invoke(cmd, args) {
        ipcCalls.push({ cmd, args: args || {} })
        if (ipcError) return Promise.reject(ipcError)
        return Promise.resolve(ipcReply)
      },
    }
    installWebClipboard({ readText: () => Promise.resolve(WEB_TEXT) })
  }
})

// —— 接线与调用点（静态取证）——
await check('接线：三个读取点全部换成 readClipboardText，读方向不再留网页调用', async () => {
  const js = fs.readFileSync(path.join(SRC, 'main.js'), 'utf8')
  const reads = [...js.matchAll(/await readClipboardText\(\)/g)].length
  assert.equal(reads, 3, `readClipboardText 读取点 ${reads} 处，应为 3 处`)
  const leftover = [...js.matchAll(/navigator\.clipboard\.readText/g)].length
  assert.equal(leftover, 0, `main.js 仍有 ${leftover} 处 navigator.clipboard.readText`)
})

await check('范围：写方向（writeText / write）不动，改动只覆盖读', async () => {
  const js = fs.readFileSync(path.join(SRC, 'main.js'), 'utf8')
  const writes = [...js.matchAll(/navigator\.clipboard\.(writeText|write)\(/g)].length
  assert.ok(writes >= 3, `main.js 的网页写入调用 ${writes} 处，写方向本不该被改没`)
})

await check('接线：插件 JS 包在依赖里且通道名与 Rust 侧命令一致', async () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(SRC, 'package.json'), 'utf8'))
  assert.ok(pkg.dependencies['@tauri-apps/plugin-clipboard-manager'], '缺 npm 依赖声明')
  const bridge = fs.readFileSync(path.join(SRC, 'tauri-bridge.js'), 'utf8')
  assert.ok(/import\('@tauri-apps\/plugin-clipboard-manager'\)/.test(bridge), '插件应懒加载')
  const pluginEntry = fs.readFileSync(
    path.join(SRC, 'node_modules', '@tauri-apps', 'plugin-clipboard-manager', 'dist-js', 'index.js'),
    'utf8',
  )
  assert.ok(pluginEntry.includes(`'${READ_CMD}'`), `插件 dist 未导出 ${READ_CMD}`)
})

await check('接线：Rust 侧注册插件、Cargo 依赖、capability 放通 read-text 且覆盖两类窗口', async () => {
  const lib = fs.readFileSync(path.join(TAURI, 'src', 'lib.rs'), 'utf8')
  assert.ok(lib.includes('.plugin(tauri_plugin_clipboard_manager::init())'), 'lib.rs 未注册插件')
  const cargo = fs.readFileSync(path.join(TAURI, 'Cargo.toml'), 'utf8')
  assert.ok(/^tauri-plugin-clipboard-manager\s*=\s*"2"/m.test(cargo), 'Cargo.toml 缺插件依赖')
  const cap = JSON.parse(fs.readFileSync(path.join(TAURI, 'capabilities', 'default.json'), 'utf8'))
  assert.ok(cap.permissions.includes('clipboard-manager:allow-read-text'), 'capability 未放通 read-text')
  assert.ok(!cap.permissions.includes('clipboard-manager:default'), '不应整包放通剪贴板默认权限')
  assert.deepEqual(cap.windows, ['main', 'vault-*'], `窗口范围应覆盖主窗口与另开窗口，实际 ${cap.windows}`)
})

console.log(`\n结果: ${pass} passed, ${fail} failed`)
if (fail) process.exitCode = 1
