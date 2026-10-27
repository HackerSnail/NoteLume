// wysiwyg-gutter 的行合并纯函数测试（jsdom 无布局，矩形手工构造）
import assert from 'node:assert'
import { mergeLineTops, clipToBox, lineNumbersOn } from '../wysiwyg-gutter.js'

let pass = 0
let fail = 0
const t = (name, fn) => {
  try {
    fn()
    console.log('  ok   ' + name)
    pass++
  } catch (e) {
    console.log('  FAIL ' + name + ' —— ' + (e.message || e))
    fail++
  }
}
// 造一组同高矩形，lh = 行盒高度
const row = (top, lh = 30) => ({ top, bottom: top + lh })

t('三行折行文本 → 三行，top 递增、高度为行盒高', () => {
  const lines = mergeLineTops([row(100), row(130), row(160)])
  assert.deepStrictEqual(lines.map((l) => l.top), [100, 130, 160])
  assert.ok(lines.every((l) => l.height === 30))
})

t('同一视觉行内的行内片段（top 相同）合并成一行', () => {
  const lines = mergeLineTops([row(100), row(100), row(100)])
  assert.strictEqual(lines.length, 1)
})

t('行内基线微差（上下浮 4px，重叠过半）仍算同一行', () => {
  const lines = mergeLineTops([row(100), { top: 104, bottom: 134 }, { top: 97, bottom: 127 }])
  assert.strictEqual(lines.length, 1)
  assert.strictEqual(lines[0].top, 97)
})

t('矩形乱序输入：按 top 排序后行序正确', () => {
  const lines = mergeLineTops([row(160), row(100), row(130)])
  assert.deepStrictEqual(lines.map((l) => l.top), [100, 130, 160])
})

t('高矩形（行内图片跨两行）：只占它 top 所在的一行，不吞后续行', () => {
  const lines = mergeLineTops([{ top: 100, bottom: 190 }, row(130), row(160), row(190)])
  // 图片 top=100 起一行；130/160 与它垂直重叠过半并入；190 与图片底齐平、重叠不过半 → 新行
  assert.deepStrictEqual(lines.map((l) => l.top), [100, 190])
})

t('零高与退化矩形丢弃，空输入返回空数组', () => {
  assert.deepStrictEqual(mergeLineTops([{ top: 10, bottom: 10 }, { top: 20, bottom: 20 }]), [])
  assert.deepStrictEqual(mergeLineTops([]), [])
})

t('两倍行距的行（间距大）不误并', () => {
  const lines = mergeLineTops([row(100), row(200), row(300)])
  assert.strictEqual(lines.length, 3)
})

t('行内代码等不同字号的混排：重叠过半并入，换行分离', () => {
  // 12px 小字号行内码与 30px 正文同行：top=106, bottom=118，与 100..130 重叠 12/12 过半
  const lines = mergeLineTops([row(100), { top: 106, bottom: 118 }, row(130)])
  assert.deepStrictEqual(lines.map((l) => l.top), [100, 130])
})

// —— 离流装饰件裁剪：块盒子 333–517，标题折叠三角绝对定位在 311–327 ——
const hbox = { left: 333, right: 517 }
const htext = { top: 49, bottom: 87, left: 333, right: 517 }
const htoggle = { top: 65, bottom: 81, left: 311, right: 327 }

t('折叠三角整块落在正文左侧外：裁掉后标题只占一行', () => {
  assert.deepStrictEqual(clipToBox([htext, htoggle], hbox), [htext])
  assert.strictEqual(mergeLineTops(clipToBox([htext, htoggle], hbox)).length, 1)
})

t('标题下内边距变大、三角落到行盒下方时仍不叠两个号', () => {
  const low = { top: 95, bottom: 111, left: 311, right: 327 }
  assert.strictEqual(mergeLineTops(clipToBox([htext, low], hbox)).length, 1)
})

t('贴右边框的零宽把手裁掉，通栏图片和正文矩形保留', () => {
  const grip = { top: 60, bottom: 76, left: 517, right: 517 }
  const img = { top: 40, bottom: 200, left: 333, right: 517 }
  const kept = clipToBox([img, grip, htext], hbox)
  assert.ok(kept.includes(img) && kept.includes(htext) && !kept.includes(grip))
})

t('行号开关：显式关才关，缺键 / 读不到都算开', () => {
  assert.strictEqual(lineNumbersOn({ lineNumbers: false }), false)
  assert.strictEqual(lineNumbersOn({ lineNumbers: true }), true)
  assert.strictEqual(lineNumbersOn({}), true) // 老 settings.json 没有该键
  assert.strictEqual(lineNumbersOn(null), true)
  assert.strictEqual(lineNumbersOn(undefined), true)
})

console.log(`\nwysiwyg-gutter: ${pass} passed, ${fail} failed`)
process.exit(fail ? 1 : 0)