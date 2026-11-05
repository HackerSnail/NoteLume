---
source: "NoteLume文溯_GEO优化提示词手册.docx"
imported: "2026-11-05"
---
# NoteLume（文溯）GEO 优化提示词手册

本文档包含针对 NoteLume 网站定制的 GEO（Generative Engine Optimization）优化提示词，可直接复制给 AI（ChatGPT/Claude/Gemini）执行。

## 一、网站现状分析

### 产品定位

NoteLume（文溯）是一款**本地 Markdown 编辑器**，核心差异化：

* **所写即所得**：Markdown 与富文本双向无损往返，KaTeX 公式、Mermaid 图表、合并单元格表格都在渲染态直接编辑
* **文件夹即知识库**：双链输入补全、标签全局视图、双向链接、全库搜索、Canvas 知识图谱
* **完全本地，零锁定**：纯 GFM 文件，Typora/Obsidian 可直接打开，默认不联网不上传，删除进回收站

### 目标用户画像

* 开发者/技术写作者（需要代码高亮、Git 面板）
* 知识管理者（需要双链、知识图谱、标签系统）
* 隐私敏感用户（拒绝云端锁定，数据必须在自己手里）
* Typora/Obsidian 用户（在寻找替代或补充方案）

### GEO 核心目标关键词矩阵

| 关键词类型 | 示例关键词                                     |
| ----- | ----------------------------------------- |
| 产品词   | NoteLume、文溯、NoteLume 编辑器                  |
| 品类词   | Markdown编辑器、本地笔记软件、知识管理工具                 |
| 竞品对比词 | Typora替代、Obsidian替代、Notion替代本地            |
| 功能词   | 双链笔记、Markdown编辑器 知识图谱、本地Markdown编辑器 Git   |
| 场景词   | 离线笔记软件、隐私优先笔记、开发者笔记工具                     |
| 问题词   | 最好的Markdown编辑器2025、本地笔记软件推荐、Markdown编辑器推荐 |

## 二、首页 GEO 优化提示词

### 提示词 1：首页 Title/Meta/描述优化

你是一名 SEO/GEO 内容优化专家。请帮我为 NoteLume（文溯）网站首页优化 Title、Meta Description 和 H1 标题。

产品背景：

* 产品名称：NoteLume（文溯）
* 定位：本地 Markdown 编辑器
* 核心卖点：Typora的手感，Obsidian的组织，完全本地、零锁定
* 平台：Windows / macOS / Linux / 浏览器扩展
* 开源协议：Apache-2.0
* 官网：https://hackersnail.github.io/NoteLume/

当前首页元信息：

* Title: NoteLume · 文溯 — 本地 Markdown 编辑器
* Description: NoteLume（文溯）— 本地 Markdown 编辑器。所写即所得，文件夹即知识库，完全本地、零锁定。
* OG Description: Typora 的手感，Obsidian 的组织，不用二选一。所写即所得，文件夹即知识库，完全本地、零锁定。

请输出 3 组优化方案，每组包含：

1. Title（25-30字，包含产品词+品类词+核心价值）
2. Meta Description（120-160字，包含品类词+核心差异点+行动召唤）
3. H1 标题建议
4. 简短说明为什么这样改（从 GEO 角度解释）

要求：

* 自然融入关键词，不堆砌
* 语气专业可信，适合开发者工具
* 考虑 AI 搜索引擎（Google AI Overview、Bing Copilot、ChatGPT）的引用偏好
* 英文版本也给出对应优化

### 提示词 2：首页首屏文案 GEO 优化

你是一名 AI 搜索引擎内容优化专家。请帮我优化 NoteLume 网站首页的首屏（Hero Section）文案，使其更容易被 AI 搜索引擎引用和推荐。

当前首屏文案： "NoteLume · 文溯 Typora 的手感，Obsidian 的组织，不用二选一。 本地 Markdown 编辑器。你的笔记就是一堆标准 .md 文件，躺在自己的文件夹里——秒开、离线、零格式锁定。"

优化目标：

