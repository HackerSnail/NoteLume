// icons.js —— 前端统一图标出口。
// 图形数据只有 index.html 里那一份 <symbol id="i-*"> 表；本模块只负责造 <svg><use>，
// 避免路径在 HTML 与 JS 两处各写一遍。描边色走 currentColor，随主题自动换色。

const NAME_RE = /^nl-ico[\w-]*$/

function svgEl(name, cls) {
  if (!/^[a-z0-9-]+$/.test(name)) throw new Error('bad icon name: ' + name)
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('class', cls && NAME_RE.test(cls) ? cls : 'nl-ico')
  svg.setAttribute('aria-hidden', 'true')
  svg.setAttribute('focusable', 'false')
  const use = document.createElementNS('http://www.w3.org/2000/svg', 'use')
  use.setAttribute('href', '#i-' + name)
  svg.appendChild(use)
  return svg
}

// 字符串场景（innerHTML 模板）用；name 只允许内置命名，不进用户数据。
export function iconHTML(name) {
  return '<svg class="nl-ico" aria-hidden="true" focusable="false"><use href="#i-' + name + '"/></svg>'
}

// 元素场景用：图标 + 文本标签（标签永远是文本节点，不拼进 HTML）。
// name 传空 = 只放文本，便于调用方按条件决定要不要图标。
export function setIcon(el, name, label, cls) {
  el.replaceChildren()
  if (name) el.appendChild(svgEl(name, cls))
  if (label != null && label !== '') el.appendChild(document.createTextNode(String(label)))
  return el
}
