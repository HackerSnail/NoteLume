// slides-assets.js —— reveal.js 内联资源（vite ?raw 读源文本，导出时拼进单文件产物）
//
// 消费方：main.js 把 slidesAssets 传给 slides-export.js 的 buildSlidesHtml。
// 注意两点：
//  1. dist 里没有 .min 文件（v5 直接发布可读的 reveal.js），体积 ~110KB 可接受。
//  2. 主题 css 自带 @import url(./fonts/...)，内联后相对路径失效，构建期剥掉，
//     字体由 slides-export.js 的片内排印样式回退到系统字体栈。
import revealJs from 'reveal.js/dist/reveal.js?raw'
import revealCss from 'reveal.js/dist/reveal.css?raw'
import themeCssRaw from 'reveal.js/dist/theme/black.css?raw'
import notesJs from 'reveal.js/plugin/notes/notes.js?raw'

const themeCss = themeCssRaw.replace(/@import url\(\.\/fonts\/[^)]*\);?\s*/g, '')

export const slidesAssets = { revealJs, revealCss, themeCss, notesJs }
