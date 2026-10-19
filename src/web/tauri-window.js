// tauri-window.js —— @tauri-apps/api/window 的网页替身
//
// 形状按 main.js / titlebar.js 的真实调用点补齐（§3 表）：缺一个方法就是运行时 TypeError。
//   - main.js setupCloseGuard： getCurrentWindow().onCloseRequested(async ev => …).catch(…)
//   - main.js 标题：            getCurrentWindow().setTitle(name).catch(…)
//   - titlebar.js 的 minimize/close/toggleMaximize/isMaximized/onResized 都在 inTauri 判空之后，
//     网页里 initTitlebar() 直接 return，不会走到；这里仍给出 no-op 以防其它调用点。
// getCurrentWindow 的返回 Promise 与原生一致；无对应浏览器能力的（尺寸 / 最大化 / 焦点）no-op 或回默认值。

function getWindow() {
  return {
    label: 'main',

    setTitle(title) {
      try {
        document.title = String(title == null ? '' : title)
      } catch {
        /* ignore */
      }
      return Promise.resolve()
      },

    // 关闭守卫：桌面版在 onCloseRequested 里跑 ensureSavedBeforeLeave（一个异步三选确认框）。
    // 浏览器 beforeunload 里无法 await 自定义对话框，且无改动时不该每次刷新都弹「离开此网站？」。
    // 因此这里不劫持卸载（返回一个已 resolve 的 Promise 供 .catch 链使用，但不注册 beforeunload），
    // 关闭询问交由 Phase 3 以「仅在脏时」的轻量 beforeunload 补回。绝不在无改动时拦刷新/导航。
    onCloseRequested(_handler) {
      return Promise.resolve(function unlisten() {})
    },

    onCloseThrown(_handler) {
      return Promise.resolve(function unlisten() {})
    },

    // 以下在网页里没有对应能力：no-op 或回一个安全的默认值。
    show: () => Promise.resolve(),
    hide: () => Promise.resolve(),
    setFocus: () => Promise.resolve(),
    close: () => Promise.resolve(),
    minimize: () => Promise.resolve(),
    unminimize: () => Promise.resolve(),
    maximize: () => Promise.resolve(),
    unmaximize: () => Promise.resolve(),
    toggleMaximize: () => Promise.resolve(),
    setMaximizable: () => Promise.resolve(),
    setSize: () => Promise.resolve(),
    setMinSize: () => Promise.resolve(),
    setResizable: () => Promise.resolve(),
    startDragging: () => Promise.resolve(),
    isMaximized: () => Promise.resolve(false),
    isMinimized: () => Promise.resolve(false),
    isFocused: () => Promise.resolve(true),
    is_visible: () => Promise.resolve(true),
    outerSize: () => Promise.resolve({ width: window.innerWidth, height: window.innerHeight }),
    innerSize: () => Promise.resolve({ width: window.innerWidth, height: window.innerHeight }),
    outerPosition: () => Promise.resolve({ x: 0, y: 0 }),
    scaleFactor: () => Promise.resolve(window.devicePixelRatio || 1),
    onResized: () => Promise.resolve(function unlisten() {}),
    onMoved: () => Promise.resolve(function unlisten() {}),
    onFocusedChanged: () => Promise.resolve(function unlisten() {}),
  }
}

export function getCurrentWindow() {
  return getWindow()
}

export function getAllWindows() {
  return Promise.resolve([getWindow()])
}

// 部分调用点用 Window.getByLabel / appWindow 单例：给出同样的替身。
export class Window {
  static async getByLabel(label) {
    return getWindow(label)
  }
}
