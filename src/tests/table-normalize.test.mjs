// table-normalize.test.mjs —— 畸形表格「矩形归一」回归（纯模型，无需浏览器 / DOM）
// 运行：cd src && node tests/table-normalize.test.mjs
//
// 背景：docx 导入的合并表常出现「表头行 colspan 加总 ≠ 数据行」，还原出的 ProseMirror
// 表格非矩形会让 prosemirror-tables 选区计算崩（光标点不动）。normalizeTableRect 负责补齐。
import assert from 'node:assert'
import { schema, normalizeTableRect } from '../editor-schema.js'

const cell = (colspan = 1, rowspan = 1, text = '') => ({
  type: 'table_cell',
  attrs: { colspan, rowspan },
  content: text ? [{ type: 'text', text }] : [],
})
const row = (cells) => ({ type: 'table_row', content: cells })
const table = (rows) => ({ type: 'table', content: rows })

// 每行「显式单元格 colspan 加总」（无 rowspan 时即行宽）
const widths = (t) => {
  const a = []
  t.forEach((r) => { let s = 0; r.forEach((c) => (s += c.attrs.colspan || 1)); a.push(s) })
  return a
}

let pass = 0
const ok = (name, fn) => { fn(); console.log('✅', name); pass++ }

ok('colspan 不齐（8 vs 7）→ 全部补到 8', () => {
  const t = schema.nodeFromJSON(
    table([
      row([cell(2), cell(2), cell(1), cell(2), cell(1)]), // 8
      row([cell(2), cell(3), cell(2)]), // 7
    ])
  )
  assert.notDeepStrictEqual(widths(t), [8, 8], '归一前应确实不齐')
  const n = normalizeTableRect(t, schema)
  assert.deepStrictEqual(widths(n), [8, 8])
})

ok('已矩形 → 原样返回（同一引用，不重建）', () => {
  const t = schema.nodeFromJSON(
    table([
      row([cell(2), cell(2)]), // 4
      row([cell(1), cell(1), cell(1), cell(1)]), // 4
    ])
  )
  assert.strictEqual(normalizeTableRect(t, schema), t)
})

ok('colspan 全 1、单元格数不齐也补齐', () => {
  const t = schema.nodeFromJSON(
    table([
      row([cell(1), cell(1), cell(1)]), // 3
      row([cell(1)]), // 1
    ])
  )
  const n = normalizeTableRect(t, schema)
  assert.deepStrictEqual(widths(n), [3, 3])
})

ok('rowspan 覆盖不误补（合法矩形表保持原样）', () => {
  // 首列被首行 rowspan=2 覆盖：第二行只需再给 1 个 cell，整体仍是 2 列宽
  const t = schema.nodeFromJSON(
    table([
      row([cell(1, 2, 'a'), cell(1, 1, 'b')]),
      row([cell(1, 1, 'c')]),
    ])
  )
  assert.strictEqual(normalizeTableRect(t, schema), t, 'rowspan 合法表不应被补出多余单元格')
})

ok('补齐后仍是合法表格（可再解析/序列化不抛）', () => {
  const t = schema.nodeFromJSON(
    table([
      row([cell(2), cell(2), cell(1), cell(2), cell(1)]), // 8
      row([cell(2), cell(3), cell(2)]), // 7 → 补 1
    ])
  )
  const n = normalizeTableRect(t, schema)
  const doc = schema.topNodeType.create(null, n)
  doc.check() // 违反 schema 会抛
  assert.ok(n.childCount === 2 && n.child(1).childCount === 4, '第二行应补出 1 个空单元格')
})

console.log(`\n结果：${pass} passed`)
