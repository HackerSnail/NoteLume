// run.mjs —— 网页版测试的跑批入口：server/tests/*.test.mjs + src/tests/web-*.test.mjs
//
// 不用 node --test：那套要求测试文件里用 node:test 的 test()，而仓库既有测试（src/tests/）
// 是「裸 node 直接跑 + 失败 exit 1」的手写风格，这里保持一致，Phase 4 加测试也不用改脚本。
// src/tests 下只收 web- 前缀的：那是网页端的替身/文案测试，跟桌面测试同一目录但互不干扰。
//
// 运行：npm run web:test（根目录）

import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SUITES = [
  { dir: HERE, pick: (f) => f.endsWith('.test.mjs'), label: (f) => f },
  { dir: path.join(HERE, '..', '..', 'src', 'tests'), pick: (f) => f.startsWith('web-') && f.endsWith('.test.mjs'), label: (f) => 'src/tests/' + f },
]

const jobs = []
for (const s of SUITES) {
  if (!fs.existsSync(s.dir)) continue
  for (const f of fs.readdirSync(s.dir).filter(s.pick).sort()) {
    jobs.push({ name: s.label(f), file: path.join(s.dir, f) })
  }
}

let failed = 0
for (const j of jobs) {
  console.log(`\n=== ${j.name} ===`)
  const r = spawnSync(process.execPath, [j.file], { stdio: 'inherit' })
  if (r.status !== 0) {
    failed++
    console.log(`--- ${j.name} 退出码 ${r.status} ---`)
  }
}

console.log(`\n合计：${jobs.length - failed}/${jobs.length} 个测试文件通过`)
if (failed) process.exit(1)
