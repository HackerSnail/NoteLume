// source-sync.test.mjs —— 「进入源码模式展示哪份文本」纯判定单测
// 运行：cd src && node tests/source-sync.test.mjs
import assert from 'node:assert'
import { resolveSourceText } from '../source-sync.js'

let pass = 0
const ok = (name) => { console.log('✅ ' + name); pass++ }

// 模型未改 + 握有原始字节 → 逐字节原文
assert.strictEqual(resolveSourceText({ modelDirty: false, rawSource: '# 原标题\n\n正文  ', serialized: 'SERIALIZED' }), '# 原标题\n\n正文  ')
ok('未改动 → 原文（保留尾随空格）')

// 模型已改 → 回退序列化
assert.strictEqual(resolveSourceText({ modelDirty: true, rawSource: 'RAW', serialized: 'SERIALIZED' }), 'SERIALIZED')
ok('已改动 → 序列化')

// 无原始字节（null）→ 序列化
assert.strictEqual(resolveSourceText({ modelDirty: false, rawSource: null, serialized: 'SERIALIZED' }), 'SERIALIZED')
ok('raw 为 null → 序列化')

// 空文件：rawSource='' 是有效原文（非 null），应返回 ''
assert.strictEqual(resolveSourceText({ modelDirty: false, rawSource: '', serialized: 'SERIALIZED' }), '')
ok('空串原文仍视为原文')

console.log('\n结果：' + pass + ' passed')
