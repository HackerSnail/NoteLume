// vault-path.test.mjs —— 库路径归一与 rootChanged 的纯逻辑回归
// 运行：cd src && node tests/vault-path.test.mjs

import assert from 'node:assert'
import { normVaultPath, rootChanged } from '../vault-path.js'

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

test('normVaultPath：统一分隔符 / 剥 \\?\\ 前缀 / 去尾斜杠 / 忽略大小写', () => {
  assert.equal(normVaultPath('C:\\Users\\a\\vault'), 'c:/users/a/vault')
  assert.equal(normVaultPath('//?/C:\\Vault\\'), 'c:/vault')
  assert.equal(normVaultPath('/home/a/vault/'), '/home/a/vault')
  assert.equal(normVaultPath(''), '')
  assert.equal(normVaultPath(null), '')
})

test('rootChanged：同一根的不同写法都不算变', () => {
  assert.equal(rootChanged('C:\\Vault', 'C:/vault/'), false)
  assert.equal(rootChanged('//?/C:\\Vault', 'c:/vault'), false)
  assert.equal(rootChanged('', ''), false)
  assert.equal(rootChanged(null, undefined), false)
})

test('rootChanged：不同根 / 一空一不空都算变', () => {
  assert.equal(rootChanged('C:/Vault', 'D:/Vault'), true)
  assert.equal(rootChanged('', 'C:/Vault'), true)
  assert.equal(rootChanged('C:/Vault', null), true)
})

console.log('结果：' + pass + ' passed, ' + fail + ' failed')
if (fail) process.exit(1)
