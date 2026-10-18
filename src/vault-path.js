// vault-path.js —— 库路径归一与比较（纯函数，可单测）
//
// 从 main.js 提出来：分栏完整模式的打开链路要按「根变没变」决定是否重扫全库 /
// 重建索引（预览浏览点几十个文件不能每次都重扫），这个判定需要脱离 DOM 单测。

/**
 * 规范化库路径用于比较：去掉 Windows canonicalize 的 \\?\ verbatim 前缀、统一分隔符、
 * 去尾部分隔符、忽略大小写（Rust 存的是 canonical 路径，前端持有的是对话框原始路径）
 */
export function normVaultPath(p) {
  let s = String(p || '').split('\\').join('/') // 反斜杠统一成正斜杠
  if (s.slice(0, 4) === '//?/') s = s.slice(4) // 去掉 Windows canonicalize 前缀（\\?\ → //?/）
  s = s.replace(/\/+$/, '') // 去尾部分隔符
  return s.toLowerCase() // Windows 路径大小写不敏感
}

/** 两个库根是不是同一个（空值安全：都空算同一个，一空一不空算不同） */
export function rootChanged(a, b) {
  return normVaultPath(a) !== normVaultPath(b)
}
