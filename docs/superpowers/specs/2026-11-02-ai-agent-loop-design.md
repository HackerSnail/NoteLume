# 设计：AI 面板 Agent 模式升级为工具循环（agent loop）

- 状态：设计完成，待实现
- 日期：2026-11-02
- 来源：现有 Agent 模式只是「一次往返，回答按锚点写进文档」；全库检索是发请求前一次性分词注入（`aiQueryTerms` + `searchVault`），命中差不迭代、读不到具体文件。本设计把 Agent 模式升级为标准 OpenAI function calling 工具循环，模型自己决定查什么、读什么，多轮迭代后给最终回答。
- 参照协议：OpenAI Chat Completions 的 `tools` / `tool_calls` / `role:'tool'`（DeepSeek、智谱 GLM、Kimi、OpenAI、Ollama 部分模型均兼容）。
- 资料：OpenAI Function calling 指南（流式 tool_calls 按 index 分片、id/name 仅首片、arguments 碎片拼接）；Ollama 博客 Streaming responses with tool calling（2025-05 起支持，tool_calls 整对象随 chunk 到达、不碎片化，支持模型 Qwen3 / Qwen2.5 / Llama3.1 / Llama4 等）；DeepSeek 文档（工具调用在 deepseek-chat，deepseek-reasoner 直接 400 "does not support this tool_choice"）；Ollama 对不支持工具的模型同样 400（`{"error":"<model> does not support tools"}`，错误体是字符串形态而非 OpenAI 的 error.message 嵌套）。

## 一、现状与差距

现状（`src/ai-panel.js` + `src-tauri/src/ai.rs`）：

1. Rust 只解析 `delta.content` 增量（`extract_delta_content`），`delta.tool_calls` 与 `finish_reason: "tool_calls"` 都被丢弃；`AiChatArgs` 也没有 `tools` 字段，请求带不上工具定义。
2. 前端 Agent 模式的全部能力是 `agentHint` 系统提示 + `<insert after="…">` 锚点协议（`parseAgentReply` / `resolveAnchorPos`），回答结束一次性写进当前文档。
3. 全库检索是发送前一次性的：前端分词 → `searchVault` → `buildVaultContext` 注入一条 system 消息。模型看不到检索之外的库内内容，检索词不好就空手而归。

差距就是三个词：带不上工具、解析不了工具调用、没有循环。

## 二、范围

**包含**

- Agent 模式升级为工具循环：请求带 `tools`，模型回 `tool_calls` 时本地执行工具、结果以 `role:'tool'` 回填、继续下一轮请求，直到无工具调用的最终回答。
- Rust SSE 侧支持 tool_calls：增量按 index 累积，done 事件随载荷带给前端；`AiChatArgs` 透传 `tools`。
- v1 工具集全部只读（见第四节），复用既有 IPC，不新增 Rust 命令。
- 工具调用在面板里可见：消息流中插入工具行（工具名 + 参数摘要 + 状态），点开看结果。
- 可终止：任一时刻（流式中 / 工具执行中 / 多轮之间）一键终止整个循环，终止后状态一致、可继续追问。
- 修改回退：Agent 写进当前文档的内容带显式「撤销」入口，不依赖焦点还停没停在文档里、也不依赖 Ctrl+Z 走到哪一步。
- Ask 模式完全不动；选区 AI 不动。

**不包含（后续批次）**

- 写工具（建笔记、改其他文件、替换当前文档选区）。写库文件需要确认弹窗，写当前文档要定替换协议，单独一批做；v1 的落文档仍走既有锚点协议（最终回答 autoApply，可撤销）。
- 并行工具执行的并发控制：v1 顺序执行（一次一轮请求只带几个调用，逐个跑完再续）。
- 工具支持能力的模型名启发式：视觉模型有名单可枚举，工具支持没有可靠名单。Agent 模式照发 `tools`，不支持的服务端会返回 4xx 错误（DeepSeek reasoner、Ollama 纯文本模型都是 400），气泡里原样显示错误并附建议切回 Ask 的提示（`ai.noToolsTip`，不猜原因只给出路）。
- MCP 接入、用户自定义工具。

