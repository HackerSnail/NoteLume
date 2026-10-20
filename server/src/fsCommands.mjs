// fsCommands.mjs —— P0 文件类命令的 Node 实现
//
// 每个 handler 的入参形状与 src/tauri-bridge.js 里 invoke 传的那份一一对应
// （vaultRoot / path / args 的嵌套层次都不变），返回形状对着 src-tauri/src/lib.rs 抄。
// 抛 VaultError 即业务失败，router 会转成 { ok:false, error:<本地化文案> }。
//
// 与 Rust 的一处行为差异写在 delete_file 里（回收站）。

import fs from 'node:fs'
import path from 'node:path'
import { msg } from './uiLang.mjs'
import { scratchRoot } from './paths.mjs'
import {
  VaultError,
  absInVault,
  b64Decode,
  b64Encode,
  ensureInsideRoot,
  fnv1a,
  mimeForExt,
  normalizeTarget,
  parentInside,
  percentDecode,
  resolveVaultRoot,
  scanDir,
  vaultJoin,
  isMd,
  isImage,
  IMG_EXTS,
  SKIP_DIRS,
} from './vault.mjs'

/** 库内某条相对路径的绝对位置（父目录可以不存在，纯词法拼接） */
function lexPath(ctx, vaultRoot, rel) {
  const root = resolveVaultRoot(vaultRoot, ctx.jail)
  const clean = String(rel == null ? '' : rel).trim().replace(/\\/g, '/')
  return { root, abs: vaultJoin(root, clean), clean }
}

/** 未落地路径也要受监狱约束：对最近一个存在的祖先做检查（export_file 用） */
function assertInJail(ctx, p) {
  if (!ctx.jail) return
  const jr = fs.realpathSync(ctx.jail)
  let cur = path.resolve(p)
  while (!fs.existsSync(cur)) {
    const up = path.dirname(cur)
    if (up === cur) break
    cur = up
  }
  const real = fs.realpathSync(cur)
  if (!(real === jr || real.startsWith(jr + path.sep) || real.startsWith(jr + '/'))) {
    throw new VaultError(msg('pathOutsideVault'))
  }
}

/** 递归拷贝一棵树（保留相对路径、覆写同名；符号链接等其他类型忽略，与 Rust 侧一致）。
 *  目标落在源里面时（沙盒「另存为」的目录选择器能选到源自己的子目录），跳过目标自身，
 *  否则会把目标拷进目标、无限递归。 */
function copyTree(from, to) {
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    const srcPath = path.join(from, e.name)
    if (srcPath === to || to.startsWith(srcPath + path.sep)) continue
    const dest = path.join(to, e.name)
    if (e.isDirectory()) {
      fs.mkdirSync(dest, { recursive: true })
      copyTree(srcPath, dest)
    } else if (e.isFile()) {
      fs.copyFileSync(srcPath, dest)
    }
  }
}

