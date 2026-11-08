# 设计：NoteLume 鸿蒙手机端（HarmonyOS NEXT + 社区移植版 Tauri）

- 状态：设计完成，待 Phase 0 闸口
- 日期：2026-11-08
- 范围：HarmonyOS NEXT 手机端首版；OpenHarmony 只作为构建验证目标，不做独立产品
- 来源：`docs/ROADMAP.md` 移动端之后的鸿蒙分支；2026-11-08 用户指令「再写一个 spec 对于鸿蒙端的，用社区移植版的 tauri」
- Tauri 基线：社区移植版 `tauri-apps/tauri` 的 `feat/open-harmony` 分支 + `ohrs`，固定 commit，不追浮动分支
- 最低 API：**API 26.0.0**（原因见 §2.2；API 20 设备只保留降级模式）
- 一句话：在 HarmonyOS 手机上复用 Android 端的单库锁定、单窗格与编辑内核；平台层换成社区移植版 Tauri + ArkTS/NAPI 文件桥，不把“桌面 Tauri 直接编到鸿蒙”当成既成事实。

## 一、目标与边界

### 1.1 首版必须成立的承诺

1. 用户在手机上选一次笔记文件夹，之后启动直达同一个库；笔记仍是普通 md，系统文件管理器和其他编辑器能打开。
2. 编辑器与桌面同源。ProseMirror schema、markdown 解析与序列化、GFM 往返规则不改。
3. 文件树、`[[链接]]`、标签、大纲、全库搜索、反链、AI 问答可用。
4. 鸿蒙的返回手势、前后台切换、软键盘、安全区按平台重做，不把 Android 的返回键与 inset 逻辑直接搬过来。
5. 社区移植版 Tauri 只作为运行容器；不修改桌面端的 `tauri` 依赖，不要求官方 Tauri 支持鸿蒙。

### 1.2 首版验收判据

- 在 API 26.0.0 手机上选 `Documents/NoteLume`，持久化授权成功；杀进程/重启设备后启动直达，不重新弹选择器。
- 编辑一篇 1MB md（中文、列表、表格、代码块、图片），HAP 内保存后与桌面版逐字节一致。
- 200 篇库的文件树、全库搜索、反链、AI 问答可用。
- 返回手势不丢未保存内容；后台被系统回收后能恢复草稿。
- `cargo tauri ohos build --ci --target aarch64` 能产出 HAP；签名后的 HAP 能装到真机。
- 桌面端测试、`npm run build`、`cargo test --lib` 不受影响。

### 1.3 明确不做

- iOS、Android 的重复实现。Android 已有独立 spec，本文件只写鸿蒙差异与共用约束。
- OpenHarmony 发行版适配、RK 开发板、车机、手表、TV。首版只验证手机。
- 把知识库默认放进应用沙箱作为唯一存储。会破坏“零锁定”，只能作为 Phase 0 降级模式。
- 申请 `MANAGE_EXTERNAL_STORAGE` 式的全盘权限，或依赖 `READ_WRITE_USER_FILE`。后者只面向 PC/2in1 的 IDE/调测工具。
- 修改官方 Tauri 上游来“顺便支持鸿蒙”。社区移植版固定 fork，出问题在 fork 侧打补丁，不混入桌面依赖。
- 首版做 Git、网页剪藏、打印、Canvas、知识图谱、插件、语音、模板、每日速记、Word 导入导出、分栏、多窗口。

## 二、现状与硬约束

### 2.1 可复用的部分

与 Android spec 共用：

- `src/editor-view.js`、`src/editor-schema.js`、markdown 往返测试。
- `src/commands.js`、`src/i18n.js`、`src/appearance-settings.js`、`src/settings-store.js`。
- `src/tabs.js`、`src/split-pane.js` 的纯逻辑；手机端仍强制单窗格。
- `src/ai-tasks.js`、`src/ai-agent.js`、`src/ai-panel.js`；Rust 侧 `ai.rs` 的请求与 SSE。
- `src/site-export.js`、`src/slides-export.js`、`src/plain-export.js` 的生成逻辑。
- Android spec 里的 `VaultFs` 抽象、单库锁定状态机、移动壳层与底部导航。
- `src/index.html` 的 SVG 图标表与 `src/icons.js`。

鸿蒙端不重复设计这些，只补平台层和构建链。

### 2.2 鸿蒙文件访问的三个硬事实

这些事实直接决定首版边界，不能按 Android SAF 的经验想当然：

1. **手机选文件夹要 API 26.0.0。** 官方 `DocumentSelectOptions.selectMode` 文档写明：`DocumentSelectMode.FOLDER` 从 API 26.0.0 起才在 Phone 设备支持；此前只有 2in1 设备可用。API 20-25 手机只能选文件，不能选目录。
2. **`READ_WRITE_DOCUMENTS_DIRECTORY` 不能救手机。** 该权限虽然从 API 12 起是 normal，但“支持设备”只有 PC/2in1 与 Tablet；`READ_WRITE_DOWNLOAD_DIRECTORY` 同样不含 Phone。普通手机应用不能靠它直接读写 `Documents`。
3. **持久化授权要走 `FILE_ACCESS_PERSIST`。** Picker 返回的是临时授权，退到后台即失效；长期访问必须 `fileShare.persistPermission`，每次启动 `activatePermission`。该权限在 API 12 起级别为 normal，本地调试可直接声明；但**上架 AppGallery 仍需按受限权限 ACL 方式申请**（官方标注 AGC 审核“申请后立即通过”，不等于普通权限自动授予）。

