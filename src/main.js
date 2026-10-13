// main.js —— 应用装配：布局、知识库文件树、大纲、标签、主题、快捷键、打开/保存/跳转
// P1 追加：Rust 索引触发与轮询、双向链接面板、全局搜索、悬浮预览（在 editor-view 里挂）、
// 自动保存 + 库内备份、HTML 导出、打印。
import { createEditor } from './editor-view.js'
import {
  pickFolder,
  pickFile,
  pickSaveAs,
  scanVault,
  readMdFile,
  writeMdFile,
  resolveWikiLink,
  createMdFile,
  deleteFile,
  confirmDialog,
  messageDialog,
  rebuildIndex,
  getIndexStatus,
  queryBacklinks,
  queryOutgoing,
  searchVault,
  updateIndexDoc,
  backupWrite,
  exportFile,
} from './tauri-bridge.js'
import { openGraph } from './graph-view.js'
import { createSnapshotPanel } from './snapshot-panel.js'
import { createPluginManager } from './plugin-loader.js'
import { createCanvasView } from './canvas-view.js'
import MarkdownIt from 'markdown-it'

// 用于 HTML 导出的独立 markdown-it 实例：commonmark + table/strikethrough
// 与 editor-schema 里的 tokenizer 分开，避免污染 schema 层的解析器
const exportMd = MarkdownIt('commonmark', { html: false }).enable(['table', 'strikethrough'])

const state = {
  vaultRoot: null, // 知识库根（绝对路径）
  currentFile: null, // 当前文档库内相对路径
  mode: 'md', // 'md' 编辑器 | 'canvas' 画布
  dirty: false,
  indexReady: false,
  autosave: {
    enabled: localStorage.getItem('nl-autosave') === '1',
    idleTimer: null,
    backupTimer: null,
    lastBackupAt: 0,
  },
}

// 自动保存策略：停手 2s 触发写盘；每 120s 触发一次带时间戳的备份
const AUTOSAVE_IDLE_MS = 2000
const BACKUP_INTERVAL_MS = 120000

const $ = (id) => document.getElementById(id)
const els = {
  tree: $('filetree'),
  outline: $('outline'),
  tags: $('tags'),
  editor: $('editor'),
  filename: $('filename'),
  status: $('status'),
  btnOpen: $('btn-open'),
  btnOpenFile: $('btn-open-file'),
  btnSave: $('btn-save'),
  btnTheme: $('btn-theme'),
  btnExportHtml: $('btn-export-html'),
  btnPrint: $('btn-print'),
  btnGraph: $('btn-graph'),
  chkAutosave: $('chk-autosave'),
  searchInput: $('search-input'),
  searchResults: $('search-results'),
  backlinks: $('backlinks'),
  outgoing: $('outgoing'),
  snapshots: $('snapshots'),
  snapshotModal: $('snapshot-modal'),
  snapshotPreview: $('snapshot-preview'),
  snapshotLabel: $('snapshot-label'),
  snapshotMeta: $('snapshot-meta'),
  snapshotRollback: $('snapshot-rollback'),
  snapshotClose: $('snapshot-close'),
  plugins: $('plugins'),
  canvasMount: $('canvas-mount'),
  btnNewCanvas: $('btn-new-canvas'),
}

let editor
let snapshotPanel = null
let pluginManager = null
let canvasView = null

// 画布文件判定（JSON Canvas 规范）
function isCanvasPath(p) {
  return /\.canvas$/i.test(p || '')
}

function setStatus(msg) {
  els.status.textContent = msg
}

// 脏标记统一入口：编辑器与画布共用（驱动 dirty 样式 + 自动保存）
function markDirty(d) {
  state.dirty = d
  els.filename.classList.toggle('dirty', d)
  if (d) scheduleAutosave()
}

// —— 主题 ——（浅色 → 暗黑 → Dracula 三态循环；按钮显示当前主题名，与界面实际一致）
const THEMES = ['light', 'dark', 'vampire']
const THEME_LABEL = { light: '☀️ 浅色', dark: '🌙 暗黑', vampire: '🧛 Dracula' }
function applyTheme(theme) {
  if (!THEMES.includes(theme)) theme = 'light'
  document.documentElement.setAttribute('data-theme', theme)
  // 深色族（暗黑 / 吸血鬼）共享一套派生样式，用 data-dark 统一命中
  document.documentElement.toggleAttribute('data-dark', theme === 'dark' || theme === 'vampire')
  localStorage.setItem('nl-theme', theme)
  els.btnTheme.textContent = THEME_LABEL[theme]
}
function toggleTheme() {
  const cur = document.documentElement.getAttribute('data-theme') || 'light'
  const next = THEMES[(THEMES.indexOf(cur) + 1) % THEMES.length]
  applyTheme(next)
}

