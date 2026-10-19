// docx-import.test.mjs —— 网页沙盒服务端 .docx 解析（docx_preview / docx_commit）的行为锁定
// 运行：cd server && node tests/docx-import.test.mjs（或根目录 npm run web:test）
//
// 本机模式（jail = null）跑命令语义：preview 出 wire 契约字段、commit 落盘 + 去重索引 + 复用；
// 监狱约束本身在 sandbox.test.mjs，这里不重复。图片/公式样本在内存里用 adm-zip 现造，避免依赖外部文件。

import crypto from 'node:crypto'
import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import AdmZip from 'adm-zip'
import { dispatch } from '../src/router.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))

let pass = 0
let fail = 0
function test(name, fn) {
  try {
    fn()
    pass++
    console.log('  ok   ' + name)
  } catch (e) {
    fail++
    console.log('  FAIL ' + name + ' —— ' + ((e && e.message) || e))
  }
}

const ctx = { sid: 'local', jail: null }
const ok = (cmd, params, label) => {
  const r = dispatch(ctx, cmd, params)
  assert.equal(r.ok, true, `${label || cmd} 应当成功：` + (r.error || ''))
  return r.result
}
const bad = (cmd, params, label) => {
  const r = dispatch(ctx, cmd, params)
  assert.equal(r.ok, false, `${label || cmd} 应当失败`)
  return r
}

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
function buildDocx({ documentXml, relsXml, media }) {
  const z = new AdmZip()
  z.addFile('[Content_Types].xml', Buffer.from('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>'))
  z.addFile('_rels/.rels', Buffer.from(`<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rIdD" Type="${R}/officeDocument" Target="word/document.xml"/></Relationships>`))
  z.addFile('word/document.xml', Buffer.from(documentXml))
  if (relsXml) z.addFile('word/_rels/document.xml.rels', Buffer.from(relsXml))
  for (const [name, buf] of Object.entries(media || {})) z.addFile('word/' + name, Buffer.isBuffer(buf) ? buf : Buffer.from(buf))
  return z.toBuffer()
}
const b64 = (buf) => buf.toString('base64')

// ---------- 真实样例：从 default-vault 读字节走 srcB64 ----------
const samplePath = path.join(HERE, '..', 'default-vault', '示例文档.docx')
const sampleB64 = fs.readFileSync(samplePath).toString('base64')

test('docx_preview：样例出齐 wire 字段、标题与 plannedDocRel 正确', () => {
  const p = ok('docx_preview', { args: { srcB64: sampleB64, srcDisplayName: '示例文档.docx', destDir: '', withFrontmatter: true, maxImageBytes: 8388608, dedupIndex: {} } })
  assert.equal(typeof p.md, 'string')
  assert.ok(p.md.includes('# NoteLume'), '正文应含一级标题')
  assert.ok(p.md.startsWith('---\nsource:'), 'withFrontmatter 应在头部拼 source/imported')
  assert.ok(/imported: "\d{4}-\d{2}-\d{2}"/.test(p.md), 'imported 是当天日期')
  assert.equal(p.title, 'NoteLume · Word 导入示例')
  assert.equal(p.plannedDocRel, 'NoteLume-Word-导入示例/NoteLume-Word-导入示例.md')
  assert.ok(Array.isArray(p.images) && Array.isArray(p.warnings) && p.stats && typeof p.stats.words === 'number')
  assert.equal(p.slug, undefined, 'slug 是内部量，不进 wire')
})

test('docx_preview：srcPath 分支读绝对路径、与 srcB64 结果一致', () => {
  const p2 = ok('docx_preview', { args: { srcPath: samplePath, destDir: '', withFrontmatter: true, maxImageBytes: 8388608, dedupIndex: {} } })
  assert.equal(p2.title, 'NoteLume · Word 导入示例')
  assert.ok(p2.md.startsWith('---\nsource: "示例文档.docx"'), 'srcPath 分支用文件名做 source')
})

test('docx_preview：无来源时报错而非抛崩', () => {
  bad('docx_preview', { args: { destDir: '' } }, '缺来源')
})

// ---------- 图片 + 去重 ----------
const IMG_SHA = crypto.createHash('sha256').update(Buffer.from('fake-png-bytes')).digest('hex')
const docWithImage = buildDocx({
  documentXml: `<w:document xmlns:w="${W}" xmlns:r="${R}"><w:body><w:p><w:r><w:drawing><wp:inline xmlns:wp="x"><a:graphic xmlns:a="y"><pic:pic xmlns:pic="z"><pic:blipFill><a:blip r:embed="rId1"/></pic:blipFill></pic:pic></a:graphic></wp:inline></w:drawing></w:r></w:p></w:body></w:document>`,
  relsXml: `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${R}/image" Target="media/image1.png"/></Relationships>`,
  media: { 'media/image1.png': 'fake-png-bytes' },
})

