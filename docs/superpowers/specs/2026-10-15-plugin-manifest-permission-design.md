# 批次 F1 · 插件清单 + 权限同意 —— 设计（Spec）

- 状态：设计已定，待写实现计划（writing-plans）
- 日期：2026-10-15
- 批次：E 已闭环 → 批次 F「插件系统 v2」第一个子项目 **F1**
- 范围：文件夹化插件包 + 声明式 `manifest.json` + 首次加载权限同意（软闸门）。**不改 ctx、不做技术拦截**（那是 F3）。

## 1. 背景与现状（v1）

- 插件 = 放在 `<vault>/.notelume-plugins/*.js` 的普通 ES 模块，运行在**主线程、无沙箱**（P2 刻意决策，仿 Obsidian「用户自担风险」）。
- 加载：Rust `list_plugins`（枚举一级 `*.js/*.mjs`）+ `read_plugin`（前缀白名单 `.notelume-plugins/` + `abs_in_vault` 防穿越）→ 前端 Blob URL + 动态 `import()`。
- 钩子：`onInit / onEditorReady / onDocChange / onFileOpen / onSave`；注册：`registerCommand / registerKeymap / registerInputRule`；`registerNodeSpec / MarkSpec` 因 schema 不可变是空壳。
- 面板 🔌：启用/禁用（localStorage `nl-disabled-plugins` 记忆）+ 命令按钮。
- **无清单、无权限、无同意**；把整个 `view`/`schema` 直接交给 ctx。
- 安全底座（本设计据此界定"权限在防什么"）：`withGlobalTauri` 未开 → `window.__TAURI__` 未暴露、裸模块 import 从 Blob URL 解析不了 → Tauri 命令非"抬手可及"；但 `csp: null` → 主线程插件可任意 `fetch`/碰 localStorage/DOM，**拦不住**。

## 2. 批次 F 全景与 F1 定位

用户目标：**长期做插件市场/生态**；隔离路线定为**混合**（默认 Obsidian 式信任 + 对"不碰编辑器"类插件的可选 Worker 隔离）。据此 F 拆为四个各有独立价值、彼此依赖的子项目，各走自己的 spec→plan→实现：

| 序 | 子项目 | 成本 | 依赖 |
|---|---|---|---|
| **F1**（本文） | 文件夹化包 + manifest + 权限同意（软闸门） | 中 | 无 |
| F2 | `registerNodeSpec`（装配前收 spec、统一建 schema） | 高 | F1（`schema` scope 作信号位） |
| F3 | 可选 Worker 隔离（非编辑器类插件）+ 按 F1 授权表真拦截 | 中 | F1 |
| F4 | 插件市场（浏览/安装/上架审核白名单） | 中高 | F1（+ 宜 F2/F3 就位） |

**定序先做 F1**：最便宜、能独立交付价值、是后三块共同的数据基座（清单/权限的"申报格式"）。文件夹化虽对 v1 破坏性，但**当前真实插件数=0，正是迁移最省的时刻**（F4 的市场包本就是文件夹）。

## 3. 关键决策（已与用户敲定）

1. **文件夹化安装包**（否决 sidecar/头注释两案）：`.notelume-plugins/<id>/{manifest.json, main.js, assets/}`。
2. **F1 = 纯声明 + 同意的软闸门**：不包装 ctx、不做拦截；价值是知情 + 授权留档 + 给 F3 预留契约。
3. **一律弹**：每个插件**首次加载都要求显式同意**，不豁免"无额外权限"插件。
4. **基线不算权限**：注册命令/快捷键/输入规则 + 生命周期 + 读写 `view`/`schema`/`dispatch` 是"插件之所以是插件"的固有契约，永远可用；权限门只管基线之外的额外可达面。
5. 同意**全有/全无**（F1 不做逐项勾选）；多插件的待同意**合并成一次弹窗**。
6. 面板保留**「重设权限」**动作。

## 4. 设计 · 包结构与清单

### 4.1 目录
```
.notelume-plugins/
  <id>/                 ← 目录名 === manifest.id，安全 slug：^[a-z0-9][a-z0-9-]*$
    manifest.json       ← 必需，入口真源
    main.js             ← 入口 ES 模块（路径由 manifest.main 指，默认 "main.js"）
    assets/             ← 可选（F4 才大量用）
```
- loader 改为**枚举一级子目录**、每目录**只读 `manifest.json`（不 import 代码）** → 过同意门 → 才对 `main` 做 `import`。
- **不再识别平铺 `.notelume-plugins/foo.js`**。检测到游离顶层 `.js/.mjs` → 面板顶部一行「⚠ 旧版插件 X.js 需文件夹化，已忽略」（不静默）。
- 迁移 `examples/notelume-plugins/hello.js` → `hello/manifest.json + hello/main.js`；README 插件段同步。

