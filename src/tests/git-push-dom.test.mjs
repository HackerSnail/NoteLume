// git-push-dom.test.mjs —— Git 面板「首次推送建立上游」与「无上游时的拉取引导」回归
// 运行：cd src && node tests/git-push-dom.test.mjs
//
// 走真模块：git-panel.js + tauri-bridge.js + @tauri-apps/plugin-dialog 的 confirm 实现，
// 只在 __TAURI_INTERNALS__.invoke 这一层打桩——所以「Rust 回的 [no_upstream] 前串能不能被
// 前端认出」「确认框走的是哪条 IPC 命令」「确认结果怎么判成 true」都在断言范围内。
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
const NO_UP_RAW =
  '[no_upstream]fatal: The current branch master has no upstream branch.\n' +
  'To push the current branch and set the remote as upstream, use\n\n' +
  '    git push --set-upstream origin master\n'
const PUSH_OK = 'remote: Resolving deltas: 100%\nTo /tmp/origin.git\n * [new branch]      master -> master\n'
const NO_UP_PULL =
  '[no_upstream]fatal: There is no tracking information for the current branch.\n' +
  'Please specify which branch you want to merge with.\n\n' +
  '    git branch --set-upstream-to=origin/<branch> master\n'
const NO_UP_UNCLASSIFIED = 'fatal: There is no tracking information for the current branch.'

let calls
let pushScript
let pullScript
let dialogAnswer

