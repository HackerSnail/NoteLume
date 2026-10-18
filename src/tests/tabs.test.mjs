// tabs.test.mjs —— 标签页组件的 jsdom 冒烟（显隐层级 / 去重 / 脏标记 / 邻居 / 预览模式）
// 运行：cd src && node tests/tabs.test.mjs
//
// 两条历史回归：
//   1. 显隐层级：挂载点从 #tabbar 改成内层滚动区后，render() 若只切挂载点的 hidden，
//      外层容器的 hidden 没人摘，整条标签页不显示。
//   2. 预览模式：每窗格最多一个预览标签、被下一个预览替换、双击固定。

import assert from 'node:assert'
import { JSDOM } from 'jsdom'

const dom = new JSDOM(
  '<!doctype html><html><body>' +
  // 与 index.html 的分栏后结构一致：tabbar > tabs-scroll + tabs-split
  '<div id="tabbar" class="tabbar hidden">' +
  '<div id="tabs" class="tabs-scroll"></div>' +
  '<div id="tabs-split" class="tabs-split"></div>' +
  '</div></body></html>'
)
globalThis.window = dom.window
globalThis.document = dom.window.document

const { createTabs } = await import('../tabs.js')

let pass = 0
let fail = 0
function t(name, fn) {
  try {
    fn()
    pass++
    console.log('  ok   ' + name)
  } catch (e) {
    fail++
    console.log('  FAIL ' + name + ' —— ' + ((e && e.message) || e))
  }
}

const tabbar = () => document.getElementById('tabbar')
const tabsEl = () => document.getElementById('tabs')
const switched = []
const closed = []

/** 每个用例一套新实例（挂同一个滚动区，paneId 不同以隔离 id 空间） */
let paneSeq = 0
function fresh() {
  switched.length = 0
  closed.length = 0
  paneSeq++
  const tabs = createTabs({
    paneId: 'p' + paneSeq,
    mountEl: tabsEl(),
    onSwitch: (id) => switched.push(id),
    onClose: (id) => closed.push(id),
  })
  return tabs
}

t('无标签：外层 tabbar 带 hidden（整条不占位）', () => {
  const tabs = fresh()
  assert.equal(tabbar().classList.contains('hidden'), true)
  assert.equal(tabsEl().querySelectorAll('.tab').length, 0)
})

t('开一个标签：hidden 从外层 tabbar 上摘掉，标签画在滚动区', () => {
  const tabs = fresh()
  const { id } = tabs.open({ root: 'C:/vault', rel: 'a.md' })
  assert.equal(tabbar().classList.contains('hidden'), false)
  assert.equal(tabsEl().querySelectorAll('.tab').length, 1)
  assert.equal(tabsEl().querySelector('.tab-name').textContent, 'a.md')
  assert.ok(id)
})

t('同一路径只开一个标签，重复打开改为激活', () => {
  const tabs = fresh()
  const first = tabs.open({ root: 'C:/vault', rel: 'a.md' })
  const again = tabs.open({ root: 'C:/vault', rel: 'a.md' })
  assert.equal(tabs.list().length, 1)
  assert.equal(again.existed, true)
  assert.equal(again.id, first.id)
  assert.equal(tabs.active().rel, 'a.md')
})

t('脏标记按标签 id 记：只点亮该标签，不影响别的', () => {
  const tabs = fresh()
  tabs.open({ root: 'C:/vault', rel: 'a.md' })
  tabs.open({ root: 'C:/vault', rel: 'b.md' })
  tabs.setDirty(tabs.list()[0].id, true)
  assert.equal(tabs.isDirty(tabs.list()[0].id), true)
  assert.equal(tabs.isDirty(tabs.list()[1].id), false)
  assert.equal(tabsEl().querySelectorAll('.tab.dirty').length, 1)
})

t('update 改 id 后脏标记跟着搬（另存为场景）', () => {
  const tabs = fresh()
  const { id } = tabs.open({ root: 'C:/tmp', rel: '未命名.md', scratch: true })
  tabs.setDirty(id, true)
  const newId = tabs.update(id, { root: 'C:/vault', rel: '正式.md', scratch: false })
  assert.notEqual(newId, id)
  assert.equal(tabs.isDirty(newId), true)
  assert.equal(tabs.isDirty(id), false)
})

t('neighborOf 先右后左；remove 活动页后 active 清空', () => {
  const tabs = fresh()
  const a = tabs.open({ root: 'C:/vault', rel: 'a.md' })
  tabs.open({ root: 'C:/vault', rel: 'b.md' })
  tabs.open({ root: 'C:/vault', rel: 'c.md' })
  assert.equal(tabs.neighborOf(a.id).rel, 'b.md')
  tabs.remove(tabs.active().id) // 移除活动的 c
  assert.equal(tabs.active(), null)
  assert.equal(tabs.list().length, 2)
})

t('关到只剩零个标签：外层 tabbar 重新盖上 hidden', () => {
  const tabs = fresh()
  const { id } = tabs.open({ root: 'C:/vault', rel: 'a.md' })
  tabs.remove(id)
  assert.equal(tabbar().classList.contains('hidden'), true)
})

