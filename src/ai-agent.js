// ai-agent.js —— Agent 模式的工具循环：工具注册表、纯逻辑与回退校验（Node 可单测）
//
// 循环在前端驱动：模型经 OpenAI function calling 回 tool_calls，本地执行只读工具
// （检索 / 读文档），结果以 role:'tool' 回填后继续下一轮，直到无工具调用的最终回答。
// 网络仍在 Rust 侧（ai.rs），这里不碰 IPC——请求与工具执行由调用方注入（ai-panel / main.js）。
// 回退校验依赖编辑器 schema 的序列化器与解析器（editor-schema.js），仅 canRevert / revertRange 用到。

import { serializeMarkdown, mdParser } from './editor-schema.js'

// —— 工具注册表（v1 全只读） ——

// description 用英文（对各家模型都稳），核心约束：先查清单 / 检索再读文件，不要凭空猜路径。
export const AGENT_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'search_vault',
      description:
        "Full-text search across the user's Markdown vault. " +
        'Returns a list of {path, title, snippet}. Use this first when the answer may live in other notes.',
      parameters: {
        type: 'object',
        properties: { query: { type: 'string', description: 'Search keywords' } },
        required: ['query'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_note',
      description:
        'Read one Markdown note from the vault by its relative path (from search_vault or list_notes results). ' +
        'Long notes are truncated. Do not guess paths.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string', description: 'Vault-relative path of the note' } },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_notes',
      description: 'List all Markdown notes in the vault as {path, title}. Use it to find which note to read next.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_current_doc',
      description: 'Read the full content of the document the user is currently editing. Longer than the automatic context.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'query_tag',
      description: 'List notes that carry a given #tag. Returns {path, title} entries.',
      parameters: {
        type: 'object',
        properties: { tag: { type: 'string', description: 'Tag name without the # prefix' } },
        required: ['tag'],
      },
    },
  },
]

/** 按运行环境过滤工具：未开知识库时只留 read_current_doc（单文件模式也有当前文档） */
export function pickTools(env) {
  const ready = !!(env && env.vaultReady)
  return AGENT_TOOLS.filter((t) => ready || t.function.name === 'read_current_doc')
}

// —— 工具结果整形 ——

export const TOOL_RESULT_MAX_CHARS = 8000

/** 单条工具结果超长截断并注明，防止单轮把上下文撑爆 */
export function truncateToolResult(text, max = TOOL_RESULT_MAX_CHARS) {
  const s = String(text ?? '')
  if (s.length <= max) return s
  return s.slice(0, max) + '\n\n…(truncated)'
}

/**
 * 模型给的 read_note path 归一化：剥前导斜杠、拒 .. 上跳与绝对路径
 * （Rust 侧 vault_join 既有校验兜底，前端先拦省一次 IPC）。非法回 null。
 */
export function normalizeReadPath(p) {
  const s = String(p ?? '').trim().replace(/\\/g, '/')
  if (!s) return null
  if (/^[a-z]:/i.test(s)) return null // Windows 盘符绝对路径
  const stripped = s.startsWith('/') ? s.slice(1) : s
  if (
    !stripped ||
    stripped === '..' ||
    stripped.startsWith('../') ||
    stripped.includes('/../') ||
    stripped.endsWith('/..')
  ) {
    return null
  }
  return stripped
}

/** 工具行参数摘要：取 query / path / tag 原文，解析失败回原始串截断 */
export function summarizeToolArgs(name, argsJson) {
  let args = null
  try {
    args = JSON.parse(String(argsJson || '{}'))
  } catch {
    args = null
  }
  const key = { search_vault: 'query', read_note: 'path', query_tag: 'tag' }[name]
  const raw = key && args && typeof args[key] === 'string' ? args[key] : String(argsJson || '')
  const s = raw.trim()
  return s.length > 60 ? s.slice(0, 60) + '…' : s
}

// —— 悬挂 tool_calls 修复 ——

// OpenAI 协议要求每条带 tool_calls 的 assistant 后面必须紧跟每个 tool_call_id 的
// role:'tool' 消息，缺了服务端直接 400。终止 / 出错可能停在中间态，存档与续发请求前补齐。
export const CANCELLED_TOOL_RESULT = '{"error":"cancelled"}'

/** 补齐序列里未被 role:'tool' 覆盖的 tool_call_id（合成结果插在该 assistant 段末尾）。不改入参。 */
export function repairHangingToolCalls(messages) {
  const out = []
  let pending = [] // 当前 assistant 段里还没见到结果的 tool_call_id
  for (const m of Array.isArray(messages) ? messages : []) {
    if (m && m.role === 'assistant' && Array.isArray(m.tool_calls) && m.tool_calls.length) {
      if (pending.length) {
        for (const id of pending) out.push({ role: 'tool', tool_call_id: id, content: CANCELLED_TOOL_RESULT })
        pending = []
      }
      out.push(m)
      pending = m.tool_calls.map((c) => c && c.id).filter(Boolean)
      continue
    }
    if (m && m.role === 'tool' && pending.includes(m.tool_call_id)) {
      pending = pending.filter((id) => id !== m.tool_call_id)
      out.push(m)
      continue
    }
    // 任何其他消息（下一条 user / 无 tool_calls 的 assistant）之前把悬挂的补上
    if (pending.length) {
      for (const id of pending) out.push({ role: 'tool', tool_call_id: id, content: CANCELLED_TOOL_RESULT })
      pending = []
    }
    out.push(m)
  }
  if (pending.length) {
    for (const id of pending) out.push({ role: 'tool', tool_call_id: id, content: CANCELLED_TOOL_RESULT })
  }
  return out
}

