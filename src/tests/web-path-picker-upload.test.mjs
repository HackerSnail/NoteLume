// web-path-picker-upload.test.mjs —— 文件选择框「上传本机文件」（jsdom）
// 运行：npm run web:test（server/tests/run.mjs 会收 src/tests/web-*）
//
// 锁的是 path-picker 的上传入口把「浏览器 File」接进「服务端导入」这条链：
//   1) file 模式底部有「上传本机文件」按钮 + 隐藏 input，accept 由 filters.extensions 推出（.docx 只收 docx）；
//   2) 选文件后先 FileReader→base64，再 invoke('import_vault_file',{vaultRoot:当前浏览目录,args:{name,dataBase64}})；
//   3) 拿回来的库内相对路径拼成 jail 绝对路径 resolve 出去，喂给后续「导入 Word」流程。
// 不发真 HTTP：stub fetch 同时接 /api/browse（列表数据）与 /api/invoke（import 落库），并记下 invoke 的调用。

import assert from 'node:assert'
import { JSDOM } from 'jsdom'

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' })
globalThis.window = dom.window
globalThis.document = dom.window.document
globalThis.CustomEvent = dom.window.CustomEvent
globalThis.Event = dom.window.Event
globalThis.File = dom.window.File
globalThis.FileReader = dom.window.FileReader

const CUR = '/v' // 当前浏览目录（= 上传落库的库根）
const invokeCalls = []

globalThis.fetch = async (url, opts) => {
  if (String(url).includes('/api/browse')) {
    return {
      json: async () => ({
        ok: true,
        result: { path: CUR, parent: '/', roots: [{ name: 'v', path: CUR }], dirs: [], files: [], home: CUR },
      }),
    }
  }
  if (String(url).includes('/api/invoke')) {
    const body = JSON.parse((opts && opts.body) || '{}')
    invokeCalls.push(body)
    // import_vault_file 回库内相对路径
    const rel = body.cmd === 'import_vault_file' ? body.params.args.name : null
    return { json: async () => ({ ok: true, result: rel }) }
  }
  return { json: async () => ({ ok: false, error: 'unexpected ' + url }) }
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
const settle = () => wait(30)

/** 开框、拿到一个本机 File 塞进隐藏 input、触发 change，返回整条 promise 的结果 */
async function runUpload({ extensions, fileName = '示例上传.docx', bytes = 'hello-docx-bytes' }) {
  invokeCalls.length = 0
  document.querySelectorAll('.nl-picker-overlay').forEach((o) => o.remove())
  const p = pickPath({ mode: 'file', extensions })
  await settle()
  const input = document.querySelector('.nl-picker-fileinput')
  assert.ok(input, 'file 模式应有隐藏的 file input')
  // jsdom 的 input.files 是只读 FileList：用 defineProperty 覆盖成我们要喂的文件
  const file = new File([bytes], fileName, { type: 'application/octet-stream' })
  Object.defineProperty(input, 'files', { value: [file], configurable: true })
  input.dispatchEvent(new dom.window.Event('change'))
  return { abs: await p, input }
}

await test('file 模式给出上传按钮，accept 由 extensions 推出', async () => {
  invokeCalls.length = 0
  document.querySelectorAll('.nl-picker-overlay').forEach((o) => o.remove())
  pickPath({ mode: 'file', extensions: ['docx'] })
  await settle()
  const uploadBtn = document.querySelector('.nl-picker-upload')
  assert.ok(uploadBtn, '底部应有「上传本机文件」按钮')
  assert.equal(document.querySelector('.nl-picker-fileinput').accept, '.docx', 'docx 选择框只收 .docx')
  const cancel = [...document.querySelectorAll('.nl-prompt-btn')].find((b) => !b.classList.contains('primary') && !b.classList.contains('nl-picker-upload'))
  cancel && cancel.click()
})

await test('不给 extensions 时 accept 为空（收全部类型）', async () => {
  document.querySelectorAll('.nl-picker-overlay').forEach((o) => o.remove())
  pickPath({ mode: 'file' })
  await settle()
  assert.equal(document.querySelector('.nl-picker-fileinput').accept, '', '无 filters → accept 空')
  const cancel = [...document.querySelectorAll('.nl-prompt-btn')].find((b) => !b.classList.contains('primary') && !b.classList.contains('nl-picker-upload'))
  cancel && cancel.click()
})

await test('多扩展名 accept 用逗号拼（对齐 filters）', async () => {
  document.querySelectorAll('.nl-picker-overlay').forEach((o) => o.remove())
  pickPath({ mode: 'file', extensions: ['md', 'canvas'] })
  await settle()
  assert.equal(document.querySelector('.nl-picker-fileinput').accept, '.md,.canvas', 'accept 跟随扩展名列表')
  const cancel = [...document.querySelectorAll('.nl-prompt-btn')].find((b) => !b.classList.contains('primary') && !b.classList.contains('nl-picker-upload'))
  cancel && cancel.click()
})

await test('选文件 → import_vault_file（base64）→ 回 jail 绝对路径', async () => {
  const { abs } = await runUpload({ extensions: ['docx'], fileName: '我的稿.docx', bytes: 'ABCD' })
  assert.equal(abs, CUR + '/我的稿.docx', '应把库内 rel 拼成当前目录下的绝对路径')
  const call = invokeCalls.find((c) => c.cmd === 'import_vault_file')
  assert.ok(call, '应调用 import_vault_file')
  assert.equal(call.params.vaultRoot, CUR, '库根 = 当前浏览目录')
  assert.equal(call.params.args.name, '我的稿.docx', '带上原始文件名')
  assert.equal(call.params.args.destDirRel, '', '落进当前目录')
  assert.equal(Buffer.from(call.params.args.dataBase64, 'base64').toString('utf8'), 'ABCD', 'base64 内容还原正确')
})

console.log('结果：' + pass + ' passed, ' + fail + ' failed')
if (fail) process.exit(1)
