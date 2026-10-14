// main.js —— 应用装配：布局、知识库文件树、大纲、标签、主题、快捷键、打开/保存/跳转
// P1 追加：Rust 索引触发与轮询、双向链接面板、全局搜索、悬浮预览（在 editor-view 里挂）、
// 自动保存 + 库内备份、HTML 导出、打印。
import { createEditor } from './editor-view.js'
import { createFrontmatterPanel } from './frontmatter-panel.js'
import { splitFrontmatter } from './frontmatter.js'
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
  createDir,
  renameItem,
  isImportableFileName,
  isImagePath,
  importVaultFileFrom,
  confirmDialog,
  messageDialog,
  rebuildIndex,
  getIndexStatus,
  queryBacklinks,
  queryOutgoing,
  searchVault,
  listAllTags,
  queryTag,
  updateIndexDoc,
  removeIndexDoc,
  backupWrite,
  exportFile,
} from './tauri-bridge.js'
import { openGraph } from './graph-view.js'
import { createSnapshotPanel } from './snapshot-panel.js'
import { promptDialog } from './prompt-dialog.js'
import { createPluginManager } from './plugin-loader.js'
import { createCanvasView } from './canvas-view.js'
import { openImage } from './img-viewer.js'
import { builtinVars, applyTemplate } from './template.js'
import { toggleDailyCapture, configureDailyCapture } from './daily-capture.js'
import { countWords, statsLabel } from './writing-stats.js'
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
  docNames: [], // 全库 .md 文件名（去 .md）——供 [[ 自动补全
  tagNames: [], // 全库标签——供 # 自动补全
  tree: [], // 最近一次 scanVault 的文件树——供模板/每日笔记列目录
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
  frontmatter: $('frontmatter'),
  tags: $('tags'),
  tagsGlobal: $('tags-global'),
  tagsGlobalDocs: $('tags-global-docs'),
  editor: $('editor'),
  filename: $('filename'),
  status: $('status'),
  btnOpen: $('btn-open'),
  btnOpenFile: $('btn-open-file'),
  btnSave: $('btn-save'),
  btnTheme: $('btn-theme'),
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
  btnDaily: $('btn-daily'),
  btnSource: $('btn-source'),
  btnMore: $('btn-more'),
  sourceMount: $('source-mount'),
  docstats: $('docstats'),
}

let editor
let snapshotPanel = null
let frontmatterPanel = null
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

// —— 批次 B：写作统计 / 专注 / 打字机 ——
function updateDocStats() {
  if (!els.docstats) return
  if (state.mode !== 'md' || !editor) { els.docstats.textContent = ''; return }
  const words = countWords(editor.getText())
  let label = statsLabel(words)
  const goal = parseInt(localStorage.getItem('nl-word-goal') || '0', 10)
  if (goal > 0) {
    const pct = Math.min(100, Math.round((words / goal) * 100))
    label += ' · 目标 ' + goal + '（' + pct + '%）'
  }
  els.docstats.textContent = label
}

function toggleFocusMode() {
  const on = localStorage.getItem('nl-focus') !== '1'
  localStorage.setItem('nl-focus', on ? '1' : '0')
  if (editor) editor.setFocusMode(on)
  setStatus(on ? '专注模式：开启' : '专注模式：关闭')
}

function toggleTypewriterMode() {
  const on = localStorage.getItem('nl-typewriter') !== '1'
  localStorage.setItem('nl-typewriter', on ? '1' : '0')
  if (editor) editor.setTypewriterMode(on)
  setStatus(on ? '打字机模式：开启' : '打字机模式：关闭')
}

async function setWordGoal() {
  const cur = localStorage.getItem('nl-word-goal') || '0'
  const v = await promptDialog({ title: '当日字数目标', placeholder: '输入目标字数，0 表示清除', defaultValue: cur === '0' ? '500' : cur })
  if (v == null) return
  const n = parseInt(String(v).replace(/[^0-9]/g, ''), 10)
  localStorage.setItem('nl-word-goal', n > 0 ? String(n) : '0')
  updateDocStats()
}

