# 界面演示动图

仓库里的功能演示动图分两条录制路线：

| 路线 | 覆盖界面 | 录制方式 |
| --- | --- | --- |
| 网页版 | 编辑器、文件树、命令面板、主题、分栏 | 脚本驱动 headless Chrome 逐帧抓取 |
| 桌面版 | 托盘、原生菜单、Git、知识图谱、右键菜单、拖入打开 | 脚本合成鼠标键盘操作，系统录屏后裁切转 GIF |

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

## 二、桌面版：脚本驱动 + 系统录屏

桌面版没有网页版那套沙盒和 CDP。画面来自系统录屏，操作由脚本合成真实的鼠标键盘事件完成，镜头每次重跑都走同一条时间轴。

### 0. 先确认屏幕录制权限

系统设置 → 隐私与安全性 → 屏幕录制，给发起录制的应用（终端或 Qoder）打开开关，按提示重启该应用。

没这个授权时，`screencapture` 全屏只拿到壁纸和左侧菜单，`-l <窗口ID>` 直接报 `could not create image from window`，`-v` 录像报 `capture error`。这不是窗口在别的桌面空间，授权之后同样区域就能录到。

Computer Use 的截图策略是 AX_ONLY，`getAppState` 只回一张空白占位图，所以 CU 适合读控件树、点按钮，像素仍要靠系统录屏。

### 1. 准备演示库

另开一份示例库副本，在里面 `git init`，提交身份设成中性名字，录制过程产生的提交与编辑都落在这份副本里。不要用日常使用的库：托盘「打开最近」列的是本机真实笔记名，这些标题会原样出现在画面里。快照目录也在副本里，随手 `gitignore` 掉，免得「变更」面板被自动备份刷满。

录制前用 AX 把窗口挪到固定原点。桌面上如果有常驻浮层，裁切窗口时会带进来。

### 2. 驱动界面

两条通道配合使用：

- AX 按名字找控件、读数、`AXPress`。网页视图里的工具栏按钮、检查器、输入框都能读到。
- CGEvent 合成鼠标点击、拖拽、滚轮和键盘。悬停、快捷键这类操作 AX 给不了，只能合成。

菜单栏是例外：原生菜单项的坐标读出来是负值，改成截图量菜单栏条目的横坐标，再按固定偏移点下去。

坐标不能缓存。保存一次快照之后，检查器里的历史列表会变长，下面所有按钮整体下移；每次点击前现量一遍再点。

合成快捷键时要把修饰键的 `flagsChanged` 事件一起发。只给主键带 `maskCommand`，⌘ 会一直处于按下状态，后面本来要输入的文字会变成别的快捷键。

### 3. 录

```bash
screencapture -v -x -V 7 /tmp/cap.mov
```

- 视频模式按全屏尺寸、60 fps 持续录，光标一起进画面，点击类动图才有可读性。
- `-l <窗口ID>` 在视频模式下被忽略，`-C` 对单窗口抓图同样无效，所以一律录全屏，窗口区域留给 ffmpeg 裁。
- 不带 `-V` 会停下来等键盘输入，`SIGINT` 退出留下的是截断文件，时长接近一帧。

脚本里先起录像，再按时间轴发操作，最后等录像按设定时长结束。全屏录像的分辨率是点数两倍（Retina），`crop` 的坐标按像素算。

### 4. 裁切转 GIF

```bash
ffmpeg -y -ss 1.0 -to 6.0 -i /tmp/cap.mov \
  -vf "crop=500:400:400:0,fps=12,scale=800:-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=128:stats_mode=diff[p];[s1][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle" \
  -loop 0 desktop-menu.gif
```

`crop` 的四个参数依次是宽、高、x 偏移、y 偏移，单位是像素。先用一张同尺寸截图框出要保留的区域，量出坐标；`-ss` / `-to` 按操作时间轴前后各留半秒余量。

