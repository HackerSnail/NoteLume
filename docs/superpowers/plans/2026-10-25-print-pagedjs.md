# Ctrl+P 打印排版增强（Paged.js）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ctrl+P 先弹排版选项窗（目录 / 页码+页眉 / H1 起新页 / 封面，记住上次选择），确认后 Paged.js 预分页再走系统打印，失败回退老打印。

**Architecture:** 纯函数（锚点、目录、打印样式 CSS、选项存取）与 DOM 编排分离：`print-paged.js` 出纯函数与 `printPaged(options)` 编排，`print-options-dialog.js` 出选项窗，`main.js` 的 `app.print` 改走分支。内容源是焦点窗格 `.ProseMirror` 的 DOM 克隆（图片已是 data URI），预分页进 `#print-root`，`body[data-paged-print]` 标记配 `@media print` 隔离应用壳。

**Tech Stack:** Vanilla JS、pagedjs@^0.4（npm，MIT，Previewer API）、jsdom 单测。

**Spec:** `docs/superpowers/specs/2026-10-25-print-pagedjs-design.md`

## Global Constraints

- 入口不动：Ctrl+P 默认键、菜单注册、`MENU_NEEDS_DOC` 均保持现状；canvas 模式直出老打印。
- 排版偏好存 localStorage `nl-print-options`，不进 settings.json；坏数据回落默认。
- 页型与边距维持现状：A4、`@page { margin: 18mm 20mm }`，不加纸型选项。
- 测试跑法：`cd src && node tests/print-toc.test.mjs`，package.json 加 `test:print-toc` 脚本。
- 注释与文档按 CLAUDE.MD「文档写作要求」：直陈问题与改法，不写总结句。

## Review Focus

- 封面 / 目录勾选后，首个 H1 不得再分出空首页——H1 分页规则是 `.nl-pbody h1 { break-before: page }` 且首个 H1 例外，目录与封面在 `.nl-pbody` 之外 → Task 1 用测试钉住 printStyles 的产出。
- 标题里的引号 / 反斜杠进 `@top-center` 的 CSS 字符串要转义，否则整条打印样式静默失效 → Task 1 测试钉住（标题含 `"` 与 `\` 时不产生非法 CSS）。
- 预分页抛错（长文档超时、布局异常）必须回退 `window.print()`，不能让用户点打印没反应 → Task 3 编排里 try/catch 兜底，真机验收覆盖。
- 打印完必须摘掉 `data-paged-print` 标记与 `#print-root`，否则下一次打印叠一层旧容器 → Task 3 的 `finally` 清理，真机验收连打两次确认。
- localStorage 里坏 JSON / 缺字段回落默认值，不抛错 → Task 1 测试钉住。

---

### Task 1: 纯函数与选项存取（`src/print-paged.js` 前半）

**Files:**
- Create: `src/print-paged.js`
- Create: `src/tests/print-toc.test.mjs`
- Modify: `src/package.json`（scripts 加 `test:print-toc`）

**Interfaces:**
- Consumes: `anchorSlug`（`src/heading-anchor.js` 导出，与编辑器 / 站点导出同一套 slug）。
- Produces（后续任务依赖，签名钉死）:
  - `assignHeadingIds(rootEl: Element) -> number`：给 rootEl 内 H1/H2 补 `id`（现有 id 不覆盖），返回补的数量。
  - `buildTocNodes(rootEl: Element) -> Array<{ level: 1|2, text: string, id: string }>`：按文档序提取 H1/H2（文本取 textContent，空标题跳过）。
  - `printStyles(options: { toc, pageNumbers, h1Break, cover }, title: string) -> string`：完整打印 CSS（`@page` 边注 / 目录 / H1 分页 / 封面，按勾选产出；未勾选的不产出对应规则；`title` 转义后进 `@top-center`）。
  - `DEFAULT_PRINT_OPTIONS = { toc: false, pageNumbers: true, h1Break: false, cover: false }`、`loadPrintOptions() -> options`、`savePrintOptions(options: object) -> void`。

- [ ] **Step 1: 写失败测试**

`src/tests/print-toc.test.mjs`，结构照 `src/tests/site-export.test.mjs`（`check(name, fn)` 计数）。jsdom 建 DOM：

