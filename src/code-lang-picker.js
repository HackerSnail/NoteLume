// code-lang-picker.js —— 代码块右上角语言标签：点击弹出可搜索语言列表（Typora 式）
//
// 机制：
//  · 语言只写入 code_block.attrs.params（即围栏 info string ```lang），永不进入正文；
//  · 语法高亮（hl-decorations）与 mermaid 预览都按 params 驱动，改完 setNodeMarkup 触发 docChanged 自动重渲染；
//  · 候选语言取自 highlight.js 已注册语言（保证选中即有高亮），常用语言置顶；
//  · 纯 DOM 浮层，复用 .nl-suggest 的观感与交互（↑/↓/Enter/Esc + 输入过滤），零新依赖。

import hljs from 'highlight.js/lib/common'

// 常用语言置顶（仅保留 hljs 实际注册的那些，其余按字母序补在后面）
const PREFERRED = [
  'javascript', 'typescript', 'python', 'java', 'go', 'rust', 'c', 'cpp', 'csharp',
  'sql', 'json', 'yaml', 'xml', 'html', 'css', 'bash', 'shell', 'powershell',
  'markdown', 'dockerfile', 'kotlin', 'swift', 'php', 'ruby', 'scala', 'diff', 'ini',
]

export function attachCodeLangPicker(view) {
  let menu = null // { el, input, list, items, index, nodePos }

  function onDocDown(e) {
    if (menu && !menu.el.contains(e.target) && !(e.target.closest && e.target.closest('.nl-code-lang'))) {
      close()
    }
  }

  function close() {
    if (menu && menu.el && menu.el.parentNode) menu.el.parentNode.removeChild(menu.el)
    menu = null
    document.removeEventListener('mousedown', onDocDown, true)
  }

  // 由标签所在 pre 反查 code_block 在文档中的位置（posAtDOM 可能落在节点起始或内容起始，两路都兜）
  function findCodeBlockPos(preEl) {
    const pos = view.posAtDOM(preEl, 0)
    const $p = view.state.doc.resolve(pos)
    for (let d = $p.depth; d > 0; d--) {
      if ($p.node(d).type.name === 'code_block') return $p.before(d)
    }
    if ($p.nodeAfter && $p.nodeAfter.type.name === 'code_block') return pos
    return null
  }

  function setLang(nodePos, lang) {
    const node = view.state.doc.nodeAt(nodePos)
    if (!node || node.type.name !== 'code_block') return
    if ((node.attrs.params || '') === lang) return
    view.dispatch(view.state.tr.setNodeMarkup(nodePos, undefined, { ...node.attrs, params: lang }))
  }

  function buildItems(filter) {
    const q = (filter || '').toLowerCase().trim()
    const reg = hljs.listLanguages()
    const regSet = new Set(reg)
    const head = PREFERRED.filter((l) => regSet.has(l))
    const rest = reg.filter((l) => !head.includes(l)).sort()
    const opts = [{ label: '纯文本（无）', value: '' }]
    for (const l of [...head, ...rest]) {
      if (!q || l.includes(q)) opts.push({ label: l, value: l })
    }
    return opts.slice(0, 300)
  }

  function renderList() {
    if (!menu) return
    const { list, items } = menu
    list.innerHTML = ''
    items.forEach((it, i) => {
      const row = document.createElement('div')
      row.className = 'nl-codelang-item' + (i === menu.index ? ' active' : '')
      row.textContent = it.label
      row.addEventListener('mousedown', (e) => e.preventDefault()) // 不夺筛选框焦点
      row.addEventListener('click', () => choose(it.value))
      list.appendChild(row)
    })
  }

  function choose(value) {
    if (!menu) return
    setLang(menu.nodePos, value)
    close()
    view.focus()
  }

  function move(delta) {
    const n = menu.items.length
    if (!n) return
    menu.index = (menu.index + delta + n) % n
    const kids = menu.el.querySelectorAll('.nl-codelang-item')
    kids.forEach((k, i) => k.classList.toggle('active', i === menu.index))
    if (kids[menu.index]) kids[menu.index].scrollIntoView({ block: 'nearest' })
  }

  function open(anchorEl, nodePos) {
    close()
    const el = document.createElement('div')
    el.className = 'nl-codelang-menu'
    const input = document.createElement('input')
    input.className = 'nl-codelang-filter'
    input.type = 'text'
    input.placeholder = '搜索语言…'
    const list = document.createElement('div')
    list.className = 'nl-codelang-list'
    el.appendChild(input)
    el.appendChild(list)
    document.body.appendChild(el)

    menu = { el, input, list, nodePos, items: buildItems(''), index: 0 }
    // 若已有语言且能在列表中命中，初始高亮定位到它
    const cur = anchorEl.getAttribute('data-lang') || ''
    const idx = menu.items.findIndex((it) => it.value === cur)
    if (idx >= 0) menu.index = idx
    renderList()

    // 定位到标签下方（右对齐），越界翻转
    const r = anchorEl.getBoundingClientRect()
    el.style.left = '0px'
    el.style.top = '0px'
    requestAnimationFrame(() => {
      if (!menu) return
      const rect = el.getBoundingClientRect()
      let left = r.right - rect.width
      if (left < 4) left = 4
      if (left + rect.width > window.innerWidth - 4) left = Math.max(4, window.innerWidth - rect.width - 4)
      let top = r.bottom + 4
      if (top + rect.height > window.innerHeight - 4) top = Math.max(4, r.top - rect.height - 4)
      el.style.left = left + 'px'
      el.style.top = top + 'px'
      if (menu.index > 0) {
        const kids = el.querySelectorAll('.nl-codelang-item')
        if (kids[menu.index]) kids[menu.index].scrollIntoView({ block: 'nearest' })
      }
    })

    input.addEventListener('input', () => {
      menu.items = buildItems(input.value)
      menu.index = 0
      renderList()
    })
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') { e.preventDefault(); move(1) }
      else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1) }
      else if (e.key === 'Enter') {
        e.preventDefault()
        const it = menu.items[menu.index]
        if (it) choose(it.value)
      } else if (e.key === 'Escape') { e.preventDefault(); close(); view.focus() }
    })
    input.focus()
    document.addEventListener('mousedown', onDocDown, true)
  }

  // 点标签：阻止 mousedown 把光标移进代码，click 时弹选择器
  view.dom.addEventListener('mousedown', (e) => {
    if (e.target.closest && e.target.closest('.nl-code-lang')) e.preventDefault()
  })
  view.dom.addEventListener('click', (e) => {
    const span = e.target.closest && e.target.closest('.nl-code-lang')
    if (!span) return
    e.preventDefault()
    const pre = span.closest('pre')
    const nodePos = pre ? findCodeBlockPos(pre) : null
    if (nodePos == null) return
    open(span, nodePos)
  })

  return { destroy: close }
}