function installStub() {
  calls = []
  pushScript = []
  pullScript = []
  window.__TAURI_INTERNALS__ = {
    invoke(cmd, args) {
      calls.push({ cmd, args })
      if (cmd === 'git_r_push' || cmd === 'git_r_pull_ff') {
        const script = cmd === 'git_r_push' ? pushScript : pullScript
        const next = script.shift()
        if (next === undefined) throw new Error(cmd + ' 调用次数超出预期')
        if (next instanceof Error) return Promise.reject(next)
        return Promise.resolve(next)
      }
      if (cmd === 'plugin:dialog|message') return Promise.resolve(dialogAnswer)
      if (cmd === 'git_r_remote_list')
        return Promise.resolve([{ name: 'origin', url: '/tmp/origin.git' }])
      if (cmd === 'git_open')
        return Promise.resolve({ isRepo: true, branch: 'master', hasHead: true, repoPath: VAULT })
      if (cmd === 'git_status') return Promise.resolve([])
      if (cmd === 'git_log') return Promise.resolve([])
      if (cmd === 'git_config_identity') return Promise.resolve({ name: 'Tester', email: 't@e.x' })
      if (cmd === 'git_r_have') return Promise.resolve({ system: true, version: 'git version 2.39.5' })
      if (cmd === 'git_r_info') return Promise.resolve({ hasGit: true, engine: 'system' })
      if (cmd === 'git_r_upstream') return Promise.resolve(null)
      if (cmd === 'git_r_ahead_behind') return Promise.resolve({ ahead: 1, behind: 0, upstream: null })
      if (cmd === 'git_r_merge_state') return Promise.resolve(null)
      return Promise.resolve(null)
    },
    transformCallback(cb) {
      return cb
    },
  }
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

async function runPush({ answer, script }) {
  installStub()
  dialogAnswer = answer
  pushScript = script
  const statuses = []
  const rootEl = document.getElementById('git')
  const panel = createGitPanel({
    rootEl,
    getVaultRoot: () => VAULT,
    escapeHtml: (s) => String(s),
    setStatus: (s) => statuses.push(s),
    onPullDone: async () => {},
    openFile: () => {},
  })
  await panel.push()
  return { statuses, pushCalls: calls.filter((c) => c.cmd === 'git_r_push') }
}

async function runPull({ script }) {
  installStub()
  pullScript = script
  dialogAnswer = 'Cancel'
  const statuses = []
  const panel = createGitPanel({
    rootEl: document.getElementById('git'),
    getVaultRoot: () => VAULT,
    escapeHtml: (s) => String(s),
    setStatus: (s) => statuses.push(s),
    onPullDone: async () => {},
    openFile: () => {},
  })
  await panel.pull()
  return {
    statuses,
    dialogs: calls.filter((c) => c.cmd === 'plugin:dialog|message'),
  }
}

await test('撞无上游：弹一次确认，确认后带 setUpstream 重推', async () => {
  const { pushCalls } = await runPush({
    answer: 'Ok',
    script: [new Error(NO_UP_RAW), PUSH_OK],
  })
  assert.strictEqual(pushCalls.length, 2, '应推两次')
  assert.strictEqual(pushCalls[0].args.setUpstream, false, '首推不带 setUpstream')
  assert.strictEqual(pushCalls[1].args.setUpstream, true, '确认后必须带 setUpstream=true')
  assert.strictEqual(pushCalls[1].args.vaultRoot, VAULT)
})

await test('确认框文案与命令形状：走 plugin:dialog|message 且带 zh 提示', async () => {
  const { statuses } = await runPush({ answer: 'Ok', script: [new Error(NO_UP_RAW), PUSH_OK] })
  const dlg = calls.find((c) => c.cmd === 'plugin:dialog|message')
  assert.ok(dlg, '确认框必须经 plugin:dialog|message')
  assert.match(dlg.args.message, /当前分支没有上游分支。是否推送到远端并建立上游？/)
  assert.strictEqual(dlg.args.buttons, 'OkCancel')
  assert.strictEqual(dlg.args.title, '推送')
  assert.ok(statuses.includes('已推送到远端'), '成功后状态提示：' + statuses.join(' / '))
})

await test('取消：不再重推，也不报成功', async () => {
  const { pushCalls, statuses } = await runPush({
    answer: 'Cancel',
    script: [new Error(NO_UP_RAW)],
  })
  assert.strictEqual(pushCalls.length, 1, '取消后不应有第二次推送')
  assert.ok(!statuses.includes('已推送'), '取消后不能报成功')
})

await test('建上游那一下也失败：回错误分类而不是静默', async () => {
  const { pushCalls, statuses } = await runPush({
    answer: 'Ok',
    script: [new Error(NO_UP_RAW), new Error('[auth]Permission denied (publickey).')],
  })
  assert.strictEqual(pushCalls.length, 2)
  assert.ok(statuses.includes('推送失败'), statuses.join(' / '))
  const dlg = calls.filter((c) => c.cmd === 'plugin:dialog|message')
  assert.ok(dlg.length >= 2, '失败要有第二个提示框，实际 ' + dlg.length)
  assert.match(dlg[dlg.length - 1].args.message, /Permission denied/)
})

await test('已有上游时不误弹确认框', async () => {
  const { pushCalls } = await runPush({ answer: 'Ok', script: [PUSH_OK] })
  assert.strictEqual(pushCalls.length, 1)
  assert.ok(!calls.some((c) => c.cmd === 'plugin:dialog|message'), '不该弹框')
})

await test('拉取撞无上游：弹引导文案，不把 git 英文原文糊给用户', async () => {
  const { statuses, dialogs } = await runPull({ script: [new Error(NO_UP_PULL)] })
  assert.strictEqual(dialogs.length, 1, '只应弹一个提示框')
  const msg = dialogs[0].args.message
  assert.strictEqual(msg, '当前分支还没有上游。先按 Push 并确认「推送并建立上游」，再重新 Pull。')
  assert.ok(!/tracking information|set-upstream-to/.test(msg), '不能出现 git 原文：' + msg)
  assert.ok(statuses.includes('拉取失败'), statuses.join(' / '))
})

await test('边界：引擎没打分类前串时仍按原文兜底', async () => {
  const { dialogs } = await runPull({ script: [new Error(NO_UP_UNCLASSIFIED)] })
  assert.strictEqual(dialogs.length, 1)
  assert.match(dialogs[0].args.message, /^拉取失败：fatal: There is no tracking information/)
})

console.log(`\ngit-push-dom: ${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
