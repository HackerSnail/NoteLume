// command-palette.js —— 批次 D：命令面板（Ctrl+P）
//
// 复用 .nl-prompt/.nl-suggest 观感（自建模态，不引 UI 框架）。两种模式（Obsidian 式）：
//   裸词 = 搜文档（对 {name, rel} 客户端 fuzzy，回车/点击 openFile(rel)）；
//   以 '>' 开头 = 搜命令（对注册表标题 fuzzy，回车/点击 runCommand(id)）。
// 面板本身是一条 app 命令（在 main.js 注册），其绑定仍走全局分发器；本模块只负责 UI 与选择。
import { fuzzyMatch } from './keymap.js'
import { setIcon } from './icons.js'
import { t } from './i18n.js'

/**
 * @param {object} deps
 * @param {() => Array} deps.getCommands   返回注册表全部命令（含 category/defaultKey/id/title）
 * @param {() => Array<{name:string, rel:string}>} deps.getDocs  可跳转文档
 * @param {(id:string) => void} deps.runCommand  执行一条命令
 * @param {(rel:string) => void} deps.openFile   打开文档
 * @param {(id:string) => string} deps.bindingFor 命令当前有效键的可读形式（右侧提示）
 * @returns {{ open: () => void, close: () => void }}
 */
export function createPalette(deps) {
  const { getCommands, getDocs, runCommand, openFile, bindingFor } = deps
  let overlay = null
  let input = null
  let listEl = null
  let items = [] // {score, kind:'cmd'|'doc', label, hint, payload}
  let active = 0

  function buildDom() {
    overlay = document.createElement('div')
    overlay.className = 'nl-palette-overlay'

    const box = document.createElement('div')
    box.className = 'nl-palette'

    input = document.createElement('input')
    input.type = 'text'
    input.className = 'nl-palette-input'
    input.spellcheck = false
    input.placeholder = t('palette.placeholder')

    listEl = document.createElement('div')
    listEl.className = 'nl-palette-list'

    box.append(input, listEl)
    overlay.appendChild(box)
    overlay.addEventListener('pointerdown', (e) => {
      if (e.target === overlay) close()
    })
    input.addEventListener('input', refresh)
    input.addEventListener('keydown', onNav)
  }

  function computeItems() {
    const raw = input.value || ''
    const cmdMode = raw.startsWith('>')
    const q = (cmdMode ? raw.slice(1) : raw).trim()
    const scored = []
    if (cmdMode) {
      for (const c of getCommands()) {
        const m = fuzzyMatch(q, c.title)
        if (!m) continue
        scored.push({ score: m.score, kind: 'cmd', label: c.title, hint: bindingFor ? bindingFor(c.id) : '', payload: c.id })
      }
    } else {
      for (const d of getDocs()) {
        const m = fuzzyMatch(q, d.name)
        if (!m) continue
        scored.push({ score: m.score, kind: 'doc', label: d.name, hint: d.rel !== d.name ? d.rel : '', payload: d.rel })
      }
    }
    scored.sort((a, b) => b.score - a.score)
    return scored.slice(0, 80)
  }

  function render() {
    listEl.innerHTML = ''
    if (!items.length) {
      const empty = document.createElement('div')
      empty.className = 'nl-palette-empty'
      empty.textContent = (input.value || '').trim() ? t('palette.noMatch') : t('palette.emptyQuery')
      listEl.appendChild(empty)
      return
    }
    items.forEach((it, i) => {
      const row = document.createElement('div')
      row.className = 'nl-palette-item' + (i === active ? ' active' : '')
      const kind = document.createElement('span')
      kind.className = 'nl-palette-kind'
      setIcon(kind, it.kind === 'cmd' ? 'terminal' : 'file')
      const label = document.createElement('span')
      label.className = 'nl-palette-label'
      label.textContent = it.label
      row.append(kind, label)
      if (it.hint) {
        const hint = document.createElement('span')
        hint.className = 'nl-palette-hint'
        hint.textContent = it.hint
        row.appendChild(hint)
      }
      row.addEventListener('mouseenter', () => {
        active = i
        updateActive()
      })
      row.addEventListener('click', () => execute(i))
      listEl.appendChild(row)
    })
  }

  function updateActive() {
    const kids = listEl.children
    for (let i = 0; i < kids.length; i++) kids[i].classList.toggle('active', i === active)
    const cur = kids[active]
    if (cur && cur.scrollIntoView) cur.scrollIntoView({ block: 'nearest' })
  }

  function refresh() {
    items = computeItems()
    active = 0
    render()
  }

  function execute(i) {
    const it = items[i]
    if (!it) return
    close()
    if (it.kind === 'doc') openFile(it.payload)
    else runCommand(it.payload)
  }

  function onNav(e) {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      if (items.length) {
        active = (active + 1) % items.length
        updateActive()
      }
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      if (items.length) {
        active = (active - 1 + items.length) % items.length
        updateActive()
      }
    } else if (e.key === 'Enter') {
      e.preventDefault()
      execute(active)
    } else if (e.key === 'Escape') {
      e.preventDefault()
      e.stopPropagation()
      close()
    }
  }

  function open() {
    if (!overlay) buildDom()
    if (overlay.parentNode) return // 已打开
    document.body.appendChild(overlay)
    input.value = ''
    refresh()
    setTimeout(() => input.focus(), 0)
  }

  function close() {
    if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay)
  }

  return { open, close }
}
