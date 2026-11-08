# 设计：NoteLume 云端版（与桌面端功能等价）

- 状态：设计完成，待 Phase 0
- 日期：2026-11-08
- 范围：云端 Web 应用，多用户、浏览器访问；不替代桌面端
- 来源：2026-11-08 用户指令「写一个云端的 spec，功能和桌面端等价，另起一章；如果当前技术选型达不到要求，可另找技术选型」
- 技术基线：Rust + Axum + PostgreSQL + S3 兼容对象存储；前端继续用 Vanilla JS + ProseMirror
- 一句话：云端不是 Tauri 套壳，也不是 `web` 沙盒的升级；把桌面端拆成可复用的 `note-core`、浏览器前端与多租户服务三部分。

## 一、目标与“等价”的定义

### 1.1 等价指任务等价，不是实现等价

桌面版是本地文件夹 + Tauri 窗口；云端版是浏览器 + 服务端工作区。两者不可能用同一套平台层。本文把“功能等价”定义为：用户能在云端完成桌面版里同样的写作、整理、检索、AI、导出与 Git 任务，md 仍是标准 GFM，数据不被锁进私有格式。

不承诺逐项同构的四类能力：

- 本地绝对路径、系统文件管理器、文件关联、托盘、窗口菜单、多窗口、自动更新。
- Windows 原生听写。
- 离线编辑。云端首版只做在线编辑与只读缓存；完整离线要本地优先同步层，单独立项。
- 任意第三方插件。桌面插件同权运行，云端必须换安全模型；首版不开放任意插件，沙盒插件放 Phase 5。

### 1.2 首版验收判据

- 新用户注册 / OIDC 登录后创建工作区，导入一个含 200 篇 md 的文件夹或 zip，文件树、标签、反链、搜索、AI 全部可用。
- 两人同时编辑不同文档不互相覆盖；同一文档并发保存时后写者收到 409 并可选择重载或覆盖。
- 编辑一篇 1MB md（中文、表格、代码块、图片、公式），保存后下载与桌面版逐字节一致。
- Git 面板在云端完成 init / commit / fetch / pull / push；Web 剪藏通过云端 HTTPS 端点落库。
- 单篇 HTML、幻灯片、整站导出可下载；docx 导入导出可用；PDF 走浏览器打印。
- 50 个并发读者 + 10 个写者下，搜索 p95 < 300ms，打开文档 p95 < 500ms。
- 备份与恢复演练通过；跨工作区越权访问全部 403。

### 1.3 明确不做

- 不做 Tauri 桌面壳的远程托管，不做每个用户一台桌面进程。
- 不把 `web` 分支的 Node 沙盒服务端直接升成云端；它没有鉴权、多租户、持久化索引与 Git/导出能力。
- 不把云端代码合进 `master`。硬性约束 8 要求 `master` 只收桌面改动；云端走独立 `cloud` 分支或独立仓库。
- 不做实时协同编辑（OT / CRDT）作为首版能力；首版用版本号乐观锁，协同单独立项。
- 不自建对象存储与数据库；生产用托管 PostgreSQL / S3，开发用 Docker Compose。
- 不做计费、发票、企业 SSO、审计导出等商业化能力；只留接口。

## 二、现状与为什么不能直接搬 Tauri

### 2.1 桌面端可复用的部分

| 部分 | 现状 | 云端用法 |
| --- | --- | --- |
| 编辑器与 schema | `src/editor-view.js`、`src/editor-schema.js` | 原样复用，ProseMirror 不依赖 Tauri |
| Markdown 解析 / 序列化 | `src/editor-schema.js`、`src/tests/roundtrip.test.mjs` | 原样复用，云端与桌面共用一份协议 |
| UI 壳与面板 | `src/main.js`、`src/tabs.js`、`src/split-pane.js`、`src/ai-panel.js` 等 | 通过传输层替身复用，不重写 UI |
| 命令注册表 | `src/commands.js` | 云端 shim 保留同一套命令 id |
| index / 反链 / 标签 | `src-tauri/src/lib.rs` 的 `VaultIndex` | 抽到 `note-core`，存储适配器换成对象存储 |
| Quarkdown | `src-tauri/src/qd/` | 纯 Rust，原样抽到 `note-core` |
| docx 导入导出 | `src-tauri/src/docx_import.rs`、`docx_export.rs` | 纯 Rust，服务端执行 |
| AI SSE | `src-tauri/src/ai.rs` | 复用解析与流式逻辑，换 per-user 配置与密钥加密 |
| 导出渲染 | `src/site-export.js`、`src/slides-export.js`、`src/plain-export.js` | 浏览器端生成下载，避免引入 headless Chromium |
| 大文件虚拟化 | `src/virtual/` | 原样复用；服务端按整文件读，限制单文件大小 |
| 五语言 / 主题 / 快捷键 | `src/locales/`、`src/appearance-settings.js`、`src/keymap.js` | 原样复用，设置改存服务端 |

### 2.2 不能直接复用的部分

