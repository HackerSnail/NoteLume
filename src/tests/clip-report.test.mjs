// clip-report.test.mjs —— 扩展后台的结果上报接线（extension/background.js 的 report / savedBody）
// 运行：cd src && node tests/clip-report.test.mjs
//
// 这一层没有 Chrome 就跑不到，构建与单测都不碰它：report 里函数名写错、content/notice.js
// 路径写错、__NL_NOTICE 名字对不上，都只在真实点一次工具栏图标时才炸（未绑定的自由标识符
// 是同步抛错，调用点的 .catch 接不住）。这里用 chrome.* 桩 + jsdom 当被剪页面，把整条
// 链路跑真：真 POST 到桩服务、真 eval 真 notice.js、真把确认条挂进真 DOM。
// 提取器不重跑（另有 clip-extract.test.mjs 覆盖），executeScript 收到 content/extract.js
// 时直接回一份提取结果。截图剪藏那条腿需要真 captureVisibleTab 与 OffscreenCanvas，这里不覆盖。
import assert from 'node:assert'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { JSDOM } from 'jsdom'

const here = path.dirname(fileURLToPath(import.meta.url))
const extDir = path.resolve(here, '../../extension')
const bgSrc = fs.readFileSync(path.join(extDir, 'background.js'), 'utf8')

let pass = 0
let fail = 0
function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => {
      pass++
      console.log('  ok   ' + name)
    })
    .catch((e) => {
      fail++
      console.log('  FAIL ' + name + ' —— ' + ((e && e.message) || e))
    })
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// 桩服务：/health 给两个开关，/clip 收下载荷并回落盘结果（字段与 Rust 的 ClipOutcome 对齐）
function startServer(port) {
  const hits = { clip: [] }
  const server = http.createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: true, hasVault: true, localizeImages: false, fullPageFallback: true, port }))
      return
    }
    if (req.url === '/clip') {
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => {
        hits.clip.push(JSON.parse(body))
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ rel: 'Clippings/2026-10-31-示例.md', title: '示例标题', linked: 2, imagesSaved: 3, imagesFailed: 0 }))
      })
      return
    }
    res.writeHead(404)
    res.end('{}')
  })
  return new Promise((r) => server.listen(port, '127.0.0.1', () => r({ server, hits })))
}

// 一次趟：一个 jsdom 页面 + 一个 chrome 桩 + 装好桩服务的 background.js
async function boot({ serverPort, tab = { id: 7, url: 'https://example.com/a' }, breakAt = null } = {}) {
  const dom = new JSDOM('<!doctype html><html><body><article>正文</article></body></html>', {
    url: 'https://example.com/',
    runScripts: 'outside-only',
  })
  const w = dom.window
  // fetch 借 Node 的：连接失败时 undici 抛的是 Node 那个 realm 的 TypeError，而 errMessage 用
  // instanceof TypeError 认「连不上」，跨 realm 判定为假。真实浏览器里抛的就是页面这一侧的
  // TypeError，所以这里在窗口里重新抛一次，保持同一 realm。
  w.__nodeFetch = (u, o) => globalThis.fetch(u, o)
  w.eval(
    'window.fetch = (u, o) => window.__nodeFetch(u, o).catch((e) => {' +
      ' const t = new TypeError(String((e && e.message) || e)); t.cause = e; throw t })'
  )
  w.AbortController = globalThis.AbortController

  const calls = { insertCSS: [], executeScript: [], notify: [], badge: [], extract: 0 }
  const scripting = {
    insertCSS: async (d) => {
      if (breakAt === 'insertCSS') throw new Error('页面拒绝注入')
      calls.insertCSS.push(d.css)
    },
    executeScript: async (d) => {
      calls.executeScript.push(d)
      if (d.files) {
        if (d.files.includes('content/extract.js')) {
          calls.extract++
          return [
            {
              result: {
                ok: true,
                title: '示例标题',
                url: 'https://example.com/a',
                markdown: '这是正文',
                description: '',
                siteName: 'Example',
                published: '',
                byline: '',
                tags: ['clip'],
                imageUrls: [],
                selectionMarkdown: '',
              },
            },
          ]
        }
        for (const f of d.files) w.eval(fs.readFileSync(path.join(extDir, f), 'utf8'))
        return [{ result: true }]
      }
      return [{ result: d.func(...(d.args || [])) }]
    },
  }
  w.chrome = {
    action: {
      onClicked: { addListener: () => {} },
      setBadgeBackgroundColor: async () => {},
      setBadgeText: async (d) => calls.badge.push(d.text),
    },
    notifications: { create: async (_id, o) => void calls.notify.push(o) },
    storage: {
      sync: {
        get: async (d) => ({ ...d, serverUrl: `http://127.0.0.1:${serverPort}` }),
        set: async () => {},
      },
    },
    tabs: { query: async () => (tab ? [tab] : []), captureVisibleTab: async () => '' },
    scripting,
    runtime: {
      onInstalled: { addListener: () => {} },
      onStartup: { addListener: () => {} },
      onMessage: { addListener: () => {} },
      getURL: (p) => 'chrome-extension://test/' + p,
    },
    contextMenus: { create: () => {}, removeAll: async () => {}, onClicked: { addListener: () => {} } },
    commands: { onCommand: { addListener: () => {} } },
  }
  w.eval(bgSrc)
  return { w, calls }
}

