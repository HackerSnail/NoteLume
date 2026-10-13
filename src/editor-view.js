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
import * as yaml from 'js-yaml'
import { saveImageFromFile, readImageDataUri } from './tauri-bridge.js'
import { highlightPlugin } from './hl-decorations.js'
import { mathInlineView, mathBlockView } from './math-nodeviews.js'
import { attachWikiHover } from './wiki-hover.js'
import { createSuggestPlugin } from './suggest-plugin.js'
import { tablePlugins, tableKeymap, attachTableContextMenu } from './table-editing.js'
import { mermaidPlugin } from './mermaid-preview.js'
import { attachCodeLangPicker } from './code-lang-picker.js'

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

  const keymapPlugin = keymap({
    'Mod-z': undo,
    'Mod-y': redo,
    'Shift-Mod-z': redo,
    'Mod-b': toggleMark(schema.marks.strong),
    'Mod-i': toggleMark(schema.marks.em),
    'Mod-`': toggleMark(schema.marks.code),
    'Mod-Shift-x': toggleMark(schema.marks.strike),
    'Shift-Enter': chainCommands(exitCode, (state, dispatch) => {
      dispatch(state.tr.replaceSelectionWith(schema.nodes.hard_break.create()).scrollIntoView())
      return true
    }),
    'Mod-m': insertMath('math_inline'),
    'Mod-Shift-m': insertMath('math_block'),
    Backspace: selectNodeBackward,
  })
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
      tableKeymap(),
      keymapPlugin,
      base,
      inputRulesPlugin,
      pasteImagesPlugin,
      highlightPlugin(),
      mermaidPlugin(),
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
        if (!dirty) {
          dirty = true
          opts.onDirty && opts.onDirty(true)
        }
        emitMeta(view, opts)
        opts.onDocChange && opts.onDocChange(next.doc, prevDoc)
      }
    },
  })

  // [[链接]] hover 悬浮预览（仅存在 vault 时才有意义，卡片自己判取 ctx）
  attachWikiHover(view.dom, () => opts.getVault())

  // 表格单元格右键：增删行列 / 对齐 / 切换表头 / 删表（复用 .cv-menu 样式）
  attachTableContextMenu(view)

  // 代码块右上角语言标签：点击弹可搜索语言列表（Typora 式，语言存围栏 info string 不入正文）
  attachCodeLangPicker(view)

  // 点击 [[链接]]：拦截跳转（链接节点 contenteditable=false）
  view.dom.addEventListener('click', (e) => {
    const wiki = e.target.closest('.nl-wiki')
    if (wiki) {
      e.preventDefault()
      opts.onOpenWiki && opts.onOpenWiki(wiki.getAttribute('data-target'))
      return
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

  return {
    view,
    setMarkdown(md) {
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
      return joinFrontmatter(fmRaw, serializeMarkdown(view.state.doc))
    },
    // frontmatter：读原始文本 + 解析后的对象；解析失败/非对象时降级为 {}（不抛，原文仍在 raw）
    getFrontmatter() {
      if (fmRaw == null) return { raw: null, data: {} }
      let data = {}
      try {
        const d = yaml.load(fmRaw)
        if (d && typeof d === 'object' && !Array.isArray(d)) data = d
      } catch (_) {
        data = {}
      }
      return { raw: fmRaw, data }
    },
    // 面板编辑后写回：raw=null 表示移除 frontmatter；置脏并触发自动保存与面板刷新
    setFrontmatter(raw) {
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
    jumpToPos(pos) {
      const tr = view.state.tr.setSelection(
        TextSelection.create(view.state.doc, Math.min(pos + 1, view.state.doc.content.size))
      )
      view.dispatch(tr.scrollIntoView())
      view.focus()
    },
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

function makeImageNodeView(getVault) {
  return (node) => {
    const img = document.createElement('img')
    const apply = (n) => {
      if (n.attrs.alt) img.setAttribute('alt', n.attrs.alt)
      else img.removeAttribute('alt')
      if (n.attrs.title) img.setAttribute('title', n.attrs.title)
      else img.removeAttribute('title')
      loadImgSrc(img, n.attrs.src, getVault)
    }
    apply(node)
    return {
      dom: img,
      ignoreMutation: () => true,
      update(next) {
        if (next.type.name !== 'image') return false
        apply(next)
        return true
      },
      selectNode() {
        img.classList.add('ProseMirror-selectednode')
      },
      deselectNode() {
        img.classList.remove('ProseMirror-selectednode')
      },
    }
  }
}

// 异步把 src 装到 img 上；用 img.__key 防止 update 竞态下旧请求覆盖新图
function loadImgSrc(img, src, getVault) {
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
      if (img.__key === key) {
        img.removeAttribute('src')
        img.classList.add('nl-img-missing')
      }
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
