// tauri-dialog.js —— @tauri-apps/plugin-dialog 的网页替身
//
// tauri-bridge.js 顶层 import { open, save, confirm as dialogConfirm, message as dialogMessage }，
// 这里给出同名导出，形状对齐 Tauri 的返回约定（§4）：
//   - open({directory:true})            → 选目录，回字符串路径；取消回 null
//   - open({directory:false})           → 选文件，回字符串路径；multiple:true 回字符串数组；取消回 null / []
//   - save({defaultPath})               → 选目录 + 填文件名，回字符串路径；取消回 null
//   - confirm(msg, {title})             → window.confirm（桌面这里只用于是/否）
//   - message(msg, {title, kind})      → window.alert（错误 / 提示）
// 目录浏览的真实数据来自后端 /api/browse，由 path-picker.js 画出来。
// 注意：bridge 的 dialogConfirm / dialogMessage 在无桌面环境里直接调 window.*，不会走到这里的
// confirm / message（open / save 才会走），所以这两个导出只是给「直接 import plugin-dialog」的调用点兜底。

import { pickPath } from './path-picker.js'

export async function open(opts = {}) {
  const directory = !!opts.directory
  const mode = directory ? 'dir' : 'file'
  const val = await pickPath({ mode, multiple: !!opts.multiple, title: opts.title || '' })
  if (val == null) return directory ? null : opts.multiple ? [] : null
  return val
}

export async function save(opts = {}) {
  const val = await pickPath({ mode: 'save', title: opts.title || '', startPath: opts.defaultPath || '' })
  return val == null ? null : val
}

export async function confirm(message, opts = {}) {
  const prefix = opts.title ? opts.title + '\n\n' : ''
  return window.confirm(prefix + message)
}

export async function message(message, opts = {}) {
  const prefix = opts.title ? opts.title + '\n\n' : ''
  window.alert(prefix + message)
  return true
}

// ask 是 confirm 的别名（部分 Tauri 版本提供），一并给出以防调用点用到。
export async function ask(message, opts = {}) {
  return confirm(message, opts)
}
