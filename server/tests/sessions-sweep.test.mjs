// sessions-sweep.test.mjs —— 沙盒会话「关浏览器即销毁」的回收逻辑
// 运行：cd server && node tests/sessions-sweep.test.mjs（或根目录 npm run web:test）
//
// 只验 sessions.mjs 的登记/清扫语义：活跃登记、超时销毁（删工作区目录 + 回收索引表与语言表）、
// 活跃会话不被误扫。心跳的前端接线是浏览器行为，这里不起 HTTP，直接驱动 touch/_setLastSeen/sweepIdle。

import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { configure, cfg } from '../src/paths.mjs'
import { touch, dropSession, sweepIdle, _setLastSeen, _snapshot } from '../src/sessions.mjs'
import { indexOf } from '../src/index.mjs'
import { setLangFor, langFor, setLang } from '../src/uiLang.mjs'

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

// —— 把运行期切到沙盒，sessionBase 指到一次性临时目录 ——
const base = fs.mkdtempSync(path.join(os.tmpdir(), 'nl-sess-'))
const prevMode = cfg.mode
const prevBase = cfg.sessionBase
configure({ mode: 'sandbox', sessionBase: base, dataDir: path.join(base, '_data') })

/** 造一份会话工作区（模拟 ensureSessionVault 落过文件），返回其目录 */
function seedSession(sid) {
  const dir = path.join(base, sid)
  fs.mkdirSync(path.join(dir, 'vault'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'vault', 'a.md'), '# a', 'utf8')
  return dir
}

const TTL = 180000

test('本机模式（非沙盒）不登记、不清扫', () => {
  configure({ mode: 'local' })
  try {
    touch('localX')
    assert.equal(_snapshot().has('localX'), false, '本机模式 touch 不该入表')
    assert.deepEqual(sweepIdle(TTL), [], '本机模式 sweep 应空转')
  } finally {
    configure({ mode: 'sandbox', sessionBase: base, dataDir: path.join(base, '_data') })
  }
})

test('非法 sid 被挡（路径成分不入库）', () => {
  touch('../evil')
  assert.equal(_snapshot().has('../evil'), false, '非法 sid 不该登记')
})

test('超时会话被扫：删工作区目录 + 回收索引/语言，回被删 sid', () => {
  const sid = 'gone1'
  const dir = seedSession(sid)
  touch(sid)
  setLangFor(sid, 'en-US')
  const idx = indexOf(sid)
  idx.__probe = 'stale' // 给缓存对象打个标记，好验证它被回收
  _setLastSeen(sid, Date.now() - TTL - 1) // 伪造很久没活动

  const removed = sweepIdle(TTL)
  assert.ok(removed.includes(sid), '被删列表应含该 sid')
  assert.equal(fs.existsSync(dir), false, '工作区目录应已删除')
  assert.equal(_snapshot().has(sid), false, '登记表应已清')
  assert.equal(langFor(sid), langFor('__none__'), '语言回收后回落默认（与陌生 sid 一致）')
  assert.ok(!indexOf(sid).__probe, '索引表应已回收（拿到的是全新实例）')
})

test('活跃会话不被误扫（刷新心跳在 TTL 内恢复）', () => {
  const sid = 'alive1'
  const dir = seedSession(sid)
  touch(sid) // 刚活动
  setLangFor(sid, 'de-DE')
  const removed = sweepIdle(TTL)
  assert.ok(!removed.includes(sid), '活跃会话不该被扫')
  assert.equal(fs.existsSync(dir), true, '工作区应还在')
  assert.equal(langFor(sid), 'de-DE', '语言应还留着')
})

test('dropSession 直接销毁一个会话（无过期判定）', () => {
  const sid = 'drop1'
  const dir = seedSession(sid)
  touch(sid)
  assert.equal(dropSession(sid), true, '有目录时应回 true')
  assert.equal(fs.existsSync(dir), false, '目录应被删')
  assert.equal(_snapshot().has(sid), false, '登记表应清')
  // rmSync 带 force：目录已不存在也不抛，重复销毁幂等返回 true
  assert.equal(dropSession(sid), true, '再删一次（目录已无）应幂等返回 true 而不抛')
})

// —— 复位，避免影响同目录其它用例（本文件内）——
setLang('zh-CN')
configure({ mode: prevMode, sessionBase: prevBase, dataDir: path.join(base, '_data') })
fs.rmSync(base, { recursive: true, force: true })

console.log('结果：' + pass + ' passed, ' + fail + ' failed')
if (fail) process.exit(1)
