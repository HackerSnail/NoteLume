// feature-flags.js —— 功能开关（设置页「功能开关」区块，存 settings.json 的 features 段）
//
// 设计原则：全部关闭 = 标准模式。每个开关只关显示层 / 输出层的增强，关掉后行为与引入该
// 功能之前逐字一致；md 源文件不受任何开关影响（文件里本来就不存这些功能的私有形态）。
// 开关只管编辑器显示与 NoteLume 自身输出；导出件的确定性优先（如目录块在导出件里始终渲染），
// 见各功能模块内的说明。

// headingNumbering 默认关：它会改动所有导出件的标题呈现，属显式选择而非默认增强
export const DEFAULT_FEATURES = {
  tocBlock: true, // [[toc]] 目录块（编辑器显示）
  csvTable: true, // ```csv 代码块渲染成表格（编辑器显示）
  emoji: true, // emoji 短代码显示层换脸
  headingNumbering: false, // 导出 / 打印时标题自动编号
}

const KEYS = Object.keys(DEFAULT_FEATURES)

/** 坏数据 / 缺字段回落默认，逐键 boolean 校验 */
export function normalizeFeatures(raw) {
  const out = { ...DEFAULT_FEATURES }
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    for (const key of KEYS) {
      if (typeof raw[key] === 'boolean') out[key] = raw[key]
    }
  }
  return out
}

/** 从 settings-store 读当前开关（store.get() 可能尚未 load，回落默认） */
export function getFeatures(store) {
  return normalizeFeatures(store && store.get ? store.get().features : null)
}

/** 写单个开关：features 段整体读改写（store.update 是浅合并） */
export function setFeature(store, key, val) {
  if (!(key in DEFAULT_FEATURES) || typeof val !== 'boolean') return getFeatures(store)
  const next = { ...getFeatures(store), [key]: val }
  store.update({ features: next })
  return next
}