export const handlers = {
  scan_vault({ vaultRoot }) {
    const root = resolveVaultRoot(vaultRoot, this.jail)
    return scanDir(root, '', 0)
  },

  read_md_file({ vaultRoot, path: rel }) {
    const root = resolveVaultRoot(vaultRoot, this.jail)
    const abs = absInVault(root, rel)
    try {
      return fs.readFileSync(abs, 'utf8')
    } catch (e) {
      throw new VaultError(msg('readFailed', { err: e.message }))
    }
  },

  // UTF-8 直写，标准 GFM，不引入任何私有格式（与 Rust 版本同语义）
  write_md_file({ vaultRoot, path: rel, content }) {
    const { root, abs } = lexPath(this, vaultRoot, rel)
    const clean = String(rel == null ? '' : rel).trim().replace(/\\/g, '/')
    if (clean.split('/').includes('..')) throw new VaultError(msg('pathEscapeVault'))
    try {
      fs.mkdirSync(path.dirname(abs), { recursive: true })
    } catch (e) {
      throw new VaultError(msg('createDirFailed', { err: e.message }))
    }
    parentInside(root, abs, this.jail)
    try {
      fs.writeFileSync(abs, String(content == null ? '' : content), 'utf8')
    } catch (e) {
      throw new VaultError(msg('saveFailed', { err: e.message }))
    }
  },

  create_md_file({ vaultRoot, args }) {
    let rel = String((args && args.path) || '').trim().replace(/\\/g, '/')
    if (!rel) throw new VaultError(msg('emptyFileName'))
    if (!rel.toLowerCase().endsWith('.md')) rel += '.md'
    this.write_md_file({ vaultRoot, path: rel, content: (args && args.content) || '' })
    return rel
  },

  /**
   * 删除：桌面版走系统回收站（trash crate），Node 没有对应的系统调用，
   * 改成移入库根下的 .notelume-trash/（点开头，扫描与索引都会跳过），
   * 文件仍在磁盘上、可手工取回，不会被静默销毁。文件夹照旧拒绝。
   */
  delete_file({ vaultRoot, path: rel }) {
    const root = resolveVaultRoot(vaultRoot, this.jail)
    const abs = absInVault(root, rel)
    let st
    try {
      st = fs.statSync(abs)
    } catch (e) {
      throw new VaultError(msg('readFailed', { err: e.message }))
    }
    if (st.isDirectory()) throw new VaultError(msg('noFolderDelete'))
    const trash = path.join(root, '.notelume-trash')
    try {
      fs.mkdirSync(trash, { recursive: true })
      let dest = path.join(trash, `${Date.now()}-${path.basename(abs)}`)
      let i = 1
      while (fs.existsSync(dest)) dest = path.join(trash, `${Date.now()}-${i++}-${path.basename(abs)}`)
      fs.renameSync(abs, dest)
    } catch (e) {
      throw new VaultError(msg('trashFailed', { err: e.message }))
    }
  },

  create_dir({ vaultRoot, path: rel }) {
    const { root, abs } = lexPath(this, vaultRoot, rel)
    if (!String(rel || '').trim()) throw new VaultError(msg('emptyFolderName'))
    if (fs.existsSync(abs)) throw new VaultError(msg('targetExists'))
    try {
      fs.mkdirSync(path.dirname(abs), { recursive: true })
    } catch (e) {
      throw new VaultError(msg('createDirFailed', { err: e.message }))
    }
    parentInside(root, abs, this.jail)
    try {
      fs.mkdirSync(abs)
    } catch (e) {
      throw new VaultError(msg('createDirFailed', { err: e.message }))
    }
  },

  rename_item({ vaultRoot, from, to }) {
    const root = resolveVaultRoot(vaultRoot, this.jail)
    const absFrom = absInVault(root, from)
    const relTo = String(to == null ? '' : to).trim().replace(/\\/g, '/')
    if (!relTo) throw new VaultError(msg('newNameEmpty'))
    const absTo = vaultJoin(root, relTo)
    if (fs.existsSync(absTo)) throw new VaultError(msg('renameExists'))
    try {
      parentInside(root, absTo, this.jail)
    } catch (e) {
      if (e instanceof VaultError) throw e
      throw new VaultError(msg('targetDirMissing', { err: e.message }))
    }
    let fromIsDir = false
    try {
      fromIsDir = fs.statSync(absFrom).isDirectory()
    } catch {
      /* absInVault 已经保证存在 */
    }
    if (fromIsDir && (absTo === absFrom || absTo.startsWith(absFrom + path.sep))) {
      throw new VaultError(msg('moveIntoSelf'))
    }
    try {
      fs.mkdirSync(path.dirname(absTo), { recursive: true })
      fs.renameSync(absFrom, absTo)
    } catch (e) {
      throw new VaultError(msg('renameFailed', { err: e.message }))
    }
  },

  /** 外部拖入的文件落库：同名不同内容时按 FNV 指纹换名，返回库内相对路径 */
  import_vault_file({ vaultRoot, args }) {
    const root = resolveVaultRoot(vaultRoot, this.jail)
    const ndir = String((args && args.destDirRel) || '').trim().replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')
    const absDir = vaultJoin(root, ndir)
    try {
      fs.mkdirSync(absDir, { recursive: true })
    } catch (e) {
      throw new VaultError(msg('createDirFailed', { err: e.message }))
    }
    const dc = ensureInsideRoot(root, absDir)
    const base = String((args && args.name) || '').split(/[/\\]/).pop().trim()
    if (!base || base === '.' || base === '..') throw new VaultError(msg('badImportFileName'))
    const bytes = b64Decode((args && args.dataBase64) || '')
    const dot = base.lastIndexOf('.')
    const stem = dot > 0 ? base.slice(0, dot) : base
    const ext = dot > 0 ? base.slice(dot + 1).toLowerCase() : ''
    let fileName = base
    let dest = path.join(dc, fileName)
    if (fs.existsSync(dest)) {
      const same = (() => {
        try {
          return Buffer.compare(fs.readFileSync(dest), bytes) === 0
        } catch {
          return false
        }
      })()
      if (!same) {
        const fp = fnv1a(bytes)
        fileName = ext ? `${stem}-${fp}.${ext}` : `${stem}-${fp}`
        dest = path.join(dc, fileName)
      }
    }
    if (!fs.existsSync(dest)) {
      try {
        fs.writeFileSync(dest, bytes)
      } catch (e) {
        throw new VaultError(msg('importFailed', { err: e.message }))
      }
    }
    return ndir ? `${ndir}/${fileName}` : fileName
  },

  /**
   * 独立导入模式的一次性目录（桌面 ensure_temp_import_dir 的网页版）：
   * <会话临时根>/NoteLume/docx-import/<时间戳>。桌面落在 std::env::temp_dir()，
   * 沙盒里 jail 外没有可写的地方，故落会话工作区的 tmp/（scratchRoot）。
   */
  ensure_temp_import_dir() {
    const base = scratchRoot(this.sid)
    const dir = path.join(base, 'NoteLume', 'docx-import', String(Date.now()))
    try {
      fs.mkdirSync(dir, { recursive: true })
    } catch (e) {
      throw new VaultError(msg('createDirFailed', { err: e.message }))
    }
    assertInJail(this, dir)
    return dir
  },

  /**
   * 独立导入的「另存为」：把整棵源目录递归拷到目标（保留相对路径、覆写同名、不删源）。
   * 语义对齐 docx_import.rs 的 relocate_import；目标不存在时按需创建。
   */
  relocate_import({ fromRoot, toRoot }) {
    const src = resolveVaultRoot(fromRoot, this.jail)
    const raw = String(toRoot || '').trim()
    if (!raw) throw new VaultError(msg('vaultPathInvalid', { err: 'empty' }))
    // 先校验再建目录：目标可以不存在（用户选个新路径），assertInJail 走最近存在祖先比，
    // 反过来先 mkdir 就会把越界目录真建出来再报错
    assertInJail(this, raw)
    try {
      fs.mkdirSync(raw, { recursive: true })
    } catch (e) {
      throw new VaultError(msg('createDirFailed', { err: e.message }))
    }
    const dst = resolveVaultRoot(raw, this.jail)
    copyTree(src, dst)
    return null
  },

  /** [[wikilink]] 解析：先按库内相对路径，失败再按 basename 全库找。回 { exists, path } */
  resolve_wiki_link({ vaultRoot, refRel, name }) {
    const root = resolveVaultRoot(vaultRoot, this.jail)
    const hit = resolveOne(root, String(refRel || ''), String(name || ''))
    return { exists: !!hit, path: hit || null }
  },

  /** 剪贴板 / 拖拽来的图片字节落进 md 同级的 assets/，回可写进 md 的相对链接 */
  save_image_bytes({ vaultRoot, mdRel, args }) {
    const ext = String((args && args.ext) || '').toLowerCase().replace(/^\.+/, '')
    if (!IMG_EXTS.includes(ext)) throw new VaultError(msg('unsupportedImgType', { ext }))
    const bytes = b64Decode((args && args.dataBase64) || '')
    const root = resolveVaultRoot(vaultRoot, this.jail)
    const assets = assetsDirFor(root, String(mdRel || ''))
    const fileName = `pasted-${fnv1a(bytes)}.${ext}`
    try {
      fs.writeFileSync(path.join(assets, fileName), bytes)
    } catch (e) {
      throw new VaultError(msg('writeImgFailed', { err: e.message }))
    }
    return `./assets/${fileName}`
  },

  /** 图片字节回 data: URL；先按常规解析，失败按文件名全库回退（Obsidian 嵌入） */
  read_image_data_uri({ vaultRoot, mdRel, src }) {
    const root = resolveVaultRoot(vaultRoot, this.jail)
    let abs
    try {
      abs = resolveMediaAbs(root, String(mdRel || ''), String(src || ''))
    } catch {
      const decoded = percentDecode(String(src || ''))
      const base = decoded.split(/[/\\]/).pop()
      abs = findAssetByName(root, base, 0)
      if (!abs) throw new VaultError(msg('imgNotFound', { src }))
    }
    const ext = (path.extname(abs) || '').slice(1).toLowerCase()
    if (!IMG_EXTS.includes(ext)) throw new VaultError(msg('unsupportedImgType', { ext }))
    let buf
    try {
      buf = fs.readFileSync(abs)
    } catch (e) {
      throw new VaultError(msg('readImgFailed', { err: e.message }))
    }
    return `data:${mimeForExt(ext)};base64,${b64Encode(buf)}`
  },

  /** 导出到库外任意路径（路径由前端的选择框给）；沙盒模式仍受监狱约束 */
  export_file({ args }) {
    const absPath = String((args && args.absPath) || '')
    if (!absPath) throw new VaultError(msg('badFilePath'))
    const p = path.resolve(absPath)
    assertInJail(this, p)
    try {
      fs.mkdirSync(path.dirname(p), { recursive: true })
      fs.writeFileSync(p, String((args && args.content) || ''), 'utf8')
    } catch (e) {
      throw new VaultError(msg('exportFailed', { err: e.message }))
    }
  },

  take_launch_paths() {
    return []
  },
}

