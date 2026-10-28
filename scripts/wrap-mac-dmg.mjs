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
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

if (process.platform !== 'darwin') process.exit(0)

const root = dirname(dirname(fileURLToPath(import.meta.url)))
// 可选参数：bundle 目录（相对仓库根）。交叉编译时 tauri 把产物放在 target/<triple>/release/bundle，
// 传那个路径进来收尾；本机架构构建（本地 npm run build 与 CI 各格）走默认的 target/release/bundle。
const bundle = process.argv[2]
  ? resolve(root, process.argv[2])
  : join(root, 'src-tauri', 'target', 'release', 'bundle')
const app = join(bundle, 'macos', 'NoteLume.app')
if (!existsSync(app) || !statSync(app).isDirectory()) {
  console.error(`找不到 ${app}，先跑 npm run build`)
  process.exit(1)
}

const version = JSON.parse(readFileSync(join(root, 'src-tauri', 'tauri.conf.json'), 'utf8')).version
// 卷宗名里的架构段跟着产物走：本地与 CI 的 arm64 包是 aarch64，Intel runner 上打出来的是 x64，
// 两种都在 CI 的上传 glob 里，名字写死一种会把另一台机器的包覆盖成错的型号
const arches = execFileSync('lipo', ['-archs', join(app, 'Contents', 'MacOS', 'NoteLume')], { encoding: 'utf8' })
  .trim().split(/\s+/)
const arch = arches.length > 1 ? 'universal' : (arches[0] === 'x86_64' ? 'x64' : 'aarch64')
const dmgDir = join(bundle, 'dmg')
const dmg = join(dmgDir, `NoteLume_${version}_${arch}.dmg`)

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

mkdirSync(dmgDir, { recursive: true })
// Tauri 那份既没补签名也没带说明，重卷前清掉，卷宗目录里只留这一份（CI 的上传 glob 收 *.dmg）
for (const stale of readdirSync(dmgDir)) if (/^NoteLume_.*\.dmg$/.test(stale)) rmSync(join(dmgDir, stale), { force: true })

execFileSync('hdiutil', ['create', '-volname', 'NoteLume', '-srcfolder', stage, '-ov', '-format', 'UDZO', dmg], { stdio: 'inherit' })
console.log(dmg)
