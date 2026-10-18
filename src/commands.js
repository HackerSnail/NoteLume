// commands.js —— 批次 D：统一命令注册表（纯容器，无 DOM / 无具体处理器）
//
// 单一事实源：命令面板、快捷键设置、插件 registerCommand 三者都读写这里。
// 命令记录形状：
//   { id, title, category:'app'|'editor'|'plugin', defaultKey?:string,
//     run(ctx), when?:'editor'|'always' }
// 具体 run 由调用方注入闭包（app 命令在 main.js 注册、editor 命令经 ctx.runEditorCommand、
// plugin 命令包一层 runCommand）。本模块只管登记/查询/分派，不含任何应用逻辑，故可纯 Node 单测。

import { t } from './i18n.js'

export const RESERVED_PREFIXES = ['app.', 'editor.'] // 内置命名空间，插件不得占用
const CATEGORIES = new Set(['app', 'editor', 'plugin'])

export function createRegistry() {
  const byId = new Map()

  function validate(cmd) {
    if (!cmd || typeof cmd.id !== 'string' || !cmd.id) return t('cmd.err.noId')
    if (typeof cmd.title !== 'string' || !cmd.title) return t('cmd.err.noTitle', { id: cmd.id })
    if (!CATEGORIES.has(cmd.category)) return t('cmd.err.badCategory', { id: cmd.id, category: cmd.category })
    if (typeof cmd.run !== 'function') return t('cmd.err.badRun', { id: cmd.id })
    if (cmd.defaultKey != null && typeof cmd.defaultKey !== 'string') return t('cmd.err.badKey', { id: cmd.id })
    return null
  }

  return {
    /** 登记命令。已存在同 id：内置不允许被插件覆盖（告警拒收），其余允许更新（重注册）。返回是否成功。 */
    register(cmd) {
      const err = validate(cmd)
      if (err) {
        console.warn(t('cmd.err.rejected'), err)
        return false
      }
      const prev = byId.get(cmd.id)
      if (prev && prev.category !== 'plugin' && cmd.category === 'plugin') {
        console.warn(t('cmd.err.noOverride', { id: cmd.id }))
        return false
      }
      byId.set(cmd.id, { when: 'always', ...cmd })
      return true
    },

    /** 注销一条命令（插件卸载用）。返回是否删除。 */
    remove(id) {
      return byId.delete(id)
    },

    /** 按命名空间前缀批量移除（插件整体卸载：removeWhere(x => x.category==='plugin' && x.id.startsWith('plugin.'+name))） */
    removeWhere(pred) {
      let n = 0
      for (const [id, cmd] of [...byId]) {
        if (pred(cmd)) {
          byId.delete(id)
          n++
        }
      }
      return n
    },

    get(id) {
      return byId.get(id) || null
    },

    /** 全部命令（descriptor 数组）。 */
    list() {
      return [...byId.values()]
    },

    listByCategory(category) {
      return [...byId.values()].filter((c) => c.category === category)
    },

    /** 分派执行。返回是否命中并执行；run 抛错向上传播由调用方兜底。 */
    run(id, ctx) {
      const cmd = byId.get(id)
      if (!cmd) return false
      cmd.run(ctx)
      return true
    },
  }
}
