// main.js —— 应用装配：布局、知识库文件树、大纲、标签、主题、快捷键、打开/保存/跳转
// P1 追加：Rust 索引触发与轮询、双向链接面板、全局搜索、悬浮预览（在 editor-view 里挂）、
// 自动保存 + 库内备份、HTML 导出、打印。
import { createEditor, EDITOR_COMMANDS } from './editor-view.js'
import { createFindBar } from './find-in-doc.js'
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
  buildSiteGraph,
  copyVaultAssets,
  setMacMenu,
  pickDocxFiles,
  docxPreview,
  docxCommit,
  ensureTempImportDir,
  relocateImport,
  exportDocx,
  fileToBase64,
} from './tauri-bridge.js'
import { exportSite, resolveImageRel, collectImages } from './site-export.js'
import { docToIR } from './docx-export.js'
import { runImport, IMG_INDEX_KEY, DEFAULT_MAX_IMAGE_BYTES } from './docx-import.js'
import { openDocxReview } from './docx-review.js'
import { createPalette } from './command-palette.js'
import { createShortcutSettings } from './shortcut-settings.js'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { listen } from '@tauri-apps/api/event'
import { openGraph } from './graph-view.js'
import { createSnapshotPanel } from './snapshot-panel.js'
import { createGitPanel } from './git-panel.js'
import { promptDialog } from './prompt-dialog.js'
import { confirm3Dialog } from './confirm3-dialog.js'
import { createPluginManager } from './plugin-loader.js'
import { createRegistry } from './commands.js'
import { detectIsMac, eventToBinding, resolveBinding, effectiveBindings, formatBinding, toAccelerator } from './keymap.js'
import { buildMacMenuSpec } from './app-menu.js'
import { createCanvasView } from './canvas-view.js'
import { openImage } from './img-viewer.js'
import { builtinVars, applyTemplate } from './template.js'
import { toggleDailyCapture, configureDailyCapture } from './daily-capture.js'
import { countWords, statsLabel } from './writing-stats.js'
import { setIcon } from './icons.js'
import { analyzeOutline, hiddenRows } from './outline-tree.js'
import MarkdownIt from 'markdown-it'

// 用于 HTML 导出的独立 markdown-it 实例：commonmark + table/strikethrough
// 与 editor-schema 里的 tokenizer 分开，避免污染 schema 层的解析器
const exportMd = MarkdownIt('commonmark', { html: false }).enable(['table', 'strikethrough'])

const state = {
  vaultRoot: null, // 知识库根（绝对路径）
  currentFile: null, // 当前文档库内相对路径
  tempImportRoot: '', // 非空 = 当前 vaultRoot 来自 Word 导入的系统 temp 一次性目录（手动保存会升级为“另存为”）
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
  outlineMode: localStorage.getItem('nl-outline-mode') || 'all', // 'all' | '1'..'6'（默认全层级可见，与逐行收起正交）
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
  git: $('git'),
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
  sidebar: $('sidebar'),
  inspector: $('inspector'),
}

let editor
let findBar = null // 文档内查找栏控制器（boot 里 editor 装配后创建）
let palette = null
let keySettings = null
let gitPanel = null
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
  // mac 原生菜单的可用性/勾选随状态变（开库、开文档、模式、主题…），状态栏是所有这些路径的公共出口，
  // 在这里挂一次重建即可覆盖全部；spec 内容没变时 syncMacChrome 自行跳过
  scheduleMacChrome()
}

// 脏标记统一入口：编辑器与画布共用（驱动 dirty 样式 + 自动保存）
function markDirty(d) {
  state.dirty = d
  els.filename.classList.toggle('dirty', d)
  if (d) {
    scheduleAutosave()
  } else if (state.autosave.idleTimer) {
    // 变干净（已保存 / 撤销回原状）：清掉待触发的自动保存，避免多余写盘
    clearTimeout(state.autosave.idleTimer)
    state.autosave.idleTimer = null
  }
}

// 离开当前文档（切换 / 打开别处 / 新建）前处理未保存改动：
//  · 无改动 → 直接放行
//  · 开了自动保存 → 立即存一次再放行（避免切走后 pending 定时器存错文件）
//  · 未开自动保存 → 弹「保存 / 不保存 / 取消」；取消则中止操作
// 返回 true = 可继续离开，false = 取消（留在当前文档不切换）
async function ensureSavedBeforeLeave() {
  if (!state.dirty) return true
  if (state.autosave.enabled) {
    await saveCurrent(false)
    return !state.dirty
  }
  const choice = await confirm3Dialog({
    title: '未保存的更改',
    message: '「' + (state.currentFile || '当前文档') + '」尚未保存，是否保存更改？',
    confirmLabel: '保存',
    neutralLabel: '不保存',
    cancelLabel: '取消',
  })
  if (choice === 'cancel') return false
  if (choice === 'confirm') {
    await saveCurrent(true)
    return !state.dirty // 保存失败（仍脏）则不继续，避免丢改动
  }
  return true // 不保存：放弃改动继续
}

