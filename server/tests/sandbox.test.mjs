// sandbox.test.mjs —— 沙盒模式的监狱、会话隔离与垃圾回收（spec §12）
// 运行：cd server && node tests/sandbox.test.mjs（或根目录 npm run web:test）
//
// 全程把 sessionBase 指到 mkdtemp，不碰真实的 os.tmpdir 布局；演示库用仓库里那份 server/default-vault。
// 与 kb-commands.test.mjs 一样是「裸 node + 失败 exit 1」的手写风格。

import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { configure, cfg, jailRoot, scratchRoot, defaultVaultRoot, pruneSessions, DEMO_VAULT } from '../src/paths.mjs'
import { browse } from '../src/browse.mjs'
import { dispatch } from '../src/router.mjs'

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

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'nl-sandbox-'))
configure({ sandbox: true, sessionBase: base, dataDir: path.join(base, '_data') })

console.log('沙盒根：' + base + '；演示库：' + DEMO_VAULT)

const A = 'sessA'
const B = 'sessB'

test('模式落定，jail 只在沙盒模式给', () => {
  assert.equal(cfg.mode, 'sandbox')
  assert.ok(jailRoot(A))
  assert.throws(() => jailRoot(''), /bad session id/, '空 sid 该报错而不是回 null')
})

test('首访把演示库灌进会话工作区', () => {
  const jail = jailRoot(A)
  const vault = path.join(jail, 'vault')
  assert.equal(defaultVaultRoot(A), vault)
  assert.ok(fs.existsSync(path.join(vault, 'home.md')), 'home.md 没灌进来')
  assert.ok(fs.existsSync(path.join(vault, '空白页.md')), '空文档没灌进来')
  assert.ok(fs.existsSync(path.join(vault, 'assets', 'demo-light.png')), 'assets 图片没灌进来')
  assert.ok(fs.existsSync(path.join(jail, 'tmp')), 'tmp/ 目录要备着（Ctrl+N 的落点）')
  assert.equal(scratchRoot(A), path.join(jail, 'tmp'))
})

test('首屏入口是 home.md，不是字母序第一篇示例', () => {
  // 与 serve.mjs 的 demoEntry 同一判据：访客第一眼要看介绍页
  const vault = path.join(jailRoot(A), 'vault')
  const names = fs.readdirSync(vault).filter((n) => n.toLowerCase().endsWith('.md')).sort()
  const home = names.find((n) => /^(home|index|readme)\.md$/i.test(n)) || names[0]
  assert.equal(home, 'home.md', '实际会开成 ' + home)
})

test('browse 空路径回 vault 起点：file / save 的 picker 从库根开始，不落空列表', () => {
  const jail = jailRoot(B)
  const r = browse('', { jail, wantFiles: true })
  assert.equal(r.vault, path.join(fs.realpathSync(jail), 'vault'), 'vault 应指向会话库根')
  assert.equal(r.home, fs.realpathSync(jail), 'home 仍是工作区根（兜底起点）')
  assert.ok(fs.existsSync(r.vault), 'vault 起点必须真实存在')
  // 库根里点得到 .docx：导入 Word 的选择框不再是一张空列表
  const inVault = browse(r.vault, { jail, wantFiles: true })
  assert.ok(inVault.files.some((f) => f.kind === 'docx'), '库根应列得出 .docx：' + JSON.stringify(inVault.files))
  // 本机模式没有 vault 概念，回 null（picker 走 home / 盘符列表）
  assert.equal(browse('', { jail: null }).vault, null, '本机模式 vault 应为 null')
})

test('非法 sid 直接拒，不当目录名用', () => {
  for (const bad of ['../etc', 'a/b', 'with space', '.']) {
    assert.throws(() => jailRoot(bad), /bad session id/, `${bad} 竟然放行`)
  }
  const r = dispatch({ sid: '../etc', jail: null }, 'scan_vault', { vaultRoot: base })
  assert.equal(r.ok, false)
})

test('/api/browse 锁在会话工作区内', () => {
  const jail = jailRoot(A)
  const vault = path.join(jail, 'vault')
  const inside = browse(vault, { jail })
  assert.ok(inside.path, '工作区内应能列')
  assert.ok(inside.dirs.some((d) => d.name !== ''), '至少要有内容')
  assert.equal(inside.roots.length, 1, '沙盒的 roots 只该有工作区一个根')
  assert.equal(inside.home, fs.realpathSync(jail), 'home 要指向工作区而不是用户主目录')

  assert.throws(() => browse(os.homedir(), { jail }), /./, '主目录应当越界')
  assert.throws(() => browse(path.resolve(DEMO_VAULT, '..', '..'), { jail }), /./, '仓库目录应当越界')
  const head = browse('', { jail })
  assert.equal(head.roots.length, 1, '不给 path 时也不该列出盘符')
})

