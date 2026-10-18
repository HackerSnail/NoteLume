// appearance.test.mjs —— 「设置-外观」纯逻辑回归（不触 DOM）
// 运行：cd src && node tests/appearance.test.mjs
import assert from 'node:assert'
import {
  DEFAULT_APPEARANCE,
  THEME_CHOICES,
  THEME_ICON,
  THEME_COLORS,
  TEXT_COLORS,
  SIDEBAR_RATIO,
  FONT_PRESETS,
  normalizeAppearance,
  clampSidebarRatio,
  appearanceVarPatch,
  applyAppearanceVarPatch,
  applyAppearance,
} from '../appearance-settings.js'

let pass = 0
let fail = 0
function test(name, fn) {
  try {
    fn()
    pass++
    console.log('  ok   ' + name)
  } catch (e) {
    fail++
    console.log('  FAIL ' + name + ' —— ' + ((e && e.message) || e))
  }
}

// 记录 setProperty / removeProperty 的样式桩
function stubStyle() {
  const calls = { set: [], remove: [] }
  return {
    calls,
    setProperty(n, v) {
      calls.set.push([n, v])
    },
    removeProperty(n) {
      calls.remove.push(n)
    },
  }
}

test('null / 非对象输入回落默认值', () => {
  for (const raw of [null, undefined, 42, 'x', []]) {
    assert.deepStrictEqual(normalizeAppearance(raw), normalizeAppearance(null))
  }
  const d = normalizeAppearance(null)
  assert.strictEqual(d.theme, 'light')
  assert.deepStrictEqual(d.colors, {})
  assert.deepStrictEqual(d.textColors, {})
  assert.strictEqual(d.fontFamily, '')
  assert.strictEqual(d.fontSize, 17)
  assert.strictEqual(d.lineHeight, 1.75)
  assert.strictEqual(d.autoWrap, true)
  assert.strictEqual(d.sidebarRatio, null)
})

test('合法值原样保留（hex 统一小写）', () => {
  const s = normalizeAppearance({
    theme: 'vampire',
    colors: { bgPrimary: '#ABCDEF' },
    textColors: { link: '#123456' },
    fontFamily: '  Georgia, serif  ',
    fontSize: 20,
    lineHeight: 1.9,
    autoWrap: false,
    sidebarRatio: 0.3,
  })
  assert.strictEqual(s.theme, 'vampire')
  assert.deepStrictEqual(s.colors, { bgPrimary: '#abcdef' })
  assert.deepStrictEqual(s.textColors, { link: '#123456' })
  assert.strictEqual(s.fontFamily, 'Georgia, serif')
  assert.strictEqual(s.fontSize, 20)
  assert.strictEqual(s.lineHeight, 1.9)
  assert.strictEqual(s.autoWrap, false)
  assert.strictEqual(s.sidebarRatio, 0.3)
})

test('脏数据：坏主题名 / 非数字 / 越界 / 坏颜色一律回落或夹紧', () => {
  const s = normalizeAppearance({
    theme: 'neon',
    colors: { bgPrimary: 'red', textPrimary: '#12345', accentColor: '#00ff0088' },
    fontSize: 'abc',
    lineHeight: 9,
    sidebarRatio: 0.99,
    fontFamily: 123,
  })
  assert.strictEqual(s.theme, 'light') // 不在 THEME_CHOICES 里
  assert.deepStrictEqual(s.colors, {}) // 三位 / 命名色 / 八位都不要
  assert.strictEqual(s.fontSize, 17)
  assert.strictEqual(s.lineHeight, 2.2) // 夹到上界
  assert.strictEqual(s.sidebarRatio, SIDEBAR_RATIO.max)
  assert.strictEqual(s.fontFamily, '') // 非字符串回落
  assert.strictEqual(normalizeAppearance({ fontSize: 1 }).fontSize, 12) // 夹到下界
  assert.strictEqual(normalizeAppearance({ sidebarRatio: 0.01 }).sidebarRatio, SIDEBAR_RATIO.min)
})

test('autoWrap 只有显式 false 算关', () => {
  assert.strictEqual(normalizeAppearance({}).autoWrap, true)
  assert.strictEqual(normalizeAppearance({ autoWrap: true }).autoWrap, true)
  assert.strictEqual(normalizeAppearance({ autoWrap: false }).autoWrap, false)
  assert.strictEqual(normalizeAppearance({ autoWrap: 'no' }).autoWrap, true)
})

