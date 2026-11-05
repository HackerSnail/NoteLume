// ollama-pull.test.mjs —— 本机模型拉取的编排状态机（IPC 全打桩，不碰 Tauri 事件通道）
// 运行：cd src && node tests/ollama-pull.test.mjs
//
// 钉的是几件真会出事的事：一次只拉一个、进度事件按 reqId 过滤、取消要当场落状态
// （Rust abort 之后不会再有事件，挂着等就永远不出结果）、订阅没挂上前的事件不能丢。

import assert from 'node:assert'
import { createOllamaPull } from '../ollama-pull.js'

let pass = 0
let fail = 0
async function t(name, fn) {
  try {
    await fn()
    pass++
    console.log('  ok   ' + name)
  } catch (e) {
    fail++
    console.log('  FAIL ' + name + ' —— ' + ((e && e.message) || e))
    if (e && e.stack) console.log(e.stack.split('\n').slice(1, 5).join('\n'))
  }
}

/** 造一套桩：pull 记录调用，listen 交出事件回调，cancel 记录被中止的 reqId */
function harness(opts = {}) {
  const calls = []
  const cancels = []
  let emit = null
  let unsubs = 0
  const ctl = createOllamaPull({
    pull: async (reqId, model) => {
      calls.push({ reqId, model })
      if (opts.pullThrows) throw new Error(opts.pullThrows)
    },
    listen: async (handler) => {
      emit = handler
      return () => { unsubs++ }
    },
    cancel: async (reqId) => { cancels.push(reqId); return true },
  })
  return { ctl, calls, cancels, fire: (e) => emit && emit(e), get unsubs() { return unsubs }, get reqId() { return calls[0] && calls[0].reqId } }
}

const tick = () => new Promise((r) => setTimeout(r, 0))

await t('start 起一次拉取：先订阅再发请求，状态立刻是 pulling', async () => {
  const h = harness()
  const seen = []
  const ok = await h.ctl.start('qwen3:1.7b', (c) => seen.push(c && c.state))
  assert.strictEqual(ok, true)
  assert.strictEqual(h.calls.length, 1)
  assert.strictEqual(h.calls[0].model, 'qwen3:1.7b')
  assert.ok(seen.includes('pulling'), '订阅方应至少收到一次 pulling：' + seen)
})

await t('空模型名不起拉取', async () => {
  const h = harness()
  assert.strictEqual(await h.ctl.start('   '), false)
  assert.strictEqual(h.calls.length, 0)
})

await t('一次只拉一个：pulling 期间第二次 start 回 false，不排队', async () => {
  const h = harness()
  await h.ctl.start('a:1')
  assert.strictEqual(await h.ctl.start('b:2'), false)
  assert.strictEqual(h.calls.length, 1, '不该发出第二次拉取')
})

await t('progress 事件更新 status 与百分比，缺 total 时沿用上一次', async () => {
  const h = harness()
  await h.ctl.start('a:1')
  h.fire({ reqId: h.reqId, kind: 'progress', status: 'pulling manifest' })
  assert.strictEqual(h.ctl.current().status, 'pulling manifest')
  assert.strictEqual(h.ctl.current().pct, 0)
  h.fire({ reqId: h.reqId, kind: 'progress', status: 'Downloading 50%', completed: 500, total: 1000 })
  assert.strictEqual(h.ctl.current().pct, 50)
  h.fire({ reqId: h.reqId, kind: 'progress', status: 'verifying sha256' })
  assert.strictEqual(h.ctl.current().pct, 50, '没有计数的行不该把进度清零')
})

await t('别的 reqId 的事件不收（上一次拉取的尾巴不能改当前状态）', async () => {
  const h = harness()
  await h.ctl.start('a:1')
  h.fire({ reqId: 'ollama-pull-old', kind: 'progress', status: 'x', completed: 1, total: 2 })
  assert.strictEqual(h.ctl.current().status, '')
})

await t('done 事件置完成并把百分比补满', async () => {
  const h = harness()
  await h.ctl.start('a:1')
  h.fire({ reqId: h.reqId, kind: 'done' })
  assert.strictEqual(h.ctl.current().state, 'done')
  assert.strictEqual(h.ctl.current().pct, 100)
})

await t('error 事件带原文落进 state', async () => {
  const h = harness()
  await h.ctl.start('nope:latest')
  h.fire({ reqId: h.reqId, kind: 'error', error: 'file not found for model' })
  assert.strictEqual(h.ctl.current().state, 'error')
  assert.strictEqual(h.ctl.current().error, 'file not found for model')
})

await t('IPC 直接抛错也算失败，不让 Promise 悬着', async () => {
  const h = harness({ pullThrows: 'connection refused' })
  await h.ctl.start('a:1')
  await tick()
  assert.strictEqual(h.ctl.current().state, 'error')
  assert.ok(h.ctl.current().error.includes('connection refused'))
})

await t('stop 当场落 cancelled 并去中止请求（Rust abort 后没有事件，不能挂等）', async () => {
  const h = harness()
  await h.ctl.start('a:1')
  assert.strictEqual(h.ctl.stop(), true)
  assert.strictEqual(h.ctl.current().error, 'cancelled')
  await tick()
  assert.deepStrictEqual(h.cancels, [h.reqId])
  assert.strictEqual(h.ctl.stop(), false, '已经停了再点不该重复中止')
})

await t('取消之后还能重新起一次拉取', async () => {
  const h = harness()
  await h.ctl.start('a:1')
  h.ctl.stop()
  assert.strictEqual(await h.ctl.start('a:1'), true)
  assert.strictEqual(h.calls.length, 2)
  assert.notStrictEqual(h.calls[0].reqId, h.calls[1].reqId, '两次拉取要各自的 reqId，事件才不会串')
})

await t('subscribe / 退订：面板关掉后不再重画，拉取本身接着跑', async () => {
  const h = harness()
  const seen = []
  const off = h.ctl.subscribe((c) => seen.push(c && c.state))
  await h.ctl.start('a:1')
  h.fire({ reqId: h.reqId, kind: 'progress', status: 'x' })
  assert.ok(seen.length >= 2, '订阅方应收到 pulling 与 progress：' + seen)
  off()
  h.fire({ reqId: h.reqId, kind: 'done' })
  assert.strictEqual(h.ctl.current().state, 'done', '退订不影响拉取本身')
  assert.ok(!seen.includes('done'), '退订后不该再回调')
})

await t('顺序：订阅挂上才发拉取请求（先发会丢头几行进度）', async () => {
  const order = []
  const ctl = createOllamaPull({
    pull: async () => { order.push('pull') },
    listen: async () => new Promise((r) => setTimeout(() => { order.push('listen'); r(() => {}) }, 10)),
    cancel: async () => true,
  })
  await ctl.start('a:1')
  assert.deepStrictEqual(order, ['listen', 'pull'])
  assert.strictEqual(ctl.current().state, 'pulling')
})

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
