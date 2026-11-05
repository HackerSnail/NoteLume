# Win / Linux 工具条分类成菜单条

目标：Windows 与 Linux 上那排图标（打开文件 / 打开知识库 / 新建 / 保存 / 今日 / 源码 / 段落 / 更多）现在是一坨平铺，看不出层级，低频操作和高频操作混在同一行。改成文本菜单条，一级是分类，操作进下一级，分类口径与 macOS 原生菜单栏完全一致。渲染仍在前端（WebView2 / WebKitGTK 里的 `.cv-menu`），macOS 那条原生菜单不碰。

## 落点

| 位置 | 内容 |
| --- | --- |
| `src/app-menu.js:144` | 分组唯一来源：app / file / edit / format / paragraph / view / git / window 八组，条目只写命令 id 与 `role(...)` |
| `src/menu-bar.js:17` | `createMenuBar(opts)`：一级渲染 + 递归下一级 + 开合栈 + 键盘导航；`DROP_ROLES` / `ROLE_COMMAND`（`src/menu-bar.js:11-13`）是 role 的平台落地表 |
| `src/index.html:91` | `<nav class="nl-menubar" id="nl-menubar">` 挂载点，占原 `.btn-group` 八个图标的位置 |
| `src/main.js:4282` | `initMenuBar()`：非 mac 挂载，`buildSpec` 取 `buildMacMenuSpec(menuSpecCtx())`，行工厂 `menuBarRow`（`src/main.js:4271`），动作交给 `onMenuSelect` |
| `src/main.js:4251` | `menuBarRoleHandler`：窗口四项走 `runWindowRole`（`src/main.js:4243`），剪贴板四项按焦点目标走 `menuEditOps`（`src/main.js:4228`） |
| `src/main.js:2103` 与 `:2248` | `pmClipboardOps` / `boxClipboardOps`：窗格右键菜单与菜单条共用，剪贴板读写只剩这一份 |
| `src/main.js:1825` `:1856` `:1877` | `placeMenu` / `makeMenuItem` / `menuSep`：行渲染与弹层容器沿用既有那套 |
| `src/main.js:4113` `:4128` `:4153` `:4170` | `MENU_CHECKED` / `menuEnabled` / `menuSpecCtx` / `onMenuSelect`：勾选态、置灰、动态列表与分派口径不变 |
| `src/style.css:370-388` `:2471` | 菜单条 `nowrap` + 横向滚动、一级项不收缩、展开态高亮；`.cv-menu-arrow` 箭头 |
| `src/style.css:2400` `:2467` | `.cv-menu` 弹层容器原样复用；子层 `.cv-menu.nl-menu-sub` 用 `position: fixed` + `z-index: 41` 挂 body |
| `src/style.css:566` | `[data-mac]` 隐藏菜单条，mac 的入口只在屏幕顶部原生菜单 |
| `src/titlebar.js:21` | 平台标记 `data-tauri-platform` / `data-mac` 的来源，菜单条按该标记分平台挂载 |
| `src-tauri/capabilities/default.json` | 补 `core:window:allow-is-fullscreen` / `core:window:allow-set-fullscreen`，`Fullscreen` 项才有权限落地 |

## 改动前

`openMoreMenu` / `openParagraphMenu` / `openCmdSubmenu` / `openTemplateMenu` / `openRecentMenu` / `openLangMenu` 与 `.btn-group` 那八个平铺图标按钮已全部删除，同一功能不再有第二个入口。内置 Quarkdown 模板原先只挂在窗口内那版模板菜单里，现由 `menuSpecCtx().templates`（`src/main.js:4153`）进 spec 的「模板」子菜单，mac 原生菜单同样选得到。

`src/tests/app-menu.test.mjs:373` 断言注册表里每条命令都必须在某个组出现（`app.about` 除外，mac 上由 `role('About')` 承担）。菜单条渲染同一份 spec，这条约束在 win/linux 同样成立，功能不会出现没有入口的。

## 分层

```
buildMacMenuSpec(app-menu.js)          分组与条目顺序，三端唯一来源
        │
        ├── mac：pushMacMenu → set_mac_menu（原生 NSMenu，保持现状）
        │
        └── win / linux：menu-bar.js（新增）
                 ├── 一级：group.id → 顶层文字项
                 └── 下一级：group.items 递归渲染 .cv-menu
                          ├── type 'cmd' / 'check' / 'sep' → makeMenuItem
                          ├── type 'submenu' / 'sub' → 悬停出右侧子菜单
                          └── type 'role' → 平台落地表（见「role 项的落地」）
```

一级项点击后的执行统一走 `onMenuSelect(id)`，与 mac 原生菜单、命令面板同一条链路，不在菜单里写第二份动作。文案、快捷键后缀、勾选态、置灰继续取 `menuCommands()` 与 `MENU_CHECKED` / `menuEnabled`，与 `openMoreMenu` 现在的口径相同。

