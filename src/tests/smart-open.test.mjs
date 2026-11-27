// smart-open.test.mjs —— 双击 md 智能打开的三分支判定与 IPC 形状
// 运行：cd src && node tests/smart-open.test.mjs
//
// 真正的目录扫描 / 魔数识别在 src-tauri 的 Rust 单测里验证；这里只钉前端那层纯判定与
// tauri-bridge 的命令名，防止把 Rust 返回的 camelCase 字段接错。

import assert from 'node:assert'
import { JSDOM } from 'jsdom'

const dom = new JSDOM('<!doctype html><html><body></body></html>')
global.window = dom.window
global.document = dom.window.document

const calls = []
window.__TAURI_INTERNALS__ = {
  transformCallback() { return 1 },
  unregisterCallback() {},
  invoke(cmd, args) {
    calls.push({ cmd, args })
    return Promise.resolve({ openAsVault: true, mdCount: 2, hasSubdir: false, tree: [], root: '/库', rel: 'a.md' })
  },
}

const { decideMdOpenMode, inspectMdOpenTarget } = await import('../tauri-bridge.js')

let pass = 0
let fail = 0
async function check(name, fn) {
  try {
    await fn()
    console.log(`ok   ${name}`)
    pass++
  } catch (e) {
    console.error(`FAIL ${name}: ${e.message}`)
    fail++
  }
}

await check('单 md 且无子目录 → 单文档', () => {
  assert.strictEqual(decideMdOpenMode({ mdCount: 1, hasSubdir: false }), false)
})

await check('两个及以上 md → 知识库（子目录有无都不影响）', () => {
  assert.strictEqual(decideMdOpenMode({ mdCount: 2, hasSubdir: false }), true)
  assert.strictEqual(decideMdOpenMode({ mdCount: 3, hasSubdir: true }), true)
})

await check('单 md 但有任意子目录 → 知识库', () => {
  assert.strictEqual(decideMdOpenMode({ mdCount: 1, hasSubdir: true }), true)
})

await check('字段缺失按默认值走单文档，不让 undefined 误判', () => {
  assert.strictEqual(decideMdOpenMode(), false)
  assert.strictEqual(decideMdOpenMode({ mdCount: 0, hasSubdir: false }), false)
})

await check('inspectMdOpenTarget 走 inspect_md_open_target 并原样传 path', async () => {
  const got = await inspectMdOpenTarget('/库/a.md')
  assert.strictEqual(calls.length, 1)
  assert.strictEqual(calls[0].cmd, 'inspect_md_open_target')
  assert.deepStrictEqual(calls[0].args, { path: '/库/a.md' })
  assert.strictEqual(got.openAsVault, true)
})

console.log(`smart-open: ${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
