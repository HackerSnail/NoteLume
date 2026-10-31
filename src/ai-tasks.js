// ai-tasks.js —— 大模型接入的任务定义与纯逻辑（Node 可单测）
//
// 三块内容：
//  1. 选区 AI 的任务提示词拼装（润色 / 续写 / 翻译 / 摘要 / 自定义）
//  2. 侧栏对话的文档上下文拼装
//  3. AI 设置（settings.json 的 ai 段）归一化 + 常见服务预设
// 网络与 SSE 都在 Rust 侧（ai.rs），这里不碰 IPC。

/** 选区 AI 的任务 id（右键菜单 / 命令面板共用） */
export const AI_TASK_IDS = ['polish', 'continue', 'translate', 'summarize', 'custom']

// 系统指令用英文（对各家模型都稳），核心约束三条：只回结果、保持原语言（翻译除外）、保留 Markdown 结构。
// 「只回结果」靠约束 + 前端把常见客套前缀剥掉双保险，见 stripFences。
const SYSTEM = 'You are a writing assistant embedded in a Markdown editor. ' +
  'Follow the user\'s task on the given text. Reply with the result text ONLY — ' +
  'no explanations, no preamble, no code fences, no surrounding quotes. ' +
  'Preserve the original language unless the task is a translation. ' +
  'Keep the Markdown structure (headings, lists, links) when present.'

const TASK_BUILDERS = {
  polish: (text) =>
    'Polish the following text: fix grammar and wording, improve fluency and clarity. ' +
    'Keep the original meaning; length roughly unchanged.\n\n---\n' + text + '\n---',
  continue: (text) =>
    'Continue writing naturally from where the following text ends. ' +
    'Output ONLY the continuation; do not repeat the given text.\n\n---\n' + text + '\n---',
  translate: (text) =>
    'Translate the following text: if it is mainly Chinese, translate it into English; ' +
    'otherwise translate it into Chinese. Keep the formatting.\n\n---\n' + text + '\n---',
  summarize: (text) =>
    'Summarize the following text in one short paragraph, in the same language as the text.\n\n---\n' + text + '\n---',
}

/** 任务 → OpenAI messages。custom 走用户自填指令；未知任务回 null。 */
export function buildTaskMessages(taskId, text, customPrompt) {
  const sel = String(text || '')
  if (taskId === 'custom') {
    const inst = String(customPrompt || '').trim()
    if (!inst) return null
    return { system: SYSTEM, user: inst + '\n\n---\n' + sel + '\n---' }
  }
  const build = TASK_BUILDERS[taskId]
  if (!build) return null
  return { system: SYSTEM, user: build(sel) }
}

/** 模型爱客套：剥掉结果外层的 ``` 围栏与「以下是…：/Here is…：」式整行引导 */
export function stripFences(text) {
  let s = String(text || '').trim()
  const fence = s.match(/^```[^\n]*\n([\s\S]*?)\n?```$/)
  if (fence) s = fence[1]
  s = s.replace(/^(?:以下是[^:\n]*[:：]?|这是[^:\n]*[:：]?|好的[，,]?|Sure[,!]?|Here(?:'s| is)[^:\n]*[:：]?)\s*\n?/i, '')
  return s.trim()
}

// —— 侧栏对话：当前文档作上下文 ——

export const DOC_CONTEXT_MAX_CHARS = 6000

/** 文档上下文（系统消息）。空文档回 ''（不加系统消息，模型直接闲聊） */
export function buildDocContext(title, text) {
  const body = String(text || '').slice(0, DOC_CONTEXT_MAX_CHARS)
  if (!body.trim()) return ''
  const name = String(title || '').trim() || 'untitled'
  return (
    'The user is currently editing a Markdown document titled "' + name + '". ' +
    'Content (may be truncated):\n\n---\n' + body + '\n---\n\n' +
    'Answer questions about this document when asked. ' +
    'If the answer is not in the document, say so briefly, then answer from general knowledge.'
  )
}

// —— AI 设置（settings.json 的 ai 段）——

export const DEFAULT_AI = { baseUrl: '', apiKey: '', model: '' }

/** 任意来源的原始设置 → 合法 AI 设置（坏类型回落默认；trim + 限长防呆） */
export function normalizeAiConfig(raw) {
  const s = { ...DEFAULT_AI }
  if (!raw || typeof raw !== 'object') return s
  if (typeof raw.baseUrl === 'string') s.baseUrl = raw.baseUrl.trim().slice(0, 300)
  if (typeof raw.apiKey === 'string') s.apiKey = raw.apiKey.trim().slice(0, 300)
  if (typeof raw.model === 'string') s.model = raw.model.trim().slice(0, 120)
  return s
}

/** 地址 + 模型齐了才算配好（API Key 允许为空：本地 Ollama 不需要） */
export function aiConfigured(cfg) {
  return !!(cfg && String(cfg.baseUrl || '').trim() && String(cfg.model || '').trim())
}

/** 常见 OpenAI 兼容服务预设：设置面板一键填充地址 + 模型名（Key 仍需用户自填） */
export const AI_PRESETS = [
  { id: 'deepseek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  { id: 'zhipu', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4' },
  { id: 'kimi', baseUrl: 'https://api.moonshot.cn/v1', model: 'kimi-k2' },
  { id: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  { id: 'ollama', baseUrl: 'http://127.0.0.1:11434/v1', model: 'llama3.1' },
]
