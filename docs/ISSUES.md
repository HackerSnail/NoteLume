# Issue 清单：AI 面板与剪藏服务的输入边界

2026-11-02 已全部修复，下面是基线 `7fbc9b3` 的复现记录，保留作回归依据。改法：一、`resolveAnchorPos` 全等标题优先，无全等才退互相包含；二、`parseAgentReply` 严格匹配失败后仍识别并剥离 `<insert>` 标记，返回 `anchorBroken`，Agent 模式下面板出「落点标记无法识别」；三、新增 `validateAiConfig` / `isHttpUrl`，设置面板保存前拒绝超长与非法地址，`aiConfigured` 同步校验；四、`buildVaultContext` 表头计入 6000 预算并按剩余空间截断；五、端口注释与五语言文案统一为顺延 9 个。回归测试在 `src/tests/ai-tasks.test.mjs`（27 条），`npm run test:ai-tasks` 与 `test:i18n` 全过；Rust 侧 `cargo test --lib` 348 passed（2026-11-02 真实终端）。

前四条由 `src/ai-tasks.js` 的函数离线直跑复现，不起应用、不开浏览器；第五条是源码与文案对读，依据是 Rust 半开区间语义，端口占满那条路径没构造过。行号会随上游提交漂移，动手前先对一遍。

文末附完整复核脚本与实际输出，脚本放 gitignore 的 `tmp/` 下，不入库。

---

## 一、Agent 落点锚定到同前缀的长标题，全等标题被跳过

严重级别：一般　优先级：中　标签：`bug` `AI面板` `必现`

### 现象

Agent 模式的落点由回答开头的 `<insert after="位置">` 决定，「位置」引用文档里已有的标题原文。`src/ai-tasks.js:182` 的标题匹配条件是文本全等、互相包含三者取「或」，而 `src/ai-tasks.js:178` 的 `if (headingHit) return` 让第一个命中的标题直接定终身，全等项没有任何优先级。模型复述锚点时给出标题的前缀或子串是常见形态，于是内容被插进相邻的错误小节。

### 复现

见脚本第一段。文档块序为 `# 目标进阶写法与更多字` / 段落 / `# 目标` / 段落，target 取 `目标`：

```
before / after             [1,13]
落点所属块                  ["目标进阶写法与更多字","目标进阶写法与更多字"]
```

两个落点都落在长标题那一节，文本全等的《目标》从未被选中。

### 期望

存在文本全等标题时优先绑全等项，只有没有全等项时才退到互相包含匹配。

### 证据边界

函数级必现，已实跑。下游消费链（`src/ai-panel.js` 的 autoApply 到 `src/main.js` 的 insertAiMarkdown）是源码对读，界面没实跑过。

---

## 二、锚点目标超 120 字符或含双引号时 `insert` 标记漏进正文

严重级别：一般　优先级：中　标签：`bug` `AI面板` `输入校验` `必现`

### 现象

`src/ai-tasks.js:110` 的锚点正则把目标文本限死在 `[^"]{1,120}`。目标超 120 字符、或目标里带双引号时正则整体不匹配，`src/ai-tasks.js:111` 走 `anchor: null` 分支，此时标记文本不从 body 里剥离，会连同 `<insert after="…">` 一起写进用户文档。锚点引用的是文档原文，长段落与带引号的标题都会触达。

### 复现

见脚本第二段。`target=120` 正常返回锚点，`target=121` 与含双引号两种都拿不到锚点，且残留标记经 `mdParser.parse` 后仍在文档文本里：

```
target=120 anchor          true
target=121 anchor          null
target 含引号 anchor        null
残留进正文                  true
```

### 期望

识别不了锚点时把标记本身一并剥离，正文只保留模型要写的文字，并明确提示落点未识别。

### 证据边界

函数级与 markdown 解析级均已实跑，必现。

---

## 三、AI 设置对超长字段静默截断，接口地址无格式校验

