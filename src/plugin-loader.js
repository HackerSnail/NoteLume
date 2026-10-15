// plugin-loader.js —— 批次 F1：文件夹化插件包 + manifest 权限同意（软闸门）
// 插件 = <vault>/.notelume-plugins/<id>/{manifest.json, main.js}，运行在主线程、无沙箱（用户自担风险）。
// 加载：Rust 枚举一级子目录只读 manifest 原文 -> 前端解析校验 -> 首载"一律弹"权限同意 -> 同意后读源码经
// Blob URL 动态 import（绕开 webview 文件系统 URL 限制）。
// F1 只做"声明 + 知情同意"软闸门，不改 ctx、不做技术拦截（那是 F3）。编辑器 keymap/inputRule 仍用
// state.reconfigure 运行时热注入；schema（node/mark spec）创建后不可变，扩展节点属 F2。
import { listPlugins, readPlugin } from './tauri-bridge.js'
import { setIcon } from './icons.js'
import { keymap } from 'prosemirror-keymap'
import { Plugin } from 'prosemirror-state'
import { schema } from './editor-schema.js'
import { parseAndValidateManifest, needsConsent, newPerms, SCOPE_LABELS } from './plugin-manifest.js'
import { pluginConsentDialog } from './plugin-consent-dialog.js'