test('归一化幂等：stringify(normalize(x)) 再 normalize 不变', () => {
  const raw = { theme: 'dark', colors: { accentColor: '#ff0000' }, fontSize: 19, sidebarRatio: 0.25 }
  const once = normalizeAppearance(raw)
  assert.deepStrictEqual(normalizeAppearance(JSON.parse(JSON.stringify(once))), once)
})

test('变量补丁：无覆盖时 12 个颜色变量全进 remove，排版变量总有值', () => {
  const patch = appearanceVarPatch(normalizeAppearance(null))
  const colorVars = [...THEME_COLORS, ...TEXT_COLORS].map((d) => d.varName)
  assert.deepStrictEqual(patch.remove.slice().sort(), colorVars.concat(['--editor-font-family']).sort())
  assert.deepStrictEqual(patch.set, {
    '--editor-font-size': '17px',
    '--editor-line-height': '1.75',
    '--editor-white-space': 'pre-wrap',
  })
})

test('变量补丁：覆盖的颜色 / 字体进 set，未覆盖的仍进 remove', () => {
  const patch = appearanceVarPatch({
    colors: { bgPrimary: '#112233' },
    textColors: { code: '#aabbcc' },
    fontFamily: "'KaiTi', serif",
    fontSize: 21,
    lineHeight: 1.8,
    autoWrap: false,
  })
  assert.strictEqual(patch.set['--bg-primary'], '#112233')
  assert.strictEqual(patch.set['--text-code'], '#aabbcc')
  assert.strictEqual(patch.set['--editor-font-family'], "'KaiTi', serif")
  assert.strictEqual(patch.set['--editor-font-size'], '21px')
  assert.strictEqual(patch.set['--editor-line-height'], '1.8')
  assert.strictEqual(patch.set['--editor-white-space'], 'pre') // 关换行
  assert.ok(patch.remove.includes('--accent-color')) // 没覆盖的仍在 remove
  assert.ok(!patch.remove.includes('--bg-primary'))
})

test('applyAppearanceVarPatch 先删后写，写进传入的样式对象', () => {
  const style = stubStyle()
  applyAppearanceVarPatch(style, {
    set: { '--editor-font-size': '18px' },
    remove: ['--bg-primary', '--text-editor'],
  })
  assert.deepStrictEqual(style.calls.remove, ['--bg-primary', '--text-editor'])
  assert.deepStrictEqual(style.calls.set, [['--editor-font-size', '18px']])

  const style2 = stubStyle()
  applyAppearance(style2, { colors: { accentColor: '#0a0b0c' } })
  const setMap = new Map(style2.calls.set)
  assert.strictEqual(setMap.get('--accent-color'), '#0a0b0c')
  assert.strictEqual(setMap.get('--editor-white-space'), 'pre-wrap')
  assert.ok(style2.calls.remove.includes('--bg-primary'))
})

test('clampSidebarRatio 夹在 [min, max]', () => {
  assert.strictEqual(clampSidebarRatio(0.5), SIDEBAR_RATIO.max)
  assert.strictEqual(clampSidebarRatio(0.1), SIDEBAR_RATIO.min)
  assert.strictEqual(clampSidebarRatio(0.22), 0.22)
  assert.strictEqual(clampSidebarRatio('x'), SIDEBAR_RATIO.def)
})

test('主题选项与图标齐全（含 system）', () => {
  assert.deepStrictEqual(THEME_CHOICES, ['light', 'dark', 'vampire', 'system'])
  for (const name of THEME_CHOICES) assert.ok(THEME_ICON[name], name + ' 缺图标')
})

test('字体预设：默认项为空栈，其余非空且带词条键', () => {
  assert.strictEqual(FONT_PRESETS[0].name, '')
  const names = new Set()
  for (const p of FONT_PRESETS) {
    assert.ok(typeof p.name === 'string')
    assert.ok(p.labelKey.startsWith('ap.font'), p.labelKey)
    names.add(p.name)
  }
  assert.strictEqual(names.size, FONT_PRESETS.length) // 无重复预设
})

test('颜色定义表：key 唯一，变量名带 -- 前缀', () => {
  for (const defs of [THEME_COLORS, TEXT_COLORS]) {
    const keys = defs.map((d) => d.key)
    assert.strictEqual(new Set(keys).size, keys.length)
    for (const d of defs) {
      assert.ok(d.varName.startsWith('--'), d.varName)
      assert.ok(d.key.length > 0)
    }
  }
})

test('DEFAULT_APPEARANCE 与 normalizeAppearance(null) 一致', () => {
  assert.deepStrictEqual(normalizeAppearance(null), normalizeAppearance(DEFAULT_APPEARANCE))
})

console.log('结果：' + pass + ' passed, ' + fail + ' failed')
if (fail) process.exit(1)
