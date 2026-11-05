// ai-tasks.test.mjs —— 大模型接入前端纯逻辑回归（提示词拼装 / 围栏剥离 / 文档上下文 / 设置归一化）
// 运行：cd src && node tests/ai-tasks.test.mjs
import assert from 'node:assert'
import {
  AI_TASK_IDS,
  buildTaskMessages,
  stripFences,
  buildDocContext,
  normalizeAiConfig,
  validateAiConfig,
  isHttpUrl,
  aiKeyHost,
  aiConfigured,
  AI_PRESETS,
  AI_LIMITS,
  parseAgentReply,
  stripInsertMarkers,
  isPlaceholderReply,
  ollamaFlowFor,
  ollamaUsable,
  OLLAMA_SUGGEST_MODEL,
  resolveAnchorPos,
  modelSupportsVision,
  aiQueryTerms,
  buildVaultContext,
  AI_VAULT_CONTEXT_MAX_CHARS,
  estimateTokens,
  aiContextWindow,
  AI_CTX_WINDOW_TOKENS,
} from '../ai-tasks.js'
import { mdParser } from '../editor-schema.js'
import { LOCALES, MESSAGES } from '../locales/index.js'

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

t('buildTaskMessages：内置任务返回 system + user 两条数组消息，正文被 --- 包裹', () => {
  const m = buildTaskMessages('polish', '旧的句子', '')
  assert.ok(Array.isArray(m) && m.length === 2, '必须回两条消息的数组')
  assert.strictEqual(m[0].role, 'system')
  assert.ok(m[0].content.includes('writing assistant'))
  assert.strictEqual(m[1].role, 'user')
  assert.ok(m[1].content.includes('---\n旧的句子\n---'))
})

t('buildTaskMessages：返回值必须是数组（Rust AiChatArgs.messages 是 Vec，传对象会让选区 AI 整体不可用）', () => {
  for (const id of AI_TASK_IDS.filter((x) => x !== 'custom')) {
    const m = buildTaskMessages(id, 'x', '')
    assert.ok(Array.isArray(m), id + ' 必须回数组')
    assert.deepStrictEqual(m.map((e) => e.role), ['system', 'user'])
    for (const e of m) assert.strictEqual(typeof e.content, 'string')
  }
})

t('buildTaskMessages：continuation 只要求输出续写（指令里带 continue 字样）', () => {
  const m = buildTaskMessages('continue', '前文', '')
  assert.ok(/continue/i.test(m[1].content))
})

t('buildTaskMessages：翻译任务带中英互译指令', () => {
  const m = buildTaskMessages('translate', '你好', '')
  assert.ok(m[1].content.includes('English') && m[1].content.includes('Chinese'))
})

