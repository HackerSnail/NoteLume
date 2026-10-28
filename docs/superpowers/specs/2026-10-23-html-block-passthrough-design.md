# 裸 HTML 块（html_block）· 设计 spec

## 1. 现状与动机

外部导出的 md（WordPress → Hexo 一类）常把正文写成块级 HTML。语料侧统计：60 篇里 57 篇含块级 HTML 行，标签分布 `br` 3207 / `p` 1837 / `code` 1551 / `td` 1328 / `figure` 688 / `tr` 492 / `img` 465 / `h2` 357 / `h3` 328 / `strong` 320 / `pre` 308 / `li` 307 / `a` 194 / `table` 53 / `blockquote` 51，属性 `class` 2774 处（`wp-block-heading` 752、`wp-block-image` 465、`has-text-align-center` 187、`has-vivid-red-color` 80 等）。

当前行为：主 tokenizer 是 `MarkdownIt('commonmark', { html: false })`（[src/editor-schema.js:440](../../src/editor-schema.js)），每个 HTML 块落成一个普通段落、正文里是字面标签文本——无排版、无标题层级、不进大纲。

不能只把 `html` 改 true：prosemirror-markdown 的默认 schema 节点表只有 `paragraph blockquote horizontal_rule heading code_block ordered_list bullet_list list_item text image hard_break`，没有承载裸 HTML 的节点；实测以 `html: true` 的 tokenizer 过 `MarkdownParser` 直接抛 `Token type 'html_block' not supported by Markdown parser`。所以 `html: false` 是「宁可显示成字面文本也不静默丢内容」的既有取舍，本 spec 要补的是模型里缺的那一层。

## 2. 关键决策

* 保真取向：照 Typora——原样保留 + 渲染。文件里的 HTML 一字不改，编辑器里显示渲染结果，点开是源码。
* 安全口子：一律不执行脚本，净化后渲染（标签/属性白名单 + 剥 `on*`、`script`、`style` 标签、`iframe`、`javascript:`）。

## 3. 目标 / 非目标

目标：
* schema 新增原子块节点 `html_block`（存原文字符串）。
* 解析走「占位—还原」两阶段，与既有合并表同一族机制。
* 序列化原样写回，未编辑的块字节级不变。
* 渲染层净化 + 主题排版继承；单击原地切源码编辑（块内图片除外：单击放大查看）。
* 大纲穿透（HTML 块里的 `h1`–`h6` 计入大纲）。

非目标：
* 不把 HTML 转成 Markdown 语法（与 §2 首条相反的那条路）。
* 不做行内 `html_inline`（段落里混 `<span style>` 这类），只处理块级。
* 不做 `html_block` 内图片的拖拽缩放（`=Wx` 无损写回只服务真 image 节点）。
* 不承诺 WordPress 专属 class 生效（`has-*` 不映射，见 §13 第 1 条）。

## 4. 架构与模块边界

| 模块 | 职责 |
| --- | --- |
| `src/editor-schema.js` | `html_block` 节点定义；`extractTableHTML` 扩为 `extractHtmlBlocks`（一趟扫描出 `{kind, source}` 列表）；还原阶段分派；serializer 加 `html_block` 分支 |
| `src/html-sanitize.js`（新） | DOMParser 解析 → 白名单过滤 → 返回可安全 `innerHTML` 的字符串；纯函数，无视图依赖 |
| `src/html-block-images.js`（新） | 块内 `<img>` 的加载：远程 / 内联 / blob 透传，相对路径按当前文档读库内字节转 data: URI；与正文图片共用一个结果缓存，只改 DOM |
| `src/editor-view.js` | `nodeViews.html_block`：渲染态 / 源码态切换、提交回写，渲染后调 `hydrateBlockImages` 换块内图片地址；`emitMeta` 顶层遍历穿透块内标题进大纲，`jumpToPos` 对原子块走整块 `NodeSelection` |
| `src/style.css` | `.nl-html-block` 容器与两种形态样式；正文排版靠既有后代选择器继承（`.ProseMirror h2`、`.ProseMirror p`、`.ProseMirror blockquote` 见 style.css:2527-2550），无需重复定义 |
| `src/site-export.js` | 站点导出：渲染那一趟临时开 `html`，`html_block` 走净化，块内 `<img>` 与普通图同一套 `resolveImageRel` 镜像到 `assets/` |
| `src/main.js` | 单篇 HTML 导出：独立的 `html:true` 渲染实例，`html_block` 走净化，图片不改写路径（单文件产物，沿用普通图的既有行为） |
| `src/docx-export.js` | Word 侧无对应结构，`html_block` 降级为纯文本段落 |

## 5. 解析规则

扫描：不自己写状态机，借 markdown-it 的 `html_block` 规则划块——把共享 tokenizer 的 `options.html` 在这一趟临时置 true，`parse` 出的 `html_block` token 带 `map=[起始行,结束行]`，块边界与 CommonMark 完全一致（类型 1 的 `pre`/`script`/`style`/`textarea` 只认闭合标签、空行不断块；其余认到空行；围栏之内天然不误伤）。扫描完立刻还原开关，编辑器解析仍是 `html:false`。

