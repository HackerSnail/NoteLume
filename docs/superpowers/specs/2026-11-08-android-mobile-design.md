# 设计：NoteLume 安卓手机与平板端（Tauri v2）

- 状态：设计完成，待实现
- 日期：2026-11-08
- 范围：Android 手机与平板端首版，不做 iOS
- 来源：P2 第 5 项「移动端适配」、`docs/ROADMAP.md` 批次 G；2026-11-08 用户指令「开发安卓手机端，按规矩先写 spec」；同日补充「安卓端锁定目录，用户方便」「安卓端同样要考虑平板」
- 最低版本：Android 7.0（API 24），Tauri v2 的默认 `minSdkVersion`
- 一句话：在 Android 上保留「打开本地文件夹 + 纯 md + WYSIWYG 手感」三条承诺，手机与平板共用一套内核、按屏宽给不同壳层，不是做阅读器，也不是把库导进应用私有目录的云同步客户端。

## 一、目标与边界

### 1.1 首版必须成立的承诺

1. 用户选中的文件夹仍是知识库本体。md 文件留在原目录，其他编辑器能直接打开，NoteLume 不建私有格式、不复制一份到应用沙箱。
2. 编辑器与桌面同源。ProseMirror schema、markdown 解析与序列化、GFM 往返规则不改；手机上保存的文件与桌面版逐字节一致。
3. 知识库基础能力可用。文件树、`[[链接]]` 跳转、标签、大纲、全库搜索、反链、AI 问答在手机上都能用。
4. 单库锁定。一个 Android 应用实例只锁一个知识库目录；首次选一次，之后启动直达，不再每次弹目录选择器。换目录必须显式解锁，避免误开别的文件夹把标签、索引与最近记录搅乱。
5. 手机与平板都是一等设备。手机单窗格；平板按宽度给持久文件树、检查器与最多两个编辑器窗格。不做三栏以上，也不把平板当放大版手机。

### 1.2 首版验收判据

- 首次启动选一次笔记文件夹，杀进程重开后直接进入这个锁定目录，不再弹选择器，文件树与上次打开的标签能恢复。
- 编辑一篇 1MB md（含中文、列表、表格、代码块、图片），保存后在桌面版打开，内容与格式一致。
- 全库搜索、反链、AI 问答（HTTPS 服务商与局域网 Ollama 各一条）可用。
- 按 Android 返回键不会丢未保存内容；后台被系统杀进程后能找回未保存草稿。
- 600dp 竖屏能看到持久文件树与编辑区，不是抽屉；840dp 横屏有持久文件树 + 编辑区；1200dp 横屏能同时看到文件树、编辑器、检查器。
- 1000dp 以上横屏可并排两篇文档，各自标签独立；窄回去时多余窗格的标签并回剩余窗格，不丢内容。
- 旋转、系统分屏、折叠展开不丢标签、滚动位置与未保存内容；外接键盘快捷键、鼠标右键 / hover、触控笔选择按设备能力可用。
- 桌面端现有测试、`npm run build`、`cargo test --lib` 全部通过。

### 1.3 明确不做

- iOS。两端触屏范式接近，但 Tauri iOS 工程、签名与文件访问是另一套工作量，单独立项。
- 云同步、账号、端到端加密。手机端只读写用户选中的本地目录。
- 把知识库导入应用私有目录作为唯一存储方式。这会直接破坏「零锁定」的产品定位。
- `MANAGE_EXTERNAL_STORAGE` 全盘文件权限。Google Play 对它有严格审核，且与「用户选文件夹」的模型冲突。
- 为移动端复制一套前端页面。复用现有 DOM 与模块，用平台分支和 CSS 重排，避免两份 UI 各自漂移。
- 手写识别、笔迹笔记、压感绘图。触控笔只当精确指针，不把平板做成手写白板。
- 三栏以上分栏与自研桌面式多窗口管理。系统分屏与自由窗口只做兼容，不自绘窗口边框与任务栏。
- 折叠屏 hinge 专用双栏放 Phase 5；首版按展开后的可用宽度走平板断点，不承诺铰链两侧各放一栏。
- 首版不做的桌面功能见 §3.3 与 §7。

## 二、现状与差距

### 2.1 可以直接复用

| 部分 | 位置 | 说明 |
| --- | --- | --- |
| 编辑器与 schema | `src/editor-view.js`、`src/editor-schema.js` | 纯前端，ProseMirror 不依赖桌面平台 |
| Markdown 解析 / 序列化 | `src/editor-schema.js`、`src/tests/roundtrip.test.mjs` | 与平台无关，手机端不改协议 |
| 命令注册表 | `src/commands.js` | 纯容器，可作为手机「更多」菜单与命令面板的数据源 |
| 设置存储 | `src/settings-store.js` | Tauri 下走 `app_config_dir()`，Android 有对应的应用私有目录 |
| i18n / 主题 / 外观 | `src/i18n.js`、`src/locales/`、`src/appearance-settings.js` | 五语言与 CSS 变量体系直接复用 |
| 标签页与分栏纯逻辑 | `src/tabs.js`、`src/split-pane.js` | 树操作与标签列模型复用；手机禁用分栏，平板最多两格 |
| AI 任务与 Agent 循环 | `src/ai-tasks.js`、`src/ai-agent.js`、`src/ai-panel.js` | 纯逻辑与注入式 IO，已有 Node 单测 |
| 导出渲染器 | `src/site-export.js`、`src/slides-export.js`、`src/plain-export.js`、`src/docx-export.js` | 生成内容与平台无关，只需换写入层 |
| 预览组件 | `src/mermaid-preview.js`、`src/csv-preview.js`、`src/bibtex-preview.js`、`src/math-nodeviews.js` | 纯前端 |
| SVG 图标表 | `src/index.html`、`src/icons.js` | 手机端工具条与底部导航直接引用 |

### 2.2 五个硬阻塞

| 阻塞 | 现状证据 | 后果 |
| --- | --- | --- |
| 存储模型是本地绝对路径 | `src/main.js:169` 注释写明 `vaultRoot` 是绝对路径；Rust 的 `scan_vault` / `read_md_file` / `write_md_file` / `create_dir` / `rename_item` / `delete_file` 都先 `fs::canonicalize` 或 `fs::read_dir`（`src-tauri/src/lib.rs:273-560`） | Android 的 SAF 只给 `content://` URI，`canonicalize` 必失败，文件树打不开，后续读写全部断 |
| dialog 插件在 Android 不支持选文件夹 | `tauri-plugin-dialog-2.8.2/android/src/main/java/DialogPlugin.kt:62` 用 `ACTION_GET_CONTENT`，旁边留着 `// TODO: ACTION_OPEN_DOCUMENT ??`，`pickerMode` 只认 image / video / media | `pickFolder()` 拿不到目录树，也不能持久化授权，必须自建 SAF 选择器 |
| Android 目标有确定的编译阻断 | `trash 5.2.9` 的 `platform` 模块只覆盖 Windows / freedesktop / macOS（`trash/src/lib.rs:44-55`），Android 下 `platform::PlatformTrashContext` 无定义；`reveal_in_folder` 只有 mac / linux / windows 三个 `cfg` 分支且末尾没有兜底返回值（`src-tauri/src/lib.rs:1068-1103`）；`git2` 依赖链含 `openssl-sys` / `libssh2-sys`；`reqwest` 当前用 `native-tls` | 不改 `Cargo.toml` 与函数分支，`tauri android build` 直接失败 |
| Android 被误判成 Linux | `src/titlebar.js:9-14` 只认 mac 与 Windows，其余返回 `linux`，并在导入期写 `data-tauri-platform="linux"` | 手机首屏会显示桌面窗口按钮、拖拽区和 Windows / Linux 菜单条 |
| 布局是固定双栏 | `.sidebar` 与 `.inspector` 各 `width: 280px; flex-shrink: 0`（`src/style.css:655-701`），`.editor` `max-width: 860px`（`src/style.css:1927`），没有 `max-width` 断点，`#app` 用 `100vh`（`src/style.css:161`） | 360-430dp 的手机上左右栏合计已超过屏宽，编辑区被挤到接近 0；状态栏与导航栏也会压住内容 |
| 输入模型按鼠标与键盘设计 | 快捷键要求 Ctrl / Cmd / Alt（`src/keymap.js:62-108`）；右键菜单、`mouseenter` 菜单切换、`wiki-hover.js` 悬浮预览、4-5px 分隔条拖拽、HTML5 / Tauri 拖放 | 软键盘没有修饰键；长按与悬浮行为不同；分隔条手指点不中；拖放在 Android 文件管理器上不成立 |

### 2.3 否掉的做法

- 只开放应用私有目录，再提供导入 / 导出。实现最快，但用户在系统文件管理器里看不到笔记，其他编辑器也打不开，等于放弃产品定位。只能作为 Phase 0 的临时验证手段，不能进首版。
- 申请 `MANAGE_EXTERNAL_STORAGE` 后继续用绝对路径。技术上改动最小，但 Play 上架要单独说明用途，且用户安装时会看到「访问所有文件」的警告；与 SAF 的按目录授权相比没有产品收益。
- 把 `web` 分支的网页版套进 WebView。网页版没有本地文件夹权限，也没有 Rust 索引与 AI 代理；且硬性约束 8 明确 `web` 不合并进 `master`。
- 为手机另写一套编辑器页面。现有编辑器、命令、AI、导出都能复用，复制一套只会让两边测试与 bug 修复翻倍。

## 三、关键决策

### 3.1 存储：SAF 目录树，所有库内 IO 走同一层抽象

打开知识库用 `ACTION_OPEN_DOCUMENT_TREE`，拿到 tree URI 后立刻 `takePersistableUriPermission(READ | WRITE)`，把 URI 存进 `settings.json` 的 `workspace.lockedVault`，显示名另存 `workspace.lockedVaultName`。启动时先检查授权是否还在，被系统回收就提示重新授权同一个目录，不静默把文件树清空，也不清锁。

约束与代价：

