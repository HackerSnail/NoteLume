// split-source.test.mjs —— 分栏复制哪一篇：活动标签优先于窗格 ctx
// 运行：cd src && node tests/split-source.test.mjs

import assert from 'node:assert'
import { splitSourceTab } from '../split-source.js'

const isCanvas = (rel) => /\.canvas$/i.test(rel || '')

// 活动标签与 ctx 不一致时以标签为准：标题栏名字和正文才对得上
{
  const active = { root: '/vault', rel: '前端设计.md', scratch: false }
  const ctx = { vaultRoot: '/tmp/NoteLume/scratch', rel: '未命名-20261118.md', scratch: true }
  assert.deepStrictEqual(splitSourceTab(active, ctx, isCanvas), {
    root: '/vault', rel: '前端设计.md', scratch: false, preview: false,
  })
  console.log('ok 活动标签优先')
}

// 没有活动标签才退回 ctx（空窗格 / 标签条刚清空）
{
  const ctx = { vaultRoot: '/vault', rel: 'a/b.md', scratch: false }
  assert.deepStrictEqual(splitSourceTab(null, ctx, isCanvas), {
    root: '/vault', rel: 'a/b.md', scratch: false, preview: false,
  })
  console.log('ok 退回 ctx')
}

// 空态与画布不复制
{
  assert.strictEqual(splitSourceTab(null, { vaultRoot: '/vault', rel: null }, isCanvas), null)
  assert.strictEqual(splitSourceTab({ root: '/vault', rel: 'board.canvas' }, null, isCanvas), null)
  console.log('ok 空态与画布不复制')
}

// 临时文件的 scratch 标记要带上，新窗格关页时才会问「选位置」
{
  const out = splitSourceTab({ root: '/tmp/NoteLume/scratch', rel: '未命名.md', scratch: true }, null, isCanvas)
  assert.strictEqual(out.scratch, true)
  console.log('ok 临时标记保留')
}
