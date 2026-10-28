# 设计：Ctrl+P 打印排版增强（Paged.js）

- 状态：设计完成，待实现
- 日期：2026-10-25
- 来源：Quarkdown 可移植功能评估的第二个子项目；最初设想「固定规则直打」，用户要求排版件可选，定为选项窗方案
- 决策原则锚定：Ctrl+P 习惯不变（入口不动）；引一个依赖换来真分页与页码，值；排版偏好是 UI 偏好，存 localStorage 不进 settings.json

## 一、背景与目标

现有打印（`app.print`，Ctrl+P）就是 `window.print()`，靠 `@media print`（`src/style.css`）隐藏应用壳、只打焦点窗格，`@page` 设 A4 边距 18mm/20mm。多页文档没有页码，长文档没有目录，书稿类文档章节不分页。本批给这条链路加真分页排版：打印前用 Paged.js 预分页，产出带页码、可选目录页 / H1 分页 / 封面的版式，仍走系统打印对话框存 PDF。

## 二、范围

**包含**
- Ctrl+P 先弹选项窗：四个勾选——自动目录页、页码 + 页眉标题、H1 起新页、封面页（标题 + 日期居中）。选择存 localStorage（键 `nl-print-options`），下次按上次的勾；首次默认只勾「页码 + 页眉标题」（最接近普通打印）。
- 预分页完成后再 `window.print()`；取消选项窗则不打印。
- canvas 模式保持老行为（直接 `window.print()`）。
- 平台：三端都走预分页。等待排版完成按进度判定而不是固定秒数——Paged.js 一页一帧地排，mac 打包版实测窗口失焦 / 被遮挡时 WKWebView 几秒才补一帧（同一篇前台 12.7 秒排完、被打印面板压住的那趟 65 秒排到一半），按总耗时砍会把还在慢慢出页的排版误判成失败。页面盒计数只要还在涨就续命，连续 20 秒没有新增才收。

**不包含（YAGNI / 后续）**
- 设置页配置（选项窗记住上次选择已够用）。
- 整库合订本打印、水印、纸型与边距选项（维持 A4 + 现有边距）。
- Emoji 短代码（第三个子项目，另立一案）。

## 三、排版链路

```
Ctrl+P → app.print
  → canvas 模式？ → window.print()（老行为，不进本链路）
  → 打开选项窗（localStorage 记忆勾选）→ 确认 / 取消
  → 克隆焦点窗格 .ProseMirror 的 DOM（图片已是 data URI、公式与 mermaid 已渲染、frontmatter 不在编辑器 DOM 里，天然不进打印文档）
  → H1/H2 按现有 anchorSlug 补 id（目录页码的锚点）
  → 按勾选拼目录 / 封面节点
  → Paged.js Previewer 预分页进隐藏容器 #print-root（body 打 data-paged-print 标记）
  → window.print() → afterprint 拆容器、摘标记
  → 预分页抛错 → 摘标记回退 window.print()（老路径），状态栏提示
```

- **内容源用 DOM 克隆，不重新渲染 markdown**：编辑器里的图片已经过 `read_image_data_uri` 换成 data URI，在应用内新增容器里引用相对路径必裂图；克隆现成 DOM 零风险，wikilink、callout、任务清单的呈现与屏幕一致。
- **Paged.js**（npm `pagedjs@^0.4`，安装时取 0.4 最新，MIT）走 Previewer API（`new Previewer().preview(content, styles, renderTo)`），不用 polyfill 自动模式——自动模式接管全页样式，会和应用自身样式打架。
- **打印隔离**：`@media print` 里按 `body[data-paged-print]` 隐藏 `body > :not(#print-root)`，只显示分页容器；这条规则与现有打印规则并存，现有路径不打这个标记就不受影响。
- **四个排版件的实现**：
  - 页码 + 页眉：`@page` 边注——页脚居中 `counter(page)`，页眉居中文档标题（`string-set` 从标题节点取）；`:first` 页页眉留空（封面勾选时即封面页，未勾选时即正文首页）。
  - 目录页：排在文档最前、`break-after: page`；条目取 H1/H2（缩进区分层级），链接指向锚点 id，页码用 `target-counter(attr(href url), page)` 由 Paged.js 自动算。
  - H1 起新页：`h1 { break-before: page }`，首个 H1 除外（否则每篇都空出首页）。
  - 封面页：文档标题 + 本地日期，居中大字，`break-after: page`；勾选时置于目录之前。
- **取消与失败**：选项窗取消 → 什么都不发生；预分页超时 / 抛错 → 摘标记回退 `window.print()`，状态栏提示走的是排版版失败（词条另立）。

## 四、组件划分

### 前端
- **`src/print-paged.js`（新增）**：主逻辑。对外暴露 `printPaged({ sourceEl, title, options })`：克隆、锚点、目录 / 封面拼装、调 Previewer、打印与清理；预分页失败回退由调用方（main.js）兜底。锚点与目录构建拆成可单测的纯函数导出（`buildTocNodes(rootEl)`、`assignHeadingIds(rootEl)`）。
- **`src/print-options-dialog.js`（新增）**：选项窗，overlay + box 结构照 `src/prompt-dialog.js` 的模式（Promise resolve，确认回选项对象、取消回 null）；勾选状态读写 localStorage `nl-print-options`（默认值与读写也在本模块，可单测）。
- **`src/main.js`（改）**：`app.print` 从 `() => window.print()` 改为走分支——canvas 直打；否则开选项窗，确认后调 `printPaged`，异常回退直打。Ctrl+P 默认键与菜单注册不动。
- **`src/style.css`（改）**：`@media print` 增 `body[data-paged-print]` 隐藏壳层一条；新增 `#print-root` 内的版式样式（`@page` 边注、目录、封面、H1 分页——这部分样式要进 Previewer 的 styles 参数而非页面样式表，Paged.js 只处理传给它的 CSS，拆成 `printStyles(options, title)` 导出以便复用与单测）。

### Rust
无改动。

## 五、i18n

选项窗标题、四个勾选文案、确认 / 取消、「正在排版…」与「排版失败，已回退普通打印」两条状态，进 `src/locales/` 五份。命令标题 `cmd.app.print` 不变。

## 六、测试

`src/tests/print-toc.test.mjs`（jsdom，参照 `site-export.test.mjs` 结构）：
- `assignHeadingIds`：H1/H2 补 id、id 与现有 `anchorSlug` 一致、重名加后缀、H3 不参与。
- `buildTocNodes`：提取层级与文本、空文档返回空数组。
- `printStyles`：按选项产出对应规则（页码边注、目录 target-counter、H1 break、封面），未勾选的不产出。
- 选项窗存储：默认值、读写往返、坏数据回落默认。
- Paged.js 预分页本体依赖真实布局引擎，jsdom 覆盖不了，归真机验收。

## 七、验收

一篇含 H1、多个 `##` 与长表格的文档：Ctrl+P 勾全部四项 → 目录页在封面之后、正文按 H1 分页、每页页脚有页码、页眉有文档标题（首页除外）；只勾页码时除页码外无其他排版件；再按 Ctrl+P 选项窗按上次勾选回显；断网时打印仍可用（Paged.js 本地打包，不依赖网络）。取消选项窗不打印；canvas 模式 Ctrl+P 直出老打印。