因此首版只有两条可行路线：

- **路线 A（主线）**：API 26.0.0 手机 + `selectMode=FOLDER` + `persistPermission` + `activatePermission`，保留“用户自己的文件夹 + 单库锁定”。
- **路线 B（降级）**：API 20-25 手机只做“单文件/多文件”模式，或应用沙箱库 + 导入导出。它不满足知识库产品承诺，只作为 Phase 0 兜底，不写成正式首版。

### 2.3 社区移植版 Tauri 的现状

已核实的两个参考：

- `richerfu/tauri-demo`：面向 OpenHarmony/HarmonyOS NEXT 的 Tauri 原型。安装方式是 `cargo install tauri-cli --git https://github.com/tauri-apps/tauri --branch feat/open-harmony` 加 `cargo install ohrs`；构建用 `cargo tauri ohos build`，产物在 `src-tauri/gen/ohos`，未签名 HAP 在 `entry/build/default/outputs/default/entry-default-unsigned.hap`；插件用 `#[cfg(target_env = "ohos")]`，`RustAbility` 转发生命周期。
- `LeenHawk/tauri-harmony`：Linux AMD64 的 Docker 构建镜像，固定 Tauri runtime 2.11.6、HarmonyOS SDK 6.0.0.858 / API 20、Rust 1.98、`aarch64-unknown-linux-ohos` 与 `x86_64-unknown-linux-ohos`，支持 `cargo tauri ohos build --ci --target aarch64`，自动加载 `tauri.ohos.conf.json`。镜像只保证交叉编译，不保证真机执行、HAP 签名或应用兼容。

结论：

- 社区移植版不是官方支持，版本与 API 组合由 fork/镜像决定；必须固定 commit 与镜像 digest，不能 `latest`。
- 当前公开镜像停在 API 20，**不满足手机选文件夹**。Phase 0 必须先把 SDK 升到 API 26.0.0，验证 fork 仍能编译；升不上去就不能承诺路线 A。
- 镜像在 Linux AMD64 上跑；Windows 本机需要 WSL2/Docker 或 Linux 构建机。HAP 签名与真机安装仍要 DevEco Studio。
- 移植版的能力边界（插件、IPC、WebView、生命周期、文件桥）需要 Phase 0 逐项验收，不能按官方 Tauri 文档推断。

### 2.4 与 Android 不同的平台阻断

| 阻断 | 现状 | 后果 |
| --- | --- | --- |
| Rust 无法直接读 `file://docs/...` | 库内文件是 HarmonyOS 用户文件 URI，不是普通路径；`std::fs` 不适用 | 必须新增 ArkTS/NAPI 文件桥，`VaultFs` 的鸿蒙实现不能复用 `std::fs` |
| 没有 SAF 的持久化 tree 授权 | 持久化走 `fileShare`，且每次启动要激活 | 单库锁定状态机多一步 `checkPersistentPermission` + `activatePermission` |
| 文件夹 Picker 版本门槛 | Phone 从 API 26.0.0 才支持 `FOLDER` | API 20 镜像无法直接做首版 |
| `FILE_ACCESS_PERSIST` 上架要 ACL | 本地调试可声明，商店发布走受限权限审批 | 上架材料要写清文档编辑场景；被驳回就没有持久化锁定 |
| 桌面依赖没有 OHOS 实现 | `trash`、`git2`、`notify`、`cpal`、Tauri tray/menu、`std::process` 命令 | 与 Android 一样按 `target_env = "ohos"` 收口，不能整套编译 |
| WebView 是 ArkWeb | 不是 WebView2/Android WebView | CSS `dvh`、safe-area、选择手柄、IME 行为都要真机验证 |
| 生命周期由 RustAbility 转发 | 社区移植版自己做了一层 Ability | 返回手势与前后台要以 ArkTS 事件为准，不能沿用 Tauri 桌面窗口事件 |

## 三、关键决策

### 3.1 路线 A：API 26 手机 + 文件夹 Picker + 持久化授权

首版按路线 A 设计，原因是它唯一能同时保住“本地文件夹”和“单库锁定”。

- 选库：`DocumentViewPicker(context)`，`DocumentSelectOptions.selectMode = FOLDER`，`maxSelectNumber = 1`；用 `canIUse('SystemCapability.FileManagement.UserFileService.FolderSelection')` 先判能力。
- 授权：选完立即 `fileShare.persistPermission([{uri, operationMode: READ_MODE | WRITE_MODE}])`，把 URI 与显示名存进 `settings.json` 的 `workspace.lockedVault` / `lockedVaultName`。
- 启动：`fileShare.checkPersistentPermission` 校验；通过后 `activatePermission`，再 `fileIo` 打开目录；不通过就显示「重新授权」，选择器用 `defaultFilePathUri` 指回上次目录。
- 换库/解除：先保存或关闭当前文档，再 `revokePermission` 旧 URI，切新锁或回引导页；不删文件。
- 远端/云盘 URI 不支持持久化。用户选到云盘或远端目录时提示改用本地目录；不把“启动直达”写成对所有 provider 生效。
- 最近打开：只收锁定库内文档，不跨库；与 Android spec 的单库锁定语义一致。

### 3.2 路线 B 只作为降级，不写成首版

如果 Phase 0 发现 API 26 构建链不可用，或者 ACL 审批走不通，按以下顺序降级：

