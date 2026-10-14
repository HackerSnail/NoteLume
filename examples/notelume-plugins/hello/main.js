// NoteLume 示例插件 —— main.js
// 用法：把整个 hello/ 文件夹（manifest.json + main.js）放进你的知识库根目录下的
// .notelume-plugins/，重新打开知识库（或点侧栏「🔌 插件」的 ↻ 重新加载）即生效。
// 首次加载会弹出「插件权限同意」——本示例 permissions 为空，仅需编辑器基线能力。
//
// 契约：export default 一个 NoteLumePlugin 对象（或返回该对象的工厂函数）。
// 清单字段与权限词表见 manifest.json 与 README 插件段。

export default {
  id: 'hello',
  name: 'Hello 示例插件',

  // 编辑器装配前调用：在这里注册快捷键 / 命令 / 输入规则
  onInit(ctx) {
    // 快捷键：Mod-Shift-H 弹出提示（Mod = Ctrl / ⌘）
    ctx.registerKeymap('Mod-Shift-h', () => {
      const { state } = ctx
      ctx.setStatus('Hello from 插件！当前文档字符数：' + state.doc.content.size)
      window.alert('👋 Hello from NoteLume 插件')
      return true // 已处理，阻止后续键位
    })

    // 命令：会显示在侧栏「🔌 插件」面板里，可点击执行
    ctx.registerCommand('插入当前时间', (c) => {
      const { state, dispatch } = c
      const text = new Date().toLocaleString()
      dispatch(state.tr.insertText(text, state.selection.from).scrollIntoView())
    })
  },

  // 编辑器就绪（可拿到 view / schema 做更复杂的交互）
  onEditorReady(view, schema) {
    console.log('[hello] 编辑器就绪，节点类型：', Object.keys(schema.nodes))
  },

  // 文档每次变更（可用于统计、校验等）
  onDocChange(doc, prevDoc) {
    // 例：字数变化时打印
    // console.log('[hello] 字数', prevDoc.content.size, '->', doc.content.size)
  },

  // 打开文件时
  onFileOpen(path, content) {
    console.log('[hello] 打开文件：' + path + '（' + content.length + ' 字）')
  },

  // 保存后
  onSave(path, content) {
    console.log('[hello] 已保存：' + path)
  },

  // 也可以用声明式写法（等价于在 onInit 里逐个注册）：
  // commands: { '示例命令': (ctx) => { ... } },
  // keymap:   { 'Mod-Shift-g': () => { ...; return true } },
}
