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
