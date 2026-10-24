// tauri-bridge.js —— 封装对 Rust 后端的调用（invoke）与系统对话框
// 参数命名遵循 Tauri v2 约定：Rust 里 snake_case -> JS 里 camelCase。

import { invoke } from '@tauri-apps/api/core'
import { open, save, confirm as dialogConfirm, message as dialogMessage } from '@tauri-apps/plugin-dialog'
import { t } from './i18n.js'

/** 打开文件夹选择器，返回选中的知识库根目录（取消返回 null） */
export async function pickFolder() {
  const picked = await open({ directory: true, multiple: false, title: t('dlg.pickFolder') })
  return typeof picked === 'string' ? picked : null
}

/** 打开单个文件选择器（Markdown / 画布），返回绝对路径（取消返回 null） */
export async function pickFile() {
  const picked = await open({
    directory: false,
    multiple: false,
    title: t('dlg.pickFile'),
    filters: [{ name: 'Markdown / Canvas', extensions: ['md', 'markdown', 'canvas'] }],
  })
  return typeof picked === 'string' ? picked : null
}

/** 打开 .docx 文件选择器（可多选），返回绝对路径数组（取消返回 []） */
export async function pickDocxFiles() {
  const picked = await open({
    directory: false,
    multiple: true,
    title: t('dlg.pickDocx'),
    filters: [{ name: 'Word', extensions: ['docx'] }],
  })
  if (!picked) return []
  return Array.isArray(picked) ? picked : [picked]
}

/** .docx → Markdown 只转不写预览：回 { md, plannedDocRel, title, images[], warnings[], stats } */
export function docxPreview(args) {
  return invoke('docx_preview', { args })
}

/** 校对确认后落库：写 .md + 按 sha256 去重落图，回 { docRel, writtenImages[], reusedImages[], updatedIndex } */
export function docxCommit(args) {
  return invoke('docx_commit', { args })
}

/** 批次 F ①：当前文档 Docx-IR → .docx（Rust 落盘到 outPath），回 { outPath, warnings, stats } */
export function exportDocx(args) {
  return invoke('export_docx', { args })
}

/** 在系统 temp 下建本次导入专属目录，返回绝对路径（独立解析模式：先落 temp、立即回显、用户自行决定保存） */
export function ensureTempImportDir() {
  return invoke('ensure_temp_import_dir')
}

/** 把 temp 导入目录整树递归拷贝到目标目录（保留相对路径、覆写同名，不删源）——独立模式下 Ctrl+S「另存为」时使用 */
export function relocateImport(fromRoot, toRoot) {
  return invoke('relocate_import', { fromRoot, toRoot })
}