async function toggleSourceMode() {
  if (!editor) return
  if (state.mode !== 'md') {
    setStatus('源码模式仅用于 Markdown 文档')
    return
  }
  const on = await editor.toggleSource()
  if (els.btnSource) els.btnSource.classList.toggle('active', on)
  setStatus(on ? '源码模式：开启（保存即写回原文，不被重新格式化）' : '源码模式：关闭（回到所见即所得）')
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
  // 通知视图层按新主题重渲染依赖配色的部件（如 mermaid 图表）
  window.dispatchEvent(new Event('nl-theme-change'))
  if (editor) editor.setSourceTheme(theme)
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
        refreshGlobalTags()
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
    recordRecent(dir, name)
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
  state.tree = nodes || []
  state.docNames = collectDocNames(nodes)
  const ul = document.createElement('ul')
  ul.className = 'tree-root'
  nodes.forEach((n) => ul.appendChild(renderNode(n)))
  els.tree.innerHTML = ''
  els.tree.appendChild(ul)
  bindTreeBgMenu()
  bindTreeDnd()
}

// 文件树空白区右键→在库根新建（子节点的 contextmenu 已 stopPropagation，只有真空白会到达这里）
let treeBgBound = false
function bindTreeBgMenu() {
  if (treeBgBound) return
  treeBgBound = true
  els.tree.addEventListener('contextmenu', (e) => {
    e.preventDefault()
    showTreeBgMenu(e.clientX, e.clientY)
  })
}

// —— 拖拽：内部移动 + 外部拖入导入（事件委托，绑定一次） ——
let treeDndBound = false
let dragRel = null
let dragIsFolder = false
let dropHlEl = null
function setDropHl(el) {
  if (dropHlEl === el) return
  if (dropHlEl) dropHlEl.classList.remove('tree-drop-hover')
  dropHlEl = el || null
  if (dropHlEl) dropHlEl.classList.add('tree-drop-hover')
}
function clearDropHl() {
  if (dropHlEl) dropHlEl.classList.remove('tree-drop-hover')
  dropHlEl = null
}
// 根据光标下元素解析目标目录（拖到文件→其所在目录；拖到文件夹/其区域→该文件夹；空白→库根）
function resolveDropTarget(target) {
  if (target && target.closest) {
    const file = target.closest('.tree-file')
    if (file) {
      const details = file.closest('details[data-path]')
      const sum = details ? details.querySelector(':scope > summary') : null
      return { destDir: parentOf(file.dataset.path), hl: sum || els.tree }
    }
    const sum = target.closest('summary[data-kind="folder"]')
    if (sum) return { destDir: sum.dataset.path, hl: sum }
    const det = target.closest('details[data-path]')
    if (det) {
      const s = det.querySelector(':scope > summary')
      return { destDir: det.dataset.path, hl: s || els.tree }
    }
  }
  return { destDir: '', hl: els.tree }
}
function bindTreeDnd() {
  if (treeDndBound) return
  treeDndBound = true
  els.tree.addEventListener('dragstart', (e) => {
    const el = e.target.closest && e.target.closest('[data-kind]')
    if (!el || !el.dataset.path) return
    dragRel = el.dataset.path
    dragIsFolder = el.dataset.kind === 'folder'
    try {
      e.dataTransfer.setData('application/notelume-tree', dragRel)
      e.dataTransfer.effectAllowed = 'move'
    } catch (_) {}
  })
  els.tree.addEventListener('dragend', () => {
    dragRel = null
    dragIsFolder = false
    clearDropHl()
  })
  els.tree.addEventListener('dragover', (e) => {
    const hasFiles = e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files')
    if (!dragRel && !hasFiles) return
    e.preventDefault()
    e.dataTransfer.dropEffect = dragRel ? 'move' : 'copy'
    setDropHl(resolveDropTarget(e.target).hl)
  })
  els.tree.addEventListener('dragleave', (e) => {
    if (e.target === els.tree || !els.tree.contains(e.relatedTarget)) clearDropHl()
  })
  els.tree.addEventListener('drop', (e) => {
    e.preventDefault()
    const { destDir } = resolveDropTarget(e.target)
    clearDropHl()
    const files = e.dataTransfer && e.dataTransfer.files
    if (dragRel) {
      const src = dragRel
      const isF = dragIsFolder
      dragRel = null
      dragIsFolder = false
      doMove(src, isF, destDir)
    } else if (files && files.length) {
      importDroppedFiles(files, destDir)
    }
  })
}