| 阻断 | 现状 | 后果 |
| --- | --- | --- |
| Tauri 是桌面壳 | 窗口、托盘、原生菜单、单实例、文件关联、自动更新都在 Tauri 里 | 云端没有这些进程模型，服务端不能跑 Tauri 窗口 |
| 命令层与 Tauri 耦合 | `src-tauri/src/lib.rs` 通过 `tauri::generate_handler!` 注册，命令直接拿 `AppHandle` / `State` | 不能直接把 `lib.rs` 挂到 HTTP 服务上；必须抽出 `note-core` |
| 存储是本地绝对路径 | `vaultRoot` 是绝对路径，`std::fs`、`canonicalize`、`notify`、`trash` 遍布命令 | 多租户云端需要对象存储 + 元数据事务，不能共享服务器文件系统 |
| 无鉴权、无租户 | 桌面默认单用户，`settings.json` 是应用私有文件 | 云端必须补用户、会话、工作区、成员、RBAC、审计 |
| `web` 分支是沙盒 | `server/` 是 Node 单用户服务，零鉴权、内存索引、无 Git/docx/导出，且 `web → master` 禁止 | 只能借鉴 `src/web/` 的传输替身与构建 alias，不能当云端后端 |
| 设置存本地 | `settings-store.js` 在浏览器回落 localStorage，桌面写 `app_config_dir` | 云端要跨设备一致，设置必须进数据库 |
| 剪藏绑本机回环 | `webclip.rs` 只绑 `127.0.0.1`，端口顺延，靠本机扩展访问 | 云端要 HTTPS 端点、工作区 token、CORS 与限流 |
| Git 依赖本地仓库 | `git2` / 系统 git 直接操作库根 | 云端仓库在服务端卷或独立 Git 服务，凭据要加密 |

## 三、技术选型

### 3.1 结论

| 层 | 选型 | 理由 |
| --- | --- | --- |
| 后端 | Rust + Axum 0.8+ + Tokio | 复用现有 Rust 内核；Axum 的 Tower 中间件、SSE、WebSocket 与类型化 extractor 适合多租户 API |
| 数据库 | PostgreSQL 16+，`sqlx` + 迁移 | 事务、行级锁、`SKIP LOCKED` 任务队列、成熟备份；不引 ORM |
| 文件存储 | S3 兼容对象存储（生产 S3 / R2 / MinIO；开发 MinIO） | 多副本、版本、生命周期、按 key 前缀隔离工作区；不自建文件服务器 |
| 本地开发存储 | `FsVaultStore`（本地卷） | 与 S3 同一 `VaultStore` 接口，开发不用起 MinIO 也能跑 |
| 搜索 | Tantivy + `jieba-rs` | 中文分词与倒排索引在进程内；不依赖外部搜索集群；单节点首版 |
| 前端 | 现有 Vanilla JS + ProseMirror，构建期替身接 HTTP/SSE | 不重写编辑器；`web` 分支已验证 alias 方案 |
| 认证 | 本地邮箱密码（Argon2）+ OIDC（GitHub / Gitee / Google） | 兼顾自托管与 SaaS；不把账号体系绑死在某一家 |
| 会话 | PostgreSQL session 表 + HttpOnly Cookie + CSRF token | 多实例可共享；不引 Redis 作为首版硬依赖 |
| 实时 | SSE（AI 流、索引进度、变更通知）；WebSocket 留给后续协同 | SSE 简单、可过反代；协同不是首版 |
| 部署 | Docker Compose（app / indexer / postgres / minio / caddy） | 单机可复现；托管环境替换为 RDS + S3 + LB |
| 代码线 | 长期 `cloud` 分支或独立仓库，`master → cloud` 定期合并，`cloud → master` 禁止 | 遵守硬性约束 8；不把服务端代码塞进桌面主干 |

### 3.2 否掉的方案

- **Tauri 远程壳**：把桌面 exe 跑在服务器上，浏览器远程桌面。多人并发成本高、无租户隔离、文件权限仍是 OS 权限，不适合云端。
- **继续 Node 后端**：`web` 分支的 Node 服务是单用户沙盒，重写 Git / docx / Quarkdown / 索引等于把 Rust 内核再实现一遍；与复用优先冲突。
- **Go / Java 重写后端**：性能不是瓶颈，重写会丢掉 `qd`、`docx`、`mdparse`、AI SSE 的既有实现与测试。
- **纯 Yjs / CRDT 协作平台**：协作强，但桌面端没有协作语义，首版会把复杂度压在编辑器状态层；先把单写多读与冲突提示做稳。
- **只用 PostgreSQL 存大文本**：md 与图片进数据库会失去“库就是文件夹”的导出/备份直观性；对象存储保留 key 即路径。
- **把 `web` 分支整体合并**：硬性约束 8 明确禁止；云端的鉴权、多租户、持久化索引都不是沙盒的增量。

## 四、架构

### 4.1 分层

```
浏览器（现有 src/ + cloud shim）
  ├─ POST /api/invoke       命令 RPC，参数形状对齐 Tauri
  ├─ GET  /api/events       SSE：AI 流、索引进度、文档变更
  ├─ POST /api/files        上传（小文件 base64 / 大文件预签名）
  └─ GET  /api/download     导出 / 附件下载

Axum API（cloud/api）
  ├─ auth / session / CSRF / rate-limit middleware
  ├─ workspace / membership / RBAC guard
  ├─ command dispatcher → note-core
  ├─ git worker
  ├─ index worker
  ├─ webclip endpoint
  └─ AI proxy

note-core（Rust crate，桌面与云端共用）
  ├─ markdown 解析 / 序列化 / 索引 / 反链 / 标签
  ├─ Quarkdown 引擎
  ├─ docx 导入导出
  ├─ 导出图构建
  ├─ Git 纯逻辑（git2）
  └─ AI SSE 解析与请求构造

存储适配器
  ├─ LocalVaultStore（桌面 std::fs）
  ├─ FsVaultStore（云端开发 / 单机卷）
  └─ S3VaultStore（生产对象存储）

PostgreSQL
  ├─ 用户、会话、工作区、成员、邀请
  ├─ 文档元数据、版本、软删除、审计
  ├─ 索引任务、导出任务、Git 凭据引用
  └─ 设置、API token、Web 剪藏 token
```

