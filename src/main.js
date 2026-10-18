// main.js —— 应用装配：布局、知识库文件树、大纲、标签、主题、快捷键、打开/保存/跳转
// P1 追加：Rust 索引触发与轮询、双向链接面板、全局搜索、悬浮预览（在 editor-view 里挂）、
// 自动保存 + 库内备份、HTML 导出、打印。
import { createEditor, editorCommandDefs } from './editor-view.js'
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
  setUiLang,
  traySetRecent,
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
import { initTitlebar } from './titlebar.js'
import { openGraph } from './graph-view.js'
import { createSnapshotPanel } from './snapshot-panel.js'
import { createGitPanel } from './git-panel.js'
import { promptDialog } from './prompt-dialog.js'
import { confirm3Dialog } from './confirm3-dialog.js'
import { createPluginManager } from './plugin-loader.js'
import { createRegistry } from './commands.js'
import { createTabs } from './tabs.js'
import { detectIsMac, eventToBinding, resolveBinding, effectiveBindings, formatBinding, toAccelerator } from './keymap.js'
import { buildMacMenuSpec } from './app-menu.js'
import { createCanvasView } from './canvas-view.js'
import { openImage } from './img-viewer.js'
import { builtinVars, applyTemplate } from './template.js'
import { toggleDailyCapture, configureDailyCapture } from './daily-capture.js'
import { openAboutDialog } from './about-dialog.js'
import { countWords, statsLabel } from './writing-stats.js'
import { setIcon } from './icons.js'
import {
  createAppearanceSettings,
  applyAppearance,
  normalizeAppearance,
  clampSidebarRatio,
  THEME_CHOICES as THEMES,
  THEME_ICON,
} from './appearance-settings.js'
import { createSettingsStore } from './settings-store.js'
import { t, getLocale, setLocale, applyStaticDom, onLocaleChange, localeName } from './i18n.js'
import { LOCALES } from './locales/index.js'
import { analyzeOutline, hiddenRows } from './outline-tree.js'
import MarkdownIt from 'markdown-it'
import { tempDir, join } from '@tauri-apps/api/path'

// 用于 HTML 导出的独立 markdown-it 实例：commonmark + table/strikethrough
// 与 editor-schema 里的 tokenizer 分开，避免污染 schema 层的解析器
const exportMd = MarkdownIt('commonmark', { html: false }).enable(['table', 'strikethrough'])

const state = {
  vaultRoot: null, // 知识库根（绝对路径）
  currentFile: null, // 当前文档库内相对路径
  tempImportRoot: '', // 非空 = 当前 vaultRoot 来自 Word 导入的系统 temp 一次性目录（手动保存会升级为“另存为”）
  scratch: false, // true = 当前文档是「新建到系统临时目录、还没选保存位置」的文件（Ctrl+S / 关闭时会问位置）
  scratchRoot: (() => { try { return localStorage.getItem('nl-scratch-dir') } catch { return null } })(), // 上述临时目录的绝对路径
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
  tabs: $('tabbar'),
  btnOpen: $('btn-open'),
  btnOpenFile: $('btn-open-file'),
  btnNewFile: $('btn-new-file'),
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
let tabs = null // 标签页（文档 tabs）控制器，boot 里创建
let palette = null
let keySettings = null
let apSettings = null // 「设置-外观」面板（appearance-settings.js）
let settingsStore = null // settings.json 读写（boot 最开始装配）
let gitPanel = null
let snapshotPanel = null
let frontmatterPanel = null
let pluginManager = null
let canvasView = null

// 画布文件判定（JSON Canvas 规范）
function isCanvasPath(p) {
  return /\.canvas$/i.test(p || '')
}

// 状态提示已从界面去掉（右下角浮版不好看也没意义），这里只保留 mac 原生菜单
// 可用性/勾选的重建触发与 console 记录，便于排查
function setStatus(msg) {
  console.debug('[status] ' + msg)
  // mac 原生菜单的可用性/勾选随状态变（开库、开文档、模式、主题…），所有这些路径的公共出口，
  // 在这里挂一次重建即可覆盖全部；spec 内容没变时 syncMacChrome 自行跳过
  scheduleMacChrome()
}

// 脏标记统一入口：编辑器与画布共用（驱动 dirty 样式 + 自动保存）
function markDirty(d) {
  state.dirty = d
  els.filename.classList.toggle('dirty', d)
  if (tabs) tabs.setDirty(d)
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
    title: t('dlg.unsavedTitle'),
    message: t('dlg.unsavedMsg', { name: state.currentFile || t('dlg.curDoc') }),
    confirmLabel: t('common.save'),
    neutralLabel: t('common.dontSave'),
    cancelLabel: t('common.cancel'),
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
    label += t('stats.goal', { goal, pct })
  }
  els.docstats.textContent = ''
  setIcon(els.docstats, 'pen', label)
}

function toggleFocusMode() {
  const on = localStorage.getItem('nl-focus') !== '1'
  localStorage.setItem('nl-focus', on ? '1' : '0')
  if (editor) editor.setFocusMode(on)
  setStatus(on ? t('status.focusOn') : t('status.focusOff'))
}

function toggleTypewriterMode() {
  const on = localStorage.getItem('nl-typewriter') !== '1'
  localStorage.setItem('nl-typewriter', on ? '1' : '0')
  if (editor) editor.setTypewriterMode(on)
  setStatus(on ? t('status.typewriterOn') : t('status.typewriterOff'))
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
  setStatus(hidden ? t('status.colHidden', { label: t('col.sidebar') }) : t('status.colShown', { label: t('col.sidebar') }))
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
  setStatus(hidden ? t('status.colHidden', { label: t('col.inspector') }) : t('status.colShown', { label: t('col.inspector') }))
}

