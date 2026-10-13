// snapshot-panel.js —— P2 版本快照 UI：列出当前文档的历史备份、预览全文、一键回滚
// 依赖 P1 地基：backup_write（保存时写快照）、list_backups（列目录）、read_backup（读快照全文）。
// 与主逻辑解耦：编辑器实例、当前状态、渲染/提示等经 deps 注入。
import {
  listBackups,
  readBackup,
  writeMdFile,
  backupWrite,
  updateIndexDoc,
  confirmDialog,
  messageDialog,
} from './tauri-bridge.js'

export function createSnapshotPanel(deps) {
  const {
    listEl,
    modalEl,
    previewEl,
    labelEl,
    metaEl,
    rollbackBtn,
    closeBtn,
    getVaultRoot,
    getCurrentFile,
    editor,
    renderMarkdown,
    escapeHtml,
    setStatus,
    onAfterRollback,
  } = deps

  let pending = null // 当前预览中的快照 { entry, content }

  // name 形如 {stem}-HH-MM-SS.md，day 形如 YYYY-MM-DD → "YYYY-MM-DD HH:MM:SS"
  function formatLabel(entry) {
    const m = entry.name.match(/(\d{2})-(\d{2})-(\d{2})\.md$/)
    const time = m ? `${m[1]}:${m[2]}:${m[3]}` : ''
    return time ? `${entry.day} ${time}` : entry.day
  }

  async function refresh() {
    const vaultRoot = getVaultRoot()
    const file = getCurrentFile()
    listEl.innerHTML = ''
    if (!vaultRoot || !file) {
      listEl.innerHTML = '<div class="link-empty">打开文档后显示历史版本</div>'
      return
    }
    let entries = []
    try {
      entries = await listBackups(vaultRoot, file)
    } catch (e) {
      listEl.innerHTML = '<div class="link-empty">读取历史失败</div>'
      return
    }
    if (!entries.length) {
      listEl.innerHTML =
        '<div class="link-empty">暂无历史备份<br /><span class="muted">保存 / 自动保存后在此累积快照</span></div>'
      return
    }
    entries.forEach((entry) => {
      const row = document.createElement('div')
      row.className = 'snapshot-item'
      row.title = entry.path
      row.innerHTML =
        '<span class="snapshot-item-time">' + escapeHtml(formatLabel(entry)) + '</span>' +
        '<span class="snapshot-item-name">' + escapeHtml(entry.name) + '</span>'
      row.addEventListener('click', () => openPreview(entry))
      listEl.appendChild(row)
    })
  }

  async function openPreview(entry) {
    const vaultRoot = getVaultRoot()
    try {
      const content = await readBackup(vaultRoot, entry.path)
      pending = { entry, content }
      labelEl.textContent = formatLabel(entry)
      metaEl.textContent = '来源：' + entry.path
      previewEl.innerHTML = renderMarkdown(content)
      modalEl.classList.remove('hidden')
      previewEl.scrollTop = 0
    } catch (e) {
      await messageDialog('读取快照失败：' + ((e && e.message) || e))
    }
  }

  function close() {
    modalEl.classList.add('hidden')
    pending = null
    previewEl.innerHTML = ''
  }

  async function doRollback() {
    if (!pending) return
    const { entry, content } = pending
    const vaultRoot = getVaultRoot()
    const file = getCurrentFile()
    const ok = await confirmDialog(
      `确定回滚到 ${formatLabel(entry)} 的快照？\n当前内容将被覆盖（覆盖前会自动另存一份当前版本，可再次回滚恢复）。`,
      '回滚版本',
    )
    if (!ok) return
    try {
      // 先把当前内容备份一份，保证回滚可逆
      try {
        await backupWrite(vaultRoot, file, editor.getMarkdown())
      } catch (_) {
        /* 基线备份失败不阻断回滚 */
      }
      await writeMdFile(vaultRoot, file, content)
      editor.setMarkdown(content)
      editor.markSaved()
      try {
        await updateIndexDoc(file, content)
      } catch (_) {}
      setStatus('已回滚到：' + formatLabel(entry))
      close()
      if (onAfterRollback) onAfterRollback()
      refresh()
    } catch (e) {
      await messageDialog('回滚失败：' + ((e && e.message) || e))
    }
  }

  // —— 一次性接线 ——
  rollbackBtn.addEventListener('click', doRollback)
  closeBtn.addEventListener('click', close)
  modalEl.addEventListener('mousedown', (e) => {
    if (e.target === modalEl) close()
  })
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !modalEl.classList.contains('hidden')) close()
  })

  return { refresh }
}