滤镜链与网页版一致：抽帧、缩到 800 宽、128 色调色板加差分抖动。菜单这类文字为主的画面，宽度压到 760 可以再省一点体积。

### 5. 现有镜头

#### 托盘菜单 `desktop-tray`

![托盘菜单](img/demo/desktop-tray.gif)

点菜单栏图标弹出快捷菜单：显示主窗口、新建笔记、打开最近、退出。左键点图标直接唤回窗口，右键才出菜单。

#### 原生菜单 `desktop-menu`

![原生菜单](img/demo/desktop-menu.gif)

「格式」菜单里的行内命令与右侧快捷键，悬停到哪一项就高亮到哪一项。

#### Git 面板 `desktop-git`

![Git 面板](img/demo/desktop-git.gif)

右侧检查器的「Git」分组：暂存全部改动、填提交说明、提交，提交记录随即多一行。

#### 知识图谱 `desktop-graph`

![知识图谱](img/demo/desktop-graph.gif)

悬停节点放大并高亮与该节点相连的边；按住节点拖动可改布局，松手后其余节点回稳；点节点直接跳到对应文档。滚轮缩放，空白处拖拽平移。

#### 右键菜单 `desktop-context`

![右键菜单](img/demo/desktop-context.gif)

两段镜头：右键文件树条目弹条目菜单（打开、在访达中显示、重命名 / 移动、移入回收站）；正文里选中一段再右键，弹的是编辑菜单（剪切 / 复制 / 粘贴、行内格式、块级插入、⌘qd 快捷插入、全选）。两处菜单都是自绘的同一套控件，打包版里压掉了 WebView 自带的原生右键菜单。

#### 拖入打开 `desktop-drop`

![拖入打开](img/demo/desktop-drop.gif)

从访达把文件拖进窗口，松手就在当前窗口打开这一篇，虚线框标出可接收的区域；把文件夹拖进来则另开一个窗口，把那个文件夹作为独立知识库打开，原窗口的库不受影响。

mac 打包版收不到 HTML5 的 `dragover` / `drop`：窗口层留着原生拖放接收器，事件只以 `tauri://drag-*` 的形式给到前端，且只带绝对路径。所以前端拿到路径后先问一次后端「这是文件还是目录」，再决定走打开还是另开窗口。Windows / Linux 打包版把这层拦截关掉（`dragDropEnabled: false`），收 HTML5 事件、路径由 WebView2 的 `File.path` 给出，落到的仍是同一套「拖入即打开」；纯网页构建没有接管，仍是拖入即导入。

### 6. 场地与镜头参数

- 常驻浮层（桌面宠物一类）不会随应用隐藏而消失，把演示窗口整体挪到浮层覆盖区之外，裁切框按窗口点坐标乘二取像素。
- 拖拽镜头的落点由 `elementFromPoint` 判定，入参是 CSS 像素，而原生事件给的是相对 webview 的物理像素，要先除 `devicePixelRatio`。
- 拖拽镜头放慢：按住之后分两段滑行，每段之间留一秒停顿，虚线高亮和拖拽提示才在抽帧后的 8 fps 里留得住。
- 两个窗口的镜头要留出级开后的落点：新窗口沿用来源窗口的尺寸，位置往右下各错 40 点，裁切框要同时罩住来源窗口、新窗口和访达。

## 三、放进 README

配图路径保持裸路径：

```markdown
![命令面板](img/demo/command-palette.gif)
```

不要在路径上追加尺寸后缀。带尺寸后缀的图片行在 Gitee 与 GitHub 上可能整行退化成纯文本，GIF 尤其明显。README 里有注释掉的动图占位（`img/qd-demo.gif`），启用时同样写裸路径。

动图放在 `docs/img/demo/`，引用时不再往上跳层。应用里按单文件打开这份文档时，库根就是 `docs/`，`../` 会逸出库根被路径守卫拒掉，画面只剩「未找到图片」；写在 `docs/` 之内时，单文件打开与整目录打开都能解析。
