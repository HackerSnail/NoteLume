# 批次 B 手感包增补 Ⅱ：Mermaid 单击出码 + 侧栏文件/大纲共用区与栏外图标 + 大纲层级折叠 + macOS 原生菜单栏 + 左右栏拖拽调宽 + 图片把手缩放 — 设计规格

- 状态：✅ 已实现（前端 + Rust 命令 + capabilities；mac 原生菜单已在真机 `tauri dev` 与打包 `.app` 内用 System Events 读取真实菜单栏核对）
- 日期：2026-10-15
- 关联：批次 B（斜杠菜单/写作统计/专注·打字机）、批次 D（统一命令注册表 `src/commands.js` + `src/keymap.js`）、批次 B 增补 Ⅰ（标题折叠 + 侧栏收起，见 CHANGELOG `[Unreleased]`）
- 追加同源两项（§4.6 / §4.7）：**左右栏按住分隔条调宽 + 拖到阈值整栏收起**、**正文图片按住把手缩放并把尺寸写回 `.md`**，同为「向 Typora 看齐」，纯前端、无 Rust
- 已拍板的六个开放项：① Mermaid 交互 = **Typora 同款：单击图就地出码**；② 适用范围 = **仅 Mermaid 图**（数学块、代码块维持现状）；③ 侧栏 = **顶部「文件 / 大纲」两 tab 共用一块区域**（其余面板保持堆叠）；④ macOS = **原生菜单栏 + 隐藏窗口内工具条**（工具条的信息项下沉为底部状态条），Windows/Linux 一行不动；⑤ 大纲 = **大标题常显、其下子级带三角整节可收**（与正文折叠分属两层，两者都保留）；⑥ 栏外常驻图标对（文件 / 大纲）= **两端都放**，mac「窗口」组的系统注入项 = **转中文**（走 bundle 本地化，不牺牲标准窗口菜单）

## 1. 背景与动机

七件事同源于「向 Typora 看齐」：

