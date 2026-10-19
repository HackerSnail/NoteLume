// browse.mjs —— 浏览器版的「选择文件夹 / 选择文件」对话框背后的目录列举
//
// 桌面版这两个框由 Tauri 原生提供，浏览器没有能给出绝对路径的 picker，所以这个框由后端喂数据、
// 前端 src/web/path-picker.js 画。返回的是本机（或会话工作区）真实的绝对路径。
//
// 两种模式的边界完全不同：
//   本机模式：不给 path 时回盘符列表（unix 上是 /），可浏览全盘——试用者要能打开自己任意位置的库。
//   沙盒模式：roots 只有该会话的工作区，越界一律 pathOutsideVault。

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { msg } from './uiLang.mjs'
import { SKIP_DIRS } from './vault.mjs'

const PICKABLE_EXT = ['md', 'markdown', 'canvas', 'docx']

/** 列出所有可作为起点的根；沙盒模式只认会话工作区 */
export function roots(jail = null) {
  if (jail) {
    const jr = fs.realpathSync(jail)
    return [{ name: path.basename(jr) || jr, path: jr }]
  }
  if (process.platform === 'win32') {
    const out = []
    for (let i = 0; i < 26; i++) {
      const letter = String.fromCharCode(65 + i)
      const p = `${letter}:\\`
      try {
        if (fs.existsSync(p) && fs.statSync(p).isDirectory()) out.push({ name: `${letter}:`, path: p })
      } catch {
        /* 光驱 / 网络盘没就绪：跳过 */
      }
    }
    return out
  }
  return [{ name: '/', path: '/' }]
}

function looksLikeDir(p) {
  try {
    return fs.statSync(p).isDirectory()
  } catch {
    return false
  }
}

/** home：沙盒给工作区根，本机给用户目录（save 模式的兜底起点） */
function homeOf(jail) {
  return jail ? fs.realpathSync(jail) : os.homedir()
}

/** 沙盒会话的库根：file / save 模式的 picker 从这开始（本机模式没有这个概念，回 null） */
function vaultOf(jail) {
  if (!jail) return null
  const v = path.join(fs.realpathSync(jail), 'vault')
  return fs.existsSync(v) ? v : null
}

/**
 * 列一个目录。jail 非空时锁在 jail 内（沙盒模式）。
 * wantFiles 为真时附带可挑的文件（md / markdown / canvas / docx）。
 * 回包里的 vault 是「file / save 模式该从哪开始」的提示：沙盒是会话库根，本机是 null。
 */
export function browse(absPath, { jail = null, wantFiles = false } = {}) {
  if (!absPath) {
    return { path: '', parent: null, roots: roots(jail), dirs: [], files: [], home: homeOf(jail), vault: vaultOf(jail) }
  }
  const target = path.resolve(String(absPath))
  if (jail) {
    const jr = fs.realpathSync(jail)
    const real = looksLikeDir(target) ? fs.realpathSync(target) : null
    if (!real || !(real === jr || real.startsWith(jr + path.sep) || real.startsWith(jr + '/'))) {
      throw new Error(msg('pathOutsideVault'))
    }
  }
  if (!looksLikeDir(target)) throw new Error(msg('targetDirMissing', { err: target }))
  const real = fs.realpathSync(target)

  let entries
  try {
    entries = fs.readdirSync(real, { withFileTypes: true })
  } catch (e) {
    throw new Error(msg('readDirFailed') + `: ${e.message}`)
  }
  const dirs = []
  const files = []
  for (const e of entries) {
    if (e.name.startsWith('.') || SKIP_DIRS.includes(e.name)) continue
    const full = path.join(real, e.name)
    if (e.isDirectory()) {
      dirs.push({ name: e.name, path: full })
    } else if (wantFiles) {
      const ext = (e.name.split('.').pop() || '').toLowerCase()
      if (PICKABLE_EXT.includes(ext) && e.name.includes('.')) files.push({ name: e.name, path: full, kind: ext })
    }
  }
  const byName = (a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase())
  dirs.sort(byName)
  files.sort(byName)

  const parentDir = path.dirname(real)
  return {
    path: real,
    parent: parentDir === real ? null : parentDir,
    roots: roots(jail),
    dirs,
    files,
    home: homeOf(jail),
    vault: vaultOf(jail),
  }
}
