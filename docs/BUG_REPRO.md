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

## 四、应用内 Git 推不上去，点了没反应（库根被标签页带偏 + 子目录误建仓库）

### 现象

Git 面板点 ↑ Push 没有任何反应：状态栏不动、不弹框、远端收不到提交。引擎徽标正常显示「系统 git」。同一台机器命令行 `git push` 正常。

### 复现

三个条件凑齐：settings.json 的 `panes.tabs` 里有一个 `root` 指向仓库子目录的标签页（「打开单个文件」入口的库根是文件所在目录，会留下这种标签）；启动恢复该标签时整个库根跟到子目录；子目录又被 `git init` 过（commit `test`，无远端）。此时面板远端行显示「未配置远端」，fetch / pull / push / merge 四个按钮 disabled——disabled 按钮的点击被浏览器吞掉，无任何反馈。

### 定位

WebView2 远程调试（`WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9223`）+ CDP 抓控制台与 IPC：

1. 干净测试库（bare 远端 + 无上游工作库）E2E：推送链路本身正常——无上游弹确认框，确认后 `push --set-upstream` 成功，bare 收到分支；gitee 真库推送同样到「已推送到远端」。排除推送实现。
2. 故障实例里 `git_r_remote_list('E:\NoteLume\docs')` 返回 `[]`，`git_open` 把 docs 认成仓库根——`docs\.git` 存在（无 remote）。面板 `populateSync` 拿不到 origin，四个按钮全 disabled。
3. `GIT_TRACE=<绝对路径>` 让 git 把每次调用的命令与退出码写文件，确认全程没有执行过 `git push`——按钮根本没触发。

### 改法

数据问题，不改代码：删掉误建的子目录 `.git`（或给它配远端），重新打开正确的库根。

### 下次直接用

- 「Git 点了没反应」先看面板远端行是不是「未配置远端」：无远端时按钮禁用（`git-panel.js` 的 `populateSync`），点击无反馈属正常行为，不是推送坏了。
- 库根会被激活标签页的 `root` 带走（tab id = paneId + root + rel，恢复即切根）；排查库根漂移先读 `%APPDATA%\app.notelume.desktop\settings.json` 的 `panes.tabs` 与 `workspace.lastVault` 是否一致。
- 应用内 git 的真实命令行与退出码：`GIT_TRACE` 指到绝对路径文件（GitRun 截走的 stderr 到不了你眼里时靠它）。

---

## 五、语音听写点完几秒就自己收场，还被报成「拿不到麦克风」（仅 Windows 原生听写）

### 现象

AI 面板配了服务商地址但没填「语音识别模型」（`voicePath` 回 `native`），点麦克风：按钮变蓝、出「正在听写，再次点击停止」，然后约 6 秒后灯自己灭，面板里出现「系统语音识别拿不到麦克风（未打包应用在新版 Windows 上被拒），可在「AI 设置」里填语音识别模型改用服务商转写」。使用者看到的就是一句「语音功能打不开」。

只影响 Windows 原生听写那一路。填了 `asrModel` 的录音+上传路径、浏览器版 Web Speech、mac/Linux 都不经过本模块。

### 复现

用打包版（或 `target/release/notelume.exe`）带 CDP 端口起，stderr 落文件：

```
WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9236
e:\NoteLume\src-tauri\target\release\notelume.exe 2> tmp\voice_ui.log
```

页面里点真按钮（不是直接调 IPC，续场逻辑在前端）：

```
localStorage.setItem('nl-ai-open','1')
document.querySelector('.ai-voice').click()
```

不要说话，每秒采一次按钮类与提示，共 40 秒（脚本 `tmp/voice_ui.mjs`，不入库）。关键输出：

```
[7.3s]  [voice] auto-stop silence limit: 请求 120s, 生效 120s
[7.3s]  [voice] recognizer state -> SpeechRecognizerState(1)
[13.4s] [voice] recognizer state -> SpeechRecognizerState(0)
[13.4s] [voice] session self-terminated, status = 7 -> end/auto-ended
[13.4s] [voice] reused session, req=dict-...   ← 上一行刚自终，下一行就接上了
```

三个条件缺任何一个都不复现：没填 `asrModel`（否则走 ASR）；系统「在线语音识别」隐私开关开着（否则 StartAsync 直接被拒 0x80045509）；真的不出声（出声一段后自终用的是 status 5，不是 7）。

### 定位

