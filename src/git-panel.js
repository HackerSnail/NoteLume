// git-panel.js —— 批次 E（子项目 L + R1 + R1-B + R2）本地 + 远程 Git 面板
// 本地（L）：探测仓库 / status 改动列表 / log 历史 / 单文件 diff 预览 / 一键提交 / 初始化。
// 远程（R1）：「同步」区——探测系统 git / 远端 origin 增改 / fetch / 领先落后 / 快进 pull。
//   认证交系统 git（应用不碰凭据）；仅 --ff-only，非快进不自动合并。数据经 tauri-bridge 的 git_* / git_r_* 封装获取。
// R1-B（内置引擎）：无系统 git 时自动切 git2；同步区顶部展引擎徽标；fetch/pull 错误按 `[code]` 前串分派，
//   陌生 host 走一次性信任。
// R2（push）：↑ Push 按钮，当前分支 → upstream 同名分支；无 upstream → `[no_upstream]` 引导。
// R3（合并拉取 + 冲突解决）：⇅ Pull（合并）按钮；冲突文件在变更列表逐行给出「用本地 / 用远端 / 编辑」，顶部合并工具条可提交合并 / 中止合并。
// 与主逻辑解耦：库根、转义、状态栏提示、pull 后集成回调、打开文件经 deps 注入；promptDialog / messageDialog / confirmDialog 复用既有件。
import {
  gitOpen,
  gitStatus,
  gitLog,
  gitDiffFile,
  gitConfigIdentity,
  gitInit,
  gitCommitAll,
  messageDialog,
  confirmDialog,
  gitRInfo,
  gitRRemoteList,
  gitRRemoteAdd,
  gitRRemoteSetUrl,
  gitRFetch,
  gitRAheadBehind,
  gitRPullFf,
  gitRPush,
  gitRPullMerge,
  gitRResolve,
  gitRMergeState,
  gitRAbortMerge,
  gitRCommitMerge,
  gitRTrustHost,
} from './tauri-bridge.js'
import { promptDialog } from './prompt-dialog.js'
import { setIcon, iconHTML } from './icons.js'

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
  const { rootEl, getVaultRoot, escapeHtml, setStatus, onPullDone, openFile } = deps

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
    setIcon(left, 'branch', branch)
    left.title = curRepoPath || ''

    const count = document.createElement('span')
    count.className = 'nl-git-count'
    count.textContent = changeCount > 0 ? `${changeCount} 项改动` : '工作树干净'

    const actions = document.createElement('span')
    actions.className = 'nl-git-actions'
    const refreshBtn = document.createElement('button')
    refreshBtn.className = 'nl-git-btn'
    setIcon(refreshBtn, 'reload')
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
        const conflicted = it.kind === 'conflicted'
        const row = document.createElement('div')
        row.className = 'nl-git-item' + (conflicted ? ' nl-git-conflict' : '')
        row.title = it.path + (it.staged ? '（已暂存）' : '')
        const b = document.createElement('span')
        b.className = 'nl-git-badge nl-git-badge-' + it.kind
        b.textContent = badge
        const p = document.createElement('span')
        p.className = 'nl-git-path'
        p.textContent = it.path
        row.append(b, p)
        if (conflicted) {
          const tools = document.createElement('span')
          tools.className = 'nl-git-conflict-tools'
          tools.append(
            miniBtn('用本地', () => resolveConf(it.path, 'ours')),
            miniBtn('用远端', () => resolveConf(it.path, 'theirs')),
            miniBtn('编辑', () => editConflict(it.path)),
          )
          row.appendChild(tools)
        } else {
          row.addEventListener('click', () => showDiff(it.path, 'HEAD', label + '：' + it.path))
        }
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
      '</span><button class="nl-git-diff-close" title="关闭">' + iconHTML('close') + '</button></div>' +
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

  function renderBody(items, commits, merging) {
    body.innerHTML = ''
    const sync = buildSyncSection()
    const parts = []
    if (merging) parts.push(renderMergeBar(items))
    parts.push(renderChanges(items), renderHistory(commits), sync.sec, diffBox)
    body.append(...parts)
    diffBox.classList.add('hidden')
    diffBox.innerHTML = ''
    populateSync(sync.inner) // 异步填充，不阻塞本地列表渲染
  }

  // R3：合并进行中工具条（列冲突数 + 提交/中止合并）
  function renderMergeBar(items) {
    const conflictCount = items.filter((i) => i.kind === 'conflicted').length
    const sec = document.createElement('div')
    sec.className = 'nl-git-section nl-git-merge-bar'
    const msg = document.createElement('span')
    msg.className = 'nl-git-merge-msg' + (conflictCount ? ' nl-git-sync-behind' : '')
    msg.textContent = conflictCount
      ? `合并进行中 · ${conflictCount} 个冲突待解决`
      : '合并进行中 · 冲突已全部解决，可提交合并'
    const actions = document.createElement('span')
    actions.className = 'nl-git-actions'
    const okBtn = document.createElement('button')
    okBtn.className = 'nl-git-btn nl-git-btn-primary'
    setIcon(okBtn, 'check', '提交合并')
    okBtn.disabled = conflictCount > 0
    okBtn.title = conflictCount > 0 ? '请先解决所有冲突' : '生成 merge commit'
    okBtn.addEventListener('click', () => doCommitMerge())
    const abortBtn = document.createElement('button')
    abortBtn.className = 'nl-git-btn'
    setIcon(abortBtn, 'close', '中止合并')
    abortBtn.title = '回到合并前状态（merge --abort）'
    abortBtn.addEventListener('click', () => doAbortMerge())
    actions.append(okBtn, abortBtn)
    sec.append(msg, actions)
    return sec
  }

  // ===== R1：同步区 =====
  // buildSyncSection 同步搭一个占位容器，populateSync 异步按「系统 git / 远端 / 领先落后」填充。
  function buildSyncSection() {
    const sec = document.createElement('div')
    sec.className = 'nl-git-section nl-git-sync-sec'
    const title = document.createElement('div')
    title.className = 'nl-git-section-title'
    title.textContent = '同步'
    const inner = document.createElement('div')
    inner.className = 'nl-git-sync'
    inner.innerHTML = '<div class="nl-git-empty-inline">检测远程能力…</div>'
    sec.append(title, inner)
    return { sec, inner }
  }

  // 凭据类错误的一句通用引导（命中关键字则附）
  function credHint(t) {
    if (/terminal prompts disabled|could not read|Authentication|permission denied|invalid username|password|ssh|BatchMode/i.test(t)) {
      return '\n\n提示：应用不代持凭据，请在系统终端配好 git 凭据助手 / ssh-agent（HTTPS 可用 Personal Access Token，SSH 需加载密钥到 agent）后重试。'
    }
    return ''
  }

  // Phase 4：拆解 `[code]body` 前串。System 引擎旧格式无 → code=null（回关键字判定）。
  // [host_unknown]<json> 额外 JSON.parse body → payload（前端一次性信任弹框需）。
  function parseErrCode(t) {
    const m = /^\[([a-z_]+)\]([\s\S]*)$/.exec(t || '')
    if (!m) return { code: null, body: t || '', payload: null }
    const code = m[1]
    const body = m[2]
    let payload = null
    if (code === 'host_unknown') {
      try {
        payload = JSON.parse(body)
      } catch (_) {
        payload = null
      }
    }
    return { code, body, payload }
  }

  // Phase 4/5：远程错误分派总入口：
  // 1) host_unknown → 一次性信任弹框 → gitRTrustHost → retryFn
  // 2) non_fast_forward / 无 code 但命中 NONFF_RE → 分叉引导
  // 3) local_changes / hostkey_mismatch / network / auth → 对应引导
  // 4) 其余 → 原文 + credHint
  async function handleRemoteErr(t, opName, retryFn) {
    const { code, body, payload } = parseErrCode(t)
    if (code === 'host_unknown' && payload && payload.host) {
      const msg =
        '首次连接 SSH 主机：' +
        payload.host +
        '\n密钥类型：' +
        (payload.keyType || 'unknown') +
        (payload.fingerprint ? '\n指纹：' + payload.fingerprint : '') +
        '\n\n与官方公告核对无误后选「信任」，下次同 host 将自动放行。\n' +
        '若并非首次连接且已看到 mismatch 提示，请拒绝并在终端手工核对。'
      const ok = await confirmDialog(msg, '信任此主机？')
      if (!ok) {
        await messageDialog('已取消' + opName + '：' + body)
        return
      }
      try {
        await gitRTrustHost({
          host: payload.host,
          keyType: payload.keyType,
          keyB64: payload.keyB64,
        })
      } catch (e) {
        await messageDialog('写 known_hosts 失败：' + errText(e))
        return
      }
      try {
        if (typeof retryFn === 'function') await retryFn()
      } catch (e2) {
        const t2 = errText(e2)
        await messageDialog(opName + '仍失败：' + t2 + credHint(t2))
      }
      return
    }
    if (code === 'non_fast_forward' || (!code && NONFF_RE.test(t))) {
      await messageDialog(
        opName +
          '被拒（本地与远端已分叉，无法快进）：\n' +
          (body || t) +
          '\n\n可用「同步」区的『Pull（合并）』按钮，或命令面板『Git：拉取（合并）』改走合并拉取；\n产生的冲突会在「变更」列表逐行列出，可选用本地 / 用远端 / 手动编辑，全部解决后提交合并。',
      )
      return
    }
    if (code === 'local_changes') {
      await messageDialog('本地未提交修改会阻挡快进：\n' + body + '\n\n请先提交或 stash。')
      return
    }
    if (code === 'no_upstream') {
      await messageDialog(
        '当前分支无上游，无法推：\n' +
          (body || t) +
          '\n\n内置引擎不自动设 upstream（避免默默创远程新分支）。\n请一次性安装系统 git 跑 `git push -u origin <当前分支>`，或手动配好后重试。',
      )
      return
    }
    if (code === 'hostkey_mismatch') {
      await messageDialog(
        '主机密钥与已存 known_hosts 不匹配：可能是中间人攻击或服务器重新生成密钥。\n\n' +
          body +
          '\n\n请在官方渠道核对指纹后，手动删除对应 known_hosts 条目并重试。',
      )
      return
    }
    if (code === 'network') {
      await messageDialog(body + '\n\n提示：请检查网络 / 代理 / 防火墙。')
      return
    }
    await messageDialog(opName + '失败：' + t + credHint(t))
  }

  // 刷新领先/落后徽标（fetch / pull 后调用）
  async function updateBadge(badge) {
    const vaultRoot = getVaultRoot()
    if (!vaultRoot || !badge || !badge.isConnected) return
    try {
      const ab = await gitRAheadBehind(vaultRoot)
      if (!ab) {
        badge.textContent = '未设置上游'
        badge.className = 'nl-git-sync-badge nl-git-muted'
      } else {
        setIcon(badge, ab.behind > 0 ? 'arrow-down' : 'arrow-up', `领先 ${ab.ahead} · 落后 ${ab.behind}`)
        badge.className =
          'nl-git-sync-badge' + (ab.behind > 0 ? ' nl-git-sync-behind' : '')
        badge.title = '上游：' + ab.upstream
      }
    } catch (_) {
      badge.textContent = ''
    }
  }

  // 实际填充同步区控件：引擎徽标 + 远端行 + Fetch/Pull + 徽标。按钮动作复用面板 busy 串行化。
  async function populateSync(inner) {
    const vaultRoot = getVaultRoot()
    if (!vaultRoot) {
      inner.innerHTML = '<div class="nl-git-empty-inline">打开知识库后可用</div>'
      return
    }
    let info = null
    try {
      info = await gitRInfo()
    } catch (_) {
      info = null
    }
    if (!inner.isConnected) return
    if (!info || !info.builtinReady) {
      inner.innerHTML =
        '<div class="nl-git-empty-inline">远程同步不可用（内置引擎未就绪）。</div>'
      return
    }
  
    // 读远端（优先 origin，否则首个远端）
    let remotes = []
    try {
      remotes = (await gitRRemoteList(vaultRoot)) || []
    } catch (_) {
      remotes = []
    }
    if (!inner.isConnected) return
    const origin = remotes.find((r) => r.name === 'origin') || remotes[0] || null
  
    inner.innerHTML = ''
  
    // —— 引擎徽标行 ——
    const engineRow = document.createElement('div')
    engineRow.className = 'nl-git-sync-engine'
    const engBadge = document.createElement('span')
    const isSys = info.engine === 'system'
    engBadge.className =
      'nl-git-engine-badge ' + (isSys ? 'nl-git-engine-system' : 'nl-git-engine-builtin')
    setIcon(
      engBadge,
      isSys ? 'terminal' : 'box',
      isSys ? '系统 git · ' + (info.gitVersion || '') : '内置引擎（无系统 git 也可用）',
    )
    engBadge.title = isSys
      ? '当前使用系统安装的 git（shell-out），凭据走 GCM / ssh-agent。'
      : '当前使用内置 libgit2（本 R1-B）：认证靠 ssh-agent / env token / 无口令私钥；SSH 首次连陌生 host 会弹一次性信任。'
    engineRow.append(engBadge)
  
    // —— 远端行 ——
    const remoteRow = document.createElement('div')
    remoteRow.className = 'nl-git-sync-row'
    const remoteLabel = document.createElement('span')
    remoteLabel.className = 'nl-git-sync-remote' + (origin ? '' : ' nl-git-muted')
    remoteLabel.textContent = origin ? `${origin.name} · ${origin.url}` : '未配置远端'
    if (origin) remoteLabel.title = origin.url
    const remoteBtn = document.createElement('button')
    remoteBtn.className = 'nl-git-btn nl-git-btn-sm'
    setIcon(remoteBtn, origin ? '' : 'plus', origin ? '改地址' : '添加远端')
    remoteBtn.title = origin ? 'git remote set-url ' + origin.name : 'git remote add origin <url>'
    remoteRow.append(remoteLabel, remoteBtn)
  
    // —— 动作行：Fetch / Pull + 徽标 ——
    const actRow = document.createElement('div')
    actRow.className = 'nl-git-sync-row nl-git-sync-actions'
    const fetchBtn = document.createElement('button')
    fetchBtn.className = 'nl-git-btn'
    setIcon(fetchBtn, 'reload', 'Fetch')
    fetchBtn.title = isSys
      ? 'git fetch --prune（非交互，凭据交系统 git）'
      : '内置 fetch（非交互）：SSH 先试 ssh-agent → 无口令私钥；HTTPS 先试 env token'
    const pullBtn = document.createElement('button')
    pullBtn.className = 'nl-git-btn nl-git-btn-primary'
    setIcon(pullBtn, 'arrow-down', 'Pull（快进）')
    pullBtn.title = '仅快进拉取；分叉不自动合并'
    const pushBtn = document.createElement('button')
    pushBtn.className = 'nl-git-btn'
    setIcon(pushBtn, 'arrow-up', 'Push')
    pushBtn.title = isSys
      ? 'git push（非交互，凭据交系统 git）'
      : '内置 push（非交互）：当前分支 → upstream 同名分支；凭据同 fetch'
    const mergeBtn = document.createElement('button')
    mergeBtn.className = 'nl-git-btn'
    setIcon(mergeBtn, 'branch', 'Pull（合并）')
    mergeBtn.title = isSys
      ? 'git pull（合并方式，非 ff-only）：分叉时产生冲突，可在变更列表逐个解决'
      : '内置合并拉取：分叉时产生冲突，可在变更列表逐个解决'
    const badge = document.createElement('span')
    badge.className = 'nl-git-sync-badge nl-git-muted'
    badge.textContent = origin ? '—' : ''
    actRow.append(fetchBtn, pullBtn, pushBtn, mergeBtn, badge)
  
    // 无远端时禁用 fetch/pull/push，仅引导添加
    fetchBtn.disabled = !origin
    pullBtn.disabled = !origin
    pushBtn.disabled = !origin
    mergeBtn.disabled = !origin
  
    inner.append(engineRow, remoteRow, actRow)
  
    // 已有远端时顺手拉一次领先/落后展示
    if (origin) updateBadge(badge)
  
    // —— 事件 ——
    remoteBtn.addEventListener('click', () => setupRemote(inner, origin))
    fetchBtn.addEventListener('click', () => doFetch(origin, badge))
    pullBtn.addEventListener('click', () => doPull(origin, badge))
    pushBtn.addEventListener('click', () => doPush(origin, badge))
    mergeBtn.addEventListener('click', () => doMergePull(origin, badge))
  }

  // 添加 / 改 origin
  async function setupRemote(inner, origin) {
    if (busy) return
    const vaultRoot = getVaultRoot()
    if (!vaultRoot) return
    const url = await promptDialog({
      title: origin ? `修改 ${origin.name} 地址` : '添加远端 origin',
      placeholder: 'https://… 或 git@…:…/…',
      defaultValue: origin ? origin.url : '',
      confirmLabel: '确定',
    })
    if (url == null || !url.trim()) return
    busy = true
    try {
      if (origin) await gitRRemoteSetUrl(vaultRoot, origin.name, url.trim())
      else await gitRRemoteAdd(vaultRoot, 'origin', url.trim())
      setStatus('远端已保存')
      await populateSync(inner)
    } catch (e) {
      await messageDialog('设置远端失败：' + errText(e))
    } finally {
      busy = false
    }
  }

  // fetch
  async function doFetch(origin, badge) {
    if (busy) return
    const vaultRoot = getVaultRoot()
    if (!vaultRoot) return
    busy = true
    setStatus('抓取远端中…')
    const retry = async () => {
      await gitRFetch(vaultRoot, origin ? origin.name : undefined)
      await updateBadge(badge)
      setStatus('已抓取远端')
    }
    try {
      await retry()
    } catch (e) {
      const t = errText(e)
      setStatus('抓取失败')
      await handleRemoteErr(t, '抓取', retry)
    } finally {
      busy = false
    }
  }

  // 快进 pull（前置：有未提交改动先提醒；成功后回调 main 重扫/索引/当前文档处理）
  const NONFF_RE = /fast-forward|divergent|Not possible to fast-forward|overwritten by merge|Need to specify how to reconcile|Merge is not possible/i
  async function doPull(origin, badge) {
    if (busy) return
    const vaultRoot = getVaultRoot()
    if (!vaultRoot) return
    // 前置提醒：工作树非空可能被快进拒 / 产生冲突
    try {
      const items = await gitStatus(vaultRoot)
      if (items && items.length) {
        const ok = await confirmDialog(
          '有未提交改动，快进可能被拒或产生冲突（冲突处理尚未支持，属后续版本），建议先提交。仍要拉取？',
          '拉取（快进）',
        )
        if (!ok) return
      }
    } catch (_) {
      /* status 读失败不阻断，交由 git 定夺 */
    }
    busy = true
    setStatus('快进拉取中…')
    const retry = async () => {
      await gitRPullFf(vaultRoot)
      setStatus('已快进拉取')
      if (typeof onPullDone === 'function') await onPullDone()
      await updateBadge(badge)
    }
    try {
      await retry()
    } catch (e) {
      const t = errText(e)
      setStatus('拉取失败')
      await handleRemoteErr(t, '拉取', retry)
    } finally {
      busy = false
    }
  }

  // R2：推当前分支→ upstream。无前置确认（推不会覆写本地文件），失败同走 handleRemoteErr（包含 host_unknown 信任重试）。
  async function doPush(origin, badge) {
    if (busy) return
    const vaultRoot = getVaultRoot()
    if (!vaultRoot) return
    busy = true
    setStatus('推送中…')
    const retry = async () => {
      await gitRPush(vaultRoot)
      setStatus('已推送到远端')
      await updateBadge(badge)
    }
    try {
      await retry()
    } catch (e) {
      const t = errText(e)
      setStatus('推送失败')
      await handleRemoteErr(t, '推送', retry)
    } finally {
      busy = false
    }
  }

  // R3：合并拉取（非 ff-only）。成功无冲突→回调 onPullDone；有冲突→refresh 让变更列表出 C 行 + 合并工具条。
  async function doMergePull(origin, badge) {
    if (busy) return
    const vaultRoot = getVaultRoot()
    if (!vaultRoot) return
    try {
      const items = await gitStatus(vaultRoot)
      if (items && items.length) {
        const ok = await confirmDialog(
          '有未提交改动，合并可能失败或加深冲突，建议先提交。仍要合并拉取？',
          '拉取（合并）',
        )
        if (!ok) return
      }
    } catch (_) {
      /* status 读失败不阻断，交由合并定夺 */
    }
    busy = true
    setStatus('合并拉取中…')
    const retry = async () => {
      const r = await gitRPullMerge(vaultRoot)
      const first = (r || '').split('\n')[0].trim()
      if (first === 'CONFLICTS') {
        setStatus('有冲突待解决')
      } else {
        setStatus('已合并拉取')
        if (typeof onPullDone === 'function') await onPullDone()
        await updateBadge(badge)
      }
    }
    try {
      await retry()
    } catch (e) {
      const t = errText(e)
      setStatus('合并拉取失败')
      await handleRemoteErr(t, '合并拉取', retry)
    } finally {
      busy = false
      await refresh()
    }
  }

  // R3：解决单个冲突文件（选边）。busy 串行化，完成后 load() 重渲染。
  async function resolveConf(path, side) {
    if (busy) return
    const vaultRoot = getVaultRoot()
    if (!vaultRoot) return
    busy = true
    try {
      await gitRResolve(vaultRoot, { path, side })
      setStatus('已解决：' + path)
      await load()
    } catch (e) {
      await messageDialog('解决冲突失败：' + errText(e))
    } finally {
      busy = false
    }
  }

  // R3：手动编辑冲突文件（交编辑器解决 <<<<<<< 标记后，回来点「提交合并」）。
  function editConflict(path) {
    if (typeof openFile === 'function') openFile(path)
    else
      messageDialog(
        '请手动打开「' + path + '」解决冲突标记（<<<<<<< / ======= / >>>>>>>），保存后回来点「提交合并」。',
      )
  }

  // R3：提交合并（冲突全解后生成 merge commit）。
  async function doCommitMerge() {
    if (busy) return
    const vaultRoot = getVaultRoot()
    if (!vaultRoot) return
    const message = await promptDialog({
      title: '提交合并',
      placeholder: '合并提交信息',
      defaultValue: 'Merge remote-tracking branch',
      confirmLabel: '提交合并',
    })
    if (!message) return
    busy = true
    try {
      await gitRCommitMerge(vaultRoot, { message })
      setStatus('已提交合并')
      if (typeof onPullDone === 'function') await onPullDone()
      await load()
    } catch (e) {
      await messageDialog('提交合并失败：' + errText(e))
    } finally {
      busy = false
    }
  }

  // R3：中止合并（回到合并前状态）。
  async function doAbortMerge() {
    if (busy) return
    const vaultRoot = getVaultRoot()
    if (!vaultRoot) return
    const ok = await confirmDialog(
      '中止合并会把工作树回退到合并前状态，冲突标记将被清除。确定？',
      '中止合并',
    )
    if (!ok) return
    busy = true
    try {
      await gitRAbortMerge(vaultRoot)
      setStatus('已中止合并')
      if (typeof onPullDone === 'function') await onPullDone()
      await load()
    } catch (e) {
      await messageDialog('中止合并失败：' + errText(e))
    } finally {
      busy = false
    }
  }

  // R3：命令面板共用的合并拉取入口（自行解析 origin；面板空闲时调用）。
  async function mergePullViaCmd() {
    if (busy) return
    const { origin } = await resolveOrigin()
    await doMergePull(origin, document.createElement('span'))
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
      let merging = false
      try {
        merging = await gitRMergeState(vaultRoot)
      } catch (_) {
        merging = false
      }
      renderHead(info, items.length)
      renderBody(items, commits, merging)
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

  // ===== 对外公共入口（命令面板 app.git.* 调用，无 DOM 依赖） =====
  // 自行解析 origin，复用 doFetch/doPull/setupRemote；完成后 refresh() 重渲染面板以同步徽标。
  async function resolveOrigin() {
    const vaultRoot = getVaultRoot()
    if (!vaultRoot) return { vaultRoot, origin: null }
    let remotes = []
    try {
      remotes = (await gitRRemoteList(vaultRoot)) || []
    } catch (_) {
      remotes = []
    }
    return { vaultRoot, origin: remotes.find((r) => r.name === 'origin') || remotes[0] || null }
  }

  async function fetchRemote() {
    if (busy) return
    const { origin } = await resolveOrigin()
    await doFetch(origin, document.createElement('span')) // 游离 badge → updateBadge 自动跳过
    refresh()
  }

  async function pullRemote() {
    if (busy) return
    const { origin } = await resolveOrigin()
    await doPull(origin, document.createElement('span'))
    refresh()
  }

  async function pushRemote() {
    if (busy) return
    const { origin } = await resolveOrigin()
    await doPush(origin, document.createElement('span'))
    refresh()
  }

  async function setupRemoteCmd() {
    if (busy) return
    const { vaultRoot, origin } = await resolveOrigin()
    if (!vaultRoot) return
    const url = await promptDialog({
      title: origin ? `修改 ${origin.name} 地址` : '添加远端 origin',
      placeholder: 'https://… 或 git@…:…/…',
      defaultValue: origin ? origin.url : '',
      confirmLabel: '确定',
    })
    if (url == null || !url.trim()) return
    busy = true
    try {
      if (origin) await gitRRemoteSetUrl(vaultRoot, origin.name, url.trim())
      else await gitRRemoteAdd(vaultRoot, 'origin', url.trim())
      setStatus('远端已保存')
      refresh()
    } catch (e) {
      await messageDialog('设置远端失败：' + errText(e))
    } finally {
      busy = false
    }
  }

  return { refresh, open, commitAll, init, fetch: fetchRemote, pull: pullRemote, push: pushRemote, merge: mergePullViaCmd, setupRemote: setupRemoteCmd }
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

// R3：变更行内的小按钮（阻止冒泡，避免触发行本身的 diff 点击）。
function miniBtn(text, onClick) {
  const b = document.createElement('button')
  b.className = 'nl-git-mini'
  b.textContent = text
  b.addEventListener('click', (ev) => {
    ev.stopPropagation()
    onClick()
  })
  return b
}
