// fs-commands.test.mjs —— 13 条文件类命令的行为锁定（spec §12）
// 运行：cd server && node tests/fs-commands.test.mjs（或根目录 npm run web:test）
//
// 本机模式（jail = null）+ mkdtemp 临时库，只验命令自身的语义与库内校验；
// 监狱与会话隔离那套在 sandbox.test.mjs，索引与快照在 kb-commands.test.mjs。
//
// 为什么要有这个文件：create_md_file 内部是 `this.write_md_file(...)`，而分派层早期
// 直接 fn.call(ctx)，this 上没有命令表 —— 网页版点「新建文件」必 TypeError，构建与桌面
// 单测都发现不了。凡是命令之间互相复用的路径，都要有一条真调分派的用例压着。

import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { dispatch } from '../src/router.mjs'
import { handlers } from '../src/fsCommands.mjs'
import { msg } from '../src/uiLang.mjs'
import { fnv1a } from '../src/vault.mjs'

let pass = 0
let fail = 0
function test(name, fn) {
  try {
    fn()
    pass++
    console.log('  ok   ' + name)
  } catch (e) {
    fail++
    console.log('  FAIL ' + name + ' —— ' + ((e && e.message) || e))
  }
}

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'nl-fs-'))
const ctx = { sid: 'local', jail: null }
const b64 = (s) => Buffer.from(s, 'utf8').toString('base64')
const ok = (cmd, params, label) => {
  const r = dispatch(ctx, cmd, params)
  assert.equal(r.ok, true, `${label || cmd} 应当成功：` + (r.error || ''))
  return r.result
}
const err = (cmd, params, expectMsg, label) => {
  const r = dispatch(ctx, cmd, params)
  assert.equal(r.ok, false, `${label || cmd} 应当被拒`)
  assert.ok(!/TypeError|not a function/.test(r.error), '回的不该是堆栈错：' + r.error)
  if (expectMsg) assert.equal(r.error, expectMsg, `${label || cmd} 文案不对：` + r.error)
  return r.error
}
const V = { vaultRoot: base }
const absOf = (...seg) => path.join(base, ...seg)

// —— 固定夹具：scan_vault 的排序与过滤要靠这棵树说话 ——
fs.writeFileSync(absOf('b.md'), '# B\n', 'utf8')
fs.writeFileSync(absOf('a-canvas.canvas'), '{"nodes":[],"edges":[]}', 'utf8')
fs.writeFileSync(absOf('img.png'), 'png-bytes', 'utf8')
fs.writeFileSync(absOf('skip.txt'), 'not markdown', 'utf8')
fs.mkdirSync(absOf('.hidden'), { recursive: true })
fs.writeFileSync(absOf('.hidden', 'ghost.md'), '# ghost\n', 'utf8')
fs.mkdirSync(absOf('notes'), { recursive: true })
fs.writeFileSync(absOf('notes', 'n1.md'), '# N1\n', 'utf8')
fs.mkdirSync(absOf('notes', 'zeta'), { recursive: true })
fs.writeFileSync(absOf('notes', 'zeta', 'deep with space.png'), 'deep-png', 'utf8')

console.log('临时库：' + base)

test('scan_vault：文件夹在前、名称排序，只收 md/canvas/图片', () => {
  const tree = ok('scan_vault', V, '扫描')
  assert.deepEqual(
    tree.map((e) => [e.name, e.type]),
    [['notes', 'folder'], ['a-canvas.canvas', 'file'], ['b.md', 'file'], ['img.png', 'file']],
  )
  const notes = tree[0]
  assert.deepEqual(
    notes.children.map((e) => [e.name, e.type]),
    [['zeta', 'folder'], ['n1.md', 'file']],
  )
  assert.equal(notes.children[0].children.length, 1, '深层要能递归到')
  assert.ok(!JSON.stringify(tree).includes('skip.txt'), '非白名单扩展名不该进树')
  assert.ok(!JSON.stringify(tree).includes('ghost.md'), '点开头目录该整棵跳过')
})

test('read_md_file：内容原样回，越界与缺失分开报', () => {
  assert.equal(ok('read_md_file', { ...V, path: 'b.md' }, '读'), '# B\n')
  err('read_md_file', { ...V, path: 'nosuch.md' }, null, '缺文件')
  err('read_md_file', { ...V, path: '../outside.md' }, msg('pathEscapeVault'), '跳出库根')
  // 空路径拼出来就是库根目录本身：Rust 同样是 read_to_string(目录) 报 EISDIR，不做特判
  err('read_md_file', { ...V, path: '' }, null, '空路径')
})

