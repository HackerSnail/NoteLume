// csv.test.mjs —— CSV 表格渲染：parseCsv 纯函数（RFC4180 口径）
// 运行：cd src && node tests/csv.test.mjs
//
// 覆盖：基础行列、引号内逗号 / 换行 / 双写引号、CRLF、尾行无换行、末尾空行不计数、
// 短行补齐成矩形、空输入。装饰层（显隐 / 光标进块）与 mermaid 同构，jsdom 跑不了 PM 视图，归真机验收。

import assert from 'node:assert'
import { parseCsv } from '../csv-preview.js'

let pass = 0, fail = 0
function check(name, fn) {
  try { fn(); console.log(`✅ ${name}`); pass++ }
  catch (e) { console.error(`❌ ${name}: ${e.message}`); fail++ }
}

check('基础行列', () => {
  assert.deepStrictEqual(parseCsv('a,b,c\n1,2,3'), [['a', 'b', 'c'], ['1', '2', '3']])
})

check('引号内逗号不切列', () => {
  assert.deepStrictEqual(parseCsv('"x,y",z'), [['x,y', 'z']])
})

check('引号内换行不切行', () => {
  assert.deepStrictEqual(parseCsv('"l1\nl2",b\nc,d'), [['l1\nl2', 'b'], ['c', 'd']])
})

check('双写引号转成字面引号', () => {
  assert.deepStrictEqual(parseCsv('"say ""hi""",2'), [['say "hi"', '2']])
})

check('CRLF 换行', () => {
  assert.deepStrictEqual(parseCsv('a,b\r\nc,d'), [['a', 'b'], ['c', 'd']])
})

check('末行无换行仍成行；末尾空行不计数', () => {
  assert.deepStrictEqual(parseCsv('a,b\nc,d'), [['a', 'b'], ['c', 'd']])
  assert.deepStrictEqual(parseCsv('a,b\nc,d\n\n'), [['a', 'b'], ['c', 'd']])
})

check('短行补空串成矩形', () => {
  assert.deepStrictEqual(parseCsv('a,b,c\n1'), [['a', 'b', 'c'], ['1', '', '']])
})

check('空输入与纯空白返回空表', () => {
  assert.deepStrictEqual(parseCsv(''), [])
  assert.deepStrictEqual(parseCsv('\n\n'), [])
})

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
