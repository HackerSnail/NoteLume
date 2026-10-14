// writing-stats.test.mjs —— 写作统计口径单测（纯函数）
// 运行：cd src && node tests/writing-stats.test.mjs
import assert from 'node:assert'
import { countWords, readingMinutes, statsLabel } from '../writing-stats.js'

let pass = 0
const ok = (name) => { console.log('✅ ' + name); pass++ }

assert.strictEqual(countWords(''), 0)
assert.strictEqual(countWords('hello world'), 2)
assert.strictEqual(countWords('你好世界'), 4)                 // CJK 逐字
assert.strictEqual(countWords('你好 world 测试 abc'), 4 + 2)  // 4 汉字 + 2 拉丁词
assert.strictEqual(countWords('日本語 テスト'), 6)            // 汉字 3 + 片假名 3，均逐字计
assert.strictEqual(countWords('co-operate 123'), 2)          // 连字符词与数字
ok('countWords 中英日混排')

assert.strictEqual(readingMinutes(0), 0)
assert.strictEqual(readingMinutes(100), 1)
assert.strictEqual(readingMinutes(700), 2)
ok('readingMinutes 阈值')

assert.match(statsLabel(1200), /1200 字/)
ok('statsLabel 文案')

console.log(`\n结果：${pass} passed`)
