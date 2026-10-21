# NoteLume 剪藏（浏览器扩展）

把网页正文剪藏到本机 NoteLume 知识库：按模板落盘成标准 GFM md，图片可选本地化，文末自动追加「## 相关笔记」关联库内已有文档。

MV3，无构建、无 npm 依赖。`vendor/` 下是三个原样放入的库：

- `defuddle.js` —— defuddle 0.19.5（MIT，npm 包 `dist` 的 UMD 浏览器包，全局名 `Defuddle`，无外部依赖）
- `Readability.js` —— @mozilla/readability（Apache-2.0）
- `turndown.js` —— turndown 7.2.0（MIT）

## 安装

Edge / Chrome：开 `edge://extensions`（或 `chrome://extensions`）→ 打开左下角「开发人员模式」→「加载已解包的扩展」→ 选本目录。

## 配置

右键扩展图标 →「扩展选项」（或 `edge://extensions` 里点详情 → 扩展选项）：

- 服务器地址：NoteLume 剪藏设置里显示的地址，默认 `http://127.0.0.1:3210`。端口被占用顺延过就以 NoteLume 里显示的实际端口为准。填这一项就够了，没有令牌要配
- 默认目标目录 / 默认模板：可选，填了就对每次剪藏生效，覆盖 NoteLume 设置里的对应值

「测试连接」会请求 `GET /health`，能看出服务在不在、端口对不对、NoteLume 有没有开着知识库。

每次剪藏前扩展也会读一次 `/health`，拿 NoteLume 剪藏设置里的两个开关：图片本地化（`clip.localizeImages`，默认关）与整页兜底（`clip.fullPageFallback`，默认关）。NoteLume 没启动时按默认值继续，随后的 POST 会以「连不上」报错。

NoteLume 侧：工具条「更多 → 网页剪藏设置」里启用服务、选模板与目标目录、目标目录、图片本地化与整页兜底两个开关。

## 使用

- 点工具栏图标：剪藏整页
- 右键菜单「剪藏选中内容到 NoteLume」：只剪选中的片段（先在页面上选中文字），走内置 highlight 模板（来源行进引用块）
- 右键菜单「剪藏整页到 NoteLume」：同工具栏图标

提取按优先级降级：Defuddle → Readability + Turndown →（设置开了才有）整页 HTML。选区剪藏不走提取器，划了什么存什么。图片本地化默认关：正文保留原链接；在 NoteLume 设置里打开后，扩展才把图 fetch 成 data URI 随载荷传来，落 `<目标目录>/assets/`。

处理中图标徽标转圈，成功 / 失败都有系统通知，通知里带落盘路径、图片数与关联篇数（图片段只在本地化开启且有图落盘时出现）。

## 失败提示对照

| 提示 | 原因 |
| --- | --- |
| 连不上 NoteLume | 应用没启动，或剪藏服务没启用，或地址端口不对 |
| 请先打开一个知识库 | NoteLume 开着但没开库 |
| 内容超过大小上限 | 单次载荷超 8MB、正文超 2MB、单图超 5MB |
| 页面提取失败 | Defuddle 与 Readability 都没有结果，且整页兜底关着（默认） |
| 没有选中内容 | 选了「剪藏选中内容」但页面上没有选区 |
| 请求超时 | 15 秒没等来响应 |

## 安全边界

服务只绑 `127.0.0.1`，不带令牌：请求带 `Origin` 时必须是扩展来源（`chrome-extension://` / `moz-extension://`），网页的 fetch 与表单提交到不了；`Host` 必须是回环名，DNS rebinding 到不了。本机其他进程写得了库里的文件，HTTP 服务没给它们新能力，为此设令牌只会把复制粘贴的成本转嫁给正常用户。
