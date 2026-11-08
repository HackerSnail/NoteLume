# 设计：NoteLume 苹果移动端（iOS / iPadOS，Tauri v2）

- 状态：设计完成，待 Phase 0 闸口
- 日期：2026-11-08
- 范围：iPhone 与 iPad 首版；iOS / iPadOS 15.0 起
- 来源：2026-11-08 用户指令「苹果移动端也要适配」；承接 Android 手机 / 平板与鸿蒙端 spec
- Tauri 基线：官方 Tauri v2（不是社区移植版）；iOS 插件用 Swift `Plugin` + `run_mobile_plugin`
- 最低版本：iOS 15.0（Tauri v2 配置默认值，本地 `config.schema.json` 已确认）
- 构建环境：macOS + Xcode + CocoaPods；Windows 上 Tauri CLI 没有 `ios` 子命令，不能本机出包
- 一句话：iPhone 复用手机单窗格，iPad 复用平板双窗格；文件层从 Android 的 SAF 换成 iOS 的 security-scoped bookmark + `NSFileCoordinator`，其余内核与前端继续共用。

## 一、目标与边界

### 1.1 首版必须成立的承诺

1. 用户在「文件」App 里选一个笔记文件夹（iCloud Drive、我的 iPhone、外置盘或第三方 provider），之后启动直达同一目录；笔记仍是普通 md，其他 App 能打开。
2. 编辑器与桌面同源。ProseMirror schema、markdown 解析与序列化、GFM 往返规则不改；iPhone / iPad 保存的文件与桌面版逐字节一致。
3. 文件树、`[[链接]]`、标签、大纲、全库搜索、反链、AI 问答可用。
4. iPhone 单窗格；iPad 按宽度给持久文件树、检查器与最多两个编辑器窗格。不做三栏以上，也不把 iPad 当放大版 iPhone。
5. iOS 的生命周期、安全区、键盘、返回手势、iPad 多任务按平台重做，不把 Android 的返回键与 inset 逻辑直接搬过来。

### 1.2 首版验收判据

- 在 macOS 或 macOS CI 上能产出签名 / TestFlight 可安装的 IPA；Windows 本机只做前端与 Rust 单测。
- 在「文件」App 选 `iCloud Drive/NoteLume` 或「我的 iPhone/NoteLume」，持久化 bookmark 成功；杀进程、重启设备后启动直达，不重新选目录。
- bookmark 失效或目录被移动时能提示重新授权；选到别的目录先确认「更换知识库」。
- 编辑一篇 1MB md（中文、表格、代码块、图片、公式），保存后下载与桌面版逐字节一致。
- 200 篇库的文件树、搜索、反链、AI 可用；iCloud 未下载的占位文件有明确下载提示。
- iPhone SE / 15 / iPad 10 / iPad Pro 上布局正确；旋转、Split View、Slide Over、Stage Manager 改宽不丢标签与未保存内容。
- 外接键盘快捷键、iPad 指针 hover / 右键、Apple Pencil 选择按设备能力可用。

### 1.3 明确不做

- iOS 15 以下。Tauri v2 默认最低 15.0，低于它不承诺。
- Apple Watch、visionOS、tvOS。只做 iPhone / iPad。
- 云同步、账号、端到端加密。手机端只读写用户选中的本地 / iCloud 目录。
- 手写识别、笔迹笔记、压感绘图。Apple Pencil 只当精确指针。
- 三栏以上分栏、自研桌面式多窗口管理。iPad 系统 Split View / Slide Over / Stage Manager 只做兼容。
- 首版不做语音输入与系统打印；语音放 Phase 5，用 `SFSpeechRecognizer`；打印用导出 / 分享替代。
- Git、网页剪藏服务、Canvas、知识图谱、插件、模板、每日速记、docx 导入导出首版隐藏，与 Android spec 口径一致。
- 把 `web` 分支或云端代码合并进来。iOS 是独立移动端实现，走 `feat/ios`。

## 二、现状与差距

### 2.1 可以复用的部分

与 Android spec 共用：

- `src/editor-view.js`、`src/editor-schema.js`、markdown 往返测试。
- `src/commands.js`、`src/i18n.js`、`src/appearance-settings.js`、`src/settings-store.js`。
- `src/tabs.js`、`src/split-pane.js`；iPhone 单窗格，iPad 最多两格。
- `src/ai-tasks.js`、`src/ai-agent.js`、`src/ai-panel.js`；Rust 侧 `ai.rs`。
- `src/site-export.js`、`src/slides-export.js`、`src/plain-export.js`；iOS 上生成后走分享 / 文档选择器保存。
- Android spec 的 `VaultFs` 抽象、单库锁定状态机、移动壳层、底部导航、长按动作表。
- `src/index.html` 的 SVG 图标表与 `src/icons.js`。

iOS 只补平台层、构建链与 Apple 特有交互，不重写编辑器。

### 2.2 iOS 与 Android 的硬差异

| 差异 | Android | iOS |
| --- | --- | --- |
| 文件授权 | SAF `content://` + `takePersistableUriPermission` | `UIDocumentPickerViewController` 选目录 + security-scoped bookmark |
| 持久访问 | tree URI 直接持久化 | `bookmarkData` 存 base64，启动 `URL(resolvingBookmarkData:)`；`startAccessingSecurityScopedResource` |
| 文件协调 | `ContentResolver` 直接读写 | 必须 `NSFileCoordinator` 读写，尤其 iCloud |
| iCloud 占位 | 无 | `isUbiquitousItem` / `isDownloaded`，未下载要先 `startDownloadingUbiquitousItem` |
| 构建 | Windows / Linux 可交叉编译 | 必须 macOS + Xcode + CocoaPods；Windows CLI 无 `ios` 命令 |
| 插件 | Kotlin `@TauriPlugin` | Swift `Plugin` + `@objc` + `run_mobile_plugin`，Swift Package |
| 返回 | 系统返回键 | 无系统返回键；页面内返回 / 关闭，禁用 WKWebView 前进后退手势 |
| 安全区 | WindowInsets / getInsets | `env(safe-area-inset-*)` + WKWebView；刘海 / 灵动岛 / Home 指示条 |
| 多窗口 | 系统分屏 / 自由窗口 | Split View / Slide Over / Stage Manager；同一 App 多窗口受 Tauri 支持度限制 |
| 打印 | 首版不做 | 首版不做；用导出 + 分享替代 |
| 分发 | Google Play | App Store / TestFlight；需要 Apple Developer Program、隐私清单、审核 |

### 2.3 与 Android 相同的平台阻断

