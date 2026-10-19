// desktop-untouched.test.mjs —— 钉住「web 分支不改桌面代码」这条硬约束（docs/CLAUDE.MD 硬性约束 7）
// 运行：cd server && node tests/desktop-untouched.test.mjs（或根目录 npm run web:test）
//
// 比较对象是 `git diff <merge-base(master,HEAD)> HEAD`，也就是**站在主干肩膀上看 web 侧加了什么**：
// 用三点语义（先求 merge-base）而不是直接 `git diff master HEAD`，因为 web 会定期把 master 合进来
// （方向合法），那些改动不该被算成 web 的违规；反过来 master 上合 web 才是禁止的，那条靠约定与
// cherry-pick 兜，本测试看不到也不该看到（master 树里没有 server/，跑不到这里）。
//
// 为什么要写死一份豁免表而不是"扫一眼 diff"：约束原文说"唯一允许碰桌面的地方是 tauri-bridge.js +
// desktop-gate.js"，但实际分流过程中还有四个桌面文件被碰过（环境判定收口、选择器失败显式化）。
// 与其让文档说一句假话，不如把既成事实连理由一起钉在这里——再加一个文件就得改本测试，评审时看得见。

import assert from 'node:assert'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

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

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
function git(...args) {
  const r = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8' })
  if (r.status !== 0) throw new Error('git ' + args.join(' ') + ' 失败：' + ((r.stderr || r.stdout || '').trim() || '退出码 ' + r.status))
  return (r.stdout || '').replace(/\r/g, '')
}

// 主干引用：本地 master 优先，没有就用 origin/master（别人刚 clone 完时本地分支可能还不存在）
function trunkRef() {
  for (const ref of ['master', 'origin/master']) {
    try {
      git('rev-parse', '--verify', '--quiet', ref)
      return ref
    } catch {
      /* 这个引用不存在，试下一个 */
    }
  }
  return null
}

const TRUNK = trunkRef()
const BASE = TRUNK ? git('merge-base', TRUNK, 'HEAD').trim() : ''
const NAME_STATUS = BASE ? git('diff', '--name-status', BASE, 'HEAD').split('\n').filter(Boolean) : []
const CHANGED = NAME_STATUS.map((line) => {
  const [status, ...rest] = line.split('\t')
  // 重命名是 R100\t旧\t新：两个路径都要算，旧路径上的删除同样算改
  return { status: status[0], paths: rest }
})
const files = () => CHANGED.flatMap((c) => c.paths)

console.log('主干：' + (TRUNK || '（找不到 master / origin/master）') + '；比较基线：' + (BASE ? BASE.slice(0, 7) : '（无）'))

test('拿得到主干与比较基线（拿不到就别假装通过）', () => {
  assert.ok(TRUNK, '仓库里没有 master 也没有 origin/master，本测试无从比较')
  assert.ok(BASE, 'HEAD 与 ' + TRUNK + ' 没有共同祖先？')
  assert.notEqual(BASE, git('rev-parse', 'HEAD').trim(), '比较基线就是 HEAD：当前分支相对主干没有任何改动，这条测试等于没跑')
})

test('diff 非空且确实是 web 侧的活（防"空 diff 假绿"）', () => {
  const f = files()
  assert.ok(f.length > 0, 'web 相对主干零改动？八成是基线取错了')
  assert.ok(f.some((p) => p.startsWith('src/web/')), '改动里找不到 src/web/，不像 web 分支')
  assert.ok(f.some((p) => p.startsWith('server/')), '改动里找不到 server/，不像 web 分支')
})