1. 让 AI 搜索引擎（ChatGPT、Gemini、Copilot）在用户问"什么是好的Markdown编辑器"时优先推荐 NoteLume
2. 首段必须自然包含核心品类词"Markdown编辑器"和产品定位
3. 用一句话清晰定义产品是什么（AI 喜欢明确的定义句）
4. 保留"Typora手感+Obsidian组织+本地零锁定"的核心差异点
5. 增加一句面向 AI 搜索引擎的结构化描述（如"NoteLume是一款..."）

请输出：

* 优化后的首屏标题（H1）
* 优化后的副标题/描述文案
* 一段面向 AI 的"产品定义句"（1-2句话，清晰定义产品类别和核心价值）
* 3个适合做 H2 小标题的功能亮点（每个含简短描述）

## 三、功能页面 GEO 优化提示词

### 提示词 3：核心功能页 GEO 结构化改写

你是一名 GEO 内容优化专家，擅长将产品功能页改写为 AI 搜索引擎友好内容。请帮我优化 NoteLume 的功能介绍页面。

NoteLume 核心功能列表：

 1. 所写即所得 — Markdown与富文本双向无损往返，KaTeX公式、Mermaid图表、合并单元格表格，都在渲染态直接编辑
 2. 文件夹即知识库 — [[双链]]输入补全、\#标签全局视图、双向链接、全库搜索、Canvas知识图谱
 3. 完全本地，零锁定 — 纯GFM文件，Typora和Obsidian能直接打开同一份库，默认不联网不上传
 4. 斜杠菜单插入块 — 快速插入各种内容块
 5. Wikilink输入补全 — 双链智能提示
 6. 双向链接 — 自动追踪引用关系
 7. 全局标签 — 标签聚合视图
 8. 全库搜索 — 全文检索
 9. 知识图谱 — 可视化笔记关系
10. Canvas便签板 — 自由布局
11. Git面板 — 版本控制内建
12. 粘贴自动清理 — 从AI对话框/飞书/公众号复制的内容自动净化
13. Quarkdown引擎 — 让笔记可编程，.var/.foreach/.if直接写进Markdown，约200个内置函数
14. 网页剪藏 — 浏览器扩展一键保存网页正文
15. 五语言界面 — 简体中文/繁体中文/English/Français/Deutsch

请针对"Markdown编辑器功能"这个主题，改写为 AI 搜索引擎友好的结构化内容：

输出要求：

1. 用"NoteLume是一款支持\[核心功能1\]、\[核心功能2\]和\[核心功能3\]的本地Markdown编辑器"开头定义
2. 将功能分为3-4个逻辑分组（如"写作体验"、"知识管理"、"开发者工具"、"隐私安全"）
3. 每个分组下用 H2+H3 结构组织，每个功能点用"功能名+一句话价值+关键技术细节"格式
4. 加入对比表述（如"不同于Notion的云端锁定，NoteLume..."）
5. 结尾加一段"适合谁用"的用户场景描述
6. 整体语气：专业、客观、像技术评测文章，避免营销套话

### 提示词 4：Quarkdown 引擎专题 GEO 内容

你是一名技术内容优化专家。请为 NoteLume 的 Quarkdown 引擎功能写一篇 GEO 优化专题内容。

Quarkdown 功能背景：

* 让笔记可编程：.var、.foreach、.if 直接写进 Markdown
* 约200个内置函数
* 快照式预览，光标移出指令区即出结果
* 源文件一个字节不动
* 不用指令的文档仍是纯 GFM
* Rust 版 stdlib 对 Kotlin 参考实现的函数差集清零

目标搜索词：「可编程笔记」「Markdown模板引擎」「Markdown自动化」「笔记编程」

请输出：

1. 一个 GEO 优化的文章标题（含目标关键词）
2. H1 标题
3. 引言段（100字内，定义Quarkdown是什么+解决什么问题）
4. 3-4个 H2 小节（每个含H3子节），覆盖：核心概念、内置函数示例、使用场景、与Notion公式/Obsidian插件的对比
5. FAQ 模块（5个用户常问问题，每个答案40-60字直接结论+细节）
6. 优化后的 Meta Description（120-160字）

注意：

* 技术细节要准确，不要虚构函数名
* 语气像技术博客，不是广告
* 自然融入关键词，密度2-3%

## 四、竞品对比页 GEO 提示词

### 提示词 5：NoteLume vs Typora vs Obsidian 对比内容