## 组件与令牌

| 令牌 | 取值 | 来源 |
| --- | --- | --- |
| 菜单条字号 | `13px` | 与 `.toolbar` 同 |
| 一级项高度 | 定高 `26px`，内边距 `4px 8px` | 与 `.win-btns button`（`34×28`）同一行不撑高；定高是因为纯拉丁文（Git）的行盒比中文矮 3px，`align-items: center` 下会一块高一块低 |
| 一级项底色 | 透明，悬停 `var(--hover)`，展开态 `var(--hover)` + `var(--accent)` 文字 | 复用工具条幽灵按钮口径 |
| 下一级容器 | 复用 `.cv-menu` / `.tree-menu`（`--bg-panel`、`--border`、`8px` 圆角、`z-index: 40`） | 不自建第二套弹层 |
| 子菜单箭头 | `▸`，靠右 `var(--muted)` | 新 `.cv-menu-arrow` |
| 溢出 | 菜单条 `white-space: nowrap` + 横向滚动，不折行 | 与既有窄屏顶栏规则一致 |

新增结构（`src/index.html`，插在 `.appbar-lead` 与原 `.btn-group` 的位置）：

```html
<nav class="nl-menubar" id="nl-menubar" aria-label="菜单"></nav>
```

`nav` 里由 `menu-bar.js` 按 spec 生成 `<button class="nl-menubar-item">`，不在 HTML 里写死菜单名，语言切换与分组变更都只有一条路径。

## 一级菜单

按 `buildMacMenuSpec` 的组顺序出，组名直接用现有词条：

| 一级 | spec group | 词条 |
| --- | --- | --- |
| 文件 | `file` | `menu.group.file` |
| 编辑 | `edit` | `menu.group.edit` |
| 格式 | `format` | `menu.group.format` |
| 段落 | `paragraph` | `menu.group.paragraph` |
| 视图 | `view` | `menu.group.view` |
| Git | `git` | `menu.group.git` |
| 窗口 | `window` | `menu.group.window` |
| 帮助 | `app` | 新增 `menu.group.help` |

`app` 组在 mac 顶格是应用名（关于 / 服务 / 隐藏 / 退出），win/linux 没有这个约定，改名「帮助」放在最右，其余条目（快捷键、外观、剪藏设置、Quarkdown 两项、语言子菜单、退出）原样保留。

## role 项的落地

`role(...)` 是 mac 系统预定义项。win/linux 的自绘菜单里每一项都要给出真实动作或整项不出，按平台表处理：

| role | win / linux |
| --- | --- |
| `Cut` `Copy` `Paste` `SelectAll` | 接现有右键菜单那套实现（按焦点目标分派：所见即所得窗格、CodeMirror 源码、`input` / `textarea`），与窗格右键菜单共用抽出来的 `pmClipboardOps`（`src/main.js:2103`）和 `boxClipboardOps`（`src/main.js:2248`），不留两份读写剪贴板的代码 |
| `Minimize` `Maximize` | `getCurrentWindow().minimize()` / `.toggleMaximize()`，与 `titlebar.js:31-36` 同一 API |
| `Fullscreen` | `setFullscreen()` 取反 `isFullscreen()`，标题栏三键之外多一个入口 |
| `CloseWindow` | `appWindow.close()`，走既有未保存询问链路 |
| `Quit` | `appWindow.close()`（不 `destroy`，退出仍要问未保存） |
| `About` | 换成注册表命令 `app.about`（注册在 `src/main.js:3965`，菜单条侧的映射表在 `src/menu-bar.js:13`）；这项不看当前焦点，不能被剪贴板那套置灰判据带下去（`src/main.js:4219`） |
| `Services` `Hide` `HideOthers` `ShowAll` | 不出现在 win/linux，渲染侧丢弃（分组数据仍一份，不在 spec 里写平台分支） |

置灰与勾选态同样适用：`Cut` / `Copy` 无选区时置灰，与右键菜单当前行为一致。

## 交互

- 单击一级项开下一级；已展开时再点同一项收起。
- 展开期间悬停其他一级项即切换下一级（原生菜单行为）；收起后再悬停只出高亮，不自动展开。
- 下一级里的子菜单条目：鼠标进入即在右侧出子菜单，离开后延时 320ms（`SUB_CLOSE_DELAY`，`src/menu-bar.js:15`）再关，指针仍在父项或子层里则不关；点击父项本身也开合。
- `Esc` 关当前层，再 `Esc` 关整条并把焦点还给一级项；`←` `→` 在一级项之间移动（当前项有子层时 `→` 先进子层）；`↑` `↓` 在当前层内移动并跳过置灰项，回车执行。键盘那套集中在 `src/menu-bar.js:95-170`。
- 收起状态悬停一级项不自动弹，只有已展开时划过才切换，避免鼠标扫过工具条就冒菜单。
- 点击外部、滚轮、窗口尺寸变化关闭：菜单条在 `open()` 内挂这四个监听、`closeAll()` 摘除（`src/menu-bar.js:57-80`），滚轮落在菜单或子层内算滚动不算关闭。

