// ai-agent-dom.test.mjs —— AI 面板 Agent 工具循环的 DOM 链路：工具行、空内容气泡、
// 回退按钮、停止 / 错误收尾与恢复重放
// 运行：cd src && node tests/ai-agent-dom.test.mjs
//
// 与 git-panel-dom.test.mjs 同一打桩方式：真模块 ai-panel.js + tauri-bridge.js，invoke 打桩；
// 循环请求经 deps.streamRequest 测试接缝注入（不走 nl:ai-event 事件通道）。
import assert from 'node:assert'
import { JSDOM } from 'jsdom'

const dom = new JSDOM('<!doctype html><html><body><div id="ai-panel"></div></body></html>', {
  url: 'http://localhost/',
})
global.window = dom.window
global.document = dom.window.document
Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true })
global.localStorage = dom.window.localStorage
global.HTMLElement = dom.window.HTMLElement
// Node 22 自带 CustomEvent，但 jsdom 的 window.dispatchEvent 只认自家实例
global.CustomEvent = dom.window.CustomEvent
global.Event = dom.window.Event
dom.window.localStorage.setItem('nl-lang', 'zh-CN')
dom.window.localStorage.setItem('nl-ai-mode', 'agent') // 模块加载时读，必须先于 import

// unlisten 内部走这个注册表，给个空实现让 destroy 的退订不出错
window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} }

window.__TAURI_INTERNALS__ = {
  // listen 经 transformCallback 注册回调拿事件 id，这里恒返回自增 id，事件不投递
  transformCallback(callback) {
    return 1
  },
  invoke(cmd) {
    switch (cmd) {
      case 'ai_skills_scan':
        return Promise.resolve([])
      case 'ai_chat_save':
        return Promise.resolve()
      case 'ai_chat_read':
        return Promise.resolve(null)
      case 'ai_models_list':
        return Promise.resolve(['m'])
      case 'plugin:event|listen':
        return Promise.resolve(() => {})
      default:
        return Promise.resolve(null)
    }
  },
}

const { createAiPanel } = await import('../ai-panel.js')
const { setLocale } = await import('../i18n.js')

let pass = 0
let fail = 0
const queue = []
function t(name, fn) {
  // 串行执行：用例里的 setLocale 会重建所有面板 DOM，并发会互相冲掉在途断言
  queue.push(async () => {
    try {
      await fn()
      pass++
      console.log('  ok   ' + name)
    } catch (e) {
      fail++
      console.log('  FAIL ' + name + ' —— ' + ((e && e.message) || e))
      if (e && e.stack) console.log(e.stack.split('\n').slice(1, 6).join('\n'))
    }
  })
}

async function until(fn, ms = 3000) {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    if (fn()) return
    await new Promise((r) => setTimeout(r, 10))
  }
  throw new Error('condition not met within ' + ms + 'ms')
}

function makePanel(overrides = {}) {
  const root = document.createElement('div')
  document.body.appendChild(root)
  const applied = []
  let reverted = 0
  const deps = {
    root,
    getConfig: () => ({ baseUrl: 'http://x/v1', apiKey: '', model: 'm' }),
    openSettings: () => {},
    getDocContext: () => '',
    insertToDoc: () => {},
    setStatus: () => {},
    vaultReady: () => true,
    execTool: async () => '[{"path":"a.md","title":"A"}]',
    appendToDoc: (text) => {
      applied.push(text)
      return { ok: true, where: '旧标题', missed: false, record: { from: 1, to: 4, md: text, prev: '' } }
    },
    canRevertAgentEdit: () => reverted === 0,
    revertAgentEdit: () => {
      reverted++
      return true
    },
    ...overrides,
  }
  const panel = createAiPanel(deps)
  return { panel, root, applied, getReverted: () => reverted }
}

function send(root, text) {
  const input = root.querySelector('.ai-input')
  input.value = text
  root.querySelector('.ai-send').click()
}

