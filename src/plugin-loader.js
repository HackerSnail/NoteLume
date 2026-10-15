// plugin-loader.js —— P2 插件基础钩子系统
// 插件 = 放在 <vault>/.notelume-plugins/*.js 的普通 ES 模块，运行在主线程、无沙箱（用户自担风险）。
// 加载：Rust 读源码 -> Blob URL -> 动态 import（绕开 webview 文件系统 URL 限制）。
// 编辑器在 boot 时已建好、而插件要到打开知识库后才可知，故 keymap/inputRule 用
// state.reconfigure 运行时热注入；schema（node/mark spec）创建后不可变，v1 暂不支持。
import { listPlugins, readPlugin } from './tauri-bridge.js'
import { setIcon } from './icons.js'
import { keymap } from 'prosemirror-keymap'
import { Plugin } from 'prosemirror-state'
import { schema } from './editor-schema.js'

const DISABLED_KEY = 'nl-disabled-plugins'

function loadDisabled() {
  try {
    return new Set(JSON.parse(localStorage.getItem(DISABLED_KEY) || '[]'))
  } catch (_) {
    return new Set()
  }
}
function saveDisabled(set) {
  localStorage.setItem(DISABLED_KEY, JSON.stringify([...set]))
}

// 把插件源码转成可 import 的模块
async function importFromSource(src) {
  const blob = new Blob([src], { type: 'text/javascript' })
  const url = URL.createObjectURL(blob)
  try {
    return await import(/* @vite-ignore */ url)
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 5000)
  }
}

