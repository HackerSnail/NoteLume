# AI 面板 Agent 工具循环（agent loop）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Agent 模式升级为 OpenAI function calling 工具循环——模型多轮调用只读工具（检索 / 读文档）后给最终回答，按既有锚点协议落文档，修改可显式回退，全程可终止。

**Architecture:** 循环在前端驱动（新模块 `src/ai-agent.js`，纯逻辑 Node 可测），Rust（`src-tauri/src/ai.rs`）保持「转发 + 解析」：加 `tools` 透传与 SSE tool_calls 按 index 累积，done 事件带回完整数组。工具执行器由 `main.js` 注入（复用既有 IPC，不新增 Rust 命令）。

**Tech Stack:** Vanilla JS、ProseMirror（回退区间操作）、serde_json（工具参数透传）、Node 内置 test 跑法（`check()` 计数，同既有测试）。

**Spec:** `docs/superpowers/specs/2026-11-02-ai-agent-loop-design.md`

## Global Constraints

- 前端原生 ES Module Vanilla JS，不引 Vue/React（CLAUDE.MD 硬性约束 2）。
- Rust 只透传与解析：`tools` / `content` 一律 `serde_json::Value` 原样转发，Rust 不理解工具语义。
- 判定「本轮要执行工具」只看累积 tool_calls 非空，不看 `finish_reason`。
- `role:'tool'` 的 `content` 必须是字符串（结构化结果 `JSON.stringify`）。
- 回传 `assistant.tool_calls` 元素必须补 `type:'function'`。
- maxSteps = 8；单条工具结果截 8000 字符；`read_current_doc` 封顶 20000 字符；`list_notes` 截 500 项注明总数。
- 界面文案进 `src/locales/` 五份（zh-CN / zh-Hant / en-US / fr-FR / de-DE），不写死中文；工具 description 面向模型，用英文，不进词条。
- 测试跑法：`cd src && node tests/ai-agent.test.mjs`（package.json 加 `test:ai-agent`）；Rust 侧 `cargo test --lib`。
- 注释与文档按 CLAUDE.MD「文档写作要求」：直陈问题与改法，不写总结句。

## Review Focus

- Ollama 整对象形态：tool_calls 单 chunk 一次到齐、可能缺 `index` → Task 1 测试钉住。
- Ollama 400 错误体 `error` 是字符串而非 `{message}` 嵌套 → Task 1 测试钉住。
- 终止停在「assistant 带 tool_calls、tool 结果没跑完」：消息序列必须补合成 tool 消息，否则下次续聊 400 → Task 2 / Task 3 测试钉住。
- 回退的替换落点：autoApply 在光标带选区时是替换，回退要恢复原文而不是删空 → Task 4 测试钉住。
- 工具参数防呆：`read_note` 的 path 剥前导 `/`、拒 `..` 与绝对路径；空 query 不发请求 → Task 2 测试钉住。

---

### Task 1: Rust 侧 tools 透传与 tool_calls 累积

**Files:**
- Modify: `src-tauri/src/ai.rs`

**Interfaces:**
- Consumes: 既有 `AiChatArgs` / `run_stream` / `handle_line` / `AiEvent` / `EmitFn`。
- Produces:
  - `AiChatArgs.tools: Option<serde_json::Value>`，非空时拼进请求体 `tools` 字段。
  - `struct ToolCallDelta { index: usize, id: Option<String>, name: Option<String>, args_delta: String }`。
  - `extract_tool_call_delta(payload: &str) -> Vec<ToolCallDelta>`：解析一条 SSE data 载荷里的 `delta.tool_calls[]`（缺 `index` 按 0）与 `message.tool_calls[]`（网关忽略 stream 的兜底，整对象一次返回），与 content 解析互不干扰。
  - 累积器 `ToolCallAccumulator`（`run_stream` 局部状态）：`push(&mut self, d: ToolCallDelta)`（有 `id` 视为新调用起始、整对象直接落全量 arguments，无 `id` 按 index 追加 arguments）与 `finish(self) -> Option<Vec<(String, String, String)>>`（(id, name, arguments)，空则 None）。
  - `AiEvent` 加 `tool_calls: Option<serde_json::Value>`（skip_serializing_if None）；`EmitFn` 扩为四参：`Fn(&str, Option<String>, Option<String>, Option<serde_json::Value>)`，done 时带累积结果。
  - 非 2xx 错误体提取兼容 `error` 为字符串形态（Ollama 400：`{"error":"<model> does not support tools"}`）。

