// keymap.test.mjs —— 批次 D 纯逻辑：绑定规范化/解析/匹配/合成/冲突/可读化 + 注册表 + fuzzy（无 DOM）
// 运行：cd src && node tests/keymap.test.mjs

import assert from 'node:assert'
import {
  normalizeBinding,
  parseBinding,
  resolveBinding,
  eventToBinding,
  eventMatches,
  formatBinding,
  effectiveBindings,
  fuzzyMatch,
} from '../keymap.js'
import { createRegistry } from '../commands.js'

let pass = 0, fail = 0
function check(name, fn) {
  try { fn(); console.log(`✅ ${name}`); pass++ }
  catch (e) { console.error(`❌ ${name}: ${e.message}`); fail++ }
}

// —— normalizeBinding ——
check('normalize 统一修饰顺序与大小写', () => {
  assert.strictEqual(normalizeBinding('Shift-Mod-b'), 'Mod-Shift-b')
  assert.strictEqual(normalizeBinding('mod-shift-b'), 'Mod-Shift-b')
  assert.strictEqual(normalizeBinding('Mod-b'), 'Mod-b')
})
check('normalize 拒绝结构性键/空基础键', () => {
  assert.strictEqual(normalizeBinding('Mod-Enter'), null)
  assert.strictEqual(normalizeBinding('Mod-'), null)
  assert.strictEqual(normalizeBinding('Mod-b-x'), null) // 多余段：中段非修饰键
  assert.strictEqual(normalizeBinding('Super-b'), null) // 未知修饰
})

// —— parseBinding：Mod 依平台展开；主修饰要求 ——
check('parse Mod 在 win→Ctrl / mac→Cmd', () => {
  assert.deepStrictEqual(parseBinding('Mod-b', false), { ctrl: true, meta: false, alt: false, shift: false, base: 'b' })
  assert.deepStrictEqual(parseBinding('Mod-b', true), { ctrl: false, meta: true, alt: false, shift: false, base: 'b' })
})
check('parse 无主修饰非法 / Alt 合法', () => {
  assert.strictEqual(parseBinding('b', false), null)
  assert.strictEqual(parseBinding('Shift-b', false), null) // 仅 Shift 不算
  const a = parseBinding('Alt-b', false)
  assert.ok(a && a.alt === true && a.ctrl === false, 'Alt 作主修饰应合法')
})

// —— resolveBinding：跨 Mod/Ctrl 归一，用于冲突比较 ——
check('resolve 使 Mod-b 与 Ctrl-b 在非 mac 归一', () => {
  assert.strictEqual(resolveBinding('Mod-b', false), resolveBinding('Ctrl-b', false))
  assert.strictEqual(resolveBinding('Mod-b', true), 'Cmd-b')
})

// —— eventToBinding：录制 ——
check('eventToBinding 组合还原为逻辑串', () => {
  assert.strictEqual(eventToBinding({ ctrlKey: true, shiftKey: true, altKey: false, metaKey: false, key: 'p' }, false), 'Mod-Shift-p')
  assert.strictEqual(eventToBinding({ ctrlKey: true, shiftKey: false, altKey: false, metaKey: false, key: 'b' }, false), 'Mod-b')
})
check('eventToBinding 拒绝无主修饰与结构性键', () => {
  assert.strictEqual(eventToBinding({ ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, key: 'b' }, false), null)
  assert.strictEqual(eventToBinding({ ctrlKey: true, shiftKey: false, altKey: false, metaKey: false, key: 'Escape' }, false), null)
})

// —— eventMatches ——
check('eventMatches 大小写与修饰严格匹配', () => {
  assert.ok(eventMatches({ ctrlKey: true, key: 'B', shiftKey: false, altKey: false, metaKey: false }, 'Mod-b', false))
  assert.ok(!eventMatches({ ctrlKey: true, shiftKey: true, key: 'b', altKey: false, metaKey: false }, 'Mod-b', false))
})

// —— effectiveBindings：默认 ∪ 覆盖 + 冲突 ——
const CMDS = [{ id: 'a', defaultKey: 'Mod-b' }, { id: 'b', defaultKey: 'Ctrl-b' }, { id: 'c', defaultKey: 'Mod-j' }]
check('effectiveBindings 检出同键冲突且后出现者占 map', () => {
  const { map, conflicts } = effectiveBindings(CMDS, {}, false)
  assert.strictEqual(conflicts.length, 1)
  assert.deepStrictEqual(conflicts[0].ids, ['a', 'b'])
  assert.strictEqual(map.get('Ctrl-b'), 'b')
  assert.strictEqual(map.get('Ctrl-j'), 'c')
})
check('effectiveBindings 空串解绑 / 覆盖改键', () => {
  const { map, conflicts } = effectiveBindings(CMDS, { b: '', a: 'Mod-k' }, false)
  assert.strictEqual(conflicts.length, 0)
  assert.ok(!map.has('Ctrl-b'), 'b 解绑后不应在表')
  assert.strictEqual(map.get('Ctrl-k'), 'a')
})

// —— formatBinding ——
check('formatBinding win 文本 / mac 符号', () => {
  assert.strictEqual(formatBinding('Mod-Shift-p', false), 'Ctrl+Shift+P')
  assert.strictEqual(formatBinding('Mod-Shift-p', true), '⌘⇧P')
})

// —— fuzzyMatch ——
check('fuzzyMatch 子序列命中/不命中/空查询', () => {
  assert.ok(fuzzyMatch('pt', 'print'), 'p..t 应命中')
  assert.strictEqual(fuzzyMatch('pz', 'print'), null, 'p..z 不应命中')
  assert.strictEqual(fuzzyMatch('', 'anything').score, 0)
  assert.ok(fuzzyMatch('ab', 'aXb').score <= fuzzyMatch('ab', 'ab').score, '连续命中得分更高')
})

// —— 注册表 ——
check('registry 注册/查询/分派', () => {
  const r = createRegistry()
  let hit = null
  assert.ok(r.register({ id: 'app.save', title: '保存', category: 'app', defaultKey: 'Mod-s', run: (c) => { hit = c } }))
  assert.strictEqual(r.get('app.save').title, '保存')
  assert.strictEqual(r.listByCategory('app').length, 1)
  assert.ok(r.run('app.save', 'CTX'))
  assert.strictEqual(hit, 'CTX')
  assert.strictEqual(r.run('nope', null), false)
})
check('registry 拒非法 / 插件不得覆盖内置 / removeWhere', () => {
  const r = createRegistry()
  r.register({ id: 'app.x', title: 'X', category: 'app', run() {} })
  assert.strictEqual(r.register({ id: 'app.y', category: 'app', run() {} }), false) // 缺 title
  assert.strictEqual(r.register({ id: 'app.x', title: 'px', category: 'plugin', run() {} }), false) // 插件覆盖内置
  assert.strictEqual(r.register({ id: 'p.a', title: 'A', category: 'plugin', run() {} }), true)
  assert.strictEqual(r.register({ id: 'p.b', title: 'B', category: 'plugin', run() {} }), true)
  assert.strictEqual(r.removeWhere((c) => c.category === 'plugin'), 2)
  assert.strictEqual(r.list().length, 1) // 仅剩内置 app.x
})

console.log(`\n结果：${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