- SAF 只认 `content://`，Rust 不能对它做 `std::fs`、`canonicalize`、`read_dir`。所有库内路径操作改走 `VaultFs`（§4.2）。
- Android 11 起不能选内部存储根目录、`Download` 根、`Android/data`、`Android/obb`；首次打开时要给一句说明，让用户选一个子文件夹（例如 `Documents/Notes`）。
- 没有文件监听。外部改动靠回到前台时的刷新、手动刷新、以及每次保存前的 mtime 校验发现（§6.3）。
- 不同 provider（本地存储、Google Drive、OneDrive、部分网盘）对 rename / move / 随机写的支持不一致。失败要回可读错误，不能假设 `renameTo` 一定成功。
- 应用私有目录只放不进入知识库的东西：`settings.json`、草稿、缓存清单、导出临时文件。它们仍是真实路径，Rust 用 `std::fs` 读写。

### 3.1.1 单库锁定

「锁定」锁的是应用内的库根，不是文件系统权限，也不阻止桌面版或其他编辑器改这些 md。它的目的是让手机端每次启动直达同一个库，不把时间花在选目录上，同时避免误开别的文件夹导致标签与索引错位。

- 首次启动没有锁：显示全屏引导页，说明「选择一个文件夹作为笔记库，之后启动直接进入」，按钮「选择笔记文件夹」调 `pickTree`。选择器用 `EXTRA_INITIAL_URI` 指向系统 `Documents` 的 document URI（取不到就省略），文案建议用户在里面新建 `NoteLume` 子目录。SAF 不能在任意位置自动创建目录并拿到持久授权，所以不做「一键自动建库」的假承诺。
- 选定后写 `workspace.lockedVault`（URI）、`workspace.lockedVaultName`、`workspace.lockedAt`，同时 `takePersistableUriPermission(READ | WRITE)`。启动时只读这一个锁。
- 启动直达：授权仍有效就直接 `scan_vault` + 建索引 + 恢复上次标签，不弹选择器；授权被系统回收就显示「重新授权」，保留原 URI，用户重选同一个目录后恢复，不把锁清空。
- 重授权时用户选了别的目录：弹「更换锁定目录？」确认。取消则保持原锁并回到重新授权页；确认才释放旧 URI、切新锁。
- 更换与解除只在设置页「知识库目录」：更换先处理当前文档未保存改动，再释放旧授权、切新锁、重建索引与标签；解除同样先保存 / 关闭文档，释放授权后回到首次引导页。文件树、最近打开、拖入、Intent 都不能直接改库根。
- 最近打开在 Android 上只记锁定库内的文档，不出现其他库的根。桌面端的多库最近列表不受影响。
- 用户连续取消选择时给「稍后再说」，进入空态，可新建草稿；草稿仍在应用私有目录，保存时要求先锁定一个库或选导出位置。

### 3.2 窗格：手机单窗格，平板最多两窗格

- 手机（< 600dp）强制单窗格。启动时把 `panes` 树归一成一个叶子，隐藏拆分按钮、窗格拖拽与「拆分」命令；标签条保留，做成可横向滚动的胶囊，长按标签出「关闭 / 关闭其他 / 固定 / 复制路径」动作表。
- 平板中等宽度（600-839dp）也是单窗格，但文件树常驻；不做分栏，AI 与检查器走侧边浮层。
- 平板宽屏（≥ 840dp）允许最多两个编辑器窗格，只做左右并排，不做上下与三窗格。是否可以拆由实际编辑区宽度决定：`canSplit = 可用编辑区宽度 ≥ 720dp && 横屏 && 窗格数 < 2`。检查器常驻会占用宽度，所以检查器打开时通常只能单窗格；要并排就先把检查器收起。
- 平板分栏复用现有 `split-pane.js`，不新写引擎；拆分按钮只保留「左右拆分」，上下拆分与拖拽落边拆分在手机上隐藏、平板上也只允许一次。已有两窗格时，标签可在两窗格间拖移，落边不再拆第三个。
- 宽度缩回单窗格阈值或转为竖屏时，保留焦点窗格，把另一个窗格的标签按顺序并回焦点窗格的标签列，去重后保留激活标签；不关闭脏文档，不丢未保存内容。恢复宽屏不自动再拆，用户手动拆。
- `panes` 树在 Android 上按设备保存，但读取时按当前形态裁剪：手机强制一个叶子，平板最多两个叶子；桌面端的 `panes` 不参与。

### 3.3 首版功能取舍

首版保留：SAF 单库锁定、文件树、阅读与编辑、保存与自动保存、新建 / 重命名 / 删除 / 回收站、图片插入与查看、手机单窗格与平板双窗格标签、大纲、属性、标签、反链、全库搜索、AI Ask / Agent、单篇导出 HTML / Markdown、主题、五语言、设置、最近打开、草稿恢复。

首版隐藏：Git 面板、网页剪藏服务、打印、Canvas、知识图谱、插件、语音输入、模板、每日速记、Word 导入 / 导出、整站导出、分栏、多窗口、文件关联启动、桌面拖放、Ollama 首启引导。

隐藏方式统一走平台能力表（§4.10），不是在各处临时 `if`。命令不注册或注册为不可见，菜单与命令面板都读同一份过滤结果。

### 3.4 包名

首版沿用 `tauri.conf.json` 的 `identifier: app.notelume.desktop`，不为了 Android 改全局标识。改它会同时移动桌面端 `app_config_dir` 与已发布版本的设置目录，需要一次性迁移，收益只是包名好看。

如果确定要上 Google Play，必须在第一次 `android init` 之前决定最终包名；Play 的 applicationId 上架后不能改。这条列进 §10 的未决项，由发布决策拍板。

## 四、架构

### 4.1 分层

```
前端（现有模块）
  src/main.js / editor / panels
        │  Tauri invoke，参数与返回值形状保持不变（vaultRoot 仍是字符串）
        ▼
Rust 命令层（src-tauri/src/lib.rs）
        │  parse_root(vault_root) → Local(PathBuf) | Android(tree URI)
        ▼
VaultFs（src-tauri/src/vault_fs.rs）
   ├─ LocalVaultFs：现有 std::fs 行为，桌面端默认
   └─ AndroidVaultFs：调用移动插件
            │  PluginHandle::run_mobile_plugin（同步阻塞）
            ▼
Kotlin 插件（src-tauri/gen/android/.../MobileFsPlugin.kt）
   DocumentsContract + ContentResolver + 持久化授权 + 清单缓存
```

关键点：前端不需要认识 SAF。`scan_vault`、`read_md_file`、`write_md_file` 等命令名与参数不变，`vaultRoot` 从绝对路径变成 `content://` 字符串，Rust 在入口处分流。这样文件树、索引、面板、AI 工具、导出全部沿用现有调用链。

### 4.2 VaultFs 接口

`src-tauri/src/vault_fs.rs` 新增：

```rust
pub enum VaultRoot {
    Local(PathBuf),
    Android { tree_uri: String, display_name: String },
}

pub trait VaultFs: Send + Sync {
    fn root_key(&self) -> String;              // Local: canonical 路径；Android: tree URI
    fn list_all(&self) -> Result<Vec<Entry>>;  // 递归清单，文件夹在前
    fn stat(&self, rel: &str) -> Result<Stat>;
    fn read_text(&self, rel: &str) -> Result<String>;
    fn read_many(&self, rels: &[String]) -> Result<Vec<FileText>>;
    fn write_text(&self, rel: &str, text: &str) -> Result<()>;
    fn create_dir(&self, rel: &str) -> Result<()>;
    fn delete(&self, rel: &str) -> Result<()>;
    fn rename(&self, from: &str, to: &str) -> Result<()>;
    fn read_bytes(&self, rel: &str) -> Result<Vec<u8>>;
    fn write_bytes(&self, rel: &str, bytes: &[u8]) -> Result<()>;
}
```

路径规则统一放在 `vault_fs::normalize_rel`，不依赖平台：

- 只接受库内相对路径，`\` 换 `/`，压掉空段。
- 拒绝 `..`、盘符、以 `/` 开头的绝对路径、`content://` 混入 rel。
- 空 rel 表示库根，只有 `list_all` / `stat` 允许。
- 文件名大小写按原样保留；比较库根时 `content://` 不 lowercase（见 §4.9 的 `normVaultPath` 修正）。

`LocalVaultFs` 把现有 `abs_in_vault` / `vault_join` / `ensure_inside_root` 的逻辑收进来，行为不变。`AndroidVaultFs` 把 rel 交给 Kotlin 解析成 document URI。

测试用一个 `MemoryVaultFs` 假实现驱动 `scan_vault` / 索引 / 备份 / 回收站逻辑，桌面上就能跑，不需要 Android 设备。

### 4.3 Android 插件

新建 Kotlin 模块（包名 `app.notelume.mobilefs`），在 Rust 侧注册：

```rust
Builder::new("notelume-mobile-fs")
    .setup(|app, api| {
        #[cfg(target_os = "android")]
        {
            let handle = api.register_android_plugin("app.notelume.mobilefs", "MobileFsPlugin")?;
            app.manage(mobile_fs::MobileFsState::new(handle));
        }
        Ok(())
    })
    .build()
```

`PluginHandle::run_mobile_plugin` 内部是 `recv` 阻塞调用（`tauri-2.12.3/src/plugin/mobile.rs:324`）。所有可能超过几十毫秒的操作（全库清单、批量读、导出）必须放在 `tauri::async_runtime::spawn_blocking` 或专门的扫描线程里，不能占 Tauri 的命令线程。

插件命令表：