### 4.2 `note-core` 抽取

这是云端的 Phase 0 前置，也是最大的一次结构改造。

从 `src-tauri` 抽到 `crates/note-core`：

- `vault`：`normalize_rel`、`abs_in_vault`、`ensure_inside_root` 的纯逻辑；桌面与云端共用。
- `index`：`VaultIndex`、`scan`、`build_index`、`search`、`query_backlinks`、`query_outgoing`、`get_doc_info`、`list_all_tags`、`query_tag`、`doc_preview`。
- `markdown`：现有 `mdparse.rs` 的纯解析对拍逻辑；`[[wikilink]]` / `#tag` / 标题抽取。
- `qd`：整块原样搬。
- `docx`：`docx_import.rs` / `docx_export.rs`，把文件读写换成 `VaultStore` / 临时文件注入。
- `export`：`build_site_graph`、`copy_vault_assets` 的纯图构建；渲染仍在 JS。
- `git`：`git_builtin.rs` 的纯操作；仓库根由调用方注入。
- `ai`：SSE 行解析、请求体构造、错误体解析；HTTP 客户端由调用方注入。
- `path` / `ui_lang`：原样搬。

桌面端保留 `src-tauri` 作为 adapter：Tauri 命令、窗口、托盘、文件选择器仍在这里；命令体改为调用 `note-core`。云端 `cloud/api` 直接调用 `note-core`，不经过 Tauri。

验收：桌面端 `cargo test --lib` 全量通过；`note-core` 的单测在桌面与云端各跑一遍；同一份 fixture 的索引/搜索/反链结果一致。

### 4.3 `VaultStore` 接口

```rust
pub trait VaultStore: Send + Sync {
    fn list_all(&self, ws: &WorkspaceId) -> Result<Vec<Entry>>;
    fn stat(&self, ws: &WorkspaceId, rel: &str) -> Result<Stat>;
    fn read_text(&self, ws: &WorkspaceId, rel: &str) -> Result<FileText>;
    fn read_many(&self, ws: &WorkspaceId, rels: &[String]) -> Result<Vec<FileText>>;
    fn write_text(&self, ws: &WorkspaceId, rel: &str, text: &str, expect: Option<&str>) -> Result<WriteResult>;
    fn create_dir(&self, ws: &WorkspaceId, rel: &str) -> Result<()>;
    fn delete(&self, ws: &WorkspaceId, rel: &str) -> Result<()>;
    fn rename(&self, ws: &WorkspaceId, from: &str, to: &str) -> Result<()>;
    fn read_bytes(&self, ws: &WorkspaceId, rel: &str) -> Result<Vec<u8>>;
    fn write_bytes(&self, ws: &WorkspaceId, rel: &str, bytes: &[u8]) -> Result<WriteResult>;
}
```

- `expect` 是乐观锁：客户端带上次读到的 `etag` / `version`；不匹配回 `conflict`。
- 桌面 `LocalVaultStore` 用 `std::fs` + 临时文件 + rename；云端 `S3VaultStore` 先 PUT blob 再事务更新元数据。
- 路径规则统一：只接受工作区内相对路径，拒绝 `..`、绝对路径、空段、盘符。
- 所有 key 前缀 `ws/<workspace_id>/vault/`，对象存储层再做一次前缀校验，防越权。

### 4.4 API 表面

命令面沿用桌面 `tauri-bridge.js` 的 80 多个函数，云端 shim 映射到：

| 端点 | 用途 |
| --- | --- |
| `POST /api/invoke` | `{cmd, params}`；返回 `{ok, result}` / `{ok:false, code, error}`；与 Tauri invoke 同形 |
| `GET /api/events` | SSE；`nl:ai-event`、`nl:index-status`、`nl:doc-changed`、`nl:git-event` |
| `POST /api/files/upload` | 小文件 multipart / base64；返回 `{rel, size, etag}` |
| `POST /api/files/presign` | 大文件直传 S3 的预签名 URL；完成后回调登记 |
| `GET /api/files/download?path=` | 附件 / 导出下载；`Content-Disposition` |
| `POST /api/export` | 异步导出任务；返回 job id，SSE 通知完成 |
| `GET /healthz` / `GET /metrics` | 健康检查与 Prometheus 指标 |

为什么保留 `/api/invoke` 而不是全 REST：

- 现有前端只通过 `tauri-bridge.js` 与三个 Tauri 包调用；`web` 分支已验证“替换传输层、UI 不动”的可行性。
- 80 多个命令逐个设计 REST 路由会拉长首版，且前端要改 60 多个模块。
- 代价是 RPC 面较粗；用 `cmd` 白名单、参数校验、统一 RBAC 中间件兜住，不让它变成万能代理。

### 4.5 索引与搜索

