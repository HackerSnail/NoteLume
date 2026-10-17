# 疑难 bug 复现记录

收那些不好复现、或复现了也不好定位的问题。一条一节，固定六段：现象 / 复现 / 定位 / 改法 / 验证与遗留 / 下次直接用。数字、命令、测试名都按当时真实执行抄进来，改代码后要回来改这里。

---

## 一、表格列边界悬停时列线闪烁（仅 macOS）

### 现象

鼠标移到表格两列之间的竖线上（不点击），列线在原地来回跳；移开就停。只跳靠后的列边界，第一列边界不跳。Chromium 内核侧同页同事件不跳。

### 复现

夹具：三列表格，第一列短词、第二第三列长句（长到超出 `style.css:2118-2124` 的 `max-width: 20em` 封顶）。版心收到 `.editor{max-width:780px}`。指针沿第二列边界上下扫，进入边界两侧 5px（prosemirror-tables 的 `handleWidth`）即出。

三个条件缺任何一个都不复现：

1. WKWebView。同一份 harness 页在 headless Chromium 里跑，列宽恒 314.9，八段采样零差异。
2. 真事件。指针移动要由窗口服务器派发（`CGEvent` 投给 `NSApp` 事件循环）。页面里 `dispatchEvent(new MouseEvent('mousemove', ...))` 的合成事件下 WebKit 不动列宽，基线 / 悬停 / 撤掉三段恒为 105.6 / 306.7 / 306.7。
3. 真装配。走应用的 `createEditor`（全套插件 + nodeViews），带本仓库 `style.css`。手搭的静态 DOM 页不抖：`max-width: 20em` 那条封顶和 PM widget 的插入结构分属两处，少一处都不成立。

前两条是这条记录存在的理由：第一轮就是拿合成事件 + 静态 DOM 页验的，两版都「看不出抖动」，规则到底有没有生效在那种页面上根本不可观测。

### 定位

1. 页面内挂采样器：`mousemove` 只认 `e.isTrusted`，回调里读该行三格的 `getBoundingClientRect().width`、`tableLayout`、colgroup 内联宽度、以及 `.column-resize-handle` / `img.ProseMirror-separator` / `br.ProseMirror-trailingBreak` 的计数，拼成状态串，变了才记一条。另挂 `ResizeObserver` 抓「那一帧没有 mousemove 也翻」的宽度变化，挂 `MutationObserver` 数表节点重建次数。
3. 同一页内来回切两种规则状态扫同一条边界：`pre` 注入 `display:inline!important` 把两条规则强制撤回流内，`ship` 不注入、走 `style.css` 现状。第二列界：pre 出 133 次状态变化，列宽在 [105.6, 306.7, 306.7] 与 [105.6, 340, 273.4] 之间来回，ResizeObserver 在没有 mousemove 的一帧也抓到翻转；ship 出 3 次，且只剩手柄出现与撤掉，列宽恒为一态。第一列界两种状态都不翻。全程表节点重建 0、`table-layout` 恒 `auto`、colgroup 无内联宽度。
4. 机制：指针进入命中区后插件在该列每格格尾插一个行内拖拽手柄，ProseMirror 围着它补一个 `img.ProseMirror-separator`、行尾再加 `br.ProseMirror-trailingBreak`。这两个盒只要还有一个留在流里，WebKit 就按当前列重量重新问整表 max-content，把 20em 封顶点上去、邻列缩下来；边界一挪 33.3px，鼠标脱出命中区、手柄撤掉、宽度弹回、再次命中，自激。
5. 逐盒开关收范围：只隐 `br` 仍翻；只隐 separator 仍翻；separator 收成 0×0 的行内盒仍翻；两个都 `display:none` 才停。手柄自身换 `right:0`、`transform`、`contain`、`width:0`+边框、`left:100%` 五种写法全都还闪，即与手柄的几何无关，只与格尾那一行结构有关。

### 改法

`style.css:2125-2134`，两条：

```css
.ProseMirror th .ProseMirror-trailingBreak,
.ProseMirror td .ProseMirror-trailingBreak {
  display: none;
}
.ProseMirror .column-resize-handle + .ProseMirror-separator {
  display: none;
}
```

