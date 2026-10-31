// ai-tasks.test.mjs —— 大模型接入前端纯逻辑回归（提示词拼装 / 围栏剥离 / 文档上下文 / 设置归一化）
// 运行：cd src && node tests/ai-tasks.test.mjs
import assert from 'node:assert'
import {
  AI_TASK_IDS,
  buildTaskMessages,
  stripFences,
  buildDocContext,
  normalizeAiConfig,
  aiConfigured,
  AI_PRESETS,
} from '../ai-tasks.js'

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

t('任务 id 表固定五项', () => {
  assert.deepStrictEqual(AI_TASK_IDS, ['polish', 'continue', 'translate', 'summarize', 'custom'])
})

t('buildTaskMessages：内置任务返回 system + user，正文被 --- 包裹', () => {
  const m = buildTaskMessages('polish', '旧的句子', '')
  assert.ok(m && m.system.includes('writing assistant'))
  assert.ok(m.user.includes('---\n旧的句子\n---'))
  assert.notStrictEqual(m.user, m.system)
})

t('buildTaskMessages：continuation 只要求输出续写（指令里带 continue 字样）', () => {
  const m = buildTaskMessages('continue', '前文', '')
  assert.ok(/continue/i.test(m.user))
})

t('buildTaskMessages：翻译任务带中英互译指令', () => {
  const m = buildTaskMessages('translate', '你好', '')
  assert.ok(m.user.includes('English') && m.user.includes('Chinese'))
})

t('buildTaskMessages：custom 无指令回 null，有指令拼进 user', () => {
  assert.strictEqual(buildTaskMessages('custom', '文本', '   '), null)
  const m = buildTaskMessages('custom', '文本', '改成表格')
  assert.ok(m.user.startsWith('改成表格\n\n---\n文本\n---'))
})

t('buildTaskMessages：未知任务回 null', () => {
  assert.strictEqual(buildTaskMessages('nope', 'x', ''), null)
})

t('stripFences：剥代码围栏与客套首行，正文原样保留', () => {
  assert.strictEqual(stripFences('```markdown\n**加粗**\n```'), '**加粗**')
  assert.strictEqual(stripFences('以下是结果：\n正文'), '正文')
  assert.strictEqual(stripFences("Here is the polished text:\n\nbody"), 'body')
  assert.strictEqual(stripFences('好的，\n结果'), '结果')
  assert.strictEqual(stripFences('纯文本原样'), '纯文本原样')
  assert.strictEqual(stripFences(''), '')
})

t('stripFences：正文里含 ``` 行首的段落不被误剥（只剥整段围栏）', () => {
  const s = '前一段\n```js\nconst a = 1\n```\n后一段'
  assert.strictEqual(stripFences(s), s)
})

t('buildDocContext：空文本回空串（不加系统消息）', () => {
  assert.strictEqual(buildDocContext('笔记', ''), '')
  assert.strictEqual(buildDocContext('笔记', '   \n  '), '')
})

t('buildDocContext：带标题与正文，超长截断', () => {
  const s = buildDocContext('读书笔记', '正文内容')
  assert.ok(s.includes('读书笔记') && s.includes('正文内容'))
  const long = 'x'.repeat(8000)
  const cut = buildDocContext('t', long)
  assert.ok(cut.length < 8000)
  assert.ok(!cut.includes('x'.repeat(7000)))
})

t('normalizeAiConfig：坏类型回落默认，字符串 trim + 限长', () => {
  assert.deepStrictEqual(normalizeAiConfig(null), { baseUrl: '', apiKey: '', model: '' })
  assert.deepStrictEqual(normalizeAiConfig(42), { baseUrl: '', apiKey: '', model: '' })
  const long = 'u'.repeat(400)
  const n = normalizeAiConfig({ baseUrl: '  https://a.b/v1  ', apiKey: long, model: 123 })
  assert.strictEqual(n.baseUrl, 'https://a.b/v1')
  assert.strictEqual(n.apiKey.length, 300)
  assert.strictEqual(n.model, '')
})

t('aiConfigured：地址 + 模型齐才算配好；Key 可空（Ollama）', () => {
  assert.strictEqual(aiConfigured(null), false)
  assert.strictEqual(aiConfigured({ baseUrl: '', apiKey: 'k', model: 'm' }), false)
  assert.strictEqual(aiConfigured({ baseUrl: 'u', apiKey: '', model: '' }), false)
  assert.strictEqual(aiConfigured({ baseUrl: 'http://127.0.0.1:11434/v1', apiKey: '', model: 'llama3.1' }), true)
})

t('AI_PRESETS：五条，baseUrl 无尾斜杠且含版本段', () => {
  assert.strictEqual(AI_PRESETS.length, 5)
  const ids = AI_PRESETS.map((p) => p.id)
  for (const id of ['deepseek', 'zhipu', 'kimi', 'openai', 'ollama']) assert.ok(ids.includes(id))
  for (const p of AI_PRESETS) {
    assert.ok(p.baseUrl && p.model)
    assert.ok(!p.baseUrl.endsWith('/'), p.id + ' baseUrl 不应以 / 结尾')
  }
})

console.log((fail ? `\n${pass} passed, ${fail} FAILED` : `all ${pass} passed`))
process.exit(fail ? 1 : 0)