1. API 26 平板/2in1 先做文件夹库，手机端只做单文件模式。产品上明确“手机版暂不支持文件夹知识库”。
2. 如果连单文件模式也要保知识库，退到应用沙箱库 + 手动导入/导出。此时 README 必须写清“笔记不在系统文件管理器可见”，不能宣传零锁定。
3. 如果两条都不满足，停止鸿蒙首版，不把降级模式包装成完成。

降级决策只能由 Phase 0 的实测结果触发，不能在实现中途悄悄换路线。

### 3.3 社区移植版固定，不混入桌面依赖

- 在 `src-tauri` 的 `[target.'cfg(target_env = "ohos")'.dependencies]` 里指向固定的 fork commit；桌面目标继续用 crates.io 的 `tauri = "2"`。
- fork 的 `tauri` / `wry` / `tao` / `cargo-mobile2` / `ability` 版本按 `tauri-pins.json` 的思路整套固定；不单独升某一个 crate。
- 不使用 `[patch.crates-io]` 全局替换，避免桌面构建被鸿蒙 fork 污染；如果 cargo 无法按目标拆分，改为 `src-tauri-ohos` 独立 crate，复用 `src-tauri/src` 的模块而不是复制代码。
- 移植版补丁放独立目录或 fork，文档记录来源 commit、镜像 digest、SDK 版本；升级时一次只动一个变量。
- 构建命令固定为 `cargo tauri ohos build --ci --target aarch64`；开发用 `cargo tauri ohos dev`；HAP 签名在 DevEco Studio 完成。

### 3.4 包名与签名

- HarmonyOS `bundleName` 至少三段。首版用 `app.notelume.harmony`，与 Android 的 `app.notelume.desktop` 区分；上架前定死，发布后不可改。
- `versionCode` / `versionName` 与仓库 `0.3.0` 对齐；HAP 版本号在 `AppScope/app.json5` 与 `build-profile.json5` 维护。
- release 证书、Profile、`keystore` 不入库；CI 只做未签名 HAP，签名走 DevEco 或受控 secrets。
- 首版不做自动更新；AppGallery 分发。

### 3.5 UI 复用 Android 移动壳层

- 平台标记新增 `harmony`；`platform.js` 的 `detectPlatform` 识别 ArkWeb UA 或 Tauri 注入的平台字段，写入 `data-tauri-platform="harmony"`。
- 复用单窗格、顶部栏、底部导航、文件抽屉、检查器/AI 全屏面板、长按动作表、首次锁定引导页。
- 鸿蒙差异单独放 `src/mobile/harmony.css` 或 `data-tauri-platform="harmony"` 分支，不把 ArkWeb 的补丁写进 Android 样式。
- 不引入 ArkUI 原生页面重写编辑器；ArkWeb 承载现有前端，ArkTS 只做文件桥、生命周期、返回手势、安全区与签名/权限。

## 四、架构

### 4.1 分层

```
前端（现有模块 + Android 移动壳层）
        │  Tauri invoke，vaultRoot 仍是字符串（file://docs/...）
        ▼
Rust 命令层（src-tauri/src/lib.rs）
        │  parse_root → Local(PathBuf) | Ohos(uri)
        ▼
VaultFs（src-tauri/src/vault_fs.rs）
   ├─ LocalVaultFs：桌面 std::fs
   ├─ AndroidVaultFs：Android spec 的 Kotlin 插件
   └─ OhosVaultFs：ArkTS/NAPI 文件桥
            │  社区移植版 Tauri 的 OHOS 插件通道
            ▼
ArkTS 文件桥（entry/src/main/ets/...）
   picker + fileIo + fileShare + preferences
```

关键点：`VaultFs` 接口与 Android 共用，`VaultRoot` 增加 `Ohos { uri, display_name }`。前端与命令签名不变，文件树、索引、AI 工具、导出继续走同一条链。

### 4.2 VaultFs 鸿蒙实现

接口沿用 Android spec 的 `list_all` / `stat` / `read_text` / `read_many` / `write_text` / `create_dir` / `delete` / `rename` / `read_bytes` / `write_bytes`。鸿蒙实现要点：

- 根是用户授权的目录 URI，rel 是相对根的子路径；`normalize_rel` 复用，拒绝 `..`、绝对路径、`file://` 混入。
- 目录遍历先用 `fileIo.listFile(dirUri)`，再递归；若 ArkTS 的 `listFile` 不接受目录 URI，用 `fileIo.open` + `listFile` 的 fd/path 变体，Phase 0 定版。无论哪种，必须用实测 API，不猜。
- 读文本：`fileIo.openSync(uri, READ_ONLY)` → `readSync` → UTF-8；写文本：`openSync(uri, WRITE_ONLY | CREATE | TRUNC)` 或 `write` 覆盖。
- 新建：`fileIo.mkdir`、`fileIo.createStream` / `open` 创文件；重命名：`fileIo.rename`；删除：`fileIo.unlink`（文件）/ `rmdir`（目录）。
- 二进制：图片走 `fileIo` 读写；插入图片从 `PhotoViewPicker` 或 `DocumentViewPicker` 选择后复制进 `assets/`。
- 批量读 `read_many`：一次 NAPI 调用读多篇，索引重建用；不能每篇一次跨语言往返。
- 错误码：`permission_lost` / `not_found` / `exists` / `escape` / `unsupported` / `io` / `too_large`，Rust 映射到 `ui_lang.rs`。