t('工具行 running→done，点击展开结果；无空气泡；回答按锚点应用并出现撤销按钮', async () => {
  let round = 0
  const { panel, root, applied, getReverted } = makePanel({
    streamRequest: async () => {
      round++
      if (round === 1) {
        return { text: '让我查一下', toolCalls: [{ id: 'c1', name: 'search_vault', arguments: '{"query":"x"}' }] }
      }
      return { text: '<insert after="旧标题">新内容', toolCalls: null }
    },
  })
  try {
    send(root, '库里有什么')
    await until(() => root.querySelector('.ai-applied'))
    // 工具行：一轮调用，终态 done
    const rows = [...root.querySelectorAll('.ai-tool-row')]
    assert.strictEqual(rows.length, 1)
    assert.ok(rows[0].classList.contains('done'))
    assert.strictEqual(rows[0].querySelector('.ai-tool-name').textContent, 'search_vault')
    assert.strictEqual(rows[0].querySelector('.ai-tool-args').textContent, 'x')
    // 点击展开结果文本
    rows[0].click()
    const pre = rows[0].querySelector('.ai-tool-result')
    assert.ok(!pre.classList.contains('hidden'))
    assert.ok(pre.textContent.includes('a.md'))
    // 气泡：末段文本（锚点标记已剥）；测试接缝没有 chunk 事件，中间轮文本进历史
    // 而不进气泡流式区——恢复重放用例会验到它以独立气泡出现
    const bubbles = [...root.querySelectorAll('.ai-bot')]
    assert.ok(bubbles.length >= 1)
    for (const b of bubbles) assert.ok(b.textContent.trim().length > 0, 'assistant 气泡不应为空')
    assert.ok(bubbles.some((b) => b.textContent.includes('新内容')))
    // 应用 + 撤销按钮
    assert.strictEqual(applied.length, 1)
    assert.strictEqual(applied[0], '新内容') // 锚点标记已剥
    const btn = root.querySelector('.ai-revert-btn')
    assert.ok(btn && !btn.disabled)
    btn.click()
    await until(() => getReverted() === 1)
    assert.ok(root.querySelector('.ai-applied').textContent.includes('已撤销'))
  } finally {
    panel.destroy()
    root.remove()
  }
})

t('恢复重放：locale 重建后工具行从历史重放出来，仍无空气泡', async () => {
  let round = 0
  const { panel, root } = makePanel({
    streamRequest: async () => {
      round++
      if (round === 1) {
        return { text: '', toolCalls: [{ id: 'c1', name: 'read_note', arguments: '{"path":"a.md"}' }] }
      }
      return { text: '最终回答', toolCalls: null }
    },
  })
  try {
    send(root, '看看 a.md')
    await until(() => root.querySelector('.ai-applied'))
    // 切语言触发 buildDom + renderHistory（重放路径）
    setLocale('en-US')
    await until(() => root.querySelector('.ai-tool-row'))
    const rows = [...root.querySelectorAll('.ai-tool-row')]
    assert.strictEqual(rows.length, 1)
    assert.ok(rows[0].classList.contains('done'))
    assert.strictEqual(rows[0].querySelector('.ai-tool-name').textContent, 'read_note')
    rows[0].click()
    assert.ok(rows[0].querySelector('.ai-tool-result').textContent.includes('a.md'))
    // 中间轮 assistant 只有 tool_calls 没文本：不出空气泡
    for (const b of root.querySelectorAll('.ai-bot')) assert.ok(b.textContent.trim().length > 0)
    setLocale('zh-CN')
  } finally {
    panel.destroy()
    root.remove()
  }
})

t('步数到顶出现上限标签，不自动应用', async () => {
  const { panel, root, applied } = makePanel({
    streamRequest: async () => ({ text: '继续查', toolCalls: [{ id: 'c1', name: 'list_notes', arguments: '{}' }] }),
  })
  try {
    send(root, '列全库')
    await until(() => root.textContent.includes('已达工具步数上限'))
    assert.strictEqual(applied.length, 0)
  } finally {
    panel.destroy()
    root.remove()
  }
})

t('流式中取消：半截回答保留、出「已停止」标签、不自动应用', async () => {
  const { panel, root, applied } = makePanel({
    streamRequest: async () => ({ cancelled: true, text: '半截回答' }),
  })
  try {
    send(root, '写一段')
    await until(() => [...root.querySelectorAll('.ai-stopped')].some((el) => el.textContent === '已停止'))
    assert.strictEqual(applied.length, 0)
    assert.ok(root.querySelector('.ai-bot').textContent.includes('半截回答'))
  } finally {
    panel.destroy()
    root.remove()
  }
})

t('请求失败：错误气泡带「切回 Ask」提示', async () => {
  const { panel, root } = makePanel({
    streamRequest: async () => {
      throw new Error('HTTP 400: does not support tools')
    },
  })
  try {
    send(root, '试试')
    await until(() => root.querySelector('.ai-err'))
    assert.ok(root.querySelector('.ai-err').textContent.includes('does not support tools'))
    assert.ok(root.querySelector('.ai-err-tip').textContent.includes('Ask'))
  } finally {
    panel.destroy()
    root.remove()
  }
})

for (const job of queue) await job()
console.log(`\n${pass} passed, ${fail} failed`)
process.exitCode = fail ? 1 : 0
