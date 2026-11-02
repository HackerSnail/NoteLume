// ai-agent.test.mjs —— Agent 工具循环的纯逻辑回归（工具表 / 防呆 / 悬挂修复 / 循环状态机 / 回退）
// 运行：cd src && node tests/ai-agent.test.mjs
import assert from 'node:assert'
import {
  AGENT_TOOLS,
  pickTools,
  truncateToolResult,
  normalizeReadPath,
  summarizeToolArgs,
  repairHangingToolCalls,
  runAgentLoop,
  AGENT_MAX_STEPS,
  canRevert,
  revertRange,
} from '../ai-agent.js'
import { mdParser, serializeMarkdown } from '../editor-schema.js'
import { EditorState } from 'prosemirror-state'

let pass = 0
let fail = 0
const pending = []
function t(name, fn) {
  // fn 可能是 async（循环状态机用例）：收集后统一等待，保证计数在全部用例跑完后输出
  pending.push(
    (async () => {
      try {
        await fn()
        pass++
        console.log('  ok   ' + name)
      } catch (e) {
        fail++
        console.log('  FAIL ' + name + ' —— ' + ((e && e.message) || e))
      }
    })()
  )
}

// —— 工具注册表 ——

t('AGENT_TOOLS 五个工具，schema 齐全', () => {
  assert.strictEqual(AGENT_TOOLS.length, 5)
  const names = AGENT_TOOLS.map((x) => x.function.name)
  assert.deepStrictEqual(names, ['search_vault', 'read_note', 'list_notes', 'read_current_doc', 'query_tag'])
  for (const tool of AGENT_TOOLS) {
    assert.strictEqual(tool.type, 'function')
    assert.ok(tool.function.description)
    assert.strictEqual(tool.function.parameters.type, 'object')
  }
})

t('pickTools 无库只剩 read_current_doc', () => {
  const off = pickTools({ vaultReady: false })
  assert.deepStrictEqual(off.map((x) => x.function.name), ['read_current_doc'])
  assert.strictEqual(pickTools({ vaultReady: true }).length, 5)
})

// —— 结果截断 ——

t('truncateToolResult 截断并注明', () => {
  assert.strictEqual(truncateToolResult('short'), 'short')
  const long = 'x'.repeat(8001)
  const out = truncateToolResult(long)
  assert.strictEqual(out.length, 8000 + '\n\n…(truncated)'.length)
  assert.ok(out.endsWith('…(truncated)'))
})

// —— path 归一化 ——

t('normalizeReadPath 剥前导斜杠、拒 .. 与绝对路径', () => {
  assert.strictEqual(normalizeReadPath('notes/a.md'), 'notes/a.md')
  assert.strictEqual(normalizeReadPath('/notes/a.md'), 'notes/a.md')
  assert.strictEqual(normalizeReadPath('a/../b.md'), null)
  assert.strictEqual(normalizeReadPath('../a.md'), null)
  assert.strictEqual(normalizeReadPath('C:\\a.md'), null)
  assert.strictEqual(normalizeReadPath(''), null)
  assert.strictEqual(normalizeReadPath(null), null)
})

// —— 参数摘要 ——

t('summarizeToolArgs 取参数原文，坏 JSON 兜底', () => {
  assert.strictEqual(summarizeToolArgs('search_vault', '{"query":"测试词"}'), '测试词')
  assert.strictEqual(summarizeToolArgs('read_note', '{"path":"a.md"}'), 'a.md')
  const raw = 'not json at all'.padEnd(80, '!')
  assert.ok(summarizeToolArgs('search_vault', raw).length <= 61)
})

// —— 悬挂 tool_calls 修复 ——

t('repairHangingToolCalls 补悬挂 tool_call_id', () => {
  const input = [
    { role: 'user', content: 'q' },
    { role: 'assistant', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'a', arguments: '{}' } }, { id: 'c2', type: 'function', function: { name: 'b', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'c1', content: 'ok' },
  ]
  const out = repairHangingToolCalls(input)
  assert.strictEqual(out.length, input.length + 1)
  assert.strictEqual(out[3].role, 'tool')
  assert.strictEqual(out[3].tool_call_id, 'c2')
  assert.strictEqual(out[3].content, '{"error":"cancelled"}')
  // 入参不被修改
  assert.strictEqual(input.length, 3)
})

