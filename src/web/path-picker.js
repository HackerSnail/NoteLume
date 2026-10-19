// path-picker.js —— 浏览器版的「选择文件夹 / 选择文件 / 另存为」模态
//
// 桌面版这三个框由 Tauri 原生提供；浏览器没有能给出绝对路径的 picker，所以这个框由后端 /api/browse
// 喂真实目录数据、这里画出来，返回绝对路径字符串（§2 决策 5）。外壳复用 style.css 现成的
// .nl-prompt-overlay / .nl-prompt 一套，不新造视觉语言；标题由调用方（tauri-bridge 的 t('dlg.*')）传入，
// 已经是当前语言。列表 / 面包屑这些 picker 专属样式在 web.css 里按 .nl-picker-* 补。

import { sessionId, invoke } from './tauri-core.js'
import { t } from '../i18n.js'
import { wt } from './web-strings.js'

async function apiBrowse(path, wantFiles) {
  const qs = new URLSearchParams()
  if (path) qs.set('path', path)
  if (wantFiles) qs.set('files', '1')
  const res = await fetch('/api/browse?' + qs.toString(), { headers: { 'x-notelume-session': sessionId() } })
  const data = await res.json()
  if (!data || !data.ok) throw new Error((data && data.error) || 'browse failed')
  return data.result
}

function el(tag, cls, text) {
  const n = document.createElement(tag)
  if (cls) n.className = cls
  if (text != null) n.textContent = text
  return n
}

/**
 * 打开一个路径选择框。mode: 'dir' 选目录 | 'file' 选文件 | 'save' 选目录 + 填文件名。
 * multiple 仅 file 模式有意义。extensions 仅 file 模式有意义：限定可选扩展名（小写、不含点），
 * 对齐桌面版 filters 的行为——非空时列表只列这些类型，空 / 缺省则全列。返回 Promise<string | string[] | null>。
 */