// —— 工具循环 ——

export const AGENT_MAX_STEPS = 8

/**
 * Agent 工具循环（前端驱动）。deps：
 * - messages：OpenAI 格式数组（system + 历史），循环内拷贝推进，返回值带回完整序列
 * - tools：pickTools 产物，每轮请求原样带上
 * - maxSteps：请求轮数上限（含工具轮），到顶不再发请求
 * - streamRequest：async (messages) => { text, toolCalls|null, cancelled? }，失败 throw
 *   （流式 chunk 经 onDelta 回调；面板侧取消后以 cancelled 即返，不挂起等事件）
 * - execTool：async (name, argsJson) => string | {content, ok}（返回值即该 tool_call 的
 *   content 字符串，调用方负责 JSON.stringify 与截断；循环原样透传）
 * - onDelta：(chunk) => void；onTool：(name, argsSummary, state) => void，state: running|done|fail
 * - shouldStop：() => boolean，发请求前与每个工具执行前轮询
 * 返回 { text, stopped, maxed, error, messages }：text 是最终回答（可能为半截或空串）；
 * stopped = 中途终止；maxed = 步数到顶；error = 请求失败文案。
 */
export async function runAgentLoop(deps) {
  const {
    messages,
    tools = [],
    maxSteps = AGENT_MAX_STEPS,
    streamRequest,
    execTool,
    onDelta = () => {},
    onTool = () => {},
    shouldStop = () => false,
  } = deps
  const seq = (Array.isArray(messages) ? messages : []).slice()
  let lastText = ''
  let stopped = false
  let maxed = false
  let error = null
  let finished = false // 走到「无 toolCalls 的最终回答」
  for (let step = 0; step < maxSteps && !stopped && !error && !finished; step++) {
    if (shouldStop()) {
      stopped = true
      break
    }
    let resp = null
    try {
      resp = await streamRequest(seq)
    } catch (e) {
      error = (e && e.message) || String(e)
      break
    }
    const text = String((resp && resp.text) || '')
    lastText = text
    if (resp && resp.cancelled) {
      if (text) seq.push({ role: 'assistant', content: text })
      stopped = true
      break
    }
    const calls = resp && Array.isArray(resp.toolCalls) && resp.toolCalls.length ? resp.toolCalls : null
    if (!calls) {
      seq.push({ role: 'assistant', content: text })
      finished = true
      break
    }
    // assistant 带 tool_calls：content 可为空串；元素补全 type:'function'
    // （done 载荷为省字节只带 {id,name,arguments}，严格校验的服务端缺 type 会拒收）
    seq.push({
      role: 'assistant',
      content: text,
      tool_calls: calls.map((c) => ({
        id: c.id,
        type: 'function',
        function: { name: c.name, arguments: c.arguments },
      })),
    })
    // 工具执行是同步 IPC 链，终止点挂在每个工具执行前；剩余的补合成结果保序列合法
    let ran = 0
    let aborted = false
    for (const c of calls) {
      if (shouldStop()) {
        aborted = true
        break
      }
      const summary = summarizeToolArgs(c.name, c.arguments)
      onTool(c.name, summary, 'running')
      let content = ''
      let ok = true
      try {
        const res = await execTool(c.name, c.arguments)
        content = typeof res === 'string' ? res : String((res && res.content) ?? '')
        ok = typeof res === 'object' && res !== null ? res.ok !== false : true
      } catch (e) {
        // 单个工具失败不终止循环：错误文本作为该 tool_call 的结果回给模型，由它决定换查法还是收尾
        content = JSON.stringify({ error: (e && e.message) || String(e) })
        ok = false
      }
      seq.push({
        role: 'tool',
        tool_call_id: c.id,
        content: typeof content === 'string' ? content : JSON.stringify(content),
      })
      onTool(c.name, summary, ok ? 'done' : 'fail')
      ran++
    }
    if (aborted) {
      for (const c of calls.slice(ran)) {
        seq.push({ role: 'tool', tool_call_id: c.id, content: CANCELLED_TOOL_RESULT })
      }
      stopped = true
    }
  }
  if (!stopped && !error && !finished) maxed = true
  return { text: lastText, stopped, maxed, error, messages: seq }
}

// —— 修改回退 ——

// record 由 main.js 的 agentApplyWithRevert 产出：{from, to, md, prev}。
// md 是落定区间的序列化产物（不是 markdown 原文——插入的是解析后的节点，字符数对不上），
// prev 是应用前被替换区间的序列化产物（纯插入为空串）。

/** 区间仍在文档内且序列化产物与记录一致（用户没动过那段）才允许回退 */
export function canRevert(doc, record) {
  if (!doc || !record) return false
  const { from, to, md } = record
  if (!Number.isInteger(from) || !Number.isInteger(to)) return false
  if (from < 0 || to > doc.content.size || from >= to) return false
  try {
    return serializeMarkdown(doc.cut(from, to)) === md
  } catch {
    return false
  }
}

/** 回退：prev 非空把区间替换回原文（恢复替换语义），为空则删除。单条事务，自身可再撤销。 */
export function revertRange(view, record) {
  if (!view || !canRevert(view.state.doc, record)) return false
  const tr = view.state.tr
  if (record.prev) {
    let prevDoc = null
    try {
      prevDoc = mdParser.parse(record.prev)
    } catch {
      prevDoc = null
    }
    if (!prevDoc || !prevDoc.content.size) return false
    tr.replaceWith(record.from, record.to, prevDoc.content)
  } else {
    tr.delete(record.from, record.to)
  }
  view.dispatch(tr)
  return true
}
