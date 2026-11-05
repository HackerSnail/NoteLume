// menu-bar.js —— Windows / Linux 窗口内菜单条
//
// 一级是分类（文件 / 编辑 / 格式 / 段落 / 视图 / Git / 窗口 / 帮助），操作在下一级。
// 分组与条目顺序不在这里写第二份：整棵树取 app-menu.js 的 buildMacMenuSpec，与 macOS 原生
// 菜单栏同源，改分组只需改那一处。执行仍走 main.js 的 onMenuSelect → 命令注册表，
// 与命令面板、mac 原生菜单同一条链路。
// spec 里的 role(...) 是 mac 系统预定义项，这里按平台表决定落地或丢弃（纯数据，可 Node 单测）。
import { onLocaleChange } from './i18n.js'
import { setIcon } from './icons.js'

// mac 才有意义的系统项：win/linux 出不了「服务 / 隐藏 / 全部显示」，整项丢弃
export const DROP_ROLES = new Set(['Services', 'Hide', 'HideOthers', 'ShowAll'])
// 有等价注册表命令的 role：About 在 win/linux 就是命令面板里那条「关于 NoteLume」
export const ROLE_COMMAND = { About: 'app.about' }
// 一级格出图标不出文字（分类名进 title / aria-label）。图标只是这一侧的呈现，mac 的系统菜单栏仍是文字，
// 所以映射留在菜单条里，不进与 mac 同源的 app-menu.js。
export const GROUP_ICON = {
  file: 'file',
  edit: 'pen',
  format: 'type',
  paragraph: 'pilcrow',
  view: 'monitor',
  git: 'branch',
  window: 'window',
  app: 'info',
}

const SUB_CLOSE_DELAY = 320