t('repairHangingToolCalls 完整序列原样返回', () => {
  const input = [
    { role: 'user', content: 'q' },
    { role: 'assistant', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'a', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'c1', content: 'ok' },
    { role: 'assistant', content: 'done' },
  ]
  const out = repairHangingToolCalls(input)
  assert.strictEqual(out.length, input.length)
})

t('repairHangingToolCalls 段尾悬挂（最后一条是 assistant.tool_calls）也补', () => {
  const input = [{ role: 'assistant', tool_calls: [{ id: 'c9', type: 'function', function: { name: 'a', arguments: '{}' } }] }]
  const out = repairHangingToolCalls(input)
  assert.strictEqual(out.length, 2)
  assert.strictEqual(out[1].tool_call_id, 'c9')
})

// —— 工具循环（runAgentLoop） ——

// 假 streamRequest：按脚本逐轮返回，记录每轮收到的 messages
function fakeStream(script) {
  const seen = []
  const calls = { n: 0, seen }
  calls.fn = async (messages) => {
    seen.push(messages.map((m) => JSON.parse(JSON.stringify(m))))
    const r = script[Math.min(calls.n, script.length - 1)]
    calls.n++
    return typeof r === 'function' ? r(calls.n) : r
  }
  return calls
}

const TOOL_CALL_ONE = {
  text: '让我查一下',
  toolCalls: [{ id: 'c1', name: 'search_vault', arguments: '{"query":"x"}' }],
}
const FINAL = { text: '最终回答' }

t('runAgentLoop 单轮工具调用后给最终回答', async () => {
  const s = fakeStream([TOOL_CALL_ONE, FINAL])
  const r = await runAgentLoop({
    messages: [{ role: 'user', content: 'q' }],
    tools: [],
    streamRequest: s.fn,
    execTool: async () => '[{"path":"a.md"}]',
  })
  assert.strictEqual(s.n, 2)
  assert.strictEqual(r.text, '最终回答')
  assert.ok(!r.stopped && !r.maxed && !r.error)
  // assistant(tool_calls) 与 role:'tool' 成对，tool_calls 带 type
  const asst = r.messages.find((m) => m.role === 'assistant' && m.tool_calls)
  assert.strictEqual(asst.content, '让我查一下')
  assert.strictEqual(asst.tool_calls[0].type, 'function')
  const tool = r.messages.find((m) => m.role === 'tool')
  assert.strictEqual(tool.tool_call_id, 'c1')
  assert.strictEqual(tool.content, '[{"path":"a.md"}]')
})

t('runAgentLoop 多轮循环、tools 每轮都带上（由调用方在 streamRequest 里加）且序列成对', async () => {
  const s = fakeStream([TOOL_CALL_ONE, TOOL_CALL_ONE, FINAL])
  let sent = 0
  const r = await runAgentLoop({
    messages: [{ role: 'user', content: 'q' }],
    tools: [{ type: 'function' }],
    streamRequest: async (messages) => {
      sent++
      // 调用方（面板的 streamRequest）发请求前过悬挂修复，历史必须已经成对无悬挂
      const snap = repairHangingToolCalls(messages)
      assert.strictEqual(snap.length, messages.length)
      return s.fn(messages)
    },
    execTool: async () => 'ok',
  })
  assert.strictEqual(sent, 3)
  assert.strictEqual(s.n, 3)
  assert.strictEqual(r.text, '最终回答')
})

t('runAgentLoop maxSteps 到顶收尾返回 maxed', async () => {
  const s = fakeStream([TOOL_CALL_ONE])
  const r = await runAgentLoop({
    messages: [{ role: 'user', content: 'q' }],
    maxSteps: 2,
    streamRequest: s.fn,
    execTool: async () => 'ok',
  })
  assert.strictEqual(s.n, 2)
  assert.ok(r.maxed)
  assert.ok(!r.stopped && !r.error)
})

