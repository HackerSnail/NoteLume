// scripts/wrap-mac-dmg.mjs —— mac 打包的收尾：补 ad-hoc 签名 + 把「打开说明.txt」装进 dmg 卷宗
//
// 挂在 package.json 的 postbuild 上：`npm run build` 出完 bundle 自动跑这一趟，
// 所以任何人、任何时候打出来的 dmg 都带着那份说明（Tauri 自己的 bundle_dmg.sh 只装 app 与
// Applications 软链，加不了第三个文件，故在它之后按 stage 重卷一次）。非 mac 直接退出 0。
//
// 顺序不能反：先 codesign 再组卷——npm run build 的产物是 linker-signed，直接分发报「已损坏」；
// 说明文件在签名之后放进 stage，不参与签名校验。

import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, rmSync, existsSync, statSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

if (process.platform !== 'darwin') process.exit(0)

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const bundle = join(root, 'src-tauri', 'target', 'release', 'bundle')
const app = join(bundle, 'macos', 'NoteLume.app')
if (!existsSync(app) || !statSync(app).isDirectory()) {
  console.error(`找不到 ${app}，先跑 npm run build`)
  process.exit(1)
}

const version = JSON.parse(readFileSync(join(root, 'src-tauri', 'tauri.conf.json'), 'utf8')).version
const dmg = join(bundle, 'dmg', `NoteLume_${version}_aarch64.dmg`)

execFileSync('codesign', ['--force', '--deep', '-s', '-', app], { stdio: 'inherit' })

const stage = join(root, 'tmp', 'dmg-stage')
rmSync(stage, { recursive: true, force: true })
mkdirSync(stage, { recursive: true })
cpSync(app, join(stage, 'NoteLume.app'), { recursive: true })
execFileSync('ln', ['-s', '/Applications', join(stage, 'Applications')])
cpSync(join(root, 'docs', 'macOS打开说明.txt'), join(stage, '打开说明.txt'))
for (const junk of walk(stage, '.DS_Store')) rmSync(junk, { force: true }) // 卷宗里不留 Finder 垃圾

function walk(dir, name) {
  const hits = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name)
    if (entry.isDirectory()) hits.push(...walk(p, name))
    else if (entry.name === name) hits.push(p)
  }
  return hits
}

execFileSync('hdiutil', ['create', '-volname', 'NoteLume', '-srcfolder', stage, '-ov', '-format', 'UDZO', dmg], { stdio: 'inherit' })
console.log(dmg)
