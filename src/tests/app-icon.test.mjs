// app-icon.test.mjs —— 主程序图标（桌面快捷方式 / 任务栏 / exe 内嵌那枚）
// 运行：cd src && node tests/app-icon.test.mjs
//
// 背景：src-tauri/icons 下那套图此前是一整块蓝紫径向渐变、零字形，桌面快捷方式和任务栏
// 就是这块色斑，而 .md / .canvas 两枚关联文件图标（scripts/gen-file-icons.py）反倒比主图标
// 有辨识度。现在主图标改成同源几何的纸页 + 白色「N」（scripts/gen-app-icon.py 画，
// tauri icon 铺全套尺寸）。
// 这类改动最容易出的两种问题：改了脚本忘了重跑、重跑了但某档尺寸没刷到，所以断言分两层——
// 接线层（conf 引用的文件都在、ico/icns 头合法、主图标与文件图标互不相同），
// 像素层（自带最小 PNG 解码读 128x128.png，中心区域既要有近白的笔画、也要留得住渐变底，
// 纯渐变与整块涂白都过不了这一条）。

import assert from 'node:assert'
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SRC = path.resolve(HERE, '..')
const ROOT = path.resolve(SRC, '..')
const ICONS = path.join(ROOT, 'src-tauri', 'icons')

const conf = JSON.parse(fs.readFileSync(path.join(ROOT, 'src-tauri', 'tauri.conf.json'), 'utf8'))

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

// 最小 PNG 解码：只吃 8bit truecolor（colortype 2/6）、非隔行——tauri icon 出的就是这一种
function decodePng(buf) {
  assert.ok(buf.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), '不是合法 PNG')
  let w = 0, h = 0, depth = 0, ctype = 0, interlace = 0
  const idat = []
  for (let i = 8; i + 8 <= buf.length;) {
    const len = buf.readUInt32BE(i)
    const type = buf.slice(i + 4, i + 8).toString('ascii')
    const data = buf.slice(i + 8, i + 8 + len)
    if (type === 'IHDR') {
      w = data.readUInt32BE(0); h = data.readUInt32BE(4)
      depth = data[8]; ctype = data[9]; interlace = data[12]
    } else if (type === 'IDAT') idat.push(data)
    i += 12 + len
  }
  assert.equal(depth, 8, `位深应为 8，实为 ${depth}`)
  assert.equal(interlace, 0, '不支持隔行 PNG')
  const bpp = ctype === 6 ? 4 : ctype === 2 ? 3 : assert.fail(`colortype 应为 2 或 6，实为 ${ctype}`)
  const stride = w * bpp
  const raw = zlib.inflateSync(Buffer.concat(idat))
  assert.equal(raw.length, h * (stride + 1), 'IDAT 解出来的长度与宽高不符')
  const rows = []
  let prev = Buffer.alloc(stride)
  for (let y = 0; y < h; y++) {
    const f = raw[y * (stride + 1)]
    const line = raw.slice(y * (stride + 1) + 1, (y + 1) * (stride + 1))
    const cur = Buffer.alloc(stride)
    for (let x = 0; x < stride; x++) {
      const a = x >= bpp ? cur[x - bpp] : 0
      const b = prev[x]
      const c = x >= bpp ? prev[x - bpp] : 0
      let v = 0
      if (f === 1) v = a
      else if (f === 2) v = b
      else if (f === 3) v = (a + b) >> 1
      else if (f === 4) {
        const p = a + b - c
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c)
        v = pa <= pb && pa <= pc ? a : (pb <= pc ? b : c)
      }
      cur[x] = (line[x] + v) & 0xff
    }
    rows.push(cur)
    prev = cur
  }
  return { w, h, bpp, ctype, rows }
}

// 中心 40% 方形区域里的亮度分布：近白（>240）算笔画，暗（<200）算渐变底
function centerLuma(img) {
  const x0 = Math.floor(img.w * 0.3), x1 = Math.ceil(img.w * 0.7)
  const y0 = Math.floor(img.h * 0.3), y1 = Math.ceil(img.h * 0.7)
  let white = 0, dark = 0, n = 0
  for (let y = y0; y < y1; y++) {
    const row = img.rows[y]
    for (let x = x0; x < x1; x++) {
      const o = x * img.bpp
      const luma = (row[o] * 299 + row[o + 1] * 587 + row[o + 2] * 114) / 1000
      if (luma > 240) white++
      else if (luma < 200) dark++
      n++
    }
  }
  return { whiteRatio: white / n, darkRatio: dark / n, n }
}