// —— 打开文件夹作为知识库 ——
async function openFolder() {
  try {
    const root = await pickFolder()
    if (!root) return
    state.vaultRoot = root
    const tree = await scanVault(root)
    renderTree(tree)
    setStatus('知识库已加载：' + root + '（索引构建中…）')
    startIndexPolling()
    if (pluginManager) pluginManager.reload()
  } catch (e) {
    const msg = (e && e.message) || e
    setStatus('打开失败：' + msg)
    await messageDialog('打开知识库失败：' + msg)
  }
}

// 规范化库路径用于比较：去掉 Windows canonicalize 的 \\?\ verbatim 前缀、统一分隔符、
// 去尾部分隔符、忽略大小写（Rust 存的是 canonical 路径，前端持有的是对话框原始路径）
function normVaultPath(p) {
  let s = String(p || '').split('\\').join('/') // 反斜杠统一成正斜杠
  if (s.slice(0, 4) === '//?/') s = s.slice(4) // 去掉 Windows canonicalize 前缀（\\?\ → //?/）
  s = s.replace(/\/+$/, '') // 去尾部分隔符
  return s.toLowerCase() // Windows 路径大小写不敏感
}

// —— 触发后台重建，前端 500ms 轮询 status.ready，就绪后刷新当前文档的双链面板 ——
function startIndexPolling() {
  state.indexReady = false
  rebuildIndex(state.vaultRoot).catch((e) => console.warn('rebuild_index 失败', e))
  const started = Date.now()
  const tick = async () => {
    try {
      const st = await getIndexStatus()
      if (st.ready && normVaultPath(st.vaultRoot) === normVaultPath(state.vaultRoot)) {
        state.indexReady = true
        setStatus('索引就绪：' + st.docs + ' 篇文档')
        refreshLinkPanels()
        return
      }
    } catch (_) {
      /* ignore transient */
    }
    if (Date.now() - started < 60_000) setTimeout(tick, 500)
    else setStatus('索引构建超时，稍后可重新打开知识库重试')
  }
  setTimeout(tick, 400)
}

// —— 打开单个文件（把文件所在目录作为工作根，保存/图片/wikilink 都依赖一个根）——
function splitAbs(p) {
  const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'))
  return i < 0 ? { dir: '', name: p } : { dir: p.slice(0, i), name: p.slice(i + 1) }
}

async function openSingleFile() {
  try {
    if (state.dirty) {
      const ok = await confirmDialog('当前文档尚未保存，是否放弃更改？', '打开文件')
      if (!ok) return
    }
    const abs = await pickFile()
    if (!abs) return
    const { dir, name } = splitAbs(abs)
    state.vaultRoot = dir
    if (isCanvasPath(name)) {
      renderSingleFileTree(name)
      await openCanvas(name)
      startIndexPolling()
      return
    }
    const md = await readMdFile(dir, name)
    state.currentFile = name
    setMode('md')
    editor.setMarkdown(md)
    els.filename.textContent = abs
    renderSingleFileTree(name)
    setStatus('已打开文件：' + abs)
    editor.focus()
    // 单文件也后台索引：库根就是同目录，反查更方便
    startIndexPolling()
    if (snapshotPanel) snapshotPanel.refresh()
    if (pluginManager) pluginManager.reload()
  } catch (e) {
    const msg = (e && e.message) || e
    setStatus('打开文件失败：' + msg)
    await messageDialog('打开文件失败：' + msg)
  }
}

// 单文件模式：侧栏只列当前这一个文件（不铺开整个目录）
function renderSingleFileTree(name) {
  const li = document.createElement('li')
  li.className = 'tree-file active'
  li.textContent = name
  li.dataset.path = name
  li.title = name
  li.addEventListener('click', () => openFile(name))
  const ul = document.createElement('ul')
  ul.className = 'tree-root'
  ul.appendChild(li)
  els.tree.innerHTML = ''
  els.tree.appendChild(ul)
}

