# 网页沙盒试用版（`server/` Node 后端 + 浏览器构建）—— 设计（Spec）

- 状态：设计已定，待实现
- 日期：2026-10-19
- 前置：`docs/SERVER.MD`「网页试用版约束」、`docs/CLAUDE.MD`「架构设计」
- 范围：`server/` 目录（Node HTTP 后端 + 静态伺服 + 演示知识库）、`src/web/` 目录（网页端前端，全部新增文件）、构建脚本、单测与端到端
- 硬约束：**桌面版现有代码一个文件都不改**。网页端的差异全部落在新增文件里，靠构建期替身接上（§3）
- 不做：见 §13

## 1. 背景与现状

`docs/SERVER.MD` 要求同时维护一个网页沙盒试用版，且「所有涉及 Tauri 能力的代码必须通过环境判断隔离，不能直接删除桌面版实现」。本轮追加一条更硬的约束：桌面版代码是已验证可用的成品，移植时不改它，网页端复制出新的来改。

现在的事实：

- `npm --prefix src run build` 已通（vite 5.4.21，2484 modules，25s，产物 `src/dist`），产出的是纯静态站点，主包 1.33 MB / gzip 441 KB。
- 运行时仍是桌面形态：`src/tauri-bridge.js` 顶层 `import { invoke } from '@tauri-apps/api/core'` 与 `@tauri-apps/plugin-dialog`；`src/main.js` 另引 `@tauri-apps/api/window|event|path`；`src/titlebar.js` 引 `@tauri-apps/api/window`。浏览器里没有 `window.__TAURI_INTERNALS__`，这些调用全部抛错。
- 耦合面只有这五个裸包名：`@tauri-apps/api/core`、`@tauri-apps/api/window`、`@tauri-apps/api/event`、`@tauri-apps/api/path`、`@tauri-apps/plugin-dialog`。全站除这三个文件外没有第二处直接 import Tauri——其余 12 个模块一律经 `./tauri-bridge.js`（`editor-view`、`img-viewer`、`git-panel`、`graph-view`、`wiki-hover`、`snapshot-panel`、`plugin-loader`、`settings-store`、`daily-capture`、`canvas-view`、`about-dialog`、`main`）。
- 浏览器回落路径现成的有两处：`settings-store.js` 的 `hasTauri()` 为假时整份设置文档读写 localStorage 的 `nl-settings`（含 `workspace` 与 `panes` 两段）；`titlebar.js` 的 `inTauri` 为假时自绘窗口按钮不出现。`main.js` 里三处 `window.__TAURI_INTERNALS__` 早退覆盖语言上报、窗口标题与 mac 菜单/托盘。

耦合面窄到只剩五个裸包名，意味着不必改 `tauri-bridge.js`：构建期把这五个包名替成网页端的实现，桌面文件原样进产物即可。

## 2. 关键决策