t('runAgentLoop 工具执行失败回填错误文本且循环继续', async () => {
  const s = fakeStream([TOOL_CALL_ONE, FINAL])
  const r = await runAgentLoop({
    messages: [{ role: 'user', content: 'q' }],
    streamRequest: s.fn,
    execTool: async () => {
      throw new Error('file not found')
    },
  })
  const tool = r.messages.find((m) => m.role === 'tool')
  assert.strictEqual(tool.content, JSON.stringify({ error: 'file not found' }))
  assert.strictEqual(r.text, '最终回答')
})

t('runAgentLoop 中途取消：剩余工具补合成消息、不发下一轮', async () => {
  const TWO_CALLS = {
    text: '',
    toolCalls: [
      { id: 'c1', name: 'search_vault', arguments: '{"query":"x"}' },
      { id: 'c2', name: 'read_note', arguments: '{"path":"a.md"}' },
    ],
  }
  const s = fakeStream([TWO_CALLS])
  let stopped = false
  let ran = 0
  const r = await runAgentLoop({
    messages: [{ role: 'user', content: 'q' }],
    streamRequest: s.fn,
    execTool: async () => {
      ran++
      if (ran >= 2) stopped = true // 第二个工具执行后用户按了停止
      return 'ok'
    },
    shouldStop: () => stopped,
  })
  assert.strictEqual(s.n, 1)
  assert.ok(r.stopped)
  // 第三个及以后的工具不再执行；c2 之前的都跑了，c3 不存在——本轮两个工具都跑完了才停
  assert.strictEqual(ran, 2)
  assert.strictEqual(s.n, 1)
  // 停在工具全跑完、下一轮请求前：序列合法无悬挂
  assert.strictEqual(repairHangingToolCalls(r.messages).length, r.messages.length)
})

t('runAgentLoop 同轮多工具中途取消：剩余工具补合成消息', async () => {
  const TWO_CALLS = {
    text: '',
    toolCalls: [
      { id: 'c1', name: 'search_vault', arguments: '{"query":"x"}' },
      { id: 'c2', name: 'read_note', arguments: '{"path":"a.md"}' },
      { id: 'c3', name: 'list_notes', arguments: '{}' },
    ],
  }
  let stopped = false
  let ran = 0
  const r = await runAgentLoop({
    messages: [{ role: 'user', content: 'q' }],
    streamRequest: async () => TWO_CALLS,
    execTool: async () => {
      ran++
      if (ran >= 2) stopped = true // c2 执行后用户按了停止
      return 'ok'
    },
    shouldStop: () => stopped,
  })
  assert.strictEqual(ran, 2) // c3 没跑
  assert.ok(r.stopped)
  const synth = r.messages.filter((m) => m.role === 'tool' && m.content === '{"error":"cancelled"}')
  assert.deepStrictEqual(synth.map((m) => m.tool_call_id), ['c3'])
})

t('runAgentLoop 流式中取消：半截文本推进历史、无下一轮', async () => {
  const s = fakeStream([{ cancelled: true, text: '半截' }])
  const r = await runAgentLoop({
    messages: [{ role: 'user', content: 'q' }],
    streamRequest: s.fn,
    execTool: async () => 'ok',
  })
  assert.strictEqual(s.n, 1)
  assert.ok(r.stopped)
  assert.strictEqual(r.text, '半截')
  const asst = r.messages.find((m) => m.role === 'assistant')
  assert.strictEqual(asst.content, '半截')
  assert.ok(!asst.tool_calls)
})

t('runAgentLoop 请求失败终止循环返回 error', async () => {
  let attempts = 0
  const r = await runAgentLoop({
    messages: [{ role: 'user', content: 'q' }],
    streamRequest: async () => {
      attempts++
      throw new Error('HTTP 400: bad request')
    },
    execTool: async () => 'ok',
  })
  assert.strictEqual(attempts, 1) // 失败后不再发第二轮
  assert.strictEqual(r.error, 'HTTP 400: bad request')
  assert.ok(!r.stopped && !r.maxed)
})