- `trash` 没有 iOS 平台实现；`delete_file` 不能直接复用。
- `git2` 依赖链在 iOS 上可能引 OpenSSL / libssh2；首版 Git 隐藏，按 `cfg(target_os = "ios")` 收口。
- `notify` 文件监听在 iOS 沙盒里不可靠；首版不做，回前台刷新 + 保存前 mtime 校验。
- `cpal` 录音首版不做；`windows` 依赖仅 Windows。
- `std::process`、`xdg-open`、托盘、原生菜单、多窗口、剪藏 HTTP 服务在 iOS 上不可用或不应启动。
- `reqwest` 的 `native-tls` 在 iOS 走 Security.framework，理论上不引 OpenSSL；Phase 0 验证。
- `voice.rs` 的 cpal / WinRT 路径不编译；语音 Phase 5 用 Swift `SFSpeechRecognizer`。

### 2.4 iOS 特有阻断

- 没有 `std::fs` 直连用户目录。用户选中的 URL 是 security-scoped，必须 start / stop access；Rust 直接按路径读写会失败或越权。
- bookmark 会失效：目录被移动、删除、provider 卸载、App 重装后都需要重新选。不能把它当永久路径。
- iCloud 占位文件不是本地文件；`Data(contentsOf:)` 前要判断 `isDownloaded`，否则读到的是占位或报错。
- 文件写入必须协调，尤其 iCloud 与第三方 provider；直接覆盖会撞 `NSFileCoordinator` 的写冲突。
- App Store 审核对“纯 WebView 壳”敏感；本 App 有本地文件、离线编辑、原生文件桥，仍要在审核说明里写清，不能只放一个网页。
- 隐私清单：UserDefaults、文件时间戳、磁盘空间等 required reason API 要写 `PrivacyInfo.xcprivacy`。
- 加密出口合规：HTTPS 与 Keychain 属标准加密；自实现的 AI Key 加密要按 Apple 出口合规问卷申报。

## 三、关键决策

### 3.1 存储：security-scoped bookmark + 单库锁定

- 选目录：`UIDocumentPickerViewController(forOpeningContentTypes: [UTType.folder], asCopy: false)`，`allowsMultipleSelection = false`。iOS 15 起可用；不复制目录，保持原地访问。
- 持久化：`url.bookmarkData(options: .minimalBookmark, includingResourceValuesForKeys: nil, relativeTo: nil)`，base64 存 `workspace.lockedBookmark`，显示名存 `workspace.lockedVaultName`，时间存 `lockedAt`。
- 启动：`URL(resolvingBookmarkData:options: .withoutUI, relativeTo: nil, bookmarkDataIsStale:)`；`isStale == false` 才继续；`startAccessingSecurityScopedResource()` 后扫描；结束一批操作就 `stopAccessingSecurityScopedResource()`。
- 单库锁定：与 Android 相同，首次选一次，之后直达；换目录 / 解除只在设置页「知识库目录」；文件树、最近、拖入、URL 打开都不能直接切根。
- 失效：bookmark stale、目录不存在、provider 卸载、App 重装都显示「重新授权」；重选同一目录恢复；选别的目录先确认「更换知识库」。
- App 沙盒只放 `settings.json`、草稿、备份、索引缓存、导出临时文件；这些用 Rust `std::fs`。用户库永远走 `IosVaultFs`。
- 不启用 `UIFileSharingEnabled` 把整个沙盒暴露给「文件」App；用户库是用户自己选的目录，沙盒不需要可见。

### 3.2 文件读写：Swift 文件桥 + NSFileCoordinator

- 所有库内 IO 走 Swift 插件：`FileManager` 负责枚举、属性、创建、重命名、删除；`NSFileCoordinator` 负责 read / write / replace；`startAccessingSecurityScopedResource` 包住一批操作。
- 目录枚举：`FileManager.contentsOfDirectory(at:includingPropertiesForKeys:options:)`，取 `isDirectory` / `fileSize` / `contentModificationDate` / `isUbiquitousItem` / `isDownloaded`。
- 读：`NSFileCoordinator.coordinate(readingItemAt:options: [])` 内读 `Data`；UTF-8 解码失败回 `invalid_encoding`，不静默替换。
- 写：先写同目录临时文件，再用 `NSFileCoordinator.coordinate(writingItemAt:options: .forReplacing)` 替换；避免半截文件。
- 重命名 / 删除 / 建目录：对应 `.move` / `.delete` / `.create` 协调选项；目标存在回 `exists`，不静默覆盖。
- 批量读 `read_many`：一次 Swift 调用读多篇，索引重建用；每篇都在协调块内。
- iCloud：
  - 读取前查 `isUbiquitousItem` 与 `isDownloaded`；未下载时 `startDownloadingUbiquitousItem`，回 `downloading` 状态，前端显示「正在从 iCloud 下载」并稍后重试。
  - 不做无限等待；单文件 10 秒超时回 `not_downloaded`，用户可手动重试。
  - 离线时回 `offline`，不把空内容写回。
- 外部改动：iOS 没有可靠的跨 provider 文件监听；回前台 / scenePhase active 时刷新，保存前用 mtime + size 比对。冲突提示与 Android 相同（重载 / 覆盖 / 取消）。

### 3.3 窗格：iPhone 单窗格，iPad 最多两窗格

- iPhone（< 600dp）单窗格；标签条横向滚动；文件树、检查器、AI 都是覆盖层。
- iPad 中等（600-839dp）单窗格 + 常驻文件树 240-280dp；检查器 / AI 右侧浮层 360dp。
- iPad 宽屏（≥ 840dp）文件树 260-320dp；窗口 ≥ 1200dp 且扣除两栏后编辑区 ≥ 480dp 时检查器常驻 300-360dp，否则浮层。
- 两窗格：`canSplitEditor = 可用编辑区 ≥ 720dp && 横屏 && 窗格数 < 2`；只允许左右，不做上下与三格；每格最小 350dp。
- 窄回 / 转竖屏 / Split View 压缩时，保留焦点窗格，把另一窗格标签并回去重；脏文档不关闭；恢复宽屏不自动再拆。
- 复用 `split-pane.js`，不新写引擎；`splitV` 在 iOS 隐藏，落边不拆第三格。

### 3.4 首版范围

保留：单库 bookmark 锁定、文件树、阅读与编辑、保存与自动保存、新建 / 重命名 / 删除 / 回收站、图片插入与查看、iPhone 单窗格 / iPad 双窗格、大纲、属性、标签、反链、全库搜索、AI Ask / Agent、单篇导出 HTML / Markdown / 幻灯片、分享、主题、五语言、设置、最近打开、草稿恢复。

隐藏：Git、网页剪藏、打印、Canvas、知识图谱、插件、语音、模板、每日速记、docx 导入导出、整站导出、分栏三格、多窗口管理、文件关联启动、桌面拖放。

隐藏入口统一走平台能力表，不在各面板临时 `if`。命令不注册或注册为不可见，菜单与命令面板读同一份过滤结果。

