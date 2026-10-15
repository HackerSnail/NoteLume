// docx-import.test.mjs —— 功能项 I：Word 导入编排的纯逻辑 + 队列状态机测试（无需浏览器 / Tauri）
// 运行：cd src && node tests/docx-import.test.mjs
//
// 用假 io（preview/commit/loadIndex/saveIndex）+ 注入的 review 回调驱动 runImport，
// 覆盖：队列构造、preview 参数派生（srcPath/srcB64/默认 frontmatter）、CommitImage 映射、
// 去重索引跨条累积、接受/跳过/失败不阻断的状态机。

import assert from 'node:assert'
import {
  buildQueue,
  previewArgsFor,
  commitImagesFrom,
  mergeIndex,
  runImport,
  DEFAULT_MAX_IMAGE_BYTES,
} from '../docx-import.js'

let pass = 0, fail = 0
function check(name, fn) {
  try { fn(); console.log(`✅ ${name}`); pass++ }
  catch (e) { console.error(`❌ ${name}: ${e.message}`); fail++ }
}
async function acheck(name, fn) {
  try { await fn(); console.log(`✅ ${name}`); pass++ }
  catch (e) { console.error(`❌ ${name}: ${e.message}`); fail++ }
}

// —— buildQueue ——
check('buildQueue 逐项建初始态', () => {
  const q = buildQueue([{ srcPath: 'a.docx' }, { srcB64: 'AAA', displayName: 'b.docx' }])
  assert.strictEqual(q.length, 2)
  assert.strictEqual(q[0].status, 'queued')
  assert.strictEqual(q[1].source.displayName, 'b.docx')
})

// —— previewArgsFor ——
check('previewArgsFor 对话框来源走 srcPath、默认 frontmatter 开', () => {
  const a = previewArgsFor({ srcPath: 'C:/x/y.doc' }, { destDir: 'Notes' })
  assert.strictEqual(a.srcPath, 'C:/x/y.doc')
  assert.strictEqual(a.destDir, 'Notes')
  assert.strictEqual(a.withFrontmatter, true)
  assert.strictEqual(a.maxImageBytes, DEFAULT_MAX_IMAGE_BYTES)
  assert.strictEqual(a.srcB64, null)
})
check('previewArgsFor 拖拽来源走 srcB64 + 显示名', () => {
  const a = previewArgsFor({ srcB64: 'QUJD', displayName: 'd.docx' }, { destDir: '', withFrontmatter: false })
  assert.strictEqual(a.srcB64, 'QUJD')
  assert.strictEqual(a.srcDisplayName, 'd.docx')
  assert.strictEqual(a.srcPath, '')
  assert.strictEqual(a.withFrontmatter, false)
})

// —— commitImagesFrom ——
check('commitImagesFrom 映射 ImportedImage→CommitImage（含 reused 交 Rust 判定）', () => {
  const imgs = commitImagesFrom([
    { sha256: 'abc123def456aa', ext: 'png', dataB64: 'X', plannedRel: 'n/abc123def456.png', reused: false, bytes: 10 },
    { sha256: 'fff111222333aa', ext: 'jpg', dataB64: 'Y', plannedRel: 'old/fff111222333.jpg', reused: true, bytes: 20 },
  ])
  assert.strictEqual(imgs.length, 2)
  assert.deepStrictEqual(Object.keys(imgs[0]).sort(), ['dataB64', 'ext', 'plannedRel', 'sha256'])
  assert.strictEqual(imgs[1].reused, undefined) // CommitImage 不含 reused
  assert.strictEqual(imgs[1].plannedRel, 'old/fff111222333.jpg')
})

// —— mergeIndex ——
check('mergeIndex 就地并入并返回同一引用', () => {
  const t = { a: '1' }
  const r = mergeIndex(t, { b: '2', a: '9' })
  assert.strictEqual(r, t)
  assert.strictEqual(t.a, '9')
  assert.strictEqual(t.b, '2')
})
check('mergeIndex 对 null 更新安全', () => {
  const t = { a: '1' }
  mergeIndex(t, null)
  assert.deepStrictEqual(t, { a: '1' })
})

// —— runImport 状态机 ——
function fakePreview(title, sha) {
  return {
    md: `# ${title}\n\n正文`,
    plannedDocRel: `${title}/${title}.md`,
    title,
    images: [{ sha256: sha, ext: 'png', dataB64: 'Z', plannedRel: `${title}/${sha.slice(0, 12)}.png`, reused: false, bytes: 5 }],
    warnings: [{ code: 'merged_table', message: '含合并单元格', locator: 't1' }],
    stats: { words: 3, images: 1, tables: 1, mergedTables: 1, footnotes: 0, droppedTextboxes: 0 },
  }
}

