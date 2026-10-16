// site-export.test.mjs —— 批次 C 整站导出：纯逻辑 + 渲染保真回归测试（无需浏览器 / Tauri）
// 运行：cd src && node tests/site-export.test.mjs
//
// 覆盖 spec §9 测试计划里前端可离线验证的部分：
//  链接重写（.md→.html、锚点、外部）、wikilink 解析落地 / 缺失降级、反链反推、
//  任务清单、callout / 数学 / tag / 嵌入图的渲染、图片镜像路径与资源收集、搜索索引构建、路径映射。

import assert from 'node:assert'
import {
  buildWikiLookup,
  buildBacklinks,
  buildSearchIndex,
  collectImages,
  rewriteMdLink,
  taskFixup,
  htmlToText,
  buildSidebar,
  buildBacklinksHtml,
  renderSite,
} from '../site-export.js'

let pass = 0, fail = 0
function check(name, fn) {
  try { fn(); console.log(`✅ ${name}`); pass++ }
  catch (e) { console.error(`❌ ${name}: ${e.message}`); fail++ }
}

// —— rewriteMdLink：.md→.html、带锚点、外部/锚点原样 ——
check('rewriteMdLink 换扩展名/保留锚点/外部不动', () => {
  assert.strictEqual(rewriteMdLink('a/b.md'), 'a/b.html')
  assert.strictEqual(rewriteMdLink('a/b.markdown'), 'a/b.html')
  assert.strictEqual(rewriteMdLink('a/b.md#sec'), 'a/b.html#sec')
  assert.strictEqual(rewriteMdLink('./note.md'), 'note.html') // ./ 前缀冗余，归一化去掉
  assert.strictEqual(rewriteMdLink('https://x.com/a.md'), 'https://x.com/a.md') // 外链不改
  assert.strictEqual(rewriteMdLink('#frag'), '#frag')
  assert.strictEqual(rewriteMdLink('img/pic.png'), 'img/pic.png') // 非 md 不改
})

// —— buildWikiLookup / buildBacklinks ——
const GRAPH = {
  docs: [
    { rel: 'Daily/a.md', title: 'A' },
    { rel: 'Notes/Note.md', title: '注' },
    { rel: 'b.md', title: 'B' },
  ],
  wiki: [
    { from: 'Daily/a.md', target: 'Note', to: 'Notes/Note.md' },
    { from: 'b.md', target: 'Note', to: 'Notes/Note.md' },
    { from: 'Daily/a.md', target: 'Ghost', to: null },
    { from: 'Notes/Note.md', target: 'Note', to: 'Notes/Note.md' }, // 自引用，反链应排除
  ],
}
check('buildWikiLookup 键为 from\\u0000target', () => {
  const m = buildWikiLookup(GRAPH)
  assert.strictEqual(m.get('Daily/a.md\u0000Note'), 'Notes/Note.md')
  assert.strictEqual(m.get('Daily/a.md\u0000Ghost'), null)
})
check('buildBacklinks 反推且排除自引用', () => {
  const bl = buildBacklinks(GRAPH)
  assert.deepStrictEqual(bl.get('Notes/Note.md'), ['Daily/a.md', 'b.md'])
  assert.ok(!bl.get('Notes/Note.md').includes('Notes/Note.md'), '不应包含自引用')
})

// —— renderSite：wikilink 解析落地 / 缺失降级为纯文本 ——
check('renderSite wikilink → 站内相对 .html', () => {
  const html = renderSite('参见 [[Note]]。', {
    selfRel: 'Daily/a.md', fromDir: 'Daily',
    wikiMap: buildWikiLookup(GRAPH),
  })
  assert.ok(/<a class="nl-wiki" href="\.\.\/Notes\/Note\.html">Note<\/a>/.test(html), html)
})
check('renderSite 带别名 wikilink 用别名文本', () => {
  const html = renderSite('[[Note|我的笔记]]', {
    selfRel: 'a.md', fromDir: '', wikiMap: new Map([['a.md\u0000Note', 'Notes/Note.md']]),
  })
  assert.ok(html.includes('我的笔记') && html.includes('Notes/Note.html'), html)
})
check('renderSite 解析失败 wikilink 降级不产坏链', () => {
  const html = renderSite('[[Ghost]]', { selfRel: 'a.md', fromDir: '', wikiMap: new Map() })
  assert.ok(/class="nl-wiki nl-wiki-missing"/.test(html), html)
  assert.ok(!html.includes('href='), '缺失链接不应带 href')
})