### 4.3 ArkTS 文件桥

ArkTS 侧只做平台能力，不复制业务：

| 能力 | API | 说明 |
| --- | --- | --- |
| 选文件夹 | `picker.DocumentViewPicker(context)` + `DocumentSelectOptions.selectMode = FOLDER` | 需要 UIAbility context |
| 能力检查 | `canIUse('SystemCapability.FileManagement.UserFileService.FolderSelection')` | 不支持就走降级提示 |
| 持久化 | `fileShare.persistPermission` | `READ_MODE | WRITE_MODE` |
| 启动激活 | `fileShare.checkPersistentPermission` / `activatePermission` | 每次启动都要做 |
| 取消授权 | `fileShare.revokePermission` | 换库/解除时 |
| 目录/文件 IO | `fileIo.openSync` / `readSync` / `write` / `mkdir` / `rename` / `unlink` / `stat` / `listFile` | 具体签名 Phase 0 实测 |
| 导出 | `picker.DocumentViewPicker.save` + `fileIo.write` | 单篇 HTML / Markdown |
| 图片 | PhotoViewPicker 或 DocumentViewPicker（image/*） | 复制进 `assets/` |
| 打开链接 | `common.UIAbilityContext.startAbility` / `openLink` | 替换 `xdg-open` |
| 退出 | `UIAbility.terminateSelf` | 返回手势确认后 |

桥接方式按社区移植版的能力选：优先用移植版的 Tauri 插件 + ArkTS/N-API；如果移植版只支持命令级桥，就把文件桥做成一个 OHOS 插件，Rust 通过 `#[cfg(target_env = "ohos")]` 调用，前端仍只调 Rust 命令。不要在前端直接 `import` ArkTS 模块。

### 4.4 Rust 命令改造

与 Android spec 的改造表基本一致，差异是平台实现：

- `scan_vault` / `read_md_file` / `write_md_file` / `create_*` / `rename_item` / `delete_file` / `backup_*` / `save_image_*` / `export_file` 全部走 `OhosVaultFs`。
- `rebuild_index` 去掉 `fs::canonicalize`，`root_key()` 对鸿蒙返回 URI；正文 `read_many` 分批。
- `delete_file` 不走桌面 `trash`；回收站放在库根 `.notelume-trash/`，用 `fileIo.rename` 移入；provider 不支持时回可读错误。
- `start_vault_watcher` / `stop_vault_watcher` 鸿蒙回 `unsupported`；外部改动靠保存前 `stat` 与回前台刷新。
- `git_*`、`webclip`、`voice`、`print`、`build_site_graph`、`copy_vault_assets`、`docx_*`、插件、托盘、原生菜单按 `cfg(target_env = "ohos")` 关掉或注册 stub。
- `open_external_url` / `open_url` 走 ArkTS `startAbility` / `openLink`，不允许落到 `xdg-open`。
- `save_image_from_data_uri` / `export_file` 改成“建议文件名 + MIME + 内容”，由 ArkTS `DocumentViewPicker.save` 选目标。
- `qd_eval` 纯文本可用；`include` / `read` / `listfiles` 等文件类函数在鸿蒙降级；`qdDocDir` / `qdLibsDir` 不拼 URI。

### 4.5 构建与依赖门控

`src-tauri/Cargo.toml`：

| 依赖 | 桌面 | 鸿蒙首版 | 动作 |
| --- | --- | --- | --- |
| `tauri` | crates.io 2.x | 社区 fork 固定 commit | 目标依赖拆开；不全局 patch |
| `trash` | 用 | 不用 | 仅非 OHOS；鸿蒙走回收站 |
| `git2` | 用 | 不用 | 仅桌面；鸿蒙 stub |
| `notify` | 用 | 不用 | 监听命令回 unsupported |
| `reqwest` | native-tls | 先验证 rustls+ring；不行用镜像里的 OpenSSL | Phase 0 定 |
| `cpal` / `windows` | Windows 语音 | 不用 | 语音整块隐藏 |
| `tray-icon` feature | 桌面 | 桌面内部才引入 | 鸿蒙不创建托盘 |
| 纯 Rust 库（zip / roxmltree / sha2 / docx-rs） | 用 | 可留 | docx 首版隐藏 |

编译收口：

- `#[cfg(target_env = "ohos")]`，不是 `target_os = "ohos"`。社区移植版的插件示例用 `target_env`。
- Rust 目标 `aarch64-unknown-linux-ohos` 与 `x86_64-unknown-linux-ohos`；发布至少 arm64，x86_64 供模拟器。
- `set_decorations`、托盘、mac 菜单、`open_vault_window`、`take_launch_paths`、桌面拖放、剪藏 HTTP 服务全部按目标排除。
- `reveal_in_folder` 鸿蒙回 unsupported；`delete_file` 不实例化 `trash`。
- 如果 fork 的 Tauri 不兼容某个插件（dialog / clipboard / opener），先降级为 ArkTS 能力，不把插件强行塞进 HAP。

### 4.6 构建链与签名

- 构建机：Linux AMD64 Docker / WSL2。Windows 本机用 DevEco Studio 做签名与真机安装。
- 镜像：固定 digest，记录 Tauri runtime 版本、SDK 版本、Rust 版本；不直接使用 `latest`。
- 命令：`cargo tauri ohos init` 生成 `src-tauri/gen/ohos`；`cargo tauri ohos build --ci --target aarch64`；HAP 产物在 `entry/build/default/outputs/default/`。
- 签名：`build-profile.json5` 的 `signingConfigs` 由 DevEco 生成；证书/Profile 不入库。CI 只出未签名 HAP，签名由发布机完成。
- 版本：`AppScope/app.json5` 的 `versionCode` / `versionName` 与根 `package.json` / `Cargo.toml` 同步。
- 产物检查：`unzip -l` 确认 `libnotelume_lib.so`、`module.json`、`ets/modules.abc` 在 HAP 内；安装前检查 ABI。

### 4.7 生命周期、返回手势与安全区

- 社区移植版的 `RustAbility` 会转发生命周期；ArkTS 侧再补 `onBackPress`、`onForeground`、`onBackground`。
- 返回手势优先级与 Android 相同：关闭最上层菜单/动作表 → 关闭抽屉/面板 → 停止 AI 流 → 脏文档询问 → `terminateSelf`。
- 前后台：`onBackground` flush 自动保存、取消 AI 请求、持久化标签与滚动位置；`onForeground` 超过 30 秒重扫清单。
- 安全区：ArkTS 用 `window.getWindowAvoidArea` 取状态栏/导航条/键盘高度，注入 CSS 变量 `--nl-safe-top` / `--nl-safe-bottom` / `--nl-kb-h`；不假设 ArkWeb 自动提供 `env(safe-area-inset-*)`。
- 键盘：监听 `keyboardHeightChange`，同步 `--nl-kb-h`；编辑区底部 padding 与底部导航隐藏由该变量驱动。
- 返回手势与系统侧滑冲突：只在应用内可关闭层存在时拦截；根页面不拦截，避免用户无法退出。

### 4.8 权限与上架

`module.json5`：

- `ohos.permission.INTERNET`：AI、联网资源。
- `ohos.permission.FILE_ACCESS_PERSIST`：持久化授权。本地调试 API 12+ 可直接声明；AppGallery 发布按 ACL 受限权限申请，场景写“文档编辑类应用长期访问用户选择的笔记目录”。
- 不申请 `READ_WRITE_DOCUMENTS_DIRECTORY`、`READ_WRITE_DOWNLOAD_DIRECTORY`、`READ_WRITE_USER_FILE`。前两者不含 Phone，后者仅 PC/2in1 调测工具。
- 不申请 `RECORD_AUDIO`；首版不做语音。
- 隐私声明写清：文件只在本机读写；AI 请求会把选中文本发给用户配置的服务商；API Key 存应用沙箱。

`FILE_ACCESS_PERSIST` 是本项目的上架闸口：如果 AGC 驳回，路线 A 的“启动直达”不成立，只能每次 Picker 重新授权或降级到单文件模式。Phase 0 必须把 ACL 申请材料准备好，不能等实现完再试。该权限是 system_grant，不是运行时弹窗授权；用户不会在应用内看到“允许访问文件”的授权框，能否持久化取决于声明与 ACL 审批。

### 4.9 数据与缓存

- `settings.json`：应用沙箱 `filesDir`，由 Rust 读写；`workspace.lockedVault` 存目录 URI，`lockedVaultName` 存显示名。
- 清单缓存：应用沙箱 `cache/manifest/<uri-hash>.json`；内容含 rel、name、isDir、size、mtime；启动先读缓存，再后台刷新。
- 索引缓存：`cache/index/<uri-hash>.json`；只加速，不进入知识库。
- 备份：`filesDir/backups/<uri-hash>/<sha256(rel)>/`，保留 20 份 / 7 天；不写库内隐藏目录，避免每次备份都走跨语言 IO。
- 草稿：`filesDir/scratch`；未锁定库时可新建草稿，保存时要求先选库或导出。
- 回收站：库内 `.notelume-trash/`；`scan_vault` 跳过 `.` 开头目录；恢复回原 rel，同名追加 `-2`。

## 五、界面与交互

### 5.1 平台标记与壳层

- `platform.js` 识别 `harmony`，写 `data-tauri-platform="harmony"` 与 `data-form-factor`。
- 手机沿用 Android 的单列壳层：顶部栏（☰、文件名、＋、⋯）、标签胶囊、格式条、编辑区、底部四入口（文件 / 大纲 / AI / 更多）。
- 侧栏、检查器、AI 面板是覆盖层；文件抽屉顶部显示“库名 + 锁图标”。
- 平板 640-1023dp 侧栏常驻；≥ 1024dp 按桌面断点，但首版仍不做分栏。
- 桌面工具栏、窗口按钮、菜单条、字数统计、自动保存勾选在鸿蒙不显示。

### 5.2 首次启动与锁定目录

复用 Android `5.13` 的引导页，文案改成鸿蒙说法：

```
选择一个文件夹作为笔记库
笔记仍是普通 md，文件管理器和桌面版都能打开
首次选一次，之后启动直接进入
[ 选择笔记文件夹 ]   [ 稍后再说 ]
```

- API 26 以下设备显示“此设备不支持文件夹知识库”，给“单文件模式 / 稍后再说”，不假装能选目录。
- 授权失败页显示库名 + 「重新授权」；`defaultFilePathUri` 指回原 URI。
- 设置页「知识库目录」：显示库名、URI 截断、锁定时间；更换 / 解除都要先保存当前文档。
- 锁图标用 SVG sprite 的 `i-lock` / `i-unlock`；不引入 emoji。

### 5.3 文件树与编辑器

- 文件树行高 44dp，单击打开，长按动作表；顶部固定“库名 + 锁图标”与搜索框。
- 文件树底部只留「刷新」；更换目录在设置页，不在文件树里误触。
- 编辑器左右 padding 16px，字号 16px，行高 1.75；代码块/表格横向滚动；行号在手机上隐藏。
- 格式条 44dp，左侧 `＋` 插入块；图片从系统 Picker 选择后复制进 `assets/`。
- 选区工具条保留加粗 / 斜体 / 链接 / 高亮 / AI；其余进“更多”。
- 源码模式保留，入口在“更多”；软键盘下不自动切换。

### 5.4 菜单、长按、AI

- 现有 `.cv-menu` 在手机上改底部动作表；长按文件、标签、图片、表格触发；编辑器正文保留系统文本选择菜单，不挂长按。
- 悬浮预览关闭；点 `[[链接]]` 直接跳转，长按出“打开 / 复制链接 / 新建”动作表。
- AI 面板全屏，输入卡固定在键盘上方；麦克风隐藏；停止、清空、设置保留。
- AI 流式回答在 `onBackground` 取消，半截回答按现有规则保留。
- 导出单篇 HTML / Markdown / 幻灯片 HTML；保存用 `DocumentViewPicker.save`。

### 5.5 鸿蒙视觉差异

- 字体栈优先 `HarmonyOS Sans`，回退系统无衬线；不强制下载字体。
- 圆角、阴影、动效按 ArkWeb 实际渲染调，不照搬桌面 Windows 的 1px 边框。
- 暗色主题用现有 CSS 变量；状态栏图标颜色由 ArkTS 窗口配置，不用 CSS 伪造。
- 安全区与键盘高度由 ArkTS 注入 CSS 变量；ArkWeb 的 `env()` 只在真机验证通过后作为增强。

## 六、文件与数据语义

| 操作 | 鸿蒙首版语义 |
| --- | --- |
| 首次锁定 | 引导页 → `DocumentViewPicker` FOLDER → `persistPermission` → 写 `lockedVault` → `scan_vault` / 索引 / 恢复标签 |
| 启动直达 | `checkPersistentPermission` → `activatePermission` → 读清单缓存 → 后台刷新；不弹选择器 |
| 授权失效 | 保留锁 URI；显示重新授权；选回同一目录恢复；选别的目录先确认换锁 |
| 更换目录 | 设置页入口；保存/关闭当前文档 → `revokePermission` 旧 URI → 切新锁 → 重建索引与标签 |
| 解除锁定 | 保存/关闭当前文档 → `revokePermission` → 清空标签与索引缓存 → 回引导页；不删文件 |
| 最近打开 | 只收锁定库内文档；不跨库 |
| 外部修改 | 无监听；保存前 `stat` 比 mtime；冲突三选一；回前台超 30 秒重扫 |
| 删除 | 移入库内 `.notelume-trash/`；失败弹永久删除确认 |
| 备份 | 应用沙箱，20 份 / 7 天；不写库内 |
| 草稿 | 未锁定库时落 `filesDir/scratch`；保存时要求选库或导出 |
| 导出 | 单篇 HTML / Markdown / 幻灯片 HTML；用户选目标位置 |
| 图片 | Picker → `assets/`；显示仍用 data URI |
| 分享 | 首版不做；Phase 5 接系统分享 |

## 七、能力矩阵

| 能力 | 桌面 | Android | HarmonyOS 首版 |
| --- | --- | --- | --- |
| 知识库文件夹 | 原生目录 | SAF tree | API 26 手机 Picker FOLDER + 持久化授权 |
| 单库锁定 | 无 | 有 | 有，且每次启动要激活持久化权限 |
| 文件监听 | `notify` | 无 | 无 |
| 单文件打开 | 有 | Phase 5 | Phase 5 / 降级模式 |
| 标签页 | 多窗格 | 单窗格 | 单窗格 |
| 分栏 | 有 | 无 | 无 |
| WYSIWYG / 源码 | 有 | 有 | 有 |
| 大纲 / 标签 / 属性 / 反链 | 有 | 有 | 有 |
| 全库搜索 | 有 | 有 | 有 |
| 双链 / 悬停预览 | 有 | 跳转保留，预览关闭 | 同 Android |
| 右键 / 长按 | 右键 | 长按动作表 | 长按动作表 |
| 快捷键 | 有 | 外接键盘 | 外接键盘 |
| 拖放打开 | 有 | 无 | 无；用系统分享/Intent |
| 多窗口 | 有 | 无 | 无 |
| AI Ask / Agent | 有 | 有 | 有；TLS Phase 0 定 |
| 语音 | Windows/浏览器 | 无 | 无 |
| 图片插入/查看 | 有 | 有 | 有 |
| 单篇导出 | 有 | 有 | 有 |
| 整站导出 / docx | 有 | 无 | 无 |
| 打印 | 有 | 无 | 无 |
| Git | 有 | 无 | 无 |
| 剪藏服务 | 有 | 无 | 无 |
| Canvas / 图谱 / 插件 | 有 | 无 | 无 |
| 模板 / 每日速记 | 有 | 无 | 无 |
| Quarkdown | 有 | 基础语法 | 基础语法 |

## 八、实施阶段

### Phase 0：工具链与权限闸口（必须先做）

1. 用固定 digest 的 Linux AMD64 镜像起构建环境；确认 `cargo tauri ohos init` 生成 `src-tauri/gen/ohos`。
2. 把 SDK 从镜像默认的 API 20 升到 API 26.0.0；验证 Tauri fork、`ohrs`、`cargo tauri ohos build` 仍能编译。升不上去就触发 §3.2 降级决策。
3. 最小 HAP 跑通：Rust IPC → 前端按钮 → 返回；`RustAbility` 生命周期能到前端。
4. ArkTS 文件桥跑通：`canIUse` → FOLDER Picker → `persistPermission` → 杀进程 → `checkPersistentPermission` + `activatePermission` → `fileIo.listFile` 遍历 → 读写一个文件。
5. 验证 `FILE_ACCESS_PERSIST` 本地声明与 ACL 申请材料；确认 AGC 场景描述。
6. AI：Android 端的 `reqwest` 在 OHOS 目标上编译；先试 rustls+ring，不行再用镜像 OpenSSL；发一次 HTTPS 请求。
7. 量一次 500 篇库的 `listFile` 递归与批量读耗时；记录目录 URI 的 `listFile` 是否可用。
8. 退出判据：真机安装 HAP，能选 `Documents/NoteLume`、持久化、重启直达、读写一篇 md；否则停在这里，不进入 UI 改造。

### Phase 1：可打开的壳

- `platform.js` 加 `harmony`；隐藏桌面工具栏/窗口按钮/菜单条。
- 复用 Android 移动壳层、底部导航、抽屉、AI 面板；单窗格归一。
- 首次引导页、授权丢失页、设置页「知识库目录」。
- 文件树与只读 WYSIWYG；返回手势关闭抽屉。
- 退出判据：360dp 宽真机能打开库、点文件、阅读、返回；杀进程重开直达。

### Phase 2：可编辑

- `OhosVaultFs` 写路径；保存、自动保存、冲突检测、草稿恢复。
- 新建 / 重命名 / 删除 / 回收站；图片插入与查看。
- `onBackground` flush；中文输入法；键盘高度 CSS 变量。
- 退出判据：1MB 文档编辑保存后与桌面逐字节一致；后台杀进程恢复草稿。

### Phase 3：知识库能力

- 索引重建改 `OhosVaultFs`；全库搜索、反链、大纲、标签、属性。
- 清单缓存、索引缓存、回前台刷新、授权失效恢复。
- 设置页、外观、五语言在 ArkWeb 下的排版。
- 退出判据：200 篇库搜索命中正确；反链与桌面一致；授权失效能重新授权。

### Phase 4：AI 与导出

- AI 面板移动布局；Ask / Agent；TLS 与后台取消。
- 单篇 HTML / Markdown / 幻灯片导出到 Picker 目标位置。
- 退出判据：HTTPS 服务商跑通 Ask 与 Agent；导出文件能在系统浏览器打开。

### Phase 5：上架与打磨

- HAP 签名、AppGallery 材料、`FILE_ACCESS_PERSIST` ACL 审批结果。
- 平板断点、横屏、安全区、暗色状态栏、TalkBack / 无障碍。
- `ACTION_VIEW` / 系统分享接收（文件管理器点 md 打开）。
- 性能优化：清单缓存、批量读、图片懒加载、长列表。
- 退出判据：§9 真机清单全过；桌面端回归不受影响。

## 九、测试与验收

### 9.1 共用单测

- `src/tests/platform.test.mjs`：新增 `harmony` 判定，Android / 桌面不回归；`formFactorFor` 边界。
- `src/tests/vault-path.test.mjs`：`file://docs` URI 不做 lowercase、尾斜杠归一、`rootChanged`。
- `src/tests/mobile-locked-vault.test.mjs`：首次锁定、启动直达、授权失效、换库确认、非锁定 root 拒绝；鸿蒙状态机复用。
- `src/tests/mobile-shell.test.mjs`：单窗格、抽屉、AI 全屏、键盘 inset。
- Rust `vault_fs::tests`：`normalize_rel`；`MemoryVaultFs` 驱动扫描/索引/备份/回收站；`OhosVaultFs` 的 URI 拼接与错误码映射（纯逻辑部分）。
- `cargo test --lib` 在桌面跑；OHOS 分支用 `cfg` 隔离，不因为本机跑不了就删测试。

### 9.2 构建与回归

- `npm run build:web` 无错。
- `npm run build` 桌面包正常。
- 前端 `src/tests/*.test.mjs` 全量通过。
- `cargo test --lib` 全量通过。
- `cargo tauri ohos build --ci --target aarch64` 出未签名 HAP；DevEco 签名后装真机。
- HAP 内容检查：`libnotelume_lib.so`、`module.json`、`ets/modules.abc` 存在；ABI 与设备匹配。

### 9.3 真机矩阵

| 设备 | 系统 | 用途 |
| --- | --- | --- |
| Mate 60 / Pura 70 或同级 | HarmonyOS API 26.0.0+ | 主验收，文件夹库 + 持久化 |
| API 20 手机 | HarmonyOS 早期 NEXT | 验证“不支持文件夹”的降级提示，不承诺知识库 |
| 平板 / 2in1 | API 26 | 文件夹 Picker + 侧栏常驻 |
| 模拟器 | API 26 x86_64 | 构建与布局冒烟 |

### 9.4 验收场景

1. 首次锁定：API 26 手机选 `Documents/NoteLume` → 持久化成功 → 文件树出现；重启设备后启动直达，不弹 Picker。
2. 授权失效：系统撤销/清理授权后重开 → 显示「重新授权」并预置上次目录 → 选回同一目录恢复；选别的目录先确认换锁。
3. 编辑：中文输入法、加粗、列表、任务、表格、代码块、图片；保存；桌面逐字节比对。
4. 文件操作：新建、重命名、删除进回收站、恢复、清空；同名冲突提示。
5. 冲突：桌面改同一篇后手机保存，三条分支（重载 / 覆盖 / 取消）都走一遍。
6. 搜索：200 篇库中文/英文关键词；反链目标正确；大纲跳转。
7. AI：HTTPS 流式问答、停止、插入；后台切换时请求取消。
8. 导出：HTML 用系统浏览器打开；Markdown 落盘。
9. 布局：360×640、412×915、800×1280；横竖屏；暗色；五语言；字号调大。
10. 返回手势：动作表 → 抽屉 → AI → 脏文档 → 退出，逐层验证；根页面不拦截。
11. 生命周期：后台 10 分钟回来刷新文件树；低内存杀进程后草稿恢复。
12. 性能：冷启动 ≤ 3s；500 篇库打开 ≤ 2s（有缓存）；切文件 ≤ 300ms；5MB 文档内存峰值 ≤ 400MB。
13. 降级：API 20 手机不显示文件夹入口，只给单文件/稍后再说；不出现“能选目录”的假象。

## 十、风险与未决

| 风险 | 影响 | 处理 |
| --- | --- | --- |
| 社区移植版非官方、可能停止维护 | 构建链断裂、无法升级 | 固定 commit + 镜像 digest；Phase 0 先验；保留桌面与 Android 独立 |
| 镜像 SDK 停在 API 20 | 手机文件夹 Picker 不可用 | Phase 0 升 API 26；升不上去就按 §3.2 降级，不硬做 |
| `FILE_ACCESS_PERSIST` 上架要 ACL | 持久化锁定被驳回 | 提前准备文档编辑场景材料；AGC 标注“申请后立即通过”但仍需审批 |
| 远端/云盘 URI 不支持持久化 | 选到网盘目录时启动直达失效 | 首次选择时提示改用本地目录；不承诺远端 provider 的持久化 |
| `listFile` 对目录 URI 的行为未实测 | 文件树/索引不可用 | Phase 0 用真机验证 URI 遍历；不行改 `open` + fd/path 方案 |
| `fileIo` 跨语言往返慢 | 大库首开、搜索慢 | 批量读、清单缓存、索引缓存；500 篇实测 |
| ArkWeb 与 Chromium 差异 | CSS/选择/IME 异常 | 真机验收；只用渐进增强；鸿蒙差异进 `harmony.css` |
| HAP 签名/上架流程陌生 | 无法分发 | Phase 5 专门做；CI 只出未签名 HAP |
| 桌面依赖无 OHOS 实现 | 编译失败或功能误暴露 | `target_env = "ohos"` 收口；stub 命令；能力表过滤 |
| TLS 在 OHOS 上不通 | AI 不可用 | rustls+ring 先验；不行用镜像 OpenSSL |
| “锁定”被理解成文件锁 | 用户以为外部不能改 | 文案只写“锁定目录”，注明不阻止其他编辑器 |
| API 20 设备体验落差 | 用户期待文件夹库 | 首次页明确“不支持文件夹”，只给单文件/稍后再说 |
| 包名 `app.notelume.harmony` 上架后不可改 | 改名成本高 | 首次发布前定死 |

未决问题：

1. 社区移植版是否支持 API 26.0.0 的 SDK。当前公开镜像只到 API 20，Phase 0 必须先回答。
2. `FILE_ACCESS_PERSIST` 的 ACL 审批是否接受“文档编辑器长期访问用户选择目录”。需要实际提交材料验证。
3. `fileIo.listFile` 是否直接接受目录 URI；不接受时用哪种等价方案。
4. 手机端是否接受 API 26 最低门槛；如果不接受，是否做单文件模式，还是暂缓鸿蒙首版。
5. 是否在首版支持“文件管理器点 md 打开 NoteLume”；涉及 `Want` / `ACTION_VIEW` 与单文件授权。
6. 是否复用 Android 的 `src/mobile/*` 目录，还是抽成 `src/mobile/common` + `src/mobile/harmony`；在实现前按代码量定。

## 十一、交付与文档

- 实现分支 `feat/harmonyos`，从最新 `origin/master` 拉出；不合并 `web`，不把 Android 分支的生成工程直接搬过来。
- 生成并入库 `src-tauri/gen/ohos`；签名证书、Profile、密钥不入库。
- 固定版本记录：`docs/superpowers/specs` 本文件、`tauri-pins` 或等价锁文件、镜像 digest、SDK 版本。
- 实现完成后同步更新：
  - `CHANGELOG.md` 的 `Added`：鸿蒙首版能力、社区移植版基线、构建命令。
  - `docs/ROADMAP.md` 的鸿蒙条目与状态。
  - `README.md` 中英两版：平台徽标、安装表、鸿蒙首版能力与限制（API 26、文件夹锁定、无 Git/剪藏/打印/插件）。
  - `docs/CLAUDE.MD` 的技术栈与架构设计：增加 HarmonyOS 目标、`OhosVaultFs`、社区移植版口径。
- 本文件只定设计与 Phase 0 闸口；闸口不过，不进入 UI 改造，不把降级模式写成完成。