test('docx_preview：图片按 <sha12>.<ext> 内联、images 带 sha/dataB64/plannedRel', () => {
  const p = ok('docx_preview', { args: { srcB64: b64(docWithImage), srcDisplayName: 'img.docx', destDir: '', withFrontmatter: false, maxImageBytes: 8388608, dedupIndex: {} } })
  const im = p.images[0]
  assert.equal(p.images.length, 1)
  assert.equal(im.sha256, IMG_SHA)
  assert.equal(im.ext, 'png')
  assert.ok(im.dataB64 && im.bytes > 0)
  assert.equal(im.reused, false)
  assert.equal(im.plannedRel, 'img/' + IMG_SHA.slice(0, 12) + '.png')
  assert.ok(p.md.includes(IMG_SHA.slice(0, 12) + '.png'), 'md 正文以 sha12 基名引用图片')
})

test('docx_commit：落 md + 图片，回 docRel/updatedIndex', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'nl-docx-'))
  try {
    const p = ok('docx_preview', { args: { srcB64: b64(docWithImage), srcDisplayName: 'img.docx', destDir: '', withFrontmatter: false, maxImageBytes: 8388608, dedupIndex: {} } })
    const c = ok('docx_commit', { args: { vaultRoot: base, destDir: '', md: p.md, docRel: p.plannedDocRel, images: p.images, dedupIndex: {}, newTitle: null } })
    assert.equal(c.docRel, 'img/img.md')
    assert.ok(fs.existsSync(path.join(base, 'img', 'img.md')))
    assert.ok(fs.existsSync(path.join(base, ...p.images[0].plannedRel.split('/'))), '图片应落盘')
    assert.equal(c.updatedIndex[IMG_SHA], 'img/' + IMG_SHA.slice(0, 12) + '.png')
    assert.deepEqual(c.writtenImages.length, 1)
  } finally {
    fs.rmSync(base, { recursive: true, force: true })
  }
})

test('带 dedupIndex 再 preview → 图片 reused=true、plannedRel 沿用旧路径', () => {
  const idx = {}
  idx[IMG_SHA] = 'elsewhere/keep.png'
  const p = ok('docx_preview', { args: { srcB64: b64(docWithImage), srcDisplayName: 'img.docx', destDir: '', withFrontmatter: false, maxImageBytes: 8388608, dedupIndex: idx } })
  assert.equal(p.images[0].reused, true)
  assert.equal(p.images[0].plannedRel, 'elsewhere/keep.png')
})

// ---------- commit 改名 / 冲突 ----------
test('docx_commit：newTitle 改名、同名冲突补 -2', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'nl-docx-'))
  try {
    const args = { vaultRoot: base, destDir: '', md: '# hi', docRel: 'A/A.md', images: [], dedupIndex: {}, newTitle: 'B Title' }
    const c1 = ok('docx_commit', { args })
    assert.equal(c1.docRel, 'A/B-Title.md')
    const c2 = ok('docx_commit', { args }) // 再来一次 → 冲突补 -2
    assert.equal(c2.docRel, 'A/B-Title-2.md')
  } finally {
    fs.rmSync(base, { recursive: true, force: true })
  }
})

// ---------- 降级：公式出 warning 而不抛 ----------
test('公式 m:oMathPara 降级为 warning（mathDropped），不抛错', () => {
  const buf = buildDocx({
    documentXml: `<w:document xmlns:w="${W}" xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"><w:body><w:p><m:oMathPara><m:oMath><m:r><m:t>E=mc2</m:t></m:r></m:oMath></m:oMathPara></w:p></w:body></w:document>`,
  })
  const p = ok('docx_preview', { args: { srcB64: b64(buf), srcDisplayName: 'math.docx', destDir: '', withFrontmatter: false, maxImageBytes: 8388608, dedupIndex: {} } })
  assert.ok(p.warnings.some((w) => w.code === 'mathDropped'), '应有 mathDropped')
  assert.equal(p.stats.math, 1)
  assert.ok(p.md.includes('E=mc2'), '公式文本降级保留')
})

test('非法字节 → 报错而非崩', () => {
  bad('docx_preview', { args: { srcB64: 'notazip', srcDisplayName: 'x.docx', destDir: '' } }, '坏 zip')
})

console.log('结果：' + pass + ' passed, ' + fail + ' failed')
if (fail) process.exit(1)