// —— 渲染文件树（folder 用 <details> 折叠，file 用可点击项）——
function renderTree(nodes) {
  const ul = document.createElement('ul')
  ul.className = 'tree-root'
  nodes.forEach((n) => ul.appendChild(renderNode(n)))
  els.tree.innerHTML = ''
  els.tree.appendChild(ul)
}

function renderNode(node) {
  if (node.type === 'folder') {
    const details = document.createElement('details')
    details.open = true
    const summary = document.createElement('summary')
    summary.textContent = node.name
    details.appendChild(summary)
    const ul = document.createElement('ul')
    ;(node.children || []).forEach((c) => ul.appendChild(renderNode(c)))
    details.appendChild(ul)
    return details
  }
  const li = document.createElement('li')
  li.className = 'tree-file'
  li.textContent = node.name
  li.dataset.path = node.path
  li.title = node.path
  li.addEventListener('click', () => openFile(node.path))
  li.addEventListener('contextmenu', (e) => {
    e.preventDefault()
    e.stopPropagation()
    showTreeMenu(e.clientX, e.clientY, node.path, node.name)
  })
  return li
}

// —— 文件树右键菜单（复用画布 .cv-menu 样式）——
let treeMenuEl = null
function closeTreeMenu() {
  if (treeMenuEl && treeMenuEl.parentNode) treeMenuEl.parentNode.removeChild(treeMenuEl)
  treeMenuEl = null
}
function showTreeMenu(clientX, clientY, rel, name) {
  closeTreeMenu()
  const menu = document.createElement('div')
  menu.className = 'cv-menu tree-menu'
  const mkItem = (label, fn, danger) => {
    const b = document.createElement('button')
    b.className = 'cv-menu-item' + (danger ? ' danger' : '')
    const chk = document.createElement('span')
    chk.className = 'cv-menu-check'
    b.appendChild(chk)
    const lab = document.createElement('span')
    lab.className = 'cv-menu-label'
    lab.textContent = label
    b.appendChild(lab)
    b.addEventListener('click', () => {
      closeTreeMenu()
      fn()
    })
    return b
  }
  menu.appendChild(mkItem('打开', () => openFile(rel)))
  const sep = document.createElement('div')
  sep.className = 'cv-menu-sep'
  menu.appendChild(sep)
  menu.appendChild(mkItem('删除', () => deleteVaultFile(rel, name), true))
  document.body.appendChild(menu)
  const mw = menu.offsetWidth
  const mh = menu.offsetHeight
  let x = clientX
  let y = clientY
  if (x + mw > window.innerWidth - 4) x = Math.max(4, window.innerWidth - mw - 4)
  if (y + mh > window.innerHeight - 4) y = Math.max(4, window.innerHeight - mh - 4)
  menu.style.left = x + 'px'
  menu.style.top = y + 'px'
  treeMenuEl = menu
}

async function deleteVaultFile(rel, name) {
  if (!state.vaultRoot) return
  const ok = await confirmDialog(`确定把「${name}」移入系统回收站？（可从回收站恢复）`, '移入回收站')
  if (!ok) return
  try {
    await deleteFile(state.vaultRoot, rel)
    if (state.currentFile === rel) {
      // 删的是当前打开文档：清空编辑区，回到无文档态
      state.dirty = false
      state.currentFile = null
      setMode('md')
      editor.setMarkdown('')
      els.filename.textContent = '（无打开文档）'
      els.filename.classList.remove('dirty')
      refreshLinkPanels()
      if (snapshotPanel) snapshotPanel.refresh()
    }
    renderTree(await scanVault(state.vaultRoot))
    setStatus('已移入回收站：' + rel)
  } catch (e) {
    await messageDialog('删除失败：' + ((e && e.message) || e))
  }
}

function highlightActiveFile() {
  els.tree.querySelectorAll('.tree-file.active').forEach((el) => el.classList.remove('active'))
  if (state.currentFile) {
    const el = els.tree.querySelector(`.tree-file[data-path="${cssEscape(state.currentFile)}"]`)
    if (el) el.classList.add('active')
  }
}

