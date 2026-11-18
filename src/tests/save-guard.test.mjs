// save-guard.test.mjs —— 保存期间继续编辑的回归（jsdom，无布局）
// 运行：cd src && node tests/save-guard.test.mjs
//
// 锁四件事：编辑/frontmatter 改动推进版本、markSaved 拿旧版本不清脏、
// 换文档把版本归零、同一文件的保存排队且拒绝版本/身份不匹配的快照。

import assert from 'node:assert'
import { register } from 'node:module'
import { JSDOM } from 'jsdom'

register('./css-stub-loader.mjs', import.meta.url)

const dom = new JSDOM(`<!doctype html><html><body><div id="mount"></div></body></html>`)
globalThis.window = dom.window
globalThis.document = dom.window.document
globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window)
globalThis.requestAnimationFrame = (cb) => cb()
if (!dom.window.ResizeObserver) {
  dom.window.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
}
globalThis.ResizeObserver = dom.window.ResizeObserver

const { createEditor } = await import('../editor-view.js')
const { withSaveLock, saveSnapshot, saveVersionStillCurrent } = await import('../save-guard.js')

const dirties = []
const inst = createEditor({
  mountEl: document.getElementById('mount'),
  getVault: () => ({ vaultRoot: '/tmp/vault', mdRel: 'a.md' }),
  onDirty: (d) => dirties.push(d),
  getFeatures: () => ({}),
})

inst.setMarkdown('# 标题\n\n正文内容')
assert.strictEqual(inst.getVersion(), 0, '新装文档版本从 0 起')

// 1. 编辑推进版本；旧的保存快照不能清脏
{
  inst.view.dispatch(inst.view.state.tr.insertText('X', 2))
  const v = inst.getVersion()
  assert.ok(v > 0, `编辑应推进版本，实际 ${v}`)
  assert.strictEqual(dirties[dirties.length - 1], true, '编辑应判脏')
  assert.strictEqual(inst.markSaved(0), false, '旧版本写盘回来不能清掉新编辑的脏标记')
  assert.strictEqual(dirties[dirties.length - 1], true, '脏标记必须留着')
  assert.strictEqual(inst.markSaved(v), true, '版本没变的保存才能清脏')
  assert.strictEqual(dirties[dirties.length - 1], false)
  console.log('ok 编辑推进版本，markSaved 拒绝旧快照')
}

// 2. frontmatter 写回同样推进版本
{
  const before = inst.getVersion()
  inst.setFrontmatter('title: 改过')
  const after = inst.getVersion()
  assert.strictEqual(after, before + 1, '属性面板写回应推进版本')
  assert.strictEqual(inst.markSaved(before), false)
  assert.strictEqual(inst.markSaved(after), true)
  console.log('ok frontmatter 写回推进版本')
}

// 3. 换文档版本归零，旧文档的版本号不会撞上新文档
{
  const old = inst.getVersion()
  inst.setMarkdown('## 另一篇')
  assert.strictEqual(inst.getVersion(), 0)
  assert.strictEqual(inst.markSaved(old), false, '旧文档的版本号不能清掉新文档的脏标记')
  console.log('ok 换文档版本归零')
}

// 4. 身份 + 版本比对：root / rel / version 三者全等才算仍是最新的
{
  const snap = saveSnapshot('/vault', 'sub/a.md', 7)
  assert.ok(saveVersionStillCurrent(snap, saveSnapshot('/vault', 'sub/a.md', 7)))
  assert.ok(!saveVersionStillCurrent(snap, saveSnapshot('/vault', 'sub/a.md', 8)), '版本变了不算')
  assert.ok(!saveVersionStillCurrent(snap, saveSnapshot('/vault', 'b.md', 7)), '换文档不算')
  assert.ok(!saveVersionStillCurrent(snap, saveSnapshot('/other', 'sub/a.md', 7)), '换库不算')
  console.log('ok 保存快照的身份与版本比对')
}

// 5. 同一把锁的保存串行；某条抛错不堵住队列
{
  const events = []
  const p1 = withSaveLock('a.md', async () => {
    events.push('start1')
    await new Promise((r) => setTimeout(r, 10))
    events.push('end1')
  })
  const p2 = withSaveLock('a.md', async () => { events.push('start2') })
  await Promise.all([p1, p2])
  assert.deepStrictEqual(events, ['start1', 'end1', 'start2'], '第二条保存要等第一条写完')

  await assert.rejects(withSaveLock('b.md', async () => { throw new Error('写盘失败') }))
  assert.strictEqual(await withSaveLock('b.md', async () => 'ok'), 'ok', '失败的任务不能卡住后续保存')
  console.log('ok 同文件保存串行且失败不堵塞')
}
