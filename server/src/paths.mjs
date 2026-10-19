// paths.mjs —— 数据落位：两种模式下的库根监狱、临时目录、演示库
//
// 本机模式（默认）不开监狱：试用者要能打开自己任意位置的库。
// --sandbox 开监狱：每个 sessionId 一份工作区（os.tmpdir()/notelume-web/<sid>），
// 里面 vault/（首访从 server/default-vault 灌一份）、tmp/（Ctrl+N 的临时文件）。
// 监狱根是整个工作区而不是 vault/，因为桌面代码会拿 tempDir() 当 vaultRoot 去建
// <base>/NoteLume/scratch（main.js 的 ensureScratchDir），只锁 vault 会把它挡掉。

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const SERVER_DIR = path.resolve(HERE, '..')
export const REPO_DIR = path.resolve(SERVER_DIR, '..')
export const DEMO_VAULT = path.join(SERVER_DIR, 'default-vault')
export const DIST_DIR = path.join(SERVER_DIR, 'dist')

/** 运行期配置，serve.mjs 启动时填 */
export const cfg = {
  mode: 'local', // 'local' | 'sandbox'
  dataDir: path.join(SERVER_DIR, 'data'),
  localTmp: path.join(os.tmpdir(), 'notelume-web'),
  sessionBase: path.join(os.tmpdir(), 'notelume-web'),
  maxAgeDays: 7,
}

export function configure(opts = {}) {
  // mode 给显式切换留口子：只认 opts.sandbox 的话，测试里再也切不回本机模式
  if (opts.mode) cfg.mode = opts.mode
  else if (opts.sandbox) cfg.mode = 'sandbox'
  if (opts.dataDir) cfg.dataDir = path.resolve(opts.dataDir)
  if (opts.localTmp) cfg.localTmp = path.resolve(opts.localTmp)
  if (opts.sessionBase) cfg.sessionBase = path.resolve(opts.sessionBase)
  fs.mkdirSync(cfg.dataDir, { recursive: true })
  if (cfg.mode === 'sandbox') fs.mkdirSync(cfg.sessionBase, { recursive: true })
  return cfg
}

// sessionId 来自浏览器 localStorage，直接当目录名用，必须先挡住路径成分与任意符号
const SID_RE = /^[A-Za-z0-9_-]{1,64}$/

export function isSafeSid(sid) {
  return typeof sid === 'string' && SID_RE.test(sid)
}

/** 该会话的监狱根（沙盒模式）；本机模式返回 null 表示不限制 */
export function jailRoot(sid) {
  if (cfg.mode !== 'sandbox') return null
  if (!isSafeSid(sid)) throw new Error('bad session id')
  const root = path.join(cfg.sessionBase, sid)
  ensureSessionVault(root)
  return root
}

/** 会话工作区里的库：没有就建，空的话从演示库灌一份 */
function ensureSessionVault(root) {
  const vault = path.join(root, 'vault')
  fs.mkdirSync(vault, { recursive: true })
  fs.mkdirSync(path.join(root, 'tmp'), { recursive: true })
  if (fs.readdirSync(vault).length === 0 && fs.existsSync(DEMO_VAULT)) {
    fs.cpSync(DEMO_VAULT, vault, { recursive: true })
  }
  return vault
}

/** 默认库根：沙盒给会话 vault，本机给 null（前端首屏自己选） */
export function defaultVaultRoot(sid) {
  if (cfg.mode !== 'sandbox') return null
  const root = jailRoot(sid)
  return root ? path.join(root, 'vault') : null
}

/** 给前端的 tempDir()：main.js 会在这里再建 NoteLume/scratch */
export function scratchRoot(sid) {
  if (cfg.mode === 'sandbox') {
    const root = jailRoot(sid)
    return path.join(root, 'tmp')
  }
  fs.mkdirSync(cfg.localTmp, { recursive: true })
  return cfg.localTmp
}

/** 启动时清掉过期的会话工作区（沙盒模式的垃圾回收，本机模式不涉及） */
export function pruneSessions(maxAgeDays = cfg.maxAgeDays) {
  if (cfg.mode !== 'sandbox') return []
  const base = cfg.sessionBase
  let names
  try {
    names = fs.readdirSync(base)
  } catch {
    return []
  }
  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000
  const removed = []
  for (const name of names) {
    if (!isSafeSid(name)) continue
    const dir = path.join(base, name)
    let st
    try {
      st = fs.statSync(dir)
    } catch {
      continue
    }
    // 以最近一次动过 vault 的时间为准：整棵树里最新的时间比目录本身更能反映「还在用」
    const last = newestMtime(dir, 2)
    if (Math.max(st.mtimeMs, last) < cutoff) {
      fs.rmSync(dir, { recursive: true, force: true })
      removed.push(name)
    }
  }
  return removed
}

function newestMtime(dir, depth) {
  let max = 0
  if (depth < 0) return max
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return max
  }
  for (const e of entries) {
    const p = path.join(dir, e.name)
    try {
      const st = fs.statSync(p)
      if (st.mtimeMs > max) max = st.mtimeMs
      if (e.isDirectory() && depth > 0) {
        const sub = newestMtime(p, depth - 1)
        if (sub > max) max = sub
      }
    } catch {
      /* 忽略 */
    }
  }
  return max
}
