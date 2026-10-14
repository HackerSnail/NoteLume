// git-panel.js —— 批次 E（子项目 L）本地 Git 面板
// 探测仓库 / status 改动列表 / log 历史 / 单文件 diff 预览 / 一键提交 / 初始化。
// 全程本地，不碰远程与认证（子项目 R 才做）。数据经 tauri-bridge 的 git_* 封装获取。
// 与主逻辑解耦：库根、转义、状态栏提示经 deps 注入；promptDialog / messageDialog 直接复用既有件。
import {
  gitOpen,
  gitStatus,
  gitLog,
  gitDiffFile,
  gitConfigIdentity,
  gitInit,
  gitCommitAll,
  messageDialog,
} from './tauri-bridge.js'
import { promptDialog } from './prompt-dialog.js'

// kind → [徽标字符, 中文短名]（对齐 Rust classify_status 的取值域）
const KIND_BADGE = {
  modified: ['M', '修改'],
  new: ['N', '新增'],
  deleted: ['D', '删除'],
  renamed: ['R', '重命名'],
  untracked: ['?', '未跟踪'],
  conflicted: ['C', '冲突'],
  ignored: ['·', '忽略'],
}

// Unix 秒 → 相对时间（近则分钟/小时，远则日期）
function relTime(sec) {
  const then = sec * 1000
  const diff = Date.now() - then
  const min = Math.floor(diff / 60000)
  if (min < 1) return '刚刚'
  if (min < 60) return `${min} 分钟前`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr} 小时前`
  const day = Math.floor(hr / 24)
  if (day < 30) return `${day} 天前`
  const d = new Date(then)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

export function createGitPanel(deps) {
  const { rootEl, getVaultRoot, escapeHtml, setStatus } = deps

  let curRepoPath = null // 当前显示仓库的工作目录（可能高于 vaultRoot）
  let busy = false // 防重入（刷新/提交期间忽略并发）

  // —— 一次性搭骨架，之后只更新内容区 ——
  rootEl.innerHTML = ''
  const head = document.createElement('div')
  head.className = 'nl-git-head'
  const body = document.createElement('div')
  body.className = 'nl-git-body'
  rootEl.append(head, body)

  function renderPlaceholder(html) {
    head.innerHTML = ''
    body.innerHTML = '<div class="nl-git-empty">' + html + '</div>'
  }

  // 顶栏：分支 + 改动计数 + 刷新/提交按钮（或初始化按钮）
  function renderHead(info, changeCount) {
    head.innerHTML = ''

    if (!info.isRepo) {
      const tip = document.createElement('span')
      tip.className = 'nl-git-branch nl-git-muted'
      tip.textContent = '未检测到 Git 仓库'
      const btn = document.createElement('button')
      btn.className = 'nl-git-btn'
      btn.textContent = '初始化仓库'
      btn.title = '在当前库根 git init，并按需写排除 .notelume-backup/ 的 .gitignore'
      btn.addEventListener('click', () => init())
      const actions = document.createElement('span')
      actions.className = 'nl-git-actions'
      actions.appendChild(btn)
      head.append(tip, actions)
      return
    }

    const left = document.createElement('span')
    left.className = 'nl-git-branch'
    const branch = info.branch || (info.hasHead ? '(分离 HEAD)' : '(无提交)')
    left.textContent = '⑂ ' + branch
    left.title = curRepoPath || ''

    const count = document.createElement('span')
    count.className = 'nl-git-count'
    count.textContent = changeCount > 0 ? `${changeCount} 项改动` : '工作树干净'

    const actions = document.createElement('span')
    actions.className = 'nl-git-actions'
    const refreshBtn = document.createElement('button')
    refreshBtn.className = 'nl-git-btn'
    refreshBtn.textContent = '⟳'
    refreshBtn.title = '刷新状态'
    refreshBtn.addEventListener('click', () => refresh())
    const commitBtn = document.createElement('button')
    commitBtn.className = 'nl-git-btn nl-git-btn-primary'
    commitBtn.textContent = '提交全部'
    commitBtn.title = 'git add -A + commit（尊重 .gitignore）'
    commitBtn.disabled = changeCount === 0
    commitBtn.addEventListener('click', () => commitAll())
    actions.append(refreshBtn, commitBtn)

    head.append(left, count, actions)
  }

  // —— Changes 区 ——
  function renderChanges(items) {
    const sec = document.createElement('div')
    sec.className = 'nl-git-section'
    const title = document.createElement('div')
    title.className = 'nl-git-section-title'
    title.textContent = '变更'
    sec.appendChild(title)

    const list = document.createElement('div')
    list.className = 'nl-git-list'
    if (!items.length) {
      list.innerHTML = '<div class="nl-git-empty-inline">没有改动</div>'
    } else {
      items.forEach((it) => {
        const [badge, label] = KIND_BADGE[it.kind] || ['•', it.kind]
        const row = document.createElement('div')
        row.className = 'nl-git-item'
        row.title = it.path + (it.staged ? '（已暂存）' : '')
        const b = document.createElement('span')
        b.className = 'nl-git-badge nl-git-badge-' + it.kind
        b.textContent = badge
        const p = document.createElement('span')
        p.className = 'nl-git-path'
        p.textContent = it.path
        row.append(b, p)
        row.addEventListener('click', () => showDiff(it.path, 'HEAD', label + '：' + it.path))
        list.appendChild(row)
      })
      if (items.length >= 1000) {
        const more = document.createElement('div')
        more.className = 'nl-git-empty-inline'
        more.textContent = '改动过多，仅显示前 1000 项'
        list.appendChild(more)
      }
    }
    sec.appendChild(list)
    return sec
  }

  // —— History 区 ——
  function renderHistory(commits) {
    const sec = document.createElement('div')
    sec.className = 'nl-git-section'
    const title = document.createElement('div')
    title.className = 'nl-git-section-title'
    title.textContent = '历史'
    sec.appendChild(title)

    const list = document.createElement('div')
    list.className = 'nl-git-list'
    if (!commits.length) {
      list.innerHTML = '<div class="nl-git-empty-inline">尚无提交</div>'
    } else {
      commits.forEach((c) => {
        const row = document.createElement('div')
        row.className = 'nl-git-item nl-git-commit'
        row.title = c.summary
        const id = document.createElement('span')
        id.className = 'nl-git-id'
        id.textContent = c.idShort
        const wrap = document.createElement('span')
        wrap.className = 'nl-git-commit-main'
        const sum = document.createElement('span')
        sum.className = 'nl-git-summary'
        sum.textContent = c.summary
        const meta = document.createElement('span')
        meta.className = 'nl-git-meta'
        meta.textContent = `${c.authorName} · ${relTime(c.time)}`
        wrap.append(sum, meta)
        row.append(id, wrap)
        row.addEventListener('click', () => showCommit(c))
        list.appendChild(row)
      })
    }
    sec.appendChild(list)
    return sec
  }

  // —— diff / 详情预览区（复用一块，切换内容）——
  const diffBox = document.createElement('div')
  diffBox.className = 'nl-git-diff hidden'
  function showDiffInBox(headText, diffHtml) {
    diffBox.classList.remove('hidden')
    diffBox.innerHTML =
      '<div class="nl-git-diff-head"><span>' +
      escapeHtml(headText) +
      '</span><button class="nl-git-diff-close" title="关闭">✕</button></div>' +
      diffHtml
    const close = diffBox.querySelector('.nl-git-diff-close')
    close.addEventListener('click', () => diffBox.classList.add('hidden'))
  }

  // 按行前缀着色：+ 新增 / - 删除 / @@ 块头 / diff 头
  function colorizeDiff(text) {
    if (!text) return '<div class="nl-git-empty-inline">无差异</div>'
    const lines = text.split('\n')
    const out = lines.map((ln) => {
      const esc = escapeHtml(ln)
      if (ln.startsWith('+++') || ln.startsWith('---')) return '<div class="nl-git-diff-file">' + esc + '</div>'
      if (ln.startsWith('@@')) return '<div class="nl-git-diff-hunk">' + esc + '</div>'
      if (ln.startsWith('+')) return '<div class="nl-git-diff-add">' + esc + '</div>'
      if (ln.startsWith('-')) return '<div class="nl-git-diff-del">' + esc + '</div>'
      return '<div class="nl-git-diff-ctx">' + esc + '</div>'
    })
    return '<pre class="nl-git-diff-pre">' + out.join('') + '</pre>'
  }

  async function showDiff(path, against, headText) {
    const vaultRoot = getVaultRoot()
    if (!vaultRoot) return
    try {
      const diff = await gitDiffFile(vaultRoot, path, against)
      showDiffInBox(headText, colorizeDiff(diff))
    } catch (e) {
      await messageDialog('读取 diff 失败：' + errText(e))
    }
  }

  // History 点击：展示提交详情（作者/时间/完整 summary）。命令面未含"列某提交改动文件"，
  // 故此处只做详情展示；文件级 diff 由「变更」区承担（工作树 vs HEAD）。
  function showCommit(c) {
    const detail =
      '<div class="nl-git-commit-detail">' +
      '<div class="nl-git-detail-row"><span class="nl-git-detail-k">提交</span><span class="nl-git-detail-v mono">' +
      escapeHtml(c.id) +
      '</span></div>' +
      '<div class="nl-git-detail-row"><span class="nl-git-detail-k">摘要</span><span class="nl-git-detail-v">' +
      escapeHtml(c.summary || '(无摘要)') +
      '</span></div>' +
      '<div class="nl-git-detail-row"><span class="nl-git-detail-k">作者</span><span class="nl-git-detail-v">' +
      escapeHtml(c.authorName) +
      ' &lt;' +
      escapeHtml(c.authorEmail) +
      '&gt;</span></div>' +
      '<div class="nl-git-detail-row"><span class="nl-git-detail-k">时间</span><span class="nl-git-detail-v">' +
      escapeHtml(relTime(c.time)) +
      '</span></div>' +
      '</div>'
    showDiffInBox('提交 ' + c.idShort, detail)
  }

  function renderBody(items, commits) {
    body.innerHTML = ''
    body.append(renderChanges(items), renderHistory(commits), diffBox)
    diffBox.classList.add('hidden')
    diffBox.innerHTML = ''
  }

  // —— 公共动作 ——
  // load 做实际拉取与渲染，假定调用方已持有 busy（供 commit/init 完成后直接复用，避免被重入守卫吞掉）。
  async function load() {
    const vaultRoot = getVaultRoot()
    if (!vaultRoot) {
      curRepoPath = null
      renderPlaceholder('打开知识库后显示 Git 状态')
      return
    }
    try {
      const info = await gitOpen(vaultRoot)
      curRepoPath = info.repoPath || null
      if (!info.isRepo) {
        renderHead(info, 0)
        body.innerHTML = ''
        body.appendChild(
          el('div', 'nl-git-empty', '此文件夹不是 Git 仓库。点上方「初始化仓库」即可纳入版本管理。'),
        )
        return
      }
      const [items, commits] = await Promise.all([gitStatus(vaultRoot), gitLog(vaultRoot)])
      renderHead(info, items.length)
      renderBody(items, commits)
    } catch (e) {
      renderPlaceholder('读取 Git 状态失败：' + escapeHtml(errText(e)))
    }
  }

  async function refresh() {
    if (busy) return
    busy = true
    try {
      await load()
    } finally {
      busy = false
    }
  }

  async function commitAll() {
    if (busy) return
    const vaultRoot = getVaultRoot()
    if (!vaultRoot) return
    const message = await promptDialog({
      title: '提交全部改动',
      placeholder: '描述本次改动（提交信息）',
      confirmLabel: '提交',
    })
    if (!message) return // 取消

    busy = true
    try {
      // 身份：先读配置；缺失则问一次（name/email 一并传给 commit，Rust 侧回写本地配置）
      let name = null
      let email = null
      const id = await gitConfigIdentity(vaultRoot)
      if (!id) {
        name = await promptDialog({ title: '提交身份 · 姓名', placeholder: 'user.name', confirmLabel: '下一步' })
        if (name == null) return
        email = await promptDialog({ title: '提交身份 · 邮箱', placeholder: 'user@email.com', confirmLabel: '提交' })
        if (email == null) return
      }
      const res = await gitCommitAll(vaultRoot, message, name, email)
      setStatus('已提交 ' + res.idShort)
      await load()
    } catch (e) {
      await messageDialog('提交失败：' + errText(e))
    } finally {
      busy = false
    }
  }

  async function init() {
    if (busy) return
    const vaultRoot = getVaultRoot()
    if (!vaultRoot) return
    busy = true
    try {
      await gitInit(vaultRoot)
      setStatus('已初始化 Git 仓库')
      await load()
    } catch (e) {
      await messageDialog('初始化失败：' + errText(e))
    } finally {
      busy = false
    }
  }

  function open() {
    refresh()
  }

  return { refresh, open, commitAll, init }
}

// —— 小工具 ——
function el(tag, cls, text) {
  const e = document.createElement(tag)
  if (cls) e.className = cls
  if (text != null) e.textContent = text
  return e
}

function errText(e) {
  return (e && (e.message || e)) || '未知错误'
}