| # | 决策 | 取舍 |
|---|---|---|
| 1 | 桌面代码零改动，网页端差异走构建期替身 | 这是本轮的硬约束，也是最省事的隔离方式：替身集中在 `src/web/`，桌面文件不用散布 `if (IS_WEB)`；代价是替身要严格对齐 `@tauri-apps/api` 的导出形状（§3 逐个列出） |
| 2 | `server/` 起一个真 Node 后端，浏览器走 HTTP 而不是内存虚拟库 | 与桌面版数据流同构（前端只认 `invoke` 的形状），文件仍是真 `.md`，直接验证「库就是文件夹」；虚拟库要另写持久化且验证不到真文件系统 |
| 3 | 后端覆盖 = P0 文件操作 + 知识库索引 | 侧栏（文件树 / 大纲 / 标签 / 反链 / 搜索 / 图谱 / 快照）全部可用；`git_*`、docx、插件、整站导出属独立生态，Node 重写代价与收益不匹配 |
| 4 | 默认本机全功能，`--sandbox` 切会话临时工作区 | 本机跑才能打开自己已有的库；往公网放必须每访客一份工作区，否则等于开放本机文件系统 |
| 5 | `pickFolder` / `pickFile` / `pickSaveAs` 在替身里走后端目录浏览器，不用 `<input type=file>` | 桌面代码拿到的是绝对路径字符串（`openFile(absPath)`、`exportFile(absPath)` 全链如此），浏览器 File 对象没有路径。本机模式下盘符列表就是浏览器根 |
| 6 | 功能门控两层：命令注册表替身在登记时丢弃不支持的命令 id；静态 DOM（工具条项、侧栏标签）由 `src/web/web.css` 按 `<html data-web>` 隐藏 | 注册表是单一事实源，命令面板 / 快捷键设置 / mac 菜单三处跟随；不注册即不留灰项。静态 DOM 项在 `src/index.html` 的标记里，不能改它，因此用新增 CSS 隐藏而不是删标记——面板的挂载点仍存在于 DOM，桌面启动逻辑不会因缺节点抛错 |
| 7 | 沙盒首屏用 `src/web/entry.js` 预置 localStorage `nl-settings` 的 `workspace.lastVault` / `lastFile` | 桌面 `boot()` 里现成的工作区恢复（`main.js:905-916`）会自动开库开文档，网页端不用写一行首屏逻辑 |
| 8 | 返回形状与错误前串以 `src-tauri/src/lib.rs` 为准，实现时逐字段对齐 | 前端按 `[code]` 前串分派的约定（git 错误、docx 警告、`MERGED` / `CONFLICTS` 协议行）在网页模式同样要吃这套；不对齐就是两套语义 |
| 9 | 验收写单测 + 真浏览器端到端，并加一条「桌面文件未被改动」的护栏测试 | 仓库既有习惯（`src/tests/*.test.mjs` 裸 node + jsdom）；路径越界、替身导出形状、静默改了桌面文件这三处不测就是埋雷 |

## 3. 构建期替身（`src/web/`，全部新增）

替身不是复制一份 `tauri-bridge.js`，而是替掉它依赖的五个裸包名。`tauri-bridge.js`、`main.js`、`titlebar.js` 连同其余 60 多个模块原样进网页产物。

| 被替的包名 | 替身文件 | 要导出的形状 |
|---|---|---|
| `@tauri-apps/api/core` | `src/web/tauri-core.js` | `invoke(cmd, params)` → `POST /api/invoke` |
| `@tauri-apps/plugin-dialog` | `src/web/tauri-dialog.js` | `open(opts)`、`save(opts)`、`confirm(msg, opts)`、`message(msg, opts)` |
| `@tauri-apps/api/window` | `src/web/tauri-window.js` | `getCurrentWindow()` → `{ setTitle, label, onCloseRequested, show, setFocus, setSize, outerSize, isMaximized, unminimize, ... }`，形状按 `main.js` / `titlebar.js` 的实际调用点补齐，缺一个就是运行时 TypeError |
| `@tauri-apps/api/event` | `src/web/tauri-event.js` | `listen(name, cb)` → resolve 一个 no-op 的 unlisten；`emit` → no-op |
| `@tauri-apps/api/path` | `src/web/tauri-path.js` | `tempDir()` → `/api/health` 的 `scratchDir`；`join(...)` → `/` 拼接并折叠重复分隔符 |

`invoke` 的传输：

```
POST /api/invoke
content-type: application/json
x-notelume-session: <sid>
body: { cmd, params }         // params 原样是 Tauri 会收到的那个对象
```

响应一律 `200` + `{ ok: true, result }` 或 `{ ok: false, error }`。不用状态码区分业务失败与传输失败，Promise 语义与原生 `invoke` 一致；`error` 原样 `throw new Error(error)`，`[invalid_path]` / `[not_found]` / `[unsupported]` 前串保持不变，前端现有分派代码不用动。连不上或非 JSON 抛 `msg.netFailed`。

`sid`：localStorage `nl-web-sid`，没有就 `crypto.randomUUID()` 生成并存下。