第二条用兄弟选择器，只隐紧邻手柄那一个 separator，其它 widget 的 separator 不受影响。应用没有引 `prosemirror-view/style/prosemirror.css`，没有同权重竞争，不需要 `!important`。

### 验证与遗留

- 光标点位：悬停态沿该格取 11 个 x 点、整表 33 格中心各问一次 `posAtCoords`，pre / ship 逐点一致，所属单元格全等；其中 5 个点再真落成 `selection.from` 也一样。separator 只是隐去，节点仍在 DOM 里，PM 的坐标映射不动。
- 拖拽写回：真鼠标按住第二列界拖 48px，ship 写回 `colwidth:[355]` 并把表转 `fixed`；pre 同样行程写回 388，因为起量的 `currentColWidth` 读到的正是那次闪出来的 340。闪烁此前还在污染拖出来的列宽。
- 回归：`npm run build:web` 30.99s 无错、`test:merged-table` 7 passed、`test:roundtrip` 58 passed、`test:pos-map` 7 passed、`test:footnote` 6 passed、`test:find-in-doc` 14 passed。
- 遗留：WebKit 首帧布局给 306.7 / 306.7、带手柄重算给 340 / 273.4 的分歧本身还在（20em 封顶带来的二义），这次只是让悬停不再触发它。`.nl-docx-render` 与 `.cv-node-body` 两个非编辑渲染面没有 PM widget，不涉及。
- 未实测：macOS 应用内目视（数字来自与同版本 `style.css` 一致的 harness 页，改后需在应用里逐列边界悬停确认）；Windows 侧对照用的是 headless Chromium 而非真 WebView2 运行时。

### 下次直接用

脚本都在 gitignore 的 `tmp/` 下，不入库，按下面片段重建。

```
node tmp/live2-page.mjs '.editor{max-width:780px}' tmp/live2-720.html
src/node_modules/.bin/esbuild tmp/live2-entry.js --bundle --format=iife --outfile=tmp/live2-bundle.js
SDKROOT=/Library/Developer/CommandLineTools/SDKs/MacOSX15.5.sdk swift tmp/cg-drive2.swift tmp/live2-720.html tmp/cg-probe.js
DRAG=ship SDKROOT=/Library/Developer/CommandLineTools/SDKs/MacOSX15.5.sdk swift tmp/cg-drive2.swift tmp/live2-720.html tmp/cg-probe.js
```

装配页（`live2-entry.js`）直接用真编辑器，不手搭 DOM：

```js
import { createEditor } from '../src/editor-view.js'
window.__boot = () => {
  const ed = createEditor({ mountEl: document.getElementById('mount'), sourceMountEl: document.getElementById('source'), /* 其余回调留空 */ })
  ed.setMarkdown(window.__MD)
  window.__view = ed.view
}
```

真鼠标投递（`cg-drive2.swift` 的核心，页面读到的 `isTrusted` 才为 1）：

```swift
let src = CGEventSource(stateID: .hidSystemState)
func point(_ wx: Double, _ wy: Double) -> CGPoint {
  let cocoa = win.convertToScreen(NSRect(x: CGFloat(wx), y: CGFloat(web.bounds.height - wy), width: 1, height: 1))
  return CGPoint(x: cocoa.minX, y: primaryH - cocoa.minY)   // primaryH = NSScreen.screens[0].frame.height
}
func move(_ wx: Double, _ wy: Double) {
  let p = point(wx, wy)
  CGWarpMouseCursorPosition(p)
  CGEvent(mouseEventSource: src, mouseType: .mouseMoved, mouseCursorPosition: p, mouseButton: .left)?.post(tap: .cghidEventTap)
}
```

踩过的坑，逐条都是真堵过一轮的：