### 4.2 manifest schema（`manifestVersion: 1`）
```jsonc
{
  "manifestVersion": 1,
  "id": "hello",            // 必须 === 目录名、合法 slug
  "name": "Hello 示例插件",  // 显示名
  "version": "1.0.0",       // 插件自身 semver（字符串即可，不强校验 semver）
  "author": "",             // 选填
  "description": "",        // 选填
  "main": "main.js",        // 相对本目录；默认 main.js；须存在且以 .js/.mjs 结尾
  "permissions": []         // 见 4.3，默认 []；每项须在已知词表内
  // 预留(不实现): minAppVersion
}
```
校验（任一不过 → 该插件**无效**：不运行、面板显具体原因、绝不默认放行）：
- JSON 可解析；`id` 合法 slug 且 === 目录名；`name` 非空；`main` 存在（Rust 侧查）且后缀合法；`permissions` 为字符串数组且每项 ∈ 已知词表。

### 4.3 权限词表
| scope | 对用户的含义 | F1 效果 | 未来（F2/F3） |
|---|---|---|---|
| `network` | 可能联网拉取远端资源 | 声明 + 同意 | F3 真拦（代理 / 禁 fetch） |
| `fs-vault` | 读写知识库内文件 | 声明 + 同意 | F3 发受控句柄 |
| `fs-outside` | 触及库外路径（**高危**，弹窗更醒目） | 声明 + 同意 | F3 |
| `git` | 驱动 Git 命令 | 声明 + 同意 | F3 命令门 |
| `schema` | 注册新节点/标记 | 声明 + 同意 | **F2 消费**（"装配前收 spec"信号位） |
| `persistent-store` | 命名空间化的本地存储 | 声明 + 同意 | F3 ctx 收口 |

**诚实边界**（文档/弹窗显著位置）：主线程 JS 拦不住 `window.fetch`，故 F1 里除 `schema`（F2 用）外，scope 是**披露 + 知情同意 + 给 F3 的契约**，非技术墙。同意弹窗文案不得宣称"已阻止未授权行为"。

## 5. 设计 · 加载与同意

### 5.1 同意存储
- localStorage `nl-plugin-consent`：`{ [id]: { perms: string[], at: number } }`（存"当时同意过的权限集"，`perms` 排序后写）。
- 变更判定：`permKey = permissions.slice().sort().join('|')`；当前 `permKey(manifest.permissions)` ≠ 存储项 → 视为需重新同意（多/少都算）。
- `needsConsent(manifest, stored)`：无存储记录 → true（一律弹）；有记录且 permKey 相等 → false；否则 true。
- `newPerms(declared, stored)`：弹窗里高亮本次相对上次新增的 scope。

### 5.2 加载序列（重构 `plugin-loader.js` 的 `reload()`，保留 `busy` 串行门）
```
list_plugins → 每个包:
  读 manifest → 校验
    无效 → 记 error 行, 跳过(不 import)
  禁用?(nl-disabled-plugins) → 跳过(不 import)
  needsConsent?(permissions 并入本次待同意队列)
    待同意 → 不 import, 收进队列
  已同意 / 无需(不可能, 一律弹) → read main → import → onInit/注册(沿用 v1 机制)
若有待同意队列 → 弹一次合并同意对话框 →
  同意: 写 consent + 对这些插件走 import/注册
  拒绝: 标 "权限未授予", 不 import
renderPanel()
```
> 一次 `reload()` 内：先跑"已同意"的插件，再把"待同意"的聚成一次弹窗；用户同意后当场补载，拒绝则留未授予态。

### 5.3 同意对话框
- 新纯 UI 模块 `src/plugin-consent-dialog.js`（复用现有 `.nl-*` 对话框样式，参照 `prompt-dialog.js`/`confirm3-dialog.js`）。
- 列出每个待同意插件：名称/版本/作者 + 权限 chip（基线恒显「仅编辑器功能」；额外 scope 逐条，`fs-outside` 标高危）+ 若有上次记录则高亮新增项。
- 两按钮：**全部同意** / **全部拒绝**（全有/全无）。拒绝的插件下次加载再弹。

## 6. 设计 · 面板 UX（扩现有 🔌 行）
- 每行加权限 chip 行 + version/author 副标题。
- 未授予态：状态「权限未授予」+「授予权限」小按钮（重触发该插件的同意）。
- 已授予态：小「重设」动作 → 删该 id 的 consent 记录 + `reload()`（下次重弹）。
- 顶部：旧版平铺 `.js` 忽略提示行（若有）。
- 保留现有启用/禁用 checkbox 与命令按钮。