async function doMove(srcRel, isFolder, destDir) {
  if (!state.vaultRoot || !srcRel) return
  const newRel = joinRel(destDir, baseName(srcRel))
  if (newRel === srcRel) return // 原地，不处理
  try {
    await renameItem(state.vaultRoot, srcRel, newRel)
    remapCurrentAfterRename(srcRel, newRel, isFolder)
    renderTree(await scanVault(state.vaultRoot))
    startIndexPolling()
    setStatus('已移动：' + srcRel + ' → ' + newRel)
  } catch (e) {
    await messageDialog('移动失败：' + errText(e))
  }
}

async function importDroppedFiles(files, destDir) {
  if (!state.vaultRoot) {
    setStatus('请先打开知识库文件夹')
    return
  }
  const list = Array.from(files || [])
  const ok = list.filter((f) => isImportableFileName(f.name))
  const bad = list.filter((f) => !isImportableFileName(f.name))
  if (!ok.length) {
    if (bad.length) await messageDialog('不支持导入的文件类型：' + bad.map((f) => f.name).join(', '))
    return
  }
  const imported = []
  for (const f of ok) {
    try {
      const rel = await importVaultFileFrom(state.vaultRoot, destDir, f)
      imported.push(rel)
    } catch (e) {
      await messageDialog('导入失败 ' + f.name + '：' + errText(e))
    }
  }
  if (imported.length) {
    renderTree(await scanVault(state.vaultRoot))
    startIndexPolling()
    setStatus('已导入 ' + imported.length + ' 个文件')
  }
}

// 递归收集库内所有 .md 的文件名主干（去 .md），供 [[ 自动补全候选
function collectDocNames(nodes) {
  const out = []
  const walk = (arr) => {
    ;(arr || []).forEach((n) => {
      if (n.type === 'file') {
        if (/\.md$/i.test(n.path)) out.push(baseName(n.path).replace(/\.md$/i, ''))
      } else if (n.type === 'folder') {
        walk(n.children)
      }
    })
  }
  walk(nodes)
  return out
}

