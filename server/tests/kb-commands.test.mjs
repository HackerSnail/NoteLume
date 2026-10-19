// kb-commands.test.mjs —— 知识库类命令的语义回归：索引 / 反链 / 出链 / 标签 / 搜索 / 图谱 / 快照
// 运行：node server/tests/kb-commands.test.mjs
//
// 全程走 router 的 dispatch，连同分派表、错误前串、按 sid 的索引隔离一起验。

import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { dispatch } from '../src/router.mjs'
import { resetStore } from '../src/index.mjs'

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

// —— 测试库 ——
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nl-kb-'))
const write = (rel, content) => {
  const abs = path.join(root, ...rel.split('/'))
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, content, 'utf8')
}

write(
  'alpha.md',
  '# Alpha\n\n正文 alpha-body。\n\n指向 [[beta]] 与 [[beta|Beta 别名]]，还有 [[beta#章节]]。\n标签见 #proj/alpha 与 [[gamma]]。\n'
)
write('beta.md', '# Beta 文档\n\nbeta-body 含关键词 ZETAKEY 供搜索。\n')
write(
  'gamma.md',
  '# Gamma\n\n链接到不存在的 [[nope]]。\n\n```js\nconst x = "[[insideCode]]"\nconst t = "#insideTag"\n```\n\n行内 `[[inlineLink]]` 与 `#inlineTag` 也不该被抽。\n'
)
write('sub/delta.md', '# Delta\n\n标签 #proj/alpha\n')

let sidSeq = 0
const ctx = () => ({ sid: `t${++sidSeq}`, jail: null })
const ok = (c, cmd, params) => {
  const r = dispatch(c, cmd, params)
  if (!r.ok) throw new Error(`${cmd} 失败：${r.error}`)
  return r.result
}
const errOf = (c, cmd, params) => {
  const r = dispatch(c, cmd, params)
  assert.equal(r.ok, false, `${cmd} 应当失败`)
  return r.error
}

/** 轮询到索引就绪（rebuild 是异步让出的，与前端同样的等法） */
async function ready(c) {
  for (let i = 0; i < 200; i++) {
    const st = ok(c, 'get_index_status', {})
    if (st.ready) return st
    await new Promise((r) => setTimeout(r, 5))
  }
  throw new Error('索引 1 秒内没就绪')
}

async function freshVaultIndex() {
  const c = ctx()
  ok(c, 'rebuild_index', { vaultRoot: root })
  const st = await ready(c)
  return { c, st }
}

console.log('kb-commands：临时库 ' + root)

await test('未 rebuild 的会话：ready=false，docs=0', () => {
  const st = ok(ctx(), 'get_index_status', {})
  assert.equal(st.ready, false)
  assert.equal(st.docs, 0)
})

await test('rebuild_index 立刻回 ready=false 与传入的 vaultRoot 原值', () => {
  const c = ctx()
  const r = ok(c, 'rebuild_index', { vaultRoot: root })
  assert.equal(r.vaultRoot, root)
  assert.equal(r.ready, false)
  assert.equal(r.docs, 0)
})

const { c: A, st } = await freshVaultIndex()

await test('索引就绪后 docs=4 且 vaultRoot 已解析成绝对库根', () => {
  assert.equal(st.docs, 4)
  // Windows 上 realpath 可能给出短名形式，只比临时目录名那一段
  assert.ok(st.vaultRoot.toLowerCase().includes(path.basename(root).toLowerCase()), st.vaultRoot)
})

await test('反链：alpha 的三条 [[beta]] 变体都指回 beta.md', () => {
  const bl = ok(A, 'query_backlinks', { path: 'beta.md' })
  assert.deepEqual(bl, [{ path: 'alpha.md', title: 'Alpha' }])
})

await test('出链：解析成功的目标去重排序，带 #段 的也能落位', () => {
  const out = ok(A, 'query_outgoing', { path: 'alpha.md' })
  assert.deepEqual(out.map((o) => o.path), ['beta.md', 'gamma.md'])
  assert.equal(out[1].title, 'Gamma')
})

await test('未解析目标保留原文，代码块内的 [[..]] 与 #tag 不被抽进', () => {
  const info = ok(A, 'get_doc_info', { path: 'gamma.md' })
  assert.deepEqual(info.unresolved, ['nope'])
  assert.deepEqual(info.tags, [])
  const out = ok(A, 'get_doc_info', { path: 'gamma.md' }).outgoing
  assert.deepEqual(out, [])
})

await test('get_doc_info 的形状与摘要', () => {
  const info = ok(A, 'get_doc_info', { path: 'alpha.md' })
  assert.equal(info.title, 'Alpha')
  assert.deepEqual(Object.keys(info).sort(), ['outgoing', 'path', 'summary', 'tags', 'title', 'unresolved'])
  assert.deepEqual(info.tags, ['proj/alpha'])
  assert.ok(info.summary.includes('alpha-body'))
})