替身挂上靠 vite `resolve.alias`——裸包名是精确匹配，不存在相对路径歧义。另有一条不是裸包名的替身：`./commands.js` 只在 `src/main.js` 里被引（已 `Grep` 确认全站唯一），所以用一条精确的 alias 正则把它指到 `src/web/commands-guard.js`，替身再按绝对路径引真正的 `../commands.js`，包一层 `register`：id 落在 denylist（`app.git.*`、`app.importDocx`、`app.exportDocx`、`app.exportSite`、`app.plugins.*`）时直接返回 `false` 不登记。`commands.js` 的注册表是单一事实源，命令面板、快捷键设置、菜单都从 `list()` 读，因此不登记等于三处同时消失，不留灰项。

`src/web/` 其余文件：

- `index.html`：复制自 `src/index.html`，只改两处——`<html>` 加 `data-web`，`<script type="module">` 指向 `./entry.js`。sprite、挂载点、工具条标记全部保持原样（§2 决策 6 的理由）。
- `entry.js`：`import './bootstrap.js'` 再 `import '../main.js'`。
- `bootstrap.js`：拉 `/api/health`、按 §2 决策 7 预置 `nl-settings`、插顶部横幅。
- `path-picker.js`：目录浏览器弹窗。
- `web.css`：`data-web` 下的样式差异——隐藏窗口按钮位与不支持的静态菜单项 / 侧栏标签，显示横幅。横幅样式与弹窗样式都复用 `style.css` 里现成的 `.nl-dlg-*` 一套，不新造视觉语言；图标走 `icons.js`，不用 emoji 字形。

## 4. 对话框与窗口

- `open({ directory: true })` → 弹 `path-picker.js` 的选目录形态，返回字符串路径；`open({ filters })` → 选文件形态，列出 `md / markdown / canvas`（`docx` 也列出来，选中后由后端回 `[unsupported]` 并给一句不支持的提示，不改 `main.js` 的导入链路）；`save({ defaultPath })` → 选目录 + 填文件名；`cancel` → `null`，与 Tauri 的返回约定一致。
- 数据来源：`GET /api/browse?path=<abs>` → `{ path, parent, roots?, dirs: [{name, path}], files: [{name, path, kind}] }`。本机模式不给 `path` 时 `roots` 是盘符（unix 上是 `/`），可浏览全盘；`--sandbox` 下 `roots` 只有会话工作区，越界一律 `[invalid_path]`。
- `confirm` / `message` → `window.confirm` / `window.alert`。这两个在桌面代码里只用于「是/否」与错误提示，更复杂的三选场景走 `confirm3-dialog.js`（纯 DOM，浏览器里本来就能用）。
- 窗口：`onCloseRequested(handler)` 的替身实现挂 `beforeunload`，把 handler 给的 `event.preventDefault()` 译成 `returnValue`；`setTitle` 写 `document.title`；`label` 回 `'main'`；尺寸与最大化相关方法 no-op 或回默认值。`main.js` 里 `window.__TAURI_INTERNALS__` 的三处判定在浏览器自然为假，mac 菜单、托盘、语言上报整段跳过。
- 打印与 HTML 导出保留：浏览器原生 `window.print` 可用，`export_file` 后端有实现（写 `save()` 给的路径）。

## 5. `server/` 结构

```
server/
  serve.mjs                 入口与路由：--sandbox / --port / --api-only / --open
  package.json              后端自身脚本（start / test），不装前端依赖
  src/
    router.mjs              /api/invoke 的 cmd → handler 分派表；未列出的命令回 [unsupported]
    browse.mjs              /api/browse 与盘符 / 工作区根
    vault.mjs               路径监狱（ensure_inside_root 的 JS 对应）、TreeNode 构造、相对路径规范化
    fsCommands.mjs          文件类命令
    index.mjs               扫描式索引（链接 / 标签 / 标题 / 摘要）与内存表
    kbCommands.mjs          索引、搜索、反链、标签、图谱、备份类命令
    paths.mjs               数据落位：dataDir / sessionDir / scratchDir / demoVault
  default-vault/            演示知识库（§9）
  dist/                     构建产物，进 .gitignore
  data/                     本机模式的运行期文件，进 .gitignore
  tests/                    后端单测与端到端
```

