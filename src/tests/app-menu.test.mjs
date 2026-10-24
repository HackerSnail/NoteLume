// app-menu.test.mjs —— mac 原生菜单 spec 构建的纯逻辑回归（不触 Tauri：materialize 需原生运行时）
// 运行：cd src && node tests/app-menu.test.mjs

import assert from 'node:assert'
import { buildMacMenuSpec } from '../app-menu.js'

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

const C = (id, title, extra = {}) => ({ id, title, category: id.split('.')[0], ...extra })

const base = () => [
  C('app.save', '保存当前文件', { accelerator: 'Cmd+S' }),
  C('app.openFile', '打开单个文件', { accelerator: 'Cmd+O' }),
  C('app.openFolder', '打开知识库文件夹', { accelerator: 'Cmd+Shift+O' }),
  C('app.newFile', '新建文件', { accelerator: 'Cmd+N' }),
  C('app.renameFile', '重命名当前文件', { accelerator: 'F2' }),
  C('app.closeFile', '关闭当前标签页', { accelerator: 'Cmd+W' }),
  C('app.nextTab', '切换下一个标签页', { accelerator: 'Ctrl+Tab' }),
  C('app.prevTab', '切换上一个标签页', { accelerator: 'Ctrl+Shift+Tab' }),
  C('app.splitH', '向左 / 右拆分窗格'),
  C('app.splitV', '向上 / 下拆分窗格'),
  C('app.newCanvas', '新画布 / 白板'),
  C('app.newTemplate', '新建空白模板…'),
  C('app.dailySettings', '今日速记设置…'),
  C('app.clearRecents', '清空最近记录'),
  C('app.export', '导出为 HTML'),
  C('app.exportSite', '导出整站…'),
  C('app.importWord', '导入 Word(.docx)…'),
  C('app.exportWord', '导出 Word(.docx)…'),
  C('app.print', '打印 / 另存 PDF', { accelerator: 'Cmd+P' }),
  C('app.dailyCapture', '今日速记', { accelerator: 'Cmd+Shift+D' }),
  C('app.autosave', '自动保存', { checked: false }),
  C('app.shortcuts', '快捷键设置…'),
  C('app.search', '聚焦侧栏搜索', { accelerator: 'Cmd+Shift+F' }),
  C('app.insertImage', '插入图片…', { accelerator: 'Cmd+Shift+I' }),
  C('editor.undo', '撤销', { accelerator: 'Cmd+Z' }),
  C('editor.redo', '重做', { accelerator: 'Cmd+Y' }),
  C('editor.bold', '加粗', { accelerator: 'Cmd+B' }),
  C('editor.italic', '斜体', { accelerator: 'Cmd+I' }),
  C('editor.code', '行内代码', { accelerator: 'Cmd+`' }),
  C('editor.strike', '删除线', { accelerator: 'Cmd+Shift+X' }),
  C('editor.link', '插入 / 编辑链接', { accelerator: 'Cmd+K' }),
  C('editor.deleteLine', '删除当前行 / 段落', { accelerator: 'Cmd+D' }),
  C('app.pastePlain', '粘贴为纯文本', { accelerator: 'Cmd+Shift+V' }),
  C('editor.mathInline', '行内公式', { accelerator: 'Cmd+M' }),
  C('editor.mathBlock', '块级公式', { accelerator: 'Cmd+Shift+M' }),
  C('editor.block.para', '段落：正文', { checked: false }),
  C('editor.block.h1', '段落：一级标题', { checked: true }),
  C('editor.block.mermaid', '段落：Mermaid 图', { checked: false }),
  C('editor.headingUp', '段落：提升标题级别', { accelerator: 'Cmd+]' }),
  C('editor.headingDown', '段落：降低标题级别', { accelerator: 'Cmd+[' }),
  C('editor.foldSection', '折叠 / 展开本节', { accelerator: 'Cmd+Shift+H' }),
  C('app.sourceMode', 'Markdown 源码模式', { accelerator: 'Cmd+E' }),
  C('app.focusMode', '专注模式', { checked: true }),
  C('app.typewriterMode', '打字机模式', { checked: false }),
  C('app.toggleSidebar', '隐藏 / 显示侧栏', { checked: true }),
  C('app.toggleInspector', '隐藏 / 显示检查器', { accelerator: 'Cmd+Shift+B' }),
  C('app.graph', '打开知识图谱', { accelerator: 'Cmd+G' }),
  C('app.palette', '命令面板', { accelerator: 'Cmd+Shift+P' }),
]

