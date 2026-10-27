// scenarios.mjs —— 网页版演示脚本：每个场景一段真实操作，交给 shoot.mjs 逐帧抓取
//
// 约定：只用真实输入事件（键盘 / 鼠标点击），不改 DOM、不直接调内部函数——抓到的画面
// 必须是用户手点出来的效果。选择器取自 src/index.html 与 main.js 的固定 class。

const TREE = '.tree-file'
const PM = '.ProseMirror'

/** 点文件树里名字含 text 的那一行 */
const openDoc = (ctx, text) => ctx.clickText(TREE, text)

/** 光标落到正文末尾（空白页时正文可能只有一个空段落） */
async function focusEnd(ctx) {
  await ctx.click(PM)
  await ctx.js(() => {
    const pm = document.querySelector('.ProseMirror')
    const last = pm.lastElementChild || pm
    const range = document.createRange()
    range.selectNodeContents(last)
    range.collapse(false)
    const sel = getSelection()
    sel.removeAllRanges()
    sel.addRange(range)
  })
  await ctx.wait(200)
}

/** 逐字输入并停顿：让「边打边变富文本」在 GIF 里看得见 */
async function typeLines(ctx, lines) {
  for (const line of lines) {
    await ctx.type(line)
    await ctx.wait(320)
  }
}

/** 滚到某个标题：按它在窗格里的真实位置算 scrollTop，避免写死像素 */
async function scrollToHeading(ctx, text) {
  const y = await ctx.js((t) => {
    const pane = document.querySelector('.nl-pane')
    const el = [...document.querySelectorAll('.ProseMirror h1, .ProseMirror h2, .ProseMirror h3')]
      .find((e) => e.textContent.trim() === t)
    if (!el || !pane) return null
    return Math.max(0, Math.round(pane.scrollTop + el.getBoundingClientRect().top - pane.getBoundingClientRect().top - 60))
  }, text)
  if (y != null) await ctx.scroll('.nl-pane', y, 700)
}

/** 等某个条件成立（库索引、面板渲染这类异步态），到点没成就直接报错，别录半截画面 */
async function until(ctx, fn, ms = 12000, what = '条件') {
  const ok = await ctx.js(async ([src, budget]) => {
    const test = new Function(`return (${src})()`)
    const end = performance.now() + budget
    while (performance.now() < end) {
      if (test()) return true
      await new Promise((r) => setTimeout(r, 120))
    }
    return false
  }, [String(fn), ms])
  if (!ok) throw new Error(`等待超时：${what}`)
}

/** 中英文案都能点中：菜单文案会随界面语言变，写死一种就录不动 */
async function clickMatch(ctx, sel, src) {
  const p = await ctx.js(([s, r]) => {
    const e = [...document.querySelectorAll(s)].find((x) => new RegExp(r).test(x.textContent.trim()))
    if (!e) return null
    e.scrollIntoView({ block: 'center', behavior: 'instant' })
    const b = e.getBoundingClientRect()
    return b.width ? { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) } : null
  }, [sel, src])
  if (!p) throw new Error(`未找到 ${sel} 匹配「${src}」`)
  await ctx.wait(200)
  await ctx.clickPoint(p)
}


/** 右侧检查器栏：已经展开就别再点（点一下会收掉） */
async function openInspector(ctx) {
  await ctx.js(() => {
    const ins = document.querySelector('#inspector')
    if (ins && !ins.classList.contains('hidden')) return
    document.querySelector('#btn-inspector').click()
  })
  await ctx.wait(700)
}


