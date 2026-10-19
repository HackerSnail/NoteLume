// router.mjs —— /api/invoke 的 cmd -> handler 分派
//
// 形状约定：body 是 { cmd, params }，params 原样是 src/tauri-bridge.js 传给 Tauri 的那个对象
// （vaultRoot / path / args 的嵌套层次都不变）。响应一律 200 + { ok, result | error }，
// 不用状态码区分业务失败与传输失败，前端替身据此还原成 Promise。
//
// 三条边界：
//   - 未列出的命令回 [unsupported] + 一句本地化说明（git / docx / 插件 / 整站导出）。
//   - 索引与快照类命令在 kbCommands.mjs，索引表按 sid 隔离（一个后端伺候多个会话）。
//   - VaultError 的 message 已经是给人看的文案，直接回传，不再加前缀。

import { handlers } from './fsCommands.mjs'
import { kbHandlers } from './kbCommands.mjs'
import { docxCommands } from './docxCommands.mjs'
import { msg, setLangFor, applyLang, LANG_LIST } from './uiLang.mjs'
import { defaultVaultRoot, isSafeSid, scratchRoot } from './paths.mjs'

/**
 * 桌面版有、网页沙盒不做的命令（面板与入口藏在 src/web/web.css，菜单项本身不藏）。
 * 访客点到这些命令时回的就是 msg('webUnsupported') 那一句，不带 [code] 前串。
 *
 * 错误上另挂 code：网页版前端（src/web/tauri-core.js）靠它把这句话提示出来。
 * 桌面版的 setStatus 早已从界面去掉（main.js 里只剩 console.debug），Git / 插件的失败在
 * 桌面版走的就是这条路——没有 code，网页版点这些项就是「屏幕上一个反应都没有」。
 * 文案只在 uiLang.mjs 存一份，判定的唯一出处也在这里（前端不再抄一份命令清单）。
 */
export const UNSUPPORTED_CODE = 'desktop-only'

export const UNSUPPORTED = new Set([
  'git_open', 'git_status', 'git_log', 'git_diff_file', 'git_config_identity', 'git_init', 'git_commit_all',
  'git_r_have', 'git_r_info', 'git_r_remote_list', 'git_r_remote_add', 'git_r_remote_set_url', 'git_r_fetch',
  'git_r_upstream', 'git_r_ahead_behind', 'git_r_pull_ff', 'git_r_push', 'git_r_pull_merge',
  'git_r_conflict_files', 'git_r_resolve', 'git_r_merge_state', 'git_r_abort_merge', 'git_r_commit_merge',
  'git_r_trust_host',
  'ensure_temp_import_dir', 'relocate_import', 'export_docx',
  // 注：docx_preview / docx_commit 已改由服务端实现（docxCommands.mjs），让网页沙盒复用桌面整条导入流程，故不在此列。
  'list_plugins', 'read_plugin',
  'build_site_graph', 'copy_vault_assets',
  'set_mac_menu', 'tray_set_recent',
  // 浏览器里设置文档走 localStorage（settings-store.js 的 hasTauri() 回落），后端不存这一份
  'read_settings_json', 'write_settings_json',
  // Rust 侧前端零引用的历史入口
  'copy_image_asset',
])

const EXTRA = {
  // 普通函数而非箭头：需要 this.sid（handlerView 挂上）把语言按访客存，多访客不串
  set_ui_lang: function ({ lang }) {
    setLangFor(this.sid, LANG_LIST.includes(lang) ? lang : 'zh-CN')
    return null
  },
  /** 给前端的 tempDir() 用：main.js 的 ensureScratchDir 会在这里再建 NoteLume/scratch */
  web_scratch_root: function () {
    return scratchRoot(this.sid)
  },
  /** 沙盒模式的默认库（本机模式回 null，前端首屏自己选） */
  web_default_vault: function () {
    return defaultVaultRoot(this.sid)
  },
}

/** 命令总表：fs 与 kb 两张拼一起，handler 之间可以 `this.other_cmd(...)` 互相复用 */
const API = Object.assign(Object.create(handlers), kbHandlers, docxCommands)

/**
 * handler 的 this：本次请求的 sid / jail 挂自身，命令表挂原型链。
 * 直接 fn.call(ctx) 的话 this 里没有命令表，create_md_file 里的 this.write_md_file 就是
 * undefined——网页版点「新建文件」必然 TypeError（这条命令当时没有单测覆盖）。
 */
function handlerView(ctx) {
  return Object.assign(Object.create(API), { sid: ctx.sid, jail: ctx.jail })
}

/**
 * 执行一条命令。ctx = { sid, jail }，jail 为 null 表示本机模式不限制路径。
 * 返回 { ok, result } 或 { ok:false, error }，绝不抛（异常都折成 error 串）。
 */
export function dispatch(ctx, cmd, params) {
  try {
    if (!ctx || !isSafeSid(ctx.sid || '')) throw new Error('bad session id')
    // 生效语言按访客刷一次：本行以下到命令返回全同步，msg() 取的就是这一份，不会被别的请求串改
    applyLang(ctx.sid)
    // 已知不支持：回一句给用户看的完整话术；只有根本没登记的命令才留 [unsupported] 调试前串
    if (UNSUPPORTED.has(cmd)) {
      const e = new Error(msg('webUnsupported'))
      e.code = UNSUPPORTED_CODE
      throw e
    }
    const fn = API[cmd] || EXTRA[cmd]
    if (!fn) throw new Error('[unsupported] ' + cmd)
    const result = fn.call(handlerView(ctx), params || {}, cmd)
    return { ok: true, result: result === undefined ? null : result }
  } catch (e) {
    const text = e && e.message ? String(e.message) : String(e)
    // code 原样带上：前端靠 'desktop-only' 把这句提示提示到屏幕上，其余失败只有文案
    return e && e.code ? { ok: false, error: text, code: String(e.code) } : { ok: false, error: text }
  }
}