const specOf = (commands = base(), extra = {}) => buildMacMenuSpec({ commands, ...extra })
const group = (spec, id) => spec.groups.find((g) => g.id === id)
const ids = (g) => g.items.map((i) => i.id || i.role || i.type)

t('七组齐全且顺序为 应用/文件/编辑/格式/段落/视图/窗口', () => {
  const spec = specOf()
  assert.deepEqual(spec.groups.map((g) => g.id), ['app', 'file', 'edit', 'format', 'paragraph', 'view', 'window'])
  assert.deepEqual(spec.groups.map((g) => g.text), ['NoteLume', '文件', '编辑', '格式', '段落', '视图', '窗口'])
})

t('标题取自注册表，菜单不自带第二份文案', () => {
  const spec = specOf([...base().filter((c) => c.id !== 'app.save'), C('app.save', '自定义保存标题', { accelerator: 'Cmd+S' })])
  const it = group(spec, 'file').items.find((i) => i.id === 'app.save')
  assert.equal(it.text, '自定义保存标题')
})

t('注册表缺失的 id 被跳过（不会挂空动作）', () => {
  const spec = specOf(base().filter((c) => c.id !== 'app.export' && c.id !== 'app.graph'))
  assert.equal(group(spec, 'file').items.filter((i) => i.id === 'app.export').length, 0)
  assert.equal(group(spec, 'view').items.filter((i) => i.id === 'app.graph').length, 0)
})

t('Word 导入/导出落在「文件」组，紧跟导出整站', () => {
  const list = ids(group(specOf(), 'file'))
  const i = list.indexOf('app.exportSite')
  assert.deepEqual(list.slice(i, i + 4), ['app.exportSite', 'app.importWord', 'app.exportWord', 'app.print'])
})

t('拆分命令落在「窗口」组，跟在两个切页项之后', () => {
  const list = ids(group(specOf(), 'window'))
  const i = list.indexOf('app.prevTab')
  assert.deepEqual(list.slice(i, i + 4), ['app.prevTab', 'sep', 'app.splitH', 'app.splitV'])
})

t('accelerator 原样透传；无键命令不带 accelerator', () => {
  const spec = specOf()
  assert.equal(group(spec, 'file').items.find((i) => i.id === 'app.save').accelerator, 'Cmd+S')
  assert.equal('accelerator' in group(spec, 'file').items.find((i) => i.id === 'app.newCanvas'), false)
})

t('checked 存在的命令渲染为勾选项，缺省为普通项', () => {
  const spec = specOf()
  const focus = group(spec, 'view').items.find((i) => i.id === 'app.focusMode')
  assert.equal(focus.type, 'check')
  assert.equal(focus.checked, true)
  const save = group(spec, 'file').items.find((i) => i.id === 'app.save')
  assert.equal(save.type, 'cmd')
})

t('enabled:false 透传（无当前文档时保存应置灰）', () => {
  const spec = specOf(base().map((c) => (c.id === 'app.save' ? { ...c, enabled: false } : c)))
  assert.equal(group(spec, 'file').items.find((i) => i.id === 'app.save').enabled, false)
})

t('分隔符不重复、不出现在组首尾', () => {
  const spec = specOf()
  for (const g of spec.groups) {
    assert.notEqual(g.items[0].type, 'sep', g.id + ' 首项是分隔符')
    assert.notEqual(g.items[g.items.length - 1].type, 'sep', g.id + ' 尾项是分隔符')
    for (let i = 1; i < g.items.length; i++) {
      if (g.items[i].type === 'sep') assert.notEqual(g.items[i - 1].type, 'sep', g.id + ' 出现连续分隔符')
    }
  }
})

t('应用组含原生角色项（关于/服务/隐藏/退出）', () => {
  const spec = specOf()
  assert.deepEqual(group(spec, 'app').items.filter((i) => i.type === 'role').map((i) => i.role), [
    'About', 'Services', 'Hide', 'HideOthers', 'ShowAll', 'Quit',
  ])
})

t('编辑组含剪贴板角色，且角色项排在撤销/重做之后', () => {
  const spec = specOf()
  assert.deepEqual(ids(group(spec, 'edit')), [
    'editor.undo', 'editor.redo', 'sep', 'Cut', 'Copy', 'Paste', 'app.pastePlain', 'app.insertImage', 'SelectAll', 'sep', 'app.search',
  ])
})

