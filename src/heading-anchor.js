// heading-anchor.js —— 标题锚点 slug 的**唯一前端实现**（批次 F 后续：Word 交叉引用 + 多级列表）。
//
// 为什么单列一份：`#anchor` 内部链接能否跳转，取决于「导入侧写的 slug」「站点导出给标题发的 id」
// 「编辑器点击时反查的 slug」三处逐字符相等。故约定必须单一事实源——site-export 与编辑器都 import
// 本模块，绝不各写一份。Rust 侧（src-tauri/src/docx_import.rs 的 heading_anchor_slug/assign_anchors）
// 是本模块的**镜像**，二者由共享 fixture `tests/fixtures/heading-slug.json` 双边断言锁死。
//
// 规则（本批自定义，非严格复刻 GitHub；只要求三实现自洽）：输入标题**纯文本**（已剥行内标记）。
//  1. 逐码点小写（unicode 感知，保留中日韩等原样）。
//  2. 保留：字母(\p{L}，含 CJK)、数字(\p{N})、下划线 `_`、连字符 `-`；其余标点/符号整字符丢弃
//     （故 `3.2` → `32`、`（一）` → `一`）。
//  3. 空白（含连续）折叠为单个 `-`；首尾空白裁掉。
//  4. 重名 dedup（slugAllInOrder）：同文档内按出现序，第二次起追加 `-1`/`-2`……首个不加后缀。

/** 单个标题纯文本 → 基础 slug（不含 dedup 后缀）。 */
export function anchorSlug(plain) {
  let out = ''
  let pendingSpace = false // 有待落的分隔符（空白折叠，且 out 已有内容才置位 → 首尾空白自然裁掉）
  for (const ch of String(plain).toLowerCase()) { // for..of 按码点迭代，CJK/代理对安全
    if (/\s/.test(ch)) {
      if (out.length > 0) pendingSpace = true
      continue
    }
    if (/[\p{L}\p{N}_-]/u.test(ch)) {
      if (pendingSpace) { out += '-'; pendingSpace = false }
      out += ch
    }
    // 其余字符（标点/符号）整字符丢弃，不产生分隔符
  }
  return out
}

/**
 * 有序标题纯文本数组 → 逐字符唯一的锚点数组（叠加 dedup）。
 * 文档序调用即得与正文标题顺序一致的锚点表；导入/导出/编辑器三边都以「文档序标题」喂本函数，
 * 故必然得到同一张表。
 */
export function slugAllInOrder(plainTexts) {
  const counts = new Map()
  return plainTexts.map((p) => {
    const base = anchorSlug(p)
    const n = counts.get(base) || 0
    counts.set(base, n + 1)
    return n === 0 ? base : `${base}-${n}`
  })
}
