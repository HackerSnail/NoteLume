// gen-web-html.mjs —— 构建期从 src/index.html 生成 src/web/index.html（web:build 的第一步）
//
// 只改两处，其余（sprite、挂载点、工具条标记）逐字节照搬：
//   1. <html ...> 加一个 data-web 属性：src/web/web.css 据此只藏不删地屏蔽桌面专属 DOM（§2 决策 6）。
//   2. 入口 <script type="module" src="/main.js"> 换成 /web/entry.js（替身装配 + 引导）。
//
// 为什么生成而不是手写副本：桌面版以后改 index.html（加按钮、改 id）时，网页版重新生成即可跟上，
// 不会错开。生成物 src/web/index.html 进 .gitignore。

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO = path.resolve(HERE, '..')
const SRC = path.join(REPO, 'src', 'index.html')
const OUT_DIR = path.join(REPO, 'src', 'web')
const OUT = path.join(OUT_DIR, 'index.html')

let html = fs.readFileSync(SRC, 'utf8')
const before = html

// 1) <html ...> 加 data-web（已有则不重复）
html = html.replace(/<html\b([^>]*)>/i, (m, attrs) => (/\bdata-web\b/.test(attrs) ? m : `<html${attrs} data-web>`))

// 2) 入口脚本：桌面 /main.js -> 网页 /web/entry.js
let swapped = false
html = html.replace(/<script\b[^>]*\bsrc\s*=\s*["']\/main\.js["'][^>]*><\/script>/i, () => {
  swapped = true
  return '<script type="module" src="/web/entry.js"></script>'
})

if (html === before) {
  console.error('[gen-web-html] 未改动任何内容，可能 src/index.html 结构与预期不符')
  process.exit(1)
}
if (!swapped) {
  console.error('[gen-web-html] 没找到入口 <script src="/main.js">，请核对 src/index.html')
  process.exit(1)
}

fs.mkdirSync(OUT_DIR, { recursive: true })
fs.writeFileSync(OUT, html, 'utf8')
console.log(`[gen-web-html] 已生成 ${path.relative(REPO, OUT).replace(/\\/g, '/')}`)
