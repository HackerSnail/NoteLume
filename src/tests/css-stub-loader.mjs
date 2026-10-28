// tests/css-stub-loader.mjs —— 把 `.css` 导入解析成空模块
// 编辑器链路上有 katex 之类的 CSS 导入，浏览器构建由 vite 处理，node 直跑测试要挡掉（样式本身不在断言范围）。
export async function resolve(specifier, ctx, next) {
  if (specifier.endsWith('.css')) return { url: 'data:text/javascript,export default {}', shortCircuit: true }
  return next(specifier, ctx)
}
