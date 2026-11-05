// ai-data-flow.test.mjs —— 「数据流向」说明与真实截断值不漂移
// 运行：cd src && node tests/ai-data-flow.test.mjs
//
// 钉的是「界面说的话 = 代码做的事」：说明里每个数字都从真实生效的常量来，
// 而 buildVaultContext 的截断行为要真的等于那个常量。改了截断值不用手改文案，
// 文案漏了占位符或某语言缺键，这里直接红。

import assert from 'node:assert'
import { readFileSync } from 'node:fs'
import { t } from '../i18n.js'
import { LOCALES, MESSAGES } from '../locales/index.js'
import {
  aiEgressVars, isLoopbackUrl, buildVaultContext,
  DOC_CONTEXT_MAX_CHARS, AI_VAULT_MAX_DOCS, AI_VAULT_SNIPPET_MAX_CHARS, AI_VAULT_CONTEXT_MAX_CHARS, AI_MAX_IMAGES,
} from '../ai-tasks.js'
import { TOOL_RESULT_MAX_CHARS } from '../ai-agent.js'

let pass = 0
let fail = 0
function check(name, fn) {
  try { fn(); pass++; console.log('✅ ' + name) }
  catch (e) { fail++; console.error('❌ ' + name + '：' + e.message) }
}

check('isLoopbackUrl：回环与 localhost 算本机，其余全按会出机', () => {
  for (const u of ['http://127.0.0.1:11434/v1', 'http://127.8.9.10/v1', 'http://localhost:11434/v1', 'http://LOCALHOST:11434', 'http://[::1]:11434/v1', 'http://me.localhost:11434']) {
    assert.ok(isLoopbackUrl(u), u + ' 应判本机')
  }
  // 局域网 IP、.local、远程域名、0.0.0.0（绑定地址不是目标地址）与坏值都算会出机
  for (const u of ['https://api.deepseek.com/v1', 'http://192.168.1.5:11434/v1', 'http://host.local/v1', 'http://0.0.0.0:11434', '', 'garbage', 'ftp://127.0.0.1']) {
    assert.ok(!isLoopbackUrl(u), u + ' 不该判本机')
  }
})

check('aiEgressVars 的每个数字都等于真实常量', () => {
  const v = aiEgressVars({ baseUrl: 'http://127.0.0.1:11434/v1' })
  assert.strictEqual(v.doc, DOC_CONTEXT_MAX_CHARS)
  assert.strictEqual(v.vaultDocs, AI_VAULT_MAX_DOCS)
  assert.strictEqual(v.snippet, AI_VAULT_SNIPPET_MAX_CHARS)
  assert.strictEqual(v.vaultTotal, AI_VAULT_CONTEXT_MAX_CHARS)
  assert.strictEqual(v.imgs, AI_MAX_IMAGES)
  assert.strictEqual(v.local, true)
  assert.strictEqual(v.host, '127.0.0.1:11434')
  // 坏 cfg 不炸、也不谎报本机
  const bad = aiEgressVars(null)
  assert.strictEqual(bad.local, false)
  assert.strictEqual(bad.host, '')
  assert.strictEqual(bad.doc, DOC_CONTEXT_MAX_CHARS)
})

check('说明里的数字与 buildVaultContext 的真实截断一致', () => {
  const long = 'x'.repeat(AI_VAULT_SNIPPET_MAX_CHARS + 500)
  const out = buildVaultContext([{ path: 'a.md', title: 'A', snippet: long }], '头')
  assert.ok(out.includes('x'.repeat(AI_VAULT_SNIPPET_MAX_CHARS)), '片段应截到常量那么长')
  assert.ok(!out.includes('x'.repeat(AI_VAULT_SNIPPET_MAX_CHARS + 1)), '不该多留一个字符')
  assert.ok(out.length <= AI_VAULT_CONTEXT_MAX_CHARS, '总长应不超过 vaultTotal：' + out.length)
  // 篇数上限同样生效：多喂一倍命中，条目数不超过 AI_VAULT_MAX_DOCS
  const many = Array.from({ length: AI_VAULT_MAX_DOCS * 2 }, (_, i) => ({ path: `n${i}.md`, title: 'T' + i, snippet: '片段' }))
  const out2 = buildVaultContext(many, '')
  assert.strictEqual(out2.split('\n').filter((l) => l.startsWith('- ')).length, AI_VAULT_MAX_DOCS)
})

check('附图上限走常量，面板里没有裸的 4', () => {
  const src = readFileSync(new URL('../ai-panel.js', import.meta.url), 'utf8')
  assert.ok(src.includes('attachments.length >= AI_MAX_IMAGES'), '附件闸应引用 AI_MAX_IMAGES')
  assert.ok(!/attachments\.length >= 4\b/.test(src), '不该留字面量 4')
})

check('五种语言的数据流向词条齐全且占位符一致', () => {
  const keys = ['ai.set.egressSection', 'ai.set.dataFlow', 'ai.set.dataFlowLocal', 'ai.set.dataFlowRemote']
  const ph = ['{doc}', '{vaultDocs}', '{snippet}', '{vaultTotal}', '{imgs}', '{tool}', '{host}']
  for (const loc of LOCALES) {
    const m = MESSAGES[loc.id]
    for (const k of keys) assert.ok(typeof m[k] === 'string' && m[k].trim(), loc.id + ' 缺词条：' + k)
    // dataFlow 讲全部截断值；两条结论各讲 host
    for (const p of ph.slice(0, 6)) assert.ok(m['ai.set.dataFlow'].includes(p), loc.id + ' dataFlow 缺占位符 ' + p)
    for (const k of ['ai.set.dataFlowLocal', 'ai.set.dataFlowRemote']) {
      assert.ok(m[k].includes('{host}'), loc.id + ' ' + k + ' 缺占位符 {host}')
    }
  }
})

check('插值后不留未替换的占位符，数字与 host 真出现在文案里', () => {
  const vars = { ...aiEgressVars({ baseUrl: 'https://api.deepseek.com/v1' }), tool: TOOL_RESULT_MAX_CHARS }
  const list = t('ai.set.dataFlow', vars)
  assert.ok(!list.includes('{'), '还有占位符没替换：' + list)
  for (const n of [DOC_CONTEXT_MAX_CHARS, AI_VAULT_MAX_DOCS, AI_VAULT_SNIPPET_MAX_CHARS, AI_VAULT_CONTEXT_MAX_CHARS, AI_MAX_IMAGES, TOOL_RESULT_MAX_CHARS]) {
    assert.ok(list.includes(String(n)), '文案里应出现数字 ' + n)
  }
  const where = t(vars.local ? 'ai.set.dataFlowLocal' : 'ai.set.dataFlowRemote', vars)
  assert.ok(!vars.local, '这条用例的前提是远程地址')
  assert.ok(where.includes('api.deepseek.com'), '远程结论应带上 host：' + where)
  assert.ok(where.includes('注意') || /note|attention|achtung/i.test(where), '远程结论应是提醒语气：' + where)
  const localLine = t('ai.set.dataFlowLocal', { ...aiEgressVars({ baseUrl: 'http://127.0.0.1:11434/v1' }), tool: TOOL_RESULT_MAX_CHARS })
  assert.ok(!localLine.includes('{'), '本机结论还有占位符：' + localLine)
})

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
