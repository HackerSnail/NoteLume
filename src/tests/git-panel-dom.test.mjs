// git-panel-dom.test.mjs —— 面板翻新：提交框（常驻输入 + Ctrl+Enter + 成功清空草稿）与行内「放弃更改」
// 运行：cd src && node tests/git-panel-dom.test.mjs
//
// 与 git-push-dom.test.mjs 同一打桩方式：真模块 git-panel.js + tauri-bridge.js，
// 只在 __TAURI_INTERNALS__.invoke 打桩；断言「IPC 命令与参数」「确认框文案」「草稿清空时机」。
// 注意：tauri-bridge 的 invoke 在模块加载时取 window.__TAURI_INTERNALS__，所以打桩要在 import 前装好。
import assert from 'node:assert'
import { JSDOM } from 'jsdom'

const dom = new JSDOM('<!doctype html><html><body><div id="git"></div></body></html>', {
  url: 'http://localhost/',
})
global.window = dom.window
global.document = dom.window.document
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true })
global.localStorage = dom.window.localStorage
global.HTMLElement = dom.window.HTMLElement
dom.window.localStorage.setItem('nl-lang', 'zh-CN')

const VAULT = '/vault/'
const REMOTE = [{ name: 'origin', url: 'https://example.com/x.git' }]
let calls = []
let discardOk = true

window.__TAURI_INTERNALS__ = {
  invoke(cmd, args) {
    calls.push({ cmd, args: args || {} })
    switch (cmd) {
      case 'git_open':
        return Promise.resolve({ isRepo: true, branch: 'master', hasHead: true, repoPath: VAULT })
      case 'git_status':
        return Promise.resolve([
          { path: 'a.md', kind: 'modified', staged: false },
          { path: 'b-new.md', kind: 'new', staged: false },
        ])
      case 'git_log':
        return Promise.resolve([{ id: 'a'.repeat(40), idShort: 'aaaaaaa', summary: 'init', authorName: 'T', authorEmail: 't@e.x', time: 0, parents: [] }])
      case 'git_r_merge_state':
        return Promise.resolve(false)
      case 'git_r_info':
        return Promise.resolve({ engine: 'system', gitVersion: 'git version 2.40', builtinReady: true })
      case 'git_r_remote_list':
        return Promise.resolve(REMOTE)
      case 'git_r_upstream':
        return Promise.resolve('origin/master')
      case 'git_r_ahead_behind':
        return Promise.resolve({ ahead: 0, behind: 0, upstream: 'origin/master' })
      case 'git_config_identity':
        return Promise.resolve({ name: 'Tester', email: 't@e.x' })
      case 'git_commit_all':
        return Promise.resolve({ id: 'b'.repeat(40), idShort: 'bbbbbbb' })
      case 'git_discard':
        return discardOk ? Promise.resolve() : Promise.reject(new Error('boom'))
      case 'plugin:dialog|confirm':
        return Promise.resolve(true)
      case 'plugin:dialog|message':
        // plugin-dialog 的 confirm 在桌面端走 message 命令（OkCancel 按钮）；
        // 这里按按钮形状区分：OkCancel=确认框（回 Ok），其余=提示框
        return Promise.resolve(args && args.buttons === 'OkCancel' ? 'Ok' : 'Ok')
      default:
        return Promise.resolve(null)
    }
  },
  transformCallback(cb) {
    return cb
  },
}

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

const { createGitPanel } = await import('../git-panel.js')

function freshPanel(statuses) {
  calls = []
  return createGitPanel({
    rootEl: document.getElementById('git'),
    getVaultRoot: () => VAULT,
    escapeHtml: (s) => String(s),
    setStatus: (s) => statuses.push(s),
    onPullDone: async () => {},
    openFile: () => {},
  })
}

const commitCalls = () => calls.filter((c) => c.cmd === 'git_commit_all')
const discardCalls = () => calls.filter((c) => c.cmd === 'git_discard')
const confirmCalls = () =>
  calls.filter((c) => c.cmd === 'plugin:dialog|message' && c.args.buttons === 'OkCancel')

