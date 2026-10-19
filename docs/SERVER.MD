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

- Ta
- 网页版目标：`npm run build` 后，`dist` 可直接部署为静态站点。

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