- 每个工作区一个 Tantivy 索引，落在索引节点本地持久卷 `index/<workspace_id>/`。
- 写文档后插入 `index_jobs`（Postgres），索引 worker 用 `FOR UPDATE SKIP LOCKED` 取任务；支持全量重建与增量更新。
- 中文用 `jieba-rs` 分词；英文按空白与标点；保留文件名、标题、标签、正文四个字段，返回结构与桌面 `search_vault` 一致。
- 索引状态通过 `GET /api/invoke` 的 `get_index_status` 与 SSE `nl:index-status` 双通道给前端；索引未就绪时搜索回空并显示进度，不阻塞编辑。
- 多实例扩展：首版单索引 worker；后续把索引换成 OpenSearch / Meilisearch 或每实例本地索引 + 广播失效。

### 4.6 AI

- 复用 `ai.rs` 的 SSE 行解析、`delta.content` / `reasoning` / tool_calls 累积、错误体提取。
- 每个用户存自己的 AI 配置；API Key 用 AES-256-GCM 加密，KEK 来自环境变量或云 KMS，密文进 Postgres。
- AI 请求从 API 服务发出，不经浏览器；SSE 通过 `/api/events` 回传。
- SSRF 防线：
  - 只允许 `http` / `https`；默认拒绝环回、链路本地、云元数据地址（`169.254.169.254` 等）与私有网段。
  - 工作区管理员可显式开启“允许私有网段”，用于局域网 Ollama；开启后仍记录审计。
  - DNS 解析后再校验 IP，防 DNS rebinding；重定向逐跳校验。
  - 限制响应大小、超时、并发与每用户配额。
- Agent 工具循环仍在前端驱动（`ai-agent.js` 不改）；工具调用走 `/api/invoke` 的只读命令，服务端按用户权限再校验一遍。

### 4.7 Git

- 每个工作区一个服务端 Git 仓库，落在持久卷 `git/<workspace_id>/`；首版单节点，Git worker 串行化同一工作区的写操作。
- 复用 `git2` 的本地 commit / log / diff / status；远程 fetch / pull / push 复用现有双后端逻辑，凭据改为：
  - OAuth / PAT 由用户授权，加密存 Postgres；或
  - 工作区级 Deploy Key（SSH），私钥加密存 Postgres。
- 云端不把仓库放对象存储：git2 需要真实文件系统；对象存储只存工作区文件快照，Git 仓库独立卷。
- 多副本部署时，Git 仓库需共享卷或独立 Git 服务；首版明确只支持单 API 副本。
- 桌面 ↔ 云端同步路径：桌面用现有 Git 面板推到一个 Git 远程，云端工作区从同一远程 clone / pull；不新增私有同步协议。

### 4.8 Web 剪藏

- 云端端点 `POST /api/clip`，HTTPS，工作区 token 鉴权；不再限制 `Origin` 为 `chrome-extension://` 或本机。
- 保留现有载荷字段、模板变量、图片本地化、关联笔记打分逻辑；`webclip.rs` 的纯逻辑抽到 `note-core`，HTTP 层用 Axum。
- 扩展新增设置：服务地址 + 工作区 token；这是扩展的一版改动，云端首版要求扩展支持。
- 限流：每 token 每分钟 N 次、每工作区每日配额；载荷上限沿用 8MB / 2MB / 5MB。

## 五、数据模型与存储语义

### 5.1 PostgreSQL 表

```sql
users(id, email, password_hash, display_name, created_at, disabled_at)
identities(user_id, provider, subject, email, created_at)
sessions(id, user_id, expires_at, ip, user_agent, created_at)
workspaces(id, slug, name, owner_id, created_at, quota_bytes)
memberships(workspace_id, user_id, role)         -- owner / editor / viewer
invites(id, workspace_id, email, role, token_hash, expires_at)
documents(workspace_id, rel, kind, size, etag, version, sha256,
          deleted_at, created_by, updated_by, updated_at)
document_versions(workspace_id, rel, version, sha256, size,
                  author_id, created_at)
settings(user_id, workspace_id, key, value jsonb, updated_at)
api_tokens(id, user_id, workspace_id, token_hash, scopes, expires_at)
audit_log(id, workspace_id, user_id, action, target, ip, detail jsonb, created_at)
index_jobs(id, workspace_id, rel, kind, status, attempts, run_after)
export_jobs(id, workspace_id, kind, status, object_key, created_at)
git_repos(workspace_id, path, remote_url, credential_ref)
webclip_tokens(id, workspace_id, token_hash, created_at, revoked_at)
```

主键用 UUID；`documents` 唯一键 `(workspace_id, rel)`；`memberships` 唯一键 `(workspace_id, user_id)`；所有查询带 `workspace_id`，禁止只按 rel 查。

### 5.2 对象存储布局

```
ws/<workspace_id>/vault/<rel>                当前文件
ws/<workspace_id>/versions/<sha256>          内容寻址版本（自动去重）
ws/<workspace_id>/trash/<timestamp>/<rel>    软删除
ws/<workspace_id>/exports/<job>/<file>       导出产物
```

元数据表指向当前 sha256；版本表按 rel + version 存历史。图片与附件同样走 `vault/<rel>`，没有第二套私有路径。

### 5.3 写入流程

1. 客户端读文档，拿到 `{content, etag, version}`。
2. 自动保存 / 手动保存发 `write_md_file(vaultRoot, path, content, etag)`。
3. 服务端校验成员角色 ≥ editor、路径合法、大小配额。
4. 计算新 sha256；若与当前 sha 相同，直接回成功，不产生新版本。
5. 对象存储 PUT `versions/<sha256>`（若已存在则跳过）。
6. Postgres 事务：更新 `documents` 的 sha/etag/version，插入 `document_versions`，插入 `index_jobs`，写审计。
7. 事务提交后发 SSE `nl:doc-changed`；失败则回滚元数据，blob 由 GC 任务清理。
8. 写入带 `If-Match` 语义：`documents.version` 不匹配回 `409 conflict + 当前 version`，前端走重载 / 覆盖 / 取消。

