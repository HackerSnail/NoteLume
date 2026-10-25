// heading-numbering.js —— 标题自动编号（输出层 CSS counter，源文件不碰）
//
// 吃 settings 的 features.headingNumbering 开关（feature-flags.js）。只影响输出件：
// 单篇 HTML、整站、打印排版、幻灯片；编辑器里标题不带编号（所见与源文件一致）。
// 用 CSS counter 而非改文本：编号只在浏览器 / 打印渲染时出现，复制正文不带编号，也不干扰锚点。
// 只编 H1 / H2（1、1.1），与 Quarkdown 文档编号的最小可用集对齐；H3 不编，避免深层噪声。

/**
 * 生成编号 CSS。
 * @param {string} scope 内容容器的 CSS 前缀（如 'article'、'.nl-pbody'；空串 = 全局）
 */
export function numberingCss(scope) {
  const s = scope ? scope + ' ' : ''
  const root = s ? s.trim() : 'body'
  return [
    `${root} { counter-reset: nlh1; }`,
    `${s}h1 { counter-increment: nlh1; counter-reset: nlh2; }`,
    `${s}h1::before { content: counter(nlh1) ". "; }`,
    `${s}h2 { counter-increment: nlh2; }`,
    `${s}h2::before { content: counter(nlh1) "." counter(nlh2) ". "; }`,
  ].join('\n')
}
