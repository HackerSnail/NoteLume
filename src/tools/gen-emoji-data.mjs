// 生成 src-tauri/src/qd/emoji_data.rs（一次性脚本，产物已提交，平时不用跑）
// 运行：cd src && node tools/gen-emoji-data.mjs
import { readFileSync, writeFileSync } from 'node:fs'
// full.mjs 是 ESM 默认导出对象：`export default { "100": "💯", ... }`
const raw = readFileSync(new URL('../node_modules/markdown-it-emoji/lib/data/full.mjs', import.meta.url), 'utf8')
const m = JSON.parse(raw.replace(/^[\s\S]*?export default /, '').trim())
const ks = Object.keys(m)
let s = '// emoji_data.rs —— markdown-it-emoji full 数据（emojilib + shortcuts 别名），\n'
s += '// 由 src/tools/gen-emoji-data.mjs 从依赖包生成，勿手改。\n'
s += `/// 短代码 → emoji 字符（${ks.length} 条）。Emoji.emoji / .allemojis 用。\n`
s += 'pub static EMOJI: &[(&str, &str)] = &[\n'
for (const k of ks) s += `    (${JSON.stringify(k)}, ${JSON.stringify(m[k])}),\n`
s += '];\n'
writeFileSync(new URL('../../src-tauri/src/qd/emoji_data.rs', import.meta.url), s)
console.log('entries:', ks.length)