// —— 内部：与 lib.rs 的同名私有函数对应 ——

function assetsDirFor(root, mdRel) {
  const slash = mdRel.lastIndexOf('/')
  const baseDir = slash >= 0 ? path.join(root, ...mdRel.slice(0, slash).split('/').filter(Boolean)) : root
  fs.mkdirSync(baseDir, { recursive: true })
  const mdDir = fs.realpathSync(baseDir)
  const assets = path.join(mdDir, 'assets')
  fs.mkdirSync(assets, { recursive: true })
  return assets
}

/** 相对当前 md（或绝对）的图片路径 -> 绝对路径：允许 `..`，但解析后必须在库内 */
function resolveMediaAbs(root, mdRel, srcRaw) {
  const src = percentDecode(srcRaw)
  const clean = src.replace(/^\.\//, '')
  const isAbs = clean.startsWith('/') || /^[A-Za-z]:[\\/]/.test(clean)
  let p
  if (isAbs) {
    p = clean
  } else {
    const slash = mdRel.lastIndexOf('/')
    const base = slash >= 0 ? path.join(root, ...mdRel.slice(0, slash).split('/').filter(Boolean)) : root
    p = path.join(base, ...clean.split(/[/\\]/).filter(Boolean))
  }
  return ensureInsideRoot(root, p)
}

/** 库内按文件名（不区分大小写）逐层浅优先查找 */
function findAssetByName(dir, name, depth) {
  if (depth > 12) return null
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return null
  }
  const subdirs = []
  for (const e of entries) {
    if (e.name.startsWith('.')) continue
    const full = path.join(dir, e.name)
    if (e.isDirectory()) {
      if (SKIP_DIRS.includes(e.name)) continue
      subdirs.push(full)
    } else if (e.name.toLowerCase() === name.toLowerCase()) {
      return full
    }
  }
  for (const d of subdirs) {
    const hit = findAssetByName(d, name, depth + 1)
    if (hit) return hit
  }
  return null
}