## 7. 错误矩阵（一律"不运行 + 面板显原因"，不静默、不放行）
| 情况 | 处理 |
|---|---|
| 目录无 `manifest.json` | 「缺少 manifest，已忽略」 |
| JSON 非法 / `id`≠目录 / 非法 slug / 未知 scope / `main` 不存在 | 「manifest 无效：<原因>」 |
| 同意被拒 | 「权限未授予」+ 授予按钮 |
| `import` 抛错 | 沿用 v1：错误行显 message |

## 8. Rust 命令改动
- `list_plugins(vault_root) -> PluginList`：返回结构改为 `{ packages: Vec<PluginPackage>, legacyFlat: Vec<String> }`。
  - `PluginPackage`：`{ dirName, manifestPath, manifestRaw, mainExists }`——枚举 `.notelume-plugins/` 下**一级子目录**，只把其中 `manifest.json` **原文**读出（`manifestRaw`），并查 `manifest.main`（默认 `main.js`）是否存在（`mainExists`）。**Rust 不解析 JSON、不校验 scope/id**（避免与前端两份实现）——`id`/`name`/权限一律由前端从 `manifestRaw` 派生并校验（含 `id === dirName`）。
  - `legacyFlat`：顶层游离 `.js/.mjs` 文件名列表，供面板显「旧版需迁移」。
  - 无 `manifest.json` 的子目录：仍返回一条 `PluginPackage`（`manifestRaw` 为空）由前端判“缺少 manifest”。
- `read_plugin(vault_root, plugin_rel) -> String`：签名不变；路径约束仍是 `.notelume-plugins/` 前缀 + `abs_in_vault`；确保 `<id>/<相对>` 内读、目录外穿越**必须拒**（沿用现有双重防线，测试补文件夹用例）。

## 9. 测试
- 纯逻辑 `src/plugin-manifest.js`（`parseAndValidateManifest(jsonText, dirName) -> {ok,id,name,version,main,permissions,error}`，含 slug/id=目录/未知 scope/main 后缀判定）与同意决策（`permKey`、`needsConsent`、`newPerms`）——**无 DOM、可单测**。
- `src/tests/plugin-manifest.test.mjs`（`cd src && node tests/plugin-manifest.test.mjs`）：id≠目录 / 非法 slug / 未知 scope / main 后缀非法 / JSON 非法 / 空权限**仍一律弹** / 权限变更需重弹 / `newPerms` diff 正确。
- Rust：扩 `list_and_read_plugins_only_inside_dir` 为文件夹模型（枚举子目录 + `manifestRaw` + `mainExists` + legacy 平铺标记）；`read_plugin` 补 `<id>/<相对>` 内可读、`<id>/../..` 穿越被拒。
- 门禁：`cargo test --lib` + `node tests/plugin-manifest.test.mjs`（+ 既有 `roundtrip`/`keymap`）+ `npm run build` 三绿；含 Rust 须重启 tauri dev。

## 10. 落地分相（代码/文档分 commit，沿 R 系列习惯）
- **P0 Rust**：`list_plugins` 改文件夹枚举 + `PluginEntry` 扩字段 + `read_plugin` 用例 + 单测 → `cargo test`。
- **P1 前端**：`plugin-manifest.js`（纯）+ `plugin-loader.js` 重构（同意流程/序列）+ `plugin-consent-dialog.js` + 面板/CSS + 迁移 `hello` 示例 → `npm run build` + 纯逻辑测试。
- **P2 文档**：README 插件段改写（新结构 + 权限说明 + 一律弹）、CHANGELOG、ROADMAP 标 F1 完成、本 spec 落地补记。

## 11. 明确不做（Out of scope）
- 不改 ctx、不包装能力句柄、不做 `fetch`/fs/git 的运行时拦截（→ F3）。
- 不实现 `registerNodeSpec`（→ F2，本设计仅预留 `schema` scope 作信号位）。
- 不做市场/在线安装/审核后台（→ F4）。
- 不做逐项权限勾选、不做 sidecar/头注释清单格式（已决策走文件夹）。
- 不兼容平铺 `.js`（仅提示引导迁移）。

## 12. 待实现期确认的小项
- `PluginPackage`/`PluginList` 最终字段命名以后端实现时对齐现有 serde 风格为准（本文给的是意图）。
- `nl-plugin-consent` 记录是否随"禁用"清理：默认不联动（禁用≠撤权），仅在"重设"或"拒绝"时变更 consent。