`serve.mjs` 的路由：`POST /api/invoke`、`GET /api/browse`、`GET /api/health`，其余 GET 走静态伺服 `server/dist`（找不到文件回 `index.html`）。只监听 `127.0.0.1`。零依赖，只用 `node:http` / `node:fs` / `node:path` / `node:os` / `node:child_process`。端口：伺服 + API `1420`，`--api-only`（配合 vite dev）`1430`。

`/api/health` 回 `{ mode, version, scratchDir, demo: { vaultRoot, file } }`，`bootstrap.js` 据此决定预置什么。

## 6. 命令清单

实现（`fsCommands.mjs` / `kbCommands.mjs`）：

| 组 | 命令 |
|---|---|
| P0 文件 | `scan_vault`、`read_md_file`、`write_md_file`、`create_md_file`、`delete_file`、`create_dir`、`rename_item`、`import_vault_file`、`resolve_wiki_link` |
| 图片 | `save_image_bytes`、`read_image_data_uri` |
| 索引 | `rebuild_index`、`get_index_status`、`update_index_doc`、`remove_index_doc`、`query_backlinks`、`query_outgoing`、`get_doc_info`、`doc_preview`、`search_vault`、`list_all_tags`、`query_tag`、`get_graph_data` |
| 快照 | `backup_write`、`list_backups`、`read_backup` |
| 导出 | `export_file` |
| 语言 | `set_ui_lang` |

不实现、router 统一回 `[unsupported]`：`git_open`、`git_status`、`git_log`、`git_diff_file`、`git_config_identity`、`git_init`、`git_commit_all`、`git_r_have`、`git_r_info`、`git_r_remote_list`、`git_r_remote_add`、`git_r_remote_set_url`、`git_r_fetch`、`git_r_upstream`、`git_r_ahead_behind`、`git_r_pull_ff`、`git_r_push`、`git_r_pull_merge`、`git_r_conflict_files`、`git_r_resolve`、`git_r_merge_state`、`git_r_abort_merge`、`git_r_commit_merge`、`git_r_trust_host`、`docx_preview`、`docx_commit`、`ensure_temp_import_dir`、`relocate_import`、`export_docx`、`list_plugins`、`read_plugin`、`build_site_graph`、`copy_vault_assets`、`set_mac_menu`、`tray_set_recent`、`read_settings_json`、`write_settings_json`。

三个说明：

- `read_settings_json` / `write_settings_json` 不走后端：`settings-store.js` 的 `hasTauri()` 在浏览器为假，整份设置文档读写 localStorage（§1）。后端落一份 settings.json 反而会造成「两份设置、谁覆盖谁」的歧义。
- `take_launch_paths` 返回 `[]`（不是错误）：`main.js` 本来就是空数组即跳过。
- `copy_image_asset` 不实现：前端零引用，Rust 侧的历史入口。

## 7. 路径监狱与返回形状

`ensureInsideRoot(root, target)` 对齐 `lib.rs` 的同名函数：相对路径先折叠 `..`、反斜杠换正斜杠、去掉开头的 `./`，拼接后对已存在的祖先做 `realpath` 再判前缀，越界抛 `[invalid_path]` + 详情。库根由 `params.vaultRoot` 给：本机模式下必须落在 `/api/browse` 允许的范围（默认可全盘）；沙盒模式强制等于该会话的 `vault/`，传别的回 `[invalid_path]`。

返回形状逐个从 `lib.rs` 抄，实现时对着源码读，不在本文重写一遍：`TreeNode { name, path, kind: 'folder'|'file', children }`（`scan_vault` 回顶层数组，深度与排序沿用 Rust 的规则）、`WikiLinkTarget { exists, path }`、索引状态 `{ vaultRoot, docs, ready }`、搜索项 `{ path, title, snippet, matchedBy }`、图谱 `{ nodes:[{path,title}], edges:[{s,t,w}] }`。字段名一律 camelCase（Tauri v2 的 snake_case ↔ camelCase 映射在 Rust 侧做掉，Node 直接吐 camelCase 才与前端现有读法一致）。

