// editor-view.js —— ProseMirror WYSIWYG 编辑器装配
// 负责：状态与插件、快捷键、[[wikilink]]/#tag 行内输入规则、图片拖拽/粘贴落库、
// 点击链接跳转、大纲与标签提取。纯渲染/交互层，模型转换在 editor-schema.js。

import { EditorView } from 'prosemirror-view'
import { EditorState, TextSelection, Plugin } from 'prosemirror-state'
import { keymap } from 'prosemirror-keymap'
import { history, undo, redo } from 'prosemirror-history'
import { baseKeymap, toggleMark, chainCommands, exitCode, selectNodeBackward } from 'prosemirror-commands'
import { schema, parseMarkdown, serializeMarkdown } from './editor-schema.js'
import { splitFrontmatter, joinFrontmatter } from './frontmatter.js'
import { resolveSourceText } from './source-sync.js'
import * as yaml from 'js-yaml'
import { saveImageFromFile, readImageDataUri } from './tauri-bridge.js'
import { highlightPlugin } from './hl-decorations.js'
import { mathInlineView, mathBlockView } from './math-nodeviews.js'
import { attachWikiHover } from './wiki-hover.js'
import { createSuggestPlugin } from './suggest-plugin.js'
import { tablePlugins, tableKeymap, attachTableContextMenu } from './table-editing.js'
import { mermaidPlugin } from './mermaid-preview.js'
import { attachCodeLangPicker } from './code-lang-picker.js'
import { createSlashMenuPlugin, SLASH_ITEMS } from './slash-menu.js'
import { BLOCK_COMMANDS, activeBlockKey, headingStep } from './block-commands.js'
import { createModesPlugin } from './editor-modes.js'
import { createFoldPlugin, foldSectionCommand, unfoldCovering } from './fold-plugin.js'
import { footnotePlugin, insertFootnote, deleteFootnote } from './footnotes.js'
import { normalizeBinding } from './keymap.js'
import { buildAnchorMap } from './anchor-link.js'

// —— 批次 D：编辑器命令表 + 动态 keymap ——
// 可重绑的编辑命令（进统一注册表、面板/设置页可列）。结构键 Shift-Enter（硬换行）、
// Backspace（节点后向删除）与标准重做别名 Shift-Mod-z 固定于 PM keymap，不进注册表。
export const EDITOR_COMMANDS = [
  { id: 'editor.undo', title: '撤销', defaultKey: 'Mod-z' },
  { id: 'editor.redo', title: '重做', defaultKey: 'Mod-y' },
  { id: 'editor.bold', title: '加粗', defaultKey: 'Mod-b' },
  { id: 'editor.italic', title: '斜体', defaultKey: 'Mod-i' },
  { id: 'editor.code', title: '行内代码', defaultKey: 'Mod-`' },
  { id: 'editor.strike', title: '删除线', defaultKey: 'Mod-Shift-x' },
  { id: 'editor.mathInline', title: '行内公式', defaultKey: 'Mod-m' },
  { id: 'editor.mathBlock', title: '块级公式', defaultKey: 'Mod-Shift-m' },
  { id: 'editor.foldSection', title: '折叠 / 展开本节', defaultKey: 'Mod-Shift-h' },
  // 脚注（无默认键，命令面板可搜；Ctrl-Shift-F 已被「专注」占用）
  { id: 'editor.footnote', title: '插入脚注', defaultKey: null },
  { id: 'editor.footnoteDelete', title: '删除脚注', defaultKey: null },
]

const PM_COMMANDS = {
  'editor.undo': undo,
  'editor.redo': redo,
  'editor.bold': toggleMark(schema.marks.strong),
  'editor.italic': toggleMark(schema.marks.em),
  'editor.code': toggleMark(schema.marks.code),
  'editor.strike': toggleMark(schema.marks.strike),
  'editor.mathInline': insertMath('math_inline'),
  'editor.mathBlock': insertMath('math_block'),
  'editor.foldSection': foldSectionCommand,
  'editor.footnote': insertFootnote,
  'editor.footnoteDelete': deleteFootnote,
}

