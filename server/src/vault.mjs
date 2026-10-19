// vault.mjs —— 库内路径与文件树的底层规则，逐条对着 src-tauri/src/lib.rs 抄
//
// 存在的意义：网页版的后端必须与 Rust 后端同一套语义，否则同一份前端代码在两端行为不同。
// 关键差异只有一处：Rust 的 ensure_inside_root 假定 target 已存在（fs::canonicalize），
// 未存在的路径走 vault_join 的纯词法拼接。这里照搬这两个函数，不多不少。

import fs from 'node:fs'
import path from 'node:path'
import { msg } from './uiLang.mjs'

/** 扫描时跳过的目录名（与 lib.rs 的 SKIP_DIRS 一致） */
export const SKIP_DIRS = ['node_modules', 'target', 'dist', '.git', '.obsidian', '.trash', '.notelume-backup']

/** 图片白名单（与 lib.rs 的 IMG_EXTS 一致） */
export const IMG_EXTS = ['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'bmp', 'ico', 'avif']

export const isMd = (name) => name.toLowerCase().endsWith('.md')
export const isCanvas = (name) => name.toLowerCase().endsWith('.canvas')
export const isImage = (name) => {
  const lower = name.toLowerCase()
  return IMG_EXTS.some((e) => lower.endsWith('.' + e))
}

/** Windows 上大小写与盘符写法会不一样，比较前统一走 realpath */
function canon(p) {
  try {
    return fs.realpathSync.native ? fs.realpathSync.native(p) : fs.realpathSync(p)
  } catch (e) {
    throw new VaultError(msg('pathResolveFailed', { path: p, err: e.message }))
  }
}

/** 命令里抛出的业务错误：message 就是给前端看的那句本地化文案 */
export class VaultError extends Error {}

/** target 必须存在且落在 root 内（root 已 realpath） */
export function ensureInsideRoot(root, target) {
  const real = canon(target)
  if (real === root || real.startsWith(root + path.sep) || real.startsWith(root + '/')) return real
  throw new VaultError(msg('pathOutsideVault'))
}

/** 库内相对路径（`/` 分隔）-> 绝对路径，要求所在目录已存在 */
export function absInVault(vaultRoot, rel) {
  const root = canon(vaultRoot)
  const parts = String(rel || '').split('/').filter((s) => s !== '')
  if (parts.includes('..')) throw new VaultError(msg('pathEscapeVault'))
  return ensureInsideRoot(root, path.join(root, ...parts))
}

/** 纯词法拼接（不要求已存在），拒绝 `..` 跳出；存在性由调用方另行校验 */
export function vaultJoin(root, rel) {
  let p = root
  for (const seg of String(rel || '').split('/').filter((s) => s !== '')) {
    if (seg === '..') throw new VaultError(msg('pathEscapeVault'))
    p = path.join(p, seg)
  }
  return p
}

/** 绝对路径 -> 库内相对路径（`/` 分隔） */
export function relInVault(root, abs) {
  const r = path.relative(root, abs)
  return r.split(path.sep).join('/')
}

/**
 * 打开文件夹时用的库根：绝对路径、必须是目录。
 * 沙盒模式下还要求落在该会话的工作区内（jail 由调用方传进来）。
 */
export function resolveVaultRoot(vaultRoot, jail) {
  if (!vaultRoot || !String(vaultRoot).trim()) throw new VaultError(msg('vaultPathInvalid', { err: 'empty' }))
  let root
  try {
    root = canon(String(vaultRoot))
  } catch (e) {
    throw new VaultError(msg('vaultPathInvalid', { err: e.message }))
  }
  let st
  try {
    st = fs.statSync(root)
  } catch {
    throw new VaultError(msg('vaultPathInvalid', { err: 'not found' }))
  }
  if (!st.isDirectory()) throw new VaultError(msg('vaultNotDir'))
  if (jail) {
    const jr = canon(jail)
    if (!(root === jr || root.startsWith(jr + path.sep) || root.startsWith(jr + '/'))) {
      throw new VaultError(msg('pathOutsideVault'))
    }
  }
  return root
}

/** 给定库内路径的父目录做同一套校验（write / create_dir / rename 的目标侧） */
export function parentInside(root, abs, jail) {
  const parent = path.dirname(abs)
  const pc = canon(parent)
  if (!(pc === root || pc.startsWith(root + path.sep) || pc.startsWith(root + '/'))) {
    throw new VaultError(msg('pathOutsideVault'))
  }
  if (jail) ensureInsideRoot(canon(jail), parent)
  return pc
}

/** 递归扫描目录树：同层「文件夹在前、按名称排序」，深度 12 封顶 */
export function scanDir(dir, rel, depth = 0) {
  const out = []
  if (depth > 12) return out
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return out // 无权限目录直接跳过，不中断整体扫描
  }
  const dirs = []
  const files = []
  for (const e of entries) {
    const name = e.name
    if (name.startsWith('.') || SKIP_DIRS.includes(name)) continue
    const full = path.join(dir, name)
    const childRel = rel ? `${rel}/${name}` : name
    if (e.isDirectory()) {
      dirs.push([name, childRel, full])
    } else if (e.isFile() && (isMd(name) || isCanvas(name) || isImage(name))) {
      files.push({ name, path: childRel, type: 'file', children: null })
    }
  }
  const byName = (a, b) => (a[0] || a.name).toLowerCase().localeCompare((b[0] || b.name).toLowerCase())
  dirs.sort(byName)
  files.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()))
  for (const [name, childRel, full] of dirs) {
    out.push({ name, path: childRel, type: 'folder', children: scanDir(full, childRel, depth + 1) })
  }
  for (const f of files) out.push(f)
  return out
}

