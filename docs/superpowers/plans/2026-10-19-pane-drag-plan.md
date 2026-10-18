# 窗格拖拽（标签 / 文件树 → 窗格）—— 实现计划

- 日期：2026-10-19
- 设计：`docs/superpowers/specs/2026-10-19-pane-drag-design.md`（已批准）
- 总门禁（每相结束跑）：`cd src && node tests/*.test.mjs` 全绿 + `npm run build` 无错；纯前端，刷新即生效，无需重启 Rust
- 分相：P1 引擎与模型 → P2 引擎 API → P3 链路与样式 → P4 文档，每相一个 commit

## P1 引擎与模型

**新增 `src/pane-drag.js`**（pointer 拖拽引擎 + 纯函数，DOM 交互经回调注入）

- 常量：`EDGE = 0.25`、`THRESHOLD = 4`。
- `dropZoneFor(rect, x, y, { edge = EDGE })` → `'left' | 'right' | 'top' | 'bottom' | 'center'`：`dx = min(x - left, right - x)`、`dy = min(y - top, bottom - y)`；两者都大于 `edge × 对应边长` → `center`；否则比 `dx / w` 与 `dy / h`，小的那轴定方向（横向按离哪边近给 `left` / `right`，纵向给 `top` / `bottom`）。
- `tabDropIndex(rects, x, skipIdx)`：数中点 x 小于指针 x 的标签数，跳过 `skipIdx`（被拖的那一项），结果夹到 `[0, len - 1]`。
- `createPaneDrag({ hitLeaf, labelFor, onDrop })` → `{ begin(ev, payload, sourceEl) }`
  - 内部状态 `st = null | { payload, sourceEl, x0, y0, active, ghost, hint, leaf, zone }`；window 上的 `pointermove` / `pointerup` / `pointercancel` / `keydown(Esc)` 常驻注册，`st` 为空直接 return。
  - 起拖：位移超 `THRESHOLD` 才置 `active`——不抢单击切标签、双击固定、中键关闭、文件树单击预览。
  - 起拖时：`<html>` 加 `nl-dragging`；源元素加 `dragging`；建 `.nl-drag-ghost`（`labelFor(payload)` 出文案）append 到 body。
  - move：ghost 跟指针（`transform: translate`）；`hitLeaf(x, y)` 取落点 `.nl-pane`；`dropZoneFor` 算落区；hint 矩形 = 整窗格（center）或半区（edge），写进 `.nl-drop-hint` 的 left / top / width / height；落在非窗格区域则隐藏 hint。
  - up：`active` 才派发 `onDrop({ payload, paneId, zone, tabIndex })`；无论成败都清 ghost / hint / class / 状态。
  - 排序索引只在「标签落回自己窗格的中心」时算：`tabDropIndex(leaf 里 .tab 的 rects, x, 被拖项下标)`。
  - 起拖后置一个 `suppressClick` 标志，window 上捕获阶段的 click 吞掉一次并复位——否则松手会跟着触发标签的 click（切标签）或文件树的 click（打开）。
- 排序用的 `.tab` rect 从落点叶子的 `.nl-pane-strip-scroll` 现取（标签会被 `render()` 重建，不缓存）。

**`src/tabs.js`**：新增 `moveTo(id, index)`

- 取项 → splice 出列 → index 夹到 `[0, len - 1]` → insert 回 → `render()`。id 不存在返回 false；移到原位仍重渲染一次（顺序没变，代价可忽略）。

**新增 `src/tests/pane-drag.test.mjs`**

- `dropZoneFor`：正中 → `center`；左 10% → `left`；右 12% → `right`；上 8% → `top`；下 8% → `bottom`；左上角（`dx/w 0.1`、`dy/h 0.3`）→ `left`；右上角 → `right`；左下角（`dx/w 0.3`、`dy/h 0.1`）→ `bottom`；24% → `left`；26% → `center`。
- `tabDropIndex`：三标签 x 在第一二之间 → 1；跳过被拖项（被拖项在第一位、指针在它右边）→ 索引少 1；空列表 → 0；x 在最左 → 0；在最右 → 长度 - 1。

**`src/tests/tabs.test.mjs`**（现有 8 条上扩）

- `moveTo`：前移 / 后移 / 移到原位顺序不变 / 越界夹取 / `serialize()` 的 items 顺序随之变化 / 不存在的 id 返回 false。

## P2 引擎 API：`split-pane.js` 的 `newFirst`

- `splitPane(tree, paneId, orientation, newPaneId, newFirst)`（纯函数）：`children` 按 `newFirst` 决定是 `[新, 旧]` 还是 `[旧, 新]`。比例维持 `SPLIT_DEFAULT`（0.5 对称；若以后支持非对称拆分，新窗格在前时比例要取 `1 - ratio`——basis 是第一个子）。
- `mountSplitTree` 的 `split(paneId, orientation, newPaneId, newFirst = false)`：DOM 手术里，`newFirst` 时 `wrap.append(fresh, bar, leaf)`（顺序 `[新, bar, 旧]`），否则维持现顺序；`applyRatioStyle` 照旧刷第一个子（即新叶子）。
- 现有 4 处调用点（按钮 / 命令 / 计划 P3 的两条路径）默认 `false`，行为不变。

**测试**（`split-pane.test.mjs` 扩）：`newFirst` 的树里 children 顺序、`paneIds` 顺序（新窗格在前）、ratio 仍是 0.5、旧形状（不传参）行为不变。（`split-pane-dom.test.mjs` 若 jsdom 下好测：新叶子是 wrap 的第一个孩子、分割条在中间、比例样式落在新叶子上。）