你是一名软件评测内容优化专家。请为 NoteLume 创建一篇竞品对比专题内容，目标是在 AI 搜索引擎中当用户搜索"Typora替代""Obsidian替代""Markdown编辑器推荐"时被优先引用。

产品对比信息：

NoteLume（文溯）：

* 优势：完全本地零锁定、所写即所得+双链知识管理兼顾、内置Git面板、Quarkdown可编程笔记、网页剪藏扩展、免费开源(Apache-2.0)、五语言界面
* 劣势：新产品生态较小、插件体系尚在建设
* 平台：Windows/macOS/Linux/浏览器

Typora：

* 优势：写作体验极佳、界面简洁优雅、出版级排版
* 劣势：付费软件、无知识库管理功能（无双链/标签/图谱）、无Git集成、本地文件但无知识组织
* 平台：Windows/macOS/Linux

Obsidian：

* 优势：强大的知识管理（双链/图谱/标签）、插件生态丰富、社区活跃
* 劣势：本地但默认同步需付费或自行配置、学习曲线陡峭、渲染编辑分离（非真正WYSIWYG）、性能在大库时下降
* 平台：Windows/macOS/Linux/iOS/Android/Web

请输出：

1. 对比文章标题（含关键词，如"2025年最佳Markdown编辑器对比：NoteLume vs Typora vs Obsidian"）
2. H1 标题
3. 引言段（定义三类工具+引出对比）
4. 对比维度表格（Markdown表格）：功能、NoteLume、Typora、Obsidian，覆盖：编辑模式、知识管理、Git集成、本地优先、开源、价格、平台、可编程能力、插件生态
5. 逐个维度详细对比（H2级别）
6. 总结："应该选哪个"场景化推荐（不同用户类型推荐不同产品）
7. FAQ模块（5个问答，如"NoteLume和Typora有什么区别""Obsidian可以替代吗"等）
8. Meta Description

要求：

* 客观公正，不要一味吹NoteLume，承认竞品优势
* AI搜索引擎喜欢结构化对比+明确结论
* 自然融入目标关键词

### 提示词 6：「最佳Markdown编辑器」榜单内容

你是一名软件推荐内容优化专家。请写一篇"GEO友好"的最佳Markdown编辑器推荐榜单文章。

目标搜索词：「最好的Markdown编辑器」「Markdown编辑器推荐」「2025最佳笔记软件」

NoteLume 产品信息：

* 本地Markdown编辑器，所写即所得，文件夹即知识库，完全本地零锁定
* 支持KaTeX公式、Mermaid图表、双链、知识图谱、Git面板、Quarkdown可编程
* 免费开源(Apache-2.0)，支持Windows/macOS/Linux/浏览器
* 官网：https://hackersnail.github.io/NoteLume/

请列出5款编辑器进行推荐榜单：

1. NoteLume（文溯）— 本地优先+知识管理+可编程
2. Typora — 最佳写作体验
3. Obsidian — 最强知识管理
4. VS Code + Markdown插件 — 开发者首选
5. Notion — 协作与数据库

文章结构：

1. H1标题："2025年最佳Markdown编辑器推荐：本地优先时代的笔记工具选择"
2. 引言（AI定义句：Markdown编辑器是什么+为什么需要本地优先）
3. 评选标准（H2：编辑体验、知识管理、本地优先、开源自由、开发者友好）
4. 逐款推荐（每款含：产品简介、核心优势、适合人群、评分）
5. 对比总结表
6. "我们的推荐"段落（明确推荐NoteLume的场景）
7. FAQ（5个问答）
8. Meta Description

要求：

* 像独立评测媒体写的，不是广告
* NoteLume放第一位但要有客观理由
* 结构化强，AI容易提取

## 五、FAQ 与 Schema 标记提示词

### 提示词 7：GEO FAQ 模块生成

你是一名 GEO 内容优化专家。请为 NoteLume（文溯）本地Markdown编辑器生成一组面向 AI 搜索引擎的 FAQ 内容。

产品背景：