### 3.5 Bundle ID 与签名

- 首选 `app.notelume.ios`，与 Android / 桌面区分；App Store Connect 的 Bundle ID 一旦创建不可改，必须在第一次上传前定死。
- `tauri.conf.json` 的全局 `identifier` 保持桌面值；若 Tauri 的 `tauri.ios.conf.json` 支持覆盖 `identifier`，在 iOS 平台配置里写 `app.notelume.ios`；不支持则 Phase 0 决定是否全局改名并迁移桌面设置目录。
- 签名用 Apple Developer Program 证书 + Provisioning Profile；CI 用 App Store Connect API Key 或导入证书的 secrets；证书、Profile、私钥不入库。
- 首版走 TestFlight 内测；App Store 正式上架放 Phase 5。

### 3.6 UI 复用 Android 移动壳层

- 平台标记新增 `ios`；`platform.js` 识别 iPhone / iPad / iPadOS（iPadOS 13+ 的 UA 是 Macintosh，需要 touch points 与 `navigator.platform` 兜底）。
- 复用 Android 的单窗格 / 平板壳层、底部导航、文件抽屉、检查器 / AI 浮层、长按动作表、首次锁定引导页。
- iOS 差异单独放 `src/mobile/ios.css` 或 `data-tauri-platform="ios"` 分支，不把 WKWebView 补丁写进 Android 样式。
- 不引入 UIKit 原生页面重写编辑器；Swift 只做文件桥、生命周期、分享、打开链接、图片选择。

## 四、架构

### 4.1 分层

```
前端（现有模块 + Android 移动壳层）
        │  Tauri invoke，vaultRoot = ios-bookmark://<base64>
        ▼
Rust 命令层（src-tauri/src/lib.rs）
        │  parse_root → Local(PathBuf) | Ios { bookmark }
        ▼
VaultFs（src-tauri/src/vault_fs.rs）
   ├─ LocalVaultFs：桌面 std::fs
   ├─ AndroidVaultFs：Android spec 的 Kotlin 插件
   └─ IosVaultFs：Swift 文件桥
            │  PluginHandle::run_mobile_plugin（同步阻塞）
            ▼
Swift 插件（src-tauri/gen/apple/.../MobileFsPlugin.swift）
   UIDocumentPicker + security-scoped bookmark
   FileManager + NSFileCoordinator + iCloud 下载状态
```

关键点：前端与命令签名不变；`vaultRoot` 从绝对路径变成 bookmark 字符串，Rust 在入口分流；文件树、索引、AI 工具、导出继续走同一条链。

### 4.2 VaultFs 接口

沿用 Android spec 的 `VaultFs`，`VaultRoot` 增加：

```rust
pub enum VaultRoot {
    Local(PathBuf),
    Android { tree_uri: String, display_name: String },
    Ios { bookmark: String, display_name: String },
}
```

`IosVaultFs` 实现：

- `root_key` 返回 bookmark 的 SHA-256，不把 base64 当路径。
- `list_all` / `stat` / `read_text` / `read_many` / `write_text` / `create_dir` / `delete` / `rename` / `read_bytes` / `write_bytes` 全部走 Swift 插件。
- rel 规则复用 `normalize_rel`：拒绝 `..`、绝对路径、空段、`ios-bookmark://` 混入 rel。
- 建议把 Android 的 `MemoryVaultFs` 测试假实现也用在 iOS 索引 / 备份 / 回收站单测上，桌面即可跑。

### 4.3 Swift 插件

Swift 类继承 `Tauri` 的 `Plugin`，方法用 `@objc` + `(_ invoke: Invoke)`；Rust 用 `run_mobile_plugin` 调用。Tauri 官方文档已确认 iOS 插件是 Swift Package，命令参数用 `Decodable`。

命令表：

| 命令 | 入参 | 返回 | 说明 |
| --- | --- | --- | --- |
| `pickFolder` | 无 | `{bookmark, name}` | `UIDocumentPickerViewController` 选目录；生成 bookmark |
| `resolveBookmark` | `{bookmark}` | `{ok, stale, name}` | 启动时解析；stale 走重新授权 |
| `listAll` | `{bookmark}` | `Entry[]` | 递归清单，含 rel / name / isDir / size / mtime / downloaded |
| `readText` | `{bookmark, rel}` | `{text, size, mtime}` | 协调读，UTF-8 |
| `readMany` | `{bookmark, rels}` | `FileText[]` | 批量读，索引重建 |
| `writeText` | `{bookmark, rel, text}` | `{size, mtime}` | 临时文件 + 协调替换 |
| `createDir` | `{bookmark, rel}` | `{}` | 已存在回 `exists` |
| `delete` | `{bookmark, rel}` | `{}` | 移入库内回收站或永久删除 |
| `rename` | `{bookmark, from, to}` | `{}` | 目标存在回 `exists` |
| `stat` | `{bookmark, rel}` | `{size, mtime, isDir, downloaded}` | 冲突检测 |
| `readBytes` / `writeBytes` | `{bookmark, rel}` / `{bookmark, rel, base64}` | base64 / `{}` | 图片与二进制；单次上限 8MB |
| `importToCache` | `{srcUrl}` | `{path, name, size}` | 文档选择器 / 分享进来的 URL 拷进沙盒缓存 |
| `exportText` | `{fileName, mime, text}` | `{}` | 文档选择器保存，或分享 |
| `exportBytes` | `{fileName, mime, base64}` | `{}` | 同上 |
| `pickImage` | 无 | `{bookmark?, rel?}` 或 `{dataBase64, name}` | PHPicker / 文档选择器；不申请整库照片权限 |
| `share` | `{path, mime}` | `{}` | `UIActivityViewController` |
| `openUrl` | `{url}` | `{}` | `UIApplication.shared.open`，仅 http / https |

实现细节：

- security-scoped access 用引用计数：`beginAccess` / `endAccess` 包住一批操作；后台时结束，前台恢复；不要长期持有不释放。
- `NSFileCoordinator` 的 `coordinatorWriting(forReplacing:)` 写临时文件再替换；读用 `coordinatorReading`。
- iCloud 下载：`URLResourceKey.isUbiquitousItemKey` / `isDownloadedKey`；未下载先 `FileManager.default.startDownloadingUbiquitousItem(at:)`，回 `downloading`，前端重试。
- 错误码统一：`permission_lost` / `stale_bookmark` / `not_found` / `exists` / `escape` / `offline` / `downloading` / `unsupported` / `io` / `too_large`；Rust 映射到 `ui_lang.rs` 词条。
- 目录上限与 Android 一致：20000 节点，超出回 `too_many`；Phase 0 真机量过再定。

### 4.4 Rust 命令改造

与 Android spec 的改造表基本一致：