1. **渲染图不该和源码同时占屏**。改前是 ` ```mermaid ` 围栏渲染成「上方源码 + 下方图」两段（`src/mermaid-preview.js` 在 code_block **之后**挂 `Decoration.widget`），一篇图多的文档滚动长度翻倍、且源码里的 `<br>` 之类噪声常驻。Typora 的做法是**只见图，点图就地变源码，点外面变回图**。
2. **侧栏「文件」与「大纲」是同一件事的两种视角**（都在回答「文档在哪 / 文档里有什么」），改前把它们堆成两个 `<section class="panel">`（`src/index.html`），互相挤占纵向空间。Typora 用顶部两个 tab 共用一块区域。
3. **mac 的入口位置约定与 Windows 不同**。mac 用户期待「文件/编辑/格式/段落/视图/窗口」在**系统顶部菜单栏**（截图中 Typora 即如此），而 NoteLume 改前全部塞在窗口内一条工具条里（`src/index.html`，六个按钮 + ▾更多）。mac 上这条工具条既占高度又与系统菜单重复；Windows 没有系统菜单约定，工具条是**唯一入口**，必须原样保留。真机截图进一步暴露：装上去的是 Tauri 默认的英文 `File/Edit/View/Window/Help`，即「菜单没换成功」而非「换错了文案」。
4. **大纲该有层级**。改前 `onMetaChange` 把标题平铺成一列 `<a class="outline-item level-N">`，只靠缩进和字重区分级别，长文档一眼扫不到「大标题在哪」。要求是「大标题常显、二级标题可以伸缩」——收起的是**大纲里的子标题行**，与增补 Ⅰ 的正文标题折叠分属两层，两者都保留。
5. **侧栏入口在收起后消失**。栏内 tab 随整栏一起被藏，`⌘⇧S` 是唯一入口且不可见。Typora 在窗口右上角常驻两个图标（文件列表 / 大纲），侧栏收起时仍可点——入口要在对象之外。
6. **两栏宽度写死**。侧栏与右检查器各 `width:280px` 硬编码在 CSS 里，宽屏想放宽、窄屏想收窄都做不到；收起只能整栏 toggle，没有 Typora 那种「拖过去就收起来」的直接手感。要求是「左右都可以通过鼠标改变宽度」「可以通过鼠标到一定宽度缩起来，比如 Typora 那样」。
7. **正文图片不能改尺寸**。粘贴/拖入的大图按自然宽铺满容器，`![alt](src)` 里没有任何尺寸信息，想缩小只能去外部改图。要求是「文章里面的图片也可以改变大小」，且改完要留在文档里（与「表格拖列宽仅当前视口生效」那条已知边界相反，这次要的是无损往返）。

## 2. 关键决策

| # | 决策 | 选择 | 理由 |
|---|---|---|---|
| 1 | Mermaid 出码的实现层 | **纯 Decoration（与标题折叠同一套机制）**：默认给 code_block 挂 `nl-mm-source`（`display:none`）只留图；出码态换成 `nl-mm-editing`（描边、源码自然可见可编辑）并摘掉该块的图 widget | 模型/md 字节不变（`roundtrip` 零风险）；不复用 NodeView 以免破坏 `pre > code` 的 `parseDOM` 往返 |
| 2 | 出码态的**唯一判据** | **光标是否落在该 mermaid 块内**（`editingPosIn(doc, selection)`），不额外存「编辑中」标记 | 一个判据同时覆盖三种进入（点图 / 斜杠菜单刚建好块 / `⌘Z` 撤销回块内）与三种退出（点别处 / `Esc` / `Shift-Enter` 出块）；若改由 meta 事务记 `editing`，「刚建好块时光标在 `display:none` 的源码里」会让输入无处可落 |
| 3 | 点图的接线 | **widget 元素自身的 `click` 监听**（`Decoration.widget` 的 `(view, getPos) => DOM` 形态），不用 `props.handleDOMEvents.click` | PM 对 `stopEvent` 的 widget 会先忽略事件，`handleDOMEvents` 收不到点击（实测 `.nl-mm-editing` 恒为 0）；`getPos()` + `nodeBefore` 反查块起点，位置不随文档变化失效（建 widget 时写死的 `data-pos` 快照会失效） |
| 4 | 编辑态并发 | **同时只允许一个块处于出码态**（判据是单个光标位置，天然互斥） | 多块同时展开会让长文档失控；Typora 亦然 |
| 5 | 适用范围 | 仅 `lang === 'mermaid'` 的 code_block | 数学块是原子节点（无「源码常显」问题，保持双击弹框）；普通代码块没有渲染产物，折叠后只剩空占位 |
| 6 | 侧栏共用区 | **两 tab 互斥 + 同一内容区**，`#filetree` / `#outline` **节点与 id 全不动**，只把两个 `<h2>` 换成 tab 条 | 渲染代码（`renderTree` / `onMetaChange` 建 `.outline-item`）零改动，改动面收敛在 HTML 结构与一处显隐 |
| 7 | 大纲为空时 | 「大纲」tab **置灰不可点**（不渲染空态文案），且若当前正停在大纲 tab 而它变灰 → 自动回「文件」 | 遵循「为空整块不渲染、不写 —/暂无」的既有约定 |
| 8 | mac 菜单的数据源 | **读既有命令注册表**（`commands.js` 的 `app.*` / `editor.*`）+「覆盖 ∪ 默认」绑定经 `toAccelerator` 生成 accelerator，**不新建第二份菜单定义** | 一处定义、三处消费（命令面板 / 快捷键设置 / 原生菜单）；快捷键重绑后菜单随之更新 |
| 9 | 「段落」组的来源 | 新 `src/block-commands.js` 把斜杠菜单 13 项映射为 PM 命令，注册成 `editor.block.<id>`（标题带「段落：」前缀，菜单里剥掉），**与 `SLASH_ITEMS` 共用同一份标签**；菜单条目顺序 = 注册表顺序 | 斜杠菜单与原生菜单不可能漂移；命令同时可被命令面板搜索到。公式块不在「段落」（它是 `editor.mathBlock`，归「格式」），故不重复挂 |
| 10 | mac 菜单的实现侧 | **前端算 spec、Rust 落原生对象**：新命令 `set_mac_menu(spec)`（`src-tauri/src/lib.rs`）把 `buildMacMenuSpec` 的结果落成 `Submenu/MenuItem/CheckMenuItem/PredefinedMenuItem` 并 `set_as_app_menu()`；点击经 `.on_menu_event` → `emit("nl:menu-select", id)` 回前端走注册表 | 一次 IPC 换整棵菜单（前端逐条 `plugin:menu\|new` 要 ~120 次往返）；`AppHandle::set_menu` 在 mac 上走 `run_on_main_thread` **吞掉原生错误**，JS 侧失败无从发现，改命令式后失败以 `Err` 回前端并 `setStatus` 回显；且 `@tauri-apps/api/menu` 的动态 `import()` 不在 vite 初始预打包清单里，命中即触发 `optimized dependencies changed. reloading` 整页刷新把刚装好的菜单冲掉——真机上「菜单从未生效」的根因 |
| 11 | 菜单重建时机 | 状态变化时**整体重建**（keymap 保存 / 主题切换 / 侧栏·专注·打字机·自动保存·源码模式 / 打开文档与最近列表变化），不持有逐项 live 引用；`setStatus` 为公共出口，150ms 去抖 + spec JSON 签名未变即跳过 | 菜单体量小、重建是毫秒级；避免「逐项 setChecked 漏一处」的状态漂移类 bug；`setStatus` 触发频繁，签名比对防逐字符重绘 |
| 12 | 菜单 accelerator 与窗口内分发器 | 两条入口共用 `runViaShortcut(id)`，**同 id 200ms 内只执行一次**；注册表查不到的 id（`builtin:*`）直接早退交回原生处理 | mac 通常由菜单吃掉按键、不进 webview，但装配结果不保证一致；不采用「装好菜单就关掉分发器」——那会让菜单装配失败时快捷键整体失效 |
| 13 | mac 工具条 | **隐藏六个动作按钮**（`.btn-group{display:none}`，Windows 下 `.btn-group{display:contents}` 故布局零变化），工具条本体 `order` 到窗口底部变成**状态条**（字数 / 自动保存 / 状态提示），文件名改由**系统标题栏**承载 | 同一批 DOM 节点两种排布，不做 mac/win 两套节点 |
| 14 | 大纲折叠的粒度 | **按父子链整节收起**（`analyzeOutline` 的 `descendants` 跨多级：折 H1 连带其下 H2/H3），三角只挂在**真有子级**的行上，无子级行用等宽占位保持文字对齐 | 与正文标题折叠同一语义；只藏「紧邻下一级」会让 H3 从收起的 H1 里漏出来 |
| 15 | 收起态存哪里 | **内存里的行号集合**，`renderOutline` 比对 `state.currentFile` 变化即清空；不持久化 | 与正文折叠一致（切文档即清）；持久化要跨文档同步行号映射，收益不抵成本 |
| 16 | 栏外图标的定位层 | `.side-corner` 挂在 **`.body`**（`position:absolute; top:8px; right:10px`，`.body` 补 `position:relative`），不挂 `.editor-pane` 也不 `fixed` | `.body` 自身不滚动 → 图标不随正文滚走；不 `fixed` → Windows 下自然落在 47px 工具条之下，无需平台分叉；不挂 `.editor-pane` → 侧栏收起后不跟着消失（这正是本条要解决的问题） |
| 17 | 栏外图标与栏内 tab 的关系 | **两个入口、一套引擎**（`setSideTab` / `toggleSidebar` / 同一份 `localStorage`），`syncSideCorner()` 由两处共同刷新；点已激活的图标 = 收起整栏 | 不各存一份状态；「按住对象直接操作」，不额外加开关按钮或弹窗 |
| 18 | mac「窗口」组的系统注入项 | 保留 `__tauri_window_menu__` 保留 id（标准窗口菜单不砍），另用 **`bundle.macOS.infoPlist` → `src-tauri/Info.macOS.plist`**（`CFBundleDevelopmentRegion=zh_CN` + `CFBundleLocalizations`）让 AppKit 的注入项取中文词；dev 形态另由 **`build.rs` 把同键的最小 plist 写到裸二进制同级** | AppKit 自动补的「全部最小化 / 填充 / 移动与调整大小 / 表情与符号」按 bundle 开发区域取词；砍掉保留 id 虽也能全中文，但代价是失去系统窗口列表与 Option 备选，本地化这条两全。dev 跑 `target/debug/notelume`、无 bundle，同级的 `Info.plist` 会被 `NSBundle` 当扁平 bundle 采纳，于是 dev 与打包词形一致（打包侧仍走 `tauri.conf.json` 那份，两条来源不交叉） |
| 19 | 不做 | mac 下不做窗口内自定义标题栏、不做 Windows 原生菜单、不做 `⌘1/⌘2` 切 tab、不做「凡有渲染产物的块」通用抽象、不做大纲折叠与正文折叠的联动 | 范围控制；抽象等第二个真实需求出现再抽 |
| 20 | 栏宽的载体 | **`.body` 上的两个 CSS 变量** `--nl-side-w` / `--nl-insp-w`（`.sidebar` / `.inspector` 的 `width` 改读变量，回退值 280px），JS 只 `setProperty` 一处 | 拖动期逐帧只改变量、不动 layout 相关的 class；`.side-corner` 的 `right:calc(var(--nl-insp-w,280px) + 10px)` 才能跟着右栏走（写死 `right:10px` 会在检查器变宽后被压住）；两侧共用一个 `applyColWidths()` |
| 21 | 「拖到一定宽度缩起来」的判定 | **宽 `< 90px` 即整栏收起**（`COL_W_COLLAPSE`），收起态与 `⌘⇧S` / 栏外图标 / 原生菜单 **同一套 `setSidebar` / `setInspector`**；分隔条本身不随栏隐藏 | 阈值给的是「拖过去的意图」，不是最小宽度（下限 180px 另设）；复用显隐函数才不必另同步图标态与 `localStorage['nl-sidebar']`；分隔条留在原位，收起后才还能反向拖回来，否则拖没了就抓不回来 |
| 22 | 拖拽的几何基准 | **指针相对 `.body` 的绝对位置**（左栏 `clientX - left`，右栏 `right - clientX`），不是 `startWidth + dx`；宽度的落盘与 clamp 只在 `pointerup` 发生 | 拖拽中途跨过阈值会收起/展开，栏宽本身突变，`startWidth + dx` 会把手甩到指针之外；绝对基准下基准不随显隐变。逐帧写 localStorage 无意义且会盖掉「记住的宽」 |
| 23 | 图片尺寸的存放层 | **image 节点的 `width` 属性**，序列化走 **Typora `![alt](src =328x)`** 与 **Obsidian `![[src\|328]]`** 两种既有外部形态；高度不存、按比例自适应 | 尺寸属于文档内容（同 Typora/Obsidian 的 `.md`），只写 DOM 样式会在重开文件后丢；采用外部通用语法而非私有格式，才能「零私有格式、他处打开不丢信息」；存高会把比例写死，图片换图即失真 |
| 24 | 尺寸语法的接入层 | markdown-it **新 inline 规则 `image_size`，`before('image')`**，只截「带尺寸」的形态，其余 `return false` 交回默认规则；目的地/title 复用 `parseLinkLabel` / `parseLinkDestination` / `parseLinkTitle` + `normalizeLink` / `validateLink` | 默认 image 规则遇到 `=328x` 直接判成纯文本（实测 `… =328x</p>`），必须在它之前截；自行解析字符串会绕过默认规则的转义与合法性处理，实测会出现每次保存多剥一层 `%5C` 的漂移。`parserTokens` 要覆盖 `image`（默认实现对无 children 的 token 抛错） |
| 25 | 尺寸形态的边界 | 只接 `=宽x` 与 `\|宽`；`=328x200`（高宽比写死）、`=50%`（相对容器宽）、尖括号目的地 `![a](<b c.png> =328x)` **一律不接**，原样留作文本 | 后三者各自要引入「比例语义」「相对单位」「含空格路径」的新模型，收益不抵成本；不接的形态必须保持**往返幂等**（改前实测会把尖括号目的地改写成 `%3Cb "c.png>`，即损数据） |
| 26 | 图片把手的提交时机 | 拖动过程只改 `img.style.width`，**`pointerup` 才落一次 `setNodeMarkup` 事务**；双击把手回原尺寸（`width:null`） | 逐帧 dispatch 会把 undo 栈刷满，一次 `⌘Z` 退不回；实测一事务即一次撤销回到 `788x478` |