## 8. 索引与搜索（`server/src/index.mjs`）

- 内存 `Map<relPath, { title, headings[], tags[], outgoing[], snippet, mtime }>`。`rebuild_index` 置 `ready = false` 后异步扫描（`setImmediate` 逐文件让出，不阻塞响应），扫完置 `ready = true` + `docs` 计数——前端现有的 `getIndexStatus` 轮询直接对接，不需要 SSE / WebSocket。
- 抽取规则：`[[链接]]`（含 `[[目标|显示]]` 与 `#段` 后缀）、`#标签`（多级 `a/b/c`）、ATX 标题、纯文本摘要截 240 字。围栏代码块与行内代码内的内容不参与抽取，否则 `[[x]]` 与 `#tag` 会被误抽。
- 保存 / 新建 / 删除走 `update_index_doc` / `remove_index_doc` 增量维护。不加文件监听：库只在编辑器里动，切库时前端本来会 `rebuild_index`。
- `search_vault`：文件名、标题、标签、正文四路，大小写不敏感的子串匹配；命中正文时取上下文 ±40 字做 `snippet`；`limit` 默认 60。子串匹配够用，不引分词与倒排。

## 9. 两种运行模式

| | 默认（本机） | `--sandbox` |
|---|---|---|
| 库根 | 用户在 `/api/browse` 里挑的真实路径 | `<os.tmpdir()>/notelume-web/<sid>/vault` |
| 设置文档 | 浏览器 localStorage `nl-settings` | 同左 |
| `scratchDir`（Ctrl+N 临时文件） | `<os.tmpdir()>/NoteLume/scratch` | `<会话目录>/scratch` |
| `/api/browse` | 全盘（Windows 列盘符，unix 列 `/`） | 锁在会话 `vault` 内 |
| 首屏 | `nl-settings` 里有 `workspace.lastVault` 就恢复，否则空态等用户点「打开知识库」 | `bootstrap.js` 发现 `nl-settings` 无 `workspace` 时写入 `demo.vaultRoot` / `demo.file`，桌面恢复逻辑自己开演示库 |
| 会话目录回收 | 不涉及 | 每 sid 一份，`serve.mjs` 启动时清 7 天前的 |

安全边界：只绑 `127.0.0.1`；不做鉴权（本机自用）；公网部署必须带 `--sandbox`，靠反代与 sessionId 隔离，应用层仍不鉴权——列为已知限制（§13）。

`server/default-vault/` 演示库：七篇 md（首页介绍 + 三篇互链的能力示例 + 一篇带 frontmatter 与多级标签 + 一篇空文档验证「点击不存在的链接新建」+ 一篇 `.canvas`）加 `assets/` 一张 png。内容覆盖 wikilink、`#标签`、表格、任务列表、代码块高亮、行内与块级数学、图片、引用、删除线。文案中英各半，不写 `lorem`。

## 10. 前端门控与网页样式

两层，都在新增文件里，不碰 `main.js`：

1. `commands-guard.js` 拦登记：denylist 命中即 `register` 返回 `false`，命令面板、快捷键设置、菜单同时没有这些项。快捷键上如果桌面默认键位指向被拦命令，`keymap` 找不到命令 id 就是按键无动作，不报错。
2. `web.css` 藏静态 DOM：`<html data-web>` 下隐藏侧栏的 Git 标签、工具条「更多」里的 docx 导入 / 导出与整站导出项、插件管理项、自绘窗口按钮位（`[data-web] .win-btns`）。选择器按 `src/index.html` 里现成的 id 与 class 写，实现时逐个对照，不删标记——`createGitPanel`、`createPluginManager` 这些调用点仍会在启动时跑，DOM 挂载点缺了就 TypeError，所以必须留标记只藏样式。被藏起来的面板仍会发一两次 `[unsupported]` 请求，代价是多几个失败的 fetch，换来的是不改桌面启动逻辑。

