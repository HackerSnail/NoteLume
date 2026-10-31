// main.js —— 应用装配：布局、知识库文件树、大纲、标签、主题、快捷键、打开/保存/跳转
// P1 追加：Rust 索引触发与轮询、双向链接面板、全局搜索、悬浮预览（在 editor-view 里挂）、
// 自动保存 + 库内备份、HTML 导出、打印。
import { selectAll } from 'prosemirror-commands'
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
  probeExternalDrop,
  revealInFolder,
  openUrl,
  ollamaProbe,
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
  takeLaunchPaths,
  openVaultWindow,
  takeWindowVault,
  readImageDataUri,
  fetchRemoteImageDataUri,
  saveImageDataUri,
  startVaultWatcher,
  stopVaultWatcher,
} from './tauri-bridge.js'
import { exportSite, resolveImageRel, collectImages, injectToc } from './site-export.js'
import { exportPlainMd } from './plain-export.js'
import { QD_SNIPPETS, insertSnippet, setQdNotice } from './qd/snippets.js'
import { anchorSlug } from './heading-anchor.js'
import { getFeatures, setFeature } from './feature-flags.js'
import { buildSlidesHtml, buildVaultSlidesHtml } from './slides-export.js'
import { slidesAssets } from './slides-assets.js'
import { printPaged } from './print-paged.js'
import { printOptionsDialog } from './print-options-dialog.js'
import { mountEmojiRenderer } from './emoji-text.js'
import { numberingCss } from './heading-numbering.js'
import { evalQd, qdDocDir, qdLibsDir, qdPackageInstall } from './tauri-bridge.js'
import { docToIR } from './docx-export.js'
import { runImport, IMG_INDEX_KEY, DEFAULT_MAX_IMAGE_BYTES } from './docx-import.js'
import { openDocxReview } from './docx-review.js'
import { createPalette } from './command-palette.js'
import { createShortcutSettings } from './shortcut-settings.js'
import { createHighlightToolbar } from './highlight-toolbar.js'
import { createFormatBar } from './format-bar.js'
import { bindDropOpen, isDroppableName, isBinaryName } from './drop-open.js'
import { bindTauriDragOpen } from './tauri-drag-open.js'
import { createPaneDrag } from './pane-drag.js'
import { mountSplitTree, normalizeTree, serializeTree, paneIds, freshId, closePane } from './split-pane.js'
import { getCurrentWindow } from '@tauri-apps/api/window'
import { getCurrentWebview } from '@tauri-apps/api/webview'
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
import { createPaneStrip } from './pane-strip.js'
import { normVaultPath, rootChanged } from './vault-path.js'
import { detectIsMac, eventToBinding, resolveBinding, effectiveBindings, defaultKeyFor, formatBinding, toAccelerator } from './keymap.js'
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
import { createClipSettings, normalizeClip } from './clip-settings.js'
import { buildTaskMessages, buildDocContext, normalizeAiConfig, aiConfigured, AI_TASK_IDS, resolveAnchorPos } from './ai-tasks.js'
import { createAiSettings } from './ai-settings.js'
import { createAiPanel } from './ai-panel.js'
import { openAiInline } from './ai-inline.js'
import { mdParser } from './editor-schema.js'
import { TextSelection } from 'prosemirror-state'
import { Slice } from 'prosemirror-model'
import { createSettingsStore } from './settings-store.js'
import { t, getLocale, setLocale, applyStaticDom, onLocaleChange, localeName } from './i18n.js'
import { LOCALES } from './locales/index.js'
import { analyzeOutline, hiddenRows } from './outline-tree.js'
import { sanitizeHtml } from './html-sanitize.js'
import MarkdownIt from 'markdown-it'
import { tempDir, join } from '@tauri-apps/api/path'

// mac 上的系统文件管理器是访达，其余平台沿用「文件管理器」这一通用说法。
// 各处右键入口共用这一个取词口，不在每张菜单里重复判平台。
const revealLabel = () => t(IS_MAC ? 'menu.revealInFinder' : 'menu.revealInFolder')

// 用于 HTML 导出的独立 markdown-it 实例：commonmark + table/strikethrough
// 与 editor-schema 里的 tokenizer 分开，避免污染 schema 层的解析器
// html 开着是为了认正文里的字面 HTML（WordPress 一类导出件），但导出件是独立文件，
// 脚本 / 事件属性 / 危险协议一律走编辑器与站点同一份白名单
const exportMd = MarkdownIt('commonmark', { html: true }).enable(['table', 'strikethrough'])
mountEmojiRenderer(exportMd) // emoji 短代码：导出件里的 :name: 出 emoji，md 源文件不变
// 标题锚点：[[toc]] 目录条目的跳转落点（与编辑器 / 站点导出同一套 slug，env 每次渲染新建天然 dedup）
exportMd.renderer.rules.heading_open = (tokens, idx, options, env, self) => {
  const inline = tokens[idx + 1]
  let plain = ''
  if (inline && Array.isArray(inline.children)) {
    for (const ch of inline.children) {
      if (ch.type === 'text' || ch.type === 'code_inline') plain += ch.content
    }
  }
  const base = anchorSlug(plain)
  if (base) {
    env.__anchor = env.__anchor || Object.create(null)
    const cnt = env.__anchor[base] || 0
    env.__anchor[base] = cnt + 1
    tokens[idx].attrSet('id', cnt === 0 ? base : `${base}-${cnt}`)
  }
  return self.renderToken(tokens, idx, options)
}
exportMd.renderer.rules.html_block = (tokens, idx) => sanitizeHtml(tokens[idx].content)
// 行内字面 HTML 保持转义文本：markdown-it 把 <b>x</b> 拆成三个 token，逐个净化会拆散标签配对
exportMd.renderer.rules.html_inline = (tokens, idx, options, env, self) => self.rules.text(tokens, idx, options, env, self)

const state = {
  vaultRoot: null, // 知识库根（绝对路径）
  currentFile: null, // 当前文档库内相对路径
  tempImportRoot: '', // 非空 = 当前 vaultRoot 来自 Word 导入的系统 temp 一次性目录（手动保存会升级为“另存为”）
  scratch: false, // true = 当前文档是「新建到系统临时目录、还没选保存位置」的文件（Ctrl+S / 关闭时会问位置）
  scratchRoot: (() => { try { return localStorage.getItem('nl-scratch-dir') } catch { return null } })(), // 上述临时目录的绝对路径
  mode: 'md', // 'md' 编辑器 | 'canvas' 画布
  dirty: false,
  indexReady: false,
  singleFile: null, // 非空 = 单文件模式（打开的是单个 md / canvas，侧栏只列它，不铺开目录）
  vaultFromFolder: false, // 当前 vaultRoot 是把「文件夹当库打开」得来的，还是只因为打开了夹在里面的某个文件
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
  tabs: null,
  tabsSplit: null,
  btnOpen: $('btn-open'),
  btnOpenFile: $('btn-open-file'),
  btnNewFile: $('btn-new-file'),
  btnSave: $('btn-save'),
  btnTheme: $('btn-theme'),
btnFind: $('btn-find'),
btnReplace: $('btn-replace'),
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
  btnParagraph: $('btn-paragraph'),
  btnMore: $('btn-more'),
  sourceMount: $('source-mount'),
  docstats: $('docstats'),
  sidebar: $('sidebar'),
  inspector: $('inspector'),
  editorPane: $('editor-pane'),
  aiPanel: $('ai-panel'),
}

let editor
let findBar = null // 焦点窗格的查找栏（分栏后每个窗格各一个，见 panes.findBars）
let palette = null
let keySettings = null
let hlBar = null // 选区高亮浮动工具栏（p5plan §6.4）
let apSettings = null // 「设置-外观」面板（appearance-settings.js）
let clipSettings = null // 「网页剪藏」设置面板（clip-settings.js）
let aiSettings = null // 「AI 设置」面板（ai-settings.js）
let aiPanel = null // 侧栏「AI」对话面板（ai-panel.js）
let settingsStore = null // settings.json 读写（boot 最开始装配）
let gitPanel = null
let snapshotPanel = null
let frontmatterPanel = null
let pluginManager = null
let canvasView = null
let paneDrag = null // 窗格拖拽控制器（pane-drag.js，标签 / 文件树 → 窗格）

// 多窗口：settings.json 只有一份，工作区与标签列的记忆归主窗口写。拖入文件夹另开的
// 窗口照常读设置（主题 / 语言 / 功能开关），但不写这两段——否则两个窗口交替操作会把
// 对方的工作区覆盖掉，下次启动只剩最后动过的那个。
const WINDOW_LABEL = window.__TAURI_INTERNALS__ ? getCurrentWindow().label : 'main'
const IS_PRIMARY_WINDOW = WINDOW_LABEL === 'main'

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

// —— 分栏（P5 §6.1，完整模式 spec 2026-10-18-pane-tab-groups）——
// 编辑器区是一棵 SplitPane 树（split-pane.js）：叶子窗格各持一个编辑器实例、一条
// 标签条（pane-strip.js + tabs.js 每窗格实例）与自己的根 / 文档上下文——保存、脏状态、
// 关闭确认都按窗格自己的来；全局 state 只镜像焦点窗格的活动标签（面板、索引、文件树
// 都读它）。标签归属窗格（id = paneId + root + rel），同一文档可在多个窗格各开一份。
// 画布视图是单实例（canvas-mount 只有一个），分栏下禁用。
const panes = {
  tree: null, // SplitPane 树
  focused: 'p1',
  editors: new Map(), // paneId -> 编辑器实例
  findBars: new Map(), // paneId -> 查找栏
  hlBars: new Map(), // paneId -> 选区高亮浮动工具栏（p5plan §6.4）
  fmtBars: new Map(), // paneId -> 内联格式按钮条（format-bar.js）
  contents: new Map(), // paneId -> .nl-pane-body（编辑器 + 源码挂载点）
  mounts: new Map(), // paneId -> { editorDiv, sourceDiv, canvasDiv }
  ctx: new Map(), // paneId -> { vaultRoot, rel, scratch, dirty }
  strips: new Map(), // paneId -> 窗格标签条（pane-strip.js 的返回值）
  view: null, // mountSplitTree 控制器
  canvasPane: null, // 画布挂载点所在的窗格（canvas-mount 单实例，分栏禁用画布）
}

/** 焦点窗格的标签控制器（旧全局 tabs 变量的归宿：所有「当前标签列表」语义都指它）。
 *  返回的是 tabs.js 的控制器，不是 pane-strip 的条子对象——条子级操作（setMulti）
 *  走 panes.strips 自己拿。 */
function ftabs() {
  const strip = panes.strips.get(panes.focused)
  return strip ? strip.tabs : null
}

function paneCtx(paneId) {
  let c = panes.ctx.get(paneId)
  if (!c) {
    c = { vaultRoot: null, rel: null, scratch: false, dirty: false }
    panes.ctx.set(paneId, c)
  }
  return c
}
function paneLeaf(paneId) {
  const body = panes.contents.get(paneId)
  return body && body.parentElement ? body.parentElement : null
}
function dirtyPaneIds() {
  const out = []
  for (const [id] of panes.editors) {
    const c = paneCtx(id)
    if (c.dirty && c.rel) out.push(id)
  }
  return out
}

