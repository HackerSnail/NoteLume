// file-association-icons.test.mjs —— .md / .canvas 关联文件图标（不再共用主程序图标）
// 运行：cd src && node tests/file-association-icons.test.mjs
//
// 背景：Tauri 的 fileAssociations 把文档类型图标一律指向主程序图标，资源管理器 / 访达里
// .md 和 .canvas 与普通白纸文档长得一样。本次改动分三处落点：
//   macOS：Info.macOS.plist 给每个文档类型加 CFBundleTypeIconFile，icns 经 bundle.resources 落到 Contents/Resources 根；
//   Windows：nsis-hooks.nsh 在安装末尾把 ProgID 的 DefaultIcon 改指随包的 ico；
//   两侧共用 scripts/gen-file-icons.py 的产物。
// 这类配置最容易出的问题是各处名字对不上（改了 conf 的 name 忘了改 nsh 的 ProgID、
// 改了 resources 的目标名忘了改 plist 的图标文件名），所以断言全部按「互相引用」来写。

import assert from 'node:assert'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SRC = path.resolve(HERE, '..')
const TAURI = path.resolve(SRC, '..', 'src-tauri')

const read = (...p) => fs.readFileSync(path.join(TAURI, ...p), 'utf8')
const readBuf = (...p) => fs.readFileSync(path.join(TAURI, ...p))

const conf = JSON.parse(read('tauri.conf.json'))
const plist = read('Info.macOS.plist')
const nsh = read('nsis-hooks.nsh')

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

// 从 Info.macOS.plist 取 CFBundleDocumentTypes 的每个 dict（plist 是固定缩进的 XML，按 key 顺序取标量）
function documentTypes(xml) {
  const start = xml.indexOf('<key>CFBundleDocumentTypes</key>')
  assert.ok(start >= 0, 'plist 里没有 CFBundleDocumentTypes')
  const arrStart = xml.indexOf('<array>', start)
  // 顶层数组以两空格缩进收口，嵌套数组缩进更深；只按 </array> 会停在第一个扩展名数组上
  const arrEnd = xml.indexOf('\n  </array>', arrStart)
  assert.ok(arrEnd > arrStart, '没找到 CFBundleDocumentTypes 数组的结束')
  const body = xml.slice(arrStart, arrEnd)
  return body.split('<dict>').slice(1).map((chunk) => {
    const one = chunk.split('</dict>')[0]
    const scalar = (key) => {
      const k = one.indexOf(`<key>${key}</key>`)
      if (k < 0) return null
      const m = /<string>([\s\S]*?)<\/string>/.exec(one.slice(k + key.length + 12))
      return m ? m[1].trim() : null
    }
    const list = (key) => {
      const k = one.indexOf(`<key>${key}</key>`)
      if (k < 0) return []
      const s = one.indexOf('<array>', k)
      const e = one.indexOf('</array>', s)
      if (s < 0 || e < 0) return []
      return [...one.slice(s, e).matchAll(/<string>([\s\S]*?)<\/string>/g)].map((m) => m[1].trim())
    }
    return {
      name: scalar('CFBundleTypeName'),
      role: scalar('CFBundleTypeRole'),
      icon: scalar('CFBundleTypeIconFile'),
      exts: list('CFBundleTypeExtensions'),
      contentTypes: list('LSItemContentTypes'),
    }
  })
}

const types = documentTypes(plist)
const associations = conf.bundle.fileAssociations
const resources = conf.bundle.resources || {}

check('夹具：关联类型两条、文档类型三条', () => {
  assert.equal(associations.length, 2, JSON.stringify(associations.map((a) => a.name)))
  assert.equal(types.length, 3, JSON.stringify(types.map((t) => t.name)))
})

check('mac：每个关联类型都有同名文档类型且带 CFBundleTypeIconFile', () => {
  for (const a of associations) {
    const t = types.find((x) => x.name === a.name)
    assert.ok(t, `plist 缺文档类型「${a.name}」`)
    assert.ok(t.icon, `「${a.name}」没有 CFBundleTypeIconFile，仍会退回主程序图标`)
    assert.deepEqual(t.exts, a.ext, `「${a.name}」扩展名与 conf 不一致：${t.exts} vs ${a.ext}`)
  }
})

check('mac：图标文件名经 resources 随包落地，落点就在 Contents/Resources 根', () => {
  for (const t of types) {
    if (!t.icon) continue
    const mapped = Object.entries(resources).find(([, dst]) => dst === t.icon)
    assert.ok(mapped, `plist 引用的 ${t.icon} 没有对应的 bundle.resources 条目`)
    const srcRel = mapped[0]
    assert.ok(srcRel.endsWith('.icns'), `${t.icon} 的来源应是 icns，实际 ${srcRel}`)
    assert.ok(fs.existsSync(path.join(TAURI, srcRel)), `源文件缺失：${srcRel}`)
    assert.equal(path.posix.dirname(dst(t.icon)), '.', `icns 目标 ${t.icon} 不应带子目录`)
  }
})

function dst(name) {
  const hit = Object.entries(resources).find(([, d]) => d === name)
  return hit ? hit[1] : name
}

check('异常：目录关联类型不配文档图标（它不是文件类型）', () => {
  const folder = types.find((t) => t.contentTypes.includes('public.folder'))
  assert.ok(folder, '缺 NoteLume Vault Folder 目录类型')
  assert.equal(folder.icon, null, `目录类型不应带 CFBundleTypeIconFile，实际 ${folder.icon}`)
  assert.equal(folder.role, 'Viewer')
})