const DISABLED_KEY = 'nl-disabled-plugins'
const CONSENT_KEY = 'nl-plugin-consent'

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
function loadConsent() {
  try {
    return JSON.parse(localStorage.getItem(CONSENT_KEY) || '{}') || {}
  } catch (_) {
    return {}
  }
}
function saveConsent(map) {
  localStorage.setItem(CONSENT_KEY, JSON.stringify(map))
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

  let loaded = [] // 记录：每个插件包一项，见 reload 内字段
  let legacyFlat = [] // 顶层游离 .js/.mjs（旧版平铺，提示迁移）
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
        console.warn('[NoteLume] registerNodeSpec 暂不支持（schema 运行时不可变，属 F2）')
      },
      registerMarkSpec() {
        console.warn('[NoteLume] registerMarkSpec 暂不支持（schema 运行时不可变，属 F2）')
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

  // 读取并装配一个已通过校验+同意的插件包（错误写回 rec.error，不外抛）
  async function importPackage(rec, vaultRoot, acc) {
    const rel = '.notelume-plugins/' + rec.dirName + '/' + rec.main
    try {
      const src = await readPlugin(vaultRoot, rel)
      const mod = await importFromSource(src)
      let plugin = mod && mod.default ? mod.default : mod
      if (typeof plugin === 'function') plugin = plugin()
      if (!plugin || typeof plugin !== 'object') throw new Error('插件须 export default 一个对象')
      rec.plugin = plugin
      rec.running = true
      acc.file = rec.name
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

  async function reload() {
    if (busy) return
    busy = true
    try {
      clearInjected()
      loaded = []
      legacyFlat = []
      commands.clear()
      if (commandRegistry) commandRegistry.removeWhere((c) => c.category === 'plugin')
      for (const k of Object.keys(hooks)) hooks[k] = []
      const acc = { keyBindings: [], inputRules: [] }

      const vaultRoot = getVaultRoot()
      let list = { packages: [], legacyFlat: [] }
      if (vaultRoot) {
        try {
          list = await listPlugins(vaultRoot)
        } catch (e) {
          setStatus('插件目录读取失败：' + ((e && e.message) || e))
        }
      }
      legacyFlat = list.legacyFlat || []
      const disabled = loadDisabled()
      const consent = loadConsent()

      // 1) 解析 + 校验每个包；有效的按同意状态决定即刻装载 / 进待同意队列
      const pending = [] // { rec, added }
      for (const pkg of list.packages) {
        const rec = {
          dirName: pkg.dirName,
          id: pkg.dirName,
          name: pkg.dirName,
          version: '',
          author: '',
          description: '',
          main: 'main.js',
          permissions: [],
          manifestError: null,
          error: null,
          plugin: null,
          running: false,
          enabled: !disabled.has(pkg.dirName),
          consentRefused: false,
        }
        loaded.push(rec)

        const m = parseAndValidateManifest(pkg.manifestRaw, pkg.dirName)
        if (!m.ok) {
          rec.manifestError = m.error
          rec.enabled = !disabled.has(pkg.dirName)
          continue
        }
        rec.id = m.id
        rec.name = m.name
        rec.version = m.version
        rec.author = m.author
        rec.description = m.description
        rec.main = m.main
        rec.permissions = m.permissions
        rec.enabled = !disabled.has(m.id)
        if (!rec.enabled) continue
        if (!pkg.mainExists) {
          rec.error = '入口文件不存在（main.js / main.mjs）'
          continue
        }
        if (needsConsent(m.permissions, consent[m.id])) {
          pending.push({ rec, added: newPerms(m.permissions, consent[m.id]) })
        } else {
          await importPackage(rec, vaultRoot, acc)
        }
      }

      // 2) 待同意的合并成一次弹窗（全有/全无）
      if (pending.length) {
        const agreed = await pluginConsentDialog({
          items: pending.map(({ rec, added }) => ({
            name: rec.name,
            version: rec.version,
            author: rec.author,
            permissions: rec.permissions,
            added: added || [],
          })),
        })
        if (agreed) {
          for (const { rec, added } of pending) {
            consent[rec.id] = { perms: rec.permissions, at: Date.now() }
            await importPackage(rec, vaultRoot, acc)
          }
        } else {
          for (const { rec } of pending) rec.consentRefused = true
        }
        saveConsent(consent)
      }

      // 3) 组装并注入 PM 插件（keymap / inputRule）
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
      const runningCount = loaded.filter((r) => r.running).length
      setStatus(`插件已加载：${runningCount}/${loaded.length} 运行`)
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

  function toggle(id) {
    const disabled = loadDisabled()
    if (disabled.has(id)) disabled.delete(id)
    else disabled.add(id)
    saveDisabled(disabled)
    reload()
  }

  // 撤销某插件的权限同意（下次加载重新弹）
  function resetConsent(id) {
    const consent = loadConsent()
    delete consent[id]
    saveConsent(consent)
    reload()
  }

  // 单独就某插件重新征求同意（用于"权限未授予"行）
  async function regrant(id) {
    const rec = loaded.find((r) => r.id === id)
    if (!rec || !rec.enabled) return
    const consent = loadConsent()
    const agreed = await pluginConsentDialog({
      items: [
        {
          name: rec.name,
          version: rec.version,
          author: rec.author,
          permissions: rec.permissions,
          added: newPerms(rec.permissions, consent[rec.id]),
        },
      ],
    })
    if (agreed) {
      consent[rec.id] = { perms: rec.permissions, at: Date.now() }
      saveConsent(consent)
    }
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
    hint.textContent = '放入 .notelume-plugins/<id>/manifest.json'
    head.appendChild(hint)
    panelEl.appendChild(head)

    if (legacyFlat.length) {
      const warn = document.createElement('div')
      warn.className = 'nl-plugin-legacy'
      warn.textContent = `检测到旧版平铺插件：${legacyFlat.join('、')}，需改为文件夹化，已忽略`
      panelEl.appendChild(warn)
    }

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
      chk.addEventListener('change', () => toggle(rec.id))
      row.appendChild(chk)

      const info = document.createElement('div')
      info.className = 'plugin-info'
      const nm = document.createElement('div')
      nm.className = 'plugin-name'
      nm.textContent = rec.name
      const subBits = []
      if (rec.version) subBits.push('v' + rec.version)
      if (rec.author) subBits.push(rec.author)
      if (subBits.length) {
        const s = document.createElement('span')
        s.className = 'nl-plugin-sub'
        s.textContent = ' ' + subBits.join(' · ')
        nm.appendChild(s)
      }
      info.appendChild(nm)
      // 权限 chip（有效清单才显示；基线恒显「仅编辑器功能」）
      if (!rec.manifestError) {
        const chips = document.createElement('div')
        chips.className = 'nl-plugin-perms'
        chips.appendChild(chipEl('仅编辑器功能', false))
        for (const p of rec.permissions) {
          const meta = SCOPE_LABELS[p] || { label: p }
          chips.appendChild(chipEl(meta.label, !!meta.danger))
        }
        info.appendChild(chips)
      }

      const st = document.createElement('div')
      st.className = 'plugin-status'
      let statusText = ''
      let statusIcon = ''
      if (rec.manifestError) {
        st.classList.add('err')
        statusText = rec.manifestError
        statusIcon = 'warning'
      } else if (!rec.enabled) {
        statusText = '已禁用'
      } else if (rec.error) {
        st.classList.add('err')
        statusText = rec.error
        statusIcon = 'warning'
      } else if (rec.consentRefused) {
        statusText = '权限未授予'
      } else if (rec.running) {
        statusText = '已启用'
      } else {
        statusText = '待同意'
      }
      setIcon(st, statusIcon, statusText)
      st.title = rec.dirName
      info.appendChild(st)
      row.appendChild(info)

      // 动作按钮：未授予→授予；运行中→重设权限
      if (rec.consentRefused && rec.enabled) {
        const g = document.createElement('button')
        g.className = 'plugin-cmd'
        g.textContent = '授予权限'
        g.addEventListener('click', () => regrant(rec.id))
        row.appendChild(g)
      } else if (rec.running) {
        const r = document.createElement('button')
        r.className = 'plugin-cmd'
        r.textContent = '重设权限'
        r.title = '撤销同意，下次加载重新征求'
        r.addEventListener('click', () => resetConsent(rec.id))
        row.appendChild(r)
      }

      // 该插件注册的命令按钮
      const cmds = [...commands.entries()].filter(([, v]) => v.owner === rec.name)
      if (cmds.length && rec.running) {
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

  function chipEl(label, danger) {
    const s = document.createElement('span')
    s.className = 'nl-plugin-chip' + (danger ? ' danger' : '')
    s.textContent = label
    return s
  }

  renderPanel()
  return { reload, fireDocChange, fireFileOpen, fireSave, runCommand, toggle, regrant, resetConsent }
}
