# 窗格标签组（完整 VS Code 分栏模式）—— 设计（Spec）

- 状态：设计已定，待写实现计划（writing-plans）
- 日期：2026-10-18
- 前置：P5 §6.1 分栏引擎已落地（`src/split-pane.js` + `main.js` 的 panes 表），本文把它从「一窗格一文档 + 全局一条标签栏」升级为「每窗格一条标签条、窗格内多文档、预览模式」
- 范围：标签模型、窗格标签条 UI、打开落定规则、持久化 schema 与迁移、快捷键语义。不含拖拽拆分 / 标签跨窗格拖放（见 §10）

## 1. 背景与现状

分栏引擎（`split-pane.js`）已支持无限嵌套的 SplitPane 树：叶子窗格各持一个编辑器实例、自己的根 / 文档 / 脏状态，树与比例存 settings.json 的 `panes` 段。但文档模型还是旧的：

- 标签页是全局一份（`tabs.js` 单例，挂在屏幕顶部 `#tabbar`），一个标签同时只在一个窗格显示（`paneTabs` / `tabPane` 双向表），点顶栏标签把文档「挪」到焦点窗格。
- 一个窗格只能装一篇文档，看第二篇就要把第一篇换掉。
- 打开链路（`openTabDoc`）每次打开都 `scanVault` + `startIndexPolling`，全库重扫 + 重建索引。

用户要的效果对标 VS Code 编辑器组：每个组一条自己的标签条、组内多文档、单击预览 / 双击固定、各组独立滚动与关闭。

## 2. 关键决策（已与用户敲定）

| # | 决策 | 取舍 |
|---|---|---|
| 1 | 完整 VS Code 模式：标签归窗格所有，每窗格一条标签条 | 全局标签栏取消，「一眼看所有文档」没有了，跨窗格找文档靠窗格本身 |
| 2 | 同一文档允许多窗格同开，标签 id 按（窗格 + 文档）唯一 | 两处存同一文件后保存的覆盖先保存的，不做合并（与 VS Code 一致） |
| 3 | 预览模式：拖入 / 单实例转发 = 预览（斜体临时标签，被同窗格下一个预览替换）；文件树单击 / wikilink / 搜索 / 命令面板 / 最近 / 模板 / 新建 = 固定（2026-10-19 改：文件树单击从预览入口挪到固定入口——单击就是想打开这一篇，不该被下一篇挤掉） | 浏览库时窗格干净；多一套预览状态；对老用户「单击的文档被替换」是行为变化 |
| 4 | 全局标签栏整条移除，拆分（横 / 竖）与关窗格按钮进各窗格标签条 | 编辑区右上角那组全局拆分按钮一并删除 |
| 5 | 拆分时新窗格复制焦点窗格的当前文档（固定标签） | 对照长文档零成本；同文档两开是决策 2 的预期用法 |
| 6 | 一个编辑器实例的硬限制不变：窗格内切标签先处理当前文档的未保存改动，切走的标签内容不驻留 | VS Code 的后台脏标签要实例池，项目已否决（见 CLAUDE.MD 标签页设计），本期不做 |

## 3. 数据模型

### 3.1 tabs.js：从全局单例到每窗格一个实例

- `createTabs({ mountEl, onSwitch, onClose, onPin })` 的契约不变（mountEl 换成窗格标签条元素），每个叶子窗格各建一个实例，由 `main.js` 的 `panes.strips: Map(paneId → 控制器)` 持有。
- items 增加 `preview: boolean`。标签 id 从 `idOf(root, rel)` 改为 `idOf(paneId, root, rel)`——同一 root+rel 在不同窗格是两个标签。
- 新增 API：
  - `openPreview(tab)`：同窗格已有预览标签且不是同一个文档 → 先 `remove` 旧预览（返回被换掉的 id，调用方已做过脏检查），再以 `preview: true` 入列并激活；没有预览标签则直接以预览入列。
  - `pin(id)`：清掉该标签的 `preview` 标记（双击固定）。
  - `previewId()`：当前窗格预览标签的 id（没有则 null）。