check('资产：icns 魔数为 icns、ico 魔数为 0000-0100，且两对互不相同', () => {
  const icns = { 'file-markdown.icns': '69636e73', 'file-canvas.icns': '69636e73' }
  for (const [f, magic] of Object.entries(icns)) {
    const buf = readBuf('icons', f)
    assert.equal(buf.subarray(0, 4).toString('hex'), magic, `${f} 不是合法 icns`)
  }
  const a = readBuf('icons', 'file-markdown.icns')
  const b = readBuf('icons', 'file-canvas.icns')
  assert.notEqual(a.subarray(0, 64).toString('hex'), b.subarray(0, 64).toString('hex'), '两枚 icns 内容相同')
  const icos = ['file-markdown.ico', 'file-canvas.ico']
  const entries = []
  for (const f of icos) {
    const buf = readBuf('icons', f)
    assert.equal(buf.readUInt16LE(0), 0, `${f} reserved 段非 0`)
    assert.equal(buf.readUInt16LE(2), 1, `${f} 类型段不是 icon(1)`)
    entries.push(buf.readUInt16LE(4))
  }
  assert.deepEqual(entries, [9, 9], `ico 尺寸条目应为 9（16..256），实际 ${entries}`)
})

check('Windows：nsis 的 ProgID 与 conf 的关联名逐项对齐', () => {
  const progIds = [...nsh.matchAll(/Software\\Classes\\([^"\\]+)\\DefaultIcon/g)].map((m) => m[1])
  assert.deepEqual(progIds.sort(), associations.map((a) => a.name).sort(),
    `nsh 的 ProgID ${progIds} 与 fileAssociations 的 name ${associations.map((a) => a.name)} 对不上`)
})

check('Windows：DefaultIcon 指向随包 ico 且带索引 ,0', () => {
  // nsh 里引号用 $\" 转义，整条形如：
  //   WriteRegStr SHCTX "Software\Classes\NoteLume Markdown\DefaultIcon" "" "$\"$INSTDIR\icons\file-markdown.ico$\",0"
  const pairs = [...nsh.matchAll(/DefaultIcon" "" "(.+)",0"/g)].map((m) => m[1])
  assert.equal(pairs.length, 2, `DefaultIcon 写入 ${pairs.length} 条`)
  const expect = { 'NoteLume Markdown': 'file-markdown.ico', 'NoteLume Canvas': 'file-canvas.ico' }
  const lines = nsh.split('\n').filter((l) => l.trimStart().startsWith('WriteRegStr') && l.includes('DefaultIcon'))
  for (const line of lines) {
    const prog = /Software\\Classes\\([^"\\]+)\\DefaultIcon/.exec(line)
    assert.ok(prog, `ProgID 解析失败：${line}`)
    const want = expect[prog[1]]
    assert.ok(want, `ProgID「${prog[1]}」不在关联类型表里`)
    assert.ok(line.includes(`$INSTDIR\\icons\\${want}$\\"`), `图标路径不符：${line}`)
    assert.ok(/,\s*0"\s*$/.test(line), `缺少图标索引 ,0：${line}`)
  }
  const icoTargets = Object.values(resources).filter((d) => d.endsWith('.ico'))
  assert.deepEqual(icoTargets.sort(), ['icons/file-canvas.ico', 'icons/file-markdown.ico'],
    'ico 的 resources 目标名要和 nsh 里的路径同名')
})

check('Windows：装卸各通知一次外壳重建图标缓存，钩子宏名正确', () => {
  assert.match(nsh, /!macro NSIS_HOOK_POSTINSTALL/)
  assert.match(nsh, /!macro NSIS_HOOK_POSTUNINSTALL/)
  assert.equal((nsh.match(/UPDATEFILEASSOC/g) || []).length, 2, 'UPDATEFILEASSOC 应恰好两次（装 / 卸各一次）')
  assert.equal(conf.bundle.windows.nsis.installerHooks, 'nsis-hooks.nsh')
  assert.ok(fs.existsSync(path.join(TAURI, 'nsis-hooks.nsh')))
})

check('产物层：已构建的 .app 里两枚 icns 与源文件逐字节相同（未构建则跳过）', () => {
  const appDir = path.join(TAURI, 'target', 'release', 'bundle', 'macos', 'NoteLume.app')
  if (!fs.existsSync(appDir)) {
    console.log('   （无 mac 构建产物，跳过产物层比对）')
    return
  }
  const res = path.join(appDir, 'Contents', 'Resources')
  for (const f of ['file-markdown.icns', 'file-canvas.icns']) {
    const shipped = path.join(res, f)
    assert.ok(fs.existsSync(shipped), `装机包缺 ${f}`)
    assert.ok(fs.readFileSync(shipped).equals(readBuf('icons', f)), `${f} 与源文件不一致`)
  }
  const iconsDir = path.join(res, 'icons')
  for (const f of ['file-markdown.ico', 'file-canvas.ico']) {
    assert.ok(fs.existsSync(path.join(iconsDir, f)), `装机包缺 icons/${f}`)
  }
  const info = fs.readFileSync(path.join(appDir, 'Contents', 'Info.plist'), 'utf8')
  for (const f of ['file-markdown.icns', 'file-canvas.icns']) {
    assert.ok(info.includes(f), `装机包 Info.plist 未写入 ${f}`)
  }
})

console.log(`\n结果: ${pass} passed, ${fail} failed`)
if (fail) process.exitCode = 1