| 命令 | 入参 | 返回 | 说明 |
| --- | --- | --- | --- |
| `pickTree` | `{initialUri?}` | `{uri, name}` | `ACTION_OPEN_DOCUMENT_TREE`，`EXTRA_INITIAL_URI` 指向上次目录或 `Documents`，`takePersistableUriPermission` |
| `hasTreePermission` | `{uri}` | `{ok}` | 启动时检查授权是否仍有效 |
| `releaseTree` | `{uri}` | `{}` | 用户移除知识库时释放授权 |
| `listAll` | `{uri}` | `Entry[]` | 递归清单，含 rel / name / isDir / size / mtime / documentId |
| `readText` | `{uri, rel}` | `{text, size, mtime}` | UTF-8 读取 |
| `readMany` | `{uri, rels}` | `FileText[]` | 一次调用读多篇，索引重建用 |
| `writeText` | `{uri, rel, text}` | `{size, mtime}` | 父目录不存在时创建 |
| `createDir` | `{uri, rel}` | `{}` | 已存在回错误码 |
| `delete` | `{uri, rel}` | `{}` | 移入库内回收站或永久删除，见 §4.7 |
| `rename` | `{uri, from, to}` | `{}` | 目标存在回错误码，不静默覆盖 |
| `stat` | `{uri, rel}` | `{size, mtime, isDir}` | 保存前冲突检测 |
| `readBytes` / `writeBytes` | `{uri, rel}` / `{uri, rel, base64}` | base64 / `{}` | 图片与二进制；单次上限 8MB |
| `copyIn` | `{srcUri, treeUri, rel}` | `{size}` | 从文件选择器或分享进来的 URI 复制到库内 |
| `importToCache` | `{srcUri}` | `{path, name, size}` | 拷进应用缓存，给 docx 等仍需真实路径的旧命令留口 |
| `exportText` | `{fileName, mime, text}` | `{uri}` | `ACTION_CREATE_DOCUMENT` 后写入 |
| `exportBytes` | `{fileName, mime, base64}` | `{uri}` | 同上，二进制 |
| `openUrl` | `{url}` | `{}` | `ACTION_VIEW`，仅 http / https |
| `getInsets` | 无 | `{top,right,bottom,left,imeBottom,cutout}` | 当前窗口安全区与键盘高度；配置变化、分屏、旋转后重取 |
| `finish` | 无 | `{}` | 返回键确认退出后关闭 Activity |

实现细节：

- 只用 framework 的 `DocumentsContract` 与 `ContentResolver`，不引 `androidx.documentfile` 或第三方 SAF 库，Gradle 依赖保持 Tauri 模板原样。
- 目录枚举用 `buildChildDocumentsUriUsingTree` + `ContentResolver.query`，projection 取 `COLUMN_DOCUMENT_ID` / `COLUMN_DISPLAY_NAME` / `COLUMN_MIME_TYPE` / `COLUMN_LAST_MODIFIED` / `COLUMN_SIZE` / `COLUMN_FLAGS`；目录 MIME 是 `MIME_TYPE_DIR`。
- Kotlin 侧维护 `rel → documentUri` 的清单缓存。首次 `listAll` 建表；`writeText` / `createDir` / `rename` / `delete` 后增量更新；`readText` 先用缓存，未命中再走一次根遍历。缓存不落盘，进程死了就重建；Rust 侧可把清单再缓存到应用私有 JSON，按 tree URI + 根 mtime 记版本。
- 错误返回统一 `{code, message}`：`permission_lost` / `not_found` / `exists` / `escape` / `unsupported` / `io` / `too_large`。Rust 把 code 映射到 `ui_lang.rs` 的词条，不把 Kotlin 英文原文直接糊到界面上。
- `listAll` 的节点上限 20000，超过时回 `too_many` 并附总数，前端提示「库太大，首版只列出前 20000 项」。这个上限在 Phase 0 用真机量过再定。

### 4.4 Rust 命令改造

| 命令 | 改法 |
| --- | --- |
| `scan_vault` | `parse_root` → `list_all`；返回的 `TreeNode.path` 仍是 rel，前端不改 |
| `read_md_file` / `write_md_file` | 走 `read_text` / `write_text`；`write_text` 前用 `stat` 做 mtime 冲突检查（§6.3） |
| `create_md_file` / `create_dir` / `rename_item` | 路径校验收进 `normalize_rel`；存在性由 `VaultFs` 判 |
| `delete_file` | Android 分支不再用 `trash`，走回收站（§4.7） |
| `resolve_wiki_link` | 用 `VaultFs` 的存在性检查，不拼绝对路径 |
| `rebuild_index` / `search_vault` | 第一阶段去掉 `fs::canonicalize`；扫描改 `list_all`，正文改 `read_many`，按 32 篇一批 |
| `backup_write` / `list_backups` / `read_backup` | Android 分支写应用私有备份目录，见 §4.7 |
| `save_image_bytes` / `read_image_data_uri` | 走 `write_bytes` / `read_bytes`；返回 data URI 的形状不变 |
| `save_image_from_data_uri` | Android 改 `exportBytes`，让用户选保存位置 |
| `export_file` | Android 改 `exportText`；参数从「绝对路径」变成「建议文件名 + MIME」 |
| `docx_preview` / `docx_commit` | 首版隐藏；若要保留，入参先走 `importToCache` 拿真实路径 |
| `build_site_graph` / `copy_vault_assets` | 首版隐藏；后续走 `list_all` + `read_many` + 目标 tree URI |
| `qd_eval` | 纯文本求值可用；`read` / `listfiles` / `include` 等文件类函数在 Android 下按现有诊断降级，不崩文档。前端 `qdDocDir` / `qdLibsDir` 在 `content://` 根下不能拼 URI，Android 分支传 `null`；Quarkdown 库与包安装一并隐藏 |
| `start_vault_watcher` / `stop_vault_watcher` | Android 直接回 `unsupported`，前端不调用 |
| `git_*` | Android 不编译 git2，命令注册为 stub，前端隐藏入口 |
| `webclip` 相关 | Android 不启动本地 HTTP 服务，设置入口隐藏 |
| `voice` 相关 | 首版不编译 / 不注册，麦克风按钮隐藏 |
| `open_external_url` / `open_url` | Android 走插件 `openUrl`；`open_url` 的 `xdg-open` 分支要排除 Android |
| `reveal_in_folder` | Android 回 `unsupported`，菜单入口隐藏 |
| `probe_external_drop` / `drop_path_is_dir` / `open_vault_window` / `take_launch_paths` | Android 回空或 `unsupported`；前端不绑桌面拖放与多窗口 |
| `set_mac_menu` / `tray_set_recent` | 前端 Android 分支不调用；`tray_set_recent` 现有非 mac 空操作可以保留 |

`lib.rs` 的 `setup` 里 `#[cfg(not(target_os = "macos"))] set_decorations(false)` 必须排除 Android，否则会尝试操作不存在的窗口装饰。剪藏服务的启动、托盘、原生菜单同样按 `cfg` 收口。

前端入口也要收口：Android 的 `openFolder()` 不再直接弹选择器，已锁定就返回当前锁，未锁定就跳首次引导；只有 `locked-vault.js` 的首次选择、重新授权、设置页更换 / 解除三处能调 `pickTree`。`openVaultPath(root, rel)` 收到与锁不一致的 root 时回「知识库已锁定」错误，不静默切根；`openAbsPath`、拖入文件夹、`file-opened` 事件在 Android 上不绑或走锁定检查。这样「锁」不是 UI 上的一个装饰，而是所有切根入口的唯一闸门。

### 4.5 索引与搜索

`VaultIndex` 已经按 rel 存文档与反链（`src-tauri/src/lib.rs:1169-1177`），结构不用改。要改的是构建入口：

1. `rebuild_index` 目前第一步 `fs::canonicalize(&vault_root)`（`src-tauri/src/lib.rs:1491`），Android 必失败。改成 `VaultFs::root_key()`。
2. `build_index` 当前的目录递归换成 `list_all` 的结果；正文读取用 `read_many` 分批，避免 500 篇文献产生 500 次 JNI 往返。
3. 构建仍在后台线程，`IndexStatus` 的 `ready` 语义不变；手机端 `ready` 之前搜索回空并显示「索引构建中」，不阻塞编辑。
4. 索引缓存可以落应用私有 JSON（`app_config_dir()/index/<tree-hash>.json`），键包含 tree URI、rel、mtime、size；启动时先读缓存让搜索立即可用，再后台增量刷新。缓存只用于加速，丢失可重建，不进入知识库。
5. 搜索命中片段仍由 Rust 返回 `path` / `title` / `snippet`，前端点结果打开文档。

### 4.6 AI 与网络

AI 的请求与 SSE 都在 Rust（`src-tauri/src/ai.rs`），前端 IPC 不变。Android 需要处理两件事：

- TLS：`reqwest` 当前用 `native-tls`，Android 上会落到 OpenSSL 交叉编译链，与 `git2` 是同一类构建风险。Android 目标改用 `rustls-no-provider` + `ring` provider，启动时安装一次默认 provider；桌面目标保持 `native-tls`。`reqwest 0.13` 的 feature 名为 `rustls-no-provider`（本地 crate 源码已确认），`rustls` 显式依赖 `ring`。
- 本地 Ollama：手机上的 Ollama 不常见，但局域网另一台机器跑 Ollama 是合理场景。Rust 的原生 HTTP 客户端不受 Android `NetworkSecurityPolicy` 的明文限制，`http://192.168.x.x:11434` 可以直接发；不要为此打开 WebView 的全局明文流量。首版不跑 Ollama 首启引导（`ollama_probe` 会去找桌面可执行文件，Android 上无意义），设置页仍允许手填地址与模型。
- 语音：首版隐藏麦克风按钮。`cpal` 在 Android 需要 NDK / Oboe 与 `RECORD_AUDIO`，服务商 ASR 又需要录音链路，单独一批做。
- 技能：`ai_skills_*` 在 Android 回空列表，AI 面板不显示技能入口；首版不扫描其他桌面 AI 软件的 SKILL.md。
- 后台：切到后台时取消正在进行的 AI 请求（`ai_chat_cancel`），避免 WebView 暂停后事件堆积；半截回答按现有规则保留在历史里。

### 4.7 备份、删除与恢复