// —— 左右栏宽度：按住分隔条直接拖；拖到不足 COL_W_COLLAPSE 就整栏收起，反向再拖回来（Typora 式）。
// 宽度写进 .body 的 CSS 变量并存 localStorage（收起不丢记忆宽），双击分隔条回默认宽 ——
const COL_W_KEY = { sidebar: 'nl-w-sidebar', inspector: 'nl-w-inspector' }
const COL_W_VAR = { sidebar: '--nl-side-w', inspector: '--nl-insp-w' }
const COL_W_MIN = 180
const COL_W_MAX = 520
const COL_W_DEFAULT = 280
const COL_W_COLLAPSE = 90
const COL_W_LABEL = { sidebar: () => t('col.sidebar'), inspector: () => t('col.inspector') }
function clampColWidth(w) {
  return Math.max(COL_W_MIN, Math.min(COL_W_MAX, Math.round(w)))
}
// 侧栏宽度的两个来源：设置页的比例（settings.json，跨会话、随窗口尺寸折算）与
// 分隔条拖出来的像素记忆（localStorage）。比例设过就优先；没设过走原来的逻辑。
function colWidth(which) {
  if (which === 'sidebar') {
    const ratio = currentAppearance().sidebarRatio
    if (ratio != null) {
      const body = document.querySelector('.body')
      if (body) return clampColWidth(Math.round(ratio * body.clientWidth))
    }
  }
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
    const label = COL_W_LABEL[which]()
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
          setStatus(t('status.colHidden', { label }))
          return
        }
        const saved = clampColWidth(w)
        localStorage.setItem(COL_W_KEY[which], String(saved))
        applyColWidths()
        if (which === 'sidebar') {
          // 拖动结果折算成比例写进设置：窗口缩放后按比例重算，设置页的滑块也指着这里
          const body = document.querySelector('.body')
          if (body) persistAppearance({ sidebarRatio: clampSidebarRatio(saved / body.clientWidth) })
        }
        setStatus(t('status.colWidth', { label, n: saved }))
      }
      window.addEventListener('pointermove', move)
      window.addEventListener('pointerup', up)
      window.addEventListener('pointercancel', up)
    })
    g.addEventListener('dblclick', () => {
      localStorage.removeItem(COL_W_KEY[which])
      if (which === 'sidebar') persistAppearance({ sidebarRatio: null }) // 比例一起清掉，回默认宽
      applyColWidths()
      setStatus(t('status.colWidthDefault', { label }))
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
      caret.title = folded ? t('common.expand') : t('common.collapse')
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
    a.textContent = item.text || t('outline.emptyTitle')
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
  setStatus(on ? t('status.autosaveOn') : t('status.autosaveOff'))
  if (on && state.dirty) scheduleAutosave()
}

async function setWordGoal() {
  const cur = localStorage.getItem('nl-word-goal') || '0'
  const v = await promptDialog({ title: t('dlg.wordGoalTitle'), placeholder: t('dlg.wordGoalPh'), defaultValue: cur === '0' ? '500' : cur })
  if (v == null) return
  const n = parseInt(String(v).replace(/[^0-9]/g, ''), 10)
  localStorage.setItem('nl-word-goal', n > 0 ? String(n) : '0')
  updateDocStats()
}

async function toggleSourceMode() {
  if (!editor) return
  if (state.mode !== 'md') {
    setStatus(t('status.sourceOnlyMd'))
    return
  }
  const on = await editor.toggleSource()
  if (els.btnSource) els.btnSource.classList.toggle('active', on)
  setStatus(on ? t('status.sourceOn') : t('status.sourceOff'))
}

// —— 主题 ——（浅色 → 暗黑 → Dracula → 跟随系统 四态循环；按钮显示当前主题名，与界面实际一致）
// data-theme 始终是「落地」的具体主题（CSS 取色、mermaid / docx 预览等都读它）；
// data-theme-choice 记用户的选择，选 system 时落地主题随 OS 的 prefers-color-scheme 变。
// 主题名也走词条：按钮每次 applyTheme 时按当前语言重取，语言切换时整体刷一遍。
// THEMES / THEME_ICON 与设置页共用一份，定义在 appearance-settings.js。
function systemPrefersDark() {
  if (typeof window === 'undefined' || !window.matchMedia) return false
  return window.matchMedia('(prefers-color-scheme: dark)').matches
}
function resolveTheme(choice) {
  if (!THEMES.includes(choice)) choice = 'light'
  return choice === 'system' ? (systemPrefersDark() ? 'dark' : 'light') : choice
}
function currentThemeChoice() {
  return document.documentElement.getAttribute('data-theme-choice') || 'light'
}
function applyTheme(choice) {
  const applied = resolveTheme(choice)
  document.documentElement.setAttribute('data-theme', applied)
  document.documentElement.setAttribute('data-theme-choice', choice)
  // 深色族（暗黑 / 吸血鬼）共享一套派生样式，用 data-dark 统一命中
  document.documentElement.toggleAttribute('data-dark', applied === 'dark' || applied === 'vampire')
  setIcon(els.btnTheme, THEME_ICON[choice], t('theme.' + choice))
  // 通知视图层按新主题重渲染依赖配色的部件（如 mermaid 图表）
  window.dispatchEvent(new Event('nl-theme-change'))
  if (editor) editor.setSourceTheme(applied)
  scheduleMacChrome() // 主题勾选项跟着走（mac 菜单）
  persistAppearance({ theme: choice }) // 主题选择进 settings.json，重启后恢复
}
function toggleTheme() {
  const next = THEMES[(THEMES.indexOf(currentThemeChoice()) + 1) % THEMES.length]
  applyTheme(next)
}

// —— 应用设置（settings.json）——
// 外观状态（主题 / 颜色 / 字体 / 字号 / 行高 / 自动换行 / 侧栏比例）的唯一持久化通道。
// boot 里 await settingsStore.load() 读回后，下面的 applyTheme + applyAppearance 把
// 状态恢复到上次保存的样子；读不到（文件不存在 / 损坏）时 normalizeAppearance 给默认值。
function currentAppearance() {
  return normalizeAppearance(settingsStore ? settingsStore.get().appearance : null)
}

/** 合并改动进 settings.json 的 appearance 段（防抖写盘）；内容没变则不写 */
function persistAppearance(patch) {
  if (!settingsStore) return
  const prev = currentAppearance()
  const next = normalizeAppearance({ ...prev, ...patch })
  if (JSON.stringify(next) === JSON.stringify(prev)) return
  settingsStore.update({ appearance: next })
}

/** 设置面板的每次改动：主题切换 + 全量 CSS 变量 + 侧栏比例 → 像素，然后落盘 */
function applyAppearanceChange(next) {
  const ap = normalizeAppearance(next)
  if (ap.theme !== currentThemeChoice()) applyTheme(ap.theme)
  applyAppearance(document.documentElement.style, ap)
  persistAppearance(ap) // 先更新内存里的设置
  applyColWidths() // 再按新比例重算侧栏像素（clamp 在 colWidth 里）
  setStatus(t('ap.saved'))
}

// —— 打开文件夹作为知识库 ——
async function openFolder() {
  try {
    // 换库 = 离开当前文档：未保存改动先按切换文档的老规矩问（保存 / 不保存 / 取消）
    if (!(await ensureSavedBeforeLeave())) return
    const root = await pickFolder()
    if (!root) return
    if (!leaveCurrentVault(root)) {
      // 挑的就是当前库：什么都不动（也顺带保护已打开的标签页不被清掉）
      setStatus(t('status.inVault', { root }))
      return
    }
    state.vaultRoot = root
    state.tempImportRoot = '' // 正式库接管，不再属于临时导入回显位
    const tree = await scanVault(root)
    renderTree(tree)
    setStatus(t('status.vaultLoaded', { root }))
    startIndexPolling()
    // 面板按新库重取：反链 / 全局标签 / 快照列表都不许残留旧库内容
    refreshLinkPanels()
    refreshGlobalTags()
    if (snapshotPanel) snapshotPanel.refresh()
    if (pluginManager) pluginManager.reload()
    if (gitPanel) gitPanel.refresh()
  } catch (e) {
    const msg = (e && e.message) || e
    setStatus(t('status.openFailed', { msg }))
    await messageDialog(t('msg.openVaultFailed', { msg }))
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
  rebuildIndex(state.vaultRoot).catch((e) => console.warn(t('msg.rebuildIndexFailed'), e))
  const started = Date.now()
  const tick = async () => {
    try {
      const st = await getIndexStatus()
      if (st.ready && normVaultPath(st.vaultRoot) === normVaultPath(state.vaultRoot)) {
        state.indexReady = true
        setStatus(t('status.indexReady', { n: st.docs }))
        refreshLinkPanels()
        refreshGlobalTags()
        return
      }
    } catch (_) {
      /* ignore transient */
    }
    if (Date.now() - started < 60_000) setTimeout(tick, 500)
    else setStatus(t('status.indexTimeout'))
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
    leaveCurrentVault(dir) // 跨目录打开：旧根的标签页与文档态作废，避免还指着上一个库
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
    state.scratch = false
    setMode('md')
    editor.setMarkdown(md)
    updateDocStats() // setMode 里的刷新发生在换文档之前，这里按新内容补一次
    els.filename.textContent = abs
    renderSingleFileTree(name)
    setStatus(t('status.fileOpened', { abs }))
    recordRecent(dir, name)
    editor.focus()
    // 单文件也后台索引：库根就是同目录，反查更方便
    startIndexPolling()
    if (snapshotPanel) snapshotPanel.refresh()
    if (pluginManager) pluginManager.reload()
    if (gitPanel) gitPanel.refresh()
    if (tabs) tabs.open({ root: dir, rel: name })
  } catch (e) {
    const msg = (e && e.message) || e
    setStatus(t('msg.openFileFailedDlg', { msg }))
    await messageDialog(t('msg.openFileFailedDlg', { msg }))
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
    setStatus(t('status.moved', { from: srcRel, to: newRel }))
  } catch (e) {
    await messageDialog(t('msg.moveFailed', { err: errText(e) }))
  }
}

async function importDroppedFiles(files, destDir) {
  if (!state.vaultRoot) {
    setStatus(t('status.needVaultFolder'))
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
        await messageDialog(t('status.readFailed', { name: f.name, err: errText(e) }))
      }
    }
    if (sources.length) await importWordFlow(sources, destDir)
  }
  if (!ok.length) {
    if (bad.length) await messageDialog(t('msg.importTypeBad', { names: bad.map((f) => f.name).join(', ') }))
    return
  }
  const imported = []
  for (const f of ok) {
    try {
      const rel = await importVaultFileFrom(state.vaultRoot, destDir, f)
      imported.push(rel)
    } catch (e) {
      await messageDialog(t('msg.importFailed', { name: f.name, err: errText(e) }))
    }
  }
  if (imported.length) {
    renderTree(await scanVault(state.vaultRoot))
    startIndexPolling()
    setStatus(t('status.imported', { n: imported.length }))
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
    setStatus(t('status.needVaultFolder'))
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
      acceptLabel: intoVault ? t('dlg.docxAcceptVault') : t('dlg.docxAccept'),
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
    const tail = (skipped ? t('msg.tailSkipped', { n: skipped }) : '') + (failed ? t('msg.tailFailed', { n: failed }) : '')
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
      setStatus(t('status.wordImportDone', {
        done: committed,
        total,
        where: intoVault ? t('doc.importWhereVault') : t('doc.importWhereTemp'),
        tail,
      }))
    } else {
      await messageDialog(t('msg.wordImportDone', {
        done: committed,
        total,
        where: intoVault ? t('doc.importWhereVault') : '',
        tail: (skipped ? t('msg.skippedUnaccepted', { n: skipped }) : '') + (failed ? t('msg.tailFailed', { n: failed }) : ''),
      }), 'info')
    }
  } catch (e) {
    await messageDialog(t('msg.wordImportFailedDlg', { err: errText(e) }))
    setStatus(t('status.wordImportFailed'))
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
    menu.appendChild(makeMenuItem(t('menu.open'), () => openFile(node.path)))
    menu.appendChild(makeMenuItem(t('menu.renameMove'), () => renameEntry(node.path, node.name, false)))
    menu.appendChild(menuSep())
    menu.appendChild(makeMenuItem(t('menu.trash'), () => deleteVaultFile(node.path, node.name), true))
  } else {
    menu.appendChild(makeMenuItem(t('menu.newFileEllipsis'), () => newFileIn(node.path)))
    menu.appendChild(makeMenuItem(t('menu.newFolderEllipsis'), () => newFolderIn(node.path)))
    menu.appendChild(menuSep())
    menu.appendChild(makeMenuItem(t('menu.renameMove'), () => renameEntry(node.path, node.name, true)))
  }
  placeMenu(menu, clientX, clientY)
}

