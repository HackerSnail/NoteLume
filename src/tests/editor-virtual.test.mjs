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

// 5. Phase 3：查找钩子——全篇命中（master 坐标）、窗外 toWin null、替换经 master 事务
{
  inst.setMarkdown('# 新文档\n\n普通内容\n')
  // 重新进入虚拟（90 块 > windowSize 60，保证有窗口外块）
  inst.enterVirtualJson(makeJson(90), makeMd(90))
  const hooksFactory = inst.getFindHooks()
  const h = hooksFactory()
  assert.ok(h, '虚拟模式应给查找钩子')
  const { findMatches, buildReplaceTr } = await import('../find-in-doc.js')
  const matches = findMatches(h.getDoc(), '内容')
  assert.ok(matches.length >= 25, `全篇命中应覆盖窗口外（${matches.length}）`)
  assert.ok(h.toWin(matches[0].from) != null, '首个命中应在窗口内')
  const last = matches[matches.length - 1]
  assert.strictEqual(h.toWin(last.from), null, '窗口外命中 toWin 应为 null')
  // 替换全部命中走 master 事务：一步进历史、窗口同步
  const tr = buildReplaceTr(h.getMasterState(), matches, 'X')
  h.applyMasterTr(tr)
  const md = inst.getMarkdown()
  assert.ok(!md.includes('内容'), '全篇替换后 master 不应再有原词')
  assert.ok(md.includes('X'), '替换文本应进 master')
  assert.ok(!inst.view.dom.textContent.includes('内容'), '窗口 DOM 应同步替换')
  assert.ok(inst.runEditorCommand('editor.undo') === true, '替换应进 master 历史')
  assert.ok(inst.getMarkdown().includes('内容'), 'undo 后应还原')
  console.log('ok 查找/替换走 master')
}

// 6. Phase 3：折叠跨窗口——集合存 master 坐标，跳转前展开
{
  const { toggleFold, foldKey } = await import('../fold-plugin.js')
  const { buildBlockIndex } = await import('../virtual/blocks.js')
  // 折叠首标题「大标题」（窗口 pos 1：top spacer 占 [0,1)）：正文块藏进装饰
  assert.ok(toggleFold(inst.view.state, inst.view.dispatch, 1), '首标题应可折')
  const folded = foldKey.getState(inst.view.state)
  assert.strictEqual(folded.length, 1, '折叠集合应有一条')
  assert.strictEqual(folded[0], 0, '应存 master 坐标（标题是 master 首块，pos 0）')
  assert.ok(inst.view.dom.querySelector('.nl-fold-hidden'), '折叠装饰应生效')
  // 跳到被折叠节内的正文（master 坐标）：先展开再落位，光标可见
  const blocks = buildBlockIndex(inst.getFindHooks()().getDoc())
  const bodyPos = blocks[1].offset
  inst.jumpToPos(bodyPos)
  assert.ok(!inst.view.dom.querySelector('.nl-fold-hidden'), '跳转应展开覆盖折叠')
  // 收起还原（展开后折叠集合应清空该节）
  toggleFold(inst.view.state, inst.view.dispatch, 1)
  console.log('ok 折叠跨窗口（master 坐标）')
}

console.log('editor-virtual: all ok')