## 三、协议与循环

请求侧：

```
POST /chat/completions
{
  model, messages, stream: true,
  tools: [{ type:'function', function: { name, description, parameters(JSON Schema) } }],
  temperature?
}
```

`tools` 只在 Agent 模式的循环请求里带上；`AiChatArgs` 加 `tools: Option<serde_json::Value>` 原样透传，Rust 不理解工具语义（与 content 的 `Value` 透传同一口径）。

响应侧（SSE）：

- 增量 chunk 里 `delta.tool_calls[]` 每片带 `index`，`id` / `function.name` 通常只在第一片出现，`function.arguments` 按 index 跨片拼接（多字节字符可能被 chunk 切开，Rust 已有的字节缓冲逐行处理天然保住完整 JSON 行）。
- 兼容两种分片形态：OpenAI / DeepSeek / GLM / Kimi 按 token 碎片传 arguments；Ollama（2025-05 起支持流式工具调用）是**整个 tool_calls 对象随单个 chunk 一次到齐**、不碎片化。累积器对每片按 index 分支：有 `id` 视为新调用起始（整对象则直接落全量 arguments），无 `id` 视为后续碎片追加 arguments——两种形态同一套代码都吃得下；Ollama 的 chunk 可能不带 `index`，缺省按 0 归位。
- 少数网关忽略 stream 一次性回完整响应的兜底（content 已有先例）：`message.tool_calls` 与 `delta.tool_calls` 同源解析，形态一致（数组、id / function.name / function.arguments 齐全），不需要单独累积。
- 判定「本轮要执行工具」只看累积结果非空，不依赖 `finish_reason`（各家对该字段的落实不一，累积结果是硬依据）。
- Rust 在流结束时把累积结果放进 done 事件：`{reqId, kind:'done', toolCalls?: [{id, name, arguments}]}`。没有工具调用时 `toolCalls` 缺省，前端语义不变。

循环（前端驱动，`src/ai-agent.js`）：

```
runAgentLoop({ messages, tools, execTool, streamRequest, callbacks, maxSteps })
  每步：
  1. streamRequest(messages 带 tools) → 流式 chunk 回调渲染助手文本（与现状一致的打字机）
  2. done 且有 toolCalls：
     a. assistant 消息（content = 已流出的文本，可为空串 + tool_calls 数组）推进 messages。
        回传的 tool_calls 要补全 `type:'function'` 字段——done 事件载荷里为省字节只带
        {id, name, arguments}，OpenAI 格式的 assistant.tool_calls 元素要求带 type，
        严格校验的服务端缺了会拒收
     b. 逐个执行 execTool(name, arguments)，每个结果以
        { role:'tool', tool_call_id, content: "<JSON 字符串>" } 推进 messages
        （role:'tool' 的 content 按协议必须是字符串，结构化结果一律 JSON.stringify；
        工具执行失败同样回字符串，如 {"error":"file not found"}）
     c. 步数 +1，未到 maxSteps 则回到 1
  3. done 且无 toolCalls → 最终回答，循环结束
```

