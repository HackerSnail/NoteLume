// menu-bar.test.mjs —— Windows / Linux 菜单条：一级取 spec 分组，下一级递归，role 按平台落地
// 运行：cd src && node tests/menu-bar.test.mjs
//
// 现象：win/linux 的工具条是一排平铺图标 + 一个把三十来条混在一起的「更多」菜单，看不出分类。
// 现在一级 = app-menu.js 的分组（与 mac 原生菜单栏同源），操作进下一级；执行仍走注册表那条链路。
// 这一支要钉住三件事：
// 1) 分组内容不在菜单条里重写第二份，一级完全跟着 spec 走（app 组改名「帮助」，只把它从 mac 的
//    第一格挪到 win/linux 的最后一格，排在「窗口」右边）；
// 2) spec 里的 mac 系统项在这侧要么有真实动作（剪切/最小化/关于），要么整项不出（服务/隐藏），
//    不能挂出一个点了没反应的项；
// 3) 勾选、置灰、快捷键后缀、动态子菜单（最近 / 主题 / 导出）与 mac 同一份数据。
// 走真 menu-bar.js + 造 spec（分组数据与 buildMacMenuSpec 同形状），CSS 与 HTML 声明另钉。

import assert from 'node:assert'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { JSDOM } from 'jsdom'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SRC = path.resolve(HERE, '..')

const dom = new JSDOM('<!doctype html><html><body></body></html>', { url: 'http://localhost/' })
global.window = dom.window
global.document = dom.window.document
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true })
global.localStorage = dom.window.localStorage
global.HTMLElement = dom.window.HTMLElement
global.CustomEvent = dom.window.CustomEvent
global.Event = dom.window.Event
dom.window.localStorage.setItem('nl-lang', 'zh-CN')

const { createMenuBar, DROP_ROLES, ROLE_COMMAND, GROUP_ICON } = await import('../menu-bar.js')
const { buildMacMenuSpec } = await import('../app-menu.js')
const { setLocale } = await import('../i18n.js')

// —— 造 spec：形状与 buildMacMenuSpec 的返回一致（cmd / check / sep / submenu / role）——
const SPEC = {
  groups: [
    {
      id: 'app', text: 'NoteLume', items: [
        { type: 'role', role: 'About', text: '关于 NoteLume' },
        { type: 'sep' },
        { type: 'cmd', id: 'app.shortcuts', text: '快捷键设置…' },
        { type: 'submenu', id: 'language', text: '语言', items: [
          { type: 'check', id: 'app.lang.zh-CN', text: '简体中文', checked: true },
          { type: 'cmd', id: 'app.lang.en-US', text: 'English' },
        ] },
        { type: 'role', role: 'Services', text: '服务' },
        { type: 'role', role: 'Hide', text: '隐藏 NoteLume' },
        { type: 'role', role: 'HideOthers', text: '隐藏其他' },
        { type: 'role', role: 'ShowAll', text: '全部显示' },
        { type: 'role', role: 'Quit', text: '退出 NoteLume' },
      ],
    },
    {
      id: 'file', text: '文件', items: [
        { type: 'cmd', id: 'app.save', text: '保存' },
        { type: 'check', id: 'app.autosave', text: '自动保存', checked: true },
        { type: 'sep' },
        { type: 'submenu', id: 'export', text: '导出', items: [
          { type: 'cmd', id: 'app.export', text: '导出 PDF' },
          { type: 'cmd', id: 'app.exportWord', text: '导出 Word', enabled: false },
        ] },
        { type: 'submenu', id: 'recent', text: '最近打开', items: [
          { type: 'cmd', id: 'recent:0', text: 'a.md' },
          { type: 'sep' },
          { type: 'cmd', id: 'app.clearRecents', text: '清空最近打开' },
        ] },
        { type: 'cmd', id: 'app.renameFile', text: '重命名', enabled: false },
      ],
    },
    {
      id: 'edit', text: '编辑', items: [
        { type: 'cmd', id: 'editor.undo', text: '撤销' },
        { type: 'role', role: 'Cut', text: '剪切' },
        { type: 'role', role: 'Copy', text: '复制', enabled: false },
        { type: 'role', role: 'Paste', text: '粘贴' },
        { type: 'role', role: 'SelectAll', text: '全选' },
      ],
    },
    { id: 'window', text: '窗口', items: [{ type: 'role', role: 'Minimize', text: '最小化' }] },
  ],
}