// —— 文件树空白区右键：在库根新建 ——
function showTreeBgMenu(clientX, clientY) {
  closeTreeMenu()
  const menu = document.createElement('div')
  menu.className = 'cv-menu tree-menu'
  menu.appendChild(makeMenuItem(t('menu.newFileEllipsis'), () => newFileIn('')))
  menu.appendChild(makeMenuItem(t('menu.newFolderEllipsis'), () => newFolderIn('')))
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
    title: dirRel ? t('dlg.newFileTitle', { dir: dirRel }) : t('dlg.newFileTitleRoot'),
    placeholder: t('dlg.newFilePh'),
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
    setStatus(t('msg.newFileOk', { rel }))
  } catch (e) {
    await messageDialog(t('msg.newFileFailed', { err: errText(e) }))
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
  catch (e) { await messageDialog(t('msg.readTplFailed', { err: errText(e) })); return }
  const name = await promptDialog({ title: t('dlg.newTplTitle', { name: baseName(tplRel) }), placeholder: t('dlg.newTplPh') })
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
    setStatus(t('msg.newFromTplOk', { rel }))
  } catch (e) {
    await messageDialog(t('msg.newFileFailed', { err: errText(e) }))
  }
}

// 新建一个空白模板（带示例变量），存于模板目录
async function newBlankTemplate() {
  if (!state.vaultRoot) { await messageDialog(t('msg.openVaultFirst')); return }
  const name = await promptDialog({ title: t('dlg.newTplFileTitle', { dir: TEMPLATE_DIR() }), placeholder: t('dlg.tplFilePh') })
  if (!name) return
  const rel = joinRel(TEMPLATE_DIR(), /\.md$/i.test(name) ? name : name + '.md')
  const seed = t('tpl.blankSeed')
  try {
    await ensureDir(TEMPLATE_DIR())
    await writeMdFile(state.vaultRoot, rel, seed)
    renderTree(await scanVault(state.vaultRoot))
    await openFile(rel)
    setStatus(t('msg.newTplOk', { rel }))
  } catch (e) { await messageDialog(t('msg.newTplFailed', { err: errText(e) })) }
}

// 工具条「模板」菜单：列模板 + 今日速记 + 新建模板 + 今日速记设置
function openTemplateMenu(anchorEl) {
  if (!state.vaultRoot) { messageDialog(t('msg.openVaultFirst')); return }
  refreshTree().then(() => {
    closeTreeMenu()
    const menu = document.createElement('div')
    menu.className = 'cv-menu tree-menu'
    const tpls = listMdInDir(TEMPLATE_DIR())
    if (!tpls.length) {
      menu.appendChild(makeMenuItem(t('menu.noTemplatesInDir', { dir: TEMPLATE_DIR() }), () => {}))
    } else {
      tpls.forEach((p) => menu.appendChild(makeMenuItem(baseName(p).replace(/\.md$/i, ''), () => newFromTemplate(p), false, false, 'file')))
    }
    menu.appendChild(menuSep())
    menu.appendChild(makeMenuItem(t('menu.dailyCaptureEntry'), () => toggleDailyCapture(), false, false, 'calendar'))
    menu.appendChild(makeMenuItem(t('cmd.app.newTemplate'), () => newBlankTemplate(), false, false, 'plus'))
    menu.appendChild(makeMenuItem(t('cmd.app.dailySettings'), () => configureDailyCapture(), false, false, 'sliders'))
    const r = anchorEl.getBoundingClientRect()
    placeMenu(menu, r.left, r.bottom + 4)
  })
}

// 工具条「更多」菜单：收纳低频操作（导出/打印/图谱/画布/模板）与视图模式开关（专注/打字机）
// 文案、键位后缀、勾选态都取注册表那一套（与 mac 原生菜单同源），菜单不自带第二份文案
function addMenuCmd(menu, id, icon) {
  const cmd = commandRegistry.get(id)
  if (!cmd) return
  const key = commandBindingFor(id)
  const checked = MENU_CHECKED[id] ? MENU_CHECKED[id]() : false
  menu.appendChild(makeMenuItem(cmd.title + (key ? ' (' + key + ')' : ''), () => runViaShortcut(id), false, checked, icon))
}

function openMoreMenu(anchorEl) {
  closeTreeMenu()
  const menu = document.createElement('div')
  menu.className = 'cv-menu tree-menu'
  addMenuCmd(menu, 'app.palette', 'terminal')
  addMenuCmd(menu, 'app.shortcuts', 'sliders')
  addMenuCmd(menu, 'app.appearance', 'palette')
  addMenuCmd(menu, 'app.export', 'export')
  addMenuCmd(menu, 'app.exportSite', 'globe')
  addMenuCmd(menu, 'app.importWord', 'file')
  addMenuCmd(menu, 'app.exportWord', 'export')
  addMenuCmd(menu, 'app.print', 'printer')
  addMenuCmd(menu, 'app.graph', 'graph')
  addMenuCmd(menu, 'app.newCanvas', 'board')
  // 这两项是子菜单而非命令，注册表里没有对应条目，文案走词条
  menu.appendChild(makeMenuItem(t('menu.recent'), () => openRecentMenu(anchorEl), false, false, 'clock'))
  menu.appendChild(makeMenuItem(t('menu.templateSettings'), () => openTemplateMenu(anchorEl), false, false, 'clipboard'))
  // 语言：子菜单列出全部语言，当前语言打勾
  menu.appendChild(makeMenuItem(t('menu.language'), () => openLangMenu(anchorEl), false, false, 'globe'))
  addMenuCmd(menu, 'app.about', 'info')
  menu.appendChild(menuSep())
  addMenuCmd(menu, 'app.focusMode', 'target')
  addMenuCmd(menu, 'app.typewriterMode', 'keyboard')
  addMenuCmd(menu, 'app.toggleSidebar', 'sidebar')
  addMenuCmd(menu, 'app.toggleInspector', 'sliders')
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
  syncTrayRecents()
}
function openRecentMenu(anchorEl) {
  const list = loadRecents()
  closeTreeMenu()
  const menu = document.createElement('div')
  menu.className = 'cv-menu tree-menu'
  if (!list.length) {
    menu.appendChild(makeMenuItem(t('menu.noRecent'), () => {}))
  } else {
    list.forEach((e) => {
      const it = makeMenuItem(e.name, () => reopenRecent(e), false, false, 'file')
      it.title = e.root + '/' + e.rel
      menu.appendChild(it)
    })
    menu.appendChild(menuSep())
    menu.appendChild(makeMenuItem(t('cmd.app.clearRecents'), () => saveRecents([]), false, false, 'eraser'))
  }
  const r = anchorEl.getBoundingClientRect()
  placeMenu(menu, r.left, r.bottom + 4)
}