- 驱动进程必须有 `NSApp.run()` + Timer 步骤表。没有事件循环时页面读到的 `isTrusted` 是 0，等于又回到合成事件。
- `swift` 要带 `SDKROOT=/Library/Developer/CommandLineTools/SDKs/MacOSX15.5.sdk`；默认 26.2 SDK 由 swift 6.2 编，本机 6.1.2 报 `failed to build module 'Swift'`。
- 从 Node 侧起 swift 只能 `spawn`，用 `execFileSync` 会堵死事件循环，同进程里的 http server 不应答，探针一路 TIMEOUT。
- harness 页里那条额外 CSS 参数漏掉，页面就用应用默认版心，抖动不复现。探针页自己的 `<style>` 若排在引入应用样式表之前，同特异性下反被应用覆盖：实测 `.editor{max-width:860px;padding:48px 30px}` 静默把 904px 内容宽改成 800px，列宽数字全偏却看不出原因。
- 拖拽腿要单开一趟。拖完 `colwidth` 就写进文档，跟闪烁扫描同页混跑会把后一条的量污染掉。
- 计数器要区分「有 mousemove 的帧」和「没有 mousemove 也翻的帧」，只挂事件监听会漏掉后者，看起来像抖动消失了。
- 探针脚本本体是 Node，只有传进 `Runtime.evaluate` 的字符串在浏览器里跑；在 async 回调里直接写 `document.querySelector` 会抛 `ReferenceError: document is not defined`，那是探针自己的 bug，不是应用挂了。

---

## 二、同一功能在 Windows 有、mac 没有（菜单入口缺失）

### 现象

Windows 的工具条「更多」下拉里有 15 项，其中「导入 Word(.docx)…」「导出 Word(.docx)…」在 mac 上没有任何入口能调到。功能本身在，Rust 侧 `export_docx` 与 docx 导入都没有平台分支。

### 复现

mac 打包版或 `tauri dev`：看系统菜单栏「文件」组，没有这两行。窗口内那条下拉在 mac 上不显示，`style.css:253-257` 有 `[data-mac] .toolbar .btn-group { display:none }`，把含「更多」的整组按钮收掉，动作交给原生菜单。

### 为什么难找

原生菜单的条目只从命令注册表取（`src/app-menu.js buildMacMenuSpec`），只认注册过的 id。任何直接写在 `openMoreMenu` 里的 `makeMenuItem` 项，mac 侧静默消失，Windows 侧正常，代码里看不出差别，单测也不会红。

### 定位

不看单张截图，按同一机制找全所有面：

1. 正向：Windows 下拉 15 项逐条映射注册表 id，分三个集合。13 项 mac 原生菜单已有对应，缺的正是 Word 那两条；查找 / 替换与 Git 那 8 条两边都没有菜单项（走 Ctrl+F / Ctrl+H 与检查器面板），不计缺口。
2. 反向：mac 有、Windows 没有的也查一遍。原生菜单「格式」「段落」组在 Windows 靠快捷键与命令面板到达，属设计文档写明的非目标（不为 Windows 建第二套 UI）。
3. 门控分三类看，别混成一条：需有文档（`MENU_NEEDS_DOC`）、需开库（`MENU_NEEDS_VAULT`）、需所见即所得的 md 文档（`editor.*` 与 `MENU_NEEDS_MD`）。

### 改法

条目注册进 `registerAppCommands`（`main.js:2006` 起），无默认键、不抢既有绑定；「文件」组内排在 `app.exportSite` 之后、「打印」之前。窗口下拉整份改由注册表出文案与键位（`addMenuCmd`，`main.js:1182`），勾选态也取 `MENU_CHECKED`，两处消费一份来源。

### 验证与遗留

- `app-menu.test.mjs` 25 passed（fixture 补两条命令，断言落位）。
- headless Chromium 载 `src/dist`，`Emulation.setUserAgentOverride` 把 `platform` 覆成 `MacIntel` / `Win32`，四趟矩阵（平台 × 有无 `nl-keymap` 覆盖）读回整份 15 项的文案、键位后缀、勾选态。
- 顺着这条带出三处别的问题：下拉里「专注模式」硬编 `(Ctrl+Shift+F)`，真实默认键是 `Mod-Shift-e`，`Ctrl+Shift+F` 是「聚焦侧栏搜索」，`README.md` 快捷键表同错；Windows 下拉项没有 disabled 机制（`makeMenuItem` 无该形参），置灰只能落在 mac 原生菜单，导出 Word 的空文档拒绝改在函数入口；未开文档时点导出得到状态栏「没有可导出的文档」，不落空 `.docx`。
- 未实测：mac 原生菜单的实际渲染（spec 由 Rust `set_mac_menu` 落地，需 `tauri dev` 目视）；Windows 打包实例（本机无 Windows 环境，上面用的是 Chromium 覆 `platform`，同一套 JS 不同运行时）。

