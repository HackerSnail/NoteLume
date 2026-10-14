// source-sync.js —— 「进入源码模式时展示哪份文本」的纯判定（无 DOM / 无依赖，可 Node 单测）
//
// 语义（对应"贴近原文"）：自上次同步以来 WYSIWYG 未改动过模型、且握有原始字节时，
// 直接展示逐字节原文；否则（模型已被改过）回退到重新序列化的文本。
export function resolveSourceText({ modelDirty, rawSource, serialized }) {
  return !modelDirty && rawSource != null ? rawSource : serialized
}