const KEYS = { 'app.save': 'Ctrl+S', 'editor.undo': 'Ctrl+Z' }

let pass = 0
let fail = 0
async function t(name, fn) {
  try { await fn(); pass++; console.log('  ok   ' + name) }
  catch (e) { fail++; console.log('  FAIL ' + name + ' —— ' + ((e && e.message) || e)) }
}

// 行工厂与 main.js 的 menuBarRow 同口径：文案 + 勾选位 + 置灰 + 子菜单箭头
function row(label, fn, opt = {}) {
  const b = document.createElement('button')
  b.className = 'cv-menu-item'
  if (opt.disabled) b.disabled = true
  const chk = document.createElement('span')
  chk.className = 'cv-menu-check'
  if (opt.checked) chk.appendChild(document.createElementNS('http://www.w3.org/2000/svg', 'svg'))
  const lab = document.createElement('span')
  lab.className = 'cv-menu-label'
  lab.textContent = label
  b.appendChild(chk)
  b.appendChild(lab)
  if (opt.arrow) {
    const a = document.createElement('span')
    a.className = 'cv-menu-arrow'
    a.textContent = '▸'
    b.appendChild(a)
  }
  b.addEventListener('click', () => { if (!b.disabled) fn() })
  return b
}
const separator = () => {
  const d = document.createElement('div')
  d.className = 'cv-menu-sep'
  return d
}

let lastBar = null
function makeBar(spec = SPEC) {
  if (lastBar) lastBar.closeAll() // 上一支用例失败时不会走到 closeAll，监听会串到这一支来
  for (const stale of document.querySelectorAll('.nl-menu-pop')) stale.remove()
  document.body.innerHTML = '<header class="toolbar"><nav id="nl-menubar" class="nl-menubar"></nav></header>'
  const cmds = []
  const roles = []
  const disabledRoles = new Set()
  const bar = createMenuBar({
    mount: document.getElementById('nl-menubar'),
    helpLabel: () => '帮助',
    buildSpec: () => spec,
    row,
    separator,
    runCommand: (id) => cmds.push(id),
    roleHandler: {
      run: (r) => roles.push(r),
      enabled: (r) => !disabledRoles.has(r),
      key: (r) => ({ Cut: 'Ctrl+X', Copy: 'Ctrl+C', Paste: 'Ctrl+V', SelectAll: 'Ctrl+A' }[r] || ''),
    },
    keyFor: (it) => (it.id ? (KEYS[it.id] || '') : ''),
  })
  lastBar = bar
  return { bar, cmds, roles, disabledRoles }
}

const topBtns = () => [...document.querySelectorAll('.nl-menubar-item')]
// 一级格是图标，分类名在 aria-label / title 上
const topTexts = () => topBtns().map((b) => b.getAttribute('aria-label'))
const btn = (text) => topBtns().find((b) => b.getAttribute('aria-label') === text)
const root = () => document.querySelector('.nl-menu-pop:not(.nl-menu-sub)')
const rows = (el) => [...(el || root()).querySelectorAll(':scope > .cv-menu-item')]
const labels = (el) => rows(el).map((b) => b.textContent)
const sub = () => document.querySelector('.nl-menu-sub')
const rowBy = (text, el) => rows(el).find((b) => b.textContent === text)
function press(k, target) {
  (target || document.body).dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }))
}
function down(el) {
  (el || document.body).dispatchEvent(new dom.window.MouseEvent('mousedown', { bubbles: true }))
}
const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

await t('一级分类完全跟 spec，app 组改名「帮助」并收尾（排在窗口右边）', () => {
  makeBar()
  assert.deepStrictEqual(topTexts(), ['文件', '编辑', '窗口', '帮助'])
  assert.deepStrictEqual(topBtns().map((b) => b.dataset.group), ['file', 'edit', 'window', 'app'])
})