export function createMenuBar(opts) {
  const { mount, buildSpec, row, separator, runCommand, roleHandler, keyFor } = opts

  let root = null // 当前展开的下一级（所有子层都挂在它里面）
  let rootBtn = null
  let dismiss = [] // 展开期挂在全局的监听
  const openSubs = new Set() // 插入顺序即层级顺序，最后一个是最深层

  const groupLabel = (g) => (g.id === 'app' ? opts.helpLabel() : g.text)

  function render() {
    mount.innerHTML = ''
    // 分组顺序仍与 mac 同源，只在这里调尾：mac 系统栏把应用菜单放第一格，
    // win/linux 的菜单条惯例是「帮助」收尾（排在「窗口」右边），故把 app 组挪到最后。
    const groups = buildSpec().groups
    const rest = groups.filter((g) => g.id !== 'app')
    const help = groups.filter((g) => g.id === 'app')
    for (const g of [...rest, ...help]) {
      const b = document.createElement('button')
      b.type = 'button'
      b.className = 'nl-menubar-item'
      b.dataset.group = g.id
      const label = groupLabel(g)
      setIcon(b, GROUP_ICON[g.id], '')
      b.title = label
      b.setAttribute('aria-label', label)
      b.setAttribute('aria-haspopup', 'menu')
      b.setAttribute('aria-expanded', 'false')
      b.addEventListener('click', () => {
        if (root && rootBtn === b) closeAll()
        else open(b)
      })
      // 已展开时悬停即切换（原生菜单条行为）；收起状态下悬停不自动弹
      b.addEventListener('mouseenter', () => { if (root && rootBtn !== b) open(b) })
      mount.appendChild(b)
    }
  }

  // 每次展开都重取 spec：勾选态、置灰、最近列表都是当下的
  function open(btn) {
    const g = buildSpec().groups.find((x) => x.id === btn.dataset.group)
    closeAll()
    if (!g || !g.items.length) return
    root = buildMenu(g.items)
    rootBtn = btn
    btn.setAttribute('aria-expanded', 'true')
    const r = btn.getBoundingClientRect()
    place(root, r.left, r.bottom + 2)
    const onDocDown = (e) => {
      if (root.contains(e.target) || (rootBtn && rootBtn.contains(e.target))) return
      for (const s of openSubs) if (s.contains(e.target)) return
      closeAll()
    }
    const onKey = (e) => onRootKey(e)
    const onDismiss = (e) => {
      // 滚轮落在菜单自身（含子层）里是滚动，不是「外面滚了」
      if (e.type === 'wheel' && (root.contains(e.target) || [...openSubs].some((s) => s.contains(e.target)))) return
      closeAll()
    }
    // 顶层出滚动条时子层是 body 级的固定元素，不跟着项走：一滚就收掉，避免悬在半空
    const onScroll = () => { closeAllSubs() }
    root.addEventListener('scroll', onScroll, true)
    document.addEventListener('mousedown', onDocDown, true)
    document.addEventListener('keydown', onKey, true)
    window.addEventListener('wheel', onDismiss, true)
    window.addEventListener('resize', onDismiss)
    dismiss = [
      () => document.removeEventListener('mousedown', onDocDown, true),
      () => document.removeEventListener('keydown', onKey, true),
      () => window.removeEventListener('wheel', onDismiss, true),
      () => window.removeEventListener('resize', onDismiss),
    ]
  }

  function closeAll() {
    for (const fn of dismiss) fn()
    dismiss = []
    closeAllSubs()
    if (root && root.parentNode) root.parentNode.removeChild(root)
    if (rootBtn) rootBtn.setAttribute('aria-expanded', 'false')
    root = null
    rootBtn = null
  }

  // —— 键盘 ——

  function deepestSub() {
    let last = null
    for (const s of openSubs) if (s.parentNode) last = s
    for (const s of openSubs) if (!s.parentNode) openSubs.delete(s)
    return last
  }

  function rowsOf(menu) {
    return [...menu.querySelectorAll(':scope > .cv-menu-item')].filter((b) => !b.disabled)
  }

  function activeMenu() {
    const a = document.activeElement
    return a && a.closest ? a.closest('.nl-menu-pop') : null
  }

  function onRootKey(e) {
    if (!root) return
    if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      const sub = deepestSub()
      if (sub) closeSub(sub)
      else {
        const btn = rootBtn
        closeAll()
        btn && btn.focus()
      }
      return
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      const menu = activeMenu() || root
      const list = rowsOf(menu)
      if (!list.length) return
      e.preventDefault()
      const i = list.indexOf(document.activeElement)
      const step = e.key === 'ArrowDown' ? 1 : -1
      const next = i < 0 ? (step > 0 ? 0 : list.length - 1) : (i + step + list.length) % list.length
      list[next].focus()
      return
    }
    if (e.key === 'ArrowRight') {
      const host = document.activeElement
      if (host && host.__nlSubItems && host.__nlSubItems.length) {
        e.preventDefault()
        openSub(host, host.__nlSubItems)
        const first = rowsOf(host.__nlSubEl)[0]
        first && first.focus()
        return
      }
      stepTop(1, e)
      return
    }
    if (e.key === 'ArrowLeft') {
      const sub = deepestSub()
      if (sub && activeMenu() && activeMenu() !== root) {
        e.preventDefault()
        const host = sub.__nlHost
        closeSub(sub)
        host && host.focus()
        return
      }
      stepTop(-1, e)
    }
  }

  // ← / → 在一级之间移动：菜单已展开时切到相邻分类并展开
  function stepTop(step, e) {
    const btns = [...mount.querySelectorAll('.nl-menubar-item')]
    const i = btns.indexOf(rootBtn)
    if (i < 0 || !root) return
    e.preventDefault()
    const next = btns[(i + step + btns.length) % btns.length]
    open(next)
    next.focus()
  }

  // —— 子层 ——
  // 子菜单是 body 级的固定元素，不挂在父项里：顶层 `.tree-menu` 带 overflow 滚动，
  // 做成子元素会被裁掉，项滚动时子层也会脱离父项。
  function closeAllSubs() {
    for (const s of [...openSubs]) closeSub(s)
    openSubs.clear()
  }

  function closeSub(sub) {
    openSubs.delete(sub)
    if (sub.__nlHost) delete sub.__nlHost.__nlSubEl
    if (sub.parentNode) sub.parentNode.removeChild(sub)
  }

  function openSub(hostEl, items) {
    // 同一层只留一个子菜单；父项换人时它下面的深层子菜单一起收掉
    const menu = hostEl.closest('.nl-menu-pop')
    for (const s of [...openSubs]) {
      const h = s.__nlHost
      if (!h || h === hostEl) continue
      const hm = h.closest('.nl-menu-pop')
      if (hm === menu || menu.contains(hm)) closeSub(s)
    }
    if (hostEl.__nlSubEl && hostEl.__nlSubEl.parentNode) {
      openSubs.add(hostEl.__nlSubEl)
      return
    }
    const sub = buildMenu(items)
    sub.classList.add('nl-menu-sub')
    sub.__nlHost = hostEl
    hostEl.__nlSubEl = sub
    openSubs.add(sub)
    const hr = hostEl.getBoundingClientRect()
    document.body.appendChild(sub)
    let left = hr.right - 6
    if (left + sub.offsetWidth > window.innerWidth - 4) left = hr.left - sub.offsetWidth + 6
    let top = hr.top - 5
    if (top + sub.offsetHeight > window.innerHeight - 4) top = Math.max(4, window.innerHeight - sub.offsetHeight - 4)
    sub.style.left = Math.max(4, left) + 'px'
    sub.style.top = Math.max(4, top) + 'px'
  }

  // —— 渲染 ——

  function buildMenu(items) {
    const el = document.createElement('div')
    el.className = 'cv-menu tree-menu nl-menu-pop'
    el.setAttribute('role', 'menu')
    appendInto(el, items)
    return el
  }

  function withKey(text, key) {
    return key ? text + ' (' + key + ')' : text
  }

  function appendInto(el, items) {
    for (const it of items) {
      if (it.type === 'sep') {
        el.appendChild(separator())
        continue
      }
      if (it.type === 'role') {
        if (DROP_ROLES.has(it.role)) continue
        const known = ROLE_COMMAND[it.role]
        const disabled = it.enabled === false || (roleHandler.enabled ? roleHandler.enabled(it.role) === false : false)
        el.appendChild(row(withKey(it.text, roleHandler.key(it.role)), () => {
          closeAll()
          if (known) runCommand(known)
          else roleHandler.run(it.role)
        }, { disabled }))
        continue
      }
      if (it.items && it.items.length) {
        const host = row(withKey(it.text, ''), () => {
          if (host.__nlSubEl && host.__nlSubEl.parentNode) closeSub(host.__nlSubEl)
          else openSub(host, it.items)
        }, { arrow: true })
        host.__nlSubItems = it.items
        host.setAttribute('aria-haspopup', 'menu')
        host.addEventListener('mouseenter', () => openSub(host, it.items))
        host.addEventListener('mouseleave', () => {
          setTimeout(() => {
            if (host.__nlSubEl && !host.__nlSubEl.contains(document.activeElement)) {
              const under = host.matches(':hover') || (host.__nlSubEl && host.__nlSubEl.matches(':hover'))
              if (!under) closeSub(host.__nlSubEl)
            }
          }, SUB_CLOSE_DELAY)
        })
        el.appendChild(host)
        continue
      }
      el.appendChild(row(withKey(it.text, keyFor(it)), () => {
        closeAll()
        runCommand(it.id)
      }, { checked: it.type === 'check' && !!it.checked, disabled: it.enabled === false }))
    }
  }

  function place(el, x, y) {
    document.body.appendChild(el)
    const w = el.offsetWidth
    const h = el.offsetHeight
    let left = x
    let top = y
    if (left + w > window.innerWidth - 4) left = Math.max(4, window.innerWidth - w - 4)
    if (top + h > window.innerHeight - 4) top = Math.max(4, window.innerHeight - h - 4)
    el.style.left = left + 'px'
    el.style.top = top + 'px'
  }

  render()
  onLocaleChange(render) // 一级文案来自 spec（按当前语言出标题），切语言整条重排
  return { render, closeAll, rootEl: () => root, isOpen: () => !!root }
}
