// template.test.mjs —— 模板变量替换 / 日期格式化 单测（纯函数，无需浏览器）
// 运行：cd src && node tests/template.test.mjs
import assert from 'node:assert'
import { formatDate, builtinVars, applyTemplate } from '../template.js'

let pass = 0
const ok = (name) => { console.log('✅ ' + name); pass++ }

// 固定时间：2026-10-14 09:05:07（本地时区构造，避免 UTC 偏移）
const d = new Date(2026, 9, 14, 9, 5, 7)

assert.strictEqual(formatDate('YYYY-MM-DD', d), '2026-10-14')
assert.strictEqual(formatDate('YY/M/D', d), '26/10/14')
assert.strictEqual(formatDate('YYYY-MM-DD HH:mm:ss', d), '2026-10-14 09:05:07')
// 大小写敏感：MM=月 mm=分
assert.strictEqual(formatDate('MM/mm', d), '10/05')
ok('formatDate 基本/补零/大小写')

const vars = builtinVars({ title: '我的笔记', filename: '我的笔记.md', now: d })
assert.strictEqual(vars.date, '2026-10-14')
assert.strictEqual(vars.time, '09:05')
assert.strictEqual(vars.datetime, '2026-10-14 09:05')
assert.strictEqual(vars.title, '我的笔记')
assert.strictEqual(vars.filename, '我的笔记.md')
assert.strictEqual(vars.weekday, '星期三')
ok('builtinVars 值')

assert.strictEqual(
  applyTemplate('# {{title}}\n日期 {{date}} 时间{{ time }}\n', vars),
  '# 我的笔记\n日期 2026-10-14 时间09:05\n'
)
// 未知 token 原样保留（不误伤 Templater 之类）
assert.strictEqual(applyTemplate('{{date}} {{unknown_x}} {{date}}', vars), '2026-10-14 {{unknown_x}} 2026-10-14')
// 无花括号、单花括号不动
assert.strictEqual(applyTemplate('a { b } c {{title}}', vars), 'a { b } c 我的笔记')
ok('applyTemplate 替换/未知保留/边界')

console.log(`\n结果：${pass} passed`)
