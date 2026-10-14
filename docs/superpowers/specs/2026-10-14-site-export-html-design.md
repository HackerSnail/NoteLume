# 批次 C 设计：整库导出 HTML 静态站

- 状态：设计已获批准，待写实现计划
- 日期：2026-10-14
- 决策原则锚定：纯文件、无自建服务器；无损互操作（GFM/Obsidian）；不引 UI 框架；复用优先；警惕外部二进制依赖

## 一、背景与目标

现有「导出为 HTML」只处理**当前单篇**：把正文经基础 markdown-it（commonmark + table + strikethrough）渲染成独立 HTML，不含 `[[wikilink]]`、callout、数学、`![[嵌入图]]`，也不动图片资源。

本批把它升级为**整库导出**：遍历当前知识库，逐篇渲染为**全保真** HTML，重写跨笔记链接与图片，生成侧栏树 / 反向链接 / 首页 / 纯前端搜索，产出一个可整体拷走、本地双击即可浏览的静态站（"本地维基"）。

## 二、范围

**包含**
- 全保真渲染：GFM（表格/删除线/任务清单）+ callout + 数学（KaTeX）+ `[[wikilink]]` + `![[图片嵌入]]` + `#tag`（降级为文本锚点）。
- 跨笔记链接重写：wikilink 与 `.md` 相对链接 → 站内 `.html`。
- 图片自包含：引用到的图片按相同相对路径复制进输出目录。
- 导航：每页侧栏整库文件树（当前项高亮）+ 页尾反向链接；独立首页。
- 搜索：导出时生成 `search-index.json`，附无依赖的纯前端 `search.html`。

**不包含（本批 YAGNI / 后续）**
- 画布 `.canvas` 不进静态站（与单篇导出一致）。
- 数学字体完全离线打包（沿用 KaTeX CSS 走 CDN，见 §7）。
- pandoc 导 DOCX/PDF（路线图列为"检测到才启用"的独立可选项，不在本批）。
- 大库批量读优化（先逐文件循环，实测慢再补命令）。

## 三、架构与数据流

```
用户 → ▾ 更多 → 「🌐 导出整站…」
  → pickFolder 选输出目录 outDir
  → build_site_graph(vaultRoot)            [Rust]  一次拿到 docs + wikilink 解析表
  → 对每个 md：readMdFile(vaultRoot, rel)  [复用]  取原文
        strip frontmatter → renderSiteHtml(md, ctx)  [前端 site-export.js]
        渲染时从 token 收集该页图片引用（普通 ![]() + ![[嵌入]]）→ 累积到全局拷贝清单
  → copy_vault_assets(vaultRoot, 去重后的图片rels, outDir)  [Rust]  镜像相对路径拷贝
  → 生成每页 HTML（注入侧栏树 + 反链）+ index.html + search.html + search-index.json + assets/site.css
  → 逐个 exportFile(outDir + '/' + relHtml, html)  [复用]  写盘（已 create_dir_all）
  → 状态栏报进度与结果
```

`ctx`（渲染上下文）持有：`rel → 站内 .html 路径` 映射、`当前页 rel`、图片重写的判定，供渲染规则把链接落到正确目标。

## 四、组件划分

### 前端
- **`src/site-export.js`（新增）**：导出主逻辑。职责：建图消费、逐篇读取与渲染、链接/资源重写、导航与反链片段生成、首页/搜索索引构建、写盘编排、进度回调。对外暴露一个 `exportSite({ vaultRoot, outDir, tree, setStatus })` 入口。
- **`src/editor-schema.js`（微改）**：把模块内构造 markdown-it 的那段（`const tokenizer`，含全部自定义 token 规则）重构成工厂 `makeTokenizer()`；编辑器仍用其单例（`mdParser` 不变），**额外导出该工厂**供 site-export 新建**自己的实例**并挂 HTML 渲染规则，互不污染。不改任何解析行为。
- **`src/main.js`（接线）**：`openMoreMenu` 增加「🌐 导出整站…」项 → 选目录 → 调 `exportSite`；无库时提示先打开知识库。

### Rust（2 个新命令）
- **`build_site_graph(vault_root) -> SiteGraph`**
  - `SiteGraph { docs: Vec<{ rel, title }>, wiki: Vec<{ from, target, to: Option<String> }> }`
    - `wiki` 每条 = 某文档 `from` 里出现的一个**原始 wikilink 文本** `target` → 解析到的库内 `rel`（`to`，解析不到为 `None`）。**必须带 `target`**，因为渲染 `[[target]]` 时按 (当前页, target) 查表拿落地路径。
  - 遍历库内 md，复用现成 `extract_wikilinks` + `resolve_one` 解析每个 wikilink（含 basename 全库回退）。`title` 取首个 `#` 或文件名主干。
  - **只覆盖 wikilink**（导航/反链/wikilink→.html 解析用）；普通 `![]()` 图片与 `.md` 相对链接不经此命令，由前端渲染时处理。
  - 目的：把 wikilink 解析这一有状态、易漂移的逻辑留在 Rust 单一实现里，前端不重复。
- **`copy_vault_assets(vault_root, rels: Vec<String>, out_dir) -> ()`**
  - 对每个 `rel`：`abs_in_vault` 校验 → 读字节 → 写到 `out_dir/rel`（`create_dir_all` 父目录）。
  - 仅复制被引用到的图片，不整库盲拷。

> 读文件复用 `read_md_file`，写文本复用 `export_file`（其已 `create_dir_all(parent)`），故不新增读/写命令。

