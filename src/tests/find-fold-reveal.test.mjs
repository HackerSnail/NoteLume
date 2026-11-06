// find-fold-reveal.test.mjs —— 查找命中落在折叠节内时的定位
// 运行：cd src && node tests/find-fold-reveal.test.mjs
//
// 背景：折叠只给块挂 .nl-fold-hidden（display:none），文档模型不变。查找插件照常命中，
// 但 reveal 后编辑器拿不到可见矩形（coordsAtPos 全零），旧实现按零坐标滚反而把窗口
// 拉回文档开头，表现是「搜索跳是跳了，窗口没滚到命中位置、高亮也看不见」。
// 本文件钉两件事：① 命中在被折叠的节里时先展开再落选区；② 目标仍不可见（零矩形）时不滚动。
//
// 用 jsdom + 真实 EditorState / 折叠插件 / 查找栏控制器；EditorView 用最小替身
// （jsdom 没有布局，coordsAtPos 由替身按用例给值），不依赖真实布局引擎。

import assert from 'node:assert'
import { JSDOM } from 'jsdom'

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' })
global.window = dom.window
global.document = dom.window.document
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true })
global.localStorage = dom.window.localStorage
global.HTMLElement = dom.window.HTMLElement
global.Event = dom.window.Event
dom.window.localStorage.setItem('nl-lang', 'zh-CN')
window.__TAURI_INTERNALS__ = { invoke: async () => ({}) }

const { EditorState } = await import('prosemirror-state')
const { schema, parseMarkdown } = await import('../editor-schema.js')
const { createFoldPlugin, toggleFold, unfoldCovering, foldKey } = await import('../fold-plugin.js')
const { findPlugin, createFindBar } = await import('../find-in-doc.js')

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

const MD = '# 头部\n\n抬头段\n\n## 目标节\n\nNEEDLE 藏在折叠里\n\n## 尾部\n\n尾段\n'

// 假 EditorView：只提供查找栏用得到的 state / dispatch / focus / coordsAtPos。
// zeroRect=true 模拟目标仍不可见（折叠未展开或其它原因），否则给一个正常矩形。
function makeView(state, { zeroRect = true } = {}) {
  const view = {
    state,
    dispatch(tr) { view.state = view.state.apply(tr) },
    focus() {},
    coordsAtPos() {
      return zeroRect
        ? { left: 0, right: 0, top: 0, bottom: 0 }
        : { left: 40, right: 120, top: 500, bottom: 524 }
    },
  }
  return view
}

// 折叠「目标节」并把光标留在标题上；NEEDLE 在隐藏区间内。
function foldedState() {
  const fold = createFoldPlugin()
  let state = EditorState.create({ schema, doc: parseMarkdown(MD), plugins: [fold.plugin, findPlugin()] })
  let target = null
  state.doc.forEach((node, pos) => {
    if (node.type.name === 'heading' && node.textContent === '目标节') target = pos
  })
  assert.notEqual(target, null, '找不到目标标题')
  toggleFold(state, (tr) => { state = state.apply(tr) }, target)
  assert.equal(foldKey.getState(state).length, 1, '前置：目标节应已折叠')
  return state
}

function search(view, paneEl, query) {
  const input = paneEl.querySelector('.nl-find-input')
  input.value = query
  input.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
}

t('命中在折叠节内：先展开覆盖折叠，再落选区', () => {
  const view = makeView(foldedState())
  const paneEl = document.createElement('div')
  document.body.appendChild(paneEl)
  const bar = createFindBar({ view, paneEl })
  bar.open('find')
  search(view, paneEl, 'NEEDLE')

  const st = view.state
  assert.deepEqual(foldKey.getState(st), [], '命中所在的折叠应已展开')
  const sel = st.selection
  const hit = st.doc.textBetween(sel.from, sel.to)
  assert.equal(hit, 'NEEDLE', '选区应落在命中文本上')
})

t('命中在折叠外：不动折叠集合', () => {
  const view = makeView(foldedState())
  const paneEl = document.createElement('div')
  document.body.appendChild(paneEl)
  const bar = createFindBar({ view, paneEl })
  bar.open('find')
  search(view, paneEl, '抬头')

  assert.equal(foldKey.getState(view.state).length, 1, '与命中无关的折叠应保留')
})

t('目标仍不可见（全零矩形）：不把窗格滚回开头', () => {
  const view = makeView(foldedState(), { zeroRect: true })
  const paneEl = document.createElement('div')
  document.body.appendChild(paneEl)
  const bar = createFindBar({ view, paneEl })
  bar.open('find')
  paneEl.scrollTop = 320
  search(view, paneEl, 'NEEDLE')
  assert.equal(paneEl.scrollTop, 320, '零矩形时不得改 scrollTop')
})

t('虚拟化模式：窗内命中也经 hooks.unfoldAt 展开', () => {
  const view = makeView(foldedState(), { zeroRect: true })
  const paneEl = document.createElement('div')
  document.body.appendChild(paneEl)
  let unfolded = 0
  const hooks = () => ({
    getDoc: () => view.state.doc,
    toWin: (p) => p, // 命中都落在当前窗口内，不需要移窗
    jumpTo: () => { throw new Error('窗内命中不应调用 jumpTo') },
    unfoldAt: (p) => {
      unfolded++
      const tr = unfoldCovering(view.state, p)
      if (tr) view.dispatch(tr)
    },
    getMasterState: () => view.state,
    applyMasterTr: () => {},
  })
  const bar = createFindBar({ view, paneEl, hooks })
  bar.open('find')
  search(view, paneEl, 'NEEDLE')
  assert.ok(unfolded >= 1, '应经 hooks.unfoldAt 展开')
  assert.deepEqual(foldKey.getState(view.state), [], '折叠应已展开')
  assert.equal(view.state.doc.textBetween(view.state.selection.from, view.state.selection.to), 'NEEDLE')
})

console.log('\n结果：' + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)