```js
import assert from 'node:assert'
import { JSDOM } from 'jsdom'
import { assignHeadingIds, buildTocNodes, printStyles, DEFAULT_PRINT_OPTIONS, loadPrintOptions, savePrintOptions } from '../print-paged.js'

const dom = new JSDOM('<!doctype html><html><body></body></html>')
global.document = dom.window.document
global.localStorage = dom.window.localStorage

// 锚点：补 id、不覆盖已有、H3 不参与、返回数量
check('assignHeadingIds 给 H1/H2 补 id，已有 id 不覆盖，H3 不管', () => {
  const el = document.createElement('div')
  el.innerHTML = '<h1>一</h1><h2 id="keep">二</h2><h3>三</h3><h2>二</h2>'
  const n = assignHeadingIds(el)
  assert.strictEqual(n, 2)
  assert.strictEqual(el.querySelector('h1').id, '一')          // anchorSlug('一') === '一'
  assert.strictEqual(el.querySelector('h2#keep').id, 'keep')
  assert.notStrictEqual(el.querySelectorAll('h2')[1].id, '')     // 重名走 anchorSlug 的 dedup 后缀
  assert.strictEqual(el.querySelector('h3').id, '')
})

// 目录提取：文档序、层级、空标题跳过
check('buildTocNodes 按文档序提取 H1/H2，空标题跳过', () => {
  const el = document.createElement('div')
  el.innerHTML = '<h1>A</h1><h3>x</h3><h2><em>B</em></h2><h1></h1>'
  const nodes = buildTocNodes(el)
  assert.deepStrictEqual(nodes, [
    { level: 1, text: 'A', id: 'A' },
    { level: 2, text: 'B', id: 'B' },
  ])
})

// 打印样式：按勾选产出；标题转义；首个 H1 例外
check('printStyles 按勾选产出对应规则', () => {
  const all = printStyles({ toc: true, pageNumbers: true, h1Break: true, cover: true }, 'T')
  assert.ok(all.includes('@bottom-center') && all.includes('counter(page)'))
  assert.ok(all.includes('@top-center') && all.includes('T'))
  assert.ok(all.includes('target-counter'))
  assert.ok(all.includes('break-before: page'))
  assert.ok(all.includes('break-after: page'))          // 封面 / 目录落页
  const none = printStyles({ toc: false, pageNumbers: false, h1Break: false, cover: false }, 'T')
  assert.ok(!none.includes('@bottom-center') && !none.includes('target-counter'))
  assert.ok(!none.includes('break-before: page'))
  assert.ok(all.includes('h1:first-child'))               // 首个 H1 例外，封面 / 目录后不空出首页
})

check('printStyles 标题含引号反斜杠不产生非法 CSS', () => {
  const css = printStyles({ pageNumbers: true }, 'a"b\\c')
  assert.ok(css.includes('\\"'))                          // 引号已转义，@top-center 的字符串没被截断
})

// 选项存取：默认值、往返、坏数据回落
check('选项存取与坏数据回落', () => {
  localStorage.clear()
  assert.deepStrictEqual(loadPrintOptions(), DEFAULT_PRINT_OPTIONS)
  savePrintOptions({ toc: true, pageNumbers: false, h1Break: true, cover: true })
  assert.deepStrictEqual(loadPrintOptions(), { toc: true, pageNumbers: false, h1Break: true, cover: true })
  localStorage.setItem('nl-print-options', '{bad json')
  assert.deepStrictEqual(loadPrintOptions(), DEFAULT_PRINT_OPTIONS)
  localStorage.setItem('nl-print-options', '{"toc":true}')
  const merged = loadPrintOptions()
  assert.strictEqual(merged.toc, true)                    // 缺字段按默认补齐
  assert.strictEqual(merged.pageNumbers, DEFAULT_PRINT_OPTIONS.pageNumbers)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd src && node tests/print-toc.test.mjs`
Expected: FAIL，`Cannot find module '../print-paged.js'`

- [ ] **Step 3: 实现 `src/print-paged.js` 的纯函数与存取**

