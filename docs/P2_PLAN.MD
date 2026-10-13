# P2 剩余功能实施计划

> 前置：知识图谱已于 v0.3.0 落地（`graph-view.js`），本文件覆盖 P2 未完项。

---

## 1. 版本快照 UI ✅ 已完成

> 落地情况：`read_backup` 命令 + `src/snapshot-panel.js` + 侧栏 📦 历史版本面板 + 预览/回滚模态均已实现；回滚覆盖前会先 `backup_write` 一份当前版，保证可逆。

**目标**：用户可看到当前文档的历史备份列表，并一键回滚。

**依赖地基**（已在 P1 落好）：
- Rust 端 `backup_write`：每次保存写 `.notelume-backup/YYYY-MM-DD/{stem}-HH-MM-SS.md`
- Rust 端 `list_backups(vault_root, doc_rel)` → `Vec<BackupInfo { filename, path, timestamp }>`
- `.notelume-backup` 已加入 `SKIP_DIRS`，不入库扫描

**新 Rust 命令**（1 个）：
- `read_backup(vault_root, backup_rel_path) -> String`：从 `.notelume-backup/<rel>` 读内容返回给前端展示 diff / 回滚

**前端**：
- 侧栏「双向链接」面板底部新增折叠区「📦 历史版本」，列出当前文档备份时间戳列表（最新的在前）
- 点击条目：模态展示该快照全文（只读 `<pre>` 或用 `exportMd.render` 做 HTML 预览）
- 操作按钮：「回滚到此版本」→ 写回原 md + `rebuild_index` / `update_index_doc` 刷新
- 快捷键：无独立绑定，通过面板交互进入

**JS 新文件**：`src/snapshot-panel.js`（~100 行）
- 负责：列表渲染 / 快照预览 modal / 调用回滚

**验收**：编辑 → 自动保存产生 2+ 份备份 → 列表出现 → 回滚 → md 内容复原 → 索引 re-ready

---

## 2. 插件基础钩子系统 ✅ 已完成

> 落地情况：新 Rust commands `list_plugins` / `read_plugin`（前缀白名单防路径穿越，附单测）+ 前端 `src/plugin-loader.js`。插件源码经 Blob URL + 动态 `import()` 加载。因为编辑器在开库前已装配，keymap / inputRule 采用 `state.reconfigure` 运行时热注入（`__nlPlugin` 标记可重入刷新）；`registerNodeSpec` / `registerMarkSpec` 因 schema 不可变 v1 暂不支持。侧栏 🔌 面板提供启用/禁用（localStorage 记忆）+ 命令按钮。验收样例：`examples/notelume-plugins/hello.js`（Mod-Shift+H 弹窗 + 插入时间命令）。

**目标**：暴露轻量 API，允许用户放 `.js` 到 `<vault>/.notelume-plugins/` 来扩展编辑功能（自定义命令 / 快捷键 / 输入规则 / 生命周期回调）。

**设计原则**：
- 不引入 RPC / worker：插件就是普通 `<script type="module">` 运行在主线程
- 不做沙箱：与 Obsidian 一样，用户自担风险
- 钩子粒度粗 → 先覆盖"编辑器装配后挂入额外插件 / 命令 / keymap"

**钩子点（API 签名）**：
```ts
interface NoteLumePlugin {
  id: string
  name?: string
  onInit?(ctx: PluginContext): void
  onEditorReady?(view: EditorView, schema: Schema): void
  onDocChange?(doc: ProseMirror.Node, prevDoc: ProseMirror.Node): void
  onFileOpen?(path: string, content: string): void
  onSave?(path: string, content: string): void
  commands?: Record<string, () => void>
  keymap?: Record<string, () => boolean>
}

interface PluginContext {
  registerCommand(name, fn): void
  registerKeymap(binding, fn): void
  registerInputRule(rule): void
  registerNodeSpec(name, spec): void
  registerMarkSpec(name, spec): void
}
```

**实现策略**：
1. Rust 端新命令 `list_plugins(vault_root)` → 返回 `.notelume-plugins/*.js` 文件名列表
2. 前端 `plugin-loader.js`：启动后 `list_plugins` → 逐个 `import(/* @vite-ignore */ fileUrl)` → 读取 `export default NoteLumePlugin` → 在 editor-view 装配阶段注入
3. editor-view.js 的 `plugins` 数组 / `keymap` / `nodeViews` 改为动态拼装，打开 `extraPlugins` / `extraKeymaps` 入口
4. 设置面板「🔌 插件管理」：列出已加载 + 启用/禁用 toggle（localStorage 记忆）

**新文件**：
- `src/plugin-loader.js`（~120 行）
- `src-tauri/src/lib.rs` 新增 `list_plugins` command

**验收**：在 `<vault>/.notelume-plugins/hello.js` 写一个注册 `Mod-Shift-H` → 弹 alert 的插件 → 重启后快捷键生效

---

## 3. 画布 / 白板（低优先级）

**目标**：类 Obsidian Canvas，自由摆放卡片 + 连线。

**复杂度评估**：
- 需要独立数据模型（非 Markdown 文档）→ JSON canvas 格式 `.canvas`
- 渲染引擎：SVG（节点拖拽 + 缩放 + 边线）或 Canvas 2D
- 交互量大：多选、对齐、分组、颜色标签、resize、边端点吸附

**最低可用版拆件**：
1. 数据：`.canvas` JSON schema（nodes[].{id,x,y,w,h,color,text|file} + edges[].{from,to,label}）
2. Rust：`read_canvas` / `write_canvas`
3. 前端 `canvas-view.js`：SVG 渲染 + pointer events 拖拽 + 滚轮缩放 + 双击编辑文字
4. 文件树识别 `.canvas` 扩展名 → 打开到画板视图替代编辑器

**建议**：放在插件钩子之后，等整体架构更灵活再做。不急于本轮。

---

## 4. 移动端（最低优先级）

**方向**：Tauri v2 本身支持 iOS / Android，但当前 UI（侧栏 + 工具条 + 力导向图）不适配小屏。

**前置条件**：
- 响应式布局重构（sidebar → drawer 折叠）
- 编辑区触屏手势适配（选中、长按图片保存）
- 图谱触屏交互（双指缩放 / 单指拖）
- 编译目标切换（`tauri android dev` / `tauri ios dev`）

**建议**：桌面版功能稳定后再做，不排入近期迭代。

---

## 建议实施顺序

| # | 功能 | 预估新增代码 | 前置 |
|---|---|---|---|
| 1 | 版本快照 UI | ~200 行（前端 100 + Rust 50 + CSS 50） | P1 backup_write / list_backups 已有 |
| 2 | 插件钩子系统 | ~300 行（loader + editor-view 改造 + list_plugins） | 无硬依赖 ✅ |
| 3 | 画布 / 白板 | ~600 行（独立视图） | 最好有插件钩子做架构参考 |
| 4 | 移动端 | 大改布局 | 桌面版 feature freeze |