- [ ] **Step 1: 写失败测试**（`ai.rs` 的 `mod tests` 扩展）

```rust
#[test]
fn tool_call_delta_fragment_form() {
    // OpenAI 碎片：首片带 id/name/空 arguments，次片只有 index + arguments 增量
    let v = extract_tool_call_delta(r#"{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"search_vault","arguments":""}}]}}]}"#);
    assert_eq!(v.len(), 1);
    assert_eq!(v[0].id.as_deref(), Some("call_1"));
    assert_eq!(v[0].name.as_deref(), Some("search_vault"));
    let v2 = extract_tool_call_delta(r#"{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\"query\":"}}]}}]}"#);
    assert_eq!(v2[0].args_delta, "{\"query\":");
    assert_eq!(v2[0].id, None);
}

#[test]
fn tool_call_delta_ollama_whole_object() {
    // Ollama：整对象一次到齐，可能缺 index（按 0 归位）
    let v = extract_tool_call_delta(r#"{"choices":[{"delta":{"tool_calls":[{"id":"call_9","function":{"name":"read_note","arguments":"{\"path\":\"a.md\"}"}}]}}]}"#);
    assert_eq!(v[0].index, 0);
    assert_eq!(v[0].args_delta, "{\"path\":\"a.md\"}");
}

#[test]
fn tool_call_delta_message_fallback_and_content() {
    // 网关忽略 stream：message.tool_calls 整数组
    let v = extract_tool_call_delta(r#"{"choices":[{"message":{"role":"assistant","tool_calls":[{"id":"c","function":{"name":"list_notes","arguments":"{}"}}]}}]}"#);
    assert_eq!(v.len(), 1);
    // 纯 content chunk / 无关载荷不受影响
    assert!(extract_tool_call_delta(r#"{"choices":[{"delta":{"content":"hi"}}]}"#).is_empty());
    assert!(extract_tool_call_delta("not json").is_empty());
}

#[test]
fn tool_call_accumulator_groups_by_index() {
    // 两个工具交错分片按 index 归组；name/id 只在首片出现不丢
}

#[test]
fn error_body_error_as_string() {
    // 非 2xx 错误体 error 为字符串形态（Ollama）→ 提取出该字符串
}
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cargo test --lib`
Expected: 编译失败（`extract_tool_call_delta` 等未定义）。

- [ ] **Step 3: 实现**

`ToolCallDelta` / `extract_tool_call_delta` / `ToolCallAccumulator` 按上列签名实现；`AiChatArgs` 加 `tools`；`run_stream` 的请求体按 `Some` 拼装、流处理循环里把 delta 喂进局部累积器、结束时经 done 事件带回；`EmitFn` 四参改造连带既有测试里的 emit 闭包签名；非 2xx 错误提取加 `error` 为字符串的分支（`v.get("error").as_str()` 先于 `.get("message")` 试）。

- [ ] **Step 4: 跑测试确认通过**

Run: `cargo test --lib`
Expected: 全过（既有 330+ 条不回归）。

- [ ] **Step 5: Commit**

```bash
git add src-tauri/src/ai.rs
git commit -m "ai.rs 支持 tools 透传与流式 tool_calls 累积，错误体兼容字符串形态"
```

### Task 2: 工具注册表与纯函数（`src/ai-agent.js` 上半）

**Files:**
- Create: `src/ai-agent.js`
- Create: `src/tests/ai-agent.test.mjs`
- Modify: `src/package.json`（scripts 加 `"test:ai-agent": "node tests/ai-agent.test.mjs"`）

