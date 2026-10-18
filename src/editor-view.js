// editor-view.js —— ProseMirror WYSIWYG 编辑器装配
// 负责：状态与插件、快捷键、[[wikilink]]/#tag 行内输入规则、图片拖拽/粘贴落库、
// 点击链接跳转、大纲与标签提取。纯渲染/交互层，模型转换在 editor-schema.js。

import { EditorView } from 'prosemirror-view'
import { EditorState, TextSelection, Plugin } from 'prosemirror-state'
import { Fragment, Slice } from 'prosemirror-model'
import { keymap } from 'prosemirror-keymap'
import { history, undo, redo } from 'prosemirror-history'
import { baseKeymap, toggleMark, chainCommands, exitCode, selectNodeBackward } from 'prosemirror-commands'
import { schema, parseMarkdown, serializeMarkdown, serializeMarkdownMapped } from './editor-schema.js'
import { splitFrontmatter, joinFrontmatter } from './frontmatter.js'
import { resolveSourceText } from './source-sync.js'
import { createPosMapper } from './pos-map.js'
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
import { findPlugin } from './find-in-doc.js'
import { t } from './i18n.js'

// —— 批次 D：编辑器命令表 + 动态 keymap ——
// 可重绑的编辑命令（进统一注册表、面板/设置页可列）。结构键 Shift-Enter（硬换行）、
// Backspace（节点后向删除）与标准重做别名 Shift-Mod-z 固定于 PM keymap，不进注册表。
// 默认键位按 Typora/Obsidian 主流习惯配（见 docs/CLUADE.MD「快捷键规范」）。
// 标题是词条键（titleKey），registration 时按当前语言取值；换语言由 main.js 重注册刷新。
const EDITOR_COMMAND_DEFS = [
  { id: 'editor.undo', titleKey: 'cmd.editor.undo', defaultKey: 'Mod-z' },
  { id: 'editor.redo', titleKey: 'cmd.editor.redo', defaultKey: 'Mod-y' },
  { id: 'editor.bold', titleKey: 'cmd.editor.bold', defaultKey: 'Mod-b' },
  { id: 'editor.italic', titleKey: 'cmd.editor.italic', defaultKey: 'Mod-i' },
  { id: 'editor.code', titleKey: 'cmd.editor.code', defaultKey: 'Mod-`' },
  { id: 'editor.strike', titleKey: 'cmd.editor.strike', defaultKey: 'Mod-Shift-x' },
  { id: 'editor.mathInline', titleKey: 'cmd.editor.mathInline', defaultKey: 'Mod-m' },
  { id: 'editor.mathBlock', titleKey: 'cmd.editor.mathBlock', defaultKey: 'Mod-Shift-m' },
  { id: 'editor.foldSection', titleKey: 'cmd.editor.foldSection', defaultKey: 'Mod-Shift-h' },
  // 插入 / 编辑链接：所见即所得里没有直接改 href 的入口，URL 经 main.js 注入的弹窗问
  { id: 'editor.link', titleKey: 'cmd.editor.link', defaultKey: 'Mod-k' },
  // 删除当前行 / 段落（Typora 的 Ctrl+D）
  { id: 'editor.deleteLine', titleKey: 'cmd.editor.deleteLine', defaultKey: 'Mod-d' },
  // 脚注（无默认键，命令面板可搜；Ctrl-Shift-F 已被「专注」占用）
  { id: 'editor.footnote', titleKey: 'cmd.editor.footnote', defaultKey: null },
  { id: 'editor.footnoteDelete', titleKey: 'cmd.editor.footnoteDelete', defaultKey: null },
  // 标题升 / 降级：Typora 的「段落」菜单项，作用于选区所在标题，越出 1..6 即命令返回 false（菜单置灰）
  { id: 'editor.headingUp', titleKey: 'cmd.editor.headingUp', defaultKey: 'Mod-]' },
  { id: 'editor.headingDown', titleKey: 'cmd.editor.headingDown', defaultKey: 'Mod-[' },
]

