// frontmatter.js —— YAML frontmatter（文件最开头的 --- 围栏）的剥离 / 补回（纯逻辑，无 DOM）
//
// 设计要点：
//  · 只识别「文件绝对开头」的 --- 围栏（Obsidian / Jekyll 约定）；正文中间的 --- 是分割线，不碰。
//  · 保留原始 yaml 字符串做字节级往返：用户手写的键顺序 / 注释 / 引号风格都不丢，
//    只有当面板显式编辑 frontmatter 时才由调用方用 js-yaml 重新 dump。
//  · 未闭合（找不到收尾围栏）按「无 frontmatter」处理，绝不吞掉正文——安全优先。
//  · 与 editor-schema 的 parse/serialize 解耦：本模块只在编辑器边界做前后包裹。

/**
 * 从 Markdown 文本剥离开头 frontmatter。
 * @returns {{ yaml: string | null, body: string }} yaml 为不含围栏的原始内容（含自身换行）；
 *          无 frontmatter 时 yaml=null、body 原样返回。
 */
export function splitFrontmatter(md) {
  if (md == null) return { yaml: null, body: '' }
  let s = md
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1) // 去 BOM 便于检测，无 frontmatter 时仍返回原文
  const open = /^---[ \t]*\r?\n/.exec(s)
  if (!open) return { yaml: null, body: md }
  const rest = s.slice(open[0].length)
  // 收尾围栏：某一行以 --- 或 ... 开头，后可跟空白并到行尾 / 文本尾
  const closeRe = /^(?:---|\.\.\.)[ \t]*(\r?\n|$)/m
  const cm = closeRe.exec(rest)
  if (!cm) return { yaml: null, body: md } // 未闭合：当作无 frontmatter
  const yaml = rest.slice(0, cm.index)
  const body = rest.slice(cm.index + cm[0].length)
  return { yaml, body }
}

/**
 * 判断 YAML 文本里是否**有可解析的文档**（js-yaml 5.4 对「全空白 / 只有注释」直接抛
 * `expected a document, but the input is empty`，而这类输入在语义上就是空文档，
 * 不该被当成解析失败拦下「应用」或「重新格式化」）。
 */
export function hasYamlDoc(text) {
  return String(text == null ? '' : text)
    .split('\n')
    .some((line) => {
      const t = line.trim()
      return t !== '' && !t.startsWith('#')
    })
}

/**
 * 把 frontmatter 原样补回正文之前。yaml=null 时直接返回 body（不加任何围栏）。
 * yaml 约定：其内容已是「围栏之间的原始文本」，末尾可能带一个换行（split 的产物）。
 */
export function joinFrontmatter(yaml, body) {
  if (yaml == null) return body
  const b = body == null ? '' : body
  // yaml 若不以换行结尾（例如外部直接喂 'a: 1'），补一个换行再收尾围栏
  const mid = yaml === '' ? '' : yaml.endsWith('\n') ? yaml : yaml + '\n'
  return '---\n' + mid + '---\n' + b
}