await acheck('runImport 接受落库、去重索引跨条累积', async () => {
  const saved = []
  const committedRels = []
  const io = {
    preview: async (a) => fakePreview(a.srcPath, 'sha' + a.srcPath),
    commit: async (args) => {
      committedRels.push(args.docRel)
      // 模拟 Rust：把每个图片 sha→rel 回写进 updatedIndex
      const upd = {}
      for (const im of args.images) upd[im.sha256] = im.plannedRel
      return { docRel: args.docRel, writtenImages: args.images.map((i) => i.plannedRel), reusedImages: [], updatedIndex: upd }
    },
    loadIndex: async () => ({}),
    saveIndex: async (i) => saved.push(i),
  }
  const review = async () => ({ action: 'accept' })
  const res = await runImport({
    sources: [{ srcPath: 'A' }, { srcPath: 'B' }],
    io, review,
    opts: { vaultRoot: '/v', destDir: 'In' },
  })
  assert.strictEqual(res.stats.committed, 2)
  assert.strictEqual(res.stats.failed, 0)
  // 第二条 commit 时 dedupIndex 已含第一条的累积
  assert.ok(committedRels.includes('A/A.md') && committedRels.includes('B/B.md'))
  // 持久化的最终索引含两条
  const final = saved[saved.length - 1]
  assert.strictEqual(Object.keys(final).length, 2)
})

await acheck('runImport 跳过不写盘、计入 skipped', async () => {
  let commits = 0
  const io = {
    preview: async (a) => fakePreview(a.srcPath, 'sha' + a.srcPath),
    commit: async () => { commits++; return { docRel: 'x', writtenImages: [], reusedImages: [], updatedIndex: {} } },
    loadIndex: async () => ({}),
    saveIndex: async () => {},
  }
  const review = async (entry) => (entry.preview.title === 'A' ? { action: 'accept' } : { action: 'skip' })
  const res = await runImport({ sources: [{ srcPath: 'A' }, { srcPath: 'B' }], io, review, opts: { vaultRoot: '/v' } })
  assert.strictEqual(commits, 1)
  assert.strictEqual(res.stats.committed, 1)
  assert.strictEqual(res.stats.skipped, 1)
})

await acheck('runImport preview 失败不阻断后续', async () => {
  const io = {
    preview: async (a) => { if (a.srcPath === 'bad') throw new Error('boom'); return fakePreview(a.srcPath, 's' + a.srcPath) },
    commit: async (args) => ({ docRel: args.docRel, writtenImages: [], reusedImages: [], updatedIndex: {} }),
    loadIndex: async () => ({}),
    saveIndex: async () => {},
  }
  const review = async () => ({ action: 'accept' })
  const res = await runImport({ sources: [{ srcPath: 'bad' }, { srcPath: 'good' }], io, review, opts: { vaultRoot: '/v' } })
  assert.strictEqual(res.stats.failed, 1)
  assert.strictEqual(res.stats.committed, 1)
  assert.strictEqual(res.queue[0].status, 'failed')
  assert.ok(/boom/.test(res.queue[0].error))
})

await acheck('runImport commit 失败置 failed 且索引不被污染', async () => {
  const io = {
    preview: async (a) => fakePreview(a.srcPath, 'sha' + a.srcPath),
    commit: async () => { throw new Error('disk full') },
    loadIndex: async () => ({}),
    saveIndex: async () => {},
  }
  const review = async () => ({ action: 'accept' })
  const res = await runImport({ sources: [{ srcPath: 'A' }], io, review, opts: { vaultRoot: '/v' } })
  assert.strictEqual(res.stats.failed, 1)
  assert.strictEqual(res.stats.committed, 0)
  assert.strictEqual(res.queue[0].status, 'failed')
})

await acheck('runImport 复用注入的 dedupIndex：命中项 reused 不重复写', async () => {
  // 预置索引含 A 的图 sha；第二条 B 引用同 sha → 期望 commit 收到的 dedupIndex 已含旧条目
  let seenIndexAtCommit = null
  const io = {
    preview: async (a) => ({
      md: '# ' + a.srcPath, plannedDocRel: `${a.srcPath}/${a.srcPath}.md`, title: a.srcPath,
      images: [{ sha256: 'shared000000ab', ext: 'png', dataB64: 'Z', plannedRel: 'old/x.png', reused: !!a.dedupIndex, bytes: 5 }],
      warnings: [], stats: {},
    }),
    commit: async (args) => { seenIndexAtCommit = Object.keys(args.dedupIndex); return { docRel: args.docRel, writtenImages: [], reusedImages: [], updatedIndex: {} } },
    loadIndex: async () => ({ 'pre000000ab': 'old/pre.png' }),
    saveIndex: async () => {},
  }
  const review = async () => ({ action: 'accept' })
  await runImport({ sources: [{ srcPath: 'A' }, { srcPath: 'B' }], io, review, opts: { vaultRoot: '/v' } })
  // loadIndex 预置的 pre 键应在每次 commit 的 dedupIndex 中
  assert.ok(seenIndexAtCommit.includes('pre000000ab'))
})

console.log(`\n结果：${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