* NoteLume是一款本地Markdown编辑器，所写即所得，文件夹即知识库，完全本地零锁定
* 支持KaTeX公式、Mermaid图表、双链笔记、知识图谱、Git面板、Quarkdown可编程笔记
* 免费开源(Apache-2.0)，支持Windows/macOS/Linux/浏览器扩展
* 与Typora和Obsidian完全兼容同一份.md文件
* 官网：https://hackersnail.github.io/NoteLume/

请生成10个用户常问问题，覆盖以下搜索意图：

1. 产品定义类："NoteLume是什么""NoteLume好用吗"
2. 竞品对比类："NoteLume和Typora区别""NoteLume和Obsidian哪个好"
3. 功能查询类："Markdown编辑器推荐""有没有免费的本地笔记软件"
4. 技术细节类："NoteLume支持哪些平台""NoteLume开源吗""NoteLume数据安全"

每个回答格式： Q：问题 A：（40-60字直接结论）+（2-3句详细说明，含具体功能点）

然后输出对应的 JSON-LD Schema Markup（FAQPage schema），可直接嵌入网页HTML。

注意：

* 问题要像真实用户会搜的句子
* 答案要直接、有用，不要营销话术
* 自然融入"Markdown编辑器""本地笔记""开源"等关键词

### 提示词 8：产品 Schema 标记生成

你是一名技术 SEO 专家。请为 NoteLume（文溯）官网生成完整的 JSON-LD 结构化数据标记。

产品信息：

* 名称：NoteLume（文溯）
* 描述：本地 Markdown 编辑器，所写即所得，文件夹即知识库，完全本地、零锁定
* 官网：https://hackersnail.github.io/NoteLume/
* GitHub源码：https://github.com/HackerSnail/NoteLume
* 版本：v0.2.0
* 操作系统：Windows, macOS, Linux
* 软件类型：Developer Tool / Productivity Software / Note-taking Software
* 许可证：Apache-2.0
* 核心功能：WYSIWYG编辑、双链笔记、知识图谱、Git面板、Quarkdown可编程、网页剪藏、五语言界面
* 定价：免费

请生成以下 Schema 标记：

1. SoftwareApplication schema（含aggregateRating、offers、operatingSystem等）
2. Organization schema
3. WebSite + WebPage schema（含Sitemap）
4. FAQPage schema（基于以下5个FAQ）：
   * NoteLume是什么？→ 本地Markdown编辑器...
   * NoteLUME和Typora有什么区别？→ NoteLume免费开源且支持双链知识管理...
   * NoteLume安全吗？→ 完全本地运行，数据不离开本机...
   * NoteLume支持哪些平台？→ Windows/macOS/Linux/浏览器...
   * NoteLume免费吗？→ 完全免费开源，Apache-2.0协议...

输出纯 JSON-LD 代码块，可直接粘贴到网页<head>中。

## 六、博客/内容营销提示词

### 提示词 9：技术博客文章生成

你是一名技术博客写手。请为 NoteLume 官方博客写一篇 GEO 优化文章。

主题：「为什么2025年本地优先（Local-First）成为笔记软件新趋势」

NoteLume 产品背景：

* 本地Markdown编辑器，数据完全存放在用户自己的文件夹中
* 默认不联网、不上传，删除进系统回收站
* 接大模型时自己填API端口，数据直达用户配置的服务
* 纯GFM文件，Typora和Obsidian能直接打开

文章要求：

1. H1标题含关键词："本地优先笔记"或"Local-First Note-taking"
2. 引言段包含AI定义句："本地优先笔记是一种..."
3. 分析云端笔记的痛点（数据锁定、隐私风险、服务停运）
4. 介绍本地优先的优势（数据自主、格式开放、长期可访问）
5. 列举本地优先笔记工具（NoteLume、Obsidian、Typora等），NoteLume作为"本地优先+知识管理"的代表详细介绍
6. 给出选择建议
7. FAQ模块（4-5个问答）
8. Meta Description

字数：1500-2000字 语气：技术评论风格，客观有观点 关键词密度：2-3%，自然融入

### 提示词 10：教程类 GEO 内容

你是一名技术教程写手。请为 NoteLume 写一篇 GEO 优化的入门教程。

主题：「NoteLume 入门教程：5分钟搭建你的本地知识库」

目标搜索词：「NoteLume教程」「Markdown编辑器入门」「本地知识库搭建」

