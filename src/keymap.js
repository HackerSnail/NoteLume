// keymap.js —— 批次 D：快捷键绑定的纯逻辑层（无 DOM，可 Node 单测）
//
// 绑定串用 ProseMirror 同款逻辑文法：修饰键 Mod/Ctrl/Alt/Shift + 一个基础键，'-' 连接。
//   例：'Mod-b'、'Mod-Shift-x'、'Mod-/'、'Mod-`'。存储只用 'Mod'（跨平台：mac→Cmd，其余→Ctrl）。
// 本层负责：规范化/解析绑定、把 KeyboardEvent 反解为绑定、匹配、有效绑定合成、冲突检出、可读化。
// 匹配/冲突一律在「按平台解析后」的规范形上进行——这样 'Mod-b' 与 'Ctrl-b' 在非 mac 平台视为同一，能查出冲突。

const MOD_ORDER = ['Mod', 'Ctrl', 'Cmd', 'Alt', 'Shift'] // 规范化时的固定次序
// 结构性键：留给编辑器/系统，不作为可重绑目标（录制时忽略）
const STRUCTURAL = new Set([' ', 'Escape', 'Enter', 'Tab', 'Spacebar', 'Control', 'Alt', 'Meta', 'Shift', 'CapsLock'])

export function detectIsMac() {
  try {
    const p = (navigator.platform || '') + ' ' + (navigator.userAgent || '')
    return /Mac|iPhone|iPad|iPod/i.test(p)
  } catch {
    return false
  }
}

// 基础键是否合法：可打印单字符（非空格）或 F1–F12
function validBase(base) {
  if (base == null) return false
  if (/^F([1-9]|1[0-2])$/.test(base)) return true
  return base.length === 1 && base !== ' '
}

// 解析任意写法 → { mods:Set, base:string }；非法返回 null。修饰键大小写不敏感，base 统一小写（F 键除外）
function split(raw) {
  const s = String(raw || '').trim()
  if (!s) return null
  const parts = s.split('-')
  const base = parts[parts.length - 1]
  const mods = []
  for (const m of parts.slice(0, -1)) {
    const canon = MOD_ORDER.find((x) => x.toLowerCase() === String(m).toLowerCase())
    if (!canon) return null // 非已知修饰键
    mods.push(canon)
  }
  if (!validBase(base)) return null
  return { mods: new Set(mods), base: /^F([1-9]|1[0-2])$/.test(base) ? base : base.toLowerCase() }
}

// 规范化逻辑串（不改 Mod/Ctrl 语义，仅统一修饰顺序与基础键大小写）
export function normalizeBinding(raw) {
  const p = split(raw)
  if (!p) return null
  const ordered = MOD_ORDER.filter((m) => p.mods.has(m))
  return ordered.concat(p.base).join('-')
}

// 解析为按键匹配描述（Mod 依平台展开）；至少含一个主修饰键（Mod/Ctrl/Cmd/Alt）方合法，Shift 单独不算
export function parseBinding(raw, isMac = false) {
  const p = split(raw)
  if (!p) return null
  const hasPrimary = p.mods.has('Mod') || p.mods.has('Ctrl') || p.mods.has('Cmd') || p.mods.has('Alt')
  if (!hasPrimary) return null // 必须含 Ctrl/Cmd/Mod/Alt 之一作主修饰
  return {
    ctrl: p.mods.has('Ctrl') || (p.mods.has('Mod') && !isMac),
    meta: p.mods.has('Cmd') || (p.mods.has('Mod') && isMac),
    alt: p.mods.has('Alt'),
    shift: p.mods.has('Shift'),
    base: p.base.toLowerCase(),
  }
}

// 按平台解析后的规范键形（用于去重/冲突比较）
export function resolveBinding(raw, isMac = false) {
  const d = parseBinding(raw, isMac)
  if (!d) return null
  const mods = []
  if (d.ctrl) mods.push('Ctrl')
  if (d.meta) mods.push('Cmd')
  if (d.alt) mods.push('Alt')
  if (d.shift) mods.push('Shift')
  return mods.concat(d.base.toLowerCase()).join('-')
}

// 由 KeyboardEvent 反解出逻辑绑定（录制用）；结构性键或无主修饰 → null
export function eventToBinding(e, isMac = false) {
  const key = e.key
  if (key == null) return null
  if (STRUCTURAL.has(key)) return null
  if (!validBase(key)) return null
  const mods = []
  // 主修饰：mac 用 Cmd(meta)，其余用 Ctrl；存成 'Mod' 保跨平台可移植
  const meta = !!e.metaKey
  const ctrl = !!e.ctrlKey
  if (!(meta || ctrl || e.altKey)) return null // 至少要一个主修饰
  if (meta || ctrl) mods.push('Mod')
  if (e.altKey) mods.push('Alt')
  if (e.shiftKey) mods.push('Shift')
  const base = /^F([1-9]|1[0-2])$/.test(key) ? key : key.toLowerCase()
  const set = new Set(mods)
  return MOD_ORDER.filter((m) => set.has(m)).concat(base).join('-')
}

