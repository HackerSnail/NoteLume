# 窗格拖拽（标签 / 文件树 → 窗格）—— 设计（Spec）

- 状态：设计已定，待写实现计划（writing-plans）
- 日期：2026-10-19
- 前置：2026-10-18 窗格标签组 spec 已落地（每窗格一条标签条、预览 / 固定、settings.json panes 新 schema）；P5 §6.1 分栏引擎（`src/split-pane.js`）
- 范围：标签跨窗格拖动、标签拖到窗格边缘拆分、标签条内拖动排序、文件树拖文件到指定窗格
- 本文取代 2026-10-18 spec §10「明确不做」的前两条

## 1. 背景与现状

分栏 + 标签组落地后，摆布局只能靠标签条右侧的「左右 / 上下拆分」按钮，再逐个把文档点开。想把 A 窗格里的文档挪到 B 窗格，得在 B 里重新打开一遍（还跟着走一遍预览替换 / 索引路径）。对标 Obsidian 与 VS Code 编辑器组的拖标签，缺这套交互。

现状里可以直接用的东西：

- 分栏引擎的 DOM 手术（拆分只搬一个元素，不重建）——新窗格的落位要沿用这套。
- 标签条是每个窗格一个 `.nl-pane-strip`（`pane-strip.js`），条上标签由 `tabs.js` 的每窗格实例渲染。
- 外部文件拖入走 HTML5 的 `drop`（`drop-open.js`，只认 `dataTransfer.files`），按落点窗格切焦点。

## 2. 关键决策（已与用户敲定）

| # | 决策 | 取舍 |
|---|---|---|
| 1 | 拖拽用 pointer 事件（与分割条同源），不用 HTML5 DnD | HTML5 的 dragover 拿不到稳定的落区判定；`.body` 上外部文件拖入已经占着 `drop` 事件，两套 DnD 混在同一批元素上会互相抢 |
| 2 | 落区四分 + 中心：窗格外圈 25% 是四个拆分落区，其余是中心 | 25% 是 VS Code 的量级；角落按「离哪条边更近」判定，不会同时命中两轴 |
| 3 | 只移动，不做复制 | 复制没场景——同一文档多窗格已经由拆分复制、wikilink 两条路覆盖 |
| 4 | 预览标签被拖动 → 落定即固定 | 拖是显式意图，落定后不该再被下一个预览替换 |
| 5 | 文件树拖文件进窗格 = 固定标签；拖文件夹不支持 | 与双击一致；拖文件夹换库会影响所有窗格的根 |
| 6 | 落定前一次问清源 / 目标窗格的未保存改动，绕开 `openDocInPane` 内部的 `ensurePaneSaved` | 一个编辑器实例的硬限制：换内容前必须先处理改动。而 `ensurePaneSaved` 传 `[]` 时，`askSavePanes` 会退化成「问所有脏窗格」，会误问无关的第三个窗格 |

决策 6 顺带记一处既有毛病，不在本文范围：**`ensurePaneSaved(paneId)` 在该窗格不脏时传 `[]` 进 `askSavePanes`，而 `askSavePanes` 认空数组为「所有脏窗格」**——在干净窗格里打开文档，会把另一个脏窗格的保存弹窗带出来。本文的新链路因此都直接走 `tabs` + `loadDocIntoPane`，不经过 `openDocInPane`。要修就把 `ensurePaneSaved` 里那个 `[]` 分支改成直接 `return true`。

## 3. 拖拽引擎（`src/pane-drag.js`，新模块）

只管「指针按下 → 位移过阈值 → 跟手 + 高亮落区 → 松手派发」，落定动作在 `main.js`。DOM 交互全部经回调注入，便于 Node 侧单测纯函数部分。

- `dropZoneFor(rect, x, y, { edge = 0.25 })` → `'left' | 'right' | 'top' | 'bottom' | 'center'`
  - `dx = min(x - left, right - x)`、`dy = min(y - top, bottom - y)`；两者都大于 `edge × 对应边长` → `center`；
  - 否则比 `dx / w` 与 `dy / h`，小的那轴说了算：横向按 `x - left < right - x` 给 `left` / `right`，纵向同理给 `top` / `bottom`。