- `scan_vault` / `read_md_file` / `write_md_file` / `create_*` / `rename_item` / `delete_file` / `backup_*` / `save_image_*` / `export_file` 走 `IosVaultFs`。
- `rebuild_index` 去掉 `fs::canonicalize`；`root_key` 用 bookmark hash；正文 `read_many` 分批。
- `delete_file` 不走桌面 `trash`；回收站放库根 `.notelume-trash/`，用 Swift 协调移动；失败回可读错误。
- `start_vault_watcher` / `stop_vault_watcher` iOS 回 `unsupported`；外部改动靠 scenePhase active 刷新与保存前 `stat`。
- `git_*`、`webclip`、`voice`、`print`、`build_site_graph`、`copy_vault_assets`、`docx_*`、插件、托盘、原生菜单按 `cfg(target_os = "ios")` 关掉或注册 stub。
- `open_external_url` / `open_url` 走 Swift `openUrl`，不允许落 `xdg-open`。
- `save_image_from_data_uri` / `export_file` 改成「建议文件名 + MIME + 内容」，由 Swift 文档选择器 / 分享保存。
- `qd_eval` 纯文本可用；`include` / `read` / `listfiles` 等文件类函数在 iOS 降级；`qdDocDir` / `qdLibsDir` 不拼 bookmark URI。
- `take_launch_paths` 返回空；文件关联 / 分享接收 Phase 5。

### 4.5 构建与依赖门控

`src-tauri/Cargo.toml`：

| 依赖 | 桌面 | iOS 首版 | 动作 |
| --- | --- | --- | --- |
| `tauri` | crates.io 2.x | 官方 2.x | 同一版本；iOS 特性由 Tauri 内置 |
| `trash` | 用 | 不用 | 仅非 iOS；iOS 走回收站 |
| `git2` | 用 | 不用 | 仅桌面；iOS stub |
| `notify` | 用 | 不用 | 监听命令回 `unsupported` |
| `reqwest` | native-tls | native-tls（Security.framework） | Phase 0 验证不引 OpenSSL；必要时切 rustls+ring |
| `cpal` / `windows` | Windows 语音 | 不用 | 语音 Phase 5 用 Swift |
| `tray-icon` feature | 桌面 | 桌面内部才引入 | iOS 不创建托盘 |
| 纯 Rust 库（zip / roxmltree / sha2 / docx-rs） | 用 | 可留 | docx 首版隐藏 |

编译收口：

- 用 `#[cfg(target_os = "ios")]`，不是 `target_env`。
- Rust 目标：`aarch64-apple-ios`（真机）、`aarch64-apple-ios-sim`（Apple Silicon 模拟器）、`x86_64-apple-ios`（Intel 模拟器）。
- `set_decorations`、托盘、mac 菜单、`open_vault_window`、桌面拖放、剪藏 HTTP 服务按目标排除。
- `reveal_in_folder` iOS 回 `unsupported`；`delete_file` 不实例化 `trash`。
- 如果某个插件（dialog / clipboard / opener）在 iOS 不可用，先降级到 Swift 能力，不把桌面插件强塞进 IPA。

### 4.6 构建链与签名

- 构建机：macOS 10.15+ + Xcode（最新稳定）+ CocoaPods；Rust 三个 iOS target；Node。
- Windows 本机只跑前端测试、Rust 桌面单测与文档；`npm run tauri -- ios` 在 Windows 上报 `unrecognized subcommand 'ios'`，不要在本机尝试出 IPA。
- 命令：
  - `npm run tauri -- ios init` 生成 `src-tauri/gen/apple`；
  - `npm run tauri -- ios dev` 到模拟器 / 真机；
  - `npm run tauri -- ios build` 出 archive；
  - `xcodebuild -exportArchive` + App Store Connect API 上传 TestFlight。
- CI：GitHub Actions `macos-14` / `macos-15` 或自建 Mac；缓存 Rust target 与 DerivedData；签名用 secrets 导入证书与 Profile。
- 产物检查：`.app` / `.ipa` 内含 `libnotelume_lib.a`、`Info.plist`、`PrivacyInfo.xcprivacy`、Web 资源；bundle ID、版本号、最低系统版本与 `tauri.conf.json` 一致。
- 签名：Apple Developer Program、Team ID、Bundle ID、Provisioning Profile、App Store Connect 记录；证书 / Profile / 私钥不入库。

### 4.7 生命周期、返回与 Intent

- iOS 没有系统返回键。页面内提供「返回 / 关闭」按钮；sheet 用下滑关闭；WKWebView 的 `allowsBackForwardNavigationGestures = false`，避免侧滑把单页应用带回空白。
- 返回栈：关闭最上层菜单 / 动作表 / 对话框 → 关闭抽屉 / 浮层 → 停止 AI 流 → 脏文档询问 → 回工作区列表 / 空态。根页面不拦截系统侧滑，交给 App 切换。
- 生命周期：`scenePhase` 从 active 到 inactive / background 时发 `nl:ios-pause`：flush 自动保存、取消 AI 请求、结束 security-scoped access。回 active 发 `nl:ios-resume`：重新 beginAccess、超过 30 秒重扫清单。
- 进程被杀：依赖 2s 自动保存 + 草稿目录，不依赖 `applicationWillTerminate`。
- 文件打开：Phase 5 接 `CFBundleDocumentTypes`（md）+ `LSSupportsOpeningDocumentsInPlace` + `application(_:open:options:)`；首版只从应用内选文件夹。

### 4.8 iOS 工程配置

- 最低版本：`bundle.iOS.minimumSystemVersion = "15.0"`（Tauri 默认）。
- `Info.plist`：
  - `LSSupportsOpeningDocumentsInPlace = true`；`UIFileSharingEnabled = false`。
  - `UIRequiresFullScreen = false`，支持 iPad Split View / Slide Over。
  - `UISupportedInterfaceOrientations` 包含竖屏 / 横屏；不锁方向。
  - `UIApplicationSupportsIndirectInputEvents = true`，支持触控板 / 鼠标。
  - `NSLocalNetworkUsageDescription`：局域网 Ollama 需要；只在用户配置本地地址时触发。
  - `NSPhotoLibraryUsageDescription`：只有回退到相册选择器时才加；首选 PHPicker，不需要整库权限。
  - 语音 Phase 5 加 `NSMicrophoneUsageDescription` / `NSSpeechRecognitionUsageDescription`。
- `PrivacyInfo.xcprivacy`：UserDefaults、文件时间戳、磁盘空间等 required reason API 逐项声明；不追踪用户。
- 出口合规：`ITSAppUsesNonExemptEncryption` 按实际加密实现填写；只走 HTTPS / Keychain 时通常为 false，自实现 AI Key 加密需确认。
- capabilities：`capabilities/mobile.json` 的 `platforms` 加 `"iOS"`，窗口 `main`，保留 `core:default`、dialog 消息框、剪贴板读文本。
- 钥匙串：AI API Key 存 `Keychain`，`kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`；不写 `settings.json`，不进 iCloud 备份。
- App 备份：`settings.json`、草稿、缓存按需排除 iCloud 备份；用户库由用户自己的 iCloud / 文件 provider 管理。

