# 批次 D 设计：命令面板 + 快捷键自定义

- 状态：设计已获批准，待实现
- 日期：2026-10-14
- 决策原则锚定：不引 UI 框架；复用优先（`.nl-prompt`/`.nl-suggest` 观感、PM `state.reconfigure` 热注入）；无损互操作；警惕过度设计（YAGNI）
- 已敲定范围（四项取最full）：重绑覆盖 **应用级 + 编辑器格式化**；面板含 **命令 + 文档跳转**；**插件命令并入统一注册表**；冲突 **硬阻止保存**

## 一、背景与目标

现状命令/快捷键三处散落、无统一入口：
- 应用级快捷键是 `main.js` `bindShortcuts()` 里一条硬编码 `if/else` 链（Ctrl+S/O/F/P/G、`Ctrl+Shift+D/F/T`、`Ctrl+/`）。
- 编辑器格式化命令是 `editor-view.js` 里的 ProseMirror `keymap({ 'Mod-b':… })`。
- 插件命令是 `plugin-loader.js` 内部 `commands` Map + `runCommand(name)`，与内置命令不通。

本批建一处**集中命令注册表**（三者共用），在其上叠两个 UI：**命令面板**（`Ctrl+Shift+P`，模糊匹配命令与文档、回车执行）与**快捷键设置页**（命令↔按键可重绑、冲突拦截、存 localStorage）。

## 二、范围

**包含**
- 统一注册表：每条命令有稳定 `id`、显示名、`category`、默认键、`run(ctx)`、作用域 `when`。
- 键位解析层：默认值 ∪ localStorage 覆盖 → 有效绑定；绑定串规范化/解析/可读化；冲突检测。
- 命令面板模态：裸词模糊匹配文档快速打开；`>` 前缀匹配命令。复用现有模态观感。
- 快捷键设置模态：分组列出可重绑命令，录制新键、重置、冲突硬阻止、持久化并即时生效。
- 应用级 + 编辑器格式化 + 插件命令均可重绑、均进面板。

**不包含（YAGNI / 后续）**
- 鼠标/右键自定义；多键序列（chord，如 `Ctrl+X Ctrl+S`）；命令图标体系；最近使用排序加权。
- 改 PM `baseKeymap` 的结构键（Enter/Backspace/方向键固定，不进注册表）。
- 标签档面板（`#` 匹配实体）——本批只做命令 + 文档两类。
- 含 Rust（本批**不涉及 Rust**，纯前端，刷新即生效，无需重启 tauri dev）。

## 三、关键架构决策：编辑器命令的两层调度（方案 B）

编辑器命令本质是 PM 命令（`toggleMark`/`undo` 等），仅在编辑器聚焦、有选区时有意义。选择：

- **采纳 B — 两层解析、一份注册表**：app/plugin 命令由**文档级全局 keydown 分发器**（读注册表 + 有效绑定）执行；editor 命令仍留在 PM `keymap()` 中，但该 `keymap` 的绑定表改为**由注册表 + 覆盖动态生成**，变更时经 `state.reconfigure` 热重建（插件系统已有同款热注入机制，复用）。
- 面板/设置页要「主动执行」一条 editor 命令时，统一调 `editor-view.js` 暴露的 `runEditorCommand(id)`：先聚焦编辑器、再对当前 state 求值对应 PM 命令并 `dispatch`（与按键触发的效果一致）。
- 否决 A — 全部塞进一个全局 keydown：需自行处理"焦点在非编辑器时不得触发编辑命令""undo/redo 与 PM history 语义冲突"等，边界多、回归风险高。
- B 的收益：编辑命令语义正确（天然只在编辑器内生效、拿到正确的 view/state/dispatch）；面板与设置页仍能统一列出、重绑、执行（执行 `when:'editor'` 命令时先 `focusEditor()` 再 `dispatch`）。

## 四、组件划分