/** FNV-1a 64 位：图片与导入文件的内容指纹（同名不同内容时追加到文件名） */
export function fnv1a(buf) {
  let h = 0xcbf29ce484222325n
  const prime = 0x100000001b3n
  const mask = 0xffffffffffffffffn
  for (const b of buf) {
    h ^= BigInt(b)
    h = (h * prime) & mask
  }
  return h.toString(16)
}

const B64_TABLE_OK = /^[A-Za-z0-9+/]*$/

/** 与 Rust 的手写解码同样严格：非法字符报错，而不是让 Buffer 静默截断 */
export function b64Decode(input) {
  const body = String(input || '').replace(/\s+/g, '').split('=')[0]
  if (body && !B64_TABLE_OK.test(body)) throw new VaultError(msg('badBase64'))
  return Buffer.from(body, 'base64')
}

export function b64Encode(buf) {
  return Buffer.from(buf).toString('base64')
}

/** markdown 图片链接遵循 URL 规范，文件名里的空格是 %20 */
export function percentDecode(s) {
  return String(s).replace(/%[0-9A-Fa-f]{2}/g, (m) => String.fromCharCode(parseInt(m.slice(1), 16)))
}

const MIME = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  svg: 'image/svg+xml',
  webp: 'image/webp',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  avif: 'image/avif',
}

export function mimeForExt(ext) {
  return MIME[String(ext || '').toLowerCase()] || 'application/octet-stream'
}

/** wikilink 目标：相对 ref_rel 所在目录解析 `../a/b.md`，与 lib.rs 的 normalize_target 同 */
export function normalizeTarget(refRel, link) {
  const slash = refRel.lastIndexOf('/')
  const baseDir = slash >= 0 ? refRel.slice(0, slash) : ''
  let joined
  if (link.startsWith('/')) joined = link.replace(/^\/+/, '')
  else if (!baseDir) joined = link
  else joined = `${baseDir}/${link}`
  const parts = []
  for (const seg of joined.split('/').filter((s) => s !== '' && s !== '.')) {
    if (seg === '..') parts.pop()
    else parts.push(seg)
  }
  return parts.join('/')
}