await test('库外路径的文档查询返回空而不是报错', () => {
  assert.deepEqual(ok(A, 'query_backlinks', { path: 'no-such.md' }), [])
  assert.equal(ok(A, 'get_doc_info', { path: 'no-such.md' }), null)
})

await test('标签计数：多级标签按写法聚合，降序同数按名序', () => {
  const tags = ok(A, 'list_all_tags', {})
  assert.deepEqual(tags, [{ tag: 'proj/alpha', count: 2 }])
})

await test('query_tag：忽略大小写与开头的 #，按路径排序', () => {
  const hits = ok(A, 'query_tag', { tag: '#PROJ/ALPHA' })
  assert.deepEqual(hits.map((h) => h.path), ['alpha.md', 'sub/delta.md'])
})

await test('搜索：正文命中回 content，片段含关键词', () => {
  const hits = ok(A, 'search_vault', { query: 'ZETAKEY', limit: 40 })
  assert.equal(hits.length, 1)
  assert.equal(hits[0].path, 'beta.md')
  assert.equal(hits[0].matchedBy, 'content')
  assert.ok(hits[0].snippet.includes('ZETAKEY'))
})

await test('搜索：每篇文档自己的命中类型按标题 > 标签 > 正文判定', () => {
  const hits = ok(A, 'search_vault', { query: 'gamma', limit: 40 })
  assert.equal(hits.find((h) => h.path === 'gamma.md').matchedBy, 'title')
  assert.deepEqual(hits.filter((h) => h.matchedBy === 'title').map((h) => h.path), ['gamma.md'])
  assert.deepEqual(ok(A, 'search_vault', { query: '   ', limit: 40 }), [])
})

await test('搜索：结果按 matchedBy 字典序排（与桌面版同：content 排在 title 前）', () => {
  const hits = ok(A, 'search_vault', { query: 'gamma', limit: 40 })
  assert.equal(hits[0].matchedBy, 'content') // alpha.md 正文里提到了 [[gamma]]
  assert.equal(hits[hits.length - 1].path, 'gamma.md')
})

await test('搜索：limit 生效', () => {
  assert.equal(ok(A, 'search_vault', { query: 'a', limit: 2 }).length, 2)
})

await test('图谱：节点按路径排序，双向链接合并成一条边', () => {
  const g = ok(A, 'get_graph_data', { vaultRoot: root })
  assert.deepEqual(g.nodes.map((n) => n.path), ['alpha.md', 'beta.md', 'gamma.md', 'sub/delta.md'])
  const pairs = g.edges.map((e) => `${e.s}->${e.t}:${e.w}`)
  assert.ok(pairs.includes('alpha.md->beta.md:1'), pairs.join(' '))
  assert.ok(pairs.includes('alpha.md->gamma.md:1'), pairs.join(' '))
  assert.ok(!g.edges.some((e) => e.s === e.t), '不应有自环')
})

await test('update_index_doc：新链接立刻进反链表', () => {
  write('alpha.md', '# Alpha\n\n现在指向 [[delta]]。\n')
  ok(A, 'update_index_doc', { path: 'alpha.md', content: fs.readFileSync(path.join(root, 'alpha.md'), 'utf8') })
  assert.deepEqual(ok(A, 'query_outgoing', { path: 'alpha.md' }).map((o) => o.path), ['sub/delta.md'])
  assert.deepEqual(ok(A, 'query_backlinks', { path: 'sub/delta.md' }), [{ path: 'alpha.md', title: 'Alpha' }])
})

await test('update_index_doc：删掉的链接要从对方反链里摘干净', () => {
  ok(A, 'update_index_doc', { path: 'alpha.md', content: '# Alpha\n\n不再指向任何文档。\n' })
  assert.deepEqual(ok(A, 'query_backlinks', { path: 'sub/delta.md' }), [])
  assert.deepEqual(ok(A, 'query_outgoing', { path: 'alpha.md' }), [])
})

await test('remove_index_doc：清掉它写进别人的反链，并删自身条目', () => {
  write('alpha.md', '# Alpha\n\n指向 [[beta]]。\n')
  ok(A, 'update_index_doc', { path: 'alpha.md', content: '# Alpha\n\n指向 [[beta]]。\n' })
  assert.equal(ok(A, 'query_backlinks', { path: 'beta.md' }).length, 1)
  ok(A, 'remove_index_doc', { path: 'alpha.md' })
  assert.equal(ok(A, 'get_index_status', {}).docs, 3)
  assert.deepEqual(ok(A, 'query_backlinks', { path: 'beta.md' }), [])
  assert.equal(ok(A, 'get_doc_info', { path: 'alpha.md' }), null)
})

