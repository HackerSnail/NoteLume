// shoot.mjs —— 网页版界面演示的逐帧抓取器
//
// 用法： node capture/shoot.mjs <场景名> [宽度]
// 产物： /tmp/nl-gif/<场景名>/frames/*.png 与 <场景名>.gif
//
// 帧来源是 CDP Page.startScreencast：它只在画面真的变化时推帧，所以打字、滚动这类
// 连续动作能拿到密集帧，静止等待期间不产垃圾帧。每帧带 screencast 元数据时间戳，
// 抓完按时间戳还原停留时长，见下方 concat 清单。

import { mkdir, writeFile, rm } from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { scenarios } from './scenarios.mjs'

const run = promisify(execFile)
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
const URL_ = process.env.NL_URL || 'http://127.0.0.1:1477/'
const OUT = '/tmp/nl-gif'
const GIF_FPS = 10

const name = process.argv[2]
const width = Number(process.argv[3] || 800)
const scenario = scenarios[name]
if (!scenario) {
  console.error(`未知场景：${name}\n可选：${Object.keys(scenarios).join(', ')}`)
  process.exit(1)
}

const dir = `${OUT}/${name}`
await rm(dir, { recursive: true, force: true })
await mkdir(`${dir}/frames`, { recursive: true })

const browser = await puppeteerLaunch()
const page = await browser.newPage()
await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 2 })
await page.goto(URL_, { waitUntil: 'networkidle2', timeout: 60000 })
await page.waitForSelector('.ProseMirror', { timeout: 30000 })
await page.evaluate(() => document.fonts.ready)
// 网页沙盒没有插件目录，开库时会回一条 desktop-only 拒绝；那条提示只属于运行环境，
// 会糊在演示画面底部，抓图前统一藏掉。其余界面元素一概不动。
await page.addStyleTag({ content: '#nl-web-toasts{display:none!important}' })
await wait(800)

const session = await page.createCDPSession()
let frameNo = 0
const frames = [] // { file, ts }：ts 来自 screencast 元数据，用来还原真实停留时长
let pendingWrites = Promise.resolve()
session.on('Page.screencastFrame', (f) => {
  const p = `${dir}/frames/${String(frameNo).padStart(4, '0')}.png`
  const ts = f.metadata && f.metadata.timestamp ? f.metadata.timestamp : Date.now() / 1000
  frameNo += 1
  frames.push({ file: p, ts })
  pendingWrites = pendingWrites.then(() => writeFile(p, Buffer.from(f.data, 'base64')))
  session.send('Page.screencastFrameAck', { sessionId: f.sessionId }).catch(() => {})
})
await session.send('Page.enable')
await session.send('Page.startScreencast', { format: 'png', everyNthFrame: 1, maxWidth: 1280, maxHeight: 800 })

const ctx = makeCtx(page)
try {
  await scenario(ctx)
} catch (e) {
  console.error(`场景 ${name} 执行失败：`, e)
}
await wait(400)
await session.send('Page.stopScreencast').catch(() => {})
await browser.close()
await pendingWrites
console.log(`抓取 ${frames.length} 帧`)
if (frames.length < 3) process.exit(2)

// screencast 只在画面变化时推帧，帧间没有固定间隔。按元数据时间戳给每帧换算停留
// 时长（上限 2s，收尾给 1s），拼成 concat 清单交给 ffmpeg——静止片段才不会被压成闪帧。
const concat = `${dir}/frames.txt`
const lines = []
for (let i = 0; i < frames.length; i++) {
  const next = frames[i + 1]
  const dur = next ? Math.min(2, Math.max(0.02, next.ts - frames[i].ts)) : 1
  lines.push(`file '${frames[i].file}'`, `duration ${dur.toFixed(3)}`)
}
lines.push(`file '${frames[frames.length - 1].file}'`) // concat 末帧需要重复一次才不被截断
await writeFile(concat, lines.join('\n'))

const gif = `${dir}/${name}.gif`
await run('ffmpeg', [
  '-y', '-f', 'concat', '-safe', '0', '-i', concat,
  '-vf', `fps=${GIF_FPS},scale=${width}:-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=128:stats_mode=diff[p];[s1][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle`,
  '-loop', '0', gif,
])
const { stdout } = await run('du', ['-h', gif])
console.log('GIF：', gif, stdout.trim())

function wait(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

async function puppeteerLaunch() {
  const { default: puppeteer } = await import('puppeteer-core')
  return puppeteer.launch({
    executablePath: CHROME,
    headless: 'new',
    args: ['--disable-sync', '--no-first-run', '--disable-features=Translate', '--hide-scrollbars'],
  })
}

// 场景脚本用的操作原语：全部走真实事件（键盘 / 鼠标），不直接改 DOM，
// 这样抓到的画面就是用户手点出来的效果
function makeCtx(page) {
  return {
    wait,
    async type(text, opts) {
      for (const ch of text) {
        // 空格与换行必须走真实按键：puppeteer 对它们会退化成 Input.insertText，
        // 而行内输入规则（#tag / $公式$ / [[双链]]）挂在 handleTextInput 上，收不到就只剩字面量
        if (ch === ' ') await page.keyboard.press('Space')
        else if (ch === '\n') await page.keyboard.press('Enter')
        else await page.keyboard.type(ch, opts)
        await wait(ch === '\n' ? 260 : 90)
      }
    },
    async press(key) {
      // 这个版本的 puppeteer 不认 'Meta+1' 这种连写：自己拆修饰键逐层按下去
      const parts = key.split('+')
      const main = parts.pop()
      for (const m of parts) await page.keyboard.down(m)
      await page.keyboard.press(main)
      for (const m of [...parts].reverse()) await page.keyboard.up(m)
      await wait(200)
    },
    async click(sel) {
      const el = await page.waitForSelector(sel, { visible: true, timeout: 15000 })
      const box = await el.boundingBox()
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 8 })
      await wait(120)
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
      await wait(260)
    },
    async clickText(sel, text) {
      const el = await page.evaluateHandle((s, t) => {
        return [...document.querySelectorAll(s)].find((e) => e.textContent.trim().includes(t)) || null
      }, sel, text)
      const box = await el.boundingBox()
      if (!box) throw new Error(`未找到可见的 ${sel} 含「${text}」`)
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2)
      await wait(300)
    },
    async js(fn, ...args) {
      return page.evaluate(fn, ...args)
    },
    async scroll(sel, to, ms = 1400) {
      await page.evaluate(
        async (s, t, d) => {
          const el = document.querySelector(s)
          const from = el.scrollTop
          const start = performance.now()
          await new Promise((res) => {
            const step = (now) => {
              const k = Math.min(1, (now - start) / d)
              el.scrollTop = from + (t - from) * (k < 0.5 ? 2 * k * k : 1 - (1 - k) ** 2)
              k < 1 ? requestAnimationFrame(step) : res()
            }
            requestAnimationFrame(step)
          })
        },
        sel, to, ms,
      )
      await wait(200)
    },
  }
}
