// editor-virtual.test.mjs —— 编辑器实例虚拟模式回归（jsdom，无布局）
// 运行：cd src && node tests/editor-virtual.test.mjs
//
// 锁五件事：enterVirtualJson 后 view 只渲染窗口块、大纲回调拿全篇 master 标题、
// 窗口编辑回灌并判脏、getMarkdown/undo 走 master、setMarkdown 退回常规模式。
// createEditor 用最小 opts（装饰插件读窗口 doc 天然窗口化，不在本测试范围）。

import assert from 'node:assert'
import { register } from 'node:module'
import { JSDOM } from 'jsdom'

register('./css-stub-loader.mjs', import.meta.url)

const dom = new JSDOM(`<!doctype html><html><body><div id="mount"></div></body></html>`)
globalThis.window = dom.window
globalThis.document = dom.window.document
globalThis.getComputedStyle = dom.window.getComputedStyle.bind(dom.window)
globalThis.requestAnimationFrame = (cb) => cb()
// 装订线插件构造要 ResizeObserver；jsdom 没有布局，桩成永不回调
if (!dom.window.ResizeObserver) {
  dom.window.ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
}
globalThis.ResizeObserver = dom.window.ResizeObserver

const { createEditor } = await import('../editor-view.js')
const { parseMarkdown } = await import('../editor-schema.js')

function makeMd(n) {
  const paras = Array.from({ length: n }, (_, i) => `段落${i}内容`)
  paras[Math.floor(n / 2)] = '## 中段标题\n\n中段正文'
  return '# 大标题\n\n' + paras.join('\n\n') + '\n'
}

function makeJson(n) {
  return JSON.parse(JSON.stringify(parseMarkdown(makeMd(n)).toJSON()))
}

const mount = document.getElementById('mount')
const metas = []
const dirties = []
const inst = createEditor({
  mountEl: mount,
  getVault: () => ({ vaultRoot: '/tmp/vault', mdRel: 'a.md' }),
  onDirty: (d) => dirties.push(d),
  onMetaChange: (m) => metas.push(m),
  getFeatures: () => ({}),
})

// 1. enterVirtualJson：窗口化渲染 + master 元数据
{
  inst.enterVirtualJson(makeJson(30), makeMd(30))
  assert.ok(inst.isVirtual(), '应处于虚拟模式')
  const kids = inst.view.dom.children
  assert.strictEqual(kids[0].className, 'nl-spacer', '首元素应是 top spacer')
  assert.strictEqual(kids[kids.length - 1].className, 'nl-spacer', '末元素应是 bottom spacer')
  assert.strictEqual(kids[1].textContent, '大标题', '窗口首块应为标题')
  const last = metas[metas.length - 1]
  assert.ok(last.outline.length >= 1, '大纲应含全篇标题（master）')
  assert.strictEqual(last.outline[0].text, '大标题')
  console.log('ok enterVirtualJson 渲染与元数据')
}

// 2. 窗口编辑：回灌 master + 判脏
{
  const tr = inst.view.state.tr.insertText('X', 4) // 标题「大标|题」之间
  inst.view.dispatch(tr)
  const md = inst.getMarkdown()
  assert.ok(md.includes('大标X题'), `master 序列化应含插入，实际开头：${md.slice(0, 40)}`)
  assert.ok(dirties.includes(true), '编辑应判脏')
  assert.ok(inst.view.dom.textContent.includes('大标X题'), '窗口 DOM 应同步')
  console.log('ok 窗口编辑回灌与判脏')
}

// 3. undo 走 master 历史
{
  assert.ok(inst.runEditorCommand('editor.undo') === true, '虚拟模式 undo 应生效（master 历史）')
  assert.ok(!inst.getMarkdown().includes('大标X题'), 'undo 后 master 应还原')
  assert.ok(inst.runEditorCommand('editor.redo') === true)
  assert.ok(inst.getMarkdown().includes('大标X题'), 'redo 后 master 恢复')
  console.log('ok undo/redo 走 master')
}

// 4. jumpToPos：master 坐标跳转（大纲点击路径）
{
  const meta = metas[metas.length - 1]
  const far = meta.outline[meta.outline.length - 1]
  assert.ok(far.pos > 0)
  inst.jumpToPos(far.pos)
  // 跳转后窗口应覆盖目标块：view.dom 里能找到目标标题前后的内容
  assert.ok(inst.view.state.selection.from > 0)
  assert.ok(inst.view.dom.children.length >= 3)
  console.log('ok jumpToPos master 坐标')
}

// 5. setMarkdown 退回常规模式
{
  inst.setMarkdown('# 新文档\n\n普通内容\n')
  assert.ok(!inst.isVirtual(), '应退出虚拟模式')
  const kids = inst.view.dom.children
  assert.strictEqual(kids[0].className, '', '常规模式无 spacer')
  assert.ok(!inst.view.dom.querySelector('.nl-spacer'), '常规模式不应有 spacer')
  const md = inst.getMarkdown()
  assert.ok(md.includes('新文档') && md.includes('普通内容'))
  console.log('ok 退出虚拟模式')
}

console.log('editor-virtual: all ok')