### 下次直接用

- 判断某个窗口内菜单项在 mac 上存不存在，只看代码不够：该项必须同时在注册表里、且在 `app-menu.js` 的组清单里，两者缺一即缺。
- 平台差对账要双向、全量、按门控分类，单条对照单张截图会漏。
- 用 `platform` 覆写能在同一台 mac 上把 `IS_MAC` 的两条文案分支都跑一遍；覆写要在 `Page.navigate` 之前下发，`IS_MAC` 在模块加载时一次算定。

---

## 三、mac 打印 / 另存 PDF 报 `webview.print not allowed`（仅 macOS）

### 现象

mac 打包版点「文件」→「打印 / 另存 PDF」，状态栏出「异步错误：webview.print not allowed. Permissions associated with this command: core:webview:allow-print」，打印面板不出现。Windows 同一条正常。

### 复现

打包版或 `tauri dev`，先打开一个 md 文档（菜单项在 `MENU_NEEDS_DOC` 里，没文档时置灰；命令面板那条路不吃置灰）。浏览器里不复现：没有 `window.__TAURI_INTERNALS__`，`window.print` 也没被替换，走 Chrome 自己的打印。

### 为什么难找

代码侧只有 `main.js:2022` 一句 `window.print()`，全文搜 `print` 搜不到任何 Tauri 调用，报错里的 `webview.print` 和源码字面对不上。差异是编译期注入的：tauri 只在 mac/iOS 把 `src/webview/scripts/print.js` 拼进 webview 初始化脚本（`tauri-2.12.3/src/webview/plugin.rs:198-202`，注释「window.print works on Linux/Windows; need to use the API on macOS」），脚本内容就三行：

```js
window.print = function () {
  return window.__TAURI_INTERNALS__.invoke('plugin:webview|print')
}
```

WKWebView 没有打印实现，mac 独走 IPC 并过权限层；WebView2 原生实现，不经 ACL。同一行代码在两个平台是两条路径。

凡是「看着是浏览器原生 API、在桌面壳里却报 `xxx not allowed`」的调用都按这一类查（打印、剪贴板、下载、`window.open`），别在业务代码里找 Tauri 调用。

### 定位

1. 报错文本自带权限名：`core:webview:allow-print`。
2. 核对权限集：`src-tauri/gen/schemas/acl-manifests.json` 里 `core:webview` 的 `default_permission.permissions` 只有 `allow-get-all-webviews`、`allow-webview-position`、`allow-webview-size`、`allow-internal-toggle-devtools` 四项，`core:default` 展开就是这些，print 不在内。
3. 核对清单：`src-tauri/capabilities/default.json` 原本只有 `core:default`、`dialog:default`、`core:window:allow-destroy`、`core:window:allow-set-title`，没有任何 webview 增补。
4. 两条探针作废，别再当证据用：
   - `strings -a 二进制 | grep core:webview:allow-print` 改前改后都 0 命中，且肯定已授予的 `core:window:allow-destroy` 同样 0 命中。权限标识符不在 `strings` 能扫到的字面量里，探针检不出已知存在项，任何结论都不成立。
   - 想留改前样本要比构建更早。release 构建原地覆盖 `target/release/notelume`，构建中途拷出的「改前」副本是 20285760 字节、与改后同尺寸（改前那份是 20285776），说明拷到的已是重链接后的新二进制。

### 改法

`src-tauri/capabilities/default.json:9` 加一行 `"core:webview:allow-print"`，范围到此为止：不附带放开别的 webview 权限，前端一行不动。