### 4.1 `src/commands.js`（新增，地基）
单一事实源。命令记录：
```
{ id, title, category:'app'|'editor'|'plugin',
  defaultKey?: 'Mod-s',   // 规范化串（见 §5），无键=不可默认触发但可进面板/可绑
  run(ctx),               // 执行；editor 类经 ctx.focusEditor() 后 ctx.dispatchCmd(id)
  when?: 'editor'|'always' } // 默认 'always'；'editor' 需编辑器聚焦
```
- API：`register(cmd)` / `remove(id)` / `list()` / `get(id)` / `run(id, ctx)`。
- `id` 命名空间：`app.*`、`editor.*`、`plugin.<插件名>.*`。重名冲突在注册时告警并拒覆盖内置。
- **`commands.js` 只承载注册表容器（纯、可单测），不含具体处理器**：app 命令的 `run` 需操作 main.js 状态，故由 main.js 以 `registry.register({ id:'app.save', defaultKey:'Mod-s', run:()=>saveCurrent(true), … })` 注入闭包注册（把 `bindShortcuts` 的 if/else 逐条搬成这类注册调用）。
- editor 命令定义由 `editor-view.js` 导出（`id`→PM 命令函数 + 默认键 + `when:'editor'`）；其 `run(ctx)` 统一调 `ctx.runEditorCommand(id)`——该方法聚焦编辑器后取对应 PM 命令、对当前 state 求值并 `dispatch`（方案 B 下真正的按键响应仍走 PM keymap，`runEditorCommand` 仅为面板/设置页「主动执行」服务）。
- plugin 命令由 `pluginManager` 在 `registerCommand`/声明式 `commands` 时并入注册表（`run` 包一层 `runCommand(name)`，`category:'plugin'`，默认无键）。

### 4.2 `src/keymap.js`（新增，纯逻辑可单测）
- `effectiveBindings(registry, overrides)` → `{ binding -> id }`（默认 ∪ `localStorage['nl-keymap']`；覆盖值为空串=解绑）。
- `normalizeBinding(str)` / `parseBinding(str)`：统一大小写/修饰顺序，识别 `Mod`（Win/Linux=Ctrl，mac=Cmd）。
- `formatBinding(str, isMac)`：面板与设置页展示用（`Ctrl+Shift+P` / `⌘⇧P`）。
- `findConflicts(bindingsMap)`：返回同一组合键被多命令占用的清单。

### 4.3 `src/command-palette.js`（新增，模态 UI）
- 复用 `.nl-prompt`/`.nl-suggest` 观感：输入框 + 结果列表；↑↓ 选择、Enter 执行、Esc 关；点遮罩/Esc 收起。
- 模式（Obsidian 式）：**裸词=文档**（对 `state.docNames` 标题/路径客户端 fuzzy）；输入以 `>` 开头=**命令**（对 `registry.list()` 标题 fuzzy）。空输入默认列出文档 + 提示"输入 > 执行命令"。
- 命中文档 → `openFile(rel)`；命中命令 → `registry.run(id, ctx)`（`when:'editor'` 由 `run` 内部转 `ctx.runEditorCommand(id)`）。
- `fuzzy(query, text)`：子序列匹配 + 连续/词首/大小写加分，纯函数入 keymap/commands 同款测试。

### 4.4 `src/shortcut-settings.js`（新增，模态 UI）
- 分组表（应用/编辑器/插件）列出 `defaultKey!=null || 可绑` 的命令；每行显示当前有效键（`formatBinding`）+「录制」+「重置」。
- 录制：进入捕获态，下一次 keydown 组成绑定串；命中已有其它命令的绑定 → **标红 + 禁止保存**，提示占用者（硬阻止）。允许解绑（清空该行）。
- 保存：写 `localStorage['nl-keymap']` = `{id: binding|''}` → 触发全局分发器重建 + `editorView.setKeymapOverrides(map)` 热重配。

### 4.5 `src/editor-view.js`（改）
- 导出编辑器命令定义表（id→{pmCmd, defaultKey}）。
- `keymapPlugin` 的绑定表由「默认 + 传入覆盖」构造；新增 `setKeymapOverrides(map)` 经 `state.reconfigure` 热替换该 keymap 插件（沿用插件系统已有 `__nlPlugin` 标记式热注入范式，新增一个 `__nlKeymap` 可重入槽）。
- 提供 `focusEditor()` 供面板执行 `when:'editor'` 命令。

### 4.6 `src/main.js`（接线）
- 构建注册表（注册 app/editor/plugin 命令）；用 keymap 层驱动的**全局分发器**取代 `bindShortcuts()` 硬编码链（保留其"非编辑器目标不拦截"等既有行为）。
- **打印收窄为纯 `Ctrl+P`**（现 `key==='p'` 未排除 shift，会吞 `Ctrl+Shift+P`），释放 `Ctrl+Shift+P` 绑定面板。
- ▾ 更多 增「⌨ 命令面板…」「🎛 快捷键设置…」。
- 启动时读 `localStorage['nl-keymap']` 应用到两层。

