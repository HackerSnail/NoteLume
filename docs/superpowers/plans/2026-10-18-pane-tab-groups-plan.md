# 窗格标签组（完整 VS Code 分栏模式）—— 实现计划

- 日期：2026-10-18
- 设计：`docs/superpowers/specs/2026-10-18-pane-tab-groups-design.md`（已批准）
- 总门禁（每相结束跑）：`cd src && node tests/*.test.mjs` 全绿 + `npm run build` 无错；纯前端，刷新即生效，无需重启 Rust
- 分相：P1 模型 → P2 UI → P3 链路 → P4 持久化与文档，每相一个 commit

## P1 模型层：tabs.js 每窗格实例 + 预览语义

**`src/tabs.js`**

- `createTabs({ paneId, mountEl, onSwitch, onClose })`：新增 `paneId` 参数；`idOf(paneId, root, rel)`（标签 id 三要素，同文档可多窗格同开）。
- items 每项加 `preview: boolean`；`joinTitle` 不变。
- `open(tab)`：固定语义——同 (root, rel) 标签存在则激活，否则以 `preview: false` 入列激活。供命令面板 / wikilink / 搜索 / 最近 / 模板 / 新建 / docx 落库等固定入口。
- `openPreview(tab)`：同窗格已有预览标签且文档不同 → 先摘旧预览（调用方已做脏检查），再以 `preview: true` 入列激活；无旧预览直接入列。返回被换掉的旧 id（无则 null）。
- `pin(id)`：清该标签 preview 标记并重渲染（标签元素 dblclick 内部直连，不设 onPin 回调——比 spec §3.1 少一个依赖项）。
- `previewId()`：当前预览标签 id 或 null。
- `serialize()` → `{ items: [{root, rel, canvas, scratch}], active }`（active 为索引，空列 -1，preview 不输出）；`restore(data)`：入列（全部按固定）、active 夹到合法范围。
- `remove(id)` / `clear()` / `update(id, patch)` 逻辑不变（update 后 id 用新 root/rel 重拼，paneId 部分不变，脏标记跟着搬的现有逻辑保留）。

**`src/tests/tabs.test.mjs`**（在现有 8 条上扩）

- `id 含 paneId：同文档在不同窗格是两个标签`
- `同窗格同路径只激活不重开；跨窗格同路径各开一份`
- `openPreview：无旧预览直接入列；有旧预览先替换并返回旧 id`
- `每窗格最多一个预览：连续两次 openPreview 只留最后一个`
- `pin：斜体标记清除、类名刷新`
- `serialize/restore 往返：preview 不落盘、active 夹紧、空列记 -1`
- `dblclick 标签触发 pin（预览转正）`

## P2 UI 层：窗格标签条

**`src/index.html`**：删 `#tabbar` / `#tabs` / `#tabs-split` 整块（114-117 行）；`.body` 直接是侧栏 / gutter / 编辑区。

**`src/style.css`**

- 现行 `.tabbar` / `.tabs-scroll` / `.tabs-split` 规则改写为 `.nl-pane-strip`（高 30px、`--bg-panel` 底、底部 1px 边框、flex、`position: sticky; top: 0; z-index: 6; width: 100%`）与其内部滚动区（标签溢出横向滚动，复用 `.tab` 现有规则与 `.tabs-scroll::-webkit-scrollbar` 隐藏）。
- `.tab.preview .tab-name { font-style: italic; opacity: .75 }`。
- 拆分 / 关闭按钮复用 `.nl-split-btn` 外观（strip 内右端一组）；删 `.nl-pane-close` 与 `.nl-split-btns`（编辑区右上角那组）规则。
- 打印样式隐藏清单补 `.nl-pane-strip`。

**`src/main.js`**