## 五、界面与交互

### 5.1 平台标记与断点

新增 `src/platform.js` 的 iOS 分支：

- `detectPlatform(ua, isTauri)` 返回 `'ios'`；iPadOS 13+ 的 UA 是 Macintosh，需 `navigator.maxTouchPoints > 1` 兜底，不能只认 `iPhone` / `iPad`。
- 导入期写 `data-tauri-platform="ios"`，不落 `macos` / `linux`。
- `formFactorFor(width, height, coarsePointer)`：`< 600` 为 `phone`，`600-839` 为 `tabletMedium`，`>= 840` 为 `tabletExpanded`；iPhone 与 iPad 共用。
- `canSplitEditor(availableEditorWidth, orientation, paneCount)`：可用编辑区 ≥ 720dp、横屏、窗格数 < 2。
- `inputModality.js` 记录最近输入：mouse / pen / touch；iPad 接键盘、鼠标、Pencil 时按最近输入分流右键、hover、长按。
- `titlebar.js` 改为从 `platform.js` 取平台；iOS 跳过 `initTitlebar` 与 `runWindowRole`。

断点三条：`max-width: 599px`、`600-839px`、`min-width: 840px`。桌面 CSS 不动；移动端样式放 `src/mobile.css` + `src/mobile/ios.css`。

### 5.2 壳层

iPhone（竖屏）：

```
┌─────────────────────────────────┐
│ ☰  文档名 ·             ＋  ⋯   │  app bar（44dp + 安全区）
├─────────────────────────────────┤
│ 标签胶囊（横向滚动，36dp）        │
├─────────────────────────────────┤
│ 格式条（44dp，横向滚动）          │
│                                 │
│          ProseMirror            │
│          编辑区（占满剩余高度）    │
│                                 │
├─────────────────────────────────┤
│ 文件   大纲   AI   更多           │  tab bar（49dp + Home 指示条）
└─────────────────────────────────┘
```

iPad 中等（600-839dp）：

```
┌──────────────┬──────────────────────────┐
│ 库名 + 锁     │ ☰ 文档名 ·        ＋ ⋯   │
│ 搜索          ├──────────────────────────┤
│ 文件树        │ 标签条                    │
│ 240-280dp     ├──────────────────────────┤
│              │ 格式条                    │
│              │ 编辑器（占满剩余）         │
└──────────────┴──────────────────────────┘
  检查器 / AI = 右侧 360dp 浮层
```

iPad 宽屏（≥ 1200dp，检查器常驻）：

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

- iPhone：编辑区唯一滚动容器；左右栏覆盖层；底部 tab bar 用 iOS 安全区。
- iPad：文件树常驻；840-1199dp 是两栏 + 浮层；≥1200dp 三栏；两窗格时检查器收成浮层。
- 软键盘弹出：iPhone 隐藏 tab bar，编辑区按 `visualViewport` 收缩；iPad 文件树不隐藏。
- iPad 分栏时每格独立 ProseMirror、标签、滚动、脏标记；每格最小 350dp，分隔条 8dp。

### 5.3 顶栏与导航

- iPhone：左 `☰` 打开文件抽屉；中文件名 + 脏点；右 `＋` 新建、`⋯` 更多。
- iPad：左 `☰` 收起 / 展开常驻文件树；中文件名；右 `＋`、`⋯`，宽屏多一个搜索图标。
- iPhone 用底部 tab bar；iPad 不挂 tab bar，文件树与「文件 / 大纲」页签常驻。
- 隐藏窗口按钮、应用名拖拽区、菜单条、字数统计、主题按钮；这些进「更多」或设置。
- iOS 顶栏与底栏留 `env(safe-area-inset-top)` / `bottom`；灵动岛 / 刘海 / Home 指示条不能压内容。

### 5.4 面板与文件树

- iPhone：文件抽屉宽 86vw（最大 360dp），检查器 / AI 全屏或底部 sheet；设置全屏页。
- iPad 中等：文件树 240-280dp 常驻；检查器 / AI 右侧浮层 360dp；设置居中模态最大 720dp。
- iPad 宽屏：文件树 260-320dp；检查器 300-360dp 常驻条件见 §3.3；AI 浮层。
- 文件树行高 44dp；单击打开，长按动作表，鼠标右键光标菜单；平板上可拖分隔条调宽，宽度按形态存 localStorage。
- 顶部固定「库名 + 锁图标」+ 搜索框；底部只留「刷新」；换目录 / 解除在设置页。
- bookmark 失效时显示「重新授权」；不提供「随便选一个」入口。
- 拖拽移动首版不做；「移动到…」放动作表，后续版本。

### 5.5 编辑器

- iPhone：`.editor` 去掉最大宽度，左右 padding 16px，字号 16px，行高 1.75；行号隐藏。
- iPad：编辑区 `max-width: 860px` 居中，左右 padding 40-48px，字号 16-17px；编辑区 ≥720dp 时显示行号装订线。
- 双窗格每格不足 720dp 时隐藏行号，padding 24px；每格最小 350dp。
- 代码块 / 表格横向滚动；图片默认 100%，点击进查看器；查看器支持双指缩放、单击关闭、iPad 鼠标滚轮。
- 选区工具条：iPhone 一排加粗 / 斜体 / 链接 / 高亮 / AI；iPad 有鼠标 / Pencil 时显示完整两排，纯触摸时紧凑排。
- 源码模式（CodeMirror）保留，入口「更多」；软键盘下不自动切模式。

### 5.6 格式、插入与 AI

- iPhone 格式条横向滚动，`＋` 插入动作表：标题、无序 / 有序 / 任务、引用、代码块、表格、图片、分隔线、AI。
- iPad 格式条一到两行，更多按钮直接可见；插入表格格子 ≥32dp，手机 ≥40dp。
- 斜杠菜单：iPhone 底部动作表；iPad 有指针时锚在光标旁，纯触摸时底部动作表。
- 选区 AI 五个任务；iPhone 结果全屏底部面板；iPad 结果最大 560dp 居中 / 侧贴面板；流式 + 替换 / 插入 / 复制 / 停止。
- AI 面板：iPhone 全屏；iPad 右侧浮层；输入卡固定在键盘上方；麦克风隐藏。

### 5.7 菜单、长按、指针与 Pencil

