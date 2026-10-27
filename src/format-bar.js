// format-bar.js —— 每个窗格一条的内联格式按钮条
//
// 给不熟悉 Markdown 语法的人：粗体 / 斜体 / 删除线 / 行内代码 / 链接 / 图片六个常用
// 语法做成常驻按钮，挂在窗格标签条下方、紧贴正文（sticky，随窗格滚动钉在顶部）。
// 动作全部转给已有命令，不新增编辑器命令；标题带当前绑定的键位，改过键也显示对的。
//
//  · 按钮统一 mousedown + preventDefault：点下去不抢编辑器的 DOM 选区，否则一碰选区就散（同 highlight-toolbar.js）。
//  · 定位容器是叶子窗格 .nl-pane（滚动容器），与标签条同一 sticky 上下文；
//    有文档时标签条必然可见，故按钮条钉在标签条下沿（见 style.css 的 top）。
//  · 显隐与按下态由调用方 sync() 喂：本模块不读编辑器状态。

import { setIcon } from './icons.js'
import { t } from './i18n.js'

const ITEMS = [
  { cmd: 'editor.bold', mark: 'strong', glyph: 'B', cls: 'nl-fmt-glyph-b' },
  { cmd: 'editor.italic', mark: 'em', glyph: 'I', cls: 'nl-fmt-glyph-i' },
  { cmd: 'editor.strike', mark: 'strike', glyph: 'S', cls: 'nl-fmt-glyph-s' },
  { cmd: 'editor.code', mark: 'code', icon: 'code' },
  { cmd: 'editor.link', mark: 'link', icon: 'link' },
  // 图片是应用级入口（选文件 + 落库），不走编辑器命令
  { cmd: null, icon: 'image', titleKey: 'cmd.app.insertImage', bindId: 'app.insertImage' },
]

/**
 * @param {object} deps
 * @param {HTMLElement} deps.paneEl 叶子窗格（.nl-pane）
 * @param {(cmd:string) => void} deps.runCommand 执行一条编辑器命令
 * @param {() => void} deps.pickImages 插入图片
 * @param {(id:string) => string|null} [deps.bindingFor] 命令当前键位串（进标题提示）
 * @returns {{el:HTMLElement, sync:(active:Set<string>, visible:boolean) => void}}
 */
export function createFormatBar({ paneEl, runCommand, pickImages, bindingFor }) {
  const bar = document.createElement('div')
  bar.className = 'nl-fmt-bar hidden'
  const btns = ITEMS.map((item) => {
    const b = document.createElement('button')
    b.type = 'button'
    b.className = 'nl-fmt-btn' + (item.cls ? ' ' + item.cls : '')
    if (item.glyph) b.textContent = item.glyph
    else setIcon(b, item.icon)
    b.dataset.mark = item.mark || ''
    b.addEventListener('mousedown', (e) => e.preventDefault())
    b.addEventListener('click', () => {
      if (item.cmd) runCommand(item.cmd)
      else pickImages()
    })
    bar.appendChild(b)
    return { item, el: b }
  })
  // 紧跟标签条之后：sticky 的 top 靠「标签条 + 按钮条」相邻这条 CSS 兄弟规则算偏移，
  // 顺序错了会掉到正文下方
  const strip = paneEl.querySelector(':scope > .nl-pane-strip')
  paneEl.insertBefore(bar, strip ? strip.nextSibling : paneEl.firstChild)
  return {
    el: bar,
    sync(active, visible) {
      bar.classList.toggle('hidden', !visible)
      if (!visible) return
      for (const { item, el } of btns) {
        el.classList.toggle('active', !!item.mark && active.has(item.mark))
        const key = item.titleKey || 'cmd.' + item.cmd
        const bind = bindingFor && bindingFor(item.bindId || item.cmd)
        el.title = bind ? `${t(key)} (${bind})` : t(key)
      }
    },
  }
}