t('文件组新建/重命名/关闭依次落在打开文件夹之后', () => {
  const list = ids(group(specOf(), 'file'))
  assert.deepEqual(list.slice(1, 4), ['app.openFolder', 'app.newFile', 'app.renameFile'])
  assert.equal(list[list.length - 2], 'app.closeFile')
})

t('段落组由注册表 editor.block.* 驱动、去掉「段落：」前缀，尾部挂提升 / 降级', () => {
  const spec = specOf()
  const para = group(spec, 'paragraph')
  assert.deepEqual(para.items.map((i) => i.id || i.type), [
    'editor.block.para', 'editor.block.h1', 'editor.block.mermaid', 'sep', 'editor.headingUp', 'editor.headingDown',
  ])
  assert.deepEqual(para.items.filter((i) => i.type !== 'sep').map((i) => i.text), [
    '正文', '一级标题', 'Mermaid 图', '提升标题级别', '降低标题级别',
  ])
})

t('段落组当前块单选：命中项 checked true，未命中也是勾选项（只是无勾）', () => {
  const spec = specOf()
  const para = group(spec, 'paragraph')
  const byId = (id) => para.items.find((i) => i.id === id)
  assert.equal(byId('editor.block.h1').type, 'check')
  assert.equal(byId('editor.block.h1').checked, true)
  assert.equal(byId('editor.block.para').type, 'check')
  assert.equal(byId('editor.block.para').checked, false)
  // 提升 / 降级不是块类型，没有「当前」一说 → 保持普通项
  assert.equal(byId('editor.headingUp').type, 'cmd')
})

t('未知：注册表缺提升 / 降级时，段落组不以悬空分隔符收尾', () => {
  const cmds = base().filter((c) => !/^editor\.heading(Up|Down)$/.test(c.id))
  const para = group(specOf(cmds), 'paragraph')
  assert.notEqual(para.items[para.items.length - 1].type, 'sep')
  assert.deepEqual(para.items.map((i) => i.id || i.type), ['editor.block.para', 'editor.block.h1', 'editor.block.mermaid'])
})

t('段落组跟随注册表顺序（新增块命令自动上榜）', () => {
  const cmds = [...base()]
  cmds.splice(cmds.findIndex((c) => c.id === 'editor.block.para') + 1, 0, C('editor.block.h2', '段落：二级标题', { checked: false }))
  assert.deepEqual(group(specOf(cmds), 'paragraph').items.map((i) => i.id || i.type), [
    'editor.block.para', 'editor.block.h2', 'editor.block.h1', 'editor.block.mermaid', 'sep', 'editor.headingUp', 'editor.headingDown',
  ])
})

t('打开最近：有记录则逐条列出，id 带 recent: 前缀', () => {
  const spec = specOf(base(), { recents: [{ id: 'recent:0', label: 'a.md' }, { id: 'recent:1', label: 'b.md' }] })
  const sub = group(spec, 'file').items.find((i) => i.id === 'recent')
  assert.deepEqual(sub.items.map((i) => i.id || i.type), ['recent:0', 'recent:1', 'sep', 'app.clearRecents'])
})

t('打开最近：空记录 → 一条禁用占位（不渲染空子菜单）', () => {
  const spec = specOf(base(), { recents: [] })
  const sub = group(spec, 'file').items.find((i) => i.id === 'recent')
  assert.deepEqual(sub.items.map((i) => i.id || i.type), ['nl.noop', 'sep', 'app.clearRecents'])
  assert.equal(sub.items[0].enabled, false)
})

t('模板子菜单：模板项 + 分隔 + 尾部命令', () => {
  const spec = specOf(base(), { templates: [{ id: 'tpl:周报', label: '周报' }] })
  const sub = group(spec, 'file').items.find((i) => i.id === 'templates')
  assert.deepEqual(sub.items.map((i) => i.id || i.type), ['tpl:周报', 'sep', 'app.newTemplate', 'app.dailySettings'])
})

t('模板子菜单：无模板时仍带新建/设置入口', () => {
  const spec = specOf(base(), { templates: [] })
  const sub = group(spec, 'file').items.find((i) => i.id === 'templates')
  assert.deepEqual(sub.items.map((i) => i.id || i.type), ['nl.noop', 'sep', 'app.newTemplate', 'app.dailySettings'])
})