## 3. 范围与非目标

**做**：
- Mermaid：默认只见图 → 单击就地出码 → 点外/`Esc` 回到图；渲染失败时错误框同样可点进编辑（否则用户无从改坏掉的源码）。
- 侧栏：文件/大纲两 tab 共用区 + tab 态持久化（`localStorage['nl-side-tab']`）+ 空大纲置灰；**栏外常驻图标对**（文件 / 大纲，两端都放，侧栏收起时仍可见可点）。
- 大纲：**层级树 + 子级整节可收**（大标题常显，三角只挂有子级的行），收起态内存级、切文档即清。
- macOS：原生菜单栏（App / 文件 / 编辑 / 格式 / 段落 / 视图 / 窗口，**全中文含系统注入项**）+ 窗口内工具条改底部状态条 + 标题栏显文件名；Windows/Linux 与浏览器构建**行为完全不变**。
- 栏宽：左右两栏各一条分隔条，按住直接拖（`180..520px`，回默认 `280px`）、双击复位、拖到 `<90px` 整栏收起且**不丢记住的宽**，宽度存 `localStorage`；栏外图标随右栏宽让位。
- 图片：右下角把手按住拖宽（下限 `40px`、上限父容器宽），双击回原尺寸；宽度作为 image 节点属性**往返进 `.md`**（Typora `=宽x` / Obsidian `|宽`），导出静态站同样带上。

**不做**：
- 数学块、普通代码块、图片、callout 的点击出码（保持现状）。
- 图片尺寸只存宽：`=328x200` 的固定高、`=50%` 的相对容器宽、尖括号目的地 `![a](<b c.png> =328x)` 都不接（原样留作文本并保证往返幂等）；不做裁剪 / 缩放后写回图片文件。
- 栏宽不做窗口尺寸自适应、不做百分比宽度、不做第三栏（分隔条只有两条，其余面板仍在栏内堆叠）。
- 侧栏其余面板（搜索/文档属性/标签/双向链接/历史版本/Git/插件）的 tab 化——搜索框按拍板留在原位，不搬底部。
- 折叠态/出码态的持久化（均为内存态，切文档即清，与批次 B 增补 Ⅰ 一致）。
- Windows 原生菜单、mac 窗口内工具条的可选显示开关。
- 菜单里的「打开最近 / 模板」子菜单 beyond 现有 `▾更多` 已实现的能力（复用同一份数据源，不新增逻辑）。

## 4. 详细设计

### 4.1 Mermaid 单击出码（改 `src/mermaid-preview.js`，无新文件）

**状态字段**：`mmKey` 的 state 从「裸 DecorationSet」改为 `{ set: DecorationSet, editing: number|null }`，其中 `editing` **不独立维护**，每次 `apply` 由光标位置重算。

```
apply(tr, prev, oldState, newState):
  editing = editingPosIn(tr.doc, newState.selection)      // 光标在哪个 mermaid 块内 → 该块 pos；否则 null
  无 docChanged 且 editing 未变 且 meta!=='refresh' → 只 map 旧 DecorationSet（廉价路径）
  否则 → buildDecorations(tr.doc, editing)

buildDecorations(doc, editing):
  doc.descendants(code_block & lang==='mermaid'):
    pos === editing → Decoration.node(pos, after, { class: 'nl-mm-editing' })        // 仅此一条：源码可见可编辑，不挂图
    否则           → Decoration.node(pos, after, { class: 'nl-mm-source' })          // 源码隐藏
                   + Decoration.widget(after, (view,getPos)=>makeWidget(...), { side:1, key:'nlmermaid:'+theme+':'+hash, stopEvent:()=>true })
```

- **进入**：`makeWidget` 返回的 div 上挂原生 `click` 监听 → `state.doc.resolve(getPos()).nodeBefore` 即该 mermaid 块（widget 挂在块尾），算出块起点后 `tr.setSelection(TextSelection.near(doc.resolve(start+1), 1))` + `setMeta('addToHistory', false)` + `view.focus()`。选区进块 → 下一帧 `editingPosIn` 命中 → 该类从 `nl-mm-source` 换成 `nl-mm-editing`，图随之摘掉。
  - 不用 `props.handleDOMEvents.click`：PM 对 `stopEvent` 的 widget 先忽略事件，该钩子收不到点击（实测：挂 handleDOMEvents 的版本点图后 `.nl-mm-editing` 恒为 0）。
  - 不写 `data-pos`：那是建 widget 那一刻的位置快照，文档一变即失效。
- **退出**（同一条判据，无需额外分支）：点正文别处、`Shift-Enter`（`exitCode`）、`⌥↑/↓` 出块，只要光标不再落在块内即回图态；`Esc` 由 `handleKeyDown` 主动把光标搬到块外（`TextSelection.near(doc.resolve(pos), -1)`，仅当确实落到块外才搬——该块是文档首块时无处可去，接受光标留在隐藏源码内，下次点击任意处即恢复）。
- **渲染失败态**：错误提示条与图同一个 div（`.nl-mermaid.nl-mermaid-error`），监听器照挂，故坏源码也能点进去改。
- **撤销栈**：进出编辑的事务都 `addToHistory:false`，`⌘Z` 撤销的仍是正文改动。
- **主题切换**：现有 `nl-theme-change` → `svgCache.clear()` + `setMeta(mmKey,'refresh')` 保留。
- **CSS**（`src/style.css` 的 `.nl-mermaid` 区块附近）：`.ProseMirror .nl-mm-source{display:none}`；`.ProseMirror .nl-mermaid{cursor:pointer}`；`.ProseMirror pre.nl-mm-editing` 加描边 + 轻微底色，提示「正在编辑」。零新增文字。

### 4.2 侧栏文件/大纲共用区（改 `src/index.html` + `src/main.js` + `src/style.css`）

```html
<section class="panel">
  <div class="side-tabs" role="tablist">
    <button class="side-tab" data-tab="files"   role="tab"><svg class="nl-ico"><use href="#i-folder"/></svg>文件</button>
    <button class="side-tab" data-tab="outline" role="tab"><svg class="nl-ico"><use href="#i-list-bullet"/></svg>大纲</button>
  </div>
  <div id="filetree" class="filetree"></div>
  <nav id="outline" class="outline hidden"></nav>
</section>
```

- 图标复用既有 sprite 符号（`#i-folder` / `#i-list-bullet`），**不新增 symbol**。
- `main.js` 新增 `setSideTab(name)`（切 `.hidden` + `.active` + 写 `localStorage['nl-side-tab']`）与 `bindSideTabs()`（委托 click）；`boot()` 里恢复持久化 tab。
- `onMetaChange` 建完 `.outline-item` 后：`outlineTab.disabled = !hasHeadings`；若 `disabled && 当前 tab==='outline'` → `setSideTab('files')`。
- 大纲点击仍走 `jumpToPos`（已含「自动展开祖先折叠」）。
- CSS：`.side-tabs{display:flex;gap:4px;margin-bottom:6px}`、`.side-tab{flex:1;…}`、`.side-tab.active{color:var(--fg);border-color:var(--accent)}`、`.side-tab:disabled{opacity:.4;cursor:default}`。文字两个字符、不解释，符合最小文案约定。

