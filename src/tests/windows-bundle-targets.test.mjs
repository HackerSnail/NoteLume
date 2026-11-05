// windows-bundle-targets.test.mjs —— Windows 打包只出 NSIS，不再指望 MSI
// 运行：cd src && node tests/windows-bundle-targets.test.mjs
//
// 背景：base 配置 bundle.targets 是 "all"，Windows 上会同时排 msi 与 nsis。打 msi 走 WiX v3
// 的 light.exe，而 CI 的 windows-latest（Server 2025）镜像已移除 .NET Framework 3.5 预装，
// light.exe 会无输出直接失败；CI 那格因此钉死 runs_on: windows-2022 且 bundles: nsis。
// 本地 npm run build 走 "all" 仍会撞同一条 msi 链路，所以加一份平台覆盖配置
// src-tauri/tauri.windows.conf.json（Tauri v2 按 tauri.{platform}.conf.json 自动合并，
// 不需要额外命令行参数）把 Windows 的 targets 收成 nsis。
// 这里钉三面：覆盖文件本身形状正确、没有把 base 的其它键抄一份造成两处漂移、CI 口径一致。

import assert from 'node:assert'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SRC = path.resolve(HERE, '..')
const ROOT = path.resolve(SRC, '..')
const TAURI = path.join(ROOT, 'src-tauri')

let pass = 0
let fail = 0
function check(name, fn) {
  try {
    fn()
    console.log(`✅ ${name}`)
    pass++
  } catch (e) {
    console.error(`❌ ${name}: ${e.message}`)
    fail++
  }
}

const WIN_CONF = 'tauri.windows.conf.json'
const winPath = path.join(TAURI, WIN_CONF)
const win = JSON.parse(fs.readFileSync(winPath, 'utf8'))
const base = JSON.parse(fs.readFileSync(path.join(TAURI, 'tauri.conf.json'), 'utf8'))

check('夹具：平台覆盖文件名按 Tauri 约定命名（后缀拼错则整份不生效）', () => {
  const hits = fs.readdirSync(TAURI).filter((f) => /^tauri\..*\.conf\.json$/.test(f))
  assert.deepEqual(hits, [WIN_CONF], `实际存在 ${hits}`)
})

check('Windows：targets 收成数组单值 nsis', () => {
  assert.deepEqual(win.bundle.targets, ['nsis'])
  assert.ok(!JSON.stringify(win.bundle.targets).includes('msi'), 'targets 里不应残留 msi')
})

check('范围：只覆盖 bundle.targets 一个键，其余仍来自 base', () => {
  assert.deepEqual(Object.keys(win).sort(), ['$schema', 'bundle'])
  assert.deepEqual(Object.keys(win.bundle), ['targets'])
})

check('接线：schema 与 base 同一份 v2 约定', () => {
  assert.equal(win.$schema, base.$schema)
  assert.match(String(win.$schema), /\/config\/2$/)
})

check('base：mac 与 linux 分支不受影响，targets 仍是 all', () => {
  assert.equal(base.bundle.targets, 'all')
  assert.equal(base.bundle.active, true)
  assert.ok(base.bundle.macOS.infoPlist, 'macOS infoPlist 覆盖应保留')
  assert.ok(base.bundle.linux, 'linux 打包段应保留')
})

check('异常：覆盖文件不重复声明资源与关联（防两处漂移）', () => {
  for (const key of ['resources', 'fileAssociations', 'externalBin', 'icon']) {
    assert.ok(!(key in win.bundle), `覆盖文件出现了 ${key}，与 base 各写一份会漂移`)
  }
  for (const key of ['productName', 'version', 'identifier', 'build']) {
    assert.ok(!(key in win), `覆盖文件出现了顶层 ${key}`)
  }
})

check('Windows：nsis 钩子在 base 里声明且文件随包存在', () => {
  assert.equal(base.bundle.windows.nsis.installerHooks, 'nsis-hooks.nsh')
  assert.ok(fs.existsSync(path.join(TAURI, base.bundle.windows.nsis.installerHooks)))
})

check('CI 口径：windows 那格 bundles 与本地一致，产物 glob 指向 nsis 的 exe', () => {
  const yml = fs.readFileSync(path.join(ROOT, '.github', 'workflows', 'build.yml'), 'utf8')
  const winBlock = yml.split('\n').slice(
    yml.split('\n').findIndex((l) => l.includes('platform: windows')),
  ).slice(0, 12).join('\n')
  assert.match(winBlock, /bundles:\s*nsis/, 'CI windows 格应只打 nsis')
  assert.match(winBlock, /bundle\/nsis\/\*\.exe/, 'CI 产物路径应指向 nsis 目录下的 exe')
  assert.ok(!/\*\.(msi)/.test(winBlock), 'CI windows 格不应再收 msi 产物')
})

check('边界：Windows 产物命名只依赖版本号，版本仍与 base 同步', () => {
  assert.equal(base.version, JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version)
  assert.equal(base.version, JSON.parse(fs.readFileSync(path.join(SRC, 'package.json'), 'utf8')).version)
})

console.log(`\n结果: ${pass} passed, ${fail} failed`)
if (fail) process.exitCode = 1
