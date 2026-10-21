# 网页剪藏（浏览器扩展 → 本地 HTTP → Rust 落盘 → 自动关联）—— 实现计划

- 日期：2026-10-21
- 设计依据：`docs/superpowers/specs/2026-10-21-web-clip-design.md`（随本计划提交，评审后进入实现）
- 链路：扩展提取正文（Readability + Turndown）→ POST `http://127.0.0.1:3210/clip` → Rust 按模板渲染、图片进 `assets/`、写盘 → 用 `VaultIndex` 算相关笔记并追加 `## 相关笔记` 段 → emit `nl:clip-saved` → 前端刷文件树、状态栏提示
- 总门禁（每相结束跑）：`cargo test --lib` 全绿；`cd src && node tests/*.test.mjs` 全绿；`npm run build` 无错。含 Rust 的相须重启 `tauri dev` 重编生效
- 分相：P1 Rust 纯逻辑 → P2 HTTP 服务与装配 → P3 前端设置与通知 → P4 浏览器扩展 → P5 文档，每相一个 commit

## 关键设计决策

1. 本地 HTTP 服务手写 `std::net::TcpListener`，不引 crate。协议面只有 `POST /clip`、`OPTIONS` 预检、`GET /health` 三个，解析加响应约 150 行；引 `tiny_http` 一类 crate 只省这点代码，多一份依赖维护。
2. 只绑 `127.0.0.1`，不绑 `0.0.0.0`。端口默认 3210，占用时顺延尝试至多 10 个，实际端口记进 `ClipServerState` 并经 `/health` 与设置界面回显。
3. 来源闸门，不带令牌（2026-10-21 修订，原设计含 `X-NL-Token` 令牌闸门，撤掉）：`Origin` 存在且不是 `chrome-extension://` / `moz-extension://` 开头的一律拒（浏览器里恶意网页的 fetch 与表单提交必带 http(s) Origin，到不了 `/clip`）；`Host` 必须是 `127.0.0.1` / `localhost`（挡 DNS rebinding）。令牌唯一能防的场景已被 Origin 检查覆盖，而它区别对待的本机其他进程本来写得了库里的文件，为它让每个用户复制粘贴不划算。CORS 预检返回 `Access-Control-Allow-Origin: *`，放开 Origin 是为了扩展的 service worker 能发请求。
4. 载荷为 JSON，上限 8MB，单图 5MB、markdown 2MB，超限 413。字段：`title` `url` `byline` `excerpt` `siteName` `published` `markdown` `tags[]` `images[{url,dataUri}]` `template` `folder` `clipType`（`page` / `selection`）。目录与模板填了就是对本次剪藏的单次覆盖，不填用设置里的值。
5. 图片由扩展侧 fetch 成 data URI 再随载荷传来（扩展有 `<all_urls>` 权限，页面内图基本取得到），Rust 复用既有 `b64_decode` + `fnv1a` 内容去重落 `assets/`，并把 markdown 里的远程 URL 改写为相对路径；取不到的图保留远程 URL（GFM 合法），Windows 上再走现有 `download_remote` 兜底，非 Windows 不兜底。
6. 模板取库内 `Templates/` 下的一个 md（设置里选），Rust 起服务/重启时读入；没选或读失败用内置默认模板。变量与 `src/template.js` 同语义（未知 `{{token}}` 原样保留）：`{{title}}` `{{url}}` `{{site}}` `{{author}}` `{{date}}` `{{time}}` `{{datetime}}` `{{description}}` `{{content}}` `{{tags}}` `{{year}}` `{{month}}` `{{day}}` `{{weekday}}`。
7. 落盘位置：目标目录默认 `Clippings/`（设置可改）；文件名模式默认 `{{date}}-{{title}}`，替换 `\ / : * ? " < > |` 与控制字符、长度封顶 80，重名追加 `-2`、`-3`。越界校验复用 `vault_join` + 父目录 canonicalize 后 `starts_with(root)`，与 `write_md_file` 同一套。
8. 自动关联是单向的：只往新剪藏文末追加 `## 相关笔记` 段（链接用 `[[库内相对路径（不含 .md）]]`），不改任何已有笔记；反向连接由现有反链面板自然呈现（`update_index_doc` 注册 outgoing 后即生效）。打分信号三条：标签交集（权重 3）、标题词重叠（2，CJK 按 2 字滑窗、拉丁取 4 字符以上词）、正文关键词命中（1，封顶 3 次），排除自身与 0 分，取前 `maxLinks`（默认 5）。索引未就绪（没开库或正在重建）时跳过关联，响应里带原因。不做正文内联加链接——会改用户正文，风险大于收益。
9. 前端不自动打开剪藏（打断当前编辑），只刷文件树 + 状态栏消息；设置里给 `openAfterSave` 开关，默认关。
10. 扩展为新顶层目录 `extension/`，MV3、无构建无 npm：`vendor/Readability.js` 与 `vendor/turndown.js` 直接放入。注入用 `chrome.scripting.executeScript`（`activeTab` 权限，不常驻 content script），点击工具栏图标剪藏整页，右键菜单「剪藏选中内容」。改动全在 master，与 `web` 分支无关。

