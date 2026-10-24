# 单文档导出 reveal.js 演示文稿 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新增 `app.exportSlides`：当前一篇 md 编译成单个自包含 HTML（内联 reveal.js），双击可放映，`::: notes` 进演讲者视图。

**Architecture:** 纯逻辑切片在 token 流上做（新模块 `src/slides-export.js`），每片正文复用 `site-export.js` 的 `renderSite` 渲染；reveal.js dist 经 vite `?raw` 读成字符串内联（新模块 `src/slides-assets.js`）；`main.js` 挂命令与菜单，沿用 `exportHTML` 的落盘链路。

**Tech Stack:** Vanilla JS、markdown-it（编辑器共享 tokenizer）、reveal.js@^5（npm，MIT）、vite `?raw`、jsdom 单测。

**Spec:** `docs/superpowers/specs/2026-10-25-slides-export-design.md`

## Global Constraints

- md 源文件保持标准 GFM：切片只用标准语法（`---` / `##` / `::: notes` 文本），不引入任何私有标记。
- 产物为单个自包含 HTML，reveal 本体零外部依赖；KaTeX css 沿用现有导出的 CDN 引用（jsdelivr，版本 0.16.9）。
- 界面文案一律进 `src/locales/` 五份词条（zh-CN / zh-Hant / en-US / fr-FR / de-DE），不写死中文。
- 测试跑法：`cd src && node tests/slides-export.test.mjs`，package.json 加 `test:slides-export` 脚本，与既有 `test:*` 脚本同格式。
- 注释与文档写法按 CLAUDE.MD「文档写作要求」：直陈问题与改法，不写总结句。

## Review Focus

- 代码块、表格、引用块里的 `---` 与 `##` 不得触发切片（token 流切片的意义所在）→ Task 1 用测试钉住。
- `::: notes` 只有开头没有 `:::` 闭合时，期望到该片末尾都算 notes，不把标记行留在正文 → Task 1 测试钉住。
- 无 H1 的文档导出不报错，标题退化为调用方给的文件名 → Task 2 测试钉住。
- setext 式标题（`文字` 下接 `---` 下划线）在 markdown-it 里是 `heading_open`（markup 为 setext）而非 hr token：h2 模式下会计成切片边界（与 `##` 同类，符合预期），hr 模式下不切。实现里不做特判。
- notes.html 内联后不得残留 `src=` / 相对路径引用，否则演讲者窗口在 blob URL 里加载失败 → Task 2 测试钉住。

---

### Task 1: 切片器 `splitSlides`

**Files:**
- Create: `src/slides-export.js`
- Create: `src/tests/slides-export.test.mjs`
- Modify: `src/package.json`（scripts 加 `test:slides-export`）

**Interfaces:**
- Consumes: `tokenizer`（`src/editor-schema.js` 导出的共享实例，仅用 `.parse()`，不改解析行为；参考 `src/site-export.js` 挂规则的既有用法）。
- Produces: `splitSlides(md: string) -> { title: string, slides: Array<{ body: string, notes: string }> }`。`title` 是 md 里首个 atx 一级标题的文本（无则空串，调用方兜底）；`body` / `notes` 是原始 md 文本片段（此任务不渲染）。

- [ ] **Step 1: 写失败测试**

`src/tests/slides-export.test.mjs`，结构照 `src/tests/site-export.test.mjs`（`check(name, fn)` 计数、jsdom 只在用到 DOMParser 时才引）。本任务的用例：

```js
import { splitSlides } from '../slides-export.js'

// hr 模式：--- 切片，*** 不切
check('有 --- 时按 --- 切片，*** 当普通水平线', () => {
  const r = splitSlides('# T\n\nA\n\n---\n\nB\n\n***\n\nC')
  assert.strictEqual(r.slides.length, 2)            // [A], [B + hr + C]
  assert.ok(r.slides[1].body.includes('***'))
})

// h2 模式：无 --- 时按 ## 切，### 不切
check('无 --- 时按 ## 切片，### 不切', () => {
  const r = splitSlides('intro\n\n## One\n\nx\n\n### Sub\n\ny\n\n## Two\n\nz')
  assert.strictEqual(r.slides.length, 3)            // intro, One(+Sub), Two
})

// 代码块 / 引用里的 --- 与 ## 不切片
check('fence 与引用内的 --- / ## 不触发切片', () => {
  const r = splitSlides('```md\n## not a slide\n---\n```\n\n> ## quote\n> ---\n\n## Real')
  assert.strictEqual(r.slides.length, 2)
})