// 脏标记统一入口：按窗格记（各窗格独立）；写给该窗格活动标签的脏点，
// 焦点窗格额外驱动文件名圆点与自动保存
function markPaneDirty(paneId, d) {
  const ctx = paneCtx(paneId)
  ctx.dirty = d
  const strip = panes.strips.get(paneId)
  const active = strip && strip.tabs.active()
  if (strip && active) strip.tabs.setDirty(active.id, d)
  if (paneId === panes.focused) {
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
}
// 焦点窗格的脏标记（画布与旧调用点走这里）
function markDirty(d) {
  markPaneDirty(panes.focused, d)
}

// 离开前处理未保存改动（分栏后可能多个窗格有改动）：
//  · 无改动 → 直接放行
//  · 开了自动保存 → 涉及的窗格各存一次再放行
//  · 未开自动保存 → 一次问清「全部保存 / 全部不保存 / 取消」；取消则中止操作
// ids 为空表示「所有脏窗格」；传单个 paneId 则只问那一个（关该窗格 / 关它绑的标签）
async function askSavePanes(ids) {
  const dirty = ids && ids.length ? ids : dirtyPaneIds()
  if (!dirty.length) return true
  if (state.autosave.enabled) {
    for (const id of dirty) await savePane(id, false)
    const stuck = dirty.filter((id) => paneCtx(id).dirty)
    if (stuck.length) {
      // 自动保存写盘失败原本只进 console，这里返回 false 会让打开 / 关闭链路
      // 静默中止，用户看来就是「点了没反应」——把失败亮出来
      await messageDialog(t('msg.autosaveFailed'))
      return false
    }
    return true
  }
  const names = dirty.map((id) => baseName(paneCtx(id).rel))
  const choice = await confirm3Dialog({
    title: t('dlg.unsavedTitle'),
    message:
      dirty.length === 1
        ? t('dlg.unsavedMsg', { name: names[0] })
        : t('dlg.unsavedMulti', { n: dirty.length, names: names.join('、') }),
    confirmLabel: t('common.save'),
    neutralLabel: t('common.dontSave'),
    cancelLabel: t('common.cancel'),
  })
  if (choice === 'cancel') return false
  if (choice === 'confirm') {
    for (const id of dirty) await savePane(id, true)
    return !dirty.some((id) => paneCtx(id).dirty) // 保存失败（仍脏）则不继续，避免丢改动
  }
  for (const id of dirty) markPaneDirty(id, false) // 不保存：放弃改动继续
  return true
}

// 离开当前文档（切换 / 打开别处 / 新建）前处理未保存改动。
// 返回 true = 可继续离开，false = 取消（留在当前文档不切换）
async function ensureSavedBeforeLeave() {
  return askSavePanes(null)
}

// 只处理指定窗格的未保存改动（关该窗格 / 关它绑的标签时用）：
// 多窗格下不能把所有脏窗格一起问，关一个标签不该连带问无关窗格。
// 本窗格不脏时直接放行——传空数组给 askSavePanes 会被当成「问所有脏窗格」，
// 第三个窗格的保存弹窗会拦住一个不相干的打开动作。
async function ensurePaneSaved(paneId) {
  if (!dirtyPaneIds().includes(paneId)) return true
  return askSavePanes([paneId])
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
  // 模式开关是全局偏好：所有窗格一起切，免得切焦点时观感跳变
  for (const inst of panes.editors.values()) {
    if (inst) inst.setFocusMode(on)
  }
  setStatus(on ? t('status.focusOn') : t('status.focusOff'))
}

function toggleTypewriterMode() {
  const on = localStorage.getItem('nl-typewriter') !== '1'
  localStorage.setItem('nl-typewriter', on ? '1' : '0')
  for (const inst of panes.editors.values()) {
    if (inst) inst.setTypewriterMode(on)
  }
  setStatus(on ? t('status.typewriterOn') : t('status.typewriterOff'))
}

// 侧栏整栏收起/展开（编辑区随之铺满）；状态持久化
function sidebarHidden() {
  return localStorage.getItem('nl-sidebar') === 'hidden'
}
function currentSideTab() {
  const v = localStorage.getItem('nl-side-tab')
  return v === 'outline' ? v : 'files'
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

// —— 侧栏「文件 / 大纲」共用一块区域：tab 互斥（Typora 式），tab 态持久化 ——
// 栏内 tab 与栏外常驻图标对（.side-corner）共用同一套引擎，不各存一份状态
let sideTabs = []
let sideCorner = []
function setSideTab(name) {
  const tab = currentSideTabSafe(name)
  localStorage.setItem('nl-side-tab', tab)
  for (const b of sideTabs) {
    const on = b.getAttribute('data-tab') === tab
    b.classList.toggle('active', on)
    b.setAttribute('aria-selected', on ? 'true' : 'false')
  }
  if (els.tree) els.tree.classList.toggle('hidden', tab !== 'files')
  if (els.outline) els.outline.classList.toggle('hidden', tab !== 'outline')
  // 搜索框只属于文件页签：大纲有自己的层级树，不要搜索
  const searchBox = document.querySelector('.search-box')
  if (searchBox) searchBox.classList.toggle('hidden', tab !== 'files')
  if (els.searchResults) els.searchResults.classList.toggle('hidden', tab !== 'files')
  syncSideCorner()
}
// 页签白名单：大纲（outline），其余一律落回文件（files）。AI 对话在右栏（见 inspTab 组）
function currentSideTabSafe(name) {
  return name === 'outline' ? name : 'files'
}
function syncSideCorner() {
  const tab = currentSideTab()
  for (const b of sideCorner) b.classList.toggle('active', !sidebarHidden() && b.getAttribute('data-tab') === tab)
}
// 栏外图标的三种落点：收起 → 开栏到该 tab；开着但在另一 tab → 切过去；正停在该 tab → 收起整栏
function openSidebarOn(name) {
  const tab = currentSideTabSafe(name)
  if (!sidebarHidden() && currentSideTab() === tab) {
    toggleSidebar()
    return
  }
  if (sidebarHidden()) toggleSidebar()
  setSideTab(tab)
}
function bindSideTabs() {
  sideTabs = [...document.querySelectorAll('.side-tab[data-tab]')]
  for (const b of sideTabs) b.addEventListener('click', () => setSideTab(b.getAttribute('data-tab')))
  sideCorner = [...document.querySelectorAll('.side-corner-btn[data-tab]')]
  // corner 图标分流：sparkle 独立开合 AI 面板，其余归左栏（openSidebarOn）
  for (const b of sideCorner) {
    b.addEventListener('click', () => {
      if (b.getAttribute('data-tab') === 'ai') toggleAiPanel()
      else openSidebarOn(b.getAttribute('data-tab'))
    })
  }
  const insp = document.getElementById('btn-inspector')
  if (insp) insp.addEventListener('click', () => toggleInspector())
  setSideTab(currentSideTab())
  syncInspector()
}
// —— 右栏：检查器与 AI 面板是两个独立区块，可单独显示也可同时显示（上下堆叠，各自滚动） ——
// 持久化：nl-inspector（检查器）/ nl-ai-open（AI 面板）。nl-ai-open 缺省时看旧版页签记忆迁移。
function aiPanelHidden() {
  const v = localStorage.getItem('nl-ai-open')
  if (v === '1') return false
  if (v === '0') return true
  return localStorage.getItem('nl-insp-tab') !== 'ai'
}
// —— 检查器（右栏）：文档属性 / 标签 / 双向链接 / 历史 / Git / 插件；左栏只留文件与大纲 ——
function inspectorHidden() {
  return localStorage.getItem('nl-inspector') === 'hidden'
}
function syncInspector() {
  const hidden = inspectorHidden()
  const aiHidden = aiPanelHidden()
  // aside 有任意一个区块可见就得显示；两个区块各自独立显隐
  if (els.inspector) els.inspector.classList.toggle('hidden', hidden && aiHidden)
  if (els.inspector) els.inspector.classList.toggle('duo', !hidden && !aiHidden)
  const inspBody = document.getElementById('insp-body')
  if (inspBody) inspBody.classList.toggle('hidden', hidden)
  if (els.aiPanel) els.aiPanel.classList.toggle('hidden', aiHidden)
  const body = document.querySelector('.body')
  if (body) body.classList.toggle('inspector-on', !hidden || !aiHidden) // corner 图标组随右栏整体让位
  const btn = document.getElementById('btn-inspector')
  if (btn) btn.classList.toggle('active', !hidden)
  for (const b of sideCorner) {
    if (b.getAttribute('data-tab') === 'ai') b.classList.toggle('active', !aiHidden)
  }
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
function setAiPanel(hidden) {
  localStorage.setItem('nl-ai-open', hidden ? '0' : '1')
  syncInspector()
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
// 大纲入口不再置灰：没有可列标题时面板里给一行空态文案（QA GU-010：置灰 + 无提示，
// 用户不知道是坏了还是没内容）
function syncOutlineTab() {
  // 保留函数与调用点：栏内 tab 与栏外图标曾经在这里整体置灰，现在只是空态
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
  if (!outlineItems.length) {
    const empty = document.createElement('div')
    empty.className = 'outline-empty'
    empty.textContent = t('outline.empty')
    ol.appendChild(empty)
    syncOutlineTab()
    return
  }
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
  syncFmtBars()
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
  // 源码视图（CodeMirror）按窗格各自换肤：分栏后每个窗格一个实例
  for (const inst of panes.editors.values()) {
    if (inst) inst.setSourceTheme(applied)
  }
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

// 剪藏设置：settings.json 的 clip 段。Rust 侧的本地 HTTP 服务按它起停（启动时读一次，
// 设置面板「保存」时经 clip_server_apply 停旧起新）；前端在 boot 里监听 nl:clip-saved。
function currentClip() {
  return normalizeClip(settingsStore ? settingsStore.get().clip : null)
}

/** 合并改动进 settings.json 的 clip 段（防抖写盘）；内容没变则不写 */
function persistClip(next) {
  if (!settingsStore) return
  const clip = normalizeClip(next)
  const prev = settingsStore.get().clip
  if (JSON.stringify(prev) === JSON.stringify(clip)) return
  settingsStore.update({ clip })
}

// AI 设置：settings.json 的 ai 段（接口地址 / API Key / 模型名）。Rust 侧不存配置，
// 每次调用经 IPC 传参；这里的唯一职责是归一化 + 防抖落盘。
function currentAi() {
  return normalizeAiConfig(settingsStore ? settingsStore.get().ai : null)
}

/** 合并改动进 settings.json 的 ai 段（防抖写盘）；内容没变则不写 */
function persistAi(next) {
  if (!settingsStore) return
  const ai = normalizeAiConfig(next)
  const prev = settingsStore.get().ai
  if (JSON.stringify(prev) === JSON.stringify(ai)) return
  settingsStore.update({ ai })
}

// —— AI：选区任务与写回 ——
// 模型产出按 markdown 解析成 ProseMirror 文档片段再插入（保结构：列表 / 代码块 /
// 引用都还原成节点），解析失败退化为纯文本（inst.insertPlainText 已处理换行）。
function insertAiMarkdown(inst, md, opts = {}) {
  const text = String(md || '').trim()
  if (!text || !inst) return
  const view = inst.view
  let doc = null
  try { doc = mdParser.parse(text) } catch { doc = null }
  view.focus()
  const tr = view.state.tr
  if (opts.caret != null) {
    tr.setSelection(TextSelection.create(view.state.doc, Math.max(0, Math.min(opts.caret, view.state.doc.content.size))))
  }
  if (doc && doc.content && doc.content.size) {
    tr.replaceSelection(new Slice(doc.content, 0, 0))
    view.dispatch(tr.scrollIntoView())
  } else {
    inst.insertPlainText(text) // 解析兜底：退化纯文本
  }
}

/** 恢复 [from, to] 选区后写入（「替换」语义：写回原选区位置） */
function aiReplaceSelection(inst, from, to, md) {
  const size = inst.view.state.doc.content.size
  const f = Math.max(0, Math.min(from, size))
  const tt = Math.max(f, Math.min(to, size))
  inst.view.dispatch(inst.view.state.tr.setSelection(TextSelection.create(inst.view.state.doc, f, tt)))
  insertAiMarkdown(inst, md)
}

/** 在位置 at（原选区结束处）之后插入（「插入」语义：结果追加到选区下方） */
function aiInsertAfter(inst, at, md) {
  insertAiMarkdown(inst, md, { caret: at })
}

/** 侧栏 AI 面板的文档上下文：md 模式下取当前文档正文（截断到上限），canvas / 未打开文档不带 */
function aiDocContext() {
  if (!editor || state.mode !== 'md' || !state.currentFile) return ''
  return buildDocContext(baseName(state.currentFile).replace(/\.md$/i, ''), editor.getText())
}

/** 当前焦点编辑器实例的非空选区文本 + 锚点矩形（浮层定位用）；无选区返回 null */
function aiSelection(inst) {
  const target = inst || editor
  if (!target || !target.view) return null
  const { state: st } = target.view
  const { from, to, empty } = st.selection
  if (empty) return null
  const text = st.doc.textBetween(from, to, '\n')
  if (!text.trim()) return null
  let rect = null
  try {
    const c = target.view.coordsAtPos(to)
    rect = { x: c.left, y: c.top, bottom: c.bottom }
  } catch { rect = null }
  return { text, rect, from, to, inst: target }
}

/** 选区 AI 入口：未配置先开设置；custom 走提示词输入框；其余直接起浮层流式请求 */
function runSelectionAi(taskId, inst) {
  const cfg = currentAi()
  if (!aiConfigured(cfg)) {
    setStatus(t('ai.needConfig'))
    if (aiSettings) aiSettings.open()
    return
  }
  if (taskId === 'custom') {
    promptDialog({
      title: t('ai.task.custom'),
      placeholder: t('ai.customPh'),
    }).then((p) => {
      if (!p || !p.trim()) return
      openSelectionAiInline(taskId, p.trim(), inst)
    })
    return
  }
  openSelectionAiInline(taskId, '', inst)
}

function openSelectionAiInline(taskId, customPrompt, inst) {
  const sel = aiSelection(inst)
  if (!sel) {
    setStatus(t('ai.needSelection'))
    return
  }
  const msgs = buildTaskMessages(taskId, sel.text, customPrompt)
  if (!msgs) return
  openAiInline({
    title: t('ai.task.' + taskId),
    anchorRect: sel.rect,
    getConfig: currentAi,
    messages: msgs,
    setStatus,
    onReplace: (md) => aiReplaceSelection(sel.inst, sel.from, sel.to, md),
    onInsert: (md) => aiInsertAfter(sel.inst, sel.to, md),
  })
}

/** AI 对话面板开合（右栏独立区块，与检查器互不影响）：收起→展开；展开→收起 */
function toggleAiPanel() {
  const hidden = !aiPanelHidden()
  setAiPanel(hidden)
  if (!hidden && aiPanel) aiPanel.focus()
  setStatus(hidden ? t('status.colHidden', { label: t('col.aiPanel') }) : t('status.colShown', { label: t('col.aiPanel') }))
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
    state.vaultFromFolder = true
    state.tempImportRoot = '' // 正式库接管，不再属于临时导入回显位
    const tree = await scanVault(root)
    renderTree(tree)
    setStatus(t('status.vaultLoaded', { root }))
    startIndexPolling()
    // 启动文件系统监听：外部增删改自动刷树 + 重建索引
    startVaultWatcher(root).catch(() => {})
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
  if (!(await ensureSavedBeforeLeave())) return
  const abs = await pickFile()
  if (!abs) return
  try {
    await openAbsPath(abs)
  } catch (e) {
    const msg = (e && e.message) || e
    setStatus(t('msg.openFileFailedDlg', { msg }))
    await messageDialog(t('msg.openFileFailedDlg', { msg }))
  }
}

// 按绝对路径打开单个文档（P5 §6.6：选择器 / 双击关联 / 单实例转发 / 拖入共用）。
// 把文件所在目录作为工作根——保存 / 图片 / wikilink 都依赖一个根。
// preview：拖入 / 单实例转发传 true（预览标签），选择器与启动参数是显式意图、固定标签。
// 出错直接抛：调用方按场景决定弹窗（选择器来的）还是静默（启动恢复）。
async function openAbsPath(abs, preview = false) {
  const { dir, name } = splitAbs(abs)
  leaveCurrentVault(dir) // 跨目录打开：旧根的标签页与文档态作废，避免还指着上一个库
  state.vaultRoot = dir
  state.vaultFromFolder = false // 这个根只是「某个文件所在的目录」，不是用户选的库
  state.tempImportRoot = ''
  state.singleFile = isCanvasPath(name) ? null : name // 画布也铺单文件树，但索引照扫全目录
  const canvas = isCanvasPath(name)
  await openDocInPane(panes.focused, { root: dir, rel: name, scratch: false, canvas }, { preview })
  // 单文件模式：侧栏只列当前这一个（loadDocIntoPane 的跨根分支按 singleFile 判定）
  if (canvas) renderSingleFileTree(name)
  setStatus(t('status.fileOpened', { abs }))
  persistWorkspace()
}

// —— P5 §6.6 文件打开链路：启动参数 / 单实例二次唤起 / 拖入打开 ——
// 工作区记忆（settings.json 的 workspace 段）：下次启动无参数时恢复上次的库与文档。
// 内容没变不写盘（JSON 比对）：点文件不触发一次设置落盘。
function persistWorkspace() {
  if (!settingsStore || !IS_PRIMARY_WINDOW) return
  const cur = settingsStore.get().workspace || {}
  const next = {
    ...cur,
    lastVault: state.vaultRoot || null,
    lastFile: state.currentFile || null,
    // 只有「文件夹被当作库打开」那次才配在下次启动时重铺整棵树；单独打开一个文档
    // （选择器 / 拖入 / 启动参数）顺带把它所在的目录记成根，重启就变成没人要求的
    // 「把那个文件夹里所有内容打开」
    folderVault: !!state.vaultRoot && state.vaultFromFolder,
  }
  if (JSON.stringify(next) === JSON.stringify(cur)) return
  settingsStore.update({ workspace: next })
}

// 按路径打开知识库（无对话框）：启动恢复、拖入文件夹、启动参数里的目录共用。
// 出错抛给调用方：选择器来的要弹窗，启动恢复的只留状态栏（上次的库可能已被移走）。
async function openVaultPath(root, rel) {
  if (!root) return
  if (normVaultPath(root) === normVaultPath(state.vaultRoot)) {
    // 就是当前库：不重扫不重建，只补开指定文档
    if (rel) await openFile(rel)
    state.vaultFromFolder = true // 文件夹是被点名打开的，即便它先前只是某个文件的目录
    persistWorkspace()
    return
  }
  leaveCurrentVault(root)
  state.vaultRoot = root
  state.vaultFromFolder = true // 这是「把文件夹当库打开」，不是某个文件顺带所在的目录
  state.singleFile = null // 正式库接管，退出单文件模式
  state.tempImportRoot = '' // 正式库接管，不再属于临时导入回显位
  const tree = await scanVault(root)
  renderTree(tree)
  setStatus(t('status.vaultLoaded', { root }))
  startIndexPolling()
  // 启动文件系统监听：外部增删改自动刷树 + 重建索引
  startVaultWatcher(root).catch(() => {})
  // 面板按新库重取：反链 / 全局标签 / 快照列表都不许残留旧库内容
  refreshLinkPanels()
  refreshGlobalTags()
  if (snapshotPanel) snapshotPanel.refresh()
  if (pluginManager) pluginManager.reload()
  if (gitPanel) gitPanel.refresh()
  if (rel) await openFile(rel)
  persistWorkspace()
}

// 启动参数 / 单实例转发 / 拖入的统一入口。
// 目录 → 知识库；可识别文档（md / markdown / canvas）→ 打开文件：第一个建立工作根，
// 同目录的其余进标签页；混目录的其余只提示（标签页的根跟着当前文档走，混根多开
// 没有明确语义）。交互场景（拖入 / 二次唤起）遇到不可识别文件弹一次「按纯文本打开」，
// 但二进制 / 系统文件（exe、dll 之类，含拖入的应用自身）静默跳过；启动场景一律
// 静默忽略——参数里混进安装器开关之类的东西不该弹窗。
// preview：交互场景（拖入 / 二次唤起）开预览标签，启动参数是显式意图、开固定标签。
async function handleOpenTargets(targets, { interactive = false, preview = false } = {}) {
  const list = (targets || []).filter((t) => t && t.path)
  if (!list.length) return
  const dirs = list.filter((t) => t.isDir)
  const files = list.filter((t) => !t.isDir && isDroppableName(splitAbs(t.path).name))
  const skipped = list.filter((t) => !t.isDir && !isDroppableName(splitAbs(t.path).name))
  const others = skipped.filter((t) => !isBinaryName(splitAbs(t.path).name))

  if (!files.length && !dirs.length && others.length) {
    if (!interactive) return
    const name = splitAbs(others[0].path).name
    if (!(await confirmDialog(t('ws.openAsPlain', { name })))) return
    if (!(await ensureSavedBeforeLeave())) return
    try {
      await openAbsPath(others[0].path, preview)
    } catch (e) {
      await messageDialog(t('msg.openFileFailedDlg', { msg: (e && e.message) || e }))
    }
    return
  }

  if (skipped.length && interactive) setStatus(t('ws.someSkipped', { n: skipped.length }))
  if (!files.length && !dirs.length) return
  if (!(await ensureSavedBeforeLeave())) return
  try {
    if (dirs.length) await openVaultPath(dirs[0].path)
    if (files.length) {
      await openAbsPath(files[0].path, preview)
      for (const f of files.slice(1)) {
        if (normVaultPath(splitAbs(f.path).dir) !== normVaultPath(state.vaultRoot)) {
          setStatus(t('ws.skippedOtherDir', { name: splitAbs(f.path).name }))
          continue
        }
        await openFile(splitAbs(f.path).name, preview)
      }
    }
  } catch (e) {
    if (interactive) await messageDialog(t('msg.openFileFailedDlg', { msg: (e && e.message) || e }))
    else setStatus(t('ws.restoreFailed', { msg: (e && e.message) || e }))
  }
}

// 启动：取走启动参数；无参数则恢复上次工作区（p5plan §6.6「无参数才恢复上次工作区」）
async function handleLaunchArgs() {
  // 拖入文件夹另开的窗口：库路径按窗口标签暂存在 Rust 侧，先取自己的那份
  if (!IS_PRIMARY_WINDOW) {
    const root = await takeWindowVault().catch(() => null)
    if (!root) return
    try {
      await openVaultPath(root, null)
    } catch (e) {
      setStatus(t('ws.restoreFailed', { msg: (e && e.message) || e }))
    }
    return
  }
  let targets = []
  try {
    targets = await takeLaunchPaths()
  } catch (e) {
    console.warn('[launch] 取启动参数失败', e)
  }
  if (!targets.length) {
    const ws = settingsStore ? settingsStore.get().workspace : null
    // panes 段恢复出了标签就不走工作区老路（上次的 lastFile 已随迁移 / 恢复进窗格）
    const restoredTabs = paneIds(panes.tree).some((id) => {
      const s = panes.strips.get(id)
      return s && s.tabs.list().length > 0
    })
    if (ws && ws.lastVault && ws.folderVault === true && !restoredTabs) {
      try {
        await openVaultPath(ws.lastVault, ws.lastFile || null)
      } catch (e) {
        // 上次的库可能已被移动 / 删除：不打断启动，状态栏留一句
        setStatus(t('ws.restoreFailed', { msg: (e && e.message) || e }))
      }
    }
    return
  }
  await handleOpenTargets(targets)
}

// 单文件模式：侧栏只列当前这一个文件（不铺开整个目录）。
// 单击 = 固定入口（与文件树一致）。
function renderSingleFileTree(name) {
  const li = document.createElement('li')
  li.className = 'tree-file active'
  li.textContent = name
  li.dataset.path = name
  li.dataset.kind = 'file' // 与 renderNode 一致：拖拽绑定按 kind 认文件项
  li.title = name
  li.addEventListener('click', () => openFile(name))
  // 单文件树此前没有任何右键处理：节点上弹 WebView2 原生菜单，空白区整个没菜单。
  // 行为对齐 renderNode 的文件行（菜单各项吃 rel 路径，单文件模式下 state.vaultRoot
  // 就是该文件所在目录，重命名 / 回收站 / 在文件管理器中显示都成立）
  li.addEventListener('contextmenu', (e) => {
    e.preventDefault()
    e.stopPropagation()
    showTreeMenu(e.clientX, e.clientY, { path: name, name, type: 'file' })
  })
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

// Tauri 原生拖放通道（桌面版两端同一条）：窗口留着拖放拦截，HTML5 的 dragover / drop
// 收不到，只来 tauri://drag-drop 事件且只带绝对路径（是否目录由探针命令补）。
// 装了拦截就一定没有 HTML5 事件（tauri-runtime-wry 的 handler 恒返回 true），dev 与
// 打包同一口径；纯 web 构建没有这条通道，那边走 bindDropOpen 的 HTML5 事件。
// 落点与语义都交给 handleDropTargets，与 Windows / Linux 的 tauri-drag-open.js 同一出口。
function bindNativeDrop() {
  if (!window.__TAURI_INTERNALS__) return
  const bodyEl = document.querySelector('.body')
  const mark = (on) => { if (bodyEl) bodyEl.classList.toggle('nl-drop-on', on) }
  getCurrentWebview()
    .onDragDropEvent(async ({ payload }) => {
      const p = payload || {}
      if (p.type === 'enter' || p.type === 'over') {
        clearDropHl() // 落点不再分左右栏：两种目标都是「打开」，树那边的「导入到某夹」高亮会误导
        mark(true)
        return
      }
      if (p.type === 'leave') {
        clearDropHl()
        mark(false)
        return
      }
      if (p.type !== 'drop') return
      mark(false)
      const paths = (p.paths || []).filter(Boolean)
      if (!paths.length) return
      const pos = p.position || {}
      const dpr = window.devicePixelRatio || 1
      const el = Number.isFinite(pos.x) ? document.elementFromPoint(pos.x / dpr, pos.y / dpr) : null
      const targets = []
      for (const path of paths) {
        try {
          const info = await probeExternalDrop(path)
          targets.push({ path, isDir: info.isDir })
        } catch (e) {
          await messageDialog(t('msg.openFileFailedDlg', { msg: errText(e) }))
        }
      }
      if (targets.length) await handleDropTargets(targets, { target: el })
    })
    .catch(() => {}) // 无后端时订阅不到事件
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
        state.vaultFromFolder = true
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
  // 不设 draggable：原生拖没有 data 且一动 pointermove 就断，拖拽走 pane-drag.js 的
  // pointer 链路（bindPaneDragging）
  li.title = node.path
  // 文件树：单击即开固定标签（已开则激活，预览标签一并转正）；拖拽走 pane-drag.js
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
let treeMenuCleanup = null
function closeTreeMenu() {
  if (treeMenuCleanup) {
    treeMenuCleanup()
    treeMenuCleanup = null
  }
  if (treeMenuEl && treeMenuEl.parentNode) treeMenuEl.parentNode.removeChild(treeMenuEl)
  treeMenuEl = null
}
function placeMenu(menu, clientX, clientY) {
  closeTreeMenu() // 单例：开新的先关旧的
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
  // 原生菜单有的关闭行为这里补齐：点外面、Esc、滚轮、改窗口大小
  const onDocDown = (e) => { if (treeMenuEl === menu && !menu.contains(e.target)) closeTreeMenu() }
  const onKey = (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeTreeMenu() } }
  const onDismiss = (e) => {
    // 菜单自身出滚动条后，在菜单里的滚轮是滚动不是「外面滚了」——不能把菜单关掉
    if (e && e.type === 'wheel' && e.target && menu.contains(e.target)) return
    closeTreeMenu()
  }
  document.addEventListener('mousedown', onDocDown, true)
  window.addEventListener('keydown', onKey, true)
  window.addEventListener('wheel', onDismiss, true)
  window.addEventListener('resize', onDismiss)
  treeMenuCleanup = () => {
    document.removeEventListener('mousedown', onDocDown, true)
    window.removeEventListener('keydown', onKey, true)
    window.removeEventListener('wheel', onDismiss, true)
    window.removeEventListener('resize', onDismiss)
  }
}
function makeMenuItem(label, fn, danger, checked, icon, disabled) {
  const b = document.createElement('button')
  b.className = 'cv-menu-item' + (danger ? ' danger' : '')
  if (disabled) b.disabled = true
  const chk = document.createElement('span')
  chk.className = 'cv-menu-check'
  if (checked) setIcon(chk, 'check')
  b.appendChild(chk)
  const lab = document.createElement('span')
  lab.className = 'cv-menu-label'
  if (icon) setIcon(lab, icon, label)
  else lab.textContent = label
  b.appendChild(lab)
  b.addEventListener('mousedown', (e) => e.preventDefault()) // 不夺编辑器焦点
  b.addEventListener('click', () => {
    if (b.disabled) return
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
    menu.appendChild(makeMenuItem(revealLabel(), () => revealVaultPath(node.path)))
    menu.appendChild(makeMenuItem(t('menu.renameMove'), () => renameEntry(node.path, node.name, false)))
    menu.appendChild(menuSep())
    menu.appendChild(makeMenuItem(t('menu.trash'), () => deleteVaultFile(node.path, node.name), true))
  } else {
    menu.appendChild(makeMenuItem(t('menu.newFileEllipsis'), () => newFileIn(node.path)))
    menu.appendChild(makeMenuItem(t('menu.newFolderEllipsis'), () => newFolderIn(node.path)))
    menu.appendChild(menuSep())
    menu.appendChild(makeMenuItem(t('menu.renameMove'), () => renameEntry(node.path, node.name, true)))
    menu.appendChild(makeMenuItem(revealLabel(), () => revealVaultPath(node.path)))
    menu.appendChild(menuSep())
    menu.appendChild(makeMenuItem(t('menu.trash'), () => deleteVaultFile(node.path, node.name), true))
  }
  placeMenu(menu, clientX, clientY)
}

// 在系统文件管理器里显示库内条目（失败弹窗：路径不存在 / 平台命令不可用）
async function revealVaultPath(rel) {
  if (!state.vaultRoot) return
  try {
    await revealInFolder(state.vaultRoot, rel)
  } catch (e) {
    await messageDialog(t('msg.revealFailed', { err: errText(e) }))
  }
}

// —— 文件树空白区右键：在库根新建 ——
function showTreeBgMenu(clientX, clientY) {
  closeTreeMenu()
  const menu = document.createElement('div')
  menu.className = 'cv-menu tree-menu'
  if (state.singleFile || !state.vaultRoot) {
    // 单文件模式 / 尚未打开库：没有「库根」可新建，给打开入口
    menu.appendChild(makeMenuItem(t('cmd.app.openFile'), () => openSingleFile()))
    menu.appendChild(makeMenuItem(t('cmd.app.openFolder'), () => openFolder()))
  } else {
    menu.appendChild(makeMenuItem(t('menu.newFileEllipsis'), () => newFileIn('')))
    menu.appendChild(makeMenuItem(t('menu.newFolderEllipsis'), () => newFolderIn('')))
    menu.appendChild(menuSep())
    menu.appendChild(makeMenuItem(revealLabel(), () => revealVaultPath('')))
  }
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

// —— Quarkdown 可发现性入口 ——
// 片段插入后的「不再 GFM」提示：状态栏轻提示（片段是轻动作，不打断）；
// 内置模板走确认框（创建是重动作，进新文档前把代价说清）
setQdNotice(() => setStatus(t('status.qdSnippetHint')))
// 右键「Quarkdown」子菜单：片段即插即出快照（features.quarkdown 默认开，无需设置）
function openQdInsertMenu(x, y, inst) {
  closeTreeMenu()
  const menu = document.createElement('div')
  menu.className = 'cv-menu tree-menu'
  for (const s of QD_SNIPPETS) {
    menu.appendChild(makeMenuItem(t(s.labelKey), () => insertSnippet(inst.view, s), false, false, s.icon))
  }
  placeMenu(menu, x, y)
}

// 内置 Quarkdown 模板：装好就能跑的可编程示例，不写进库内 Templates/，
// 选了现起一个新文件（默认名带日期；同名覆盖由 Rust 侧 write_md_file 决定，
// 默认名带日期已把撞名概率压到可忽略）
const QD_TEMPLATES = [
  { nameKey: 'tpl.qd.weekly.name', bodyKey: 'tpl.qd.weekly.body' },
  { nameKey: 'tpl.qd.vars.name', bodyKey: 'tpl.qd.vars.body' },
  { nameKey: 'tpl.qd.xref.name', bodyKey: 'tpl.qd.xref.body' },
]

async function newQdTemplate(tpl) {
  if (!state.vaultRoot) { await messageDialog(t('msg.openVaultFirst')); return }
  // 模板生成的文档带 Quarkdown 指令，创建前把「不再 GFM」的代价确认一次
  if (!(await confirmDialog(t('msg.qdGfmWarn'), t('msg.qdGfmTitle')))) return
  const d = new Date()
  const stamp = [d.getFullYear(), String(d.getMonth() + 1).padStart(2, '0'), String(d.getDate()).padStart(2, '0')].join('-')
  const name = await promptDialog({ title: t('dlg.qdTplTitle'), defaultValue: `${t(tpl.nameKey)} ${stamp}`, placeholder: t('dlg.tplFilePh') })
  if (!name) return
  try {
    const rel = await createMdFile(state.vaultRoot, /\.md$/i.test(name) ? name : name + '.md', t(tpl.bodyKey))
    renderTree(await scanVault(state.vaultRoot))
    await openFile(rel)
    setStatus(t('msg.newTplOk', { rel }))
  } catch (e) { await messageDialog(t('msg.newTplFailed', { err: errText(e) })) }
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
    // 内置 Quarkdown 模板：装好就能跑的可编程示例（周报 / 变量化文档头 / 编号与交叉引用），
    // 不写进库内 Templates/，选了现起一个新文件（默认名带日期，重名由用户改名规避覆盖）
    menu.appendChild(menuSep())
    for (const tpl of QD_TEMPLATES) {
      menu.appendChild(makeMenuItem(t(tpl.nameKey), () => newQdTemplate(tpl), false, false, 'terminal'))
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

// 命令子菜单（导出 / Git）：与 mac 菜单栏同构——同一组命令 id，剥掉注册表标题里的
// 归类前缀（「导出」「Git：」，父项已经说了同一件事），勾选态与置灰走同一套口径
function openCmdSubmenu(anchorEl, text, icon, ids, prefixKey) {
  closeTreeMenu()
  const menu = document.createElement('div')
  menu.className = 'cv-menu tree-menu'
  const re = new RegExp('^' + t(prefixKey).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*')
  for (const id of ids) {
    const cmd = commandRegistry.get(id)
    if (!cmd) continue
    const key = commandBindingFor(id)
    const checked = MENU_CHECKED[id] ? MENU_CHECKED[id]() : false
    const title = String(cmd.title).replace(re, '')
    menu.appendChild(makeMenuItem(title + (key ? ' (' + key + ')' : ''), () => runViaShortcut(id), false, checked, null, !menuEnabled(id)))
  }
  placeMenu(menu, anchorEl.getBoundingClientRect().left, anchorEl.getBoundingClientRect().bottom + 4)
}

function openMoreMenu(anchorEl) {
  closeTreeMenu()
  const menu = document.createElement('div')
  menu.className = 'cv-menu tree-menu'
  // 文件：新建 / 打开 → 最近 / 模板 → 保存 / 重命名 / 定位 → 导入导出 → 速记 / 自动保存 / 关闭
  addMenuCmd(menu, 'app.newFile', 'file-plus')
  addMenuCmd(menu, 'app.openFile', 'file')
  addMenuCmd(menu, 'app.openFolder', 'folder')
  menu.appendChild(makeMenuItem(t('menu.recent'), () => openRecentMenu(anchorEl), false, false, 'clock'))
  menu.appendChild(makeMenuItem(t('menu.templateSettings'), () => openTemplateMenu(anchorEl), false, false, 'clipboard'))
  menu.appendChild(menuSep())
  addMenuCmd(menu, 'app.save', 'save')
  addMenuCmd(menu, 'app.renameFile', 'pen')
  addMenuCmd(menu, 'app.revealFile', 'folder')
  menu.appendChild(menuSep())
  addMenuCmd(menu, 'app.importWord', 'file')
  menu.appendChild(makeMenuItem(t('menu.export'), () => openCmdSubmenu(anchorEl, t('menu.export'), 'export', [
    'app.print',
    'app.export',
    'app.exportPlain',
    'app.exportWord',
    'app.exportSlides',
    'app.exportVaultSlides',
    'app.exportSite',
  ], 'menu.exportPrefix'), false, false, 'export'))
  menu.appendChild(menuSep())
  addMenuCmd(menu, 'app.dailyCapture', 'calendar')
  addMenuCmd(menu, 'app.autosave', 'save')
  addMenuCmd(menu, 'app.closeFile', 'close')
  menu.appendChild(menuSep())
  addMenuCmd(menu, 'app.graph', 'graph')
  addMenuCmd(menu, 'app.newCanvas', 'board')
  addMenuCmd(menu, 'app.clipSettings', 'clipboard')
  addMenuCmd(menu, 'app.qdToggleEval', 'terminal')
  addMenuCmd(menu, 'app.qdInstallPackage', 'plus')
  // Git：与 mac 顶级 Git 组同一组命令
  menu.appendChild(makeMenuItem(t('menu.group.git'), () => openCmdSubmenu(anchorEl, t('menu.group.git'), 'branch', [
    'app.git.refresh',
    'app.git.commit',
    'app.git.fetch',
    'app.git.pull',
    'app.git.pullMerge',
    'app.git.push',
    'app.git.remote',
    'app.git.init',
  ], 'menu.gitPrefix'), false, false, 'branch'))
  menu.appendChild(menuSep())
  addMenuCmd(menu, 'app.palette', 'terminal')
  addMenuCmd(menu, 'app.shortcuts', 'sliders')
  addMenuCmd(menu, 'app.appearance', 'palette')
  // 语言：子菜单列出全部语言，当前语言打勾
  menu.appendChild(makeMenuItem(t('menu.language'), () => openLangMenu(anchorEl), false, false, 'globe'))
  addMenuCmd(menu, 'app.about', 'info')
  menu.appendChild(menuSep())
  addMenuCmd(menu, 'app.focusMode', 'target')
  addMenuCmd(menu, 'app.typewriterMode', 'keyboard')
  addMenuCmd(menu, 'app.toggleSidebar', 'sidebar')
  addMenuCmd(menu, 'app.toggleInspector', 'sliders')
  addMenuCmd(menu, 'app.aiPanel', 'sparkle')
  const r = anchorEl.getBoundingClientRect()
  placeMenu(menu, r.left, r.bottom + 4)
}

// 工具条「段落」菜单（Windows / Linux 用；mac 是原生「段落」菜单，两边不同时挂）：
// 直接取 buildMacMenuSpec 的「段落」组渲染 —— 分组、顺序、勾选、置灰、剥掉的「段落：」前缀
// 与 mac 同一份定义，两边不会各改各的。执行走 runViaShortcut → 命令注册表，与命令面板同链路。
function openParagraphMenu(anchorEl) {
  closeTreeMenu()
  const menu = document.createElement('div')
  menu.className = 'cv-menu tree-menu'
  const icons = {
    para: 'pilcrow', quote: 'quote', code: 'code', mermaid: 'diagram', exitBlock: 'arrow-down',
    bullet: 'list-bullet', ordered: 'list-ordered', task: 'task', hr: 'hr', table: 'table', callout: 'lightbulb',
    link: 'link', footnote: 'pen', footnoteDelete: 'eraser', mathBlock: 'math', headingUp: 'arrow-up', headingDown: 'arrow-down',
  }
  const para = (buildMacMenuSpec(menuSpecCtx()).groups.find((g) => g.id === 'paragraph') || { items: [] }).items
  for (const it of para) {
    if (it.type === 'sep') { menu.appendChild(menuSep()); continue }
    const name = it.id.split('.').pop()
    const key = commandBindingFor(it.id)
    const el = makeMenuItem(it.text + (key ? ' (' + key + ')' : ''), () => runViaShortcut(it.id),
      false, it.type === 'check' && !!it.checked, icons[name] || null, it.enabled === false)
    menu.appendChild(el)
  }
  const r = anchorEl.getBoundingClientRect()
  placeMenu(menu, r.left, r.bottom + 4)
}

// —— 编辑器通用右键菜单（窗格内：剪切 / 复制 / 粘贴 + 行内格式 + 插入块）——
// 挂在窗格（.nl-pane）而不是 view.dom：编辑器上下留白、文档下方的空白也归编辑部，
// 那些位置右键照样出这个菜单。表格范围不接——表格菜单挂在 view.dom 上、事件先到它
// 那儿且已 preventDefault，这里见 defaultPrevented 就让路。标签条 / 查找栏 / 源码模式 /
// 输入框不在这接：它们由 installGlobalContextMenu 的 document capture 兜底接管
// （输入框出编辑菜单、标签条出标签菜单），不会再冒 WebView2 原生菜单。
function attachEditorContextMenu(paneId, inst) {
  const pane = inst.view.dom.closest('.nl-pane')
  if (!pane) return
  const SKIP = '.nl-pane-strip, .nl-find-bar, .nl-source, #canvas-mount, input, textarea, select'
  const modKey = (k) => (IS_MAC ? '⌘' + k : 'Ctrl+' + k)
  const withKey = (label, key) => (key ? label + '  ' + key : label)
  pane.addEventListener('contextmenu', (e) => {
    if (e.defaultPrevented) return
    const hit = e.target
    // 图片命中（节点视图的 .nl-img-host 或裸 img）走自绘图片菜单，不进文本菜单也不放行原生
    const imgEl = (hit && hit.closest && hit.closest('.nl-img-host'))
      ? hit.closest('.nl-img-host').querySelector('img')
      : (hit && hit.tagName === 'IMG' ? hit : null)
    if (imgEl) {
      e.preventDefault()
      openImageContextMenu(e, paneId, imgEl)
      return
    }
    if (hit && hit.closest && hit.closest(SKIP)) return
    e.preventDefault()
    closeTreeMenu()
    // 右键落在这个窗格：命令对这个窗格的编辑器求值，别打到焦点窗格上去
    inst.focusEditor()
    const view = inst.view
    const sel = view.state.selection
    const hasSel = !!(sel && !sel.empty)
    const selText = () => view.state.doc.textBetween(view.state.selection.from, view.state.selection.to, '\n', '\n')
    const writeClip = async (text) => {
      try {
        await navigator.clipboard.writeText(text)
        return true
      } catch (err) {
        setStatus(t('status.clipFail', { err: errText(err) }))
        return false
      }
    }
    const menu = document.createElement('div')
    menu.className = 'cv-menu tree-menu'
    // 剪切 / 复制写纯文本（markdown 编辑器要的就是纯文本）；剪切 = 复制成功后按 PM 事务
    // 删选区，不依赖 execCommand('cut') 的 DOM 副作用
    menu.appendChild(makeMenuItem(withKey(t('ctx.cut'), modKey('X')), async () => {
      if (!hasSel) return
      if (await writeClip(selText())) {
        const { from, to } = view.state.selection
        view.dispatch(view.state.tr.delete(from, to))
      }
    }, false, false, null, !hasSel))
    menu.appendChild(makeMenuItem(withKey(t('ctx.copy'), modKey('C')), async () => {
      if (hasSel) await writeClip(selText())
    }, false, false, null, !hasSel))
    menu.appendChild(makeMenuItem(withKey(t('ctx.paste'), modKey('V')), async () => {
      let text = null
      try {
        text = await navigator.clipboard.readText()
      } catch (err) {
        setStatus(t('status.clipFail', { err: errText(err) }))
        return
      }
      if (!text) {
        setStatus(t('status.clipEmpty'))
        return
      }
      inst.insertPlainText(text)
    }))
    menu.appendChild(menuSep())
    const cmd = (id, labelKey) => makeMenuItem(withKey(t(labelKey), commandBindingFor(id)), () => inst.runEditorCommand(id))
    menu.appendChild(cmd('editor.bold', 'cmd.editor.bold'))
    menu.appendChild(cmd('editor.italic', 'cmd.editor.italic'))
    menu.appendChild(cmd('editor.strike', 'cmd.editor.strike'))
    menu.appendChild(cmd('editor.code', 'cmd.editor.code'))
    menu.appendChild(menuSep())
    menu.appendChild(cmd('editor.block.table', 'cmd.block.table'))
    menu.appendChild(cmd('editor.block.code', 'cmd.block.code'))
    menu.appendChild(cmd('editor.block.quote', 'cmd.block.quote'))
    menu.appendChild(cmd('editor.block.hr', 'cmd.block.hr'))
    menu.appendChild(cmd('editor.block.callout', 'cmd.block.callout'))
    menu.appendChild(makeMenuItem(t('ctx.qd'), () => openQdInsertMenu(e.clientX, e.clientY, inst), false, false, 'terminal'))
    menu.appendChild(menuSep())
    // AI：选区任务（润色 / 续写 / 翻译 / 摘要 / 自定义提示词）。结果浮层流式预览，
    // 可写回选区 / 追加到选区下方 / 复制；无选区时整组置灰
    const aiIcon = { polish: 'pen', 'continue': 'arrow-down', translate: 'globe', summarize: 'list-bullet', custom: 'sliders' }
    for (const task of AI_TASK_IDS) {
      menu.appendChild(makeMenuItem(t('ai.task.' + task), () => runSelectionAi(task, inst), false, false, aiIcon[task] || 'sparkle', !hasSel))
    }
    menu.appendChild(menuSep())
    menu.appendChild(makeMenuItem(withKey(t('ctx.selectAll'), modKey('A')), () => {
      selectAll(view.state, view.dispatch)
      view.focus()
    }))
    placeMenu(menu, e.clientX, e.clientY)
  })
}

// —— 全局右键兜底：应用内不再弹 WebView2 原生菜单（返回/刷新/检查那一套）——
// 已有自绘菜单的区域（编辑器正文 / 表格 / 图片 / 文件树 / 画布）在冒泡阶段自己
// preventDefault，capture 阶段不能抢：命中它们的区域直接放行。其余区域分两类：
// 可编辑目标（输入框 / 源码 CodeMirror）弹自绘编辑菜单；标签条弹标签菜单；
// 剩下的（工具条 / 状态栏 / 侧栏空白等）压掉原生菜单、不出菜单。
function installGlobalContextMenu() {
  document.addEventListener('contextmenu', (e) => {
    if (e.defaultPrevented) return
    const hit = e.target
    if (!(hit instanceof Element)) return
    if (hit.closest('#canvas-mount')) return // 画布的 svg 监听自己 preventDefault
    const pane = hit.closest('.nl-pane')
    const inStrip = !!(pane && hit.closest('.nl-pane-strip'))
    // .ProseMirror 也是 contenteditable，但正文有窗格监听的自绘菜单（剪切/复制 + 块格式），
    // 不能被下面的纯输入框编辑菜单抢走
    const editable = !!hit.closest('input, textarea, select, [contenteditable="true"], .cm-content')
      && !hit.closest('.ProseMirror')
    if (pane && !inStrip && !editable) return // 编辑器 / 表格 / 图片：窗格监听在冒泡阶段接手
    if (hit.closest('#filetree')) return // 文件树：节点与空白区都已有自绘菜单
    e.preventDefault()
    closeTreeMenu()
    if (hit.closest('#sidebar')) {
      // 侧栏空白（树行之外的区域）：与树空白区同一张菜单——库模式给新建，单文件 / 无库给
      // 打开入口；搜索框等可编辑目标仍是编辑菜单
      if (editable) openEditContextMenu(e, hit)
      else showTreeBgMenu(e.clientX, e.clientY)
      return
    }
    if (inStrip && !editable) openTabContextMenu(e, pane)
    else if (editable) openEditContextMenu(e, hit)
  }, true)
}

// 可编辑目标（input / textarea / CodeMirror 源码）的自绘编辑菜单。
// 不用 document.execCommand('paste')（WebView2 里拿不到系统剪贴板读权限），
// 统一走 navigator.clipboard 读 + 就地写回；写回对 CM 用 insertText（CM6 经
// beforeinput 接住），对输入框用 setRangeText 并补发 input 事件。
function openEditContextMenu(e, target) {
  const editable = target.closest('input, textarea, [contenteditable="true"], .cm-content')
  if (!editable) return
  const isBox = editable instanceof HTMLInputElement || editable instanceof HTMLTextAreaElement
  const isCM = !!(editable.closest && editable.closest('.cm-editor'))
  let boxSel = null // [start, end]
  if (isBox) {
    try { boxSel = [editable.selectionStart, editable.selectionEnd] } catch (_) {}
  }
  const ceSel = !isBox && (() => {
    const s = window.getSelection()
    return !!(s && !s.isCollapsed && s.anchorNode && editable.contains(s.anchorNode))
  })()
  const hasSel = isBox ? !!(boxSel && boxSel[0] != null && boxSel[0] !== boxSel[1]) : ceSel
  const selectedText = () => (isBox
    ? editable.value.slice(boxSel[0], boxSel[1])
    : String(window.getSelection() || ''))
  const writeClip = async (text) => {
    try { await navigator.clipboard.writeText(text); return true } catch (_) { return false }
  }
  const insertText = (text) => {
    if (isBox) {
      const s = boxSel && boxSel[0] != null ? boxSel[0] : editable.value.length
      const end = boxSel && boxSel[1] != null ? boxSel[1] : s
      editable.setRangeText(text, s, end, 'end')
      editable.dispatchEvent(new Event('input', { bubbles: true }))
    } else {
      document.execCommand('insertText', false, text)
    }
  }
  const modKey = (k) => (IS_MAC ? '⌘' + k : 'Ctrl+' + k)
  const withKey = (label, key) => (key ? label + '  ' + key : label)
  const menu = document.createElement('div')
  menu.className = 'cv-menu tree-menu'
  if (!isCM) {
    menu.appendChild(makeMenuItem(withKey(t('ctx.undo'), modKey('Z')), () => {
      editable.focus()
      document.execCommand('undo')
    }))
  }
  menu.appendChild(makeMenuItem(withKey(t('ctx.cut'), modKey('X')), async () => {
    if (!hasSel) return
    if (await writeClip(selectedText())) {
      editable.focus()
      if (isBox) {
        editable.setRangeText('', boxSel[0], boxSel[1], 'start')
        editable.dispatchEvent(new Event('input', { bubbles: true }))
      } else {
        document.execCommand('delete')
      }
    }
  }, false, false, null, !hasSel))
  menu.appendChild(makeMenuItem(withKey(t('ctx.copy'), modKey('C')), async () => {
    if (hasSel) await writeClip(selectedText())
  }, false, false, null, !hasSel))
  menu.appendChild(makeMenuItem(withKey(t('ctx.paste'), modKey('V')), async () => {
    let text = null
    try { text = await navigator.clipboard.readText() } catch (_) {}
    if (!text) return
    editable.focus()
    insertText(text)
  }))
  menu.appendChild(menuSep())
  menu.appendChild(makeMenuItem(withKey(t('ctx.selectAll'), modKey('A')), () => {
    editable.focus()
    if (isBox) editable.select()
    else document.execCommand('selectAll')
  }))
  placeMenu(menu, e.clientX, e.clientY)
}

// 标签条右键：关闭 / 关闭其他 / 固定预览标签 / 复制路径 / 在系统文件管理器中显示。
// 条子不在焦点窗格时先切焦点——closeTab 全链路只认焦点窗格
function openTabContextMenu(e, pane) {
  const paneId = pane.dataset.paneId
  const strip = panes.strips.get(paneId)
  if (!strip) return
  const tabs = strip.tabs
  const tabEl = e.target.closest('.tab[data-id]')
  const tab = tabEl ? tabs.get(tabEl.dataset.id) : tabs.active()
  if (!tab) return
  closeTreeMenu()
  const list = tabs.list()
  const menu = document.createElement('div')
  menu.className = 'cv-menu tree-menu'
  menu.appendChild(makeMenuItem(t('menu.tabClose'), async () => {
    if (paneId !== panes.focused) await focusPaneUi(paneId)
    closeTab(tab.id)
  }))
  menu.appendChild(makeMenuItem(t('menu.tabCloseOthers'), async () => {
    if (paneId !== panes.focused) await focusPaneUi(paneId)
    for (const it of tabs.list()) {
      if (it.id !== tab.id && tabs.get(it.id)) await closeTab(it.id)
    }
  }, false, false, null, list.length <= 1))
  if (tab.preview) menu.appendChild(makeMenuItem(t('menu.tabPin'), () => tabs.pin(tab.id)))
  menu.appendChild(menuSep())
  menu.appendChild(makeMenuItem(t('menu.copyPath'), async () => {
    const sep = /[\\/]$/.test(tab.root) ? '' : '/'
    const full = tab.root ? tab.root + sep + tab.rel : tab.rel
    try {
      await navigator.clipboard.writeText(full)
      setStatus(t('status.pathCopied', { path: full }))
    } catch (err) {
      setStatus(t('status.clipFail', { err: errText(err) }))
    }
  }))
  menu.appendChild(makeMenuItem(revealLabel(), async () => {
    if (tab.root) {
      try { await revealInFolder(tab.root, tab.rel) } catch (err) {
        await messageDialog(t('msg.revealFailed', { err: errText(err) }))
      }
    } else revealVaultPath(tab.rel)
  }, false, false, null, !tab.root))
  placeMenu(menu, e.clientX, e.clientY)
}

// 图片右键的自绘菜单：另存为 / 复制图像 / 复制图像链接（远程图）。字节统一走 data: URL——
// 本地图 readImageDataUri（限库内），远程图 fetchRemoteImageDataUri（Rust 系统下载，无 Referer，
// 前端 fetch 被 CORS 挡死拿不到外链字节）。复制图像经 canvas 转 PNG，避开剪贴板对源格式的挑剔。
function openImageContextMenu(e, paneId, imgEl) {
  closeTreeMenu()
  const menu = document.createElement('div')
  menu.className = 'cv-menu tree-menu'
  const src = imgEl.getAttribute('src') || ''
  const isRemote = /^https?:/i.test(src)
  const name = decodeURIComponent((src.split('?')[0].split('#')[0].split('/').pop() || '').trim()) || 'image.png'
  const dataUriFor = () => (isRemote
    ? fetchRemoteImageDataUri(src)
    : readImageDataUri(paneCtx(paneId).vaultRoot || '', paneCtx(paneId).rel || '', src))
  menu.appendChild(makeMenuItem(t('ctx.imgSave'), async () => {
    try {
      const dest = await pickSaveAs(name)
      if (!dest) return
      await saveImageDataUri(dest, await dataUriFor())
      setStatus(t('status.imgSaved', { name: dest.split(/[\\/]/).pop() }))
    } catch (err) {
      setStatus(t('status.imgFail', { msg: errText(err) }))
    }
  }))
  menu.appendChild(makeMenuItem(t('ctx.imgCopy'), async () => {
    try {
      const blob = await dataUriToPngBlob(await dataUriFor())
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
      setStatus(t('status.imgCopied'))
    } catch (err) {
      setStatus(t('status.imgFail', { msg: errText(err) }))
    }
  }))
  if (isRemote) {
    menu.appendChild(makeMenuItem(t('ctx.imgCopyLink'), async () => {
      try {
        await navigator.clipboard.writeText(src)
        setStatus(t('status.imgLinkCopied'))
      } catch (err) {
        setStatus(t('status.imgFail', { msg: errText(err) }))
      }
    }))
  }
  placeMenu(menu, e.clientX, e.clientY)
}

// data: URL → PNG blob（data URI 不污染画布；SVG 无固有尺寸时兜底 1024 宽）
async function dataUriToPngBlob(uri) {
  const img = new Image()
  img.src = uri
  await img.decode()
  const w = img.naturalWidth || 1024
  const h = img.naturalHeight || Math.round(1024 / (img.width / img.height || 1)) || 1024
  const cv = document.createElement('canvas')
  cv.width = w
  cv.height = h
  cv.getContext('2d').drawImage(img, 0, 0, w, h)
  return await new Promise((res, rej) => cv.toBlob((b) => (b ? res(b) : rej(new Error('toBlob'))), 'image/png'))
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
    state.vaultFromFolder = true // 整棵目录树已铺开，这个根就是个库
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
  paneCtx(panes.focused).rel = newCf
  els.filename.textContent = newCf
  highlightActiveFile()
  const tabs = ftabs()
  if (tabs && tabs.active()) {
    tabs.update(tabs.active().id, { rel: newCf })
  }
}

async function deleteVaultFile(rel, name) {
  if (!state.vaultRoot) return
  const ok = await confirmDialog(t('msg.trashConfirm', { name }), t('msg.trashTitle'))
  if (!ok) return
  try {
    await deleteFile(state.vaultRoot, rel)
    // 索引同步：从索引移除这条文档（canvas 不在索引内，为空操作）
    try { await removeIndexDoc(rel) } catch (_) {}
    // 删的是当前打开文档（或其所在目录）时：清空编辑区，回到无文档态
    const hitCurrent = !!state.currentFile && (state.currentFile === rel || state.currentFile.startsWith(rel + '/'))
    if (hitCurrent) {
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
      // 关掉当前页并激活邻居（没有就清空窗格）
      const tabs = ftabs()
      const act = tabs && tabs.active()
      if (act) {
        const next = tabs.neighborOf(act.id)
        tabs.remove(act.id)
        if (next) await openDocInPane(panes.focused, next, { preview: !!next.preview })
        else await closePaneIfEmpty(panes.focused)
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
    // 正文留空：文件名已带「未命名」，再预置一行 H1 会让用户打的第一行落进标题、
    // 被列进大纲（QA GU-010「正文首行误列」），与「新文档从正文开始」的直觉相反
    await writeMdFile(root, rel, '')
    await openDocInPane(panes.focused, { root, rel, scratch: true })
    setStatus(t('status.createdScratch'))
    editor.focus()
  } catch (e) {
    await messageDialog(t('msg.newFileFailed', { err: errText(e) }))
  }
}

// 切到焦点窗格内的另一个标签：走既有打开链路（脏检查 → 激活 → 换内容）。
// 完整分栏后标签归窗格所有，条子之外的入口点不到别窗格的标签。
async function switchToTab(id) {
  const tabs = ftabs()
  if (!tabs) return
  const tab = tabs.get(id)
  if (!tab) return
  if (tabs.active() && tabs.active().id === id) return // 点的就是当前标签
  await openDocInPane(panes.focused, tab, { preview: !!tab.preview })
}

/**
 * 打开一个文档进指定窗格并完成标签入列（spec §5.1）：
 *   1. 该窗格已有同 (root, rel) 标签 → 激活 + 换内容（脏检查照旧）；
 *   2. 预览入口且该窗格有旧预览 → 先问旧预览的未保存改动，取消则整体中止；
 *   3. 脏检查（一个编辑器实例：换内容前必须处理当前文档的改动）；
 *   4. 装内容 + 标签入列（openPreview 内部摘旧预览）+ 根变化门控 + 最近记录。
 * 装内容失败（文件没了 / 读取出错）时摘掉刚入列的标签，不留空壳。
 */
async function openDocInPane(paneId, doc, { preview = false } = {}) {
  let strip = panes.strips.get(paneId)
  if (!strip) {
    // 树里有叶子但实例没了（异常时序的残留）：落到还有实例的窗格，不静默丢弃
    paneId = panes.strips.has(panes.focused)
      ? panes.focused
      : paneIds(panes.tree).find((id) => panes.strips.has(id))
    strip = paneId ? panes.strips.get(paneId) : null
    if (!strip) return
  }
  if (doc.canvas && paneId !== panes.canvasPane) {
    // 画布视图是单实例（canvas-mount 一个），分栏下不允许在非画布窗格开画布
    setStatus(t('pn.canvasSplit'))
    return
  }
  const exist = strip.tabs.list().find((x) => x.root === doc.root && x.rel === doc.rel)
  if (exist) {
    if (strip.tabs.active() && strip.tabs.active().id === exist.id) {
      // 已是活动标签：固定入口（双击 / wikilink / 启动参数）把预览转正，再重载内容
      if (!preview && exist.preview) strip.tabs.pin(exist.id)
      await loadDocIntoPane(paneId, doc) // 重载内容（外部改动），不问脏
      persistPanes() // 转正改变序列化结果；纯重载被 dedupe 拦下，不产生写盘
      return
    }
    if (!(await ensurePaneSaved(paneId))) return
    strip.tabs.activate(exist.id)
    await loadDocIntoPane(paneId, doc)
    persistPanes() // 激活位要落盘，重启才能恢复到这个标签
    return
  }
  if (!(await ensurePaneSaved(paneId))) return
  let opened = null
  try {
    opened = preview ? strip.tabs.openPreview(doc) : strip.tabs.open(doc)
    await loadDocIntoPane(paneId, doc)
  } catch (e) {
    if (opened && !opened.existed) strip.tabs.remove(opened.id)
    if (!strip.tabs.list().length) showPaneEmpty(paneId, true)
    throw e
  }
  // 临时文件不进「最近打开」：它的归宿是另存为那一刻的正式路径（saveScratchAs 里记）
  if (!doc.scratch) recordRecent(doc.root, doc.rel)
  persistWorkspace()
  persistPanes() // 开标签 / 换激活位都动标签列，「开关标签都落盘」的开在这补上
  if (gitPanel) gitPanel.refresh()
  if (snapshotPanel) snapshotPanel.refresh()
}

/**
 * 把文档内容装进窗格（不碰标签入列，那由 openDocInPane 负责）。
 * 读根取窗格自己的 ctx——一个窗格里可能有跨根标签（库文件 + 临时文件），
 * 全局 state.vaultRoot 只镜像焦点窗格。焦点窗格额外同步全局镜像；根没变只刷
 * 高亮与面板，根变了才重扫树 / 重建索引 / 重载插件（预览浏览不能每次都重扫）。
 */
async function loadDocIntoPane(paneId, doc) {
  const ctx = paneCtx(paneId)
  const rootChangedNow = rootChanged(ctx.vaultRoot, doc.root)
  // 失败回滚用：读取 / 装载半路抛错时上下文退回原状。留着 doc.rel 的「幽灵 ctx」
  // 会让 openFile 的同文档早退误命中——窗格明明是空态，点那个文件却再没反应
  const prev = { vaultRoot: ctx.vaultRoot, rel: ctx.rel, scratch: ctx.scratch }
  // 全局镜像另记一份：开库只设 state.vaultRoot，焦点窗格的 ctx.vaultRoot 要等首个文档
  // 装载才写。按 ctx 的旧值回退全局会把「库已打开」抹掉，之后点文件树全在
  // openFile 开头静默返回
  const prevGlobal = { root: state.vaultRoot, file: state.currentFile, scratch: state.scratch }
  ctx.vaultRoot = doc.root
  ctx.rel = doc.rel
  ctx.scratch = !!doc.scratch
  ctx.dirty = false
  try {
    if (paneId === panes.focused) {
      state.tempImportRoot = '' // 独立解析模式只对焦点窗格有意义
      state.currentFile = doc.rel
      state.scratch = ctx.scratch
      // 全局根一并镜像：boot 恢复布局只走这条路装文档，不补镜像的话
      // state.vaultRoot 停在 null，重启后点文件树会在 openFile 静默返回
      state.vaultRoot = doc.root
    }
    if (doc.canvas) {
      await openCanvas(doc.rel)
    } else {
      const md = await readMdFile(doc.root, doc.rel)
      const inst = panes.editors.get(paneId)
      if (paneId === panes.focused) {
        setMode('md')
        editor.setMarkdown(md)
        updateDocStats() // setMode 里的刷新发生在换文档之前，这里补一次
        els.filename.textContent = ctx.scratch ? await joinPath(doc.root, doc.rel) : doc.rel
      } else if (inst) {
        // 非焦点窗格：装进它自己的编辑器实例，不抢全局焦点与面板
        inst.setMarkdown(md)
      }
      showPaneEmpty(paneId, false)
      if (pluginManager) pluginManager.fireFileOpen(doc.rel, md)
    }
    markPaneDirty(paneId, false) // setMarkdown 会 onDirty(false)，显式一次确保脏点清掉
    resetBackupTimer()
    if (paneId === panes.focused) {
      if (rootChangedNow) {
        // 跨根：树与索引跟着这个窗格的文档走（既有跨库切页链路）
        if (ctx.scratch || state.singleFile || !prevGlobal.root) {
          // 临时目录 / 单文件模式 / 启动恢复时并没有开过库（只记住了那篇文档）：
          // 侧栏不铺开目录，只列当前这一个
          state.tree = []
          renderSingleFileTree(doc.rel)
        } else {
          renderTree(await scanVault(doc.root))
        }
        startIndexPolling()
        if (pluginManager) pluginManager.reload()
      } else {
        highlightActiveFile()
        refreshLinkPanels()
      }
      if (snapshotPanel) snapshotPanel.refresh()
      if (gitPanel) gitPanel.refresh()
    }
  } catch (e) {
    Object.assign(ctx, prev)
    if (paneId === panes.focused) {
      state.currentFile = prevGlobal.file
      state.scratch = prevGlobal.scratch
      state.vaultRoot = prevGlobal.root // 镜像退回装载前的值，别留下指向新根的残留
    }
    throw e
  }
  scheduleMacChrome()
}

// 窗格空了之后的收尾：多于一个窗格时整格关掉（点 × 关的是文档，没人想留一排
// 空窗格手动关）；只剩最后一个窗格时保留，空态承接下一次打开。
async function closePaneIfEmpty(paneId) {
  clearPane(paneId)
  if (paneIds(panes.tree).length > 1) {
    await closePaneUi(paneId) // 整格关掉那条由 closePaneUi 自己落盘
    return
  }
  refreshLinkPanels()
  if (snapshotPanel) snapshotPanel.refresh()
  // 末窗格留空态这条分支没人落盘：关光的标签与 lastFile 还留在设置里，下次启动又恢复回来
  persistPanes()
  persistWorkspace()
}

// 关一个标签（× / 中键 / Ctrl+W）。标签只可能属于焦点窗格（条子就挂在窗格上）：
// 非活动标签直接摘；活动标签先问脏（临时页多问一次要不要选正式位置），关完激活
// 右邻再左邻，关光了就整格自动关掉（最后一个窗格保留空态）。
async function closeTab(id) {
  const tabs = ftabs()
  if (!tabs) return
  const tab = tabs.get(id)
  if (!tab) return
  const paneId = panes.focused
  const isActive = !!tabs.active() && tabs.active().id === id
  if (isActive) {
    if (tab.scratch) {
      // 临时页：先按常规处理改动（选「保存」会走另存为，成功后这一页已不再是临时页），
      // 仍是临时页（没改动 / 自动保存过 / 选了不保存）再问要不要选正式位置
      if (!(await ensurePaneSaved(paneId))) return
      const choice = await confirm3Dialog({
        title: t('dlg.scratchTitle'),
        message: t('dlg.scratchMsg', { name: baseName(tab.rel) }),
        confirmLabel: t('dlg.scratchChoose'),
        neutralLabel: t('dlg.scratchClose'),
        cancelLabel: t('common.cancel'),
      })
      if (choice === 'cancel') return
      if (choice === 'confirm' && !(await saveScratchAs())) return
    } else if (!(await ensurePaneSaved(paneId))) {
      return
    }
  }
  // 另存为会改这一页的 id（root/rel 变了），故用 tab 对象上的现值，不用入参 id
  const cur = tabs.get(tab.id) || tab
  const next = isActive ? tabs.neighborOf(cur.id) : null // 先问邻居，再移除
  tabs.remove(cur.id)
  if (next) {
    await openDocInPane(paneId, next, { preview: !!next.preview })
  } else if (isActive) {
    await closePaneIfEmpty(paneId)
  }
}

// 回到无文档态：清编辑器 / 统计 / 脏标记 / 文件名（标签页与面板由调用方决定）
function resetToNoDoc() {
  setMode('md')
  clearPane(panes.focused)
}

// 清空指定窗格（内容 + 上下文 + 空态提示），不动其它窗格；焦点窗格额外清全局镜像
function clearPane(paneId) {
  const ctx = paneCtx(paneId)
  ctx.vaultRoot = null
  ctx.rel = null
  ctx.scratch = false
  ctx.dirty = false
  const inst = panes.editors.get(paneId)
  if (inst) inst.setMarkdown('')
  showPaneEmpty(paneId, true)
  if (paneId === panes.focused) {
    state.currentFile = null
    state.scratch = false
    markDirty(false) // 走统一入口：顺带清掉待触发的自动保存，避免切走后存错文件
    updateDocStats() // setMode 里的刷新发生在清空之前，这里补一次归零
    els.filename.textContent = t('ui.noDocOpen')
    els.filename.classList.remove('dirty')
  }
}

// 空态提示：窗格里没有文档时盖一句引导（分栏后新窗格 / 关掉文档的窗格会看到）
function showPaneEmpty(paneId, on) {
  const body = panes.contents.get(paneId)
  if (!body) return
  let hint = body.querySelector('.nl-pane-empty')
  if (on) {
    if (!hint) {
      hint = document.createElement('div')
      hint.className = 'nl-pane-empty'
      hint.textContent = t('pn.emptyHint')
      body.appendChild(hint)
    }
  } else if (hint) {
    hint.remove()
  }
  syncFmtBars()
}

// 换根（换知识库 / 单文件模式 / 打开跨库的最近文档）前的收尾：
// 旧根的打开记录整体作废——标签页清空、绑定表清空、回到无文档态、清掉搜索残留。
// 不做脏检查（调用方在换根前已问过），也不重扫树（由调用方按新根扫）。
// 其它窗格里已加载的文档保留（各自的 ctx 还在，照常能保存），只是没了标签。
// 返回 false = 挑的就是当前根，调用方应原样返回，不动任何状态。
function leaveCurrentVault(root) {
  if (normVaultPath(root) === normVaultPath(state.vaultRoot)) return false
  const tabs = ftabs()
  if (tabs) tabs.clear()
  // 停止旧库的文件系统监听
  stopVaultWatcher().catch(() => {})
  state.singleFile = null
  resetToNoDoc()
  // 搜索结果还挂着旧库的命中：点进去会用新根打开一个同名（或不存在）的文件
  els.searchInput.value = ''
  els.searchResults.innerHTML = ''
  return true
}

// Ctrl+Tab / Ctrl+Shift+Tab：焦点窗格内循环切标签（dir = 1 下一个，-1 上一个）
async function cycleTab(dir) {
  const tabs = ftabs()
  if (!tabs) return
  const list = tabs.list()
  if (list.length < 2) {
    setStatus(list.length ? t('status.oneTab') : t('status.noTab'))
    return
  }
  const active = tabs.active()
  const i = active ? list.findIndex((x) => x.id === active.id) : -1
  const from = i < 0 ? 0 : i
  const next = list[(from + dir + list.length) % list.length]
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
    state.vaultFromFolder = false // 选的是「这个文件存哪儿」，不是把该目录当库打开
    state.tempImportRoot = ''
    state.scratch = false
    state.currentFile = name
    const ctx = paneCtx(panes.focused)
    ctx.vaultRoot = dir
    ctx.rel = name
    ctx.scratch = false
    editor.markSaved()
    markPaneDirty(panes.focused, false)
    els.filename.textContent = abs
    const tabs = ftabs()
    if (tabs && tabs.active()) {
      // update 自己按新 root/rel 重拼 id 并搬脏标记，没有外部绑定表要 rekey
      tabs.update(tabs.active().id, { root: dir, rel: name, scratch: false })
    }
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
// 兼容入口：文件树 / wikilink / 搜索 / 命令面板 / 最近打开都经它落焦点窗格。
// preview = true 是预览入口（拖入打开 / 单实例二次唤起），false 是固定入口（文件树 / 其余全部）。
// 图片附件走独立查看器，不切换当前文档、不触发脏状态确认。
async function openFile(rel, preview = false) {
  if (!state.vaultRoot) return
  if (isImagePath(rel)) {
    openImage(rel, { vaultRoot: state.vaultRoot })
    return
  }
  const ctx = paneCtx(panes.focused)
  const emptyBody = panes.contents.get(panes.focused)
  const emptyShown = !!(emptyBody && emptyBody.querySelector('.nl-pane-empty'))
  if (ctx.rel === rel && !emptyShown) {
    // 点的就是当前文档：固定入口把预览标签转正；预览入口只把焦点给编辑器
    if (!preview) {
      const tabs = ftabs()
      const act = tabs && tabs.active()
      if (act && act.preview) tabs.pin(act.id)
    }
    editor.focus()
    return
  }
  try {
    await openDocInPane(
      panes.focused,
      { root: state.vaultRoot, rel, scratch: isScratchRoot(state.vaultRoot), canvas: isCanvasPath(rel) },
      { preview },
    )
    setStatus(t('status.opened', { rel }))
    editor.focus()
  } catch (e) {
    await messageDialog(t('status.openFailed', { msg: e }))
    // 打不开多半是这一条已被外部删走 / 移走：重扫一次，别让死行留在树上等人再点
    try {
      renderTree(await scanVault(state.vaultRoot))
    } catch (_) {
      /* 连库根都取不到：留给下一次开库的提示 */
    }
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
  syncFmtBars()
}

// 画布打开（内容装载；标签入列由 openDocInPane 负责）。
// 画布视图单实例，只在画布窗格（canvasPane）里开。
async function openCanvas(path) {
  try {
    if (panes.focused !== panes.canvasPane) {
      setStatus(t('pn.canvasSplit')) // 画布视图单实例，分栏下只能在画布窗格开
      return
    }
    setMode('canvas') // 先显示容器，open 内的 fitView 才能拿到真实尺寸（否则 0×0 会把节点甩到左上角）
    await canvasView.open(path)
    const ctx = paneCtx(panes.canvasPane)
    ctx.dirty = false
    els.filename.textContent = path
    showPaneEmpty(panes.canvasPane, false)
    setStatus(t('status.canvasOpened', { path }))
    resetBackupTimer()
  } catch (e) {
    // 不在这里弹窗：openDocInPane 会摘掉刚入列的标签，由最外层调用方统一报错
    throw e
  }
}

async function newCanvas() {
  if (!state.vaultRoot) {
    setStatus(t('status.needVaultFolder'))
    await messageDialog(t('msg.canvasNeedVault'), 'info')
    return
  }
  if (panes.focused !== panes.canvasPane) {
    setStatus(t('pn.canvasSplit')) // 画布视图单实例，分栏下只能在画布窗格新建
    return
  }
  if (!(await ensureSavedBeforeLeave())) return
  const d = new Date()
  const pad = (n) => String(n).padStart(2, '0')
  const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  const name = t('doc.canvasName') + '-' + stamp + '.canvas'
  try {
    setMode('canvas') // 先显示容器，newBlank 里 centerWorld 才能拿到真实尺寸
    await canvasView.newBlank(name)
    await canvasView.save() // 先落盘一个空画布，使其出现在文件树
    renderTree(await scanVault(state.vaultRoot))
    await openDocInPane(panes.canvasPane, { root: state.vaultRoot, rel: name, scratch: false, canvas: true })
    setStatus(t('status.canvasCreated', { name }))
  } catch (e) {
    await messageDialog(t('msg.canvasCreateFailed', { err: (e && e.message) || e }))
  }
}

// —— 保存到原文件（含索引增量更新 + 可选备份）——
// 保存焦点窗格（Ctrl+S / 菜单 / 自动保存都走这里）
async function saveCurrent(manual = true) {
  await savePane(panes.focused, manual)
}

/**
 * 保存指定窗格的文档（P5 §6.1）：按该窗格自己的根与路径写盘，不读全局 state——
 * 分栏后多个窗格可能来自不同根，全局 state 只描述焦点窗格。
 * 画布只在画布窗格（canvas-mount 单实例，分栏禁用画布），故画布分支限定 paneId===canvasPane。
 * 临时文件 / 独立导入目录的「另存为」升级只对焦点窗格做：那两条路要动全局根与
 * 标签页，非焦点窗格照旧写临时目录保命（与自动保存的行为一致，不丢数据）。
 */
async function savePane(paneId, manual = true) {
  const ctx = paneCtx(paneId)
  const inst = panes.editors.get(paneId)
  if (!ctx.rel || !ctx.vaultRoot || !inst) {
    if (manual && paneId === panes.focused) setStatus(t('status.nothingToSave'))
    return
  }
  const isFocus = paneId === panes.focused
  // 新建未定落的临时文件：手动保存 = 选正式位置（另存为），自动保存仍写临时目录保命
  if (manual && isFocus && ctx.scratch) return saveScratchAs()
  // 独立解析模式（temp 一次性目录）下的手动保存 → 升级为“另存为”（仅焦点窗格）
  if (manual && isFocus && state.tempImportRoot && normVaultPath(ctx.vaultRoot) === normVaultPath(state.tempImportRoot)) {
    return saveTempAsFormal()
  }
  try {
    if (state.mode === 'canvas' && paneId === panes.canvasPane) {
      await canvasView.save()
      setStatus(manual
        ? t('status.saved', { name: ctx.rel, time: timeStr() })
        : t('status.autoSaved', { name: ctx.rel, time: timeStr() }))
      return
    }
    const md = inst.getMarkdown()
    await writeMdFile(ctx.vaultRoot, ctx.rel, md)
    inst.markSaved()
    markPaneDirty(paneId, false)
    if (pluginManager) pluginManager.fireSave(ctx.rel, md)
    setStatus(manual
      ? t('status.saved', { name: ctx.rel, time: timeStr() })
      : t('status.autoSaved', { name: ctx.rel, time: timeStr() }))
    // 索引增量：无需重扫全库
    try {
      await updateIndexDoc(ctx.rel, md)
      if (isFocus) refreshLinkPanels()
    } catch (e) {
      console.warn(t('msg.indexUpdateFailed'), e)
    }
    // 备份：手动保存一定做一次；自动保存受间隔约束（在 scheduleAutosave 里）
    await maybeBackup(ctx.vaultRoot, ctx.rel, md, manual)
    if (snapshotPanel && manual && isFocus) snapshotPanel.refresh()
    if (gitPanel && manual && isFocus) gitPanel.refresh()
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
    state.vaultFromFolder = true // 目录是用户在保存对话框里点名的库位
    paneCtx(panes.focused).vaultRoot = target
    state.tempImportRoot = ''
    state.scratch = false
    paneCtx(panes.focused).scratch = false
    const tabs = ftabs()
    if (tabs && tabs.active()) {
      tabs.update(tabs.active().id, { root: target })
    }
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

async function maybeBackup(vaultRoot, rel, md, force) {
  if (!rel || !vaultRoot) return
  const now = Date.now()
  if (!force && now - state.autosave.lastBackupAt < BACKUP_INTERVAL_MS) return
  try {
    await backupWrite(vaultRoot, rel, md)
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
  state.autosave.idleTimer = setTimeout(async () => {
    // 分栏后所有脏窗格都存：定时器触发时焦点可能已经不在当初触发它的窗格上
    for (const id of dirtyPaneIds()) await savePane(id, false)
  }, AUTOSAVE_IDLE_MS)
}

function timeStr() {
  const d = new Date()
  return d.toTimeString().slice(0, 8)
}

// —— [[wikilink]] 点击：跳转或新建 ——
async function onOpenWiki(name, { newPane = false } = {}) {
  if (!state.vaultRoot) {
    setStatus(t('status.needVaultFolder'))
    return
  }
  try {
    const res = await resolveWikiLink(state.vaultRoot, state.currentFile || '', name)
    if (res.exists) {
      if (newPane) await openInSplitPane(res.path)
      else await openFile(res.path)
      return
    }
    if (newPane) {
      // 不存在的页面走「是否新建」确认框，新窗格模式下先不拆，避免取消后留一个空窗格
      if (!(await confirmDialog(t('dlg.wikiMissingDoc', { name }), t('dlg.wikiNewDocTitle')))) return
      const rel = await createMdFile(state.vaultRoot, name, `# ${name}\n\n`)
      renderTree(await scanVault(state.vaultRoot))
      await openInSplitPane(rel)
      try { await updateIndexDoc(rel, `# ${name}\n\n`) } catch (_) {}
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

// 在当前窗格右侧拆一个新窗格并落文档（双链 ⌘/Ctrl+点击的去处）
async function openInSplitPane(rel) {
  const newId = splitEmptyPane(panes.focused, 'horizontal', false)
  if (!newId) return
  await syncFocusedEditor()
  await landDocInPane(newId, { root: state.vaultRoot, rel })
  persistPanes()
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
      els.searchInput.value = '#' + tag
      runSearch('#' + tag)
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
    let md = splitFrontmatter(full).body
    // Quarkdown 开关开启时先求值展开（源文件不动，只影响导出件）；文档目录供 .read 等文件类函数用
    if (getFeatures(settingsStore).quarkdown) {
      const docDir = qdDocDir(state.vaultRoot, state.currentFile)
      md = (await evalQd(md, docDir, qdLibsDir(state.vaultRoot, docDir))).expanded
    }
    const title = (md.match(/^#\s+(.+)$/m) || [, state.currentFile])[1]
    const body = injectToc(exportMd.render(md), title)
    const html = buildExportHtml(title, body, getFeatures(settingsStore).headingNumbering)
    const defaultName = state.currentFile.replace(/\.md$/i, '.html')
    const abs = await pickSaveAs(defaultName)
    if (!abs) return
    await exportFile(abs, html)
    setStatus(t('status.exportedHtml', { abs }))
  } catch (e) {
    await messageDialog(t('msg.exportFailed', { err: (e && e.message) || e }))
  }
}

// —— 打印（Ctrl+P）：画布直出老打印；普通文档先弹排版选项窗，Paged.js 预分页后再走系统打印，
// 预分页失败回退直打（spec 见 docs/superpowers/specs/2026-10-25-print-pagedjs-design.md）——
async function printViaDialog() {
  if (state.mode === 'canvas') {
    window.print()
    return
  }
  const options = await printOptionsDialog()
  if (!options) return
  setStatus(t('status.printPaging'))
  try {
    // 编号开关在设置页（不在打印选项窗），随 settings 并进排版选项
    await printPaged({ ...options, headingNumbering: getFeatures(settingsStore).headingNumbering }, (state.currentFile || '').replace(/\.md$/i, ''))
    setStatus('')
  } catch (e) {
    setStatus(t('status.printPagedFallback'))
    window.print()
  }
}

// —— 导出为演示文稿（单文档 → 自包含 reveal.js HTML，spec 见 docs/superpowers/specs/2026-10-25-slides-export-design.md）——
async function exportSlides() {
  if (!state.currentFile) {
    setStatus(t('status.openDocFirst'))
    return
  }
  if (state.mode === 'canvas') {
    setStatus(t('status.canvasNoSlides'))
    return
  }
  try {
    const full = editor.getMarkdown()
    let md = splitFrontmatter(full).body
    if (getFeatures(settingsStore).quarkdown) {
      const docDir = qdDocDir(state.vaultRoot, state.currentFile)
      md = (await evalQd(md, docDir, qdLibsDir(state.vaultRoot, docDir))).expanded
    }
    const html = buildSlidesHtml(md, { title: state.currentFile, headingNumbering: getFeatures(settingsStore).headingNumbering, assets: slidesAssets })
    const defaultName = state.currentFile.replace(/\.md$/i, '.slides.html')
    const abs = await pickSaveAs(defaultName)
    if (!abs) return
    await exportFile(abs, html)
    setStatus(t('status.exportedSlides', { abs }))
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

// —— 整库幻灯片（阶段 3）：库内全部 md 按树序合成一份 reveal.js 放映件 ——
async function exportVaultSlides() {
  if (!state.vaultRoot) {
    setStatus(t('status.siteNeedVault'))
    return
  }
  const segs = String(state.vaultRoot).split(/[\\/]+/).filter(Boolean)
  const vaultName = segs[segs.length - 1] || 'Slides'
  const abs = await pickSaveAs(vaultName + '.slides.html')
  if (!abs) return
  try {
    setStatus(t('status.slidesVaultBuilding'))
    const graph = await buildSiteGraph(state.vaultRoot)
    const docs = ((graph && graph.docs) || [])
    const prepared = []
    for (const d of docs) {
      const raw = await readMdFile(state.vaultRoot, d.rel)
      let md = splitFrontmatter(raw).body
      // 每篇按自己的目录过 qd 求值（.read / .include 相对它解析），与整站导出同口径
      if (getFeatures(settingsStore).quarkdown) {
        const docDir = qdDocDir(state.vaultRoot, d.rel)
        md = (await evalQd(md, docDir, qdLibsDir(state.vaultRoot, docDir))).expanded
      }
      prepared.push({ title: d.title || d.rel, md })
    }
    const html = buildVaultSlidesHtml(prepared, {
      title: vaultName,
      headingNumbering: getFeatures(settingsStore).headingNumbering,
      assets: slidesAssets,
    })
    await exportFile(abs, html)
    setStatus(t('status.exportedSlides', { abs }))
  } catch (e) {
    await messageDialog(t('msg.exportFailed', { err: (e && e.message) || e }))
  }
}

// —— Quarkdown 包：显式安装（include {@scope/name:version} 只读本地缓存，文档求值不触发下载）——
async function qdInstallPackageDialog() {
  const ref = await promptDialog({
    title: t('dlg.qdPkgTitle'),
    placeholder: t('dlg.qdPkgPh'),
    defaultValue: '@atoms/cowsay',
  })
  if (!ref) return
  try {
    setStatus(t('status.qdPkgInstalling', { ref }))
    const installed = await qdPackageInstall(ref)
    setStatus(t('status.qdPkgInstalled', { ref: installed }))
  } catch (e) {
    await messageDialog(t('msg.qdPkgFailed', { err: (e && e.message) || e }))
  }
}

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
    const r = await exportSite({
      vaultRoot: state.vaultRoot,
      outDir,
      io,
      setStatus,
      headingNumbering: getFeatures(settingsStore).headingNumbering,
      // evalMd 第二参 = 每篇文档自己的目录（.read 等文件类函数相对它解析）
      evalMd: getFeatures(settingsStore).quarkdown
        ? (body, docDir) => evalQd(body, docDir, qdLibsDir(state.vaultRoot, docDir))
        : null,
    })
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

// 整库导出标准 GFM 副本：Obsidian 私有语法在写出时降级，产物任何编辑器都能开
async function exportPlainMdFull() {
  if (!state.vaultRoot) {
    setStatus(t('status.siteNeedVault'))
    return
  }
  const outDir = await pickFolder()
  if (!outDir) return
  setStatus(t('plain.building'))
  try {
    const io = {
      buildGraph: (vr) => buildSiteGraph(vr),
      scanTree: (vr) => scanVault(vr),
      readMd: (vr, rel) => readMdFile(vr, rel),
      writeFile: (absPath, content) => exportFile(absPath, content),
      copyAssets: (vr, rels, od) => copyVaultAssets(vr, rels, od),
    }
    const r = await exportPlainMd({ vaultRoot: state.vaultRoot, outDir, io, setStatus })
    await messageDialog(t('msg.plainExportDone', { ok: r.ok, dir: outDir }), 'info')
  } catch (e) {
    await messageDialog(t('msg.plainExportFailedDlg', { err: (e && e.message) || e }))
    setStatus(t('status.siteExportFailed'))
  }
}

function buildExportHtml(title, body, headingNumbering = false) {
  // 独立 HTML：内嵌 GitHub 风格样式 + KaTeX css 引用；离线可读，可分享
  return `<!DOCTYPE html>
<html lang="zh-CN"><head>
<meta charset="UTF-8">
<title>${escapeHtml(title)}</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.9/dist/katex.min.css">
<style>
  body { font-family: -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; max-width: 820px; margin: 40px auto; padding: 0 24px; line-height: 1.75; color: #24292e; }
  ${headingNumbering ? numberingCss('') : ''}
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
  const app = (id, defaultKey, run, defaultKeyMac) =>
    commandRegistry.register({ id, title: t('cmd.' + id), category: 'app', defaultKey, defaultKeyMac, run })
  app('app.save', 'Mod-s', () => saveCurrent(true))
  app('app.openFile', 'Mod-o', () => openSingleFile())
  app('app.openFolder', 'Mod-Shift-o', () => openFolder())
  // Ctrl+F = 当前文档内查找（Typora/Obsidian 语义）；全库搜索改到 Ctrl+Shift+F
  app('app.findInDoc', 'Mod-f', () => {
    if (editor && state.mode === 'md' && !editor.isSourceMode()) findBar && findBar.open()
  })
  // Ctrl+H：打开同一查找栏，但焦点落在替换框（替换行常显）
  // mac 上 ⌘H 是系统「隐藏」的角色键，原生菜单会静默丢掉这条快捷键，故 mac 绑 ⌥⌘F
  app('app.replace', 'Mod-h', () => {
    if (editor && state.mode === 'md' && !editor.isSourceMode()) findBar && findBar.open('replace')
  }, 'Mod-Alt-f')
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
  // 在文件管理器里显示当前文件（菜单「打开文件位置」）。临时目录里的未命名文档也真在磁盘上，
  // 照用活动页自己的 root/rel；单文件模式（无库根）回落到 state.vaultRoot 那条路径。
  app('app.revealFile', null, () => {
    const act = ftabs() && ftabs().active()
    if (!state.currentFile) {
      setStatus(t('status.noOpenFile'))
      return
    }
    if (act && act.root && act.rel) {
      revealInFolder(act.root, act.rel).catch(async (e) => {
        await messageDialog(t('msg.revealFailed', { err: errText(e) }))
      })
      return
    }
    revealVaultPath(state.currentFile)
  })
  // 关闭当前标签页（Ctrl+W）：关焦点窗格的活动标签；关完没有邻居则窗格留空态
  app('app.closeFile', 'Mod-w', () => {
    const tabs = ftabs()
    const act = tabs && tabs.active()
    if (!act) {
      setStatus(t('status.noTab'))
      return
    }
    closeTab(act.id)
  })
  // 标签页循环（Ctrl+Tab / Ctrl+Shift+Tab）：完整分栏后是焦点窗格内循环。
  // 刻意用 Ctrl 而非 Mod——mac 上 Cmd+Tab 被系统切应用占用
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
  app('app.print', 'Mod-p', () => printViaDialog())
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
  // 网页剪藏：本地 HTTP 服务（只绑 127.0.0.1，令牌闸门）的开关 / 端口 / 模板 / 自动关联
  app('app.clipSettings', null, () => { if (clipSettings) clipSettings.open() })
  // 分栏（P5 §6.1）：在焦点窗格里横分 / 竖分。编辑区右上角也有同款按钮
  app('app.splitH', null, () => splitFocusedPane('horizontal'))
  app('app.splitV', null, () => splitFocusedPane('vertical'))
  app('app.export', null, () => exportHTML())
  app('app.exportSlides', null, () => exportSlides())
  app('app.exportVaultSlides', null, () => exportVaultSlides())
  app('app.qdInstallPackage', null, () => qdInstallPackageDialog())
  // Quarkdown 求值开关：与设置页「功能开关」同一 setFeature 通道，改完广播全部编辑器重扫装饰
  app('app.qdToggleEval', null, () => {
    const next = !getFeatures(settingsStore).quarkdown
    setFeature(settingsStore, 'quarkdown', next)
    refreshFeatureFlags()
    setStatus(t(next ? 'status.qdEvalOn' : 'status.qdEvalOff'))
  })
  app('app.exportSite', null, () => exportSiteFull())
  app('app.exportPlain', null, () => exportPlainMdFull())
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
  // AI：面板开合 / 设置面板 / 选区任务（命令面板 + mac 菜单 + 快捷键设置共用一张表）
  app('app.aiPanel', 'Mod-Shift-a', () => toggleAiPanel())
  app('app.aiSettings', null, () => { if (aiSettings) aiSettings.open() })
  for (const task of AI_TASK_IDS) {
    commandRegistry.register({
      id: 'editor.ai.' + task,
      title: t('cmd.editor.ai.' + task),
      category: 'editor',
      when: 'editor',
      defaultKey: null,
      run: () => runSelectionAi(task),
    })
  }
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
  // 标题栏文件名不在静态 DOM 的刷新范围内（index.html 里特意没给它挂 data-i18n），
  // 所以只有当前显示的正是「没打开文档」那句占位时才要手动跟着语言走；开着文档时
  // 它是路径（画布态也是），与界面语言无关，不能动
  if (!state.currentFile) els.filename.textContent = t('ui.noDocOpen')
  applyTheme(currentThemeChoice()) // 按「选择」重放：选 system 的不会被打回具体主题
  if (hlBar) hlBar.relabel() // 高亮工具栏文案跟随界面语言
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
  const chosen = Object.prototype.hasOwnProperty.call(ov, id) ? ov[id] : defaultKeyFor(cmd, IS_MAC)
  if (!chosen) return ''
  return formatBinding(chosen, IS_MAC)
}

// —— macOS 原生菜单（系统菜单栏）——
// 菜单不带第二份文案或快捷键：每次从命令注册表 + 覆盖表现算 spec，一次 IPC 交 Rust 整份重建。
// 工具条在导入期（titlebar.js）就按 mac 标记藏掉；装配失败（纯 web 构建 / 缺能力授权 /
// 原生侧抛错）时把这个标记摘回来并回显状态栏——入口不能因为菜单挂不上而消失。
let macMenuOn = false
let macChromeTimer = null
let macMenuSig = ''
let macTitle = ''
const lastRunAt = new Map()

const MENU_NEEDS_DOC = new Set(['app.save', 'app.export', 'app.exportSlides', 'app.print', 'app.closeFile', 'app.renameFile', 'app.revealFile'])
const MENU_NEEDS_VAULT = new Set(['app.exportSite', 'app.exportPlain', 'app.exportVaultSlides', 'app.newCanvas', 'app.newTemplate', 'app.graph'])
// 导出 Word 取的是当前 md 文档的 PM 节点树：画布与未打开文档时置灰，同 editor.* 的口径
const MENU_NEEDS_MD = new Set(['app.exportWord', 'app.insertImage'])
const MENU_CHECKED = {
  'app.focusMode': () => localStorage.getItem('nl-focus') === '1',
  'app.typewriterMode': () => localStorage.getItem('nl-typewriter') === '1',
  'app.toggleSidebar': () => localStorage.getItem('nl-sidebar') !== 'hidden',
  'app.toggleInspector': () => !inspectorHidden(),
  'app.aiPanel': () => !aiPanelHidden(),
  'app.autosave': () => state.autosave.enabled,
  'app.sourceMode': () => !!(editor && editor.isSourceMode()),
  'app.qdToggleEval': () => getFeatures(settingsStore).quarkdown,
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
    const raw = Object.prototype.hasOwnProperty.call(ov, c.id) ? ov[c.id] : defaultKeyFor(c, IS_MAC)
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
    languages: LOCALES.map((l) => ({ id: 'app.lang.' + l.id, label: l.name, checked: l.id === getLocale() })),
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
    // 菜单没挂上，窗口内工具条要回来（titlebar.js 在导入期就把它藏了）
    document.documentElement.toggleAttribute('data-mac', false)
    setStatus(t('msg.macMenuUnavailable', { err: (e && e.message) || e }))
    return
  }
  macMenuOn = true
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
  // 分栏后每个窗格的编辑器都要热重配（各自持有 keymap 插件）
  for (const inst of panes.editors.values()) {
    if (inst) inst.setKeymapOverrides(ov)
  }
  scheduleMacChrome()
}

function bindShortcuts() {
  registerAppCommands()
  registerEditorCommands()
  rebuildKeymap()
  for (const inst of panes.editors.values()) {
    if (inst) inst.setKeymapOverrides(loadKeymapOverrides()) // 编辑器层：应用持久化的重绑
  }
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

// —— 分栏窗格管理（P5 §6.1）——
// 每个窗格 = 一个编辑器实例 + 查找栏 + 高亮工具栏 + 自己的根 / 文档上下文。
// 功能开关改动后让各窗格编辑器重扫装饰（emoji / 目录块按 meta 强制重建，不等下次文档变更）
function refreshFeatureFlags() {
  for (const inst of panes.editors.values()) {
    const v = inst.view
    if (v) v.dispatch(v.state.tr.setMeta('nl-features', {}))
  }
}

// 模块级 editor / findBar / hlBar 始终指向焦点窗格的实例（切焦点时重绑），
// 大量既有调用点因此不用改；els.editor / els.sourceMount / els.canvasMount 同理。

// 编辑器实例工厂：回调按窗格各自路由（脏状态 / 选区变化都带 paneId，不读全局焦点——
// 焦点随时会变，读它就绑错人）。getVault 用窗格自己的根：图片落库 / wikilink
// 解析都相对该窗格所在的文档。
function createPaneEditor(paneId, mountEl, sourceMountEl) {
  return createEditor({
    mountEl,
    getVault: () => {
      const c = paneCtx(paneId)
      return { vaultRoot: c.vaultRoot, mdRel: c.rel }
    },
    onOpenWiki,
    onMetaChange: (meta) => {
      // 大纲 / 标签面板只跟焦点窗格：非焦点窗格的元数据变化不许刷掉面板
      if (paneId !== panes.focused) return
      onMetaChange(meta)
    },
    onDirty: (d) => markPaneDirty(paneId, d),
    onNotify: (msg) => setStatus(msg),
    suggestDocs: () => state.docNames,
    suggestTags: () => state.tagNames,
    onFrontmatterChange: () => {
      if (paneId === panes.focused && frontmatterPanel) frontmatterPanel.refresh()
    },
    initialFocus: localStorage.getItem('nl-focus') === '1',
    initialTypewriter: localStorage.getItem('nl-typewriter') === '1',
    getFeatures: () => getFeatures(settingsStore),
    // 快照求值带上该窗格文档的目录（Data 模块文件类函数相对它解析）与库目录（include 按名加载）
    evalQd: (md) => {
      const c = paneCtx(paneId)
      const docDir = qdDocDir(c.vaultRoot, c.rel)
      return evalQd(md, docDir, qdLibsDir(c.vaultRoot, docDir))
    },
    sourceMountEl,
    onSourceTextChange: () => {
      if (paneId !== panes.focused) return
      updateDocStats()
      if (frontmatterPanel) frontmatterPanel.refresh()
    },
    onDocChange: (doc, prev) => {
      if (paneId !== panes.focused) return
      updateDocStats()
      if (pluginManager) pluginManager.fireDocChange(doc, prev)
    },
    onSelectionChange: () => {
      scheduleMacChrome()
      const bar = panes.hlBars.get(paneId)
      if (bar) bar.sync()
      syncFmtBars()
    },
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
}

// 窗格内容壳（编辑器 + 源码挂载点 + 画布占位）：首窗格在 boot 里建好（复用静态
// HTML 的三个挂载点），其它窗格（拆分 / 恢复出来的布局）在这里现场建。同一 paneId
// 始终返回同一元素——split-pane 的 DOM 手术靠它把编辑器连壳搬走，不连根拔起。
function paneBodyFor(paneId) {
  let body = panes.contents.get(paneId)
  if (body) return body
  body = document.createElement('div')
  body.className = 'nl-pane-body'
  const editorDiv = document.createElement('div')
  editorDiv.className = 'editor'
  const sourceDiv = document.createElement('div')
  sourceDiv.className = 'nl-source hidden'
  const canvasDiv = document.createElement('div')
  canvasDiv.className = 'hidden' // 占位：画布单实例，非首窗格的画布挂载点永不使用
  body.append(editorDiv, sourceDiv, canvasDiv)
  panes.contents.set(paneId, body)
  panes.mounts.set(paneId, { editorDiv, sourceDiv, canvasDiv })
  return body
}

// 给窗格备好编辑器实例（幂等）。恢复出来的多窗格布局在 boot 里逐个调它；
// 拆分时先调它再动 DOM（engine 的 contentFor 只取壳，实例在这里建）。
function ensurePaneEditor(paneId) {
  const exist = panes.editors.get(paneId)
  if (exist) return exist
  paneBodyFor(paneId)
  const { editorDiv, sourceDiv } = panes.mounts.get(paneId)
  const inst = createPaneEditor(paneId, editorDiv, sourceDiv)
  attachEditorContextMenu(paneId, inst)
  panes.editors.set(paneId, inst)
  paneCtx(paneId)
  if (!paneCtx(paneId).rel) showPaneEmpty(paneId, true)
  return inst
}

function ensurePaneFindBar(paneId) {
  const exist = panes.findBars.get(paneId)
  if (exist) return exist
  const inst = panes.editors.get(paneId)
  const leaf = paneLeaf(paneId)
  if (!inst || !leaf) return null
  const bar = createFindBar({ view: inst.view, paneEl: leaf })
  panes.findBars.set(paneId, bar)
  return bar
}

// 高亮浮动工具栏按窗格各一个（readState / apply / clear 都闭包捕获 paneId，
// 选的是哪个窗格的文字就改哪个窗格——工具栏跟着选区所在的窗格走）
function ensurePaneHlBar(paneId) {
  const exist = panes.hlBars.get(paneId)
  if (exist) return exist
  const leaf = paneLeaf(paneId)
  if (!leaf) return null
  const bar = createHighlightToolbar({
    paneEl: leaf,
    readState: () => {
      const inst = panes.editors.get(paneId)
      return inst ? inst.currentSelectionRect() : null
    },
    applyColor: (color) => {
      const inst = panes.editors.get(paneId)
      if (inst) inst.applyHighlightColor(color)
    },
    clear: () => {
      const inst = panes.editors.get(paneId)
      if (inst) inst.clearHighlight()
    },
    // 第二排：选区 AI（豆包式——选中即见，点任务起结果浮层；配置检查在 runSelectionAi 里）
    // 按钮用短标签（ai.taskShort.*），全名放悬停提示（ai.task.*）
    aiActions: () => AI_TASK_IDS.map((id) => ({
      id,
      label: t('ai.taskShort.' + id),
      title: t('ai.task.' + id),
      icon: { polish: 'pen', 'continue': 'arrow-down', translate: 'globe', summarize: 'list-bullet', custom: 'sliders' }[id] || 'sparkle',
    })),
    onAi: (taskId) => {
      bar.hide() // 浮层接管：工具条收起，保住编辑器选区（runSelectionAi 里读）
      const inst = panes.editors.get(paneId)
      runSelectionAi(taskId, inst)
    },
  })
  panes.hlBars.set(paneId, bar)
  return bar
}

// 键位提示每次 sync 只查一遍（每次选区变化都要刷按钮标题，逐格逐颗去解析键位覆盖表太碎）
let fmtBinds = new Map()
function fmtBindingFor(id) {
  if (!fmtBinds.has(id)) fmtBinds.set(id, commandBindingFor(id))
  return fmtBinds.get(id)
}

// 格式按钮条按窗格各一条：常驻标签条下方，动作转给本窗格的编辑器实例
// （选的是哪一格的文字就改哪一格，与高亮浮栏同口径）
function ensurePaneFmtBar(paneId) {
  const exist = panes.fmtBars.get(paneId)
  if (exist) return exist
  const leaf = paneLeaf(paneId)
  if (!leaf) return null
  const bar = createFormatBar({
    paneEl: leaf,
    runCommand: (cmd) => {
      const inst = panes.editors.get(paneId)
      if (inst) inst.runEditorCommand(cmd)
    },
    pickImages: () => {
      const inst = panes.editors.get(paneId)
      if (inst) inst.pickAndInsertImages()
    },
    bindingFor: fmtBindingFor,
  })
  panes.fmtBars.set(paneId, bar)
  return bar
}

// 显隐：这一格有可编辑的 md 文档才出（空态 / 画布 / 源码态整条藏——按钮改的是 PM
// 模型，源码态下动的是用户看不见的文档）；按下态跟选区里是否含该 mark 走。
function syncFmtBars() {
  fmtBinds = new Map()
  for (const [paneId, bar] of panes.fmtBars) {
    const inst = panes.editors.get(paneId)
    const ctx = paneCtx(paneId)
    const visible = !!inst && !!ctx.rel && !isCanvasPath(ctx.rel) && !inst.isSourceMode()
    bar.sync(visible ? new Set(inst.activeMarks()) : new Set(), visible)
  }
}

// 焦点切换（split-pane 的 onPaneFocus 回调）：全局镜像、树 / 索引（跨根时）、
// 面板、查找栏、高亮工具栏全部换成新焦点窗格的
async function focusPaneUi(paneId) {
  if (!panes.editors.has(paneId) || paneId === panes.focused) return
  panes.focused = paneId
  await syncFocusedEditor()
  updatePaneChrome() // 焦点环跟着焦点走：打印只打焦点窗格，环留在旧窗格会误导
  const inst = panes.editors.get(paneId)
  if (inst) inst.focus()
}

async function syncFocusedEditor() {
  const paneId = panes.focused
  const inst = panes.editors.get(paneId) || null
  editor = inst
  const mounts = panes.mounts.get(paneId)
  if (mounts) {
    els.editor = mounts.editorDiv
    els.sourceMount = mounts.sourceDiv
    els.canvasMount = mounts.canvasDiv
  }
  findBar = panes.findBars.get(paneId) || null
  hlBar = panes.hlBars.get(paneId) || null
  const ctx = paneCtx(paneId)
  // 焦点窗格没有文档时不把全局根清成 null：侧栏树还指着上一个根，用户从树里
  // 点文件能直接开进这个空窗格（清成 null 会把打开入口一起废掉）
  const rootChanged = !!ctx.vaultRoot && normVaultPath(ctx.vaultRoot) !== normVaultPath(state.vaultRoot)
  if (ctx.vaultRoot) state.vaultRoot = ctx.vaultRoot
  state.currentFile = ctx.rel
  state.scratch = ctx.scratch
  state.dirty = ctx.dirty
  els.filename.textContent = ctx.rel
    ? ctx.scratch
      ? await joinPath(ctx.vaultRoot, ctx.rel)
      : ctx.rel
    : t('ui.noDocOpen')
  els.filename.classList.toggle('dirty', ctx.dirty)
  if (els.btnSource) els.btnSource.classList.toggle('active', !!(inst && inst.isSourceMode()))
  if (rootChanged) {
    // 跨根焦点切换：树与索引跟着新焦点的文档走（既有跨库切页链路）
    if (ctx.scratch) {
      state.tree = []
      renderSingleFileTree(ctx.rel)
    } else {
      state.tree = await scanVault(ctx.vaultRoot)
      renderTree(state.tree)
    }
    startIndexPolling()
    if (pluginManager) pluginManager.reload()
  }
  highlightActiveFile()
  updateDocStats()
  // 大纲 / 标签 / frontmatter 面板跟焦点窗格走：从新焦点窗格的编辑器重新取数
  if (inst && inst.refreshMeta) inst.refreshMeta()
  if (frontmatterPanel) frontmatterPanel.refresh()
  refreshLinkPanels()
  if (snapshotPanel) snapshotPanel.refresh()
  if (gitPanel) gitPanel.refresh()
  scheduleMacChrome()
}

// 在焦点窗格里插入新分栏（P5 §6.1「拆分」按钮 / 命令入口）。
// 新窗格复制焦点窗格的当前文档（VS Code 拆分行为，便于左右对照）；焦点窗格是空态
// （没有当前文档）或当前是画布（单实例）时新窗格空置。
async function splitFocusedPane(orientation) {
  if (!panes.view) return
  const from = panes.focused
  const fromCtx = paneCtx(from)
  const dup =
    fromCtx.rel && !isCanvasPath(fromCtx.rel)
      ? { root: fromCtx.vaultRoot, rel: fromCtx.rel, scratch: fromCtx.scratch }
      : null
  const newId = freshId(panes.tree, 'p')
  ensurePaneEditor(newId) // 壳 + 实例先备好（engine 的 contentFor 只取壳）
  panes.tree = panes.view.split(from, orientation, newId)
  panes.focused = newId
  await syncFocusedEditor()
  mountPaneChrome(newId)
  ensurePaneFindBar(newId)
  ensurePaneHlBar(newId)
  ensurePaneFmtBar(newId)
  updatePaneChrome()
  if (dup) await openDocInPane(newId, dup)
  else showPaneEmpty(newId, true)
  persistPanes()
  setStatus(t(orientation === 'vertical' ? 'pn.splitVDone' : 'pn.splitHDone'))
}

// —— 拖拽落定（spec 2026-10-19-pane-drag：标签 / 文件树 → 窗格）———
// 标签拖到别的窗格 = 移动，拖到窗格边缘 = 拆分，落回自己窗格的中间 = 排序，
// 文件树拖进来 = 打开。落定一律直接走 tabs + loadDocIntoPane，不经过
// openDocInPane：后者内部的 ensurePaneSaved 在窗格不脏时会退化成「问所有脏窗格」
// （spec 决策 6），那会把无关的第三个窗格的保存弹窗带出来。

/** 只问真脏的窗格；一个都不脏就直接放行（askSavePanes([]) 会被当成「问所有脏窗格」） */
async function ensurePanesSaved(ids) {
  const dirty = ids.filter((id) => paneCtx(id).dirty && paneCtx(id).rel)
  if (!dirty.length) return true
  return askSavePanes(dirty)
}

/** 摘走一个标签：删的是活动标签才要换内容（邻居 → 装它的内容；没有邻居 → 空态） */
async function detachTab(paneId, tabId) {
  const strip = panes.strips.get(paneId)
  if (!strip) return
  const tabs = strip.tabs
  const wasActive = !!tabs.active() && tabs.active().id === tabId
  if (!wasActive) {
    tabs.remove(tabId)
    return
  }
  const next = tabs.neighborOf(tabId) // 邻居要在 remove 之前问（remove 会清 activeId）
  tabs.remove(tabId)
  if (next) {
    tabs.activate(next.id)
    await loadDocIntoPane(paneId, next)
  } else {
    await closePaneIfEmpty(paneId)
  }
}

/** 把文档装进目标窗格：已有该文档则激活并转正（落定即固定），没有则入列 */
async function landDocInPane(paneId, doc) {
  const strip = panes.strips.get(paneId)
  if (!strip) return
  const tabs = strip.tabs
  const exist = tabs.list().find((x) => x.root === doc.root && x.rel === doc.rel)
  if (exist) {
    tabs.activate(exist.id)
    if (exist.preview) tabs.pin(exist.id)
  } else {
    tabs.open(doc)
  }
  await loadDocIntoPane(paneId, doc)
}

/**
 * 拆一个空窗格出来（文件树落边 / 标签落边共用）。返回新窗格 id。
 *
 * 不按 `paneId === panes.canvasPane` 拦：canvasPane 只是「#canvas-mount 归属哪个窗格」，
 * 启动时固定给首窗格，单窗格布局下每个窗格都会命中——早先在这里拦，表现就是拖到边上
 * 松手什么都不发生（新窗格没拆出来，标签回原位）。拆出来的新窗格本来也装不到画布
 * （`splitTabToPane` 拦画布标签、`dropTreeFile` 的画布走 openDocInPane 不落边），
 * 画布视图留在原窗格，与标签条上的「拆分」按钮行为一致。
 */
function splitEmptyPane(dstPaneId, orientation, newFirst) {
  const newId = freshId(panes.tree, 'p')
  ensurePaneEditor(newId)
  panes.tree = panes.view.split(dstPaneId, orientation, newId, newFirst)
  mountPaneChrome(newId)
  ensurePaneFindBar(newId)
  ensurePaneHlBar(newId)
  ensurePaneFmtBar(newId)
  panes.focused = newId // 先定焦点再打标：updatePaneChrome 按当前焦点画环，反了环就留在旧窗格
  updatePaneChrome()
  return newId
}

async function moveTabToPane(payload, dstPaneId) {
  // payload.paneId 就是标签原本所在的窗格（拖拽源）
  const { tabId, paneId: srcPaneId, doc } = payload
  if (doc.canvas) {
    setStatus(t('pn.canvasSplit')) // 画布是单实例，只能待在 canvasPane
    return
  }
  // 目标窗格要换内容，源窗格要摘标签：两个都可能脏，一次问清
  if (!(await ensurePanesSaved([srcPaneId, dstPaneId]))) return
  await landDocInPane(dstPaneId, doc)
  await detachTab(srcPaneId, tabId)
  await focusPaneUi(dstPaneId)
  persistPanes()
}

async function splitTabToPane(payload, dstPaneId, orientation, newFirst) {
  const { tabId, paneId: srcPaneId, doc } = payload
  if (doc.canvas) {
    setStatus(t('pn.canvasSplit'))
    return
  }
  // 目标窗格内容不变，只有源窗格（被摘的是活动标签时）可能脏
  if (!(await ensurePanesSaved([srcPaneId]))) return
  const newId = splitEmptyPane(dstPaneId, orientation, newFirst)
  if (!newId) return
  await detachTab(srcPaneId, tabId)
  // detachTab 可能把源窗格整格关掉（拖走了最后一个标签），焦点会被重指到第一个
  // 窗格；拆分落定该停在新窗格，这里扳回来再同步
  if (paneIds(panes.tree).includes(newId)) panes.focused = newId
  await syncFocusedEditor() // 焦点已指到新窗格：面板 / 树 / 索引跟着它走
  await landDocInPane(newId, doc)
  persistPanes()
  setStatus(t(orientation === 'vertical' ? 'pn.splitVDone' : 'pn.splitHDone'))
}

async function dropTreeFile(dstPaneId, rel, zone) {
  const doc = { root: state.vaultRoot, rel }
  if (isCanvasPath(rel)) {
    // 画布走既有打开链路（里面有画布的规则与提示），落边也不给拆
    await openDocInPane(dstPaneId, doc)
    return
  }
  if (zone === 'center') {
    if (!(await ensurePanesSaved([dstPaneId]))) return
    await landDocInPane(dstPaneId, doc)
    await focusPaneUi(dstPaneId)
  } else {
    const newId = splitEmptyPane(
      dstPaneId,
      zone === 'left' || zone === 'right' ? 'horizontal' : 'vertical',
      zone === 'left' || zone === 'top',
    )
    if (!newId) return
    await syncFocusedEditor()
    await landDocInPane(newId, doc)
  }
  recordRecent(doc.root, doc.rel)
  persistPanes()
}

/** pane-drag 的松手派发：落点不在任何窗格上直接回（拖拽引擎已复原源标签） */
function handlePaneDrop(drop) {
  const { payload, paneId, zone, tabIndex } = drop
  if (!paneId || !payload) return
  const run = (p) => p.catch((e) => console.warn('[pane-drag] 落定失败', e))
  if (payload.kind === 'tab') {
    if (zone === 'center') {
      if (paneId === payload.paneId) {
        // 落回自己窗格：按落点重排（tabIndex < 0 表示落点不明，不动）
        if (tabIndex >= 0) {
          panes.strips.get(paneId).tabs.moveTo(payload.tabId, tabIndex)
          persistPanes()
        }
        return
      }
      run(moveTabToPane(payload, paneId))
      return
    }
    run(
      splitTabToPane(
        payload,
        paneId,
        zone === 'left' || zone === 'right' ? 'horizontal' : 'vertical',
        zone === 'left' || zone === 'top',
      ),
    )
    return
  }
  if (payload.kind === 'tree') run(dropTreeFile(paneId, payload.rel, zone))
}

/** 绑拖拽：标签条与文件树条目的 pointerdown 起拖（真正起拖要等位移过 4px） */
function bindPaneDragging() {
  paneDrag = createPaneDrag({
    hitLeaf: (x, y) => {
      const el = document.elementFromPoint(x, y)
      return el && el.closest ? el.closest('.nl-pane') : null
    },
    labelFor: (p) => baseName(p.rel),
    onDrop: handlePaneDrop,
  })
  document.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || !panes.view || !paneDrag) return
    const el = e.target && e.target.closest ? e.target : null
    if (!el) return
    const tabEl = el.closest('.tab')
    if (tabEl) {
      const stripEl = tabEl.closest('.nl-pane-strip')
      const paneId = stripEl && stripEl.dataset.paneId
      const strip = paneId ? panes.strips.get(paneId) : null
      const tab = strip ? strip.tabs.get(tabEl.dataset.id) : null
      if (!tab) return
      paneDrag.begin(
        e,
        {
          kind: 'tab',
          paneId,
          tabId: tab.id,
          rel: tab.rel,
          doc: { root: tab.root, rel: tab.rel, canvas: tab.canvas, scratch: tab.scratch },
        },
        tabEl,
      )
      return
    }
    // 文件树的文件项（文件夹不起拖：拖文件夹换库会影响所有窗格）
    const li = el.closest('.tree-file')
    if (li && li.dataset.kind === 'file') {
      paneDrag.begin(e, { kind: 'tree', rel: li.dataset.path }, li)
    }
  })
}

// 关一个窗格（它标签条右侧的关闭按钮）。未保存改动先按老规矩问；最后一个窗格不让关
// （按钮也隐藏），要回到无文档态请用「关闭文档」。
// 画布挂载点（#canvas-mount 单实例）住在首窗格的内容壳里。关掉那个窗格时把它搬进
// 剩余窗格的壳（顶掉占位的 canvasDiv），panes.canvasPane 跟着改——不搬的话挂载点随
// 叶子一起出 DOM，此后点任何 .canvas 文件都被「非画布窗格」拦下且无提示。
// 注意取真实挂载点要用被关窗格的 mounts 条目：els.canvasMount 会随焦点切换指向
// 别的窗格的占位节点，不能作数。
function rehomeCanvasMount(closingPaneId) {
  const target = paneIds(panes.tree).find((id) => id !== closingPaneId)
  const real = panes.mounts.get(closingPaneId)?.canvasDiv
  if (!target || !real) return
  paneBodyFor(target)
  const mounts = panes.mounts.get(target)
  if (mounts && mounts.canvasDiv !== real) {
    mounts.canvasDiv.replaceWith(real)
    mounts.canvasDiv = real
  }
  panes.canvasPane = target
  els.canvasMount = real
}

async function closePaneUi(paneId) {
  const before = paneIds(panes.tree)
  if (before.length <= 1) return
  if (!(await ensurePaneSaved(paneId))) return
  panes.tree = panes.view.close(paneId)
  if (paneIds(panes.tree).length === before.length) {
    // close 没动树（叶子已经不在了）：映射原样保留。照删的话树里会留下一个
    // 没有 strip / 编辑器的死窗格，之后开进它的文档全都无声无息
    return
  }
  if (paneId === panes.canvasPane) rehomeCanvasMount(paneId)
  const inst = panes.editors.get(paneId)
  if (inst) {
    try {
      inst.view.destroy() // PM 视图监听 / 观察器必须显式销毁，光摘 DOM 会漏
    } catch {
      /* 已销毁等情况忽略 */
    }
    panes.editors.delete(paneId)
  }
  // 查找栏 / 高亮工具栏 / 标签条的 DOM 都在被摘掉的叶子里，随垃圾回收；只清控制器引用
  panes.findBars.delete(paneId)
  panes.hlBars.delete(paneId)
  panes.fmtBars.delete(paneId)
  panes.contents.delete(paneId)
  panes.mounts.delete(paneId)
  panes.ctx.delete(paneId)
  panes.strips.delete(paneId)
  panes.view.releaseLeaf(paneId)
  panes.focused = paneIds(panes.tree)[0]
  await syncFocusedEditor()
  updatePaneChrome()
  persistPanes()
  setStatus(t('pn.closed'))
}

// 窗格自己的标签条（pane-strip.js：标签滚动区 + 拆分横/竖 + 关窗格）。幂等——
// 已挂过的窗格直接返回（boot 与拆分都会调）。
function mountPaneChrome(paneId) {
  const leaf = paneLeaf(paneId)
  if (!leaf || panes.strips.has(paneId) || leaf.querySelector('.nl-pane-strip')) return
  panes.strips.set(
    paneId,
    createPaneStrip({
      paneId,
      leaf,
      onSwitch: (id) => switchToTab(id),
      onClose: (id) => closeTab(id),
      onSplit: (o) => splitFocusedPane(o),
      onClosePane: () => closePaneUi(paneId),
    }),
  )
}

// 多窗格时才显示各窗格的关窗格按钮；焦点窗格打标（打印只打焦点窗格用）
function updatePaneChrome() {
  const multi = paneIds(panes.tree).length > 1
  for (const paneId of paneIds(panes.tree)) {
    const leaf = paneLeaf(paneId)
    if (!leaf) continue
    leaf.classList.toggle('focused', paneId === panes.focused)
    const strip = panes.strips.get(paneId)
    if (strip) strip.setMulti(multi)
  }
  syncFmtBars()
}

// 分割条拖完：引擎里改比例是 `setRatio` 生成的新树，只在引擎内部，
// panes.tree 还停在拖之前那份。不把这棵树交回来，persistPanes 写的是老比例，
// 重启后分栏回到 50/50。
function commitPaneRatios() {
  if (panes.view) panes.tree = panes.view.tree
  persistPanes()
}

// 分栏树与各窗格标签列进 settings.json 的 panes 段（拆分 / 关闭 / 拖拽结束 /
// 开关标签都落盘）。预览与脏标记不持久化（serialize 里已剔除）。
function persistPanes() {
  if (!settingsStore || !IS_PRIMARY_WINDOW) return
  const tabs = {}
  for (const paneId of paneIds(panes.tree)) {
    const strip = panes.strips.get(paneId)
    if (strip) tabs[paneId] = strip.tabs.serialize()
  }
  const data = { tree: serializeTree(panes.tree), focused: panes.focused, tabs }
  const cur = settingsStore.get().panes
  if (cur && JSON.stringify(cur) === JSON.stringify(data)) return
  settingsStore.update({ panes: data })
  settingsStore.flush() // 布局性改动即时落盘：update 的 500ms 防抖扛不住「拖完立刻关窗」
}

// 恢复布局的空窗格剪枝：标签列是空的叶子直接从树里摘掉（运行期同规则——窗格空了
// 就整格关掉），首叶子除外。focused 被剪掉时夹回现存窗格。
function pruneEmptyPanes(data) {
  let tree = data.tree
  const ids = paneIds(tree)
  if (ids.length <= 1) return { tree, focused: data.focused }
  const first = ids[0]
  const hasTabs = (id) => {
    const e = data.tabs[id]
    return !!(e && Array.isArray(e.items) && e.items.length)
  }
  for (const id of ids) {
    if (id === first || hasTabs(id) || paneIds(tree).length <= 1) continue
    tree = closePane(tree, id)
  }
  const rest = paneIds(tree)
  const focused = rest.includes(data.focused) ? data.focused : rest.includes(first) ? first : rest[0]
  return { tree, focused }
}

// 拖入打开的统一落点（mac 的 bindNativeDrop、Windows / Linux 的 tauri-drag-open、
// 纯 web 的 drop-open 三条通道共用）：分栏后拖进哪个窗格就落哪个窗格（落点在窗格外
// 才用当前焦点窗格）。语义与「打开方式」一致——文件在当前窗口开，文件夹另开一个窗口
// 当知识库打开，当前窗口的库不变。
async function handleDropTargets(targets, e) {
  const list = (targets || []).filter((t) => t && t.path)
  if (!list.length) return
  for (const d of list.filter((t) => t.isDir)) {
    try {
      await openVaultWindow(d.path)
    } catch (err) {
      await messageDialog(t('msg.openFileFailedDlg', { msg: errText(err) }))
    }
  }
  const files = list.filter((t) => !t.isDir)
  if (!files.length) return
  const leaf = e && e.target && e.target.closest ? e.target.closest('.nl-pane') : null
  const paneId = leaf && leaf.dataset.paneId
  if (paneId && paneId !== panes.focused && panes.editors.has(paneId)) {
    await focusPaneUi(paneId)
  }
  return handleOpenTargets(files, { interactive: true, preview: true })
}

async function boot() {
  // 界面语言：i18n.js 导入时已按「本地记忆 → 系统语言 → 简体中文」定好 locale；
  // 这里把 <html lang> 与静态文案对齐当前语言（默认词条也是中文，重复一遍无副作用）
  document.documentElement.lang = getLocale()
  applyStaticDom(document)
  // 后端同理：命令错误 / docx 警告 / git 结果 / 托盘菜单按当前语言取词（ui_lang.rs 词表）
  if (window.__TAURI_INTERNALS__) setUiLang(getLocale()).catch(() => {})
  // —— Ollama 首启探测（主窗口只做一次）：没装则问一次是否打开下载页；拒绝就记住，
  // 之后不再主动打扰，等用户在 AI 设置里主动选 Ollama 时再提示一次 ——
  if (IS_PRIMARY_WINDOW && window.__TAURI_INTERNALS__ && !localStorage.getItem('nl-ollama-probed')) {
    localStorage.setItem('nl-ollama-probed', '1')
    ollamaProbe().then(async (ok) => {
      if (ok) return
      const yes = await confirmDialog(t('ollama.missingBody'), t('ollama.installBtn'))
      if (yes) {
        openUrl('https://ollama.com/download').catch(() => {})
      } else {
        localStorage.setItem('nl-ollama-skip', '1')
      }
    }).catch(() => {})
  }
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
  // mac 原生菜单在第一帧之后立刻挂上：命令注册（菜单文案与快捷键的唯一来源）与菜单装配
  // 提到分栏 / 开库 / 文档恢复之前，否则刚打开那几秒用的还是系统默认菜单。
  registerAppCommands()
  registerEditorCommands()
  setupMacMenu()
  setupTrayMenu()
  // —— 分栏（P5 §6.1，完整模式）：编辑器区挂 SplitPane 树 ——
  // 首窗格复用静态 HTML 的三个挂载点（#editor / #source-mount / #canvas-mount），
  // 整体搬进 .nl-pane 内容壳；树结构与各窗格标签列从 settings.json 恢复
  // （上次会话的分栏布局）。旧格式（裸树）迁移时首窗格按 workspace.lastFile
  // 建一个固定标签；panes 为空 / 坏 → 单窗格空布局，走下面的工作区恢复老路。
  const wsFallback = settingsStore.get().workspace || {}
  // 另开的窗口不继承主窗口的上次会话（布局与标签列的记忆只归主窗口）：从单窗格空布局起
  const panesData = IS_PRIMARY_WINDOW
    ? normalizeTree(settingsStore.get().panes, 'p1', wsFallback.lastVault && wsFallback.lastFile ? { root: wsFallback.lastVault, rel: wsFallback.lastFile } : null)
    : normalizeTree(null, 'p1', null)
  // 恢复出的布局里可能带着空窗格（上次会话关光了标签的窗格、恢复失败摘光的那类）。
  // 启动时直接剪掉，不留一排要手动关的空壳；首叶子保留（画布挂载点的宿主）。
  const pruned = pruneEmptyPanes(panesData)
  panes.tree = pruned.tree
  // 恢复出来的树里第一个叶子的 id 才是首窗格（挂静态 HTML 的三个挂载点）：上次会话
  // 可能把 p1 那个窗格关掉了，剩下 p2|p3 之类，不能写死 p1。焦点按恢复的值走，
  // 可能与首窗格不同（syncFocusedEditor 负责把 els.editor 等指针挪过去）。
  const firstPane = paneIds(panes.tree)[0] || 'p1'
  panes.focused = pruned.focused || firstPane
  const paneOneBody = document.createElement('div')
  paneOneBody.className = 'nl-pane-body'
  paneOneBody.append(els.editor, els.sourceMount, els.canvasMount)
  panes.contents.set(firstPane, paneOneBody)
  panes.mounts.set(firstPane, { editorDiv: els.editor, sourceDiv: els.sourceMount, canvasDiv: els.canvasMount })
  panes.canvasPane = firstPane // #canvas-mount 在这个窗格里，画布只能在这里开
  panes.view = mountSplitTree({
    mountEl: els.editorPane,
    tree: panes.tree,
    contentFor: (paneId) => paneBodyFor(paneId),
    onPaneFocus: (paneId) => {
      if (paneId !== panes.focused) focusPaneUi(paneId)
    },
    onRatioCommit: () => commitPaneRatios(),
    onRatioReset: () => commitPaneRatios(),
  })
  // 树里的每个窗格备好编辑器实例与标签条（恢复出来的布局此刻才有实例；首窗格同理）
  for (const paneId of paneIds(panes.tree)) {
    ensurePaneEditor(paneId)
    mountPaneChrome(paneId)
    ensurePaneFindBar(paneId)
    ensurePaneHlBar(paneId)
    ensurePaneFmtBar(paneId)
  }
  bindPaneDragging() // 标签 / 文件树的拖拽要在窗格与标签条都就位之后才绑
  editor = panes.editors.get(panes.focused)
  findBar = panes.findBars.get(panes.focused) || null
  hlBar = panes.hlBars.get(panes.focused) || null
  await syncFocusedEditor() // 焦点可能不是首窗格：els.editor 等挂载点指针跟着焦点走
  updatePaneChrome()
  // 上次会话里文件夹是被当库打开的：先把目录树铺回来，标签里的文档随后装载。
  // 只在 folderVault 为真时铺——单文件打开记住的根不该在重启后摊成整个文件夹。
  const wsBoot = settingsStore.get().workspace || {}
  if (IS_PRIMARY_WINDOW && wsBoot.folderVault === true && wsBoot.lastVault) {
    try {
      await openVaultPath(wsBoot.lastVault, null)
    } catch (e) {
      console.warn('[restore] 打开上次的知识库失败', e)
      setStatus(t('ws.restoreFailed', { msg: (e && e.message) || e }))
    }
  }
  // 还原各窗格的标签列（预览不恢复，一律按固定），每个窗格只读活动标签的内容，
  // 其余标签点击时再读。恢复出的文档可能已被移走：摘掉该标签留空态，不打断启动。
  for (const paneId of paneIds(panes.tree)) {
    const strip = panes.strips.get(paneId)
    if (strip && panesData.tabs[paneId]) strip.tabs.restore(panesData.tabs[paneId])
  }
  for (const paneId of paneIds(panes.tree)) {
    const strip = panes.strips.get(paneId)
    const act = strip && strip.tabs.active()
    if (!act) continue
    try {
      await loadDocIntoPane(paneId, act)
    } catch (e) {
      console.warn('[restore] 打开上次的文档失败', act.rel, e)
      strip.tabs.remove(act.id)
      // 还有别的标签撑着就显空态；标签光了按运行期同规则整格关掉（末窗格留空态）
      if (strip.tabs.list().length) showPaneEmpty(paneId, true)
      else await closePaneIfEmpty(paneId)
    }
  }
  if (!ftabs() || !ftabs().active()) showPaneEmpty(panes.focused, true) // 焦点窗格没有文档：显空态

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

  // P2 版本快照面板：列表 / 预览 / 回滚（依赖已装配的 editor 与导出用 markdown-it）。
  // 分栏后经 getEditor 现取焦点窗格的编辑器实例（P5 §6.1）
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
    getEditor: () => editor,
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

  // P2 插件钩子系统：打开知识库后从 .notelume-plugins/ 加载（依赖已装配的 editor.view）。
  // 分栏后经 getView 现取焦点窗格的 view（P5 §6.1）
  pluginManager = createPluginManager({
    getView: () => (editor ? editor.view : null),
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
// 标题栏「查找 / 替换」：走命令注册表同一入口（无文档 / 源码态时命令自守卫为空操作）
els.btnFind && els.btnFind.addEventListener('click', () => runViaShortcut('app.findInDoc'))
els.btnReplace && els.btnReplace.addEventListener('click', () => runViaShortcut('app.replace'))
  els.btnDaily && els.btnDaily.addEventListener('click', () => toggleDailyCapture())
  els.btnSource && els.btnSource.addEventListener('click', toggleSourceMode)
  els.btnParagraph && els.btnParagraph.addEventListener('click', (e) => openParagraphMenu(e.currentTarget))
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
    getFeatures: () => getFeatures(settingsStore),
    setFeature: (key, val) => {
      setFeature(settingsStore, key, val)
      refreshFeatureFlags()
    },
  })
  // 「网页剪藏」：设置写 settings.json 的 clip 段，「保存」时经 clip_server_apply
  // 让 Rust 侧停旧起新本地 HTTP 服务；面板关着时服务照常运行
  clipSettings = createClipSettings({
    getClip: currentClip,
    apply: persistClip,
    flush: () => settingsStore.flush(),
    setStatus,
    listTemplates: () => (state.vaultRoot ? listMdInDir(TEMPLATE_DIR()) : []),
  })
  // 「AI」：设置写 settings.json 的 ai 段；侧栏 AI 面板针对当前文档问答，
  // 选区任务（右键 / 命令面板）的结果在浮层里流式预览后写回文档
  aiSettings = createAiSettings({
    getAi: currentAi,
    apply: persistAi,
    flush: () => settingsStore.flush(),
    setStatus,
  })
  aiPanel = createAiPanel({
    root: els.aiPanel,
    getConfig: currentAi,
    openSettings: () => aiSettings.open(),
    getDocContext: aiDocContext,
    insertToDoc: (text) => insertAiMarkdown(editor, text),
    // Agent 模式收尾：锚点协议（自然语言位置）优先——模型回答里 <insert after="…"> 引用的
    // 标题/段落能在文档里找到就直接插到那，找不到回退光标落点并标 missed；
    // 无锚点时按光标智能落位（写到哪补到哪），光标在标题/代码块里插到该块之后，没动过编辑器才落文末
    appendToDoc: (text, anchor) => {
      if (!editor || !editor.view) return false
      const view = editor.view
      const missed = !!(anchor && anchor.target)
      if (anchor && anchor.target) {
        const pos = resolveAnchorPos(view.state.doc, anchor)
        if (pos != null) {
          insertAiMarkdown(editor, text, { caret: pos })
          return { ok: true, where: anchor.target, missed: false }
        }
      }
      const { selection } = view.state
      const atOrigin = selection.head === 0 && selection.anchor === 0
      if (atOrigin) {
        insertAiMarkdown(editor, text, { caret: view.state.doc.content.size })
        return { ok: true, where: missed ? anchor.target : undefined, missed }
      }
      const $head = selection.$head
      const inBlock = $head.parent.type.name === 'heading' || $head.parent.type.name === 'code_block'
      insertAiMarkdown(editor, text, inBlock ? { caret: $head.after(1) } : {})
      return { ok: true, where: missed ? anchor.target : undefined, missed }
    },
    // 底行模型选择器切模型：写回 settings.json 的 ai 段
    persistModel: (name) => persistAi({ ...currentAi(), model: String(name || '').trim().slice(0, 120) }),
    setStatus,
  })
  // P5 §6.6 文件打开链路：拖入打开（主区域）与原生侧唤起（macOS「打开方式」/ 双击 / 拖到
  // Dock 图标，二次唤起）都汇到 handleOpenTargets；启动参数优先于一切，无参数才恢复上次
  // 工作区。拖入 / 唤起是浏览式打开，落预览标签；启动参数是显式意图，落固定标签。
  // 拖入打开：桌面版两端都走 Tauri 原生拖放事件（拖动落点 + 真实绝对路径），差别只在
  // 类型探针——mac 用 probe_external_drop，Windows / Linux 用 drop_path_is_dir；
  // 纯 web 构建没有事件通道，仍走 drop-open.js 的 HTML5 drop。三条都汇到 handleDropTargets。
  bindDropOpen({
    rootEl: document.querySelector('.body'),
    onTargets: handleDropTargets,
  })
  if (IS_MAC) {
    bindNativeDrop()
  } else if (window.__TAURI_INTERNALS__) {
    bindTauriDragOpen({
      rootEl: document.querySelector('.body'),
      onTargets: handleDropTargets,
    })
  }
  // Rust 侧的唤起只排队、不带路径：事件叫醒后统一去 takeLaunchPaths 取。
  // 冷启动那次事件没人听也不丢——排着的同一份队列由 handleLaunchArgs 兜走。
  listen('file-opened', () => {
    if (!IS_PRIMARY_WINDOW) return // 队列全应用共享：让主窗口取，另开的窗口不抢
    takeLaunchPaths()
      .then((targets) => {
        if (targets && targets.length) return handleOpenTargets(targets, { interactive: true, preview: true })
      })
      .catch(() => {}) // 无后端 / 取回失败：静默，界面本来就没有这条路
  }).catch(() => {}) // 纯 web 构建没有事件通道，忽略
  // 网页剪藏落盘（Rust 服务线程 emit）：刷文件树 + 状态栏，不自动打开以免打断当前编辑；
  // openAfterSave 开着才顺带打开新剪藏的那一篇
  listen('nl:clip-saved', (e) => {
    const p = (e && e.payload) || {}
    if (!p.path) return
    if (state.vaultRoot) {
      scanVault(state.vaultRoot)
        .then((tree) => renderTree(tree))
        .catch(() => {})
    }
    const linked = p.linked == null ? 0 : p.linked
    setStatus(t('clip.saved', { rel: p.path, linked }))
    if (currentClip().openAfterSave) openFile(p.path)
  }).catch(() => {}) // 纯 web 构建没有事件通道，忽略
  // 外部文件系统变动（Rust fs_watcher emit）：刷文件树 + 重建索引，不自动打开
  listen('nl:vault-changed', (e) => {
    const p = (e && e.payload) || {}
    if (!p.vaultRoot) return
    // 只对当前打开的库响应；其它库的变动忽略
    if (state.vaultRoot && normVaultPath(p.vaultRoot) === normVaultPath(state.vaultRoot)) {
      scanVault(state.vaultRoot)
        .then((tree) => renderTree(tree))
        .catch(() => {})
      startIndexPolling()
      setStatus(t('status.vaultChanged', { kind: p.kind || '' }))
    }
  }).catch(() => {})
  await handleLaunchArgs()
  bindShortcuts()
  installGlobalContextMenu()
  bindTreeBgMenu() // 开机即绑：一个文档都没开时右键树区也不漏原生菜单
  setupCloseGuard()

  // 文件树右键菜单：点击菜单外任意处即关闭
  document.addEventListener('pointerdown', (e) => {
    if (treeMenuEl && !treeMenuEl.contains(e.target)) closeTreeMenu()
  }, true)
}

boot().catch((e) => {
  console.error(e)
  if (window.__nlError) window.__nlError(t('status.initFailed', { err: (e && e.message) || e }))
})