- 保留 `open / activate / update / remove / clear / neighborOf / setDirty / isDirty / render`；`open(tab)` 语义收紧为「固定标签打开或激活」（命令面板、wikilink 等固定入口走它）。
- `update(id, patch)` 后 id 会变（另存为改 root/rel），`paneId` 部分不变，拼接逻辑照旧。

### 3.2 main.js：panes 表调整

- 删 `paneTabs` / `tabPane` 两张绑定表与 `bindTabToPane / unbindTab / rekeyTab / clearTabBindings`——归属变成结构性的，窗格的 strips 实例自己管。
- `panes` 表保留 `tree / focused / editors / findBars / hlBars / contents / mounts / ctx / view / canvasPane`，新增 `strips`。
- `markPaneDirty(paneId, d)` 改为同时写「该窗格活动标签」的脏点（`strips.get(paneId).setDirty(activeId, d)`）；焦点窗格额外驱动全局 `state.dirty` 与文件名圆点（现逻辑）。
- `switchToTab(id)` / `closeTab(id)` 退化为焦点窗格内的操作（tab id 自带 paneId，非焦点窗格的标签不接受跨窗格点击——没有全局栏可点）。

### 3.3 持久化（settings.json `panes` 段）

```jsonc
"panes": {
  "tree": { "type": "split", "id": "s3", "orientation": "horizontal", "ratio": 0.5,
            "children": [ { "type": "leaf", "id": "p1" }, { "type": "leaf", "id": "p2" } ] },
  "focused": "p2",
  "tabs": {
    "p1": { "items": [ { "root": "C:/vault", "rel": "a.md", "canvas": false, "scratch": false } ], "active": 0 },
    "p2": { "items": [], "active": -1 }
  }
}
```

- `preview` 不落盘（临时的，重启只恢复固定标签）；`dirty` 不落盘（退出时由关闭守卫问）。
- `tabs` 里出现树中不存在的 paneId → 丢弃；树里的叶子没有 tabs 条目 → 空标签列。
- 旧格式（`panes` 直接是裸树）迁移：树保留；首个叶子按 `workspace.lastFile`（配 `lastVault`）建一个固定标签，其余叶子空。迁移结果当场写回一次。
- `normalizeTree(raw, fallbackPaneId)` 改为认两种形状：新形状校验 `tree` + `tabs`；旧形状走迁移。任一校验不过 → 单窗格空标签，启动不因此失败。
- `workspace` 段保留：继续记焦点窗格活动文档的 `lastVault` / `lastFile`，作旧版兼容与 `panes` 为空时的启动回落。

## 4. UI 结构

- `index.html` 删除 `#tabbar` / `#tabs` / `#tabs-split` 整块；`.body` 直接是侧栏 / gutter / 编辑区。
- 每个窗格顶部一条 `.nl-pane-strip`（`mountPaneChrome` 建，append 到 `.nl-pane` 叶子）：
  - 结构：`[标签…（横向滚动，溢出同现行 tabbar 规则）][split-h][split-v][close]`，高约 30px，底色 `--bg-panel`，底部 1px 边框。
  - `position: sticky; top: 0; z-index: 6`：钉在窗格滚动内容顶部，不把 `.nl-pane` 从「滚动容器」改成「flex 列 + 内层滚动」——`editor-view.js` 的 `closest('.nl-pane')` 滚动计算、查找栏的 `scrollTop + 12` 定位都建立在「`.nl-pane` 即滚动容器」上，不改这块。
  - 拆分两钮常显；`close` 仅多窗格时显示（现行 `updatePaneChrome` 规则）。删除浮动的 `.nl-pane-close`。
  - 预览标签：`.tab.preview .tab-name { font-style: italic; opacity: .75 }`；固定标签普通。tooltip 预览 / 固定同一套（`joinTitle` 不变）。
- 查找栏避让：`find-in-doc.js` 的 `pin()` 从 `paneEl.scrollTop + 12` 改为 `+ strip 高度`（常量 34px，与 `.nl-pane-strip` 实际高度对齐），不与条子重叠。
- 空态 `.nl-pane-empty` 只在最后一个窗格出现：多窗格下窗格空了整格自动关掉（2026-10-19 改，原设计是 pane 保留空态）。
- 打印样式：现行「只打焦点窗格」规则补上 `.nl-pane-strip`（不上纸）。

