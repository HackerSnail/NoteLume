// tauri-bridge.js —— 封装对 Rust 后端的调用（invoke）与系统对话框
// 参数命名遵循 Tauri v2 约定：Rust 里 snake_case -> JS 里 camelCase。

import { invoke } from '@tauri-apps/api/core'
import { open, save, confirm as dialogConfirm, message as dialogMessage } from '@tauri-apps/plugin-dialog'

/** 打开文件夹选择器，返回选中的知识库根目录（取消返回 null） */
export async function pickFolder() {
  const picked = await open({ directory: true, multiple: false, title: '选择知识库文件夹' })
  return typeof picked === 'string' ? picked : null
}

/** 打开单个文件选择器（Markdown / 画布），返回绝对路径（取消返回 null） */
export async function pickFile() {
  const picked = await open({
    directory: false,
    multiple: false,
    title: '选择 Markdown / 画布文件',
    filters: [{ name: 'Markdown / Canvas', extensions: ['md', 'markdown', 'canvas'] }],
  })
  return typeof picked === 'string' ? picked : null
}

/** 另存为对话框（导出用，P1） */
export async function pickSaveAs(defaultPath) {
  return await save({ defaultPath, title: '保存文件' })
}

/** 原生确认框（Tauri webview 下比 window.confirm 更可靠） */
export async function confirmDialog(message, title) {
  return await dialogConfirm(message, { title: title || 'NoteLume' })
}

/** 原生提示框 */
export async function messageDialog(message, kind) {
  return await dialogMessage(message, { title: 'NoteLume', kind: kind || 'error' })
}

/** 扫描知识库文件树 */
export function scanVault(vaultRoot) {
  return invoke('scan_vault', { vaultRoot })
}

/** 读取库内 md 内容 */
export function readMdFile(vaultRoot, path) {
  return invoke('read_md_file', { vaultRoot, path })
}

/** 写回库内 md 内容 */
export function writeMdFile(vaultRoot, path, content) {
  return invoke('write_md_file', { vaultRoot, path, content })
}

/** 解析 [[wikilink]]：返回 { exists, path } */
export function resolveWikiLink(vaultRoot, refRel, name) {
  return invoke('resolve_wiki_link', { vaultRoot, refRel, name })
}

/** 新建 md 文档：返回库内相对路径 */
export function createMdFile(vaultRoot, path, content) {
  return invoke('create_md_file', { vaultRoot, args: { path, content } })
}

/**
 * 保存剪贴板/拖拽的图片字节到库内 assets/，返回可写入 md 的相对链接。
 * file 为浏览器 File 对象。
 */
export async function saveImageFromFile(vaultRoot, mdRel, file) {
  const dataBase64 = await fileToBase64(file)
  const ext = extFromFile(file)
  return invoke('save_image_bytes', { vaultRoot, mdRel, args: { dataBase64, ext } })
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = String(reader.result)
      // 去掉 data:...;base64, 前缀
      const comma = result.indexOf(',')
      resolve(comma >= 0 ? result.slice(comma + 1) : result)
    }
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(file)
  })
}

function extFromFile(file) {
  const name = file.name || ''
  const dot = name.lastIndexOf('.')
  if (dot > 0 && dot < name.length - 1) return name.slice(dot + 1).toLowerCase()
  // 退化到 mime
  const sub = (file.type || '').split('/')[1] || 'png'
  return sub.replace(/[^a-z0-9]/g, '') || 'png'
}

// ==================== P1 新增：索引 / 双向链接 / 搜索 / 预览 / 备份 / 导出 ====================

/** 触发后台全量重建索引；立即返回，需轮询 getIndexStatus 判断就绪 */
export function rebuildIndex(vaultRoot) {
  return invoke('rebuild_index', { vaultRoot })
}

/** 查询索引状态：{ vaultRoot, docs, ready } */
export function getIndexStatus() {
  return invoke('get_index_status', {})
}

/** 引用当前文档的反向链接列表 */
export function queryBacklinks(path) {
  return invoke('query_backlinks', { path })
}

/** 当前文档指向出去的正向链接列表 */
export function queryOutgoing(path) {
  return invoke('query_outgoing', { path })
}

/** 拿一文档的索引快照（标题/标签/出链/摘要）——供悬浮预览使用 */
export function getDocInfo(path) {
  return invoke('get_doc_info', { path })
}

/** 全局搜索：标题/标签/正文；返回 [{path,title,snippet,matchedBy}] */
export function searchVault(query, limit = 60) {
  return invoke('search_vault', { query, limit })
}

/** 读取一文档前 N 字的纯文本摘要（库内路径校验通过） */
export function docPreview(vaultRoot, path, maxChars = 240) {
  return invoke('doc_preview', { vaultRoot, path, maxChars })
}

/** 保存/新建后增量更新索引中的这条文档 */
export function updateIndexDoc(path, content) {
  return invoke('update_index_doc', { path, content })
}

/** 写入一份带时间戳的库内备份副本，返回相对路径 */
export function backupWrite(vaultRoot, path, content) {
  return invoke('backup_write', { vaultRoot, args: { path, content } })
}

/** 列出某文档的历史备份（可选过滤），P2 版本快照 UI 会用 */
export function listBackups(vaultRoot, docRel) {
  return invoke('list_backups', { vaultRoot, docRel: docRel || null })
}

/** 读取一个快照全文（backupRel 必须位于 .notelume-backup/ 下） */
export function readBackup(vaultRoot, backupRel) {
  return invoke('read_backup', { vaultRoot, backupRel })
}

/** P2：列出 <vault>/.notelume-plugins/ 下的插件文件 [{name, path}] */
export function listPlugins(vaultRoot) {
  return invoke('list_plugins', { vaultRoot })
}

/** P2：读取一个插件源码（pluginRel 必须位于 .notelume-plugins/ 下） */
export function readPlugin(vaultRoot, pluginRel) {
  return invoke('read_plugin', { vaultRoot, pluginRel })
}

/** 读图片字节返回 data: URL（src 相对当前 md 或绝对，限库内） */
export function readImageDataUri(vaultRoot, mdRel, src) {
  return invoke('read_image_data_uri', { vaultRoot, mdRel, src })
}

/** 导出到库外任意路径（由系统保存对话框给出） */
export function exportFile(absPath, content) {
  return invoke('export_file', { args: { absPath, content } })
}

/** P2：知识图谱数据 {nodes:[{path,title}], edges:[{s,t,w}]} */
export function getGraphData(vaultRoot) {
  return invoke('get_graph_data', { vaultRoot })
}
