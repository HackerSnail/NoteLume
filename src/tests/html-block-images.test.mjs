// html-block-images.test.mjs —— HTML 块内图片按库内路径加载（DOM 层）
// 运行：cd src && node tests/html-block-images.test.mjs
//
// 后端用 window.__TAURI_INTERNALS__.invoke 打桩，断言命令名与参数形状；
// 灯片夹具手写，与 README 的三列预览表同构。

import assert from 'node:assert'
import { JSDOM } from 'jsdom'

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' })
global.window = dom.window
global.document = dom.window.document
global.Node = dom.window.Node
global.Element = dom.window.Element
global.HTMLElement = dom.window.HTMLElement

let calls = []
const defaultHandler = async (args) => 'data:image/png;base64,' + Buffer.from(args.src).toString('base64')
let handler = defaultHandler
window.__TAURI_INTERNALS__ = {
  invoke(cmd, args) {
    calls.push({ cmd, args })
    return handler(args)
  },
}

const { hydrateBlockImages, retryWhenVisible } = await import('../html-block-images.js')

const CTX = { vaultRoot: '/库', mdRel: 'README.md' }
const flush = () => new Promise((r) => setTimeout(r, 0))

let pass = 0
let fail = 0
async function check(name, fn) {
  calls = []
  handler = defaultHandler
  try {
    await fn()
    pass++
    console.log(`ok  ${name}`)
  } catch (e) {
    fail++
    console.error(`FAIL ${name}: ${e.message}`)
  }
}

// 真实文档里的块一直挂在文档树上；离场的旧元素由用例自己摘掉
function mount(html) {
  const root = document.createElement('div')
  root.innerHTML = html
  document.body.appendChild(root)
  return root
}
function unmount(root) {
  root.remove()
}
function cachedSrc(cache, mdRel, src) {
  return cache.get('/库|' + mdRel + '|' + src)
}

await check('README 三列预览表：逐张按相对路径读库，src 换成 data URI', async () => {
  const root = mount(
    '<table align="center"><tr>' +
      '<td align="center"><img src="img/preview/light.png" alt="浅色主题" width="100%"><br>浅色</td>' +
      '<td align="center"><img src="img/preview/dark.png" alt="暗黑主题" width="100%"><br>暗黑</td>' +
      '<td align="center"><img src="img/preview/vampire.png" alt="Dracula 主题" width="100%"><br>Dracula</td>' +
      '</tr></table>'
  )
  const cache = new Map()
  hydrateBlockImages(root, () => CTX, cache)
  await flush()
  assert.deepStrictEqual(
    calls,
    [
      { cmd: 'read_image_data_uri', args: { vaultRoot: '/库', mdRel: 'README.md', src: 'img/preview/light.png' } },
      { cmd: 'read_image_data_uri', args: { vaultRoot: '/库', mdRel: 'README.md', src: 'img/preview/dark.png' } },
      { cmd: 'read_image_data_uri', args: { vaultRoot: '/库', mdRel: 'README.md', src: 'img/preview/vampire.png' } },
    ],
    '三张图应各读一次，参数与 Rust 命令形状一致'
  )
  const imgs = root.querySelectorAll('img')
  assert.strictEqual(imgs.length, 3)
  for (const img of imgs) {
    assert.ok(img.getAttribute('src').startsWith('data:image/png;base64,'), 'src 应换成 data URI：' + img.getAttribute('src'))
    assert.strictEqual(img.getAttribute('alt') ? true : false, true)
  }
  assert.strictEqual(imgs[0].getAttribute('width'), '100%', '块内原有属性不能被改动')
  unmount(root)
})

await check('远程图：不读库，原样透传并挂 no-referrer', async () => {
  const root = mount('<p><img src="https://example.com/a.png"></p>')
  hydrateBlockImages(root, () => CTX, new Map())
  await flush()
  const img = root.querySelector('img')
  assert.strictEqual(calls.length, 0, '远程图不该走后端')
  assert.strictEqual(img.getAttribute('src'), 'https://example.com/a.png')
  assert.strictEqual(img.referrerPolicy, 'no-referrer')
  unmount(root)
})

await check('大写协议与 data:/blob: 同样透传（协议判定不分大小写）', async () => {
  const root = mount('<img src="HTTPS://example.com/a.png"><img src="data:image/gif;base64,AA"><img src="blob:http://localhost/x">')
  hydrateBlockImages(root, () => CTX, new Map())
  await flush()
  assert.strictEqual(calls.length, 0)
  const imgs = root.querySelectorAll('img')
  assert.strictEqual(imgs[0].referrerPolicy, 'no-referrer')
  assert.strictEqual(imgs[1].getAttribute('src'), 'data:image/gif;base64,AA')
  assert.strictEqual(imgs[2].getAttribute('src'), 'blob:http://localhost/x')
  unmount(root)
})

await check('未打开库：保留相对 src，不调后端', async () => {
  const root = mount('<img src="img/preview/light.png">')
  hydrateBlockImages(root, () => null, new Map())
  await flush()
  assert.strictEqual(calls.length, 0)
  assert.strictEqual(root.querySelector('img').getAttribute('src'), 'img/preview/light.png')
  unmount(root)
})