## 5. 交互链路

### 5.1 打开落定

| 入口 | 行为 |
|---|---|
| 拖入打开、单实例二次唤起 | 预览（替换同窗格旧预览） |
| 文件树单击、wikilink、搜索、命令面板、最近打开、模板、新建、docx 导入落库 | 固定 |
| 同一窗格已有该文档的标签（预览或固定） | 激活它，不开新标签；预览的保持预览，固定保持固定 |

统一入口 `openDocInPane(paneId, { root, rel, canvas, scratch }, { preview })`：

1. 该窗格已有同 (root, rel) 标签 → `activate` + 走既有 `openFile` 换内容（脏检查照旧），结束。
2. `preview` 且该窗格有旧预览标签 → 先 `ensurePaneSaved(paneId)`（旧预览可能脏），用户取消则整体中止；通过后 `remove` 旧预览。
3. 非预览或没有旧预览 → `ensurePaneSaved(paneId)` 后继续。
4. `openFile(rel, true, paneId)` 装内容；标签入列（`preview` 或固定）并激活；根没变只 `highlightActiveFile` + 面板刷新，根变了才 `scanVault` + `startIndexPolling` + `pluginManager.reload`（性能点，见 5.4）。

### 5.2 预览替换规则

- 每窗格最多一个预览标签；新预览替换旧预览，固定标签永不被替换。
- 双击预览标签 = `pin`（斜体转正）；双击固定标签无动作。
- 预览标签被替换时若带未保存改动：脏检查弹「保存 / 不保存 / 取消」，取消则本次打开中止（不丢改动）。
- 预览标签关闭（× / Ctrl+W）与固定标签同路。

### 5.3 窗格内切标签 / 关闭 / 快捷键

- 点标签或 Ctrl+Tab / Ctrl+Shift+Tab（窗格内循环，mac 菜单 nextTab/prevTab 同步改语义）：`ensurePaneSaved(paneId)` → `openFile` 装新活动标签的内容。
- Ctrl+W（`app.closeFile`）：关焦点窗格的活动标签；该标签脏则先问。关到最后一个 → 多窗格时整格自动关掉，只剩一个窗格时空态保留（`showPaneEmpty`）。
- 关窗格按钮：整窗格关掉，只问它活动标签的脏（其余标签此刻不可能脏，见决策 6）。`closePaneUi` 连带清理 strips 实例。
- 拆分（`app.splitH` / `app.splitV`，strip 上的按钮与命令面板 / mac 窗口菜单同入口）：新窗格复制焦点窗格当前文档为固定标签；焦点移到新窗格；`persistPanes()` 落盘。

### 5.4 根变化门控（性能）

现行 `openTabDoc` 无条件 `scanVault` + `startIndexPolling` + `pluginManager.reload` + `gitPanel.refresh` + `snapshotPanel.refresh`。改为：`normVaultPath(newRoot) !== normVaultPath(oldRoot)` 才做这套；根没变只 `highlightActiveFile()` + `refreshLinkPanels()`（焦点窗格活动文档的反链跟着走）。判定提成纯函数 `rootChanged(a, b)` 单独测。预览浏览点几十个文件不再全库重扫。

## 6. 与既有机制衔接

- 画布：canvas 标签只能存在于 `panes.canvasPane`，其余窗格开画布仍提示 `pn.canvasSplit`；canvas 标签在 strip 里正常显示与关闭。
- 自动保存 / 脏点：`scheduleAutosave` 已遍历所有脏窗格，不变；脏点改由 strips 按标签记（§3.2）。
- 面板（frontmatter / 大纲 / 标签 / 反链 / git / 快照 / 查找栏 / 高亮工具栏 / 写作统计）：继续跟焦点窗格的**活动标签**走，`syncFocusedEditor` 的镜像逻辑不变，只是「当前文档」从「窗格唯一文档」变成「窗格活动标签」。
- 启动恢复：`panes` 段恢复树 + 各窗格标签列；每个窗格只读活动标签的内容（`openFile` 的静默路径，不写 workspace、不记最近），其余标签点击时再读；`panes` 为空 / 损坏 → 走 `workspace.lastVault` / `lastFile` 老路。
- 临时文件（scratch）：预览替换对临时页同样生效（换掉的预览若 dirty 先问）；Ctrl+S 对焦点窗格的临时活动标签仍是另存为。

