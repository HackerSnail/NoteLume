// entry.js —— 网页版入口：先跑 bootstrap 铺好环境，再拉起桌面 main.js
//
// 顺序很关键：main.js 的 boot() 在 import 时就执行，并立刻读 settings（含 workspace 恢复）。
// 用顶层 await + 动态 import 保证 bootstrap（含沙盒首屏的 nl-settings 预置、语言上报）全部做完之后，
// 才把桌面入口引进来。生成的 web/index.html 里的 module script 指向的就是这里（不是 /main.js）。

import './web.css'
import { runBootstrap } from './bootstrap.js'

await runBootstrap()
await import('../main.js')