### 5.4 版本、备份、回收站

- 每次成功写入生成一个版本；版本按 sha256 去重，`document_versions` 记录作者与时间。
- 版本保留策略：默认保留 90 天或最近 100 个版本；工作区可配置。管理员可导出全部版本。
- 备份：Postgres 每日 `pg_dump`，对象存储开启版本控制与生命周期；恢复演练按 `docs/runbooks/cloud-restore.md`。
- 删除：移入 `trash/`，`documents.deleted_at` 置位；30 天后对象生命周期删除，期间可恢复。恢复时若原路径已被占用，追加 `-2`。
- 导出：工作区整包 zip（md + assets + canvas + 设置）由服务端流式生成；单篇 HTML / 幻灯片在浏览器生成。

### 5.5 导入

- zip / 文件夹上传：浏览器 `<input type="file" webkitdirectory>` 或 zip；服务端校验路径、大小、zip bomb、重名，逐文件写对象存储与元数据。
- Git clone：新建工作区时填远程 URL + 凭据，Git worker clone 后导入。
- 单篇 md：上传后放在当前目录；图片相对路径按 zip 结构或用户指定目录补齐。
- Word 导入：复用 `docx_import.rs`，在服务端解析并写库；校对仍在浏览器完成。

### 5.6 并发与冲突

- 首版不做 OT / CRDT；同一文档用 ETag 乐观锁。
- 两个用户同时编辑不同文档互不影响；同一文档后保存者收到 409，前端现有三选一冲突对话框改成“重载 / 覆盖 / 取消”。
- 自动保存失败不静默：状态栏与浮条提示，保留本地未保存内容，允许重试。
- 文档变更 SSE 只用于让其他标签页/成员刷新树与提示，不自动覆盖正在编辑的内容。

## 六、认证、权限与安全

### 6.1 认证

- 本地账号：邮箱 + Argon2id 密码；注册可关闭（仅邀请）。
- OIDC：GitHub / Gitee / Google，配置化；首次登录按邮箱绑定或创建账号。
- 会话：`__Host-nl_session` HttpOnly、Secure、SameSite=Lax；会话表支持多设备与主动登出。
- CSRF：双提交 cookie + `X-CSRF-Token`；所有 `POST /api/invoke` 与上传校验。
- 登录限流、失败次数锁定、密码重置 token 一次性。
- API token：工作区范围、只读 / 读写 / Git / 剪藏分 scope；只存哈希，创建时显示一次。

### 6.2 权限

- 角色：owner（成员、设置、删除工作区）、editor（读写文档、Git、导出）、viewer（只读、导出、AI 只读工具）。
- 每个 `/api/invoke` 命令先解析所需 scope，再校验 `membership`；命令内部再次校验路径前缀与角色，双层防护。
- 邀请：邮件或链接；token 哈希存储，限定工作区与角色。
- 审计：登录、成员变更、文档写删、Git 操作、剪藏、导出、AI 配置变更。
- 跨工作区一律 404（不泄露存在性），同工作区越权 403。

### 6.3 安全清单

- 路径：拒绝 `..`、绝对路径、盘符、空字节；对象 key 前缀二次校验。
- XSS：前端继续 `html:false` + 现有 sanitizer；站点导出与 HTML 导出在服务端再跑一次白名单清洗；CSP 禁止内联脚本（除构建产物 hash）。
- CSRF / CORS：同源部署；扩展端点单独 CORS 白名单。
- SSRF：AI 地址、远程图片、Web 剪藏、Git 远程都走 URL 校验与私网拦截；管理员可显式放行私有网段。
- 上传：大小、类型、zip 解压炸弹、图片解压炸弹、路径穿越、重复文件；隔离临时目录。
- 密钥：数据库连接、S3、OIDC、KEK 走环境变量或 KMS；AI Key / Git 凭据 / SMTP 加密存储；日志不打印 secret。
- 配额：每用户工作区数、每工作区字节数、单文件大小、导出并发、AI 日 token 上限。
- 依赖：`cargo audit` / `npm run audit:osv` 进 CI；容器镜像最小化，非 root 运行。

## 七、前端复用与改造

### 7.1 代码线

- 长期 `cloud` 分支（或独立仓库 `note-lume-cloud`），从 `master` 定期合并；`cloud → master` 禁止。
- `cloud` 分支保留现有 `src/`，新增 `src/cloud/` 传输替身与 `cloud/` 服务端目录；不把 `src/web/` 合并进来，只 cherry-pick 其 `tauri-core` 传输思路。
- 桌面端代码不因为云端加 `if (CLOUD)`；平台差异集中在 `src/cloud/`，与 `web` 分支同一套构建期 alias 思路。

### 7.2 传输替身

构建时替换五个裸包名：

