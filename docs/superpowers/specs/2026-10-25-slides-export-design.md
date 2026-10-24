# 设计：单文档导出 reveal.js 演示文稿（v1）

- 状态：设计完成，待实现
- 日期：2026-10-25
- 来源：评估 `.others/quarkdown`（Kotlin 排版系统）可移植功能时选定的第一项；PDF 排版改造（Paged.js）与 Emoji 短代码随后各立一案
- 决策原则锚定：md 源文件保持标准 GFM，不引入私有标记；产物离线可用；复用既有渲染管线与导出链路

## 一、背景与目标

现有导出入口三个：单文档 HTML（`app.export`）、整库静态站（`app.exportSite`）、Word（`app.exportWord`），放映型文档没有出路。本批加第四个入口 `app.exportSlides`：把当前一篇 md 编译成单个自包含 HTML，内联 reveal.js，双击即可放映、可直接发给别人。

切分规则对齐 Obsidian 幻灯片插件与 Quarkdown 的兼容思路：默认按 `##` 切片，文档里出现 `---` 时以 `---` 优先。`---` 是标准 GFM 水平线，文档在 Typora/Obsidian 里打开完全不受影响。

## 二、范围

**包含**
- 切片：顶层 `---` 优先，否则按 `##`；引言页；`::: notes` 演讲者备注进 reveal notes（按 S 开演讲者视图可见）。
- 渲染：走 `site-export.js` 同款的全保真管线（编辑器 tokenizer 挂 HTML 渲染规则 + `sanitizeHtml`），wikilink、callout、数学、任务清单在片内正常显示。
- 产物：单个自包含 HTML，reveal.js dist（脚本、核心样式、主题、notes 插件）全部内联，无 CDN 依赖即可放映。

**不包含（YAGNI / 后续）**
- 整库编译成一套幻灯片（下一个子项目，走 `app.exportSite` 的路子）。
- 垂直分页（reveal 的嵌套 section）、`<section data-…>` 定制、主题选择与 frontmatter 覆盖、导出选项对话框。
- mermaid 图表在片内渲染成图——v1 代码块原样保留（与现有单文档 HTML 导出一致）。

## 三、切片规则（`src/slides-export.js`，纯逻辑可单测）

新模块，输入 md 字符串，输出 `{ slides: [{ body: string, notes: string }], title: string }`；I/O 与渲染由调用方注入，便于 Node 单测（沿用 `site-export.js` 的做法）。

1. 先按顶层水平线切片：只有 `---`（markdown-it hr token 且 `markup` 为连字符）算切片，`***` / `___` 按普通水平线渲染进当页——正文里用作强调分隔的星线不该被误切。
2. 无 `---` 时按 `##` 切片，`##` 本身留在该片开头（作页标题）；片内的 `###` 及更深层级只是普通标题。
3. 第一个切片点之前的内容独立成首页：H1 + 首段，天然形成标题页；没有 H1 就退化为普通一页。
4. 每片内 `::: notes` … `:::` 之间的内容摘出进该片的 `notes`，`:::` 行本身不进正文；块内是多行纯文本/markdown，单独走一遍渲染放进 `<aside class="notes">`。
5. 切片在 markdown-it 的 token 流上做（hr / heading_open 深度判断），不按原始文本正则切——否则代码块、表格里的 `---` 和 `##` 会切坏内容。

## 四、组件划分

### 前端
- **`src/slides-export.js`（新增）**：切片 + 渲染 + 产物拼装。对外暴露 `buildSlidesHtml(md, { title, assets })`，返回完整 HTML 字符串；`assets` 由构建期注入 reveal 内联资源。
- **`src/main.js`（接线）**：`app('app.exportSlides', …)`，注册进现有导出命令组；行为对齐 `exportHTML()`——canvas 模式拦截（`status.canvasNoHtml` 同款文案另立词条）、`splitFrontmatter` 剥头、`pickSaveAs`（默认名 `xxx.slides.html`）、`exportFile` 落盘、状态栏提示。不占默认快捷键，注册表里默认键留空，可在快捷键设置里绑。
- **reveal.js 资源内联（vite 构建期）**：新增 npm 依赖 `reveal.js@^5`（MIT）。用 vite 的 `?raw` 导入把 `dist/reveal.min.js`、`dist/reveal.min.css`、主题 css、`plugin/notes/notes.js` 读成字符串，经 `slides-export.js` 的 `assets` 参数拼进产物。

### Rust
无改动。读文档、写盘都复用现成链路（`editor.getMarkdown()` + `exportFile`）。

## 五、渲染方案

- 复用 `editor-schema.js` 导出的共享 `tokenizer` 实例挂渲染规则（site-export 既有做法：编辑器只 tokenize 不 render，挂规则零污染），不新建 `exportMd` 那种低配实例——幻灯片里出现 wikilink、callout、公式时保真度对齐整库导出。
- 数学公式：`katex.renderToString`（同 site-export）；KaTeX css 与字体沿用现有导出的 CDN 引用（jsdelivr），产物放映需联网加载公式字体——reveal 本体不依赖网络，断网时公式降级显示，接受。
- 演讲者视图是单文件形态下的一个坑：reveal notes 插件按 S 会 `window.open('plugin/notes/notes.html?client=true')`，单文件没有这个资源。处理：把 `notes.html` 内容也内联进产物，并在注入的初始化脚本里把插件对该路径的请求改写到 blob URL（`URL.createObjectURL(new Blob([...]))`），S 键照常弹出演讲者窗口。
- 图片相对路径：`![](./assets/x.png)` 在产物里按导出文件所在目录解析，与现有单文档 HTML 导出同款行为，不新增处理。

## 六、i18n

- 命令 `cmd.app.exportSlides`、菜单项 `menu.*`、状态与消息 `status.*` / `msg.*` 进 `src/locales/` 五份（zh-CN / zh-Hant / en-US / fr-FR / de-DE）。
- 后端无改动，`ui_lang.rs` 不动。

## 七、测试

`tests/slides-export.test.mjs`（jsdom，参照 `site-export.test.mjs` 的结构）：
- 切片三分支：有 `---` 按它切且 `***` 不切；无 `---` 按 `##` 切且 `###` 不切；引言独立成首页。
- 代码块 / 表格里的 `---` 与 `##` 不触发切片（token 流切片的意义所在）。
- `::: notes` 摘取：notes 不出现在正文、进对应片的 `<aside class="notes">`；无 notes 片不含 aside。
- 产物：含内联的 reveal.min.js 与主题 css；`<section>` 数量与切片数一致；notes.html blob 改写脚本存在。

## 八、验收

一篇含 H1、多个 `##`、一个表格、一段公式、一组 `::: notes` 的真实笔记导出后：双击打开能翻页放映，公式正常渲染，按 S 弹出演讲者视图且备注可见；同一 md 在 Typora 里打开内容不变。
