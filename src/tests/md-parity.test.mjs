// md-parity.test.mjs —— Rust / JS 双解析器对拍（虚拟化 Phase 1 的漂移防线）
// 运行：cd src && node tests/md-parity.test.mjs
//
// fixtures/md-parity.json 是三方一致的锚点：Rust（src-tauri/src/mdparse.rs，cargo test --lib）
// 与 JS（editor-schema.js）对同一批 md 样例必须产出完全相同的 PM JSON。Rust 侧用
// include_str! 直接读这份文件断言，这里反着验 JS 侧。任何一侧改解析行为让 fixture 不再
// 两边都绿就是漂移——虚拟化方案靠它兜住「双解析器产物分叉 → 文件往返损坏」的风险。
//
// 顺带验证 fixture 能经 Node.fromJSON 用当前 schema 无损重建：这是 Phase 2 里
// 「Rust JSON → master doc」链路的可行性前提，schema 演进改坏属性名在这里立刻炸。

import assert from 'node:assert'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { Node } from 'prosemirror-model'
import { parseMarkdown, schema } from '../editor-schema.js'

const CASES = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'fixtures/md-parity.json'), 'utf8'),
)

assert.ok(CASES.length >= 8, 'fixture 用例数不应缩水')

// PM 节点的 attrs 是 null-prototype 对象，deepStrictEqual 会因原型不同误报；
// 统一 JSON 往返成普通对象再比（JSON 键序无关，语义比较不受影响）
const norm = (v) => JSON.parse(JSON.stringify(v))

for (const [i, c] of CASES.entries()) {
  // JS 解析走与真实打开文档完全相同的入口 parseMarkdown（含 HTML 块抽取与任务项后处理）
  const got = norm(parseMarkdown(c.md).toJSON())
  assert.deepStrictEqual(got, c.doc, `用例 ${i} JS 产物与 fixture 不一致：${JSON.stringify(c.md)}`)

  // fixture 必须能经 Node.fromJSON 重建为合法 doc（Phase 2 的 master doc 建立路径）
  const rebuilt = norm(Node.fromJSON(schema, c.doc).toJSON())
  assert.deepStrictEqual(rebuilt, c.doc, `用例 ${i} fixture 无法经 Node.fromJSON 重建`)
}

console.log(`md-parity: ${CASES.length} cases OK`)
