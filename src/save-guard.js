// save-guard.js —— 写盘期间的串行化与身份/版本核对
//
// 保存是异步的：getMarkdown() 取快照到 writeMdFile 返回之间，用户还能继续打字或切文档。
// 无条件 markSaved() 会把这段窗口里的新编辑一起标成已保存，关窗 / 切文档时不再提示。
// 这里放两件可单测的小逻辑：同一文件的保存排队，以及写盘前后的身份+版本比对。
// 版本由 editor-view 的 editVersion 提供，main.js 的 savePane 把两者接起来。

const tails = new Map()

/**
 * 同一把钥匙下的任务串行执行：前一条没结束，后一条连快照都不取，排队等它完成。
 * 这样第二条拿到的是用户最新的内容，不会拿旧文本覆盖刚写进去的新文本。
 * 任务内部自己处理错误；这里只保证队列不会因为某条抛错而卡死。
 */
export function withSaveLock(key, task) {
  const prev = tails.get(key) || Promise.resolve()
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const tail = prev.then(() => gate) // tail 在上一个任务完成后、本任务释放 gate 时 resolve
  tails.set(key, tail)
  return prev.catch(() => {}).then(async () => {
    try {
      return await task()
    } finally {
      release()
      if (tails.get(key) === tail) tails.delete(key)
    }
  })
}

/** 保存开始时记下：写到哪个文件 + 当时编辑器内容的版本。 */
export function saveSnapshot(root, rel, version) {
  return { root, rel, version }
}

/** 写盘返回后核对：root、rel、version 三者都没变，这份内容才仍是当前文档的最新版。 */
export function saveVersionStillCurrent(snap, current) {
  return !!snap && !!current &&
    snap.root === current.root &&
    snap.rel === current.rel &&
    snap.version === current.version
}