await check('库上下文缺 mdRel：无从解析，不调后端', async () => {
  const root = mount('<img src="img/preview/light.png">')
  hydrateBlockImages(root, () => ({ vaultRoot: '/库' }), new Map())
  await flush()
  assert.strictEqual(calls.length, 0)
  assert.strictEqual(root.querySelector('img').getAttribute('src'), 'img/preview/light.png')
  unmount(root)
})

await check('读不到图：去掉 src、标 nl-img-missing、title 带原路径', async () => {
  handler = async () => {
    throw new Error('no such file')
  }
  const root = mount('<img src="img/preview/none.png" alt="缺失">')
  hydrateBlockImages(root, () => CTX, new Map())
  await flush()
  const img = root.querySelector('img')
  assert.strictEqual(calls.length, 1)
  assert.strictEqual(img.hasAttribute('src'), false, '破图地址要摘掉')
  assert.ok(img.classList.contains('nl-img-missing'))
  assert.ok(img.title.includes('img/preview/none.png'), 'title 要带原路径：' + img.title)
  assert.strictEqual(img.getAttribute('alt'), '缺失', 'alt 要留着')
  unmount(root)
})

await check('缓存命中：同一图第二次不重复读后端', async () => {
  const cache = new Map()
  const first = mount('<img src="img/preview/light.png">')
  hydrateBlockImages(first, () => CTX, cache)
  await flush()
  unmount(first)
  const second = mount('<img src="img/preview/light.png">')
  hydrateBlockImages(second, () => CTX, cache)
  await flush()
  assert.strictEqual(calls.length, 1, '第二次应走缓存')
  assert.ok(second.querySelector('img').getAttribute('src').startsWith('data:image/png;base64,'))
  unmount(second)
})

await check('缓存按 vault|md|src 建键，写入后端返回值', async () => {
  const cache = new Map()
  const root = mount('<img src="img/preview/light.png">')
  hydrateBlockImages(root, () => CTX, cache)
  await flush()
  assert.strictEqual(cachedSrc(cache, 'README.md', 'img/preview/light.png'), 'data:image/png;base64,aW1nL3ByZXZpZXcvbGlnaHQucG5n')
  unmount(root)
})

await check('换文档后同路径要重读（键含 mdRel）', async () => {
  const cache = new Map()
  const a = mount('<img src="img/a.png">')
  hydrateBlockImages(a, () => CTX, cache)
  await flush()
  unmount(a)
  const b = mount('<img src="img/a.png">')
  hydrateBlockImages(b, () => ({ vaultRoot: '/库', mdRel: '子目录/另一篇.md' }), cache)
  await flush()
  assert.strictEqual(calls.length, 2, '不同文档的同名相对路径是两张图')
  assert.ok(cache.has('/库|子目录/另一篇.md|img/a.png'))
  unmount(b)
})

await check('没有 src 或 src 为空：整张跳过', async () => {
  const root = mount('<img alt="无源"><img src=""><img>')
  hydrateBlockImages(root, () => CTX, new Map())
  await flush()
  assert.strictEqual(calls.length, 0)
  assert.strictEqual(root.querySelectorAll('img[src]').length, 1, '空 src 属性保持原样')
  unmount(root)
})

await check('块在请求返回前重绘：旧 img 已离场，不再落 src', async () => {
  let resolveRead
  handler = () => new Promise((r) => (resolveRead = r))
  const root = mount('<p><img src="img/old.png"></p>')
  const img = root.querySelector('img')
  hydrateBlockImages(root, () => CTX, new Map())
  img.remove()
  resolveRead('data:image/png;base64,T0xE')
  await flush()
  assert.strictEqual(img.getAttribute('src'), 'img/old.png', '离场元素不该被后到的结果改写')
  unmount(root)
})

await check('失败结果晚到且元素已离场：不标缺失态', async () => {
  let rejectRead
  handler = () => new Promise((_, rej) => (rejectRead = rej))
  const root = mount('<p><img src="img/gone.png"></p>')
  const img = root.querySelector('img')
  hydrateBlockImages(root, () => CTX, new Map())
  img.remove()
  rejectRead(new Error('gone'))
  await flush()
  assert.strictEqual(img.hasAttribute('src'), true)
  assert.strictEqual(img.classList.contains('nl-img-missing'), false)
  unmount(root)
})

await check('同一块里远程与相对混排：只读相对那张', async () => {
  const root = mount('<img src="https://example.com/a.png"><img src="img/local.png">')
  hydrateBlockImages(root, () => CTX, new Map())
  await flush()
  assert.deepStrictEqual(calls.map((c) => c.args.src), ['img/local.png'])
  const imgs = root.querySelectorAll('img')
  assert.strictEqual(imgs[0].getAttribute('src'), 'https://example.com/a.png')
  assert.ok(imgs[1].getAttribute('src').startsWith('data:image/png;base64,'))
  unmount(root)
})

