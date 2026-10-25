# Quarkdown 引擎阶段 1（编辑器集成 + 导出注入）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 编辑器里 Quarkdown 指令块显示求值结果快照（点进源码、点出回快照，mermaid/csv 同款交互）+ 诊断呈现；单篇 HTML / 整站 / 幻灯片三个导出点渲染前展开；`features.quarkdown` 开关，关闭即完全旁路。

**Architecture:** `src/qd/editor.js` 装饰插件：区域 = 指令调用段 + 其后连续的 code_block / 列表（缩进体在 CommonMark 里落成这两类节点）；源码重组后经 `evalQd`（tauri-bridge → `qd_eval`）求值，展开文本经本地 markdown-it 渲染进 widget，结果按区域源码指纹缓存。导出侧在渲染前调 `evalQd` 展开（exportHTML / exportSlides 直接预展开，exportSite 经 opts.evalMd 注入保持模块无 Tauri 依赖）。打印走编辑器 DOM 克隆，快照随克隆带上。

**Tech Stack:** 现有栈（ProseMirror 装饰、markdown-it、Tauri invoke）。

**Spec:** `docs/superpowers/specs/2026-10-25-quarkdown-engine-design.md` §二 / §三

## Global Constraints

- `features.quarkdown` 关闭时：编辑器不挂任何装饰、导出不求值（文件按普通 GFM 处理）。
- 无 Tauri 环境（vite dev 网页预览）evalQd 透传原文，编辑器照常可用。
- 源文件不动：快照是视图层，序列化 / 保存永远写指令原文。
- 区域边界 v1 口径：指令调用段（段落文本以 `.`+名字开头）+ 其后**连续的** code_block 与列表节点；含段落体的块参数（1–3 空格缩进）不在区域里（_commonmark 会把 4 空格缩进落成 code_block，正文段落体罕见，v1 接受此限制并在代码注释说明）。
- 测试跑法：`cd src && node tests/qd.test.mjs`。

## Review Focus

- 缩进体在编辑器里是 code_block：重组源码时按 4 空格前缀还原，否则 qd_eval 拿到的函数体没有缩进、解析不出块参数 → Task 2 测试钉住。
- 相邻两条指令（中间隔空行）必须是两个区域，不能合并 → Task 2 测试钉住。
- evalQd 透传（无 Tauri）不能抛错 → Task 1 测试钉住。
- 区域源码不变时不得重复发起求值（缓存键 = 区域源码）→ Task 3 以 mermaid 的 key 复用机制对齐。

---

### Task 1: 开关与桥接

**Files:**
- Modify: `src/feature-flags.js`（DEFAULT_FEATURES 加 `quarkdown: true`）
- Modify: `src/appearance-settings.js`（FEATURE_ROWS 加 `feature.quarkdown` 行）
- Modify: `src/tauri-bridge.js`（加 `evalQd(md)`：有 Tauri invoke('qd_eval')，否则透传 `{ expanded: md, diagnostics: [] }`）
- Modify: `src/locales/*.js` ×5（`feature.quarkdown`）

- [ ] Step 1: 实现（照既有开关行的写法）
- [ ] Step 2: `npm run test:i18n` 过 + `node tests/feature-flags.test.mjs`（若存在则补 quarkdown 键断言；无则并入 Task 3 的测试文件）
- [ ] Step 3: 提交 `feat(qd): quarkdown 功能开关与 evalQd 桥接`

### Task 2: 区域收集与源码重组（`src/qd/editor.js` 前半，纯函数）

**Files:**
- Create: `src/qd/editor.js`
- Create: `src/tests/qd.test.mjs`

**Interfaces:**
- Produces:
  - `collectQdRegions(doc) -> Array<{ from: number, to: number, source: string }>`（顶层遍历：指令调用段开启区域，吞并其后连续 code_block / 列表；`source` = 指令段文本 + code_block 行加 4 空格前缀 + 列表项 `- ` 行）
  - `isQdCallPara(node)`、`regionSource(parts)`

- [ ] Step 1: 写失败测试（`src/tests/qd.test.mjs`，jsdom + parseMarkdown，参照 anchor-link.test.mjs）

```js
// 1. 指令段 + 缩进体：".function {greet}\n    to:\n    Hello, .to" 在 PM 里是
//    段落 + code_block("to:\nHello, .to") → 一个区域，source == ".function {greet}\n    to:\n    Hello, .to"
//    （code_block 行还原 4 空格前缀）
// 2. 相邻两条指令（隔空行）→ 两个区域
// 3. 列表体归入区域：".var {letters}" + bullet_list(- A / - B) → source 含 "- A\n- B"
// 4. 无指令的普通文档 → 空数组
// 5. 区域 from/to 覆盖全部成员节点（pos 语义与 doc.forEach 一致）
```

- [ ] Step 2: 确认失败 → Step 3: 实现纯函数 → Step 4: 通过 → Step 5: 提交 `feat(qd): 指令区域收集与源码重组`

### Task 3: 求值快照插件（`src/qd/editor.js` 后半）

**Files:**
- Modify: `src/qd/editor.js`
- Modify: `src/editor-view.js`（import + `qdPlugin(opts.getFeatures, opts.evalQd)` 装配）
- Modify: `src/main.js`（createPaneEditor 传 `evalQd`）
- Modify: `src/style.css`（`.nl-qd-source` 隐藏、`.nl-qd` 快照容器、`.nl-qd-diag` 诊断条）

**Interfaces:**
- Consumes: Task 2 纯函数、`evalQd`（opts 注入）、`markdown-it`（本地实例：commonmark + table/strikethrough，html:false，挂 emoji renderer）
- Produces: `qdPlugin(getFeatures, evalQd) -> ProseMirror Plugin`

- [ ] Step 1: 实现插件（mermaid 模式：光标不在区域内 → 节点挂 `.nl-qd-source` 隐藏 + 区域尾挂快照 widget（异步求值后填充，`document.contains` 防过期回写，缓存键 = 区域源码）；光标在区域内 → 源码可见可编辑；诊断在快照尾部出灰字条）
- [ ] Step 2: `npm run build` 过 → Step 3: 提交 `feat(qd): 编辑器求值快照与诊断呈现`

### Task 4: 导出注入

**Files:**
- Modify: `src/main.js`（exportHTML / exportSlides 渲染前 `const ev = await evalQd(md); md = ev.expanded`；exportSiteFull 传 `evalMd: evalQd`）
- Modify: `src/site-export.js`（exportSite 参数加 `evalMd`，每篇渲染前展开）

- [ ] Step 1: 实现四处注入 → Step 2: `npm run build` + 既有测试（site-export 30 条不破）→ Step 3: 提交 `feat(qd): 导出渲染前展开`

### Task 5: 文档与真机验收

- [ ] Step 1: CHANGELOG + CLAUDE.MD「功能开关」节补 quarkdown 行
- [ ] Step 2: 真机验收（spec §三）：写 `.var {name} {NoteLume}` + `Hello, .name!` → 快照出 "Hello, NoteLume!"，点进快照见源码，Esc 回快照；诊断示例（`.nosuch`）快照尾部出灰字；设置关闭 quarkdown 开关后全部旁路；导出 HTML 里是展开结果；无 Tauri 网页预览不报错
- [ ] Step 3: 提交推送