function renderNode(node) {
  if (node.type === 'folder') {
    const details = document.createElement('details')
    details.open = true
    details.className = 'tree-folder'
    details.dataset.path = node.path
    const summary = document.createElement('summary')
    summary.textContent = node.name
    summary.title = node.path
    summary.draggable = true
    summary.dataset.path = node.path
    summary.dataset.kind = 'folder'
    summary.addEventListener('contextmenu', (e) => {
      e.preventDefault()
      e.stopPropagation()
      showTreeMenu(e.clientX, e.clientY, node)
    })
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
  li.dataset.kind = 'file'
  if (isImagePath(node.path)) li.classList.add('is-img')
  li.draggable = true
  li.title = node.path
  li.addEventListener('click', () => openFile(node.path))
  li.addEventListener('contextmenu', (e) => {
    e.preventDefault()
    e.stopPropagation()
    showTreeMenu(e.clientX, e.clientY, node)
  })
  return li
}

// —— 文件树右键菜单（复用画布 .cv-menu 样式）——
let treeMenuEl = null
function closeTreeMenu() {
  if (treeMenuEl && treeMenuEl.parentNode) treeMenuEl.parentNode.removeChild(treeMenuEl)
  treeMenuEl = null
}
function placeMenu(menu, clientX, clientY) {
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
function makeMenuItem(label, fn, danger, checked) {
  const b = document.createElement('button')
  b.className = 'cv-menu-item' + (danger ? ' danger' : '')
  const chk = document.createElement('span')
  chk.className = 'cv-menu-check'
  chk.textContent = checked ? '✓' : ''
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
function menuSep() {
  const d = document.createElement('div')
  d.className = 'cv-menu-sep'
  return d
}

// —— 文件 / 文件夹右键菜单 ——
function showTreeMenu(clientX, clientY, node) {
  closeTreeMenu()
  const menu = document.createElement('div')
  menu.className = 'cv-menu tree-menu'
  if (node.type === 'file') {
    menu.appendChild(makeMenuItem('打开', () => openFile(node.path)))
    menu.appendChild(makeMenuItem('重命名 / 移动…', () => renameEntry(node.path, node.name, false)))
    menu.appendChild(menuSep())
    menu.appendChild(makeMenuItem('移入回收站', () => deleteVaultFile(node.path, node.name), true))
  } else {
    menu.appendChild(makeMenuItem('新建文件…', () => newFileIn(node.path)))
    menu.appendChild(makeMenuItem('新建文件夹…', () => newFolderIn(node.path)))
    menu.appendChild(menuSep())
    menu.appendChild(makeMenuItem('重命名 / 移动…', () => renameEntry(node.path, node.name, true)))
  }
  placeMenu(menu, clientX, clientY)
}

// —— 文件树空白区右键：在库根新建 ——
function showTreeBgMenu(clientX, clientY) {
  closeTreeMenu()
  const menu = document.createElement('div')
  menu.className = 'cv-menu tree-menu'
  menu.appendChild(makeMenuItem('新建文件…', () => newFileIn('')))
  menu.appendChild(makeMenuItem('新建文件夹…', () => newFolderIn('')))
  placeMenu(menu, clientX, clientY)
}

function parentOf(rel) {
  const i = rel.lastIndexOf('/')
  return i < 0 ? '' : rel.slice(0, i)
}
function joinRel(dir, name) {
  return dir ? dir + '/' + name : name
}
function baseName(rel) {
  return rel.slice(rel.lastIndexOf('/') + 1)
}
function extOf(name) {
  const m = /\.[^.]+$/.exec(name)
  return m ? m[0] : ''
}
function errText(e) {
  return (e && e.message) || String(e)
}

async function newFileIn(dirRel) {
  if (!state.vaultRoot) return
  const name = await promptDialog({
    title: '新建 Markdown 文件' + (dirRel ? '（于 ' + dirRel + '）' : '（库根）'),
    placeholder: '文件名（可不带 .md）',
  })
  if (!name) return
  let rel = joinRel(dirRel, name)
  if (!rel.toLowerCase().endsWith('.md')) rel += '.md'
  const seed = '# ' + baseName(rel).replace(/\.md$/i, '') + '\n\n'
  try {
    await writeMdFile(state.vaultRoot, rel, seed)
    renderTree(await scanVault(state.vaultRoot))
    try { await updateIndexDoc(rel, seed) } catch (_) {}
    await openFile(rel)
    setStatus('已新建：' + rel)
  } catch (e) {
    await messageDialog('新建失败：' + errText(e))
  }
}

// —— 批次 A：模板（从模板新建，纯文件、零新依赖、无 Rust 改动）——
const TEMPLATE_DIR = () => localStorage.getItem('nl-template-dir') || 'Templates'

// 逐段创建库内目录（已存在的段忽略报错）
async function ensureDir(dirRel) {
  if (!dirRel) return
  let cur = ''
  for (const s of dirRel.split('/').filter(Boolean)) {
    cur = cur ? cur + '/' + s : s
    try { await createDir(state.vaultRoot, cur) } catch (_) { /* 已存在/竞态，忽略 */ }
  }
}

// 从缓存文件树里找某个库内目录节点
function findFolderNode(dirRel) {
  const target = (dirRel || '').replace(/\/+$/, '')
  let found = null
  ;(function walk(nodes) {
    (nodes || []).forEach((n) => {
      if (found) return
      if (n.type === 'folder') {
        if (n.path === target) { found = n; return }
        walk(n.children)
      }
    })
  })(state.tree || [])
  return found
}
// 列出某目录下的 .md 模板（相对路径，按名排序）
function listMdInDir(dirRel) {
  const folder = findFolderNode(dirRel)
  if (!folder) return []
  return (folder.children || [])
    .filter((n) => n.type === 'file' && /\.md$/i.test(n.path))
    .map((n) => n.path)
    .sort((a, b) => baseName(a).localeCompare(baseName(b)))
}
async function refreshTree() {
  try { state.tree = await scanVault(state.vaultRoot) } catch (_) {}
}

// 从指定模板新建文档：填名 → 变量替换 → 落库 → 打开
async function newFromTemplate(tplRel) {
  if (!state.vaultRoot) return
  let tpl
  try { tpl = await readMdFile(state.vaultRoot, tplRel) }
  catch (e) { await messageDialog('读取模板失败：' + errText(e)); return }
  const name = await promptDialog({ title: '基于模板新建（' + baseName(tplRel) + '）', placeholder: '新文件名（可不带 .md）' })
  if (!name) return
  const rel = /\.md$/i.test(name) ? name : name + '.md'
  const now = new Date()
  const vars = builtinVars({ title: baseName(rel).replace(/\.md$/i, ''), filename: baseName(rel), now })
  const content = applyTemplate(tpl, vars)
  try {
    await ensureDir(parentOf(rel))
    await writeMdFile(state.vaultRoot, rel, content)
    renderTree(await scanVault(state.vaultRoot))
    try { await updateIndexDoc(rel, content) } catch (_) {}
    await openFile(rel)
    setStatus('已从模板新建：' + rel)
  } catch (e) {
    await messageDialog('新建失败：' + errText(e))
  }
}

// 新建一个空白模板（带示例变量），存于模板目录
async function newBlankTemplate() {
  if (!state.vaultRoot) { await messageDialog('请先打开知识库'); return }
  const name = await promptDialog({ title: '新建模板（存于 ' + TEMPLATE_DIR() + '/）', placeholder: '模板文件名（可不带 .md）' })
  if (!name) return
  const rel = joinRel(TEMPLATE_DIR(), /\.md$/i.test(name) ? name : name + '.md')
  const seed = '# {{title}}\n\n日期：{{date}} {{weekday}}　时间：{{time}}\n\n## 待办\n- [ ] \n'
  try {
    await ensureDir(TEMPLATE_DIR())
    await writeMdFile(state.vaultRoot, rel, seed)
    renderTree(await scanVault(state.vaultRoot))
    await openFile(rel)
    setStatus('已新建模板：' + rel)
  } catch (e) { await messageDialog('新建模板失败：' + errText(e)) }
}

// 工具条「模板」菜单：列模板 + 今日速记 + 新建模板 + 今日速记设置
function openTemplateMenu(anchorEl) {
  if (!state.vaultRoot) { messageDialog('请先打开知识库'); return }
  refreshTree().then(() => {
    closeTreeMenu()
    const menu = document.createElement('div')
    menu.className = 'cv-menu tree-menu'
    const tpls = listMdInDir(TEMPLATE_DIR())
    if (!tpls.length) {
      menu.appendChild(makeMenuItem('（' + TEMPLATE_DIR() + '/ 暂无模板）', () => {}))
    } else {
      tpls.forEach((p) => menu.appendChild(makeMenuItem('📄 ' + baseName(p).replace(/\.md$/i, ''), () => newFromTemplate(p))))
    }
    menu.appendChild(menuSep())
    menu.appendChild(makeMenuItem('📅 今日速记（全局浮层，独立于知识库）', () => toggleDailyCapture()))
    menu.appendChild(makeMenuItem('➕ 新建空白模板…', () => newBlankTemplate()))
    menu.appendChild(makeMenuItem('⚙ 今日速记设置…', () => configureDailyCapture()))
    const r = anchorEl.getBoundingClientRect()
    placeMenu(menu, r.left, r.bottom + 4)
  })
}

// 工具条「更多」菜单：收纳低频操作（导出/打印/图谱/画布/模板）与视图模式开关（专注/打字机）
function openMoreMenu(anchorEl) {
  closeTreeMenu()
  const menu = document.createElement('div')
  menu.className = 'cv-menu tree-menu'
  menu.appendChild(makeMenuItem('📤 导出为 HTML', () => exportHTML()))
  menu.appendChild(makeMenuItem('🖨 打印 / 导出 PDF (Ctrl+P)', () => window.print()))
  menu.appendChild(makeMenuItem('🕸 知识图谱 (Ctrl+G)', () => openGraphModal()))
  menu.appendChild(makeMenuItem('🗺 新画布 / 白板', () => newCanvas()))
  menu.appendChild(makeMenuItem('🕘 最近打开', () => openRecentMenu(anchorEl)))
  menu.appendChild(makeMenuItem('📋 模板 / 今日速记设置', () => openTemplateMenu(anchorEl)))
  menu.appendChild(menuSep())
  menu.appendChild(makeMenuItem('🎯 专注模式 (Ctrl+Shift+F)', () => toggleFocusMode(), false, localStorage.getItem('nl-focus') === '1'))
  menu.appendChild(makeMenuItem('⌨ 打字机模式 (Ctrl+Shift+T)', () => toggleTypewriterMode(), false, localStorage.getItem('nl-typewriter') === '1'))
  const r = anchorEl.getBoundingClientRect()
  placeMenu(menu, r.left, r.bottom + 4)
}

// —— 最近打开（全局记录于 localStorage，跨知识库；点条目按原库根重开该文件）——
const RECENT_KEY = 'nl-recent'
const RECENT_MAX = 12
function loadRecents() {
  try {
    const a = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]')
    return Array.isArray(a) ? a : []
  } catch (_) {
    return []
  }
}
function saveRecents(list) {
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(list))
  } catch (_) {
    /* 配额满等忽略 */
  }
}
function recordRecent(root, rel) {
  if (!root || !rel) return
  const keyRoot = normVaultPath(root)
  const list = loadRecents().filter((e) => !(normVaultPath(e.root) === keyRoot && e.rel === rel))
  list.unshift({ root, rel, name: baseName(rel) })
  saveRecents(list.slice(0, RECENT_MAX))
}
function openRecentMenu(anchorEl) {
  const list = loadRecents()
  closeTreeMenu()
  const menu = document.createElement('div')
  menu.className = 'cv-menu tree-menu'
  if (!list.length) {
    menu.appendChild(makeMenuItem('（暂无最近打开记录）', () => {}))
  } else {
    list.forEach((e) => {
      const it = makeMenuItem('📄 ' + e.name, () => reopenRecent(e))
      it.title = e.root + '/' + e.rel
      menu.appendChild(it)
    })
    menu.appendChild(menuSep())
    menu.appendChild(makeMenuItem('🧹 清空最近记录', () => saveRecents([])))
  }
  const r = anchorEl.getBoundingClientRect()
  placeMenu(menu, r.left, r.bottom + 4)
}
async function reopenRecent(entry) {
  if (state.dirty) {
    const ok = await confirmDialog('当前文档尚未保存，是否放弃更改？', '打开最近文件')
    if (!ok) return
  }
  try {
    state.vaultRoot = entry.root
    state.currentFile = null // 避免 openFile 的“同一相对路径”早退（跨库可能同名）
    const tree = await scanVault(entry.root)
    renderTree(tree)
    startIndexPolling()
    await openFile(entry.rel, true) // 脏状态已在上面确认
    if (pluginManager) pluginManager.reload()
  } catch (e) {
    // 目录可能已移动 / 删除：剔除该条并提示
    saveRecents(loadRecents().filter((x) => !(normVaultPath(x.root) === normVaultPath(entry.root) && x.rel === entry.rel)))
    await messageDialog('打开最近文件失败（路径可能已变动）：' + ((e && e.message) || e))
  }
}