// 段落命令入同一张表：项表复用斜杠菜单（一份定义），公式块不在这里（已有 editor.mathBlock）。
// 默认键位按 Typora 习惯：标题 Ctrl+1~6、代码块 Ctrl+Shift+K、引用 Ctrl+Shift+Q、
// 任务列表 Ctrl+Shift+L、无序 / 有序列表 Ctrl+Shift+[ / ]、表格 Ctrl+T。
// 无 defaultKey → 不占快捷键，只供面板与 mac 原生「段落」菜单调用。
const BLOCK_DEFAULT_KEYS = {
  h1: 'Mod-1', h2: 'Mod-2', h3: 'Mod-3', h4: 'Mod-4', h5: 'Mod-5', h6: 'Mod-6',
  code: 'Mod-Shift-k', quote: 'Mod-Shift-q', task: 'Mod-Shift-l',
  bullet: 'Mod-Shift-[', ordered: 'Mod-Shift-]', table: 'Mod-t',
}
const BLOCK_CMD_IDS = ['para', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'quote', 'code', 'bullet', 'ordered', 'task', 'hr', 'table', 'callout', 'mermaid']
for (const id of BLOCK_CMD_IDS) {
  EDITOR_COMMAND_DEFS.push({ id: 'editor.block.' + id, titleKey: 'cmd.editor.block.' + id, defaultKey: BLOCK_DEFAULT_KEYS[id] || null })
}

/** 注册用：按当前语言解析标题。语言切换后重新调用即可刷新注册表里的 title。 */
export function editorCommandDefs() {
  return EDITOR_COMMAND_DEFS.map((def) => ({ ...def, title: t(def.titleKey) }))
}

export const EDITOR_COMMANDS = EDITOR_COMMAND_DEFS

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
  'editor.link': insertLink,
  'editor.deleteLine': deleteLine,
  'editor.footnote': insertFootnote,
  'editor.footnoteDelete': deleteFootnote,
}