## 7. 错误与边界

| 情况 | 处理 |
|---|---|
| 恢复的 tabs 引用树中不存在的 paneId | 丢弃该条目 |
| active 越界 / -1 | 夹到 `[0, items.length-1]`，空列记 -1 |
| 旧格式裸树 | 迁移（§3.3），首个叶子带 lastFile |
| 同文档两窗格各存一次 | 后保存覆盖先保存，不合并、不弹冲突（与 VS Code 一致）；保存时的外部冲突检测走既有 `writeMdFile` 链路 |
| 预览替换时旧预览 dirty 且用户取消 | 本次打开中止，界面不动 |
| 拆分时焦点窗格是空态 | 新窗格空置（没有「当前文档」可复制） |
| 关到只剩一个窗格 | 与现行一致：关窗格按钮隐藏，标签条保留 |
| 窗格空了（关光 / 拖走标签 / 删当前文档） | 多窗格时整格自动关掉（2026-10-19 起）；末窗格空态 |

## 8. 测试

- `src/tests/tabs.test.mjs` 扩：id 含 paneId、同窗格同路径去活不重开、跨窗格同路径各开一份、`openPreview` 替换旧预览（返回被换 id）、`pin` 清预览标记、每窗格最多一个预览、`update` 后 id 与脏标记跟着搬。
- `src/tests/split-pane-dom.test.mjs` 扩：strip 挂进叶子（含按钮）、拆分后新窗格 strip 就位、关窗格后 strips 清理、单窗格时 close 按钮隐藏。
- `rootChanged(a, b)` 纯函数用例（同路径不同分隔符 / 大小写 / 空值）。
- 门禁：全量 `node tests/*.test.mjs` + `npm run build` 两绿。纯前端，刷新即生效。
- 手验（记 CHANGELOG 实测段）：`tauri dev` 下 ① 树单击=固定标签、拖入=预览斜体再点另一个替换、双击预览标签固定；② 拆分复制当前文档、左右各改各的；③ Ctrl+W / Ctrl+Tab 窗格内语义；④ 重启恢复多窗格多标签、预览不恢复；⑤ 旧 settings.json（裸树 panes）迁移。

## 9. 落地分相

- **P1 模型层**：`tabs.js`（每实例 preview/pin/openPreview、id 带 paneId）+ `tabs.test.mjs` 扩。
- **P2 UI 层**：`index.html` 删全局栏；`.nl-pane-strip` 的 DOM / CSS / 按钮（split-pane 手术与 strips 生命周期接入 `main.js` 的 `mountPaneChrome` / `splitFocusedPane` / `closePaneUi`）；查找栏避让；打印样式。
- **P3 链路层**：`openDocInPane` 统一入口（含根变化门控）、文件树双击、`switchToTab` / `closeTab` / 快捷键改窗格内语义、拆分复制文档。
- **P4 持久化与文档**：`normalizeTree` 新形状 + 旧格式迁移、`persistPanes` 写 tabs、启动恢复；CLAUDE.MD「分栏设计 / 标签页设计」两节改写；CHANGELOG。

## 10. 明确不做

- 拖拽标签到别的窗格、拖到屏幕边缘自动拆分（用户选定不含拖拽的方案；strip 按钮 + 快捷键覆盖同场景）。
- 后台驻留多个脏文档（需编辑器实例池，项目既有否决结论）。
- 全局总览栏 / 「所有打开文档」列表。
- 预览模式的键盘固定方式之外的更多花式交互（如拖拽排序标签）。

## 11. 待实现期确认的小项

- strip 高度常量与查找栏偏移的最终值以实测为准（本文给 30px / 34px）。
- `panes.strips` 的清理时机：关窗格 / 换根清标签时都要删实例，避免泄漏（关窗格已有显式 destroy 编辑器实例的先例，照做）。
- mac 菜单「窗口」组的 nextTab/prevTab 标题是否从「切换下一个 / 上一个标签页」改为「当前窗格的下一个 / 上一个标签页」——改，词条同步五种语言。