### 4.3 macOS 原生菜单栏（新 `src/app-menu.js` 算 spec + `src-tauri/src/lib.rs` 落原生 + `main.js` 接线）

**分层**（沿用本项目「纯逻辑可 Node 单测 / 副作用另置」范式，副作用这侧放到了 Rust）：
- `buildMacMenuSpec(ctx) -> { groups }`：**纯数据**，无 DOM、无 Tauri import → `src/tests/app-menu.test.mjs` 断言分组/条目/accelerator/checked/置灰；预定义角色（`type:'role'`）在此处统一查 `ROLE_TEXT` 换成中文标题（关于 X / 服务 / 隐藏 X / 隐藏其他 / 全部显示 / 退出 X / 关闭窗口 / 剪切 / 复制 / 粘贴 / 全选 / 最小化 / 缩放 / 进入全屏幕），应用名取 `ctx.appName`。
- Rust `set_mac_menu(spec)`：`MenuSpec/MenuGroup/MenuItemSpec`（`#[serde(rename_all="camelCase")]`，与前端 spec 同形）→ 每组一个 `SubmenuBuilder`（`id` 走 `native_group_id`：`window` 映射到 `tauri::menu::WINDOW_SUBMENU_ID`，其余用原 id）→ `MenuBuilder.items(&[&dyn IsMenuItem])` → `set_as_app_menu()`。`build_menu_item` 分派 `sep / role / submenu（递归）/ check / cmd`，`predefined_item` 覆盖 17 个角色、未知角色回 `Err("未知的系统菜单项：{}")`。
- 回传：`.on_menu_event(|app, event| app.emit("nl:menu-select", event.id()))` → `main.js` 的 `onMenuSelect(id)`；`nl.noop` 与 `builtin:*` 在前端早退。
- `main.js` 侧的接线函数：`menuCommands()`（注册表 + 「覆盖 ∪ 默认」键 + `enabled` + `checked`）、`menuSpecCtx()`（命令表 + 最近 + 模板 + 主题三态）、`onMenuSelect(id)`、`runViaShortcut(id)`、`scheduleMacChrome()` → `syncMacChrome()`（比对 spec JSON 签名后 `pushMacMenu()`，失败作废签名待下次重试）、`syncWindowTitle()`、`setupMacMenu()`。

**accelerator 转换**：`src/keymap.js` 新增纯函数 `toAccelerator(logical)`——`Mod-Shift-s → Cmd+Shift+S`、`Mod-/ → Cmd+/`、`Shift-Mod-p → Shift+Cmd+P`、`Control/Option` 展开为 `Control/Option`、`F1..F12` 原样、空/未绑定/非法 → `null`（该项不挂键）。与 `formatBinding`（显示用 `⌘⇧S`）分开：显示与系统格式两套消费者，避免互相污染。

**分组与来源**（条目一律取注册表 `title`，不另写文案；注册表里查不到的 id 直接跳过，故重命名命令不会让菜单挂空项）：

| 菜单 | 条目 | 来源 |
|---|---|---|
| **NoteLume** | 关于 / ─ / 快捷键设置… / ─ / 服务 / ─ / 隐藏·隐藏其他·全部显示 / ─ / 退出 | `PredefinedMenuItem` + `app.shortcuts` |
| **文件** | 打开文件… / 打开知识库… / 打开最近 ▸（≤12 + ─ + 清空最近记录） / 新画布·白板 / 模板 ▸（模板列表 + ─ + 新建空白模板… + 今日速记设置…） / ─ / 保存 / 导出 HTML / 导出整站… / 打印… / ─ / 今日速记 / 自动保存 ✓ / ─ / 关闭窗口 | `app.openFile` `app.openFolder` `recent:<i>` `app.newCanvas` `tpl:<path>` `app.save` `app.export` `app.exportSite` `app.print` `app.dailyCapture` `app.autosave` + Predefined `CloseWindow` |
| **编辑** | 撤销 / 重做 / ─ / 剪切 / 复制 / 粘贴 / 全选 / ─ / 搜索 | `editor.undo` `editor.redo`（走 PM history，与 `nl-keymap` 重绑一致；源码模式下 `runEditorCommand` 转 `src.undo()/src.redo()`）；剪贴板四项用 `PredefinedMenuItem`（WKWebView 原生粘贴最稳）；`app.search` |
| **格式** | 粗体 / 斜体 / 行内代码 / 删除线 / ─ / 行内公式 / 公式块 | `editor.bold` `editor.italic` `editor.code` `editor.strike` `editor.mathInline` `editor.mathBlock` |
| **段落** | 正文 / 一级·二级·三级标题 / 引用 / 代码块 / 无序列表 / 有序列表 / 任务列表 / 分割线 / 表格 / 提示卡片 / Mermaid 图（13 项，顺序 = 注册表顺序） | `editor.block.<id>`，由新 `src/block-commands.js` 把 `SLASH_ITEMS` 的 `build()` 换成 PM 命令（`setBlockType`/`wrapIn`/`wrapInList`/`insertBelow`/`taskList`）；菜单里剥掉注册表标题的「段落：」前缀。**无默认键**，只供菜单与命令面板调用 |
| **视图** | 源码模式 ✓ / ─ / 折叠·展开当前节 / ─ / 专注模式 ✓ / 打字机模式 ✓ / 侧栏 ✓ / ─ / 知识图谱… / 命令面板… / 主题 ▸（浅色·暗黑·Dracula，当前 ✓） | `app.sourceMode` `editor.foldSection` `app.focusMode` `app.typewriterMode` `app.toggleSidebar` `app.graph` `app.palette` + `theme:<name>` |
| **窗口** | 最小化 / 缩放 / ─ / 进入全屏幕 | Predefined |

> 有意**不放**「帮助」子菜单（无对应内容可链）；不放 mac 上无意义的重复项（如「▾更多」本身）；公式块只在「格式」出现一次，不重复挂进「段落」。

**条目状态**：
- `checked` 由 `MENU_CHECKED` 读实时态（`app.focusMode`/`app.typewriterMode`/`app.toggleSidebar`/`app.autosave`/`app.sourceMode`→`editor.isSourceMode()`），自动保存的复选框与菜单项共用新抽出的 `setAutosave(on)` 单入口。
- `enabled` 三判定：`MENU_NEEDS_DOC`（保存/导出/打印需已打开文档）、`MENU_NEEDS_VAULT`（导出整站/新画布/新模板/图谱需已开库）、`editor.*` 需「已打开 md 文档」（画布与无文档态置灰）。

**接线点**（`main.js`）：
- `boot()` 末尾 `bindShortcuts(); setupCloseGuard(); setupMacMenu()`。`setupMacMenu()` 首行 `if (!IS_MAC || !window.__TAURI_INTERNALS__) return`（浏览器与 Windows 整段静默跳过），**装配成功后**才 `document.documentElement.toggleAttribute('data-mac', true)`——装配失败即保持窗口内工具条原形态。
- 重建出口收敛为一处：`setStatus()`（所有状态变化的公共出口）、`applyTheme()`、`saveKeymapOverrides()`、`runViaShortcut()`、主题切换 → `scheduleMacChrome()`（150ms 去抖）→ `syncMacChrome()` 内比对 spec 的 JSON 签名，未变即不重建（`setStatus` 触发极频繁，逐次重绘原生菜单不可接受）。
- 标题栏：`#filename` 由多处直接赋值，故用 `MutationObserver` 观察该节点统一驱动 `syncWindowTitle()`（`getCurrentWindow().setTitle(name)`，仅 mac + Tauri，名字未变即跳过），而非逐个改赋值点。
- 菜单 `action` 一律 `onMenuSelect(id)` → `runViaShortcut(id)` → `commandRegistry.run(id, commandCtx())`——与键盘、命令面板**同一条执行路径**，不新增第二套；`recent:<i>` / `tpl:<path>` / `theme:<name>` / `nl.noop` 四类合成 id 在 `onMenuSelect` 内分流。

