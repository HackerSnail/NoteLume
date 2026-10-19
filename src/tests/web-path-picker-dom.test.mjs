// web-path-picker-dom.test.mjs —— 文件选择框按扩展名过滤（jsdom）
// 运行：npm run web:test（server/tests/run.mjs 会收 src/tests/web-*）
//
// 由来：桌面版 open({filters:[{extensions:['docx']}]}) 只让选 .docx；网页替身早期把这层
// filters 整片丢了，pickFile / pickDocxFiles 在浏览器里会列出所有可挑文件（md / canvas / docx 混在一起）。
// 现在 tauri-dialog 把 filters 拍平成 extensions 传给 pickPath，这里锁三件事：
//   1) 给了 extensions 只列对得上的，选中的路径就是它；
//   2) 对不上的一律不列（含大小写、点号开头的写法）；
//   3) 不给 extensions 时照旧全列（dir / save 模式不受影响）。
// 后端 browse 回的每个文件带 kind（扩展名），过滤依赖这个字段，测试数据照此构造。

import assert from 'node:assert'
import { JSDOM } from 'jsdom'

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' })
globalThis.window = dom.window
globalThis.document = dom.window.document
globalThis.CustomEvent = dom.window.CustomEvent

const FILES = [
  { name: 'home.md', path: '/v/home.md', kind: 'md' },
  { name: 'roadmap.canvas', path: '/v/roadmap.canvas', kind: 'canvas' },
  { name: '示例.DOCX', path: '/v/示例.DOCX', kind: 'docx' },
]
// 按 wantFiles 给不同目录数据；dir 模式（不带 files）回空 files，正好验「过滤只作用在文件列表」
globalThis.fetch = async (url) => {
  const wantFiles = String(url).includes('files=1')
  return {
    json: async () => ({
      ok: true,
      result: {
        path: '/v',
        parent: '/',
        roots: [{ name: 'v', path: '/v' }],
        dirs: [{ name: 'notes', path: '/v/notes' }],
        files: wantFiles ? FILES : [],
        home: '/v',
      },
    }),
  }
}

const { pickPath } = await import('../web/path-picker.js')

let pass = 0
let fail = 0
async function test(name, fn) {
  try {
    await fn()
    pass++
    console.log('  ok   ' + name)
  } catch (e) {
    fail++
    console.log('  FAIL ' + name + ' —— ' + ((e && e.message) || e))
  }
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const settle = () => wait(20) // 等 apiBrowse 的 Promise 链跑完 paint
const listedFiles = () => [...document.querySelectorAll('.nl-picker-file')].map((e) => e.textContent.replace('· ', ''))

// 关掉当前还挂着的模态，免得下一条测试数到旧的节点
function closeOpen() {
  const btns = [...document.querySelectorAll('.nl-prompt-btn')]
  const cancel = btns.find((b) => b.textContent && !b.classList.contains('primary'))
  if (cancel) cancel.click()
  document.querySelectorAll('.nl-picker-overlay').forEach((o) => o.remove())
}

await test('给了 extensions 只列对得上的（大小写不敏感）', async () => {
  const p = pickPath({ mode: 'file', extensions: ['docx'] })
  await settle()
  assert.deepEqual(listedFiles(), ['示例.DOCX'], '只该露 .DOCX（kind 是 docx，显示名大写也认）')
  closeOpen()
  assert.equal(await p, null, '取消回 null')
})

await test('多个 extensions 都列、其余不列', async () => {
  pickPath({ mode: 'file', extensions: ['md', 'canvas'] })
  await settle()
  assert.deepEqual(listedFiles().sort(), ['home.md', 'roadmap.canvas'], 'md / canvas 都该在，docx 不该在')
  closeOpen()
})

await test('不给 extensions 全列（回到旧行为，dir/save 不受影响）', async () => {
  pickPath({ mode: 'file' })
  await settle()
  assert.equal(listedFiles().length, 3, '不带过滤应列出全部三个可挑文件')
  closeOpen()
})

await test('点中过滤后的文件回的就是它的绝对路径', async () => {
  const p = pickPath({ mode: 'file', extensions: ['md'] })
  await settle()
  const items = [...document.querySelectorAll('.nl-picker-file')]
  assert.equal(items.length, 1, 'md 只应有一个')
  items[0].click() // 单选模式：点一下即 finish
  assert.equal(await p, '/v/home.md', '返回的应是选中项绝对路径')
})

await test('对不上任何扩展名时列空并给空态提示', async () => {
  pickPath({ mode: 'file', extensions: ['pdf'] })
  await settle()
  assert.equal(listedFiles().length, 0, '库里没有 pdf')
  assert.ok(document.querySelector('.nl-picker-empty'), '该显示「没有文件」的空态而不是光板')
  closeOpen()
})

console.log('结果：' + pass + ' passed, ' + fail + ' failed')
if (fail) process.exit(1)
