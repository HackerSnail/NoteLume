// pdf-print-name.test.mjs —— 导出 PDF 时「另存为 PDF」默认名取当前文档名
// 运行：cd src && node tests/pdf-print-name.test.mjs
//
// 覆盖：路径/后缀清理、Windows 非法字符、未命名 i18n 兜底、main.js 打印期临时改 document.title 并恢复、
// 其它导出（HTML / 幻灯片）的默认名不受影响。

import assert from 'node:assert'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { pdfPrintBaseName } from '../print-paged.js'
import { setLocale } from '../i18n.js'

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const read = (rel) => fs.readFileSync(path.join(SRC, rel), 'utf8')

let pass = 0, fail = 0
function check(name, fn) {
  try { fn(); console.log(`✅ ${name}`); pass++ }
  catch (e) { console.error(`❌ ${name}: ${e.message}`); fail++ }
}

check('取路径最后一段并去掉 .md 后缀（大小写不敏感）', () => {
  assert.strictEqual(pdfPrintBaseName('验收文档.md'), '验收文档')
  assert.strictEqual(pdfPrintBaseName('docs/验收文档.md'), '验收文档')
  assert.strictEqual(pdfPrintBaseName('docs\\验收文档.MD'), '验收文档')
})

check('清理 Windows 非法字符与尾部空格/点', () => {
  assert.strictEqual(pdfPrintBaseName('a/b:c*d?e"f<g>h|i.md'), 'b_c_d_e_f_g_h_i')
  assert.strictEqual(pdfPrintBaseName('  验收文档 . .md  '), '验收文档')
})

check('空值回退 i18n 未命名（五语言）', () => {
  const expected = {
    'zh-CN': '未命名',
    'zh-Hant': '未命名',
    'en-US': 'Untitled',
    'fr-FR': 'Sans titre',
    'de-DE': 'Unbenannt',
  }
  for (const [locale, name] of Object.entries(expected)) {
    assert.ok(setLocale(locale))
    assert.strictEqual(pdfPrintBaseName(''), name)
    assert.strictEqual(pdfPrintBaseName(null), name)
    assert.strictEqual(pdfPrintBaseName(undefined), name)
  }
  setLocale('zh-CN')
})

check('main.js 打印前设置 document.title，结束后在 finally 恢复', () => {
  const main = read('main.js')
  assert.match(main, /import \{[^}]*\bpdfPrintBaseName\b[^}]*\} from '\.\/print-paged\.js'/)
  assert.match(main, /document\.title\s*=\s*pdfPrintBaseName\(state\.currentFile\)/)
  assert.match(main, /finally\s*\{\s*document\.title\s*=\s*originalPdfPrintTitle\s*\}/)
})

check('其它导出的默认名未被改动', () => {
  const main = read('main.js')
  assert.ok(main.includes("const defaultName = state.currentFile.replace(/\\.md$/i, '.html')"))
  assert.ok(main.includes("const defaultName = state.currentFile.replace(/\\.md$/i, '.slides.html')"))
})

console.log(`\n${pass} passed, ${fail} failed`)
process.exitCode = fail ? 1 : 0
