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
import { t } from './i18n.js'

// kind → 徽标字符（对齐 Rust classify_status 的取值域）；中文短名走词条 git.kind.<kind>
const KIND_BADGE = {
  modified: 'M',
  new: 'N',
  deleted: 'D',
  renamed: 'R',
  untracked: '?',
  conflicted: 'C',
  ignored: '·',
}

const kindLabel = (kind) => t('git.kind.' + kind)

// Unix 秒 → 相对时间（近则分钟/小时，远则日期）
function relTime(sec) {
  const then = sec * 1000
  const diff = Date.now() - then
  const min = Math.floor(diff / 60000)
  if (min < 1) return t('git.time.justNow')
  if (min < 60) return t('git.time.minAgo', { min })
  const hr = Math.floor(min / 60)
  if (hr < 24) return t('git.time.hourAgo', { hr })
  const day = Math.floor(hr / 24)
  if (day < 30) return t('git.time.dayAgo', { day })
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
      tip.textContent = t('git.noRepo')
      const btn = document.createElement('button')
      btn.className = 'nl-git-btn'
      btn.textContent = t('git.initBtn')
      btn.title = t('git.initTip')
      btn.addEventListener('click', () => init())
      const actions = document.createElement('span')
      actions.className = 'nl-git-actions'
      actions.appendChild(btn)
      head.append(tip, actions)
      return
    }

    const left = document.createElement('span')
    left.className = 'nl-git-branch'
    const branch = info.branch || (info.hasHead ? t('git.detachedHead') : t('git.noHead'))
    setIcon(left, 'branch', branch)
    left.title = curRepoPath || ''

    const count = document.createElement('span')
    count.className = 'nl-git-count'
    count.textContent = changeCount > 0 ? t('git.changesCount', { n: changeCount }) : t('git.cleanTree')

    const actions = document.createElement('span')
    actions.className = 'nl-git-actions'
    const refreshBtn = document.createElement('button')
    refreshBtn.className = 'nl-git-btn'
    setIcon(refreshBtn, 'reload')
    refreshBtn.title = t('git.refreshTip')
    refreshBtn.addEventListener('click', () => refresh())
    const commitBtn = document.createElement('button')
    commitBtn.className = 'nl-git-btn nl-git-btn-primary'
    commitBtn.textContent = t('git.commitAllBtn')
    commitBtn.title = t('git.commitAllTip')
    commitBtn.disabled = changeCount === 0
    commitBtn.addEventListener('click', () => commitAll())
    actions.append(refreshBtn, commitBtn)

    head.append(left, count, actions)
  }

  // —— 折叠分组（VS Code 源代码管理式）：标题行点击开合，状态持久化 nl-git-fold.<key> ——
  function foldSec(key, titleText, badgeText) {
    const sec = document.createElement('div')
    sec.className = 'nl-git-section nl-git-fold'
    const bar = document.createElement('div')
    bar.className = 'nl-git-fold-bar'
    const chev = document.createElement('span')
    chev.className = 'nl-git-fold-chev'
    setIcon(chev, 'chevron-down')
    const ttl = document.createElement('span')
    ttl.className = 'nl-git-fold-title'
    ttl.textContent = titleText
    bar.append(chev, ttl)
    if (badgeText != null && badgeText !== '') {
      const b = document.createElement('span')
      b.className = 'nl-git-fold-badge'
      b.textContent = badgeText
      bar.appendChild(b)
    }
    const wrap = document.createElement('div')
    wrap.className = 'nl-git-fold-body'
    const apply = () => {
      const c = localStorage.getItem('nl-git-fold.' + key) === '1'
      sec.classList.toggle('collapsed', c)
      wrap.classList.toggle('hidden', c)
    }
    bar.addEventListener('click', () => {
      localStorage.setItem('nl-git-fold.' + key, localStorage.getItem('nl-git-fold.' + key) === '1' ? '0' : '1')
      apply()
    })
    apply()
    sec.append(bar, wrap)
    return { sec, body: wrap }
  }

  // —— Changes 区 ——
  function renderChanges(items) {
    const f = foldSec('changes', t('git.sectionChanges'), items.length ? String(items.length) : '')
    const list = document.createElement('div')
    list.className = 'nl-git-list'
    if (!items.length) {
      list.innerHTML = '<div class="nl-git-empty-inline">' + t('git.noChanges') + '</div>'
    } else {
      items.forEach((it) => {
        const badge = KIND_BADGE[it.kind] || '•'
        const label = kindLabel(it.kind) || it.kind
        const conflicted = it.kind === 'conflicted'
        const row = document.createElement('div')
        row.className = 'nl-git-item' + (conflicted ? ' nl-git-conflict' : '')
        row.title = it.path + (it.staged ? t('git.staged') : '')
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
            miniBtn(t('git.useOurs'), () => resolveConf(it.path, 'ours')),
            miniBtn(t('git.useTheirs'), () => resolveConf(it.path, 'theirs')),
            miniBtn(t('git.edit'), () => editConflict(it.path)),
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
        more.textContent = t('git.tooManyChanges', { n: 1000 })
        list.appendChild(more)
      }
    }
    f.body.appendChild(list)
    return f.sec
  }

  // —— Graph 区：提交图（lane 分配 + 逐行 SVG 连线，合并分叉可见），点击行看提交详情 ——
  const GW = 14 // 每条 lane 的水平宽度
  function renderGraph(commits, branch) {
    const f = foldSec('graph', t('git.sectionGraph'), commits.length ? String(commits.length) : '')
    if (!commits.length) {
      f.body.innerHTML = '<div class="nl-git-empty-inline">' + t('git.historyEmpty') + '</div>'
      return f.sec
    }
    const list = document.createElement('div')
    list.className = 'nl-git-list nl-git-graph'
    // lane 分配：lanes[i] = 该 lane 顶端待接的 oid。第一个 parent 继承本 lane，
    // 其余 parent（合并提交）各占一个已有/新开 lane；没有 parent 则本 lane 置空（到头）。
    const rows = []
    let lanes = []
    for (const c of commits) {
      let idx = lanes.indexOf(c.id)
      if (idx < 0) {
        idx = lanes.indexOf(null)
        if (idx < 0) {
          lanes.push(null)
          idx = lanes.length - 1
        }
      }
      const lanesIn = lanes.slice()
      lanes[idx] = c.parents.length ? c.parents[0] : null
      for (const p of c.parents.slice(1)) {
        let pi = lanes.indexOf(p)
        if (pi < 0) {
          pi = lanes.indexOf(null)
          if (pi < 0) {
            lanes.push(p)
            pi = lanes.length - 1
          } else lanes[pi] = p
        }
      }
      rows.push({ c, lane: idx, lanesIn, lanesOut: lanes.slice() })
    }
    const headId = commits[0].id
    let prevOut = null
    for (const { c, lane, lanesIn, lanesOut } of rows) {
      const nLane = Math.max(lanesIn.length, lanesOut.length, lane + 1)
      const x = (i) => i * GW + GW / 2
      const cx = x(lane)
      const line = (x1, y1, x2, y2, cls) =>
        '<line x1="' + x1 + '" y1="' + y1 + '" x2="' + x2 + '" y2="' + y2 + '" class="' + cls + '"/>'
      let s = ''
      // 上半（0→12）：上一行的每条活动 lane 连到本行对应位置；被本提交取走的 lane 收到节点
      if (prevOut) {
        for (let i = 0; i < prevOut.length; i++) {
          const oid = prevOut[i]
          if (!oid) continue
          let xb = null
          if (oid === c.id) xb = cx
          else {
            const j = lanesIn.indexOf(oid)
            if (j >= 0) xb = x(j)
          }
          if (xb == null) continue
          s += line(x(i), 0, xb, 12, i === 0 ? 'nl-git-lane-main' : 'nl-git-lane')
        }
      }
      // 下半（12→24）：非本提交占用的 lane 竖直下探
      for (let i = 0; i < lanesIn.length; i++) {
        const oid = lanesIn[i]
        if (!oid || oid === c.id) continue
        s += line(x(i), 12, x(i), 24, i === 0 ? 'nl-git-lane-main' : 'nl-git-lane')
      }
      // 下半：节点 → 各 parent 的出口 lane（主 parent 继承本 lane，合并 parent 斜入侧 lane）
      for (let pi = 0; pi < c.parents.length; pi++) {
        const j = lanesOut.indexOf(c.parents[pi])
        if (j < 0) continue
        s += line(cx, 12, x(j), 24, pi === 0 && lane === 0 ? 'nl-git-lane-main' : 'nl-git-lane')
      }
      // 节点（HEAD 描边外圈）
      s += c.id === headId
        ? '<circle cx="' + cx + '" cy="12" r="5.5" class="nl-git-node-head"/><circle cx="' + cx + '" cy="12" r="2.5" class="nl-git-node-core"/>'
        : '<circle cx="' + cx + '" cy="12" r="3.5" class="nl-git-node"/>'
      const row = document.createElement('div')
      row.className = 'nl-git-item nl-git-commit'
      row.title = c.summary + '\n' + c.authorName + ' · ' + relTime(c.time)
      const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
      svg.setAttribute('class', 'nl-git-gsvg')
      svg.setAttribute('width', String(nLane * GW))
      svg.setAttribute('height', '24')
      svg.innerHTML = s
      const sum = document.createElement('span')
      sum.className = 'nl-git-summary'
      sum.textContent = c.summary
      const author = document.createElement('span')
      author.className = 'nl-git-meta'
      author.textContent = c.authorName
      row.append(svg, sum, author)
      if (c.id === headId && branch) {
        const pill = document.createElement('span')
        pill.className = 'nl-git-branch-pill'
        pill.textContent = branch
        row.appendChild(pill)
      }
      row.addEventListener('click', () => showCommit(c))
      list.appendChild(row)
      prevOut = lanesOut
    }
    f.body.appendChild(list)
    return f.sec
  }

  // —— diff / 详情预览区（复用一块，切换内容）——
  const diffBox = document.createElement('div')
  diffBox.className = 'nl-git-diff hidden'
  function showDiffInBox(headText, diffHtml) {
    diffBox.classList.remove('hidden')
    diffBox.innerHTML =
      '<div class="nl-git-diff-head"><span>' +
      escapeHtml(headText) +
      '</span><button class="nl-git-diff-close" title="' + t('common.close') + '">' + iconHTML('close') + '</button></div>' +
      diffHtml
    const close = diffBox.querySelector('.nl-git-diff-close')
    close.addEventListener('click', () => diffBox.classList.add('hidden'))
  }

  // 按行前缀着色：+ 新增 / - 删除 / @@ 块头 / diff 头
  function colorizeDiff(text) {
    if (!text) return '<div class="nl-git-empty-inline">' + t('git.noDiff') + '</div>'
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
      await messageDialog(t('git.diffReadFailed', { err: errText(e) }))
    }
  }

  // History 点击：展示提交详情（作者/时间/完整 summary）。命令面未含"列某提交改动文件"，
  // 故此处只做详情展示；文件级 diff 由「变更」区承担（工作树 vs HEAD）。
  function showCommit(c) {
    const detail =
      '<div class="nl-git-commit-detail">' +
      '<div class="nl-git-detail-row"><span class="nl-git-detail-k">' + t('git.detailCommit') + '</span><span class="nl-git-detail-v mono">' +
      escapeHtml(c.id) +
      '</span></div>' +
      '<div class="nl-git-detail-row"><span class="nl-git-detail-k">' + t('git.detailSummary') + '</span><span class="nl-git-detail-v">' +
      escapeHtml(c.summary || t('git.detailNoSummary')) +
      '</span></div>' +
      '<div class="nl-git-detail-row"><span class="nl-git-detail-k">' + t('git.detailAuthor') + '</span><span class="nl-git-detail-v">' +
      escapeHtml(c.authorName) +
      ' &lt;' +
      escapeHtml(c.authorEmail) +
      '&gt;</span></div>' +
      '<div class="nl-git-detail-row"><span class="nl-git-detail-k">' + t('git.detailTime') + '</span><span class="nl-git-detail-v">' +
      escapeHtml(relTime(c.time)) +
      '</span></div>' +
      '</div>'
    showDiffInBox(t('git.commitTitle', { id: c.idShort }), detail)
  }

  function renderBody(items, commits, merging, branch) {
    body.innerHTML = ''
    const sync = buildSyncSection()
    const parts = []
    if (merging) parts.push(renderMergeBar(items))
    parts.push(renderChanges(items), renderGraph(commits, branch), sync.sec, diffBox)
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
      ? t('git.mergeOngoing', { n: conflictCount })
      : t('git.mergeResolved')
    const actions = document.createElement('span')
    actions.className = 'nl-git-actions'
    const okBtn = document.createElement('button')
    okBtn.className = 'nl-git-btn nl-git-btn-primary'
    setIcon(okBtn, 'check', t('git.mergeCommitBtn'))
    okBtn.disabled = conflictCount > 0
    okBtn.title = conflictCount > 0 ? t('git.mergeResolveFirst') : t('git.mergeCommitTip')
    okBtn.addEventListener('click', () => doCommitMerge())
    const abortBtn = document.createElement('button')
    abortBtn.className = 'nl-git-btn'
    setIcon(abortBtn, 'close', t('git.mergeAbortBtn'))
    abortBtn.title = t('git.mergeAbortTip')
    abortBtn.addEventListener('click', () => doAbortMerge())
    actions.append(okBtn, abortBtn)
    sec.append(msg, actions)
    return sec
  }

  // ===== R1：同步区 =====
  // buildSyncSection 同步搭一个占位容器，populateSync 异步按「系统 git / 远端 / 领先落后」填充。
  function buildSyncSection() {
    const f = foldSec('sync', t('git.sectionSync'), '')
    const inner = document.createElement('div')
    inner.className = 'nl-git-sync'
    inner.innerHTML = '<div class="nl-git-empty-inline">' + t('git.syncProbing') + '</div>'
    f.body.appendChild(inner)
    return { sec: f.sec, inner }
  }

  // 凭据类错误的一句通用引导（命中关键字则附）
  function credHint(raw) {
    if (/terminal prompts disabled|could not read|Authentication|permission denied|invalid username|password|ssh|BatchMode/i.test(raw)) {
      return t('git.credHint')
    }
    return ''
  }

  // Phase 4：拆解 `[code]body` 前串。System 引擎旧格式无 → code=null（回关键字判定）。
  // [host_unknown]<json> 额外 JSON.parse body → payload（前端一次性信任弹框需）。
  function parseErrCode(raw) {
    const m = /^\[([a-z_]+)\]([\s\S]*)$/.exec(raw || '')
    if (!m) return { code: null, body: raw || '', payload: null }
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
  async function handleRemoteErr(raw, opName, retryFn) {
    const { code, body, payload } = parseErrCode(raw)
    if (code === 'host_unknown' && payload && payload.host) {
      let msg = t('git.hostUnknownHead', {
        host: payload.host,
        keyType: payload.keyType || t('git.unknownErr'),
      })
      if (payload.fingerprint) msg += '\n' + t('git.hostFingerprint', { fingerprint: payload.fingerprint })
      msg += t('git.hostUnknownTail')
      const ok = await confirmDialog(msg, t('git.trustHost'))
      if (!ok) {
        await messageDialog(t('git.canceledOp', { op: opName, body }))
        return
      }
      try {
        await gitRTrustHost({
          host: payload.host,
          keyType: payload.keyType,
          keyB64: payload.keyB64,
        })
      } catch (e) {
        await messageDialog(t('git.knownHostsWriteFailed', { err: errText(e) }))
        return
      }
      try {
        if (typeof retryFn === 'function') await retryFn()
      } catch (e2) {
        const raw2 = errText(e2)
        await messageDialog(t('git.opStillFailed', { op: opName, err: raw2, hint: credHint(raw2) }))
      }
      return
    }
    if (code === 'non_fast_forward' || (!code && NONFF_RE.test(raw))) {
      await messageDialog(
        t('git.nonFfMsg', { op: opName, body: body || raw }),
      )
      return
    }
    if (code === 'local_changes') {
      await messageDialog(t('git.localChangesMsg', { body }))
      return
    }
    if (code === 'no_upstream') {
      await messageDialog(
        t('git.noUpstreamMsg', { body: body || raw }),
      )
      return
    }
    if (code === 'hostkey_mismatch') {
      await messageDialog(
        t('git.hostKeyMismatch', { body }),
      )
      return
    }
    if (code === 'network') {
      await messageDialog(t('git.networkMsg', { body }))
      return
    }
    await messageDialog(t('git.opFailed', { op: opName, err: raw, hint: credHint(raw) }))
  }

  // 刷新领先/落后徽标（fetch / pull 后调用）
  async function updateBadge(badge) {
    const vaultRoot = getVaultRoot()
    if (!vaultRoot || !badge || !badge.isConnected) return
    try {
      const ab = await gitRAheadBehind(vaultRoot)
      if (!ab) {
        badge.textContent = t('git.noUpstream')
        badge.className = 'nl-git-sync-badge nl-git-muted'
      } else {
        setIcon(badge, ab.behind > 0 ? 'arrow-down' : 'arrow-up', t('git.aheadBehind', { ahead: ab.ahead, behind: ab.behind }))
        badge.className =
          'nl-git-sync-badge' + (ab.behind > 0 ? ' nl-git-sync-behind' : '')
        badge.title = t('git.upstream', { name: ab.upstream })
      }
    } catch (_) {
      badge.textContent = ''
    }
  }

  // 实际填充同步区控件：引擎徽标 + 远端行 + Fetch/Pull + 徽标。按钮动作复用面板 busy 串行化。
  async function populateSync(inner) {
    const vaultRoot = getVaultRoot()
    if (!vaultRoot) {
      inner.innerHTML = '<div class="nl-git-empty-inline">' + t('git.needVault') + '</div>'
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
        '<div class="nl-git-empty-inline">' + t('git.syncUnavailable') + '</div>'
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
      isSys ? t('git.engineSystem', { version: info.gitVersion || '' }) : t('git.engineBuiltin'),
    )
    engBadge.title = isSys
      ? t('git.engineSystemTip')
      : t('git.engineBuiltinTip')
    engineRow.append(engBadge)

    // —— 远端行 ——
    const remoteRow = document.createElement('div')
    remoteRow.className = 'nl-git-sync-row'
    const remoteLabel = document.createElement('span')
    remoteLabel.className = 'nl-git-sync-remote' + (origin ? '' : ' nl-git-muted')
    remoteLabel.textContent = origin ? `${origin.name} · ${origin.url}` : t('git.noRemote')
    if (origin) remoteLabel.title = origin.url
    const remoteBtn = document.createElement('button')
    remoteBtn.className = 'nl-git-btn nl-git-btn-sm'
    setIcon(remoteBtn, origin ? '' : 'plus', origin ? t('git.remoteEdit') : t('git.remoteAdd'))
    remoteBtn.title = origin ? t('git.remoteSetUrlTip', { name: origin.name }) : t('git.remoteAddTip')
    remoteRow.append(remoteLabel, remoteBtn)

    // —— 动作行：Fetch / Pull + 徽标 ——
    const actRow = document.createElement('div')
    actRow.className = 'nl-git-sync-row nl-git-sync-actions'
    const fetchBtn = document.createElement('button')
    fetchBtn.className = 'nl-git-btn'
    setIcon(fetchBtn, 'reload', t('git.btnFetch'))
    fetchBtn.title = isSys
      ? t('git.fetchTipSys')
      : t('git.fetchTipBuiltin')
    const pullBtn = document.createElement('button')
    pullBtn.className = 'nl-git-btn nl-git-btn-primary'
    setIcon(pullBtn, 'arrow-down', t('git.btnPullFf'))
    pullBtn.title = t('git.pullFfTip')
    const pushBtn = document.createElement('button')
    pushBtn.className = 'nl-git-btn'
    setIcon(pushBtn, 'arrow-up', t('git.btnPush'))
    pushBtn.title = isSys
      ? t('git.pushTipSys')
      : t('git.pushTipBuiltin')
    const mergeBtn = document.createElement('button')
    mergeBtn.className = 'nl-git-btn'
    setIcon(mergeBtn, 'branch', t('git.btnPullMerge'))
    mergeBtn.title = isSys
      ? t('git.mergeTipSys')
      : t('git.mergeTipBuiltin')
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
      title: origin ? t('git.remoteEditTitle', { name: origin.name }) : t('git.remoteAddTitle'),
      placeholder: t('git.remoteUrlPh'),
      defaultValue: origin ? origin.url : '',
      confirmLabel: t('common.confirm'),
    })
    if (url == null || !url.trim()) return
    busy = true
    try {
      if (origin) await gitRRemoteSetUrl(vaultRoot, origin.name, url.trim())
      else await gitRRemoteAdd(vaultRoot, 'origin', url.trim())
      setStatus(t('git.remoteSaved'))
      await populateSync(inner)
    } catch (e) {
      await messageDialog(t('git.remoteSetFailed', { err: errText(e) }))
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
    setStatus(t('git.fetching'))
    const retry = async () => {
      await gitRFetch(vaultRoot, origin ? origin.name : undefined)
      await updateBadge(badge)
      setStatus(t('git.fetched'))
    }
    try {
      await retry()
    } catch (e) {
      const raw = errText(e)
      setStatus(t('git.fetchFailed'))
      await handleRemoteErr(raw, t('git.opFetch'), retry)
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
          t('git.pullConfirm'),
          t('git.btnPullFf'),
        )
        if (!ok) return
      }
    } catch (_) {
      /* status 读失败不阻断，交由 git 定夺 */
    }
    busy = true
    setStatus(t('git.pulling'))
    const retry = async () => {
      await gitRPullFf(vaultRoot)
      setStatus(t('git.pulled'))
      if (typeof onPullDone === 'function') await onPullDone()
      await updateBadge(badge)
    }
    try {
      await retry()
    } catch (e) {
      const raw = errText(e)
      setStatus(t('git.pullFailed'))
      await handleRemoteErr(raw, t('git.opPull'), retry)
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
    setStatus(t('git.pushing'))
    const retry = async () => {
      await gitRPush(vaultRoot)
      setStatus(t('git.pushed'))
      await updateBadge(badge)
    }
    try {
      await retry()
    } catch (e) {
      const raw = errText(e)
      setStatus(t('git.pushFailed'))
      await handleRemoteErr(raw, t('git.opPush'), retry)
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
          t('git.mergePullConfirm'),
          t('git.btnPullMerge'),
        )
        if (!ok) return
      }
    } catch (_) {
      /* status 读失败不阻断，交由合并定夺 */
    }
    busy = true
    setStatus(t('git.merging'))
    const retry = async () => {
      const r = await gitRPullMerge(vaultRoot)
      const first = (r || '').split('\n')[0].trim()
      if (first === 'CONFLICTS') {
        setStatus(t('git.conflictsPending'))
      } else {
        setStatus(t('git.merged'))
        if (typeof onPullDone === 'function') await onPullDone()
        await updateBadge(badge)
      }
    }
    try {
      await retry()
    } catch (e) {
      const raw = errText(e)
      setStatus(t('git.mergeFailed'))
      await handleRemoteErr(raw, t('git.opMerge'), retry)
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
      setStatus(t('git.resolved', { path }))
      await load()
    } catch (e) {
      await messageDialog(t('git.resolveFailed', { err: errText(e) }))
    } finally {
      busy = false
    }
  }

  // R3：手动编辑冲突文件（交编辑器解决 <<<<<<< 标记后，回来点「提交合并」）。
  function editConflict(path) {
    if (typeof openFile === 'function') openFile(path)
    else
      messageDialog(
        t('git.editConflictMsg', { path }),
      )
  }

  // R3：提交合并（冲突全解后生成 merge commit）。
  async function doCommitMerge() {
    if (busy) return
    const vaultRoot = getVaultRoot()
    if (!vaultRoot) return
    const message = await promptDialog({
      title: t('git.mergeCommitTitle'),
      placeholder: t('git.mergeCommitPh'),
      defaultValue: 'Merge remote-tracking branch',
      confirmLabel: t('git.mergeCommitBtn'),
    })
    if (!message) return
    busy = true
    try {
      await gitRCommitMerge(vaultRoot, { message })
      setStatus(t('git.mergeCommitted'))
      if (typeof onPullDone === 'function') await onPullDone()
      await load()
    } catch (e) {
      await messageDialog(t('git.mergeCommitFailed', { err: errText(e) }))
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
      t('git.abortConfirm'),
      t('git.mergeAbortBtn'),
    )
    if (!ok) return
    busy = true
    try {
      await gitRAbortMerge(vaultRoot)
      setStatus(t('git.mergeAborted'))
      if (typeof onPullDone === 'function') await onPullDone()
      await load()
    } catch (e) {
      await messageDialog(t('git.mergeAbortFailed', { err: errText(e) }))
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
      renderPlaceholder(t('git.needVaultShow'))
      return
    }
    try {
      const info = await gitOpen(vaultRoot)
      curRepoPath = info.repoPath || null
      if (!info.isRepo) {
        renderHead(info, 0)
        body.innerHTML = ''
        body.appendChild(
          el('div', 'nl-git-empty', t('git.notRepoHint')),
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
      renderBody(items, commits, merging, info.branch || '')
    } catch (e) {
      renderPlaceholder(escapeHtml(t('git.statusReadFailed', { err: errText(e) })))
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
      title: t('git.commitAllTitle'),
      placeholder: t('git.commitPh'),
      confirmLabel: t('git.commitBtn'),
    })
    if (!message) return // 取消

    busy = true
    try {
      // 身份：先读配置；缺失则问一次（name/email 一并传给 commit，Rust 侧回写本地配置）
      let name = null
      let email = null
      const id = await gitConfigIdentity(vaultRoot)
      if (!id) {
        name = await promptDialog({ title: t('git.identityName'), placeholder: 'user.name', confirmLabel: t('git.nextStep') })
        if (name == null) return
        email = await promptDialog({ title: t('git.identityEmail'), placeholder: 'user@email.com', confirmLabel: t('git.commitBtn') })
        if (email == null) return
      }
      const res = await gitCommitAll(vaultRoot, message, name, email)
      setStatus(t('git.committed', { id: res.idShort }))
      await load()
    } catch (e) {
      await messageDialog(t('git.commitFailed', { err: errText(e) }))
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
      setStatus(t('git.initialized'))
      await load()
    } catch (e) {
      await messageDialog(t('git.initFailed', { err: errText(e) }))
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
      title: origin ? t('git.remoteEditTitle', { name: origin.name }) : t('git.remoteAddTitle'),
      placeholder: t('git.remoteUrlPh'),
      defaultValue: origin ? origin.url : '',
      confirmLabel: t('common.confirm'),
    })
    if (url == null || !url.trim()) return
    busy = true
    try {
      if (origin) await gitRRemoteSetUrl(vaultRoot, origin.name, url.trim())
      else await gitRRemoteAdd(vaultRoot, 'origin', url.trim())
      setStatus(t('git.remoteSaved'))
      refresh()
    } catch (e) {
      await messageDialog(t('git.remoteSetFailed', { err: errText(e) }))
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
  return (e && (e.message || e)) || t('common.unknownErr')
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
