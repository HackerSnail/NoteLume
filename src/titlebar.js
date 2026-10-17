// titlebar.js —— Windows / Linux 单栏标题：平台标记 + 窗口按钮 + 双击拖拽区最大化
// 工具条即标题栏：.appbar-lead（左端应用名）与 .spacer（中部空白）是拖拽区，
// .win-btns（右端）是最小化/最大化/关闭。mac 走原生 Overlay，这套默认隐藏、仅 win/linux 显示。
import { getCurrentWindow } from '@tauri-apps/api/window'

const inTauri = '__TAURI_INTERNALS__' in window

function detectPlatform() {
  const ua = navigator.userAgent
  if (/Macintosh|Mac OS X|iPhone|iPad/i.test(ua)) return 'macos'
  if (/Windows/i.test(ua)) return 'windows'
  return 'linux'
}

// 模块加载即打标记，CSS 据此决定是否显示自定义标题；放在导入期，先于 boot() 执行
document.documentElement.dataset.tauriPlatform = detectPlatform()

export function initTitlebar() {
  if (!inTauri) return
  const appWindow = getCurrentWindow()

  const btns = document.querySelector('.win-btns')
  if (!btns) return
  const btnMax = btns.querySelector('[data-win="max"]')

  btns.querySelector('[data-win="min"]')?.addEventListener('click', () => appWindow.minimize())
  btns.querySelector('[data-win="close"]')?.addEventListener('click', () => appWindow.close())
  btnMax?.addEventListener('click', async () => {
    await appWindow.toggleMaximize()
    refreshMax()
  })

  // 最大化态换图标：还原（双框）<-> 最大化（单框）
  async function refreshMax() {
    const use = btnMax?.querySelector('use')
    if (!use) return
    const max = await appWindow.isMaximized()
    use.setAttribute('href', max ? '#i-win-restore' : '#i-win-max')
    btnMax.title = max ? '向下还原' : '最大化'
  }
  refreshMax()
  appWindow.onResized(refreshMax)

  // 双击拖拽区（应用名 / 中部空白）最大化/还原；这两个区没有按钮，直接挂不用排除
  for (const sel of ['.appbar-lead', '.toolbar .spacer']) {
    document.querySelector(sel)?.addEventListener('dblclick', () => appWindow.toggleMaximize())
  }
}