保留可用：文件树、大纲、属性、标签、反链、搜索、快照面板、图谱、分栏与拖拽、五语言、外观设置、快捷键设置、命令面板、查找替换、HTML 导出、打印、拖入打开（`import_vault_file` 走 base64，与桌面同路）、每日捕获、脚注、mermaid、数学。

横幅：`bootstrap.js` 在工具条下方插一条「网页沙盒试用版，功能为桌面版子集」，右侧一个关闭按钮（`icons.js` 图标）。文案进 `src/locales/` 五语言各一条——这是 locales 文件的追加（§15），不改现有词条。

## 11. 构建与脚本

- `src/web/vite.config.web.js`（新文件，不动 `src/vite.config.js`）：`root` 仍是 `src`（`node_modules` 与相对 import 都按现成解析走），`build.rollupOptions.input` 指 `src/web/index.html`，`outDir` 指 `server/dist`，`base: './'`；`resolve.alias` 五条裸包名 + 一条 `/^\.\/commands\.js$/`；`server.proxy` 加 `'/api': 'http://127.0.0.1:1430'` 供 dev。
- 根 `package.json` 追加四条，现有 `dev` / `build` / `tauri` 三条不动：

```
"web:build":   node src/node_modules/vite/bin/vite.js build --config src/web/vite.config.web.js
"web":         npm run web:build && node server/serve.mjs --open
"web:sandbox": npm run web:build && node server/serve.mjs --sandbox --open
"web:api":     node server/serve.mjs --api-only --port 1430
```

- dev 是两条命令、两个终端：终端一 `npm run web:api`（1430 只出 API），终端二 `npm run web:dev`（vite 起 `src/web/index.html`，`/api` 走 proxy）。不用 `&&` 串——`serve.mjs` 是常驻进程，串下去第二条永远不执行；也不引 `concurrently`。
- `--open` 用 `child_process`：win 走 `start`、mac/linux 走 `open` / `xdg-open`，失败静默。
- `server/package.json`：`{ "type": "module", "scripts": { "start": "node serve.mjs", "test": "node --test tests/" } }`，无 `dependencies`。
- `.gitignore` 追加 `server/dist/`、`server/data/`。
- 文档：`server/README.md` 写两条路径（本机试用 / 沙盒部署）、端口、参数、限制；`docs/SERVER.MD` 的「当前构建状态」补网页版命令并把残缺的 `- Ta` 行写完。

## 12. 测试与验收

单测（裸 node + jsdom，与 `src/tests/` 同风格）：

- `src/tests/web-tauri-core.test.mjs`：替身的 `invoke` 打到 `/api/invoke` 且 body 是 `{cmd, params}`；`{ok:false, error:'[invalid_path] …'}` 抛出的 `Error.message` 保留前串；`join` / `tempDir` 行为；`plugin-dialog` 替身的 `open` / `save` 返回值形状与 Tauri 约定一致（字符串 / `null` / 数组）。
- `src/tests/web-commands-guard.test.mjs`：denylist 命中的 id 登记失败、`list()` 里没有、非 denylist 的正常登记；同 id 重复注册不炸。
- `server/tests/fs-commands.test.mjs`：临时目录建库 → `scan_vault` 树形与排序、读写、`create_md_file` / `create_dir` / `rename_item` / `delete_file`、`[invalid_path]`（`../` 与绝对路径两种越界）、`[not_found]`、`save_image_bytes` 落 `assets/` 且返回的相对链接能在 md 里直接用、`resolve_wiki_link` 命中 / 未命中、`read_image_data_uri` 的 data 前缀。
- `server/tests/kb-commands.test.mjs`：`rebuild_index` → 轮询 `ready` → `query_backlinks` / `query_outgoing` / `list_all_tags` / `query_tag` / `search_vault` 的 `snippet` 与 `matchedBy` / `get_graph_data` 的节点与边；围栏代码块内的 `[[x]]` 与 `#tag` 不被抽进；`update_index_doc` / `remove_index_doc` 的增量；`backup_write` → `list_backups` → `read_backup`。
- `server/tests/sandbox.test.mjs`：`--sandbox` 首访灌演示库、`/api/browse` 锁在工作区、两个 sid 的 `vault` 互不可见、7 天前的会话目录被清。
- `server/tests/desktop-untouched.test.mjs`：`git diff --name-only HEAD` 里不得出现 `src/*.js`（`src/web/` 与 `src/tests/` 除外）、`src/index.html`、`src/style.css`、`src/vite.config.js`、`src/locales/*` 之外的既有前端文件——把 §2 决策 1 的硬约束钉成一条会失败的测试。
- `server/tests/e2e.mjs`：起 `node server/serve.mjs --sandbox --port 1420`（不带 `--open`），真浏览器（沿用 `tmp/cdp.mjs` 的 CDP 探针路子或 webapp-testing 一套）走：自动出现演示库文件树 → 点开一篇 → 打字 → 标题脏标记 → `Ctrl+S` → 读会话目录里的 `.md` 确认落盘 → 反链面板出现引用它的另一篇 → 搜索命中并点开 → 点不存在的 `[[链接]]` 走新建 → 命令面板里搜 git / docx / 插件应当无结果 → 截图存 `tmp/`。