await t('一级格只出图标：格内没有文字节点，分类名挂在 title 与 aria-label 上', () => {
  makeBar()
  for (const b of topBtns()) {
    assert.strictEqual(b.textContent, '', `一级格不该留文字：${b.dataset.group}`)
    assert.strictEqual(b.title, b.getAttribute('aria-label'), 'title 与 aria-label 要同一个分类名')
    const use = b.querySelector('svg.nl-ico use')
    assert.ok(use, `一级格要画图标：${b.dataset.group}`)
    assert.strictEqual(use.getAttribute('href'), '#i-' + GROUP_ICON[b.dataset.group])
  }
})

await t('图标映射覆盖 app-menu.js 声明的每个分组，且符号都在 sprite 里（新增分组漏配图要在这里失败）', () => {
  const src = fs.readFileSync(path.join(SRC, 'app-menu.js'), 'utf8')
  const declared = [...new Set([...src.matchAll(/\bgroup\('([a-z]+)'/g)].map((m) => m[1]))]
  const html = fs.readFileSync(path.join(SRC, 'index.html'), 'utf8')
  assert.deepStrictEqual(Object.keys(GROUP_ICON).sort(), [...declared].sort(), '映射的分组要和 spec 声明的一一对应')
  for (const id of declared) {
    assert.ok(html.includes(`symbol id="i-${GROUP_ICON[id]}"`), `分组 ${id} 的图标 #i-${GROUP_ICON[id]} 不在 sprite 里`)
  }
})

await t('点一级出下一级：文案带快捷键后缀，勾选与置灰照 spec，分隔线在位', () => {
  const { bar } = makeBar()
  btn('文件').click()
  assert.ok(root(), '下一级应挂到 body')
  assert.deepStrictEqual(labels(), ['保存 (Ctrl+S)', '自动保存', '导出▸', '最近打开▸', '重命名'])
  assert.strictEqual(rowBy('重命名').disabled, true, 'spec 里 enabled:false 的项要置灰')
  assert.ok(rowBy('自动保存').querySelector('.cv-menu-check svg'), 'check 项打勾')
  assert.strictEqual(root().querySelectorAll(':scope > .cv-menu-sep').length, 1, '分隔线应渲染')
  assert.ok(rowBy('导出▸').querySelector('.cv-menu-arrow'), '子菜单项要有箭头')
  bar.closeAll()
})

await t('叶子点击：先关菜单再走 runCommand（执行仍归注册表那条链路）', () => {
  const { bar, cmds } = makeBar()
  btn('文件').click()
  rowBy('保存 (Ctrl+S)').click()
  assert.deepStrictEqual(cmds, ['app.save'])
  assert.strictEqual(root(), null, '执行后整条收起')
  assert.strictEqual(bar.isOpen(), false)
})

await t('mac 系统项在这侧整项不出：服务 / 隐藏 / 隐藏其他 / 全部显示', () => {
  const { bar } = makeBar()
  btn('帮助').click()
  const got = labels()
  for (const gone of ['服务', '隐藏 NoteLume', '隐藏其他', '全部显示']) {
    assert.ok(!got.includes(gone), gone + ' 不该出现在 win/linux 菜单里')
  }
  assert.ok(got.includes('关于 NoteLume') && got.includes('退出 NoteLume'), 'About/Quit 要有落地入口')
  bar.closeAll()
})

await t('About 走注册表命令，窗口项与剪贴板项走 roleHandler', () => {
  const { bar, cmds, roles } = makeBar()
  btn('帮助').click()
  rowBy('关于 NoteLume').click()
  assert.deepStrictEqual(cmds, ['app.about'], 'About 应转成 app.about 命令')
  btn('帮助').click()
  rowBy('退出 NoteLume').click()
  assert.deepStrictEqual(roles, ['Quit'], 'Quit 交给 roleHandler（走关闭链路）')
  btn('窗口').click()
  rowBy('最小化').click()
  assert.deepStrictEqual(roles, ['Quit', 'Minimize'])
})

await t('剪切/复制/粘贴/全选：带快捷键后缀，无选区的那项按 roleHandler.enabled 置灰', () => {
  const { bar, roles, disabledRoles } = makeBar()
  btn('编辑').click()
  assert.deepStrictEqual(labels(), ['撤销 (Ctrl+Z)', '剪切 (Ctrl+X)', '复制 (Ctrl+C)', '粘贴 (Ctrl+V)', '全选 (Ctrl+A)'])
  assert.strictEqual(rowBy('复制 (Ctrl+C)').disabled, true, 'spec 里 enabled:false 的 role 也置灰')
  rowBy('复制 (Ctrl+C)').click()
  assert.deepStrictEqual(roles, [], '置灰的项不该能点')
  disabledRoles.add('Paste')
  bar.closeAll()
  btn('编辑').click()
  assert.strictEqual(rowBy('粘贴 (Ctrl+V)').disabled, true, '无落点时要置灰')
  rowBy('剪切 (Ctrl+X)').click()
  assert.deepStrictEqual(roles, ['Cut'])
})

await t('子菜单：悬停即在右侧出下一层，叶子把 id 原样交给 runCommand', () => {
  const { bar, cmds } = makeBar()
  btn('文件').click()
  const host = rowBy('最近打开▸')
  host.dispatchEvent(new dom.window.Event('mouseenter'))
  assert.ok(sub(), '应出现子层')
  assert.deepStrictEqual(labels(sub()), ['a.md', '清空最近打开'])
  rows(sub())[0].click()
  assert.deepStrictEqual(cmds, ['recent:0'], 'recent: 前缀由 onMenuSelect 认领')
  bar.closeAll()
  btn('文件').click()
  rowBy('导出▸').dispatchEvent(new dom.window.Event('mouseenter'))
  assert.strictEqual(rows(sub())[1].disabled, true, '子层里的置灰同样传递')
  rows(sub())[0].click()
  assert.deepStrictEqual(cmds, ['recent:0', 'app.export'])
})

await t('同级只留一个子层：换父项时旧的收掉', () => {
  const { bar } = makeBar()
  btn('文件').click()
  rowBy('导出▸').dispatchEvent(new dom.window.Event('mouseenter'))
  assert.ok(sub())
  rowBy('最近打开▸').dispatchEvent(new dom.window.Event('mouseenter'))
  assert.strictEqual(document.querySelectorAll('.nl-menu-sub').length, 1, '只应剩刚打开的那层')
  assert.strictEqual(sub().textContent.includes('a.md'), true)
})

await t('收起：再点同一项、点外部、Escape 都关；有子层时 Escape 先收子层', () => {
  const { bar } = makeBar()
  btn('文件').click()
  assert.ok(root())
  btn('文件').click()
  assert.strictEqual(root(), null, '再点同一项应收起')
  btn('文件').click()
  down(document.body)
  assert.strictEqual(root(), null, '点外部应收起')
  btn('文件').click()
  rowBy('导出▸').dispatchEvent(new dom.window.Event('mouseenter'))
  assert.ok(sub())
  press('Escape')
  assert.strictEqual(sub(), null, '第一次 Escape 只收子层')
  assert.ok(root(), '顶层还在')
  press('Escape')
  assert.strictEqual(root(), null, '第二次 Escape 收整条')
  bar.closeAll()
})

await t('键盘：↑↓ 在本层移动（跳过置灰项），→ 开子层并进去，← 退回父项', () => {
  const { bar } = makeBar()
  btn('文件').click()
  press('ArrowDown', root())
  assert.strictEqual(document.activeElement.textContent, '保存 (Ctrl+S)', '第一次 ↓ 进第一项')
  press('ArrowDown')
  assert.strictEqual(document.activeElement.textContent, '自动保存')
  press('ArrowDown')
  assert.strictEqual(document.activeElement.textContent, '导出▸', '置灰的「重命名」要被跳过')
  document.activeElement.focus()
  press('ArrowRight')
  assert.ok(sub(), '→ 应开子层')
  assert.strictEqual(document.activeElement.textContent, '导出 PDF', '进子层后焦点落在第一项')
  assert.strictEqual(rows(sub())[1].disabled, true, 'Word 导出未开文档时置灰，不该被自动聚焦')
  press('ArrowLeft')
  assert.strictEqual(sub(), null, '← 退回并收掉子层')
  assert.strictEqual(document.activeElement.textContent, '导出▸')
  bar.closeAll()
})

await t('一级之间：→ 切到下一分类并展开，悬停同样切换', () => {
  const { bar } = makeBar()
  btn('文件').click()
  press('ArrowRight')
  assert.strictEqual(btn('编辑').getAttribute('aria-expanded'), 'true', '应切到「编辑」')
  assert.ok(root().textContent.includes('剪切'))
  press('ArrowLeft')
  press('ArrowLeft')
  assert.strictEqual(btn('帮助').getAttribute('aria-expanded'), 'true', '到边界回绕到最后一个分类')
  btn('窗口').dispatchEvent(new dom.window.Event('mouseenter'))
  assert.strictEqual(btn('窗口').getAttribute('aria-expanded'), 'true', '展开状态下悬停相邻项即切换')
  assert.ok(root().textContent.includes('最小化'))
  bar.closeAll()
})

await t('动态内容每次展开现取：spec 变了同一格跟着变，不缓存在菜单条上', () => {
  const live = JSON.parse(JSON.stringify(SPEC))
  const { bar } = makeBar(live)
  btn('文件').click()
  assert.deepStrictEqual(labels().includes('另存为…'), false)
  live.groups[1].items.unshift({ type: 'cmd', id: 'app.saveAs', text: '另存为…' })
  bar.closeAll()
  btn('文件').click()
  assert.strictEqual(labels()[0], '另存为…', '重新展开要读到新 spec')
  bar.closeAll()
  btn('文件').dispatchEvent(new dom.window.Event('mouseenter'))
  assert.strictEqual(root(), null, '收起状态下悬停不自动弹（只有已展开时才切换）')
})

await t('切语言整条重排：一级文案跟着新语言出', () => {
  const localized = {
    groups: [{ id: 'file', text: 'File', items: [{ type: 'cmd', id: 'app.save', text: 'Save' }] }],
  }
  const { bar } = makeBar(localized)
  assert.deepStrictEqual(topTexts(), ['File'])
  localized.groups[0].text = 'Datei'
  bar.render()
  assert.deepStrictEqual(topTexts(), ['Datei'], '重绘后取新词条')
  setLocale('en-US')
  assert.deepStrictEqual(topTexts(), ['Datei'], '订阅重绘不影响 spec 给出的分组名')
  dom.window.localStorage.setItem('nl-lang', 'zh-CN')
  setLocale('zh-CN')
})

await t('role 落地表本身：丢弃项与 About 映射', () => {
  assert.deepStrictEqual([...DROP_ROLES].sort(), ['Hide', 'HideOthers', 'Services', 'ShowAll'])
  assert.deepStrictEqual(ROLE_COMMAND, { About: 'app.about' })
})

await t('真 spec 的每个叶子都能落地：递归展开后 DOM 行与 spec 叶子一一对应', () => {
  const spec = buildMacMenuSpec({
    commands: [
      { id: 'app.newFile', title: '新建' },
      { id: 'app.autosave', title: '自动保存', checked: false },
      { id: 'app.clearRecents', title: '清空最近记录' },
    ],
    recents: [],
    templates: [],
    themes: [{ id: 'theme:dark', label: '暗黑', checked: true }],
    languages: [{ id: 'app.lang.zh-CN', label: '简体中文', checked: true }],
  })
  const { bar } = makeBar(spec)
  const bare = (s2) => s2.replace(/\s*\([^)]*\)$/, '').replace(/▸$/, '')
  const want = []
  const walkSpec = (items) => {
    for (const it of items) {
      if (it.type === 'sep') continue
      if (it.type === 'role' && DROP_ROLES.has(it.role)) continue
      want.push(bare(it.text || ''))
      if (it.items) walkSpec(it.items)
    }
  }
  spec.groups.forEach((g) => walkSpec(g.items))
  const got = []
  const walkDom = (el) => {
    for (const r of rows(el)) {
      got.push(bare(r.textContent))
      if (r.__nlSubItems) {
        r.dispatchEvent(new dom.window.Event('mouseenter'))
        walkDom(r.__nlSubEl)
      }
    }
  }
  for (const b of topBtns()) {
    b.click()
    walkDom(root())
    bar.closeAll()
  }
  assert.ok(want.length > 6, '这条要覆盖到动态子菜单，实得 ' + want.length)
  assert.deepStrictEqual(got.sort(), want.sort(), '菜单条渲染的叶子要和 spec 一致（含空列表占位项）')
  bar.closeAll()
})

