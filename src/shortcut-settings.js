// shortcut-settings.js —— 批次 D：快捷键设置模态
//
// 分组列出注册表里的可重绑命令（应用 / 编辑器 / 插件），每行「录制 / 解绑 / 重置」。
// 录制捕获一次按键 → 组成逻辑绑定串 → 立即做冲突校验：若与其它命令撞键则「硬阻止」（不写盘、
// 给出占用者提示）；否则写 localStorage['nl-keymap'] 并即时生效（saveOverrides 由 main.js 注入，
// 内部会重算全局分发器 + 热重配编辑器 keymap）。结构性键无法被录成绑定（eventToBinding 返回 null 则继续等待）。
import { formatBinding, eventToBinding, effectiveBindings } from './keymap.js'
import { t } from './i18n.js'

/**
 * @param {object} deps
 * @param {() => Array} deps.getCommands  注册表全部命令（含 id/title/category/defaultKey）
 * @param {() => Object<string,string>} deps.getOverrides  当前覆盖表
 * @param {(overrides:Object<string,string>) => void} deps.saveOverrides  落盘 + 令两层即时生效
 * @param {boolean} deps.isMac
 * @param {(msg:string) => void} deps.setStatus
 * @returns {{ open: () => void, close: () => void }}
 */
export function createShortcutSettings(deps) {
  const { getCommands, getOverrides, saveOverrides, isMac = false, setStatus } = deps
  let overlay = null
  let bodyEl = null
  let recordingId = null

  function titleOf(id) {
    const c = getCommands().find((x) => x.id === id)
    return c ? c.title : id
  }

  // 有效绑定（覆盖 ∪ 默认）：'' 表示用户显式解绑，undefined 走默认
  function bindingOf(id) {
    const ov = getOverrides()
    if (Object.prototype.hasOwnProperty.call(ov, id)) return ov[id]
    const c = getCommands().find((x) => x.id === id)
    return c && c.defaultKey ? c.defaultKey : ''
  }

  // 提交一次改动：binding='' 解绑、null 重置为默认、逻辑串重绑。冲突则硬阻止并提示。
  function commit(id, binding) {
    const ov = { ...getOverrides() }
    if (binding === null) delete ov[id]
    else ov[id] = binding
    const { conflicts } = effectiveBindings(getCommands(), ov, isMac)
    const hit = conflicts.find((c) => c.ids.includes(id))
    if (hit) {
      const others = hit.ids.filter((x) => x !== id).map(titleOf)
      setStatus(t('ks.conflict', { binding: formatBinding(hit.binding, isMac), names: others.join('、') }))
      render()
      return false
    }
    saveOverrides(ov)
    setStatus(t('ks.saved'))
    render()
    return true
  }

  function stopRecording() {
    if (recordingId == null) return
    recordingId = null
    document.removeEventListener('keydown', onCapture, true)
  }

  function onCapture(e) {
    e.preventDefault()
    e.stopPropagation()
    if (e.key === 'Escape') {
      stopRecording()
      render()
      return
    }
    const binding = eventToBinding(e, isMac)
    if (!binding) return // 结构性/无主修饰：继续等待下一次按键
    const id = recordingId
    stopRecording()
    commit(id, binding)
  }

  function startRecording(id) {
    if (recordingId === id) {
      stopRecording()
      render()
      return
    }
    stopRecording()
    recordingId = id
    document.addEventListener('keydown', onCapture, true)
    render()
  }

  function makeRow(cmd) {
    const row = document.createElement('div')
    row.className = 'nl-ks-row'

    const label = document.createElement('span')
    label.className = 'nl-ks-label'
    label.textContent = cmd.title
    row.appendChild(label)

    const key = document.createElement('span')
    key.className = 'nl-ks-key' + (recordingId === cmd.id ? ' recording' : '')
    if (recordingId === cmd.id) key.textContent = t('ks.recording')
    else {
      const b = bindingOf(cmd.id)
      key.textContent = b ? formatBinding(b, isMac) : t('ks.unset')
    }
    row.appendChild(key)

    const recBtn = document.createElement('button')
    recBtn.className = 'nl-ks-btn'
    recBtn.textContent = recordingId === cmd.id ? t('common.cancel') : t('ks.record')
    recBtn.addEventListener('click', () => startRecording(cmd.id))
    row.appendChild(recBtn)

    const ov = getOverrides()
    const cleared = Object.prototype.hasOwnProperty.call(ov, cmd.id) && ov[cmd.id] === ''
    const unBtn = document.createElement('button')
    unBtn.className = 'nl-ks-btn'
    unBtn.textContent = t('ks.unbind')
    unBtn.disabled = !bindingOf(cmd.id)
    unBtn.addEventListener('click', () => commit(cmd.id, ''))
    row.appendChild(unBtn)

    const rstBtn = document.createElement('button')
    rstBtn.className = 'nl-ks-btn'
    rstBtn.textContent = t('ks.reset')
    rstBtn.disabled = !Object.prototype.hasOwnProperty.call(ov, cmd.id) && !cleared
    rstBtn.addEventListener('click', () => commit(cmd.id, null))
    row.appendChild(rstBtn)

    return row
  }

  function render() {
    bodyEl.innerHTML = ''
    const cmds = getCommands()
    for (const cat of ['app', 'editor', 'plugin']) {
      const group = cmds.filter((c) => c.category === cat)
      if (!group.length) continue
      const head = document.createElement('div')
      head.className = 'nl-ks-head'
      head.textContent = t('ks.cat' + cat[0].toUpperCase() + cat.slice(1))
      bodyEl.appendChild(head)
      for (const c of group) bodyEl.appendChild(makeRow(c))
    }
  }

  function buildDom() {
    overlay = document.createElement('div')
    overlay.className = 'nl-prompt-overlay nl-ks-overlay'

    const box = document.createElement('div')
    box.className = 'nl-prompt nl-ks'

    const head = document.createElement('div')
    head.className = 'nl-ks-top'
    const title = document.createElement('div')
    title.className = 'nl-prompt-title'
    title.textContent = t('ks.title')
    const resetAll = document.createElement('button')
    resetAll.className = 'nl-ks-btn'
    resetAll.textContent = t('ks.resetAll')
    resetAll.addEventListener('click', () => {
      stopRecording()
      saveOverrides({})
      setStatus(t('ks.resetAllDone'))
      render()
    })
    const closeBtn = document.createElement('button')
    closeBtn.className = 'nl-ks-btn'
    closeBtn.textContent = t('common.close')
    closeBtn.addEventListener('click', () => close())
    head.append(title, resetAll, closeBtn)

    bodyEl = document.createElement('div')
    bodyEl.className = 'nl-ks-body'

    box.append(head, bodyEl)
    overlay.appendChild(box)
    overlay.addEventListener('pointerdown', (e) => {
      if (e.target === overlay) close()
    })
  }

  function onEsc(e) {
    if (e.key === 'Escape' && recordingId == null) {
      // 录制中时 Esc 只取消录制（onCapture 处理），不关整个模态
      e.preventDefault()
      e.stopPropagation()
      close()
    }
  }

  function open() {
    if (!overlay) buildDom()
    if (overlay.parentNode) return
    document.body.appendChild(overlay)
    render()
    document.addEventListener('keydown', onEsc, true)
  }

  function close() {
    stopRecording()
    document.removeEventListener('keydown', onEsc, true)
    if (overlay && overlay.parentNode) overlay.parentNode.removeChild(overlay)
  }

  return { open, close }
}
