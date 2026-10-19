// docxCommands.mjs —— 网页沙盒里 .docx 导入的 preview / commit 两个命令（同步）
//
// 让桌面现成的整条“导入 Word”流程（pickDocxFiles/拖入 → docx_preview → 校对模态 → docx_commit → 自动打开）
// 在浏览器里原样跑通：出入参形状严格对齐 src-tauri/src/docx_import.rs 的 serde 契约（camelCase），
// 解析交给 ./docxOoxml.mjs（JS 子集，保真度低于桌面引擎，降级项以 warnings 呈现）。
// 这两个命令从 router.mjs 的 UNSUPPORTED 里摘出，改由这里实现；桌面代码一行不改。

import fs from 'node:fs'
import path from 'node:path'
import { VaultError, b64Decode, resolveVaultRoot, vaultJoin } from './vault.mjs'
import { docxToMarkdown } from './docxOoxml.mjs'

const canon = (p) => {
  try {
    return fs.realpathSync(p)
  } catch (e) {
    throw new VaultError('无法解析路径：' + ((e && e.message) || e))
  }
}

/** 该绝对路径是否落在 jail 内（jail 为空即本机模式，不限制） */
function assertInsideJail(jail, abs) {
  if (!jail) return
  const jr = canon(jail)
  const r = canon(abs)
  if (!(r === jr || r.startsWith(jr + path.sep) || r.startsWith(jr + '/'))) {
    throw new VaultError('路径不在本会话工作区内')
  }
}

// ---------- 命名/路径小工具（对齐 Rust join_rel / sanitize_rel / split_dir_file / resolve_conflict）----------
function joinRel(dir, name) {
  return !dir ? name : `${dir.replace(/\/+$/, '')}/${name}`
}
function sanitizeRel(rel) {
  const norm = String(rel || '').trim().replace(/\\/g, '/')
  const segs = []
  for (const s of norm.split('/').filter((x) => x !== '' && x !== '.')) {
    if (s === '..') throw new VaultError('非法的相对路径')
    segs.push(s)
  }
  return segs.join('/')
}
function splitDirFile(rel) {
  const i = rel.lastIndexOf('/')
  return i < 0 ? ['', rel] : [rel.slice(0, i), rel.slice(i + 1)]
}
function slugify(title) {
  let out = ''
  let lastDash = false
  for (const ch of String(title || '')) {
    const code = ch.codePointAt(0)
    const keep = /[\p{L}\p{N}]/u.test(ch) || ch === '-' || ch === '_' || ch === '.' || ch === ' ' || (code >= 0x4e00 && code <= 0x9fff)
    const illegal = ch === '/' || ch === '\\' || ch === ':' || ch === '*' || ch === '?' || ch === '"' || ch === '<' || ch === '>' || ch === '|' || code < 0x20
    if (keep && !illegal) {
      if (ch === ' ') {
        if (!lastDash && out.length) {
          out += '-'
          lastDash = true
        }
      } else {
        out += ch
        lastDash = false
      }
    }
  }
  out = out.replace(/^[-.]+|[-.]+$/g, '')
  return out || 'Untitled'
}
/** 路径存在则文件名主干补 -2/-3…（目录不变）——对齐 Rust resolve_conflict */
function resolveConflict(root, rel) {
  const exists = (r) => fs.existsSync(path.join(root, ...String(r).split('/').filter(Boolean)))
  if (!exists(rel)) return rel
  const [dir, file] = splitDirFile(rel)
  const dot = file.lastIndexOf('.')
  const stem = dot > 0 ? file.slice(0, dot) : file
  const ext = dot > 0 ? file.slice(dot + 1) : null
  for (let n = 2; n < 1000; n++) {
    const candFile = ext ? `${stem}-${n}.${ext}` : `${stem}-${n}`
    const cand = dir ? `${dir}/${candFile}` : candFile
    if (!exists(cand)) return cand
  }
  return rel
}

