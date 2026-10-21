# 网页剪藏设计

- 日期：2026-10-21
- 计划：`docs/superpowers/plans/2026-10-21-web-clip-plan.md`
- 目标：从浏览器把网页正文存进 NoteLume 知识库，落盘为标准 GFM md，并自动关联库内已有笔记

## 1. 链路

```
浏览器扩展（Readability + Turndown）
  → POST http://127.0.0.1:<port>/clip（JSON，X-NL-Token 头）
  → Tauri 主进程内的本地 HTTP 服务（Rust 线程）
  → 按模板渲染、图片进 assets/、写盘到 Clippings/
  → VaultIndex 打分算相关笔记，文末追加「## 相关笔记」
  → emit nl:clip-saved → 前端刷文件树 + 状态栏提示
```

扩展在 `extension/`（MV3，无构建）；Rust 侧是新模块 `src-tauri/src/webclip.rs`；前端新增 `src/clip-settings.js` 设置面板与 boot 里的事件监听。

## 2. 本地 HTTP 服务

只绑 `127.0.0.1`。三个路由：`POST /clip`、`GET /health`、`OPTIONS`（预检）。手写 `std::net::TcpListener`，不引 crate：协议面只有这三条，请求解析（`\r\n\r\n` 分帧 + `Content-Length`）与响应拼装约 150 行。listener 设 nonblocking，accept 循环每 5ms 查一次关闭标志；每连接一线程。

端口默认 3210，占用时顺延 `+1` 至多 10 个，实际端口记进运行态并经 `/health` 与设置面板回显。

安全闸门两道，全部在响应前校验，不带令牌：

1. `Origin` 头存在时必须是 `chrome-extension://` 或 `moz-extension://` 开头，否则 403。浏览器里恶意网页的 fetch 与表单提交必带 http(s) Origin，到不了 `/clip`
2. `Host` 头去端口后必须是 `127.0.0.1` / `localhost` / `::1`，否则 403（挡 DNS rebinding）

不带 Origin 的请求（Firefox 扩展、curl、本机进程）放行。2026-10-21 修订：原设计有第三道 `X-NL-Token` 令牌闸门，实现后撤掉——它唯一能防的「恶意网页直连本机端口」已被 Origin 检查完整覆盖，而它真正区别对待的「本机其他进程」本来就能直接写库里的文件，HTTP 服务没给它们任何新能力。令牌的成本（每个用户找令牌、复制、粘贴、同步改）是实的，收益是虚的。

载荷上限 8MB、markdown 2MB、单图 5MB，超限 413。

## 3. 落盘

模板取库内 `Templates/` 下用户选的 md，读取失败或未选时用内置默认模板（frontmatter + 标题 + 引述 + 正文）。扩展选项页填了目录 / 模板时按载荷的单次覆盖走。变量与 `src/template.js` 的 `applyTemplate` 同语义：`{{token}}` 两侧允许空格，未知 token 原样保留。剪藏扩展的变量：`title` `url` `site` `author` `description` `published` `content` `tags`（逗号分隔，frontmatter 用）`hashtags`（`#a #b`，正文用）`date` `time` `datetime` `year` `month` `day` `weekday`（本地化周名，走后端词表）。

目标目录默认 `Clippings/`。文件名模式默认 `{{date}}-{{title}}`，渲染后替换 `\ / : * ? " < > |` 与控制字符、去首尾空格与点、截断 80 字符，空则 `untitled`；重名追加 `-2`。写盘复用 `vault_join` + 父目录 canonicalize 后 `starts_with(root)` 的越界校验，与 `write_md_file` 同一套。

图片：扩展把取到的图转成 data URI 随载荷传来（`images[{url,dataUri}]`）。Rust 解码后写进 `<目标目录>/assets/`，命名取 URL 主名（sanitize 后），同内容复用（`fnv1a` 比对），不同内容追加指纹后缀；markdown 里的远程 URL 替换为 `./assets/<name>`。没有 data URI 的图：Windows 上试一次 `download_remote` 兜底，其余平台与失败情况保留远程 URL，不阻断剪藏。

