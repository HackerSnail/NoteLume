// tabs.js —— 标签页：打开中的文档列表 + 工具条下方标签条的渲染与交互
//
// 设计约束：编辑器始终只有一个实例、一个活动文档（main.js 的 state.currentFile）。
// 标签页只记录「打开中的文档」，切页 / 关页都走既有的打开文档链路（脏检查、重载树与索引）。
// 由此推出一条不变式：非活动页一定是干净的——离开它时 ensureSavedBeforeLeave 已强制
// 保存或放弃改动，所以关非活动页不需要再问。
//
// 临时文件（新建未选保存位置）也是普通一页，只多一个 scratch 标记：关闭时要先问是否选位置。

import { t } from './i18n.js'

const idOf = (root, rel) => String(root || '') + '\u0000' + String(rel || '')
const baseName = (rel) => String(rel || '').slice(Math.max(String(rel || '').lastIndexOf('/'), String(rel || '').lastIndexOf('\\')) + 1)

export function createTabs({ mountEl, onSwitch, onClose }) {
  const items = [] // [{ id, root, rel, canvas, scratch }]
  let activeId = null
  let dirty = false

  function render() {
    if (!mountEl) return
    mountEl.textContent = ''
    mountEl.classList.toggle('hidden', items.length === 0)
    for (const tab of items) {
      const el = document.createElement('div')
      el.className = 'tab' + (tab.id === activeId ? ' active' : '') + (tab.id === activeId && dirty ? ' dirty' : '') + (tab.scratch ? ' scratch' : '')
      el.dataset.id = tab.id
      el.title = joinTitle(tab)
      const name = document.createElement('span')
      name.className = 'tab-name'
      name.textContent = baseName(tab.rel)
      const dot = document.createElement('span')
      dot.className = 'tab-dot'
      dot.setAttribute('aria-hidden', 'true')
      const x = document.createElement('button')
      x.type = 'button'
      x.className = 'tab-x'
      x.title = t('common.close')
      x.setAttribute('aria-label', t('common.close'))
      x.textContent = '×'
      x.addEventListener('click', (e) => {
        e.stopPropagation()
        onClose && onClose(tab.id)
      })
      el.appendChild(name)
      el.appendChild(dot)
      el.appendChild(x)
      el.addEventListener('click', () => { if (tab.id !== activeId) onSwitch && onSwitch(tab.id) })
      // 中键点击 = 关闭（浏览器标签页习惯）
      el.addEventListener('mousedown', (e) => { if (e.button === 1) { e.preventDefault(); onClose && onClose(tab.id) } })
      mountEl.appendChild(el)
    }
  }

  // 形参名用 tab 不用 t：避开与 i18n 的 t 撞名
  function joinTitle(tab) {
    const suffix = tab.scratch ? t('tab.scratchSuffix') : ''
    if (!tab.root) return tab.rel + suffix
    const sep = /[\\/]$/.test(tab.root) ? '' : '/'
    return tab.root + sep + tab.rel + suffix
  }

  render() // 建好就画一次：无标签时挂上 hidden

  return {
    list: () => items.slice(),
    get: (id) => items.find((t) => t.id === id) || null,
    active: () => (activeId ? items.find((t) => t.id === activeId) || null : null),
    /** 打开或激活一页：同 root+rel 只保留一个标签 */
    open(tab) {
      const id = idOf(tab.root, tab.rel)
      const exist = items.find((t) => t.id === id)
      if (exist) {
        exist.canvas = !!tab.canvas
        exist.scratch = !!tab.scratch
      } else {
        items.push({ id, root: tab.root, rel: tab.rel, canvas: !!tab.canvas, scratch: !!tab.scratch })
      }
      activeId = id
      render()
      return id
    },
    activate(id) {
      if (items.some((t) => t.id === id)) activeId = id
      render()
    },
    /** 改一页的定位（重命名 / 另存为后 root 或 rel 变了） */
    update(id, patch) {
      const t = items.find((x) => x.id === id)
      if (!t) return
      Object.assign(t, patch)
      t.id = idOf(t.root, t.rel)
      if (activeId === id) activeId = t.id
      render()
    },
    remove(id) {
      const i = items.findIndex((t) => t.id === id)
      if (i < 0) return null
      const [gone] = items.splice(i, 1)
      if (activeId === id) activeId = null
      render()
      return gone
    },
    /** 清空全部标签：换知识库 / 换单文件根时，旧根的打开记录整体作废 */
    clear() {
      items.length = 0
      activeId = null
      dirty = false
      render()
    },
    /** 关闭一页后该激活谁：先右后左；在 remove 之前调用，没有则 null（调用方走无文档态） */
    neighborOf(id) {
      const i = items.findIndex((t) => t.id === id)
      if (i < 0 || items.length === 0) return null
      if (i + 1 < items.length) return items[i + 1]
      return items[i - 1] || null
    },
    /** 活动页的脏标记（只有活动页可能脏，见文件头不变式） */
    setDirty(d) {
      dirty = !!d
      render()
    },
    render,
  }
}
