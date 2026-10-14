// plugin-manifest.test.mjs —— 批次 F1 纯逻辑：manifest 校验 + 权限同意决策（无 DOM）
// 运行：cd src && node tests/plugin-manifest.test.mjs

import assert from 'node:assert'
import {
  parseAndValidateManifest,
  permKey,
  needsConsent,
  newPerms,
  KNOWN_SCOPES,
} from '../plugin-manifest.js'

let pass = 0,
  fail = 0
function check(name, fn) {
  try {
    fn()
    console.log(`✅ ${name}`)
    pass++
  } catch (e) {
    console.error(`❌ ${name}: ${e.message}`)
    fail++
  }
}

const M = (o) => JSON.stringify(o)
const valid = { id: 'hello', name: 'Hello', main: 'main.js', permissions: [] }

check('空文本 → 缺少 manifest', () => {
  assert.strictEqual(parseAndValidateManifest('', 'hello').ok, false)
  assert.ok(parseAndValidateManifest('   ', 'hello').error.includes('缺少'))
})

check('JSON 非法 → 校验失败', () => {
  assert.strictEqual(parseAndValidateManifest('{ not json', 'hello').ok, false)
})

check('合法 → ok 且填默认', () => {
  const r = parseAndValidateManifest(M(valid), 'hello')
  assert.strictEqual(r.ok, true)
  assert.strictEqual(r.id, 'hello')
  assert.strictEqual(r.version, '0.0.0') // 缺省默认
  assert.deepStrictEqual(r.permissions, [])
})

check('id ≠ 目录名 → 拒', () => {
  const r = parseAndValidateManifest(M({ ...valid, id: 'other' }), 'hello')
  assert.strictEqual(r.ok, false)
  assert.ok(r.error.includes('目录名'))
})

check('非法 slug id → 拒', () => {
  assert.strictEqual(parseAndValidateManifest(M({ ...valid, id: 'Bad_Name' }), 'Bad_Name').ok, false)
  assert.strictEqual(parseAndValidateManifest(M({ ...valid, id: '-lead' }), '-lead').ok, false)
})

check('name 空 → 拒', () => {
  assert.strictEqual(parseAndValidateManifest(M({ ...valid, name: '' }), 'hello').ok, false)
})

check('main 后缀非法 → 拒', () => {
  assert.strictEqual(parseAndValidateManifest(M({ ...valid, main: 'entry.ts' }), 'hello').ok, false)
})

check('permissions 非数组 → 拒', () => {
  assert.strictEqual(parseAndValidateManifest(M({ ...valid, permissions: 'network' }), 'hello').ok, false)
})

check('未知 scope → 拒', () => {
  const r = parseAndValidateManifest(M({ ...valid, permissions: ['network', 'rootkit'] }), 'hello')
  assert.strictEqual(r.ok, false)
  assert.ok(r.error.includes('rootkit'))
})

check('已知 scope 全通过', () => {
  const r = parseAndValidateManifest(M({ ...valid, permissions: KNOWN_SCOPES }), 'hello')
  assert.strictEqual(r.ok, true)
  assert.deepStrictEqual(r.permissions, KNOWN_SCOPES)
})

// —— 同意决策 ——
check('permKey 排序稳定', () => {
  assert.strictEqual(permKey(['git', 'network']), permKey(['network', 'git']))
  assert.strictEqual(permKey([]), '')
})

check('无存储记录 → 需同意（空权限也一律弹）', () => {
  assert.strictEqual(needsConsent([], undefined), true)
  assert.strictEqual(needsConsent(['network'], undefined), true)
})

check('permKey 相等 → 已同意', () => {
  assert.strictEqual(needsConsent(['network', 'git'], { perms: ['git', 'network'] }), false)
  assert.strictEqual(needsConsent([], { perms: [] }), false)
})

check('权限集变更 → 需重新同意', () => {
  assert.strictEqual(needsConsent(['network', 'git'], { perms: ['network'] }), true) // 新增
  assert.strictEqual(needsConsent(['network'], { perms: ['network', 'git'] }), true) // 减少
})

check('newPerms 相对上次新增', () => {
  assert.deepStrictEqual(newPerms(['network', 'git'], { perms: ['network'] }), ['git'])
  assert.deepStrictEqual(newPerms(['network'], { perms: ['network', 'git'] }), [])
  assert.deepStrictEqual(newPerms(['network'], undefined), ['network']) // 首次全算新增
})

console.log(`\n结果：${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