只接管顶格块：行首非 `<` 的（列表项 / 引用里缩进的）交回原样。起始标签再过一道白名单——CommonMark 类型 6 名单 + 类型 1 那四个 + 注释/声明/CDATA；刻意不收类型 7（任意标签独占一行），因为 `<a id="…"></a>` 与 `<mark data-color=…>` 是自定义行内规则（anchor / highlight）的载体，独占一行时也得继续走行内规则。

占位：`{{nl-html-N}}` 独占一个段落，与既有 `{{nl-table-N}}` 同一族但正则分开，避免互相吞。

还原：由后往前 `replaceWith`（同 `restoreTables`）。分派规则——
* 单行 `<table>…</table>`：仍走既有 `parseTableSlice` 还原成真表节点（本仓库自序列化的合并表必须继续可编辑，这是既有能力，不回退）。
* 其余（含多行 HTML 表）：还原为 `html_block` 节点，`source` 存原始文本。

## 6. 序列化与落盘

`html_block` 写出 `source` 原样，前后各留一个空行；除首尾空白外不做任何改写（属性顺序、缩进、自闭斜杠一律保留）。落盘仍走既有「内容变了才写」的路径，未编辑的块在保存后与原文件逐字节相同。

幂等判据：`serialize(parse(x)) === serialize(parse(serialize(parse(x))))`，且对纯 HTML 文件 `parse` 后不编辑直接 `serialize` 应等值于原文（首尾空白规范化除外）。

测试夹具一律合成，不引用外部真实博客正文。

## 7. 净化（渲染层）

净化器与站点 / 单篇 HTML 导出共用同一份（`src/html-sanitize.js`）。DOMParser 解析后按白名单重新拼字符串输出，不走 `innerHTML = tree.innerHTML`（那条路会引入 mXSS 差异）。

* 保留标签：`p div span h1 h2 h3 h4 h5 h6 hr br wbr strong em b i u s sup sub mark code pre kbd samp var q cite blockquote ul ol li dl dt dd table thead tbody tfoot tr th td caption colgroup col figure figcaption img a details summary time abbr bdi bdo ruby rt rp`。
* 整块丢弃（连内容）：`script style iframe object embed link meta base form input button textarea select option noscript template svg math canvas head body html frame frameset applet audio video source track portal`。
* 保留属性：`class id title href src alt style colspan rowspan start reversed type width height headers scope abbr align valign`；任意 `on*` 一律不写；`type` 只留 `<ol>` 的编号样式（`1 a A i I`）。
* `href` 只收 `http https mailto tel` 与相对 / `#` 地址，`src` 另允许 `data:image/(png|gif|jpg|jpeg|webp|avif)`；协议相对 `//host` 不收。
* `style` 只收 `text-align width height max-width min-width object-fit font-weight font-style color background-color margin margin-left margin-right padding padding-left border-collapse`，值里含 `url()` / `expression` / `javascript:` / `@import` / `<` 的整条丢弃。
* 未知标签脱壳留文字（`<small>`、`<font>` 不丢字），注释不进渲染。
* 渲染：净化结果 `innerHTML` 写进 `contenteditable="false"` 的容器；原子块不进光标。容器内 `white-space: normal`——编辑区继承下来的 `pre-wrap` 是为光标映射，原子块里没有可映射的文本，照抄会把源码换行变成真换行（三枚徽章各占一行）。
* 净化后为空分两种：纯注释块（README / 文章末尾的 `<!-- links -->` 之类）整个不显示，与 Typora 一致；其余（纯 `<script>` / `<style>`）容器退回显示源码原文（`.nl-html-raw`），不静默丢内容。
* 块内图片：`src` 是相对地址时，webview 直接加载会解析到应用自身 origin（`tauri://localhost/img/…`），与正文图片此前的问题同源。渲染后由 `hydrateBlockImages` 按 `vaultRoot + mdRel + src` 读库内字节换成 data: URI；`http(s)` / `data:` / `blob:` 原样透传并挂 `no-referrer`；读不到时摘掉 `src`、标 `.nl-img-missing`、`title` 留原路径，`alt` 文本照旧显示。缓存与正文图片共用，切回同一文档不重读；只改 DOM，`attrs.source` 与序列化不动。

## 8. 就地编辑

单击块 → 原地换成 textarea（预填 `source`），失焦或 Esc 提交 → 更新 `attrs.source` → 重新净化渲染；改成全空白则删掉该块（不留下空块占位）。不加按钮、不加弹窗（直接按住对象操作）。提交产生事务，脏标记与既有自动保存一致。块内链接不跟随（免得 webview 整页跳走）。

框的高度按源码内容给满：`rows` 取源码行数不封顶，再按实测 `scrollHeight` 加高一次（长行折行时行数不够），`resize: none` + `overflow: hidden`，不留拉伸把手也不出滚动条。

