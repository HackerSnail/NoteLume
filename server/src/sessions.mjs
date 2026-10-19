// sessions.mjs —— 沙盒会话的活跃登记与过期回收（关浏览器即销毁）
//
// 语义：sid 仍存浏览器 localStorage（稳定），但工作区是临时的。前端在沙盒模式下每 ~25s 打一次
// /api/heartbeat，后端把每个活跃请求都 touch 一下；后台定时器扫掉「久无活动」的会话——
// 删该会话整份工作区目录 + 回收内存索引表与语言表。于是：
//   - 关浏览器 → 心跳停 → 约 IDLE_TTL 后被清扫；
//   - 刷新 → 同 sid，心跳在 TTL 内恢复 → 不误删；
//   - 重开（同 sid 已被扫掉）→ jailRoot→ensureSessionVault 重新灌一份全新演示库，路径不变仍有效。
// IDLE_TTL 要明显大于浏览器对后台标签页的限流间隔（约每分钟一次），默认取 180s 留足余量。

import fs from 'node:fs'
import path from 'node:path'
import { cfg, isSafeSid } from './paths.mjs'
import { dropIndex } from './index.mjs'
import { deleteLang } from './uiLang.mjs'

const lastSeen = new Map() // sid -> 最近一次活跃的时间戳（ms）

/** 登记一次活跃；仅沙盒模式、且 sid 合法时才记 */
export function touch(sid) {
  if (cfg.mode !== 'sandbox') return
  if (!isSafeSid(sid || '')) return
  lastSeen.set(sid, Date.now())
}

/** 会话工作区根（sessionBase/<sid>）；非沙盒或非法 sid 返回 null */
function sessionDir(sid) {
  if (cfg.mode !== 'sandbox' || !isSafeSid(sid || '')) return null
  return path.join(cfg.sessionBase, sid)
}

/**
 * 立即销毁一个会话：删工作区目录 + 回收内存索引表 / 语言表。
 * 本机模式不涉及（无工作区）。返回是否真的删了目录。
 */
export function dropSession(sid) {
  const dir = sessionDir(sid)
  lastSeen.delete(sid)
  dropIndex(sid)
  deleteLang(sid)
  if (!dir) return false
  try {
    fs.rmSync(dir, { recursive: true, force: true })
    return true
  } catch {
    return false
  }
}

/**
 * 扫掉超过 ttlMs 无活动的会话，返回被销毁的 sid 列表。
 * now 可注入便于测试（默认 Date.now()）。
 */
export function sweepIdle(ttlMs, now = Date.now()) {
  if (cfg.mode !== 'sandbox') return []
  const removed = []
  for (const [sid, ts] of [...lastSeen.entries()]) {
    if (now - ts >= ttlMs) {
      dropSession(sid)
      removed.push(sid)
    }
  }
  return removed
}

/** 仅测试用：伪造某会话的最近活跃时间（很久以前 = 会被扫掉） */
export function _setLastSeen(sid, ts) {
  lastSeen.set(sid, ts)
}

/** 仅测试用：当前登记表快照 */
export function _snapshot() {
  return new Map(lastSeen)
}