**权限与重启**：`capabilities/default.json` 只需 `"core:window:allow-set-title"`（`setTitle` 仍从 JS 走 window plugin）。`core:menu:default` 随 JS 装配路径一并撤下——原生菜单改在应用进程内构建，`set_mac_menu` 是 `generate_handler!` 注册的应用命令、不过 ACL；撤掉后真机菜单照常装配。**因含 Rust 与 capabilities，须重启 `tauri dev` 重编生效**。

**双触发风险**：菜单挂了 accelerator 后按键通常被系统菜单消费、不进 webview，但装配结果不保证一致，故两条入口共用 `runViaShortcut(id)` 内的 **200ms 同 id 去重**（不采用「菜单装好即关窗口内分发器」——那会让菜单装配失败时快捷键整体失效）。编辑层命令（`editor.*`）经 `ctx.runEditorCommand` 落到 PM，与直接按键等价。

### 4.4 大纲层级折叠 + 栏外常驻图标（新 `src/outline-tree.js` + `main.js` 渲染层 + `index.html` 两个按钮）

**纯逻辑 `src/outline-tree.js`**（无 DOM，可 Node 单测）：
- `analyzeOutline(items)`：单调栈切父子。弹栈条件 `level <= 栈顶.level` → 同级与回升都弹出，故**跳级不产生幽灵父**（H1→H3 直挂 H1）；输出与入参同序的 `{ level, parent, kids, descendants, depth, hasKids }`。`descendants` 是跨多级的全部后代（对每行沿 `parent` 链上溯、把自己挂到每个祖先名下，按文档序追加）；`depth` 按父子链而非 `level` 数值；`level` 归一到 `1..6`（`0`/缺省/非数字 → 1，`9` → 6）。
- `hiddenRows(rows, collapsed)`：把收起行号集合展开成应隐藏集合（并集，天然去重）；`rows` 非数组、`collapsed` 为 `null`、越界行号一律忽略不抛。

**渲染层 `renderOutline()`（`main.js`）**：
- 每行 `.outline-row.level-N` = 折叠位 + `.outline-item` 链接；`hasKids` 的行挂 `<button class="outline-caret">`（`#i-chevron-down`，收起态加 `.folded` → CSS `rotate(-90deg)`），否则挂等宽 `<span class="outline-caret outline-caret-sp">` 保持文字对齐（不渲染空态文案）。
- 三角 `click` 内 `preventDefault + stopPropagation` 只翻折叠；点文字仍 `editor.jumpToPos(item.pos)`。缩进/字重从 `.outline-item.level-N` 移到 `.outline-row.level-N`（`10/22/34px`，与改前视觉同级）。
- 收起态 `outlineCollapsed: Set<行号>` 存内存；`renderOutline` 开头比对 `state.currentFile`，变了即清空——覆盖 `openFile` / 单文件 / 最近重开 / 新建 等全部换文档路径，不必逐个改调用点。不触模型、不参与序列化。

**栏外图标对（`index.html`，`.body` 的第一个子节点）**：
```html
<div class="side-corner" role="group">
  <button class="side-corner-btn" data-tab="files"   title="文件"><use href="#i-folder"/></button>
  <button class="side-corner-btn" data-tab="outline" title="大纲"><use href="#i-list-bullet"/></button>
</div>
```
- 定位在 `.body`（补 `position:relative`）：`.body` 不随正文滚动 → 图标常驻；win 下自然落在 47px 工具条之下，mac 下即内容区右上角——**同一批节点、无平台分叉**。图标复用既有 `#i-folder` / `#i-list-bullet`，不新增 symbol；按钮内零文字（`title` 两字）。
- `openSidebarOn(tab)` 三条落点：收起 → `toggleSidebar()` + `setSideTab(tab)`；开着且在另一 tab → 只 `setSideTab`；**正停在该 tab → `toggleSidebar()` 收起整栏**。
- 状态单一来源：`setSideTab` 与 `setSidebar` 末尾都调 `syncSideCorner()`，故栏内 tab、栏外图标、`⌘⇧S` 命令三者永远同步；`syncOutlineTab(hasHeadings)` 同时置灰两处的大纲入口并在正停大纲时回落文件。

### 4.5 左右栏按住分隔条调宽 + 拖到边收起（改 `src/index.html` + `src/style.css` + `src/main.js`，无 Rust）

**结构**：`.body` 内两条 `.nl-gutter`（`#gutter-side` 在侧栏之后、`#gutter-insp` 在检查器之前），排布 `侧栏 → 分隔条 → 正文 → 分隔条 → 检查器`；`role="separator" aria-orientation="vertical"` 只作语义标注，不接 `aria-valuenow`（值不在无障碍树上更新，拖一次改一次反而是噪声）。

**CSS**：`.nl-gutter{flex:0 0 5px; align-self:stretch; cursor:col-resize; touch-action:none; z-index:4}`，`::after` 用 `inset:0 2px` 的强调色条只在 `:hover` / `.dragging` 时 `opacity:.45`（命中区 5px、视觉线 1px，不必加宽占位）；`.sidebar{width:var(--nl-side-w,280px)}`、`.inspector{width:var(--nl-insp-w,280px)}`；`.side-corner{right:calc(var(--nl-insp-w,280px) + 10px)}`；拖拽期给该栏加 `.is-resizing{user-select:none}`。

**JS（`bindColResizers()`，启动时紧随 `bindSideTabs()` 一次）**：
- 常量一侧共用：`COL_W_MIN 180` / `COL_W_MAX 520` / `COL_W_DEFAULT 280` / `COL_W_COLLAPSE 90`，键 `nl-w-sidebar` / `nl-w-inspector`，变量 `--nl-side-w` / `--nl-insp-w`；循环 `['sidebar','inspector']` 一份代码，差异只在 `COL_W_KEY` / `COL_W_VAR` / `COL_W_LABEL` 三张表和 `bodyWidthAt()` 里的左右取反。
- `bodyWidthAt(which, clientX)` 取绝对基准（见决策 22）；`move` 里 `w < COL_W_COLLAPSE` 则 `setColShown(which,false)` 并早退（不写变量，避免留下未达下限的值），否则 `setColShown(true)` + `setProperty(min(COL_W_MAX, w))`。
- `setColShown()` 先比对 `sidebarHidden()` / `inspectorHidden()`，态不符才调 `setSidebar` / `setInspector`：显隐只有一条通道，图标态与 `localStorage['nl-sidebar']` 的同步逻辑不用重复一遍。
- `up()` 两分支：落在收起区 → `applyColWidths()`（把变量收回记住的宽）+ `setStatus(label+'：已收起')`，**不记账**；否则 `clampColWidth(w)` 落 `localStorage` 后 `applyColWidths()`。
- `dblclick` → `removeItem` + `applyColWidths()` + `setStatus(label+'宽度：默认')`。
- 事件挂 `window` 的 `pointermove/pointerup/pointercancel`，不用 `setPointerCapture`（合成 pointerId 下 capture 抛错，且 capture 后分隔条自身不再收到 move）。

### 4.6 图片把手缩放与尺寸往返（改 `src/editor-schema.js` + `src/editor-view.js` + `src/site-export.js`，无 Rust）