构建约束：capabilities 由 `tauri-build` 在编译期读 `capabilities/*.json` 烘进二进制，同时生成 `gen/schemas/capabilities.json`。只改 JSON 不重建 Rust 侧不生效，前端刷新无效。仓库里多数修复是 `src/dist` 改完刷新即生效，这一条不是，容易在只跑 `npm run build:web` 之后误判成没修好。

### 验证与遗留

- `npm run build`：vite 28.41s、cargo release 42.12s，`bundle/macos/NoteLume.app` 与 `bundle/dmg/NoteLume_0.1.0_aarch64.dmg`（8.5 MB）重出；`gen/schemas/capabilities.json` 含该权限位（标识符在构建期按 `desktop-schema.json` 校验，写错构建直接失败）。
- 打包版界面实测（AX 读，不涉及截图）：点「文件」→「打印 / 另存 PDF」，1s 内主窗口 `AXSheets` 由 0 变 1，之后 0.5s 步长轮询 24 拍不消失，sheet 内一个分离组，即打印面板的预览分栏。改前的拒绝状态取用使用者的实测报告，本轮没重建改前二进制复测。
- 同一次 AX 遍历顺带核对到 mac 原生菜单落位：「文件」组次序 …导出为 HTML、导出整站…、导入 Word(.docx)…、导出 Word(.docx)…、打印 / 另存 PDF，与注册条目一致；「打印 / 另存 PDF」的 `AXMenuItemCmdChar` 为 `P`、`AXMenuItemCmdModifiers` 为 0。
- 未实测：`⌘P` 键位路径。`keystroke "p" using command down` 与 CGEvent 键击两条都没出面板，但同通道发的 `⌘⇧S` 也翻不动「隐藏 / 显示侧栏」的菜单勾（同项用 `AXPress` 点击可翻，mark 由 ✓ 变无），合成键击在这台机上不可信，不能据此判键位坏。判它得用真键盘或 `tauri dev` 目视一次。
- 未实测：面板里「PDF」下拉的另存落盘、以及 `@media print`（`style.css:3617-3680`）在纸面的效果；本轮只验面板出与不出。
- Windows 不改，不经这条 ACL。

### 下次直接用

- 桌面壳报 `xxx not allowed. Permissions associated with this command: yyy`，两步读完事，不用起应用：

```
python3 - <<'PY'
import json
m = json.load(open('src-tauri/gen/schemas/acl-manifests.json'))
print(m['core:webview']['default_permission']['permissions'])
PY
grep -c "core:webview:allow-print" src-tauri/gen/schemas/capabilities.json
```

- 判定面板出没出，只轮询这一句，别深查 sheet（对 sheet 逐元素读属性之后，下一次查询该 sheet 就报无效索引，面板是自己关还是被读关掉未判明）：

```
osascript -e 'tell application "System Events" to tell process "notelume" to count of sheets of window 1'
```

- 进程名是小写 `notelume`，bundle 名才是 `NoteLume`；读菜单属性用 `value of attribute "AXMenuItemCmdChar"` / `"AXMenuItemCmdModifiers"` / `"AXMenuItemMarkChar"`。
- `name of first application process whose frontmost is true` 必须写在 `tell application "System Events"` 块内，写进 `tell process` 里会报类型转换错（-1700）。
- 面板存活期用菜单点击验，别用合成键击：`click menu item "打印 / 另存 PDF" of menu 1 of menu bar item "文件" of menu bar 1`。

---

## 空白模板

```
## N、一句话现象

### 现象
在哪、做什么操作、看到什么、哪些条件下不出现。

### 复现
夹具到列宽 / 数据量 / 主题 / 窗宽这个级别；命令逐条可贴。

### 定位
按实际顺序写，包含判错的弯路和据以排除的那次测量。

### 改法
文件:行 + 为什么这么选（有没有更窄的写法、为什么不用 !important）。

### 验证与遗留
改前后各一组的数字、跑了哪些测试、哪些没验、机制残留在哪。

### 下次直接用
探针踩过的坑、能复用的命令与片段。
```