// 语言子菜单：列 LOCALES 全部语言，当前项打勾；点选项即切换并整体刷新界面
function openLangMenu(anchorEl) {
  closeTreeMenu()
  const menu = document.createElement('div')
  menu.className = 'cv-menu tree-menu'
  for (const l of LOCALES) {
    menu.appendChild(makeMenuItem(l.name, () => switchLocale(l.id), false, getLocale() === l.id, 'globe'))
  }
  const r = anchorEl.getBoundingClientRect()
  placeMenu(menu, r.left, r.bottom + 4)
}
async function reopenRecent(entry) {
  if (!(await ensureSavedBeforeLeave())) return
  try {
    // 跨库打开：清标签页 + 回无文档态（后者同时消掉 openFile「同一相对路径」早退——
    // 两个库各有一个 README.md 时，不清 currentFile 会让新库的那个点不动）
    leaveCurrentVault(entry.root)
    state.vaultRoot = entry.root
    state.tempImportRoot = ''
    state.scratch = false
    const tree = await scanVault(entry.root)
    renderTree(tree)
    startIndexPolling()
    await openFile(entry.rel, true) // 脏状态已在上面确认
    if (pluginManager) pluginManager.reload()
  } catch (e) {
    // 目录可能已移动 / 删除：剔除该条并提示
    saveRecents(loadRecents().filter((x) => !(normVaultPath(x.root) === normVaultPath(entry.root) && x.rel === entry.rel)))
    await messageDialog(t('msg.recentOpenFailed', { err: (e && e.message) || e }))
  }
}

async function newFolderIn(dirRel) {
  if (!state.vaultRoot) return
  const name = await promptDialog({
    title: dirRel ? t('dlg.newFolderTitle', { dir: dirRel }) : t('dlg.newFolderTitleRoot'),
    placeholder: t('dlg.newFolderPh'),
  })
  if (!name) return
  if (name.includes('/') || name.includes('\\')) {
    await messageDialog(t('msg.folderSep'))
    return
  }
  const rel = joinRel(dirRel, name)
  try {
    await createDir(state.vaultRoot, rel)
    renderTree(await scanVault(state.vaultRoot))
    setStatus(t('msg.newFolderOk', { rel }))
  } catch (e) {
    await messageDialog(t('msg.newFolderFailed', { err: errText(e) }))
  }
}