## 五、渲染方案（R1：复用同一 markdown-it 管线）

- 用 `makeTokenizer()` 新建实例得到 HTML 主体。因其 token 化与编辑器**完全一致**，callout/数学/wiki/task 的 token 结构天然对齐，只需为自定义 token 补 HTML 渲染规则：
  - `wiki_link` → `<a class="nl-wiki" href="{站内 .html}">{label|target}</a>`；解析失败 → `<span class="nl-wiki nl-wiki-missing">{label}</span>`（不产生坏链）。
  - `wiki_img`（`![[x.png]]`）→ `<img src="{相对路径}" alt>`，并把该资源加入本页拷贝清单。
  - `math_inline` / `math_block` → `katex.renderToString(latex, { throwOnError:false })` 的结果（inline/display）。
  - `callout` → `<div class="callout" data-callout="{type}">…</div>`（沿用编辑器类名，样式在 site.css 提供）。
  - `tag` → `<span class="nl-tag">#tag</span>`（纯展示）。
  - 任务清单 → 标准 `<ul class="contains-task-list"><li class="task-list-item"><input type=checkbox disabled>`。
- 普通链接重写：`[x](a/b.md)` → 换扩展名 `.html`（锚点 `#…` 保留）；`[x](a/b.md#sec)` → `a/b.html#sec`。图片 `![](p.png)` 路径不变（资源镜像到同相对位置）。
- 渲染规则挂在 **site-export 自建的 tokenizer 实例**上（由 `makeTokenizer()` 新建），不触碰编辑器解析用的单例。

## 六、输出目录结构（镜像库树）

```
outDir/
  index.html            首页：库标题 + 整库文件树
  search.html           纯前端搜索页（内联脚本 + 拉取 search-index.json）
  search-index.json     [{ title, href, text }]
  assets/site.css       共享样式（单篇导出 CSS 基线 + callout/侧栏/数学/任务清单补充）
  <镜像库内相对路径>/*.html   每篇 md → 同相对位置的 .html
  <镜像的图片相对路径>        仅被引用到的图片
```

镜像整棵树后，**相对链接与图片天然可解析**，仅需 `.md`→`.html` 换扩展名；wikilink 与嵌入图靠 `build_site_graph` 落到确切目标。

## 七、导航 / 反链 / 首页 / 搜索

- **侧栏树**：由 `tree`（scanVault 结果，过滤掉 canvas）生成嵌套 `<ul>` 片段，逐页注入；当前页加 `.active`。
- **反向链接**：由 `SiteGraph.wiki` 反推 `to → [from…]`，在页尾列「被这些文档引用」。
- **首页**：库标题 + 完整侧栏树（无正文）。
- **搜索**：导出时把每篇标题 + 正文纯文本（复用 Rust 已有的去标记纯文本逻辑或前端 strip）写入 `search-index.json`；`search.html` 内联一段无依赖脚本：加载 json，按关键词过滤（空格分词 + 中文子串匹配），列出命中（标题 + 摘要 + 链接）。零服务器、零新 JS 依赖。
- **数学样式**：`site.css` 里 `<link>` 引 KaTeX CDN CSS（与单篇导出一致）；完全离线字体打包列为后续可选项。

## 八、边界与错误处理

- 未打开知识库 → 菜单项提示先打开库，不执行。
- 输出目录为空/取消选择 → 中止，无副作用。
- 输出目录已有同名文件 → 覆盖（导出即重建快照语义）；文档级错误（单篇读/渲染失败）记入日志、跳过不中断整站，末尾汇总「N 篇成功 / M 篇跳过」。
- wikilink 指向库外/解析不到 → 渲染为纯文本，不产坏链。
- 循环写盘为串行，避免同时打开过多文件句柄；进度写状态栏。
- 路径安全：`copy_vault_assets` 走 `abs_in_vault` 防逃逸；`out_dir` 由用户对话框选定。

## 九、测试计划

- **Node 纯逻辑单测**（`src/tests/site-export.test.mjs`）：
  - 链接重写：`.md`→`.html`、带 `#锚点`、wikilink→解析相对 `.html`、解析失败→纯文本。
  - backlinks 反推正确性（给定 wiki 数组）。
  - 搜索索引构建（标题 + 去标记正文）。
  - 相对路径镜像映射（md rel → html rel；图片 rel 收集去重）。
- **渲染保真**：`npm run build:web` 无错 + 手动导一个含 callout/数学/嵌入图/wikilink/任务清单的样例库，浏览器目测与站内互跳。
- **Rust**：`build_site_graph` / `copy_vault_assets` 加 `#[cfg(test)]` 单测（路径解析、拷贝、逃逸拒绝），`cargo test` 通过。

## 十、交付与验证流程

1. 前端 `npm run build:web` 无错；`cargo test`（含新命令单测）通过；Node 单测通过。
2. **因含 2 个新 Rust 命令，须重启 `tauri dev` 重编**方生效（仅前端刷新不够）。
3. 逐文件 `git add` + 中文 commit（UTF-8 文件 + `git commit -F`）+ push `origin/master`（Gitee）。
4. 回填 `CHANGELOG.md`（Added）、`README.md`（特性/目录）、`docs/ROADMAP.md`（批次 C 标完成）。

## 十一、影响与风险

- 新增 2 个 Rust 命令 + 前端主逻辑模块，属成规模子系统；实现将按 spec → 实现计划拆分步骤推进。
- 主要正确性风险在渲染保真（R1 规则需与编辑器输出一致）与链接解析一致性（统一走 `build_site_graph`）——均以单测 + 样例库目测兜底。