// —— renderSite：任务清单（紧/松两种）——
check('renderSite 任务清单转复选框', () => {
  const html = renderSite('- [x] 完成\n- [ ] 待办\n- 普通\n')
  assert.ok(/<li class="nl-task-item"><input type="checkbox" class="nl-task-box" checked disabled>/.test(html), html)
  assert.ok(/<li class="nl-task-item"><input type="checkbox" class="nl-task-box" disabled>/.test(html), html)
  assert.ok(html.includes('普通'), '普通项保留')
})

// —— renderSite：callout / 数学 / tag ——
check('renderSite callout 保真', () => {
  const html = renderSite('> [!WARNING] 注意\n> 正文')
  assert.ok(html.includes('nl-callout'), html)
  assert.ok(html.includes('nl-callout-warning'), html)
  assert.ok(html.includes('注意') && html.includes('正文'), html)
})
check('renderSite 折叠 callout 用 details', () => {
  const html = renderSite('> [!TIP]- 折叠\n> 内容')
  assert.ok(/<details class="nl-callout[^"]*nl-callout-fold"/.test(html), html)
  assert.ok(html.includes('</details>'), '折叠卡片应以 details 收尾')
})
check('renderSite 行内数学走 KaTeX', () => {
  const html = renderSite('公式 $e^{i\\pi}+1=0$ 结束')
  assert.ok(html.includes('katex'), html)
})
check('renderSite 块级数学', () => {
  const html = renderSite('$$\n\\int_0^1 x dx\n$$')
  assert.ok(html.includes('nl-math-block'), html)
})
check('renderSite tag 降级为文本锚点', () => {
  const html = renderSite('打标 #work 即可')
  assert.ok(/<span class="nl-tag">#work<\/span>/.test(html), html)
})

// —— 图片：普通 ![]() 与嵌入 ![[ ]] 解析、改写 href、收集拷贝清单 ——
check('renderSite 普通图片解析到镜像路径并登记资源', () => {
  const assets = new Set()
  const html = renderSite('![](assets/pic.png)', {
    selfRel: 'Daily/a.md', fromDir: 'Daily',
    imageSet: new Set(['assets/pic.png']),
    imgByBase: new Map([['pic.png', 'assets/pic.png']]),
    assets,
  })
  assert.ok(/src="\.\.\/assets\/pic\.png"/.test(html), html)
  assert.ok(assets.has('assets/pic.png'), '应登记库内真实 rel 供拷贝')
})
check('renderSite 嵌入 ![[图]] basename 回退', () => {
  const assets = new Set()
  const html = renderSite('![[Pic.PNG]]', {
    selfRel: 'x.md', fromDir: '',
    imageSet: new Set(['assets/Pic.PNG']),
    imgByBase: new Map([['pic.png', 'assets/Pic.PNG']]),
    assets,
  })
  assert.ok(/class="nl-embed"/.test(html), html)
  assert.ok(assets.has('assets/Pic.PNG'), '嵌入图应登记')
})
check('renderSite 找不到图片时降级不产坏链', () => {
  const html = renderSite('![[missing.png]]', { selfRel: 'x.md', fromDir: '', imageSet: new Set(), imgByBase: new Map(), assets: new Set() })
  assert.ok(/nl-wiki-missing/.test(html), html)
})

// —— collectImages：从树扁平化图片 rel + basename 索引 ——
check('collectImages 递归且只收图片', () => {
  const tree = {
    type: 'folder', name: '', path: '', children: [
      { type: 'f', name: 'a.md', path: 'a.md' },
      { type: 'folder', name: 'assets', path: 'assets', children: [
        { type: 'f', name: 'p.png', path: 'assets/p.png' },
        { type: 'f', name: 'q.jpg', path: 'assets/q.jpg' },
      ] },
    ],
  }
  const { images, byBase } = collectImages(tree)
  assert.deepStrictEqual(images.sort(), ['assets/p.png', 'assets/q.jpg'])
  assert.strictEqual(byBase.get('p.png'), 'assets/p.png')
})

// 回归：scan_vault 实际返回顶层数组（非合成根节点）——collectImages 必须能处理数组，
// 否则 imageSet 为空，导出（docx / 整站）会把所有图片误报「库内未找到」。
check('collectImages 兼容 scan_vault 返回的顶层数组', () => {
  const arr = [
    { type: 'f', name: 'a.md', path: 'a.md' },
    { type: 'f', name: 'root.png', path: 'root.png' },
    { type: 'folder', name: 'assets', path: 'assets', children: [
      { type: 'f', name: 'p.png', path: 'assets/p.png' },
      { type: 'folder', name: 'sub', path: 'assets/sub', children: [
        { type: 'f', name: 'q.jpeg', path: 'assets/sub/q.jpeg' },
      ] },
    ] },
  ]
  const { images, byBase } = collectImages(arr)
  assert.deepStrictEqual(images.sort(), ['assets/p.png', 'assets/sub/q.jpeg', 'root.png'])
  assert.strictEqual(byBase.get('q.jpeg'), 'assets/sub/q.jpeg')
})

// —— buildSearchIndex：rel → root 相对 href ——
check('buildSearchIndex href 换 .html', () => {
  const idx = buildSearchIndex([{ rel: 'Daily/a.md', title: 'A', text: 'hello' }])
  assert.strictEqual(idx[0].href, 'Daily/a.html')
  assert.strictEqual(idx[0].text, 'hello')
})

// —— htmlToText：去标签与实体 ——
check('htmlToText 去标签收拢空白', () => {
  const t = htmlToText('<p>粗 <b>体</b> &amp; 号</p>\n\n<script>x</script>')
  assert.ok(t.includes('粗') && t.includes('体') && t.includes('& 号'), t)
  assert.ok(!t.includes('<') && !t.includes('x'), '标签/脚本内容应清除')
})

// —— 侧栏 / 反链 HTML 片段 ——
check('buildSidebar 生成树并高亮当前页', () => {
  const html = buildSidebar(GRAPH.docs, 'Daily/a.md', 'Daily')
  assert.ok(html.includes('nl-nav-dir'), '应含目录')
  assert.ok(/class="nl-nav-item active"/.test(html), '当前页高亮')
  assert.ok(html.includes('href="../Notes/Note.html"'), '跨目录链接用相对路径')
})
check('buildBacklinksHtml 列出引用者', () => {
  const titleOf = (r) => ({ 'Daily/a.md': 'A', 'b.md': 'B' }[r] || r)
  const html = buildBacklinksHtml('Notes/Note.md', buildBacklinks(GRAPH), titleOf, 'Notes')
  assert.ok(html.includes('被这些文档引用'), html)
  assert.ok(html.includes('../Daily/a.html') && html.includes('../b.html'), html)
})
check('buildBacklinksHtml 无引用返回空串', () => {
  const html = buildBacklinksHtml('lonely.md', new Map(), () => 'x', '')
  assert.strictEqual(html, '')
})

// —— 标题锚点 id（批次 F 后续：与导入侧/编辑器同一套 slugAllInOrder，供 #锚点 内链可跳）——
check('renderSite 标题发 id（共享锚点 + 同文档重名 dedup）', () => {
  const md = ['# 第一章', '', '正文', '', '# 第一章', '', '## Foo Bar', '', '# 3.2 方法（一）'].join('\n')
  const html = renderSite(md, { __site: true, selfRel: 'x.md', fromDir: '' })
  assert.match(html, /<h1 id="第一章">/, html)
  assert.match(html, /<h1 id="第一章-1">/, html) // 重名第二个 → -1
  assert.match(html, /<h2 id="foo-bar">/, html)
  assert.match(html, /<h1 id="32-方法一">/, html) // 标点丢弃
})

// —— 交叉引用锚点（批次 F 后续）：非标题目标的 <a id> 应原样渲染（不被 html:false 转义），#id 内链可落 ——
check('renderSite 交叉引用锚点 <a id> 保真渲染', () => {
  const md = ['见 [52](#_Ref52)。', '', '<a id="_Ref52"></a>文献条目全文'].join('\n')
  const html = renderSite(md, { __site: true, selfRel: 'x.md', fromDir: '' })
  assert.ok(html.includes('<a id="_Ref52"></a>'), '锚点应原样渲染: ' + html)
  assert.ok(!html.includes('&lt;a id'), '锚点不应被转义为文本: ' + html)
  assert.ok(html.includes('href="#_Ref52"'), '引用应渲染为 #id 链接: ' + html)
})

console.log(`\n结果：${pass} passed, ${fail} failed`)
if (fail > 0) process.exit(1)
