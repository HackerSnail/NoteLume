# 网页剪藏 v2：Defuddle 提取、图片本地化可选、frontmatter 规范化、高亮模板

- 日期：2026-10-21
- 基础：[`2026-10-21-web-clip-design.md`](2026-10-21-web-clip-design.md)（v1，已实现并推送）。v1 的架构不变：扩展 POST 到本机 HTTP 服务（只绑 127.0.0.1，Origin + Host 两道来源闸门、无令牌），Rust 按模板落盘、自动关联、emit `nl:clip-saved`，设置走 settings.json 的 `clip` 段
- 本文只写 v1 之上的增量与对齐项

## 1. 提取链路：四级优先级

同批注入 isolated world，按优先级降级：

1. **Defuddle**（新增）：`new Defuddle(doc).parse()`。正文提取比 Readability 稳，元数据全（`author` `description` `site` `published` `domain` `title` `wordCount`）。返回的 `content` 是 HTML 字符串，照旧过 Turndown 转 md
2. **Readability + Turndown**（现有）：Defuddle 抛错、`content` 为空、`wordCount < 120` 时降级
3. **手动选区**（现有）：`selection` 模式优先于 1/2——用户划了什么就存什么，提取器不参与
4. **整页 HTML 兜底**（现有，但改为默认关）：1/2 都失败时，按设置 `clip.fullPageFallback`（默认 false）决定报「提取失败」还是退化 `document.body`。整页噪声最多，不作默认行为

Defuddle 依赖已就位：`extension/vendor/defuddle.js` 取 npm 包 `defuddle@0.19.5` 的 `dist/index.js`（包自带的 UMD 浏览器包，全局名 `Defuddle`，无外部依赖，339KB），从 npm registry tarball 提取，`parse()` 返回结构按包内 README 核对过。注入顺序 `defuddle.js → Readability.js → turndown.js → extract.js`（UMD 顶层声明在 isolated world 共享，与 Readability 同机制）。

`content/extract.js` 的 metaInfo 改两级：Defuddle / Readability 结果里的 `author` `description` `site` `published` 优先，`og:*` / `article:*` / `keywords` 作兜底（Defuddle 的 `site` 为空时回落 og:site_name，再回落 location.hostname）。

## 2. 落盘格式：frontmatter 规范化

内置 article 模板的 frontmatter 换成：

```yaml
---
title: {{title}}
source: {{url}}
author: {{author}}
published_at: {{published_at}}
clipped_at: {{clipped_at}}
tags: [{{tags}}]
template: {{template}}
---
```

- `clipped_at`：本地时区 ISO 8601， chrono `Local::now().format("%Y-%m-%dT%H:%M:%S%:z")`
- `published_at`：页面给了才填，没给留空串
- `tags`：第一项默认 `clip`（设置 `clip.defaultClipTag` 可关），页面关键词接在后面；`{{tags}}` 变量语义不变（逗号分隔）
- `template`：本次实际使用的模板名（`article` / `highlight` / 用户模板主名），方便日后按来源模板检索
- 模板变量与 frontmatter key 同名：`{{clipped_at}}` `{{published_at}}` `{{template}}`。`render_template` 的变量名正则 `[A-Za-z0-9_]+` 已允许下划线，不用改
- 默认模板移除旧变量 `{{site}}` `{{published}}` `{{clipped}}`（`{{site}}` 保留给 highlight 模板的引用行用）。用户 `Templates/` 里的旧模板自行迁移，Rust 不做自动改写

## 3. 图片：本地化从「总是」改为可选

v1 每次剪藏都让扩展把图 fetch 成 data URI，剪藏变慢。v2 改成开关：