// ::: notes 摘取：进 notes、离开正文；未闭合时吃到片尾
check('::: notes 摘出且未闭合时吃到片尾', () => {
  const r = splitSlides('## S\n\n正文\n\n::: notes\n讲稿A\n:::\n\n后面\n\n---\n\n## T\n\n::: notes\n讲稿B')
  assert.ok(r.slides[0].body.includes('后面'))
  assert.ok(!r.slides[0].body.includes('讲稿A'))
  assert.strictEqual(r.slides[0].notes, '讲稿A')
  assert.strictEqual(r.slides[1].notes, '讲稿B')
  assert.ok(!r.slides[1].body.includes(':::'))
})

// title 取首个一级标题
check('title 取首个 # 标题', () => {
  assert.strictEqual(splitSlides('# T\n\nx').title, 'T')
  assert.strictEqual(splitSlides('x\n\n# T2').title, 'T2')
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd src && node tests/slides-export.test.mjs`
Expected: FAIL，`Cannot find module '../slides-export.js'`

- [ ] **Step 3: 实现 `src/slides-export.js` 的 `splitSlides`**

实现要点（签名与测试已定，此处只钉算法）：
1. `const lines = md.split('\n')`，`tokenizer.parse(md, {})` 拿 token 流。
2. 只扫 `level === 0` 的 token 定切片边界行：mode = 存在 `type === 'hr'` 且 `/^-{3,}$/.test(markup)` 时为 hr 模式（边界 = 这些 hr 的 `map[0]`），否则为 h2 模式（边界 = `heading_open` 且 `tag === 'h2'` 的 `map[0]`）。fence 内容在 `fence` token 里、引用/列表内容 `level > 0`，天然不参与。
3. 切片 = 按边界行号切 `lines`（首个边界前的引言为第一片；`map[0]` 即 `##` 行所在行，标题留在片内）。
4. 每片内做 notes 摘取：逐行扫，`/^\s*::: notes\s*$/` 开、`/^\s*:::\s*$/` 收（未闭合到片尾），标记行与内容行从 `body` 剔除，多段 notes 用 `\n\n` 连接进 `notes`。
5. `title`：首个 `# ` 行文本（只在 `md` 上做一次正则）。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd src && node tests/slides-export.test.mjs`
Expected: 全部 PASS

- [ ] **Step 5: package.json 加脚本并提交**

`src/package.json` 的 scripts 里加 `"test:slides-export": "node tests/slides-export.test.mjs"`（放在 `test:site-export` 旁）。

```bash
git add src/slides-export.js src/tests/slides-export.test.mjs src/package.json
git commit -m "feat: 幻灯片切片器 splitSlides（--- 优先，## 兜底，::: notes 摘取）"
```

---

### Task 2: 产物拼装 `buildSlidesHtml`

**Files:**
- Modify: `src/slides-export.js`
- Modify: `src/tests/slides-export.test.mjs`

**Interfaces:**
- Consumes: Task 1 的 `splitSlides`；`src/site-export.js` 的 `renderSite(md, ctx)`（单页全保真渲染，已含 wikilink/callout/katex/任务清单规则与 `sanitizeHtml`）；`src/html-sanitize.js` 的 `escapeHtml`（若未导出则在模块内自实现，参考 `main.js` 的同名函数）。
- Produces: `buildSlidesHtml(md: string, opts: { title?: string, assets: { revealJs, revealCss, themeCss, notesJs, notesHtml } }) -> string`。五个 assets 都是字符串，占位即可（真实值由 Task 3 注入）；`title` 缺省回退顺序：入参 → md 首个 H1 → `'Slides'`。

- [ ] **Step 1: 写失败测试**（追加到 `slides-export.test.mjs`）

```js
import { buildSlidesHtml } from '../slides-export.js'

const FAKE = { revealJs: '<reveal-js>', revealCss: '<reveal-css>', themeCss: '<theme-css>', notesJs: '<notes-js>', notesHtml: '<script src="notes.js"></script>' }

check('产物结构：section 数、内联资源、notes aside', () => {
  const html = buildSlidesHtml('## A\n\nx\n\n---\n\n## B\n\n::: notes\nn1', { assets: FAKE })
  assert.strictEqual((html.match(/<section>/g) || []).length, 2)
  assert.ok(html.includes('<reveal-js>') && html.includes('<theme-css>'))
  assert.ok(/<aside class="notes"><p>n1<\/p><\/aside>/.test(html)) // notes 也走渲染，段落包 <p>
  assert.ok(html.includes('cdn.jsdelivr.net/npm/katex@0.16.9/dist/katex.min.css'))
})

check('notes.html 内联去 src 引用并进 blob 改写脚本', () => {
  const html = buildSlidesHtml('## A', { assets: FAKE })
  const blob = html.slice(html.indexOf('NOTES_HTML'))
  assert.ok(!blob.includes('<script src='))          // src 已换成内联 notesJs
  assert.ok(blob.includes('URL.createObjectURL'))    // window.open 改写存在
})

check('无 H1 时不报错，title 退化为入参', () => {
  const html = buildSlidesHtml('## A', { title: 'my.note.html', assets: FAKE })
  assert.ok(html.includes('<title>my.note.html</title>'))
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd src && node tests/slides-export.test.mjs`
Expected: 新增 3 个用例 FAIL（`buildSlidesHtml is not a function` 或断言失败），Task 1 用例仍 PASS

- [ ] **Step 3: 在 `src/slides-export.js` 实现 `buildSlidesHtml`**

实现要点：
1. `splitSlides(md)` 切片；每片 `renderSite(slide.body, {})` 得正文，`notes` 非空时 `renderSite(slide.notes, {})` 包进 `<aside class="notes">…</aside>`，二者拼进 `<section>`。
2. notes.html 内联：把 `assets.notesHtml` 里的 `<script src="notes.js"></script>`（以 reveal dist 实际写法为准，见 Task 3 Step 1 的核对）替换成 `<script>` + `assets.notesJs` + `</script>`，替换后不得再含 `<script src=`。
3. 外壳顺序：`<style>{revealCss}{themeCss}` + 片内排印微调样式（参照 site-export 的 `siteCss()` 写法，控制 `section` 内标题/代码/表格的字号与间距）→ katex CDN `<link>` → `<div class="reveal"><div class="slides">…</div></div>` → 内联 `<script>{revealJs}</script>` → notes 插件注册与初始化脚本：`NOTES_HTML` 字符串 → `URL.createObjectURL(new Blob([NOTES_HTML], {type:'text/html'}))` → 包一层 `window.open` 改写（url 以 `plugin/notes/notes.html` 开头时改走 blob）→ `Reveal.initialize({ hash: true, plugins: [RevealNotes] })`。
4. `title` 经 `escapeHtml` 后进 `<title>`。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd src && node tests/slides-export.test.mjs`
Expected: 全部 PASS

- [ ] **Step 5: 提交**

```bash
git add src/slides-export.js src/tests/slides-export.test.mjs
git commit -m "feat: buildSlidesHtml 拼装自包含 reveal 产物（notes 进演讲者视图）"
```

---

### Task 3: reveal.js 内联资源模块

**Files:**
- Modify: `src/package.json`（dependencies 加 `reveal.js`）
- Create: `src/slides-assets.js`

**Interfaces:**
- Consumes: npm 包 `reveal.js@^5`（安装时取最新 5.x）。
- Produces: `export const slidesAssets = { revealJs, revealCss, themeCss, notesJs, notesHtml }`（五个字符串，供 `buildSlidesHtml` 的 `opts.assets`），命名与 Task 2 的 assets 形状一一对应。

- [ ] **Step 1: 安装依赖并核对 dist 实际路径**

Run: `cd src && npm i reveal.js@^5`
然后核对 `node_modules/reveal.js` 里实际存在的文件与 Task 2 假定的写法是否一致：`dist/reveal.min.js`、`dist/reveal.min.css`、`dist/theme/black.css`、notes 插件两个文件的真实路径，以及 `notes.html` 引用 notes.js 的确切标签写法（Task 2 Step 3 的替换串按它调整）。

- [ ] **Step 2: 创建 `src/slides-assets.js`**

用 vite `?raw` 导入五个文件（路径按 Step 1 核对结果）：

```js
import revealJs from 'reveal.js/dist/reveal.min.js?raw'
// …其余四个同形
export const slidesAssets = { revealJs, revealCss, themeCss, notesJs, notesHtml }
```

- [ ] **Step 3: 构建验证**

Run: `cd src && npm run build`
Expected: 构建成功，无 `?raw` 解析报错

- [ ] **Step 4: 提交**

```bash
git add src/package.json src/package-lock.json src/slides-assets.js
git commit -m "feat: reveal.js 内联资源模块（vite ?raw）"
```

---

### Task 4: 命令接线 + i18n

**Files:**
- Modify: `src/main.js`
- Modify: `src/locales/zh-CN.js`、`zh-Hant.js`、`en-US.js`、`fr-FR.js`、`de-DE.js`

**Interfaces:**
- Consumes: Task 2 的 `buildSlidesHtml(md, { title, assets })`；Task 3 的 `slidesAssets`；`main.js` 既有 `splitFrontmatter` / `pickSaveAs` / `exportFile` / `setStatus`（参考 `exportHTML()`，约 2838 行起）。
- Produces: 可用入口 `app.exportSlides`（命令面板、菜单、快捷键设置三处可见，默认无快捷键）。

- [ ] **Step 1: main.js 接线**

1. import `buildSlidesHtml` 与 `slidesAssets`。
2. `app('app.exportSlides', null, () => exportSlides())`，注册在 `app('app.export', …)` 旁（约 3114 行）。
3. `exportSlides()` 照抄 `exportHTML()` 的骨架，差异四处：canvas 拦截的提示用 `t('status.canvasNoSlides')`；默认名 `state.currentFile.replace(/\.md$/i, '.slides.html')`；产物 `buildSlidesHtml(md, { title: state.currentFile, assets: slidesAssets })`；成功提示 `t('status.exportedSlides', { abs })`。失败复用 `msg.exportFailed`。
4. 菜单：`addMenuCmd(menu, 'app.exportSlides', 'export')` 加在 `app.export` 那行旁（约 1564 行）；`MENU_NEEDS_DOC` 集合（约 3256 行）加入 `'app.exportSlides'`。

- [ ] **Step 2: 五语言词条**

每份 locale 加三条：`cmd.app.exportSlides`（导出为演示文稿 / Export as presentation… 等）、`status.canvasNoSlides`、`status.exportedSlides`（带 `{abs}` 占位）。zh-CN 直陈，其余四语言按既有词条的措辞习惯对齐（参考 `app.exportSite` 各语言的写法）。

- [ ] **Step 3: 跑相关测试**

Run: `cd src && npm run test:i18n && node tests/slides-export.test.mjs`
Expected: 两个都 PASS（i18n 测试会查五语言键齐平）

- [ ] **Step 4: 手动验收（spec §八）**

Run: `cd src && npm run tauri dev`
验收清单：打开一篇含 H1、多个 `##`、表格、公式、`::: notes` 的真实笔记 → 导出为演示文稿 → 双击产物翻页放映正常、公式渲染、按 S 弹演讲者视图且备注可见；同一 md 在 Typora 里打开内容不变；命令面板与快捷键设置里能看到新命令。

- [ ] **Step 5: 提交并推送**

```bash
git add src/main.js src/locales/
git commit -m "feat: 导出为演示文稿入口 app.exportSlides 与五语言词条"
git push
```
