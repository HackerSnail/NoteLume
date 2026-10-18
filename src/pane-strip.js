// pane-strip.js —— 窗格标签条（完整分栏模式，spec 2026-10-18-pane-tab-groups）
//
// 每个叶子窗格（.nl-pane）顶部一条：左边是标签滚动区（tabs.js 的每窗格实例），
// 右边是拆分（横 / 竖）与关窗格按钮。sticky 钉在窗格滚动内容上方，不把 .nl-pane
// 从滚动容器改成嵌套滚动——editor-view 的滚动计算、查找栏的定位都建立在
// 「.nl-pane 即滚动容器」上。
//
// 标签的打开 / 切换 / 关闭语义在 main.js（openDocInPane / closeTab），本模块只负责
// DOM 与按钮派发，纯 DOM 逻辑可在 Node + jsdom 下单测。

import { createTabs } from './tabs.js'
import { setIcon } from './icons.js'
import { t } from './i18n.js'

/**
 * 在叶子的最前面插入标签条并挂上该窗格的 tabs 实例。
 * @param {object} opts
 * @param {string} opts.paneId 窗格 id（进标签 id，同文档可多窗格同开）
 * @param {HTMLElement} opts.leaf 叶子元素（.nl-pane）
 * @param {(tabId:string) => void} opts.onSwitch 点标签（切到该文档）
 * @param {(tabId:string) => void} opts.onClose 关标签（× / 中键）
 * @param {('horizontal'|'vertical') => void} opts.onSplit 拆分按钮
 * @param {() => void} opts.onClosePane 关窗格按钮
 * @returns {{el:HTMLElement, tabs:object, setMulti:(on:boolean)=>void}}
 */
export function createPaneStrip({ paneId, leaf, onSwitch, onClose, onSplit, onClosePane }) {
  const strip = document.createElement('div')
  strip.className = 'nl-pane-strip hidden'
  strip.dataset.paneId = paneId

  const scroll = document.createElement('div')
  scroll.className = 'nl-pane-strip-scroll'

  const btns = document.createElement('div')
  btns.className = 'nl-pane-strip-btns'
  const mk = (icon, key, cls, fn) => {
    const b = document.createElement('button')
    b.type = 'button'
    b.className = 'nl-split-btn' + (cls ? ' ' + cls : '')
    b.title = t(key)
    b.setAttribute('aria-label', t(key))
    setIcon(b, icon)
    b.addEventListener('click', fn)
    return b
  }
  const closeBtn = mk('close', 'pn.closeTip', 'nl-strip-close hidden', (e) => {
    e.stopPropagation() // 别先触发窗格焦点切换（紧接着就关掉了，切了也白切）
    onClosePane()
  })
  btns.append(
    mk('dist-h', 'pn.splitH', '', () => onSplit('horizontal')),
    mk('dist-v', 'pn.splitV', '', () => onSplit('vertical')),
    closeBtn,
  )
  strip.append(scroll, btns)
  // 条子必须是叶子第一个孩子：sticky 才钉在滚动区最上方（pane-body 在后面）
  leaf.insertBefore(strip, leaf.firstChild)

  const tabs = createTabs({ paneId, mountEl: scroll, onSwitch, onClose })
  return {
    el: strip,
    tabs,
    /** 多窗格才显示关窗格按钮（单窗格时没得关） */
    setMulti(on) {
      closeBtn.classList.toggle('hidden', !on)
    },
  }
}