- 触摸：底部动作表；长按 500ms，移动 >8dp 取消；挂在文件行、标签、图片、表格。
- 鼠标 / 触控板：右键光标位置菜单；iPadOS 支持 secondary click；hover 预览只在 `hover: hover` 且最近输入是 mouse / pen 时开启。
- Apple Pencil：走指针路径，支持精确选择、点击链接、hover（支持的机型）；不做手写识别、不做压感绘图。
- 编辑器正文保留系统文本选择菜单；不自绘全局 context menu 覆盖系统菜单。
- 混合输入按 `inputModality.js` 切换，不按设备型号一刀切。
- iOS 的 `-webkit-touch-callout` 保持默认，避免长按链接 / 图片时丢系统菜单。

### 5.8 键盘、输入法与安全区

- iPhone 软键盘：`visualViewport` 更新 `--nl-kb-h`；tab bar 隐藏；编辑区底部 padding 增加；字号 16px 防止 WebView 自动放大。
- iPad 外接键盘 / 触控板：Ctrl / Cmd / Alt 快捷键、Tab、F2、Ctrl+Tab、命令面板可用；触控板双指滚动等同滚轮。
- 中文 / 日文输入法组合输入依赖 ProseMirror `composition`；真机覆盖候选词上屏、拼音未上屏删除、输入法切换。
- 安全区：`viewport-fit=cover` + `env(safe-area-inset-*)`；iPhone 灵动岛 / 刘海 / Home 指示条、iPad 圆角都留白。
- 旋转、Split View、Slide Over、Stage Manager 改宽：重算 `formFactorFor` / `canSplitEditor`，裁剪窗格，不重载页面；标签 / 滚动 / 未保存内容保留。
- `UIRequiresFullScreen=false` 才能进 Split View；不要锁 `UISupportedInterfaceOrientations`。
- `-webkit-text-size-adjust: 100%`；滚动用 `-webkit-overflow-scrolling: touch` 保持惯性。

### 5.9 iPad 多任务与窗口

- iPad Split View / Slide Over：作为其中一个 App 时，窗口宽度可能 <600dp，退回 iPhone 单窗格；恢复全屏回平板布局。
- Stage Manager：同一 App 多窗口受 Tauri iOS 支持度限制；首版只保证单窗口随系统缩放，不承诺多窗口同步。Phase 5 再评估 `UIApplicationSupportsMultipleScenes`。
- 拖宽跨 600 / 840 阈值只调整布局，不重建编辑器；脏文档不丢。
- 折叠 / 旋转 / 键盘坞变化同样走 `nl:ios-config`。

### 5.10 无障碍

- 图标按钮给 `aria-label` / `title`；触控目标 ≥44dp。
- 底部 tab bar / 动作表用 `role="tablist"` / `role="menu"`，焦点顺序按视觉顺序。
- 支持 VoiceOver、动态字体（应用内字号设置不跟随系统过大缩放）、减少动态效果。
- 主题对比度沿用三套主题；暗色状态栏图标由 iOS 主题控制。

## 六、文件与数据语义

| 操作 | iOS 首版语义 |
| --- | --- |
| 首次锁定 | 引导页 → `UIDocumentPicker` 选目录 → 生成 bookmark → 写 `lockedBookmark` → `scan_vault` / 索引 / 恢复标签 |
| 启动直达 | `resolveBookmark` → `startAccessingSecurityScopedResource` → 读清单缓存 → 后台刷新；不弹选择器 |
| bookmark 失效 | `stale` / 不存在 → 保留旧名，显示「重新授权」；重选同一目录恢复；选别的先确认换库 |
| 更换目录 | 设置页入口；保存 / 关闭当前文档 → 释放旧 access → 切新 bookmark → 重建索引与标签 |
| 解除锁定 | 保存 / 关闭当前文档 → 释放 access → 清空标签与索引缓存 → 回引导页；不删文件 |
| 最近打开 | 只收锁定库内文档；`root` 恒等于 `lockedBookmark`，不跨库 |
| 外部修改 | 无监听；回 active 刷新 + 保存前 mtime / size 比对；冲突三选一 |
| iCloud 占位 | 未下载 → 显示「正在下载」→ `startDownloadingUbiquitousItem` → 重试；离线回 `offline` |
| 删除 | 移入库内 `.notelume-trash/`；协调移动失败则弹永久删除确认 |
| 备份 | 应用沙盒 `Application Support/backups`，保留 20 份 / 7 天；不进用户库 |
| 草稿 | 未锁定库时落沙盒 `scratch`；保存时要求选库或导出 |
| 图片 | PHPicker / 文档选择器 → 复制进 `assets/`；显示用 data URI |
| 导出 | 单篇 HTML / Markdown / 幻灯片；文档选择器保存或 `UIActivityViewController` 分享 |
| 文件关联 | Phase 5：`CFBundleDocumentTypes` + `application(_:open:options:)`；首版不承诺 |
| 分享接收 | Phase 5：Share Extension / `UIActivityViewController`；首版不做 |

## 七、平台能力矩阵

| 能力 | 桌面 | Android | iOS 首版 |
| --- | --- | --- | --- |
| 知识库文件夹 | 原生目录 | SAF tree | security-scoped bookmark |
| 单库锁定 | 无 | 有 | 有，bookmark 持久化 |
| 文件监听 | `notify` | 无 | 无 |
| 单文件打开 | 有 | Phase 5 | Phase 5 |
| 标签页 | 多窗格 | 手机 1 / 平板 2 | iPhone 1 / iPad 2 |
| 分栏 | 有 | 平板最多 2 | iPad 最多 2 |
| WYSIWYG / 源码 | 有 | 有 | 有 |
| 大纲 / 标签 / 属性 / 反链 | 有 | 有 | 有 |
| 全库搜索 | 有 | 有 | 有 |
| 双链 / 悬停预览 | 有 | 触摸关闭，鼠标保留 | iPhone 长按；iPad 指针 hover |
| 右键 / 长按 | 右键 | 长按 / 鼠标右键 | 长按 / 指针右键 |
| 快捷键 | 有 | 外接键盘 | 外接键盘 / 触控板 |
| 拖放打开 | 有 | 不做 | 不做；Phase 5 文件关联 |
| 多窗口 | 有 | 兼容系统分屏 | Split View / Slide Over；Stage Manager 单窗口 |
| AI Ask / Agent | 有 | 有 | 有；Keychain + ATS |
| 语音 | Windows / 浏览器 | 无 | Phase 5 `SFSpeechRecognizer` |
| 图片插入 / 查看 | 有 | 有 | PHPicker / 文档选择器 |
| 单篇导出 | 有 | 有 | 有 + 分享 |
| 整站导出 / docx | 有 | 无 | 无 |
| 打印 | 有 | 无 | 无；用分享 / 打印扩展替代 |
| Git | 有 | 无 | 无 |
| 剪藏服务 | 有 | 无 | 无 |
| Canvas / 图谱 / 插件 | 有 | 无 | 无 |
| 模板 / 每日速记 | 有 | 无 | 无 |
| Quarkdown | 有 | 基础语法 | 基础语法 |
| 主题 / 五语言 / 设置 | 有 | 有 | 有 |