严重级别：一般　优先级：中　标签：`bug` `AI设置` `易误判` `必现`

### 现象

`src/ai-tasks.js:81` 归一化用的是 `trim().slice()`：超上限直接截断，不报错也不提示。密钥被截短后送去鉴权只会收到 401，界面出「请求失败」，排查方向会被引到服务端，而实际是粘贴时多带了内容。同一函数对 `baseUrl` 没有任何格式校验，`not a url` 能存下，并被 `aiConfigured` 判为已配置。

### 复现

见脚本第三段。上限 300 取 299 / 300 / 301 三个位置：

```
apiKey 400 入 / 出          [400,300]
model 123 入 / 出           [123,120]
baseUrl 原样                "not a url"
aiConfigured               true
apiKey 299 出参             299
apiKey 300 出参             300
apiKey 301 出参             300
```

等于上限与略小原样保留，略大静默截断。

### 期望

超上限拒绝并提示可输入长度；非 `http(s)` 地址在保存时就报格式错误，不把损坏的密钥与无效地址带到请求阶段。

### 证据边界

函数级已实跑。设置面板输入框侧（`src/ai-settings.js`）是否另有校验没验。

---

## 四、全库检索注入文本的 6000 字符预算不含表头

严重级别：轻微　优先级：低　标签：`bug` `AI面板` `上下文预算` `必现`

### 现象

`src/ai-tasks.js:159` 先把表头塞进输出再判预算，且预算检查排在追加之前（`src/ai-tasks.js:161`），表头长度不参与 6000 的计算。表头偏长时输出直接超限，还可能一篇命中都装不下。

### 复现

见脚本第四段。5 篇各 400 字符的命中，表头分别取 5900 与 6100 字符：

```
head5900 长度 / 命中篇        [6313,1]
head6100 长度 / 命中篇        [6101,0]
```

前者超预算 313 字符且只装下 1 篇，后者一篇都没进。

### 期望

预算从表头之后起算、表头本身计入总量，超限部分截断，总长稳定不超过 6000。

### 证据边界

函数级已实跑。真实表头取自 `ai.vaultCtxHead` 文案，实际会不会触达那个长度没测。

---

## 五、剪藏端口占用提示比代码实际顺延数多报一个端口

严重级别：轻微　优先级：低　标签：`bug` `文案` `剪藏服务` `五种语言`

### 现象

`src-tauri/src/webclip.rs:982` 的 `for off in 0..10u16` 排除右端，共尝试 10 个端口，即配置端口加 9 个顺延。`src-tauri/src/ui_lang.rs:1018` 的文案「端口 {port} 及顺延的 10 个端口都被占用」声称试了 11 个，`src-tauri/src/webclip.rs:978` 的函数注释「顺延 +1 至多 10 个」同一口径；zh-CN / zh-Hant / en-US / fr-FR / de-DE 五条译文都跟着这个偏差。

### 复现

不需要起应用，仓库根执行：

```
sed -n '978,983p' src-tauri/src/webclip.rs
grep -n -A2 'clip.portBusy' src-tauri/src/ui_lang.rs
```

`for off in 0..10u16` 迭代 10 次（`checked_add` 溢出发 `break`，只会更少），对文案里的「及顺延的 10 个」即 11 个。

### 期望

文案与注释的端口数跟实际尝试次数一致：要么文案改成「及顺延的 9 个」，要么循环改成试 11 个。五种语言一起改。

### 证据边界

没有运行时实测。判定依据是 Rust 半开区间语义与源码对读，端口占满的触发路径没构造过。

---

## 附：复核脚本与实际输出

`tmp/issue-repro.mjs`，仓库根 `node tmp/issue-repro.mjs` 执行。