// —— 零例外禁改：改了就没有"替身"这回事了，网页版会把桌面版一起改坏 ——
const ABSOLUTE_BANNED = [
  { re: /^src\/index\.html$/, why: '桌面 HTML 结构；网页版那份由 server/gen-web-html.mjs 生成到 src/web/index.html' },
  { re: /^src\/style\.css$/, why: '桌面样式；网页版专属样式写 src/web/web.css' },
  { re: /^src\/vite\.config\.js$/, why: '桌面构建配置；网页版走 src/web/vite.config.web.js' },
  { re: /^src-tauri\//, why: 'Rust 后端；网页版的能力由 server/ 的 Node 后端代劳' },
]

function absoluteViolations(paths) {
  const hit = []
  for (const p of paths) {
    for (const b of ABSOLUTE_BANNED) if (b.re.test(p)) hit.push(p + ' —— ' + b.why)
  }
  return hit
}

test('绝对禁改面零命中（index.html / style.css / vite.config.js / src-tauri）', () => {
  const hit = absoluteViolations(files())
  assert.deepEqual(hit, [], '这些桌面文件被改了：\n  ' + hit.join('\n  '))
})

// —— src/*.js（顶层）默认禁改，豁免表就是既成事实的清单 ——
const TOP_LEVEL = /^src\/[^/]+\.js$/
const WAIVERS = {
  'src/tauri-bridge.js': '硬性约束 7 明示的能力入口：invoke / 对话框 / 路径 API 只在这一处接触 @tauri-apps',
  'src/desktop-gate.js': '硬性约束 7 明示的唯一判据出处（isDesktop / hasBackend / desktopOnlyError）',
  'src/main.js': '环境判定收口：window.__TAURI_INTERNALS__ → isDesktop()，tempDir/join 改走 bridge；另把选择器失败显式弹框',
  'src/titlebar.js': '同上：局部的 inTauri 换成 isDesktop()',
  'src/settings-store.js': '同上：局部的 hasTauri() 换成 isDesktop()（浏览器回落 localStorage）',
  'src/daily-capture.js': 'pickFolder() 现在可能 reject（无后端），失败要显式弹框而不是静默继续问后面两项',
}

function topLevelViolations(paths) {
  return paths.filter((p) => TOP_LEVEL.test(p) && !WAIVERS[p])
}

test('src/*.js 顶层文件除豁免表外没被碰过', () => {
  const hit = topLevelViolations(files())
  assert.deepEqual(hit, [], '这些桌面 js 不该被 web 分支改（差异请写进 src/web/ 的替身）：\n  ' + hit.join('\n  '))
})

test('豁免表没有变成空头支票（列了的文件确实还在 diff 里）', () => {
  // 谁把某个豁免文件"改回去"了（比如桌面侧修好了），就该把它从表里删掉，别让豁免越攒越长
  const present = new Set(files())
  const stale = Object.keys(WAIVERS).filter((p) => !present.has(p))
  assert.deepEqual(stale, [], '这些豁免已失效，请从本测试的 WAIVERS 里删掉：\n  ' + stale.join('\n  '))
})

// —— 词条文件：加键放行，改/删既有键要拦 ——
// 词条 diff 里的删除行（--- a/xxx 是文件头，不算删词条）
function localeRemovedLines(diffText) {
  return diffText.split('\n').filter((l) => l.startsWith('-') && !l.startsWith('---'))
}

test('src/locales/ 只加键，没有改动或删除既有词条', () => {
  const removed = localeRemovedLines(git('diff', '--unified=0', BASE, 'HEAD', '--', 'src/locales'))
  assert.deepEqual(removed, [], '网页版可以加词条（如 msg.desktopOnly），但不能改删桌面词条：桌面版共用同一份词表\n  ' + removed.join('\n  '))
})

// —— 下面三条是拿假数据喂上面三个判定，证明它们不是空转的：真数据今天干净，
//    但判定本身要是写错了（正则漏了、过滤反了），这条测试就会先红，而不是闷声放行。
test('判定本身会咬人（合成输入验证三类拦截）', () => {
  assert.ok(absoluteViolations(['src/index.html']).length === 1, 'index.html 该拦下')
  assert.ok(absoluteViolations(['src-tauri/src/lib.rs']).length === 1, 'Rust 侧该拦下')
  assert.deepEqual(absoluteViolations(['src/web/index.html', 'src/web/web.css']), [], 'src/web/ 下的替身是正当产物，不该拦')

  assert.deepEqual(topLevelViolations(['src/brand-new.js']), ['src/brand-new.js'], '新的顶层 js 该拦下')
  assert.ok(topLevelViolations(['src/main.js']).length === 0, '豁免表里的该放行')
  assert.deepEqual(topLevelViolations(['src/web/entry.js', 'src/tests/web-strings.test.mjs', 'src/locales/zh-CN.js']), [],
    'src/web/、src/tests/、src/locales/ 都不是顶层桌面 js，不该拦')

  const fakeDiff = 'diff --git a/src/locales/zh-CN.js b/src/locales/zh-CN.js\n--- a/src/locales/zh-CN.js\n+++ b/src/locales/zh-CN.js\n@@ -1,2 +1,2 @@\n-  \'a.b\': \'旧\',\n+  \'a.b\': \'新\',\n'
  assert.equal(localeRemovedLines(fakeDiff).length, 1, '改词条必带删除行，该拦下')
  assert.deepEqual(localeRemovedLines('+++ b/src/locales/zh-CN.js\n+  \'a.b\': \'新\',\n'), [], '纯加键不该拦')
})

console.log('结果：' + pass + ' passed, ' + fail + ' failed')
if (fail) process.exit(1)
