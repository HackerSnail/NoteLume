// tauri-bridge.js —— 封装对 Rust 后端的调用（invoke）与系统对话框
// 参数命名遵循 Tauri v2 约定：Rust 里 snake_case -> JS 里 camelCase。

import { invoke } from '@tauri-apps/api/core'
import { open, save, confirm as dialogConfirm, message as dialogMessage } from '@tauri-apps/plugin-dialog'

/** 打开文件夹选择器，返回选中的知识库根目录（取消返回 null） */
export async function pickFolder() {
  const picked = await open({ directory: true, multiple: false, title: '选择知识库文件夹' })
  return typeof picked === 'string' ? picked : null
}

/** 打开单个 Markdown 文件选择器，返回绝对路径（取消返回 null） */
export async function pickFile() {
  const picked = await open({
    directory: false,
    multiple: false,
    title: '选择 Markdown 文件',
    filters: [{ name: 'Markdown', extensions: ['md', 'markdown'] }],
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