- 备份：桌面继续写库内 `.notelume-backup`。Android 写应用私有 `backups/<tree-hash>/<sha256(rel)>/`，保留最近 20 份或 7 天，元数据记 `rel`、`mtime`、`size`。理由是 SAF 下每次备份都要一次 IPC 与一次文档创建，库内隐藏目录还会被其他文件管理器看到；备份是保险，不是笔记数据。
- 删除：优先用 `DocumentsContract.moveDocument` 把条目移进库根 `.notelume-trash/<时间戳>-<原文件名>`。移动失败时，文件 ≤ 10MB 走「读字节 → 写回收站 → 删原文件」，目录或更大的文件弹确认框写明「将从设备永久删除」，确认后才删。
- 恢复：回收站列表读 `.notelume-trash` 的清单，恢复时移回原 rel；原位置已有同名文件则追加 `-2`，不覆盖。
- 回收站不参与文件树与索引（现有 `scan_dir` 跳过以 `.` 开头的目录，`src-tauri/src/lib.rs:331`）。首版不做自动清理，设置页给「清空回收站」。
- 保存冲突：写之前用 `stat` 比 mtime。与打开时记录的 mtime 不一致且编辑器有改动，弹「文件已在外部修改」：重新加载 / 保留本地并覆盖 / 取消。没有改动则直接重新加载。
- 草稿恢复：沿用现有临时文件 + 自动保存。手机端把草稿目录放应用私有 `files/scratch`；`Ctrl+N` 的临时页机制改为「新建到当前库」优先，未开库时才落草稿目录。`onPause` 时强制 flush 一次自动保存，`onResume` 时恢复标签与草稿。

### 4.8 图片与导出

- 插入图片走系统图片选择器（`ACTION_OPEN_DOCUMENT`，`image/*`），插件 `copyIn` 把 bytes 写进当前文档目录的 `assets/`，命名与去重沿用 `insertImageFiles` 现有规则。剪贴板里的图片是否可粘贴取决于 Android WebView 的 paste 载荷；首版不承诺，图片入口以选择器为准。
- 图片显示继续用 `read_image_data_uri`（data URI），不改编辑器渲染。
- 单篇导出：HTML / Markdown / 幻灯片 HTML 生成字符串后走 `exportText`，用户选保存位置；成功后可「分享」到其他应用（`ACTION_SEND` + FileProvider，Phase 4 再做）。
- 整站导出、docx 导入导出、打印首版隐藏。

### 4.9 前端路径比较与最近打开

`normVaultPath` 现在把所有路径 lowercase（`src/vault-path.js:10-15`），`content://` URI 是大小写敏感且含编码段，lowercase 会让 `rootChanged` 误判。改成：

```js
if (/^content:\/\//i.test(s)) return s.replace(/\/+$/, '')
```

`recent` 条目从 `{root, rel}` 扩展为 `{root, rootName, rel, title}`。`root` 为 URI 时，标题栏与最近列表显示 `rootName`，不能显示整串 `content://com.android...`。`currentFile` 仍是 rel，标签 id 仍是 `paneId + root + rel`。Android 的最近列表只收锁定库内的文档，`root` 永远等于 `workspace.lockedVault`；切库时整批最近记录随锁一起换，不混排。

### 4.10 构建与依赖门控

`src-tauri/Cargo.toml` 按目标拆依赖：

| 依赖 | 桌面 | Android 首版 | 动作 |
| --- | --- | --- | --- |
| `trash` | 用 | 不用 | `[target.'cfg(not(target_os = "android"))'.dependencies]`，`delete_file` 分平台 |
| `git2` | 用 | 不用 | 仅桌面依赖；`git_builtin` 模块与命令按 `cfg` 收口，Android 注册 stub |
| `notify` | 用 | 可留但不用 | `fs_watcher` 启动命令 Android 回 `unsupported`；若构建报错再 gate |
| `reqwest` | `native-tls` | `rustls-no-provider` + `rustls/ring` | 分目标 feature；启动安装 provider |
| `cpal` / `windows` | Windows 语音 | 不用 | `voice` 模块与命令按桌面 / Windows 收口 |
| `pulldown-cmark` / `zip` / `roxmltree` / `sha2` / `docx-rs` | 用 | 纯 Rust 可留 | 无平台风险；docx 首版隐藏 |
| `tauri` 的 `tray-icon` feature | 用 | 桌面内部目标才引入 | 保留，Android 不创建托盘 |

`src-tauri/src/lib.rs` 的编译收口：

- `reveal_in_folder` 增加 Android 分支（回 `unsupported`）或整体重排 `cfg`，保证每个目标都有返回值。
- `open_external_url` / `open_url` 的 Android 分支走 `openUrl` 插件，不能再落到 `xdg-open`。
- `delete_file` 的 Android 分支走 `VaultFs`，不实例化 `trash`。
- `setup` 的 `set_decorations(false)` 排除 Android。
- 剪藏服务、托盘、原生菜单、桌面拖放、多窗口命令在 Android 不启动 / 不注册。

### 4.11 Android 工程配置

- 生成：在仓库根执行 `npm run tauri -- android init`，产物 `src-tauri/gen/android` 入库；构建命令 `npm run tauri -- android dev` / `npm run tauri -- android build --apk`，上架时 `--aab`。本机另需 JDK 17、Android SDK 与 NDK（版本以 Tauri CLI 生成的 Gradle 配置为准）。`MIN_SDK` 用 24，`versionCode` 由 `bundle.android.versionCode` 或 semver 派生。
- Rust 目标：`aarch64-linux-android`、`armv7-linux-androideabi`、`i686-linux-android`、`x86_64-linux-android`。首版发布至少 arm64-v8a + x86_64（模拟器）；armeabi-v7a 视低端机验收结果再决定。
- 权限：`INTERNET`（AI / 联网图片），SAF 不需要存储权限；首版不申请 `RECORD_AUDIO`。`android:windowSoftInputMode="adjustResize"`。
- Manifest：`android:allowBackup="false"` 或 data extraction rules 排除 `settings.json`。API Key 存在 `settings.json`，不能让系统云备份把它带走。
- 尺寸与窗口：`resizeableActivity="true"`、`supportsPictureInPicture="false"`、不锁定 `screenOrientation`；`MainActivity` 声明 `android:configChanges="orientation|screenSize|smallestScreenSize|screenLayout|keyboardHidden|keyboard|navigation|uiMode|density"`，避免旋转、分屏、键盘坞切换时重建 Activity 把编辑器状态打回冷启动。
- 边到边：`WindowCompat.setDecorFitsSystemWindows(window, false)`，由 `getInsets` 把状态栏 / 导航栏 / 刘海 / 输入法高度交给前端；Android 15 起系统强制边到边，不能靠主题里的 `statusBarColor` 蒙混。
- 平板资源与断点走 CSS（WebView 的 dp 宽度），不靠 Android `values-sw600dp` 另做一套布局；Android 资源只放图标、主题与启动图。
- 文件打开：`ACTION_VIEW` 的 `text/markdown` / `text/x-markdown` intent-filter 与 `content` scheme 放 Phase 5；首版可以从应用内选文件夹，不承诺「在其他应用里点 md 打开 NoteLume」。
- capabilities：`capabilities/default.json` 加 `"platforms": ["windows", "macOS", "linux"]`；新增 `capabilities/mobile.json`，`"platforms": ["android"]`、`windows: ["main"]`，只保留 `core:default`、dialog 的消息框、剪贴板读文本。桌面窗口权限（minimize / maximize / start-dragging / print）不下放给 Android。
- 签名：release keystore 与 `keystore.properties` 不入库；CI 用 secrets 注入。debug 签名只用于本地真机验证。

### 4.12 生命周期、返回键与 Intent

- `MainActivity` 覆写返回键（Android 13+ 用 `OnBackPressedDispatcher`），不直接 `finish()`，而是向前端发 `nl:android-back`。前端按栈处理：关闭最上层菜单 / 动作表 / 对话框 → 关闭抽屉或面板 → 停止正在流式的 AI → 当前文档有未保存改动则弹「保存 / 不保存 / 取消」→ 都没有才调用插件 `finish`。
- `onPause` 发 `nl:android-pause`：flush 自动保存、取消 AI 请求、持久化当前标签与滚动位置。`onResume` 发 `nl:android-resume`：若距上次刷新超过 30 秒，后台重建清单并刷新文件树。
- `onConfigurationChanged` 与 `onMultiWindowModeChanged` 发 `nl:android-config`，带 `{width,height,orientation,multiWindow}`：前端重算 `formFactorFor` / `canSplit`、裁剪窗格、更新 inset CSS 变量；活动不重建，编辑器 state 保留。Activity 真被系统重建时，靠标签与草稿恢复。
- 折叠屏 Phase 5 用 `androidx.window` 的 `FoldingFeature` 取铰链方向与 posture；首版按展开后的可用宽度走平板断点，不把内容压在铰链上。
- Intent：Phase 5 接 `ACTION_VIEW`（md 文件）与 `ACTION_SEND`（文本 / 图片）。文件 URI 进来后先提示「选择所在文件夹以启用完整功能」，再通过 `copyIn` 或 tree 授权打开；不在首版承诺。
- 进程被杀：依赖自动保存与草稿目录，不依赖 `onDestroy` 回调。

## 五、界面与交互

### 5.1 平台标记与断点

新增 `src/platform.js`：

- `detectPlatform(ua, isTauri)` 纯函数，Android 返回 `'android'`，导出 `IS_ANDROID` / `IS_TAURI` / `IS_MOBILE`。
- 导入期写 `document.documentElement.dataset.tauriPlatform`，Android 不再落到 `linux`。
- `formFactorFor(width, height, coarsePointer)` 纯函数：`< 600` 为 `phone`，`600-839` 为 `tabletMedium`，`>= 840` 为 `tabletExpanded`。不再把 Android 平板叫 `desktop`，避免和 Tauri 桌面混淆。
- `canSplitEditor(availableEditorWidth, orientation, paneCount)` 纯函数：可用编辑区 ≥ 720dp、横屏、窗格数 < 2 才允许拆第二窗格。窗口宽度只是初判，最终看扣除文件树与检查器后的实测宽度。
- `inputModality.js` 记录最近一次输入：`pointerdown` 的 `pointerType` 为 `mouse` / `pen` / `touch`，切到 `body.nl-input-mouse` / `nl-input-touch`；混合设备上右键、hover、长按按最近一次输入分流，不按设备型号猜。
- `titlebar.js` 改为从 `platform.js` 取平台；Android 直接跳过 `initTitlebar` 与 `runWindowRole`。

断点三条：`max-width: 599px`（手机）、`600-839px`（平板中等）、`min-width: 840px`（平板宽屏）。桌面 CSS 不动，移动端样式放 `src/mobile.css`，在 `index.html` 里排在 `style.css` 之后；平板差异用 `html[data-form-factor="tabletMedium"]` / `tabletExpanded` 收口，不在 JS 里散落宽度判断。