实现要点（签名与测试已定，只钉算法）：
1. `assignHeadingIds`：`rootEl.querySelectorAll('h1, h2')`，无 id 的用 `anchorSlug(textContent)` 补，slug 为空（纯符号标题）则跳过；计数返回。
2. `buildTocNodes`：同一查询，level 取 tagName，text 取 textContent.trim()，id 读已有（调用序：先 `assignHeadingIds` 再 `buildTocNodes`）。
3. `printStyles`：字符串模板，各块按勾选拼接——`@page { margin: 18mm 20mm; @bottom-center { content: counter(page) } @top-center { content: "<title>" } }`（`:first` 页页眉 `content: none`）；目录 `.nl-ptoc a::after { content: " " target-counter(attr(href url), page) }` 与 `break-after: page`；H1 `.nl-pbody h1 { break-before: page } .nl-pbody h1:first-child { break-before: auto }`；封面 `.nl-pcover { break-after: page }` 居中版式。`title` 经 `escapeCss`（`\` → `\\`、`"` → `\"`）再进字符串。
4. 存取：`savePrintOptions` 写 `JSON.stringify`，`loadPrintOptions` 解析失败或非对象回落 `{ ...DEFAULT_PRINT_OPTIONS }`，字段逐个用 `typeof === 'boolean'` 校验后并入默认。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd src && node tests/print-toc.test.mjs`
Expected: 全部 PASS

- [ ] **Step 5: package.json 加脚本并提交**

`src/package.json` scripts 加 `"test:print-toc": "node tests/print-toc.test.mjs"`（放 `test:slides-export` 旁）。

```bash
git add src/print-paged.js src/tests/print-toc.test.mjs src/package.json
git commit -m "feat: 打印排版纯函数（锚点 / 目录 / 打印样式）与选项存取"
```

---

### Task 2: 选项窗（`src/print-options-dialog.js`）

**Files:**
- Create: `src/print-options-dialog.js`

**Interfaces:**
- Consumes: Task 1 的 `DEFAULT_PRINT_OPTIONS` / `loadPrintOptions` / `savePrintOptions`；`src/i18n.js` 的 `t`。
- Produces: `printOptionsDialog() -> Promise<options | null>`——确认 resolve 勾选对象（并 `savePrintOptions`），取消（取消按钮 / Esc / 点遮罩）resolve null。DOM 结构照 `src/prompt-dialog.js` 的 overlay + box 模式（类名 `nl-print-opt-*`），标题 + 四个 checkbox + 确认 / 取消。

- [ ] **Step 1: 实现 `src/print-options-dialog.js`**

实现要点：打开时 `loadPrintOptions()` 回显四个勾；确认收集勾选 → `savePrintOptions` → resolve；Esc 与点遮罩同取消；焦点进窗内首个 checkbox（照 prompt-dialog 的焦点处理）。

- [ ] **Step 2: 冒烟验证**

Run: `cd src && npm run build`
Expected: 构建通过（本任务无独立测试，DOM 交互归 Task 4 真机验收）

- [ ] **Step 3: 提交**

```bash
git add src/print-options-dialog.js
git commit -m "feat: 打印排版选项窗（记住上次勾选）"
```

---

### Task 3: pagedjs 依赖、`printPaged` 编排与接线

**Files:**
- Modify: `src/package.json`（dependencies 加 `pagedjs`）
- Modify: `src/print-paged.js`
- Modify: `src/main.js`（`app.print` 分支，约 3122 行）
- Modify: `src/style.css`（`@media print` 增隔离规则）

**Interfaces:**
- Consumes: Task 1 全部导出、Task 2 的 `printOptionsDialog`；`src/i18n.js` 的 `t, getLocale`。
- Produces: `printPaged(options: object) -> Promise<void>`（内部含回退：取不到焦点窗格内容时直接 `window.print()`；预分页抛错向上抛，由调用方提示并兜底）。

- [ ] **Step 1: 安装依赖并核对入口**

Run: `cd src && npm i pagedjs@^0.4`
核对 node_modules 里 Previewer 的导出路径（包入口是自动执行的 polyfill，按其 package.json 的 module/exports 选不自动执行的那个入口 import `{ Previewer }`；若只能走 polyfill，则改用 `window.PagedConfig = { auto: false }` + 动态 import 的方案，本计划的编排与清理逻辑不变）。

- [ ] **Step 2: `print-paged.js` 追加 `printPaged`**

实现要点：
1. `sourceEl = document.querySelector('.nl-pane.focused .ProseMirror')`；取不到 → `window.print()` 返回（空态 / 画布兜底，与 spec 一致）。
2. 组装打印文档：`title` 取调用方传入（main.js 传 `state.currentFile` 去扩展名）；`options.cover` 时先插 `.nl-pcover`（标题 + `new Date().toLocaleDateString(getLocale())`）；`options.toc` 时插 `.nl-ptoc`（`buildTocNodes` 的结果建链接列表，href = `#id`）；正文克隆进 `.nl-pbody`，克隆后先 `assignHeadingIds` 再 `buildTocNodes`（目录链接才有 id 可指）。
3. `#print-root` 挂 body、body 加 `data-paged-print`；`new Previewer().preview(printDocEl, [printStyles(options, title)], printRoot)`；成功后 `window.print()`；`finally` 摘 `#print-root` 与标记（打印对话框关闭后才走到 finally，Chromium 行为即如此）。
4. Previewer 抛错：摘干净后再向上抛（main.js 提示 + 回退直打）。

