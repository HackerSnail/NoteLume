// serve.mjs —— 网页版的 Node 后端入口：HTTP 路由 + 静态伺服
//
// 三条 API：POST /api/invoke（cmd -> handler）、GET /api/browse（目录浏览器）、GET /api/health、POST /api/heartbeat。
// 其余 GET 走静态伺服 server/dist（构建产物），找不到文件回 index.html。
//
// 默认只绑 127.0.0.1（--host 0.0.0.0 可改，仅容器部署场景用）。API 路由本身零依赖（只用 node:http / fs / path / os / child_process）；
// 唯一例外是网页沙盒的 Word 导入解析（src/docxCommands.mjs + src/docxOoxml.mjs）引入的两个同步解析库：adm-zip / fast-xml-parser。
// 参数：--sandbox（会话工作区）/ --port / --host（默认 127.0.0.1，容器部署时传 0.0.0.0）/ --api-only（只出 API，静态交给 vite dev）/ --open（起服务后开浏览器）。
//
// sessionId 从请求头 x-notelume-session 取；invoke 与 browse 都按它落监狱（沙盒模式）或忽略（本机模式）。

import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dispatch } from './src/router.mjs'
import { browse } from './src/browse.mjs'
import { configure, cfg, jailRoot, scratchRoot, defaultVaultRoot, pruneSessions, DIST_DIR } from './src/paths.mjs'
import { langFor } from './src/uiLang.mjs'
import { touch, sweepIdle } from './src/sessions.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
// vite 以 root=src 构建、入口是 src/web/index.html，产物路径保留成 dist/web/index.html。
// base './' 让 html 里的资源写成 ../assets/*；把这份 html 当作 `/` 返回时，../assets 归一化成 /assets，正好命中真实文件。
// 兼容 dist/index.html（万一以后调整了 root/输入位置）。
const ENTRY_HTML = [path.join(DIST_DIR, 'web', 'index.html'), path.join(DIST_DIR, 'index.html')].find((p) =>
  fs.existsSync(p),
)
const VERSION = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(HERE, 'package.json'), 'utf8')).version || '0.0.0'
  } catch {
    return '0.0.0'
  }
})()

const argv = process.argv.slice(2)
const hasFlag = (n) => argv.includes('--' + n)
function flagValue(name, dflt) {
  const i = argv.indexOf('--' + name)
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : dflt
}

const SANDBOX = hasFlag('sandbox')
const API_ONLY = hasFlag('api-only')
const PORT = Number(flagValue('port', API_ONLY ? 1430 : 1420))
const HOST = flagValue('host', '127.0.0.1')
// 会话空闲多久后被销毁（关浏览器 → 心跳停 → 超这个时长即清）。默认 180s，明显大于后台标签页限流间隔。
const IDLE_TTL_MS = Number(flagValue('idle-ttl', 180000))
const SWEEP_MS = 30000

configure({ sandbox: SANDBOX })
const removed = pruneSessions()
if (removed.length) console.log(`[serve] 清理了 ${removed.length} 个过期会话工作区`)

/** 演示库首屏：从 default-vault 里挑首页作为 lastFile */
function demoEntry(sid) {
  if (cfg.mode !== 'sandbox') return { vaultRoot: null, file: null }
  const vault = defaultVaultRoot(sid)
  if (!vault) return { vaultRoot: null, file: null }
  let names = []
  try {
    names = fs
      .readdirSync(vault)
      .filter((n) => n.toLowerCase().endsWith('.md'))
      .sort()
  } catch {
    /* 灌入失败等：留空，首屏走空态 */
  }
  // 首屏要落在介绍页上：按字母序取第一篇会开到某篇语法示例（实测拿到的是 code-math.md），
  // 访客第一眼看到的就不是「这里能做什么」。库在顶层，basename 就是库内相对路径。
  const home = names.find((n) => /^(home|index|readme)\.md$/i.test(n)) || names[0] || null
  return { vaultRoot: vault, file: home }
}

