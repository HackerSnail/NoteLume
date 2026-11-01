// feature-flags.test.mjs —— 功能开关注册表回归（纯逻辑，无 DOM）
// 运行：cd src && node tests/feature-flags.test.mjs
//
// 锁三件事：DEFAULT_FEATURES 键集稳定（设置页行与这里的键一一对应）、
// 坏数据逐键回落默认、virtualLargeMd 默认关（虚拟化是显式选择的实验功能）。

import assert from 'node:assert'
import { DEFAULT_FEATURES, normalizeFeatures, setFeature } from '../feature-flags.js'

// 1. 键集：新增开关必须进这里，设置页 FEATURE_ROWS 与它对齐
assert.deepStrictEqual(Object.keys(DEFAULT_FEATURES).sort(), [
  'csvTable',
  'emoji',
  'headingNumbering',
  'lineNumbers',
  'quarkdown',
  'tocBlock',
  'virtualLargeMd',
])
assert.strictEqual(DEFAULT_FEATURES.virtualLargeMd, false, '虚拟化默认关')
console.log('ok 键集与默认值')

// 2. 坏数据逐键回落：错类型 / 缺键 / 非对象都回默认
{
  const n1 = normalizeFeatures({ tocBlock: 'yes', virtualLargeMd: 1, unknown: true })
  assert.strictEqual(n1.tocBlock, true)
  assert.strictEqual(n1.virtualLargeMd, false)
  assert.strictEqual('unknown' in n1, false, '未知键不进结果')
  const n2 = normalizeFeatures(null)
  assert.deepStrictEqual(n2, DEFAULT_FEATURES)
  const n3 = normalizeFeatures([true])
  assert.deepStrictEqual(n3, DEFAULT_FEATURES)
  console.log('ok 坏数据回落')
}

// 3. setFeature 写单个开关：store.update 浅合并语义
{
  const calls = []
  const store = {
    get: () => ({ features: { ...DEFAULT_FEATURES } }),
    update: (patch) => calls.push(patch),
  }
  const next = setFeature(store, 'virtualLargeMd', true)
  assert.strictEqual(next.virtualLargeMd, true)
  assert.strictEqual(next.tocBlock, true, '其余键保持')
  assert.strictEqual(calls.length, 1)
  assert.strictEqual(calls[0].features.virtualLargeMd, true)
  // 非法调用不动 store：返回当前（未变）值
  const same = setFeature(store, 'nope', true)
  assert.strictEqual(same.virtualLargeMd, false, '非法键不写盘，回落 store 现值')
  assert.strictEqual(calls.length, 1, '非法键不写盘')
  console.log('ok setFeature 语义')
}

console.log('feature-flags: all ok')
