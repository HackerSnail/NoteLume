功能规格 (Feature Specs)
6.1 高级拖拽分栏引擎（核心）
组件 SplitPane，支持 orientation="horizontal"（左右）与 "vertical"（上下）。
子节点可为另一个 SplitPane 或具体 EditorContent，实现无限嵌套网格。
两栏之间渲染约 4px 分割条 Resizer：悬停光标为 col-resize / row-resize；按下拖动时用全局 mousedown / mousemove / mouseup + pointer-events 捕获，确保跨组件顺滑，不受子内容影响。
按鼠标 X / Y 偏移实时计算并更新面板宽度 / 高度（百分比或 flex-basis）。
限制范围：每侧最小占比（如 20%）、最大不超过屏幕 80%，防止拖没。
编辑区右上角 / Tab 预留"拆分"按钮，点击在当前 Pane 内插入新分栏。
6.2 主题与自定义颜色
变量集：--bg-primary --bg-secondary --text-primary --text-secondary --border-color --accent-color。
设置页提供颜色选择器逐项修改；同时支持预设主题 light / dark / system。
变更时更新 :root 或 [data-theme] 上的变量实时生效，并持久化。
6.3 自定义文字颜色
逐项：正文 --text-editor、标题 --text-heading、代码 --text-code、链接 --text-link、引用 --text-quote、列表 --text-list。
每项配颜色选择器 + 重置按钮；预览区直接用这些变量渲染。
自定义文字颜色可作为预设主题之上的覆盖层，需写入 settings.json 并在重启恢复。
6.4 选区高亮 / 填充做笔记（Notion 风格）
选中文字后，在选区附近弹出浮动工具栏：预设高亮色（黄 / 绿 / 蓝 / 粉）+ 自定义取色器 + 清除高亮 +（可选）添加备注。
实现：document.getSelection() 取选区，用 Range.surroundContents 或 extractContents + insertNode 包裹为 <mark> / <span> 并挂对应 CSS 类。
高亮色通过变量管理：--highlight-yellow --highlight-green --highlight-blue --highlight-pink。
持久化：写回 Markdown 时以 HTML 标签或自定义语法保存；文件重新加载须正确解析并恢复高亮显示。
6.5 字体 / 字号 / 行高 / 自动换行
字体：下拉预设（JetBrains Mono、Fira Code、Microsoft YaHei）+ 手动输入覆盖，写入 --editor-font-family。
字号 / 行高：可调数值。
自动换行 Toggle：开启 white-space: pre-wrap; word-break: break-all;，关闭 white-space: pre;。
6.6 文件打开能力（完整链路）
文件关联：tauri.conf.json 的 bundle.fileAssociations 注册 .md / .markdown（说明 Win / macOS / Linux 差异；tauri dev 下双击可能不生效，需打包验证）。
启动参数：Rust 端解析 std::env::args，若为存在的文件路径则读取并 emit('file-opened')；为目录则作为工作区；无参数则恢复上次工作区。前端监听 file-opened 加载。
单实例二次唤起：应用已在运行时，用单实例插件把新文件路径转发给已有窗口，加入标签页；需处理空路径 / 多文件 / 含空格中文路径。
拖入打开：主区域监听 dragover / drop，支持拖入单 / 多 .md 文件（读内容打开）或文件夹（扫描生成文件树）；非 Markdown 给出提示或降级为纯文本。
读写保存：见 §5.3 Command；保存需处理创建、外部冲突、失败提示。
最近文件与工作区恢复：workspace.json / settings.json 记录最近文件、最近文件夹、上次打开路径与窗口状态；有启动参数优先，否则恢复上次工作区；前端提供最近列表、快速重开、清除记录。
6.7 前端文件状态
维护 currentFile、currentFolder、openedFiles、recentFiles、recentFolders、unsavedChanges、fileTree。
打开：已开则切标签，否则新建标签并更新最近列表；文件夹：左侧文件树可展开折叠、点击打开。
关闭：有未保存修改弹确认；关闭移出标签但保留最近记录。
7. 常用命令 (Commands)
pnpm install            # 或 npm install，安装前端依赖
pnpm tauri dev          # 开发模式（注意：文件关联双击在 dev 下通常不生效）
pnpm tauri build        # 打包，产出安装包后再验证双击 / 打开方式 / 拖入
cargo check             # Rust 端类型检查
8. 编码规范 (Coding Standards)
TypeScript 严格模式；组件函数式 + Hooks；Rust Command 返回 Result<T, String>，错误信息可读。
序列化统一走 serde::{Serialize, Deserialize}。
状态防抖写盘（500ms），拖拽结束（mouseup）即时写盘，避免高频 IO。
每个 CSS 变量都有默认值，主题切换只改变量值，不改组件结构。
注释解释"为什么"而非"是什么"；分栏递归渲染注意终止条件，避免死循环。