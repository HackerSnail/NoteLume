// empty-context-menu.test.mjs —— 空窗格右键菜单不把「粘贴」等高亮
// 运行：cd src && node tests/empty-context-menu.test.mjs
//
// 空态下编辑器不可编辑，粘贴 / 加粗 / 插入块都点不动；菜单的置灰判定
// 和编辑器只读开关走同一份纯函数，这里钉判定表与 main.js 的接线。

import assert from 'node:assert'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { JSDOM } from 'jsdom'

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const { canEditPane, isReadOnlyTarget } = await import('../edit-state.js')

// 1. 窗格能否编辑：没路径 / 编辑器只读，两种都算不能编辑
{
  assert.strictEqual(canEditPane('a.md', true), true)
  assert.strictEqual(canEditPane('a.md', false), false, '编辑器关成只读后不能再粘贴')
  assert.strictEqual(canEditPane(null, true), false, '没打开文档不能再粘贴')
  assert.strictEqual(canEditPane(null, false), false)
  console.log('ok 窗格可编辑判定')
}

// 2. 输入框 / 源码 CM 的只读判定
{
  const dom = new JSDOM('<!doctype html><html><body><div id="a" contenteditable="true"></div><div id="b" contenteditable="false"></div><input id="c" disabled><input id="d" readonly><input id="e"></body></html>')
  const q = (id) => dom.window.document.getElementById(id)
  assert.strictEqual(isReadOnlyTarget(q('a')), false)
  assert.strictEqual(isReadOnlyTarget(q('b')), true, '只读 CM 的 contenteditable=false')
  assert.strictEqual(isReadOnlyTarget(q('c')), true)
  assert.strictEqual(isReadOnlyTarget(q('d')), true)
  assert.strictEqual(isReadOnlyTarget(q('e')), false)
  assert.strictEqual(isReadOnlyTarget(null), false)
  console.log('ok 只读目标判定')
}

// 3. 菜单接线：粘贴与格式项都带 !canEdit，输入框菜单带 readOnly
{
  const mainText = fs.readFileSync(path.join(SRC, 'main.js'), 'utf8')
  assert.match(mainText, /const canEdit = canEditPane\(paneCtx\(paneId\)\.rel, inst\.view\.editable\)/)
  assert.match(mainText, /makeMenuItem\(withKey\(t\('ctx\.paste'\), modKey\('V'\)\), clip\.paste, false, false, null, !canEdit\)/)
  assert.match(mainText, /makeMenuItem\(withKey\(t\('ctx\.paste'\), modKey\('V'\)\), clip\.paste, false, false, null, readOnly\)/)
  // 键盘路径也要挡住：Ctrl+Shift+V / 插入图片不能绕开只读编辑器写进去
  assert.match(mainText, /app\.pastePlain[\s\S]{0,600}canEditPane\(state\.currentFile, editor\.view\.editable\)/)
  assert.match(mainText, /app\.insertImage[\s\S]{0,200}canEditPane\(state\.currentFile, editor\.view\.editable\)/)
  console.log('ok 两处菜单接线与键盘插入闸')
}