**Interfaces:**
- Consumes: 无（纯逻辑，不 import PM / IPC）。
- Produces:
  - `AGENT_TOOLS`：五个工具的 `{type:'function', function:{name, description, parameters}}` 数组，description 英文，约束「先 search/list 再 read，不要凭空猜路径」。名字：`search_vault`（query）/ `read_note`（path）/ `list_notes` / `read_current_doc` / `query_tag`（tag）。
  - `pickTools(env: {vaultReady: boolean}) -> array`：无库时只留 `read_current_doc`。
  - `truncateToolResult(text, max = 8000) -> string`：超长截断并在尾部注明「…(truncated)」。
  - `normalizeReadPath(p) -> string|null`：剥前导 `/`、拒 `..` / 盘符绝对路径 / 空串，非法回 null。
  - `summarizeToolArgs(name, argsJson) -> string`：取 query / path / tag 原文，解析失败回原始串截断 60 字符。
  - `repairHangingToolCalls(messages) -> array`：扫描序列，assistant.tool_calls 里未被紧跟的 role:'tool' 覆盖的 tool_call_id，补 `{role:'tool', tool_call_id, content:'{"error":"cancelled"}'}`（插在该 assistant 之后、下一 assistant 之前），返回新数组不改入参。

- [ ] **Step 1: 写失败测试**

`src/tests/ai-agent.test.mjs`，结构照 `src/tests/ai-tasks.test.mjs`（`check(name, fn)` 计数，结尾 `process.exitCode`）。本任务用例：

```js
import { AGENT_TOOLS, pickTools, truncateToolResult, normalizeReadPath, summarizeToolArgs, repairHangingToolCalls } from '../ai-agent.js'

check('AGENT_TOOLS 五个工具，schema 齐全', () => { /* 每个有 type==='function'、function.name/description/parameters.type==='object' */ })
check('pickTools 无库只剩 read_current_doc', () => { /* pickTools({vaultReady:false}) 长度 1 且名字对；true 时 5 个 */ })
check('normalizeReadPath 剥前导斜杠、拒 .. 与绝对路径', () => {
  assert.strictEqual(normalizeReadPath('/notes/a.md'), 'notes/a.md')
  assert.strictEqual(normalizeReadPath('../a.md'), null)
  assert.strictEqual(normalizeReadPath('C:\\a.md'), null)
  assert.strictEqual(normalizeReadPath(''), null)
})
check('truncateToolResult 截断并注明', () => { /* 8001 字符 → 8000 + 尾注；8000 以内原样 */ })
check('summarizeToolArgs 取参数原文，坏 JSON 兜底', () => { /* search_vault + '{"query":"x"}' → 'x'；'not json' → 截断原文 */ })
check('repairHangingToolCalls 补悬挂 tool_call_id', () => {
  // [assistant(tool_calls:[c1,c2]), tool(c1)] → 补 c2 的合成 tool 消息在 tool(c1) 之后
  // 完整序列原样返回；入参对象不被修改
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd src && node tests/ai-agent.test.mjs`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现** 按上列签名；`repairHangingToolCalls` 用 map 记每个 assistant 后已出现的 tool_call_id，缺的按序补。

- [ ] **Step 4: 跑测试确认通过** Run: `cd src && node tests/ai-agent.test.mjs` Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/ai-agent.js src/tests/ai-agent.test.mjs src/package.json
git commit -m "新增 ai-agent.js：Agent 工具注册表、参数防呆与悬挂 tool_calls 修复"
```

### Task 3: 工具循环 `runAgentLoop`

**Files:**
- Modify: `src/ai-agent.js`
- Modify: `src/tests/ai-agent.test.mjs`

**Interfaces:**
- Consumes: Task 2 的全部导出。
- Produces: `runAgentLoop(deps) -> Promise<{text, stopped, maxed, messages}>`

```js
runAgentLoop({
  messages,       // OpenAI 格式数组（system + 历史），循环内拷贝推进，返回值带回完整序列
  tools,          // pickTools 产物（每轮请求原样带上）
  maxSteps = 8,
  streamRequest,  // async (messages) => { text, toolCalls|null, cancelled? }；失败 throw Error
  execTool,       // async (name, argsJson) => string（返回值已是该 tool_call 的 content 字符串）
  onDelta,        // (chunk) => void 流式助手文本
  onTool,         // (name, argsSummary, state) => void，state: 'running'|'done'|'fail'
  shouldStop,     // () => boolean，发请求前与每个工具执行前轮询
})
```

行为：每步 `streamRequest` → done 有 toolCalls 则 assistant 消息（content = 本轮流出的文本，可为空串；tool_calls 补 `type:'function'`）推进，逐个执行工具（结果字符串直接用 `execTool` 返回值，调用方负责截断——循环内不再截）与回填 role:'tool'，未到 maxSteps 续下一轮；无 toolCalls 即最终回答。`shouldStop` 命中：不再发请求、剩余工具补合成 tool 消息（`{"error":"cancelled"}`），返回 `stopped: true`。`maxSteps` 到顶返回 `maxed: true` 与最后一条助手文本。`streamRequest` 抛错返回 `error` 文案。注意：循环不发 onDelta 之外的通知，无 UI 依赖，可 Node 直测。

- [ ] **Step 1: 写失败测试**（追加进 `src/tests/ai-agent.test.mjs`）

```js
import { runAgentLoop } from '../ai-agent.js'
// 假 streamRequest：按脚本逐轮返回；记录每次收到的 messages