```js
// tmp/issue-repro.mjs —— docs/ISSUES.md 五条缺陷的一次性复核
// 跑法（仓库根）：node tmp/issue-repro.mjs
import { parseAgentReply, resolveAnchorPos, normalizeAiConfig, aiConfigured, buildVaultContext } from '../src/ai-tasks.js'
import { mdParser } from '../src/editor-schema.js'

const p = (k, v) => console.log(k.padEnd(26), JSON.stringify(v))

console.log('一、锚点绑到同前缀的长标题')
const doc1 = mdParser.parse(['# 目标进阶写法与更多字', '段落', '# 目标', '正文'].join('\n\n'))
const blocks = []
doc1.forEach((n, o) => blocks.push({ o, size: n.nodeSize, txt: n.textContent.slice(0, 12) }))
const b1 = resolveAnchorPos(doc1, { dir: 'before', target: '目标' })
const a1 = resolveAnchorPos(doc1, { dir: 'after', target: '目标' })
const owner = (pos) => {
  const k = blocks.find((x) => pos === x.o + 1 || pos === x.o + 1 + x.size)
  return k ? k.txt : '未对应'
}
p('before / after', [b1, a1])
p('落点所属块', [owner(b1), owner(a1)])

console.log('\n二、超长与含引号的锚点标记残留')
p('target=120 anchor', Boolean(parseAgentReply('<insert after="' + 'a'.repeat(120) + '">正文').anchor))
const r121 = parseAgentReply('<insert after="' + 'a'.repeat(121) + '">正文')
p('target=121 anchor', r121.anchor)
const q = parseAgentReply('x<insert after="say "hi"">y')
p('target 含引号 anchor', q.anchor)
const d2 = mdParser.parse(r121.body)
p('残留进正文', d2.textBetween(0, d2.content.size, '|').includes('<insert'))

console.log('\n三、配置截断与地址不校验')
const cfg = normalizeAiConfig({ baseUrl: 'not a url', apiKey: 'k'.repeat(400), model: 'm'.repeat(123) })
p('apiKey 400 入 / 出', [400, cfg.apiKey.length])
p('model 123 入 / 出', [123, cfg.model.length])
p('baseUrl 原样', cfg.baseUrl)
p('aiConfigured', aiConfigured(cfg))
for (const n of [299, 300, 301]) p(`apiKey ${n} 出参`, normalizeAiConfig({ apiKey: 'k'.repeat(n) }).apiKey.length)

console.log('\n四、注入预算不含表头')
const list = Array.from({ length: 5 }, (_, i) => ({ path: 'p' + i, title: 't' + i, snippet: 's'.repeat(400) }))
const v1 = buildVaultContext(list, 'H'.repeat(5900))
const v2 = buildVaultContext(list, 'H'.repeat(6100))
p('head5900 长度 / 命中篇', [v1.length, v1.split('\n').filter((l) => l.startsWith('- ')).length])
p('head6100 长度 / 命中篇', [v2.length, v2.split('\n').filter((l) => l.startsWith('- ')).length])

console.log('\n五、端口顺延数文案')
console.log('见 docs/ISSUES.md 的 sed / grep 两条，静态对读，本脚本不覆盖')
```

实际输出：

```
一、锚点绑到同前缀的长标题
before / after             [1,13]
落点所属块                      ["目标进阶写法与更多字","目标进阶写法与更多字"]

二、超长与含引号的锚点标记残留
target=120 anchor          true
target=121 anchor          null
target 含引号 anchor          null
残留进正文                      true

三、配置截断与地址不校验
apiKey 400 入 / 出           [400,300]
model 123 入 / 出            [123,120]
baseUrl 原样                 "not a url"
aiConfigured               true
apiKey 299 出参              299
apiKey 300 出参              300
apiKey 301 出参              300

四、注入预算不含表头
head5900 长度 / 命中篇          [6313,1]
head6100 长度 / 命中篇          [6101,0]

五、端口顺延数文案
见 docs/ISSUES.md 的 sed / grep 两条，静态对读，本脚本不覆盖
```