function readBody(req, limit = 8 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (c) => {
      size += c.length
      if (size > limit) {
        reject(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function json(res, code, obj) {
  const text = JSON.stringify(obj)
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
  res.end(text)
}

function sidOf(req) {
  const raw = req.headers['x-notelume-session']
  return typeof raw === 'string' ? raw : ''
}

/** ctx：本机模式 jail=null；沙盒模式 jail=该会话工作区（顺带首访灌演示库）。任何请求都算一次活跃 */
function makeCtx(req) {
  const sid = sidOf(req)
  touch(sid) // 关浏览器销毁：活跃登记，后台定时器据此扫掉久无活动的会话
  const jail = jailRoot(sid) // 沙盒返回工作区根并保证 vault 就位；本机返回 null
  return { sid, jail }
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json; charset=utf-8',
}

function serveStatic(req, res, urlPath) {
  if (API_ONLY) {
    json(res, 404, { ok: false, error: 'api-only 模式不伺服静态文件，请用 vite dev 打开页面' })
    return
  }
  if (!fs.existsSync(DIST_DIR)) {
    res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' })
    res.end('尚未构建网页产物：先运行 npm run web:build 生成 server/dist')
    return
  }
  let rel = decodeURIComponent(urlPath.split('?')[0])
  if (rel === '/' || rel === '') rel = path.sep + (ENTRY_HTML ? path.relative(DIST_DIR, ENTRY_HTML) : 'index.html')
  // 防目录穿越：拼到 DIST_DIR 后必须仍在其中
  const target = path.join(DIST_DIR, path.normalize(rel).replace(/^([/\\])+/, ''))
  const send = (p) => {
    fs.readFile(p, (err, buf) => {
      if (err) {
        res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('404 not found')
        return
      }
      res.writeHead(200, {
        'content-type': MIME[path.extname(p).toLowerCase()] || 'application/octet-stream',
        // 本地试用：入口 html 不缓存，避免改了前端后浏览器还端着旧 bundle（资源文件名带 hash，本不受影响）。
        'cache-control': 'no-store',
      })
      res.end(buf)
    })
  }
  if (target.startsWith(DIST_DIR) && fs.existsSync(target) && fs.statSync(target).isFile()) {
    send(target)
    return
  }
  // 找不到真实文件：回 SPA 入口
  send(ENTRY_HTML || path.join(DIST_DIR, 'index.html'))
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://${HOST}:${PORT}`)
  const p = u.pathname
  try {
    if (req.method === 'POST' && p === '/api/invoke') {
      let cmd = ''
      let params = {}
      try {
        const body = JSON.parse((await readBody(req)) || '{}')
        cmd = String(body.cmd || '')
        params = body.params || {}
      } catch (e) {
        json(res, 200, { ok: false, error: '[bad_request] ' + e.message })
        return
      }
      const ctx = makeCtx(req)
      const out = dispatch(ctx, cmd, params)
      json(res, 200, out)
      return
    }

    if (req.method === 'GET' && p === '/api/browse') {
      const ctx = makeCtx(req)
      const abs = u.searchParams.get('path') || ''
      const wantFiles = u.searchParams.get('files') === '1'
      try {
        json(res, 200, { ok: true, result: browse(abs, { jail: ctx.jail, wantFiles }) })
      } catch (e) {
        json(res, 200, { ok: false, error: String((e && e.message) || e) })
      }
      return
    }

    if (req.method === 'GET' && p === '/api/health') {
      const sid = sidOf(req)
      const demo = demoEntry(sid)
      json(res, 200, {
        ok: true,
        mode: cfg.mode,
        version: VERSION,
        lang: langFor(sid),
        scratchDir: scratchRoot(sid),
        demo: { vaultRoot: demo.vaultRoot, file: demo.file },
      })
      return
    }

    if (req.method === 'POST' && p === '/api/heartbeat') {
      touch(sidOf(req)) // 沙盒下前端定时打点：保持会话不被扫掉（不建 jail，不灌库）
      json(res, 200, { ok: true })
      return
    }

    if (req.method === 'GET' || req.method === 'HEAD') {
      serveStatic(req, res, p)
      return
    }

    json(res, 405, { ok: false, error: 'method not allowed' })
  } catch (e) {
    json(res, 200, { ok: false, error: String((e && e.message) || e) })
  }
})

server.listen(PORT, HOST, () => {
  const line = `NoteLume 网页版已启动： http://${HOST}:${PORT}/  （模式 ${cfg.mode}${API_ONLY ? '，仅 API' : ''}）`
  console.log(line)
  if (SANDBOX) console.log('[serve] 沙盒模式：每个访客一份临时工作区，只绑 ' + HOST)
  if (!API_ONLY && hasFlag('open')) openBrowser(`http://${HOST}:${PORT}/`)
})

// 沙盒模式：后台扫掉久无活动的会话（关浏览器 → 心跳停 → 工作区被销毁，重开即全新演示库）
if (SANDBOX) {
  const timer = setInterval(() => {
    const gone = sweepIdle(IDLE_TTL_MS)
    if (gone.length) console.log(`[serve] 已销毁 ${gone.length} 个空闲会话工作区（idle > ${IDLE_TTL_MS / 1000}s）`)
  }, SWEEP_MS)
  timer.unref && timer.unref()
}

function openBrowser(url) {
  try {
    let cmd, args
    if (process.platform === 'win32') {
      cmd = 'cmd'
      args = ['/c', 'start', '', url]
    } else if (process.platform === 'darwin') {
      cmd = 'open'
      args = [url]
    } else {
      cmd = 'xdg-open'
      args = [url]
    }
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true })
    child.on('error', () => {})
    child.unref()
  } catch {
    /* 打不开就算了：地址已经打在终端上 */
  }
}