// 标题升 / 降级：Typora 的「段落」菜单项，作用于选区所在标题，越出 1..6 即命令返回 false（菜单置灰）
EDITOR_COMMANDS.push({ id: 'editor.headingUp', title: '段落：提升标题级别' })
EDITOR_COMMANDS.push({ id: 'editor.headingDown', title: '段落：降低标题级别' })
PM_COMMANDS['editor.headingUp'] = headingStep(-1)
PM_COMMANDS['editor.headingDown'] = headingStep(1)

// 段落命令入同一张表：项表复用斜杠菜单（一份定义），公式块不在这里（已有 editor.mathBlock）。
// 无 defaultKey → 不占快捷键，只供面板与 mac 原生「段落」菜单调用。
const BLOCK_CMD_IDS = ['para', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'quote', 'code', 'bullet', 'ordered', 'task', 'hr', 'table', 'callout', 'mermaid']
for (const id of BLOCK_CMD_IDS) {
  const item = SLASH_ITEMS.find((x) => x.id === id)
  EDITOR_COMMANDS.push({ id: 'editor.block.' + id, title: '段落：' + item.label })
  PM_COMMANDS['editor.block.' + id] = BLOCK_COMMANDS[id]
}

// 硬换行命令（由固定结构键 Shift-Enter 触发）
const nlHardBreak = chainCommands(exitCode, (state, dispatch) => {
  dispatch(state.tr.replaceSelectionWith(schema.nodes.hard_break.create()).scrollIntoView())
  return true
})

// 「默认键 ∪ 覆盖」→ 编辑器 keymap 插件；固定别名/结构键始终保留
function buildEditorKeymap(overrides) {
  const map = {
    'Shift-Mod-z': redo,
    'Shift-Enter': nlHardBreak,
    Backspace: selectNodeBackward,
  }
  const ov = overrides && typeof overrides === 'object' ? overrides : {}
  for (const def of EDITOR_COMMANDS) {
    const chosen = Object.prototype.hasOwnProperty.call(ov, def.id) ? ov[def.id] : def.defaultKey
    if (chosen == null || chosen === '') continue // 空串 = 解绑
    const norm = normalizeBinding(chosen)
    if (!norm) continue // 非法或结构键目标：忽略
    map[norm] = PM_COMMANDS[def.id]
  }
  return keymap(map)
}

/**
 * 创建编辑器实例。
 * @param {object} opts
 * @param {HTMLElement} opts.mountEl 编辑器挂载容器
 * @param {() => {vaultRoot:string, mdRel:string}} opts.getVault 当前库根与当前文档相对路径
 * @param {(name:string)=>void} opts.onOpenWiki 点击 [[链接]]
 * @param {(tags:string[])=>void} opts.onMetaChange 大纲/标签变化回调
 * @param {(dirty:boolean)=>void} opts.onDirty 脏标记回调
 * @param {() => void} [opts.onFrontmatterChange] frontmatter 变化（打开/编辑）回调，供属性面板刷新
 */
