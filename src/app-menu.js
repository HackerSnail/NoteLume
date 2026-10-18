// app-menu.js —— macOS 系统菜单栏的 spec 构建
//
// 只在 mac 装配：Windows/Linux 保留窗口内工具条，不建第二套 UI（设计文档的非目标）。
// 这里只做纯数据变换（buildMacMenuSpec）→ 可 Node 单测；落地成原生菜单由 Rust 的
// `set_mac_menu` 完成（一次 IPC 换整棵菜单），点击经 `nl:menu-select` 事件回 main.js。
// 条目一律取命令注册表的 title 与「覆盖 ∪ 默认」绑定：这里不写第二份文案或快捷键。

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

  const group = (id, text, list) => {
    const items = []
    const push = (it) => {
      if (it && (it.type !== 'sep' || (items.length && items[items.length - 1].type !== 'sep'))) items.push(it)
    }
    for (const entry of list) {
      if (!entry) continue
      if (entry === 'sep') {
        push({ type: 'sep' })
        continue
      }      if (typeof entry === 'string') {
        push(item(entry))
        continue
      }
      if (entry.type === 'role') {
        const label = ROLE_TEXT[entry.role]
        push(label ? { ...entry, text: label(ctx.appName || 'NoteLume') } : entry)
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
      }
      if (kids.length) push({ type: 'submenu', id: entry.id, text: entry.text, dynamic: entry.dynamic, items: kids })
    }
    // 尾部分隔符：注册表里缺该组的某些项（如尚未注册的提升/降级）时会留下悬空分隔线
    while (items.length && items[items.length - 1].type === 'sep') items.pop()
    return items.length ? { id, text, items } : null
  }

  const groups = [
    group('app', ctx.appName || 'NoteLume', [
      role('About'),
      'sep',
      'app.shortcuts',
      'sep',
      role('Services'),
      'sep',
      role('Hide'),
      role('HideOthers'),
      role('ShowAll'),
      'sep',
      role('Quit'),
    ]),
    group('file', t('menu.group.file'), [
      'app.openFile',
      'app.openFolder',
      'app.newFile',
      'app.renameFile',
      submenu('recent', t('menu.recentMac'), 'recents', ['app.clearRecents']),
      'app.newCanvas',
      submenu('templates', t('menu.templatesMac'), 'templates', ['app.newTemplate', 'app.dailySettings']),
      'sep',
      'app.save',
      'app.export',
      'app.exportSite',
      'app.importWord',
      'app.exportWord',
      'app.print',
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
      'app.insertImage',
      role('SelectAll'),
      'sep',
      'app.search',
    ]),
    group('format', t('menu.group.format'), [
      'editor.bold',
      'editor.italic',
      'editor.code',
      'editor.strike',
      'sep',
      'editor.mathInline',
      'editor.mathBlock',
    ]),
    group('paragraph', t('menu.group.paragraph'), [...blockIds, 'sep', 'editor.headingUp', 'editor.headingDown']),
    group('view', t('menu.group.view'), [
      'app.sourceMode',
      'sep',
      'editor.foldSection',
      'sep',
      'app.focusMode',
      'app.typewriterMode',
      'app.toggleSidebar',
      'app.toggleInspector',
      'sep',
      'app.graph',
      'app.palette',
      submenu('theme', t('menu.theme'), 'themes'),
    ]),
    group('window', t('menu.group.window'), [
      'app.nextTab',
      'app.prevTab',
      role('Minimize'),
      role('Maximize'),
      'sep',
      role('Fullscreen'),
    ]),
  ].filter(Boolean)

  // 「段落」组的注册表标题带当前语言的段落前缀（面板里便于归类），菜单里是多余的
  const para = groups.find((g) => g.id === 'paragraph')
  if (para) {
    const prefix = t('menu.paraPrefix')
    const re = new RegExp('^' + prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    for (const it of para.items) it.text = String(it.text).replace(re, '')
  }

  return { groups }
}