t('runAgentLoop 默认步数上限 8、onTool 状态回调', async () => {
  assert.strictEqual(AGENT_MAX_STEPS, 8)
  const s = fakeStream([TOOL_CALL_ONE, FINAL])
  const states = []
  await runAgentLoop({
    messages: [],
    streamRequest: s.fn,
    execTool: async () => ({ content: 'ok', ok: true }),
    onTool: (name, args, state) => states.push(name + ':' + state),
  })
  assert.deepStrictEqual(states, ['search_vault:running', 'search_vault:done'])
})

// —— 修改回退（canRevert / revertRange） ——

// 文档构造与视图桩：doc 由 mdParser 造（同 resolveAnchorPos 测试口径），
// 桩 view 用真实 EditorState.apply 走事务，保证 replaceWith / delete 真的落进 doc
function makeView(md) {
  const doc = mdParser.parse(md)
  const state = EditorState.create({ doc })
  const view = {
    state,
    dispatch(tr) {
      this.state = this.state.apply(tr)
    },
  }
  return view
}

/** 文档里首个含 needle 的文本节点的子串区间 [from, to] */
function rangeOfText(view, needle) {
  let hit = null
  view.state.doc.descendants((node, pos) => {
    if (!hit && node.isText && node.text && node.text.includes(needle)) {
      const idx = node.text.indexOf(needle)
      hit = { from: pos + idx, to: pos + idx + needle.length }
      return false
    }
    return true
  })
  return hit
}

/** 模拟 main.js agentApplyWithRevert 的产物：md 取落定区间的序列化产物 */
function makeRecord(view, from, to, prev = '') {
  return { from, to, md: serializeMarkdown(view.state.doc.cut(from, to)), prev }
}

const fullText = (view) => view.state.doc.textBetween(0, view.state.doc.content.size, '\n')

t('canRevert 区间未动为真、动过后为假', () => {
  const view = makeView('# 标题\n\n第一段\n\n第二段\n')
  const range = rangeOfText(view, '第二段')
  const record = makeRecord(view, range.from, range.to)
  assert.ok(canRevert(view.state.doc, record))
  // 区间内的文字被改过 → 序列化比对失配（改动要落在区间里才测得出）
  const changed = mdParser.parse('# 标题\n\n第一段\n\n第二改段\n')
  assert.ok(!canRevert(changed, record))
  // 越界 / 坏记录一律不行
  assert.ok(!canRevert(view.state.doc, { ...record, to: view.state.doc.content.size + 5 }))
  assert.ok(!canRevert(view.state.doc, null))
})

t('revertRange 插入场景删掉记录区间', () => {
  const view = makeView('# 标题\n\n第一段\n')
  const range = rangeOfText(view, '第一段')
  const record = makeRecord(view, range.from, range.to)
  assert.ok(revertRange(view, record))
  assert.ok(!fullText(view).includes('第一段'))
})

t('revertRange 替换场景恢复原文（prev 非空）', () => {
  const view = makeView('第一段\n\n旧的结尾\n')
  const range = rangeOfText(view, '旧的结尾')
  const record = makeRecord(view, range.from, range.to, 'old tail')
  assert.ok(revertRange(view, record))
  const text = fullText(view)
  assert.ok(text.includes('old tail'))
  assert.ok(!text.includes('旧的结尾'))
})

t('revertRange 校验不过返回 false 不动文档', () => {
  const view = makeView('abc\n')
  const before = view.state.doc
  assert.ok(!revertRange(view, { from: 0, to: 2, md: '不存在的内容', prev: '' }))
  assert.strictEqual(view.state.doc, before)
  assert.ok(!revertRange(view, null))
  assert.ok(!revertRange(null, { from: 0, to: 1, md: 'x', prev: '' }))
})

await Promise.all(pending)
console.log(`\n${pass} passed, ${fail} failed`)
process.exitCode = fail ? 1 : 0
