// empty-editor.test.mjs —— 空窗格不可编辑回归（jsdom，无布局）
// 运行：cd src && node tests/empty-editor.test.mjs
//
// 锁两件事：没有文档时 setEditable(false) 真的把 ProseMirror 关成只读、命令也进不去；
// 打开 / 新建文档后 setEditable(true) 恢复。空态提示五语言都写明了要先新建或打开。

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
const { MESSAGES } = await import('../locales/index.js')

const inst = createEditor({
  mountEl: document.getElementById('mount'),
  getVault: () => ({ vaultRoot: '/tmp/vault', mdRel: 'a.md' }),
  getFeatures: () => ({}),
})
inst.setMarkdown('# 一篇文档\n\n正文')

// 1. 空态关编辑： editable 与 contenteditable 都关掉，主动执行的编辑命令不生效
{
  inst.setEditable(false)
  assert.strictEqual(inst.view.editable, false, '空态下 ProseMirror 应不可编辑')
  assert.strictEqual(inst.view.dom.getAttribute('contenteditable'), 'false')
  assert.strictEqual(inst.runEditorCommand('editor.bold'), false, '不可编辑时命令应早退')
  assert.ok(!inst.getMarkdown().includes('**'), '命令不能改动文档')
  console.log('ok 空态关编辑')
}

// 2. 打开 / 新建文档后恢复编辑
{
  inst.setEditable(true)
  assert.strictEqual(inst.view.editable, true)
  assert.strictEqual(inst.view.dom.getAttribute('contenteditable'), 'true')
  assert.ok(inst.runEditorCommand('editor.bold'), '恢复后命令应生效')
  console.log('ok 装载文档恢复编辑')
}

// 3. 空态提示写得清：不是只说「点文件」，明说要先新建或打开
{
  const expects = {
    'zh-CN': '新建',
    'zh-Hant': '新增',
    'en-US': 'create',
    'fr-FR': 'créez',
    'de-DE': 'erstellen',
  }
  for (const [id, word] of Object.entries(expects)) {
    const hint = MESSAGES[id] && MESSAGES[id]['pn.emptyHint']
    assert.ok(hint, `${id} 缺 pn.emptyHint`)
    assert.ok(hint.includes(word), `${id} 的空态提示没说要先新建：${hint}`)
  }
  console.log('ok 空态提示五语言')
}