export function createPluginManager(deps) {
  const { view, panelEl, setStatus, getVaultRoot, commandRegistry } = deps

  let loaded = [] // { name, file, plugin, error, enabled }
  let injected = [] // 本系统注入的 PM 插件（带 __nlPlugin 标记）
  const commands = new Map() // name -> { owner, fn, ctx }
  const hooks = { onEditorReady: [], onDocChange: [], onFileOpen: [], onSave: [] }
  let busy = false

  // 把插件命令并入统一命令注册表（面板可列、设置页可绑；id 命名空间 plugin.<owner>.<name>）
  function syncPluginCommand(owner, name, fn, ctx) {
    if (!commandRegistry) return
    const id = 'plugin.' + String(owner).replace(/\s+/g, '_') + '.' + String(name).replace(/\s+/g, '_')
    commandRegistry.register({
      id,
      title: `${owner}：${name}`,
      category: 'plugin',
      // 无默认键：插件自身声明的 keymap 仍走 PM 注入；这里默认只供面板/设置页绑定与执行
      run: () => {
        try {
          fn(ctx)
        } catch (e) {
          setStatus('命令执行失败：' + ((e && e.message) || e))
          console.error(e)
        }
      },
    })
  }

  function makeContext(plugin, acc) {
    return {
      id: plugin.id || acc.file,
      name: plugin.name || acc.file,
      view,
      schema,
      get state() {
        return view.state
      },
      dispatch(tr) {
        view.dispatch(tr)
      },
      setStatus,
      registerCommand(name, fn) {
        commands.set(name, { owner: this.name, fn, ctx: this })
        syncPluginCommand(this.name, name, fn, this)
      },
      registerKeymap(binding, fn) {
        acc.keyBindings.push([binding, fn])
      },
      registerInputRule(fn) {
        acc.inputRules.push(fn)
      },
      registerNodeSpec() {
        console.warn('[NoteLume] registerNodeSpec 暂不支持（schema 运行时不可变）')
      },
      registerMarkSpec() {
        console.warn('[NoteLume] registerMarkSpec 暂不支持（schema 运行时不可变）')
      },
    }
  }

  // 从当前 state 移除本系统注入的插件，返回干净的 base 列表
  function basePlugins() {
    return view.state.plugins.filter((p) => !p.__nlPlugin)
  }
  function clearInjected() {
    if (injected.length) {
      view.updateState(view.state.reconfigure({ plugins: basePlugins() }))
      injected = []
    }
  }

  async function reload() {
    if (busy) return
    busy = true
    try {
      clearInjected()
      loaded = []
      commands.clear()
      if (commandRegistry) commandRegistry.removeWhere((c) => c.category === 'plugin')
      for (const k of Object.keys(hooks)) hooks[k] = []
      const acc = { keyBindings: [], inputRules: [] }

      const vaultRoot = getVaultRoot()
      if (!vaultRoot) {
        renderPanel()
        return
      }
      let files = []
      try {
        files = await listPlugins(vaultRoot)
      } catch (e) {
        setStatus('插件目录读取失败：' + ((e && e.message) || e))
        renderPanel()
        return
      }
      const disabled = loadDisabled()

      for (const f of files) {
        const rec = { name: f.name, file: f.path, plugin: null, error: null, enabled: !disabled.has(f.name) }
        loaded.push(rec)
        if (!rec.enabled) continue
        try {
          const src = await readPlugin(vaultRoot, f.path)
          const mod = await importFromSource(src)
          let plugin = mod && mod.default ? mod.default : mod
          if (typeof plugin === 'function') plugin = plugin()
          if (!plugin || typeof plugin !== 'object') throw new Error('插件须 export default 一个对象')
          rec.plugin = plugin
          acc.file = f.name
          const ctx = makeContext(plugin, acc)

          if (typeof plugin.onInit === 'function') plugin.onInit(ctx)
          // 静态声明式 commands / keymap
          if (plugin.commands) {
            for (const [name, fn] of Object.entries(plugin.commands)) {
              if (typeof fn === 'function') {
                commands.set(name, { owner: ctx.name, fn, ctx })
                syncPluginCommand(ctx.name, name, fn, ctx)
              }
            }
          }
          if (plugin.keymap) {
            for (const [b, fn] of Object.entries(plugin.keymap)) {
              if (typeof fn === 'function') acc.keyBindings.push([b, fn])
            }
          }
          for (const h of ['onEditorReady', 'onDocChange', 'onFileOpen', 'onSave']) {
            if (typeof plugin[h] === 'function') hooks[h].push(plugin[h].bind(plugin))
          }
        } catch (e) {
          rec.error = (e && e.message) || String(e)
        }
      }

      // 组装并注入 PM 插件
      const extras = []
      if (acc.keyBindings.length) {
        const map = {}
        for (const [b, fn] of acc.keyBindings) {
          map[b] = (state, dispatch, v) => {
            try {
              return fn(state, dispatch, v)
            } catch (e) {
              console.error('[NoteLume] keymap 处理异常', e)
              return false
            }
          }
        }
        const kp = keymap(map)
        kp.__nlPlugin = true
        extras.push(kp)
      }
      if (acc.inputRules.length) {
        const rules = acc.inputRules
        const ip = new Plugin({
          props: {
            handleTextInput(v, from, to, text) {
              for (const fn of rules) {
                try {
                  if (fn(v, from, to, text)) return true
                } catch (e) {
                  console.error('[NoteLume] inputRule 异常', e)
                }
              }
              return false
            },
          },
        })
        ip.__nlPlugin = true
        extras.push(ip)
      }
      if (extras.length) {
        view.updateState(view.state.reconfigure({ plugins: [...basePlugins(), ...extras] }))
        injected = extras
      }

      for (const fn of hooks.onEditorReady) {
        try {
          fn(view, schema)
        } catch (e) {
          console.error('[NoteLume] onEditorReady 异常', e)
        }
      }
      const okCount = loaded.filter((r) => r.enabled && !r.error).length
      setStatus(`插件已加载：${okCount}/${loaded.length} 启用`)
    } finally {
      busy = false
      renderPanel()
    }
  }

  // —— 生命周期分发（由 main.js 调用）——
  function fireDocChange(doc, prev) {
    for (const fn of hooks.onDocChange) {
      try {
        fn(doc, prev)
      } catch (e) {
        console.error('[NoteLume] onDocChange 异常', e)
      }
    }
  }
  function fireFileOpen(path, content) {
    for (const fn of hooks.onFileOpen) {
      try {
        fn(path, content)
      } catch (e) {
        console.error('[NoteLume] onFileOpen 异常', e)
      }
    }
  }
  function fireSave(path, content) {
    for (const fn of hooks.onSave) {
      try {
        fn(path, content)
      } catch (e) {
        console.error('[NoteLume] onSave 异常', e)
      }
    }
  }

  function toggle(name) {
    const disabled = loadDisabled()
    if (disabled.has(name)) disabled.delete(name)
    else disabled.add(name)
    saveDisabled(disabled)
    reload()
  }

  function runCommand(name) {
    const entry = commands.get(name)
    if (!entry) {
      setStatus('未知命令：' + name)
      return
    }
    try {
      entry.fn(entry.ctx)
    } catch (e) {
      setStatus('命令执行失败：' + ((e && e.message) || e))
      console.error(e)
    }
  }

  // —— 面板渲染 ——
  function renderPanel() {
    if (!panelEl) return
    panelEl.innerHTML = ''

    const head = document.createElement('div')
    head.className = 'plugin-head'
    const reloadBtn = document.createElement('button')
    reloadBtn.className = 'plugin-reload'
    setIcon(reloadBtn, 'reload', '重新加载')
    reloadBtn.addEventListener('click', () => reload())
    head.appendChild(reloadBtn)
    const hint = document.createElement('span')
    hint.className = 'muted'
    hint.textContent = '放入 .notelume-plugins/*.js'
    head.appendChild(hint)
    panelEl.appendChild(head)

    if (!loaded.length) {
      const empty = document.createElement('div')
      empty.className = 'link-empty'
      empty.textContent = '未检测到插件'
      panelEl.appendChild(empty)
      return
    }

    loaded.forEach((rec) => {
      const row = document.createElement('div')
      row.className = 'plugin-item'

      const chk = document.createElement('input')
      chk.type = 'checkbox'
      chk.checked = rec.enabled
      chk.title = rec.enabled ? '点击禁用' : '点击启用'
      chk.addEventListener('change', () => toggle(rec.name))

      const info = document.createElement('div')
      info.className = 'plugin-info'
      const nm = document.createElement('div')
      nm.className = 'plugin-name'
      nm.textContent = (rec.plugin && rec.plugin.name) || rec.name
      info.appendChild(nm)
      let statusText = ''
      let statusIcon = ''
      if (rec.error) {
        statusText = rec.error
        statusIcon = 'warning'
      } else if (!rec.enabled) statusText = '已禁用'
      else statusText = '已启用'
      const st = document.createElement('div')
      st.className = 'plugin-status' + (rec.error ? ' err' : '')
      setIcon(st, statusIcon, statusText)
      st.title = rec.file
      info.appendChild(st)
      row.appendChild(chk)
      row.appendChild(info)

      // 该插件注册的命令按钮
      const cmds = [...commands.entries()].filter(([, v]) => v.owner === ((rec.plugin && rec.plugin.name) || rec.name))
      if (cmds.length && rec.enabled) {
        const cw = document.createElement('div')
        cw.className = 'plugin-cmds'
        cmds.forEach(([name]) => {
          const b = document.createElement('button')
          b.className = 'plugin-cmd'
          b.textContent = name
          b.addEventListener('click', () => runCommand(name))
          cw.appendChild(b)
        })
        row.appendChild(cw)
      }
      panelEl.appendChild(row)
    })
  }

  renderPanel()
  return { reload, fireDocChange, fireFileOpen, fireSave, runCommand, toggle }
}