| 包名 | 云端替身 | 行为 |
| --- | --- | --- |
| `@tauri-apps/api/core` | `src/cloud/tauri-core.js` | `invoke(cmd, params)` → `POST /api/invoke`，带 session + CSRF |
| `@tauri-apps/api/event` | `src/cloud/tauri-event.js` | `listen` → SSE 事件总线；`emit` → 本地分发 |
| `@tauri-apps/api/window` | `src/cloud/tauri-window.js` | `setTitle` 写 `document.title`；窗口方法 no-op |
| `@tauri-apps/api/path` | `src/cloud/tauri-path.js` | `join` 走 rel 拼接；`tempDir` 回虚拟 scratch 路径 |
| `@tauri-apps/plugin-dialog` | `src/cloud/tauri-dialog.js` | 工作区文件浏览器 / 上传 / 下载；确认框走现有 DOM 对话框 |

`tauri-bridge.js` 与其余 60 多个模块原样进产物；命令 id 与参数形状保持。`src/cloud/commands.js` 不删命令，云端实现全部命令；桌面专属命令由服务端回 `unsupported` 或 no-op，UI 隐藏对应入口。

### 7.3 启动与认证

- 新增 `/login`、`/workspace/:slug` 路由；未登录跳登录页，登录后拉 `/api/me` 与工作区列表。
- 设置不再走 localStorage；`settings-store.js` 的 `hasTauri()` 在云端为假时改读 `/api/invoke` 的 `read_settings_json`，写走 `write_settings_json`。
- 最近打开、标签、窗格布局按用户 + 工作区存服务端；多设备一致。
- 首屏不预置演示库；新用户给“导入 zip / 克隆 Git / 新建空库”三个入口。

### 7.4 UI 差异

- 平台标记 `cloud`：隐藏窗口按钮、托盘、菜单条、文件关联提示、自动更新、`在资源管理器中显示`。
- 「打开知识库」改成「切换工作区」；文件选择器改成工作区上传 / 目录浏览器。
- 打印保留浏览器 `window.print`；PDF 走打印对话框。
- 拖入文件改为浏览器 File 对象上传，不支持 OS 路径拖放。
- 大文件虚拟化、分栏、标签、主题、五语言、快捷键、命令面板、查找替换全部保留。
- 移动浏览器：首版按桌面断点降级，不做专门手机布局；手机端已有 Android / Harmony spec。

## 八、功能等价矩阵

| 桌面能力 | 云端实现 | 首版状态 | 说明 |
| --- | --- | --- | --- |
| WYSIWYG / GFM / 往返 | 同一前端与 schema | 等价 | 不重写编辑器 |
| 文件树 / 打开文件夹 | 工作区对象存储 + 上传 / Git | 等价（工作区级） | 不暴露服务器绝对路径 |
| 新建 / 重命名 / 删除 / 回收站 | 对象存储 + 元数据 + 软删除 | 等价 | 30 天回收站 |
| 保存 / 自动保存 / 备份 | 版本 + 对象存储版本控制 | 等价 | 版本历史可在面板查看 |
| 标签 / 大纲 / 属性 / 反链 / 搜索 | `note-core` + Tantivy | 等价 | 索引异步 |
| 标签页 / 分栏 / 拖拽 | 同一前端 | 等价 | 浏览器多标签页另算 |
| 主题 / 五语言 / 快捷键 / 命令面板 | 同一前端 | 等价 | 设置进 DB |
| 图片粘贴 / 拖入 / 查看 | 上传 + 对象存储 | 等价 | 大图走预签名 |
| 双链 / 悬停预览 | 同一前端 | 等价 | 鼠标环境 |
| AI Ask / Agent | 服务端代理 + SSE | 等价 | 密钥加密、SSRF 策略 |
| Git 本地 / 远程 / 冲突 | 服务端 git2 + 卷 | 等价（单节点） | 凭据加密；多副本后续 |
| Web 剪藏 | `/api/clip` + token | 等价（需扩展升级） | 不再绑 localhost |
| Quarkdown | `note-core` qd | 等价 | 纯 Rust |
| docx 导入 / 导出 | `note-core` docx | 等价 | 服务端执行 |
| 单篇 HTML / 幻灯片 / 整站导出 | 浏览器生成 + 下载 | 等价 | 整站 zip 由前端/服务端协作 |
| 打印 / PDF | 浏览器打印 | 部分等价 | 无服务端 headless PDF |
| Canvas / 图谱 / 快照 | 同一前端 + 版本 API | 等价 | 大图性能另测 |
| 每日速记 / 模板 | 同一前端 + 服务端目录 | 等价 | 速记落工作区 |
| 插件 | 首版不开放；Phase 5 沙盒 | 不等价 | 桌面插件 API 不能原样跑 |
| 语音输入 | Web Speech + 可选服务端 ASR | 部分等价 | 无 Windows 原生命中 |
| 本地文件关联 / 托盘 / 多窗口 / 自动更新 | 无 | 不适用 | Web UX 替代 |
| 离线编辑 | 不做；只读缓存 | 不等价 | 本地优先同步另立项 |
| 多用户 / 权限 / 审计 / 分享 | 云端新增 | 超出桌面 | 桌面无此能力 |
| 实时协同编辑 | 不做 | 不等价 | Phase 6 评估 |

“功能等价”验收以 P0 / P1 全项、P2 除插件外全项为准；插件、离线、原生命中三处明确列为后续阶段，不在首版承诺。

## 九、部署与运维

### 9.1 开发环境

```
docker compose up
  caddy      :443 / :80，反代 api 与静态 web
  api        :3000，Rust Axum
  indexer    :3001，索引 worker
  postgres   :5432
  minio      :9000 / 9001
```

