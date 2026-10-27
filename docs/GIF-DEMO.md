# 界面演示动图

仓库里的功能演示动图分两条录制路线：

| 路线 | 覆盖界面 | 录制方式 |
| --- | --- | --- |
| 网页版 | 编辑器、文件树、命令面板、主题、分栏 | 脚本驱动 headless Chrome 逐帧抓取 |
| 桌面版 | 托盘、原生菜单、Git、系统对话框 | 手动录屏后转 GIF |

网页版的画面来自 `web` 分支的网页沙盒，抓帧脚本放在主干 `examples/gif-demo/`。脚本只是录制工具，不参与任何构建，也不把网页版产物带进主干。

## 一、网页版：脚本抓帧

### 1. 准备前后端

```bash
git fetch origin web
git worktree add .others/web-gif origin/web
cd .others/web-gif
```

前端依赖与主工作区共用同一份 `src/package.json`，把已安装的目录直接链过来即可（主工作区没装过依赖的话，先在仓库根执行 `npm --prefix src ci`）：

```bash
cp -al ../../src/node_modules src/node_modules
npm --prefix server install
npm i --no-save puppeteer-core
```

`--no-save` 只把抓帧用的 `puppeteer-core` 装进 `node_modules`，不改 `package.json`。抓帧还需要本机 Chrome 与 ffmpeg（`brew install ffmpeg`）。

### 2. 构建并起服务

```bash
npm run web:build
node server/serve.mjs --sandbox --port 1477 --host 127.0.0.1
```

`--sandbox` 让每个浏览器会话拿到一份独立工作区：演示库从 `server/default-vault` 现灌一份，页面关掉约三分钟后整份回收。重复录制之间不互相污染，帧里也不会残留上一场的输入。

### 3. 抓一个场景

从仓库根把脚本拷进工作树，再按场景名运行：

```bash
mkdir -p .others/web-gif/capture
cp examples/gif-demo/*.mjs .others/web-gif/capture/
cd .others/web-gif
node capture/shoot.mjs theme-switch
```

产物在 `/tmp/nl-gif/<场景名>/`：`frames/*.png` 是原始帧，`<场景名>.gif` 是编码结果，默认 800 宽；第二个参数可以改宽度。

### 4. 现有场景

#### 输入即渲染 `wysiwyg-typing`

![输入即渲染](img/demo/wysiwyg-typing.gif)

标题走快捷键，正文里的 `**重点**`、`*强调*`、`#project`、`$E=mc^2$`、`[[wiki-links]]` 在语法落定时直接换成富文本，不用切预览。

#### 双链补全 `wikilink-suggest`

![双链补全](img/demo/wikilink-suggest.gif)

敲 `[[` 弹出候选，继续打字按名称过滤，回车插入链接节点。

#### 命令面板 `command-palette`

![命令面板](img/demo/command-palette.gif)

裸词搜文档；前缀 `>` 切成命令模式，选中「Markdown 源码模式」后整篇切到源码态。

#### 正文与源码互切 `source-toggle`

![正文与源码互切](img/demo/source-toggle.gif)

源码态里补一段 Markdown，切回正文时按规则渲染成标题与列表。

#### 主题轮换 `theme-switch`

![主题轮换](img/demo/theme-switch.gif)

浅色、暗黑、Dracula、跟随系统四态，按顺序循环。

#### 富文本渲染 `rich-render`

![富文本渲染](img/demo/rich-render.gif)

代码高亮、块级公式、Mermaid 流程图、表格逐段滚过。

#### 分栏 `split-panes`

![分栏](img/demo/split-panes.gif)

把一个窗格拆成两个，左右各自开文档、各自滚动。

### 5. 加新场景

场景写在 `scenarios.mjs`，`shoot.mjs` 提供操作原语：`type`、`press`、`click`、`clickText`、`scroll`、`wait`、`js`。约定只有一条：画面必须由真实输入事件产生，不直接改 DOM、不调应用内部函数。

几条实测下来容易踩的：