check('单轮工具调用后给最终回答', () => { /* 第1轮回 toolCalls，第2轮回文本；断言 messages 里 assistant(tool_calls+type) 与 tool 成对、最终 text 对、请求共 2 次 */ })
check('多轮循环步数递增且 tools 每轮都带', () => { /* 两轮工具后回答；断言 3 次请求、每次请求 messages 尾部序列合法 */ })
check('maxSteps 到顶收尾返回 maxed', () => { /* streamRequest 恒回 toolCalls，maxSteps=2；断言 maxed、请求恰 2 次 */ })
check('工具执行失败回填错误文本且循环继续', () => { /* execTool 抛错/返回 {"error":..} 均成 tool 消息，下一轮继续 */ })
check('中途取消：不发下一轮、剩余工具补合成消息', () => { /* shouldStop 在第2轮工具执行后为真；断言请求共 2 次、stopped、悬挂 id 已补 {"error":"cancelled"} */ })
check('请求失败终止循环返回 error', () => { /* streamRequest throw；断言 error 文案、无下一轮 */ })
check('流式中取消：半截文本推进历史、无下一轮', () => { /* streamRequest 回 {cancelled:true, text:'半截'}；断言 stopped、assistant(半截文本) 无 tool_calls、请求共 1 次 */ })
check('role:tool 的 content 恒为字符串', () => { /* execTool 返回对象时由调用方 stringify——本测试断言循环原样透传字符串 */ })
```

- [ ] **Step 2: 跑测试确认失败** Run: `cd src && node tests/ai-agent.test.mjs` Expected: 新用例 FAIL（`runAgentLoop` 未定义）。

- [ ] **Step 3: 实现** 按上列行为；工具顺序执行保证结果与 tool_calls 数组同序。

- [ ] **Step 4: 跑测试确认通过** Run: `cd src && node tests/ai-agent.test.mjs` Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/ai-agent.js src/tests/ai-agent.test.mjs
git commit -m "ai-agent.js 加 runAgentLoop：工具循环、步数上限与终止语义"
```

### Task 4: 修改回退（捕获 + 校验 + 回退事务）

**Files:**
- Modify: `src/main.js`（`insertAiMarkdown` 返回落定区间；`appendToDoc` 产出回退记录）
- Modify: `src/ai-agent.js`（`canRevert` / `revertRange`）
- Modify: `src/tests/ai-agent.test.mjs`

**Interfaces:**
- Consumes: `serializeMarkdown` / `mdParser`（`src/editor-schema.js`）；`insertAiMarkdown`（main.js 现有）。
- Produces:
  - `insertAiMarkdown(inst, text, opts)` 改为返回 `{from, to} | null`：`tr.replaceSelection(slice)` 后用 `tr.mapping.map(from, -1)` / `map(to, 1)` 算落定区间（`from` / `to` 取替换前的选区边界）；解析兜底 `insertPlainText` 路径回 null。
  - `captureRevert(view, text) -> record|null`（main.js，appendToDoc 的包装内调用）：替换前取选区 `[from, to]` 与 `prev = from !== to ? serializeMarkdown(doc.slice(from,to)) : ''`，dispatch 后取 `{from2, to2}`，`record = {from, to, md: serializeMarkdown(view.state.doc.slice(from2,to2)), prev}`——`md` 用序列化产物而非原文，保证 `canRevert` 的等值比对口径一致。
  - `canRevert(doc, record) -> boolean`：区间在边界内且 `serializeMarkdown(doc.slice(from,to)) === record.md`。
  - `revertRange(view, record) -> boolean`：`canRevert` 过才动手——`prev` 为空 `tr.delete(from,to)`，非空 `tr.replaceWith(from, to, mdParser(record.prev).content)`，单条事务 dispatch，返回是否执行。