1. 先误了层：状态码。`voice.rs` 里写的是 `if code == 7 { emit("error","mic-unavailable") }`，注释说 7 是 MicrophoneUnavailable、5 是 PauseLimitReached。查 crate 里的常量表：`%USERPROFILE%\.cargo\registry\src\index.crates.io-*\windows-0.62.2\src\Windows\Media\SpeechRecognition\mod.rs` 里 `impl SpeechRecognitionResultStatus` 一段逐项写着 Success 0 / TopicLanguageNotSupported 1 / GrammarLanguageMismatch 2 / GrammarCompilationFailure 3 / AudioQualityFailure 4 / UserCanceled 5 / Unknown 6 / **TimeoutExceeded 7** / PauseLimitExceeded 8 / NetworkFailure 9 / **MicrophoneUnavailable 10**。所以：引擎每次「没听到可用语音就收场」都被当成麦克风被拒，而真被拒（10）反倒归到 else 分支当正常收尾吞掉。
2. 再一层：为什么是 6 秒。微软文档里 `AutoStopSilenceTimeout` 默认 5 秒，看着止好对上。设到 120 秒后重跑——自终时刻没后移，而 getter 回读确实给了 120 秒。这一步推翻了「调那个属性就能修」的假设：这个开关不是这条链的闸门，只能靠自终后有人接。当时误判过一次，差点把「设大上限」当成交付项交出去。
3. 另一条支线：引擎到底有没有收到声。挂 `SpeechRecognizer.RecognitionQualityDegrading` 与状态日志，外放噪声时看到 `audio problem -> SpeechRecognitionAudioProblem(4)`（TooQuiet）与 state 走 SoundStarted(3) → SpeechDetected(5) → SoundEnded(4)——麦克风通道是通的，不是无包身份被拒。顺带把 `SpeechRecognizerState` 的常量表也查了一遍（Idle 0 / Capturing 1 / Processing 2 / SoundStarted 3 / SoundEnded 4 / SpeechDetected 5 / Paused 6），与直觉序也不一样。
4. 锁的形状是顺路发现的：`dictation_start_sync` 持 `dict_slot` 跨 `StartAsync()?.join()`，而 Completed 回调要同一把锁——回调等锁、建立会话的线程等回调，就死在那儿。两把锁分开（`DICT_OPS` 串行 start/stop/probe，状态锁只碰字段）后，又补上「启动后 2 秒窗口内的收尾类当上一场尾巴丢掉」，否则会话复用后迟到的 Completed 会把刚开好的那场关掉。
5. 最后一轮才掉出来的：`Close()` 也不能在状态锁里做。改完锁之后有一轮验证里出现了新形状——点停止后状态不变、Rust 日志从此一行不出（`completed …` 与 `emit …` 都在锁后打），看起来像整个听写卡住。锁里剩的 WinRT 调用只剩 `recognizer.Close()`（在 Completed 回调里与 `discard_engine()` 里）——它一卡，stop 拿不到状态锁就永远不回来。改成「锁里只取走对象，锁放掉再 Close」。
6. 同一个验证还扒出一个真卡死：那一轮 `StopAsync` 等了 12 秒没回来，而那之前所有点麦克风的操作都排在 `DICT_OPS` 后面——这就是用户视角的「彻底打不开」（为了验证是不是「复用引擎」导致的，还把 `dictation_keeps_engine` 装成「一律重建」重跑一轮，同样卡 → 排除复用，得是卡本身要上上限）。现在的处理：停止前先问 `recognizer.State()`，已经 Idle 就不等 StopAsync；真等不到（6 秒上限）就拆引擎、下一场重建，并把错误回给前端说一句「没响应」而不是静默蓝住。

### 改法

口径从「自终就是故障」改成「自终不是故障，是下一场的开始」：

* `src-tauri/src/voice.rs`：纯函数 `dictation_done_signal`（0/4/5/7/8 → `end` + 哨兵 `auto-ended`，9 → `network-unavailable`，10 → `mic-unavailable`，其余 → `engine-error:{码}`）、`is_auto_end`、`completed_counts(code, just_started)`、`dictation_keeps_engine`、`engine_is_busy`；`dict_slot` 与 `DICT_OPS` 两把锁拆开，WinRT 调用（`StartAsync` / `StopAsync` / `CompileConstraintsAsync` / `Close`）全在锁外；复用路径 StartAsync 失败当场 `discard_engine()` 重建；`auto-ended` 不关引擎，留给下一次复用（实测复用 80ms、重建 0.5s）；阻塞等待走 `winrt_block`，启动/初始化上限 `DICT_START_WAIT_SECS=12s`、停止 `DICT_STOP_WAIT_SECS=6s`，停止前先问 `State()`。
* `src/ai-tasks.js`：`dictationDoneInfo(kind, text)` 把哨兵映射到词条；`shouldResumeDictation({text,state,now,deadline,resumes})` 四条件；`DICT_SESSION_MAX_MS = 120000`（与 Rust 的 `REC_MAX_SECS` 同源）、`DICT_RESUME_MAX = 25`（只当循环刹车）。
* `src/ai-panel.js`：`voiceState` 多一个 `starting`，点击当场点亮并拦住第二下；`end` 分支先问要不要续场，续场时先挂新 `dictReqId` 再发 start；`result` 事件把续场计数归零。
* 词条：`ai.voiceSessionEnd`（不再续场时说一句）、`ai.voiceNetwork`、`ai.voiceEngineErr` 五语言；`ai.voiceMicUnavailable` 从此只在真被拒时出。