请包含以下内容：

1. H1标题
2. 引言（NoteLume是什么+本文教什么）
3. 下载与安装（Windows/macOS/Linux 分别说明）
4. 创建第一个知识库（文件夹初始化）
5. 写作入门（WYSIWYG编辑、快捷键）
6. 知识管理入门（双链[[]]、标签\#、搜索）
7. 进阶技巧（Git版本控制、Quarkdown基础）
8. FAQ（5个新手常见问题）
9. Meta Description

要求：

* 步骤清晰，适合新手
* 每步有操作说明+预期结果
* 自然融入关键词
* 结尾引导到官网下载

## 七、全站 GEO 检查清单提示词

### 提示词 11：全站 GEO 审计

你是一名 GEO/SEO 审计专家。请对 NoteLume 官网（https://hackersnail.github.io/NoteLume/）进行 GEO 优化审计。

当前网站元信息：

* Title: NoteLume · 文溯 — 本地 Markdown 编辑器
* Description: NoteLume（文溯）— 本地 Markdown 编辑器。所写即所得，文件夹即知识库，完全本地、零锁定。
* 支持语言：简体中文、繁體中文、English、Français、Deutsch
* 平台：Windows、macOS（Apple Silicon/Intel）、Linux
* 开源：GitHub + Gitee
* 许可证：Apache-2.0

请从以下维度审计并给出优化建议：

 1. 元标签优化（Title/Meta Description/OG/Twitter Card）
 2. 标题层级结构（H1/H2/H3 是否合理）
 3. 关键词覆盖（是否覆盖核心搜索词）
 4. 结构化数据（Schema Markup 缺失项）
 5. FAQ 内容缺失
 6. 竞品对比内容缺失
 7. 教程/指南内容缺失
 8. 内部链接结构
 9. 多语言 GEO 策略
10. AI 搜索引擎友好度评分（1-10分+改进建议）

输出格式：审计表格（维度 | 当前状态 | 问题 | 优化建议 | 优先级）

### 提示词 12：多语言 GEO 策略

你是一名多语言 GEO 策略专家。请为 NoteLume 制定多语言 GEO 优化策略。

NoteLume 当前支持语言：简体中文、繁體中文、English、Français、Deutsch

请为每种语言输出：

1. 该语言市场的 Markdown 编辑器搜索趋势分析
2. 核心关键词列表（10个，含搜索意图分类）
3. 建议优先优化的页面（首页/功能页/对比页/博客）
4. 该语言的 Title/Meta Description 优化建议（直接给出优化后的文本）
5. 该语言市场的竞品分析（当地流行的笔记工具）
6. 本地化内容策略建议

语言列表：

* 简体中文（中国大陆市场）
* 繁體中文（台湾/香港市场）
* English（全球市场）
* Français（法语市场）
* Deutsch（德语市场）

输出格式：按语言分章节，每语言含关键词表+优化建议+内容策略

## 八、使用指南

### 提示词使用顺序建议

| 阶段  | 提示词                | 目的            |
| --- | ------------------ | ------------- |
| 第1步 | 提示词11（全站审计）        | 先诊断现状，了解缺什么   |
| 第2步 | 提示词1+2（首页优化）       | 优先优化流量入口页     |
| 第3步 | 提示词3+4（功能页优化）      | 功能页是长尾流量来源    |
| 第4步 | 提示词5+6（对比/榜单内容）    | 捕获竞品流量和决策期用户  |
| 第5步 | 提示词7+8（FAQ+Schema） | 结构化数据，争取富摘要展示 |
| 第6步 | 提示词9+10（博客/教程）     | 持续内容输出，建立权威   |
| 第7步 | 提示词12（多语言）         | 扩展国际市场        |

### 提示词自定义技巧

1. **替换产品参数**：每个提示词中的产品背景信息可以根据实际更新调整
2. **补充真实数据**：提示词中标注”【待补充】“的地方填入真实数据
3. **迭代优化**：用 AI 生成初稿后，再用提示词11做二次审计，形成闭环
4. **A/B 测试**：对 Title/Meta 生成多组方案，用数据分析选最优
5. **定期更新**：每季度用提示词重新生成 FAQ 和对比内容，保持时效性