async function renameEntry(rel, name, isFolder) {
  if (!state.vaultRoot) return
  const input = await promptDialog({
    title: t(isFolder ? 'dlg.renameFolder' : 'dlg.renameFile'),
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
    setStatus(t('status.renamed', { from: rel, to }))
  } catch (e) {
    await messageDialog(t('msg.renameFailed', { err: errText(e) }))
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
  if (tabs && tabs.active()) tabs.update(tabs.active().id, { rel: newCf })
}

async function deleteVaultFile(rel, name) {
  if (!state.vaultRoot) return
  const ok = await confirmDialog(t('msg.trashConfirm', { name }), t('msg.trashTitle'))
  if (!ok) return
  try {
    await deleteFile(state.vaultRoot, rel)
    // 索引同步：从索引移除这条文档（canvas 不在索引内，为空操作）
    try { await removeIndexDoc(rel) } catch (_) {}
    if (state.currentFile === rel) {
      // 删的是当前打开文档：清空编辑区，回到无文档态
      state.dirty = false
      state.currentFile = null
      state.scratch = false
      setMode('md')
      editor.setMarkdown('')
      updateDocStats() // 清空后统计归零，不沿用被删文档的字数
      els.filename.textContent = t('ui.noDocOpen')
      els.filename.classList.remove('dirty')
      refreshLinkPanels()
      if (snapshotPanel) snapshotPanel.refresh()
      const act = tabs && tabs.active()
      if (act) {
        const next = tabs.neighborOf(act.id)
        tabs.remove(act.id)
        if (next) await openTabDoc(next)
      }
    }
    renderTree(await scanVault(state.vaultRoot))
    setStatus(t('status.trashed', { rel }))
  } catch (e) {
    await messageDialog(t('msg.deleteFailed', { err: (e && e.message) || e }))
  }
}

function highlightActiveFile() {
  els.tree.querySelectorAll('.tree-file.active').forEach((el) => el.classList.remove('active'))
  if (state.currentFile) {
    const el = els.tree.querySelector(`.tree-file[data-path="${cssEscape(state.currentFile)}"]`)
    if (el) el.classList.add('active')
  }
}

// —— 标签页（文档 tabs）——
// 模型见 tabs.js 文件头：一个编辑器实例 + 一列打开中的文档；切页/关页都走既有打开链路。
// 活动页的 root/rel 恒等于 state.vaultRoot/state.currentFile（scratch 页例外见 openTabDoc）。

// 新建到系统临时目录：先落一个能立刻编辑的文件，保存 / 关闭时再选正式位置。
// 临时目录固定为 <temp>/NoteLume/scratch（与 docx 导入的 temp 同根，互不重叠）。
async function ensureScratchDir() {
  const base = await tempDir()
  try {
    await createDir(base, 'NoteLume/scratch')
  } catch (_) {
    /* 已存在：create_dir 对已存在目录报错，忽略 */
  }
  const dir = await join(base, 'NoteLume', 'scratch')
  state.scratchRoot = dir // 记住它：openFile 据此判当前文档是不是临时文件
  try {
    localStorage.setItem('nl-scratch-dir', dir) // 跨会话记住：重开后从「打开文件」进临时目录也能认出来
  } catch (_) {
    /* 隐私模式等场景写不进去，不影响本次 */
  }
  return dir
}

async function newScratchFile() {
  if (!(await ensureSavedBeforeLeave())) return
  const d = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  try {
    const root = await ensureScratchDir()
    const rel = t('doc.untitled') + '-' + stamp + '.md'
    await writeMdFile(root, rel, '# ' + t('doc.untitled') + '\n\n')
    await openTabDoc({ root, rel, scratch: true })
    setStatus(t('status.createdScratch'))
    editor.focus()
  } catch (e) {
    await messageDialog(t('msg.newFileFailed', { err: errText(e) }))
  }
}

// 切到某一页：先处理当前文档的未保存改动，再换根开文档（跨库 / 临时目录都要重载树与索引）
async function switchToTab(id) {
  const tab = tabs && tabs.get(id)
  if (!tab) return
  const active = tabs.active()
  if (active && active.id === id) return
  if (!(await ensureSavedBeforeLeave())) return
  await openTabDoc(tab)
}

async function openTabDoc(tab) {
  state.vaultRoot = tab.root
  state.tempImportRoot = ''
  state.scratch = !!tab.scratch
  if (tab.canvas) {
    renderSingleFileTree(tab.rel)
    await openCanvas(tab.rel)
  } else {
    if (tab.scratch) {
      // 临时目录不进侧栏树（那是系统 temp，铺开只会碍事）；也只列当前这一个
      renderSingleFileTree(tab.rel)
      state.tree = []
    } else {
      renderTree(await scanVault(tab.root))
    }
    await openFile(tab.rel, true)
  }
  if (tabs) tabs.open(tab)
  startIndexPolling() // 根可能变（跨库 / 临时目录），索引跟着换
  if (pluginManager) pluginManager.reload()
  if (gitPanel) gitPanel.refresh()
  if (snapshotPanel) snapshotPanel.refresh()
}

// 关闭一页。活动页：临时且未定落的先问是否选位置，脏的走「保存 / 不保存 / 取消」。
// 非活动页按构造是干净的（离开时已强制保存或放弃），直接移除。
async function closeTab(id) {
  if (!tabs) return
  const tab = tabs.get(id)
  if (!tab) return
  if (tabs.active() && tabs.active().id === id) {
    if (tab.scratch) {
      // 临时页：先按常规处理改动（选「保存」会走另存为，成功后这一页已不再是临时页），
      // 仍是临时页（没改动 / 自动保存过 / 选了不保存）再问要不要选正式位置
      if (!(await ensureSavedBeforeLeave())) return
      if (tab.scratch) {
        const choice = await confirm3Dialog({
          title: t('dlg.scratchTitle'),
          message: t('dlg.scratchMsg', { name: baseName(tab.rel) }),
          confirmLabel: t('dlg.scratchChoose'),
          neutralLabel: t('dlg.scratchClose'),
          cancelLabel: t('common.cancel'),
        })
        if (choice === 'cancel') return
        if (choice === 'confirm' && !(await saveScratchAs())) return
      }
    } else if (!(await ensureSavedBeforeLeave())) {
      return
    }
    // 另存为会改这一页的 id（root/rel 变了），故用 tab 对象上的现值，不用入参 id
    const next = tabs.neighborOf(tab.id) // 先问邻居，再移除（移除后该页就没了）
    tabs.remove(tab.id)
    if (next) await openTabDoc(next)
    else await goNoDoc()
  } else {
    tabs.remove(id)
  }
}

// 全部关完：回到无文档态（不退出应用）
async function goNoDoc() {
  resetToNoDoc()
  refreshLinkPanels()
  if (snapshotPanel) snapshotPanel.refresh()
}

// 回到无文档态：清编辑器 / 统计 / 脏标记 / 文件名（标签页与面板由调用方决定）
function resetToNoDoc() {
  state.currentFile = null
  state.scratch = false
  markDirty(false) // 走统一入口：顺带清掉待触发的自动保存，避免切走后存错文件
  setMode('md')
  editor.setMarkdown('')
  updateDocStats() // setMode 里的刷新发生在清空之前，这里补一次归零
  els.filename.textContent = t('ui.noDocOpen')
  els.filename.classList.remove('dirty')
}

// 换根（换知识库 / 单文件模式 / 打开跨库的最近文档）前的收尾：
// 旧根的打开记录整体作废——标签页清空、回到无文档态、清掉搜索残留。
// 不做脏检查（调用方在换根前已问过），也不重扫树（由调用方按新根扫）。
// 返回 false = 挑的就是当前根，调用方应原样返回，不动任何状态。
function leaveCurrentVault(root) {
  if (normVaultPath(root) === normVaultPath(state.vaultRoot)) return false
  if (tabs) tabs.clear()
  resetToNoDoc()
  // 搜索结果还挂着旧库的命中：点进去会用新根打开一个同名（或不存在）的文件
  els.searchInput.value = ''
  els.searchResults.innerHTML = ''
  return true
}

// Ctrl+Tab / Ctrl+Shift+Tab：循环切页（dir = 1 下一个，-1 上一个）
async function cycleTab(dir) {
  if (!tabs) return
  const list = tabs.list()
  if (list.length < 2) {
    setStatus(list.length ? t('status.oneTab') : t('status.noTab'))
    return
  }
  const i = list.findIndex((t) => t.id === (tabs.active() || {}).id)
  const next = list[(i + dir + list.length) % list.length]
  await switchToTab(next.id)
}

// 临时文件的「保存」：选一个正式位置写盘，然后把这一页改指到新位置（退出临时态）
async function saveScratchAs() {
  try {
    const md = editor.getMarkdown()
    const abs = await pickSaveAs(state.currentFile || t('doc.untitledMd'))
    if (!abs) {
      setStatus(t('status.saveCanceled'))
      return false
    }
    const { dir, name } = splitAbs(abs)
    await writeMdFile(dir, name, md)
    state.vaultRoot = dir
    state.tempImportRoot = ''
    state.scratch = false
    state.currentFile = name
    editor.markSaved()
    els.filename.textContent = abs
    if (tabs && tabs.active()) tabs.update(tabs.active().id, { root: dir, rel: name, scratch: false })
    renderTree(await scanVault(dir))
    highlightActiveFile()
    try {
      await updateIndexDoc(name, md)
      refreshLinkPanels()
    } catch (_) {
      /* 索引增量失败不阻断保存 */
    }
    recordRecent(dir, name)
    startIndexPolling()
    if (snapshotPanel) snapshotPanel.refresh()
    if (gitPanel) gitPanel.refresh()
    if (pluginManager) pluginManager.reload()
    setStatus(t('status.savedTo', { abs }))
    return true
  } catch (e) {
    await messageDialog(t('msg.saveFailedDlg', { err: errText(e) }))
    return false
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
    state.scratch = isScratchRoot(state.vaultRoot)
    setMode('md')
    editor.setMarkdown(md)
    updateDocStats() // setMode 里的刷新发生在换文档之前（切标签时编辑器还是上一个文档），这里补一次
    els.filename.textContent = state.scratch ? await joinPath(state.vaultRoot, rel) : rel
    highlightActiveFile()
    setStatus(t('status.opened', { rel }))
    editor.focus()
    refreshLinkPanels()
    if (snapshotPanel) snapshotPanel.refresh()
    if (pluginManager) pluginManager.fireFileOpen(rel, md)
    resetBackupTimer()
    // 临时文件不进「最近打开」：它的归宿是另存为那一刻的正式路径（saveScratchAs 里记）
    if (!state.scratch) recordRecent(state.vaultRoot, rel)
    if (tabs) tabs.open({ root: state.vaultRoot, rel, scratch: state.scratch })
  } catch (e) {
    await messageDialog(t('status.openFailed', { msg: e }))
  }
}

// 当前根是不是「新建未定落」的临时目录（决定 Ctrl+S 是否走另存为、标签页是否带临时标）
function isScratchRoot(root) {
  return !!state.scratchRoot && !!root && normVaultPath(root) === normVaultPath(state.scratchRoot)
}

// 展示用路径拼接：走 Tauri 的 join，非桌面环境（纯浏览器预览）退化成斜杠拼接
async function joinPath(a, b) {
  try {
    return await join(a, b)
  } catch {
    return String(a).replace(/[\\/]$/, '') + '/' + b
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
    state.scratch = isScratchRoot(state.vaultRoot)
    els.filename.textContent = path
    highlightActiveFile()
    setStatus(t('status.canvasOpened', { path }))
    resetBackupTimer()
    recordRecent(state.vaultRoot, path)
    if (tabs) tabs.open({ root: state.vaultRoot, rel: path, canvas: true, scratch: state.scratch })
  } catch (e) {
    await messageDialog(t('msg.canvasOpenFailed', { err: (e && e.message) || e }))
  }
}

async function newCanvas() {
  if (!state.vaultRoot) {
    setStatus(t('status.needVaultFolder'))
    await messageDialog(t('msg.canvasNeedVault'), 'info')
    return
  }
  if (!(await ensureSavedBeforeLeave())) return
  const d = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  const name = t('doc.canvasName') + '-' + stamp + '.canvas'
  try {
    setMode('canvas') // 先显示容器，newBlank 里 centerWorld 才能拿到真实尺寸
    state.currentFile = name
    els.filename.textContent = name
    highlightActiveFile()
    await canvasView.newBlank(name)
    await canvasView.save() // 先落盘一个空画布，使其出现在文件树
    renderTree(await scanVault(state.vaultRoot))
    setStatus(t('status.canvasCreated', { name }))
    if (tabs) tabs.open({ root: state.vaultRoot, rel: name, canvas: true })
  } catch (e) {
    await messageDialog(t('msg.canvasCreateFailed', { err: (e && e.message) || e }))
  }
}

// —— 保存到原文件（含索引增量更新 + 可选备份）——
async function saveCurrent(manual = true) {
  if (!state.currentFile || !state.vaultRoot) {
    if (manual) setStatus(t('status.nothingToSave'))
    return
  }
  // 新建未定落的临时文件：手动保存 = 选正式位置（另存为），自动保存仍写临时目录保命
  if (manual && state.scratch) return saveScratchAs()
  // 独立解析模式（temp 一次性目录）下的手动保存 → 升级为“另存为”，避免默认行为就是默默覆写 temp
  if (manual && state.tempImportRoot && normVaultPath(state.vaultRoot) === normVaultPath(state.tempImportRoot)) {
    return saveTempAsFormal()
  }
  try {
    if (state.mode === 'canvas') {
      await canvasView.save()
      setStatus(manual
        ? t('status.saved', { name: state.currentFile, time: timeStr() })
        : t('status.autoSaved', { name: state.currentFile, time: timeStr() }))
      return
    }
    const md = editor.getMarkdown()
    await writeMdFile(state.vaultRoot, state.currentFile, md)
    editor.markSaved()
    if (pluginManager) pluginManager.fireSave(state.currentFile, md)
    setStatus(manual
      ? t('status.saved', { name: state.currentFile, time: timeStr() })
      : t('status.autoSaved', { name: state.currentFile, time: timeStr() }))
    // 索引增量：无需重扫全库
    try {
      await updateIndexDoc(state.currentFile, md)
      refreshLinkPanels()
    } catch (e) {
      console.warn(t('msg.indexUpdateFailed'), e)
    }
    // 备份：手动保存一定做一次；自动保存受间隔约束（在 scheduleAutosave 里）
    await maybeBackup(md, manual)
    if (snapshotPanel && manual) snapshotPanel.refresh()
    if (gitPanel && manual) gitPanel.refresh()
  } catch (e) {
    if (manual) await messageDialog(t('msg.saveFailedDlg', { err: e }))
    else console.warn(t('msg.autosaveFailed'), e)
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
      setStatus(t('status.savedTemp'))
      return
    }
    // 3) 递归拷贝整棵 temp → target（覆写同名，保留相对路径）
    await relocateImport(tempRoot, target)
    // 4) 切换工作根到新目录：同 rel 内容已存在，无需重开文件，只换 vaultRoot 标识
    state.vaultRoot = target
    state.tempImportRoot = ''
    state.scratch = false
    if (tabs && tabs.active()) tabs.update(tabs.active().id, { root: target })
    renderTree(await scanVault(target))
    startIndexPolling()
    if (pluginManager) pluginManager.reload()
    if (gitPanel) gitPanel.refresh()
    setStatus(t('status.savedAs', { target }))
  } catch (e) {
    await messageDialog(t('msg.saveAsFailed', { err: (e && e.message) || e }))
    setStatus(t('status.saveAsFailed'))
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
    console.warn(t('msg.backupFailed'), e)
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
    setStatus(t('status.needVaultFolder'))
    return
  }
  try {
    const res = await resolveWikiLink(state.vaultRoot, state.currentFile || '', name)
    if (res.exists) {
      await openFile(res.path)
      return
    }
    const create = await confirmDialog(t('dlg.wikiMissingDoc', { name }), t('dlg.wikiNewDocTitle'))
    if (!create) return
    const rel = await createMdFile(state.vaultRoot, name, `# ${name}\n\n`)
    renderTree(await scanVault(state.vaultRoot))
    state.currentFile = null
    state.dirty = false
    await openFile(rel)
    // 让索引立刻感知新文档
    try { await updateIndexDoc(rel, `# ${name}\n\n`) } catch (_) {}
  } catch (e) {
    await messageDialog(t('msg.opFailed', { err: e }))
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
    { key: '1', label: 'H1', title: t('outline.expandTo', { level: 'H1' }) },
    { key: '2', label: 'H2', title: t('outline.expandTo', { level: 'H2' }) },
    { key: '3', label: 'H3', title: t('outline.expandTo', { level: 'H3' }) },
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
  tags.forEach((tag) => {
    const chip = document.createElement('span')
    chip.className = 'tag-chip'
    chip.textContent = '#' + tag
    chip.title = t('tags.searchInVault')
    chip.addEventListener('click', () => {
      els.searchInput.value = '#' + t
      runSearch('#' + t)
    })
    tw.appendChild(chip)
  })
  if (!tags.length) tw.innerHTML = '<div class="muted">' + t('tags.docEmpty') + '</div>'

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
    box.innerHTML = '<div class="muted">' + (state.vaultRoot ? t('common.indexBuilding') : t('tags.vaultHint')) + '</div>'
    return
  }
  let tags = []
  try {
    tags = await listAllTags()
  } catch (_) {
    box.innerHTML = '<div class="muted">' + t('tags.loadFailed') + '</div>'
    return
  }
  state.tagNames = (tags || []).map((t) => t.tag)
  if (!tags.length) {
    box.innerHTML = '<div class="muted">' + t('tags.empty') + '</div>'
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
    chip.title = t('tags.viewDocs', { tag })
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
  docBox.innerHTML = '<div class="muted">' + t('common.loading') + '</div>'
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
  head.textContent = t('tags.docCount', { tag, n: docs.length })
  docBox.appendChild(head)
  if (!docs.length) {
    const empty = document.createElement('div')
    empty.className = 'muted'
    empty.textContent = t('tags.noDocs')
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
    els.backlinks.innerHTML = '<div class="link-empty">' + (state.indexReady ? t('links.empty') : t('common.indexBuilding')) + '</div>'
    els.outgoing.innerHTML = '<div class="link-empty">' + (state.indexReady ? t('links.empty') : t('common.indexBuilding')) + '</div>'
    return
  }
  try {
    const [bl, og] = await Promise.all([queryBacklinks(state.currentFile), queryOutgoing(state.currentFile)])
    renderLinkList(els.backlinks, bl, t('links.noBacklinks'))
    renderLinkList(els.outgoing, og, t('links.noOutgoing'))
  } catch (e) {
    console.warn(t('msg.backlinksFailed'), e)
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
      els.searchResults.innerHTML = '<div class="search-empty">' + t('search.noMatch') + '</div>'
      return
    }
    hits.forEach((h) => {
      const card = document.createElement('div')
      card.className = 'search-hit'
      const badge =
        h.matchedBy === 'title' ? '<span class="search-hit-badge">' + t('search.badgeTitle') + '</span>'
        : h.matchedBy === 'tag' ? '<span class="search-hit-badge">' + t('search.badgeTag') + '</span>'
        : ''
      card.innerHTML =
        '<div class="search-hit-title">' + escapeHtml(h.title) + badge + '</div>' +
        '<div class="search-hit-path">' + escapeHtml(h.path) + '</div>' +
        '<div class="search-hit-snippet">' + escapeHtml(h.snippet) + '</div>'
      card.addEventListener('click', () => openFile(h.path))
      els.searchResults.appendChild(card)
    })
  } catch (e) {
    console.warn(t('search.failed'), e)
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
}

// —— P1#6 导出 HTML ——
async function exportHTML() {
  if (!state.currentFile) {
    setStatus(t('status.openDocFirst'))
    return
  }
  if (state.mode === 'canvas') {
    setStatus(t('status.canvasNoHtml'))
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
    setStatus(t('status.exportedHtml', { abs }))
  } catch (e) {
    await messageDialog(t('msg.exportFailed', { err: (e && e.message) || e }))
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
  // 菜单已按「有 md 文档」置灰，这里兜住命令面板那条路：空文档导出一份空 Word 不如直接拒
  if (!state.currentFile) {
    setStatus(t('status.noDocToExport'))
    return
  }
  if (state.mode === 'canvas') {
    setStatus(t('status.canvasNoWord'))
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
    setStatus(t('status.exportedWord', { abs }))
    if (r && r.warnings && r.warnings.length) {
      await messageDialog(t('msg.exportWordDone', { warnings: r.warnings.map((w) => '· ' + w.message).join('\n') }), 'info')
    }
  } catch (e) {
    await messageDialog(t('msg.exportFailed', { err: (e && e.message) || e }))
  }
}

// —— 批次 C：导出整站为静态 HTML ——
async function exportSiteFull() {
  if (!state.vaultRoot) {
    setStatus(t('status.siteNeedVault'))
    return
  }
  const outDir = await pickFolder()
  if (!outDir) return
  setStatus(t('status.siteExportStart'))
  try {
    const io = {
      buildGraph: (vr) => buildSiteGraph(vr),
      scanTree: (vr) => scanVault(vr),
      readMd: (vr, rel) => readMdFile(vr, rel),
      writeFile: (absPath, content) => exportFile(absPath, content),
      copyAssets: (vr, rels, od) => copyVaultAssets(vr, rels, od),
    }
    const r = await exportSite({ vaultRoot: state.vaultRoot, outDir, io, setStatus })
    await messageDialog(t('msg.siteExportDone', {
      ok: r.ok,
      failed: r.failed ? t('msg.siteSkipped', { n: r.failed }) : '',
      dir: outDir,
    }), 'info')
  } catch (e) {
    await messageDialog(t('msg.siteExportFailedDlg', { err: (e && e.message) || e }))
    setStatus(t('status.siteExportFailed'))
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
  th, td { border: 1px solid #dfe2e5; padding: 6px 10px; max-width: 20em; }
  th { background: #f6f8fa; font-weight: 600; text-align: left; }
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
    setStatus(t('status.graphNeedVault'))
    return
  }
  if (!state.indexReady) {
    setStatus(t('status.graphIndexNotReady'))
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
    setStatus(t('status.graphFailed', { err: e?.message || e }))
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
  const app = (id, defaultKey, run) =>
    commandRegistry.register({ id, title: t('cmd.' + id), category: 'app', defaultKey, run })
  app('app.save', 'Mod-s', () => saveCurrent(true))
  app('app.openFile', 'Mod-o', () => openSingleFile())
  app('app.openFolder', 'Mod-Shift-o', () => openFolder())
  // Ctrl+F = 当前文档内查找（Typora/Obsidian 语义）；全库搜索改到 Ctrl+Shift+F
  app('app.findInDoc', 'Mod-f', () => {
    if (editor && state.mode === 'md' && !editor.isSourceMode()) findBar && findBar.open()
  })
  // Ctrl+H：打开同一查找栏，但焦点落在替换框（替换行常显）
  app('app.replace', 'Mod-h', () => {
    if (editor && state.mode === 'md' && !editor.isSourceMode()) findBar && findBar.open('replace')
  })
  app('app.search', 'Mod-Shift-f', () => { setSidebar(false); els.searchInput.focus(); els.searchInput.select() })
  // 新建文件（Ctrl+N）：建到系统临时目录，不要求先开知识库；Ctrl+S / 关闭时再选保存位置
  app('app.newFile', 'Mod-n', () => newScratchFile())
  // 重命名当前文件（F2）：复用文件树右键那条（promptDialog + renameItem + 索引重建）
  app('app.renameFile', 'F2', () => {
    if (!state.currentFile) {
      setStatus(t('status.noOpenFile'))
      return
    }
    renameEntry(state.currentFile, baseName(state.currentFile), false)
  })
  // 关闭当前标签页（Ctrl+W）：只剩一页时等同关闭文档，回到无文档态
  app('app.closeFile', 'Mod-w', () => {
    const act = tabs && tabs.active()
    if (!act) {
      setStatus(t('status.noTab'))
      return
    }
    closeTab(act.id)
  })
  // 标签页循环（Ctrl+Tab / Ctrl+Shift+Tab）：刻意用 Ctrl 而非 Mod——mac 上 Cmd+Tab 被系统切应用占用
  app('app.nextTab', 'Ctrl-Tab', () => cycleTab(1))
  app('app.prevTab', 'Ctrl-Shift-Tab', () => cycleTab(-1))
  // 插入图片（Ctrl+Shift+I，Typora 习惯）：file input 选图后走落库路径
  app('app.insertImage', 'Mod-Shift-i', () => {
    if (editor && state.mode === 'md') editor.pickAndInsertImages()
    else setStatus(t('status.imgOnlyMd'))
  })
  // 粘贴为纯文本（Ctrl+Shift+V，Typora/Obsidian 习惯键）
  app('app.pastePlain', 'Ctrl-Shift-v', async () => {
    // 焦点在输入框（查找栏 / 侧栏搜索 / 源码 CM）里时不抢，那边要的是带格式粘贴
    const el = document.activeElement
    if (el && el.closest && el.closest('input, textarea, .cm-content')) return
    let text = null
    try {
      text = await navigator.clipboard.readText()
    } catch (e) {
      setStatus(t('status.clipFail', { err: errText(e) }))
      return
    }
    if (!text) {
      setStatus(t('status.clipEmpty'))
      return
    }
    if (editor && state.mode === 'md') editor.insertPlainText(text)
    else setStatus(t('status.noPasteDoc'))
  })
  // Ctrl+E = 编辑 / 预览互切（Typora 语义，即源码 ⇄ 所见即所得）；Ctrl+/ 不再占默认键
  app('app.sourceMode', 'Mod-e', () => toggleSourceMode())
  // 打印保留 Ctrl+P（用户明确要求）；命令面板回 Ctrl+Shift+P
  app('app.print', 'Mod-p', () => window.print())
  app('app.palette', 'Mod-Shift-p', () => { if (palette) palette.open() })
  app('app.graph', 'Mod-g', () => openGraphModal())
  app('app.dailyCapture', 'Mod-Shift-d', () => toggleDailyCapture())
  // 专注模式 Ctrl+Shift+`（Typora 习惯）；原 Ctrl+Shift+E 释放
  app('app.focusMode', 'Mod-Shift-`', () => toggleFocusMode())
  app('app.typewriterMode', 'Mod-Shift-t', () => toggleTypewriterMode())
  app('app.toggleSidebar', 'Mod-Shift-s', () => toggleSidebar())
  // 检查器改到 Ctrl+Shift+B：Ctrl+Shift+I 让给「插入图片」
  app('app.toggleInspector', 'Mod-Shift-b', () => toggleInspector())
  // 以下原先只挂在「更多」菜单里：入注册表后 mac 原生菜单可直接取用（一处定义，两处消费）
  app('app.shortcuts', null, () => { if (keySettings) keySettings.open() })
  // 外观设置：主题 / 颜色 / 字体 / 字号 / 行高 / 自动换行 / 侧栏比例，走 settings.json
  app('app.appearance', null, () => { if (apSettings) apSettings.open() })
  app('app.export', null, () => exportHTML())
  app('app.exportSite', null, () => exportSiteFull())
  app('app.importWord', null, () => importWordViaDialog())
  app('app.exportWord', null, () => exportWordViaDialog())
  app('app.newCanvas', null, () => newCanvas())
  app('app.newTemplate', null, () => newBlankTemplate())
  app('app.dailySettings', null, () => configureDailyCapture())
  app('app.autosave', null, () => setAutosave(!state.autosave.enabled))
  app('app.clearRecents', null, () => saveRecents([]))
  // 「关于」：Windows/Linux 从「更多」菜单与命令面板进；mac 用原生 About role（app-menu.js），
  // 两边不同时挂，免得 mac 出现两个入口。无默认键。
  app('app.about', null, () => openAboutDialog())
  // 界面语言：一种语言一条命令，标题按当前语言生成（各语言自称取自 LOCALES）；选中态由 MENU_CHECKED 给出
  for (const l of LOCALES) {
    commandRegistry.register({
      id: 'app.lang.' + l.id,
      title: t('cmd.app.lang', { name: l.name }),
      category: 'app',
      defaultKey: null,
      run: () => switchLocale(l.id),
    })
  }
  // 批次 E（L）：本地 Git（无默认键，避免抢占既有快捷键；可在快捷键设置里自行绑定）
  app('app.git.refresh', null, () => { if (gitPanel) gitPanel.refresh() })
  app('app.git.commit', null, () => { if (gitPanel) gitPanel.commitAll() })
  app('app.git.init', null, () => { if (gitPanel) gitPanel.init() })
  // 批次 E（R1）：Git 远程（认证 + 快进 pull）——run 委托给面板暴露的方法；面板未就绪则无操作
  app('app.git.fetch', null, () => { if (gitPanel) gitPanel.fetch() })
  app('app.git.pull', null, () => { if (gitPanel) gitPanel.pull() })
  // 批次 E（R2）：Git push（当前分支 → upstream）
  app('app.git.push', null, () => { if (gitPanel) gitPanel.push() })
    // 批次 E（R3）：合并拉取（非 ff-only，冲突交面板解决）
    app('app.git.pullMerge', null, () => { if (gitPanel) gitPanel.merge() })
  app('app.git.remote', null, () => { if (gitPanel) gitPanel.setupRemote() })
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
        updateDocStats() // 重新加载的是远端版本，字数/时长跟着换
        markDirty(false)
        refreshLinkPanels()
      } catch (_) {
        /* 文件可能被删，忽略 */
      }
    }
    if (state.dirty) {
      const ok = await confirmDialog(t('msg.pullConflict'), t('msg.pullConflictTitle'))
      if (ok) await reload()
    } else {
      await reload()
    }
  }
}

// editor 命令入注册表：与 app 同一张表（面板可列、可重绑），但执行经 ctx.runEditorCommand 转给 PM
// 注：全局分发器不跳 editor 类（已按 category 过滤），避免与 PM keymap 重复触发
function registerEditorCommands() {
  for (const def of editorCommandDefs()) {
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

// —— 界面语言 ——
// 切换后统一刷新：注册表标题（命令面板 / 快捷键设置 / mac 菜单的文案来源）、静态 DOM、
// 主题按钮文字、词数统计。各面板自己订阅 onLocaleChange 重绘（见各面板模块）。
function switchLocale(id) {
  if (!setLocale(id)) return
  registerAppCommands()
  registerEditorCommands()
  applyStaticDom(document)
  applyTheme(currentThemeChoice()) // 按「选择」重放：选 system 的不会被打回具体主题
  updateDocStats()
  scheduleMacChrome()
  // 后端文案跟随；托盘菜单要等 setUiLang 落好再重建才是新语言（scheduleMacChrome 只重建菜单栏）
  if (IS_MAC && window.__TAURI_INTERNALS__) {
    setUiLang(id).then(() => syncTrayRecents()).catch(() => {})
  } else if (window.__TAURI_INTERNALS__) {
    setUiLang(id).catch(() => {})
  }
  setStatus(t('status.langSwitched', { name: localeName(id) }))
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

const MENU_NEEDS_DOC = new Set(['app.save', 'app.export', 'app.print', 'app.closeFile', 'app.renameFile'])
const MENU_NEEDS_VAULT = new Set(['app.exportSite', 'app.newCanvas', 'app.newTemplate', 'app.graph'])
// 导出 Word 取的是当前 md 文档的 PM 节点树：画布与未打开文档时置灰，同 editor.* 的口径
const MENU_NEEDS_MD = new Set(['app.exportWord', 'app.insertImage'])
const MENU_CHECKED = {
  'app.focusMode': () => localStorage.getItem('nl-focus') === '1',
  'app.typewriterMode': () => localStorage.getItem('nl-typewriter') === '1',
  'app.toggleSidebar': () => localStorage.getItem('nl-sidebar') !== 'hidden',
  'app.toggleInspector': () => !inspectorHidden(),
  'app.autosave': () => state.autosave.enabled,
  'app.sourceMode': () => !!(editor && editor.isSourceMode()),
}
// 语言命令的勾：当前语言那一项打勾（注册表 title 按当前语言生成，勾用于「更多」菜单与 mac 菜单）
for (const l of LOCALES) {
  MENU_CHECKED['app.lang.' + l.id] = () => getLocale() === l.id
}

function menuEnabled(id) {
  if (MENU_NEEDS_DOC.has(id) && !state.currentFile) return false
  // PM 编辑命令只在所见即所得的文档上可用（画布 / 未打开文档时置灰）
  if ((id.startsWith('editor.') || MENU_NEEDS_MD.has(id)) && !(state.currentFile && state.mode === 'md')) return false
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
  // 主题单选组的勾选态比的是「选择」而非落地主题：选 system 时打勾的也是 system
  const choice = currentThemeChoice()
  return {
    commands: menuCommands(),
    recents: loadRecents().map((e, i) => ({ id: 'recent:' + i, label: e.name })),
    templates: listMdInDir(TEMPLATE_DIR()).map((p) => ({ id: 'tpl:' + p, label: baseName(p).replace(/\.md$/i, '') })),
    themes: THEMES.map((name) => ({ id: 'theme:' + name, label: t('theme.' + name), checked: name === choice })),
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
    setStatus(t('status.cmdFailed', { err: (err && err.message) || err }))
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
    console.warn(t('msg.macMenuRebuildFailed'), e)
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

// macOS 菜单栏状态图标：接 Rust 转发的菜单事件（新建笔记 / 打开最近），并把最近列表同步给托盘
function setupTrayMenu() {
  if (!IS_MAC || !window.__TAURI_INTERNALS__) return
  listen('notelume://menu-action', (e) => {
    if (e.payload === 'new') els.btnNewFile?.click()
    // 'show' 由 Rust 侧 show()+set_focus() 处理，前端不用动；'quit' 由 Rust 走窗口关闭
  })
  listen('notelume://menu-open', (e) => {
    const entry = loadRecents()[Number(e.payload)]
    if (entry) reopenRecent(entry)
  })
  // boot 里 setUiLang 是不等返回的点火式调用，这里再等一次落好再同步，
  // 否则托盘菜单在启动瞬间用的是 Rust 默认的 zh-CN，要等用户下次动语言才纠正
  setUiLang(getLocale()).then(() => syncTrayRecents(), () => {})
}
function syncTrayRecents() {
  if (!IS_MAC || !window.__TAURI_INTERNALS__) return
  traySetRecent(loadRecents().map((e) => e.rel)).catch(() => {})
}

async function setupMacMenu() {
  if (!IS_MAC || !window.__TAURI_INTERNALS__) return
  try {
    await listen('nl:menu-select', (e) => onMenuSelect(e.payload))
    await pushMacMenu()
  } catch (e) {
    setStatus(t('msg.macMenuUnavailable', { err: (e && e.message) || e }))
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
    setStatus(t('msg.saveKeymapFailed', { err: (e && e.message) || e }))
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
    // F 键允许裸按（F2 重命名），其余仍要求至少一个修饰键
    if (!(e.ctrlKey || e.metaKey || e.altKey || /^F([1-9]|1[0-2])$/.test(e.key))) return
    const logical = eventToBinding(e, IS_MAC)
    if (!logical) return
    const id = effectiveKeymap.get(resolveBinding(logical, IS_MAC))
    if (!id) return
    e.preventDefault()
    runViaShortcut(id)
  })
}

async function boot() {
  // 界面语言：i18n.js 导入时已按「本地记忆 → 系统语言 → 简体中文」定好 locale；
  // 这里把 <html lang> 与静态文案对齐当前语言（默认词条也是中文，重复一遍无副作用）
  document.documentElement.lang = getLocale()
  applyStaticDom(document)
  // 后端同理：命令错误 / docx 警告 / git 结果 / 托盘菜单按当前语言取词（ui_lang.rs 词表）
  if (window.__TAURI_INTERNALS__) setUiLang(getLocale()).catch(() => {})
  // 应用设置（settings.json）：先读回再装配界面。外观状态（主题 / 颜色 / 字体 /
  // 字号 / 行高 / 自动换行 / 侧栏比例）恢复到上次保存的样子；文件不存在或损坏
  // 时（load 内部静默处理）normalizeAppearance 给代码里的默认值。
  settingsStore = createSettingsStore()
  await settingsStore.load()
  let ap = currentAppearance()
  if (!settingsStore.get().appearance) {
    // 老版本把主题记在 localStorage['nl-theme']：没有 settings.json 时认这个旧值，
    // 之后的改动只写 settings.json
    const legacy = localStorage.getItem('nl-theme')
    if (legacy) ap = normalizeAppearance({ ...ap, theme: legacy })
  }
  initTitlebar()
  // 标签页先建：编辑器回调（onDirty → markDirty → tabs.setDirty）可能在装配过程中就触发
  tabs = createTabs({
    mountEl: els.tabs,
    onSwitch: (id) => switchToTab(id),
    onClose: (id) => closeTab(id),
  })
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
    // Ctrl+K 的 URL 询问：所见即所得里没有直接改 href 的入口，只能弹窗问。
    // 返回 null = 取消，'' = 解除链接，其余为链接地址。
    onAskLinkUrl: async (current) => {
      const input = await promptDialog({
        title: current ? t('dlg.linkEdit') : t('dlg.linkInsert'),
        placeholder: t('dlg.linkPh'),
        defaultValue: current || '',
      })
      if (input === null) return null // 取消：不动文档
      return input.trim()
    },
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

  applyTheme(ap.theme)
  applyAppearance(document.documentElement.style, ap) // 颜色 / 字体 / 字号 / 行高 / 换行的行内变量
  // OS 的浅色 / 深色偏好变化时，选了「跟随系统」就跟着落地主题一起换
  if (window.matchMedia) {
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
      if (currentThemeChoice() === 'system') applyTheme('system')
    })
  }
  setSidebar(localStorage.getItem('nl-sidebar') === 'hidden')
  bindSideTabs()
  bindColResizers()
  // 窗口缩放时侧栏按设置里的比例重算像素（clamp 在 colWidth 里）
  window.addEventListener('resize', applyColWidths)

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
  els.btnNewFile.addEventListener('click', () => newScratchFile())
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
        setStatus(t('status.cmdFailed', { err: (e && e.message) || e }))
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
  // 「设置-外观」：每次改动经 applyAppearanceChange 生效并（防抖）写 settings.json
  apSettings = createAppearanceSettings({
    getAppearance: currentAppearance,
    apply: applyAppearanceChange,
    flush: () => settingsStore.flush(),
    setStatus,
  })
  bindShortcuts()
  setupCloseGuard()
  setupMacMenu()
  setupTrayMenu()

  // 文件树右键菜单：点击菜单外任意处即关闭
  document.addEventListener('pointerdown', (e) => {
    if (treeMenuEl && !treeMenuEl.contains(e.target)) closeTreeMenu()
  }, true)
}

boot().catch((e) => {
  console.error(e)
  if (window.__nlError) window.__nlError(t('status.initFailed', { err: (e && e.message) || e }))
})