**模型（`editor-schema.js`）**：`image` 节点 attrs 增加 `width: { default: null }`；`pxNum(v)` 只把 `328` / `328px` 认成整数（`50%`、`auto`、小数 → `null`）；`parseDOM.getAttrs` 读 `dom.style.width`、`toDOM` 有宽时写 `style="width:…px"`（外部 HTML 的内联宽也接得住）。

**解析（tokenizer）**：`inline.ruler.before('image','image_size', …)`，规则内 `parseLinkLabel` 取 alt → `parseLinkDestination` 取目的地 → 可选 `parseLinkTitle` → 尾部 `/^=(\d+)x/` 命中才 push `image` token（`attrs=[['src',href],['alt',''],['width',m[1]]]`，`children` 由 `inline.parse` 填）。三处必须与默认规则同进退：`unescDest()` 先解 `\(`/`\)`（默认规则的 `parseLinkDestination` 已解这层，漏掉会让同一张图带不带尺寸解析出两个 src，实测每次保存多剥一层 `%5C`）、`normalizeLink` + `validateLink` 失败即 `return false`、`rest.startsWith('<')` 早退（含空格路径按空格切会改写数据）。wikilink 嵌入侧 `![[图.png|328]]`：竖线段纯数字取作宽、`alt` 回落目标名；`|300x200` 仍按别名处理。

**序列化**：`embed` 节点写回 Obsidian 形态 `![[src|宽]]`；有宽的标准图写 `![alt](src "title" =宽x)`（括号按 `\(` 转义，title 与尺寸共存）；无宽仍走 `defaultMarkdownSerializer.nodes.image`。

**NodeView（`editor-view.js`）**：`makeImageNodeView(node, view, getPos)` 在 host 右下角 append `.nl-img-grip`（16px，hover / `.ProseMirror-selectednode` / `.dragging` 才可见，`.is-missing` 时 `display:none`）；`apply()` 里 `img.style.width = attrs.width ? … : ''`（样式由模型驱动，不反过来写模型）；`writeWidth(w)` 经 `getPos()` + `nodeAt(pos)` 比对后 `tr.setNodeMarkup(pos,undefined,{...attrs,width:w})`，只在 `pointerup` / `dblclick` 各调一次；上限取 `host.parentElement` 的宽、下限 `IMG_W_MIN 40`；`stopEvent` 认出把手目标，否则按下即被 PM 转成图片选中 + 原生图片拖拽。

**导出（`site-export.js`）**：`R.image` 与 `R.wiki_img` 各补 `style="width:…px"`，静态站与编辑器内看到同宽。

### 4.7 右侧检查器栏（改 `src/index.html` + `src/style.css` + `src/main.js`，无 Rust）

- **搬家不改面板**：六个面板（文档属性 `#frontmatter` / 标签 `#tags`+`#tags-global` / 双向链接 `#backlinks`+`#outgoing` / 历史版本 `#snapshots` / Git `#git` / 插件 `#plugins`）整段从 `.sidebar` 移进 `.inspector`，模块靠固定 id 容器挂载（`createFrontmatterPanel` / `createSnapshotPanel` / `createGitPanel` / `createPluginManager`），渲染代码与 `els` 取值不动；`.sidebar` 只剩 side-tabs + 搜索 + 文件树 + 大纲。
- **显隐一条通道**：`inspectorHidden()`（`localStorage['nl-inspector']` = `hidden`/`shown`）→ `syncInspector()` 一次刷新 `.inspector.hidden`、`.body.inspector-on`、`#btn-inspector.active` → 写入口只有 `setInspector(hidden)`（`toggleInspector()` 与栏宽拖拽都经它）。
- **图标与让位**：`#btn-inspector` 用既有 `#i-sliders`、零文字，并入 `.side-corner` 组（第三枚），点已激活即收起整栏；`.body.inspector-on .side-corner{right:calc(var(--nl-insp-w,280px) + 10px)}` 使三枚图标在检查器展开时整体让开一栏宽。
- **命令**：`app.toggleInspector`（`隐藏 / 显示检查器`，`Mod-Shift-i`）进注册表 → 命令面板 / 快捷键设置 / mac「视图」组勾选三处共用；窗口内「▾更多」项标题带当前键位。

### 4.8 「段落」菜单当前块类型打勾 + 标题升 / 降级（改 `src/block-commands.js` + `src/main.js` + `src/app-menu.js` + `src-tauri/src/lib.rs`）

- `activeBlockKey(state)`：由内向外、内层优先（引用里的标题算 `quote`、列表项里的段落算 `bullet`/`task`）；`NodeSelection` 直接取被点块；`code_block` 按 `params` 分流 `mermaid`/`code`；`h4/h5/h6` 照实返回（项表无该项 → 自然无勾）；`$head.depth < 1` 或点选块不在项表里 → `null` 不抛。纯函数、无 DOM，单测直接喂 PM 状态。
- `menuCommands()`：`editor.block.*` 的 `checked = (id === 'editor.block.' + active)`（全组互斥单选）；`headingUp` 的 `enabled = level > 1`、`headingDown` 的 `enabled = 1 ≤ level < 6`，非标题两项皆灰。
- `headingStep(delta)`：沿 `$head` 向上找最近 `heading`（更深层级里的标题也能升），越界返回 `false` → 置灰，不静默无操作。
- `app-menu.js`：段落组 = `editor.block.*` 全表 + 分隔 + 升 / 降级；`checked != null` 才出 `type:'check'`；剥「段落：」前缀。
- Rust：`build_menu_item` 的 `"check"` 分支用 `CheckMenuItemBuilder::with_id().enabled().checked()`，**无增量 `set_checked`**，勾态随整棵重建；重建由 `onSelectionChange → scheduleMacChrome()`（150ms）→ `pushMacMenu()` 的签名去重驱动，源码模式下 `activeBlock()` 返回 `null`。

### 4.9 跳转地图（新增/改动的可达路径）

```
Mermaid：正文图块 --单击（光标进块）--> 就地源码 --点外/Esc/Shift-Enter 出块--> 图块
侧栏  ：tab[文件] <--点/持久化--> tab[大纲] --条目--> jumpToPos（自动展开祖先正文折叠）
mac   ：系统菜单栏 文件/编辑/格式/段落/视图 --nl:menu-select--> runViaShortcut --> commandRegistry.run(id) --同一路径--> 命令面板 / 快捷键
        窗口底部状态条：字数 · 自动保存 ✓ · 状态提示（原工具条信息项，节点未变；主题入口移到 视图→主题▸）
        文件名：系统标题栏（窗口内 #filename 与六个动作按钮、主题按钮在 mac 下隐藏）
大纲  ：栏内 tab[大纲] <--同一套引擎--> 栏外图标[大纲]（.side-corner，侧栏收起时仍在）
        行内三角 --翻 outlineCollapsed--> 该标题下全部后代隐藏/恢复   |   行内文字 --jumpToPos--> 正文（不触发折叠）
侧栏  ：栏外图标[文件]/[大纲] --收起?开栏并切tab : 同tab?收起整栏 : 切tab--> 与 ⌘⇧S 同源
栏宽  ：#gutter-side / #gutter-insp --按住拖--> CSS 变量实时宽 --pointerup--> localStorage(nl-w-*)
        拖到 <90px --setColShown(false)--> 整栏收起（记住的宽不动）--反向拖回--> 展开恢复
        双击分隔条 --removeItem--> 回默认 280px  |  ⌘⇧S / ⌘⇧I / 栏外图标 / 原生菜单 --同源--> setSidebar / setInspector
图片  ：.nl-img-grip --按住拖（只改样式）--> pointerup 落一次事务 --> image.width 属性 --序列化--> `=宽x` / `|宽` 写进 .md
        双击把手 --width:null--> 回自然尺寸  |  ⌘Z / ⌘⇧Z --一事务一次--> 缩放可撤可重
win   ：mac 专属的两项（菜单栏、工具条沉底）不启用，工具条与六个按钮维持现状；栏外图标对与大纲折叠两端共用
```

