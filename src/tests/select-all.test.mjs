// select-all.test.mjs —— Typora 式分段全选（Mod-a）的模型级 + 真编辑器回归
// 运行：cd src && node tests/select-all.test.mjs
//
// 判据分两层：
//  · 模型层（无 view）：selectAllStaged(state, dispatch, null) 的选区落点，覆盖表格 /
//    代码块 / 引用 / callout / 列表 / 顶层段落 / 部分框选 / 合并格 / 嵌套 / 跨块选区；
//  · 真编辑器层（jsdom + createEditor）：baseKeymap 那条 Mod-a 已让路（按键不被吃掉、
//    不整篇全选），并且整表框选在挂着 tableEditing 的真实 state 上同样成立。

import assert from 'node:assert'
import { register } from 'node:module'
import { JSDOM } from 'jsdom'

register('./css-stub-loader.mjs', import.meta.url)

const dom = new JSDOM('<!doctype html><html><body><div id="root"></div></body></html>', { url: 'http://localhost/' })
global.window = dom.window
global.document = dom.window.document
global.Node = dom.window.Node
global.Element = dom.window.Element
global.HTMLElement = dom.window.HTMLElement
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true })
global.DOMParser = dom.window.DOMParser
global.XMLSerializer = dom.window.XMLSerializer
global.NodeFilter = dom.window.NodeFilter
global.DocumentFragment = dom.window.DocumentFragment
global.getComputedStyle = dom.window.getComputedStyle
global.requestAnimationFrame = (cb) => setTimeout(() => cb(Date.now()), 0)
global.cancelAnimationFrame = clearTimeout
global.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} }
global.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} }
dom.window.ResizeObserver = global.ResizeObserver
dom.window.IntersectionObserver = global.IntersectionObserver
dom.window.matchMedia = dom.window.matchMedia || (() => ({ matches: false, addEventListener() {}, removeEventListener() {} }))
global.matchMedia = dom.window.matchMedia
if (!dom.window.CSS) dom.window.CSS = { escape: (s) => String(s).replace(/["\\]/g, '\\$&') }
global.CSS = dom.window.CSS
window.__TAURI_INTERNALS__ = {
  async invoke(cmd) { throw new Error('unexpected invoke: ' + cmd) },
}

const { EditorState, TextSelection, AllSelection } = await import('prosemirror-state')
const { CellSelection, mergeCells } = await import('prosemirror-tables')
const { schema, parseMarkdown } = await import('../editor-schema.js')
const { createTable } = await import('../block-commands.js')
const { selectAllStaged } = await import('../select-all.js')

let pass = 0
let fail = 0
function t(name, fn) {
  try {
    fn()
    pass++
    console.log('  ok   ' + name)
  } catch (e) {
    fail++
    console.log('  FAIL ' + name + ' —— ' + ((e && e.message) || e))
  }
}

const N = schema.nodes

function stateOf(doc, sel) {
  return EditorState.create({ schema, doc, selection: sel })
}

// 光标放到含 anchor 的那段文本里（偏移 1：落在字符后）
function caretAt(doc, anchor) {
  let pos = null
  doc.descendants((node, p) => {
    if (pos != null || !node.isText) return
    const i = node.text.indexOf(anchor)
    if (i >= 0) pos = p + i + 1
  })
  assert.notEqual(pos, null, '夹具里没有锚点 ' + anchor)
  return TextSelection.create(doc, pos)
}

function firstNode(doc, name) {
  let found = null
  doc.descendants((n, p) => {
    if (!found && n.type.name === name) found = { node: n, pos: p }
  })
  assert.ok(found, '夹具里没有 ' + name)
  return found
}

// 表格里所有格子的节点位（CellSelection 要的就是这个位）
function cellPositions(doc) {
  const out = []
  doc.descendants((n, p) => {
    if (n.type.name === 'table_cell' || n.type.name === 'table_header') out.push(p)
  })
  return out
}

// 按一次全选：返回按完后的 state（dispatch 传 undefined 即「能否执行」查询）
function press(state, withDispatch = true) {
  let ok = null
  let tr = null
  ok = selectAllStaged(state, withDispatch ? (x) => { tr = x } : undefined, null)
  return { ok, next: tr ? state.apply(tr) : state }
}

const isAll = (st) => st.selection instanceof AllSelection
const cellCount = (sel) => {
  let c = 0
  sel.forEachCell(() => c++)
  return c
}
// 选区是否正好等于某个块的全部正文（端点由 PM 收进块内首尾文本位，故比文本不比起止位）
function coversBlock(st, target) {
  const sel = st.selection
  const want = target.node.textBetween(0, target.node.content.size, '\n', '\n')
  // 不比 Selection.text（这一版 PM 里它是方法不是属性），直接按区间从 doc 取文
  return !sel.empty && st.doc.textBetween(sel.from, sel.to, '\n', '\n') === want
    && sel.from >= target.pos && sel.to <= target.pos + target.node.nodeSize
}

const TBL = '段落 head\n\n| 甲 | 乙 |\n| --- | --- |\n| 丙 | 丁 |\n\n段落 tail\n'

t('表格内光标：第一次选整表（四格全框住），不碰全文', () => {
  const doc = parseMarkdown(TBL)
  const st = stateOf(doc, caretAt(doc, '丙'))
  const r = press(st)
  assert.equal(r.ok, true)
  assert.ok(r.next.selection instanceof CellSelection, '应是单元格框选')
  assert.ok(r.next.selection.isColSelection() && r.next.selection.isRowSelection(), '横竖都要到边')
  assert.equal(cellCount(r.next.selection), 4, '四格全在选区内')
  assert.ok(!isAll(r.next), '第一次不许选全文')
})

t('表格整表已选中：第二次升到全文，第三次仍停在全文', () => {
  const doc = parseMarkdown(TBL)
  let st = stateOf(doc, caretAt(doc, '丙'))
  st = press(st).next
  st = press(st).next
  assert.ok(isAll(st), '第二次应整篇全选')
  const r = press(st)
  assert.equal(r.ok, true, 'selectAll 恒真（库语义），再按一次不报错')
  assert.ok(isAll(r.next), '仍是整篇全选，不来回跳')
})

t('表格只框了两格：第一次扩到整表', () => {
  const doc = parseMarkdown(TBL)
  const ps = cellPositions(doc)
  const st = stateOf(doc, CellSelection.create(doc, ps[0], ps[1]))
  const r = press(st)
  assert.ok(r.next.selection instanceof CellSelection)
  assert.equal(cellCount(r.next.selection), 4, '应补齐成整表')
})

t('合并单元格的表（colspan 头格）：整表判定照样成立', () => {
  const table = createTable(2, 3)
  const doc = N.doc.create(null, [N.paragraph.create(null, schema.text('前 p')), table])
  const ps = cellPositions(doc)
  const st0 = stateOf(doc, CellSelection.create(doc, ps[0], ps[1]))
  let tr = null
  assert.equal(mergeCells(st0, (x) => { tr = x }), true, '夹具要能合并前两格')
  const merged = st0.apply(tr).doc
  const cells = cellPositions(merged)
  const head = stateOf(merged, TextSelection.create(merged, cells[0] + 1))
  const r = press(head)
  assert.ok(r.next.selection instanceof CellSelection)
  assert.ok(r.next.selection.isColSelection() && r.next.selection.isRowSelection(), 'colspan 后仍要横竖到边')
})

t('代码块内：第一次选中块内全文，光标仍在块里', () => {
  const md = '段落 x\n\n```js\nconst a = 1\nconst b = 2\n```\n\n段落 y\n'
  const doc = parseMarkdown(md)
  const cb = firstNode(doc, 'code_block')
  const st = stateOf(doc, caretAt(doc, 'const b'))
  const r = press(st)
  assert.ok(!isAll(r.next), '第一次不许选全文')
  assert.ok(coversBlock(r.next, cb), '选区要正好等于代码块内容区间')
  assert.equal(r.next.selection.$from.parent.type.name, 'code_block', '锚点仍在代码块内')
  assert.ok(r.next.selection.from > cb.pos && r.next.selection.to < cb.pos + cb.node.nodeSize, '不许越出块界')
})

t('代码块内已有部分选区：第一次扩到整块', () => {
  const md = '```js\nconst a = 1\nconst b = 2\n```\n'
  const doc = parseMarkdown(md)
  const cb = firstNode(doc, 'code_block')
  const st = stateOf(doc, TextSelection.create(doc, cb.pos + 3, cb.pos + 8))
  const r = press(st)
  assert.ok(coversBlock(r.next, cb))
})

t('引用块内：第一次选中整段引用，第二次全文', () => {
  const md = '> 引用一\n>\n> 引用二\n\n段落 z\n'
  const doc = parseMarkdown(md)
  const bq = firstNode(doc, 'blockquote')
  let st = stateOf(doc, caretAt(doc, '引用二'))
  const r1 = press(st)
  assert.ok(coversBlock(r1.next, bq), '要盖住引用块全部内容')
  const r2 = press(r1.next)
  assert.ok(isAll(r2.next), '第二次升全文')
})

t('callout 内：第一次选中整张卡片', () => {
  const md = '> [!NOTE] 提示题\n> 卡片 body 锚点\n\n段落 w\n'
  const doc = parseMarkdown(md)
  const co = firstNode(doc, 'callout')
  const st = stateOf(doc, caretAt(doc, '锚点'))
  const r = press(st)
  assert.ok(coversBlock(r.next, co), '要盖住 callout 内容')
})

t('无序 / 有序列表：第一次选中整张列表', () => {
  for (const [md, name, anchor] of [
    ['- 甲一\n- 乙二 anchor\n- 丙三\n', 'bullet_list', 'anchor'],
    ['1. 甲一\n2. 乙二 anchor\n3. 丙三\n', 'ordered_list', 'anchor'],
  ]) {
    const doc = parseMarkdown(md)
    const li = firstNode(doc, name)
    const st = stateOf(doc, caretAt(doc, anchor))
    const r = press(st)
    assert.ok(!isAll(r.next), name + ' 第一次不许选全文')
    assert.ok(coversBlock(r.next, li), name + ' 要盖住整张列表')
  }
})

t('顶层普通段落：不插中间档，一次就是全文', () => {
  const doc = parseMarkdown('段落 alpha\n\n段落 beta\n')
  const st = stateOf(doc, caretAt(doc, 'alpha'))
  const r = press(st)
  assert.ok(isAll(r.next), '正文里按一次即整篇全选')
})

t('空文档（只有一个空段落）：直接全文', () => {
  const doc = N.doc.create(null, [N.paragraph.create()])
  const st = stateOf(doc, TextSelection.create(doc, 1))
  const r = press(st)
  assert.ok(isAll(r.next))
})

t('选区已经跨出表格（锚点在表外段落）：直接全文，不回表', () => {
  const doc = parseMarkdown(TBL)
  const from = caretAt(doc, 'head').from
  const to = caretAt(doc, '丙').from
  const st = stateOf(doc, TextSelection.create(doc, from, to))
  const r = press(st)
  assert.ok(isAll(r.next), '锚点不在容器里就不分段')
})

t('引用里套表格：先选表格这一层，再按一次直接全文（不逐层爬）', () => {
  const table = createTable(2, 2)
  const bq = N.blockquote.create(null, [N.paragraph.create(null, schema.text('引内 q')), table])
  const doc = N.doc.create(null, [N.paragraph.create(null, schema.text('外头 o')), bq])
  const cells = cellPositions(doc)
  const st = stateOf(doc, TextSelection.create(doc, cells[0] + 1))
  const r1 = press(st)
  assert.ok(r1.next.selection instanceof CellSelection, '第一档落表格')
  assert.ok(r1.next.selection.isColSelection() && r1.next.selection.isRowSelection())
  const r2 = press(r1.next)
  assert.ok(isAll(r2.next), '第二档直接整篇')
})

t('dispatch 传空（菜单置灰查询）：返回可执行且不动 state', () => {
  const doc = parseMarkdown(TBL)
  const st = stateOf(doc, caretAt(doc, '丙'))
  const r = press(st, false)
  assert.equal(r.ok, true)
  assert.equal(r.next, st, '查询态不许改选区')
})

// —— 真编辑器层：baseKeymap 的 Mod-a 是否真让路了 ——
const { createEditor } = await import('../editor-view.js')
const mountEl = document.getElementById('root')
const ed = createEditor({ mountEl, getVault: () => ({ vaultRoot: '/库', mdRel: 'a.md' }), onMetaChange() {}, onDirty() {} })
const view = ed.view

t('编辑器里按 Ctrl+A：不再被 baseKeymap 整篇吃掉（事件不 preventDefault）', () => {
  ed.setMarkdown(TBL)
  const doc = view.state.doc
  view.dispatch(view.state.tr.setSelection(caretAt(doc, '丙')))
  const ev = new window.KeyboardEvent('keydown', { key: 'a', code: 'KeyA', ctrlKey: true, bubbles: true, cancelable: true })
  view.dom.dispatchEvent(ev)
  assert.equal(ev.defaultPrevented, false, 'PM 不该再接住 Mod-a')
  assert.ok(!(view.state.selection instanceof AllSelection), '按键本身不该把整篇选中')
  assert.ok(view.state.selection instanceof CellSelection || view.state.selection.empty, '选区维持原样')
})

t('真实 view（挂着 tableEditing）上整表框选成立，且 normalize 不改回单选', () => {
  const doc = view.state.doc
  const st0 = stateOf(doc, caretAt(doc, '甲'))
  const r = press(st0)
  assert.ok(r.next.selection instanceof CellSelection)
  assert.equal(cellCount(r.next.selection), 4)
  // 经真实 state 的 normalizeSelection 走一遍：全表框选要留得住
  const tr = view.state.tr.setSelection(r.next.selection)
  view.dispatch(tr)
  assert.ok(view.state.selection instanceof CellSelection, '插件规范化不许把整表框选收回单格')
  assert.equal(cellCount(view.state.selection), 4)
})

console.log('')
console.log(`${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