// 事件是否匹配某绑定
export function eventMatches(e, binding, isMac = false) {
  const d = parseBinding(binding, isMac)
  if (!d) return false
  if (d.ctrl !== !!e.ctrlKey || d.meta !== !!e.metaKey) return false
  if (d.alt !== !!e.altKey || d.shift !== !!e.shiftKey) return false
  return d.base === String(e.key || '').toLowerCase()
}

// 可读化展示（面板/设置页）：mac 用符号，其余用 Ctrl/Alt/Shift 文本
export function formatBinding(raw, isMac = false) {
  const d = parseBinding(raw, isMac)
  if (!d) return String(raw || '')
  const parts = []
  if (isMac) {
    if (d.meta) parts.push('⌘')
    if (d.ctrl) parts.push('⌃')
    if (d.alt) parts.push('⌥')
    if (d.shift) parts.push('⇧')
  } else {
    if (d.ctrl) parts.push('Ctrl')
    if (d.alt) parts.push('Alt')
    if (d.shift) parts.push('Shift')
  }
  const b = d.base
  parts.push(b.length === 1 ? b.toUpperCase() : b)
  return isMac ? parts.join('') : parts.join('+')
}

// 系统原生菜单的 accelerator 串（muda/Tauri 文法：'Cmd+Shift+S'、'Cmd+/'，键名可给字符本身）。
// 只服务 mac 原生菜单，故 Mod 一律展开为 Cmd；非法/无主修饰/已解绑 → null（调用方该项不挂键）。
// 与 formatBinding 分开：那是给人看的符号（⌘⇧S），这是给系统解析的格式，两个消费者互不污染。
export function toAccelerator(raw) {
  const d = parseBinding(raw, true)
  if (!d) return null
  const mods = []
  if (d.ctrl) mods.push('Control')
  if (d.meta) mods.push('Cmd')
  if (d.alt) mods.push('Option')
  if (d.shift) mods.push('Shift')
  const key = d.base.toUpperCase() // 字母/符号/F 键统一大写形（'/'、'`' 等符号 toUpperCase 为恒等）
  return mods.concat(key).join('+')
}

/**
 * 合成有效绑定。
 * @param {Array<{id:string, defaultKey?:string}>} commands
 * @param {Object<string,string>} overrides  {id: 绑定串}；空串 '' = 解绑
 * @param {boolean} isMac
 * @returns {{ map: Map<string,string>, conflicts: Array<{binding:string, ids:string[]}> }}
 *   map：解析后键形 → id（后出现者胜，用于分发器兜底匹配）；conflicts：同一键形被多命令占用的清单
 */
export function effectiveBindings(commands, overrides = {}, isMac = false) {
  const map = new Map()
  const byBinding = new Map() // 解析后键形 -> [id...]
  for (const cmd of commands || []) {
    if (!cmd || !cmd.id) continue
    const chosen = Object.prototype.hasOwnProperty.call(overrides, cmd.id) ? overrides[cmd.id] : cmd.defaultKey
    if (chosen == null || chosen === '') continue
    const resolved = resolveBinding(chosen, isMac)
    if (!resolved) continue // 非法绑定跳过
    map.set(resolved, cmd.id)
    if (!byBinding.has(resolved)) byBinding.set(resolved, [])
    const arr = byBinding.get(resolved)
    if (!arr.includes(cmd.id)) arr.push(cmd.id)
  }
  const conflicts = []
  for (const [binding, ids] of byBinding) if (ids.length > 1) conflicts.push({ binding, ids })
  return { map, conflicts }
}

/**
 * 轻量模糊匹配（面板/命令标题排序用）：大小写不敏感子序列。
 * 连续命中、词首（分隔符后）命中加分，短串靠前。全不命中返回 null；空查询返回中性 {score:0}。
 * @returns {null | {score:number, matched:number[]}}
 */
export function fuzzyMatch(query, text) {
  const q = String(query == null ? '' : query).toLowerCase()
  const t = String(text == null ? '' : text)
  const tl = t.toLowerCase()
  if (!q) return { score: 0, matched: [] }
  let qi = 0, score = 0, prev = -2
  const matched = []
  for (let ti = 0; ti < tl.length && qi < q.length; ti++) {
    if (tl[ti] === q[qi]) {
      let s = 1
      if (ti === prev + 1) s += 3 // 连续
      if (ti === 0 || /[\s/\\._-]/.test(tl[ti - 1])) s += 2 // 词首
      score += s
      matched.push(ti)
      prev = ti
      qi++
    }
  }
  if (qi < q.length) return null
  score += Math.max(0, 8 - Math.floor(tl.length / 12)) // 越短越靠前
  return { score, matched }
}
