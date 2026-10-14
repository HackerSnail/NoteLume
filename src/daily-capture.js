// daily-capture.js —— 全局「今日速记」浮层
//
// 设计要点（回应"今日不该和知识库文件夹绑定"）：
//  · 与当前打开的知识库完全无关：所有库共用同一个"今日文件"；未开库也能用。
//  · 独立浮层 + 纯 <textarea>（不占用主 ProseMirror 编辑区、不切换工作根、互不打断）。
//  · 落盘为标准 markdown（普通 .md 文件，纯文件、无私有格式）。
//  · 存放目录 = 一个用户选定的**绝对路径**文件夹（存 localStorage，全局），
//    把该目录当作它自己的根传给现有 read_md_file/write_md_file（路径天然在根内，无需改 Rust）。
//  · 停止输入 ~0.8s 自动保存；关闭 / Ctrl+S 立即保存；Esc 关闭。
import { readMdFile, writeMdFile, pickFolder, confirmDialog, messageDialog } from './tauri-bridge.js'
import { promptDialog } from './prompt-dialog.js'
import { formatDate, builtinVars, applyTemplate } from './template.js'

const LS_DIR = 'nl-daily-abs'
const LS_FMT = 'nl-daily-format'
const DEFAULT_FMT = 'YYYY-MM-DD'
const SEED = '# {{date}} {{weekday}}\n\n'

let overlay, ta, statusEl, dirLabelEl, curRel = null, dirty = false, timer = null

const getFmt = () => localStorage.getItem(LS_FMT) || DEFAULT_FMT
const dirName = (dir) => { const i = Math.max(dir.lastIndexOf('/'), dir.lastIndexOf('\\')); return i < 0 ? dir : (dir.slice(i + 1) || dir) }

// 计算今天的库内相对文件名（去掉路径分隔/非法字符，避免越界或非法名）
function dailyRel() {
  const name = formatDate(getFmt(), new Date()).replace(/[\\/:*?"<>|]/g, '-').replace(/^\.+/, '')
  return (name || 'daily') + '.md'
}

function setStatus(msg) { if (statusEl) statusEl.textContent = msg }

function ensureDom() {
  if (overlay) return
  overlay = document.createElement('div')
  overlay.className = 'nl-daily-overlay hidden'
  const box = document.createElement('div')
  box.className = 'nl-daily'

  const head = document.createElement('div')
  head.className = 'nl-daily-head'
  const title = document.createElement('span')
  title.className = 'nl-daily-title'
  title.textContent = '📅 今日速记'
  dirLabelEl = document.createElement('span')
  dirLabelEl.className = 'nl-daily-dir'
  const cfgBtn = document.createElement('button')
  cfgBtn.className = 'nl-daily-cfg'
  cfgBtn.title = '设置今日目录 / 文件命名'
  cfgBtn.textContent = '⚙'
  const closeBtn = document.createElement('button')
  closeBtn.className = 'nl-daily-close'
  closeBtn.title = '关闭并保存 (Esc)'
  closeBtn.textContent = '✕'
  head.append(title, dirLabelEl, cfgBtn, closeBtn)

  ta = document.createElement('textarea')
  ta.className = 'nl-daily-ta'
  ta.spellcheck = false
  ta.placeholder = '随手记点什么…（停止输入即自动保存为标准 markdown）'

  statusEl = document.createElement('div')
  statusEl.className = 'nl-daily-status'

  box.append(head, ta, statusEl)
  overlay.appendChild(box)
  document.body.appendChild(overlay)

  closeBtn.addEventListener('click', close)
  cfgBtn.addEventListener('click', configure)
  overlay.addEventListener('pointerdown', (e) => { if (e.target === overlay) close() })
  ta.addEventListener('input', onInput)
  // 捕获阶段拦下 Ctrl+S / Esc，避免冒泡到应用级快捷键（Ctrl+S 存主编辑区、会误触发脏检查）
  ta.addEventListener('keydown', (e) => {
    const mod = e.ctrlKey || e.metaKey
    if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); e.stopPropagation(); flush() }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close() }
  })
}

async function loadAndShow(dir) {
  curRel = dailyRel()
  let content
  try {
    content = await readMdFile(dir, curRel)
  } catch (_) {
    // 今天还没有：用种子（含 {{date}}/{{weekday}} 变量）新建并立即落盘
    const now = new Date()
    content = applyTemplate(SEED, builtinVars({ title: curRel.replace(/\.md$/i, ''), filename: curRel, now }))
    try { await writeMdFile(dir, curRel, content) }
    catch (e) { await messageDialog('无法在今日目录创建笔记：' + ((e && e.message) || e)); return }
  }
  ta.value = content
  dirty = false
  dirLabelEl.textContent = dirName(dir) + ' · ' + curRel
  overlay.classList.remove('hidden')
  setStatus('已载入今天（' + curRel + '）')
  setTimeout(() => ta.focus(), 0)
}

async function flush() {
  if (timer) { clearTimeout(timer); timer = null }
  const dir = localStorage.getItem(LS_DIR)
  if (!dir || !curRel) return
  try {
    await writeMdFile(dir, curRel, ta.value)
    dirty = false
    setStatus('已保存 · ' + new Date().toLocaleTimeString())
  } catch (e) {
    setStatus('⚠ 保存失败：' + ((e && e.message) || e))
  }
}

function onInput() {
  dirty = true
  setStatus('编辑中…')
  if (timer) clearTimeout(timer)
  timer = setTimeout(flush, 800)
}

function close() {
  if (!overlay || overlay.classList.contains('hidden')) return
  flush()
  overlay.classList.add('hidden')
}

// 切换浮层；未设置今日目录时先引导设置
async function toggle() {
  let dir = localStorage.getItem(LS_DIR)
  if (!dir) { await configure(); dir = localStorage.getItem(LS_DIR); if (!dir) return }
  ensureDom()
  if (!overlay.classList.contains('hidden')) { close(); return }
  await loadAndShow(dir)
}

// 设置：选一个绝对文件夹作为今日目录 + 文件名日期格式
async function configure() {
  ensureDom()
  const cur = localStorage.getItem(LS_DIR)
  const go = await confirmDialog(
    '设置「今日速记」的存放位置。\n\n当前：' + (cur ? cur : '未设置') +
    '\n\n下一步用系统对话框选择一个文件夹（所有知识库共用这一个"今日"，与当前打开的库无关）。',
    '今日速记 · 设置'
  )
  if (!go) return
  const dir = await pickFolder()
  if (dir) localStorage.setItem(LS_DIR, dir)
  const f = await promptDialog({ title: '今日文件名 · 日期格式', placeholder: 'YYYY-MM-DD / YYYYMMDD / YYYY年MM月DD日 …', defaultValue: getFmt() })
  if (f != null) localStorage.setItem(LS_FMT, f)
  setStatus(dir ? '今日目录已设为：' + dir : '未更改目录')
  // 若浮层正开着，按新设置重新载入今天
  const nowDir = localStorage.getItem(LS_DIR)
  if (nowDir && !overlay.classList.contains('hidden')) await loadAndShow(nowDir)
}

export const toggleDailyCapture = toggle
export const configureDailyCapture = configure
export const closeDailyCapture = close
export const isDailyCaptureOpen = () => !!overlay && !overlay.classList.contains('hidden')
