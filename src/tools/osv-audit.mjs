// 依赖漏洞扫描：拿本机已安装的版本逐个问 OSV（https://osv.dev）
// 运行：cd src && node tools/osv-audit.mjs   （或 npm run audit:osv）
//
// 为什么不用 `npm audit`：本机 registry 是 npmmirror，它的 `/-/npm/v1/security/*` 端点没实现，
// audit 直接 404 报错。OSV 是公开 API，且与 Red Hat TPA 一类扫描器同一份公告源。
// 退出码：0 干净，1 有命中或有包查询失败，可直接挂进发版前检查。

import { execSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const SRC_DIR = fileURLToPath(new URL('..', import.meta.url))
const CONCURRENCY = 8

function installedPackages() {
  let raw
  try {
    raw = execSync('npm ls --all --json', { cwd: SRC_DIR, maxBuffer: 64 * 1024 * 1024, encoding: 'utf8' })
  } catch (e) {
    raw = e.stdout // 树里有 invalid / peer 问题时 npm 会非零退出，JSON 照旧可用
  }
  const found = new Map()
  const walk = (node) => {
    for (const [name, v] of Object.entries(node.dependencies || {})) {
      if (v && v.version) found.set(`${name}@${v.version}`, { name, version: v.version })
      if (v && v.dependencies) walk(v)
    }
  }
  walk(JSON.parse(raw))
  return [...found.values()]
}

function fixedVersions(vuln) {
  const set = new Set()
  for (const a of vuln.affected || []) {
    for (const r of a.ranges || []) {
      for (const e of r.events || []) if (e.fixed) set.add(e.fixed)
    }
  }
  return [...set].join(' / ') || '?'
}

async function query({ name, version }) {
  const res = await fetch('https://api.osv.dev/v1/query', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ package: { name, ecosystem: 'npm' }, version }),
  })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return (await res.json()).vulns || []
}

const pkgs = installedPackages()
const queue = [...pkgs]
const hits = []
const errors = []

async function worker() {
  while (queue.length) {
    const pkg = queue.pop()
    try {
      for (const v of await query(pkg)) hits.push({ ...pkg, vuln: v })
    } catch (e) {
      errors.push(`${pkg.name}@${pkg.version}: ${e.message}`)
    }
  }
}

await Promise.all(Array.from({ length: CONCURRENCY }, worker))

console.log(`扫描 ${pkgs.length} 个已安装包（含 devDependencies 与传递依赖）`)
for (const h of hits) {
  const sev = (h.vuln.severity || []).map((s) => s.score).join(' ') || '-'
  console.log(`  ${h.name}@${h.version}  ${h.vuln.id}  [${sev}]  ${h.vuln.summary}`)
  console.log(`      修复版本：${fixedVersions(h.vuln)}`)
}
for (const e of errors) console.log(`  查询失败 ${e}`)

if (!hits.length && !errors.length) {
  console.log('无已知漏洞')
  process.exit(0)
}
console.log(`命中 ${hits.length} 条公告，查询失败 ${errors.length} 条`)
process.exit(1)
