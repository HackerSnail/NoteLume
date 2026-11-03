// code-lang-list.js —— 代码块语言候选表：highlight.js 已注册语言 + 预览语言。
// 两个入口共用同一份候选：
//  · code-lang-picker.js：点已有代码块的语言标签改语言（包含过滤 + 「纯文本」项）；
//  · suggest-plugin.js：段首敲 ``` 时的语言联想（前缀过滤，对齐 Typora）。
// 只读 hljs 注册表，不注册任何语言；选中即有高亮是 hljs 侧保证的。

import hljs from 'highlight.js/lib/common'

// 常用语言置顶（仅保留 hljs 实际注册的那些，其余按字母序补在后面）
const PREFERRED = [
  'javascript', 'typescript', 'python', 'java', 'go', 'rust', 'c', 'cpp', 'csharp',
  'sql', 'json', 'yaml', 'xml', 'html', 'css', 'bash', 'shell', 'powershell',
  'markdown', 'dockerfile', 'kotlin', 'swift', 'php', 'ruby', 'scala', 'diff', 'ini',
]

// 预览块语言：不靠 highlight.js 上色，靠各自的预览插件把代码块换成图 / 表 / 条目
// （mermaid-preview.js / csv-preview.js / bibtex-preview.js）。hljs 的注册表里没有它们，
// 不补进列表就只能去源码态手写围栏 info，预览功能等于没有入口
const PREVIEW_LANGS = ['bibtex', 'csv', 'mermaid']

// 常用别名：hljs 的 listLanguages() 只报主名，但用户敲的是别名（敲 js 不出 javascript
// 就等于没联想）。别名跟在主名后面进候选；选中别名即 params=别名，hljs.getLanguage
// 认别名、序列化器原样写围栏 info，往返都不变形。只收真正常敲的，不搬全量别名表
const ALIASES = {
  javascript: ['js', 'jsx'],
  typescript: ['ts'],
  python: ['py'],
  bash: ['sh'],
  yaml: ['yml'],
  ruby: ['rb'],
  markdown: ['md'],
  cpp: ['c++'],
  go: ['golang'],
}

let cached = null

// 完整有序候选：常用置顶（主名 + 紧跟别名）+ 其余字母序 + 预览语言补尾。注册表不变，结果缓存
export function fenceLangList() {
  if (cached) return cached
  const reg = hljs.listLanguages()
  const regSet = new Set(reg)
  const expand = (l) => [l, ...(ALIASES[l] || [])]
  const head = PREFERRED.filter((l) => regSet.has(l)).flatMap(expand)
  const extra = PREVIEW_LANGS.filter((l) => !regSet.has(l) && !head.includes(l))
  const preferredSet = new Set(PREFERRED)
  const rest = reg.filter((l) => !preferredSet.has(l)).sort()
  cached = [...head, ...extra, ...rest]
  return cached
}

// 联想场景的前缀过滤：敲 j 只出 j 开头的语言——Typora 即此前缀口径；
// 「包含」会让列表被无关语言挤掉，选起来反而慢。
// 空 query（刚敲完 ```）返回整个候选表，由调用方截断。
export function filterFenceLangs(query, limit = 12) {
  const q = (query || '').toLowerCase().trim()
  const out = []
  for (const l of fenceLangList()) {
    if (q && !l.toLowerCase().startsWith(q)) continue
    out.push(l)
    if (out.length >= limit) break
  }
  return out
}
