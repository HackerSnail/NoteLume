// plugin-manifest.js —— 批次 F1 纯逻辑：插件 manifest 解析/校验 + 权限同意决策（无 DOM、可单测）
// 校验的唯一真源在此（Rust 只当文件系统枚举器、不解析 JSON）。
import { t } from './i18n.js'

export const KNOWN_SCOPES = ['network', 'fs-vault', 'fs-outside', 'git', 'schema', 'persistent-store']

// scope → [label 词条键, 是否高危]。同意弹窗与面板共用；label 在渲染点经 t() 取，
// 切语言后重渲染即换文案（模块级只存键名，不存成品文案）。
const SCOPE_META = {
  network: ['plugin.scope.network', false],
  'fs-vault': ['plugin.scope.fsVault', false],
  'fs-outside': ['plugin.scope.fsOutside', true],
  git: ['plugin.scope.git', false],
  schema: ['plugin.scope.schema', false],
  'persistent-store': ['plugin.scope.persistentStore', false],
}

export function scopeMeta(scope) {
  const meta = SCOPE_META[scope]
  return meta ? { label: t(meta[0]), danger: meta[1] } : { label: String(scope), danger: false }
}

const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/

// 解析并校验一个插件包的 manifest.json 原文。dirName = 一级目录名（须 === id）。
// 返回 { ok, id, name, version, author, description, main, permissions, error }
export function parseAndValidateManifest(jsonText, dirName) {
  const fail = (error) => ({ ok: false, error })
  if (typeof jsonText !== 'string' || !jsonText.trim()) return fail(t('plugin.manifest.missing'))

  let raw
  try {
    raw = JSON.parse(jsonText)
  } catch (e) {
    return fail(t('plugin.manifest.jsonBad', { err: (e && e.message) || e }))
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fail(t('plugin.manifest.notObject'))

  const id = raw.id
  if (typeof id !== 'string' || !SLUG_RE.test(id)) return fail(t('plugin.manifest.idBad'))
  if (id !== dirName) return fail(t('plugin.manifest.idMismatch', { id, dirName }))

  const name = raw.name
  if (typeof name !== 'string' || !name.trim()) return fail(t('plugin.manifest.nameEmpty'))

  const main = typeof raw.main === 'string' && raw.main ? raw.main : 'main.js'
  if (!(main.endsWith('.js') || main.endsWith('.mjs'))) return fail(t('plugin.manifest.mainBad'))

  const version = typeof raw.version === 'string' && raw.version ? raw.version : '0.0.0'
  const author = typeof raw.author === 'string' ? raw.author : ''
  const description = typeof raw.description === 'string' ? raw.description : ''

  const perms = raw.permissions === undefined ? [] : raw.permissions
  if (!Array.isArray(perms)) return fail(t('plugin.manifest.permsNotArray'))
  for (const p of perms) {
    if (typeof p !== 'string' || !KNOWN_SCOPES.includes(p)) return fail(t('plugin.manifest.unknownScope', { scope: String(p) }))
  }

  return { ok: true, id, name, version, author, description, main, permissions: perms.slice(), error: null }
}

// —— 权限同意决策 ——
export function permKey(perms) {
  return (perms || []).slice().sort().join('|')
}

// stored: { perms: string[] } | undefined；declaredPerms: string[]。
// 一律弹：无存储记录即需同意；permKey 相等则已同意；否则（权限集变更）需重新同意。
export function needsConsent(declaredPerms, stored) {
  if (!stored) return true
  return permKey(declaredPerms) !== permKey(stored.perms || [])
}

// declared 相对 stored 新增的 scope（供弹窗高亮）。stored 缺省时全部算新增。
export function newPerms(declaredPerms, stored) {
  const had = new Set((stored && stored.perms) || [])
  return (declaredPerms || []).filter((p) => !had.has(p))
}