- 删 `buildPaneChrome`（编辑区右上角全局按钮组）与 `panes.chrome` 字段。
- `mountPaneChrome(paneId)` 改建 strip：滚动区（`createTabs` 的 mountEl）+ `split-h` / `split-v` / `close` 三钮（`setIcon` + i18n，行为接 `splitFocusedPane` / `closePaneUi`），并把 strips 实例存进 `panes.strips`。
- `updatePaneChrome()`：多窗格才显示各 strip 的 close 钮（规则不变），焦点窗格打标不变。
- `splitFocusedPane`：新窗格 `mountPaneChrome(newId)` 已有调用点之后建 strip（顺序：engine.split → ensurePaneEditor → mountPaneChrome → strips 实例）。
- `closePaneUi`：`panes.strips.delete(paneId)`（strip DOM 随叶子摘除，只清控制器引用）。
- boot 的窗格装配循环里对每个叶子建 strip。
- `leaveCurrentVault` 的 `clearTabBindings()` 调用删除（函数一并删）；`tabs.clear()` 改为清焦点窗格自己的 strip + `resetToNoDoc()`，其余窗格的 strip 保留（它们的标签各带自己的 root，仍可正常打开——注释更新说明这点）。

**`src/find-in-doc.js`**：`pin()` 的 `+ 12` 改 `+ STRIP_H`（文件内常量 `const STRIP_H = 34`，注释说明与 `.nl-pane-strip` 高度对齐）。

**`src/tests/split-pane-dom.test.mjs`**（扩）

- `strip 挂进叶子：含滚动区与三个按钮`
- `拆分后新窗格 strip 就位；关闭窗格后旧 strip 从 DOM 消失`
- `单窗格时 close 按钮隐藏（多窗格才显）`

## P3 链路层：统一打开入口 + 窗格内语义