export const scenarios = {
  // 所写即所得：Markdown 语法落定即变富文本（标题走快捷键，其余靠输入规则）
  'wysiwyg-typing': async (ctx) => {
    await openDoc(ctx, '空白页')
    await focusEnd(ctx)
    await typeLines(ctx, ['本周复盘'])
    await ctx.press('Meta+1')
    await ctx.press('Enter')
    await typeLines(ctx, [
      '把 Markdown 原样敲进来，落定就渲染：\n',
      '**重点** 与 *强调* 在收尾的星号落定时换掉；\n',
      '#project 后面跟一个空格，标签自动收成芯片；\n',
      '公式 $E=mc^2$ 与双链 [[wiki-links]] 同样即时渲染。\n',
    ])
    await ctx.wait(700)
  },

  // 双链补全：敲 [[ 出候选，过滤后回车插入
  'wikilink-suggest': async (ctx) => {
    await openDoc(ctx, '空白页')
    await focusEnd(ctx)
    await typeLines(ctx, ['今天想记的'])
    await ctx.press('Meta+2')
    await ctx.press('Enter')
    await ctx.type('相关的笔记：')
    await ctx.type('[[')
    await ctx.wait(600)
    await ctx.type('wiki')
    await ctx.wait(900)
    await ctx.press('Enter')
    await ctx.wait(600)
  },

  // 命令面板：裸词搜文档，'>' 前缀搜命令
  'command-palette': async (ctx) => {
    await ctx.js(() => document.body.click())
    await ctx.press('Meta+Shift+p')
    await ctx.wait(600)
    await ctx.type('code')
    await ctx.wait(900)
    for (let i = 0; i < 4; i++) await ctx.press('Backspace')
    await ctx.type('>源码')
    await ctx.wait(900)
    await ctx.press('Enter')
    await ctx.wait(1400)
  },

  // 正文 ↔ 源码整篇互切
  'source-toggle': async (ctx) => {
    await openDoc(ctx, 'tables-tasks')
    await ctx.wait(700)
    await ctx.press('Meta+e')
    await ctx.wait(900)
    await ctx.type('\n\n## 源码态里直接补一段\n\n- 打字就是 Markdown 原文\n')
    await ctx.wait(500)
    await ctx.press('Meta+e')
    await ctx.wait(1200)
  },

  // 四态主题轮换：浅色 → 暗黑 → 吸血鬼 → 跟随系统
  'theme-switch': async (ctx) => {
    await openDoc(ctx, 'code-math')
    await ctx.wait(600)
    for (let i = 0; i < 4; i++) {
      await ctx.click('#btn-theme')
      await ctx.wait(1100)
    }
  },

  // 富渲染巡览：代码高亮 → 块级公式 → Mermaid → 表格
  'rich-render': async (ctx) => {
    await openDoc(ctx, 'code-math')
    await ctx.wait(700)
    for (const h of ['带子语言的高亮', '数学', '图示']) {
      await scrollToHeading(ctx, h)
      await ctx.wait(700)
    }
    await openDoc(ctx, 'tables-tasks')
    await ctx.wait(700)
    await scrollToHeading(ctx, '表格')
    await ctx.wait(900)
  },

  // 分栏 + 标签
  'split-panes': async (ctx) => {
    await ctx.click('.nl-pane-strip-btns .nl-split-btn')
    await ctx.wait(900)
    await openDoc(ctx, 'wiki-links')
    await ctx.wait(900)
    await ctx.scroll('.nl-pane:last-of-type', 700, 1500)
    await ctx.wait(600)
    await ctx.clickText('.nl-pane:first-child .tab', 'home')
    await ctx.wait(900)
  },

  // 大纲层级折叠：逐节收起小标题，再用档位条一键收到只剩大标题
  'outline-fold': async (ctx) => {
    await openDoc(ctx, '空白页')
    await focusEnd(ctx)
    for (const [key, text] of [
      ['Meta+1', '产品周报'],
      ['Meta+2', '三月'],
      ['Meta+3', '上线'],
      ['Meta+3', '风险'],
      ['Meta+2', '二月'],
      ['Meta+3', '上线'],
    ]) {
      await ctx.press(key)
      await ctx.type(text)
      await ctx.press('Enter')
    }
    // 没有标题时大纲 tab 会被 syncOutlineTab 藏掉，所以先打字再切过去
    await ctx.click('.side-tab[data-tab="outline"]')
    await ctx.wait(1000)
    await clickOutlineCaret(ctx, '三月')
    await ctx.wait(1200)
    await clickOutlineCaret(ctx, '二月')
    await ctx.wait(1400)
    await ctx.click('.outline-toolbar button[data-mode="1"]')
    await ctx.wait(1400)
    await ctx.click('.outline-toolbar button[data-mode="1"]')
    await ctx.wait(900)
  },

  // 视图模式：专注模式只点亮当前块，打字机模式把当前块顶到视口中间
  'view-modes': async (ctx) => {
    await openDoc(ctx, 'tables-tasks')
    await ctx.wait(700)
    await focusEnd(ctx)
    await ctx.press('Meta+Shift+`')
    await until(ctx, () => document.querySelector('.ProseMirror').classList.contains('nl-focus'), 6000, '专注模式')
    for (let i = 0; i < 3; i++) {
      await ctx.type('这一行写在专注模式下\n')
    }
    await ctx.wait(900)
    await ctx.press('Meta+Shift+t')
    for (let i = 0; i < 3; i++) {
      await ctx.type('打字机模式跟着光标走\n')
    }
    await ctx.wait(1200)
  },

  // 今日速记：全局浮层，独立于当前知识库，写完自动落到速记目录
  'daily-capture': async (ctx) => {
    // 没设过速记目录时，点「今日」会先走一次系统确认框（网页版把 dialogConfirm 退化成
    // window.confirm，会阻塞 CDP 输入）。这里只补环境：把速记目录预置成当前库根，
    // 界面操作本身照旧。
    await ctx.js(() => {
      if (localStorage.getItem('nl-daily-abs')) return
      const s = JSON.parse(localStorage.getItem('nl-settings') || '{}')
      if (s.workspace && s.workspace.lastVault) localStorage.setItem('nl-daily-abs', s.workspace.lastVault)
    })
    await ctx.click('#btn-daily')
    await until(ctx, () => {
      const o = document.querySelector('.nl-daily-overlay')
      return o && !o.classList.contains('hidden')
    }, 8000, '今日速记浮层')
    await ctx.wait(600)
    await ctx.click('.nl-daily-ta')
    await ctx.type('早上：过一遍 [[wiki-links]] 那篇的用法\n')
    await ctx.type('下午：给团队写完规范 #能力/表格\n')
    await ctx.type('晚上：周报草稿，引用 [[code-math]] 里的图\n')
    await ctx.wait(1200)
    await ctx.press('Escape')
    await ctx.wait(600)
  },

  // 斜杠菜单：块类型、模板与 Quarkdown 片段都在一处即插即用
  'slash-menu': async (ctx) => {
    await openDoc(ctx, '空白页')
    await focusEnd(ctx)
    await ctx.press('Meta+2')
    await ctx.type('斜杠菜单')
    await ctx.press('Enter')
    await ctx.type('/')
    await until(ctx, () => document.querySelectorAll('.nl-suggest-item').length > 0, 8000, '斜杠菜单')
    await ctx.wait(700)
    await ctx.type('提示')
    await ctx.wait(900)
    await ctx.press('Enter')
    await ctx.wait(700)
    await ctx.type('这一条是用 / 插出来的 callout。')
    await ctx.wait(900)
    await ctx.press('Enter')
    await ctx.press('Enter')
    await ctx.type('/')
    await ctx.wait(600)
    await ctx.type('表格')
    await ctx.wait(900)
    await ctx.press('Enter')
    await ctx.wait(1400)
  },

  // 界面语言：菜单里换一种，整套界面（含菜单 / 面板 / 提示）当场翻过去
  'language-switch': async (ctx) => {
    await openDoc(ctx, 'home')
    await ctx.wait(800)
    await ctx.click('#btn-more')
    await until(ctx, () => [...document.querySelectorAll('.cv-menu-item')].some((e) => /语言|Language/.test(e.textContent)), 6000, '语言子菜单')
    await ctx.clickText('.cv-menu-item', '界面语言')
    await ctx.wait(500)
    await until(ctx, () => [...document.querySelectorAll('.cv-menu-item')].some((e) => /English/.test(e.textContent)), 6000, '语言列表')
    await ctx.clickText('.cv-menu-item', 'English')
    await ctx.wait(1600)
    await ctx.click('#btn-more')
    await ctx.wait(700)
    await ctx.press('Escape')
    await ctx.wait(900)
  },

  // 正文图片拖拽缩放：拖右下角把手改宽度，写回的是 md 里的尺寸，图本身不动
  'image-resize': async (ctx) => {
    await openDoc(ctx, 'home')
    await until(ctx, () => document.querySelectorAll('.nl-img-host img').length > 0, 15000, '正文图片')
    // 把手在图片右下角，图片不在视口内时点不到（boundingBox 是视口坐标）
    await ctx.js(() => document.querySelector('.nl-img-host').scrollIntoView({ block: 'center' }))
    await ctx.wait(600)
    const w0 = await ctx.js(() => Math.round(document.querySelector('.nl-img-host img').getBoundingClientRect().width))
    const p = await ctx.js(() => {
      const b = document.querySelector('.nl-img-grip').getBoundingClientRect()
      return { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) }
    })
    await ctx.drag(p, { x: p.x - 150, y: p.y })
    await ctx.wait(900)
    const w1 = await ctx.js(() => Math.round(document.querySelector('.nl-img-host img').getBoundingClientRect().width))
    if (!(w1 < w0 - 20)) throw new Error(`拖拽后宽度没变（${w0} → ${w1}）`)
    await ctx.js(() => document.querySelector('.ProseMirror h1').click())
    await ctx.wait(700)
  },

  // 白板画布：库里的 .canvas 文件直接开成画板，便签与连线可拖
  'canvas-board': async (ctx) => {
    await ctx.clickText('.tree-file', 'roadmap')
    await until(ctx, () => !!document.querySelector('.cv-node, .nl-canvas-node'), 12000, '画布节点')
    await ctx.wait(900)
    const p = await ctx.js(() => {
      const n = document.querySelector('.cv-node, .nl-canvas-node')
      const b = n.getBoundingClientRect()
      return { x: b.x + b.width / 2, y: b.y + 18 }
    })
    await ctx.drag(p, { x: p.x + 120, y: p.y + 90 })
    await ctx.wait(1200)
  },

  // 检查器栏：frontmatter 文档属性 + 本文档标签，右侧一栏看全一篇的元信息
  'inspector-panel': async (ctx) => {
    await openDoc(ctx, 'tags-frontmatter')
    await until(ctx, () => document.querySelectorAll('.tree-file').length > 3, 15000, '文件树渲染')
    await openInspector(ctx)
    await until(ctx, () => (document.querySelector('#frontmatter') || {}).textContent?.includes('title'), 12000, '文档属性面板')
    await ctx.wait(1000)
    await ctx.click('#inspector details:nth-of-type(2) summary')
    await ctx.wait(1200)
  },

  // 图表就地编辑：单击 Mermaid 图把光标送进图源码，源码就地可见
  'mermaid-edit': async (ctx) => {
    await openDoc(ctx, 'code-math')
    await until(ctx, () => document.querySelectorAll('.nl-mermaid svg').length > 0, 25000, 'Mermaid 渲染')
    await ctx.click('.nl-mermaid svg')
    await until(ctx, () => {
      const pre = [...document.querySelectorAll('.ProseMirror pre')].find((e) => /graph|flowchart|sequenceDiagram/i.test(e.textContent))
      return !!(pre && pre.getBoundingClientRect().width > 0)
    }, 8000, '图源码就地可见')
    await ctx.wait(1600)
    await ctx.js(() => document.querySelector('.ProseMirror h1').click())
    await ctx.wait(1400)
  },

  // 外观设置：主题色板 + 字号 / 行距 / 正文宽度，右侧实时预览
  'appearance-settings': async (ctx) => {
    await ctx.click('#btn-more')
    await until(ctx, () => [...document.querySelectorAll('.cv-menu-item')].some((e) => /外观|Appearance/.test(e.textContent)), 6000, '更多菜单')
    await ctx.clickText('.cv-menu-item', '外观')
    await until(ctx, () => !!document.querySelector('.nl-ap-head'), 8000, '外观设置面板')
    await ctx.wait(900)
    await ctx.click('.nl-ap-theme:nth-child(2)')
    await ctx.wait(1100)
    await ctx.click('.nl-ap-theme:nth-child(3)')
    await ctx.wait(1100)
    await ctx.click('.nl-ap-theme:nth-child(1)')
    await ctx.wait(900)
    await ctx.press('Escape')
    await ctx.wait(600)
  },

  // 快捷键设置：全部键位可重绑，冲突当场拦下
  'shortcuts-settings': async (ctx) => {
    await ctx.click('#btn-more')
    await until(ctx, () => [...document.querySelectorAll('.cv-menu-item')].some((e) => /快捷键|Keyboard/.test(e.textContent)), 6000, '更多菜单')
    await ctx.clickText('.cv-menu-item', '快捷键')
    await until(ctx, () => document.querySelectorAll('.nl-ks-row').length > 5, 8000, '快捷键列表')
    await ctx.wait(1000)
    await ctx.scroll('.nl-ks-list, .nl-dialog-body, .nl-ks-body', 260, 900)
    await ctx.wait(900)
    await ctx.press('Escape')
    await ctx.wait(600)
  },

  // Word 导入：选 .docx → 左预览右源码的校对窗（降级项列清）→ 接受才落库
  'docx-import': async (ctx) => {
    await ctx.click('#btn-more')
    await until(ctx, () => [...document.querySelectorAll('.cv-menu-item')].some((e) => /导入 Word|Import Word/.test(e.textContent)), 6000, '更多菜单')
    await ctx.clickText('.cv-menu-item', '导入 Word')
    await until(ctx, () => document.querySelectorAll('.nl-picker-root').length > 0, 8000, '文件选择窗')
    await ctx.wait(600)
    // 选择窗开出来就停在会话库根（file 模式下由 /api/browse 的 vault 提示定位），演示文件即在根上
    await until(ctx, () => [...document.querySelectorAll('.nl-picker-file')].some((e) => e.textContent.includes('示例文档')), 12000, '库里的 .docx')
    await ctx.clickText('.nl-picker-file', '示例文档')
    await ctx.wait(600)
    await ctx.clickText('.nl-picker .nl-prompt-btn', '确定')
    await until(ctx, () => !!document.querySelector('.nl-docx-overlay'), 25000, '导入校对窗')
    await ctx.wait(1400)
    await ctx.clickText('.nl-docx-btn', '接受')
    await until(ctx, () => !!document.querySelector('.ProseMirror h1') && /导入示例/.test(document.querySelector('.ProseMirror').textContent), 15000, '导入后自动打开的文档')
    await ctx.wait(1800)
  },

  // 表格编辑：Tab 逐格跳转，右键就地插行、插列
  'table-edit': async (ctx) => {
    await openDoc(ctx, 'tables-tasks')
    await until(ctx, () => document.querySelectorAll('.ProseMirror table td').length > 4, 12000, '正文表格')
    const before = await ctx.js(() => ({
      rows: document.querySelectorAll('.ProseMirror table tr').length,
      cols: document.querySelectorAll('.ProseMirror table th').length,
    }))
    await ctx.click('.ProseMirror table td')
    for (let i = 0; i < 3; i++) {
      await ctx.press('Tab')
      await ctx.wait(460)
    }
    await ctx.rightClick('.ProseMirror table td')
    await until(ctx, () => !!document.querySelector('.table-menu'), 6000, '表格右键菜单')
    await ctx.wait(600)
    await clickMatch(ctx, '.table-menu .cv-menu-item', '下方插入行|Insert Row Below')
    await ctx.wait(900)
    await ctx.rightClick('.ProseMirror table td')
    await until(ctx, () => !!document.querySelector('.table-menu'), 6000, '表格右键菜单')
    await clickMatch(ctx, '.table-menu .cv-menu-item', '右侧插入列|Insert Column Right')
    await ctx.wait(1100)
    const after = await ctx.js(() => ({
      rows: document.querySelectorAll('.ProseMirror table tr').length,
      cols: document.querySelectorAll('.ProseMirror table th').length,
    }))
    if (!(after.rows > before.rows && after.cols > before.cols)) {
      throw new Error(`插行/插列没生效（${before.rows}×${before.cols} → ${after.rows}×${after.cols}）`)
    }
    await ctx.wait(900)
  },
}

/** 点某条大纲行左侧的伸缩箭头：按标题文字找行，箭头本身没有可用选择器 */
async function clickOutlineCaret(ctx, text) {
  const p = await ctx.js((t) => {
    const row = [...document.querySelectorAll('.outline-row')].find(
      (r) => (r.querySelector('.outline-item') || {}).textContent?.trim() === t,
    )
    const caret = row && row.querySelector('button.outline-caret')
    if (!caret) return null
    const b = caret.getBoundingClientRect()
    if (!b.width) return null // 侧栏还停在「文件」tab：整棵大纲是隐藏的，别去点一个零尺寸的框
    return { x: Math.round(b.x + b.width / 2), y: Math.round(b.y + b.height / 2) }
  }, text)
  if (!p) throw new Error(`大纲里没有可折叠的「${text}」`)
  await ctx.clickPoint(p)
}
