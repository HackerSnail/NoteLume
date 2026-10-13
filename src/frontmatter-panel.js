// frontmatter-panel.js —— 侧栏「文档属性」面板：查看 + 编辑 YAML frontmatter
//
// 取舍（稳字优先）：
//  · 默认不重排用户的 YAML——编辑走「源码 textarea + 校验应用」，保留键顺序 / 注释 / 引号风格。
//  · 已解析字段给一个只读摘要方便查看；「重新格式化」是显式按钮，会把 yaml.dump 的结果
//    填进 textarea（可能改动注释与顺序，故不自动执行）。
//  · 应用前用 js-yaml 校验，解析失败则提示且不落盘，避免写出坏 frontmatter。

import * as yaml from 'js-yaml'

export function createFrontmatterPanel({ container, getFm, setFm, isEditable }) {
  let error = ''

  function refresh() {
    error = ''
    render()
  }

  function apply(text) {
    const trimmed = text.replace(/\s+$/, '')
    if (trimmed === '') {
      setFm(null) // 空 frontmatter = 移除
      return
    }
    try {
      yaml.load(text) // 仅校验；不 dump，保留用户原文
    } catch (e) {
      error = String((e && e.message) || e)
      render()
      return
    }
    setFm(text.endsWith('\n') ? text : text + '\n')
  }

  function reformat() {
    const ta = container.querySelector('.fm-textarea')
    if (!ta) return
    try {
      const data = yaml.load(ta.value || '')
      const dumped = data == null ? '' : yaml.dump(data, { lineWidth: 0, sortKeys: false })
      ta.value = dumped
      error = '已重排为规范 YAML（可能改动注释/顺序）；点「应用」生效。'
      render() // 重画会丢 textarea 值，故下面立刻回填
      const ta2 = container.querySelector('.fm-textarea')
      if (ta2) ta2.value = dumped
    } catch (e) {
      error = '无法解析，不能格式化：' + String((e && e.message) || e)
      render()
    }
  }

  function render() {
    container.innerHTML = ''
    if (!isEditable || !isEditable()) {
      const p = el('div', 'muted', '打开一个 Markdown 文档后可编辑文档属性')
      container.appendChild(p)
      return
    }
    const { raw, data } = getFm()
    const hasFm = raw != null

    // —— 只读字段摘要 ——
    const sum = el('div', 'fm-summary')
    if (!hasFm) {
      sum.appendChild(el('div', 'muted', '该文档暂无 frontmatter（YAML 头）'))
    } else {
      const keys = Object.keys(data || {})
      if (!keys.length) {
        sum.appendChild(el('div', 'muted', '（空 frontmatter）'))
      }
      for (const k of keys) sum.appendChild(row(k, (data || {})[k]))
    }
    container.appendChild(sum)

    // —— 源码编辑区 ——
    const ta = document.createElement('textarea')
    ta.className = 'fm-textarea'
    ta.spellcheck = false
    ta.placeholder = hasFm ? '' : 'title: \ntags: []\nstatus: draft'
    ta.value = hasFm ? raw : ''
    container.appendChild(ta)

    if (error) container.appendChild(el('div', 'fm-error', error))

    // —— 动作按钮 ——
    const bar = el('div', 'fm-actions')
    bar.appendChild(btn('应用', 'primary', () => apply(ta.value)))
    bar.appendChild(btn('重新格式化', '', reformat))
    if (hasFm) {
      bar.appendChild(btn('移除 frontmatter', 'danger', () => {
        if (window.confirm('移除本文档的 frontmatter（YAML 头）？')) setFm(null)
      }))
    }
    container.appendChild(bar)
  }

  // 单行 key -> 值（含数组 / 复杂值降级显示）
  function row(key, val) {
    const r = document.createElement('div')
    r.className = 'fm-row'
    const k = el('span', 'fm-key', key)
    const v = document.createElement('span')
    v.className = 'fm-val'
    if (Array.isArray(val)) {
      v.textContent = val.every(isScalar) ? val.map((x) => String(x)).join(', ') : '[…] 复杂数组'
    } else if (val && typeof val === 'object') {
      v.textContent = '{…} 复杂对象'
    } else if (val == null) {
      v.textContent = '—'
    } else {
      v.textContent = String(val)
    }
    r.append(k, v)
    return r
  }

  render()
  return { refresh }
}

function isScalar(v) {
  return v == null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean'
}

function el(tag, cls, text) {
  const n = document.createElement(tag)
  if (cls) n.className = cls
  if (text != null) n.textContent = text
  return n
}

function btn(label, cls, onClick) {
  const b = document.createElement('button')
  b.className = 'fm-btn' + (cls ? ' ' + cls : '')
  b.textContent = label
  b.addEventListener('click', onClick)
  return b
}
