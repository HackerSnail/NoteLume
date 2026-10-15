// source-editor.js —— 正文 Markdown「源码模式」编辑器（CodeMirror 6，懒加载）
//
// · 所有 @codemirror/* 与 @lezer/* 一律在函数体内 `await import()` 动态加载：主 bundle 只含本薄封装，
//   CM 子块仅在首次进入源码模式时才拉取（对齐 mermaid 的懒加载先例）。
// · 颜色全部走 CSS 变量（--bg/--fg/--muted/--accent/--border/--hover/--bg-panel），随应用主题（light/
//   dark/vampire）自动切换——CM 生成的样式里写 var() 在运行时按容器解析，无需自建三套调色板。
//   setTheme() 仅按需重配 EditorView.theme 的 {dark} 语义（影响光标/选区等内部默认），保持廉价。

let CM = null // 缓存已加载的模块集合

async function loadCM() {
  if (CM) return CM
  const [state, view, commands, language, langmd, lezermd, hl] = await Promise.all([
    import('@codemirror/state'),
    import('@codemirror/view'),
    import('@codemirror/commands'),
    import('@codemirror/language'),
    import('@codemirror/lang-markdown'),
    import('@lezer/markdown'),
    import('@lezer/highlight'),
  ])
  CM = { state, view, commands, language, langmd, lezermd, hl }
  return CM
}

// 用 var() 书写的 chrome 主题（前景/背景/行号槽/当前行/选区/光标）
function buildTheme(CM, isDark) {
  return CM.view.EditorView.theme(
    {
      '&': { color: 'var(--fg)', backgroundColor: 'transparent', fontSize: '14px' },
      '.cm-scroller': {
        fontFamily: 'ui-monospace, SFMono-Regular, Consolas, "Liberation Mono", Menlo, monospace',
        lineHeight: '1.7',
      },
      '.cm-content': { caretColor: 'var(--accent)', padding: '8px 0' },
      '.cm-cursor, .cm-dropCursor': { borderLeftColor: 'var(--accent)' },
      '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection': {
        backgroundColor: 'var(--hover)',
      },
      '.cm-gutters': {
        backgroundColor: 'transparent',
        color: 'var(--muted)',
        border: 'none',
        borderRight: '1px solid var(--border)',
      },
      '.cm-activeLine': { backgroundColor: 'transparent' },
      '.cm-activeLineGutter': { backgroundColor: 'var(--hover)', color: 'var(--fg)' },
    },
    { dark: isDark }
  )
}

// Markdown token 高亮：标题 / 粗斜 / 删除线 / 链接·URL / 行内码·代码 / 引用 / 列表标记 / 元信息
function buildHighlight(CM) {
  const tags = CM.hl.tags
  return CM.language.HighlightStyle.define([
    { tag: [tags.heading1, tags.heading2, tags.heading3, tags.heading4, tags.heading5, tags.heading6], color: 'var(--fg)', fontWeight: '700' },
    { tag: tags.heading1, fontSize: '1.45em' },
    { tag: tags.heading2, fontSize: '1.25em' },
    { tag: tags.heading3, fontSize: '1.12em' },
    { tag: tags.strong, fontWeight: '700', color: 'var(--fg)' },
    { tag: tags.emphasis, fontStyle: 'italic' },
    { tag: tags.strikethrough, textDecoration: 'line-through', color: 'var(--muted)' },
    { tag: [tags.link, tags.url], color: 'var(--accent)', textDecoration: 'underline' },
    { tag: tags.monospace, color: 'var(--accent)' },
    { tag: tags.quote, color: 'var(--muted)', fontStyle: 'italic' },
    { tag: tags.list, color: 'var(--accent)' },
    { tag: tags.meta, color: 'var(--muted)' },
    { tag: tags.contentSeparator, color: 'var(--border)' },
  ])
}

/**
 * 创建源码编辑器（异步：首次调用会加载 CM 依赖）。
 * @param {object} cfg
 * @param {HTMLElement} cfg.mountEl  挂载容器（已存在、通常此刻刚从 hidden 显示）
 * @param {string} cfg.theme         'light' | 'dark' | 'vampire'
 * @param {(text:string)=>void} cfg.onChange  仅用户编辑触发（程序化 setDoc 不触发）
 * @returns {Promise<{setDoc, getDoc, setTheme, focus, refresh, destroy}>}
 */
export async function createSourceEditor({ mountEl, theme = 'light', onChange }) {
  const CM = await loadCM()
  let applying = false // 程序化写入标志：期间不回调 onChange（避免进入/切文件被误判为"编辑"）
  const themeComp = new CM.state.Compartment()

  const buildExt = (isDark) => [buildTheme(CM, isDark), CM.language.syntaxHighlighting(buildHighlight(CM))]
  const isDark = theme !== 'light'

  const updateListener = CM.view.EditorView.updateListener.of((u) => {
    if (u.docChanged && !applying && onChange) onChange(u.state.doc.toString())
  })

  const startState = CM.state.EditorState.create({
    doc: '',
    extensions: [
      themeComp.of(buildExt(isDark)),
      CM.view.lineNumbers(),
      CM.view.EditorView.lineWrapping,
      CM.commands.history(),
      CM.language.bracketMatching(),
      CM.langmd.markdown({ extensions: [CM.lezermd.GFM] }),
      // Mod-/ 归应用级「切换源码模式」：留着它时 CM 的 toggleComment 会抢先执行，
      // 把光标所在行包成 <!-- … -->（标题被就地改成注释），再由退出源码的读取写入模型。
      CM.view.keymap.of([...CM.commands.defaultKeymap.filter((b) => b.key !== 'Mod-/'), ...CM.commands.historyKeymap, CM.commands.indentWithTab]),
      updateListener,
    ],
  })

  const view = new CM.view.EditorView({ state: startState, parent: mountEl })

  return {
    setDoc(text) {
      applying = true
      try {
        view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: String(text == null ? '' : text) } })
      } finally {
        applying = false
      }
      view.requestMeasure()
    },
    getDoc() {
      return view.state.doc.toString()
    },
    setTheme(name) {
      view.dispatch({ effects: themeComp.reconfigure(buildExt(name !== 'light')) })
    },
    focus() {
      view.focus()
      view.requestMeasure()
    },
    // 原生菜单「撤销 / 重做」在源码态的落点：此刻可见的是 CodeMirror 的历史，不是 PM
    undo() {
      view.focus()
      return CM.commands.undo(view.state, (tr) => view.dispatch(tr), view)
    },
    redo() {
      view.focus()
      return CM.commands.redo(view.state, (tr) => view.dispatch(tr), view)
    },
    refresh() {
      view.requestMeasure()
    },
    destroy() {
      view.destroy()
    },
  }
}
