// kbCommands.mjs —— 知识库类命令：索引 / 反链 / 出链 / 搜索 / 标签 / 图谱 / 快照
//
// 返回形状逐字段对着 src-tauri/src/lib.rs 抄（camelCase、{path,title}、{tag,count}、
// {nodes,edges}、{vaultRoot,docs,ready}），前端 main.js 与 graph-view / wiki-hover /
// snapshot-panel 的读法不用改。
//
// 一处结构性差异：桌面版索引是进程内单份全局状态（一个实例一个库），网页版一个后端
// 要伺候多个会话，所以索引按 sid 存在 index.mjs 的会话表里。查询类命令的入参本来就不带
// vaultRoot（get_index_status / query_backlinks / update_index_doc …），正是靠 sid 定位。

import fs from 'node:fs'
import path from 'node:path'
import { msg } from './uiLang.mjs'
import { VaultError, absInVault, relInVault, resolveVaultRoot } from './vault.mjs'
import {
  docInfo,
  graphData,
  indexOf,
  listAllTags,
  queryBacklinks,
  queryOutgoing,
  queryTag,
  removeDoc,
  searchVault,
  startRebuild,
  summaryFrom,
  updateDoc,
} from './index.mjs'

const pad = (n, w = 2) => String(n).padStart(w, '0')

/** 库内相对路径查询用的宽松规范化：只统一分隔符，键本身仍是扫描得到的 '/' 形式 */
const relKey = (p) => String(p == null ? '' : p).replace(/\\/g, '/')

export const BACKUP_DIR = '.notelume-backup'

export const kbHandlers = {
  // —— 索引生命周期 ——

  rebuild_index({ vaultRoot }) {
    const root = resolveVaultRoot(vaultRoot, this.jail)
    const index = indexOf(this.sid)
    return startRebuild(index, String(vaultRoot), root)
  },

  get_index_status() {
    const index = indexOf(this.sid)
    return { vaultRoot: index.vaultRoot, docs: index.docs.size, ready: index.ready }
  },

  update_index_doc({ path: rel, content }) {
    updateDoc(indexOf(this.sid), relKey(rel), String(content == null ? '' : content))
  },

  remove_index_doc({ path: rel }) {
    removeDoc(indexOf(this.sid), relKey(rel))
  },

  // —— 链接查询 ——

  query_backlinks({ path: rel }) {
    return queryBacklinks(indexOf(this.sid), relKey(rel))
  },

  query_outgoing({ path: rel }) {
    return queryOutgoing(indexOf(this.sid), relKey(rel))
  },

  get_doc_info({ path: rel }) {
    return docInfo(indexOf(this.sid), relKey(rel))
  },

  /** 不落索引、直接读盘：与 Rust 的 doc_preview 同（悬浮预览点开不存在的文档也要有摘要） */
  doc_preview({ vaultRoot, path: rel, maxChars }) {
    const root = resolveVaultRoot(vaultRoot, this.jail)
    const abs = absInVault(root, relKey(rel))
    let content
    try {
      content = fs.readFileSync(abs, 'utf8')
    } catch (e) {
      throw new VaultError(msg('readFailed', { err: e.message }))
    }
    return summaryFrom(content, Number(maxChars) > 0 ? Number(maxChars) : 240)
  },

  // —— 搜索与标签 ——

  search_vault({ query, limit }) {
    return searchVault(indexOf(this.sid), String(query == null ? '' : query), limit)
  },

  list_all_tags() {
    return listAllTags(indexOf(this.sid))
  },

  query_tag({ tag }) {
    return queryTag(indexOf(this.sid), String(tag == null ? '' : tag))
  },

  get_graph_data({ vaultRoot }) {
    resolveVaultRoot(vaultRoot, this.jail) // 与 Rust 一样只做有效性校验
    return graphData(indexOf(this.sid))
  },

  // —— 快照：.notelume-backup/YYYY-MM-DD/{stem}-HH-MM-SS.md ——

  backup_write({ vaultRoot, args }) {
    const root = resolveVaultRoot(vaultRoot, this.jail)
    const rel = relKey(args && args.path)
    const now = new Date()
    const day = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
    const ts = `${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`
    const fileName = rel.split('/').pop() || rel
    const dot = fileName.lastIndexOf('.')
    const stem = dot >= 0 ? fileName.slice(0, dot) : fileName
    const fileRel = `${BACKUP_DIR}/${day}/${stem}-${ts}.md`
    const abs = path.join(root, ...fileRel.split('/'))
    try {
      fs.mkdirSync(path.dirname(abs), { recursive: true })
      fs.writeFileSync(abs, String((args && args.content) || ''), 'utf8')
    } catch (e) {
      throw new VaultError(msg('writeBackupFailed', { err: e.message }))
    }
    return fileRel
  },

  list_backups({ vaultRoot, docRel }) {
    const root = resolveVaultRoot(vaultRoot, this.jail)
    const base = path.join(root, BACKUP_DIR)
    if (!fs.existsSync(base)) return []
    let stemFilter = null
    if (docRel) {
      const fileName = relKey(docRel).split('/').pop()
      const dot = fileName.lastIndexOf('.')
      stemFilter = dot >= 0 ? fileName.slice(0, dot) : fileName
    }
    const out = []
    let days
    try {
      days = fs.readdirSync(base, { withFileTypes: true })
    } catch (e) {
      throw new VaultError(msg('readBackupFailed', { err: e.message }))
    }
    for (const d of days) {
      if (!d.isDirectory()) continue
      const day = d.name
      let files
      try {
        files = fs.readdirSync(path.join(base, day))
      } catch (e) {
        continue // 目录正好被并发清掉：跳过这一天
      }
      for (const name of files) {
        if (!name.endsWith('.md')) continue
        if (stemFilter != null && !name.startsWith(`${stemFilter}-`)) continue
        const full = path.join(base, day, name)
        if (!fs.statSync(full).isFile()) continue
        out.push({ path: relInVault(root, full), day, name })
      }
    }
    out.sort((a, b) => (a.day === b.day ? cmpName(b.name, a.name) : cmpName(b.day, a.day)))
    return out
  },

  /** 只允许读备份目录内的快照：前缀白名单 + absInVault 双重防穿越（与 Rust 同） */
  read_backup({ vaultRoot, backupRel }) {
    const root = resolveVaultRoot(vaultRoot, this.jail)
    const norm = relKey(backupRel)
    if (!norm.startsWith(`${BACKUP_DIR}/`)) throw new VaultError(msg('backupOnly'))
    const abs = absInVault(root, norm)
    try {
      return fs.readFileSync(abs, 'utf8')
    } catch (e) {
      throw new VaultError(msg('readBackupFailed', { err: e.message }))
    }
  },
}

const cmpName = (a, b) => (a < b ? -1 : a > b ? 1 : 0)
