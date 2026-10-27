// drop-open.js —— 拖入打开（P5 §6.6）：纯路径助手 + 主区域拖放绑定
//
// 主区域（.body）监听 dragover / drop：拖进来的文档按「打开文件」处理，文件夹按
// 「打开知识库」处理，其余由调用方决定是否降级为纯文本。落库与否的判定不在这里——
// 本模块只负责把 DataTransfer 里的路径干净地取出来。
//  · 路径来源优先 DataTransferItem.webkitGetAsEntry()：只有它能给出文件夹 entry。
//    Windows 下 entry.fullPath 形如 /C:/a/b.md（前导斜杠），normDropPath 剥掉。
//  · dataTransfer.files 的 path 属性是 Tauri webview 注入的（Windows 的 WebView2 有、mac 的
//    WKWebView 没有），作兜底；mac 打包版靠原生拖放事件那条通道，见 main.js 的 bindNativeDrop。

const OPENABLE_EXTS = ['md', 'markdown', 'canvas']

// 这类文件拖进来不弹「按纯文本打开」：二进制 / 系统文件读出来没有意义，
// 静默跳过。exe 自身拖进窗口就落在这一档。
const BINARY_EXTS = ['exe', 'dll', 'msi', 'msp', 'com', 'scr', 'cpl', 'msc', 'sys', 'ocx', 'lnk']

/** WebView 拖放 fullPath 在 Windows 下形如 /C:/a/b.md：剥掉开头的 / 还原成绝对路径 */
export function normDropPath(p) {
  let s = String(p || '').trim()
  if (!s) return ''
  s = s.split('\\').join('/') // 统一成正斜杠再判断盘符前缀
  if (/^\/[a-z]:\//i.test(s)) s = s.slice(1)
  return s
}

/** 能否直接当文档打开（按扩展名）；其余走「按纯文本打开」的降级确认 */
export function isDroppableName(name) {
  const base = String(name || '')
  const dot = base.lastIndexOf('.')
  if (dot < 0) return false
  return OPENABLE_EXTS.includes(base.slice(dot + 1).toLowerCase())
}

/** 二进制 / 系统文件（exe、dll 之类）：连「按纯文本打开」的确认都不给，直接跳过 */
export function isBinaryName(name) {
  const base = String(name || '')
  const dot = base.lastIndexOf('.')
  if (dot < 0) return false
  return BINARY_EXTS.includes(base.slice(dot + 1).toLowerCase())
}

/**
 * 从 DataTransfer 收集拖入的目标：[{ path, isDir }]。
 * items 优先（能拿文件夹）；拿不到再退 files 的 path 属性。
 */
export function collectDropPaths(dt) {
  const out = []
  const items = dt && dt.items ? Array.from(dt.items) : []
  if (items.length && typeof items[0].webkitGetAsEntry === 'function') {
    for (const it of items) {
      let entry = null
      try {
        entry = it.webkitGetAsEntry()
      } catch {
        entry = null // getAsEntry 在部分环境下对非文件 drag 抛错
      }
      if (entry && entry.fullPath) {
        out.push({ path: normDropPath(entry.fullPath), isDir: !!entry.isDirectory })
      }
    }
    if (out.length) return out
  }
  const files = dt && dt.files ? Array.from(dt.files) : []
  for (const f of files) {
    const p = f.path || (f.entry && f.entry.fullPath) || ''
    if (p) out.push({ path: normDropPath(p), isDir: !!(f.entry && f.entry.isDirectory) })
  }
  return out
}

/**
 * 绑定主区域拖放。
 * @param {object} deps
 * @param {HTMLElement} deps.rootEl 监听容器（.body）
 * @param {(targets:Array<{path:string,isDir:boolean}>, ev:DragEvent) => Promise<void>} deps.onTargets 统一处理入口（第二个参数是 drop 事件，调用方按落点判断落在哪个窗格）
 */
export function bindDropOpen(deps) {
  const { rootEl, onTargets } = deps
  let depth = 0 // 子元素也会冒泡 dragenter：用进出计数判「真正离开本区域」
  rootEl.addEventListener('dragenter', (e) => {
    if (!e.dataTransfer) return
    e.preventDefault()
    depth++
    rootEl.classList.add('nl-drop-on')
  })
  rootEl.addEventListener('dragover', (e) => {
    if (!e.dataTransfer) return
    // 不 preventDefault 浏览器会把 drop 当导航，文件直接在 webview 里打开
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
  })
  rootEl.addEventListener('dragleave', () => {
    depth = Math.max(0, depth - 1)
    if (depth === 0) rootEl.classList.remove('nl-drop-on')
  })
  rootEl.addEventListener('drop', async (e) => {
    e.preventDefault()
    depth = 0
    rootEl.classList.remove('nl-drop-on')
    const targets = collectDropPaths(e.dataTransfer).filter((t) => t.path)
    if (targets.length) await onTargets(targets, e)
  })
}