await test('doc_preview 读盘取摘要，越界路径回 [invalid_path] 前串', async () => {
  const p = ok(A, 'doc_preview', { vaultRoot: root, path: 'beta.md', maxChars: 20 })
  assert.ok(p.includes('Beta 文档'))
  const c = ctx()
  ok(c, 'rebuild_index', { vaultRoot: root })
  const bad = errOf(c, 'doc_preview', { vaultRoot: root, path: '../../windows/win.ini', maxChars: 20 })
  assert.ok(/非法路径|Invalid path|outside/.test(bad), bad)
})

await test('快照三命令：写入 -> 列出 -> 读回，路径落在 .notelume-backup 下', () => {
  const c = ctx()
  const rel = ok(c, 'backup_write', { vaultRoot: root, args: { path: 'beta.md', content: 'SNAPSHOT-TEXT\n' } })
  assert.match(rel, /^\.notelume-backup\/\d{4}-\d{2}-\d{2}\/beta-\d{2}-\d{2}-\d{2}\.md$/)
  assert.ok(fs.existsSync(path.join(root, ...rel.split('/'))), '备份文件要真的落盘')

  const list = ok(c, 'list_backups', { vaultRoot: root, docRel: null })
  assert.equal(list.length, 1)
  assert.equal(list[0].path, rel)
  assert.equal(list[0].name, rel.split('/').pop())
  assert.match(list[0].day, /^\d{4}-\d{2}-\d{2}$/)

  ok(c, 'backup_write', { vaultRoot: root, args: { path: 'alpha.md', content: 'OTHER\n' } })
  const onlyBeta = ok(c, 'list_backups', { vaultRoot: root, docRel: 'beta.md' })
  assert.equal(onlyBeta.length, 1)
  assert.equal(ok(c, 'list_backups', { vaultRoot: root, docRel: null }).length, 2)

  assert.equal(ok(c, 'read_backup', { vaultRoot: root, backupRel: rel }), 'SNAPSHOT-TEXT\n')
})

await test('read_backup 只准读备份目录：越界与库外都被拒', () => {
  const c = ctx()
  const e = errOf(c, 'read_backup', { vaultRoot: root, backupRel: 'beta.md' })
  assert.ok(/备份目录|backup directory/.test(e), e)
  const e2 = errOf(c, 'read_backup', { vaultRoot: root, backupRel: '.notelume-backup/../../secret.txt' })
  assert.ok(e2 !== e, '穿越路径要落到库根校验的报错上')
})

await test('快照目录不进文件树也不进索引', async () => {
  const c = ctx()
  ok(c, 'backup_write', { vaultRoot: root, args: { path: 'beta.md', content: 'X\n' } })
  ok(c, 'rebuild_index', { vaultRoot: root })
  const st2 = await ready(c)
  assert.equal(st2.docs, 4, '.notelume-backup 里的 md 不该被索引')
  const tree = ok(c, 'scan_vault', { vaultRoot: root })
  assert.ok(!tree.some((n) => n.name === '.notelume-backup'), '文件树不该列出备份目录')
})

await test('会话隔离：两个 sid 的索引互不干扰', () => {
  const one = ctx()
  const other = ctx()
  ok(one, 'rebuild_index', { vaultRoot: root })
  assert.equal(ok(other, 'get_index_status', {}).ready, false)
  assert.equal(ok(other, 'get_index_status', {}).docs, 0)
})

await test('切库：新库的文档替换旧库，旧库反链消失', async () => {
  const otherRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'nl-kb2-'))
  fs.writeFileSync(path.join(otherRoot, 'solo.md'), '# Solo\n\n指向 [[missing]]。\n', 'utf8')
  const c = ctx()
  ok(c, 'rebuild_index', { vaultRoot: root })
  await ready(c)
  ok(c, 'rebuild_index', { vaultRoot: otherRoot })
  const st2 = await ready(c)
  assert.equal(st2.docs, 1)
  assert.ok(st2.vaultRoot.toLowerCase().includes(path.basename(otherRoot).toLowerCase()), st2.vaultRoot)
  assert.deepEqual(ok(c, 'query_backlinks', { path: 'beta.md' }), [])
  assert.deepEqual(ok(c, 'get_doc_info', { path: 'solo.md' }).unresolved, ['missing'])
  fs.rmSync(otherRoot, { recursive: true, force: true })
})

await test('无效库根：rebuild 回本地化错误而不是堆栈', () => {
  const c = ctx()
  const e = errOf(c, 'rebuild_index', { vaultRoot: path.join(root, 'no-such-dir') })
  assert.ok(String(e).length > 0 && !e.includes('at '), e)
})

resetStore()
fs.rmSync(root, { recursive: true, force: true })

console.log('结果：' + pass + ' passed, ' + fail + ' failed')
if (fail) process.exit(1)