## P1 Rust 纯逻辑（新模块 `src-tauri/src/webclip.rs`）

- 类型 `ClipPayload`（`Deserialize`，camelCase，与既有 `CreateDocArgs` / `ImportArgs` 同风格）与 `ClipOutcome { rel, title, linked, images_saved, images_failed }`。
- `render_template(tpl, vars)`：与 `template.js` 的 `applyTemplate` 同语义，正则 `\{\{\s*([A-Za-z0-9_]+)\s*\}\}`，未知 token 原样保留。
- `clip_vars(payload, now)` + `clip_filename(pattern, vars)`：日期格式支持 `YYYY YY MM M DD D HH mm ss`（一次正则最长优先，同 `formatDate` 做法）；title 为空时回落 url host，再回落 `untitled`。
- `write_clip(vault_root, payload, cfg)`：读模板（失败回落内置默认，默认模板内含 frontmatter：title/source/site/author/clipped/tags）→ 渲染 → 文件名去重 → 逐图 b64 解码落 `assets/` 并改写 markdown 中的图片 URL → 写 md。返回 `ClipOutcome`。
- `related_docs(index: &VaultIndex, payload, limit)`：纯函数打分，返回 `Vec<(path, title)>`。
- `append_related(md, links)`：文末已有 `## 相关笔记` 标题行则在其后插列表，否则文末追加整段。
- 索引侧两个前置改动：`DocEntry` / `VaultIndex` 字段提升为 `pub(crate)`；`update_index_doc` 的核心抽成 `index_doc_into(g: &mut VaultIndex, path, content)`，命令层与 webclip 共用（避免剪藏写盘后索引对不上）。
- 新增单测（`webclip.rs` 内 `#[cfg(test)]`）：模板未知 token 保留、日期格式大小写（`MM`=月 / `mm`=分）、文件名 sanitize 与 80 字封顶、重名追加 `-2`、data URI 解码落盘与同内容去重、`related_docs` 打分（标签交集胜过正文命中、排除自身、0 分不入列、limit 截断、CJK 2 字滑窗命中中文标题）、`append_related` 两种落点都不重复追加、`index_doc_into` 后 backlinks 反向可查。

## P2 HTTP 服务与装配

- `webclip.rs` 续：`parse_request(bytes) -> Option<(method, path, headers, body)>` 纯函数（手写，只认 `\r\n\r\n` 分帧 + `Content-Length` 读 body，chunked 不支持直接 400）；`handle_request(...)` 分派三个路由并产出响应字节；`serve_loop(listener, shared, shutdown)`：listener 设 nonblocking，`WouldBlock` 时 sleep 5ms 查 `AtomicBool`，每连接起一线程（剪藏是低频人工操作，一线程一连接足够）。
- `lib.rs`：`mod webclip;`；新增托管状态 `ClipServerState(Arc<Mutex<ClipConfig>>)`（`{ enabled, port, token, folder, template, filename, auto_link, max_links, bound_port }`）；`setup` 里读 settings.json 的 `clip` 段，启用则起服务；`invoke_handler` 加 `clip_server_apply`（前端改设置后调，停旧起新）与 `clip_server_status`（回显 running/port/token）。
- 剪藏落盘成功后：`index_doc_into` 更新索引 → `app.handle().emit("nl:clip-saved", { path, title, linked })`（`use tauri::Emitter`，同 `on_menu_event` 先例）。
- 错误码：401 令牌不符、409 没开知识库（`IndexState.vault_root` 为空）、413 超限、400 畸形请求；响应体统一 `{ ok, code?, message? }`，message 走后端词条（`ui_msg!`）。
- 新增单测：`parse_request` 正常 POST / 缺 `Content-Length` / 超大 `Content-Length` 拒收 / `OPTIONS` 分派；集成测试起 `127.0.0.1:0` 临时端口，`TcpStream` 发手工拼的 POST（含一张 1×1 PNG 的 data URI），断言 200、文件落盘、关联段生成、错误 token 得 401、无 vault 得 409。

