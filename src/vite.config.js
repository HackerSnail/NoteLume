import { defineConfig } from 'vite'

// 固定端口，Tauri devUrl 依赖它；清楚终端由 Tauri 管理
const host = process.env.TAURI_DEV_HOST

export default defineConfig({
  // 明确不清屏，便于 Tauri 读取 vite 输出
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: 'ws', host, port: 1421 } : undefined,
    watch: { ignored: ['**/src-tauri/**'] },
  },
  build: {
    target: 'es2022',
    outDir: 'dist',
    emptyOutDir: true,
  },
})