// —— 声明层：真 style.css 进 CSSOM，真 index.html 的标记 ——
const cssText = fs.readFileSync(path.join(SRC, 'style.css'), 'utf8')
const cssDom = new JSDOM('<!doctype html><html><head><style></style></head><body></body></html>')
cssDom.window.document.querySelector('style').textContent = cssText
function cssOf(selector) {
  const out = []
  const walk = (rules) => {
    for (const r of rules) {
      if (r.selectorText && r.selectorText.split(',').map((s) => s.trim()).includes(selector)) out.push(r.style.cssText)
      if (r.cssRules && r.cssRules.length) walk(r.cssRules)
    }
  }
  for (const s of [...cssDom.window.document.styleSheets]) walk(s.cssRules)
  return out
}

await t('CSS 声明：菜单条一行不折行、子层用 body 级固定定位浮在顶层之上', () => {
  const nav = cssOf('.nl-menubar')
  assert.ok(nav.some((b) => /overflow-x:\s*auto/.test(b)), `.nl-menubar 要横向滚动兜底，实得 ${JSON.stringify(nav)}`)
  assert.ok(nav.some((b) => /display:\s*flex/.test(b)), '.nl-menubar 应是 flex 一行')
  const item = cssOf('.toolbar .nl-menubar-item')
  assert.ok(item.some((b) => /flex:\s*(none|0 0 auto)/.test(b)), '一级项不随窄窗口收缩，实得 ' + JSON.stringify(item))
  assert.ok(item.some((b) => /height:\s*26px/.test(b)), '一级项要定高：纯拉丁文（Git）的行盒比中文矮，居中后一块高一块低')
  const subCss = cssOf('.cv-menu.nl-menu-sub')
  assert.ok(subCss.some((b) => /position:\s*fixed/.test(b)), '子层必须 fixed：顶层 .tree-menu 带 overflow 滚动，做成子元素会被裁掉')
  assert.ok(subCss.some((b) => /z-index:\s*41/.test(b)), '子层要压在顶层（.tree-menu z-index 40）之上')
  assert.ok(cssOf('.toolbar .nl-menubar-item[aria-expanded="true"]').length > 0, '展开态要有高亮声明')
})