- `tabDropIndex(rects, x, skipIdx)` → 插入索引。数出「中点 x 小于指针 x」的标签个数，跳过 `skipIdx`（被拖的那一项本身）；越界夹到 `[0, len - 1]`。
- `createPaneDrag({ hitLeaf, labelFor, onDrop, edge, threshold })` → `{ begin(ev, payload, sourceEl) }`
  - `begin` 在 pointerdown 里调（button 0）；位移超 `threshold`（4px）才真正起拖——不抢单击切标签、双击固定、中键关闭、文件树单击预览。
  - 起拖：`<html>` 加 `.nl-dragging`（禁选 + `cursor: grabbing`），源元素加 `.dragging`（半透明），建 `.nl-drag-ghost` 跟指针。
  - 移动：`hitLeaf(x, y)` 取落点 `.nl-pane`（`document.elementFromPoint(...).closest('.nl-pane')`，现取不缓存），按落区算出矩形画 `.nl-drop-hint`。
  - 松手：`onDrop({ payload, paneId, zone, tabIndex })`。落在非窗格区域（侧栏 / 状态条）、或没过阈值就松开 → 无操作，源标签复原。
  - `pointercancel` / Esc → 取消，同样复原。
  - 事件绑在 window 上（`pointermove` / `pointerup` 一次注册，多窗格共用），不用 `setPointerCapture`：拖拽期间标签元素会随 `render()` 重建，捕获会断。

## 4. 落区 → 动作

| 落区 | 拖的是标签 | 拖的是文件树文件 |
|---|---|---|
| 中心，落回自己窗格 | 按落点 x 插到相邻标签之间（排序） | 已开则激活，否则打开（无排序概念） |
| 中心，落在别的窗格 | 移动：文档进目标窗格，源窗格摘标签 | 在目标窗格打开 |
| left / right | 目标窗格横向拆分，新窗格在左 / 右，文档进新窗格 | 同左，新窗格里打开 |
| top / bottom | 目标窗格纵向拆分，新窗格在上 / 下 | 同左 |
| 不在任何窗格上 | 无操作 | 无操作 |

## 5. 落定链路（`main.js`）

四个入口，共用前处理与收尾：

- `detachTab(paneId, tabId)`：摘标签 → 有邻居则 `activate` + `loadDocIntoPane(邻居)`（**不走** `openDocInPane`，见决策 6），没有邻居则 `clearPane(paneId)` 显示空态。邻居要在 `remove` 之前取（现在 `closeTab` 里就是这个顺序）。
- `moveTabToPane(tabId, dstPaneId)`
  1. 画布标签 → `setStatus(t('pn.canvasSplit'))` 收工（画布是单实例）。
  2. 一次问清未保存改动：`askSavePanes(脏的窗格 id 列表)`，列表由「源窗格（被拖的是活动标签且脏）+ 目标窗格（脏）」过滤得到，取消则整体中止。目标窗格不论下面走哪条路都要换内容，问必须在换内容之前。
  3. 目标窗格已有该文档 → `activate` + `pin`（落定即固定）；没有 → `tabs.open(doc)`。两者都跟着 `loadDocIntoPane`。
  4. `detachTab(源窗格, tabId)`；`focusPaneUi(dstPaneId)`；`persistPanes()`。
- `splitTabToPane(tabId, dstPaneId, orientation, newFirst)`
  1. 同上的画布拦截。不再按「目标窗格是 `panes.canvasPane`」拦：那个 id 含义是画布挂载点归谁，启动时固定给首窗格，单窗格布局下边落拆分会被全部拦掉（2026-10-19 修）。拆出去的新窗格本来就装不到画布——画布标签在上面第一条就拦了，文件树的 `.canvas` 走 `openDocInPane` 不落边——画布视图留在原窗格，与标签条的「拆分」按钮同行为。
  2. 问清：只有源窗格（被拖的是活动标签且脏）——目标窗格内容不变，不用问。
  3. `newId = freshId(...)` → `ensurePaneEditor(newId)` → `panes.tree = panes.view.split(dstPaneId, orientation, newId, newFirst)`。
  4. `mountPaneChrome(newId)` + `ensurePaneFindBar` + `ensurePaneHlBar` + `updatePaneChrome()`（与 `splitFocusedPane` 同套路）。
  5. `detachTab(源窗格, tabId)`；`panes.focused = newId`；`syncFocusedEditor()`；新窗格 `tabs.open(doc)` + `loadDocIntoPane(newId, doc)`；`persistPanes()`。
- 文件树落定：目标窗格脏就先 `askSavePanes([dstPaneId])`（新窗格则不用问），然后目标窗格 `tabs.open({ root, rel })` + `loadDocIntoPane`；落边则先拆出空窗格（复用 `splitTabToPane` 里 3、4 步，没有标签要摘），再在新窗格里做同样两步。

非活动标签不可能脏（既有不变式），所以只有拖活动标签才需要问保存。

## 6. 被改的既有 API

