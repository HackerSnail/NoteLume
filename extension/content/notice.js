// content/notice.js —— 剪藏结果在页面右下角的确认条。
//
// 为什么要它：系统通知（chrome.notifications）在 mac 上会被系统设置与专注模式挡掉，
// 而且被挡时扩展拿不到任何反馈，成功与失败看起来一模一样。页面这一条不吃系统权限，
// 与系统通知各发一次，两条互相独立。
//
// 样式全在 background.js 的 NOTICE_CSS 里、经 insertCSS 注入：页面 CSP 管不到那条通道，
// 而往元素上写内联 style 属性会被严格 CSP 拦下，所以这里只挂 class，不写任何样式。
// 文案一律走 textContent（标题来自被剪的页面，不能进 HTML）。
;(() => {
  const ID = 'nl-clip-notice'
  const BASE = 'nl-clip-notice'
  const ON = 'nl-clip-on'
  const OUT_MS = 200 // 与 NOTICE_CSS 里 transition 的时长对齐

  // background.js 每剪一次就重新执行本文件一次，模块内的变量会换成新实例；计时器 id 放这里
  // 共享，否则上一发的收起计时没人能取消，新的确认条会被旧定时提前抹掉。
  const st = (window.__NL_NOTICE_STATE = window.__NL_NOTICE_STATE || { hide: 0, drop: 0 })

  function node() {
    let el = document.getElementById(ID)
    if (!el) {
      el = document.createElement('div')
      el.id = ID
      // 挂 documentElement：正文还没解析出来的注入时机也不能失败
      document.documentElement.appendChild(el)
    }
    el.classList.add(BASE)
    if (!el.querySelector('.nl-clip-notice-title')) {
      const title = document.createElement('div')
      title.className = 'nl-clip-notice-title'
      el.insertBefore(title, el.firstChild)
    }
    return el
  }

  function drop(el) {
    el.classList.remove(ON)
    clearTimeout(st.drop)
    st.drop = setTimeout(() => el.remove(), OUT_MS)
  }

  function show(opts) {
    const o = opts || {}
    const el = node()
    clearTimeout(st.hide)
    clearTimeout(st.drop)
    el.classList.remove('nl-clip-bad', 'nl-clip-info')
    if (o.kind === 'bad') el.classList.add('nl-clip-bad')
    else if (o.kind === 'info') el.classList.add('nl-clip-info')
    el.querySelector('.nl-clip-notice-title').textContent = String(o.title || '')
    // 正文为空整块不渲染，只留标题那一行
    const bodyText = String(o.body || '')
    let bodyEl = el.querySelector('.nl-clip-notice-body')
    if (!bodyText && bodyEl) {
      bodyEl.remove()
      bodyEl = null
    }
    if (bodyText) {
      if (!bodyEl) {
        bodyEl = document.createElement('div')
        bodyEl.className = 'nl-clip-notice-body'
        el.appendChild(bodyEl)
      }
      bodyEl.textContent = bodyText
    }
    // 先空一帧再置进场类，transition 才有起点（不用 rAF：后台标签页里 rAF 会被冻住，
    // 确认条会一直停在透明态）
    setTimeout(() => el.classList.add(ON), 16)
    st.hide = setTimeout(() => drop(el), Number(o.ms) > 0 ? Number(o.ms) : 4000)
    return true
  }

  window.__NL_NOTICE = { show }
})()
