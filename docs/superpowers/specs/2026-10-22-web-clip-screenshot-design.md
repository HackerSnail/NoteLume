# 网页剪藏 v3：选区截图剪藏

- 日期：2026-10-22
- 基础：[`2026-10-21-web-clip-design.md`](2026-10-21-web-clip-design.md)（v1）、[`2026-10-21-web-clip-v2-design.md`](2026-10-21-web-clip-v2-design.md)（v2），均已实现并推送。v1/v2 的架构不变：扩展 POST 到本机 HTTP 服务（只绑 `127.0.0.1`，Origin + Host 两道来源闸门、无令牌），Rust 按模板落盘、自动关联、emit `nl:clip-saved`，设置走 settings.json 的 `clip` 段
- 本文只写 v2 之上的增量：多一种剪藏物（画面），不是多一种剪藏源

## 1. 为什么加

剪藏链路此前只搬文字与远程图：选区剪藏存的是划中的那段 md，图片是正文里的 `![]()` 远程链接。用户真正想留的常常是画面本身——图表、示意图、一段代码截图、一张配图——文字描述不了，存下来的是链接而不是那张图，链接过两天就裂。

所以加第三种剪藏物：**选区截图**。用户划一块区域（或选中一张图），扩展把这块画面截下来，存进库的 `assets/`，正文里是一张本地图片。

## 2. 链路

```
选区 → 页面侧量矩形（content/shot.js）
     → chrome.tabs.captureVisibleTab 拍可视视口
     → service worker 里 OffscreenCanvas 裁出那块
     → POST /clip（clipType='screenshot'，screenshot.dataUri + width）
     → Rust 落 <目标目录>/assets/clip-<时间戳>.png，正文写 ![标题](./assets/xxx.png =宽x)
```

扩展侧新增三个文件级入口：

- 右键菜单「截取选区图片剪藏到 NoteLume」（contexts: selection）
- 右键菜单「框选区域截图剪藏到 NoteLume」（contexts: page + selection）
- 快捷键 `Alt+Shift+S`（选区截图）与 `Alt+Shift+D`（手动框选），manifest 的 `commands` 段登记，浏览器自己派发

工具栏图标维持原语义（有选区剪文字选区，没有剪整页）——图标只有一个，按住不放会让「剪文字」与「截图」互相猜。截图走右键与快捷键几条明确入口。

## 2.1 手动框选

浏览器的选区只能圈文字：图、图表、canvas 画出来的图，划不出来。框选补的就是这一段——用户自己在页面上拖一个矩形。

- 页面侧 `shot.js` 的 `startPick()` 挂一层 `position:fixed` 的暗色遮罩，拖动时画选框，松开即算矩形
- 样式走 `chrome.scripting.insertCSS`：页面的 CSP 管不到它；写成元素的 `style` 属性反会被严格 CSP 拦下（CSSOM 逐条设 `style.left` 才没事）
- **遮罩与选框在报回结果前全部撤掉**——截图拍的是当前画面，遮罩留着就被拍进去了
- `Esc` 取消；拖动面积不足 4px 当误点处理（同样按取消）
- 结果两路报回后台：`chrome.runtime.sendMessage` 与 `window.__NL_SHOT.lastPick`。后台 `waitForPick` 走消息优先、200ms 轮询兜底（页面里拿不到 `chrome.runtime` 时走轮询这条）
- 框选出来的图与选区截图同一条落盘链路（`clipType='screenshot'`），正文只有图、不带选中的文字——框选圈的是画面，不是文字

## 3. 页面侧量矩形（extension/content/shot.js）

- `prepare()`：取当前选区的 `getBoundingClientRect()`（视口 CSS 像素）。选区有一截在视口外时，先 `scrollIntoView({block:'center', inline:'center', behavior:'instant'})` 把它滚进来，等 150ms 再量一次——截图只能拍到可视视口，滚完的坐标才对得上
- 选区在本 frame 读不到时（选区在 iframe 里），退到同源 iframe 里找（跨域读不到，catch 掉），矩形加上 iframe 自己在页面里的位置
- `pageMeta()`：标题 / 作者 / 站点 / 关键词（`og:*` 与 `meta` 兜底）。截图剪藏是拍画面，不必跑 Defuddle / Readability