- 本地卷：`./data/postgres`、`./data/minio`、`./data/git`、`./data/index`。
- `cloud/.env.example` 列全部变量；真实 `.env` 不入库。
- 数据库迁移 `sqlx migrate run` 在 api 启动前执行；失败即退出，不带半套 schema 启动。

### 9.2 生产

- 单 API 副本 + 单 indexer + 单 Git worker 是首版目标；Postgres / S3 用托管服务。
- 反向代理终止 TLS、HSTS、CSP、请求体上限、SSE 超时调大；静态资源带 hash 长缓存。
- 健康检查：`/healthz` 检查 DB 与 S3；`/metrics` 给 Prometheus；日志 JSON 带 request id。
- 备份：Postgres 每日全量 + WAL 归档；对象存储版本控制与跨区复制；每月恢复演练。
- 发布：镜像不可变 tag；迁移向前兼容；先 api 后 indexer；失败回滚旧镜像，数据库迁移保留回滚脚本。
- 资源：CPU / 内存限额；索引与大导出单独 worker，不和 API 抢。

### 9.3 配额与限流

- 每用户工作区数、每工作区总字节、单文件大小、单次上传、AI 日 token、剪藏每分钟、Git 操作并发。
- 超限回可读错误与剩余额度；不静默截断。
- 反向代理层限连接与请求速率，应用层按用户/工作区再限。

## 十、实施阶段

### Phase 0：内核抽取与最小闭环

- 抽 `note-core` crate；桌面 `src-tauri` 改为 adapter，`cargo test --lib` 全绿。
- 起 Axum + Postgres + MinIO + Caddy；`/api/invoke` 只实现登录、工作区、`scan_vault`、`read_md_file`、`write_md_file`。
- 前端 cloud shim 跑通登录、工作区、文件树、打开、编辑、保存。
- 量 1000 篇库的导入、扫描、索引、搜索；确认对象存储延迟可接受。
- 退出判据：Docker Compose 一条命令起全栈；两个用户各开一个工作区，互不可见；保存后重新登录内容还在。

### Phase 1：单用户完整写作

- 认证（本地 + OIDC）、工作区、邀请、成员基础。
- 文件树、标签页、分栏、编辑器、自动保存、409 冲突、图片上传、主题、五语言、快捷键。
- 版本、回收站、最近打开、设置同步。
- 退出判据：1MB 文档编辑保存后下载与桌面逐字节一致；杀浏览器重开恢复；断网编辑给出明确失败提示。

### Phase 2：知识库与 AI

- 索引 worker、Tantivy + jieba、全库搜索、反链、标签、大纲、图谱、Canvas、快照。
- AI Ask / Agent、SSE、密钥加密、SSRF 策略、配额。
- 导出：HTML / 幻灯片 / 整站 zip / docx；打印。
- 退出判据：200 篇库搜索准确；反链与桌面一致；AI 流式与停止可用；导出件可打开。

### Phase 3：多用户与权限

- RBAC、邀请、审计、API token、配额、限流、跨工作区隔离测试。
- 同文档并发冲突、变更通知、成员退出 / 工作区转移。
- 退出判据：viewer 不能写；editor 不能改成员；跨工作区 403 / 404；审计可追溯。

### Phase 4：Git、剪藏与迁移

- Git worker、远程凭据加密、OAuth / Deploy Key、冲突解决。
- Web 剪藏端点、扩展设置、模板与关联笔记。
- zip / 文件夹 / Git 导入；整包导出；桌面 ↔ 云端 Git 同步演练。
- 退出判据：Git push / pull 成功；剪藏落库；200 篇库经 Git 从桌面同步到云端。

### Phase 5：插件与语音

- 插件沙盒：iframe / Worker + 能力 API；不暴露 DOM、`fetch`、文件系统、Git；节点插件用声明式 schema，不执行任意代码。
- 语音：Web Speech + 可选服务端 ASR；不做 Windows 原生听写。
- 退出判据：一个只读插件与一个命令插件在沙盒内运行；恶意插件不能访问其他工作区或网络。

### Phase 6：离线与协同（单独立项）

- 本地优先同步层（操作日志 / CRDT）与离线写；桌面端可作为客户端接入。
- 实时协同、presence、评论、分享链接。
- 多副本 API、共享 Git 卷 / Git 服务、索引集群。
- 这些不阻塞首版；单独出 spec，不在云端首版里堆。

## 十一、测试与验收

### 11.1 单测与集成

- `note-core`：路径、索引、反链、标签、Quarkdown、docx、Git 纯逻辑；桌面与云端共用同一批 fixture。
- `cloud/api`：命令路由、参数校验、RBAC、ETag 冲突、软删除、配额；`sqlx` 测试库 + MinIO 测试容器。
- 前端：现有 `src/tests/*.test.mjs` 全量；cloud shim 的 `invoke` / SSE / 上传 / 409 分支新增测试。
- 契约对拍：同一 `cmd + params` 在桌面与云端返回同形；字段名、错误 `[code]`、分页与排序一致。

### 11.2 端到端与安全

- Playwright：注册 / 登录、创建工作区、导入 zip、编辑、保存、搜索、AI、导出、Git、剪藏、登出。
- 权限矩阵：owner / editor / viewer × 读 / 写 / 删除 / Git / 成员 / 导出 / AI，逐项断言。
- 安全：路径穿越、对象 key 越权、CSRF、XSS、SSRF、zip 炸弹、超大上传、会话固定、暴力登录、跨工作区 IDOR。
- 负载：5000 篇库导入、50 并发读、10 并发写、搜索 p95、SSE 连接数、索引重建时间。
- 备份恢复：`pg_dump` + 对象存储版本恢复到一个新环境，文档与版本一致。

