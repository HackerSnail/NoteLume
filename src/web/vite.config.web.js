import { defineConfig } from 'vite'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// vite.config.web.js —— 网页版的独立构建配置，不动桌面 src/vite.config.js（§2 决策 1 / §11）。
//
// 关键：resolve.alias 把桌面代码里那五个裸包名指到 src/web/ 的替身，于是 tauri-bridge.js、
// main.js、titlebar.js 连同其余 60 多个模块原样进产物，一行不用改。alias 只在网页构建里生效，
// 桌面构建走的是另一份配置，互不影响。
//
// root 固定成 src（命令从仓库根跑，默认 root 会是仓库根，必须显式指回 src）；
// 入口是生成的 web/index.html；产物落到 server/dist，base 用相对路径方便任意前缀部署。

const HERE = path.dirname(fileURLToPath(import.meta.url)) // …/src/web
const SRC = path.resolve(HERE, '..') // …/src
const w = (f) => path.resolve(HERE, f)

export default defineConfig({
  root: SRC,
  base: './',
  clearScreen: false,
  resolve: {
    alias: [
      { find: '@tauri-apps/api/core', replacement: w('tauri-core.js') },
      { find: '@tauri-apps/api/window', replacement: w('tauri-window.js') },
      { find: '@tauri-apps/api/event', replacement: w('tauri-event.js') },
      { find: '@tauri-apps/api/path', replacement: w('tauri-path.js') },
      { find: '@tauri-apps/plugin-dialog', replacement: w('tauri-dialog.js') },
    ],
  },
  build: {
    target: 'es2022',
    outDir: path.resolve(SRC, '..', 'server', 'dist'),
    emptyOutDir: true,
    rollupOptions: {
      input: path.resolve(HERE, 'index.html'),
    },
  },
  server: {
    port: 1420,
    strictPort: false,
    // dev 时 API 打到并行的 web:api（1430），静态与 HMR 交给 vite
    proxy: {
      '/api': 'http://127.0.0.1:1430',
    },
    watch: { ignored: ['**/src-tauri/**'] },
  },
})
