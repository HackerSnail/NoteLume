// plugin-manifest.js —— 批次 F1 纯逻辑：插件 manifest 解析/校验 + 权限同意决策（无 DOM、可单测）
// 校验的唯一真源在此（Rust 只当文件系统枚举器、不解析 JSON）。

export const KNOWN_SCOPES = ['network', 'fs-vault', 'fs-outside', 'git', 'schema', 'persistent-store']

// scope -> 展示元数据（label + 是否高危）。同意弹窗与面板共用。
export const SCOPE_LABELS = {
  network: { label: '联网' },
  'fs-vault': { label: '库内文件' },
  'fs-outside': { label: '库外路径', danger: true },
  git: { label: 'Git' },
  schema: { label: '扩展语法' },
  'persistent-store': { label: '本地存储' },
}

const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/

// 解析并校验一个插件包的 manifest.json 原文。dirName = 一级目录名（须 === id）。
// 返回 { ok, id, name, version, author, description, main, permissions, error }
export function parseAndValidateManifest(jsonText, dirName) {
  const fail = (error) => ({ ok: false, error })
  if (typeof jsonText !== 'string' || !jsonText.trim()) return fail('缺少 manifest')

  let raw
  try {
    raw = JSON.parse(jsonText)
  } catch (e) {
    return fail('manifest JSON 非法：' + ((e && e.message) || e))
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return fail('manifest 须是对象')

  const id = raw.id
  if (typeof id !== 'string' || !SLUG_RE.test(id)) return fail('id 非法（须为小写字母/数字/连字符 slug）')
  if (id !== dirName) return fail(`id "${id}" 与目录名 "${dirName}" 不符`)

  const name = raw.name
  if (typeof name !== 'string' || !name.trim()) return fail('name 不能为空')

  const main = typeof raw.main === 'string' && raw.main ? raw.main : 'main.js'
  if (!(main.endsWith('.js') || main.endsWith('.mjs'))) return fail('main 须以 .js/.mjs 结尾')

  const version = typeof raw.version === 'string' && raw.version ? raw.version : '0.0.0'
  const author = typeof raw.author === 'string' ? raw.author : ''
  const description = typeof raw.description === 'string' ? raw.description : ''

  const perms = raw.permissions === undefined ? [] : raw.permissions
  if (!Array.isArray(perms)) return fail('permissions 须是数组')
  for (const p of perms) {
    if (typeof p !== 'string' || !KNOWN_SCOPES.includes(p)) return fail('未知权限 scope：' + String(p))
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
