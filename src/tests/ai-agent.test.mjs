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
} from '../ai-agent.js'

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

console.log(`\n${pass} passed, ${fail} failed`)
process.exitCode = fail ? 1 : 0