- [ ] **Step 3: `main.js` 接线与 `style.css` 隔离**

1. import `printPaged` 与 `printOptionsDialog`。
2. `app('app.print', 'Mod-p', () => printViaDialog())`；`printViaDialog()`：`state.mode === 'canvas'` → `window.print()`；否则 `printOptionsDialog()`，null 直接返回；确认后 `setStatus(t('status.printPaging'))` → `await printPaged(options)` → 清状态栏；catch 里 `messageDialog(t('status.printPagedFallback'))` + `window.print()`（回退）。`MENU_NEEDS_DOC` 已含 `app.print`，不动。
3. `style.css` 的 `@media print` 块加：`body[data-paged-print] > :not(#print-root) { display: none !important; }` 与 `#print-root` 常态 `display: none`（预分页在后台做，不上屏）。

- [ ] **Step 4: 构建验证与提交**

Run: `cd src && npm run build && node tests/print-toc.test.mjs`
Expected: 均通过

```bash
git add src/print-paged.js src/main.js src/style.css src/package.json src/package-lock.json
git commit -m "feat: Ctrl+P 走 Paged.js 预分页（选项窗 → 排版打印，失败回退）"
```

---

### Task 4: i18n 与真机验收

**Files:**
- Modify: `src/locales/zh-CN.js`、`zh-Hant.js`、`en-US.js`、`fr-FR.js`、`de-DE.js`

**Interfaces:**
- Consumes: Task 2 / 3 用到的词条键：`dlg.printTitle`、`dlg.printOptToc`、`dlg.printOptPageNumbers`、`dlg.printOptH1`、`dlg.printOptCover`、`status.printPaging`、`status.printPagedFallback`。

- [ ] **Step 1: 五语言词条**

按既有 `dlg.*` 词条的措辞习惯补七条 ×5 份（中文：打印排版 / 自动目录页 / 页码与页眉标题 / H1 起新页 / 封面页 / 正在排版… / 排版失败，已回退普通打印）。

- [ ] **Step 2: 跑测试**

Run: `cd src && npm run test:i18n && node tests/print-toc.test.mjs`
Expected: 均通过（i18n 测试查五语言键齐平）

- [ ] **Step 3: 真机验收（spec §七）**

Run: `cd src && npm run tauri dev`
验收清单：长文档 Ctrl+P 全勾四项 → 选项窗回显、确认后出打印预览：封面在最前、目录页码与实际页对上、正文按 H1 分页、每页页脚页码、页眉标题（首页无）；只勾页码时其余不出现；连按两次 Ctrl+P 不叠旧容器（打印预览里无重复封面 / 目录）；取消选项窗不出打印；canvas 模式 Ctrl+P 直出老打印；标题含引号的文档页眉正常。

- [ ] **Step 4: CHANGELOG / CLAUDE.MD 补记并提交推送**

CHANGELOG 的 Added 加一条（写法参照幻灯片导出条目：问题 → 做法 → 实测 → 未实测）；CLAUDE.MD「快捷键规范」节的打印相关描述与「幻灯片导出」节后补一小节「打印排版（2026-10-25）」。完成后：

```bash
git add CHANGELOG.md docs/CLAUDE.MD src/locales/
git commit -m "docs: 打印排版增强补 CHANGELOG、CLAUDE.MD 与五语言词条"
git push
```
