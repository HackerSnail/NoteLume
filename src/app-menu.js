// app-menu.js —— 菜单 spec 构建（mac 系统菜单栏；Windows / Linux 的工具条「段落」菜单也取同一份的段落组）
//
// mac 上原生菜单由本模块出 spec，Rust 的 `set_mac_menu` 落地（一次 IPC 换整棵菜单），点击经
// `nl:menu-select` 事件回 main.js；Windows / Linux 保留窗口内工具条，只有「段落」下拉直接渲染
// 这里的同一条目表，免得两边各排一次序。
// 这里只做纯数据变换（buildMacMenuSpec）→ 可 Node 单测。
// 条目一律取命令注册表的 title 与「覆盖 ∪ 默认」绑定：这里不写第二份文案或快捷键。
// 注册表里每条命令都必须在某个组里出现（单测按叶子 id 全量核对），功能不留没有入口的。

// 系统预定义项的标题由我们给出：muda 只按文字建项、动作仍是原生 selector，
// 不给标题就会留一手英文（mac 上「剪切/复制/退出」这类是约定俗成的固定译法）。
// 文案走 i18n 词条，与语言切换保持一致。
import { t } from './i18n.js'

const ROLE_TEXT = {
  About: (app) => t('menu.role.about', { app }),
  Services: () => t('menu.role.services'),
  Hide: (app) => t('menu.role.hide', { app }),
  HideOthers: () => t('menu.role.hideOthers'),
  ShowAll: () => t('menu.role.showAll'),
  Quit: (app) => t('menu.role.quit', { app }),
  CloseWindow: () => t('menu.role.closeWindow'),
  Cut: () => t('menu.role.cut'),
  Copy: () => t('menu.role.copy'),
  Paste: () => t('menu.role.paste'),
  SelectAll: () => t('menu.role.selectAll'),
  Minimize: () => t('menu.role.minimize'),
  Maximize: () => t('menu.role.maximize'),
  Fullscreen: () => t('menu.role.fullscreen'),
}

const role = (name) => ({ type: 'role', role: name })
const submenu = (id, text, dynamic, tail = []) => ({ type: 'submenu', id, text, dynamic, tail })
// 静态子菜单：list 里放命令 id / 'sep' / 再一层 sub()。strip 是注册表标题里的归类前缀
// （命令面板靠它检索，菜单里父项已经说了同一件事），只在本子菜单内剥掉。
const sub = (id, text, list, strip = '') => ({ type: 'sub', id, text, list, strip })