- [ ] **Step 1: 写失败测试**（追加进 `src/tests/ai-agent.test.mjs`）

```js
import { canRevert, revertRange } from '../ai-agent.js'
import { mdParser, serializeMarkdown } from '../editor-schema.js'
// 文档构造：mdParser.parse(md) 得 doc（同 resolveAnchorPos 测试口径）
// 视图桩：{ state: EditorState.create({doc}), dispatch(tr){ this.state = this.state.apply(tr) } }

check('canRevert 区间未动为真、动过后为假', () => { /* 插入后原样 → true；在区间内改一个字 → false */ })
check('revertRange 插入场景删掉记录区间', () => { /* 回退后 doc 文本不含插入内容，返回 true */ })
check('revertRange 替换场景恢复原文', () => { /* prev 非空：回退后该区间序列化 === prev */ })
check('revertRange 校验不过返回 false 不动文档', () => {})
```

- [ ] **Step 2: 跑测试确认失败** Run: `cd src && node tests/ai-agent.test.mjs` Expected: 新用例 FAIL。

- [ ] **Step 3: 实现** `canRevert` / `revertRange` 进 ai-agent.js（import editor-schema 两件）；main.js 的 `insertAiMarkdown` 加返回值、`appendToDoc` 的三个落点分支统一走 `captureRevert`，返回值带 `record`。

- [ ] **Step 4: 跑测试确认通过** Run: `cd src && node tests/ai-agent.test.mjs && cd .. && cargo test --lib` Expected: 全过（main.js 改动不触 Rust，cargo 跑一遍防意外）。

- [ ] **Step 5: Commit**

```bash
git add src/main.js src/ai-agent.js src/tests/ai-agent.test.mjs
git commit -m "Agent 落文档加显式回退：落定区间捕获、slice 再序列化校验、替换场景恢复原文"
```

### Task 5: 面板接线（循环 / 工具行 / stop / 存档重放 / i18n）

**Files:**
- Modify: `src/ai-panel.js`
- Modify: `src/tauri-bridge.js`（`aiChatStream` args 加可选 `tools` 原样透传）
- Modify: `src/main.js`（ai-panel deps 注入 `execTool`：switch 工具名调 `searchVault` / `readMdFile` / `scanVault` / `queryTag` / 焦点窗格序列化，无库回错误字符串；`state.vaultRoot` 判 `vaultReady`）
- Modify: `src/locales/*.js` 五份
- Create: `src/tests/ai-agent-dom.test.mjs`
- Modify: `src/package.json`（`test:ai-agent-dom`）

**Interfaces:**
- Consumes: Task 2/3/4 的全部导出；`aiChatStream` / `aiChatCancel` / `aiChatListen`（既有）。
- Produces:
  - panel 内 `streamRequest(messages)`：生成 reqId → `aiChatStream({reqId, messages, tools: currentTools, ...cfg})` → 现有 `aiChatListen` 分发按 reqId 收 chunk（调 onDelta）→ done/error/cancelled resolve `{text, toolCalls, cancelled}`。
  - `execTool(name, args)`：`search_vault` 空 query 回错误字符串；`read_note` 过 `normalizeReadPath` 后 `readMdFile` + `truncateToolResult`；`list_notes` 扁平化截 500 项注明总数；`read_current_doc` 序列化截 20000；`query_tag` 直调。所有结果 `JSON.stringify` 成字符串。
  - Agent 模式 `send()`：`pickTools` → `runAgentLoop`（一次性检索注入跳过，Ask 保留）；工具行渲染挂 `onTool`；stop 设 stopFlag + `aiChatCancel`；收尾走既有 `parseAgentReply` / autoApply（`stopped` 不自动应用，`maxed` 加标签）。
  - 上下文圆环：`ctxText` 把 role:'tool' 消息计入（spec「工具轮会把历史撑大」条）。
  - 工具行（`ai-tool-row`）：图标 + 工具名 + `summarizeToolArgs` + 状态点，点击展开结果；只有 tool_calls 没文本的 assistant 消息不渲染空气泡（重放同规则）。
  - 存档 / 恢复：`saveChat` 前过 `repairHangingToolCalls`；恢复后 role:'tool' 消息重放为工具行（结果在 content 里）；`nl-ai-mode` 语义不变。
  - 词条五语言：`ai.toolRunning` / `ai.toolDone` / `ai.toolFail` / `ai.toolMaxSteps` / `ai.toolExpand` / `ai.noToolsTip` / `ai.revert` / `ai.reverted` / `ai.revertGone`。
  - 回退按钮：autoApply 标签后加「撤销」（`ai.revert`），点击 `revertRange` 成功变「已撤销」（`ai.reverted`），`canRevert` 为假置灰悬停 `ai.revertGone`；记录只存内存，新 autoApply 使旧记录失效。