await t('HTML：八个平铺图标退场，菜单条只留一个挂载点', () => {
  const html = fs.readFileSync(path.join(SRC, 'index.html'), 'utf8')
  for (const gone of ['btn-open-file', 'btn-open"', 'btn-new-file', 'btn-save', 'btn-daily', 'btn-source', 'btn-paragraph', 'btn-more', 'btn-group']) {
    assert.ok(!html.includes(gone), `工具条图标 ${gone} 应已退场，不能和菜单条同时存在两个入口`)
  }
  assert.ok(/<nav class="nl-menubar" id="nl-menubar"/.test(html), '菜单条挂载点缺失')
  for (const keep of ['btn-find', 'btn-replace', 'chk-autosave', 'btn-theme', 'win-btns', 'docstats', 'filename']) {
    assert.ok(html.includes(keep), `右侧常驻项 ${keep} 不该被连带删掉`)
  }
})

await t('mac 那侧不挂菜单条：CSS 里 data-mac 隐藏的是菜单条而不是旧图标组', () => {
  const html = fs.readFileSync(path.join(SRC, 'index.html'), 'utf8')
  const css = fs.readFileSync(path.join(SRC, 'style.css'), 'utf8')
  assert.ok(!/btn-group|btn-more/.test(css), 'style.css 里不该再留 .btn-group 规则')
  assert.ok(/\[data-mac\] \.toolbar \.nl-menubar/.test(css), 'mac 隐藏菜单条的声明缺失（原生菜单栏已有一份入口）')
  assert.ok(html.includes('id="nl-menubar"'), '挂载点应在 HTML 里，由 main.js 按平台填内容')
})

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
