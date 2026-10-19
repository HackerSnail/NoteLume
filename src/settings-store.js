// settings-store.js —— 应用设置（settings.json）的读取、防抖写盘与变更订阅
//
// 存储位置：Tauri 下走 Rust 命令读写 <app_config_dir>/settings.json（见 lib.rs 的
// read_settings_json / write_settings_json，写盘是临时文件 + rename 的原子替换）；
// 纯浏览器环境（vite dev 直接开网页）回落 localStorage 的 nl-settings 键，
// 开发预览不依赖 Tauri。
//
// 写盘防抖 500ms（p5plan §8）：滑块拖动、连点取色这类连续改动不逐次写文件；
// 需要即时落盘的时机（拖拽结束、关闭设置面板）由调用方调 flush()。
// 整个文档（不止外观）都走这一个 store，后续 P5 的工作区 / 最近文件并进来即可。

import { readSettingsJson, writeSettingsJson } from './tauri-bridge.js'
import { isDesktop } from './desktop-gate.js'

const LS_KEY = 'nl-settings'
const DEBOUNCE_MS = 500

function readLs() {
  try {
    const v = JSON.parse(localStorage.getItem(LS_KEY) || 'null')
    return v && typeof v === 'object' && !Array.isArray(v) ? v : null
  } catch {
    return null
  }
}

function writeLs(doc) {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(doc))
  } catch {
    /* 配额满等忽略：设置丢了下次用默认值 */
  }
}

export function createSettingsStore() {
  let doc = {} // 全量设置文档
  let timer = null
  let inFlight = null // 进行中的写盘 Promise：避免并发写互相覆盖
  let dirty = false // 写盘期间又改了文档：这次写完成后补一次
  const listeners = new Set()

  /** 启动时调用一次：读回设置文档。失败（含文件损坏）时静默用默认值，不阻断启动。 */
  async function load() {
    try {
      const raw = isDesktop() ? await readSettingsJson() : readLs()
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) doc = raw
    } catch (e) {
      console.warn('[settings] 读取失败，使用默认值', e)
    }
    return doc
  }

  function get() {
    return doc
  }

  /** 改动设置：patch 浅合并进文档，同步通知订阅方，并按防抖调度写盘 */
  function update(patch) {
    doc = { ...doc, ...(patch && typeof patch === 'object' ? patch : {}) }
    if (inFlight) dirty = true
    for (const fn of [...listeners]) {
      try {
        fn(doc)
      } catch (e) {
        console.warn('[settings] 订阅方处理失败', e)
      }
    }
    schedule()
    return doc
  }

  function schedule() {
    if (!isDesktop()) {
      writeLs(doc) // 浏览器回落：localStorage 同步写，没有 IO 压力
      return
    }
    if (timer) clearTimeout(timer)
    timer = setTimeout(() => {
      timer = null
      flush()
    }, DEBOUNCE_MS)
  }

  /** 立即写盘（取消待执行的防抖）。返回的 Promise 在写盘结束后 resolve。 */
  function flush() {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    if (!isDesktop()) {
      writeLs(doc)
      return Promise.resolve()
    }
    if (inFlight) return inFlight
    const snapshot = doc
    inFlight = writeSettingsJson(snapshot)
      .catch((e) => {
        console.warn('[settings] 写入失败', e)
      })
      .finally(() => {
        inFlight = null
        if (dirty) {
          dirty = false
          flush() // 写盘期间又有了改动：按最新文档再写一次
        }
      })
    return inFlight
  }

  function onChange(fn) {
    listeners.add(fn)
    return () => listeners.delete(fn)
  }

  return { load, get, update, flush, onChange }
}