check('conf：bundle.icon 四条都真在 icons/ 下（路径没写错、文件没漏刷）', () => {
  const list = conf.bundle.icon
  assert.ok(list.length >= 4, `bundle.icon 应至少四条，实为 ${list.length}`)
  for (const rel of list) {
    assert.match(rel, /^icons\//, `${rel} 不在 icons/ 下`)
    assert.ok(fs.existsSync(path.join(ROOT, 'src-tauri', rel)), `缺文件 ${rel}`)
  }
})

check('Windows：icon.ico 头合法，帧尺寸覆盖 16 到 256', () => {
  const buf = fs.readFileSync(path.join(ICONS, 'icon.ico'))
  assert.equal(buf.readUInt16LE(0), 0, 'reserved 应为 0')
  assert.equal(buf.readUInt16LE(2), 1, '类型应为 1（图标）')
  const count = buf.readUInt16LE(4)
  assert.ok(count >= 6, `帧数偏少：${count}`)
  const sizes = []
  for (let i = 0; i < count; i++) {
    const w = buf[6 + i * 16] || 256
    const h = buf[7 + i * 16] || 256
    assert.equal(w, h, `${w}x${h} 不是方帧`)
    sizes.push(w)
  }
  assert.ok(sizes.includes(16) || Math.min(...sizes) <= 16, `最小帧偏大：${Math.min(...sizes)}`)
  assert.ok(Math.max(...sizes) >= 256, `最大帧不足 256：${Math.max(...sizes)}`)
  assert.ok(sizes.length >= new Set(sizes).size, '帧尺寸有重复')
})

check('macOS：icon.icns 魔数与总长自洽', () => {
  const buf = fs.readFileSync(path.join(ICONS, 'icon.icns'))
  assert.equal(buf.slice(0, 4).toString('ascii'), 'icns', '魔数不是 icns')
  assert.equal(buf.readUInt32BE(4), buf.length, `头部声明长度 ${buf.readUInt32BE(4)} 与文件 ${buf.length} 不符`)
})

check('像素层：128x128 中心既有白色 N、又留得住渐变底（不再是一块无色渐变）', () => {
  const img = decodePng(fs.readFileSync(path.join(ICONS, '128x128.png')))
  assert.equal(img.w, 128); assert.equal(img.h, 128)
  assert.equal(img.ctype, 6, '128x128.png 应带 alpha 通道')
  const { whiteRatio, darkRatio, n } = centerLuma(img)
  assert.ok(whiteRatio >= 0.15, `近白笔画只占中心区 ${(whiteRatio * 100).toFixed(1)}%（<15%），字标没画上去或太细`)
  assert.ok(darkRatio >= 0.10, `渐变底只占中心区 ${(darkRatio * 100).toFixed(1)}%（<10%），整块涂白了`)
  console.log(`   （中心 ${Math.sqrt(n)}x${Math.sqrt(n)} 区：白色 ${(whiteRatio * 100).toFixed(1)}%、渐变底 ${(darkRatio * 100).toFixed(1)}%）`)
})

check('尺寸档：128x128@2x 是 256 方图，与 128 档同一张设计', () => {
  const img = decodePng(fs.readFileSync(path.join(ICONS, '128x128@2x.png')))
  assert.equal(img.w, 256); assert.equal(img.h, 256)
  const { whiteRatio } = centerLuma(img)
  assert.ok(whiteRatio >= 0.15, `@2x 档近白占比 ${(whiteRatio * 100).toFixed(1)}%，与 128 档不成同一套`)
})

check('三枚图标互不相同：主图标没有和 .md / .canvas 撞图', () => {
  const app = fs.readFileSync(path.join(ICONS, 'icon.ico'))
  for (const f of ['file-markdown.ico', 'file-canvas.ico']) {
    const other = fs.readFileSync(path.join(ICONS, f))
    assert.ok(!app.equals(other), `主图标与 ${f} 逐字节相同`)
  }
  assert.ok(!fs.readFileSync(path.join(ICONS, 'file-markdown.ico')).equals(
    fs.readFileSync(path.join(ICONS, 'file-canvas.ico'))), '.md 与 .canvas 撞图')
})

check('同源几何：gen-app-icon.py 与 gen-file-icons.py 的画布、配色、纸页常量一致', () => {
  const read = (f) => fs.readFileSync(path.join(ROOT, 'scripts', f), 'utf8')
  const app = read('gen-app-icon.py')
  const file = read('gen-file-icons.py')
  for (const line of ['S = 1024', 'SS = 4', 'BLUE = (61, 111, 227)', 'PURPLE = (131, 56, 236)',
                      'RADIUS = 96', 'FOLD = 196', 'X0, Y0, X1, Y1 = 168, 104, 856, 920']) {
    assert.ok(file.includes(line), `文件图标侧缺常量「${line}」`)
    assert.ok(app.includes(line), `主图标侧缺常量「${line}」——两族几何漂移了`)
  }
  // 字标是 N：左竖、左上到右下斜、右竖四点，线宽比 M↓ 的 68 加粗
  assert.match(app, /stroke\(d, \[\(342, 677\), \(342, 347\), \(682, 677\), \(682, 347\)\], 84/,
    '主图标字标不是那串 N 折线')
})

console.log(`\n结果: ${pass} passed, ${fail} failed`)
if (fail) process.exitCode = 1
