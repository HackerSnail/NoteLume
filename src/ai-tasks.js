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

/**
 * 任务 → OpenAI messages 数组（可直接交给 ai_chat_stream）。
 * 必须是数组不是对象：Rust 侧 AiChatArgs.messages 是 Vec<AiMessage>，
 * 递个 {system,user} 过去会在 IPC 反序列化阶段就报错、请求根本发不出去。
 * custom 走用户自填指令；未知任务 / custom 无指令回 null。
 */
export function buildTaskMessages(taskId, text, customPrompt) {
  const sel = String(text || '')
  if (taskId === 'custom') {
    const inst = String(customPrompt || '').trim()
    if (!inst) return null
    return [{ role: 'system', content: SYSTEM }, { role: 'user', content: inst + '\n\n---\n' + sel + '\n---' }]
  }
  const build = TASK_BUILDERS[taskId]
  if (!build) return null
  return [{ role: 'system', content: SYSTEM }, { role: 'user', content: build(sel) }]
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

export const DEFAULT_AI = { baseUrl: '', apiKey: '', model: '', asrModel: '', contextTokens: 0, keys: {}, toolsCap: 'auto' }

/** 字段上限。保存前由 validateAiConfig 拒绝超长，normalizeAiConfig 只做存储层兜底截断。 */
export const AI_LIMITS = { baseUrl: 300, apiKey: 300, model: 120 }

/** Agent 工具调用的档位：auto = 有能力信号才判，on = 强制发，off = 强制不发 */
export const AI_TOOL_CAP_MODES = ['auto', 'on', 'off']

/** 一条消息最多带的附图数（ai-panel.js 的附件闸与「出机说明」共用这一个数，别抄两份） */
export const AI_MAX_IMAGES = 4

/** 上下文窗口手填上限（防手滑填天文数字）；0 表示未设，回落到参考值 */
export const AI_CTX_WINDOW_MAX = 10000000

/**
 * 接口地址对应的 Key 分格名：host:port（含端口，本机不同端口的服务算两格）。
 * 地址非法 / 空 → 空串，表示这一条还没有归属。
 */
export function aiKeyHost(baseUrl) {
  const s = String(baseUrl || '').trim()
  if (!s) return ''
  try {
    const u = new URL(s)
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return ''
    return u.host.toLowerCase()
  } catch {
    return ''
  }
}

/** Key 表归一化：只收字符串值、去空、限长；旧版单 Key 首次分格时归到当时地址那一格 */
function normalizeAiKeys(raw, host, legacy) {
  const out = {}
  const src = raw && typeof raw === 'object' ? raw.keys : null
  if (src && typeof src === 'object' && !Array.isArray(src)) {
    for (const [k, v] of Object.entries(src)) {
      if (typeof v !== 'string') continue
      const name = String(k).trim().toLowerCase()
      const val = v.trim().slice(0, AI_LIMITS.apiKey)
      if (name && val) out[name] = val
    }
  }
  if (!Object.keys(out).length && legacy && host) out[host] = legacy
  return out
}

/** 任意来源的原始设置 → 合法 AI 设置（坏类型回落默认；trim + 限长防呆） */
export function normalizeAiConfig(raw) {
  const s = { ...DEFAULT_AI, keys: {} }
  if (!raw || typeof raw !== 'object') return s
  if (typeof raw.baseUrl === 'string') s.baseUrl = raw.baseUrl.trim().slice(0, AI_LIMITS.baseUrl)
  if (typeof raw.model === 'string') s.model = raw.model.trim().slice(0, AI_LIMITS.model)
  // 语音识别模型（OpenAI 兼容 /audio/transcriptions 的 model 参数）；留空 = 语音输入走系统原生识别
  if (typeof raw.asrModel === 'string') s.asrModel = raw.asrModel.trim().slice(0, AI_LIMITS.model)
  // 上下文窗口：非负整数才收，其余（缺字段 / 坏型 / 负数 / NaN）一律回 0 = 用参考值
  const ct = Number(raw.contextTokens)
  if (Number.isFinite(ct) && ct >= 0) s.contextTokens = Math.min(AI_CTX_WINDOW_MAX, Math.floor(ct))
  const legacy = typeof raw.apiKey === 'string' ? raw.apiKey.trim().slice(0, AI_LIMITS.apiKey) : ''
  const host = aiKeyHost(s.baseUrl)
  // 能力门控档位：只认三个值，坏值回 auto（自动判，猜不到就按现状发 tools）
  s.toolsCap = AI_TOOL_CAP_MODES.includes(raw.toolsCap) ? raw.toolsCap : 'auto'
  s.keys = normalizeAiKeys(raw, host, legacy)
  // apiKey 是当前地址那一格的镜像：调用方（面板 / 浮层 / IPC）照旧只读 cfg.apiKey
  s.apiKey = host ? (s.keys[host] || '') : legacy
  return s
}

/** http(s) 绝对地址；其他协议、裸字符串与空串一律 false */
export function isHttpUrl(value) {
  const s = String(value || '').trim()
  if (!s) return false
  try {
    const u = new URL(s)
    return u.protocol === 'http:' || u.protocol === 'https:'
  } catch {
    return false
  }
}

/**
 * 保存前校验：超长与地址格式在这里拦下，避免密钥被静默截短后只收到 401。
 * 返回 { ok, errors, cfg }；errors 的键是字段名，值是 'tooLong' / 'badUrl'。
 */
export function validateAiConfig(raw) {
  const read = (key) => (raw && typeof raw === 'object' && typeof raw[key] === 'string' ? raw[key].trim() : '')
  const baseUrl = read('baseUrl')
  const apiKey = read('apiKey')
  const model = read('model')
  const errors = {}
  if (baseUrl.length > AI_LIMITS.baseUrl) errors.baseUrl = 'tooLong'
  else if (baseUrl && !isHttpUrl(baseUrl)) errors.baseUrl = 'badUrl'
  if (apiKey.length > AI_LIMITS.apiKey) errors.apiKey = 'tooLong'
  if (model.length > AI_LIMITS.model) errors.model = 'tooLong'
  return { ok: Object.keys(errors).length === 0, errors, cfg: normalizeAiConfig(raw) }
}

/** 地址是合法 http(s) 且模型名非空才算配好（API Key 允许为空：本地 Ollama 不需要） */
export function aiConfigured(cfg) {
  return !!(cfg && isHttpUrl(cfg.baseUrl) && String(cfg.model || '').trim())
}

// —— 语音输入（AI 面板的麦克风按钮）——

/**
 * 语音输入走哪条路（纯函数，可单测）。优先级：
 * 1. asr：桌面版 + AI 配好 + 填了语音识别模型——录音在 Rust 侧采，上传服务商转文字；
 * 2. native：桌面版 + 系统有识别引擎（Windows 原生听写，离线可用）；
 * 3. webspeech：浏览器版退回 Web Speech API（Chrome 可用；桌面 WebView2 没有可用的
 *    识别后端，这条在桌面上永远轮不到，只是给网页预览留的口）；
 * 4. none：环境什么都不支持，按钮点了给提示。
 * env: { tauri, webSpeech, native }——native 由调用方探测后缓存（探测有 IPC 开销，别每次点都探）。
 */
export function voicePath(cfg, env) {
  if (env.tauri && aiConfigured(cfg) && String(cfg.asrModel || '').trim()) return 'asr'
  if (env.tauri && env.native) return 'native'
  if (env.webSpeech) return 'webspeech'
  return 'none'
}

/**
 * 原生听写的一场结束时 Rust 给的信号 → 该上屏哪条文案（纯函数，可单测）。
 * kind 是 'end' | 'error'，text 是 voice.rs 里 dictation_done_signal 给的哨兵码，两头是
 * 同一张表的两侧。关键口径：`auto-ended` 是引擎自己收的场（没听到语音 / 停顿到期 /
 * 音频质量不够），不是故障；不单独说一句就只是静默灭灯。真拿不到麦克风才给「改用
 * 服务商转写」的专项指引。回 { key, params }，key 为 null 表示不说话（用户自己点的停）。
 * 未知形态落 ai.voiceErr 并原样把串附上屏，不编造原因。
 */
export function dictationDoneInfo(kind, text) {
  const s = String(text || '')
  if (kind === 'end') {
    return s === 'auto-ended' ? { key: 'ai.voiceSessionEnd' } : { key: null }
  }
  if (s === 'mic-unavailable') return { key: 'ai.voiceMicUnavailable' }
  if (s === 'network-unavailable') return { key: 'ai.voiceNetwork' }
  const m = /^engine-error:(-?\d+)$/.exec(s)
  if (m) return { key: 'ai.voiceEngineErr', params: { code: m[1] } }
  return { key: 'ai.voiceErr', params: { err: s || 'unknown' } }
}

/** 原生听写一场的总预算（毫秒）：与 Rust 侧 ASR 那路的录音上限同源（voice.rs 的
 *  REC_MAX_SECS），免得麦克风一直开着收声。 */
export const DICT_SESSION_MAX_MS = 120000
/** 连续自动续场的次数闸。真机实测：静默时引擎每约 5 秒自终一场，120 秒预算走完要 24 次左
 *  右，所以这个数比预算大一点——日常由 DICT_SESSION_MAX_MS 定终点，这一档只当循环刹车：
 *  引擎当场就死（续一次死一次）时不能无限转圈。 */
export const DICT_RESUME_MAX = 25

/**
 * 引擎自终后要不要原地续一场（纯函数，可单测）。四个条件全过才续：
 * 信号是引擎自终（auto-ended）、用户没点停（还在 native 态）、总时长还在预算内、循环没跑飞。
 * Rust 那侧对这一档留着引擎，所以续场只是一次 start IPC（本机实测约 80ms，重建要 0.5s）。
 */
export function shouldResumeDictation(s) {
  if (!s) return false
  return s.text === 'auto-ended'
    && s.state === 'native'
    && s.now < s.deadline
    && s.resumes < DICT_RESUME_MAX
}

/** 零模型时建议拉的本地模型：中文强、体积 1.3 GB 量级、capabilities 带 tools（本机 qwen3:1.7b 实测），
 *  小内存机器也跑得动。换型号只改这里——预设行与首启引导的文案都跟着它走。
 *  与 AI_PRESETS 的 ollama 行同一个值：选了本地预设又建议另一个模型，两个口径迟早漂移。 */
export const OLLAMA_SUGGEST_MODEL = 'qwen3:1.7b'

/** 常见 OpenAI 兼容服务预设：设置面板一键填充地址 + 模型名（Key 仍需用户自填） */
export const AI_PRESETS = [
  { id: 'deepseek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' },
  { id: 'zhipu', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4' },
  { id: 'kimi', baseUrl: 'https://api.moonshot.cn/v1', model: 'kimi-k2' },
  { id: 'openai', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' },
  { id: 'ollama', baseUrl: 'http://127.0.0.1:11434/v1', model: OLLAMA_SUGGEST_MODEL },
]

// —— Ollama 首启引导：探测四档 → 该走哪条动作（纯映射，Node 可单测）——

/**
 * `ollama_probe` 的返回值 → 该走的引导。四档各一条，不再把「没装 / 装了没起 / 起了零模型」
 * 挤成同一句话（此前只回 bool，后两档根本分不开）。
 * 坏数据（老版本回 true、探测抛错回 null）一律 kind 'none'——探测本身出问题时不打扰用户。
 * 返回 { kind: 'none'|'install'|'start'|'pull'|'ready', bodyKey, titleKey, model? }
 */
export function ollamaFlowFor(status) {
  switch (String((status && status.state) || '')) {
    case 'missing':
      return { kind: 'install', bodyKey: 'ollama.missingBody', titleKey: 'ollama.installBtn', model: '' }
    case 'stopped':
      return { kind: 'start', bodyKey: 'ollama.stoppedBody', titleKey: 'ollama.retryBtn', model: '' }
    case 'no_models':
      return { kind: 'pull', bodyKey: 'ollama.pullAsk', titleKey: 'ollama.pullBtn', model: OLLAMA_SUGGEST_MODEL }
    case 'ready':
      return { kind: 'ready', bodyKey: '', titleKey: '', model: '' }
    default:
      return { kind: 'none', bodyKey: '', titleKey: '', model: '' }
  }
}

/** 探测结果能不能用（服务可达）：没装 / 装了没起都算不能用，别把连不上的地址填进预设 */
export function ollamaUsable(status) {
  const st = String((status && status.state) || '')
  return st === 'ready' || st === 'no_models'
}

/** 地址是不是只往本机发：回环与 localhost 才算。其余（含局域网 IP 与 .local）一律按「会出机」提示，宁可多说一句 */
export function isLoopbackUrl(url) {
  const raw = String(url || '').trim()
  if (!raw) return false
  // 先认协议：只有 http(s) 才谈得上「发到哪儿」，ftp://127.0.0.1 之类不算本机地址
  if (!isHttpUrl(raw)) return false
  let host = ''
  try { host = new URL(raw).hostname } catch { return false }
  const h = String(host || '').replace(/^\[|\]$/g, '').toLowerCase()
  if (!h || h === '0.0.0.0') return false
  if (h === '::1' || h === 'localhost' || h.endsWith('.localhost')) return true
  // 127.0.0.1 / 127.8.9.10 这一整段都是回环
  return /^127\.\d{1,3}(\.\d{1,3}){0,2}$/.test(h)
}

/**
 * 「哪些内容会离开本机」的变量表：数字全部取自上面那些真实生效的常量，文案只插值——
 * 改了截断值说明自己跟着变，不会出现「文档写 6000、代码截 4000」这种漂移。
 * 工具结果的截断值在 ai-agent.js（TOOL_RESULT_MAX_CHARS），由调用方并进来，这里不反向依赖。
 */
export function aiEgressVars(cfg) {
  const baseUrl = String((cfg && cfg.baseUrl) || '')
  return {
    host: aiKeyHost(baseUrl) || '',
    local: isLoopbackUrl(baseUrl),
    doc: DOC_CONTEXT_MAX_CHARS,
    vaultDocs: AI_VAULT_MAX_DOCS,
    snippet: AI_VAULT_SNIPPET_MAX_CHARS,
    vaultTotal: AI_VAULT_CONTEXT_MAX_CHARS,
    imgs: AI_MAX_IMAGES,
  }
}

// —— Agent 模式的能力门控：该不该给这个模型发 tools ——

/**
 * 模型名比对：大小写、`:latest` 尾巴与只写仓库名都算同一个。
 * 用户在设置里敲 `qwen3` 而本机装的是 `qwen3:1.7b` 是常态，严格全等会把支持的模型误判成不支持。
 */
export function sameModelName(a, b) {
  const norm = (s) => String(s || '').trim().toLowerCase().replace(/:latest$/, '')
  const x = norm(a)
  const y = norm(b)
  if (!x || !y) return false
  if (x === y) return true
  const repo = (s) => s.split(':')[0]
  // 一边没写 tag：按仓库名比（qwen3 ↔ qwen3:1.7b）。写了 tag 的两边不等就不算同一个
  if (!x.includes(':') || !y.includes(':')) return repo(x) === repo(y)
  return false
}

/**
 * 三态返回：true 支持 / false 明确不支持 / null 没有能力信号。
 * null 一律按现状发 tools——远程 OpenAI 兼容服务不返 capabilities，猜它不支持比不猜更糟；
 * 旧版 Ollama 不返该字段时 hasCaps 为 false，同样不算结论（空表 ≠ 都不支持）。
 */
export function supportsToolCalling(cfg, status) {
  const mode = AI_TOOL_CAP_MODES.includes(cfg && cfg.toolsCap) ? cfg.toolsCap : 'auto'
  if (mode === 'on') return true
  if (mode === 'off') return false
  const model = String((cfg && cfg.model) || '').trim()
  if (!model || !status || !Array.isArray(status.models) || !status.models.length) return null
  // 只有本机 Ollama 的探测结果里有能力表，远程地址拿到的 models 是 /models 的名字，没有 capabilities
  if (!isLoopbackUrl((cfg && cfg.baseUrl) || '')) return null
  if (!status.hasCaps || !Array.isArray(status.toolModels)) return null
  const hit = status.models.filter((m) => sameModelName(m, model))
  if (!hit.length) return null
  return hit.some((m) => status.toolModels.some((t) => sameModelName(t, m)))
}

// —— Agent 模式：回答落点协议（自然语言锚点） ——

/**
 * 剥掉文本里所有落点标记 `<insert …>` / `</insert>`（大小写不敏感，替换成换行避免把
 * 前后文字粘连）。模型把协议标记当正文吐出来时，残留的每一个标记都不能漏进用户文档，
 * 所以这里是全局口径，不是「只剥首个 / 只剥尾部」。
 */
export function stripInsertMarkers(text) {
  return String(text || '').replace(/<\/?insert\b[^>]*>/gi, '\n')
}

/**
 * 模型认为「这句没有要写进文档的内容」时吐的占位标记：`<empty>` / `[empty]` / 「空」这类
 * 成对界符包着一个空词的形状。界符不可省——裸的「无 / None」可能正是真回答（“文档里没提到”），不能吞。
 */
const EMPTY_MARK_RE = /^\s*[<[(（【「“‘"']\s*(?:empty|none|null|nil|无内容|空字符串|空)\s*[>\])）】」”’"']\s*$/i

/** 整段正文只是一个占位标记时判为空回答 */
export function isPlaceholderReply(text) {
  return EMPTY_MARK_RE.test(String(text || '').trim())
}

/**
 * Agent 回答落点协议：模型在内容开头放 <insert after="位置"> 或 <insert before="位置">，
 * 「位置」引用文档中已有的标题或段落原文；正文跟在标记后（闭合 </insert> 可省）。
 * 标记前的文字一律视为客套引导剥掉。无标记时 anchor 为 null，body 走 stripFences。
 */
export function parseAgentReply(raw) {
  const s = String(raw || '')
  // 占位标记不是正文：换成空串，面板改走思考/空回答兜底，Agent 的自动写入跟着跳过
  const bodyOf = (t) => { const b = stripFences(t); return isPlaceholderReply(b) ? '' : b }
  const strict = s.match(/<insert\s+(after|before)="([^"]{1,120})"\s*>/i)
  const target = strict ? strict[2].trim() : ''
  if (strict && target) {
    let body = s.slice(strict.index + strict[0].length)
    body = stripInsertMarkers(body)
    return {
      anchor: { dir: strict[1].toLowerCase(), target },
      body: bodyOf(body),
      anchorBroken: false,
    }
  }
  // 标记存在但目标不合法（超 120 字符 / 含双引号 / 属性残缺）：锚点放弃，标记本身
  // 仍要从正文里剥掉——模型写坏的标记不该连同内容一起写进用户文档。
  const loose = s.match(/<insert\b[^>]*>/i)
  if (!loose) return { anchor: null, body: bodyOf(s), anchorBroken: false }
  let body = s.slice(loose.index + loose[0].length)
  body = stripInsertMarkers(body)
  return { anchor: null, body: bodyOf(body), anchorBroken: true }
}

const normText = (s) => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim()

// —— AI 全库检索：问题分词 + 检索结果拼装（纯逻辑可单测；searchVault 调用在 main.js）——

export const AI_VAULT_MAX_DOCS = 5

/** 上下文窗口参考值（估算圆环分母）：各家模型 8K~1M 不等，取保守的 32K 作提示基准 */
export const AI_CTX_WINDOW_TOKENS = 32768

/** 圆环分母优先取用户在设置里填的真实上下文窗口，未填（0/坏值）回落到上面的保守参考值 */
export function aiContextWindow(cfg) {
  const n = Number(cfg && cfg.contextTokens)
  return Number.isFinite(n) && n > 0 ? n : AI_CTX_WINDOW_TOKENS
}

/** 粗估 token 数：CJK 字符 ≈ 1 token/字，其它按 4 字符 ≈ 1 token（中英混合经验值） */
export function estimateTokens(text) {
  let cjk = 0
  let other = 0
  for (const ch of String(text || '')) {
    if (ch.charCodeAt(0) > 0x2e80) cjk++
    else other++
  }
  return Math.ceil(cjk + other / 4)
}

/**
 * 从用户问题里提取检索词：英文/数字词原样取（≥2 字符），中文段滑窗取相邻 2-gram
 * （索引是子串匹配，2-gram 覆盖词中组合）；总量限 12 个防请求爆炸。
 */
export function aiQueryTerms(question) {
  const q = String(question || '')
  const terms = new Set()
  for (const m of q.matchAll(/[A-Za-z0-9_\-+#./]{2,}/g)) terms.add(m[0].toLowerCase())
  for (const m of q.matchAll(/[\u4e00-\u9fff]{2,}/g)) {
    const seg = m[0]
    for (let i = 0; i < seg.length - 1 && i < 8; i++) terms.add(seg.slice(i, i + 2))
  }
  return [...terms].filter((t) => t.length >= 2).slice(0, 12)
}

/** 注入文本总长上限（表头与命中条目合计）。 */
export const AI_VAULT_CONTEXT_MAX_CHARS = 6000

/** 单条检索片段的截断长度。提成常量是为了「出机说明」能引用它，别在文案里抄一份数字。 */
export const AI_VAULT_SNIPPET_MAX_CHARS = 400

/**
 * 合并去重后的检索命中 → 注入文本。hits: [{path,title,snippet}]；
 * 超过 AI_VAULT_MAX_DOCS 篇截断，总量 6000 字符封顶（表头计入）。
 */
export function buildVaultContext(hits, headText) {
  const list = (Array.isArray(hits) ? hits : []).filter((h) => h && h.path)
  if (!list.length) return ''
  // 表头计入总量：先按上限截断表头，条目只在剩余空间里追加，总长稳定不超过上限。
  const head = String(headText || '').slice(0, AI_VAULT_CONTEXT_MAX_CHARS)
  let text = (head ? head + '\n' : '').slice(0, AI_VAULT_CONTEXT_MAX_CHARS)
  if (text.length >= AI_VAULT_CONTEXT_MAX_CHARS) return text
  for (const h of list.slice(0, AI_VAULT_MAX_DOCS)) {
    const entry = `- ${h.title || h.path}（${h.path}）\n  ${String(h.snippet || '').slice(0, AI_VAULT_SNIPPET_MAX_CHARS)}\n`
    const room = AI_VAULT_CONTEXT_MAX_CHARS - text.length
    if (room <= 0) break
    text += entry.slice(0, room)
    if (entry.length > room) break
  }
  return text
}

/**
 * 在文档顶层块里解析锚点 → 插入位置（ProseMirror pos）。doc 由调用方给（前端视图 / 测试里 mdParser 造）。
 * 标题优先（全等 / 互相包含即中），其次按段落等文本块的前缀匹配；找不到回 null（调用方回退光标落点）。
 */
export function resolveAnchorPos(doc, anchor) {
  if (!doc || !anchor || typeof anchor.target !== 'string') return null
  const target = normText(anchor.target)
  if (!target) return null
  // 标题全等优先：模型复述锚点时给前缀/子串很常见，不能让同前缀的长标题先出现就定终身。
  // 没有全等项时才退到互相包含匹配，最后才是正文段落前缀。
  let headingExact = null
  let headingHit = null
  let textHit = null
  doc.forEach((node, offset) => {
    if (headingExact) return
    const text = normText(node.textContent)
    if (!text) return
    if (node.type && node.type.name === 'heading') {
      if (text === target) headingExact = { offset, node }
      else if (!headingHit && (text.includes(target) || target.includes(text))) headingHit = { offset, node }
      return
    }
    if (!textHit && (text.startsWith(target) || target.startsWith(text.slice(0, 40)))) textHit = { offset, node }
  })
  const hit = headingExact || headingHit || textHit
  if (!hit) return null
  const start = hit.offset + 1 // forEach 的 offset 是该块在 doc 内容中的起始偏移，doc 开口占 1
  return anchor.dir === 'before' ? start : start + hit.node.nodeSize
}

// —— 多模态（图片输入）支持判定 ——

// 服务端不会先告知模型能力，本地按模型名启发式：命中已知视觉模型才放行上传，
// 其余一律当纯文本拦下（宁可误拦，也不把图片塞给不支持的服务端炸请求）。
const VISION_PATTERNS = [
  /gpt-4\.?o/, /gpt-4\.1/, /gpt-4-turbo/, /chatgpt-4o/, /(^|\W)o[134](\W|$)/,
  /claude-?[3-9]/, /claude-(sonnet|opus|haiku)/,
  /gemini/,
  /qwen[\w.-]*vl|qvq/, /glm-[\d.]*v/,
  /doubao[\w.-]*vision|doubao-?seed-?1\.?6/,
  /moonshot[\w.-]*vision|kimi[\w.-]*vision/,
  /pixtral/, /llava/, /llama[\w.-]*vision/, /internvl/, /minicpm-?v/,
  /grok-?[4-9]|grok-?vision/, /step-?1v/, /hunyuan-?vision/,
]

/** 模型名命中已知视觉模型名单才算支持图片输入；空名 / 未知名一律 false */
export function modelSupportsVision(model) {
  const m = String(model || '').toLowerCase()
  if (!m.trim()) return false
  return VISION_PATTERNS.some((re) => re.test(m))
}

// —— /models 列表里的非对话模型 ——
// 聚合服务（SiliconFlow 一类）把向量、重排、文生图与语音模型和对话模型放在同一张表里，
// 按名称升序自动填第一个就可能填到 BAAI/bge-m3 这种 embedding 模型——发
// /chat/completions 回 400「Model does not exist」，看着像接口连不上。只按明确特征摘，
// 认不准的留在列表里（宁可不删，也别把能用的对话模型删掉）。
const NON_CHAT_PATTERNS = [
  /embed/, /rerank/, /bge-/, /bce-/, /m3e-/, /gte-/, /mxbai/,
  /whisper/, /\btts\b/, /cosyvoice/, /speech/, /\basr\b/,
  /flux/, /stable-diffusion/, /sdxl/, /dall-e/, /imagen/, /kolors/, /hunyuanimage/,
  /clip/, /ocr/,
]

/** id 看着不像对话模型（向量 / 重排 / 文生图 / 语音）；空名不算 */
export function isNonChatModel(id) {
  const m = String(id || '').toLowerCase()
  if (!m.trim()) return false
  return NON_CHAT_PATTERNS.some((re) => re.test(m))
}

/** /models 列表只留对话模型（顺带去空串与重复）；全被摘光时回原表，不给空候选 */
export function chatModelsOnly(list) {
  const arr = [...new Set((Array.isArray(list) ? list : []).map((x) => String(x || '').trim()).filter(Boolean))]
  const kept = arr.filter((id) => !isNonChatModel(id))
  return kept.length || !arr.length ? kept : arr
}