桌面回归：

- `npm --prefix src run test:roundtrip`、`test:footnote`、`test:merged-table`、`test:split-pane`、`test:tabs`、`test:vault-path`、`test:i18n` 全跑（本轮不改桌面文件，这些应当全绿且无需修改）。
- `npm run build`（Tauri 打包）过一次，确认没被 web 构建配置影响。
- `tauri dev` 手工点一遍：开库 → 编辑 → `Ctrl+S` → 切库 → 关窗询问。

## 13. 明确不做

- docx 导入导出、本地与远程 git、插件系统、整站导出的 Node 重写：前端藏入口，后端统一回 `[unsupported]`，不留半实现。
- 改桌面代码来「支持网页版」：不做。若某个替身做不到（比如 `getCurrentWindow()` 的某个方法语义在浏览器里无法等价），停下讨论，不在 `main.js` 里加 `if`。
- IndexedDB / OPFS 的浏览器端虚拟库、Service Worker 缓存与 PWA 清单、多用户鉴权与配额、WebSocket 实时同步。
- 公网部署的应用层鉴权与会话过期清理策略之外的加固。
- 前端产物瘦身：主包 1.33 MB（gzip 441 KB）、`mermaid` 与 `elk` 各自上 MB，网页首屏会明显慢。独立议题，另开 spec（mermaid / katex / codemirror 语言包按懒加载切分），本文不动。
- `copy_image_asset` 的清理：前端零引用，属 Rust 侧死代码，本文范围外。

## 14. 实施切分

四段，每段结束都有能跑的东西：

1. `src/web/` 替身五件 + `serve.mjs` 骨架 + 文件类命令：浏览器里能选库、开文档、编辑、`Ctrl+S` 落盘。这一段就能验证 §2 决策 1 的替身路线走不走得通，走不通要立刻停下来重议。
2. `index.mjs` + `kbCommands.mjs`：反链 / 标签 / 搜索 / 图谱 / 快照与悬浮预览可用。
3. `--sandbox` + `default-vault/` + `commands-guard.js` + `web.css` + 横幅与五语言词条。
4. 七份测试、根脚本与产物验证、`server/README.md` 与 `docs/SERVER.MD`、桌面回归。

## 15. 会动到的既有文件

除新增文件外只碰四处，且都是追加：

- 根 `package.json`：加四条 `web*` 脚本，现有三条不动。
- `.gitignore`：加 `server/dist/`、`server/data/`。
- `src/locales/` 的五个语言文件：各追加横幅与目录浏览器弹窗的词条，不改现有键。
- `docs/SERVER.MD`：补完「当前构建状态」的残缺行并加一条网页版命令。

`src/*.js`、`src/index.html`、`src/style.css`、`src/vite.config.js`、`src-tauri/**` 一概不动，由 `desktop-untouched.test.mjs` 兜。