## P3 前端设置与通知

- 新 `src/clip-settings.js`：设置面板含启用开关、端口、令牌展示 + 重新生成、目标目录、模板下拉（列 `Templates/` 下 md，复用 `listMdInDir` 的思路）、文件名模式、自动关联开关与上限、保存后打开开关。读写走 `settings-store.js` 的 `clip` 段，保存后调 `clip_server_apply`（不等返回的点火式，同 `setUiLang`）。
- `src/main.js`：注册 `app.clipSettings` 命令（工具条「更多」菜单 + 命令面板，图标 `clipboard`，`src/icons.js` / sprite 已有）；boot 里 `listen('nl:clip-saved')` → `renderTree(await scanVault(state.vaultRoot))` + `setStatus`；`openAfterSave` 为真时顺带 `openFile(path)`。
- 五语言词条 `src/locales/{zh-CN,zh-Hant,en-US,fr-FR,de-DE}.js` 新增 `clip.*` 与 `cmd.app.clipSettings`；`src-tauri/src/ui_lang.rs` 补后端词条（`clip.noVault` / `clip.badToken` / `clip.tooLarge` / `clip.writeFailed` 等，五语言齐）。
- 门禁：前端测试全绿 + `npm run build`；无头 Chromium 冒烟：设置面板改端口 → apply → `/health` 返回新端口；发一条 `nl:clip-saved` 后树刷新、状态栏出文案。

## P4 浏览器扩展（新目录 `extension/`）

- `manifest.json`：MV3，`permissions: activeTab scripting storage contextMenus`，`host_permissions: <all_urls>`（后台取图用）。
- `background.js`：action 点击 → `executeScript` 注入 `vendor/Readability.js`、`vendor/turndown.js`、`content/extract.js` → 收 payload → 补 `images`（跨域图由后台 fetch 转 data URI，失败留远程 URL）→ POST `/clip`（10s 超时）。右键菜单两条：剪藏选中内容（`selection` 为真）、剪藏整页。处理中 badge 转圈，失败按错误码给通知：网络错误（应用没开，提示先启动 NoteLume）、401（令牌不匹配，按钮直达选项页）、409（没开知识库）。
- `content/extract.js`：`Readability.parse()` → Turndown（`headingStyle: 'atx'`、`codeBlockStyle: 'fenced'`、`bulletListMarker: '-'`）→ 采 `article:published_time` / `author` / `keywords` / `og:site_name` → 回传。
- `options.html` / `options.js`：服务器地址（默认 `http://127.0.0.1:3210`）、令牌、默认模板与目录，存 `chrome.storage.sync`。
- `vendor/Readability.js`、`vendor/turndown.js` 原样放入，不建构建链。
- 手验（Edge 加载已解包扩展）：文章页 / 含多图页面 / 选中片段各剪一次，核对落盘文件名、`assets/` 去重、`## 相关笔记` 段内容；应用没开时的提示；设置里改令牌后扩展得 401 提示。

## P5 文档

- `CHANGELOG.md` Unreleased/Added 一条，含实测段（Rust 单测数与前端测试数、扩展三个站点的手验结果、未实测项按惯例列明）。
- `docs/CLAUDE.MD` 新增「网页剪藏」节：链路四段、端口与令牌规则、模板变量表、关联打分规则、安全边界（只绑回环、Origin/Host 检查、大小上限）。
- `docs/superpowers/specs/2026-10-21-web-clip-design.md`：设计依据，本计划引用其决策。
- `README.md` 补一小节：安装扩展、填地址与令牌、三个剪藏入口。

## 风险与回滚

- 服务线程 emit 需 `AppHandle` clone 进线程；`setup` 里起服务时窗口可能未就绪，emit 只发事件不依赖窗口，前端 boot 后监听即达（与 `file-opened` 队列不同的地方是剪藏没有冷启动排队需求——应用没开时请求本就到不了）。
- 端口被占：顺延逻辑兜底 + `/health` 与设置界面显示实际端口，扩展侧地址可改。
- 恶意网页直连本机端口：令牌 + Origin/Host 双重检查挡在上层；最坏情况是知道令牌的本机用户程序，与本项目「本地文件直接可读写」的信任模型一致。
- 大页面与慢网：载荷上限 413 明确拒绝；图片取不到不阻断，保留远程 URL。
- 回滚粒度 = commit：P1/P2 是新模块 + `lib.rs` 少量接线（`mod webclip`、状态托管、两条命令、一次 emit），整体 revert 即回到无服务状态；P3/P4/P5 相互独立。
