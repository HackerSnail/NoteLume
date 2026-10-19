# NoteLume 项目规则

## 项目定位

NoteLume 是一个本地 Markdown 知识库编辑器，当前主形态是 Tauri 桌面应用。

同时需要维护一个 **网页沙盒试用版**，用于在浏览器里快速体验核心编辑能力。

## 分支与合并方向

- 桌面主干 = `master`；网页沙盒 = `web`。
- `master → web`：允许，且是常态。web 要跟住主干的修复，就在 web 上合一次 master。
- `web → master`：**禁止**。网页版的产物一律不进主干：`server/`（Node 后端、演示库 `server/default-vault/`、后端测试）、`src/web/`（前端替身与 `web.css`）、`src/web/index.html` 这类构建期生成物、根 `package.json` 里的 `web:*` 脚本。
- 主干要拿 web 里的改动，只 cherry-pick 那一条提交，且必须是桌面语义的（例如 `mermaid-preview.js` 缺 `import { t }` 那类真 bug）。不在 master 上做整支合并。
- 桌面侧唯一允许为网页版改动的地方是能力入口的集中分流：`src/tauri-bridge.js` + `src/desktop-gate.js`。这套目前只存在于 `web` 分支，主干没有；要进主干请单独提一条桌面提交。

## 当前构建状态

- 桌面版：`npm run dev` / `npm run build` 走 Tauri v2，已可用。
- 网页版：`npm run web` 构建并起本地服务，产物 `server/dist`；`npm run web:sandbox` 是给访客跑的沙盒模式；`npm run web:api` 配合 `npm --prefix src run dev` 做开发热更。
- 静态部署要求：`server/dist` 是带 `--base=./` 的产物，可以整目录丢到任意静态托管，前提是同域下有那份 Node 后端（纯静态托管跑不起来）。

## 网页版隔离规则

- 桌面版代码是已验证成品，网页版开发**不改** `src/index.html`、`src/style.css`、`src/vite.config.js`、`src-tauri/**`；`src/*.js`（`src/web/` 下新增的除外）只在一个地方允许动：桌面能力的集中分流，即 `src/tauri-bridge.js` + `src/desktop-gate.js`。其它调用点不得自己加环境判断。
- 两条判据分工，别混：`hasBackend()` = Tauri 原生或网页版替身（`src/web/tauri-core.js` 挂 `__NOTELUME_BACKEND__`），管 `invoke` / 选择器 / 路径 API 能不能调；`isDesktop()` 只认真 `__TAURI_INTERNALS__`，管窗口按钮、设置存储的 localStorage 回落、启动参数探测。网页版里 `isDesktop()` 恒为假，所以确认框 / 提示框降到 `window.confirm` / `window.alert`，而 HTTP 后端照常工作。
- 网页端的差异全部写在新增文件里：前端替身在 `src/web/`，Node 后端与演示库在 `server/`。
- 隔离靠构建期替身：vite alias 把五个 `@tauri-apps/*` 包名换成 `src/web/` 里的网页实现，桌面代码原样进产物。网页不支持的能力不在前端做名单，统一由后端 `server/src/router.mjs` 的 `UNSUPPORTED` 判定（见下）。
- 护栏两条：`node src/tests/desktop-gate.test.mjs` 全仓扫描——除 bridge / gate（加 titlebar、main 的窗口调用）外不得出现 Tauri 导入与注入标记读取，且网页标记必须放行后端、不冒充桌面；`server/tests/desktop-untouched.test.mjs` 检查 `git diff` 里没碰到上面那批被禁的桌面文件。
- 设计细节见 `docs/superpowers/specs/2026-10-19-web-sandbox-server-design.md`。

## 网页试用版约束

浏览器环境不支持 Tauri 能力，包括：

- `invoke()`
- `@tauri-apps/api`
- 文件系统访问
- 窗口管理
- 系统托盘
- Shell 打开外部程序
- 本地目录读取

所有涉及上述能力的代码必须通过环境判断隔离，不能直接删除桌面版实现。

网页版的文件读写不走浏览器本地能力：前端调的还是 `invoke(cmd, params)` 那一套形状，传输层被替成 `POST /api/invoke`，由 `server/` 的 Node 后端读写真文件系统。浏览器只当客户端。

### 桌面专属能力怎么告知访客

菜单与命令面板里的桌面专属项照旧留着（藏掉反而让人以为产品缺功能），点下去要给一句能看的话。这条路只有两处：

- 判定与文案在后端：`router.mjs` 的 `UNSUPPORTED` 是唯一名单，命中的命令回 `{ ok:false, error:<一句完整话术>, code:'desktop-only' }`。话术在 `server/src/uiLang.mjs` 的 `webUnsupported`（五语），语言由前端 `set_ui_lang` 上报；不带 code 的普通失败仍是 `{ ok:false, error }`，不要把访客的误操作说成「网页版不支持」。
- 可见化在前端：`src/web/tauri-core.js` 见到 `code:'desktop-only'` 就调 `src/web/desktop-only.js` 把那句话提示到屏幕底部。为什么要这一层：桌面版的失败提示走 `setStatus`，而 `setStatus` 早已从界面上去掉（只剩 `console.debug`），Git / 插件那一类命令在网页里就会「点了没反应」。三条规矩：访客动过之前不提示（开库自检也会被拒）、同一句话只一条、调用方自己弹了同一句话的框（导出 Word / 整站 / Git push）就不再补提示——`window.alert` 被包了一层只记不拦的挂钩，因为 bridge 的 `dialogMessage` 在非桌面环境是直接调 `window.alert` 的，不走 alias 的替身。

前端不存第二份「不支持」文案，也不新建命令名单：加一条桌面专属能力，只改 `router.mjs` 那个 Set。

web版代码推送到web 分支
