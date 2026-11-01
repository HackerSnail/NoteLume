// spike-windowed.js —— DOM 层 spike 的驱动页（vite dev 下访问 /spike-windowed.html）
import 'prosemirror-view/style/prosemirror.css'
import { createWindowedEditor } from './windowed-editor.js'

// 造一篇大文档：3 万段 + 每 100 段一个代码块，逼出「整篇铺 DOM」与窗口化的对比
function bigMd(n) {
  let s = ''
  for (let i = 0; i < n; i++) {
    s += `段落 ${i}：这是一行用于占位的中文正文内容，包含一些文字。\n\n`
    if (i % 100 === 0) s += '```js\nconsole.log(' + i + ')\nvar a = ' + i + '\n```\n\n'
  }
  return s
}

const bar = document.getElementById('bar')
const t0 = performance.now()
const md = bigMd(8000)
const bootParse = performance.now()

const spike = createWindowedEditor({
  mountEl: document.getElementById('mount'),
  scroller: document.getElementById('scroller'),
  mdText: md,
  overscan: 8,
  onDebug: (d) => {
    bar.textContent =
      `blocks=${d.blocks} | window=[${d.window[0]}..${d.window[1]}] | DOM块=${d.domBlocks} | ` +
      `scrollTop=${d.scrollTop} | 总高=${d.total} | 载入解析=${Math.round(bootParse - t0)}ms`
  },
})
window.__spike = spike // 供 devtools 手动驱动
spike.focus()
