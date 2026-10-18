// drop-open.test.mjs —— 拖入打开（P5 §6.6）纯逻辑回归（不触 DOM）
// 运行：cd src && node tests/drop-open.test.mjs
import assert from 'node:assert'
import { normDropPath, isDroppableName, isBinaryName, collectDropPaths } from '../drop-open.js'

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

test('normDropPath：剥掉 Windows fullPath 的前导斜杠，统一正斜杠', () => {
  assert.strictEqual(normDropPath('/C:/Users/a/b.md'), 'C:/Users/a/b.md')
  assert.strictEqual(normDropPath('/c:/x/y.canvas'), 'c:/x/y.canvas')
  assert.strictEqual(normDropPath('C:\\Users\\a\\b.md'), 'C:/Users/a/b.md')
  assert.strictEqual(normDropPath('/home/a/b.md'), '/home/a/b.md') // POSIX 绝对路径不动
  assert.strictEqual(normDropPath('  /D:/x.md  '), 'D:/x.md') // 去首尾空白
  assert.strictEqual(normDropPath(''), '')
  assert.strictEqual(normDropPath(null), '')
})

test('isDroppableName：md / markdown / canvas 收，其余与无扩展名不收', () => {
  assert.strictEqual(isDroppableName('a.md'), true)
  assert.strictEqual(isDroppableName('A.MARKDOWN'), true)
  assert.strictEqual(isDroppableName('b.canvas'), true)
  assert.strictEqual(isDroppableName('c.txt'), false)
  assert.strictEqual(isDroppableName('noext'), false)
  assert.strictEqual(isDroppableName('archive.md.zip'), false) // 看最后一段
  assert.strictEqual(isDroppableName(''), false)
})

test('isBinaryName：exe / dll / lnk 等二进制收，md / txt / 无扩展名不收', () => {
  assert.strictEqual(isBinaryName('notelume.exe'), true)
  assert.strictEqual(isBinaryName('NOTELUME.EXE'), true)
  assert.strictEqual(isBinaryName('foo.dll'), true)
  assert.strictEqual(isBinaryName('setup.msi'), true)
  assert.strictEqual(isBinaryName('快捷方式.lnk'), true)
  assert.strictEqual(isBinaryName('a.md'), false)
  assert.strictEqual(isBinaryName('c.txt'), false)
  assert.strictEqual(isBinaryName('noext'), false)
  assert.strictEqual(isBinaryName('archive.md.zip'), false)
  assert.strictEqual(isBinaryName(''), false)
})

test('collectDropPaths：优先 items 的 entry（能拿文件夹）', () => {
  const dt = {
    items: [
      { webkitGetAsEntry: () => ({ fullPath: '/C:/vault/笔记.md', isDirectory: false }) },
      { webkitGetAsEntry: () => ({ fullPath: '/C:/vault', isDirectory: true }) },
    ],
    files: [],
  }
  assert.deepStrictEqual(collectDropPaths(dt), [
    { path: 'C:/vault/笔记.md', isDir: false },
    { path: 'C:/vault', isDir: true },
  ])
})

test('collectDropPaths：没有 items 时退 files 的 path 属性', () => {
  const dt = {
    items: [],
    files: [{ path: 'D:\\x\\y.md' }],
  }
  assert.deepStrictEqual(collectDropPaths(dt), [{ path: 'D:/x/y.md', isDir: false }])
})

test('collectDropPaths：getAsEntry 抛错 / fullPath 为空的项跳过，不全军覆没', () => {
  const dt = {
    items: [
      {
        webkitGetAsEntry() {
          throw new Error('nope')
        },
      },
      { webkitGetAsEntry: () => null },
      { webkitGetAsEntry: () => ({ fullPath: '/E:/ok.md', isDirectory: false }) },
    ],
    files: [],
  }
  assert.deepStrictEqual(collectDropPaths(dt), [{ path: 'E:/ok.md', isDir: false }])
})

test('collectDropPaths：既无 items 也无 files 返回空数组', () => {
  assert.deepStrictEqual(collectDropPaths({}), [])
  assert.deepStrictEqual(collectDropPaths(null), [])
})

console.log('结果：' + pass + ' passed, ' + fail + ' failed')
if (fail) process.exit(1)
