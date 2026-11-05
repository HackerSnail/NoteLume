// find-bar-narrow-pane.test.mjs —— 查找/替换栏在窄窗格内不被裁掉
// 运行：cd src && node tests/find-bar-narrow-pane.test.mjs
//
// 背景：.nl-find-bar 只设 right:24px 不设宽度，栏宽由内容撑开（固定 180px 输入框 + 两个文字按钮）。
// 左右分栏后每个 .nl-pane 变窄，而 .nl-pane 是 overflow-y:auto 的滚动容器（横轴随之变 auto），
// 超出窗格的那一段直接被裁掉，表现为查找框 / 替换框被遮挡。
// 修法三条声明：栏本身 max-width: calc(100% - 36px) + box-sizing:border-box；
// 输入框 flex:1 1 auto + min-width:0（可随窗格收缩，180px 降为基准宽）；行 min-width:0。
// 本文件钉声明层（真 style.css 进 CSSOM 解析后按选择器取值）与标记钩子；
// 像素级几何由仓库外的无头 Chrome 探针另测，结论写进测试报告。

import assert from 'node:assert'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { JSDOM } from 'jsdom'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SRC = path.resolve(HERE, '..')

const cssText = fs.readFileSync(path.join(SRC, 'style.css'), 'utf8')
const dom = new JSDOM('<!doctype html><html><head><style id="app"></style></head><body></body></html>')
dom.window.document.getElementById('app').textContent = cssText
const sheets = [...dom.window.document.styleSheets]

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

// 收集选择器命中的规则 cssText（含 @media 与嵌套规则）。
// 注意：jsdom 给普通样式规则也挂了个空 cssRules，先按 selectorText 命中、再决定是否下钻。
function cssOf(selector) {
  const out = []
  const walk = (rules) => {
    for (const r of rules) {
      if (r.selectorText && r.selectorText.split(',').map((s) => s.trim()).includes(selector)) {
        out.push(r.style.cssText)
      }
      if (r.cssRules && r.cssRules.length) walk(r.cssRules)
    }
  }
  for (const s of sheets) walk(s.cssRules)
  return out
}

function assertDecl(selector, re, label) {
  const blocks = cssOf(selector)
  assert.ok(blocks.length > 0, `CSSOM 里没有 ${selector} 规则`)
  const hit = blocks.some((b) => re.test(b))
  assert.ok(hit, `${selector} 缺「${label}」，实际 ${JSON.stringify(blocks)}`)
  return blocks
}

check('声明：查找栏宽度封顶到窗格（max-width 走 100% 减右侧 24px 与左侧留白）', () => {
  assertDecl('.nl-find-bar', /max-width:\s*calc\(100% - 36px\)/, 'max-width: calc(100% - 36px)')
})

check('声明：查找栏按 border-box 计量（padding 8px 不再额外撑宽）', () => {
  assertDecl('.nl-find-bar', /box-sizing:\s*border-box/, 'box-sizing: border-box')
})

check('宽窗格观感不变：仍绝对定位钉右上、层级与右距原样', () => {
  const blocks = assertDecl('.nl-find-bar', /right:\s*24px/, 'right: 24px')
  assert.ok(blocks.some((b) => /position:\s*absolute/.test(b)), 'position: absolute 丢失')
  assert.ok(blocks.some((b) => /z-index:\s*30/.test(b)), 'z-index: 30 丢失')
})

check('声明：输入框可收缩（flex 1 1 auto + min-width 0），180px 降为基准宽', () => {
  const blocks = assertDecl('.nl-find-input', /flex:\s*1 1 auto/, 'flex: 1 1 auto')
  assert.ok(blocks.some((b) => /min-width:\s*0/.test(b)), '缺 min-width: 0，flex 子项默认不收缩到内容宽以下')
  assert.ok(blocks.some((b) => /(^|;)\s*width:\s*180px/.test(b)), '基准宽 180px 丢失')
})

check('声明：查找行自身也允许收缩（min-width 0）', () => {
  assertDecl('.nl-find-row', /min-width:\s*0/, 'min-width: 0')
})

check('机制留档：窗格是 overflow-y:auto 的裁切容器（遮挡成因）', () => {
  const blocks = assertDecl('.nl-pane', /overflow-y:\s*auto/, 'overflow-y: auto')
  assert.ok(blocks.some((b) => /position:\s*relative/.test(b)), 'position: relative 丢失，查找栏将钉到外层')
})

check('标记钩子：CSS 用到的四个类名由真 DOM 构建代码写出', () => {
  const js = fs.readFileSync(path.join(SRC, 'find-in-doc.js'), 'utf8')
  for (const cls of ['nl-find-bar', 'nl-find-row', 'nl-find-input', 'nl-find-row-replace']) {
    assert.ok(js.includes(cls), `find-in-doc.js 未再生成 .${cls}，该条 CSS 变成空挂`)
  }
  assert.match(js, /bar\.className = 'nl-find-bar'/)
  assert.match(js, /row2\.className = 'nl-find-row nl-find-row-replace'/)
})

check('找全所有面：没有任何规则把输入框宽度写死而不允许收缩', () => {
  // 除基准宽那条外，其它给 .nl-find-input 定宽的选择器（含派生类）都要带 min-width:0
  const hard = [...cssText.matchAll(/([^{}\n]*\.nl-find-input[^{}]*)\{([^}]*)\}/g)]
  assert.ok(hard.length > 0, '未找到任何 .nl-find-input 规则')
  for (const [, sel, body] of hard) {
    const fixed = /(^|;)\s*width:\s*\d+px/.test(body)
    if (!fixed) continue
    assert.ok(/min-width:\s*0/.test(body) || /flex:\s*1 1 auto/.test(body),
      `${sel.trim()} 写了固定宽却没有 min-width:0`)
  }
})

check('找全所有面：内联样式与 JS 模板里不再另设查找栏宽度', () => {
  for (const f of ['find-in-doc.js', 'main.js']) {
    const js = fs.readFileSync(path.join(SRC, f), 'utf8')
    const bad = [...js.matchAll(/bar\.style\.(width|maxWidth)\s*=\s*'[^']*'/g)]
    assert.equal(bad.length, 0, `${f} 里有内联宽度：${bad.map((m) => m[0]).join(' / ')}`)
  }
})

check('边界：替换输入框与查找输入框同类，共用同一收缩声明', () => {
  const js = fs.readFileSync(path.join(SRC, 'find-in-doc.js'), 'utf8')
  assert.match(js, /row2\.style\.display = 'none'/, '替换行应默认隐藏')
  assert.match(js, /replaceInput\.className = 'nl-find-input nl-find-replace-input'/,
    '替换输入框没带 .nl-find-input，拿不到收缩声明')
  // 单独给替换输入框定宽的选择器若存在，也必须允许收缩
  const own = [...cssText.matchAll(/([^{}\n]*\.nl-find-replace-input[^{}]*)\{([^}]*)\}/g)]
  for (const [, sel, body] of own) {
    if (!/(^|;)\s*width:\s*\d+px/.test(body)) continue
    assert.ok(/min-width:\s*0/.test(body) || /flex:\s*1 1 auto/.test(body),
      `${sel.trim()} 写了固定宽却没有 min-width:0`)
  }
})

console.log(`\n结果: ${pass} passed, ${fail} failed`)
if (fail) process.exitCode = 1