const cases = []
const t = (name, fn) => cases.push([name, fn])

t('整页剪藏成功：系统通知与页面确认条各一条，正文带库内路径与统计', async () => {
  const { server, hits } = await startServer(33991)
  try {
    const { w, calls } = await boot({ serverPort: 33991 })
    await w.clipActiveTab('page')
    await sleep(40)
    assert.strictEqual(hits.clip.length, 1, 'POST 要真打到桩服务')
    assert.strictEqual(calls.notify.length, 1)
    assert.strictEqual(calls.notify[0].title, '已剪藏到 NoteLume')
    const el = w.document.getElementById('nl-clip-notice')
    assert.ok(el, '确认条要挂进真 DOM')
    assert.strictEqual(el.querySelector('.nl-clip-notice-title').textContent, '已剪藏到 NoteLume')
    assert.strictEqual(
      el.querySelector('.nl-clip-notice-body').textContent,
      '示例标题　→　Clippings/2026-10-31-示例.md（3 张图，关联 2 篇）'
    )
    assert.ok(el.classList.contains('nl-clip-on'), '进场类要在下一帧置上')
    assert.strictEqual(calls.badge[calls.badge.length - 1], '', '成功要把徽标清掉')
  } finally {
    server.close()
  }
})

t('注入的三步顺序与载荷：样式 → content/notice.js → show(标题/正文/kind/ms)', async () => {
  const { server } = await startServer(33992)
  try {
    const { w, calls } = await boot({ serverPort: 33992 })
    await w.clipActiveTab('page')
    assert.ok(calls.insertCSS[0].includes('#nl-clip-notice'), '样式得选中确认条本身')
    const legs = calls.executeScript
    const fileLeg = legs.find((d) => d.files && d.files.includes('content/notice.js'))
    // 这些数组 / 对象在窗口那个 realm 里造出来，原型与 Node 侧不同，深比较一律先过一趟 JSON
    assert.strictEqual(JSON.stringify(fileLeg.files), JSON.stringify(['content/notice.js']))
    const funcLeg = legs.filter((d) => d.func).pop()
    assert.ok(legs.indexOf(fileLeg) < legs.indexOf(funcLeg), '先挂脚本再调 show')
    assert.deepStrictEqual(JSON.parse(JSON.stringify(funcLeg.args[0])), {
      title: '已剪藏到 NoteLume',
      body: '示例标题　→　Clippings/2026-10-31-示例.md（3 张图，关联 2 篇）',
      kind: 'ok',
      ms: 4000,
    })
  } finally {
    server.close()
  }
})

t('服务没开：红色确认条留 8 秒，正文是失败原因', async () => {
  const { w, calls } = await boot({ serverPort: 33993 }) // 这个端口没人监听
  await w.clipActiveTab('page')
  await sleep(40)
  assert.strictEqual(calls.insertCSS.length, 1, '失败也要注入样式')
  const el = w.document.getElementById('nl-clip-notice')
  assert.ok(el.classList.contains('nl-clip-bad'), '失败要走红边')
  assert.strictEqual(el.querySelector('.nl-clip-notice-title').textContent, '剪藏失败')
  assert.match(el.querySelector('.nl-clip-notice-body').textContent, /连不上 NoteLume/)
  const funcLeg = calls.executeScript.filter((d) => d.func).pop()
  assert.strictEqual(funcLeg.args[0].kind, 'bad')
  assert.strictEqual(funcLeg.args[0].ms, 8000)
  assert.strictEqual(calls.badge[calls.badge.length - 1], '!', '失败要把徽标点亮')
})

t('没有可注入的文档（内置页面）：只发系统通知，不发任何注入', async () => {
  const { w, calls } = await boot({ serverPort: 33994, tab: null })
  await w.clipActiveTab('page')
  await sleep(20)
  assert.strictEqual(calls.insertCSS.length, 0)
  assert.strictEqual(calls.executeScript.length, 0)
  assert.strictEqual(calls.notify.length, 1)
  assert.strictEqual(calls.notify[0].title, '无法剪藏')
})

t('页面拒绝注入：确认条挂不上也不影响系统通知发出去', async () => {
  const { w, calls } = await boot({ serverPort: 33995, breakAt: 'insertCSS' })
  await w.clipActiveTab('page')
  await sleep(40)
  assert.strictEqual(w.document.getElementById('nl-clip-notice'), null)
  assert.strictEqual(calls.notify.length, 1, '注入失败不能让提示整条消失')
})

t('服务端回空对象：正文退化只剩标题，不出现 undefined', async () => {
  const server = http.createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end('{"ok":true,"hasVault":true,"localizeImages":false,"fullPageFallback":true}')
      return
    }
    let body = ''
    req.on('data', (c) => (body += c))
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end('{}') // 没有 rel / 统计数字
    })
  })
  await new Promise((r) => server.listen(33996, '127.0.0.1', r))
  try {
    const { w } = await boot({ serverPort: 33996 })
    await w.clipActiveTab('page')
    await sleep(40)
    const el = w.document.getElementById('nl-clip-notice')
    assert.strictEqual(el.querySelector('.nl-clip-notice-body').textContent, '示例标题')
  } finally {
    server.close()
  }
})

;(async () => {
  for (const [name, fn] of cases) await test(name, fn)
  console.log(`\n${pass} passed, ${fail} failed`)
  if (fail) process.exit(1)
})()