## 5. 验证结果

| 层 | 手段 | 结果 |
|---|---|---|
| 纯逻辑 | `src/tests/app-menu.test.mjs`（新） | **24 passed**：组序与标签、文案取自注册表、注册表缺 id 即跳过、accelerator 透传/无键即省略、check 与 cmd 分派、`enabled:false`、分隔符不在首尾且不重复、role 清单与其 14 条中文标题（跟随 `appName`）、段落组剥前缀且随注册表顺序、**段落组按当前块单选（命中项 `checked:true`、其余 `false`）**、**注册表缺升/降级项时段落组不挂悬空 id**、最近/模板尾项与空态占位、主题勾选、近空注册表、`appName` 覆盖、叶子 id 唯一、未绑定命令仍列出 |
| 纯逻辑 | `src/tests/outline-tree.test.mjs`（新） | **14 passed**（用例表 14 条，6 条为负例/边界）：链式父子与多级后代、兄弟根、无 H1 时 H2 即根、跳级不产生幽灵父、同级为兄弟、逐级回升全为根、空序列、非数组入参、脏 `level` 归一、折叠 H1 隐藏跨多级后代、折叠叶子得空集、父+子并集去重、越界/`null` 入参不抛、`hasKids` 与 `kids` 一致 |
| 纯逻辑 | `src/tests/block-commands.test.mjs`（新） | **31 passed**：13 项块命令的模型产物断言 + 「`dispatch=undefined` 即纯判定」+ 表格单元格内 / 已在列表内边界；另有 10 条给「段落」菜单的**当前块类型判定与升/降级**（正文与各级标题、引用 / 代码块 / Mermaid 同节点按 `params` 分流、三种列表、表格单元格与 callout 内层优先、引用里的标题算引用这类边界、NodeSelection 点选 `hr` 的正例、公式块这类不在项表里的顶层块返回 `null` 不抛、一~六级端点越界即拒、非标题块拒答） |
| 纯逻辑 | `src/tests/keymap.test.mjs`（扩） | **19 passed**（+5 条 `toAccelerator`：`Mod→Cmd`、符号键 `/` 与 `` ` ``、`Control/Option/Cmd/F5` 形态、非法输入 `null`、与 `formatBinding` 的 mac 可读形态对照） |
| Rust | `cargo test --lib` | **49 passed / 0 failed**，含 3 条新菜单 spec 单测：`menu_spec_accepts_frontend_shape`（cmd/check/sep/role/嵌套子菜单 + camelCase 全类型反序列化）、`menu_spec_rejects_missing_group_text_and_maps_window_id`（缺组标题即 `Err`、`window` 组映射到保留 id）、`menu_spec_gives_roles_a_text` |
| 纯逻辑 | 既有 7 套离线套件 | `fold` 24 / `roundtrip` 54 / `source-sync` 4 / `template` 3 / `writing-stats` 3 / `site-export` 21 passed；十套合计 **197 passed / 0 failed**（证明 mermaid、大纲与图片尺寸改动不破坏既有往返） |
| 构建 | `npm run build:web` / `tauri build --bundles app` | 均无错；`.app` 内 `plutil -p Contents/Info.plist` 确认 `CFBundleDevelopmentRegion=zh_CN` 与 `CFBundleLocalizations` 已合入 |
| 浏览器（dist 静态服务 + headless Chrome CDP，**不用 1420 dev 代理**） | 真实用户路径建两块 mermaid：粘贴 HTML → 空段 `/mermaid` → 菜单选中 → `Input.insertText` 打源码 | 建块后 `widgets 2 / svg 2 / hiddenSrc 2 / editing 0`；点第一张 → `editing 1 / widgets 1 / pre display:block`；出码态 `insertText('%% Q ')` → 模型含该串；`Esc` → `editing 0 / widgets 2`；点第二张 → 仍只 1 块出码；点正文段落 → 退出 |
| 同上 | 侧栏两 tab | `.side-tab` 两项「文件 / 大纲」；点大纲 → `#filetree` 隐藏、`#outline` 显示、`ls='outline'`、条目 1；点回文件全部复原；无标题文档时大纲 tab `disabled` |
| 同上 | 大纲层级折叠（粘贴 1/2/3/2/1 五级标题） | 5 行、`caret` 落点 `open/open/sp/sp/sp`；点 H1 三角 → **5 行→2 行**（只剩两个 H1），三角 `.folded` 且 computed `transform: matrix(0,-1,1,0,0,0)`；展开 H1 后折 H2「1.1 节」→ 4 行（其下 H3 被藏）；点末行文字 → 选区落「第二章」且行数不变（跳转不误触折叠）；空文档 → 0 行且两处大纲入口 `disabled` |
| 同上 | 栏外图标对 | 两枚 26px 宽；点「大纲」→ `ls='outline'`、`#filetree` 隐藏、栏内 tab 与栏外图标 active 同步；再点同一图标 → 整栏收起而图标仍可见（`top 55`、active 全清）；点「文件」→ 开栏回文件 tab；`⌘⇧S` 收起后图标 active 同步清空；图标不与正文重叠（`cornerBottom 77 < firstH1Top 140`）；mac 形态（手动 `data-mac`）图标 `top 8`、工具条 `top 866` |
| 同上 | Windows 回归 | 无 `data-mac` 时 `.btn-group{display:contents}`、六个按钮全在顶部（工具条 `top 0`、高 47、`打开文件/打开知识库/保存/今日/源码/更多` + 主题/文件名/状态/自动保存/字数 全在位）；手动加 `data-mac` 后工具条 `top 0→866`（贴底、高 34，`.body` 底边 866 让位）、`.btn-group`/`#btn-theme`/`#filename` 全 `display:none`、状态文本与自动保存勾选保留 |
| **真机**（`tauri dev` + System Events 读真实菜单栏，非截图非推断） | mac 原生菜单本体 | 顶层 `Apple, NoteLume, 文件, 编辑, 格式, 段落, 视图, 窗口`（改前是 Tauri `Menu::default()` 的英文 `File/Edit/View/Window/Help`）；文件组 15 项全中文并含「打开最近 ▸ / 模板 ▸」与「关闭窗口」；应用组 关于 NoteLume / 快捷键设置… / 服务 / 隐藏 NoteLume / 隐藏其他 / 全部显示 / 退出 NoteLume；段落组已剥「段落：」前缀；点 视图→Markdown 源码模式 → `AXMenuItemMarkChar` `missing value→✓`、再点回 `✓→missing value`（原生点击 → Rust 事件 → 注册表 → spec 重建 双向闭环）；系统标题栏显当前文档名；撤下 `core:menu:default` 后重启仍装配 |
| **真机（打包 `.app`）** | 系统注入项本地化 | 窗口组 `最小化 / 全部最小化 / 缩放 / 全部缩放 / 填充 / 居中 / 移动与调整大小 / 全屏幕拼贴 / 从组中移除窗口 / 进入全屏幕 / 未打开文档`、文件组末项 `关闭窗口 / 全部关闭`、编辑组 `撤销 / 重做 / 剪切 / 复制 / 粘贴 / 全选 / 聚焦侧栏 / 搜索 / 自动填充 / 开始听写… / 表情与符号`——整棵菜单零英文 |
| 同上 | 右侧检查器栏 | `sidebarPanels 1`（左栏只剩 side-tabs、`sidebarH2` 空、搜索框在）、`inspectorPanels 6` 且 `inspectorH2` = 文档属性 / 标签 / 双向链接 / 历史版本 / Git / 插件、`.side-corner` 三枚 `["files","outline","btn-inspector"]`；`Ctrl+Shift+I` → `inspectorDisplay block→none`、`.body.inspector-on` 摘掉、`nl-inspector=hidden`、`cornerRight 312→10`、`editorW 848→1150`，再按一次五项全复原；栏外第三枚图标点 / 再点同样收 / 开 |
| 同上 | 左右栏拖拽调宽（`#gutter-side` / `#gutter-insp`） | 初始 `sideW 280 / inspW 280 / cornerRight 290 / editorW 870`；侧栏右拖 +120 → `403px` 且 `nl-w-sidebar=403`、状态「侧栏宽度：403px」，再 −60 → `346`；检查器 −90 → `372`、`cornerRight 382`（图标跟随右栏宽）；继续拖到 `<90` → `sideDisp none`、`nl-sidebar=hidden`、记住的 `346` 未被覆盖、`editorW 1058`、状态「侧栏：已收起」；反向拖 → 重开停在 `323`；检查器同形态（收起后 `cornerRight 10`、`editorW 1107`）；双击分隔条 → 回 `280`、`nl-w-sidebar` 清空、状态「侧栏宽度：默认」 |
| 同上 | 图片把手缩放 + 尺寸往返 | 1320×800 图源种入 → `natural 1320x800 / shown 788x478 / width null`；把手左拖 −240 → `shown 548x332`、`style.width 548px`，模型经 `pmViewDesc.node.toJSON()` + `serializeMarkdown` 得 `![probe](… =548x)`；`⌘Z` **一次**即回 `788x478` 且 Markdown 中尺寸消失（证明拖动全程只一事务）、`⌘⇧Z` 回 `548px`；双击把手 → `width (auto)` + 无尺寸 Markdown |
| 纯逻辑 | `src/tests/roundtrip.test.mjs`（扩，尺寸往返） | **54 passed**（+5 条 SAMPLES、+9 项断言）：`![图注](./assets/pic.png =328x)` 解析成 `width 328` 并原形态写回；title 与尺寸共存；`![[diagram.png\|328]]` 写回 Obsidian 形态且数字段不当别名（`alt === src`）；`![[diagram.png\|300x200]]` 不吞（`width null`、别名保留）；`=50%` 与 `=328x200` 不成图且文本往返幂等；转义括号路径 `![a](p\(1.png =100x)` 不漂移 |
| 构建 | `cargo build` / `cargo test --lib`（含新 build script） | 构建无错、**49 passed / 0 failed**；build script 触发后 `src-tauri/target/debug/Info.plist` 生成，`plutil -p` 读出 `CFBundleDevelopmentRegion => zh_CN` 与 `CFBundleLocalizations=[zh_CN, zh-Hans, en]`，与 `target/debug/notelume` 同级 |
| **未实测项（须声明）** | WKWebView 内的大纲折叠与栏外图标点击 | 本机 1420 是用户自己的 dev 实例，前端行为验证一律走 dist 静态服务 + headless Chrome；真机侧只读到了原生菜单栏（System Events 走 AX，不需要 webview 调试端口），故这两处只有浏览器实测数据，未见 WKWebView 内表现 |
| 同上 | `tauri dev` 下的窗口组与 WebView 右键菜单 | 打包 `.app` 后转中文已实测（见上面「真机（打包 `.app`）」行）；dev 侧改由 build script 写同级 `Info.plist` 补齐，`plutil -p` 验到的是**文件内容与四键**，菜单词形需重启 dev 才可见（1420 被现有实例占着，未动它） |
| 同上 | mac 系统外观（深色菜单 / 减少透明度）与 accelerator 被菜单消费后的实际按键归属 | 原生菜单不吃应用 CSS，未换系统外观核对；按键归属只验到「同一命令不会双触发」的去重逻辑，未逐键验由谁消费 |
| 同上 | 段落菜单勾的原生形态 | `editor.block.*` 的 `checked` 已进 spec、Rust 侧 `CheckMenuItemBuilder` 已装配并过 49 条单测，真机 `AXMenuItemMarkChar` 是否随选区出现未 dump；Windows / 浏览器形态没有原生菜单，勾无等效 UI |
| 同上 | 栏宽拖拽与图片缩放在真机 WKWebView 内 | 拖拽帧率、触摸板惯性、真实 `.md` 落盘后的字节复核都只在 dist 静态服务 + headless Chrome 侧取到；文档内容按同一序列化函数推出，未 reopen 磁盘文件比对 |
| 同上 | 图片 `parseDOM` 的 `style.width` 形态、`=50%` 的外部还原 | 从外部粘贴带内联宽的 `<img>` 未走一遍；`=50%` 只保证「不成图、原文幂等」，Typora 自身对该串的显示未比对 |
| 同上 | 检查器栏六个面板搬家后的功能回归 | frontmatter 编辑落盘、快照回滚、Git fetch、插件加载只验到容器 id 与显隐，未逐个走一遍真实操作；窄窗（<1200px）下 `flex-shrink:0` 的右栏挤压正文的幅度未逐档核对 |