export function pickPath({ mode = 'dir', multiple = false, title = '', startPath = '', extensions = null } = {}) {
  return new Promise((resolve) => {
    const overlay = el('div', 'nl-prompt-overlay nl-picker-overlay')
    const box = el('div', 'nl-prompt nl-picker')

    const head = el('div', 'nl-picker-head')
    head.appendChild(el('div', 'nl-prompt-title', title || t('dlg.pickFolder')))
    const pathRow = el('div', 'nl-picker-path')
    const upBtn = el('button', 'nl-picker-up')
    upBtn.type = 'button'
    upBtn.textContent = '↑'
    upBtn.title = wt('ui.up')
    const pathLabel = el('span', 'nl-picker-cur', '…')
    pathRow.append(upBtn, pathLabel)
    head.appendChild(pathRow)
    const rootsRow = el('div', 'nl-picker-roots')
    head.appendChild(rootsRow)

    const list = el('div', 'nl-picker-list')
    box.append(head, list)

    let nameInput = null
    if (mode === 'save') {
      const nameRow = el('div', 'nl-picker-namerow')
      nameRow.appendChild(el('span', 'nl-picker-namelbl', wt('ui.fileName')))
      nameInput = el('input', 'nl-prompt-input nl-picker-name')
      nameInput.type = 'text'
      nameInput.value = startPath ? basename(startPath) : 'untitled.md'
      nameRow.appendChild(nameInput)
      box.appendChild(nameRow)
    }

    const foot = el('div', 'nl-prompt-row')
    const cancel = el('button', 'nl-prompt-btn', t('common.cancel'))
    const ok = el('button', 'nl-prompt-btn primary', t('common.confirm'))
    cancel.type = 'button'
    ok.type = 'button'
    if (mode === 'file') {
      // 上传本机文件：浏览器 <input type=file> 拿到真文件→base64→import_vault_file 落进当前浏览目录，
      // 再把库内绝对路径回给调用方——.docx 经「导入 Word」喂给已实现的服务端 docx_preview，整条流程自动跑通。
      const upload = el('button', 'nl-prompt-btn nl-picker-upload', wt('ui.uploadLocal'))
      upload.type = 'button'
      const fileInput = document.createElement('input')
      fileInput.type = 'file'
      fileInput.className = 'nl-picker-fileinput'
      fileInput.accept = extensions && extensions.length ? extensions.map((e) => '.' + e).join(',') : ''
      upload.addEventListener('click', () => fileInput.click())
      fileInput.addEventListener('change', async () => {
        const f = fileInput.files && fileInput.files[0]
        fileInput.value = ''
        if (!f) return
        if (!state.cur) {
          pathLabel.textContent = wt('ui.uploadLocal') + ' ✕ ' + t('status.needVaultFolder')
          return
        }
        pathLabel.textContent = wt('ui.uploading')
        try {
          finish(await uploadLocalFile(f, state.cur))
        } catch (e) {
          pathLabel.textContent = wt('ui.uploadLocal') + ' ✕ ' + String((e && e.message) || e)
        }
      })
      box.appendChild(fileInput)
      foot.append(upload, cancel, ok)
    } else {
      foot.append(cancel, ok)
    }
    box.appendChild(foot)

    overlay.appendChild(box)
    document.body.appendChild(overlay)

    const state = { cur: '', parent: null, selected: null, selectedMulti: [] }
    let done = false
    const finish = (val) => {
      if (done) return
      done = true
      document.removeEventListener('keydown', onKey, true)
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay)
      resolve(val)
    }

    function renderDirs(roots) {
      rootsRow.textContent = ''
      ;(roots || []).forEach((r) => {
        const b = el('button', 'nl-picker-root', r.name)
        b.type = 'button'
        b.title = r.path
        b.addEventListener('click', () => load(r.path))
        rootsRow.appendChild(b)
      })
    }

    function paint(data) {
      state.cur = data.path
      state.parent = data.parent
      pathLabel.textContent = data.path || t('dlg.pickFolder')
      renderDirs(data.roots)
      list.textContent = ''

      const back = data.parent
      if (back != null) {
        const li = el('div', 'nl-picker-item nl-picker-back', '… ' + wt('ui.up'))
        li.addEventListener('click', () => load(back))
        list.appendChild(li)
      }
      for (const d of data.dirs) {
        const li = el('div', 'nl-picker-item nl-picker-dir')
        li.textContent = '▸ ' + d.name
        li.addEventListener('click', () => load(d.path))
        li.addEventListener('dblclick', () => (mode === 'dir' ? finish(d.path) : load(d.path)))
        list.appendChild(li)
      }
      if (mode === 'file') {
        // 后端回的每个文件带 kind（扩展名）；给了 extensions 就只列对得上的，对齐桌面 filters
        const allow = extensions && extensions.length ? extensions : null
        const shown = allow ? data.files.filter((f) => allow.includes(String(f.kind || '').toLowerCase())) : data.files
        for (const f of shown) {
          const li = el('div', 'nl-picker-item nl-picker-file')
          li.textContent = '· ' + f.name
          const abs = f.path
          li.addEventListener('click', () => {
            if (multiple) {
              const i = state.selectedMulti.indexOf(abs)
              if (i >= 0) {
                state.selectedMulti.splice(i, 1)
                li.classList.remove('sel')
              } else {
                state.selectedMulti.push(abs)
                li.classList.add('sel')
              }
            } else {
              finish(abs)
            }
          })
          if (multiple && state.selectedMulti.includes(abs)) li.classList.add('sel')
          list.appendChild(li)
        }
        if (!shown.length) list.appendChild(el('div', 'nl-picker-empty', wt('ui.noFiles')))
      }
    }

    async function load(p) {
      try {
        paint(await apiBrowse(p, mode === 'file'))
      } catch (e) {
        pathLabel.textContent = String((e && e.message) || e)
      }
    }

    upBtn.addEventListener('click', () => {
      if (state.parent != null) load(state.parent)
    })

    ok.addEventListener('click', () => {
      if (mode === 'dir') return finish(state.cur || null)
      if (mode === 'file') return finish(multiple ? state.selectedMulti : state.selected || null)
      // save：目录 + 文件名拼成绝对路径；分隔符跟随当前路径
      const rawName = (nameInput && nameInput.value.trim()) || ''
      if (!state.cur || !rawName) return
      const sep = state.cur.includes('\\') ? '\\' : '/'
      const joined = state.cur.replace(/[\\/]+$/, '') + sep + rawName
      finish(joined)
    })

    cancel.addEventListener('click', () => finish(null))
    overlay.addEventListener('pointerdown', (e) => {
      if (e.target === overlay) finish(null)
    })
    function onKey(e) {
      if (e.key === 'Escape') {
        e.preventDefault()
        finish(null)
      } else if (e.key === 'Enter' && mode === 'save' && e.target === nameInput) {
        e.preventDefault()
        ok.click()
      }
    }
    document.addEventListener('keydown', onKey, true)

    // 起始路径：save 用 defaultPath 的目录，file / save 从库根（沙盒）或 home 开始——桌面
    // 原生框也是开在一个具体目录里，不是一张空列表；dir 模式（打开知识库）不给起点，保持
    // 盘符 / 工作区列表让用户自己选。先 paint 再 load：load 失败也还看得见 roots。
    apiBrowse(startPath && mode !== 'save' ? startPath : '', mode === 'file')
      .then((data) => {
        paint(data)
        const explicit = !!(startPath && mode !== 'save')
        const startDir = explicit || mode === 'dir' ? null : data.vault || data.home
        if (startDir) load(startDir)
      })
      .catch((e) => {
        pathLabel.textContent = String((e && e.message) || e)
      })
  })
}

function basename(p) {
  const s = String(p).replace(/[\\/]+$/, '')
  return s.split(/[\\/]/).pop() || ''
}

/** 把一个本机 File 读成 base64、以 dir 为库根 import_vault_file 落库，返回它的绝对路径 */
async function uploadLocalFile(file, dir) {
  const dataUrl = await new Promise((res, rej) => {
    const fr = new FileReader()
    fr.onload = () => res(fr.result)
    fr.onerror = () => rej(fr.error || new Error('read failed'))
    fr.readAsDataURL(file)
  })
  const dataBase64 = String(dataUrl).split(',')[1] || ''
  const vaultRoot = String(dir).replace(/[\\/]+$/, '')
  const rel = await invoke('import_vault_file', { vaultRoot, args: { destDirRel: '', name: file.name, dataBase64 } })
  if (!rel) throw new Error('import failed')
  return vaultRoot + '/' + rel
}
