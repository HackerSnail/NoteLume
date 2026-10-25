// toc.test.mjs —— [[toc]] 目录块：条目收集（纯函数）、开关存取、导出件目录注入（jsdom）
// 运行：cd src && node tests/toc.test.mjs
//
// 覆盖：collectTocEntries 的层级过滤 / 全量 slug 去重 / pos 语义（与 anchor-link.test 同口径）、
// feature-flags 的默认值与坏数据回落、injectToc 的锚点替换 / 条目缩进 / 无标题原样返回。

import assert from 'node:assert'
import { JSDOM } from 'jsdom'
import { parseMarkdown } from '../editor-schema.js'
import { collectTocEntries } from '../toc-block.js'
import { injectToc } from '../site-export.js'
import { normalizeFeatures, getFeatures, setFeature, DEFAULT_FEATURES } from '../feature-flags.js'
import { numberingCss } from '../heading-numbering.js'

// injectToc 走 DOMParser（与 sanitizeHtml 同口径），离线补一份 jsdom
const jsdom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' })
global.DOMParser = jsdom.window.DOMParser
global.Node = jsdom.window.Node
global.Element = jsdom.window.Element
global.HTMLElement = jsdom.window.HTMLElement

let pass = 0, fail = 0
function check(name, fn) {
  try { fn(); console.log(`✅ ${name}`); pass++ }
  catch (e) { console.error(`❌ ${name}: ${e.message}`); fail++ }
}

// —— 条目收集：H4 不进、重名去重跨层级连续 ——
check('collectTocEntries 只取 H1-H3，slug 去重含深层标题', () => {
  const doc = parseMarkdown('# T\n\n## A\n\n### deep\n\n#### h4\n\n## A\n')
  const entries = collectTocEntries(doc)
  assert.deepStrictEqual(entries.map((e) => [e.level, e.slug]), [
    [1, 't'],
    [2, 'a'],
    [3, 'deep'],
    [2, 'a-1'], // 第二个 A：去重序号把 h4 也数进去（slugAllInOrder 按全量标题）
  ])
  // pos 与独立复算一致（跳转语义与锚点表同源）
  const positions = []
  doc.forEach((node, pos) => {
    if (node.type.name === 'heading' && node.attrs.level <= 3) positions.push(pos)
  })
  assert.deepStrictEqual(entries.map((e) => e.pos), positions)
})

check('collectTocEntries 无标题返回空数组', () => {
  assert.deepStrictEqual(collectTocEntries(parseMarkdown('只有正文\n')), [])
})

// —— 开关：默认值 / 坏数据回落 / 单键写 ——
check('feature-flags 默认值与坏数据回落', () => {
  assert.deepStrictEqual(normalizeFeatures(null), DEFAULT_FEATURES)
  assert.deepStrictEqual(normalizeFeatures({ tocBlock: 'yes', junk: 1 }), { ...DEFAULT_FEATURES })
  const store = {
    get: () => ({ features: { emoji: false } }),
    update(patch) { this.doc = { ...this.get(), ...patch } },
  }
  store.get = () => store.doc || { features: { emoji: false } }
  assert.strictEqual(getFeatures(store).emoji, false)
  assert.strictEqual(getFeatures(store).tocBlock, true) // 缺字段补默认
  setFeature(store, 'tocBlock', false)
  assert.strictEqual(store.get().features.tocBlock, false)
  assert.strictEqual(store.get().features.emoji, false) // 同段其他键不丢
  setFeature(store, 'notAKey', true) // 未知键不写入
  assert.strictEqual(store.get().features.notAKey, undefined)
})

// —— 导出件注入：锚点替换 / 缩进 / 无 [[toc]] 或无标题原样返回 ——
check('injectToc 把 toc 锚换成目录，条目层级缩进', () => {
  const html = '<p><span class="nl-wiki nl-wiki-missing" data-target="toc">toc</span></p>' +
    '<h1 id="intro">Intro</h1><h2 id="a">A</h2><h3 id="d">D</h3>'
  const out = injectToc(html)
  assert.ok(!out.includes('nl-wiki'))
  assert.ok(out.includes('class="nl-toc"'))
  assert.ok(out.includes('href="#intro"'))
  assert.ok(/lv2[^>]*href="#a"|href="#a"[^>]*class="lv2"/.test(out))
  assert.ok(/lv3[^>]*href="#d"|href="#d"[^>]*class="lv3"/.test(out))
  assert.ok(out.includes('id="intro"')) // 正文标题原样保留
})

check('injectToc 无 [[toc]] 或无标题时原样返回', () => {
  const noToc = '<h1 id="intro">Intro</h1>'
  assert.strictEqual(injectToc(noToc), noToc)
  const noHead = '<p><span class="nl-wiki" data-target="toc">toc</span></p>'
  assert.strictEqual(injectToc(noHead), noHead)
})

// —— 标题自动编号 CSS（输出层 counter）——
check('numberingCss 按容器前缀产出 H1/H2 编号规则', () => {
  const scoped = numberingCss('.nl-pbody')
  assert.ok(scoped.includes('.nl-pbody { counter-reset: nlh1; }'))
  assert.ok(scoped.includes('.nl-pbody h1::before { content: counter(nlh1) ". "; }'))
  assert.ok(scoped.includes('counter(nlh1) "." counter(nlh2)'))
  assert.ok(!scoped.includes('nlh3')) // 只编 H1/H2
  const bare = numberingCss('')
  assert.ok(bare.includes('body { counter-reset: nlh1; }'))
  assert.ok(bare.includes('h1 { counter-increment: nlh1'))
})

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
