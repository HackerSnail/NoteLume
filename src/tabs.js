// tabs.js —— 标签页：一个窗格内打开中的文档列表 + 窗格顶部标签条的渲染与交互
//
// 分栏完整模式（P5 §6.1，spec 2026-10-18-pane-tab-groups）：每个窗格各持一个实例
// （createTabs 的 paneId），标签归属窗格——同一文档可在多个窗格各开一份，id 三要素
// paneId + root + rel。
//
// 预览模式（VS Code 习惯）：拖入打开 / 单实例二次唤起开的是预览标签（斜体，可被同窗格
// 下一个预览替换）；文件树单击 / wikilink / 搜索 / 命令面板等显式意图开的是固定标签。
// 每窗格最多一个预览标签，固定标签永不被预览替换。
//
// 一个编辑器实例的硬限制：窗格内切标签前由 main.js 走 ensurePaneSaved 问保存，切走的
// 标签内容不驻留。脏标记按标签 id 记（哪个窗格在改它，哪个标签上的点亮）。
//
// 临时文件（新建未选保存位置）也是普通一页，只多一个 scratch 标记：关闭时要先问是否选位置。

import { t } from './i18n.js'

const sep = '\u0000'
const idOf = (paneId, root, rel) => String(paneId ?? '') + sep + String(root || '') + sep + String(rel || '')
const baseName = (rel) => String(rel || '').slice(Math.max(String(rel || '').lastIndexOf('/'), String(rel || '').lastIndexOf('\\')) + 1)