平板按最短边与当前窗口宽度判形态，不按设备名：7-8 英寸竖屏多为 `tabletMedium`，10 英寸以上横屏多为 `tabletExpanded`；同一台设备旋转或进系统分屏会换形态，布局跟着换。

### 5.2 壳层

手机竖屏：

```
┌─────────────────────────────────┐
│ ☰  文档名 ·             ＋  ⋯   │  app bar（48dp + 安全区）
├─────────────────────────────────┤
│ 标签胶囊（横向滚动，36dp）        │
├─────────────────────────────────┤
│ 格式条（44dp，横向滚动）          │
│                                 │
│          ProseMirror            │
│          编辑区（占满剩余高度）    │
│                                 │
├─────────────────────────────────┤
│ 文件   大纲   AI   更多           │  底部导航（56dp + 安全区）
└─────────────────────────────────┘
```

平板中等宽度（600-839dp）：

```
┌──────────────┬──────────────────────────┐
│ 库名 + 锁     │ ☰ 文档名 ·        ＋ ⋯   │
│ 搜索          ├──────────────────────────┤
│ 文件树        │ 标签条                    │
│ 240-280dp     ├──────────────────────────┤
│              │ 格式条                    │
│              │ 编辑器（占满剩余）         │
│              │                          │
└──────────────┴──────────────────────────┘
  检查器 / AI = 右侧 360dp 浮层
```

平板宽屏（≥ 1200dp，检查器常驻）：

```
┌──────────────┬────────────────────────┬──────────────┐
│ 库名 + 锁     │ ☰ 文档名 ·       ＋ ⋯   │ 属性 / 标签   │
│ 搜索          ├────────────────────────┤ 反链 / 历史   │
│ 文件树        │ 标签条                  │              │
│ 260-320dp     ├────────────────────────┤ 300-360dp    │
│              │ 格式条                  │              │
│              │ 编辑器（max 860 居中）   │              │
└──────────────┴────────────────────────┴──────────────┘
```

- 手机：编辑区是唯一滚动容器，左右栏是覆盖层（见 §5.4）。
- 平板：文件树是常驻列，不是抽屉；检查器只在窗口 ≥ 1200dp 且扣除文件树与检查器后编辑区 ≥ 480dp 时常驻，否则改右侧 360dp 浮层；AI 面板同理。840-1199dp 与中等布局一样是两栏，只是文件树更宽。
- 平板并排两窗格时，检查器自动收成浮层，把宽度让给两个编辑器；每个窗格最小 350dp，窗格间 8dp 分隔条。
- 所有布局都保持每窗格一个滚动容器，不出现嵌套滚动；格式条与标签条各占一行，不随滚动消失。
- 软键盘弹出时手机隐藏底部导航；平板不隐藏文件树，只把编辑区高度按 `visualViewport` / `getInsets` 收缩。

### 5.3 顶栏

复用 `.toolbar` 的 DOM，移动端只显示：

- 左：手机 `☰` 打开文件抽屉；平板 `☰` 收起 / 展开常驻文件树，或切「文件 / 大纲」页签。抽屉与常驻列顶部都固定一行「库名 + 锁图标」。
- 中：当前文件名，脏标记一个小圆点；单行省略，不换行。
- 右：`＋` 新建（当前库内新建 md；未开库时落草稿）、`⋯` 打开「更多」动作表。平板宽屏可多放一个搜索图标，点击聚焦文件树搜索框。

隐藏：窗口按钮、应用名拖拽区、字数统计、查找 / 替换按钮、自动保存勾选、主题按钮、菜单条。这些动作进「更多」或底部导航。顶栏不放「打开其他文件夹」入口，换库只在设置页「知识库目录」。

### 5.4 底部导航与面板

手机底部四个入口：

| 入口 | 行为 |
| --- | --- |
| 文件 | 打开左侧文件抽屉，抽屉顶部保留「文件 / 大纲」两个页签与搜索框 |
| 大纲 | 打开文件抽屉并切到大纲页签 |
| AI | 全屏 AI 面板（复用 `#ai-panel`，移动端用 class 只显示 AI 区块） |
| 更多 | 底部动作表，条目从命令注册表过滤生成 |

平板不挂底部导航：文件树与「文件 / 大纲」页签常驻在左列，AI、检查器、更多走右侧浮层或顶栏下拉。手机的文件抽屉、平板的中等宽度侧栏、宽屏常驻列共用同一套 `.sidebar` DOM，只换定位与宽度，不复制两份。

抽屉与面板的实现：

- 手机 `.sidebar` / `.inspector` 是 `position: fixed`，宽 `86vw`（最大 360px），`translateX(-100%)` / `translateX(100%)` 收起；打开时加 `body.nl-drawer-open` 与半透明 backdrop。
- 平板中等宽度 `.sidebar` 常驻，宽 `clamp(240px, 32vw, 280px)`；`.inspector` 与 AI 是右侧浮层，宽 `min(360px, 42vw)`。
- 平板宽屏 `.sidebar` 宽 `clamp(260px, 28vw, 320px)`；`.inspector` 在剩余编辑宽度 ≥ 480dp 时常驻，宽 `clamp(300px, 26vw, 360px)`，否则浮层。
- 检查器内的 Git / 插件 / 历史版本首版隐藏；属性、标签、反链保留。
- AI 面板手机全屏；平板是右侧浮层，输入卡固定在浮层底部；消息区独立滚动。麦克风隐藏。
- 设置、命令面板、快捷键说明：手机全屏页；平板居中模态，最大宽 720dp，不铺满整屏。

### 5.5 文件树

- 手机行高 44dp，抽屉内单列；平板行高 40dp，常驻列可拖右侧分隔条调宽，宽度存 localStorage，按形态分别记。
- 文件夹行可点开合；文件名单行省略，右侧留 `⋯` 打开文件动作表（新建 / 重命名 / 删除 / 复制路径 / 刷新）。
- 单击文件 = 打开；长按文件 = 动作表；鼠标右键 = 光标位置菜单（见 §5.8）。不做滑动菜单，避免与系统返回手势冲突。
- 顶部固定「库名 + 锁图标」一行；下面是搜索框，搜索结果点一条后手机关闭抽屉，平板保持文件树并打开文档。
- 抽屉 / 列底部只留「刷新」；「更换目录」「解除锁定」放在设置页「知识库目录」，避免在文件树里误触切根。
- 授权丢失时，文件树位置显示「重新授权」按钮，点它重开选择器并预置上次目录；不要提供「随便选一个」的入口。
- 拖拽移动首版不做；「移动到…」放在动作表里，弹目录选择（后续版本）。
- 平板把文件树收起到 0 宽时，顶栏 `☰` 仍能拉回；收起状态不写坏 `panes`。

### 5.6 编辑器

- 手机：`.editor` 去掉最大宽度，左右 padding 16px，上下 24px / 80px；字号 16px，行高 1.75，标题层级按比例缩小。
- 平板：编辑区 `max-width: 860px` 居中，左右 padding 40-48px，字号 16-17px，行宽控制在约 80 个字符；编辑区实际宽度不足 720dp 时 padding 收到 24px。
- 平板宽屏且编辑区 ≥ 720dp 时显示 WYSIWYG 行号装订线；双窗格每格不足 720dp 时自动隐藏，不挤正文。
- 双窗格时每个窗格是独立 ProseMirror 实例，各有标签条、滚动位置与脏标记；每格最小 350dp，分隔条 8dp，只允许左右排列。
- 代码块、表格允许横向滚动，外层容器 `overflow-x: auto`；不把整页撑宽。
- 图片默认宽度 100%，点击进查看器；查看器支持双指缩放、单击关闭，平板可用双指捏合与鼠标滚轮。
- 选区工具条：手机保留一排加粗 / 斜体 / 链接 / 高亮 / AI；平板在鼠标或触控笔下显示完整两排，纯触摸时仍用紧凑排但按钮 44dp。
- 源码模式（CodeMirror）保留，入口在「更多」；软键盘下不自动切模式。

### 5.7 格式、插入与 AI 入口

- 手机顶部格式条按钮 44dp，横向滚动；左侧 `＋` 插入块按钮打开底部动作表：标题、无序 / 有序 / 任务列表、引用、代码块、表格、图片、分隔线、AI。
- 平板格式条可用一到两行展示更多按钮（段落、标题、列表、任务、引用、代码、链接、表格、图片、AI），不横向滚动；剩余项进「更多」。
- 插入表格仍用 `table-picker`，手机格子 40dp 以上，平板 32dp 以上；鼠标操作时格子可 hover。
- 斜杠菜单保留：手机用底部动作表；平板有鼠标 / 触控笔时锚在光标旁，纯触摸时仍走底部动作表。
- 选区 AI 五个任务保留；手机结果用全屏底部面板，平板结果用最大 560dp 的居中 / 侧贴面板，流式预览 + 替换 / 插入 / 复制 / 停止。

### 5.8 菜单、长按与悬浮

- 现有自绘菜单（`.cv-menu`）按最近输入分流：触摸用底部动作表（`position: fixed; left: 8px; right: 8px; bottom: calc(8px + env(safe-area-inset-bottom))`），鼠标 / 触控笔用光标位置菜单；`placeMenu` 在触摸态不写 `left/top`。菜单项最小高度 44dp，鼠标态可 36dp。
- 长按统一由 `src/mobile/long-press.js` 处理：`pointerdown` 记时，移动超过 8dp 或 500ms 内抬起则取消；命中后触发动作表并吞掉随后的 click。挂在文件行、标签、图片、表格这些非文本区域。
- 编辑器正文不挂长按菜单：触摸保留系统文本选择手柄与复制 / 粘贴 / 全选；鼠标右键走现有编辑器右键菜单；触控笔按鼠标路径处理。
- Android 不安装全局 `installGlobalContextMenu` 的压原生逻辑；自绘区域各自绑 `contextmenu`（鼠标）与 long-press（触摸），编辑器正文保留系统菜单。
- 悬浮预览（`wiki-hover.js`）只在 `hover: hover` 且最近输入是鼠标 / 触控笔时开启；纯触摸关闭，点 `[[链接]]` 直接跳转，长按链接触发「打开 / 复制链接 / 新建（目标不存在）」动作表。
- 混合设备（平板接键盘、ChromeOS、折叠屏外接鼠标）不按 `pointer: coarse` 一刀切，按 `inputModality.js` 的最近输入切换菜单与 hover。