// IntersectionObserver 桩：observe() 记下元素，fire() 按「滚进视口」回调一次
function stubObserver() {
  const observers = []
  global.IntersectionObserver = class {
    constructor(cb) {
      this.cb = cb
      this.el = null
    }
    observe(el) {
      this.el = el
      observers.push(this)
    }
    disconnect() {
      this.el = null
    }
    fire() {
      this.cb([{ isIntersecting: true, target: this.el }], this)
    }
  }
  return observers
}

await check('库未就绪：记下原路径，补跑一次即出图并清标记', async () => {
  const root = mount('<img src="img/preview/light.png">')
  let ctx = null
  hydrateBlockImages(root, () => ctx, new Map())
  await flush()
  assert.strictEqual(calls.length, 0)
  const img = root.querySelector('img')
  assert.strictEqual(img.getAttribute('data-nl-src'), 'img/preview/light.png', '没库也要留下原路径')
  ctx = CTX
  hydrateBlockImages(root, () => ctx, new Map())
  await flush()
  assert.strictEqual(calls.length, 1)
  assert.ok(img.getAttribute('src').startsWith('data:image/png;base64,'))
  assert.strictEqual(img.hasAttribute('data-nl-src'), false, '已出图不该再留待重试标记')
  unmount(root)
})

await check('读失败后滚进视口会重试：权限/读盘临时失败不再永久空白', async () => {
  const observers = stubObserver()
  let broken = true
  handler = async (args) => {
    if (broken) throw new Error('Operation not permitted')
    return 'data:image/png;base64,' + Buffer.from(args.src).toString('base64')
  }
  const root = mount('<img src="img/preview/light.png">')
  const cache = new Map()
  hydrateBlockImages(root, () => CTX, cache)
  await flush()
  const img = root.querySelector('img')
  assert.strictEqual(img.hasAttribute('src'), false, '失败先摘破图')
  assert.strictEqual(img.getAttribute('data-nl-src'), 'img/preview/light.png')
  const io = retryWhenVisible(root, () => CTX, cache, hydrateBlockImages)
  assert.strictEqual(observers.length, 1, '块要挂上可见性监听')
  broken = false
  io.fire()
  await flush()
  assert.strictEqual(calls.length, 2, '滚进视口要再读一次')
  assert.ok(img.getAttribute('src').startsWith('data:image/png;base64,'), '重试成功要把图装回来')
  assert.strictEqual(img.classList.contains('nl-img-missing'), false, '成功后要清掉失败占位')
  unmount(root)
})

await check('重试有上限：读不到的图不会被反复回源', async () => {
  stubObserver()
  handler = async () => {
    throw new Error('no such file')
  }
  const root = mount('<img src="img/none.png">')
  const cache = new Map()
  hydrateBlockImages(root, () => CTX, cache)
  await flush()
  const io = retryWhenVisible(root, () => CTX, cache, hydrateBlockImages)
  let fired = 0
  for (let i = 0; i < 6; i++) {
    if (!root.querySelector('img[data-nl-src]')) break
    io.fire()
    await flush()
    fired++
  }
  assert.strictEqual(fired, 4, '第 4 趟只清标记不再回源：' + fired)
  assert.strictEqual(calls.length, 4, '首趟 1 次 + 补跑 3 次')
  assert.strictEqual(root.querySelector('img').hasAttribute('data-nl-src'), false, '放弃后不再留标记')
  unmount(root)
})

await check('没有本地图的块：可见性监听不产生任何后端调用', async () => {
  const observers = stubObserver()
  const root = mount('<p>纯文本块</p>')
  hydrateBlockImages(root, () => CTX, new Map())
  const io = retryWhenVisible(root, () => CTX, new Map(), hydrateBlockImages)
  io.fire()
  await flush()
  assert.strictEqual(observers.length, 1)
  assert.strictEqual(calls.length, 0)
  unmount(root)
})

await check('无 IntersectionObserver 环境：退化成不监听，水合照旧', async () => {
  global.IntersectionObserver = undefined
  const root = mount('<img src="img/local.png">')
  const cache = new Map()
  hydrateBlockImages(root, () => CTX, cache)
  await flush()
  const io = retryWhenVisible(root, () => CTX, cache, hydrateBlockImages)
  io.disconnect()
  assert.strictEqual(calls.length, 1)
  assert.ok(root.querySelector('img').getAttribute('src').startsWith('data:image/png;base64,'))
  unmount(root)
})

await check('补跑时上一趟还在路上：同一张图不重复回源', async () => {
  const observers = stubObserver()
  let resolveRead
  handler = () => new Promise((r) => (resolveRead = r))
  const root = mount('<img src="img/slow.png">')
  const cache = new Map()
  hydrateBlockImages(root, () => CTX, cache)
  const io = retryWhenVisible(root, () => CTX, cache, hydrateBlockImages)
  io.fire()
  io.fire()
  await flush()
  assert.strictEqual(calls.length, 1, '在途的读不该被补跑重复触发')
  resolveRead('data:image/png;base64,U0xPVw==')
  await flush()
  assert.ok(root.querySelector('img').getAttribute('src').startsWith('data:image/png;base64,'))
  assert.strictEqual(root.querySelector('img').hasAttribute('data-nl-src'), false)
  unmount(root)
})

console.log(`\n结果：${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