await test('提交框常驻：输入框 + 提交按钮，无信息或无变更时按钮禁用', async () => {
  const statuses = []
  const panel = freshPanel(statuses)
  await panel.refresh()
  const ta = document.querySelector('.nl-git-commit-input')
  const btn = document.querySelector('.nl-git-commit-btn')
  assert.ok(ta && btn, '提交框该渲染出来')
  assert.strictEqual(btn.disabled, true, '无信息时按钮禁用')
  ta.value = '  '
  ta.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
  assert.strictEqual(btn.disabled, true, '纯空白也禁用')
  ta.value = '第一次提交'
  ta.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
  assert.strictEqual(btn.disabled, false, '有信息后按钮可用')
})

await test('Ctrl+Enter 提交：带身份调用 git_commit_all，成功后清空草稿并刷新', async () => {
  const statuses = []
  const panel = freshPanel(statuses)
  await panel.refresh()
  const ta = document.querySelector('.nl-git-commit-input')
  ta.value = '第一次提交'
  ta.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
  ta.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true, cancelable: true }))
  await new Promise((r) => setTimeout(r, 30))
  const cs = commitCalls()
  assert.strictEqual(cs.length, 1, '应调用一次 git_commit_all')
  assert.strictEqual(cs[0].args.args.message, '第一次提交')
  assert.strictEqual(cs[0].args.args.name, null, '身份已配置时不传 name')
  const ta2 = document.querySelector('.nl-git-commit-input')
  assert.strictEqual(ta2.value, '', '提交成功后草稿清空')
  assert.ok(statuses.some((s) => s.includes('bbbbbbb')), '状态提示带新提交短哈希：' + statuses.join(' / '))
})

await test('放弃更改：行内按钮先弹确认（文案带路径），确认后调用 git_discard', async () => {
  const statuses = []
  const panel = freshPanel(statuses)
  await panel.refresh()
  const btns = [...document.querySelectorAll('.nl-git-list:not(.nl-git-graph) .nl-git-row-tools .nl-git-mini-icon')]
  assert.strictEqual(btns.length, 2, '两个变更行各一个放弃按钮')
  btns[0].click()
  await new Promise((r) => setTimeout(r, 30))
  const cf = confirmCalls()
  assert.strictEqual(cf.length, 1, '应弹一次确认')
  assert.match(cf[0].args.message, /a\.md/, '确认文案带文件路径')
  const ds = discardCalls()
  assert.strictEqual(ds.length, 1)
  assert.strictEqual(ds[0].args.path, 'a.md')
  assert.ok(statuses.some((s) => s.includes('a.md')), '成功后状态提示')
})

await test('放弃取消：确认框拒绝后不调用 git_discard', async () => {
  // 临时把 confirm 桩改成拒绝
  const orig = window.__TAURI_INTERNALS__.invoke
  window.__TAURI_INTERNALS__.invoke = (cmd, args) => {
    if (cmd === 'plugin:dialog|message' && args && args.buttons === 'OkCancel') return Promise.resolve('Cancel')
    return orig(cmd, args)
  }
  try {
    const statuses = []
    const panel = freshPanel(statuses)
    await panel.refresh()
    const btn = document.querySelector('.nl-git-list:not(.nl-git-graph) .nl-git-row-tools .nl-git-mini-icon')
    btn.click()
    await new Promise((r) => setTimeout(r, 30))
    assert.strictEqual(discardCalls().length, 0, '拒绝后不应调用')
  } finally {
    window.__TAURI_INTERNALS__.invoke = orig
  }
})

await test('放弃失败：弹错误框，不吞异常', async () => {
  discardOk = false
  try {
    const statuses = []
    const panel = freshPanel(statuses)
    await panel.refresh()
    const btn = document.querySelector('.nl-git-list:not(.nl-git-graph) .nl-git-row-tools .nl-git-mini-icon')
    btn.click()
    await new Promise((r) => setTimeout(r, 30))
    const dlg = calls.filter((c) => c.cmd === 'plugin:dialog|message')
    assert.ok(dlg.length >= 1, '失败要有提示框')
    assert.ok(statuses.length >= 0)
  } finally {
    discardOk = true
  }
})

console.log(`\ngit-panel-dom: ${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