// 关闭窗口前若仍有未保存改动，走与切换文档一致的「保存 / 不保存 / 取消」询问。
// 本版 @tauri-apps/api：handler 会被 await，返回后若未 preventDefault 则框架自动 destroy()，
// 故取消时 preventDefault 保住窗口，保存/不保存时顺其自然关闭（需 core:window:allow-destroy 权限）。
function setupCloseGuard() {
  try {
    getCurrentWindow()
      .onCloseRequested(async (event) => {
        if (!(await ensureSavedBeforeLeave())) event.preventDefault()
      })
      .catch(() => {}) // 非 Tauri 环境（如纯浏览器预览）忽略
  } catch {
    /* 非 Tauri 环境，跳过 */
  }
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
  els.docstats.textContent = ''
  setIcon(els.docstats, 'pen', label)
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

// 侧栏整栏收起/展开（编辑区随之铺满）；状态持久化
function sidebarHidden() {
  return localStorage.getItem('nl-sidebar') === 'hidden'
}
function currentSideTab() {
  return localStorage.getItem('nl-side-tab') === 'outline' ? 'outline' : 'files'
}
function setSidebar(hidden) {
  localStorage.setItem('nl-sidebar', hidden ? 'hidden' : 'shown')
  if (els.sidebar) els.sidebar.classList.toggle('hidden', hidden)
  syncSideCorner()
}
function toggleSidebar() {
  const hidden = localStorage.getItem('nl-sidebar') !== 'hidden'
  setSidebar(hidden)
  setStatus(hidden ? '侧栏：已收起' : '侧栏：已展开')
}

// —— 侧栏「文件 / 大纲」共用一块区域：两 tab 互斥（Typora 式），tab 态持久化 ——
// 栏内 tab 与栏外常驻图标对（.side-corner）共用同一套引擎，不各存一份状态
let sideTabs = []
let sideCorner = []
function setSideTab(name) {
  const tab = name === 'outline' ? 'outline' : 'files'
  localStorage.setItem('nl-side-tab', tab)
  for (const b of sideTabs) {
    const on = b.getAttribute('data-tab') === tab
    b.classList.toggle('active', on)
    b.setAttribute('aria-selected', on ? 'true' : 'false')
  }
  if (els.tree) els.tree.classList.toggle('hidden', tab !== 'files')
  if (els.outline) els.outline.classList.toggle('hidden', tab !== 'outline')
  syncSideCorner()
}
function syncSideCorner() {
  const tab = currentSideTab()
  for (const b of sideCorner) b.classList.toggle('active', !sidebarHidden() && b.getAttribute('data-tab') === tab)
}
// 栏外图标的三种落点：收起 → 开栏到该 tab；开着但在另一 tab → 切过去；正停在该 tab → 收起整栏
function openSidebarOn(name) {
  const tab = name === 'outline' ? 'outline' : 'files'
  if (!sidebarHidden() && currentSideTab() === tab) {
    toggleSidebar()
    return
  }
  if (sidebarHidden()) toggleSidebar()
  setSideTab(tab)
}
function bindSideTabs() {
  sideTabs = [...document.querySelectorAll('.side-tab')]
  for (const b of sideTabs) b.addEventListener('click', () => setSideTab(b.getAttribute('data-tab')))
  sideCorner = [...document.querySelectorAll('.side-corner-btn[data-tab]')]
  for (const b of sideCorner) b.addEventListener('click', () => openSidebarOn(b.getAttribute('data-tab')))
  const insp = document.getElementById('btn-inspector')
  if (insp) insp.addEventListener('click', toggleInspector)
  setSideTab(currentSideTab())
  syncInspector()
}
// —— 检查器（右栏）：文档属性 / 标签 / 双向链接 / 历史 / Git / 插件；左栏只留文件与大纲 ——
function inspectorHidden() {
  return localStorage.getItem('nl-inspector') === 'hidden'
}
function syncInspector() {
  const hidden = inspectorHidden()
  if (els.inspector) els.inspector.classList.toggle('hidden', hidden)
  const body = document.querySelector('.body')
  if (body) body.classList.toggle('inspector-on', !hidden)
  const btn = document.getElementById('btn-inspector')
  if (btn) btn.classList.toggle('active', !hidden)
}
function setInspector(hidden) {
  localStorage.setItem('nl-inspector', hidden ? 'hidden' : 'shown')
  syncInspector()
}
function toggleInspector() {
  const hidden = !inspectorHidden()
  setInspector(hidden)
  setStatus(hidden ? '检查器：已收起' : '检查器：已展开')
}

// —— 左右栏宽度：按住分隔条直接拖；拖到不足 COL_W_COLLAPSE 就整栏收起，反向再拖回来（Typora 式）。
// 宽度写进 .body 的 CSS 变量并存 localStorage（收起不丢记忆宽），双击分隔条回默认宽 ——
const COL_W_KEY = { sidebar: 'nl-w-sidebar', inspector: 'nl-w-inspector' }
const COL_W_VAR = { sidebar: '--nl-side-w', inspector: '--nl-insp-w' }
const COL_W_MIN = 180
const COL_W_MAX = 520
const COL_W_DEFAULT = 280
const COL_W_COLLAPSE = 90
const COL_W_LABEL = { sidebar: '侧栏', inspector: '检查器' }
function clampColWidth(w) {
  return Math.max(COL_W_MIN, Math.min(COL_W_MAX, Math.round(w)))
}
function colWidth(which) {
  const n = Number(localStorage.getItem(COL_W_KEY[which]))
  return n >= COL_W_MIN && n <= COL_W_MAX ? n : COL_W_DEFAULT
}
function applyColWidths() {
  const body = document.querySelector('.body')
  if (!body) return
  body.style.setProperty(COL_W_VAR.sidebar, colWidth('sidebar') + 'px')
  body.style.setProperty(COL_W_VAR.inspector, colWidth('inspector') + 'px')
}
// 显隐复用 setSidebar / setInspector 一条路：栏外图标态、localStorage 收起态都跟着走
function setColShown(which, shown) {
  if (which === 'sidebar') {
    if (sidebarHidden() === shown) setSidebar(!shown)
  } else if (inspectorHidden() === shown) setInspector(!shown)
}
function bodyWidthAt(which, clientX) {
  const body = document.querySelector('.body')
  if (!body) return COL_W_DEFAULT
  const r = body.getBoundingClientRect()
  // 用指针相对 .body 的绝对位置定宽：中途收起/展开改变不了基准，手不会跳
  return Math.round(which === 'sidebar' ? clientX - r.left : r.right - clientX)
}
function bindColResizers() {
  applyColWidths()
  for (const which of ['sidebar', 'inspector']) {
    const g = document.getElementById(which === 'sidebar' ? 'gutter-side' : 'gutter-insp')
    const col = els[which]
    if (!g || !col) continue
    const label = COL_W_LABEL[which]
    g.addEventListener('pointerdown', (e) => {
      e.preventDefault()
      g.classList.add('dragging')
      col.classList.add('is-resizing')
      let w = bodyWidthAt(which, e.clientX)
      const move = (ev) => {
        w = bodyWidthAt(which, ev.clientX)
        if (w < COL_W_COLLAPSE) {
          setColShown(which, false)
          return
        }
        setColShown(which, true)
        const body = document.querySelector('.body')
        if (body) body.style.setProperty(COL_W_VAR[which], Math.min(COL_W_MAX, w) + 'px')
      }
      const up = () => {
        window.removeEventListener('pointermove', move)
        window.removeEventListener('pointerup', up)
        window.removeEventListener('pointercancel', up)
        g.classList.remove('dragging')
        col.classList.remove('is-resizing')
        if (w < COL_W_COLLAPSE) {
          applyColWidths() // 拖没的这次不记账：变量回到记住的宽度，下次展开即恢复
          setStatus(label + '：已收起')
          return
        }
        const saved = clampColWidth(w)
        localStorage.setItem(COL_W_KEY[which], String(saved))
        applyColWidths()
        setStatus(label + '宽度：' + saved + 'px')
      }
      window.addEventListener('pointermove', move)
      window.addEventListener('pointerup', up)
      window.addEventListener('pointercancel', up)
    })
    g.addEventListener('dblclick', () => {
      localStorage.removeItem(COL_W_KEY[which])
      applyColWidths()
      setStatus(label + '宽度：默认')
    })
  }
}
// 无标题可列时「大纲」入口置灰（栏内 tab 与栏外图标同进退，不渲染空态文案）；正停在大纲上则回落到文件
function syncOutlineTab(hasHeadings) {
  for (const list of [sideTabs, sideCorner]) {
    const btn = list.find((b) => b.getAttribute('data-tab') === 'outline')
    if (btn) btn.disabled = !hasHeadings
  }
  if (!hasHeadings && currentSideTab() === 'outline') setSideTab('files')
}

// —— 大纲：层级树（大标题常显、其下子级整节可收，含多级后代）——
// 收起态存内存（行号集合），换文档即清——与正文标题折叠同一约定，不持久化
let outlineItems = []
let outlineCollapsed = new Set()
let outlineFoldDoc
function renderOutline() {
  const ol = els.outline
  if (!ol) return
  const rows = analyzeOutline(outlineItems)
  if (outlineFoldDoc !== state.currentFile) {
    outlineFoldDoc = state.currentFile
    outlineCollapsed = collapsedRowsForMode(rows, state.outlineMode)
  }
  // 档位工具条：档位只给「默认收起哪些行」，之后逐行三角仍可自由开合
  const setMode = (m) => {
    state.outlineMode = m
    try { localStorage.setItem('nl-outline-mode', m) } catch (e) {}
    outlineCollapsed = collapsedRowsForMode(rows, m)
    renderOutline()
  }
  ol.innerHTML = ''
  ol.appendChild(renderOutlineToolbar(setMode))
  const hidden = hiddenRows(rows, outlineCollapsed)
  outlineItems.forEach((item, i) => {
    if (hidden.has(i)) return
    const row = document.createElement('div')
    row.className = 'outline-row level-' + rows[i].level
    if (rows[i].hasKids) {
      const folded = outlineCollapsed.has(i)
      const caret = document.createElement('button')
      caret.type = 'button'
      caret.className = 'outline-caret' + (folded ? ' folded' : '')
      caret.title = folded ? '展开' : '收起'
      setIcon(caret, 'chevron-down', '')
      caret.addEventListener('click', (e) => {
        e.preventDefault()
        e.stopPropagation()
        if (outlineCollapsed.has(i)) outlineCollapsed.delete(i)
        else outlineCollapsed.add(i)
        renderOutline()
      })
      row.appendChild(caret)
    } else {
      const sp = document.createElement('span')
      sp.className = 'outline-caret outline-caret-sp'
      row.appendChild(sp)
    }
    const a = document.createElement('a')
    a.className = 'outline-item'
    a.textContent = item.text || '（空标题）'
    a.href = '#'
    a.addEventListener('click', (e) => {
      e.preventDefault()
      editor.jumpToPos(item.pos)
    })
    row.appendChild(a)
    ol.appendChild(row)
  })
  syncOutlineTab(outlineItems.length > 0)
}

// 自动保存开关的唯一入口：复选框与命令注册表（含 mac 菜单勾选项）都走这里
function setAutosave(on) {
  state.autosave.enabled = !!on
  localStorage.setItem('nl-autosave', on ? '1' : '0')
  if (els.chkAutosave) els.chkAutosave.checked = !!on
  setStatus(on ? '自动保存已开启（2s 空闲）' : '自动保存已关闭')
  if (on && state.dirty) scheduleAutosave()
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
const THEME_LABEL = { light: ['sun', '浅色'], dark: ['moon', '暗黑'], vampire: ['contrast', 'Dracula'] }
function applyTheme(theme) {
  if (!THEMES.includes(theme)) theme = 'light'
  document.documentElement.setAttribute('data-theme', theme)
  // 深色族（暗黑 / 吸血鬼）共享一套派生样式，用 data-dark 统一命中
  document.documentElement.toggleAttribute('data-dark', theme === 'dark' || theme === 'vampire')
  localStorage.setItem('nl-theme', theme)
  setIcon(els.btnTheme, THEME_LABEL[theme][0], THEME_LABEL[theme][1])
  // 通知视图层按新主题重渲染依赖配色的部件（如 mermaid 图表）
  window.dispatchEvent(new Event('nl-theme-change'))
  if (editor) editor.setSourceTheme(theme)
  scheduleMacChrome() // 主题勾选项跟着走（mac 菜单）
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
    state.tempImportRoot = '' // 正式库接管，不再属于临时导入回显位
    const tree = await scanVault(root)
    renderTree(tree)
    setStatus('知识库已加载：' + root + '（索引构建中…）')
    startIndexPolling()
    if (pluginManager) pluginManager.reload()
    if (gitPanel) gitPanel.refresh()
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
    if (!(await ensureSavedBeforeLeave())) return
    const abs = await pickFile()
    if (!abs) return
    const { dir, name } = splitAbs(abs)
    state.vaultRoot = dir
    state.tempImportRoot = ''
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
    if (gitPanel) gitPanel.refresh()
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
  const docxList = list.filter((f) => /\.docx$/i.test(f.name || ''))
  const ok = list.filter((f) => isImportableFileName(f.name))
  const bad = list.filter((f) => !isImportableFileName(f.name) && !/\.docx$/i.test(f.name || ''))
  if (docxList.length) {
    // 拖入的 .docx：浏览器 File 无绝对路径 → 转 base64 走同一导入流
    const sources = []
    for (const f of docxList) {
      try {
        sources.push({ srcB64: await fileToBase64(f), displayName: f.name })
      } catch (e) {
        await messageDialog('读取失败 ' + f.name + '：' + errText(e))
      }
    }
    if (sources.length) await importWordFlow(sources, destDir)
  }
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

// ==================== 功能项 I：Word(.docx) → Markdown 校对导入 ====================

/** 「更多」菜单入口：选 .docx → 直接解析校对；已开库接受即落库，未开库接受时才问存到哪（取消=不保存） */
async function importWordViaDialog() {
  const paths = await pickDocxFiles()
  if (!paths || !paths.length) return
  const sources = paths.map((p) => ({ srcPath: p }))

  if (state.vaultRoot) {
    // 已开库：接受即落到当前文档所在夹（否则库根），走去重索引 + 刷树
    const destDir = state.currentFile ? parentOf(state.currentFile) : ''
    await importWordFlow(sources, destDir, { intoVault: true })
  } else {
    // 未开库：不选目录、不拦截，直接 preview→校对；「接受」即落系统 temp 一次性目录并立即打开，是否保存用户自决
    await importWordFlow(sources, '', { intoVault: false })
  }
}

/**
 * 导入编排的真实装配：把 bridge/Rust 与去重索引注入 runImport，校对回调开 docx-review 模态。
 * @param {Array<{srcPath?:string, srcB64?:string, displayName?:string}>} sources
 * @param {string} destDir  目标根内的相对目录（'' = 根）
 * @param {object} [target] { intoVault }——false = 独立解析模式：不选目录，「接受」即把转换结果写入
 *   系统 temp 的一次性目录（每篇自包含、不读写库级去重索引），完成后立即在编辑器打开（回显），
 *   是否长期保存（移走/另存）由用户自行决定。两种模式导入后都会自动打开首篇。
 */
async function importWordFlow(sources, destDir = '', target = {}) {
  const intoVault = target.intoVault !== false
  const vaultRoot = intoVault ? state.vaultRoot : ''
  if (intoVault && !vaultRoot) {
    setStatus('请先打开知识库文件夹')
    return
  }
  let tempRoot = '' // 独立模式：首次落盘时在系统 temp 建的一次性目录
  const committedRels = [] // 两种模式：已成功落盘的库内相对路径（供导入后立即打开回显）
  // 图片去重索引按知识库隔离：索引存的是「库内相对路径」，跨库复用会引用到别的库的路径而断图，
  // 故 key 带上 vaultRoot，每个库各一份（新库首次导入 = 空索引 → 图片正常复制到文档旁）。
  const indexKey = `${IMG_INDEX_KEY}:${vaultRoot}`
  const io = {
    preview: (args) => docxPreview(args),
    commit: async (args) => {
      if (intoVault) return docxCommit(args)
      // 独立保存：写进一次性 temp 目录；不传/不回共享索引，每篇自包含（图片必落盘、引用必对）
      if (!tempRoot) tempRoot = await ensureTempImportDir()
      const r = await docxCommit({ ...args, vaultRoot: tempRoot, dedupIndex: {} })
      return { ...r, updatedIndex: {} }
    },
    loadIndex: intoVault
      ? () => {
          try { return JSON.parse(localStorage.getItem(indexKey) || '{}') } catch { return {} }
        }
      : async () => ({}),
    saveIndex: intoVault ? (i) => localStorage.setItem(indexKey, JSON.stringify(i)) : async () => {},
    onCommitted: async (res) => {
      if (res && res.docRel) committedRels.push(res.docRel)
      if (intoVault) {
        renderTree(await scanVault(state.vaultRoot))
        startIndexPolling()
      }
    },
  }
  const review = (entry, ctx) =>
    openDocxReview(entry, {
      ...ctx,
      theme: document.documentElement.getAttribute('data-theme') || 'light',
      acceptLabel: intoVault ? '接受并落库' : '接受',
    })
  try {
    const res = await runImport({
      sources,
      io,
      review,
      onProgress: setStatus,
      opts: { vaultRoot, destDir, withFrontmatter: true, maxImageBytes: DEFAULT_MAX_IMAGE_BYTES },
    })
    const { committed, skipped, failed, total } = res.stats
    const tail = (skipped ? `，${skipped} 跳过` : '') + (failed ? `，${failed} 失败` : '')
    if (committedRels.length) {
      // 立即回显：独立模式先把 temp 一次性目录作为工作根打开（侧栏树列出全部导入篇、可点），再打开首篇
      if (!intoVault && tempRoot) {
        state.vaultRoot = tempRoot
        state.tempImportRoot = tempRoot
        state.currentFile = null
        renderTree(await scanVault(tempRoot))
        startIndexPolling()
        if (pluginManager) pluginManager.reload()
        if (gitPanel) gitPanel.refresh()
      }
      await openFile(committedRels[0])
      setStatus(`Word 导入完成：${committed}/${total} 篇` + (intoVault ? '入库' : '（临时目录，可自行保存）') + tail)
    } else {
      await messageDialog(`Word 导入：${committed}/${total} 篇` + (intoVault ? '入库' : '') + (skipped ? `，${skipped} 跳过/未接受` : '') + (failed ? `，${failed} 失败` : ''), 'info')
    }
  } catch (e) {
    await messageDialog('Word 导入失败：' + errText(e))
    setStatus('Word 导入失败')
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

// 递归收集库内 .md 文件 {name(去.md), rel}，供命令面板跳文档
function collectDocPaths(nodes) {
  const out = []
  const walk = (arr) => {
    ;(arr || []).forEach((n) => {
      if (n.type === 'file') {
        if (/\.md$/i.test(n.path)) out.push({ name: baseName(n.path).replace(/\.md$/i, ''), rel: n.path })
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
function makeMenuItem(label, fn, danger, checked, icon) {
  const b = document.createElement('button')
  b.className = 'cv-menu-item' + (danger ? ' danger' : '')
  const chk = document.createElement('span')
  chk.className = 'cv-menu-check'
  if (checked) setIcon(chk, 'check')
  b.appendChild(chk)
  const lab = document.createElement('span')
  lab.className = 'cv-menu-label'
  if (icon) setIcon(lab, icon, label)
  else lab.textContent = label
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
      tpls.forEach((p) => menu.appendChild(makeMenuItem(baseName(p).replace(/\.md$/i, ''), () => newFromTemplate(p), false, false, 'file')))
    }
    menu.appendChild(menuSep())
    menu.appendChild(makeMenuItem('今日速记（全局浮层，独立于知识库）', () => toggleDailyCapture(), false, false, 'calendar'))
    menu.appendChild(makeMenuItem('新建空白模板…', () => newBlankTemplate(), false, false, 'plus'))
    menu.appendChild(makeMenuItem('今日速记设置…', () => configureDailyCapture(), false, false, 'sliders'))
    const r = anchorEl.getBoundingClientRect()
    placeMenu(menu, r.left, r.bottom + 4)
  })
}

// 工具条「更多」菜单：收纳低频操作（导出/打印/图谱/画布/模板）与视图模式开关（专注/打字机）
function openMoreMenu(anchorEl) {
  closeTreeMenu()
  const menu = document.createElement('div')
  menu.className = 'cv-menu tree-menu'
  menu.appendChild(makeMenuItem('命令面板 (Ctrl+Shift+P)', () => palette && palette.open(), false, false, 'terminal'))
  menu.appendChild(makeMenuItem('快捷键设置…', () => keySettings && keySettings.open(), false, false, 'sliders'))
  menu.appendChild(makeMenuItem('导出为 HTML', () => exportHTML(), false, false, 'export'))
  menu.appendChild(makeMenuItem('导出整站…', () => exportSiteFull(), false, false, 'globe'))
    menu.appendChild(makeMenuItem('导入 Word(.docx)…', () => importWordViaDialog(), false, false, 'file'))
    menu.appendChild(makeMenuItem('导出 Word(.docx)…', () => exportWordViaDialog(), false, false, 'export'))
  menu.appendChild(makeMenuItem('打印 / 导出 PDF (Ctrl+P)', () => window.print(), false, false, 'printer'))
  menu.appendChild(makeMenuItem('知识图谱 (Ctrl+G)', () => openGraphModal(), false, false, 'graph'))
  menu.appendChild(makeMenuItem('新画布 / 白板', () => newCanvas(), false, false, 'board'))
  menu.appendChild(makeMenuItem('最近打开', () => openRecentMenu(anchorEl), false, false, 'clock'))
  menu.appendChild(makeMenuItem('模板 / 今日速记设置', () => openTemplateMenu(anchorEl), false, false, 'clipboard'))
  menu.appendChild(menuSep())
  menu.appendChild(makeMenuItem('专注模式 (Ctrl+Shift+F)', () => toggleFocusMode(), false, localStorage.getItem('nl-focus') === '1', 'target'))
  menu.appendChild(makeMenuItem('打字机模式 (Ctrl+Shift+T)', () => toggleTypewriterMode(), false, localStorage.getItem('nl-typewriter') === '1', 'keyboard'))
  const sbKey = commandBindingFor('app.toggleSidebar')
  menu.appendChild(makeMenuItem('侧栏' + (sbKey ? ' (' + sbKey + ')' : ''), () => toggleSidebar(), false, localStorage.getItem('nl-sidebar') !== 'hidden', 'sidebar'))
  const inKey = commandBindingFor('app.toggleInspector')
  menu.appendChild(makeMenuItem('检查器' + (inKey ? ' (' + inKey + ')' : ''), () => toggleInspector(), false, !inspectorHidden(), 'sliders'))
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
      const it = makeMenuItem(e.name, () => reopenRecent(e), false, false, 'file')
      it.title = e.root + '/' + e.rel
      menu.appendChild(it)
    })
    menu.appendChild(menuSep())
    menu.appendChild(makeMenuItem('清空最近记录', () => saveRecents([]), false, false, 'eraser'))
  }
  const r = anchorEl.getBoundingClientRect()
  placeMenu(menu, r.left, r.bottom + 4)
}
async function reopenRecent(entry) {
  if (!(await ensureSavedBeforeLeave())) return
  try {
    state.vaultRoot = entry.root
    state.tempImportRoot = ''
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
  if (!skipDirtyConfirm && !(await ensureSavedBeforeLeave())) return
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
  if (!(await ensureSavedBeforeLeave())) return
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
  // 独立解析模式（temp 一次性目录）下的手动保存 → 升级为“另存为”，避免默认行为就是默默覆写 temp
  if (manual && state.tempImportRoot && normVaultPath(state.vaultRoot) === normVaultPath(state.tempImportRoot)) {
    return saveTempAsFormal()
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
    if (gitPanel && manual) gitPanel.refresh()
  } catch (e) {
    if (manual) await messageDialog('保存失败：' + e)
    else console.warn('自动保存失败', e)
  }
}

/**
 * 独立解析模式下手动保存的“另存为”升级：先写一次 temp（保证即使取消弹框也不丢改动），
 * 然后让用户选一个正式目录，把 temp 目录整棵树递归拷过去（包含同次导入的其它篇与图），
 * 成功后把工作根切到新目录（退出“临时”态）。取消选目录 = 不丢数据，仅提示已存回临时。
 */
async function saveTempAsFormal() {
  const tempRoot = state.tempImportRoot
  try {
    // 1) 先把当前编辑器内容回写到 temp，确保取消弹框时不丢修改
    if (state.mode === 'canvas') {
      await canvasView.save()
    } else {
      await writeMdFile(tempRoot, state.currentFile, editor.getMarkdown())
      editor.markSaved()
    }
    // 2) 选目标目录
    const target = await pickFolder()
    if (!target) {
      setStatus('已保存到临时目录（未选择保存位置）')
      return
    }
    // 3) 递归拷贝整棵 temp → target（覆写同名，保留相对路径）
    await relocateImport(tempRoot, target)
    // 4) 切换工作根到新目录：同 rel 内容已存在，无需重开文件，只换 vaultRoot 标识
    state.vaultRoot = target
    state.tempImportRoot = ''
    renderTree(await scanVault(target))
    startIndexPolling()
    if (pluginManager) pluginManager.reload()
    if (gitPanel) gitPanel.refresh()
    setStatus('已另存为：' + target)
  } catch (e) {
    await messageDialog('另存为失败：' + ((e && e.message) || e))
    setStatus('另存为失败')
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
// 档位 → 默认收起集合：层级 ≥ 档位且真有子级的行先收起，效果等同「只展开到 H 档」。
// 写成收起集合而不是硬过滤，选完档位后逐行三角照样能开合。
function collapsedRowsForMode(rows, mode) {
  const s = new Set()
  const depth = parseInt(mode, 10) // 'all'、非法值、历史 'hide' → NaN → 不收起任何行
  if (!Number.isFinite(depth)) return s
  rows.forEach((r, i) => {
    if (r.hasKids && r.level >= depth) s.add(i)
  })
  return s
}

function renderOutlineToolbar(setMode) {
  const bar = document.createElement('div')
  bar.className = 'outline-toolbar'
  const btns = [
    { key: '1', label: 'H1', title: '展开到 H1' },
    { key: '2', label: 'H2', title: '展开到 H2' },
    { key: '3', label: 'H3', title: '展开到 H3' },
  ]
  for (const b of btns) {
    const el = document.createElement('button')
    el.type = 'button'
    el.textContent = b.label
    el.title = b.title
    el.dataset.mode = b.key
    el.classList.toggle('active', b.key === state.outlineMode)
    // 再点已选中的档位 = 回到全展开（原「全部展开」按钮的去处，不占位）
    el.addEventListener('click', () => setMode(b.key === state.outlineMode ? 'all' : b.key))
    bar.appendChild(el)
  }
  return bar
}

function onMetaChange({ outline, tags }) {
  outlineItems = Array.isArray(outline) ? outline : []
  renderOutline()

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

// —— 批次 F ①：当前文档 → Word(.docx)（前端产 Docx-IR，Rust export_docx 落盘）——

// 把 IR 内所有图片 src 解析为库根相对 rel（Rust 按 vaultRoot + rel 读字节）。
function irResolveImageRels(ir, fromDir, imageSet, byBase) {
  const fix = (arr) => {
    if (!Array.isArray(arr)) return
    for (const run of arr) {
      if (run && run.image && run.image.rel) {
        const resolved = resolveImageRel(fromDir, run.image.rel, imageSet, byBase)
        if (resolved) run.image.rel = resolved
      }
    }
  }
  for (const b of (ir && ir.blocks) || []) {
    if (b.inline) fix(b.inline)
    if (b.items) for (const it of b.items) fix(it.inline)
    if (b.type === 'table') {
      for (const cell of b.header || []) fix(cell)
      for (const row of b.rows || []) for (const cell of row) fix(cell)
    }
  }
}

async function exportWordViaDialog() {
  if (!editor) return
  if (state.mode === 'canvas') {
    setStatus('画布不支持导出 Word')
    return
  }
  try {
    const ir = docToIR(editor.view.state.doc)
    if (state.vaultRoot) {
      let imageSet = new Set()
      let byBase = new Map()
      try {
        const ci = collectImages(await scanVault(state.vaultRoot))
        imageSet = new Set(ci.images)
        byBase = ci.byBase
      } catch { /* 无树则图片按原样交给 Rust（缺失会记警告） */ }
      const file = String(state.currentFile || '').replace(/\\/g, '/')
      const fromDir = file.includes('/') ? file.slice(0, file.lastIndexOf('/')) : ''
      irResolveImageRels(ir, fromDir, imageSet, byBase)
    }
    const base = state.currentFile ? String(state.currentFile).replace(/\.(md|markdown)$/i, '') : 'document'
    const abs = await pickSaveAs(base + '.docx')
    if (!abs) return
    const r = await exportDocx({ ir, vaultRoot: state.vaultRoot || '', outPath: String(abs) })
    setStatus('已导出 Word：' + abs)
    if (r && r.warnings && r.warnings.length) {
      await messageDialog('导出完成（含提示）：\n' + r.warnings.map((w) => '· ' + w.message).join('\n'), 'info')
    }
  } catch (e) {
    await messageDialog('导出失败：' + ((e && e.message) || e))
  }
}

// —— 批次 C：导出整站为静态 HTML ——
async function exportSiteFull() {
  if (!state.vaultRoot) {
    setStatus('需先打开知识库文件夹才能导出整站')
    return
  }
  const outDir = await pickFolder()
  if (!outDir) return
  setStatus('开始导出整站…')
  try {
    const io = {
      buildGraph: (vr) => buildSiteGraph(vr),
      scanTree: (vr) => scanVault(vr),
      readMd: (vr, rel) => readMdFile(vr, rel),
      writeFile: (absPath, content) => exportFile(absPath, content),
      copyAssets: (vr, rels, od) => copyVaultAssets(vr, rels, od),
    }
    const r = await exportSite({ vaultRoot: state.vaultRoot, outDir, io, setStatus })
    await messageDialog(`整站导出完成：${r.ok} 篇成功` + (r.failed ? `，${r.failed} 篇跳过` : '') + '\n输出目录：' + outDir, 'info')
  } catch (e) {
    await messageDialog('整站导出失败：' + ((e && e.message) || e))
    setStatus('整站导出失败')
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

// —— 快捷键（应用级）：统一命令注册表 + 全局分发器（批次 D）——
// 命令集中注册为闭包；分发器读「默认键 ∪ localStorage['nl-keymap'] 覆盖」的有效绑定，
// 取代旧的硬编码 if/else 链。editor / plugin 命令在后续步骤并入同一注册表。
const commandRegistry = createRegistry()
const IS_MAC = detectIsMac()
let effectiveKeymap = new Map() // 解析后键形 → 命令 id

// 读用户覆盖；损坏 JSON 视为空覆盖（回退默认）
function loadKeymapOverrides() {
  try {
    const raw = localStorage.getItem('nl-keymap')
    const obj = raw ? JSON.parse(raw) : null
    return obj && typeof obj === 'object' ? obj : {}
  } catch {
    return {}
  }
}

// 重算全局分发的有效绑定表：仅 app/plugin（editor 命令留在 PM keymap，见 editor-view）
function rebuildKeymap() {
  const cmds = commandRegistry.list().filter((c) => c.category !== 'editor')
  const { map } = effectiveBindings(cmds, loadKeymapOverrides(), IS_MAC)
  effectiveKeymap = map
}

function registerAppCommands() {
  const app = (id, title, defaultKey, run) =>
    commandRegistry.register({ id, title, category: 'app', defaultKey, run })
  app('app.save', '保存当前文件', 'Mod-s', () => saveCurrent(true))
  app('app.openFile', '打开单个文件', 'Mod-o', () => openSingleFile())
  app('app.openFolder', '打开知识库文件夹', 'Mod-Shift-o', () => openFolder())
  // Ctrl+F = 当前文档内查找（Typora/Obsidian 语义）；全库搜索改到 Ctrl+Shift+F
  app('app.findInDoc', '在本篇文档中查找', 'Mod-f', () => {
    if (editor && state.mode === 'md' && !editor.isSourceMode()) findBar && findBar.open()
  })
  app('app.search', '聚焦侧栏搜索', 'Mod-Shift-f', () => { setSidebar(false); els.searchInput.focus(); els.searchInput.select() })
  // 打印收窄为纯 Ctrl+P：旧实现 key==='p' 未排除 shift，会吞掉 Ctrl+Shift+P（留给命令面板）
  app('app.print', '打印 / 另存 PDF', 'Mod-p', () => window.print())
  app('app.graph', '打开知识图谱', 'Mod-g', () => openGraphModal())
  app('app.dailyCapture', '今日速记', 'Mod-Shift-d', () => toggleDailyCapture())
  app('app.focusMode', '专注模式', 'Mod-Shift-e', () => toggleFocusMode())
  app('app.typewriterMode', '打字机模式', 'Mod-Shift-t', () => toggleTypewriterMode())
  app('app.toggleSidebar', '隐藏 / 显示侧栏', 'Mod-Shift-s', () => toggleSidebar())
  app('app.toggleInspector', '隐藏 / 显示检查器', 'Mod-Shift-i', () => toggleInspector())
  app('app.sourceMode', 'Markdown 源码模式', 'Mod-/', () => toggleSourceMode())
  app('app.palette', '命令面板', 'Mod-Shift-p', () => { if (palette) palette.open() })
  // 以下原先只挂在「更多」菜单里：入注册表后 mac 原生菜单可直接取用（一处定义，两处消费）
  app('app.shortcuts', '快捷键设置…', null, () => { if (keySettings) keySettings.open() })
  app('app.export', '导出为 HTML', null, () => exportHTML())
  app('app.exportSite', '导出整站…', null, () => exportSiteFull())
  app('app.newCanvas', '新画布 / 白板', null, () => newCanvas())
  app('app.newTemplate', '新建空白模板…', null, () => newBlankTemplate())
  app('app.dailySettings', '今日速记设置…', null, () => configureDailyCapture())
  app('app.autosave', '自动保存', null, () => setAutosave(!state.autosave.enabled))
  app('app.clearRecents', '清空最近记录', null, () => saveRecents([]))
  // 批次 E（L）：本地 Git（无默认键，避免抢占既有快捷键；可在快捷键设置里自行绑定）
  app('app.git.refresh', 'Git：刷新状态', null, () => { if (gitPanel) gitPanel.refresh() })
  app('app.git.commit', 'Git：提交全部…', null, () => { if (gitPanel) gitPanel.commitAll() })
  app('app.git.init', 'Git：初始化仓库', null, () => { if (gitPanel) gitPanel.init() })
  // 批次 E（R1）：Git 远程（认证 + 快进 pull）——run 委托给面板暴露的方法；面板未就绪则无操作
  app('app.git.fetch', 'Git：抓取远端', null, () => { if (gitPanel) gitPanel.fetch() })
  app('app.git.pull', 'Git：拉取（仅快进）', null, () => { if (gitPanel) gitPanel.pull() })
  // 批次 E（R2）：Git push（当前分支 → upstream）
  app('app.git.push', 'Git：推送到远端', null, () => { if (gitPanel) gitPanel.push() })
    // 批次 E（R3）：合并拉取（非 ff-only，冲突交面板解决）
    app('app.git.pullMerge', 'Git：拉取（合并）…', null, () => { if (gitPanel) gitPanel.merge() })
  app('app.git.remote', 'Git：设置远端 origin…', null, () => { if (gitPanel) gitPanel.setupRemote() })
}

// 批次 E（R1）· pull 改动磁盘文件后的编辑器集成（spec §6.4）：
//  · 重扫文件树 + 重建索引 + 刷双链/全局标签（复用 openFolder 那套）
//  · 当前打开文档：脏则询问是否放弃本地改动重载，净则直接回灌新内容
// 由 git-panel 的快进 pull 成功后回调（面板不直接碰编辑器，保持解耦）。
async function afterRemotePull() {
  if (!state.vaultRoot) return
  try {
    renderTree(await scanVault(state.vaultRoot))
  } catch (_) {
    /* 重扫失败不阻断后续 */
  }
  startIndexPolling()
  // 当前文档按脏/净态处理（仅 md 模式；画布不受 pull 影响）
  const cf = state.currentFile
  if (cf && state.mode === 'md') {
    const reload = async () => {
      try {
        const md = await readMdFile(state.vaultRoot, cf)
        editor.setMarkdown(md)
        markDirty(false)
        refreshLinkPanels()
      } catch (_) {
        /* 文件可能被删，忽略 */
      }
    }
    if (state.dirty) {
      const ok = await confirmDialog('远端可能更新了当前文档，是否放弃本地未保存改动并重新加载？', '拉取冲突')
      if (ok) await reload()
    } else {
      await reload()
    }
  }
}

// editor 命令入注册表：与 app 同一张表（面板可列、可重绑），但执行经 ctx.runEditorCommand 转给 PM
// 注：全局分发器不跳 editor 类（已按 category 过滤），避免与 PM keymap 重复触发
function registerEditorCommands() {
  for (const def of EDITOR_COMMANDS) {
    commandRegistry.register({
      id: def.id,
      title: def.title,
      category: 'editor',
      defaultKey: def.defaultKey,
      when: 'editor',
      run: (ctx) => ctx.runEditorCommand(def.id),
    })
  }
}

// 传给 commandRegistry.run 的执行上下文
function commandCtx() {
  return {
    setStatus,
    registry: commandRegistry,
    // editor 命令经编辑器实例执行（面板/设置页「主动执行」用）
    runEditorCommand: (id) => (editor ? editor.runEditorCommand(id) : false),
    focusEditor: () => { if (editor) editor.focusEditor() },
  }
}

// 命令当前有效键的可读形式（面板右侧提示）：覆盖 ∪ 默认，按平台展示
function commandBindingFor(id) {
  const cmd = commandRegistry.get(id)
  if (!cmd) return ''
  const ov = loadKeymapOverrides()
  const chosen = Object.prototype.hasOwnProperty.call(ov, id) ? ov[id] : cmd.defaultKey
  if (!chosen) return ''
  return formatBinding(chosen, IS_MAC)
}

// —— macOS 原生菜单（系统菜单栏）——
// 菜单不带第二份文案或快捷键：每次从命令注册表 + 覆盖表现算 spec，一次 IPC 交 Rust 整份重建。
// 装配失败（纯 web 构建 / 缺能力授权 / 原生侧抛错）时 data-mac 不落地并回显状态栏，
// 窗口内工具条与既有分发器原样保留——入口不能因为菜单挂不上而消失。
let macMenuOn = false
let macChromeTimer = null
let macMenuSig = ''
let macTitle = ''
const lastRunAt = new Map()

const MENU_NEEDS_DOC = new Set(['app.save', 'app.export', 'app.print'])
const MENU_NEEDS_VAULT = new Set(['app.exportSite', 'app.newCanvas', 'app.newTemplate', 'app.graph'])
const MENU_CHECKED = {
  'app.focusMode': () => localStorage.getItem('nl-focus') === '1',
  'app.typewriterMode': () => localStorage.getItem('nl-typewriter') === '1',
  'app.toggleSidebar': () => localStorage.getItem('nl-sidebar') !== 'hidden',
  'app.toggleInspector': () => !inspectorHidden(),
  'app.autosave': () => state.autosave.enabled,
  'app.sourceMode': () => !!(editor && editor.isSourceMode()),
}

function menuEnabled(id) {
  if (MENU_NEEDS_DOC.has(id) && !state.currentFile) return false
  // PM 编辑命令只在所见即所得的文档上可用（画布 / 未打开文档时置灰）
  if (id.startsWith('editor.') && !(state.currentFile && state.mode === 'md')) return false
  if (MENU_NEEDS_VAULT.has(id) && !state.vaultRoot) return false
  return true
}

function menuCommands() {
  const ov = loadKeymapOverrides()
  // 当前块类型：「段落」组的勾（单选语义，同 Typora）与标题升/降级的可用性都读它
  const active = (editor && editor.activeBlock && editor.activeBlock()) || null
  const isH = active && /^h[1-6]$/.test(active) ? Number(active.slice(1)) : 0
  return commandRegistry.list().map((c) => {
    const raw = Object.prototype.hasOwnProperty.call(ov, c.id) ? ov[c.id] : c.defaultKey
    const out = { id: c.id, title: c.title, accelerator: toAccelerator(raw), enabled: menuEnabled(c.id) }
    const check = MENU_CHECKED[c.id]
    if (check) out.checked = check()
    if (c.id.startsWith('editor.block.')) out.checked = c.id === 'editor.block.' + active
    if (c.id === 'editor.headingUp') out.enabled = out.enabled && isH > 1
    if (c.id === 'editor.headingDown') out.enabled = out.enabled && isH > 0 && isH < 6
    return out
  })
}

function menuSpecCtx() {
  const theme = document.documentElement.getAttribute('data-theme') || 'light'
  return {
    commands: menuCommands(),
    recents: loadRecents().map((e, i) => ({ id: 'recent:' + i, label: e.name })),
    templates: listMdInDir(TEMPLATE_DIR()).map((p) => ({ id: 'tpl:' + p, label: baseName(p).replace(/\.md$/i, '') })),
    themes: THEMES.map((name) => ({ id: 'theme:' + name, label: THEME_LABEL[name][1], checked: name === theme })),
  }
}

function onMenuSelect(id) {
  if (!id || id === 'nl.noop') return
  if (id.startsWith('recent:')) {
    const e = loadRecents()[Number(id.slice('recent:'.length))]
    if (e) reopenRecent(e)
    return
  }
  if (id.startsWith('tpl:')) {
    newFromTemplate(id.slice('tpl:'.length))
    return
  }
  if (id.startsWith('theme:')) {
    applyTheme(id.slice('theme:'.length))
    scheduleMacChrome()
    return
  }
  runViaShortcut(id)
}

// 同一条绑定的两个入口：窗口内 keydown 分发器与 mac 菜单 accelerator。
// macOS 通常由菜单吃掉按键，但装配结果不保证一致，故 200ms 内同一命令只执行一次。
function runViaShortcut(id) {
  // 系统预定义项（Cut/Copy/Quit…，id 形如 builtin:*）由原生侧自己处理，不进注册表
  if (!commandRegistry.get(id)) return
  const now = Date.now()
  if (now - (lastRunAt.get(id) || 0) < 200) return
  lastRunAt.set(id, now)
  try {
    commandRegistry.run(id, commandCtx())
  } catch (err) {
    setStatus('命令执行失败：' + ((err && err.message) || err))
  }
  scheduleMacChrome()
}

function scheduleMacChrome() {
  if (!IS_MAC) return
  clearTimeout(macChromeTimer)
  macChromeTimer = setTimeout(syncMacChrome, 150)
}

async function syncMacChrome() {
  syncWindowTitle()
  if (!macMenuOn) return
  try {
    await pushMacMenu()
  } catch (e) {
    console.warn('原生菜单重建失败', e)
  }
}

// 一次 IPC 换整棵菜单；spec 内容没变就跳过（setStatus 触发得很频繁）
async function pushMacMenu() {
  const spec = buildMacMenuSpec(menuSpecCtx())
  const sig = JSON.stringify(spec)
  if (sig === macMenuSig) return
  macMenuSig = sig
  try {
    await setMacMenu(spec)
  } catch (e) {
    macMenuSig = '' // 没落地，签名作废，下次状态变化时重试
    throw e
  }
}

// mac 的标题属于系统标题栏：当前文档名写进窗口标题，工具条里的文件名不再重复
function syncWindowTitle() {
  if (!IS_MAC || !window.__TAURI_INTERNALS__) return
  const name = (els.filename.textContent || '').trim() || 'NoteLume'
  if (name === macTitle) return
  macTitle = name
  getCurrentWindow()
    .setTitle(name)
    .catch(() => {
      /* 缺 core:window:allow-set-title 时静默跳过 */
    })
}

async function setupMacMenu() {
  if (!IS_MAC || !window.__TAURI_INTERNALS__) return
  try {
    await listen('nl:menu-select', (e) => onMenuSelect(e.payload))
    await pushMacMenu()
  } catch (e) {
    setStatus('mac 原生菜单不可用，已保留窗口内工具条：' + ((e && e.message) || e))
    return
  }
  macMenuOn = true
  document.documentElement.toggleAttribute('data-mac', true)
  // 词数统计上移到标题条右侧，与三个栏切换图标同组；底部状态条只留状态与主题
  const corner = document.querySelector('.side-corner')
  if (corner && els.docstats) corner.insertBefore(els.docstats, corner.firstChild)
  syncWindowTitle()
  // filename 由多处直接赋值，用观察器统一同步标题，避免逐个改调用点
  new MutationObserver(syncWindowTitle).observe(els.filename, { childList: true, characterData: true, subtree: true })
}

// 保存覆盖表到 localStorage 并令两层同时生效：重建全局分发器 + 热重配编辑器 keymap + 重挂原生菜单键
function saveKeymapOverrides(overrides) {
  const ov = overrides && typeof overrides === 'object' ? overrides : {}
  try {
    localStorage.setItem('nl-keymap', JSON.stringify(ov))
  } catch (e) {
    setStatus('保存快捷键失败：' + ((e && e.message) || e))
    return
  }
  rebuildKeymap()
  if (editor) editor.setKeymapOverrides(ov)
  scheduleMacChrome()
}

function bindShortcuts() {
  registerAppCommands()
  registerEditorCommands()
  rebuildKeymap()
  if (editor) editor.setKeymapOverrides(loadKeymapOverrides()) // 编辑器层：应用持久化的重绑
  document.addEventListener('keydown', (e) => {
    if (!(e.ctrlKey || e.metaKey || e.altKey)) return
    const logical = eventToBinding(e, IS_MAC)
    if (!logical) return
    const id = effectiveKeymap.get(resolveBinding(logical, IS_MAC))
    if (!id) return
    e.preventDefault()
    runViaShortcut(id)
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
    onSelectionChange: () => scheduleMacChrome(),
  })

  // 文档内查找栏：挂到编辑区容器（.editor-pane，relative 且为滚动容器），命令式驱动 find 插件
  findBar = createFindBar({ view: editor.view, paneEl: els.editor.parentElement })

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
  setSidebar(localStorage.getItem('nl-sidebar') === 'hidden')
  bindSideTabs()
  bindColResizers()

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

  // 批次 E（L + R1）本地 + 远程 Git 面板：本地探测/status/log/diff/提交/初始化 + 远程同步区（fetch/快进 pull/远端增改）
  gitPanel = createGitPanel({
    rootEl: els.git,
    getVaultRoot: () => state.vaultRoot,
    escapeHtml,
    setStatus,
    onPullDone: () => afterRemotePull(),
    openFile: (rel) => openFile(rel),
  })
  gitPanel.refresh()

  // P2 插件钩子系统：打开知识库后从 .notelume-plugins/ 加载（依赖已装配的 editor.view）
  pluginManager = createPluginManager({
    view: editor.view,
    panelEl: els.plugins,
    setStatus,
    getVaultRoot: () => state.vaultRoot,
    commandRegistry,
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
  els.chkAutosave.addEventListener('change', () => setAutosave(els.chkAutosave.checked))

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
  palette = createPalette({
    getCommands: () => commandRegistry.list(),
    getDocs: () => collectDocPaths(state.tree),
    runCommand: (id) => {
      try {
        commandRegistry.run(id, commandCtx())
      } catch (e) {
        setStatus('命令执行失败：' + ((e && e.message) || e))
      }
    },
    openFile: (rel) => openFile(rel),
    bindingFor: commandBindingFor,
  })
  keySettings = createShortcutSettings({
    getCommands: () => commandRegistry.list(),
    getOverrides: loadKeymapOverrides,
    saveOverrides: saveKeymapOverrides,
    isMac: IS_MAC,
    setStatus,
  })
  bindShortcuts()
  setupCloseGuard()
  setupMacMenu()

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