### 5.9 键盘与输入法

- 手机软键盘没有修饰键，快捷键只作为外接键盘能力保留；高频动作全部有可见入口。
- 平板外接键盘 / 触控板：Ctrl / Cmd / Alt 快捷键、Tab、F2、Ctrl+Tab、命令面板全部可用；触控板双指滚动等同鼠标滚轮，不触发文本选择。
- `visualViewport` 的 `resize` / `scroll` 更新 `--nl-kb-h`；手机软键盘弹出时隐藏底部导航，平板只收缩编辑区，不隐藏文件树。
- 中文 / 日文输入法的组合输入依赖 ProseMirror 现有 `composition` 处理，不改 `dispatchTransaction`。手机与平板软键盘都要覆盖中文候选词上屏、拼音未上屏时按删除、输入法切换。
- 回车就是 Enter；Shift+Enter 的硬换行只对外接键盘可用。
- 触控笔只当精确指针：选择、拖选区、点击链接、hover 预览；不做手写识别。

### 5.10 安全区与屏幕适配

- `index.html` 的 viewport 改为 `width=device-width, initial-scale=1.0, viewport-fit=cover`。
- `#app` 高度：先 `100vh` 回退，再 `@supports (height: 100dvh) { height: 100dvh }`；容器用 `min-height: 0` + flex，避免固定高度在分屏和键盘弹出时溢出。
- 安全区以 `getInsets` 返回值为准：`--nl-inset-top/right/bottom/left` 与 `--nl-kb-h` 由 JS 写到 `:root`，`env(safe-area-inset-*)` 只作回退。横屏刘海、平板圆角、手势导航条、折叠屏铰链都走同一套变量。
- 系统栏：Android 15 起强制边到边，状态栏 / 导航栏颜色与图标明暗由主题配置；不能只靠状态栏底色遮住内容。
- 旋转、系统分屏、自由窗口、折叠展开都会改变可用宽高：`nl:android-config` 后重新算形态、窗格上限与 inset，不重载页面；标签、滚动位置与未保存内容保留。
- `@media (hover: none)` 只用于没有 hover 的设备；混合设备用 `body.nl-input-mouse` / `nl-input-touch` 覆盖具体样式，避免平板接鼠标时还禁用 hover。
- `-webkit-text-size-adjust: 100%`，禁止系统字体缩放把布局撑坏；应用内字号设置仍然生效。

### 5.11 平板布局

平板按宽度分两档，不做“放大版手机”，也不做桌面式三栏以上：

| 形态 | 可用宽度 | 文件树 | 编辑器 | 检查器 / AI | 窗格 |
| --- | --- | --- | --- | --- | --- |
| `phone` | < 600dp | 抽屉 | 全宽 | 全屏 / 抽屉 | 1 |
| `tabletMedium` | 600-839dp | 常驻 240-280dp | 剩余宽度，max 860 | 右侧浮层 360dp | 1 |
| `tabletExpanded` | ≥ 840dp | 常驻 260-320dp，可收起 | 剩余宽度，max 860 | 窗口 ≥ 1200dp 且扣除两栏后编辑区 ≥ 480dp 时常驻 300-360dp，否则浮层 | 默认 1，宽屏可 2 |

分栏规则：

- 只有 `canSplitEditor` 为真才显示「左右拆分」；上下拆分、三窗格、拖拽落边拆第三格一律禁用。
- 两窗格时检查器收成浮层，AI 也走浮层；每个窗格最小 350dp，分隔条 8dp，比例限制 25%-75%。
- 宽度缩回单窗格阈值或转竖屏时，保留焦点窗格，把另一窗格的标签按顺序并回焦点窗格并去重；脏文档不关闭，未保存内容不丢。恢复宽屏不自动再拆。
- 关闭一个窗格时，如果它还有标签，先处理未保存改动，再把剩余标签并回另一窗格；只剩一个窗格时保留空态。
- 两窗格的标签可互相拖移；已有两窗格时落边不再拆新格，落中间是移动 / 排序。

多窗口与折叠：

- Android 系统分屏把窗口压到 < 600dp 时，切回手机单窗格布局；返回全屏后恢复平板布局与窗格，不重载页面。
- 自由窗口 / ChromeOS 拖动改宽时实时重算形态；跨过 600 / 840 阈值只调整布局，不重建编辑器。
- 折叠屏展开后按可用宽度走 `tabletExpanded`；铰链方向与 posture 放 Phase 5 用 `androidx.window` 处理，首版不把内容压在铰链上。
- ChromeOS / 外接键盘鼠标：鼠标右键、hover 预览、触控板滚动、快捷键按桌面习惯可用；仍不挂托盘、窗口按钮与自研多窗口管理。

持久化：

- 文件树宽度、检查器宽度与开合、分栏比例、焦点窗格、各窗格标签按形态分别存；手机不写分栏比例。
- 同一份 `settings.json`，但读取时按当前 `formFactor` 裁剪；桌面 `panes` 不参与。
- 旋转 / 分屏 / 折叠切换不写坏 `panes`，下一次恢复按上次形态的布局。

平板验收：

- 600dp 竖屏：文件树常驻 + 编辑区，能看到正文而不是只剩抽屉入口。
- 840dp 横屏：文件树 + 编辑区两栏；检查器 / AI 从右侧浮层打开；正文行宽不超过 860dp。
- 1000dp 横屏：可并排两篇文档，各自标签独立；检查器收起为浮层；旋转回竖屏后多余窗格标签并回，内容不丢。
- 1200dp 横屏：文件树 + 编辑区 + 检查器三栏同时可见；收起检查器后可并排两格。
- 系统分屏半屏：自动退回手机单窗格，返回全屏恢复；外接键盘快捷键、鼠标右键、触控笔选择可用。

### 5.12 无障碍

- 所有图标按钮给 `aria-label` / `title`（复用现有词条），触控目标不小于 44dp。
- 底部导航与动作表使用 `role="navigation"` / `role="menu"`，焦点顺序按视觉顺序。
- 主题对比度沿用现有三套主题；暗色主题下状态栏图标用浅色，这个在 Android 主题里配。

### 5.13 首次启动与锁定目录

首次启动是独立的全屏页，不是桌面式小模态：

```
┌─────────────────────────────────┐
│                                 │
│            NoteLume             │
│                                 │
│   选择一个文件夹作为笔记库       │
│   笔记仍是普通 md，其他编辑器能开 │
│   首次选一次，之后启动直接进入     │
│                                 │
│        [ 选择笔记文件夹 ]         │
│             稍后再说             │
└─────────────────────────────────┘
```

- 主按钮调 `pickTree`，选择器初始位置指系统 `Documents`（取不到就省略），文案建议新建或选择 `Documents/NoteLume`。不在 Documents 下自动建目录：SAF 没有「创建目录并同时授权」的原子动作，假装一键建库会在部分机型上失败。
- 次按钮「稍后再说」进入空态，可以新建草稿；草稿保存时仍要求先选库或选导出位置。下次启动继续出引导页。
- 授权丢失页复用同一壳：显示锁定的库名与「重新授权」按钮，副按钮「更换目录」。重新授权成功后回编辑态，不重建锁。
- 设置页新增「知识库目录」组：显示库名、URI 截断展示、锁定时间，按钮「更换目录」「解除锁定」。两个动作都先保存或关闭当前文档，再释放旧授权。
- 锁图标用 SVG sprite 新增 `i-lock` / `i-unlock` 两枚，不引入 emoji 或临时字形；文案五语言。
- UI 文案写「锁定目录」，不写「只读」。锁定只固定应用内的库根，不阻止桌面版或其他编辑器改文件，避免用户误解为文件锁。

## 六、文件与数据语义

### 6.1 打开与最近

| 操作 | 语义 |
| --- | --- |
| 首次锁定 | 引导页 → `pickTree` → `takePersistableUriPermission` → 写 `lockedVault` → `scan_vault` → 建索引 → 恢复标签 |
| 启动直达 | 只读 `lockedVault`；授权有效就直接进入，不弹选择器；标签与上次文档恢复 |
| 重新授权 | 授权失效时保留 URI，选择器预置上次目录；选回同一目录即恢复；选了别的目录先确认「更换锁定目录？」 |
| 更换目录 | 设置页入口；保存 / 关闭当前文档 → 释放旧授权 → 切新锁 → 重建索引与标签 → 最近记录换批 |
| 解除锁定 | 设置页入口；保存 / 关闭当前文档 → 释放授权 → 清空当前标签与索引缓存 → 回首次引导页；不删文件 |
| 最近打开 | 只记锁定库内文档；`root` 恒等于 `lockedVault`，不出现其他库根 |
| 外部入口 | 拖入文件夹、其他库的最近记录、`file-opened` 事件一律拒绝并提示「知识库已锁定」；换库只走设置页 |

### 6.2 编辑与保存

| 操作 | 语义 |
| --- | --- |
| 手动保存 | 走 `write_md_file`；保存成功更新 mtime 与标签脏标记 |
| 自动保存 | 停手 2s 写盘；`onPause` 强制 flush；失败在面板内提示，不静默 |
| 备份 | 每 120s 或手动保存前写应用私有备份；保留最近 20 份 / 7 天 |
| 草稿 | 未开库新建落 `files/scratch`；重开后认出草稿并提示保存位置 |
| 大文件 | 沿用桌面 2MB 阈值与虚拟化开关；手机上首次打开超阈值文档给一次提示 |

### 6.3 外部修改

没有文件监听，冲突检测靠保存前的 `stat`：

1. 打开文档时记 `{mtime, size}`。
2. 保存前读取当前 `stat`；相同则直接写。
3. 不同且编辑器无改动：重新读取并替换编辑器内容，提示「已重新加载」。
4. 不同且有改动：弹三选一（重新加载 / 保留本地并覆盖 / 取消）。
5. 回到前台超过 30 秒：后台重扫清单；当前文档 mtime 变了但编辑器干净，静默重载。

### 6.4 新建、重命名、删除、恢复