/** 另存为对话框（导出用，P1） */
export async function pickSaveAs(defaultPath) {
  return await save({ defaultPath, title: t('dlg.saveFile') })
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

/** 删除库内单个文件（md / canvas），限库内路径 */
export function deleteFile(vaultRoot, path) {
  return invoke('delete_file', { vaultRoot, path })
}

/** 新建文件夹（限库内） */
export function createDir(vaultRoot, path) {
  return invoke('create_dir', { vaultRoot, path })
}

/** 重命名 / 移动库内条目（文件或文件夹）：from 已存在，to 不存在 */
export function renameItem(vaultRoot, from, to) {
  return invoke('rename_item', { vaultRoot, from, to })
}

const IMG_EXT_SET = new Set(['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'bmp', 'ico', 'avif'])

/** 判断一个库内路径是否图片附件（与 Rust scan_dir 的 IMG_EXTS 白名单一致）：点击时走图片查看器 */
export function isImagePath(p) {
  const n = (p || '').toLowerCase()
  const dot = n.lastIndexOf('.')
  return dot > 0 && IMG_EXT_SET.has(n.slice(dot + 1))
}

/** 判断一个外部拖入的文件是否可导入（与文件树一致的 .md/.canvas + 图片白名单） */
export function isImportableFileName(name) {
  const n = (name || '').toLowerCase()
  if (n.endsWith('.md') || n.endsWith('.canvas')) return true
  const dot = n.lastIndexOf('.')
  return dot > 0 && IMG_EXT_SET.has(n.slice(dot + 1))
}

/** 把系统拖入的浏览器 File 导入到库内目录（文档进目录、图片也同目录），返回库内相对路径 */
export async function importVaultFileFrom(vaultRoot, destDirRel, file) {
  const dataBase64 = await fileToBase64(file)
  return invoke('import_vault_file', { vaultRoot, args: { destDirRel, name: file.name, dataBase64 } })
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

export function fileToBase64(file) {
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

/** 全库标签计数：返回 [{tag, count}]（按出现次数降序） */
export function listAllTags() {
  return invoke('list_all_tags', {})
}

/** 含指定标签的文档：返回 [{path, title}] */
export function queryTag(tag) {
  return invoke('query_tag', { tag })
}

/** 读取一文档前 N 字的纯文本摘要（库内路径校验通过） */
export function docPreview(vaultRoot, path, maxChars = 240) {
  return invoke('doc_preview', { vaultRoot, path, maxChars })
}

/** 保存/新建后增量更新索引中的这条文档 */
export function updateIndexDoc(path, content) {
  return invoke('update_index_doc', { path, content })
}

/** 文件删除后从索引移除这条文档 */
export function removeIndexDoc(path) {
  return invoke('remove_index_doc', { path })
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

/** 远程图取字节回 data: URL（各平台系统网络栈：Windows URLDownloadToFileW / 其他系统 curl，不带 Referer，绕开图床防盗链） */
export function fetchRemoteImageDataUri(url) {
  return invoke('fetch_remote_image_data_uri', { url })
}

/** 把 data: URL 的图片字节写到指定绝对路径（图片右键「另存为」） */
export function saveImageDataUri(path, dataUri) {
  return invoke('save_image_from_data_uri', { path, dataUri })
}

/** 导出到库外任意路径（由系统保存对话框给出） */
export function exportFile(absPath, content) {
  return invoke('export_file', { args: { absPath, content } })
}

/** P2：知识图谱数据 {nodes:[{path,title}], edges:[{s,t,w}]} */
export function getGraphData(vaultRoot) {
  return invoke('get_graph_data', { vaultRoot })
}

// ==================== 批次 C：整站导出 ====================

/** 一次拿全库站点图：{ docs:[{rel,title}], wiki:[{from,target,to}] }（rel 用 / 分隔） */
export function buildSiteGraph(vaultRoot) {
  return invoke('build_site_graph', { vaultRoot })
}

/** 把被引用到的图片按相同相对路径镜像复制到输出目录 */
export function copyVaultAssets(vaultRoot, rels, outDir) {
  return invoke('copy_vault_assets', { vaultRoot, args: { rels, outDir } })
}

// ==================== 批次 E（子项目 L）：本地 Git（只读 + 本地写，无远程/认证）====================

/** 探测库根所在仓库（向上 discover）：{ isRepo, repoPath, branch, hasHead } */
export function gitOpen(vaultRoot) {
  return invoke('git_open', { vaultRoot })
}

/** 工作树/暂存/HEAD 差异列表：[{ path, kind, staged }]（封顶 1000） */
export function gitStatus(vaultRoot) {
  return invoke('git_status', { vaultRoot })
}

/** 提交历史：[{ id, idShort, summary, authorName, authorEmail, time }] */
export function gitLog(vaultRoot, limit) {
  return invoke('git_log', { vaultRoot, limit: limit == null ? null : limit })
}

/** 单文件统一 diff 文本。against='HEAD'（含未跟踪）或某 commit id */
export function gitDiffFile(vaultRoot, path, against) {
  return invoke('git_diff_file', { vaultRoot, args: { path, against } })
}

/** 读提交身份：{ name, email } | null */
export function gitConfigIdentity(vaultRoot) {
  return invoke('git_config_identity', { vaultRoot })
}

/** 初始化仓库（无 .gitignore 时写一份排除 .notelume-backup/）：返回 GitRepoInfo */
export function gitInit(vaultRoot) {
  return invoke('git_init', { vaultRoot })
}

/** 一键提交全部（git add -A + commit）：name/email 省略则读配置。返回 { id, idShort } */
export function gitCommitAll(vaultRoot, message, name, email) {
  return invoke('git_commit_all', {
    vaultRoot,
    args: { message, name: name || null, email: email || null },
  })
}

// ==================== 批次 E（子项目 R1）：Git 远程（认证 + 快进 pull，shell out 系统 git）====================
// 应用绝不接触/存储任何凭据——认证全交系统 git（凭据助手 / ssh-agent / GCM）。
// 仅 --ff-only 快进 pull，非快进/分叉由前端按 stderr 关键字识别并引导（冲突解决属 R3）。

/** 探测系统 git：返回版本串（如 "git version 2.45.0"）或 null（未安装 → 前端隐藏同步区）
 *  Phase 4 后推荐改用 gitRInfo()，本函数仅保留向后兼容。*/
export function gitRHave() {
  return invoke('git_r_have', {})
}

/** Phase 4 新增：上报当前引擎与系统 git 版本。返回：
 *  { engine: "system"|"builtin", gitVersion: string|null, builtinReady: boolean }
 *  前端徽标与错误引导分派需。*/
export function gitRInfo() {
  return invoke('git_r_info', {})
}

/** 列现有远端：[{ name, url }]（每个 remote 取 fetch URL） */
export function gitRRemoteList(vaultRoot) {
  return invoke('git_r_remote_list', { vaultRoot })
}

/** 添加远端：git remote add <name> <url> */
export function gitRRemoteAdd(vaultRoot, name, url) {
  return invoke('git_r_remote_add', { vaultRoot, args: { name, url } })
}

/** 改远端地址：git remote set-url <name> <url> */
export function gitRRemoteSetUrl(vaultRoot, name, url) {
  return invoke('git_r_remote_set_url', { vaultRoot, args: { name, url } })
}

/** git fetch --prune [remote|--all]（非交互）。成功 resolve 为 stderr（进度/警告），失败 reject 附 git 原文 */
export function gitRFetch(vaultRoot, remote) {
  return invoke('git_r_fetch', { vaultRoot, remote: remote || null })
}

/** 上游名（如 origin/main）；无上游 → null */
export function gitRUpstream(vaultRoot) {
  return invoke('git_r_upstream', { vaultRoot })
}

/** 领先/落后：{ ahead, behind, upstream } | null（无上游） */
export function gitRAheadBehind(vaultRoot) {
  return invoke('git_r_ahead_behind', { vaultRoot })
}

/** 快进 pull（git pull --ff-only）：成功 resolve 为摘要文本；非零退出 reject 附 stdout+stderr（供关键字判定） */
export function gitRPullFf(vaultRoot) {
  return invoke('git_r_pull_ff', { vaultRoot })
}

// ==================== macOS 系统菜单栏 ====================

/** 把前端算好的菜单 spec 交给 Rust 落成原生菜单并挂上菜单栏；失败 reject 附原生错误原文 */
export function setMacMenu(spec) {
  return invoke('set_mac_menu', { spec })
}

/** 界面语言上报：后端命令错误 / docx 警告 / git 结果 / 托盘菜单按这个语言取词。boot 与切换语言时各调一次 */
export function setUiLang(lang) {
  return invoke('set_ui_lang', { lang })
}

/** macOS 菜单栏状态图标：把「最近打开」列表（rel 路径数组）同步到状态栏「打开最近」子菜单；非 mac 为空操作 */
export function traySetRecent(paths) {
  return invoke('tray_set_recent', { paths })
}

/** 读取应用设置（<app_config_dir>/settings.json）：文件不存在 / 损坏时后端返回 null，前端回落默认值 */
export function readSettingsJson() {
  return invoke('read_settings_json', {})
}

/** 写入应用设置（Rust 侧临时文件 + rename 原子替换，参数为整个设置文档） */
export function writeSettingsJson(settings) {
  return invoke('write_settings_json', { settings })
}

/** 剪藏设置保存后停旧起新本地 HTTP 服务，返回 { running, port } */
export function clipServerApply(clip) {
  return invoke('clip_server_apply', { clip })
}

/** 查询剪藏服务运行态：{ running, port }（设置面板打开时拉一次） */
export function clipServerStatus() {
  return invoke('clip_server_status', {})
}

/** P5 §6.6：取走启动参数（[{ path, isDir }]，取后即清）；无参数返回 [] */
export function takeLaunchPaths() {
  return invoke('take_launch_paths', {})
}

/** R2 新增：推当前分支→ upstream。System 走 `git push`；Builtin 走 git2 Remote::push。
 *  失败 reject，附 `[code]msg` 前串（no_upstream / non_fast_forward / auth / network /
 *  hostkey_mismatch / host_unknown / git_error），同 handleRemoteErr 分派表。*/
export function gitRPush(vaultRoot) {
  return invoke('git_r_push', { vaultRoot })
}

/** R3 新增：合并拉取（不带 --ff-only）。resolve 为 `MERGED\n…` 或 `CONFLICTS\n…`；
 *  其他失败 reject 附 `[code]msg` 前串。 */
export function gitRPullMerge(vaultRoot) {
  return invoke('git_r_pull_merge', { vaultRoot })
}

/** R3 新增：列当前冲突文件（相对路径数组）。 */
export function gitRConflictFiles(vaultRoot) {
  return invoke('git_r_conflict_files', { vaultRoot })
}

/** R3 新增：解决单个冲突文件。args = { path, side }，side 为 'ours' | 'theirs'。 */
export function gitRResolve(vaultRoot, args) {
  return invoke('git_r_resolve', { vaultRoot, args })
}

/** R3 新增：是否处于 merge-in-progress（resolve 为 bool）。 */
export function gitRMergeState(vaultRoot) {
  return invoke('git_r_merge_state', { vaultRoot })
}

/** R3 新增：中止合并，回到 pull 前状态。 */
export function gitRAbortMerge(vaultRoot) {
  return invoke('git_r_abort_merge', { vaultRoot })
}

/** R3 新增：提交合并（冲突全解后生成 merge commit）。args = { message }。 */
export function gitRCommitMerge(vaultRoot, args) {
  return invoke('git_r_commit_merge', { vaultRoot, args })
}

/** Phase 4 新增：一次性信任陌生 SSH 主机。args = { host, keyType, keyB64 }（同错误里 payload 的三段）。
 *  成功后下一拨 fetch/pull 会命中 known_hosts 直接放行。*/
export function gitRTrustHost(args) {
  return invoke('git_r_trust_host', { args })
}

/** 文件系统监听：开始监听库根目录变动（外部增删改），自动刷新树 */
export function startVaultWatcher(vaultRoot) {
  return invoke('start_vault_watcher', { vaultRoot })
}

/** 文件系统监听：停止监听 */
export function stopVaultWatcher() {
  return invoke('stop_vault_watcher', {})
}