- maxSteps 定 8（含工具轮）。到顶不再发请求：把最后一条助手文本当回答收尾，气泡尾缀「已达工具步数上限」标签。
- Agent 模式跳过既有的一次性全库检索注入（`getVaultContext` / `buildVaultContext`）：检索已经交给 `search_vault` 工具按需多轮做，预注入既冗余又固定烧一份 token；Ask 模式保留现状。
- 取消：stop 按钮取消当前流式请求（`aiChatCancel`）并终止整个循环。终止点挂在循环的每个等待位上——等流式 chunk、等工具执行（单工具执行是同步 IPC，下一个工具执行前检查）、下一轮请求发出前——点到即停，不再发起新请求、不再跑剩余工具。已执行的工具调用与结果保留在消息历史里（assistant.tool_calls 与已执行的 role:'tool' 成对），半截回答与现状同口径（保留、不自动应用），气泡尾缀「已停止」标签；面板随后可正常继续追问。
- 悬挂 tool_calls 修复：OpenAI 协议要求每条带 tool_calls 的 assistant 消息后面必须紧跟每个 tool_call_id 对应的 role:'tool' 消息，缺了服务端直接 400。终止或出错可能停在「assistant 已带 tool_calls、tool 结果没跑完」的中间态，会话存档前检查消息尾部：有悬挂的 tool_call_id 就补一条合成的 role:'tool'（content 为 `{"error":"cancelled"}`），序列保持合法，下次带着这段历史续聊不会被服务端拒。
- 错误：任一轮请求失败（含服务端不支持 tools 的报错）按现状 `finishError` 收尾，循环终止；Agent 模式的错误气泡统一附一条建议「切回 Ask」的提示（不区分错误原因，模型不支持 tools 与网络错误都这么说，不猜原因只给出路，词条 `ai.noToolsTip`）；单个工具执行失败不终止循环——工具返回错误文本（`{"error":"…"}`）作为该 tool_call 的结果回给模型，让模型自己决定换个查法还是收尾。
- 工具结果截断：单条结果超过 8000 字符截断并注明「已截断」，防止单轮把上下文撑爆；每轮全部工具结果总量不再另设上限（8 步 × 8000 字符在 32K 参考窗口内可控，上下文圆环如实反映）。上下文圆环的估算把已产生的 role:'tool' 消息计入（ctxText 现在只算 system + 历史 + 输入，工具轮会把历史撑大）。

## 四、v1 工具集（只读）

| 工具 | 参数 | 实现 | 说明 |
| --- | --- | --- | --- |
| `search_vault` | `query: string` | `searchVault(query, 8)` | 全库内容检索，回 `[{path, title, snippet}]`；query 为空直接回错误文本不发请求 |
| `read_note` | `path: string` | `readMdFile(vaultRoot, path)` | 读库内一篇 md 全文，超 8000 字符截断。模型给的 path 先归一化：剥前导 `/`、拒 `..` 与绝对路径（Rust 侧 vault_join 既有校验兜底，前端先拦省一次 IPC） |
| `list_notes` | 无 | `scanVault` 树扁平化 | 库内全部 md 的 `[{path, title}]` 清单，模型用来挑该读哪篇；大库截前 500 项并在结果里注明总数 |
| `read_current_doc` | 无 | 焦点窗格文档序列化 | 当前文档全文（20000 字符封顶），比 system 里的 6000 字符截断更完整 |
| `query_tag` | `tag: string` | `queryTag(tag)` | 按标签列文档 |

工具描述（function.description）用英文写，约束「先 search/list 再 read，不要凭空猜路径」；未开知识库时 `search_vault` / `read_note` / `list_notes` / `query_tag` 不注册，`read_current_doc` 恒可用（单文件模式也有当前文档）。工具注册表做成数组，按运行时环境过滤后发出去。

安全边界：v1 没有任何写工具、没有 shell、没有网络类工具，模型能做的最坏的事是把库内文本读进上下文。后续写工具批次再引入确认机制。

## 五、UI

- 消息流里的工具行：助手气泡之前插入一行小条目（`ai-tool-row`），内容为图标 + 工具名 + 参数摘要（query / path / tag 原文）+ 状态点（运行中 / 完成 / 失败）；点击行展开结果文本（等宽字体、可复制）。连续多轮就多条工具行，按时间顺序排在助手气泡之间。
- 中间轮的 assistant 消息常常只有 tool_calls 没有文本（模型直接发起调用），这种消息不渲染空气泡，只出工具行；有文本的（「让我先查一下…」再调用）正常出气泡。恢复会话重放时同一规则。
- 流式打字机只渲染助手文本增量；工具执行期间气泡显示「正在调用 search_vault…」占位（与现有「思考中」同款样式）。
- 工具行是渲染层的产物，不入 OpenAI 消息历史；会话存档存原始消息序列（assistant.tool_calls 与 role:'tool' 消息都在），恢复会话时按消息序列重放出工具行。
- stop 语义：流式中 = 取消请求 + 终止循环；工具执行中 = 立即中断执行（剩余工具不再跑）并终止循环。实现口径与现状一致：前端调 `aiChatCancel` 后不等 Rust 的 done 事件（abort 后不会再有事件），当场以「已停止」收尾——循环的 streamRequest 对应地支持 cancelled 即返，不挂起等事件。