### 11.3 验收场景

1. 新用户 OIDC 登录 → 创建 `notes` 工作区 → 上传 zip → 文件树与 200 篇文档出现。
2. 打开一篇含中文、表格、代码、公式、图片的文档 → 编辑 → 保存 → 下载与桌面版比对。
3. 两个浏览器同时编辑同一篇：后保存者 409，重载后内容正确；不同文档互不影响。
4. 搜索中文关键词、标签、文件名；反链与桌面一致；索引重建时 UI 显示进度。
5. AI Ask / Agent：HTTPS 服务商流式回答、停止、插入；AI Key 在数据库中是密文。
6. Git：init → commit → push 到测试远程 → 另一个用户 clone / pull；冲突走三选一。
7. Web 剪藏：扩展指向云端地址 + token，剪藏落 `Clippings/`，关联笔记生成。
8. 导出：HTML / 幻灯片 / 整站 zip / docx；PDF 用浏览器打印。
9. 权限：viewer 只读；editor 可写但不能改成员；跨工作区访问 404。
10. 运维：杀掉 api 容器重启，SSE 重连，未保存内容不丢；备份恢复演练通过。

## 十二、风险与未决

| 风险 | 影响 | 处理 |
| --- | --- | --- |
| 从 Tauri 命令抽 `note-core` 工作量大 | Phase 0 拖长 | 先抽索引 / 路径 / qd / docx / AI 五块；桌面测试做回归；不复制逻辑 |
| 对象存储与 DB 双写不一致 | 文档丢或版本错 | 先 PUT 内容寻址 blob，再事务更新元数据；失败靠 GC 与索引任务恢复 |
| 索引与对象存储最终一致 | 搜索短时缺结果 | 索引任务可重放；索引状态 UI 明示；全量重建兜底 |
| 多副本下 Git 卷与索引本地盘 | 不能水平扩展 | 首版单副本；后续共享卷 / Git 服务 / 外部搜索 |
| AI / 远程图片 / Git 的 SSRF | 内网探测与元数据泄露 | 私网默认拒绝、DNS rebinding 校验、管理员显式放行、审计 |
| 插件与桌面不等价 | 用户预期落差 | 首版不开放任意插件；Phase 5 沙盒；README 写清 |
| 离线编辑缺失 | 弱网体验差 | 首版只读缓存 + 失败提示；Git 作为桌面同步桥；离线单独立项 |
| PDF 依赖浏览器打印 | 分页 / 字体与桌面不同 | 首版接受；需要服务端 PDF 时再引 headless Chromium |
| 多租户数据泄漏 | 严重 | 所有查询带 workspace_id；对象 key 前缀；RBAC 双层；IDOR 测试 |
| 成本失控 | 对象存储 / AI / 索引费用 | 配额、限流、生命周期、按工作区计量；首版不承诺免费额度 |
| 前端两份漂移 | 云端落后桌面 | `cloud` 分支定期合并 master；契约对拍测试；不复制 UI |
| 备份未演练 | 真故障恢复不了 | 每月恢复演练；备份与对象存储版本同查 |

未决问题：

1. 云端代码线用长期 `cloud` 分支，还是独立仓库 `note-lume-cloud`。首版建议 `cloud` 分支，部署时镜像到独立仓库；若团队分开，再拆。
2. 产品形态是公共 SaaS 还是只做单租户自托管。本文按多租户设计，自托管可关注册、单工作区。
3. 认证是否允许纯本地账号，还是只 OIDC。建议两者都留，默认 OIDC。
4. Git 仓库放共享卷还是独立 Git 服务。首版单副本 + 本地卷；多副本前必须定。
5. 搜索首版 Tantivy 是否够用；中文分词质量需用真实 200 篇库验收后再定是否换 Meilisearch。
6. 插件沙盒的能力边界：只读 / 命令 / 节点 schema 三档分别开放到什么程度。
7. 离线与协同是否合并成一个“本地优先”项目；首版不做，避免和云端首发抢资源。
8. 是否提供只读分享链接与公开站点。桌面没有，云端可后加；首版不做。

## 十三、交付与文档

- 代码线：`cloud` 分支（或独立仓库），从 `master` 定期合并；`cloud → master` 禁止；不合并 `web` 分支。
- 目录：`cloud/`（api / indexer / git-worker / migrations / docker）、`src/cloud/`（传输替身与登录页）、`docs/superpowers/specs` 本文件。
- 部署：`cloud/docker-compose.yml`、`cloud/.env.example`、`cloud/Caddyfile`、`cloud/README.md`；生产另出 runbook。
- 实现完成后同步更新：
  - `CHANGELOG.md` 的 `Added`：云端首版、技术选型、迁移说明。
  - `docs/ROADMAP.md` 的云端章节与批次状态。
  - `README.md` 中英两版：云端入口、能力边界（插件 / 离线 / PDF / 语音）、数据与隐私说明。
  - `docs/CLAUDE.MD` 的技术栈与架构：增加 `note-core`、`cloud` 产品线、`VaultStore` 口径。
- 本文件只定设计与 Phase 0 闸口；`note-core` 抽取与 Docker Compose 闭环不过，不进入 UI 与多租户细节。