## 八、实施阶段

### Phase 0：macOS 构建与文件授权闸口

1. 在 macOS 或 macOS CI 安装 Xcode、CocoaPods、Rust iOS targets；`npm run tauri -- ios init` 生成 `src-tauri/gen/apple`。
2. 最小 App 跑通 Rust IPC → 前端按钮 → 返回；Swift 插件能被 `run_mobile_plugin` 调用。
3. `pickFolder` → `UIDocumentPicker` 选目录 → 生成 bookmark → 杀进程 → `resolveBookmark` → `startAccessing` → `FileManager` 枚举 → 读写一篇 md。
4. `NSFileCoordinator` 读写、iCloud 占位下载、bookmark stale 三条路径各验一次。
5. AI：`reqwest` 在 iOS 目标上编译；HTTPS 请求成功；局域网 HTTP 与 `NSLocalNetworkUsageDescription` 验证。
6. TestFlight 内部构建：签名、PrivacyInfo、Info.plist、最低 iOS 15 全过。
7. 退出判据：真机安装，选 `iCloud Drive/NoteLume` 或「我的 iPhone/NoteLume」，重启直达，读写一篇；否则停在这里，不进入 UI 改造。

### Phase 1：可打开的壳

- `platform.js` iOS 识别；隐藏桌面工具栏 / 窗口按钮 / 菜单条。
- iPhone / iPad 三档壳层、iPhone tab bar、iPad 常驻文件树、检查器 / AI 浮层。
- 首次引导、bookmark 锁定、重新授权页、设置页「知识库目录」。
- iPhone 单窗格；iPad 宽屏左右两格；WYSIWYG 只读渲染。
- 退出判据：iPhone SE、iPhone 15、iPad 10 上能打开库、点文件、阅读；旋转 / Split View 不重载；杀进程重开直达。

### Phase 2：可编辑

- `IosVaultFs` 写路径；保存、自动保存、冲突检测、草稿恢复。
- 新建 / 重命名 / 删除 / 回收站；图片插入与查看。
- iPad 双窗格、标签并回、分栏比例持久化。
- 返回栈、`nl:ios-pause` flush、中文输入法、键盘安全区。
- 退出判据：1MB 文档保存后与桌面逐字节一致；iPad 两窗格各自标签独立；后台杀进程恢复草稿。

### Phase 3：知识库能力

- 索引重建改 `IosVaultFs`；全库搜索、反链、大纲、标签、属性。
- 最近打开、bookmark 失效恢复、回前台刷新、iCloud 下载状态。
- 设置页、外观、五语言在 iPhone / iPad 的排版。
- 退出判据：200 篇库搜索命中正确；反链与桌面一致；bookmark 失效能重新授权。

### Phase 4：AI 与导出

- AI 面板 iPhone / iPad 布局；Ask / Agent；Keychain 密钥；ATS / 本地网络；后台取消。
- 单篇 HTML / Markdown / 幻灯片导出；`UIDocumentPicker` 保存；`UIActivityViewController` 分享。
- 退出判据：HTTPS 服务商与局域网 Ollama 各跑一轮 Ask 与 Agent；导出文件能在「文件」App 打开。

### Phase 5：iPad 打磨与上架

- iPad Split View / Slide Over / Stage Manager 单窗口、指针 hover / 右键、Apple Pencil、外接键盘。
- `CFBundleDocumentTypes` / 文件关联 / 分享接收；语音 `SFSpeechRecognizer`；打印用 `UIPrintInteractionController`（如仍需要）。
- TestFlight 外测、App Store 审核、隐私清单、出口合规、审核说明。
- 性能优化：清单缓存、索引缓存、图片懒加载、长列表、iCloud 批量读。
- 退出判据：§9 真机清单全过；TestFlight 可安装；桌面端回归不受影响。

## 九、测试与验收

### 9.1 共用单测

- `src/tests/platform.test.mjs`：iPadOS Macintosh UA 兜底；iOS 不落 macOS；`formFactorFor` 边界 599 / 600 / 839 / 840；`canSplitEditor` 组合。
- `src/tests/vault-path.test.mjs`：`ios-bookmark://` 不做 lowercase、尾斜杠归一、`rootChanged`。
- `src/tests/mobile-back.test.mjs`：返回栈顺序（动作表 → 抽屉 → AI → 脏文档 → 空态）。
- `src/tests/mobile-shell.test.mjs`：iPhone tab bar、iPad 常驻文件树、两窗格、窄回标签并回、AI 浮层。
- `src/tests/mobile-input-modality.test.mjs`：mouse / pen / touch 分流；iPad 指针右键 / hover；Pencil 走指针路径。
- `src/tests/mobile-locked-vault.test.mjs`：首次锁定、启动直达、bookmark stale、重新授权、换库确认、非锁定 root 拒绝。
- `src/tests/mobile-menu.test.mjs`：iOS 隐藏 Git / 打印 / 剪藏 / Canvas / 插件 / 语音 / 模板 / 速记；iPad `splitH` 可见、`splitV` 不可见。

Rust：

- `vault_fs::tests`：`normalize_rel`；`MemoryVaultFs` 驱动扫描 / 索引 / 备份 / 回收站。
- `mobile_fs::tests`：Swift 错误码 → `ui_lang` 词条；bookmark hash；批量读切分。
- `cargo test --lib` 在桌面跑；iOS 分支 `cfg` 隔离，不因本机跑不了就删测试。

Swift（XCTest，macOS 上跑）：

- `SecurityScopedBookmarkTests`：bookmark 生成 / 解析 / stale 分支。
- `FileCoordinatorTests`：协调读写、临时文件替换、iCloud 占位状态映射。
- `MobileFsPluginTests`：命令参数 Decodable、错误码、rel 越权拒绝。

### 9.2 构建与回归

- 前端 `src/tests/*.test.mjs` 全量通过。
- `npm run build:web` 无错。
- `npm run build` 桌面包正常。
- `cargo test --lib` 全量通过。
- macOS CI：`tauri ios build` 出 archive；`xcodebuild -exportArchive` 出 IPA；TestFlight 上传成功。
- IPA 检查：`Info.plist` 的 bundle ID / 最低版本 / 方向 / `UIRequiresFullScreen` / 隐私清单存在。

### 9.3 真机矩阵

