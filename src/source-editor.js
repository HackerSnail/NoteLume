// source-editor.js —— 正文 Markdown「源码模式」编辑器（CodeMirror 6，懒加载）
//
// · 所有 @codemirror/* 与 @lezer/* 一律在函数体内 `await import()` 动态加载：主 bundle 只含本薄封装，
//   CM 子块仅在首次进入源码模式时才拉取（对齐 mermaid 的懒加载先例）。
// · 颜色全部走 CSS 变量（--bg/--fg/--muted/--accent/--border/--hover/--bg-panel），随应用主题（light/
//   dark/vampire）自动切换——CM 生成的样式里写 var() 在运行时按容器解析，无需自建三套调色板。
//   setTheme() 仅按需重配 EditorView.theme 的 {dark} 语义（影响光标/选区等内部默认），保持廉价。

let CM = null // 缓存已加载的模块集合

// 选区边界规整：NaN/越界一律夹到 [0, doc.length]
function clampSel(v, len) {
  const n = Number.isFinite(v) ? Math.trunc(v) : 0
  return n < 0 ? 0 : n > len ? len : n
}

async function loadCM() {
  if (CM) return CM
  const [state, view, commands, language, langmd, lezermd, hl, langdata] = await Promise.all([
    import('@codemirror/state'),
    import('@codemirror/view'),
    import('@codemirror/commands'),
    import('@codemirror/language'),
    import('@codemirror/lang-markdown'),
    import('@lezer/markdown'),
    import('@lezer/highlight'),
    import('@codemirror/language-data'),
  ])
  CM = { state, view, commands, language, langmd, lezermd, hl, langdata }
  return CM
}

// 用 var() 书写的 chrome 主题（前景/背景/行号槽/当前行/选区/光标）
// extra：调用方可追加/覆盖 theme 选择器条目（如嵌在固定高度容器里时需声明 '&':{height:'100%'} 自滚）
function buildTheme(CM, isDark, extra) {
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
      ...extra,
    },
    { dark: isDark }
  )
}

// Markdown token 高亮（Typora 风彩色）：标题/粗体/斜体/删除线/链接/内码/围栏代码/引用/列表/元信息/分隔线
// 调色取 One Dark 系——在 light/dark/vampire 三主题下都可读（背景对比度足够），且保留
// 与 --fg 正文不同的色相以确保“一眼分得清”。若需主题化可拆到 CSS 变量。
function buildHighlight(CM) {
  const tags = CM.hl.tags
  const HEAD = '#61afef'
  return CM.language.HighlightStyle.define([
    // 标题：统一鲜亮蓝，1–3 级字号逐层缩（与 Typora 一致）
    // 关键：每个级别必须是“单条规则”（颜色+字重+字号合并）。CM6 HighlightStyle 对
    // 同一 tag 的多条规则不是合并样式、而是“后规则 class 整个覆盖前规则”——若把字号
    // 拆成单独一条，标题文字会只剩字号 class、丢掉颜色 class（表现为“标题没颜色”）。
    { tag: tags.heading1, color: HEAD, fontWeight: '700', fontSize: '1.45em' },
    { tag: tags.heading2, color: HEAD, fontWeight: '700', fontSize: '1.25em' },
    { tag: tags.heading3, color: HEAD, fontWeight: '700', fontSize: '1.12em' },
    { tag: [tags.heading4, tags.heading5, tags.heading6], color: HEAD, fontWeight: '700' },
    // 强调：粗体橙、斜体紫、删除线灰带中划线
    { tag: tags.strong, fontWeight: '700', color: '#d19a66' },
    { tag: tags.emphasis, fontStyle: 'italic', color: '#c678dd' },
    { tag: tags.strikethrough, textDecoration: 'line-through', color: '#7f848e' },
    // 链接与 URL 分开着色（Typora 风格），内码/围栏代码青蓝呼应
    { tag: tags.link, color: '#98c379', textDecoration: 'underline' },
    { tag: tags.url, color: '#56b6c2' },
    { tag: tags.monospace, color: '#56b6c2' },
    // 引用：斜体蓝灰
    { tag: tags.quote, color: '#98c379', fontStyle: 'italic' },
    // 列表符号：Typora 风鲜亮黄
    { tag: tags.list, color: '#e5c07b' },
    // 元信息：frontmatter / HTML 注释 / 脚注定义等
    { tag: tags.meta, color: '#7f848e', fontStyle: 'italic' },
    // 分隔线 ---
    { tag: tags.contentSeparator, color: '#5c6370' },
  ])
}