**新增 `src/vault-path.js`**（纯模块）：从 main.js 搬 `normVaultPath`，加 `rootChanged(a, b)`（两者归一后不等即真，空值安全）。main.js 改为 import。`src/tests/vault-path.test.mjs`：同路径不同分隔符 / 大小写 / `\\?\` 前缀 / 尾斜杠 / 空值 → false，不同路径 → true。

**`src/main.js`**

- 删 `paneTabs` / `tabPane` / `bindTabToPane` / `unbindTab` / `rekeyTab` / `clearTabBindings`；`panes` 表加 `strips: new Map()`。
- `markPaneDirty(paneId, d)`：改写给该窗格**活动标签**的脏点（`strips.get(paneId)?.setDirty(activeId, d)`），焦点窗格部分逻辑不变。
- 新增 `openDocInPane(paneId, doc, { preview = false })`（spec §5.1 四步）：
  1. 该窗格已有同 (root, rel) 标签 → `activate` → 走换内容链路（脏检查照旧）→ 结束；
  2. `preview` 且有旧预览 → `ensurePaneSaved(paneId)`，取消则中止；通过后摘旧预览；
  3. 非预览 → `ensurePaneSaved(paneId)`；
  4. 写 `paneCtx(paneId)` 的 root/rel/scratch → `openFile(rel, true, paneId)` 装内容 → 标签入列（`open` 或 `openPreview`）→ 根变化门控：`rootChanged(oldRoot, doc.root)` 才 `scanVault` + `startIndexPolling` + `pluginManager.reload`，否则只 `highlightActiveFile` + `refreshLinkPanels`。
- `openFile(rel, skipDirtyConfirm, paneId)`：读取根从 `paneCtx(paneId).vaultRoot` 取（不再读全局 `state.vaultRoot`——窗格内可能有跨根标签）；加载后焦点窗格同步全局镜像（`syncFocusedEditor` 或既有内联逻辑）；删掉函数尾部的 `tabs.open` + `bindTabToPane` + `persistWorkspace`（移到 `openDocInPane`）。
- `openTabDoc` 删除，调用方全改走 `openDocInPane`：
  - `renderTree` 的文件项 click → `openDocInPane(focused, {root, rel}, {preview:true})`；新增 dblclick → `{preview:false}`（`src/main.js:1302` 附近）；单文件树 click（`renderSingleFileTree`，963 行）同样 click=预览 / dblclick=固定。
  - `openAbsPath`（选择器 / 启动参数 / 单实例 / 拖入的统一落点）：显式打开 = 固定；`handleOpenTargets` 里拖入与单实例转发两个场景传 `preview: true`（启动参数 = 显式意图 = 固定）。
  - `openVaultPath` 的 rel 打开、`onOpenWiki`、搜索结果点击、命令面板 `openFile` dep、最近打开、`template.js` 新建、`newScratchFile`、docx 落库、graph 节点点击：全部固定。
- `switchToTab(id)` / `closeTab(id)` 退化为焦点窗格内操作：switch = strip.activate + 换内容（脏检查）；close = 问脏 → strip.remove → 还有邻居则激活邻居并装内容，没有则 `showPaneEmpty(paneId, true)`。
- `cycleTab(dir)`：循环焦点窗格 strip 的 list（`status.oneTab` / `status.noTab` 提示保留）。
- `app.closeFile`（Ctrl+W）改为关焦点窗格活动标签（现有关页逻辑搬进来）；`app.nextTab` / `app.prevTab` 语义不变（组内循环），命令标题与 mac 菜单标题改「当前窗格的下一个 / 上一个标签页」，`cmd.app.nextTab` / `cmd.app.prevTab` 五种语言同步。
- `saveScratchAs`：`rekeyTab` 删除后，改为 `strips.get(focused).update(oldId, {root, rel, scratch:false})`（update 自己返回新 id，无外部表要rekey）。
- `MENU_NEEDS_DOC` 不变。

**测试**：P3 的逻辑大半在 main.js（不可单测），由 P1/P2 的模块测试 + 无头冒烟 + 手验覆盖；`vault-path.test.mjs` 是唯一新增纯函数测试。

## P4 持久化与文档

**`src/split-pane.js`**：`normalizeTree(raw, fallbackPaneId)` 改认两种形状：

- 新形状 `{tree, focused, tabs}`：树走现校验；`tabs` 每项 `{items:[{root,rel,canvas?,scratch?}], active}`——paneId 不在树里的丢弃、树里叶子缺条目的补空列、active 夹到 `[-1, len-1]`；`focused` 不在树里则取首个叶子。
- 旧形状（裸树）：迁移——树保留，首个叶子按 `settings.workspace.lastFile`（配 `lastVault`，存在才建）建一个固定标签，其余空列。
- 都不过 → 单窗格空标签。返回 `{tree, focused, tabs}` 统一形状。

**`src/main.js`**：`persistPanes()` 写 `{tree: serializeTree(panes.focused 的树), focused, tabs: {paneId: strips.get(paneId).serialize()}}`（内容没变不写盘的现有比对保留）。boot：`normalizeTree` 恢复后，每叶子建 strip + `restore`，再对每窗格活动标签走一次静默 `openFile`（不记最近、不写 workspace）；`panes` 空或坏 → 老路 `workspace.lastVault/lastFile`。迁移结果当场写回一次。

**`src/tests/split-pane.test.mjs`**（扩）：新形状原样收（tabs 校验 / 丢弃孤儿 / 补空列 / active 夹紧 / focused 回落）、旧形状迁移（有 / 无 lastFile）、坏数据退回单窗格。

**文档**：`docs/CLAUDE.MD` 「标签页设计 / 分栏设计」两节改写（每窗格标签条、预览规则、快捷键窗格内语义、`panes` 新 schema）；`CHANGELOG.md` Unreleased/Added 加条目（含实测段：`tauri dev` 手验五项——预览替换 / 拆分复制 / Ctrl+W·Ctrl+Tab / 重启恢复 / 旧 settings 迁移）。

## 风险与回滚

- `openFile` 改读 ctx 根是本期最深的一刀：所有打开入口都经 `openDocInPane`，漏改一个入口就会出现「标签开了但内容没装 / 根不对」。缓解：P3 逐个入口改完立即 `npm run build` + 无头冒烟（strip DOM 级）+ 手验文件树 / wikilink / 搜索三条主路径。
- 预览模式对老用户是行为变化：CHANGELOG 写明，设置里不做开关（YAGNI，用户反馈再议）。
- 回滚粒度 = commit：P1/P2 可独立回滚（旧全局栏代码仍在 git 历史）；P3 的 `openFile` 签名变化若出问题， revert P3 后 P4 的 schema 迁移仍兼容旧调用。