test('本机模式下 browse 可以浏览全盘（对照）', () => {
  configure({ mode: 'local' })
  assert.equal(cfg.mode, 'local')
  assert.equal(jailRoot(A), null, '本机模式不该有 jail')
  const r = browse('', { jail: null })
  assert.ok(r.roots.length >= 1)
  configure({ mode: 'sandbox' })
  assert.equal(cfg.mode, 'sandbox')
})

test('库根必须在自己工作区内：别人的库与仓库都拒', () => {
  const ctx = { sid: A, jail: jailRoot(A) }
  const foreign = dispatch(ctx, 'scan_vault', { vaultRoot: DEMO_VAULT })
  assert.equal(foreign.ok, false, '指向演示库本体竟然通过')
  assert.ok(!/Error:/.test(foreign.error), '回的是给人看的文案：' + foreign.error)
  const up = dispatch(ctx, 'scan_vault', { vaultRoot: path.resolve(base, '..') })
  assert.equal(up.ok, false)
  const mine = dispatch(ctx, 'scan_vault', { vaultRoot: path.join(jailRoot(A), 'vault') })
  assert.equal(mine.ok, true, mine && mine.error)
  assert.ok(Array.isArray(mine.result) && mine.result.length, '自己的库要能扫出树')
})

test('两个 sid 的 vault 互不可见', () => {
  const va = path.join(jailRoot(A), 'vault')
  const vb = path.join(jailRoot(B), 'vault')
  fs.writeFileSync(path.join(va, 'only-a.md'), '# 只在 A\n', 'utf8')
  assert.ok(fs.existsSync(path.join(va, 'only-a.md')))
  assert.equal(fs.existsSync(path.join(vb, 'only-a.md')), false, 'B 看见了 A 的文件')
  assert.notEqual(va, vb)
  const ctxB = { sid: B, jail: jailRoot(B) }
  const r = dispatch(ctxB, 'read_md_file', { vaultRoot: vb, path: 'only-a.md' })
  assert.equal(r.ok, false, 'B 读到了 A 的文档')
})

test('文件写也在监狱内：越界的相对路径拼不出去', () => {
  const jail = jailRoot(A)
  const vault = path.join(jail, 'vault')
  const ctx = { sid: A, jail }
  const escape = dispatch(ctx, 'create_md_file', { vaultRoot: vault, args: { path: '../escape', content: 'x' } })
  assert.equal(escape.ok, false, '../ 逃逸竟然成功')
  assert.equal(fs.existsSync(path.join(jail, 'escape.md')), false, '工作区里出现了逃逸文件')
  const inside = dispatch(ctx, 'create_md_file', { vaultRoot: vault, args: { path: 'notes/ok', content: '# ok\n' } })
  assert.equal(inside.ok, true, inside.error)
  assert.equal(inside.result, 'notes/ok.md', '补 .md 后的相对路径要回给前端：' + inside.result)
  assert.ok(fs.existsSync(path.join(vault, 'notes', 'ok.md')))
})

test('pruneSessions 清掉 7 天前的会话，新的留着', () => {
  const stale = path.join(base, 'stale1')
  fs.mkdirSync(path.join(stale, 'vault'), { recursive: true })
  fs.writeFileSync(path.join(stale, 'vault', 'a.md'), '# a\n', 'utf8')
  const old = new Date(Date.now() - 9 * 24 * 60 * 60 * 1000)
  // 判据取「整棵树里最新的 mtime」，所以目录和内文件都要压回 9 天前
  fs.utimesSync(path.join(stale, 'vault', 'a.md'), old, old)
  fs.utimesSync(path.join(stale, 'vault'), old, old)
  fs.utimesSync(stale, old, old)
  const freshName = 'fresh1'
  fs.mkdirSync(path.join(base, freshName, 'vault'), { recursive: true })
  const removed = pruneSessions(7)
  assert.ok(removed.includes('stale1'), '该清的没清：' + JSON.stringify(removed))
  assert.equal(fs.existsSync(stale), false, '目录还在')
  assert.ok(fs.existsSync(path.join(base, freshName)), '新会话被误删')
  // 真实会话目录不因文件名不合法而被删
  assert.ok(fs.existsSync(path.join(base, A)), 'A 的工作区被删了')
})

console.log('结果：' + pass + ' passed, ' + fail + ' failed')
if (fail) process.exit(1)