test('write_md_file：建缺失父目录、反斜杠归一、拒绝 ..', () => {
  ok('write_md_file', { ...V, path: 'deep/a/b/x.md', content: '# deep\n' }, '写深层')
  assert.equal(fs.readFileSync(absOf('deep', 'a', 'b', 'x.md'), 'utf8'), '# deep\n')
  ok('write_md_file', { ...V, path: 'deep\\back.md', content: 'back\n' }, '反斜杠路径')
  assert.equal(fs.existsSync(absOf('deep', 'back.md')), true, '反斜杠该归一成 /')
  err('write_md_file', { ...V, path: '../out.md', content: 'x' }, msg('pathEscapeVault'), '../ 写')
  assert.equal(fs.existsSync(path.resolve(base, '..', 'out.md')), false, '库外不该出现文件')
  assert.equal(ok('read_md_file', { ...V, path: 'deep/a/b/x.md' }, '回读'), '# deep\n')
})

test('create_md_file：补 .md、回相对路径、空名拒 —— 走的是 this.write_md_file', () => {
  // 回归：分派层漏了命令表时，这条会炸成 TypeError
  assert.equal(typeof handlers.write_md_file, 'function', '命令表本身要能当原型链用')
  assert.equal(ok('create_md_file', { ...V, args: { path: '新建笔记' } }, '无扩展名'), '新建笔记.md')
  assert.equal(fs.readFileSync(absOf('新建笔记.md'), 'utf8'), '', '不传 content 时是空文件')
  assert.equal(ok('create_md_file', { ...V, args: { path: 'sub/Two.MD', content: '# two\n' } }, '大写扩展名'), 'sub/Two.MD')
  assert.equal(ok('create_md_file', { ...V, args: { path: 'has.md', content: 'x' } }, '已带 .md'), 'has.md')
  err('create_md_file', { ...V, args: { path: '  ' } }, msg('emptyFileName'), '空文件名')
  err('create_md_file', { ...V, args: { path: '../p' } }, msg('pathEscapeVault'), '越界新建')
})

test('create_dir：建嵌套父目录，重名拒，空名拒', () => {
  ok('create_dir', { ...V, path: 'folder/new' }, '建夹')
  assert.equal(fs.statSync(absOf('folder', 'new')).isDirectory(), true)
  err('create_dir', { ...V, path: 'folder/new' }, msg('targetExists'), '重名')
  err('create_dir', { ...V, path: '' }, msg('emptyFolderName'), '空文件夹名')
  err('create_dir', { ...V, path: '../evil' }, msg('pathEscapeVault'), '跳出库根')
})

test('rename_item：改名与跨目录移动，目标占用与移入自身都拒', () => {
  ok('rename_item', { ...V, from: 'has.md', to: 'renamed.md' }, '同名改')
  assert.equal(fs.existsSync(absOf('renamed.md')), true)
  assert.equal(fs.existsSync(absOf('has.md')), false, '源该消失')
  ok('rename_item', { ...V, from: 'renamed.md', to: 'folder/inner.md' }, '跨目录移动')
  assert.equal(fs.readFileSync(absOf('folder', 'inner.md'), 'utf8'), 'x')
  ok('write_md_file', { ...V, path: 'taken.md', content: 't' }, '预置占位')
  err('rename_item', { ...V, from: 'taken.md', to: 'b.md' }, msg('renameExists'), '移入已存在')
  err('rename_item', { ...V, from: 'folder', to: 'folder/self' }, msg('moveIntoSelf'), '文件夹移入自身')
  err('rename_item', { ...V, from: 'folder', to: '' }, msg('newNameEmpty'), '空新名')
  err('rename_item', { ...V, from: 'ghost.md', to: 'x.md' }, null, '源不存在')
  err('rename_item', { ...V, from: 'b.md', to: '../escape.md' }, msg('pathEscapeVault'), '目标越界')
})

test('delete_file：文件进 .notelume-trash（Node 无系统回收站），文件夹照旧拒', () => {
  ok('write_md_file', { ...V, path: 'gone.md', content: 'bye\n' }, '预置待删')
  ok('delete_file', { ...V, path: 'gone.md' }, '删文件')
  assert.equal(fs.existsSync(absOf('gone.md')), false, '原位置还在')
  const trash = absOf('.notelume-trash')
  const moved = fs.readdirSync(trash).filter((n) => n.endsWith('gone.md'))
  assert.equal(moved.length, 1, '回收目录里应有且只有一份：' + JSON.stringify(fs.readdirSync(trash)))
  assert.equal(fs.readFileSync(path.join(trash, moved[0]), 'utf8'), 'bye\n', '内容要原样保留，不能静默销毁')
  ok('write_md_file', { ...V, path: 'twice.md', content: '1' }, '第二次删除预置')
  ok('delete_file', { ...V, path: 'twice.md' }, '删一次')
  ok('write_md_file', { ...V, path: 'twice.md', content: '2' }, '重建同名')
  ok('delete_file', { ...V, path: 'twice.md' }, '再删一次')
  assert.equal(fs.readdirSync(trash).filter((n) => n.endsWith('twice.md')).length, 2, '同名两次删除不能互相覆盖')
  const tree = ok('scan_vault', V, '删除后扫描')
  assert.ok(!JSON.stringify(tree).includes('.notelume-trash'), '回收目录不该出现在文件树里')
  err('delete_file', { ...V, path: 'folder' }, msg('noFolderDelete'), '删文件夹')
  err('delete_file', { ...V, path: 'nosuch.md' }, null, '删不存在的文件')
})