function cssEscape(s) {
  return (window.CSS && CSS.escape && CSS.escape(s)) || s.replace(/["\\]/g, '\\$&')
}

// —— 打开/切换文档 ——
async function openFile(rel) {
  if (!state.vaultRoot) return
  if (rel === state.currentFile) return
  if (state.dirty) {
    const ok = await confirmDialog('当前文档尚未保存，是否放弃更改？', '切换文档')
    if (!ok) return
  }
  if (isCanvasPath(rel)) {
    await openCanvas(rel)
    return
  }
  try {
    const md = await readMdFile(state.vaultRoot, rel)
    state.currentFile = rel
    setMode('md')
    editor.setMarkdown(md)
    els.filename.textContent = rel
    highlightActiveFile()
    setStatus('已打开：' + rel)
    editor.focus()
    refreshLinkPanels()
    if (snapshotPanel) snapshotPanel.refresh()
    if (pluginManager) pluginManager.fireFileOpen(rel, md)
    resetBackupTimer()
  } catch (e) {
    await messageDialog('打开失败：' + e)
  }
}

// —— 画布模式切换 / 打开 / 新建 ——
function setMode(mode) {
  state.mode = mode
  const canvasOn = mode === 'canvas'
  els.editor.classList.toggle('hidden', canvasOn)
  els.canvasMount.classList.toggle('hidden', !canvasOn)
}

async function openCanvas(path) {
  try {
    setMode('canvas') // 先显示容器，open 内的 fitView 才能拿到真实尺寸（否则 0×0 会把节点甩到左上角）
    await canvasView.open(path)
    state.currentFile = path
    els.filename.textContent = path
    highlightActiveFile()
    setStatus('已打开画布：' + path)
    resetBackupTimer()
  } catch (e) {
    await messageDialog('打开画布失败：' + ((e && e.message) || e))
  }
}

async function newCanvas() {
  if (!state.vaultRoot) {
    setStatus('请先打开知识库文件夹')
    await messageDialog('新建画布前请先打开一个知识库文件夹（画布会保存为库内的 .canvas 文件）。', 'info')
    return
  }
  if (state.dirty) {
    const ok = await confirmDialog('当前文档尚未保存，是否放弃更改？', '新建画布')
    if (!ok) return
  }
  const d = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  const name = `画布-${stamp}.canvas`
  try {
    setMode('canvas') // 先显示容器，newBlank 里 centerWorld 才能拿到真实尺寸
    state.currentFile = name
    els.filename.textContent = name
    highlightActiveFile()
    await canvasView.newBlank(name)
    await canvasView.save() // 先落盘一个空画布，使其出现在文件树
    renderTree(await scanVault(state.vaultRoot))
    setStatus('新建画布：' + name)
  } catch (e) {
    await messageDialog('新建画布失败：' + ((e && e.message) || e))
  }
}

// —— 保存到原文件（含索引增量更新 + 可选备份）——
async function saveCurrent(manual = true) {
  if (!state.currentFile || !state.vaultRoot) {
    if (manual) setStatus('没有可保存的文档')
    return
  }
  try {
    if (state.mode === 'canvas') {
      await canvasView.save()
      setStatus((manual ? '已保存：' : '自动保存：') + state.currentFile + ' · ' + timeStr())
      return
    }
    const md = editor.getMarkdown()
    await writeMdFile(state.vaultRoot, state.currentFile, md)
    editor.markSaved()
    if (pluginManager) pluginManager.fireSave(state.currentFile, md)
    setStatus((manual ? '已保存：' : '自动保存：') + state.currentFile + ' · ' + timeStr())
    // 索引增量：无需重扫全库
    try {
      await updateIndexDoc(state.currentFile, md)
      refreshLinkPanels()
    } catch (e) {
      console.warn('索引更新失败', e)
    }
    // 备份：手动保存一定做一次；自动保存受间隔约束（在 scheduleAutosave 里）
    await maybeBackup(md, manual)
    if (snapshotPanel && manual) snapshotPanel.refresh()
  } catch (e) {
    if (manual) await messageDialog('保存失败：' + e)
    else console.warn('自动保存失败', e)
  }
}

async function maybeBackup(md, force) {
  if (!state.currentFile || !state.vaultRoot) return
  const now = Date.now()
  if (!force && now - state.autosave.lastBackupAt < BACKUP_INTERVAL_MS) return
  try {
    await backupWrite(state.vaultRoot, state.currentFile, md)
    state.autosave.lastBackupAt = now
  } catch (e) {
    console.warn('备份失败', e)
  }
}

function resetBackupTimer() {
  if (state.autosave.backupTimer) clearInterval(state.autosave.backupTimer)
  state.autosave.lastBackupAt = 0
  // 打开文档时立刻做一次基线备份，之后每 BACKUP_INTERVAL_MS 由 autosave tick 触发
}

function scheduleAutosave() {
  if (!state.autosave.enabled) return
  if (state.autosave.idleTimer) clearTimeout(state.autosave.idleTimer)
  state.autosave.idleTimer = setTimeout(() => {
    if (state.dirty) saveCurrent(false)
  }, AUTOSAVE_IDLE_MS)
}

function timeStr() {
  const d = new Date()
  return d.toTimeString().slice(0, 8)
}

// —— [[wikilink]] 点击：跳转或新建 ——
async function onOpenWiki(name) {
  if (!state.vaultRoot) {
    setStatus('请先打开知识库文件夹')
    return
  }
  try {
    const res = await resolveWikiLink(state.vaultRoot, state.currentFile || '', name)
    if (res.exists) {
      await openFile(res.path)
      return
    }
    const create = await confirmDialog(`文档 "${name}" 不存在，是否在知识库中新建？`, '新建文档')
    if (!create) return
    const rel = await createMdFile(state.vaultRoot, name, `# ${name}\n\n`)
    renderTree(await scanVault(state.vaultRoot))
    state.currentFile = null
    state.dirty = false
    await openFile(rel)
    // 让索引立刻感知新文档
    try { await updateIndexDoc(rel, `# ${name}\n\n`) } catch (_) {}
  } catch (e) {
    await messageDialog('操作失败：' + e)
  }
}

// —— 大纲 / 标签面板 ——
function onMetaChange({ outline, tags }) {
  const ol = els.outline
  ol.innerHTML = ''
  outline.forEach((item) => {
    const a = document.createElement('a')
    a.className = 'outline-item level-' + item.level
    a.textContent = item.text || '（空标题）'
    a.href = '#'
    a.addEventListener('click', (e) => {
      e.preventDefault()
      editor.jumpToPos(item.pos)
    })
    ol.appendChild(a)
  })
  if (!outline.length) ol.innerHTML = '<div class="muted">暂无标题</div>'

  const tw = els.tags
  tw.innerHTML = ''
  tags.forEach((t) => {
    const chip = document.createElement('span')
    chip.className = 'tag-chip'
    chip.textContent = '#' + t
    chip.title = '在库内搜索此标签'
    chip.addEventListener('click', () => {
      els.searchInput.value = '#' + t
      runSearch('#' + t)
    })
    tw.appendChild(chip)
  })
  if (!tags.length) tw.innerHTML = '<div class="muted">本文档暂无标签</div>'

  scheduleAutosave()
}

// —— P1#1 双向链接面板 ——
async function refreshLinkPanels() {
  if (!state.currentFile || !state.indexReady) {
    els.backlinks.innerHTML = '<div class="link-empty">' + (state.indexReady ? '暂无' : '索引构建中…') + '</div>'
    els.outgoing.innerHTML = '<div class="link-empty">' + (state.indexReady ? '暂无' : '索引构建中…') + '</div>'
    return
  }
  try {
    const [bl, og] = await Promise.all([queryBacklinks(state.currentFile), queryOutgoing(state.currentFile)])
    renderLinkList(els.backlinks, bl, '暂无反向链接')
    renderLinkList(els.outgoing, og, '本文档暂无指向其他文档的链接')
  } catch (e) {
    console.warn('反查链接失败', e)
  }
}

function renderLinkList(container, list, emptyText) {
  container.innerHTML = ''
  if (!list.length) {
    container.innerHTML = '<div class="link-empty">' + emptyText + '</div>'
    return
  }
  list.forEach((h) => {
    const div = document.createElement('div')
    div.className = 'link-item'
    div.textContent = h.title || h.path
    div.title = h.path
    div.addEventListener('click', () => openFile(h.path))
    container.appendChild(div)
  })
}

// —— P1#2 全局搜索 ——
let searchDebounce = null
function onSearchInput() {
  if (searchDebounce) clearTimeout(searchDebounce)
  searchDebounce = setTimeout(() => runSearch(els.searchInput.value), 220)
}
async function runSearch(q) {
  const query = (q || '').trim()
  if (!query || !state.indexReady) {
    els.searchResults.innerHTML = ''
    return
  }
  try {
    const hits = await searchVault(query, 40)
    els.searchResults.innerHTML = ''
    if (!hits.length) {
      els.searchResults.innerHTML = '<div class="search-empty">无匹配</div>'
      return
    }
    hits.forEach((h) => {
      const card = document.createElement('div')
      card.className = 'search-hit'
      const badge =
        h.matchedBy === 'title' ? '<span class="search-hit-badge">标题</span>'
        : h.matchedBy === 'tag' ? '<span class="search-hit-badge">标签</span>'
        : ''
      card.innerHTML =
        '<div class="search-hit-title">' + escapeHtml(h.title) + badge + '</div>' +
        '<div class="search-hit-path">' + escapeHtml(h.path) + '</div>' +
        '<div class="search-hit-snippet">' + escapeHtml(h.snippet) + '</div>'
      card.addEventListener('click', () => openFile(h.path))
      els.searchResults.appendChild(card)
    })
  } catch (e) {
    console.warn('搜索失败', e)
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}

// —— P1#6 导出 HTML ——
async function exportHTML() {
  if (!state.currentFile) {
    setStatus('请先打开一个文档')
    return
  }
  if (state.mode === 'canvas') {
    setStatus('画布不支持导出 HTML')
    return
  }
  try {
    const md = editor.getMarkdown()
    const body = exportMd.render(md)
    const title = (md.match(/^#\s+(.+)$/m) || [, state.currentFile])[1]
    const html = buildExportHtml(title, body)
    const defaultName = state.currentFile.replace(/\.md$/i, '.html')
    const abs = await pickSaveAs(defaultName)
    if (!abs) return
    await exportFile(abs, html)
    setStatus('已导出 HTML：' + abs)
  } catch (e) {
    await messageDialog('导出失败：' + ((e && e.message) || e))
  }
}

function buildExportHtml(title, body) {
  // 独立 HTML：内嵌 GitHub 风格样式 + KaTeX css 引用；离线可读，可分享
  return `<!DOCTYPE html>
<html lang="zh-CN"><head>
<meta charset="UTF-8">
<title>${escapeHtml(title)}</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/katex.min.css">
<style>
  body { font-family: -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; max-width: 820px; margin: 40px auto; padding: 0 24px; line-height: 1.75; color: #24292e; }
  h1, h2, h3, h4, h5, h6 { line-height: 1.3; margin: 1.4em 0 0.6em; font-weight: 650; }
  h1 { font-size: 1.9em; border-bottom: 1px solid #eaecef; padding-bottom: .3em; }
  h2 { font-size: 1.5em; border-bottom: 1px solid #eaecef; padding-bottom: .3em; }
  h3 { font-size: 1.25em; }
  blockquote { border-left: 3px solid #d7dade; margin: .8em 0; padding: .1em 1em; color: #6a737d; }
  code { font-family: "SFMono-Regular", Consolas, monospace; background: #f2f3f5; padding: .1em .35em; border-radius: 4px; font-size: .9em; }
  pre { background: #f6f8fa; padding: 12px 14px; border-radius: 6px; overflow-x: auto; }
  pre code { background: none; padding: 0; }
  table { border-collapse: collapse; margin: 1em 0; width: 100%; }
  th, td { border: 1px solid #dfe2e5; padding: 6px 10px; }
  th { background: #f6f8fa; font-weight: 600; }
  img { max-width: 100%; }
  a { color: #2f6feb; }
  hr { border: none; border-top: 1px solid #e4e6e9; margin: 1.6em 0; }
  ul.contains-task-list, li.task-list-item { list-style: none; }
  li.task-list-item input { margin-right: .5em; }
</style></head>
<body>
${body}
</body></html>`
}

// —— P2：知识图谱模态 ——
let graphHandle = null
async function openGraphModal() {
  if (graphHandle) return
  if (!state.vaultRoot) {
    setStatus('需先打开知识库文件夹才能看图')
    return
  }
  if (!state.indexReady) {
    setStatus('索引尚未就绪，稍候再试')
    return
  }
  try {
    graphHandle = await openGraph({
      vaultRoot: state.vaultRoot,
      currentPath: state.currentFile,
      onNodeClick: (path) => { openFile(path) },
      onClose: () => { graphHandle = null },
    })
  } catch (e) {
    graphHandle = null
    setStatus('图谱打开失败：' + (e?.message || e))
  }
}

// —— 快捷键（应用级）——
function bindShortcuts() {
  document.addEventListener('keydown', (e) => {
    const mod = e.ctrlKey || e.metaKey
    if (!mod) return
    const key = e.key.toLowerCase()
    if (key === 's') {
      e.preventDefault()
      saveCurrent(true)
    } else if (key === 'o') {
      e.preventDefault()
      if (e.shiftKey) openFolder()
      else openSingleFile()
    } else if (key === 'f' && !e.shiftKey) {
      // 焦点交给侧栏搜索框
      e.preventDefault()
      els.searchInput.focus()
      els.searchInput.select()
    } else if (key === 'p') {
      // 打印（浏览器/系统会弹出打印对话框，可选另存 PDF）
      e.preventDefault()
      window.print()
    } else if (key === 'g') {
      // P2：知识图谱
      e.preventDefault()
      openGraphModal()
    }
  })
}

async function boot() {
  editor = createEditor({
    mountEl: els.editor,
    getVault: () => ({ vaultRoot: state.vaultRoot, mdRel: state.currentFile }),
    onOpenWiki,
    onMetaChange,
    onDirty: markDirty,
    onDocChange: (doc, prev) => pluginManager && pluginManager.fireDocChange(doc, prev),
  })

  applyTheme(localStorage.getItem('nl-theme') || 'light')

  // P2 版本快照面板：列表 / 预览 / 回滚（依赖已装配的 editor 与导出用 markdown-it）
  snapshotPanel = createSnapshotPanel({
    listEl: els.snapshots,
    modalEl: els.snapshotModal,
    previewEl: els.snapshotPreview,
    labelEl: els.snapshotLabel,
    metaEl: els.snapshotMeta,
    rollbackBtn: els.snapshotRollback,
    closeBtn: els.snapshotClose,
    getVaultRoot: () => state.vaultRoot,
    getCurrentFile: () => state.currentFile,
    editor,
    renderMarkdown: (md) => exportMd.render(md),
    escapeHtml,
    setStatus,
    onAfterRollback: () => refreshLinkPanels(),
  })
  snapshotPanel.refresh()

  // P2 插件钩子系统：打开知识库后从 .notelume-plugins/ 加载（依赖已装配的 editor.view）
  pluginManager = createPluginManager({
    view: editor.view,
    panelEl: els.plugins,
    setStatus,
    getVaultRoot: () => state.vaultRoot,
  })

  // P2 画布 / 白板：.canvas 文件的独立视图（文件读写在本模块内，复用通用文本命令）
  canvasView = createCanvasView({
    mountEl: els.canvasMount,
    setStatus,
    onDirty: markDirty,
    onOpenFile: (file) => openFile(file),
    getVaultRoot: () => state.vaultRoot,
  })

  els.chkAutosave.checked = state.autosave.enabled
  els.chkAutosave.addEventListener('change', () => {
    state.autosave.enabled = els.chkAutosave.checked
    localStorage.setItem('nl-autosave', state.autosave.enabled ? '1' : '0')
    setStatus(state.autosave.enabled ? '自动保存已开启（2s 空闲）' : '自动保存已关闭')
    if (state.autosave.enabled && state.dirty) scheduleAutosave()
  })

  els.btnOpen.addEventListener('click', openFolder)
  els.btnOpenFile.addEventListener('click', openSingleFile)
  els.btnSave.addEventListener('click', () => saveCurrent(true))
  els.btnTheme.addEventListener('click', toggleTheme)
  els.btnExportHtml.addEventListener('click', exportHTML)
  els.btnPrint.addEventListener('click', () => window.print())
  els.btnGraph.addEventListener('click', openGraphModal)
  els.btnNewCanvas.addEventListener('click', newCanvas)
  els.searchInput.addEventListener('input', onSearchInput)
  els.searchInput.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      els.searchInput.value = ''
      els.searchResults.innerHTML = ''
    }
  })
  bindShortcuts()

  // 文件树右键菜单：点击菜单外任意处即关闭
  document.addEventListener('pointerdown', (e) => {
    if (treeMenuEl && !treeMenuEl.contains(e.target)) closeTreeMenu()
  }, true)

  setStatus('第一步：点「打开知识库」选择一个本地文件夹')
}

boot().catch((e) => {
  console.error(e)
  if (window.__nlError) window.__nlError('初始化失败：' + ((e && e.message) || e))
})
