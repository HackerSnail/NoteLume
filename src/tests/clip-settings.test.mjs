// clip-settings.test.mjs —— 「网页剪藏」设置纯逻辑回归（不触 DOM）
// 运行：cd src && node tests/clip-settings.test.mjs
import assert from 'node:assert'
import {
  DEFAULT_CLIP,
  normalizeClip,
  genClipToken,
  clipServerUrl,
} from '../clip-settings.js'

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

test('normalizeClip: 空值回落默认', () => {
  for (const raw of [null, undefined, 42, 'x', []]) {
    assert.deepStrictEqual(normalizeClip(raw), DEFAULT_CLIP)
  }
})

test('normalizeClip: 端口与篇数夹取', () => {
  assert.strictEqual(normalizeClip({ port: 80 }).port, 1024)
  assert.strictEqual(normalizeClip({ port: 999999 }).port, 65535)
  assert.strictEqual(normalizeClip({ port: 'abc' }).port, DEFAULT_CLIP.port)
  assert.strictEqual(normalizeClip({ port: 3210 }).port, 3210)
  assert.strictEqual(normalizeClip({ maxLinks: -3 }).maxLinks, 0)
  assert.strictEqual(normalizeClip({ maxLinks: 99 }).maxLinks, 20)
})

test('normalizeClip: 目录与文件名归一化', () => {
  // 反斜杠转正斜杠 + 去首尾斜杠（与 Rust 侧 normalize_folder 同语义）
  assert.strictEqual(normalizeClip({ folder: ' \\Clippings\\ ' }).folder, 'Clippings')
  assert.strictEqual(normalizeClip({ folder: '/a/b/' }).folder, 'a/b')
  assert.strictEqual(normalizeClip({ folder: '  ' }).folder, DEFAULT_CLIP.folder)
  assert.strictEqual(normalizeClip({ filename: '  ' }).filename, DEFAULT_CLIP.filename)
  assert.strictEqual(normalizeClip({ filename: ' {{date}} ' }).filename, '{{date}}')
})

test('normalizeClip: 令牌与模板串净化', () => {
  assert.strictEqual(normalizeClip({ token: '  abc  ' }).token, 'abc')
  assert.strictEqual(normalizeClip({ token: 'x'.repeat(100) }).token.length, 64)
  assert.strictEqual(normalizeClip({ template: ' Templates/a.md ' }).template, 'Templates/a.md')
})

test('normalizeClip: 布尔只认布尔', () => {
  assert.strictEqual(normalizeClip({ enabled: 'yes' }).enabled, false)
  assert.strictEqual(normalizeClip({ enabled: true }).enabled, true)
  assert.strictEqual(normalizeClip({ autoLink: false }).autoLink, false)
  assert.strictEqual(normalizeClip({ openAfterSave: true }).openAfterSave, true)
})

test('normalizeClip: 不篡改默认对象', () => {
  const before = JSON.stringify(DEFAULT_CLIP)
  normalizeClip({ enabled: true, port: 4000, folder: 'x' })
  assert.strictEqual(JSON.stringify(DEFAULT_CLIP), before)
})

test('genClipToken: 32 位十六进制且不重复', () => {
  const a = genClipToken()
  const b = genClipToken()
  assert.match(a, /^[0-9a-f]{32}$/)
  assert.match(b, /^[0-9a-f]{32}$/)
  assert.notStrictEqual(a, b)
})

test('clipServerUrl: 拼本机地址', () => {
  assert.strictEqual(clipServerUrl(3210), 'http://127.0.0.1:3210')
  assert.strictEqual(clipServerUrl('4123'), 'http://127.0.0.1:4123')
  assert.strictEqual(clipServerUrl(''), 'http://127.0.0.1:' + DEFAULT_CLIP.port)
  assert.strictEqual(clipServerUrl(NaN), 'http://127.0.0.1:' + DEFAULT_CLIP.port)
})

console.log(`\nclip-settings: ${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