- NoteLume 设置新增 `clip.localizeImages`，默认 false：保留原链接，剪藏快
- `/health` 响应加 `localizeImages` 字段；扩展每次剪藏前 `GET /health` 读这个开关（localhost 轻请求）
- 开关 true 才走 v1 的取图链路（data URI、单图 5MB / 最多 30 张、`assets/` 内容去重、markdown URL 改写为 `./assets/`）；false 时载荷 `images` 传空数组，Rust 完全不碰图，正文保留 `https://` 原链接
- 设置面板加一行勾选 + hint；五个语言文件补 `clip.localizeImages` 与 hint 词条

## 4. 模板：article + highlight 两个内置模板

- 选择逻辑：`cfg.template_rel` 非空（用户显式选过）优先；否则 `clipType === 'selection'` 用 highlight，其余用 article
- article：v1 默认模板升级 frontmatter（见 §2）
- highlight：正文与整页剪藏拉开观感，来源行进引用块：

```markdown
---
（同 article 的 frontmatter，template: highlight）
---

# {{title}}

> 摘录自 [{{site}}]({{url}})

{{content}}
```

具体形态实现时可调；关键是选区剪藏落盘后一眼能看出是摘录。

## 5. 端口与端点

保持 `127.0.0.1:3210`（可配，占用顺延）。推荐链路里的 19827 只是示例值，不改成默认——已发布的文档与用户配置都写着 3210。

## 6. 状态提示契约（把固现状写成契约）

- 成功：通知标题「已剪藏到 NoteLume」，正文 `标题 → rel（n 张图，关联 m 篇）`，图片段只在本地化开启且 n > 0 时出现
- 失败：按错误码给分类提示，与 `extension/README.md` 的对照表一致——连不上（应用没开 / 服务没启用 / 地址不对）、没开库（409）、超限（413）、提取失败（两级提取器都空且兜底关着）、无选区（选了剪藏选中内容但页面上没划选）、超时（15s）

## 7. 明确不做

- 剪藏后自动建议归档位置（本地小模型 / 外部 API）：MVP 不上，先把「剪藏 → 落盘 → 可检索」跑通。现有文末「## 相关笔记」是本地索引打分，与归档建议是两件事，保持不变
- Defuddle 的 full bundle（含 temml / mathml-to-latex，320KB+）：不上，core 包够用
- 用户旧模板自动迁移、旧剪藏文件 frontmatter 回填：不动历史文件

## 8. 落地检查单

标注 [已实现] 的是 v1 已推送的部分，其余为 v2 新增：

- [已实现] 本地 HTTP 服务 `/clip` `/health`、Origin + Host 闸门、模板落盘、assets 图片链路、自动关联、设置面板、`nl:clip-saved` 事件刷新、扩展三入口
- [已实现] Readability + Turndown、选区剪藏、整页退化（v2 改为默认关）、图片 data URI 链路（v2 改为开关控制）
- [已实现] vendor/defuddle.js 就位（0.19.5 UMD，339KB）
- v2 新增：Defuddle 一级提取与降级链、metaInfo 两级取值
- v2 新增：frontmatter 新字段（`published_at` `clipped_at` `template`）、`clipped_at` 本地时区 ISO 8601、`clip.defaultClipTag`
- v2 新增：`clip.localizeImages` 设置、`/health` 下发、扩展读取与开关行为
- v2 新增：highlight 内置模板与 clipType 选择逻辑
- v2 新增：`clip.fullPageFallback` 设置（默认 false）
- 文档：CLAUDE.MD「网页剪藏」节同步提取优先级与 frontmatter 字段；README 两节用法更新（图片本地化默认关）；CHANGELOG 记一条

## 9. 风险

- Defuddle 0.19.5 的 UMD 包 339KB，与 Readability 同批注入，注入耗时增加约一次脚本解析；实测剪藏端到端延迟应仍在百毫秒级，超时上限 15s 不动
- `localizeImages` 默认关后，剪藏文件里的外链图在离线 / 防盗链场景会裂图——这是默认换速度的代价，设置里一行勾选可改，文档要写明
- frontmatter 字段改名后，依赖旧字段（`site` / `published` / `clipped`）的用户模板与外部工具链会读不到新值；只在新模板用新字段，旧文件不动