t('buildTaskMessages：custom 无指令回 null，有指令拼进 user', () => {
  assert.strictEqual(buildTaskMessages('custom', '文本', '   '), null)
  const m = buildTaskMessages('custom', '文本', '改成表格')
  assert.ok(m[1].content.startsWith('改成表格\n\n---\n文本\n---'))
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

t('normalizeAiConfig：坏类型回落默认，字符串 trim + 限长；contextTokens 非负整数才收', () => {
  assert.deepStrictEqual(normalizeAiConfig(null), { baseUrl: '', apiKey: '', model: '', contextTokens: 0, keys: {} })
  assert.deepStrictEqual(normalizeAiConfig(42), { baseUrl: '', apiKey: '', model: '', contextTokens: 0, keys: {} })
  const long = 'u'.repeat(400)
  const n = normalizeAiConfig({ baseUrl: '  https://a.b/v1  ', apiKey: long, model: 123 })
  assert.strictEqual(n.baseUrl, 'https://a.b/v1')
  assert.strictEqual(n.apiKey.length, 300)
  assert.strictEqual(n.model, '')
  assert.strictEqual(normalizeAiConfig({ contextTokens: '4096' }).contextTokens, 4096)
  assert.strictEqual(normalizeAiConfig({ contextTokens: -5 }).contextTokens, 0)
  assert.strictEqual(normalizeAiConfig({ contextTokens: 'abc' }).contextTokens, 0)
  assert.strictEqual(normalizeAiConfig({ contextTokens: 1e99 }).contextTokens, 10000000)
})

t('aiKeyHost：取 host:port 小写；非 http(s) 与坏地址回空串', () => {
  assert.strictEqual(aiKeyHost('https://api.deepseek.com/v1'), 'api.deepseek.com')
  assert.strictEqual(aiKeyHost('https://API.DeepSeek.com/V1'), 'api.deepseek.com')
  assert.strictEqual(aiKeyHost('http://127.0.0.1:11434/v1'), '127.0.0.1:11434')
  assert.strictEqual(aiKeyHost('  https://a.b/p  '), 'a.b')
  assert.strictEqual(aiKeyHost('ftp://a.b'), '')
  assert.strictEqual(aiKeyHost('not a url'), '')
  assert.strictEqual(aiKeyHost(''), '')
  assert.strictEqual(aiKeyHost(undefined), '')
})

t('Key 分格：apiKey 是当前地址那一格的镜像，换地址不串 Key', () => {
  const deep = 'sk-deepseek-1'
  const base = { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' }
  // 旧版单 Key：首次分格归到当时地址，升级后不用重填
  const migrated = normalizeAiConfig({ ...base, apiKey: deep })
  assert.deepStrictEqual(migrated.keys, { 'api.deepseek.com': deep })
  assert.strictEqual(migrated.apiKey, deep)
  // 同一张表换到 Kimi：那一格没填过就是空，DeepSeek 的值留在原格
  const kimi = normalizeAiConfig({ ...migrated, baseUrl: 'https://api.moonshot.cn/v1', model: 'kimi-k2' })
  assert.strictEqual(kimi.apiKey, '')
  assert.strictEqual(kimi.keys['api.deepseek.com'], deep)
  // 填了 Kimi 再切回来，两家各自独立（面板口径：格子与镜像成对写）
  const filled = normalizeAiConfig({ ...kimi, apiKey: 'sk-kimi-2', keys: { ...kimi.keys, 'api.moonshot.cn': 'sk-kimi-2' } })
  assert.deepStrictEqual(filled.keys, { 'api.deepseek.com': deep, 'api.moonshot.cn': 'sk-kimi-2' })
  assert.strictEqual(filled.apiKey, 'sk-kimi-2')
  const back = normalizeAiConfig({ ...filled, baseUrl: base.baseUrl })
  assert.strictEqual(back.apiKey, deep)
  // 只改镜像不改格子不生效：换地址时不能把上一家的 Key 自动带进新格
  const mirrorOnly = normalizeAiConfig({ ...filled, apiKey: 'sk-串台' })
  assert.strictEqual(mirrorOnly.apiKey, 'sk-kimi-2')
  assert.strictEqual(mirrorOnly.keys['api.moonshot.cn'], 'sk-kimi-2')
  // 本机端口也算两格；坏类型与空格名被丢掉，格子名统一小写
  const dirty = normalizeAiConfig({
    baseUrl: 'http://127.0.0.1:11434/v1',
    keys: { '127.0.0.1:11434': '  a  ', '127.0.0.1:11435': 42, '': 'c', 'API.OpenAI.com': 'd' },
  })
  assert.deepStrictEqual(dirty.keys, { '127.0.0.1:11434': 'a', 'api.openai.com': 'd' })
  assert.strictEqual(dirty.apiKey, 'a')
  // 地址还没填合法：Key 留在 apiKey 字段，不被任何格子吞掉
  const pending = normalizeAiConfig({ baseUrl: '', apiKey: 'sk-x', keys: { 'api.deepseek.com': deep } })
  assert.strictEqual(pending.apiKey, 'sk-x')
})

t('aiContextWindow：填了用真实窗口，未填（0/坏值）回落参考值', () => {
  assert.strictEqual(aiContextWindow({ contextTokens: 2048 }), 2048)
  assert.strictEqual(aiContextWindow({ contextTokens: 0 }), AI_CTX_WINDOW_TOKENS)
  assert.strictEqual(aiContextWindow({}), AI_CTX_WINDOW_TOKENS)
  assert.strictEqual(aiContextWindow(null), AI_CTX_WINDOW_TOKENS)
})

t('aiConfigured：地址 + 模型齐才算配好；地址须为 http(s)；Key 可空（Ollama）', () => {
  assert.strictEqual(aiConfigured(null), false)
  assert.strictEqual(aiConfigured({ baseUrl: '', apiKey: 'k', model: 'm' }), false)
  assert.strictEqual(aiConfigured({ baseUrl: 'u', apiKey: '', model: '' }), false)
  assert.strictEqual(aiConfigured({ baseUrl: 'not a url', apiKey: '', model: 'm' }), false)
  assert.strictEqual(aiConfigured({ baseUrl: 'http://127.0.0.1:11434/v1', apiKey: '', model: 'llama3.1' }), true)
})

t('validateAiConfig：超长拒绝、非 http(s) 地址拒绝', () => {
  const ok = validateAiConfig({ baseUrl: 'https://api.deepseek.com/v1', apiKey: '', model: 'deepseek-chat' })
  assert.strictEqual(ok.ok, true)
  assert.deepStrictEqual(ok.errors, {})

  const longKey = validateAiConfig({ baseUrl: 'https://a.b/v1', apiKey: 'k'.repeat(AI_LIMITS.apiKey + 1), model: 'm' })
  assert.strictEqual(longKey.ok, false)
  assert.strictEqual(longKey.errors.apiKey, 'tooLong')

  const longModel = validateAiConfig({ baseUrl: 'https://a.b/v1', apiKey: '', model: 'm'.repeat(AI_LIMITS.model + 1) })
  assert.strictEqual(longModel.errors.model, 'tooLong')

  const badUrl = validateAiConfig({ baseUrl: 'not a url', apiKey: '', model: 'm' })
  assert.strictEqual(badUrl.ok, false)
  assert.strictEqual(badUrl.errors.baseUrl, 'badUrl')

  assert.strictEqual(isHttpUrl('ftp://a.b'), false)
  assert.strictEqual(isHttpUrl(' https://a.b '), true)
  assert.strictEqual(isHttpUrl(''), false)
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

// —— Agent 锚点协议：parseAgentReply / resolveAnchorPos ——

t('parseAgentReply：无标记时只走 stripFences', () => {
  const r = parseAgentReply('```md\n## 结论\n\n正文\n```')
  assert.strictEqual(r.anchor, null)
  assert.ok(r.body.includes('正文'))
})

t('parseAgentReply：after 标记 + 闭合标签剥干净', () => {
  const r = parseAgentReply('<insert after="引言">\n\n## 补充\n\n一段说明文字。\n\n</insert>')
  assert.deepStrictEqual(r.anchor, { dir: 'after', target: '引言' })
  assert.strictEqual(r.body, '## 补充\n\n一段说明文字。')
})

t('parseAgentReply：before 标记无闭合也认，标记前的客套全剥', () => {
  const r = parseAgentReply('好的，下面是要插入的内容：\n<insert before="结论">\n内容本体')
  assert.deepStrictEqual(r.anchor, { dir: 'before', target: '结论' })
  assert.strictEqual(r.body, '内容本体')
})

t('parseAgentReply：超长或含引号的目标不绑锚点，标记仍从正文剥离', () => {
  const long = parseAgentReply('<insert after="' + 'a'.repeat(121) + '">正文')
  assert.strictEqual(long.anchor, null)
  assert.strictEqual(long.anchorBroken, true)
  assert.strictEqual(long.body, '正文')

  const quoted = parseAgentReply('x<insert after="say "hi"">y')
  assert.strictEqual(quoted.anchor, null)
  assert.strictEqual(quoted.anchorBroken, true)
  assert.strictEqual(quoted.body, 'y')

  const fine = parseAgentReply('<insert after="引言">正文')
  assert.strictEqual(fine.anchorBroken, false)
})

t('parseAgentReply：正文中段的落点标记残渣全部剥掉（只剥首个的修复）', () => {
  const r = parseAgentReply('<insert after="引言">内容甲</insert>更多乙<insert after="x">尾巴')
  assert.deepStrictEqual(r.anchor, { dir: 'after', target: '引言' })
  assert.strictEqual(r.body, '内容甲\n更多乙\n尾巴')
})

t('parseAgentReply：只吐协议标记（内容为空）时 body 为空串、锚点仍绑定', () => {
  // 真机复现形状：模型先吐标记、又吐一个闭合标签、再吐一遍标记，全程没有正文
  const r = parseAgentReply('<insert after="引言"></insert>\n<insert after="引言">')
  assert.deepStrictEqual(r.anchor, { dir: 'after', target: '引言' })
  assert.strictEqual(r.body, '')
})

t('parseAgentReply：首个标记之前的残渣整段丢弃', () => {
  const r = parseAgentReply('</insert>\n<insert after="引言">正文')
  assert.deepStrictEqual(r.anchor, { dir: 'after', target: '引言' })
  assert.strictEqual(r.body, '正文')
})

t('ollamaFlowFor：四档各一条，坏数据不打扰', () => {
  assert.strictEqual(ollamaFlowFor({ state: 'missing' }).kind, 'install')
  assert.strictEqual(ollamaFlowFor({ state: 'stopped' }).kind, 'start')
  const pull = ollamaFlowFor({ state: 'no_models', models: [] })
  assert.strictEqual(pull.kind, 'pull')
  assert.strictEqual(pull.model, OLLAMA_SUGGEST_MODEL)
  assert.ok(pull.model && !/\s/.test(pull.model), '建议模型名要能直接进请求体')
  assert.strictEqual(ollamaFlowFor({ state: 'ready', models: ['a'] }).kind, 'ready')
  // 老版本返回 true / 探测抛错返回 null / 没见过的档位：一律不打扰，不能弹空文案的框
  for (const bad of [true, false, null, undefined, {}, { state: 'weird' }]) {
    assert.strictEqual(ollamaFlowFor(bad).kind, 'none', JSON.stringify(bad) + ' 应判 none')
  }
})

t('ollamaUsable：可达（含零模型）算可用，没装与没起都不能填预设', () => {
  assert.strictEqual(ollamaUsable({ state: 'ready', models: ['a'] }), true)
  assert.strictEqual(ollamaUsable({ state: 'no_models', models: [] }), true)
  assert.strictEqual(ollamaUsable({ state: 'stopped' }), false)
  assert.strictEqual(ollamaUsable({ state: 'missing' }), false)
  assert.strictEqual(ollamaUsable(null), false)
})

t('Ollama 引导引用的词条五种语言都齐', () => {
  const keys = [
    'ollama.missingBody', 'ollama.installBtn', 'ollama.stoppedBody', 'ollama.retryBtn',
    'ollama.pullAsk', 'ollama.pullBtn', 'ollama.pullProgress', 'ollama.pullDone', 'ollama.pullFail',
    'ai.set.ollama', 'ai.set.ollamaReady', 'ai.set.ollamaNoModels', 'ai.set.ollamaStopped', 'ai.set.ollamaMissing',
    'common.cancel', 'ai.stopped',
  ]
  for (const loc of LOCALES) {
    const m = MESSAGES[loc.id]
    assert.ok(m, loc.id + ' 语言包没登记')
    for (const k of keys) assert.ok(typeof m[k] === 'string' && m[k].trim(), loc.id + ' 缺词条：' + k)
  }
  // 不再被引用的键该删干净（留着就是漂移源）
  for (const loc of LOCALES) assert.ok(!('ollama.retryBody' in MESSAGES[loc.id]), loc.id + ' 还留着 ollama.retryBody')
})

t('parseAgentReply：只吐 <empty> 这类占位标记时 body 为空串（不进气泡、不写进文档）', () => {
  // 真机形状：Agent 模式问「你好」，模型想完「应该输出空字符串」后把占位标记当正文吐出来
  assert.strictEqual(parseAgentReply('<empty>').body, '')
  assert.strictEqual(parseAgentReply('  <empty>  ').body, '')
  assert.strictEqual(parseAgentReply('[empty]').body, '')
  assert.strictEqual(parseAgentReply('“空”').body, '')
  assert.strictEqual(parseAgentReply('```md\n<empty>\n```').body, '')
  const withAnchor = parseAgentReply('<insert after="引言">\n\n<empty>')
  assert.deepStrictEqual(withAnchor.anchor, { dir: 'after', target: '引言' })
  assert.strictEqual(withAnchor.body, '', '带锚点的占位也不该写任何东西进文档')
})

t('parseAgentReply：占位标记只在整段等于它时才吞，裸的「无 / None」可能是真回答', () => {
  assert.strictEqual(parseAgentReply('结论：<empty> 这一项空缺').body, '结论：<empty> 这一项空缺')
  assert.strictEqual(parseAgentReply('无').body, '无')
  assert.strictEqual(parseAgentReply('None').body, 'None')
})

t('isPlaceholderReply：界符必需，成对包着一个空词才判占位', () => {
  assert.strictEqual(isPlaceholderReply('<empty>'), true)
  assert.strictEqual(isPlaceholderReply('<NONE>'), true)
  assert.strictEqual(isPlaceholderReply('（无内容）'), true)
  assert.strictEqual(isPlaceholderReply('<empty> 后面还有话'), false)
  assert.strictEqual(isPlaceholderReply(''), false)
})

t('stripInsertMarkers：大小写不敏感、成对剥、残留不粘字', () => {
  assert.strictEqual(stripInsertMarkers('a</INSERT>b<Insert after="x">c'), 'a\nb\nc')
  assert.strictEqual(stripInsertMarkers('没有标记的正文'), '没有标记的正文')
})

t('resolveAnchorPos：标题命中，after 在标题块之后、before 在标题块之前', () => {
  const doc = mdParser.parse('# 引言\n\n开头一段。\n\n## 结论\n\n收尾。')
  const after = resolveAnchorPos(doc, { dir: 'after', target: '引言' })
  const before = resolveAnchorPos(doc, { dir: 'before', target: '结论' })
  assert.ok(after != null && before != null)
  assert.ok(after > 1 && after < before, '引言之后应落在结论之前')
  // before「结论」= 其标题块起点，正好是 after「开头一段。」段落的末尾位置
  const para = resolveAnchorPos(doc, { dir: 'after', target: '开头一段' })
  assert.strictEqual(before, para)
})

t('resolveAnchorPos：正文段落前缀命中、大小写与空白不敏感', () => {
  const doc = mdParser.parse('# T\n\nThe Quick  Brown Fox\n\n尾段。')
  const pos = resolveAnchorPos(doc, { dir: 'after', target: 'the quick brown' })
  assert.ok(pos != null && pos > 3)
})

t('resolveAnchorPos：同前缀长标题在前时，文本全等的标题仍优先', () => {
  const doc = mdParser.parse('# 目标进阶写法与更多字\n\n段落\n\n# 目标\n\n正文')
  const blocks = []
  doc.forEach((node, offset) => blocks.push({ offset, size: node.nodeSize, text: node.textContent }))
  const target = blocks.find((b) => b.text === '目标')
  assert.ok(target, '文档里应有全等标题')
  const before = resolveAnchorPos(doc, { dir: 'before', target: '目标' })
  const after = resolveAnchorPos(doc, { dir: 'after', target: '目标' })
  assert.strictEqual(before, target.offset + 1, 'before 应落在全等标题块起点')
  assert.strictEqual(after, target.offset + 1 + target.size, 'after 应落在全等标题块末尾')
})

t('resolveAnchorPos：找不到回 null', () => {
  const doc = mdParser.parse('# 引言\n\n正文。')
  assert.strictEqual(resolveAnchorPos(doc, { dir: 'after', target: '不存在的段落' }), null)
  assert.strictEqual(resolveAnchorPos(doc, null), null)
  assert.strictEqual(resolveAnchorPos(doc, { dir: 'after', target: '  ' }), null)
})

t('modelSupportsVision：已知视觉模型放行，纯文本/空名拦下', () => {
  for (const yes of ['gpt-4o', 'gpt-4o-mini', 'gpt-4.1', 'o3-mini', 'claude-3-5-sonnet', 'claude-sonnet-4', 'gemini-2.0-flash', 'qwen2.5-vl-72b', 'qwen-vl-max', 'glm-4v', 'glm-4.5v', 'doubao-seed-1.6', 'moonshot-v1-8k-vision', 'llava:13b', 'grok-4']) {
    assert.strictEqual(modelSupportsVision(yes), true, yes + ' 应视为支持视觉')
  }
  for (const no of ['', 'deepseek-chat', 'deepseek-r1', 'glm-4', 'kimi-k2', 'llama3.1', 'qwen2.5-72b-instruct', 'grok-3']) {
    assert.strictEqual(modelSupportsVision(no), false, no + ' 应视为纯文本')
  }
})

t('aiQueryTerms：英文词原样、中文 2-gram、去重限 12', () => {
  const terms = aiQueryTerms('帮我总结 ProseMirror 的 schema 设计，附性能对比')
  assert.ok(terms.includes('prosemirror'), '英文词原样小写')
  assert.ok(terms.includes('总结') || terms.includes('结性'), '中文 2-gram 命中')
  assert.ok(terms.length <= 12)
  assert.deepStrictEqual(aiQueryTerms(''), [])
})

t('estimateTokens：CJK 按字、ASCII 按四分之一', () => {
  assert.strictEqual(estimateTokens(''), 0)
  assert.strictEqual(estimateTokens('abcd'), 1)
  assert.strictEqual(estimateTokens('中文'), 2)
  assert.strictEqual(estimateTokens('中a'), 2)
})

t('buildVaultContext：空命中回空串、截 5 篇封 6000 字符', () => {
  assert.strictEqual(buildVaultContext([], 'HEAD'), '')
  const many = Array.from({ length: 8 }, (_, i) => ({ path: 'p' + i + '.md', title: 'T' + i, snippet: 's' + i }))
  const ctx = buildVaultContext(many, 'HEAD')
  assert.ok(ctx.startsWith('HEAD'))
  assert.ok(ctx.includes('T4') && !ctx.includes('T5'), '只取前 5 篇')
  const huge = [{ path: 'big.md', title: 'B', snippet: 'x'.repeat(9000) }]
  assert.ok(buildVaultContext(huge, 'H').length < 7000, '总量封顶')
})

t('buildVaultContext：表头计入 6000 预算，总长不超限', () => {
  const list = Array.from({ length: 5 }, (_, i) => ({ path: 'p' + i, title: 't' + i, snippet: 's'.repeat(400) }))
  const v1 = buildVaultContext(list, 'H'.repeat(5900))
  assert.ok(v1.length <= AI_VAULT_CONTEXT_MAX_CHARS)
  assert.strictEqual(v1.split('\n').filter((l) => l.startsWith('- ')).length, 1)

  const v2 = buildVaultContext(list, 'H'.repeat(6100))
  assert.strictEqual(v2.length, AI_VAULT_CONTEXT_MAX_CHARS)
  assert.strictEqual(v2.split('\n').filter((l) => l.startsWith('- ')).length, 0)
})

console.log((fail ? `\n${pass} passed, ${fail} FAILED` : `all ${pass} passed`))
process.exit(fail ? 1 : 0)