- [ ] **Step 1: 写失败测试**（`src/tests/ai-agent-dom.test.mjs`，jsdom，结构照 `src/tests/git-panel-dom.test.mjs`）

```js
// 用 createAiPanel 的最小 deps 桩（假 streamRequest/execTool 走 Task 3 的脚本桩）
check('工具行：工具执行期出现 running 行，完成后变 done，点击展开结果文本', () => {})
check('只有 tool_calls 没文本的 assistant 消息不出空气泡', () => {})
check('恢复存档：role:tool 消息重放为工具行', () => {})
check('maxSteps 到顶出现上限标签；stopped 出「已停止」标签', () => {})
check('Agent 模式错误气泡带「切回 Ask」提示（ai.noToolsTip）', () => {})
check('回退按钮：插入后点「撤销」文档区间被删、标签变「已撤销」；手动改过后按钮置灰', () => {})
```

- [ ] **Step 2: 跑测试确认失败** Run: `cd src && node tests/ai-agent-dom.test.mjs` Expected: FAIL。

- [ ] **Step 3: 实现** 按上列；bridge 的 `tools` 透传一行；词条五份补齐（中文简繁措辞分开写，不机械复制）。

- [ ] **Step 4: 跑测试确认通过** Run: `cd src && node tests/ai-agent.test.mjs && node tests/ai-agent-dom.test.mjs && node tests/ai-tasks.test.mjs` Expected: 全过（`ai-tasks` 13 条回归）。

- [ ] **Step 5: Commit**

```bash
git add src/ai-panel.js src/tauri-bridge.js src/main.js src/locales src/tests/ai-agent-dom.test.mjs src/package.json
git commit -m "AI 面板 Agent 模式接工具循环：工具行、终止、存档重放与回退按钮，词条五语言"
```

### Task 6: 文档与收尾

**Files:**
- Modify: `docs/CLAUDE.MD`（「大模型接入」一节补 agent loop 段：循环位置、工具集、可终止与回退口径、错误兼容）
- Modify: `CHANGELOG.md`（有则补条目，无则跳过）

- [ ] **Step 1: 按实际实现写文档**，直陈行为与取舍，对照 CLAUDE.MD「文档写作要求」自查一遍（无总结句、无戏剧化用词）。
- [ ] **Step 2: 全量回归** Run: `cd src && node tests/ai-agent.test.mjs && node tests/ai-agent-dom.test.mjs` 与 `cargo test --lib` Expected: 全过。
- [ ] **Step 3: Commit**

```bash
git add docs/CLAUDE.MD CHANGELOG.md
git commit -m "CLAUDE.MD 补 Agent 工具循环一节"
```

### Task 7: 真机验收（不改代码，产出记录）

对照 spec 第九节逐项：DeepSeek 走通整循环与锚点落文档；Ollama qwen3 整对象分片形态；dolphin-llama3 / deepseek-reasoner 的 400 报错与切回 Ask；工具执行中 stop；悬挂 tool_calls 修复后续聊不 400；回退的插入 / 替换 / 置灰 / 重启四路；Ask 模式逐项与现状一致。验收记录写回 CLAUDE.MD 对应条目。