test('resolve_wiki_link：同层、库内 basename、显式 .md、未命中', () => {
  const hit = ok('resolve_wiki_link', { ...V, refRel: 'b.md', name: 'n1' }, '库内 basename')
  assert.deepEqual(hit, { exists: true, path: 'notes/n1.md' })
  assert.equal(ok('resolve_wiki_link', { ...V, refRel: 'notes/n1.md', name: 'n1' }, '同层优先').path, 'notes/n1.md')
  assert.equal(ok('resolve_wiki_link', { ...V, refRel: 'home.md', name: 'notes/n1.md' }, '带目录').path, 'notes/n1.md')
  assert.equal(ok('resolve_wiki_link', { ...V, refRel: 'home.md', name: 'notes/n1' }, '目录无扩展').path, 'notes/n1.md')
  const miss = ok('resolve_wiki_link', { ...V, refRel: 'b.md', name: '尚未存在的页面' }, '未命中')
  assert.deepEqual(miss, { exists: false, path: null })
  assert.deepEqual(ok('resolve_wiki_link', { ...V, refRel: 'b.md', name: '  ' }, '空白名'), { exists: false, path: null })
})

test('save_image_bytes：落 md 同级 assets，回的链接可直接写进 md', () => {
  const link = ok('save_image_bytes', { ...V, mdRel: 'notes/n1.md', args: { ext: '.png', dataBase64: b64('IMG') } }, '存图')
  assert.equal(link, './assets/pasted-' + fnv1a(Buffer.from('IMG', 'utf8')) + '.png', '实际回：' + link)
  assert.equal(fs.existsSync(absOf('notes', 'assets', link.slice('./assets/'.length))), true, '文件要落在 notes/assets')
  // 同一份字节再存一次：指纹相同，幂等覆盖同名文件，不产生第二份
  const again = ok('save_image_bytes', { ...V, mdRel: 'notes/n1.md', args: { ext: 'png', dataBase64: b64('IMG') } }, '再存')
  assert.equal(again, link, '相同内容该得到同一个链接')
  // 回退查找的用例：同一张图另存一个不常被直接引用的名字
  ok('save_image_bytes', { ...V, mdRel: 'notes/n1.md', args: { ext: 'png', dataBase64: b64('IMG') } }, '存图')
  fs.copyFileSync(absOf('notes', 'assets', link.slice('./assets/'.length)), absOf('notes', 'assets', '未放路径里的图.png'))
  err('save_image_bytes', { ...V, mdRel: 'b.md', args: { ext: 'exe', dataBase64: b64('X') } }, msg('unsupportedImgType', { ext: 'exe' }), '非白名单类型')
})

test('read_image_data_uri：常规解析、%20 转义、按文件名回退查找', () => {
  const uri = ok('read_image_data_uri', { ...V, mdRel: 'b.md', src: './assets/deep with space.png' }, '带空格')
  assert.ok(uri.startsWith('data:image/png;base64,'), uri.slice(0, 40))
  assert.equal(Buffer.from(uri.split(',')[1], 'base64').toString('utf8'), 'deep-png')
  const viaRel = ok('read_image_data_uri', { ...V, mdRel: 'notes/zeta/x.md', src: 'deep with space.png' }, '相对同层')
  assert.equal(viaRel, uri, '两种写法要读到同一张图')
  const percent = ok('read_image_data_uri', { ...V, mdRel: 'notes/zeta/x.md', src: 'deep%20with%20space.png' }, 'URL 转义')
  assert.equal(percent, uri)
  const fallback = ok('read_image_data_uri', { ...V, mdRel: 'b.md', src: '未放路径里的图.png' }, '回退查找')
  assert.ok(fallback.startsWith('data:image/png;base64,'), fallback.slice(0, 40))
  assert.equal(Buffer.from(fallback.split(',')[1], 'base64').toString('utf8'), 'IMG', '回退命中的是 notes/assets 里那张：' + fallback)
})

test('read_image_data_uri：找不到与非法类型分开报', () => {
  err('read_image_data_uri', { ...V, mdRel: 'b.md', src: '没有这张.png' }, msg('imgNotFound', { src: '没有这张.png' }), '缺图')
  fs.writeFileSync(absOf('bad.txt2'), 'x', 'utf8')
  err('read_image_data_uri', { ...V, mdRel: 'b.md', src: 'bad.txt2' }, msg('unsupportedImgType', { ext: 'txt2' }), '非图片扩展')
})