t('点标签 / 点 × 触发对应回调', () => {
  const tabs = fresh()
  tabs.open({ root: 'C:/vault', rel: 'a.md' })
  tabs.open({ root: 'C:/vault', rel: 'b.md' })
  const els = tabsEl().querySelectorAll('.tab')
  els[0].dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  assert.deepEqual(switched.length, 1)
  els[1].querySelector('.tab-x').dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
  assert.deepEqual(closed.length, 1)
})

// —— 预览模式（P1 新增语义）——

t('id 含 paneId：同一文档在两个窗格是两个标签', () => {
  const left = fresh()
  const right = fresh()
  const a = left.open({ root: 'C:/vault', rel: 'a.md' })
  const b = right.open({ root: 'C:/vault', rel: 'a.md' })
  assert.notEqual(a.id, b.id)
  assert.equal(left.list().length, 1)
  assert.equal(right.list().length, 1)
})

t('openPreview：无旧预览直接入列，带 preview 类名与斜体样式挂钩', () => {
  const tabs = fresh()
  const { id, replaced } = tabs.openPreview({ root: 'C:/vault', rel: 'a.md' })
  assert.equal(replaced, null)
  assert.equal(tabs.list().length, 1)
  assert.equal(tabs.list()[0].preview, true)
  assert.equal(tabs.previewId(), id)
  assert.equal(tabsEl().querySelector('.tab').classList.contains('preview'), true)
})

t('openPreview：已有预览先被替换，返回被换掉的旧 id', () => {
  const tabs = fresh()
  const first = tabs.openPreview({ root: 'C:/vault', rel: 'a.md' })
  const second = tabs.openPreview({ root: 'C:/vault', rel: 'b.md' })
  assert.equal(second.replaced, first.id)
  assert.equal(second.existed, false)
  assert.equal(tabs.list().length, 1)
  assert.equal(tabs.active().rel, 'b.md')
})

t('openPreview 对固定标签只激活，不替换不加项', () => {
  const tabs = fresh()
  const pinned = tabs.open({ root: 'C:/vault', rel: 'a.md' })
  const r = tabs.openPreview({ root: 'C:/vault', rel: 'a.md' })
  assert.equal(r.existed, true)
  assert.equal(r.id, pinned.id)
  assert.equal(r.replaced, null)
  assert.equal(tabs.list().length, 1)
  assert.equal(tabs.list()[0].preview, false)
})

t('每窗格最多一个预览：连续 openPreview 只留最后一个', () => {
  const tabs = fresh()
  tabs.openPreview({ root: 'C:/vault', rel: 'a.md' })
  tabs.open({ root: 'C:/vault', rel: 'b.md' }) // 固定
  tabs.openPreview({ root: 'C:/vault', rel: 'c.md' }) // 只替换 a，不动固定 b
  const previews = tabs.list().filter((x) => x.preview)
  assert.equal(previews.length, 1)
  assert.equal(previews[0].rel, 'c.md')
  assert.equal(tabs.list().length, 2)
})

t('pin：清预览标记，dblclick 预览标签转正', () => {
  const tabs = fresh()
  const { id } = tabs.openPreview({ root: 'C:/vault', rel: 'a.md' })
  assert.equal(tabs.pin(id), true)
  assert.equal(tabs.previewId(), null)
  assert.equal(tabsEl().querySelector('.tab').classList.contains('preview'), false)
  // dblclick 路径：再开一个预览，双击它（此时列表是 [a固定, b预览]，点第二个）
  tabs.openPreview({ root: 'C:/vault', rel: 'b.md' })
  const tabEls = tabsEl().querySelectorAll('.tab')
  assert.equal(tabEls.length, 2)
  tabEls[1].dispatchEvent(new window.MouseEvent('dblclick', { bubbles: true }))
  assert.equal(tabs.previewId(), null)
  assert.equal(tabs.list()[1].preview, false)
})

t('pin 对固定标签无事发生', () => {
  const tabs = fresh()
  const { id } = tabs.open({ root: 'C:/vault', rel: 'a.md' })
  assert.equal(tabs.pin(id), false)
  assert.equal(tabs.list()[0].preview, false)
})

t('serialize/restore 往返：预览不落盘、active 夹紧、空列记 -1', () => {
  const src = fresh()
  src.openPreview({ root: 'C:/vault', rel: 'a.md' }) // 预览
  src.open({ root: 'C:/vault', rel: 'b.md' }) // 固定
  src.open({ root: 'C:/vault', rel: 'c.md' })
  src.setDirty(src.active().id, true)
  const data = src.serialize()
  assert.equal(data.items.length, 3)
  assert.ok(data.items.every((x) => !('preview' in x)))
  assert.equal(data.active, 2)

  const dst = fresh()
  dst.restore(data)
  assert.equal(dst.list().length, 3)
  assert.ok(dst.list().every((x) => !x.preview)) // 预览不恢复
  assert.ok(dst.list().every((x) => !dst.isDirty(x.id))) // 脏标记不恢复
  assert.equal(dst.active().rel, 'c.md')

  // active 越界 / 空列
  dst.restore({ items: data.items, active: 99 })
  assert.equal(dst.active().rel, 'a.md') // 夹到第一项
  dst.restore({ items: [], active: 3 })
  assert.equal(dst.active(), null)
  assert.equal(dst.serialize().active, -1)
})

console.log('结果：' + pass + ' passed, ' + fail + ' failed')
if (fail) process.exit(1)
