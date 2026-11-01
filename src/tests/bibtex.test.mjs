// bibtex.test.mjs —— ```bibtex 代码块的解析与条目拼装（纯函数层）
// 运行：cd src && node tests/bibtex.test.mjs
//
// 口径锚点与 Rust 侧 .bibliography 同源（src-tauri/src/qd/bibliography.rs 的 parse_bibtex /
// entry_content），BIB 常量直接抄那边的测试样本，两边对得上才算一处口径而不是两套实现。
// 装饰层（隐源码 / 挂条目 / 光标进块）与 mermaid、csv 同族，jsdom 跑不了 PM 视图，归真机验收。

import assert from 'node:assert'
import { parseBibEntries, bibEntryParts } from '../bibtex-preview.js'

let pass = 0, fail = 0
function check(name, fn) {
  try { fn(); console.log(`✅ ${name}`); pass++ }
  catch (e) { console.error(`❌ ${name}: ${e.message}`); fail++ }
}

const field = (e, name) => {
  const hit = e.fields.find(([k]) => k === name)
  return hit ? hit[1] : null
}
const plain = (parts) => parts.map((p) => (p.em ? '*' + p.text + '*' : p.text)).join(', ')

const BIB = `@article{einstein1905,
  author = {Albert Einstein},
  title = {Zur Elektrodynamik bewegter K{\\"o}rper},
  journal = {Annalen der Physik},
  volume = {322},
  number = {10},
  pages = {891--921},
  year = {1905}
}

@book{knuth1984,
  author = {Donald Knuth},
  title = {The TeXbook},
  publisher = {Addison-Wesley},
  year = {1984}
}`

check('两条条目、类型与引用键、字段名小写', () => {
  const e = parseBibEntries(BIB)
  assert.strictEqual(e.length, 2)
  assert.deepStrictEqual([e[0].type, e[0].key], ['article', 'einstein1905'])
  assert.deepStrictEqual([e[1].type, e[1].key], ['book', 'knuth1984'])
  assert.strictEqual(field(e[0], 'author'), 'Albert Einstein')
  assert.strictEqual(field(e[0], 'volume'), '322')
  assert.strictEqual(field(e[0], 'TITLE'), null, '字段名不分小写就取不到')
})

check('值里剥花括号、跨行折空白', () => {
  const e = parseBibEntries(BIB)
  // 花括号剥掉、重音命令里的反斜杠留下（与 Rust 侧 clean_bib_value 同一口径）
  assert.strictEqual(field(e[0], 'title'), 'Zur Elektrodynamik bewegter K\\"orper')
  const multi = parseBibEntries('@misc{x,\n  title = {一行\n    两行},\n}')
  assert.strictEqual(field(multi[0], 'title'), '一行 两行')
})

check('双引号值与裸数字值', () => {
  const e = parseBibEntries('@inbook{a, title = "引号里的标题", year = 1999, pages = "1--9"}')
  assert.strictEqual(field(e[0], 'title'), '引号里的标题')
  assert.strictEqual(field(e[0], 'year'), '1999')
  assert.strictEqual(field(e[0], 'pages'), '1--9')
})

check('嵌套花括号配平不提前收尾', () => {
  const e = parseBibEntries('@article{a, title = {外层 {内层} 收尾}, year = {2020}}')
  assert.strictEqual(field(e[0], 'title'), '外层 内层 收尾')
  assert.strictEqual(field(e[0], 'year'), '2020')
})

check('@comment / @string / @preamble 整组跳过', () => {
  const src = '@string{ space = { } }\n@comment{ @article{fake, title = {不该出现}} }\n@preamble{ " 拼这个 " }\n@book{real, title = {真条目}}'
  const e = parseBibEntries(src)
  assert.deepStrictEqual(e.map((x) => x.key), ['real'])
})

check('同键重复后者覆盖，顺序按首次出现', () => {
  const e = parseBibEntries('@a{k, title = {第一}}\n@b{j, title = {第二}}\n@a{k, title = {第三}}')
  assert.strictEqual(e.length, 2)
  assert.strictEqual(field(e[0], 'title'), '第三')
  assert.deepStrictEqual(e.map((x) => x.key), ['k', 'j'])
})

check('畸形字段跳过该字段，不让整块报废', () => {
  // 畸形字段单独占一行：字段名扫到行尾没遇到等号就当畸形跳掉（与 Rust 侧同一容错）
  const e = parseBibEntries('@article{a,\n  这行没有等号,\n  year = {2020}\n}')
  assert.strictEqual(e.length, 1)
  assert.strictEqual(field(e[0], 'year'), '2020')
  assert.strictEqual(e[0].fields.length, 1)
})

check('非 BibTeX 文本解析不出条目', () => {
  assert.deepStrictEqual(parseBibEntries('不是 BibTeX 的普通文本'), [])
  assert.deepStrictEqual(parseBibEntries(''), [])
  assert.deepStrictEqual(parseBibEntries(null), [])
})

check('条目拼装：作者, *标题*, 出处, vol./no./pp., 年（与 Rust 侧同一句序）', () => {
  const e = parseBibEntries(BIB)
  assert.strictEqual(
    plain(bibEntryParts(e[0].fields)),
    'Albert Einstein, *Zur Elektrodynamik bewegter K\\"orper*, Annalen der Physik, vol. 322, no. 10, pp. 891-921, 1905.'
  )
  assert.strictEqual(plain(bibEntryParts(e[1].fields)), 'Donald Knuth, *The TeXbook*, Addison-Wesley, 1984.')
})

check('author 缺失回落 editor；出处按 journal→booktitle→publisher→school→howpublished 取第一个', () => {
  const e = parseBibEntries('@incollection{a,\n  editor = {某人},\n  title = {一章},\n  booktitle = {文集},\n  publisher = {不该出现},\n  school = {也不该出现}\n}')
  const parts = bibEntryParts(e[0].fields)
  assert.strictEqual(plain(parts), '某人, *一章*, 文集.')
})

check('全空字段出空片段，不硬造标点', () => {
  assert.deepStrictEqual(bibEntryParts([]), [])
  assert.deepStrictEqual(bibEntryParts([['keywords', 'a b']]), [])
})

check('结尾只在缺句点时补一个', () => {
  const e = parseBibEntries('@book{a, title = {标题}, note = {x}, year = {2020.}}')
  const parts = bibEntryParts(e[0].fields)
  assert.ok(parts[parts.length - 1].text === '2020.', '年份自带句点不该再加：' + parts[parts.length - 1].text)
})

console.log(`\n结果：${pass} passed, ${fail} failed`)
if (fail) process.exit(1)