### 修改回退

- v1 唯一的修改入口是最终回答的 autoApply（锚点落位写进当前文档），它本来就是单条 ProseMirror 事务，Ctrl+Z 一步可撤。但焦点一挪、undo 栈一深，「撤掉 Agent 那一下」就找不回来了，所以补显式回退。注意 autoApply 不全是插入：光标带选区时 `insertAiMarkdown` 走 `replaceSelection`，是替换——回退若只删新区间，被替换的用户原文就丢了。所以应用事务前后各取一次快照，记录 `{from, to, md, prev}`：`from` / `to` 是落定后的实际插入区间（不能记「pos + md 文本长度」去 `textBetween` 比对——插入的是解析后的 PM 节点，`## 标题` 落成 heading 后文档里只剩 `标题`，长度对不上），`md` 是新写入内容的 markdown 原文，`prev` 是应用前被替换区间的 markdown（纯插入为空串）。气泡尾缀的「已插入到…」标签后加一个「撤销」按钮。
- 回退动作：先校验区间仍有效（`from` / `to` 在文档边界内）且 `serializeMarkdown(doc.slice(from, to))` 与记录的 `md` 一致，一致则单条事务把该区间替换回 `prev` 解析出的节点（`prev` 为空即删除；这条修改自身也在 undo 栈里，可再撤回来），标签变「已撤销」；不一致（用户在应用后编辑过那段）则按钮置灰、悬停提示「文档已改动，无法回退」，此时仍可走 Ctrl+Z。
- 只记录最后一笔：新的 autoApply 会让上一条标签的撤销按钮失效（同一处反复插入，旧记录的 pos 已不可信），与 undo 栈互不干扰。回退记录只存内存，不进会话存档——重启恢复会话后标签不显示撤销按钮（PM pos 是会话内坐标，重启后必然失位）；同会话内切到别的文档再切回来，`canRevert` 校验不过自然置灰（安全方向）。
- 后续写工具批次沿用同一原则并加码：写库文件前经既有 `backupWrite` 存快照、确认弹窗列出将改动的文件；一次循环里的多次写记为一个批次，可整批回退。

## 六、组件划分

### 前端

- **`src/ai-agent.js`（新增）**：循环与工具定义。导出 `AGENT_TOOLS`（JSON Schema 定义表）、`pickTools(env)`（按开库与否过滤）、`runAgentLoop(deps)`、`truncateToolResult(text)`、`summarizeToolArgs(name, args)`；回退侧导出 `canRevert(doc, record)`（区间有效 + slice 再序列化与记录 md 比对）与 `revertRange(doc, record)`（回删除事务的范围）。循环请求与工具执行都由调用方注入（`streamRequest` / `execTool`），纯逻辑可用 Node 单测。
- **`src/ai-panel.js`（改）**：Agent 模式的 `send()` 改走 `runAgentLoop`；`execTool` 按 deps 注入（main.js 提供 `searchVault` / `readMdFile` / `scanVault` / `queryTag` 的桥接与 vaultRoot）；工具行 DOM 渲染；stop 状态从「单个请求」扩成「整个循环」。
- **`src/tauri-bridge.js`（改）**：`aiChatStream` 的 args 增加可选 `tools`，原样透传。
- **`src/main.js`（改）**：给 ai-panel 的 deps 补工具执行器（读 `state.vaultRoot`，无库返回错误对象）。

### Rust（src-tauri/src/ai.rs）