## 6. 风险与回退

- **菜单 accelerator 与 PM 内建键位抢键**：若实测发现某键（如 `⌘Z`）经菜单路径行为漂移，回退做法是该项**不挂 accelerator**（仅保留可点击），键位仍由 PM 处理——单点回退，不影响其他项。
- **Mermaid 退出编辑后光标落在隐藏源码内**：仅发生在「该块是文档首块且 `Esc` 无处可搬」，最坏表现是看不见光标直到点别处，不损数据。
- **大纲收起态按行号存**：在收起的节**之上**新插一个标题会让折叠落到相邻节（最坏表现是多藏/少藏一节，点一下即复原）；换文档已按 `state.currentFile` 清空，不跨文档残留。不选按 `pos` 存：大纲层拿不到 PM 的位置映射，编辑正文即整体失效。
- **`set_mac_menu` 装配失败**：命令 `Err` 回前端 → `setStatus` 回显中文原因、`data-mac` 不挂 → 窗口内工具条与快捷键分发器原样可用（不会因菜单挂不上而丢入口）。
- **图片尺寸往返的三个失效形态**（都已在实现里堵住，改动 `image_size` 规则时须一起保）：① 目的地转义未还原（默认规则的 `parseLinkDestination` 已解 `\(`，自定义规则漏一步就会每次保存多剥一层，实测漂移成 `%5C%5C`）；② 尖括号目的地按空格切（实测被改写成 `%3Cb "c.png>`，属**损数据**）；③ `parserTokens` 未覆盖 `image`（默认实现对无 children 的 token 抛错，图片直接进不了模型）。回退做法：不认外部尺寸语法，只走 `parseDOM` 的 `style.width` —— 代价是 Typora / Obsidian 打开时尺寸丢。
- **栏收起时残留未达下限的宽**：跨过阈值即 `return`（不写变量），松手再 `applyColWidths()` 回到记住的宽；若留着 `74px` 这类值，下次经 `⌘⇧S` 展开会以低于 `COL_W_MIN` 的宽出现。
- **拖动过程不落事务**：图片把手与分隔条都只在 `pointerup` 记账，undo 栈一次缩放一条；改成逐帧 dispatch 会让一次 `⌘Z` 只退一像素。
- **dev 的 build script 写同级 plist**：只在 mac target 跑、内容未变不重写、失败也不阻断构建（`let _ =`）；无效时的现状就是 dev 下这些项显英文（打包形态不受影响，两者走不同 plist 来源）。
- **回退整体**：各块改动彼此独立（mermaid 插件 / 侧栏 tab 与栏外图标 HTML+函数 / 大纲层级模块 / mac 菜单 spec+Rust 命令+CSS / bundle 与 dev 的本地化 plist / 检查器栏 HTML+显隐函数 / 栏宽分隔条 / 图片尺寸 schema+NodeView+导出），可单独 revert 而不牵动其余。