// ---------- docx_preview（只转不写）----------
export const docxCommands = {
  docx_preview({ args }) {
    const a = args || {}
    const b64 = String(a.srcB64 || '').trim()
    let buf
    let srcName
    if (b64) {
      buf = b64Decode(b64)
      srcName = String(a.srcDisplayName || '').trim() || 'document.docx'
    } else {
      if (!a.srcPath || !String(a.srcPath).trim()) throw new VaultError('缺少 .docx 来源')
      const abs = path.resolve(String(a.srcPath))
      if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) throw new VaultError('找不到该 .docx 文件')
      assertInsideJail(this.jail, abs)
      try {
        buf = fs.readFileSync(abs)
      } catch (e) {
        throw new VaultError('读取 .docx 失败：' + ((e && e.message) || e))
      }
      srcName = path.basename(abs)
    }

    const r = docxToMarkdown(buf, {
      titleOverride: a.titleOverride,
      destDir: a.destDir || '',
      dedupIndex: a.dedupIndex || {},
      withFrontmatter: a.withFrontmatter !== false,
      maxImageBytes: a.maxImageBytes || 8 * 1024 * 1024,
      srcName,
    })
    const { slug, ...wire } = r // slug 是内部量，不进 wire（对齐 Rust DocxPreview 字段）
    return wire
  },

  // ---------- docx_commit（校对后落盘 + 去重）----------
  docx_commit({ args }) {
    const a = args || {}
    const root = resolveVaultRoot(a.vaultRoot, this.jail)
    let rel = sanitizeRel(a.docRel)

    const nt = a.newTitle != null ? String(a.newTitle).trim() : ''
    if (nt) {
      const [dir] = splitDirFile(rel)
      const slug = slugify(nt)
      rel = dir ? `${dir}/${slug}.md` : `${slug}.md`
    }
    if (!rel || !rel.toLowerCase().endsWith('.md')) throw new VaultError('非法的文档路径')

    const finalRel = resolveConflict(root, rel)
    const docDir = splitDirFile(finalRel)[0]

    const mdAbs = vaultJoin(root, finalRel)
    assertInsideJail(this.jail, path.dirname(mdAbs))
    fs.mkdirSync(path.dirname(mdAbs), { recursive: true })
    fs.writeFileSync(mdAbs, String(a.md || ''), 'utf8')

    const updated = { ...(a.dedupIndex || {}) }
    const written = []
    const reused = []
    for (const img of a.images || []) {
      if (!img || !img.sha256) continue
      const existing = updated[img.sha256]
      if (existing) {
        try {
          const target = vaultJoin(root, existing)
          assertInsideJail(this.jail, target)
          if (fs.existsSync(target)) {
            reused.push(existing)
            continue
          }
          fs.mkdirSync(path.dirname(target), { recursive: true })
          fs.writeFileSync(target, b64Decode(img.dataB64))
          written.push(existing)
          continue
        } catch {
          /* 越界/异常 → 落到下面按 plannedRel 正常写并更新索引 */
        }
      }
      let irel
      if (!String(img.plannedRel || '').trim()) {
        const e = String(img.ext || '').trim().replace(/^\.+/, '').toLowerCase()
        if (!e) continue
        irel = joinRel(docDir, `${img.sha256.slice(0, 12)}.${e}`)
      } else {
        irel = sanitizeRel(img.plannedRel)
      }
      if (!irel) continue
      const abs = vaultJoin(root, irel)
      assertInsideJail(this.jail, abs)
      fs.mkdirSync(path.dirname(abs), { recursive: true })
      if (!fs.existsSync(abs)) {
        fs.writeFileSync(abs, b64Decode(img.dataB64))
        written.push(irel)
      }
      updated[img.sha256] = irel
    }

    return { docRel: finalRel, writtenImages: written, reusedImages: reused, updatedIndex: updated }
  },
}
