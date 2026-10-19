// router.mjs —— /api/invoke 的 cmd -> handler 分派
//
// 形状约定：body 是 { cmd, params }，params 原样是 src/tauri-bridge.js 传给 Tauri 的那个对象
// （vaultRoot / path / args 的嵌套层次都不变）。响应一律 200 + { ok, result | error }，
// 不用状态码区分业务失败与传输失败，前端替身据此还原成 Promise。
//
// 三条边界：
//   - 未列出的命令回 [unsupported] + 一句本地化说明（git / docx / 插件 / 整站导出）。
//   - 索引类命令本轮给空表与 ready:true，形状与 Rust 一致，侧栏面板显示「没有结果」而不是报错。
//   - VaultError 的 message 已经是给人看的文案，直接回传，不再加前缀。

import { handlers } from './fsCommands.mjs'
import { msg, setLang, LANG_LIST } from './uiLang.mjs'
import { defaultVaultRoot, isSafeSid, scratchRoot } from './paths.mjs'

/** 桌面版有、网页沙盒不做的命令（前端同时在命令注册表里拦掉，见 src/web/commandsGuard.js） */
export const UNSUPPORTED = new Set([
  'git_open', 'git_status', 'git_log', 'git_diff_file', 'git_config_identity', 'git_init', 'git_commit_all',
  'git_r_have', 'git_r_info', 'git_r_remote_list', 'git_r_remote_add', 'git_r_remote_set_url', 'git_r_fetch',
  'git_r_upstream', 'git_r_ahead_behind', 'git_r_pull_ff', 'git_r_push', 'git_r_pull_merge',
  'git_r_conflict_files', 'git_r_resolve', 'git_r_merge_state', 'git_r_abort_merge', 'git_r_commit_merge',
  'git_r_trust_host',
  'docx_preview', 'docx_commit', 'ensure_temp_import_dir', 'relocate_import', 'export_docx',
  'list_plugins', 'read_plugin',
  'build_site_graph', 'copy_vault_assets',
  'set_mac_menu', 'tray_set_recent',
  // 浏览器里设置文档走 localStorage（settings-store.js 的 hasTauri() 回落），后端不存这一份
  'read_settings_json', 'write_settings_json',
  // Rust 侧前端零引用的历史入口
  'copy_image_asset',
])

/**
 * 索引类命令的空实现。返回形状照 lib.rs，docs 为 0、ready 为真：
 * 前端 rebuildIndex 之后轮询 getIndexStatus，看到 ready 就把面板当「已就绪但没有数据」。
 */
const EMPTY_INDEX = {
  rebuild_index: (p) => undefined,
  get_index_status: (p) => ({ vaultRoot: (p && p.vaultRoot) || null, docs: 0, ready: true }),
  update_index_doc: () => undefined,
  remove_index_doc: () => undefined,
  query_backlinks: () => [],
  query_outgoing: () => [],
  query_tag: () => [],
  list_all_tags: () => [],
  search_vault: () => [],
  get_graph_data: () => ({ nodes: [], edges: [] }),
  get_doc_info: () => null,
  doc_preview: () => '',
  list_backups: () => [],
}

const EXTRA = {
  set_ui_lang: ({ lang }) => {
    setLang(LANG_LIST.includes(lang) ? lang : 'zh-CN')
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

/**
 * 执行一条命令。ctx = { sid, jail }，jail 为 null 表示本机模式不限制路径。
 * 返回 { ok, result } 或 { ok:false, error }，绝不抛（异常都折成 error 串）。
 */
export function dispatch(ctx, cmd, params) {
  try {
    if (!ctx || !isSafeSid(ctx.sid || '')) throw new Error('bad session id')
    if (UNSUPPORTED.has(cmd)) throw new Error('[unsupported] ' + msg('webUnsupported'))
    const fn = handlers[cmd] || EXTRA[cmd] || EMPTY_INDEX[cmd]
    if (!fn) throw new Error('[unsupported] ' + cmd)
    const result = fn.call(ctx, params || {}, cmd)
    return { ok: true, result: result === undefined ? null : result }
  } catch (e) {
    const text = e && e.message ? String(e.message) : String(e)
    return { ok: false, error: text }
  }
}