export function createEditor(opts) {
  let dirty = false
  let fmRaw = null // 当前文档 YAML frontmatter 原文（不含围栏）；null=无
  // 源码模式（CodeMirror）：与 WYSIWYG 整篇互切
  let sourceMode = false
  let rawSource = null // 进入源码应展示的文本：打开即原始字节；WYSIWYG 改后置为最新全文
  let modelDirty = false // 自上次同步以来 WYSIWYG 是否改过模型（决定进源码展示 raw 还是序列化）
  let src = null // 懒建的 CodeMirror 封装实例
  let srcChangeTimer = null
  // 专注/打字机模式插件（初始态由 main.js 从 localStorage 传入）
  const modes = createModesPlugin({ focus: !!opts.initialFocus, typewriter: !!opts.initialTypewriter })
  // 标题折叠（仅渲染层）：换文档时由 setMarkdown 清空，源码模式往返则保留
  const fold = createFoldPlugin()

  // —— 行内输入规则：[[目标]] 与 #标签 触发即转成节点 ——
  const inputRulesPlugin = new Plugin({
    props: {
      handleTextInput(view, from, to, text) {
        const state = view.state
        const sel = state.selection
        if (!sel.empty) return false
        const $head = sel.$head
        if (!$head.parent || !$head.parent.isTextblock) return false
        const blockFrom = $head.start()
        const caret = $head.pos
        const before = state.doc.textBetween(blockFrom, caret, '\u0000', '\u0000')

        // [[...]]：补全右侧 ]] 时替换
        if (text === ']') {
          const m = /\[\[([^\[\]]+)\]\]$/.exec(before + text)
          if (m) {
            const startAbs = caret - (m[0].length - text.length)
            if (startAbs >= blockFrom) {
              const node = schema.nodes.wikiLink.create({ target: m[1].trim(), label: null })
              const tr = state.tr.replaceWith(startAbs, caret, node)
              tr.setSelection(TextSelection.create(tr.doc, startAbs + node.nodeSize))
              view.dispatch(tr.scrollIntoView())
              return true
            }
          }
          return false
        }

        // #tag：输入空格时把紧邻的 #word 转为标签节点，并保留空格
        if (text === ' ') {
          const m = /(^|[\s(])#([A-Za-z0-9_\-/]+)$/.exec(before)
          if (m) {
            const hashIdx = caret - m[2].length - 1 // '#' 的绝对位置
            if (hashIdx >= blockFrom) {
              const node = schema.nodes.tag.create({ tag: m[2] })
              const tr = state.tr.replaceWith(hashIdx, caret, [node, schema.text(' ')])
              tr.setSelection(TextSelection.create(tr.doc, hashIdx + node.nodeSize + 1))
              view.dispatch(tr.scrollIntoView())
              return true
            }
          }
        }

        // $...$：补上尾 $$时把整段射为行内数学（与 [[...]] 同构机制）
        if (text === '$') {
          const m = /\$([^$\n]+)\$$/.exec(before + text)
          if (m) {
            const startAbs = caret - (m[0].length - text.length)
            if (startAbs >= blockFrom) {
              const node = schema.nodes.math_inline.create({ latex: m[1] })
              const tr = state.tr.replaceWith(startAbs, caret, node)
              tr.setSelection(TextSelection.create(tr.doc, startAbs + node.nodeSize))
              view.dispatch(tr.scrollIntoView())
              return true
            }
          }
          return false
        }
        return false
      },
    },
  })

  // —— 粘贴图片 ——
  const pasteImagesPlugin = new Plugin({
    props: {
      handlePaste(view, event) {
        const files = imageFiles(event.clipboardData)
        if (!files.length) return false
        insertImageFiles(view, view.state.selection.from, files, opts)
        return true
      },
    },
  })

  // 编辑器 keymap：由「默认键 ∪ 覆盖」动态生成（标记 __nlKeymap，供热重配时原地替换）
  const nlKeymapPlugin = buildEditorKeymap(opts.keymapOverrides || {})
  nlKeymapPlugin.__nlKeymap = true
  const base = keymap(baseKeymap)

  const state = EditorState.create({
    schema,
    doc: parseMarkdown(''),
    plugins: [
      history(),
      createSuggestPlugin({
        getDocs: opts.suggestDocs || (() => []),
        getTags: opts.suggestTags || (() => []),
      }),
      createSlashMenuPlugin(),
      tableKeymap(),
      nlKeymapPlugin,
      base,
      inputRulesPlugin,
      pasteImagesPlugin,
      highlightPlugin(),
      mermaidPlugin(),
      footnotePlugin(),
      modes.plugin,
      fold.plugin,
      ...tablePlugins(),
    ],
  })

  const view = new EditorView(opts.mountEl, {
    state,
    nodeViews: {
      math_inline: mathInlineView,
      math_block: mathBlockView,
      image: makeImageNodeView(() => opts.getVault()),
    },
    dispatchTransaction(tr) {
      const prevDoc = view.state.doc
      const next = view.state.apply(tr)
      view.updateState(next)
      if (tr.docChanged) {
        if (!sourceMode) modelDirty = true
        if (!dirty) {
          dirty = true
          opts.onDirty && opts.onDirty(true)
        }
        emitMeta(view, opts)
        opts.onDocChange && opts.onDocChange(next.doc, prevDoc)
      }
      // 光标换块也要上报：mac「段落」菜单的勾跟着选区走（去抖与签名比对在 main.js）
      if (tr.selectionSet || tr.docChanged) opts.onSelectionChange && opts.onSelectionChange(next)
    },
  })

  // [[链接]] hover 悬浮预览（仅存在 vault 时才有意义，卡片自己判取 ctx）
  attachWikiHover(view.dom, () => opts.getVault())

  // 表格单元格右键：增删行列 / 对齐 / 切换表头 / 删表（复用 .cv-menu 样式）
  attachTableContextMenu(view)

  // 代码块右上角语言标签：点击弹可搜索语言列表（Typora 式，语言存围栏 info string 不入正文）
  attachCodeLangPicker(view)

  // 跳转到文档内某 pos：大纲与 #锚点 链接共用。目标被折在某节里时先展开，否则跳过去看不见。
  function jumpToPos(pos) {
    const open = unfoldCovering(view.state, pos)
    if (open) view.dispatch(open)
    const tr = view.state.tr.setSelection(
      TextSelection.create(view.state.doc, Math.min(pos + 1, view.state.doc.content.size))
    )
    view.dispatch(tr.scrollIntoView())
    view.focus()
  }

  // 点击 [[链接]]：拦截跳转（链接节点 contenteditable=false）
  view.dom.addEventListener('click', (e) => {
    const wiki = e.target.closest('.nl-wiki')
    if (wiki) {
      e.preventDefault()
      opts.onOpenWiki && opts.onOpenWiki(wiki.getAttribute('data-target'))
      return
    }
    // 点击文档内 #锚点 链接（docx 交叉引用等产出）：按共享 slug 规则反查标题并跳转。
    // 与站点导出（发 heading id）同一套 heading-anchor 规则，故同一 slug 三处必达。
    const a = e.target.closest('a')
    if (a) {
      const href = a.getAttribute('href') || ''
      if (href.startsWith('#')) {
        e.preventDefault() // 阻止 webview 走原生锚点导航（会改 URL / 空白跳转）
        const key = decodeURIComponent(href.slice(1))
        const map = buildAnchorMap(view.state.doc)
        if (map.has(key)) jumpToPos(map.get(key))
        // 无匹配标题：仅拦下默认行为，不跳转（等同普通无效锚点）
      }
    }
  })

  // 拖拽图片到编辑器
  view.dom.addEventListener('dragover', (e) => {
    if (e.dataTransfer && Array.from(e.dataTransfer.files).some(isImage)) e.preventDefault()
  })
  view.dom.addEventListener('drop', (e) => {
    const files = imageFiles(e.dataTransfer)
    if (!files.length) return
    e.preventDefault()
    const pos = view.posAtCoords({ left: e.clientX, top: e.clientY })
    insertImageFiles(view, pos ? pos.pos : view.state.selection.from, files, opts)
  })

  // —— 源码模式（CodeMirror 6，懒加载）与 WYSIWYG 的双向同步 ——
  function serializedFull() {
    return joinFrontmatter(fmRaw, serializeMarkdown(view.state.doc))
  }
  function currentThemeName() {
    return document.documentElement.getAttribute('data-theme') || 'light'
  }
  async function ensureSrc() {
    if (src) return src
    const mod = await import('./source-editor.js')
    src = await mod.createSourceEditor({ mountEl: opts.sourceMountEl, theme: currentThemeName(), onChange: onSourceChange })
    return src
  }
  function onSourceChange(text) {
    rawSource = text
    modelDirty = false // 源码即最新全文，模型将据其重建
    if (!dirty) { dirty = true; opts.onDirty && opts.onDirty(true) }
    if (srcChangeTimer) clearTimeout(srcChangeTimer)
    srcChangeTimer = setTimeout(() => { opts.onSourceTextChange && opts.onSourceTextChange(text) }, 200)
  }
  async function enterSource() {
    const text = resolveSourceText({ modelDirty, rawSource, serialized: serializedFull() })
    rawSource = text
    // 先隐藏整个编辑器容器、显示源码容器并（懒）建 CM —— 保证 CM 在可见且有尺寸的容器里测量
    if (opts.mountEl) opts.mountEl.classList.add('hidden')
    if (opts.sourceMountEl) opts.sourceMountEl.classList.remove('hidden')
    await ensureSrc()
    src.setDoc(text)
    sourceMode = true
    src.focus()
    opts.onFrontmatterChange && opts.onFrontmatterChange()
    return true
  }
  function exitSource() {
    if (!sourceMode) return false
    const text = src ? src.getDoc() : rawSource || ''
    const { yaml: fm, body } = splitFrontmatter(text)
    fmRaw = fm
    view.updateState(EditorState.create({ schema, doc: parseMarkdown(body), plugins: view.state.plugins }))
    rawSource = text
    modelDirty = false
    sourceMode = false
    if (opts.sourceMountEl) opts.sourceMountEl.classList.add('hidden')
    if (opts.mountEl) opts.mountEl.classList.remove('hidden')
    emitMeta(view, opts)
    opts.onFrontmatterChange && opts.onFrontmatterChange()
    view.focus()
    return false
  }
  function setSourceTheme(name) { if (src) src.setTheme(name) }

  return {
    view,
    setMarkdown(md) {
      fold.api.reset() // 换文档：旧的折叠位置与新文档无关，一律清空
      rawSource = md
      modelDirty = false
      if (sourceMode && src) {
        // 源码态下打开/重载文件：原文直接进 CodeMirror，不重解析模型
        fmRaw = splitFrontmatter(md).yaml
        src.setDoc(md)
        dirty = false
        opts.onDirty && opts.onDirty(false)
        opts.onFrontmatterChange && opts.onFrontmatterChange()
        if (srcChangeTimer) clearTimeout(srcChangeTimer)
        opts.onSourceTextChange && opts.onSourceTextChange(md)
        return
      }
      // 剥离开头 frontmatter，只把正文交给模型；原始 yaml 存于 fmRaw 供原样补回
      const { yaml: fm, body } = splitFrontmatter(md)
      fmRaw = fm
      view.updateState(EditorState.create({ schema, doc: parseMarkdown(body), plugins: view.state.plugins }))
      dirty = false
      opts.onDirty && opts.onDirty(false)
      emitMeta(view, opts)
      opts.onFrontmatterChange && opts.onFrontmatterChange()
    },
    getMarkdown() {
      // 源码态返回 CodeMirror 全文（原文，不被重新序列化）；WYSIWYG 态序列化补回 frontmatter
      return sourceMode && src ? src.getDoc() : serializedFull()
    },
    // frontmatter：读原始文本 + 解析后的对象；解析失败/非对象时降级为 {}（不抛，原文仍在 raw）
    // 源码态从 CodeMirror 全文现取 fm（原文里的 --- 块），WYSIWYG 态取 fmRaw
    getFrontmatter() {
      const raw = sourceMode && src ? splitFrontmatter(src.getDoc()).yaml : fmRaw
      if (raw == null) return { raw: null, data: {} }
      let data = {}
      try {
        const d = yaml.load(raw)
        if (d && typeof d === 'object' && !Array.isArray(d)) data = d
      } catch (_) {
        data = {}
      }
      return { raw, data }
    },
    // 面板编辑后写回：raw=null 表示移除 frontmatter；置脏并触发自动保存与面板刷新
    setFrontmatter(raw) {
      if (sourceMode && src) {
        const { body } = splitFrontmatter(src.getDoc())
        src.setDoc(joinFrontmatter(raw, body)) // 程序化写入，不触发 onChange
        rawSource = src.getDoc()
        modelDirty = false
        dirty = true
        opts.onDirty && opts.onDirty(true)
        opts.onFrontmatterChange && opts.onFrontmatterChange()
        return
      }
      fmRaw = raw == null ? null : String(raw)
      dirty = true
      opts.onDirty && opts.onDirty(true)
      opts.onFrontmatterChange && opts.onFrontmatterChange()
    },
    markSaved() {
      dirty = false
      opts.onDirty && opts.onDirty(false)
    },
    focus() {
      view.focus()
    },
    // 热重配编辑器 keymap：原地替换 __nlKeymap 插件（保留其它插件与顺序），令重绑即时生效
    setKeymapOverrides(overrides) {
      const next = buildEditorKeymap(overrides)
      next.__nlKeymap = true
      const cur = view.state.plugins
      const idx = cur.findIndex((p) => p.__nlKeymap)
      const list = cur.slice()
      if (idx >= 0) list[idx] = next
      else list.splice(list.length - 1, 0, next) // 兜底：插在 base 之前以保优先级
      view.updateState(view.state.reconfigure({ plugins: list }))
    },
    // 面板/设置页/原生菜单「主动执行」一条编辑命令：聚焦后对当前 state 求值 PM 命令
    runEditorCommand(id) {
      // 源码态下可见的是 CodeMirror：撤销/重做归它自己的历史，动 PM 等于改错对象
      if (sourceMode && src && (id === 'editor.undo' || id === 'editor.redo')) {
        return id === 'editor.undo' ? src.undo() : src.redo()
      }
      const fn = PM_COMMANDS[id]
      if (!fn) return false
      view.focus()
      const ok = fn(view.state, view.dispatch, view)
      if (ok) view.focus()
      return !!ok
    },
    focusEditor() {
      view.focus()
    },
    // 写作统计：源码态按 CodeMirror 全文计数；WYSIWYG 取文档纯文本（块间用 \n 分隔）
    getText() {
      if (sourceMode && src) return src.getDoc()
      return view.state.doc.textBetween(0, view.state.doc.content.size, '\n', '\n')
    },
    // 源码模式：整篇切换 WYSIWYG <-> Markdown 原文（CodeMirror，懒加载）
    isSourceMode() { return sourceMode },
    // 当前块类型（mac「段落」菜单的勾）；源码态可见的是 CodeMirror，无块可言
    activeBlock() { return sourceMode ? null : activeBlockKey(view.state) },
    enterSource,
    exitSource,
    async toggleSource() { return sourceMode ? exitSource() : await enterSource() },
    setSourceTheme,
    // 专注 / 打字机模式开关（main.js 驱动并持久化）
    setFocusMode(on) { modes.api.setFocus(on) },
    setTypewriterMode(on) { modes.api.setTypewriter(on) },
    jumpToPos, // 大纲面板复用同一跳转（含折叠展开 + 落光标 + 滚动）
  }
}

function isImage(file) {
  return file && file.type && file.type.startsWith('image/')
}

// —— 图片显示：markdown 里存的是相对当前文档的路径（如 ./assets/x.png），
// 而 Tauri webview 直接 <img src=相对> 会解析到应用自身 origin 而 404。
// NodeView 通过 Rust read_image_data_uri 读字节转 data: URL（最稳，不依赖 asset 协议/scope/跨域）。
// 序列化仍用原始相对 src（attrs 不变），故写盘/往返无损。结果按绝对键缓存，切文件不重读。
const imgDataCache = new Map() // key(vault|md|src) -> dataUri

const IMG_W_MIN = 40

function makeImageNodeView(getVault) {
  return (node, view, getPos) => {
    const img = document.createElement('img')
    // 包一层 host：加载失败时在原地显示「未找到图片：<路径>」提示（而非空白框）
    const host = document.createElement('span')
    host.className = 'nl-img-host'
    // 右下角把手：按住直接拖宽，双击回原尺寸；宽度是节点属性，落进 Markdown 而非 DOM
    const grip = document.createElement('span')
    grip.className = 'nl-img-grip'
    host.appendChild(img)
    host.appendChild(grip)
    const apply = (n) => {
      if (n.attrs.alt) img.setAttribute('alt', n.attrs.alt)
      else img.removeAttribute('alt')
      if (n.attrs.title) img.setAttribute('title', n.attrs.title)
      else img.removeAttribute('title')
      img.style.width = n.attrs.width ? n.attrs.width + 'px' : ''
      loadImgSrc(img, host, n.attrs.src, getVault)
    }
    const writeWidth = (w) => {
      if (typeof getPos !== 'function') return
      const pos = getPos()
      if (pos == null) return
      const cur = view.state.doc.nodeAt(pos)
      if (!cur || cur.attrs.width === w) return
      view.dispatch(view.state.tr.setNodeMarkup(pos, undefined, { ...cur.attrs, width: w }))
    }
    apply(node)
    grip.addEventListener('pointerdown', (e) => {
      e.preventDefault()
      grip.classList.add('dragging')
      host.classList.add('is-resizing')
      const base = img.getBoundingClientRect().width
      const slot = host.parentElement ? host.parentElement.getBoundingClientRect().width : base
      const startX = e.clientX
      let w = Math.round(base)
      const max = Math.max(IMG_W_MIN, Math.round(slot))
      const move = (ev) => {
        w = Math.max(IMG_W_MIN, Math.min(max, Math.round(base + (ev.clientX - startX))))
        img.style.width = w + 'px'
      }
      const up = () => {
        window.removeEventListener('pointermove', move)
        window.removeEventListener('pointerup', up)
        window.removeEventListener('pointercancel', up)
        grip.classList.remove('dragging')
        host.classList.remove('is-resizing')
        writeWidth(w) // 松手才落一次事务：拖动过程只改样式，不进 undo 栈
      }
      window.addEventListener('pointermove', move)
      window.addEventListener('pointerup', up)
      window.addEventListener('pointercancel', up)
    })
    grip.addEventListener('dblclick', (e) => {
      e.preventDefault()
      e.stopPropagation()
      img.style.width = ''
      writeWidth(null)
    })
    return {
      dom: host,
      ignoreMutation: () => true,
      // 把手上的指针事件不交给编辑器：否则按下即选中图片并起文本拖拽
      stopEvent(e) {
        return e.target === grip || grip.contains(e.target)
      },
      update(next) {
        if (next.type.name !== 'image') return false
        apply(next)
        return true
      },
      selectNode() {
        host.classList.add('ProseMirror-selectednode')
      },
      deselectNode() {
        host.classList.remove('ProseMirror-selectednode')
      },
    }
  }
}

// 异步把 src 装到 img 上；用 img.__key 防止 update 竞态下旧请求覆盖新图。
// 加载失败：隐藏破图，在 host 内显示「未找到图片：<src>」提示（hover 有完整路径）。
function loadImgSrc(img, host, src, getVault) {
  // 每次（重）加载先清除上一次的缺失态
  host.classList.remove('is-missing')
  const oldHint = host.querySelector('.nl-img-hint')
  if (oldHint) oldHint.remove()
  img.classList.remove('nl-img-missing')

  if (!src) {
    img.removeAttribute('src')
    img.__key = null
    return
  }
  // 远程 / 内联 / 剪贴板 blob：直接透传
  if (/^(https?:|data:|blob:)/i.test(src)) {
    img.__key = null
    img.src = src
    return
  }
  const ctx = getVault()
  if (!ctx || !ctx.vaultRoot || !ctx.mdRel) {
    img.src = src // 未打开库：无从解析，原样交给浏览器
    img.__key = null
    return
  }
  const key = ctx.vaultRoot + '|' + ctx.mdRel + '|' + src
  img.__key = key
  const cached = imgDataCache.get(key)
  if (cached) {
    img.src = cached
    return
  }
  readImageDataUri(ctx.vaultRoot, ctx.mdRel, src)
    .then((uri) => {
      imgDataCache.set(key, uri)
      if (img.__key === key) img.src = uri
    })
    .catch(() => {
      if (img.__key !== key) return
      img.removeAttribute('src')
      img.classList.add('nl-img-missing')
      host.classList.add('is-missing')
      const hint = document.createElement('span')
      hint.className = 'nl-img-hint'
      hint.setAttribute('contenteditable', 'false')
      hint.textContent = '未找到图片：' + src
      hint.title = src
      host.appendChild(hint)
    })
}

// 插入行内/块级公式：有选区就用选区内容作为 latex，否则给一个占位例子
function insertMath(kind) {
  return (state, dispatch) => {
    const sel = state.selection
    let latex = ''
    if (!sel.empty) {
      latex = state.doc.textBetween(sel.from, sel.to, ' ', ' ').trim()
    }
    if (!latex) latex = kind === 'math_inline' ? 'e^{i\\pi}+1=0' : '\\int_{0}^{\\infty} e^{-x^2}\\,dx = \\frac{\\sqrt{\\pi}}{2}'
    const node = schema.nodes[kind].create({ latex })
    let tr
    if (kind === 'math_block') {
      // 块级：插到当前 block 后，确保不处于 textblock 中
      const $head = sel.$head || state.doc.resolve(sel.head)
      const at = $head.end($head.depth === 0 ? 0 : $head.depth - 1)
      tr = state.tr.insert(at, node)
    } else {
      tr = state.tr.replaceSelectionWith(node)
    }
    dispatch(tr.scrollIntoView())
    return true
  }
}

function imageFiles(dt) {
  if (!dt || !dt.files) return []
  return Array.from(dt.files).filter(isImage)
}

async function insertImageFiles(view, pos, files, opts) {
  const ctx = opts.getVault()
  if (!ctx.vaultRoot || !ctx.mdRel) {
    // 未打开知识库/文档时，退化为直接插入原始对象 URL（不落库）
    files.forEach((f) => {
      const url = URL.createObjectURL(f)
      view.dispatch(
        view.state.tr.insert(pos, schema.nodes.image.create({ src: url, alt: '', title: null }))
      )
    })
    return
  }
  for (const f of files) {
    try {
      const rel = await saveImageFromFile(ctx.vaultRoot, ctx.mdRel, f)
      const node = schema.nodes.image.create({ src: rel, alt: '', title: null })
      const at = Math.min(pos, view.state.doc.content.size)
      view.dispatch(view.state.tr.insert(at, node).scrollIntoView())
    } catch (err) {
      console.error('保存图片失败', err)
    }
  }
}

function emitMeta(view, opts) {
  if (!opts.onMetaChange) return
  const outline = []
  const tags = []
  const seen = new Set()
  view.state.doc.forEach((node, pos) => {
    if (node.type.name === 'heading') {
      outline.push({ level: node.attrs.level, text: node.textContent, pos })
    }
    node.descendants((child) => {
      if (child.type.name === 'tag' && !seen.has(child.attrs.tag)) {
        seen.add(child.attrs.tag)
        tags.push(child.attrs.tag)
      }
    })
  })
  opts.onMetaChange({ outline, tags })
}
