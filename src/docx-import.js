// docx-import.js —— Word(.docx) → Markdown 批量导入编排（功能项 I·P1）
// 纯逻辑 + I/O 依赖注入：preview / commit / 去重索引读写 / 校对回调 均可注入，
// 因此在 Node 下用假 io 即可单测队列状态机、去重索引合并、frontmatter/标题派生。
//
// 真实装配（main.js）注入：
//   io.preview(args)  → bridge.docxPreview(args)
//   io.commit(args)   → bridge.docxCommit(args)
//   io.loadIndex()    → localStorage['nl-img-index']（JSON → {hash:relPath}）
//   io.saveIndex(i)   → localStorage['nl-img-index'] = JSON.stringify(i)
//   io.onCommitted()  → 刷树 renderTree + startIndexPolling
//   review(entry, ctx)→ 打开校对模态，返回 { action:'accept'|'skip', md, newTitle }

export const IMG_INDEX_KEY = 'nl-img-index'
export const DEFAULT_MAX_IMAGE_BYTES = 8 * 1024 * 1024 // 8MB：超此图片占位 + warning（I spec §7）

// ============ 队列构造 ============

/**
 * 把来源列表建成初始队列。
 * @param {Array<{srcPath?:string, file?:File, displayName?:string}>} sources
 * @returns {Array} 每项 { id, source, status:'queued', md, plannedDocRel, title, warnings, stats, images }
 */
export function buildQueue(sources) {
  return (sources || []).map((source, i) => ({
    id: 'q' + i,
    source,
    status: 'queued', // queued → previewing → reviewing → committed | skipped | failed
    error: null,
    preview: null,
    result: null,
  }))
}

// ============ 来源 → preview 参数 ============

/**
 * 由一个来源 + 运行选项拼 docx_preview 的 args（camelCase，对齐 Rust DocxPreviewArgs）。
 * 对话框来源走 srcPath；拖拽来源（浏览器 File 无绝对路径）走 fileBase64 + displayName。
 * @param {object} source
 * @param {object} opts  { destDir, dedupIndex, withFrontmatter, maxImageBytes, fileBase64 }
 */
export function previewArgsFor(source, opts = {}) {
  const destDir = opts.destDir || ''
  const base = {
    srcPath: source.srcPath || '',
    destDir,
    titleOverride: source.titleOverride ?? null,
    dedupIndex: opts.dedupIndex || {},
    withFrontmatter: opts.withFrontmatter !== false, // 默认开
    maxImageBytes: opts.maxImageBytes || DEFAULT_MAX_IMAGE_BYTES,
    srcB64: source.srcB64 || null,
    srcDisplayName: source.displayName || null,
  }
  return base
}

// ============ preview.images → commit.images 映射 ============

/** 只转不写回来的 ImportedImage[] 转成落库用的 CommitImage[]（reused 的仍交 Rust 判定去重） */
export function commitImagesFrom(previewImages) {
  return (previewImages || []).map((im) => ({
    sha256: im.sha256,
    ext: im.ext,
    dataB64: im.dataB64,
    plannedRel: im.plannedRel,
  }))
}

// ============ 去重索引合并 ============

/** 把 commit 回来的 updatedIndex 并入运行期 dedupIndex（就地 + 返回同一对象，跨条累积） */
export function mergeIndex(target, updated) {
  if (updated && typeof updated === 'object') {
    for (const [k, v] of Object.entries(updated)) target[k] = v
  }
  return target
}

// ============ 编排：runImport ============

/**
 * 顺序处理队列：逐个 preview → review（校对模态）→ 接受则 commit。
 * 任何一条 preview/commit 失败或校对跳过都记录状态、不阻断后续。
 * @param {object} params
 * @param {Array}  params.sources  buildQueue 的输入
 * @param {object} params.io       { preview, commit, loadIndex, saveIndex, onCommitted }
 * @param {(entry, ctx)=>Promise<{action,md?,newTitle?}>} params.review  校对回调
 * @param {(msg:string)=>void} [params.onProgress]
 * @param {object} [params.opts]   { destDir, withFrontmatter, maxImageBytes }
 * @returns {Promise<{ index, stats:{committed,skipped,failed,total} }>}
 */
export async function runImport({ sources, io, review, onProgress = () => {}, opts = {} }) {
  const queue = buildQueue(sources)
  const say = (m) => { try { onProgress(m) } catch { /* ignore */ } }

  // 运行期去重索引：优先注入的 opts.dedupIndex，否则从存储载入
  let index = opts.dedupIndex
    ? { ...opts.dedupIndex }
    : await safeLoadIndex(io)

  let committed = 0, skipped = 0, failed = 0

  for (let k = 0; k < queue.length; k++) {
    const entry = queue[k]
    say(`导入 ${k + 1}/${queue.length}`)

    // ---- 预览 ----
    let preview
    try {
      entry.status = 'previewing'
      const src = normalizeSource(entry.source)
      preview = await io.preview(previewArgsFor(src, { ...opts, dedupIndex: index }))
      entry.preview = preview
      if (!preview || typeof preview.md !== 'string') throw new Error('预览返回空')
    } catch (e) {
      entry.status = 'failed'
      entry.error = errText(e)
      failed++
      continue
    }

    // ---- 校对 ----
    let decision
    try {
      entry.status = 'reviewing'
      decision = await review(entry, {
        index: k,
        total: queue.length,
        dedupIndex: index,
        opts,
      })
    } catch (e) {
      entry.status = 'failed'
      entry.error = errText(e)
      failed++
      continue
    }

    if (!decision || decision.action !== 'accept') {
      entry.status = 'skipped'
      skipped++
      continue
    }

    // ---- 落库 ----
    try {
      entry.status = 'committing'
      const commitArgs = {
        vaultRoot: opts.vaultRoot,
        destDir: opts.destDir || '',
        md: decision.md != null ? decision.md : preview.md,
        docRel: preview.plannedDocRel,
        images: commitImagesFrom(preview.images),
        dedupIndex: index,
        newTitle: decision.newTitle ?? null,
      }
      const res = await io.commit(commitArgs)
      mergeIndex(index, res && res.updatedIndex)
      entry.result = res
      entry.status = 'committed'
      committed++
      if (io.onCommitted) { try { await io.onCommitted(res, entry) } catch { /* ignore */ } }
    } catch (e) {
      entry.status = 'failed'
      entry.error = errText(e)
      failed++
      continue
    }
  }

  // 持久化运行期累积的去重索引
  if (io.saveIndex) { try { await io.saveIndex(index) } catch { /* ignore */ } }

  return { index, queue, stats: { committed, skipped, failed, total: queue.length } }
}

// ============ 小 helper ============

/** 归一化来源：把 File→{ srcB64, displayName } 的转换留给调用方（异步 FileReader 不在此），
 *  这里只保证有 srcPath 或 srcB64 之一。调用方（main.js）在 buildQueue 前把 File 预转 srcB64。*/
function normalizeSource(source) {
  return source || {}
}

async function safeLoadIndex(io) {
  if (io && io.loadIndex) {
    try {
      const loaded = await io.loadIndex()
      if (loaded && typeof loaded === 'object') return { ...loaded }
    } catch { /* ignore */ }
  }
  return {}
}

function errText(e) {
  if (!e) return '未知错误'
  if (typeof e === 'string') return e
  return e.message || String(e)
}