| 操作 | 语义 |
| --- | --- |
| 新建笔记 | 当前库内当前目录新建 `.md`，重名追加 `-2`；未开库落草稿 |
| 新建文件夹 | 当前目录下建，重名拒绝 |
| 重命名 | 同目录改名；目标存在拒绝；provider 不支持 rename 时回可读错误 |
| 删除 | 移入 `.notelume-trash/`；失败按 §4.7 降级 |
| 回收站 | 列出条目，恢复回原路径；清空需二次确认 |
| 图片插入 | 选择器 → `assets/`；同内容复用，异内容加指纹 |
| 导出 | 单篇 HTML / Markdown / 幻灯片 HTML；用户选目标位置 |

### 6.5 设置与缓存

`settings.json` 仍由 Rust 读写 `app_config_dir()`。新增键：

- `workspace.lockedVault`：Android 唯一知识库的 tree URI。
- `workspace.lockedVaultName`：文件树与设置页展示的目录名。
- `workspace.lockedAt`：锁定时间，ISO 8601。
- `workspace.lastVault` / `lastVaultName`：桌面继续用；Android 首次升级时若只有旧 `lastVault`，可一次性迁移成锁，之后只读写 `lockedVault`。
- `ui.formFactor` 不落盘，运行时算。
- `backup.retainDays` / `backup.retainCount` 可选，默认 7 / 20。

应用私有缓存目录：`cache/manifest/<tree-hash>.json`、`cache/index/<tree-hash>.json`、`backups/`、`files/scratch/`。这些目录不参与知识库扫描，也不随「导出」带走。

## 七、平台能力矩阵

| 能力 | 桌面（现状） | Android 首版 | 说明 |
| --- | --- | --- | --- |
| 知识库文件夹 | 原生目录，可开多个 | SAF tree URI，单库锁定 | 核心差异，走 `VaultFs`；首次选一次，之后直达 |
| 切换知识库 | 菜单 / 最近列表 | 仅设置页「更换目录」 | 文件树、最近、拖入、Intent 都不能改根 |
| 单文件打开 | 支持 | 不做 | Phase 5 接 `ACTION_VIEW` |
| 文件监听 | `notify` | 不做 | 回前台刷新 + 保存前 mtime 校验 |
| 标签页 | 多窗格 | 手机单窗格，平板最多 2 | 平板宽屏且检查器收起时可并排 |
| 分栏 | 支持 | 手机不做，平板最多左右 2 | 不做上下拆分与三栏以上 |
| WYSIWYG / 源码 | 支持 | 支持 | 同源 |
| 大纲 / 标签 / 属性 / 反链 | 支持 | 支持 | 索引改 `VaultFs` |
| 全库搜索 | 支持 | 支持 | 批量读 + 可选缓存 |
| 双链 / 悬停预览 | 支持 | 触摸关闭，鼠标 / 笔保留 | 触摸用长按动作表 |
| 右键菜单 | 支持 | 鼠标右键 / 触摸长按 | 按最近输入分流 |
| 快捷键 | 支持 | 外接键盘保留 | 手机软键盘靠可见入口 |
| 拖放打开 | 支持 | 不做 | Android 用系统 Intent；平板多窗口拖入不承诺 |
| 多窗口 | 支持 | 兼容系统分屏 / 自由窗口 | 不自研桌面式窗口管理 |
| 平板布局 | 支持 | 中等与宽屏两档 | 600 / 840dp 断点，宽屏最多两窗格 |
| 外接键盘 / 鼠标 | 支持 | 支持 | 快捷键、hover、右键、触控板滚动 |
| 触控笔 | 支持 | 精确指针 | 选择 / hover / 点击；不做手写识别 |
| 折叠屏 | 支持 | 按展开宽度走平板断点 | 铰链双栏 Phase 5 |
| AI Ask / Agent | 支持 | 支持 | TLS 换 rustls / ring |
| 语音输入 | Windows / 浏览器 | 不做 | Phase 5 单独做 |
| 图片插入 / 查看 | 支持 | 支持 | 选择器 + data URI |
| 单篇导出 HTML / MD / 幻灯片 | 支持 | 支持 | SAF 保存 |
| 整站导出 / docx | 支持 | 不做 | 后续批次 |
| 打印 | 支持 | 不做 | |
| Git | 支持 | 不做 | git2 不编译 |
| 网页剪藏服务 | 支持 | 不做 | 手机回环地址对 PC 扩展无意义 |
| Canvas | 支持 | 不做 | 触屏交互需重做 |
| 知识图谱 | 支持 | 不做 | 同上 |
| 插件 | 支持 | 不做 | 安全模型未定 |
| 模板 / 每日速记 | 支持 | 不做 | 后续按 SAF 重接 |
| Quarkdown 文本求值 | 支持 | 支持基础语法 | 文件类函数降级 |
| 主题 / 五语言 / 设置 | 支持 | 支持 | 复用 |

## 八、实施阶段

每个阶段可独立验收，后一阶段不要求前一阶段的 UI 细节全部完成。

### Phase 0：构建闸口（spike）

- `npm run tauri -- android init`，生成 `src-tauri/gen/android`；跑通 `android dev` 到真机或模拟器。
- 按 §4.10 拆 `Cargo.toml` 目标依赖；修 `trash`、`reveal_in_folder`、`open_url`、`set_decorations` 的编译阻断。
- 写一个最小 Kotlin 插件，跑通 `pickTree`（带 `initialUri`）/ `listAll` / `readText` / `writeText` 四个命令。
- 用 500 篇 md 的库量一次 `listAll` 与批量读耗时；用 DeepSeek HTTPS 与局域网 Ollama HTTP 各发一次请求，确认 rustls / ring 可用。
- 在 800dp 平板模拟器上确认 `configChanges` 不重建 Activity、`getInsets` 返回值正确；系统分屏压到 500dp 时能退回手机布局。
- 退出判据：应用装到真机，能选一个 SAF 目录、读出文件树、打开一篇 md、写回一次；杀进程重开直接进入同一目录，不再弹选择器；构建命令可在 CI 复现。

### Phase 1：可打开的壳

- `platform.js`、`titlebar.js` 平台修正；隐藏桌面工具栏、菜单条、窗口按钮。
- `mobile.css` 三档壳层：手机、平板中等（600-839dp）、平板宽屏（≥840dp）；手机底部导航，平板文件树常驻、无底部导航。
- 平板安全区：`getInsets` → CSS 变量；`nl:android-config` 重算形态、窗格上限与 inset。
- 首次启动引导页与单库锁定：`src/mobile/locked-vault.js`、`pickTree(initialUri)`、持久化授权、启动直达、授权丢失页。
- 手机单窗格；平板宽屏可拆左右两格，标签条与文件树可打开文档；WYSIWYG 只读渲染。
- 退出判据：360dp 手机和 600dp / 840dp 平板都能打开库、点文件、阅读；旋转与系统分屏不重载；杀进程重开直达。

### Phase 2：可编辑

- `VaultFs` 写路径；保存、自动保存、冲突检测、草稿恢复。
- 新建 / 重命名 / 删除 / 回收站；图片插入与查看。
- 平板双窗格：`canSplitEditor`、左右拆分、标签并回、分栏比例持久化；两窗格各自标签与脏标记。
- 返回键未保存询问；`onPause` flush；中文输入法验收。
- 退出判据：1MB 文档编辑保存后与桌面版逐字节一致；1000dp 横屏能并排两篇且各自标签独立；后台杀进程能恢复草稿。

### Phase 3：知识库能力

- 索引重建改 `VaultFs`；全库搜索、反链、大纲、标签、属性。
- 最近打开、授权丢失恢复、回前台刷新。
- 设置页「知识库目录」：更换 / 解除锁定，先保存当前文档再释放旧授权。
- 平板检查器常驻 / 浮层切换、属性与反链在宽屏下的排版。
- 退出判据：200 篇库搜索命中正确；反链与桌面一致；授权回收后能重新授权；更换目录后索引与标签重建，旧库文件不被删除。

### Phase 5：打磨与发布

- 折叠屏铰链、ChromeOS / 自由窗口、触控笔、鼠标 / 触摸混合输入、横屏安全区、暗色状态栏、TalkBack。
- `ACTION_VIEW` / `ACTION_SEND`（file association 与分享接收）。
- 性能优化：清单缓存、索引缓存、图片懒加载、长列表、两窗格内存。
- release 签名、`--aab`、Play 上架材料；桌面端回归。
- 退出判据：§9 的真机清单全过，桌面测试与打包不受影响。

## 九、测试与验收

### 9.1 纯逻辑单测

新增：

- `src/tests/platform.test.mjs`：UA → 平台；Android 不再落 `linux`；`formFactorFor` 边界 599 / 600 / 839 / 840；`canSplitEditor` 的宽度、横竖屏、窗格数组合。
- `src/tests/vault-path.test.mjs` 补：`content://` 不做 lowercase、尾斜杠归一、`rootChanged`。
- `src/tests/mobile-back.test.mjs`：返回栈顺序（动作表 → 抽屉 → AI 流 → 脏文档询问 → 退出），每一步只做一件事。
- `src/tests/mobile-shell.test.mjs`（jsdom）：手机底部导航；平板无底部导航、文件树常驻、检查器浮层；单窗格归一；宽屏两窗格；窄回时标签并回；AI 面板全屏 / 侧浮层；键盘 inset 变量。
- `src/tests/mobile-input-modality.test.mjs`：pointer type 切换；鼠标右键 / hover / 长按按最近输入分流；触控笔走鼠标路径。
- `src/tests/mobile-locked-vault.test.mjs`：首次引导 → 锁定；启动直达；授权丢失保留锁；重新授权选到别的目录先确认；非锁定 root 的 `openVaultPath` / 最近 / 拖入被拒；更换与解除的状态迁移。
- `src/tests/mobile-menu.test.mjs`：命令注册表在 Android 上过滤掉 Git / 打印 / 剪藏 / Canvas / 插件 / 语音 / 模板 / 速记；平板上 `splitH` 可见、`splitV` 不可见。

Rust：

