// main.js —— 应用装配：布局、知识库文件树、大纲、标签、主题、快捷键、打开/保存/跳转
import { createEditor } from './editor-view.js'
import {
  pickFolder,
  scanVault,
  readMdFile,
  writeMdFile,
  resolveWikiLink,
  createMdFile,
  confirmDialog,
  messageDialog,
} from './tauri-bridge.js'

const state = {
  vaultRoot: null, // 知识库根（绝对路径）
  currentFile: null, // 当前文档库内相对路径
  dirty: false,
}

const $ = (id) => document.getElementById(id)
const els = {
  tree: $('filetree'),
  outline: $('outline'),
  tags: $('tags'),
  editor: $('editor'),
  filename: $('filename'),
  status: $('status'),
  btnOpen: $('btn-open'),
  btnSave: $('btn-save'),
  btnTheme: $('btn-theme'),
}

let editor

function setStatus(msg) {
  els.status.textContent = msg
}

// —— 主题 ——
function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme)
  localStorage.setItem('nl-theme', theme)
  els.btnTheme.textContent = theme === 'dark' ? '☀️ 浅色' : '🌙 暗黑'
}
function toggleTheme() {
  const cur = document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark'
  applyTheme(cur)
}

// —— 打开文件夹作为知识库 ——
async function openFolder() {
  const root = await pickFolder()
  if (!root) return
  state.vaultRoot = root
  try {
    const tree = await scanVault(root)
    renderTree(tree)
    setStatus('知识库已加载：' + root)
  } catch (e) {
    await messageDialog('扫描知识库失败：' + e)
  }
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
  return li
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
  try {
    const md = await readMdFile(state.vaultRoot, rel)
    state.currentFile = rel
    editor.setMarkdown(md)
    els.filename.textContent = rel
    highlightActiveFile()
    setStatus('已打开：' + rel)
    editor.focus()
  } catch (e) {
    await messageDialog('打开失败：' + e)
  }
}

// —— 保存到原文件 ——
async function saveCurrent() {
  if (!state.currentFile || !state.vaultRoot) {
    setStatus('没有可保存的文档')
    return
  }
  try {
    const md = editor.getMarkdown()
    await writeMdFile(state.vaultRoot, state.currentFile, md)
    editor.markSaved()
    setStatus('已保存：' + state.currentFile + ' · ' + timeStr())
  } catch (e) {
    await messageDialog('保存失败：' + e)
  }
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
    // 重新扫描以让新文件出现在树中
    renderTree(await scanVault(state.vaultRoot))
    state.currentFile = null // 强制刷新
    state.dirty = false
    await openFile(rel)
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
    tw.appendChild(chip)
  })
  if (!tags.length) tw.innerHTML = '<div class="muted">本文档暂无标签</div>'
}

// —— 快捷键（应用级）——
function bindShortcuts() {
  document.addEventListener('keydown', (e) => {
    const mod = e.ctrlKey || e.metaKey
    if (!mod) return
    const key = e.key.toLowerCase()
    if (key === 's') {
      e.preventDefault()
      saveCurrent()
    } else if (key === 'o') {
      e.preventDefault()
      openFolder()
    }
  })
}

async function boot() {
  editor = createEditor({
    mountEl: els.editor,
    getVault: () => ({ vaultRoot: state.vaultRoot, mdRel: state.currentFile }),
    onOpenWiki,
    onMetaChange,
    onDirty: (d) => {
      state.dirty = d
      els.filename.classList.toggle('dirty', d)
    },
  })

  applyTheme(localStorage.getItem('nl-theme') || 'light')

  els.btnOpen.addEventListener('click', openFolder)
  els.btnSave.addEventListener('click', saveCurrent)
  els.btnTheme.addEventListener('click', toggleTheme)
  bindShortcuts()

  setStatus('第一步：点「打开知识库」选择一个本地文件夹')
}

boot()
