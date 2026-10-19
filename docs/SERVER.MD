# NoteLume 项目规则

## 项目定位

NoteLume 是一个本地 Markdown 知识库编辑器，当前主形态是 Tauri 桌面应用。

同时需要维护一个 **网页沙盒试用版**，用于在浏览器里快速体验核心编辑能力。

## 当前构建状态

- 桌面版：`npm run dev` / `npm run build` 走 Tauri v2，已可用。
- 网页版：`npm run web` 构建并起本地服务，产物 `server/dist`；`npm run web:sandbox` 是给访客跑的沙盒模式；`npm run web:api` 配合 `npm --prefix src run dev` 做开发热更。
- 静态部署要求：`server/dist` 是带 `--base=./` 的产物，可以整目录丢到任意静态托管，前提是同域下有那份 Node 后端（纯静态托管跑不起来）。

## 网页版隔离规则

- 桌面版代码是已验证成品，网页版开发**不改** `src/*.js`（`src/web/` 下新增的除外）、`src/index.html`、`src/style.css`、`src/vite.config.js`、`src-tauri/**`。
- 网页端的差异全部写在新增文件里：前端替身在 `src/web/`，Node 后端与演示库在 `server/`。
- 隔离靠构建期替身：vite alias 把五个 `@tauri-apps/*` 包名换成 `src/web/` 里的网页实现，`./commands.js` 换成注册表 wrapper 拦掉网页不支持的命令。
- 护栏测试 `server/tests/desktop-untouched.test.mjs`：`git diff` 里出现被禁的桌面文件即失败。
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