- `vault_fs::tests`：`normalize_rel` 的 `..` / 绝对路径 / 反斜杠 / 空段；`LocalVaultFs` 与旧 `abs_in_vault` 行为一致。
- `MemoryVaultFs` 驱动 `scan_vault`、索引构建、备份命名、回收站元数据。
- `mobile_fs::tests`：Kotlin 错误码 → `ui_lang` 词条映射；清单 JSON 解析；批量读的批次切分。
- `cargo test --lib` 在桌面跑，Android 专属分支用 `cfg` 隔离，不能因为在 Windows 上跑不了就删测试。

Kotlin（可选但推荐）：

- `MobileFsPluginTest`：rel ↔ documentId 映射、清单解析、非法 rel 拒绝、`ACTION_CREATE_DOCUMENT` 结果写入。

### 9.2 构建与回归

- `npm run build:web` 无错。
- `npm run build` 桌面包正常（`postbuild` 的 mac 逻辑不受影响）。
- 前端 `src/tests/*.test.mjs` 全量通过。
- `cargo test --lib` 全量通过。
- `npm run tauri -- android build --apk` 出包；CI 增加 Android 构建作业（可先手动）。

### 9.3 真机矩阵

| 设备 | 版本 | 用途 |
| --- | --- | --- |
| Pixel 6 或同级 | Android 14 | 手机主验收，arm64 |
| 低端机（4GB 内存） | Android 10 | 性能与内存下限 |
| 7 英寸平板 | Android 13，600dp 宽 | 平板中等：常驻文件树 |
| 10 英寸平板 | Android 14，800dp 宽 | 平板中等 / 宽屏切换 |
| 12.9 英寸平板 | Android 14，1024dp 宽 | 宽屏三栏与两窗格 |
| 折叠屏 | Android 14，展开 700-900dp | 展开 / 折叠、旋转 |
| ChromeOS / 自由窗口 | 最新稳定版 | 鼠标、键盘、窗口缩放 |
| 模拟器 | API 24 x86_64 | 最低版本兼容 |

### 9.4 验收场景

1. 首次锁定与直达：首次出引导页 → 选择 `Documents/NoteLume` → 文件树出现；杀进程重开直接进入，不弹选择器；系统设置撤销授权后重开出「重新授权」并预置上次目录；重选同一目录恢复，选别的目录弹「更换锁定目录？」。
2. 编辑：中文输入法输入、加粗、列表、任务、表格、代码块、图片；保存；桌面打开逐字节比对。
3. 文件操作：新建、重命名、删除进回收站、恢复、清空；同名冲突提示。
4. 冲突：用桌面版改同一篇后再在手机上保存，三条分支（重载 / 覆盖 / 取消）都走一遍。
5. 搜索：200 篇库搜中文与英文关键词；反链目标正确；大纲跳转。
6. AI：DeepSeek HTTPS 流式问答、停止、插入；局域网 Ollama `http://192.168.x.x:11434` 问答；后台切换时请求取消。
7. 导出：HTML 用系统浏览器打开，样式与图片正常；Markdown 落盘。
8. 布局：360×640、412×915、800×1280；横竖屏；暗色；五语言；字号调大。
9. 返回键：动作表 → 抽屉 → AI → 脏文档 → 退出，逐层验证。
10. 生命周期：后台 10 分钟回来，文件树刷新，当前文档未丢；低内存杀进程后草稿恢复。
11. 性能：冷启动 ≤ 3s；500 篇库打开 ≤ 2s（有缓存）；切文件 ≤ 300ms；输入无可感知卡顿；5MB 文档内存峰值 ≤ 400MB。
12. 锁定闸门：从最近、拖入、外部 Intent 尝试切到另一个库，全部被拒绝并提示；设置页更换目录成功后旧库文件仍在、新库索引重建；解除锁定回引导页。
13. 600dp 竖屏：文件树常驻 + 编辑区，正文可见；没有底部导航；检查器与 AI 是右侧浮层。
14. 840dp 横屏：文件树 + 编辑区两栏；检查器 / AI 从右侧浮层打开；正文最大宽 860dp 居中；文件树可收起，编辑区随之变宽。
15. 1000dp 横屏两窗格：左右各开一篇，标签、滚动、脏标记独立；检查器收起为浮层；旋转回竖屏后另一窗格标签并回焦点窗格，内容不丢；恢复宽屏不自动再拆。
16. 系统分屏 / 自由窗口：半屏时退回手机单窗格；拖宽到 840dp 恢复两栏；跨阈值不重载页面；外接键盘快捷键、鼠标右键 / hover、触控笔选择、触控板滚动各走一遍。
17. 1200dp 横屏：文件树 + 编辑区 + 检查器三栏；正文仍不超过 860dp；收起检查器后可并排两格。

## 十、风险与未决

| 风险 | 影响 | 处理 |
| --- | --- | --- |
| SAF 遍历与单文件读写慢 | 大库首开、索引重建、搜索变慢 | Phase 0 真机量；清单缓存 + `readMany` 批量 + 索引缓存；超过 20000 项明确提示 |
| provider 差异 | rename / move / 随机写失败 | 错误码映射；不假设 `renameTo` 成功；回收站有降级路径 |
| rustls + ring 交叉编译 | Android 构建失败 | Phase 0 先验；不通再评估 vendored OpenSSL（不推荐） |
| `trash` / `git2` / `cpal` 的平台分支 | 编译失败或功能误暴露 | 目标依赖 + `cfg` 收口；命令注册 stub；前端能力表过滤 |
| WebView 版本碎片 | `dvh` / `backdrop-filter` / `:has` 不支持 | 只用渐进增强；`100vh` 回退；`@supports` 分支；低端机真机验收 |
| Android 15 边到边 / 多窗口 inset | 内容被系统栏压住或错位 | `getInsets` + CSS 变量；`configChanges` 不重建；真机覆盖分屏 / 横屏 / 折叠 |
| 平板两窗格内存与 DOM | 低端平板卡顿 | 上限 2 格、每格 350dp、第二格按需装载；只读预览优先；真机测量 |
| Activity 重建 / WebView 未 resize | 旋转后布局错或丢状态 | `configChanges` + `nl:android-config`；标签与草稿兜底；不依赖 `100vh` |
| 折叠屏铰链 / ChromeOS 窗口 | 内容压铰链或窗口缩放错 | Phase 5 用 `FoldingFeature`；窗口 resize 重算；不承诺桌面式多窗口 |
| 混合输入 | 接鼠标的平板仍被当触摸 | `inputModality.js`；hover / 右键 / 长按按最近输入分流 |
| 常驻文件树挤压正文 | 600dp 正文过窄 | 树宽 `clamp(240px, 32vw, 280px)`、可收起；< 700dp 默认 240 |
| 系统杀进程 | 未保存内容丢失 | 2s 自动保存 + `onPause` flush + 草稿恢复 |
| 外部改动无法实时发现 | 覆盖别人刚改的内容 | 保存前 mtime 校验；回前台刷新；三选一提示 |
| API Key 进系统备份 | 密钥随 Google 备份离开设备 | `allowBackup=false` 或 data extraction rules 排除；设置页写明 |
| 包名 `app.notelume.desktop` | Play 上架后不可改 | 上架前决策；不改则接受命名 |
| 首版隐藏功能多 | 桌面用户预期落空 | README 与发布说明写清「Android 首版能力」；设置页不出现不可用入口 |
| 单文件打开 / 分享接收 | 文件管理器点 md 不能直达 | Phase 5 接 Intent；首版在 README 说明先打开文件夹 |
| Quarkdown 文件类函数 | `include` / `read` 在 SAF 下不可用 | 按诊断降级；库与包安装隐藏；后续走 `VaultFs` |
| SAF 不能自动创建并授权默认目录 | 用户以为能零选择建库 | 首次引导 + `EXTRA_INITIAL_URI` 指 `Documents`，文案建议新建 `NoteLume`；不承诺一键建库 |
| 单库锁定与桌面多库习惯不同 | 用户找不到「打开其他库」 | 设置页「更换目录」写清；README 说明 Android 首版单库 |
| 「锁定」被理解成文件锁 | 用户以为外部编辑器不能改 | UI 文案只写「锁定目录」，并注明不阻止其他编辑器修改 |
| 选错目录后想换 | 需要先保存、再释放授权 | 更换流程先处理未保存改动；取消不动旧锁 |

未决问题：

1. 是否在首个版本就支持「在其他应用里点 md 用 NoteLume 打开」。涉及 Intent、单文件授权与图片相对路径，建议放 Phase 5。
2. 包名是否在 `android init` 前改成 `app.notelume`。改则要迁移桌面设置目录，不改则 Play 包名不理想。
3. 模板、每日速记、docx 导入导出是否在第二个 Android 版本补。它们都依赖 SAF 写路径，技术上可复用首版能力，但会拉长首版验收。
4. 平板两窗格首版做左右两格，不做上下与三格；12.9 英寸是否需要三格，等真实使用再评估。
5. 单库锁定是否要升级成多工作区（每个工作区一个锁）。首版不做；如果做，入口必须和「更换目录」分开，避免文件树里出现两套根。
6. 是否在首次引导里提供示例库或模板库。示例库要写进用户选中的目录，涉及批量创建文件与进度提示，首版不做。

## 十一、交付与文档

- 实现分支 `feat/android`，从最新 `origin/master` 拉出；不合并 `web`，不把 `web` 的内容摘进来。
- 生成并入库 `src-tauri/gen/android`；keystore、`keystore.properties`、签名口令不入库。
- 实现完成后同步更新：
  - `CHANGELOG.md` 的 `Added`（Android 首版能力、手机 / 平板布局、平台分支、构建命令）。
  - `docs/ROADMAP.md` 批次 G 状态与链接。
  - `README.md` 中英两版：平台徽标、安装表、Android 首版能力与限制（SAF 单库锁定、首次选一次、换目录在设置、手机单窗格 / 平板两窗格、无 Git / 剪藏 / 打印 / 插件）。
  - `docs/CLAUDE.MD` 的「技术栈」「架构设计」补 Android 手机 / 平板目标与 `VaultFs` 口径；「功能清单」P2 移动端标注为 Android 首版设计中。
- 本文件只定设计与阶段，不在本轮写实现代码；实现前先按 Phase 0 做构建闸口，闸口不过不进入 UI 改造。