## 五、绑定串规范

- 形式：`Mod-`/`Ctrl-`/`Alt-`/`Shift-` 修饰 + 一个基础键；基础键为可打印单字符（含现有命令用到的 `/` 与 `` ` ``，存小写）。
- **结构性键不可作重绑目标**：`Enter`/`Tab`/`Escape`/方向键等留给编辑器与系统，设置页录制到时忽略之（当前 `/`、`` ` `` 作为带 `Mod` 的组合键是合法可绑的）。
- `Mod` 解析时按平台映射（非 mac→`Ctrl`，mac→`Cmd`）；序列化/比较统一转规范顺序（Ctrl<Alt<Shift<… 、基础键小写）。
- 存储只存逻辑串（含 `Mod`），跨平台可移植；展示时再按当前平台展开。

## 六、数据流

```
启动：读 nl-keymap → keymap 层解析 → ① 全局分发器（app/plugin）
                                     → ② editorView.setKeymapOverrides（editor）
Ctrl+Shift+P：开面板 → fuzzy(文档|命令) → Enter → openFile / registry.run(id,ctx)
设置页重绑：录制 → 冲突校验（硬阻止） → 写 nl-keymap → 重算 → 重建①+② → 即时生效
```

## 七、边界与错误处理

- 未开库/无文档：面板文档区显占位；命令区照常可用；跳文档类命令 `run` 内自带前置检查（沿用现有 `setStatus` 提示）。
- `when:'editor'` 命令但当前无编辑器聚焦/无文档：`runEditorCommand` 内部检测到则 `setStatus` 提示，不抛错。
- 冲突：**硬阻止保存**（用户选定）；设置页不落盘非法绑定，旧有效配置保持不变。
- localStorage 非法/损坏 JSON：解析失败视为空覆盖，回退默认。
- 注册表内置 `id` 与插件 `id` 同名：拒插件覆盖内置，告警。

## 八、测试计划

- **Node 纯逻辑单测**（`src/tests/keymap.test.mjs`，无 DOM）：
  - 绑定规范化/解析（`Mod`/大小写/修饰顺序/等价串）。
  - `effectiveBindings`：默认 ∪ 覆盖、空串解绑。
  - `findConflicts`：多命令同键检出。
  - `fuzzy`：子序列命中、打分排序、空查询。
  - `commands`：注册/查询/`run` 分派、id 冲突拒绝。
- **构建**：`npm run build:web` 无错（含新模块被 main.js 引用，验证接线）。
- **无 Rust**：不改后端，刷新即生效，不需重启 tauri dev。
- **手动目测**：`Ctrl+Shift+P` 开面板→跳文档、`>` 跑命令；设置页把「加粗」从 `Ctrl+B` 改到 `Ctrl+Shift+B` 生效、改到「斜体」已占的键被硬拦；打印仍走纯 `Ctrl+P`、`Ctrl+Shift+P` 不再触发打印。

## 九、落地顺序（实现按此拆步）

1. **D1** `commands.js` + `keymap.js` + 全局分发器取代 `bindShortcuts`（先 app 命令跑通，无新 UI；附单测）
2. **D2** editor 命令并入注册表 + `editor-view.js` 动态 keymap + `setKeymapOverrides` 热重配 + `focusEditor`
3. **D3** plugin 命令并入注册表（`pluginManager` 注册时同步进出注册表/卸载时移除）
4. **D4** `command-palette.js`（`Ctrl+Shift+P`，命令 + 文档，打印收窄）+ ▾ 更多接线
5. **D5** `shortcut-settings.js`（录制 + 冲突硬阻止 + 持久化 + 两层即时生效）+ ▾ 更多接线
6. 文档回填 CHANGELOG（Added）/README（特性）/ROADMAP（批次 D 标完成）

## 十、影响与风险

- 属成规模子系统：新增 4 前端模块 + 改 main.js/editor-view.js/plugin-loader.js，重构快捷键装配。
- 主要正确性风险在 **D2 的 PM keymap 热重配**（勿破坏 `baseKeymap`/history 顺序、勿与插件 keymap 注入冲突）与 **全局分发器接管后既有快捷键行为不回退**。以纯逻辑单测 + 手动逐键回归兜底。
- 每步 D1–D5 独立可验证；D1 完成后快捷键体验已无回归即具备合并价值，UI（D4/D5）为增量。