## P3 链路与样式

**`src/main.js`**

- `ensurePanesSaved(ids)`：先按 `paneCtx(id).dirty && paneCtx(id).rel` 过滤，再 `askSavePanes(过滤后的 ids)`；空列表直接 `return true`（避开 `askSavePanes([])` 退化成「问所有脏窗格」的既有毛病，spec 决策 6）。
- `detachTab(paneId, tabId)`：先取 `neighborOf`（必须在 remove 之前）→ `tabs.remove(tabId)` → 有邻居则 `activate(邻居)` + `loadDocIntoPane(paneId, 邻居)`，**不走** `openDocInPane`（它内部 `ensurePaneSaved` 会误问）→ 没有邻居则 `clearPane(paneId)`（顺带空态）。
- `moveTabToPane(tabId, dstPaneId)`：画布拦截 → `ensurePanesSaved([src, dst])` → 目标已有该文档则 `activate` + `pin`，否则 `tabs.open(doc)` → `loadDocIntoPane(dst, doc)` → `detachTab(src, tabId)` → `focusPaneUi(dstPaneId)` → `persistPanes()`。
- `splitTabToPane(tabId, dstPaneId, orientation, newFirst)`：画布拦截（含「落点窗格是画布所在窗格」）→ `ensurePanesSaved([src])` → `freshId` + `ensurePaneEditor(newId)` + `panes.view.split(dstPaneId, orientation, newId, newFirst)` → `mountPaneChrome` / `ensurePaneFindBar` / `ensurePaneHlBar` / `updatePaneChrome()` → `detachTab(src, tabId)` → `panes.focused = newId` + `syncFocusedEditor()` → 新窗格 `tabs.open(doc)` + `loadDocIntoPane(newId, doc)` → `persistPanes()`。
- 文件树：`dropTreeFile(dstPaneId, path, { split: { orientation, newFirst } | null })` → 有 split 先走空窗格拆分（复用上面 3、4 步）→ `ensurePanesSaved([dst])` → `tabs.open({ root, rel })` + `loadDocIntoPane` + `recordRecent(root, rel)` + `persistPanes()`。
- `handlePaneDrop({ payload, paneId, zone, tabIndex })` 统一派发：没有 paneId 直接回；`kind === 'tab'` 按 zone 走（center + 同窗格 → `moveTo(tabId, tabIndex)`；center + 别窗格 → `moveTabToPane`；四边 → `splitTabToPane`）；`kind === 'tree'` 按 zone 走 `dropTreeFile`。
- 绑定（boot 里一次）：`createPaneDrag({ hitLeaf, labelFor, onDrop: handlePaneDrop })` + document 级 `pointerdown` 委托——`button !== 0` 或 `!panes.view` 不起拖；命中 `.tab` 则取它所在 strip 的 `dataset.paneId` 与 `tabId`（payload 带 `{ paneId, tabId, doc }`）；命中 `.tree-file[data-kind=file]` 则 payload `{ kind: 'tree', path, root }`。
- `renderNode`：文件 li 摘掉 `draggable = true`（现在只触发没有 data 的原生拖，且原生拖一起动 `pointermove` 就断），folder 的 summary 不绑拖拽。

**`src/style.css`**

- `.nl-drag-ghost`（fixed、`pointer-events:none`、z-index 高于 strip、主题色边 + 半透明底、单行截断、`padding` 对齐 `.tab`）。
- `.nl-drop-hint`（fixed、主题色 12% 底 + 1px 边、4px 圆角、`pointer-events:none`）。
- `html.nl-dragging` + `html.nl-dragging *` 禁选（与 `nl-resizing` 同款），`cursor: grabbing`。
- `.tab.dragging { opacity: .45 }`。
- 打印隐藏清单（`@media print` 那组）补 `.nl-drag-ghost` 与 `.nl-drop-hint`。

**测试**：落定逻辑在 main.js（不可单测），由 P1/P2 的模块测试 + 无头冒烟 + 手验覆盖。

## P4 文档

- `docs/CLAUDE.MD`「标签页设计」补四条拖拽（跨窗格移动 / 落边拆分 / 条内排序 / 文件树拖到窗格）与「明确不做」清单的对应更新；「分栏设计」补落边拆分与 `newFirst`。
- `CHANGELOG.md` Unreleased/Added 一条（含实测段：`tauri dev` 手验六项——跨窗格移动 / 四边拆分 / 条内排序 / 文件树拖入与落边 / 拖活动脏标签的保存三选 / 预览标签落定转正）。

## 风险与回滚

- WebView2 里 pointer 拖拽若被吞（个别环境 pointermove 不跟手），回退方案：文件树改用 HTML5 DnD 自定义 mime（`application/x-nl-tree`），窗格侧 `dragover` / `drop` 与 `drop-open.js` 按 `dataTransfer.types` 分派共存。标签拖拽不受影响（标签本来就不是原生可拖元素）。
- 落定链路绕开 `openDocInPane` 会少掉它尾部的 `recordRecent` / `persistWorkspace` / 面板刷新：`loadDocIntoPane` 内部已有 snapshot / git 面板刷新与根变化门控；`recordRecent` 只在文件树拖入这条链路上补（移动标签不算「打开」）。
- 摘掉文件树 li 的 `draggable` 没有行为损失——现在那条原生拖没有任何 data，落在哪儿都不生效。
- 回滚粒度 = commit：P1 是新模块 + 新 API（旧调用不受影响）；P2 默认参数 `false`；P3 摘 li 的 draggable 与四个落定函数可整体 revert。