- `tabs.js`：新增 `moveTo(id, index)`（标签条内排序）。序列化顺序就是落盘顺序，拖动排序照常进 `persistPanes`。
- `split-pane.js`：`split(paneId, orientation, newPaneId)` 现在只会把新窗格放在第二子位（右 / 下）。加 `newFirst` 参数：DOM 上把新叶子 `insertBefore` 到源叶子前（顺序变成 `[新, bar, 旧]`），树里 `children` 同步对调，比例取 `1 - ratio`（basis 是第一个子）。
- `main.js` 文件树：`li` 摘掉 `draggable = true`——它现在只触发没有 data 的原生拖（没用），且原生拖一起动 `pointermove` 就断了。改挂 pointerdown 起拖，payload 是 `{ kind: 'tree', path }`；`folder` 的 `summary` 不起拖。

## 7. 视觉与样式

- `.nl-drag-ghost`：跟随指针的幽灵标签（`position: fixed`，主题色边 + 半透明），`pointer-events: none`。
- `.nl-drop-hint`：落区高亮（`position: fixed`，主题色 12% 底 + 1px 边）。用 fixed 而不是塞进 `.nl-pane`：窗格是滚动容器，absolute 会跟着滚。
- `html.nl-dragging`：全局禁选 + 锁光标（复用 `.nl-resizing` 那套思路）。
- `.tab.dragging`：源标签半透明，留在原位（躲开 vs 留在原地的好处是，落点索引算出来就是它该去的位置）。
- 打印样式：ghost 与 hint 都不上纸（跟现有打印规则一起加）。
- 无新词条——拖拽没有文案。

## 8. 错误与边界

| 情况 | 处理 |
|---|---|
| 拖的是画布标签 | 拦下，`setStatus(t('pn.canvasSplit'))` |
| 目标窗格已有该文档 | 只激活（并把预览转正），不重开第二个 |
| 拖走窗格最后一个标签 | 源窗格 `clearPane` 变空态 |
| 落在侧栏 / 状态条 / 窗口外 | 无操作，标签复原 |
| 拖拽中按 Esc / pointercancel | 取消，标签复原 |
| `panes.view` 还没建起来（启动未完成时） | 不起拖 |
| 落点窗格就是源窗格且落区是边缘 | 允许：把自己拆成两半，文档进新的一半 |

## 9. 持久化

每次落定（移动 / 拆分 / 排序 / 文件树打开）后 `persistPanes()`：树、比例、各窗格标签列与活动项一次性写盘。预览与脏标记照旧不落盘。

## 10. 测试

- 新增 `src/tests/pane-drag.test.mjs`：`dropZoneFor` 九宫格（正中、四边、四角，含刚好落在 25% 线内外的两条）、`tabDropIndex`（前移 / 后移 / 跳过被拖项 / 空列表 / 越界夹取）。
- `src/tests/split-pane.test.mjs` 加 `newFirst`：树里 children 顺序、比例互补、`paneIds` 顺序。
- `src/tests/tabs.test.mjs` 加 `moveTo`：前后移、移到原位、越界夹取、序列化顺序跟着变。
- 门禁：全量 `node tests/*.test.mjs` + `npm run build` 两绿。纯前端，刷新即生效。
- 手验（记 CHANGELOG 实测段）：`tauri dev` 下 ① 标签拖到另一窗格，源少一个标签、目标焦点跟过去；② 拖到左 / 右 / 上 / 下四个边各拆一次，新窗格位置与手势一致；③ 标签条内左右拖动重排，松手落点与手指一致；④ 文件树拖文件到第二个窗格，落边直接拆出新窗格打开；⑤ 拖活动脏标签 → 一次问清「保存 / 不保存 / 取消」，取消回到原位；⑥ 拖预览标签，落定后斜体转正。

## 11. 落地分相

- **P1 引擎与模型**：`src/pane-drag.js` + `dropZoneFor` / `tabDropIndex` 纯函数测试；`tabs.js` 的 `moveTo` + 测试。
- **P2 引擎 API**：`split-pane.js` 的 `newFirst`（树操作 + DOM 手术）+ 测试。
- **P3 链路与样式**：`main.js` 三个落定函数 + 拖拽绑定（标签条 / 文件树）+ CSS + 打印样式。
- **P4 文档**：CLAUDE.MD「标签页设计 / 分栏设计」两节补拖拽条目、CHANGELOG、手验。

## 12. 明确不做

- 复制式拖放（Alt / Ctrl 拖）。
- 拖出成独立窗口、跨窗口拖。
- 文件树拖文件夹。
- 标签拖到侧栏 / 面板 / 状态条上（那里不是窗格）。
- 拖拽期间的边缘自动滚动（标签条横向滚动已有）。