PM_COMMANDS['editor.headingUp'] = headingStep(-1)
PM_COMMANDS['editor.headingDown'] = headingStep(1)
for (const id of BLOCK_CMD_IDS) {
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
  askLinkUrl = typeof opts.onAskLinkUrl === 'function' ? opts.onAskLinkUrl : null
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
      findPlugin(),
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
  // 源码全文里正文的起始偏移（frontmatter 前缀长度）：位置映射以正文为坐标系，
  // splitFrontmatter 的 body 是入参的后缀，故长度差即前缀长（带 BOM 时也恰好对得上）
  function bodyOffset(text) {
    return text.length - splitFrontmatter(text).body.length
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
  // 当前所见即所得选区，以 DOM 选区为准。PM 的 state 选区靠 selectionchange 异步回同步，
  // 方向键之后立刻按 Ctrl+E 时可能还没跟上，用户看见的光标才是要映射的位置；
  // DOM 选区不在编辑器内（焦点在别处）时才回退 state。
  function currentSel() {
    const sel = window.getSelection()
    if (sel && sel.rangeCount) {
      const r = sel.getRangeAt(0)
      if (view.dom.contains(r.startContainer) && view.dom.contains(r.endContainer)) {
        try {
          const a = view.posAtDOM(r.startContainer, r.startOffset)
          const b = view.posAtDOM(r.endContainer, r.endOffset)
          if (a >= 0 && b >= 0) return { from: Math.min(a, b), to: Math.max(a, b) }
        } catch (_) {
          /* 落到回退 */
        }
      }
    }
    const s = view.state.selection
    return { from: s.from, to: s.to }
  }
  // 光标对齐：映射失败（异常节点、极端文本）不阻断切换，退回原来的行为（光标落文档开头）
  function mapSelToSource(text) {
    try {
      const mapper = createPosMapper({ doc: view.state.doc, serialize: serializeMarkdownMapped, source: text, base: bodyOffset(text) })
      const sel = currentSel()
      return [mapper.pmToSrc(sel.from), mapper.pmToSrc(sel.to)]
    } catch (_) {
      return null
    }
  }
  function mapSelFromSource(text, doc, body) {
    if (!src) return null
    try {
      const range = src.getSelection()
      const mapper = createPosMapper({ doc, serialize: serializeMarkdownMapped, source: text, base: text.length - body.length })
      return TextSelection.between(doc.resolve(mapper.srcToPm(range.from)), doc.resolve(mapper.srcToPm(range.to)))
    } catch (_) {
      return null
    }
  }
  // 两个编辑器共用的外层滚动容器是 .editor-pane。CM 和 PM 自己的 scrollIntoView 在这里
  // 都不可靠：CM 写的是 .cm-scroller（本应用 overflow:visible，不滚），PM 要求 DOM 选区
  // 已经在编辑器内。
  function sourcePane() {
    return opts.sourceMountEl && opts.sourceMountEl.closest ? opts.sourceMountEl.closest('.editor-pane') : null
  }
  function editorPane() {
    return opts.mountEl && opts.mountEl.closest ? opts.mountEl.closest('.editor-pane') : null
  }
  // 把滚动容器滚到「el 可见」：上下各留 margin，已可见则不动（夹紧到合法滚动范围）
  function scrollElementIntoPane(el, pane, margin = 48) {
    if (!el || !pane) return
    scrollRectIntoPane(el.getBoundingClientRect(), pane, margin)
  }
  function scrollRectIntoPane(r, pane, margin = 48) {
    if (!r || (!r.height && !r.width)) return // 隐藏 / 未布局
    const pr = pane.getBoundingClientRect()
    let top = pane.scrollTop
    if (r.top < pr.top + margin) top -= pr.top + margin - r.top
    else if (r.bottom > pr.bottom - margin) top += r.bottom - (pr.bottom - margin)
    const max = Math.max(0, pane.scrollHeight - pane.clientHeight)
    pane.scrollTop = Math.max(0, Math.min(top, max))
  }
  // 按 host 容器内当前 DOM 选区（= 光标）的位置滚 pane：CM 的光标行要等一帧才渲染出来，
  // 拿到元素后直接量它
  function scrollDomSelectionIntoPane(host, pane, margin = 48) {
    if (!host || !pane) return
    const sel = window.getSelection()
    if (!sel || !sel.rangeCount) return
    const r = sel.getRangeAt(0)
    if (!host.contains(r.startContainer)) return
    const el = r.startContainer.nodeType === 3 ? r.startContainer.parentElement : r.startContainer
    scrollElementIntoPane(el, pane, margin)
  }
  function nextFrame() {
    return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  }
  // PM 光标所在 DOM 元素（docView.domAtPos 拿到的可能是文本节点，取它的父元素才有盒子）
  function caretElementOf(v, pos) {
    let node = null
    try {
      node = v.docView && v.docView.domAtPos ? v.docView.domAtPos(pos) : null
    } catch (_) {
      return null
    }
    if (!node) return null
    if (node.nodeType === 3) node = node.parentNode
    return node && node.nodeType === 1 ? node : null
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
    // 光标对齐：把 WYSIWYG 当前选区换算成源码偏移带过去（原文字节 / 重新序列化都覆盖）
    const range = mapSelToSource(text)
    if (range) src.setSelection(range[0], range[1])
    src.focus()
    // CM 只渲染视口内的行，它自己的 scrollIntoView 也只作用于 .cm-scroller，而本应用的纵向
    // 滚动在外层 .editor-pane（.nl-source .cm-scroller{overflow:visible}），CM 滚不动。
    // 等一帧，让 CM 在那一帧的 measure 里把光标所在行渲染出来，再按 DOM 选区把外层容器滚到
    // 光标可见；不等的话切过去只看见文件头，光标在屏幕外。
    if (range) {
      await nextFrame()
      scrollDomSelectionIntoPane(opts.sourceMountEl, sourcePane(), 48)
    }
    opts.onFrontmatterChange && opts.onFrontmatterChange()
    return true
  }
  function exitSource() {
    if (!sourceMode) return false
    const text = src ? src.getDoc() : rawSource || ''
    const { yaml: fm, body } = splitFrontmatter(text)
    fmRaw = fm
    const doc = parseMarkdown(body)
    // 光标对齐：源码选区 → 新文档里的对应位置（退出后选区和滚动都落在原处）
    const sel = mapSelFromSource(text, doc, body)
    view.updateState(EditorState.create({ schema, doc, plugins: view.state.plugins }))
    rawSource = text
    modelDirty = false
    sourceMode = false
    if (opts.sourceMountEl) opts.sourceMountEl.classList.add('hidden')
    if (opts.mountEl) opts.mountEl.classList.remove('hidden')
    emitMeta(view, opts)
    opts.onFrontmatterChange && opts.onFrontmatterChange()
    if (sel) {
      // 先 focus 再 setSelection + scrollIntoView：PM 的 scrollToSelection 要求 DOM 选区已经
      // 在编辑器内，此刻它还在 CodeMirror 里，顺序反了它直接返回、不滚动，表现是退回来光标
      // 位置对但视图停在文档开头。
      view.focus()
      view.dispatch(view.state.tr.setSelection(sel).scrollIntoView())
      // 再按光标的 DOM 节点补一次滚动，防止 PM 内部那条路因为布局时序没滚成。
      scrollElementIntoPane(caretElementOf(view, sel.head), editorPane(), 48)
    } else {
      view.focus()
    }
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
    // 插入图片（Ctrl+Shift+I）：隐藏 file input 选图，之后与拖拽 / 粘贴同一条落库路径
    pickAndInsertImages() {
      const input = document.createElement('input')
      input.type = 'file'
      input.accept = 'image/*'
      input.multiple = true
      input.style.display = 'none'
      input.addEventListener('change', () => {
        const files = Array.from(input.files || [])
        if (files.length) insertImageFiles(view, view.state.selection.from, files, opts)
        input.remove()
      })
      document.body.appendChild(input)
      input.click()
    },
    // 粘贴为纯文本（Ctrl+Shift+P）：不带任何格式插入，换行转硬换行（保留视觉分行）
    insertPlainText(text) {
      const t = String(text == null ? '' : text)
      if (!t) return
      if (sourceMode && src) {
        const { from, to } = src.getSelection()
        const doc = src.getDoc()
        src.setDoc(doc.slice(0, from) + t + doc.slice(to))
        src.setSelection(from + t.length)
        return
      }
      view.focus()
      const tr = view.state.tr
      const sel = view.state.selection
      if (!sel.empty) tr.delete(sel.from, sel.to)
      const frag = []
      t.split('\n').forEach((line, i) => {
        if (i > 0) frag.push(schema.nodes.hard_break.create())
        if (line) frag.push(schema.text(line))
      })
      tr.replaceSelection(new Slice(Fragment.from(frag), 0, 0))
      view.dispatch(tr.scrollIntoView())
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
      hint.textContent = t('msg.imgNotFound', { src })
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
      console.error(t('msg.imgSaveFailed'), err)
    }
  }
}

// —— 插入 / 编辑链接（Ctrl+K）——
// 所见即所得里没有直接改 href 的入口，URL 由 main.js 注入的弹窗问（onAskLinkUrl）。
// 纯编辑器（无注入）时退化为「不问 URL 直接建 / 解除」，供测试与复用。
let askLinkUrl = null

function markInRange(state, from, to, type) {
  let found = null
  state.doc.nodesBetween(from, to, (node) => {
    if (found || !node.isText) return
    const m = node.marks.find((x) => x.type === type)
    if (m) found = m
  })
  return found
}

function insertLink(state, dispatch, view) {
  const { from, to, empty } = state.selection
  const type = schema.marks.link
  const existing = empty
    ? state.selection.$from.marks().find((m) => m.type === type) || null
    : markInRange(state, from, to, type)
  if (!askLinkUrl) {
    // 已有链接且无询问入口：解除链接；否则套一个空 href
    applyLinkUrl(view, from, to, empty, existing ? '' : 'https://')
    return true
  }
  Promise.resolve(askLinkUrl(existing ? existing.attrs.href || '' : '')).then((url) => {
    applyLinkUrl(view, from, to, empty, url)
  })
  return true // 已接管：不让按键继续走 webview 默认行为
}

// url = null 取消（不动文档）；'' 解除链接；其余新建或改址。空选区插「链接文字」骨架并选中。
function applyLinkUrl(view, from, to, empty, url) {
  if (url === null) return
  const cur = view.state
  const size = cur.doc.content.size
  const f = Math.max(0, Math.min(from, size))
  const to2 = Math.max(f, Math.min(to, size)) // 局部名避开 i18n 的 t
  const type = schema.marks.link
  const tr = cur.tr
  if (url === '') {
    tr.removeMark(f, to2, type)
    view.dispatch(tr.scrollIntoView())
    view.focus()
    return
  }
  if (empty) {
    const text = t('editor.linkText')
    tr.insertText(text, f)
    tr.addMark(f, f + text.length, type.create({ href: url, title: null }))
    tr.setSelection(TextSelection.create(tr.doc, f, f + text.length))
  } else {
    tr.addMark(f, to2, type.create({ href: url, title: null }))
  }
  view.dispatch(tr.scrollIntoView())
  view.focus()
}

// 删除当前行 / 段落（Ctrl+D）：整项删列表项，否则删最近的文本块（段落 / 标题 / 引用内段落）。
// 文档只剩一个块时不删节点（PM 不允许空 doc），改为清空其内容，留下一个空段落。
function deleteLine(state, dispatch) {
  const $ = state.selection.$head
  if (!$) return false
  for (let d = $.depth; d >= 1; d--) {
    const n = $.node(d)
    if (n.type.name !== 'list_item' && !n.isTextblock) continue
    if (!dispatch) return true
    const only = d === 1 && $.node(0).childCount === 1
    const tr = state.tr
    if (only) {
      tr.delete($.start(d), $.end(d))
    } else {
      tr.delete(Math.max(0, $.before(d)), Math.min(state.doc.content.size, $.after(d)))
      const pos = Math.min(Math.max(0, $.before(d)), tr.doc.content.size)
      tr.setSelection(TextSelection.near(tr.doc.resolve(pos)))
    }
    dispatch(tr.scrollIntoView())
    return true
  }
  return false
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