t('主题子菜单为单选式勾选项', () => {
  const spec = specOf(base(), { themes: [
    { id: 'theme:light', label: '浅色', checked: true },
    { id: 'theme:dark', label: '暗黑', checked: false },
  ] })
  const sub = group(spec, 'view').items.find((i) => i.id === 'theme')
  assert.deepEqual(sub.items.map((i) => [i.type, i.checked]), [['check', true], ['check', false]])
})

t('语言子菜单跟随「更多」：列全部语言、当前语言打勾', () => {
  const spec = specOf(base(), { languages: [
    { id: 'app.lang.zh-CN', label: '简体中文', checked: true },
    { id: 'app.lang.en-US', label: 'English', checked: false },
  ] })
  const sub = group(spec, 'app').items.find((i) => i.id === 'language')
  assert.ok(sub, '应用组缺语言子菜单')
  assert.equal(sub.text, '界面语言')
  assert.deepEqual(sub.items.map((i) => [i.id, i.type, i.checked]), [
    ['app.lang.zh-CN', 'check', true],
    ['app.lang.en-US', 'check', false],
  ])
})

t('语言子菜单：ctx 未给语言时不挂空子菜单', () => {
  const spec = specOf()
  assert.equal(group(spec, 'app').items.filter((i) => i.id === 'language').length, 0)
})

t('注册表几乎为空：只剩含原生角色项的组，格式/段落/视图消失', () => {
  const spec = specOf([C('app.save', '保存当前文件')])
  assert.deepEqual(spec.groups.map((g) => g.id), ['app', 'file', 'edit', 'window'])
  assert.deepEqual(group(spec, 'file').items.map((i) => i.id || i.role || i.type),
    ['recent', 'templates', 'sep', 'app.save', 'sep', 'CloseWindow'])
})

t('空注册表：应用组仍给出关于/服务/隐藏/退出，编辑组仍给出剪贴板', () => {
  const spec = specOf([])
  assert.deepEqual(spec.groups.map((g) => g.id), ['app', 'file', 'edit', 'window'])
  assert.deepEqual(group(spec, 'app').items.filter((i) => i.type === 'role').map((i) => i.role),
    ['About', 'Services', 'Hide', 'HideOthers', 'ShowAll', 'Quit'])
  assert.deepEqual(group(spec, 'edit').items.filter((i) => i.type === 'role').map((i) => i.role),
    ['Cut', 'Copy', 'Paste', 'SelectAll'])
})

t('appName 覆盖应用组标题', () => {
  assert.equal(group(specOf(base(), { appName: 'NoteLume Pro' }), 'app').text, 'NoteLume Pro')
})

t('角色项带中文标题（不留 muda 默认英文），应用名跟随 appName', () => {
  const spec = specOf(base(), { appName: 'NoteLume' })
  const roles = {}
  for (const g of spec.groups) for (const i of g.items) if (i.type === 'role') roles[i.role] = i.text
  assert.deepEqual(roles, {
    About: '关于 NoteLume',
    Services: '服务',
    Hide: '隐藏 NoteLume',
    HideOthers: '隐藏其他',
    ShowAll: '全部显示',
    Quit: '退出 NoteLume',
    CloseWindow: '关闭窗口',
    Cut: '剪切',
    Copy: '复制',
    Paste: '粘贴',
    SelectAll: '全选',
    Minimize: '最小化',
    Maximize: '缩放',
    Fullscreen: '进入全屏幕',
  })
})

t('叶子 id 全局唯一（原生菜单按 id 回调，重名会串事件）', () => {
  const spec = specOf(base(), {
    recents: [{ id: 'recent:0', label: 'a.md' }],
    templates: [{ id: 'tpl:0', label: 't' }],
    themes: [{ id: 'theme:light', label: '浅色', checked: true }],
    languages: [{ id: 'app.lang.zh-CN', label: '简体中文', checked: true }],
  })
  const all = []
  const walk = (items) => items.forEach((i) => {
    if (i.type === 'sep' || i.type === 'role') return
    all.push(i.id)
    if (i.items) walk(i.items)
  })
  spec.groups.forEach((g) => walk(g.items))
  assert.equal(new Set(all).size, all.length, '存在重复 id：' + all.filter((x, i) => all.indexOf(x) !== i).join(','))
})

t('解绑的命令（无 accelerator）仍出现在菜单里，只是不带键', () => {
  const spec = specOf(base().map((c) => (c.id === 'app.save' ? { ...c, accelerator: undefined } : c)))
  const it = group(spec, 'file').items.find((i) => i.id === 'app.save')
  assert.ok(it)
  assert.equal('accelerator' in it, false)
})

console.log(`\n${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)