async function newFolderIn(dirRel) {
  if (!state.vaultRoot) return
  const name = await promptDialog({
    title: '新建文件夹' + (dirRel ? '（于 ' + dirRel + '）' : '（库根）'),
    placeholder: '文件夹名',
  })
  if (!name) return
  if (name.includes('/') || name.includes('\\')) {
    await messageDialog('文件夹名不能包含路径分隔符')
    return
  }
  const rel = joinRel(dirRel, name)
  try {
    await createDir(state.vaultRoot, rel)
    renderTree(await scanVault(state.vaultRoot))
    setStatus('已新建文件夹：' + rel)
  } catch (e) {
    await messageDialog('新建文件夹失败：' + errText(e))
  }
}

async function renameEntry(rel, name, isFolder) {
  if (!state.vaultRoot) return
  const input = await promptDialog({
    title: isFolder ? '重命名 / 移动文件夹' : '重命名 / 移动文件',
    defaultValue: name,
  })
  if (input === null) return
  const newName = input.trim()
  if (!newName || newName === name) return
  let to = joinRel(parentOf(rel), newName)
  if (!isFolder) {
    const origExt = extOf(name)
    if (origExt && !to.toLowerCase().endsWith(origExt.toLowerCase())) to += origExt
  }
  if (to === rel) return
  try {
    await renameItem(state.vaultRoot, rel, to)
    remapCurrentAfterRename(rel, to, isFolder)
    renderTree(await scanVault(state.vaultRoot))
    startIndexPolling() // 索引重建，反映改名 / 移动后的新路径
    setStatus('已重命名 / 移动：' + rel + ' → ' + to)
  } catch (e) {
    await messageDialog('重命名失败：' + errText(e))
  }
}