test('import_vault_file：落库、同名同内容复用、同名不同内容加指纹', () => {
  const bytes = b64('payload-A')
  const first = ok('import_vault_file', { ...V, args: { destDirRel: 'inbox', name: 'doc.md', dataBase64: bytes } }, '首次导入')
  assert.equal(first, 'inbox/doc.md', '实际回：' + first)
  assert.equal(fs.readFileSync(absOf('inbox', 'doc.md'), 'utf8'), 'payload-A')
  const same = ok('import_vault_file', { ...V, args: { destDirRel: 'inbox', name: 'doc.md', dataBase64: bytes } }, '同内容再导入')
  assert.equal(same, 'inbox/doc.md', '同内容不该改名产生副本')
  const clash = ok('import_vault_file', { ...V, args: { destDirRel: 'inbox', name: 'doc.md', dataBase64: b64('payload-B') } }, '冲突导入')
  assert.equal(clash, 'inbox/doc-' + fnv1a(Buffer.from('payload-B', 'utf8')) + '.md', '实际回：' + clash)
  assert.equal(fs.readFileSync(absOf('inbox', 'doc.md'), 'utf8'), 'payload-A', '已有文件不能被覆盖')
  const rootDir = ok('import_vault_file', { ...V, args: { destDirRel: '', name: 'top.txt', dataBase64: b64('t') } }, '库根导入')
  assert.equal(rootDir, 'top.txt')
  const nested = ok('import_vault_file', { ...V, args: { destDirRel: '/inbox/second/', name: 'p/a.md', dataBase64: b64('n') } }, '名字带路径')
  assert.equal(nested, 'inbox/second/a.md', '只取 basename：' + nested)
  err('import_vault_file', { ...V, args: { destDirRel: 'inbox', name: '..', dataBase64: bytes } }, msg('badImportFileName'), '非法名')
  err('import_vault_file', { ...V, args: { destDirRel: 'inbox', name: '', dataBase64: bytes } }, msg('badImportFileName'), '空名')
})

test('export_file：本机模式跟着选择框写，沙盒模式受监狱约束', () => {
  ok('export_file', { ...V, args: { absPath: absOf('out', 'exported.txt'), content: 'e' } }, '库内导出')
  assert.equal(fs.readFileSync(absOf('out', 'exported.txt'), 'utf8'), 'e')
  err('export_file', { ...V, args: { absPath: '', content: 'x' } }, msg('badFilePath'), '空路径')
  // 本机模式 jail 为 null：导出目标本来就是原生保存框给的任意路径，不该拦
  const far = path.join(base, '..', 'nl-free-export.txt')
  ok('export_file', { ...V, args: { absPath: far, content: 'free' } }, '本机模式写库外')
  assert.equal(fs.readFileSync(far, 'utf8'), 'free')
  fs.rmSync(far, { force: true })

  // 同一份参数放进监狱里：库外一律拒，而未落地的深层路径要靠最近的祖先判定
  const jailed = { sid: 'local', jail: base }
  const r1 = dispatch(jailed, 'export_file', { ...V, args: { absPath: path.join(base, 'out', 'jailed.txt'), content: 'j' } })
  assert.equal(r1.ok, true, '监狱内该放行：' + r1.error)
  assert.equal(fs.readFileSync(absOf('out', 'jailed.txt'), 'utf8'), 'j')
  const r2 = dispatch(jailed, 'export_file', { ...V, args: { absPath: absOf('out', 'deep2', 'deep3', 'x.txt'), content: 'x' } })
  assert.equal(r2.ok, true, '未落地的库内深层该放行：' + r2.error)
  const outside = path.join(base, '..', 'nl-jailed-escape.txt')
  const r3 = dispatch(jailed, 'export_file', { ...V, args: { absPath: outside, content: 'x' } })
  assert.equal(r3.ok, false, '沙盒写监狱外竟然通过')
  assert.equal(r3.error, msg('pathOutsideVault'), '文案不对：' + r3.error)
  assert.equal(fs.existsSync(outside), false, '监狱外不该落文件')
})

test('take_launch_paths：网页版没有拖开语义，恒回空数组', () => {
  assert.deepEqual(ok('take_launch_paths', {}, '启动参数'), [])
})

test('未列出的命令回 [unsupported]，不是 500 堆栈', () => {
  const r = dispatch(ctx, 'git_status', {})
  assert.equal(r.ok, false)
  assert.ok(r.error.startsWith('[unsupported]'), r.error)
})

fs.rmSync(base, { recursive: true, force: true })
console.log('结果：' + pass + ' passed, ' + fail + ' failed')
if (fail) process.exit(1)