- 空格与换行必须走真实按键。`keyboard.type` 对它们的实现会退化成 `Input.insertText`，挂在 `handleTextInput` 上的行内规则收不到，画面里只剩字面量。
- 快捷键写 `Meta+…`。headless Chrome 在 macOS 上把 `Mod` 解析成 Meta；这个版本的 puppeteer 不认 `Meta+1` 这种连写，`press` 里已拆成按下修饰键、敲主键、松开。
- 边打边变的只有行内规则：`#tag`（标签字符限 ASCII）、`$公式$`、`[[双链]]`、`**粗**` 一类强调。行首没有 `# `、`- ` 这样的标题与列表规则，标题要用快捷键或斜杠菜单。
- 打开文档、切换主题之后留 600 到 900 毫秒再抓，否则拿到的是过渡中的一帧。
- screencast 只在画面变化时推帧。脚本按每帧的 screencast 时间戳写一份 concat 清单交给 ffmpeg，静止停留才不会被压成闪帧。
- 网页沙盒没有插件目录，开库时后端会回一条 desktop-only 拒绝，提示条会糊在画面底部。脚本在抓帧前用一行 CSS 藏掉 `#nl-web-toasts`，其余界面元素不动。
- 知识图谱在网页沙盒里打不开：后端索引状态里的库根是 `/private/var/...`，前端比较的是 `/var/...`，两串对不上，`state.indexReady` 一直为假，入口只回一句「索引尚未就绪」。这一项留给桌面版。
- 网页工作树落后主干时，主干新加的功能不会出现在画面里。录制新一轮之前先把主干合进 `web`（方向允许，见 `docs/SERVER.MD`），重新 `npm run web:build`。

## 二、桌面版：手动录屏

### 0. 先确认屏幕录制权限

系统设置 → 隐私与安全性 → 屏幕录制，给发起录制的应用（终端或 Qoder）打开开关，按提示重启该应用。

没这个授权时，`screencapture` 全屏只拿到壁纸和左侧菜单，`-l <窗口ID>` 直接报 `could not create image from window`，`-v` 录像报 `capture error`。这不是窗口在别的桌面空间，授权之后同样区域就能录到。

Computer Use 的截图策略是 AX_ONLY，`getAppState` 只回一张空白占位图，所以 CU 适合读控件树、点按钮，像素仍要靠系统录屏。

### 1. 录

macOS 自带录屏：`⌘⇧5` → 录制所选部分 → 录完存成 `.mov`。

- 录制前把应用切到前台，选区对准窗口。
- 录制选项里打开「显示鼠标指针」，点击类操作才有可读性。
- 同一个功能的多段动图用同一窗口尺寸，拼在文档里才不会忽大忽小。

### 2. 转 GIF

```bash
ffmpeg -y -i note-lume.mov \
  -vf "fps=10,scale=800:-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=128:stats_mode=diff[p];[s1][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle" \
  -loop 0 note-lume.gif
```

这条滤镜链与网页版共用：先按 10 fps 抽帧、缩到 800 宽，再生成 128 色调色板做差分抖动。画面以静态为主时把 `fps` 降到 6，或者把宽度压到 760。

### 3. 桌面版镜头清单

| 镜头 | 操作 | 画面要点 |
| --- | --- | --- |
| 托盘 | 点菜单栏图标，选一项快捷操作 | 弹出菜单与勾选态 |
| 原生菜单 | 打开「段落」或「文件」菜单 | 右侧快捷键提示 |
| Git | 右侧 Git 面板刷新、暂存、提交 | 状态与提交记录 |
| 知识图谱 |「更多」菜单 → 知识图谱 | 力导向图与悬停信息 |
| 剪藏 | 浏览器扩展图标 → 整页剪藏 | 剪完入库的文档 |

## 三、放进 README

配图路径保持裸路径：

```markdown
![命令面板](img/demo/command-palette.gif)
```

不要在路径上追加尺寸后缀。带尺寸后缀的图片行在 Gitee 与 GitHub 上可能整行退化成纯文本，GIF 尤其明显。README 里有注释掉的动图占位（`img/qd-demo.gif`），启用时同样写裸路径。

动图放在 `docs/img/demo/`，引用时不再往上跳层。应用里按单文件打开这份文档时，库根就是 `docs/`，`../` 会逸出库根被路径守卫拒掉，画面只剩「未找到图片」；写在 `docs/` 之内时，单文件打开与整目录打开都能解析。
