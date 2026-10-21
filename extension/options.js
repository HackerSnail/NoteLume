// options.js —— 选项页：读写 chrome.storage.sync，测试连接走 GET /health
const $ = (id) => document.getElementById(id)

const DEFAULTS = {
  serverUrl: 'http://127.0.0.1:3210',
  folder: '',
  template: '',
}

function setStatus(msg, ok) {
  const el = $('status')
  el.textContent = msg
  el.className = ok === true ? 'ok' : ok === false ? 'err' : ''
}

async function load() {
  const cfg = await chrome.storage.sync.get(DEFAULTS)
  $('serverUrl').value = cfg.serverUrl || DEFAULTS.serverUrl
  $('folder').value = cfg.folder || ''
  $('template').value = cfg.template || ''
}

async function save() {
  const serverUrl = $('serverUrl').value.trim().replace(/\/+$/, '')
  // 服务只绑 127.0.0.1：地址必须是回环，避免用户填了外网地址白跑
  let host = ''
  try {
    host = new URL(serverUrl).hostname
  } catch (e) {
    setStatus('地址格式不对', false)
    return
  }
  if (host !== '127.0.0.1' && host !== 'localhost') {
    setStatus('地址必须是本机回环（127.0.0.1 或 localhost）', false)
    return
  }
  await chrome.storage.sync.set({
    serverUrl,
    folder: $('folder').value.trim(),
    template: $('template').value.trim(),
  })
  setStatus('已保存', true)
}

async function testConnection() {
  const serverUrl = $('serverUrl').value.trim().replace(/\/+$/, '') || DEFAULTS.serverUrl
  setStatus('连接中…')
  try {
    const resp = await fetch(serverUrl + '/health')
    const data = await resp.json().catch(() => null)
    if (!resp.ok || !data || data.ok !== true) {
      setStatus('NoteLume 没响应：' + (data && data.message ? data.message : resp.status), false)
      return
    }
    setStatus(
      '连接正常 · 端口 ' + data.port + (data.hasVault ? ' · 已打开知识库' : ' · 还没打开知识库'),
      true
    )
  } catch (e) {
    setStatus('连不上：请确认 NoteLume 已启动且剪藏服务已启用', false)
  }
}

$('save').addEventListener('click', save)
$('test').addEventListener('click', testConnection)
load()