| 设备 | 系统 | 用途 |
| --- | --- | --- |
| iPhone SE（小屏） | iOS 15 / 最新 | 最小屏、Home 键、键盘 |
| iPhone 15 / 16 | 最新 iOS | 灵动岛、Face ID、主验收 |
| iPad 10 | iPadOS 最新 | 600-840dp、Split View |
| iPad Pro 11 / 12.9 | iPadOS 最新 | 840-1200dp、Stage Manager、Pencil |
| 模拟器 | iOS 15 + 最新 | 构建与布局冒烟 |
| TestFlight 真机 | 最新 | 签名、安装、审核前验证 |

文件 provider 覆盖：iCloud Drive、我的 iPhone、外置 USB-C 盘、至少一个第三方 provider（如 Dropbox / OneDrive）。

### 9.4 验收场景

1. 首次锁定：iPhone 选 `iCloud Drive/NoteLume` → bookmark 生成 → 文件树出现；杀进程 / 重启设备后直达，不弹选择器。
2. bookmark 失效：在「文件」App 移动目录 → 重开出「重新授权」；选回原目录恢复；选别的目录先确认换库。
3. iCloud 占位：桌面端写入一篇云端未下载的 md → 手机打开显示「正在下载」→ 下载完成后正文正确；离线时回 `offline` 不写空。
4. 编辑：中文输入法、加粗、列表、任务、表格、代码块、图片；保存；桌面逐字节比对。
5. 文件操作：新建、重命名、删除进回收站、恢复、清空；同名冲突提示。
6. 冲突：桌面改同一篇后手机保存，三条分支（重载 / 覆盖 / 取消）走一遍。
7. 搜索：200 篇库中文 / 英文关键词；反链目标正确；大纲跳转。
8. AI：HTTPS 流式问答、停止、插入；局域网 Ollama `http://192.168.x.x:11434`；后台切换取消。
9. 导出 / 分享：HTML / Markdown / 幻灯片；文档选择器保存；分享到「文件」/ 邮件。
10. iPhone 布局：SE / 15 / 灵动岛 / 刘海；竖屏 / 横屏；键盘弹出；暗色；五语言。
11. iPad 布局：600 / 840 / 1200dp；文件树常驻；两窗格；检查器浮层 / 常驻。
12. iPad 多任务：Split View 半屏回手机布局；Slide Over；Stage Manager 改宽；旋转；不重载、不丢状态。
13. 输入：外接键盘快捷键、触控板滚动、鼠标右键 / hover、Apple Pencil 选择。
14. 后台：切后台 10 分钟回来刷新；低内存杀进程后草稿恢复。
15. 性能：冷启动 ≤ 3s；500 篇库打开 ≤ 2s（有缓存）；切文件 ≤ 300ms；5MB 文档内存峰值 ≤ 400MB。
16. 上架预检：PrivacyInfo、出口合规、审核说明、TestFlight 安装。

## 十、风险与未决

| 风险 | 影响 | 处理 |
| --- | --- | --- |
| 只能在 macOS / CI 构建 | Windows 本机无法出 IPA，迭代慢 | Phase 0 建 macOS CI；本地 Windows 只跑前端 / 桌面单测；接受硬件门槛 |
| security-scoped bookmark 失效 | 启动打不开库 | 保留旧名 + 重新授权；不静默清锁；真机覆盖移动目录 / 重装 |
| iCloud 占位与离线 | 读到空 / 写回坏文件 | `isDownloaded` 判断 + `startDownloading` + `offline` 错误；不把空内容当正文 |
| NSFileCoordinator 写冲突 | 覆盖别人改动 | 保存前 mtime / size；协调写 + 冲突三选一 |
| App Store 审核 | 纯 WebView / 隐私 / 加密被拒 | 审核说明写本地文件与原生桥；PrivacyInfo；出口合规；TestFlight 先验 |
| WKWebView 差异 | 键盘 / 安全区 / 选择手柄异常 | 真机验收；`visualViewport`；16px 字号；渐进增强 |
| Tauri iOS 插件 / 多窗口成熟度 | Stage Manager 多窗口不可用 | 首版单窗口；Phase 5 评估 `UIApplicationSupportsMultipleScenes` |
| AI Key / 本地网络 | Key 泄漏 / ATS 拦截 | Keychain；`NSLocalNetworkUsageDescription`；HTTPS 优先；Phase 0 验 ATS |
| 文件 provider 差异 | 枚举 / 重命名 / 下载失败 | 错误码映射；不假设 provider 支持；回收站降级 |
| 大库遍历慢 | 首开 / 索引慢 | 清单缓存 + `read_many` + 索引缓存；500 篇量 |
| 包名 / 签名 | App Store 记录不可改 | 首次上传前定 `app.notelume.ios`；证书不入库 |
| 首版隐藏功能多 | 桌面用户预期落空 | README 写清 iOS 首版能力；设置页不出现不可用入口 |

未决问题：

1. iOS Bundle ID 用 `app.notelume.ios`，还是沿用 `app.notelume.desktop`。前者清晰，后者少一次迁移；首次上传前定死。
2. 用户库首选 iCloud Drive 文件夹，还是「我的 iPhone」本地目录。两者都支持；默认引导建议 iCloud Drive。
3. `tauri.ios.conf.json` 是否能覆盖 `identifier`；不能的话是否全局改名并迁移桌面设置目录。
4. Stage Manager 同 App 多窗口是否在 Phase 5 做；取决于 Tauri iOS 的能力与审核成本。
5. 语音用 `SFSpeechRecognizer` 还是服务商 ASR；首版不做，Phase 5 定。
6. 打印用 `UIPrintInteractionController` 还是只导出 / 分享；首版不做，Phase 5 定。
7. 文件关联 / 分享接收是否首版就做；涉及 `CFBundleDocumentTypes`、`application(_:open:options:)` 与 Share Extension，建议 Phase 5。

## 十一、交付与文档

- 实现分支 `feat/ios`，从最新 `origin/master` 拉出；不合并 `web`，不把云端服务端代码带进来。
- 生成并入库 `src-tauri/gen/apple`；证书、Provisioning Profile、App Store Connect API Key、私钥不入库。
- 平台配置：`tauri.conf.json` / `tauri.ios.conf.json` 的 `bundle.iOS.minimumSystemVersion`、`Info.plist`、`PrivacyInfo.xcprivacy`、`capabilities/mobile.json`。
- 实现完成后同步更新：
  - `CHANGELOG.md` 的 `Added`（iOS 首版能力、构建命令、TestFlight）。
  - `docs/ROADMAP.md` 的 iOS 章节与批次状态。
  - `README.md` 中英两版：平台徽标、安装表、iOS 首版能力与限制（bookmark 单库、无 Git / 剪藏 / 打印 / 插件、需要 macOS 构建）。
  - `docs/CLAUDE.MD` 的技术栈与架构：增加 iOS 目标、`IosVaultFs`、Swift 插件、macOS 构建口径。
- 本文件只定设计与 Phase 0 闸口；macOS 构建与 bookmark 持久化不过，不进入 UI 改造。