## 4. 自动关联

写盘后用 `VaultIndex` 的既有条目打分，只往新剪藏文末追加 `## 相关笔记` 段，链接形如 `- [[/目录/文件名|标题]]`（根绝对形式、不含 `.md`）——剪藏文档多在一级子目录，相对路径会因参照目录不同解析不到。不改任何已有笔记——反向连接由现有反链面板在索引更新后自然呈现。

打分（每条文档）：

- 标签交集 × 3（clip 的 `tags` 与文档 tags，小写比较）
- 标题词重叠 × 2（词见下）
- 正文命中 × 1（每个词封顶 3 次）

词提取：拉丁词小写后取 4 字符以上、去过停用词表；CJK 取 2 字滑窗。输入为 clip 的 title、excerpt、siteName。0 分不入列，按分数降序、路径升序取前 `maxLinks`（默认 5）。索引未就绪（没开库或正在重建）时跳过关联，响应里带 `linked: 0`。

设置 `clip.autoLink` 关掉则整段跳过。不做正文内联加链接：会改用户正文，风险大于收益。

## 5. 前端

设置面板 `src/clip-settings.js`（模态壳沿用外观设置那套）：启用开关、端口、令牌（展示 + 复制 + 重新生成）、目标目录、模板下拉、文件名模式、自动关联开关与上限、剪藏后打开开关。改动经 main.js 的 settingsStore 写 `clip` 段并 flush，随后调 `clip_server_apply` 重启服务（点火式，不等返回）。`clip` 段结构：

```json
{
  "enabled": false,
  "port": 3210,
  "token": "",
  "folder": "Clippings",
  "template": "",
  "filename": "{{date}}-{{title}}",
  "autoLink": true,
  "maxLinks": 5,
  "openAfterSave": false
}
```

命令 `app.clipSettings` 进命令注册表，工具条「更多」菜单与命令面板两个入口。boot 里监听 `nl:clip-saved`：刷新文件树、状态栏出「已剪藏：{rel}（关联 n 篇）」；`openAfterSave` 为真时顺带打开。

后端错误文案（无知识库 / 令牌不符 / 来源不允许 / 超限 / 写盘失败等）走 `ui_lang.rs` 五语言词表，前端界面文案进 `src/locales/` 五份词条。

## 6. 浏览器扩展

`extension/` 下 MV3，无构建、无 npm：`vendor/Readability.js` 与 `vendor/turndown.js` 直接放入。`background.js` 是 service worker：点工具栏图标剪藏整页，右键菜单两条（剪藏选中内容 / 剪藏整页）。提取用 `chrome.scripting.executeScript` 按需注入（`activeTab` 权限，不常驻 content script）：`content/extract.js` 在页面里跑 Readability + Turndown（`headingStyle: atx`、`codeBlockStyle: fenced`），一次返回整页与选中片段两份 markdown，采集 `og:*` / `article:published_time` / `author` / `keywords`，图片 URL 列表回传后台；跨域图由后台 fetch 转 data URI（`host_permissions: <all_urls>`），失败留远程 URL。`options.html` 配服务器地址、令牌与可选的默认目录 / 模板（填了就是对每次剪藏的单次覆盖），存 `chrome.storage.sync`。

错误分类提示：网络错误（应用没开）、401（令牌不匹配，引导去选项页）、409（没开知识库）。

## 7. 分支与兼容

扩展与桌面侧改动都在 `master`，与 `web` 分支无关（`web` 不收桌面产物）。剪藏写出的 md 是标准 GFM + 库内相对路径图片链接，Typora / Obsidian 直接可读。Rust 改动含新模块与 `lib.rs` 接线，须重启 `tauri dev` 重编生效。
