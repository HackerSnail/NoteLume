// tabs.test.mjs —— 标签页组件的 jsdom 冒烟（显隐层级 / 去重 / 脏标记 / 邻居）
// 运行：cd src && node tests/tabs.test.mjs
//
// 显隐那条是回归：分栏把挂载点从 #tabbar 改成内层 #tabs 后，render() 若只切挂载点
// 的 hidden，外层 tabbar 的 hidden 没人摘，整条标签页（含拆分按钮）一直不显示。

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

function fresh() {
  switched.length = 0
  closed.length = 0
  const tabs = createTabs({
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
  tabs.open({ root: 'C:/vault', rel: 'a.md' })
  assert.equal(tabbar().classList.contains('hidden'), false)
  assert.equal(tabsEl().querySelectorAll('.tab').length, 1)
  assert.equal(tabsEl().querySelector('.tab-name').textContent, 'a.md')
})

t('同一路径只开一个标签，重复打开改为激活', () => {
  const tabs = fresh()
  tabs.open({ root: 'C:/vault', rel: 'a.md' })
  tabs.open({ root: 'C:/vault', rel: 'a.md' })
  assert.equal(tabs.list().length, 1)
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
  const id = tabs.open({ root: 'C:/tmp', rel: '未命名.md', scratch: true })
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
  assert.equal(tabs.neighborOf(a).rel, 'b.md')
  tabs.remove(tabs.active().id) // 移除活动的 c
  assert.equal(tabs.active(), null)
  assert.equal(tabs.list().length, 2)
})

t('关到只剩零个标签：外层 tabbar 重新盖上 hidden', () => {
  const tabs = fresh()
  const id = tabs.open({ root: 'C:/vault', rel: 'a.md' })
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

console.log('结果：' + pass + ' passed, ' + fail + ' failed')
if (fail) process.exit(1)
