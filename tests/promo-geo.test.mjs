// promo-geo.test.mjs —— 官网落地页的 GEO 接线（index.html，lumenote-promo-page 分支）
// 运行：node tests/promo-geo.test.mjs
//
// 背景：落地页按 docs/NoteLume文溯GEO-优化提示词手册.md 做过一轮 GEO 改造——head 元信息、
// JSON-LD（Organization / WebSite / WebPage / SoftwareApplication / FAQPage / HowTo）、
// 首屏产品定义句、能力清单四组、竞品对比表、上手五步、十条 FAQ，五语言词条同步。
// 这类改造最容易坏在三个地方，本文件逐条钉住：
//   一、schema 与页面可见文案漂移——搜索引擎明确要求 FAQPage / HowTo 标记反映可见内容，
//       不一致轻则丢富摘要，重被判为误导性结构化数据；
//   二、五语言词条漏键或数组长度不齐——setPromoLang 按下标取词，缺一项就渲染成 undefined；
//   三、非中文词条里残留中文——翻译时抄漏一句，英文页面夹一条中文问答。
// 落地页是单文件、无构建，所以这里不引 jsdom，只用正则取文本 + 直接 eval 词条块。

import assert from 'node:assert'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
// index.html 是 CRLF（Windows 手改的文件），正则里的 \n 得先归一，否则整块匹配不上
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8').replace(/\r\n/g, '\n')

let pass = 0
let fail = 0
function check(name, fn) {
  try {
    fn()
    console.log(`✅ ${name}`)
    pass++
  } catch (e) {
    console.error(`❌ ${name}: ${e.message}`)
    fail++
  }
}

const strip = (s) => s.replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim()
const attrOf = (re) => {
  const m = re.exec(html)
  return m ? m[1] : null
}
// 取某个 id 的 section 到它后面第一个 </section> 之间的片段
function sectionSlice(id) {
  const start = html.indexOf(`id="${id}"`)
  assert.ok(start > 0, `找不到 #${id}`)
  const end = html.indexOf('</section>', start)
  return html.slice(start, end)
}

// —— 词条块：直接 eval 出五份字典，后面几条检查都要用 ——
function loadDicts() {
  const start = html.indexOf('var I18N = (function () {')
  assert.ok(start > 0, '找不到 I18N 字典块')
  const end = html.indexOf('\n})();', start)
  assert.ok(end > start, 'I18N 字典块没有收口')
  const src = html.slice(start, end + '\n})();'.length)
  const win = {}
  return new Function('window', `${src}\nreturn I18N;`)(win)
}
const I18N = loadDicts()
const LANGS = ['zh-CN', 'zh-TW', 'en', 'fr', 'de']
const GEO_KEYS = ['navCompare', 'navFaq', 'metaDesc', 'appDesc', 'featList', 'heroDef', 'heroDefSentence',
  'hlEyebrow', 'hlH2', 'capEyebrow', 'capH2', 'capLead', 'capH3', 'capP',
  'cmpEyebrow', 'cmpH2', 'cmpLead', 'cmpCaption', 'cmpHead', 'cmpDim', 'cmpRow', 'cmpNote',
  'cmpWho', 'cmpSceneH3', 'cmpSceneP', 'qsEyebrow', 'qsH2', 'qsT', 'qsD',
  'faqEyebrow', 'faqH2', 'faqQ', 'faqA']

check('head：GEO 元信息一项不缺（canonical / robots / OG / Twitter）', () => {
  const need = [
    ['title', /<title>([^<]+)<\/title>/],
    ['description', /<meta name="description" content="([^"]+)">/],
    ['robots', /<meta name="robots" content="([^"]+)">/],
    ['canonical', /<link rel="canonical" href="([^"]+)">/],
    ['og:url', /<meta property="og:url" content="([^"]+)">/],
    ['og:site_name', /<meta property="og:site_name" content="([^"]+)">/],
    ['og:locale', /<meta property="og:locale" content="([^"]+)">/],
    ['og:image:alt', /<meta property="og:image:alt" content="([^"]+)">/],
    ['twitter:image:alt', /<meta name="twitter:image:alt" content="([^"]+)">/]
  ]
  for (const [name, re] of need) assert.ok(attrOf(re), `缺 ${name}`)
  assert.equal(attrOf(/<link rel="canonical" href="([^"]+)">/), attrOf(/<meta property="og:url" content="([^"]+)">/),
    'canonical 与 og:url 不是同一个地址')
  assert.match(attrOf(/<meta name="robots" content="([^"]+)">/), /index/)
})

check('head：description 长度在 100–180 字之间（手册要求 120–160）', () => {
  const d = attrOf(/<meta name="description" content="([^"]+)">/)
  assert.ok(d.length >= 100 && d.length <= 180, `实为 ${d.length} 字`)
})