/** 命中一条 md 的库内相对路径；解析不出返回 null（索引与 resolve_wiki_link 共用这一份） */
export function resolveOne(root, refRel, link) {
  const name = link.trim()
  if (!name) return null
  if (name.includes('/') || name.startsWith('..') || name.toLowerCase().endsWith('.md')) {
    const rel = normalizeTarget(refRel, name)
    const cand = rel.toLowerCase().endsWith('.md') ? rel : `${rel}.md`
    if (fs.existsSync(path.join(root, ...cand.split('/').filter(Boolean)))) return cand
  }
  const stem = name.toLowerCase().endsWith('.md') && isMd(name) ? name.slice(0, -3) : name
  return findMdByBasename(root, stem, 0, '')
}

/** 按文件名（不含扩展名）全库找 md：同层优先，跳过 assets 与隐藏目录（对 Rust 的 find_md_by_basename） */
function findMdByBasename(dir, stem, depth, rel) {
  if (depth > 12) return null
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return null
  }
  const subs = []
  for (const e of entries) {
    if (e.name.startsWith('.') || SKIP_DIRS.includes(e.name) || e.name === 'assets') continue
    const childRel = rel ? `${rel}/${e.name}` : e.name
    const full = path.join(dir, e.name)
    if (e.isDirectory()) {
      subs.push([full, childRel])
    } else {
      const dot = e.name.lastIndexOf('.')
      const base = dot > 0 ? e.name.slice(0, dot) : e.name
      if (base === stem && isMd(e.name)) return childRel // 同层命中即返回，比 Rust 的 insert(0) 更直接
    }
  }
  for (const [full, childRel] of subs) {
    const hit = findMdByBasename(full, stem, depth + 1, childRel)
    if (hit) return hit
  }
  return null
}