function stripTitles(items, prefix) {
  if (!prefix) return
  const re = new RegExp('^' + prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*')
  for (const it of items) {
    if (typeof it.text === 'string') it.text = it.text.replace(re, '')
    if (it.items) stripTitles(it.items, prefix)
  }
}

/**
 * @param {object} ctx
 * @param {string} [ctx.appName]
 * @param {Array<{id:string,title:string,accelerator?:string,enabled?:boolean,checked?:boolean}>} ctx.commands
 *   已解析好的命令清单（顺序即注册顺序）；accelerator 为 muda 串（Cmd+Shift+S），无键则省略
 * @param {Array<{id:string,label:string}>} [ctx.recents] 最近打开
 * @param {Array<{id:string,label:string}>} [ctx.templates] 模板文件
 * @param {Array<{id:string,label:string,checked:boolean}>} [ctx.themes] 主题单选组
 */
export function buildMacMenuSpec(ctx = {}) {
  const byId = new Map((ctx.commands || []).map((c) => [c.id, c]))

  // 注册表里没有的 id 直接跳过：菜单不会挂出一个空动作
  const item = (id) => {
    const c = byId.get(id)
    if (!c) return null
    const it = { id, text: c.title }
    if (c.accelerator) it.accelerator = c.accelerator
    if (c.enabled === false) it.enabled = false
    if (c.checked != null) {
      it.type = 'check'
      it.checked = !!c.checked
    } else {
      it.type = 'cmd'
    }
    return it
  }

  const blockIds = (ctx.commands || []).filter((c) => c.id.startsWith('editor.block.')).map((c) => c.id)

  // 一条命令清单 → 菜单项数组：未注册 id 跳过、连续 / 首尾分隔符去重、静态子菜单递归
  const buildItems = (list) => {
    const items = []
    const push = (it) => {
      if (it && (it.type !== 'sep' || (items.length && items[items.length - 1].type !== 'sep'))) items.push(it)
    }
    for (const entry of list) {
      if (!entry) continue
      if (entry === 'sep') {
        push({ type: 'sep' })
        continue
      }
      if (typeof entry === 'string') {
        push(item(entry))
        continue
      }
      if (entry.type === 'role') {
        const label = ROLE_TEXT[entry.role]
        push(label ? { ...entry, text: label(ctx.appName || 'NoteLume') } : entry)
        continue
      }
      if (entry.type === 'sub') {
        const kids = buildItems(entry.list)
        if (kids.length) {
          stripTitles(kids, entry.strip)
          push({ type: 'submenu', id: entry.id, text: entry.text, items: kids })
        }
        continue
      }
      const kids = []
      const withTail = (rows, emptyText) => {
        for (const r of rows) kids.push({ type: 'cmd', id: r.id, text: r.label })
        if (!kids.length) kids.push({ type: 'cmd', id: 'nl.noop', text: emptyText, enabled: false })
        if (entry.tail && entry.tail.length) {
          kids.push({ type: 'sep' })
          for (const t of entry.tail) {
            const it = item(t)
            if (it) kids.push(it)
          }
        }
      }
      if (entry.dynamic === 'recents') withTail(ctx.recents || [], t('common.none'))
      else if (entry.dynamic === 'templates') withTail(ctx.templates || [], t('menu.noTemplates'))
      else if (entry.dynamic === 'themes') {
        for (const r of ctx.themes || []) kids.push({ type: 'check', id: r.id, text: r.label, checked: !!r.checked })
      } else if (entry.dynamic === 'languages') {
        for (const r of ctx.languages || []) kids.push({ type: 'check', id: r.id, text: r.label, checked: !!r.checked })
      }
      if (kids.length) push({ type: 'submenu', id: entry.id, text: entry.text, dynamic: entry.dynamic, items: kids })
    }
    // 尾部分隔符：注册表里缺该组的某些项（如尚未注册的提升/降级）时会留下悬空分隔线
    while (items.length && items[items.length - 1].type === 'sep') items.pop()
    return items
  }

  const group = (id, text, list) => {
    const items = buildItems(list)
    return items.length ? { id, text, items } : null
  }

  // 「段落」组：标题 / 列表两个子菜单先收走对应块类型，其余 editor.block.*（新加的块）
  // 仍按注册表顺序平铺在子菜单之后，不会因为没有归类就从菜单里消失
  const placed = new Set(['editor.block.para', 'editor.block.quote', 'editor.block.table', 'editor.block.code',
    'editor.block.callout', 'editor.block.mermaid', 'editor.block.hr', 'editor.block.bullet', 'editor.block.ordered',
    'editor.block.task', ...blockIds.filter((id) => /^editor\.block\.h[1-6]$/.test(id))])
  const restBlocks = blockIds.filter((id) => !placed.has(id))

  const groups = [
    group('app', ctx.appName || 'NoteLume', [
      role('About'),
      'sep',
      'app.shortcuts',
      'app.appearance',
      'app.clipSettings',
      'app.qdToggleEval',
      'app.qdInstallPackage',
      submenu('language', t('menu.language'), 'languages'),
      'sep',
      role('Services'),
      'sep',
      role('Hide'),
      role('HideOthers'),
      role('ShowAll'),
      'sep',
      role('Quit'),
    ]),
    // 文件组按「新建 / 打开 → 保存与定位 → 导入导出 → 记录 → 关闭」分段；
    // 导出全部收进子菜单（PDF 走打印面板，语义上是导出不是打印，故也归在这里）
    group('file', t('menu.group.file'), [
      'app.newFile',
      'app.newCanvas',
      'app.openFile',
      'app.openFolder',
      submenu('recent', t('menu.recentMac'), 'recents', ['app.clearRecents']),
      submenu('templates', t('menu.templatesMac'), 'templates', ['app.newTemplate', 'app.dailySettings']),
      'sep',
      'app.save',
      'app.renameFile',
      'app.revealFile',
      'sep',
      'app.importWord',
      sub('export', t('menu.export'), [
        'app.print',
        'app.export',
        'app.exportPlain',
        'app.exportWord',
        'app.exportSlides',
        'app.exportVaultSlides',
        'app.exportSite',
      ], t('menu.exportPrefix')),
      'sep',
      'app.dailyCapture',
      'app.autosave',
      'sep',
      'app.closeFile',
      role('CloseWindow'),
    ]),
    group('edit', t('menu.group.edit'), [
      'editor.undo',
      'editor.redo',
      'sep',
      role('Cut'),
      role('Copy'),
      role('Paste'),
      'app.pastePlain',
      'sep',
      role('SelectAll'),
      'app.insertImage',
      'editor.deleteLine',
      'sep',
      'app.findInDoc',
      'app.replace',
      'app.search',
    ]),
    // 格式组只放行内标记（块级的公式块在段落组，与 Typora 同口径）
    group('format', t('menu.group.format'), [
      'editor.bold',
      'editor.italic',
      'editor.strike',
      'editor.code',
      'editor.highlight',
      'sep',
      'editor.mathInline',
    ]),
    // 段落组照 Typora：全部平铺、不出子菜单。标题六级在最上（⌘1~6），其后正文、标题升降，
    // 再按「块 → 引用 → 列表 → 链接脚注 → 分割线」分段。公式块属块级，归这里；行内公式在格式组。
    group('paragraph', t('menu.group.paragraph'), [
      ...blockIds.filter((id) => /^editor\.block\.h[1-6]$/.test(id)),
      'sep',
      'editor.block.para',
      'sep',
      'editor.headingUp',
      'editor.headingDown',
      'sep',
      'editor.block.table',
      'editor.mathBlock',
      'editor.block.code',
      'editor.exitBlock',
      'sep',
      'editor.block.quote',
      'sep',
      'editor.block.ordered',
      'editor.block.bullet',
      'editor.block.task',
      'sep',
      'editor.link',
      'editor.footnote',
      'editor.footnoteDelete',
      'sep',
      'editor.block.hr',
      'editor.block.callout',
      'editor.block.mermaid',
      ...restBlocks,
    ]),
    group('view', t('menu.group.view'), [
      'app.sourceMode',
      'sep',
      'editor.foldSection',
      'sep',
      'app.focusMode',
      'app.typewriterMode',
      'sep',
      'app.toggleSidebar',
      'app.toggleInspector',
      'sep',
      'app.graph',
      'app.palette',
      'sep',
      submenu('theme', t('menu.theme'), 'themes'),
    ]),
    group('git', t('menu.group.git'), [
      'app.git.refresh',
      'app.git.commit',
      'sep',
      'app.git.fetch',
      'app.git.pull',
      'app.git.pullMerge',
      'app.git.push',
      'sep',
      'app.git.remote',
      'app.git.init',
    ]),
    group('window', t('menu.group.window'), [
      'app.nextTab',
      'app.prevTab',
      'sep',
      'app.splitH',
      'app.splitV',
      role('Minimize'),
      role('Maximize'),
      'sep',
      role('Fullscreen'),
    ]),
  ].filter(Boolean)

  // 「段落」「Git」组的注册表标题带当前语言的归类前缀（面板里便于归类），菜单里是多余的
  for (const [gid, key] of [['paragraph', 'menu.paraPrefix'], ['git', 'menu.gitPrefix']]) {
    const g = groups.find((x) => x.id === gid)
    if (g) stripTitles(g.items, t(key))
  }

  return { groups }
}