落点在 `<img>` 上是例外：这一击交给全屏查看器放大（`html-block-images.js` 的 `openIslandImage`，data URI / 外链直接用现成 `src`，还没装成的相对路径按当前文档回库读一趟），不把块切成源码；Quarkdown 快照同一口径。

## 9. 周边一致性

* 大纲：`emitMeta`（`src/editor-view.js`）在顶层遍历时用 `htmlHeadings(source)`（`src/html-sanitize.js`）抽 `h1`–`h6` 的层级与文本计入；跳转落到块位置——原子块没有可放光标的块内位置，故 `jumpToPos` 走整块 `NodeSelection`，靠 nodeView 的 `selectNode` 描边并滚动。
* 字数 / 阅读时长：不计 `html_block` 内容（与代码块 / 公式同口径，见 §13 第 2 条）。
* 查找替换：只在真节点上工作，不穿透 HTML 源码。
* 折叠 / 大纲模式 / 段落菜单：`html_block` 不参与块型转换（原子块）。
* 站点导出 / 单篇 HTML 导出：两处都要 `html_block` 出元素——站点那一趟把共享 tokenizer 的 `options.html` 临时置 true 再还原，单篇导出用独立的 `html:true` 实例；`html_block` 一律过净化，站点侧块内 `<img>` 与普通图同一套 `resolveImageRel`，命中即登记 `env.assets` 并改写为相对路径，单篇侧不改写路径；行内 `html_inline` 两处仍按转义文本渲染（markdown-it 把 `<b>x</b>` 拆成三个 token，逐个净化会拆散配对），与编辑器口径一致。
* Word 导出：`html_block` 降级为纯文本段落（`htmlToPlain`：剥标签、整块丢弃的标签连内容一起去掉），不静默丢内容。

## 10. 错误处理矩阵

| 情况 | 行为 |
| --- | --- |
| 围栏代码块内的伪标签 | 不动（状态机跳过） |
| frontmatter 内出现 `<` | 不动（frontmatter 先于正文切走） |
| 未闭合标签 | DOMParser 容错渲染，`source` 原样写回 |
| 整块被净化成空 | 纯注释块整体隐藏；纯脚本 / 样式块退回显示源码原文（`.nl-html-raw`）。都不删块 |
| 占位串在正文里自然出现（`{{nl-html-0}}`） | 还原时按占位表索引取，取不到则原样保留该段落文本 |

## 11. 测试策略

* `src/tests/html-block.test.mjs`：占位与还原、实体不被二次转义、属性顺序与自闭斜杠原样、整篇序列化幂等、多行 `<figure>` 包表仍归 `html_block`、单行自序列化表仍归 table、围栏内不误伤、未闭合标签收到空行为止、HTML 块打断段落、列表项里缩进的不接管、`html_block` 为 atom、空文档与纯 markdown 文档不受影响。
* `src/tests/html-sanitize.test.mjs`：白名单（`on*` / `script` / `javascript:` / `data:text/html` / 协议相对地址 / style 白名单外声明全剥）、`ol` 的 `type` 只留编号样式、未知标签脱壳留文字、mXSS 嵌套探针、`htmlHeadings` 的文档序与文本压平。
* `src/tests/site-export.test.mjs`：块渲染成元素、脚本与事件属性进不了发布物、块内 `<img>` 镜像到 `assets/`、行内字面 HTML 仍是转义文本、临时开 `html` 不抢 anchor / highlight、渲染完开关复位。
* `src/tests/docx-export.test.mjs`：`html_block` 降级段落的文本与剥净标签。
* 回归：`src/tests/roundtrip.test.mjs` 全量、既有合并表两阶段用例不破、`src/tests/` 全部文件按退出码跑一遍。
* 浏览器侧：无头 Chromium 装载构建产物 + 合成夹具，核对渲染样式、单击切源码、点块内图片出全屏查看器、Esc / 失焦提交、空提交删块、大纲计入与整块选中跳转、未编辑块与原文件逐字节一致。

## 12. 落地分相

* P0：schema 节点 + 解析/序列化 + 模型层单测（可独立合入，此时块仍显示为原子块文本）。
* P1：净化模块 + nodeview 渲染 + CSS（这一相结束才有「有样式」的可见结果）。
* P2：就地编辑 + 大纲穿透。
* P3：站点导出侧开 `html` + 图片抽取认 `html_block` 里的 `<img>`（§13 第 3 条）。

## 13. 范围裁定

1. WordPress 的 `has-*` 类不补映射：居中 187 处、`has-vivid-red-color` 80 处、字号类一律不生效，只吃通用排版（与 Typora 行为一致）。
2. 状态栏字数与阅读时长不计入 `html_block` 内容（与代码块 / 公式的既有口径一致）。
3. 站点导出与 P0–P2 同期落地：`src/site-export.js` 的渲染器开 `html`，导出的静态网页按 HTML 正常渲染；图片路径解析（`resolveImageRel`）要同时认 `html_block` 里的 `<img src>`，否则图不落地。