`placeMenu` 是单例（开新的先关旧的），菜单条需要父子两层同时存在，故另建一个开合栈（顶层 + 子层集合，`src/menu-bar.js:20-23`）；子层是 body 级固定元素并在 `src/menu-bar.js:186` 按父项右边界定位、放不下时翻到左侧，关闭时逐级摘除。行渲染继续用 `makeMenuItem`（`src/main.js:1856`），点击回调里先收栈再执行。

## 三端行为矩阵

| | macOS | Windows | Linux |
| --- | --- | --- | --- |
| 一级菜单 | 屏幕顶部原生（`set_mac_menu`） | 窗口内菜单条 | 窗口内菜单条 |
| 图标工具条 | 不挂菜单条，入口在屏幕顶部原生菜单 | 已删除，只从菜单条进 | 已删除，只从菜单条进 |
| 渲染层 | AppKit NSMenu | WebView2 自绘 `.cv-menu` | WebKitGTK 自绘 `.cv-menu` |
| `role` 项 | 原生 selector | 平台落地表 | 平台落地表 |

`data-mac` 那条链路不动：mac 上菜单条不挂载，`setupMacMenu` 失败时的回退（把工具条放回来）也保持原样，避免 mac 上出现「菜单条 + 顶部菜单」两份入口。

## 采用

1. 一级八个分类（文件 / 编辑 / 格式 / 段落 / 视图 / Git / 窗口 / 帮助），与 mac 分组逐条对应，不引入合并表。
2. `.btn-group` 整排图标删除：打开文件、打开知识库、新建、保存、今日、源码、段落、更多全部只从菜单进；右侧 `#btn-find` `#btn-replace` `#chk-autosave` `#btn-theme` 与 `#docstats` `#filename` 保留。
3. `Cut` / `Copy` / `Paste` / `SelectAll` 按当前焦点目标分派：`.ProseMirror` 用 `pmClipboardOps`，`input` / `textarea` / CodeMirror 用 `boxClipboardOps`，都没有则落回焦点窗格的编辑器；无处可落时整项置灰（`src/main.js:4228`）。
4. 快捷键、外观、剪藏设置、语言、关于、退出合成一格「帮助」，不拆「设置」。

## 落地顺序（已落地）

1. `src/menu-bar.js`：一级渲染 + 递归下一级 + 开合栈 + 键盘导航，纯前端可 Node/jsdom 测。
2. `src/index.html` 加 `nav`，`src/main.js` 按平台标记挂载并接 `menuSpecCtx` / `onMenuSelect`。
3. 剪贴板四项从窗格右键菜单抽成 `pmClipboardOps` / `boxClipboardOps`，两处共用。
4. `src/style.css` 出菜单条样式与 `.cv-menu-sub` / `.cv-menu-arrow`，删掉 `.btn-group` 全部规则。
5. 五个语言包补 `menu.group.help`（其余分组词条已存在）。
6. 删除 `openMoreMenu` / `openParagraphMenu` / `openCmdSubmenu` / `openTemplateMenu` / `openRecentMenu` / `openLangMenu` 与八个平铺图标按钮；托盘「新建笔记」改调 `newScratchFile()`，不再依赖按钮存在。
7. 测试：`src/tests/menu-bar.test.mjs`（jsdom）断言一级项来自 spec 分组、role 落地表分派、开合栈与键盘导航、窄屏不折行，末了用真 `buildMacMenuSpec` 递归展开核对「spec 每个叶子都渲染得出来」；`src/tests/app-menu.test.mjs:373` 的全量覆盖断言同时守住 mac 与 win/linux。
8. `src-tauri/capabilities/default.json` 补全屏两条权限。

## 风险

- Linux 下 WebKitGTK 的系统剪贴板读写权限与 WebView2 不同口径，`readClipboardText()` 那条链路（`main.js:27` 起自 `tauri-bridge.js`）在 Linux 打包版需要实机确认；本机没有 Linux 环境，这一项只能标未实测。
- 一级八项在德语 / 法语下文案更长（`Datei / Bearbeiten / Format / Absatz / Ansicht / Git / Fenster / Hilfe` 尚可，`Fichier / Édition / Format / Paragraphe / Affichage` 更宽），窄窗口靠横向滚动兜底，不缩字号。
- 图标排删除后拖拽区是 `.appbar-lead` 与 `.spacer`（`src/index.html:89` `:96`），菜单条里的一级项是可点控件，不吃拖拽；mac 上这两块由 `[data-mac]` 一并隐藏，口径不变。