/**
 * 创建源码编辑器（异步：首次调用会加载 CM 依赖）。
 * @param {object} cfg
 * @param {HTMLElement} cfg.mountEl  挂载容器（已存在、通常此刻刚从 hidden 显示）
 * @param {string} cfg.theme         'light' | 'dark' | 'vampire'
 * @param {(text:string)=>void} cfg.onChange  仅用户编辑触发（程序化 setDoc 不触发）
 * @param {object} [cfg.themeExtra]  追加/覆盖 CM theme 条目（填充高度/自滚等容器级样式）
 * @returns {Promise<{setDoc, getDoc, setTheme, focus, refresh, destroy}>}
 */
export async function createSourceEditor({ mountEl, theme = 'light', onChange, themeExtra }) {
  const CM = await loadCM()
  let applying = false // 程序化写入标志：期间不回调 onChange（避免进入/切文件被误判为“编辑”）
  const themeComp = new CM.state.Compartment()

  const buildExt = (isDark) => [
    buildTheme(CM, isDark, themeExtra),
    // 两层高亮：buildHighlight（Typora 风 Markdown 配色）用 Prec.highest 抢优先，
    // defaultHighlightStyle（普通注册）专门兜底围栏代码块的子语言 token
    // （keyword/type/varName/number…）。实测：若用 {fallback:true} 反而会让子语言
    // 不包 span（代码块单色）；必须 buildHL 高优先 + default 普通注册，两者才能共存。
    CM.state.Prec.highest(CM.language.syntaxHighlighting(buildHighlight(CM))),
    CM.language.syntaxHighlighting(CM.language.defaultHighlightStyle),
  ]
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
      CM.langmd.markdown({
        // 围栏代码块子语言高亮：根据 ```lang 信息串自动匹配、动态 import 对应
        // 解析器（未用到的语言不会进初 chunk）。支持 js/ts/java/py/json/yaml/go/rust/c/cpp
        // /html/css/sql/md/sh/docker/php/ruby/xml/yaml/… 等 100+ 种。
        extensions: [CM.lezermd.GFM],
        codeLanguages: CM.langdata.languages,
      }),
      CM.view.keymap.of([
        // 过滤掉 `Mod-s`：CM 内置 `save` 命令会吞掉事件且什么都不做，源码模式下 Ctrl+S
        // 无法冒泡到应用级分发器（app.save 监听在 document），表现为“没反应”。
        // 过滤掉 `Mod-/`：CM 的 toggleComment 会抢先执行，把光标所在行包成 <!-- … -->
        // （标题被就地改成注释），再由退出源码的读取写入模型；该键归应用级「切换源码模式」。
        ...CM.commands.defaultKeymap.filter((b) => b && b.key !== 'Mod-s' && b.key !== 'Mod-/'),
        ...CM.commands.historyKeymap,
        CM.commands.indentWithTab,
      ]),
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
    // 光标/选区落点：切换模式时由 editor-view 按位置映射设置（保留选区范围，
    // scrollIntoView 让光标所在行滚入视口——否则整篇跳回开头）
    setSelection(from, to) {
      const len = view.state.doc.length
      const a = clampSel(Number(from), len)
      const b = clampSel(to == null ? Number(from) : Number(to), len)
      view.dispatch({ selection: { anchor: a, head: b }, scrollIntoView: true })
      view.requestMeasure()
    },
    getSelection() {
      const r = view.state.selection.main
      return { from: r.from, to: r.to }
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