### 验证与遗留

* 单测：`cargo test --lib` 375 passed（voice:: +7）；`tests/ai-tasks.test.mjs` 49 passed（+2）；`tests/ai-panel-voice-ui.test.mjs` 16 passed（+7）；前端全量 94 个测试文件零失败（约 1073 条）；`npm run build` 出包正常（vite 38.53s、cargo release 1m21s、NSIS 8.24 MiB）。
* 负向对照：同时摘掉 `toggleVoice` 与 `startVoice` 两道连点拦截 → 「一次会话只能有一个 start：2 !== 1」红；把续场判定装成永不续 → 「引擎自终不结束会话」「出字后计数归零」两条红；把 `auto-ended` 装回「麦克风故障」旧口径 → 「该说本场结束那句，实际：……拿不到麦克风」红；装回即绿。
* 真机（`tmp/voice_ui.mjs` + `tmp/voice_stop.mjs`）：静默 40 秒共 8 场场场当场续上（约 80 毫秒）、麦克风全程蓝着不出故障提示；status 5 那档也被接住；点停止立刻灭灯，随后 20 秒会话建立次数不再增长（用户停的是 `end` + 空 text，不吃续场）；连点「开始 + 300ms 后停」最短周期不卡不残留。
* 遗留：`StopAsync` 为什么在某些时刻不回来仍未查到底（同一轮里它又秒回），现在只有上限与 Idle 前置判定这两层兼底；`DICT_START_GRACE_SECS=2s` 窗口会把「启动后 2 秒内真的自终」误当尾巴丢，后果是那一拍不续场、下一次点击才能接上（不会卡死，因为有 State 判定）。真人开口后的转写质量仍未验——本机 WebView2 `speechSynthesis.getVoices()` 回 0 条，TTS 外放这条路取不到可识别的语音；WebAudio 噪声只能证明「引擎听得见」，证明不了「识别得对」。ASR 那一路真机一次仍未做（需服务商余额）。

### 下次直接用

* 遇到 WinRT 返回的状态码，先去 cargo registry 里看 `impl XxxStatus { pub const ... }`，不要按文档页的排列或直觉序猜；这一行的 value 与名字错一位，界面文案就整条错。
* 判断听写引擎有没有收到声音：挂 `RecognitionQualityDegrading`（NoSignal 2 / TooQuiet 4）与 `StateChanged`；`voice.rs` 的 `dictation_register_diag` 默认就挂着这两条并打 stderr。
* 别把 `AutoStopSilenceTimeout` 当连续听写的保底：设得再大（120s，回读也是 120s）引擎仍会几秒自终。能保住的只有「收到 `end` + `auto-ended` 就再 start 一场」。
* 会话复用后，事件回调里的 `reqId` 与 `running` 都是共享单元，任何「上一场的迟到事件」都必须先问「刚 start 过没」再动手；否则会看到莫名「刚点亮就灭」。
* WinRT 的 `join()` / `Close()` 一个都不能放在锁里：`join()` 不回来会把后面的命令全堵住，所以要有 `winrt_block` 这种带上限的等法；而「停止」这种操作不要相信自己的 `running` 标记，先问引擎 `State()` —— 它已经 Idle 时 `StopAsync` 根本不会回来。
* 驱动脚本（`tmp/voice_cdp.mjs` / `voice_cdp2.mjs` / `voice_cdp3.mjs` / `voice_ui.mjs` / `voice_stop.mjs` / `voice_noise.mjs`）都在 gitignore 的 `tmp/` 下，不入库；CDP 收广播事件要 `plugin:event|listen` 带 `target: { kind: 'Any' }`；验证听写肯定要走 UI（直接调 IPC 不会触发前端的续场）。

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