export function createTabs({ paneId, mountEl, onSwitch, onClose }) {
  const items = [] // [{ id, root, rel, canvas, scratch, preview }]
  let activeId = null
  const dirtyIds = new Set() // 脏标记按标签记（各窗格独立，不再是「只有活动页可能脏」）

  function render() {
    if (!mountEl) return
    mountEl.textContent = ''
    // 显隐切在最外层 .tabbar / .nl-pane-strip 上：挂载点可能是它内部的滚动区，
    // 只切挂载点的话外层容器的 hidden 没人摘，整条标签页不显示
    const bar = mountEl.closest ? mountEl.closest('.tabbar, .nl-pane-strip') : null
    ;(bar || mountEl).classList.toggle('hidden', items.length === 0)
    for (const tab of items) {
      const el = document.createElement('div')
      el.className =
        'tab' +
        (tab.id === activeId ? ' active' : '') +
        (dirtyIds.has(tab.id) ? ' dirty' : '') +
        (tab.scratch ? ' scratch' : '') +
        (tab.preview ? ' preview' : '')
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
      el.addEventListener('click', () => {
        if (tab.id !== activeId) onSwitch && onSwitch(tab.id)
      })
      // 双击预览标签 = 固定（VS Code 习惯）；双击固定标签无动作
      el.addEventListener('dblclick', () => {
        if (tab.preview) pin(tab.id)
      })
      // 中键点击 = 关闭（浏览器标签页习惯）
      el.addEventListener('mousedown', (e) => {
        if (e.button === 1) {
          e.preventDefault()
          onClose && onClose(tab.id)
        }
      })
      mountEl.appendChild(el)
    }
  }

  // 形参名用 tab 不用 t：避开与 i18n 的 t 撞名
  function joinTitle(tab) {
    const suffix = tab.scratch ? t('tab.scratchSuffix') : ''
    if (!tab.root) return tab.rel + suffix
    const s = /[\\/]$/.test(tab.root) ? '' : '/'
    return tab.root + s + tab.rel + suffix
  }

  /** 同窗格内按 root+rel 找已有标签（跨窗格同文档是两份，各找各的） */
  function findDoc(root, rel) {
    return items.find((x) => x.root === root && x.rel === rel) || null
  }

  /**
   * 固定入口（命令面板 / wikilink / 搜索 / 双击 / 最近 / 模板 / 新建）：同路径已开
   * 则只激活，否则入列固定标签。返回 { id, existed }。
   */
  function open(tab) {
    const exist = findDoc(tab.root, tab.rel)
    if (exist) {
      exist.canvas = !!tab.canvas
      exist.scratch = !!tab.scratch
      activeId = exist.id
      render()
      return { id: exist.id, existed: true }
    }
    const id = idOf(paneId, tab.root, tab.rel)
    items.push({ id, root: tab.root, rel: tab.rel, canvas: !!tab.canvas, scratch: !!tab.scratch, preview: false })
    activeId = id
    render()
    return { id, existed: false }
  }

  /**
   * 预览入口（拖入 / 单实例二次唤起）：同路径已开则只激活（保留它原有的预览 / 固定身份）；
   * 否则先替换掉本窗格已有的预览标签（调用方已就旧预览做过脏检查），再入列预览标签。
   * 返回 { id, existed, replaced }，replaced 为被换掉的旧预览 id（无则 null）。
   */
  function openPreview(tab) {
    const exist = findDoc(tab.root, tab.rel)
    if (exist) {
      exist.canvas = !!tab.canvas
      exist.scratch = !!tab.scratch
      activeId = exist.id
      render()
      return { id: exist.id, existed: true, replaced: null }
    }
    const replaced = previewId()
    if (replaced) remove(replaced)
    const id = idOf(paneId, tab.root, tab.rel)
    items.push({ id, root: tab.root, rel: tab.rel, canvas: !!tab.canvas, scratch: !!tab.scratch, preview: true })
    activeId = id
    render()
    return { id, existed: false, replaced }
  }

  /** 摘掉一个标签（预览替换 / × / 中键共用）。返回被摘掉的项 */
  function remove(id) {
    const i = items.findIndex((t) => t.id === id)
    if (i < 0) return null
    const [gone] = items.splice(i, 1)
    if (activeId === id) activeId = null
    dirtyIds.delete(id)
    render()
    return gone
  }

  /**
   * 标签条内重排（拖拽排序）：把 id 摘出来插到 index 处。
   * index 越界夹到队尾；id 不存在返回 false。
   */
  function moveTo(id, index) {
    const i = items.findIndex((x) => x.id === id)
    if (i < 0) return false
    const [it] = items.splice(i, 1)
    const at = Math.min(Math.max(0, Number.isInteger(index) ? index : 0), Math.max(0, items.length))
    items.splice(at, 0, it)
    render()
    return true
  }

  /** 双击固定：清预览标记。已是固定标签则无事发生 */
  function pin(id) {
    const it = items.find((x) => x.id === id)
    if (!it || !it.preview) return false
    it.preview = false
    render()
    return true
  }

  /** 本窗格当前预览标签的 id（每窗格最多一个），没有则 null */
  function previewId() {
    const it = items.find((x) => x.preview)
    return it ? it.id : null
  }

  render() // 建好就画一次：无标签时挂上 hidden

  return {
    list: () => items.slice(),
    get: (id) => items.find((t) => t.id === id) || null,
    active: () => (activeId ? items.find((t) => t.id === activeId) || null : null),
    /** 打开或激活一页（固定入口） */
    open,
    /** 打开或激活一页（预览入口，可能替换旧预览） */
    openPreview,
    /** 双击固定预览标签 */
    pin,
    previewId,
    activate(id) {
      if (items.some((t) => t.id === id)) activeId = id
      render()
    },
    /** 改一页的定位（重命名 / 另存为后 root 或 rel 变了）。返回新 id——调用方按新 id 续接 */
    update(id, patch) {
      const t = items.find((x) => x.id === id)
      if (!t) return null
      Object.assign(t, patch)
      const newId = idOf(paneId, t.root, t.rel)
      t.id = newId
      if (activeId === id) activeId = newId
      if (dirtyIds.delete(id) && newId !== id) dirtyIds.add(newId)
      render()
      return newId
    },
    remove,
    /** 标签条内重排（拖拽落定）；序列化顺序即落盘顺序 */
    moveTo,
    /** 清空全部标签：换知识库 / 换单文件根时，旧根的打开记录整体作废 */
    clear() {
      items.length = 0
      activeId = null
      dirtyIds.clear()
      render()
    },
    /** 关闭一页后该激活谁：先右后左；在 remove 之前调用，没有则 null（调用方走空态） */
    neighborOf(id) {
      const i = items.findIndex((t) => t.id === id)
      if (i < 0 || items.length === 0) return null
      if (i + 1 < items.length) return items[i + 1]
      return items[i - 1] || null
    },
    /** 指定标签的脏标记（每个标签各自记） */
    setDirty(id, d) {
      if (d) dirtyIds.add(id)
      else dirtyIds.delete(id)
      render()
    },
    isDirty(id) {
      return dirtyIds.has(id)
    },
    /** 持久化（settings.json panes.tabs）：预览与脏标记都不落盘 */
    serialize() {
      return {
        items: items.map((x) => ({ root: x.root, rel: x.rel, canvas: x.canvas, scratch: x.scratch })),
        active: activeId ? items.findIndex((x) => x.id === activeId) : -1,
      }
    },
    /** 从持久化恢复：一律按固定标签入列（预览是临时的），active 夹到合法范围 */
    restore(data) {
      items.length = 0
      dirtyIds.clear()
      activeId = null
      const list = data && Array.isArray(data.items) ? data.items : []
      for (const raw of list) {
        if (!raw || typeof raw.root !== 'string' || typeof raw.rel !== 'string') continue
        const id = idOf(paneId, raw.root, raw.rel)
        if (items.some((x) => x.id === id)) continue
        items.push({ id, root: raw.root, rel: raw.rel, canvas: !!raw.canvas, scratch: !!raw.scratch, preview: false })
      }
      let idx = data && Number.isInteger(data.active) ? data.active : -1
      if (idx < 0 || idx >= items.length) idx = items.length ? 0 : -1
      activeId = idx >= 0 ? items[idx].id : null
      render()
    },
    render,
  }
}