check('OG 图：og:image:width / height 与图片真实尺寸一致', () => {
  const url = attrOf(/<meta property="og:image" content="([^"]+)">/)
  const m = /@master\/(.+)$/.exec(url)
  if (!m) { console.log('   （og:image 不指仓库内文件，跳过尺寸核对）'); return }
  const file = path.join(ROOT, m[1])
  if (!fs.existsSync(file)) { console.log(`   （${m[1]} 不在本地，跳过）`); return }
  const b = fs.readFileSync(file)
  assert.equal(b.slice(1, 4).toString('ascii'), 'PNG', 'og:image 指向的不是 PNG')
  const w = b.readUInt32BE(16), h = b.readUInt32BE(20)
  assert.equal(Number(attrOf(/<meta property="og:image:width" content="([^"]+)">/)), w, `og:image:width 应为 ${w}`)
  assert.equal(Number(attrOf(/<meta property="og:image:height" content="([^"]+)">/)), h, `og:image:height 应为 ${h}`)
})

check('head：title 带品类词与差异词，不再只有产品名', () => {
  const t = attrOf(/<title>([^<]+)<\/title>/)
  assert.match(t, /Markdown 编辑器/, 'title 缺品类词')
  assert.match(t, /双链|知识图谱/, 'title 缺差异关键词')
  assert.ok(t.length <= 40, `title 过长：${t.length}`)
})

check('JSON-LD：@graph 六个节点齐，且不编造评分', () => {
  const raw = attrOf(/<script type="application\/ld\+json" id="ld-json">\n([\s\S]*?)\n<\/script>/)
  assert.ok(raw, '找不到 ld+json 块')
  const data = JSON.parse(raw)
  const types = data['@graph'].map((n) => n['@type'])
  for (const want of ['Organization', 'WebSite', 'WebPage', 'SoftwareApplication', 'FAQPage', 'HowTo']) {
    assert.ok(types.includes(want), `缺 ${want} 节点`)
  }
  const app = data['@graph'].find((n) => n['@type'] === 'SoftwareApplication')
  assert.equal(app.aggregateRating, undefined, '没有真实评分就不要写 aggregateRating（虚标富摘要会被判误导）')
  assert.equal(app.offers.price, '0')
  assert.match(app.license, /apache\.org\/licenses\/LICENSE-2\.0/i)
  assert.ok(app.codeRepository && app.downloadUrl && app.operatingSystem && app.softwareVersion, '应用节点缺必要字段')
  assert.equal(app.featureList.length, 12)
  return data
})

const LD = JSON.parse(attrOf(/<script type="application\/ld\+json" id="ld-json">\n([\s\S]*?)\n<\/script>/))
const faqSchema = LD['@graph'].find((n) => n['@type'] === 'FAQPage')
const howtoSchema = LD['@graph'].find((n) => n['@type'] === 'HowTo')

check('schema 与可见 FAQ 逐条同文（十条问答，问题与答案都比）', () => {
  const block = sectionSlice('faq')
  const pairs = [...block.matchAll(/<summary>([\s\S]*?)<\/summary>\s*<div class="a">([\s\S]*?)<\/div>/g)]
    .map((m) => [strip(m[1]), strip(m[2])])
  assert.equal(pairs.length, 10, `可见 FAQ ${pairs.length} 条，schema ${faqSchema.mainEntity.length} 条`)
  assert.equal(faqSchema.mainEntity.length, 10)
  pairs.forEach(([q, a], i) => {
    assert.equal(faqSchema.mainEntity[i].name, q, `第 ${i + 1} 条问题不同文`)
    assert.equal(faqSchema.mainEntity[i].acceptedAnswer.text, a, `第 ${i + 1} 条答案不同文`)
  })
})

check('schema 与可见 HowTo 逐条同文（五步标题与正文）', () => {
  const block = sectionSlice('quickstart')
  const steps = [...block.matchAll(/<li>\s*<h3>([\s\S]*?)<\/h3>\s*<p>([\s\S]*?)<\/p>\s*<\/li>/g)]
    .map((m) => [strip(m[1]), strip(m[2])])
  assert.equal(steps.length, 5, `可见步骤 ${steps.length} 条`)
  steps.forEach(([name, text], i) => {
    assert.equal(howtoSchema.step[i].name, name, `第 ${i + 1} 步标题不同文`)
    assert.equal(howtoSchema.step[i].text, text, `第 ${i + 1} 步正文不同文`)
    assert.equal(howtoSchema.step[i].position, i + 1)
  })
})

check('标题层级：一个 h1，每个内容段各有一个 h2', () => {
  assert.equal((html.match(/<h1[\s>]/g) || []).length, 1, 'h1 应当恰好一个')
  for (const id of ['features', 'demo', 'capabilities', 'highlights', 'compare', 'quickstart', 'faq', 'changelog']) {
    const block = sectionSlice(id)
    assert.equal((block.match(/<h2[\s>]/g) || []).length, 1, `#${id} 的 h2 数量不是 1`)
  }
  // H1 里要带得上品类词（手册提示词 2：AI 更爱引用有明确定义的标题）
  const h1 = strip(attrOf(/(<h1[\s\S]*?<\/h1>)/) || '')
  assert.match(h1, /Markdown 编辑器/, 'h1 缺品类词')
})

check('新段落齐备：能力四组、对比表八行、场景三条、FAQ 十条 details', () => {
  assert.equal((sectionSlice('capabilities').match(/<div class="cap">/g) || []).length, 4)
  assert.equal((sectionSlice('compare').match(/<tr><th scope="row">/g) || []).length, 8)
  assert.equal((sectionSlice('compare').match(/<div class="scene">/g) || []).length, 3)
  assert.equal((sectionSlice('faq').match(/<details>/g) || []).length, 10)
})

check('内部链接：导航新增的两条锚点在页内都有落点', () => {
  for (const id of ['compare', 'faq', 'capabilities', 'quickstart']) {
    assert.ok(html.includes(`id="${id}"`), `缺 #${id}`)
  }
  for (const href of ['#compare', '#faq']) {
    assert.ok(html.includes(`href="${href}"`), `导航缺 ${href} 入口`)
  }
})

check('五语言词条：GEO 新键一个不缺，数组长度与 zh-CN 对齐', () => {
  const base = I18N['zh-CN']
  for (const lang of LANGS) {
    const t = I18N[lang]
    assert.ok(t, `缺语言字典 ${lang}`)
    for (const k of GEO_KEYS) {
      assert.ok(t[k] !== undefined && t[k] !== '', `${lang} 缺词条 ${k}`)
      if (Array.isArray(base[k])) {
        assert.equal(t[k].length, base[k].length, `${lang}.${k} 长度 ${t[k].length}，zh-CN 为 ${base[k].length}`)
      }
    }
    t.cmpRow.forEach((row, i) => assert.equal(row.length, 3, `${lang} 对比表第 ${i + 1} 行不是三格`))
    for (const k of ['faqQ', 'faqA', 'qsT', 'qsD', 'capH3', 'capP', 'featList', 'cmpSceneH3', 'cmpSceneP', 'cmpWho']) {
      assert.ok(Array.isArray(t[k]), `${lang}.${k} 不是数组`)
      t[k].forEach((v, i) => assert.ok(String(v).trim().length > 0, `${lang}.${k}[${i}] 是空的`))
    }
  }
})

check('词条形状：setPromoLang 按下标取词的几组长度互相对得上', () => {
  for (const lang of LANGS) {
    const t = I18N[lang]
    assert.equal(t.faqQ.length, t.faqA.length, `${lang} 问答数不等`)
    assert.equal(t.qsT.length, t.qsD.length, `${lang} 步骤标题与正文数不等`)
    assert.equal(t.cmpDim.length, t.cmpRow.length, `${lang} 维度名与行数不等`)
    assert.equal(t.capH3.length, t.capP.length, `${lang} 分组标题与正文数不等`)
    assert.equal(t.cmpWho.length, t.cmpSceneH3.length)
    assert.equal(t.cmpSceneP.length, t.cmpSceneH3.length)
    assert.equal(t.faqQ.length, faqSchema.mainEntity.length, `${lang} 问答数与 zh-CN schema 条数不等`)
  }
})

check('非中文词条不夹中文（en / fr / de 三份里不该有 CJK）', () => {
  for (const lang of ['en', 'fr', 'de']) {
    const t = I18N[lang]
    for (const k of GEO_KEYS) {
      const text = Array.isArray(t[k]) ? t[k].flat().join(' | ') : String(t[k])
      const hit = text.match(/[\u4e00-\u9fff]+/g)
      assert.ok(!hit, `${k} 残留中文：${hit ? hit.slice(0, 3).join(' / ') : ''}`)
    }
  }
})

check('默认语言可读：不执行 JS 时页面是 zh-CN 正文与 zh-CN schema', () => {
  assert.match(html, /<html lang="zh-CN">/)
  assert.ok(sectionSlice('faq').includes('NoteLume 是什么？'), '静态 FAQ 首条不是中文')
  assert.equal(faqSchema.inLanguage, 'zh-CN')
  assert.equal(howtoSchema.inLanguage, 'zh-CN')
  assert.equal(LD['@graph'].find((n) => n['@type'] === 'WebSite').inLanguage, 'zh-CN')
})

check('运行时同步：切语言会重写 meta 与 ld+json（函数存在且被调用）', () => {
  assert.match(html, /function syncGeo\(t, lang\)/)
  assert.match(html, /syncGeo\(t, lang\);/)
  // 每个字典都得备齐 syncGeo 要读的字段，否则切语言后 schema 被写成 undefined
  for (const lang of LANGS) {
    const t = I18N[lang]
    for (const k of ['metaDesc', 'title', 'appDesc', 'featList', 'faqQ', 'faqA', 'qsT', 'qsD', 'qsH2']) {
      assert.ok(t[k], `${lang} 缺 ${k}，syncGeo 会写出 undefined`)
    }
  }
})

console.log(`\n结果: ${pass} passed, ${fail} failed`)
if (fail) process.exitCode = 1