## 4. 裁剪

`captureVisibleTab` 给的是活动标签的可视视口画面，按设备像素比放大。裁剪坐标换算：

```
scaleX = 图片宽 / innerWidth      scaleY = 图片高 / innerHeight
裁剪区 = 选区矩形 ∩ 视口
```

- 选区比视口大时只能截到看得见的那部分，扩展在通知里说明（「选区比视口大，只截到看得见的那部分」）
- 长边超过 2000px 的等比缩到 2000px 以内：2 倍屏上一块大区域能到几千像素，整块 base64 会顶到 8MB 的载荷上限
- PNG 超过 3.5MB 转 JPEG（照片、渐变图压不小）；Rust 侧按 mime 认 png / jpg，落盘扩展名跟着走

## 5. 载荷与落盘

载荷加一个字段，与 `images` 分开：

```json
{
  "clipType": "screenshot",
  "markdown": "选中的文字（没有就空串）",
  "screenshot": { "dataUri": "data:image/png;base64,..." }
}
```

- `screenshot` 是剪藏内容本身，**恒定落盘**，不受 `clip.localizeImages` 影响——那个开关管的是正文里的远程图
- 文件名 `clip-<YYYYMMDD-HHMMSS>.png` 落 `<目标目录>/assets/`，同一秒两张加序号
- 正文：`![页面标题](./assets/clip-xxx.png)`，后面接选中的文字（选了才有）
- 不写 Typora 的 `=宽x` 尺寸形态：它不是标准 GFM，Obsidian 与 GitHub 会把整段当纯文本，图片在这些阅读器里就废了。图按原图大小显示，由阅读器按栏宽收
- 内置模板加第三个 `shot`：来源行进引用块 `> 截自 [站点](链接)`，与整页剪藏、选区摘录都拉开观感
- 用户的模板优先（设置里的 `template_rel` 或扩展选项页的单次覆盖）；用户模板里没有 `{{content}}` 时，图补到文末——别让截下来的画面丢了
- 空内容判定放宽：有截图就不算空（选区是一张图时没有文字）
- 自动关联照旧按标题 / 摘要 / 标签打分，文末追加「## 相关笔记」

## 6. 明确不做

- 整页长截图（captureVisibleTab 只给可视视口；要整页得靠 CDP，扩展做不到）
- 圈选任意形状（只按矩形裁；Chrome 没有框选 API）
- 视频帧、GIF 动图
- 截图剪藏的远程图本地化（截图本身就是本地的，没有远程图这回事）
- 框选时多块区域（一次一个矩形）、框选后手动微调边框

## 7. 落地检查单

- [已实现] 扩展：`content/shot.js`（量矩形 + 页面 meta + 手动框选遮罩）、`background.js` 的 `clipShot` / `clipShotBox` / `captureRegion` / `cropBox` / `waitForPick`、右键菜单四条、快捷键 `Alt+Shift+S` 与 `Alt+Shift+D`
- [已实现] Rust：`ClipScreenshot` 载荷字段、`save_clip_screenshot`、内置 `shot` 模板、空内容判定放宽
- [已实现] 文档：`extension/README.md` 用法与失败提示、`docs/CLAUDE.MD` 剪藏节、CHANGELOG 一条

## 8. 风险

- `captureVisibleTab` 只能拍可视视口：选区在视口外要先滚进来（页面侧做），选区比视口大时截不全
- 跨域 iframe 里的选区读不到：没有矩形就报「没有选中内容」，不比选区摘录那条（有 `info.selectionText` 兜底）——图剪藏没有纯文本兜底可用
- 手动框选期间页面被遮罩盖住：这期间页面上的交互（点链接、滚动）都收着，Esc 才退
- 扩展依赖 `captureVisibleTab` 与 `OffscreenCanvas`：Firefox 的 MV3 也有这两个 API，但本项目只验了 Chromium 系