- `AiChatArgs` 加 `tools: Option<serde_json::Value>`，请求体按非空拼进 `tools` 字段。
- 非 2xx 错误体提取兼容 `error` 为字符串的形态（Ollama 400 实锤：`{"error":"<model> does not support tools"}`），现有 `via_json` 只认 error.message，取不到时回退原始 JSON 原文可用但难看，顺带兼容成 error 是字符串就直取。
- SSE 解析加 tool_calls 累积：新纯函数 `extract_tool_call_delta(payload) -> Vec<ToolCallDelta>`（index、id、name、arguments 增量），累积器是 `run_stream` 的局部状态（随请求生灭，不进任务运行表），`run_stream` 结束时把完整 `[{id, name, arguments}]` 经 done 事件带回。
- `AiEvent` 加 `#[serde(skip_serializing_if = "Option::is_none")] tool_calls` 字段；`EmitFn` 签名相应扩展（或改为载荷结构体回调，实现时取简）。
- 纯函数单测：跨 chunk 拼 arguments（含被切开的多字节字符整行场景）、多工具按 index 分组、name/id 只在首片出现、Ollama 整对象形态（单 chunk 带全量 arguments，无需拼接）、`message.tool_calls` 一次性兜底、无 tool_calls 的流不受影响。

## 七、i18n

`src/locales/` 五份：`ai.toolRunning` / `ai.toolDone` / `ai.toolFail` / `ai.toolMaxSteps` / `ai.toolExpand` / `ai.noToolsTip` / `ai.revert` / `ai.reverted` / `ai.revertGone`（文档已改动无法回退的提示）；工具描述不进词条（面向模型的英文）。Rust 侧无新文案。

## 八、测试

- Rust（`cargo test --lib`）：`extract_tool_call_delta` 的分片累积、跨行多字节、index 分组、Ollama 整对象形态、`message.tool_calls` 兜底；带 tools 的请求体拼装；非 2xx 错误体 error 为字符串形态的提取。
- Node（`tests/ai-agent.test.mjs`，假 streamRequest / execTool 驱动循环）：单轮工具调用 → 执行 → 续请求 → 最终回答；多轮循环步数递增；maxSteps 到顶收尾；工具执行失败回填错误文本且循环继续；请求失败终止循环；流式 chunk 之后中途取消（假流在第二步抛停止信号）不再发下一轮请求；role:'tool' 的 content 是字符串（结构化结果 stringify）；续发请求体里 assistant.tool_calls 带 `type:'function'` 且 assistant 与 tool 消息成对；中断后悬挂 tool_call_id 补合成 tool 消息；结果 8000 字符截断；`pickTools` 按开库过滤；`summarizeToolArgs` 摘要；`read_note` 路径归一化（剥前导 `/`、拒 `..` / 绝对路径）；`list_notes` 大清单截断并注明总数。回退用 mdParser 造文档（同 `resolveAnchorPos` 测试口径）：插入场景 `canRevert` 在区间未动时为真、动过后为假，`revertRange` 删掉的区间与记录一致；替换选区场景回退恢复的是原文（`prev` 非空），不是删空。
- 既有测试回归：`tests/ai-tasks.test.mjs` 13 条不动（`parseAgentReply` 锚点协议保留）。

## 九、验收

配 DeepSeek（支持工具调用）实测：问「库里有哪些笔记提到某某主题？」→ 气泡前出现 search_vault 工具行，随后可能跟 read_note，最终回答引用具体笔记路径；「把当前文档的写作建议整理成清单」→ read_current_doc 后给回答并按锚点写进文档，Ctrl+Z 可整体撤销。Ollama 两个方向各验一遍：支持工具的模型（如 qwen3）走通整循环（顺带验整对象分片形态），纯文本模型（如 dolphin-llama3）报错可见、切回 Ask 正常；DeepSeek 换 deepseek-reasoner 再验一遍同类报错。stop 按钮在工具执行中按下：循环终止、无后续请求发出；终止后「开启新对话」归档再续聊，被拒 400 的路径不出现（悬挂 tool_calls 已补合成 tool 消息）。回退两条路各验一遍：插入落点——应用后在文档其他位置继续编辑、焦点离开文档，点标签上的「撤销」仍能精确删掉那一段，应用后手动改过那段文字则按钮置灰并提示；替换落点——光标选中文档里一段再发请求，回答替换选区后点「撤销」，恢复的是被替换的原文而不是删空。重启应用恢复会话，标签上没有撤销按钮（pos 失位不误删）。Ask 模式全程行为与现状逐项一致。
