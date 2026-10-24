// emoji.test.mjs —— emoji 短代码：词表查找与导出渲染（无需浏览器 / Tauri）
// 运行：cd src && node tests/emoji.test.mjs
//
// 覆盖：findEmojiInText 的命中 / 别名 / 未知名、编辑器 tokenize 不受影响（仍是原文 token）、
// .render() 输出 emoji（整站 / 幻灯片导出同管线）、行内代码里的 :x: 不在纯函数命中范围之外由
// isLiteralCode 挡（该函数依赖 PM 节点，归编辑器侧装饰，jsdom 不跑 PM）。

import assert from 'node:assert'
import { findEmojiInText } from '../emoji-text.js'
import { tokenizer } from '../editor-schema.js'

let pass = 0, fail = 0
function check(name, fn) {
  try { fn(); console.log(`✅ ${name}`); pass++ }
  catch (e) { console.error(`❌ ${name}: ${e.message}`); fail++ }
}

// —— 纯函数：命中 / 别名 / 未知名 / 多处 ——
check('findEmojiInText 命中正名与别名，未知名跳过', () => {
  const hits = findEmojiInText('hi :smile: 和 :+1: 还有 :not_an_emoji: 结束')
  assert.strictEqual(hits.length, 2)
  assert.strictEqual(hits[0].name, 'smile')
  assert.strictEqual(hits[0].emoji, '😄')
  assert.strictEqual(hits[0].start, 3)
  assert.strictEqual(hits[0].end, 10)
  assert.strictEqual(hits[1].emoji, '👍') // :+1: 是 shortcuts 别名
})

check('findEmojiInText 空文本与无冒号文本返回空', () => {
  assert.deepStrictEqual(findEmojiInText(''), [])
  assert.deepStrictEqual(findEmojiInText('没有短代码的普通文本'), [])
})

// —— 编辑器解析不受影响：token 里仍是 :smile: 原文 ——
check('tokenizer.parse 不受 emoji 插件影响（显示层换脸的前提）', () => {
  const tokens = tokenizer.parse('a :smile: b', {})
  const inline = tokens.find((t) => t.type === 'inline')
  const text = inline.children.find((t) => t.type === 'text')
  assert.ok(text.content.includes(':smile:'))
})

// —— 导出渲染：.render() 出 emoji ——
check('tokenizer.render 输出 emoji', () => {
  assert.ok(tokenizer.render('a :smile: b').includes('😄'))
})

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