function remapCurrentAfterRename(from, to, isFolder) {
  const cf = state.currentFile
  if (!cf) return
  let newCf = null
  if (cf === from) newCf = to
  else if (isFolder && cf.startsWith(from + '/')) newCf = to + cf.slice(from.length)
  if (!newCf) return
  // 内容未变，仅路径变了：保留编辑器缓冲与脏状态，只更新当前路径标识
  state.currentFile = newCf
  els.filename.textContent = newCf
  highlightActiveFile()
}

async function deleteVaultFile(rel, name) {
  if (!state.vaultRoot) return
  const ok = await confirmDialog(`确定把「${name}」移入系统回收站？（可从回收站恢复）`, '移入回收站')
  if (!ok) return
  try {
    await deleteFile(state.vaultRoot, rel)
    // 索引同步：从索引移除这条文档（canvas 不在索引内，为空操作）
    try { await removeIndexDoc(rel) } catch (_) {}
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
async function openFile(rel, skipDirtyConfirm) {
  if (!state.vaultRoot) return
  // 图片附件：走独立查看器单独放大查看，不切换当前文档、不触发脏状态确认
  if (isImagePath(rel)) {
    openImage(rel, { vaultRoot: state.vaultRoot })
    return
  }
  if (rel === state.currentFile) return
  if (state.dirty && !skipDirtyConfirm) {
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
    recordRecent(state.vaultRoot, rel)
  } catch (e) {
    await messageDialog('打开失败：' + e)
  }
}

// —— 画布模式切换 / 打开 / 新建 ——
function setMode(mode) {
  state.mode = mode
  const canvasOn = mode === 'canvas'
  // 切画布前先退出源码模式（同步回灌模型），避免源码容器盖住画布
  if (canvasOn && editor && editor.isSourceMode()) {
    editor.exitSource()
    if (els.btnSource) els.btnSource.classList.remove('active')
  }
  // md 态下若仍在源码模式，保持主编辑器隐藏、源码容器可见（供 openFile 调 setMode('md') 时不破坏源码态）
  const inSource = !canvasOn && !!editor && editor.isSourceMode()
  els.editor.classList.toggle('hidden', canvasOn || inSource)
  els.sourceMount && els.sourceMount.classList.toggle('hidden', !inSource)
  els.canvasMount.classList.toggle('hidden', !canvasOn)
  if (frontmatterPanel) frontmatterPanel.refresh() // 画布态下属性面板转为占位
  updateDocStats()
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
    recordRecent(state.vaultRoot, path)
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

// —— 全局标签视图：列出全库标签 + 计数；点标签展开含该标签的文档，点文档跳转 ——
let activeGlobalTag = null
async function refreshGlobalTags() {
  const box = els.tagsGlobal
  const docBox = els.tagsGlobalDocs
  if (!box) return
  activeGlobalTag = null
  if (docBox) {
    docBox.innerHTML = ''
    docBox.classList.remove('show')
  }
  if (!state.vaultRoot || !state.indexReady) {
    box.innerHTML = '<div class="muted">' + (state.vaultRoot ? '索引构建中…' : '打开知识库后显示') + '</div>'
    return
  }
  let tags = []
  try {
    tags = await listAllTags()
  } catch (_) {
    box.innerHTML = '<div class="muted">标签加载失败</div>'
    return
  }
  state.tagNames = (tags || []).map((t) => t.tag)
  if (!tags.length) {
    box.innerHTML = '<div class="muted">暂无标签</div>'
    return
  }
  box.innerHTML = ''
  tags.forEach(({ tag, count }) => {
    const chip = document.createElement('span')
    chip.className = 'tag-chip tag-global-chip'
    chip.appendChild(document.createTextNode('#' + tag))
    const c = document.createElement('span')
    c.className = 'tag-count'
    c.textContent = String(count)
    chip.appendChild(c)
    chip.title = '查看含 #' + tag + ' 的文档'
    chip.addEventListener('click', () => toggleTagDocs(tag, chip))
    box.appendChild(chip)
  })
}

async function toggleTagDocs(tag, chip) {
  const docBox = els.tagsGlobalDocs
  document.querySelectorAll('.tag-global-chip.active').forEach((el) => el.classList.remove('active'))
  if (activeGlobalTag === tag) {
    activeGlobalTag = null
    docBox.innerHTML = ''
    docBox.classList.remove('show')
    return
  }
  activeGlobalTag = tag
  if (chip) chip.classList.add('active')
  docBox.innerHTML = '<div class="muted">加载中…</div>'
  docBox.classList.add('show')
  let docs = []
  try {
    docs = await queryTag(tag)
  } catch (_) {
    docs = []
  }
  docBox.innerHTML = ''
  const head = document.createElement('div')
  head.className = 'tag-docs-head'
  head.textContent = '#' + tag + ' · ' + docs.length + ' 篇'
  docBox.appendChild(head)
  if (!docs.length) {
    const empty = document.createElement('div')
    empty.className = 'muted'
    empty.textContent = '无文档'
    docBox.appendChild(empty)
    return
  }
  docs.forEach((d) => {
    const item = document.createElement('div')
    item.className = 'tag-doc-item'
    item.textContent = d.title || d.path
    item.title = d.path
    item.addEventListener('click', () => openFile(d.path))
    docBox.appendChild(item)
  })
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
    const full = editor.getMarkdown()
    // 导出不含 frontmatter：渲染与取标题都只看正文（frontmatter 非正文）
    const md = splitFrontmatter(full).body
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
    } else if (key === 'd' && e.shiftKey) {
      // 批次 A：今日速记（全局浮层，独立于知识库）
      e.preventDefault()
      toggleDailyCapture()
    } else if (key === 'f' && e.shiftKey) {
      // 批次 B：专注模式
      e.preventDefault()
      toggleFocusMode()
    } else if (key === 't' && e.shiftKey) {
      // 批次 B：打字机模式
      e.preventDefault()
      toggleTypewriterMode()
    } else if (key === '/') {
      // Markdown 源码模式：整篇切换 WYSIWYG <-> 原文
      e.preventDefault()
      toggleSourceMode()
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
    suggestDocs: () => state.docNames,
    suggestTags: () => state.tagNames,
    onFrontmatterChange: () => frontmatterPanel && frontmatterPanel.refresh(),
    initialFocus: localStorage.getItem('nl-focus') === '1',
    initialTypewriter: localStorage.getItem('nl-typewriter') === '1',
    sourceMountEl: els.sourceMount,
    onSourceTextChange: () => { updateDocStats(); if (frontmatterPanel) frontmatterPanel.refresh() },
    onDocChange: (doc, prev) => { updateDocStats(); if (pluginManager) pluginManager.fireDocChange(doc, prev) },
  })

  // 文档属性（frontmatter）面板：查看 / 编辑当前 md 文档的 YAML 头
  frontmatterPanel = createFrontmatterPanel({
    container: els.frontmatter,
    getFm: () => editor.getFrontmatter(),
    setFm: (raw) => editor.setFrontmatter(raw),
    isEditable: () => state.mode === 'md' && !!state.currentFile,
  })
  frontmatterPanel.refresh()

  refreshGlobalTags() // 未开库时先显占位；开库并索引就绪后由 startIndexPolling 刷新

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
  els.btnDaily && els.btnDaily.addEventListener('click', () => toggleDailyCapture())
  els.btnSource && els.btnSource.addEventListener('click', toggleSourceMode)
  els.btnMore && els.btnMore.addEventListener('click', (e) => openMoreMenu(e.currentTarget))
  els.docstats && els.docstats.addEventListener('click', setWordGoal)
  updateDocStats()
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
