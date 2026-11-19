// edit-state.js —— 右键菜单的「能不能编辑」口径
//
// 空窗格时 editor-view 的 setEditable(false) 把编辑器关成只读，源码态 CM 的 contenteditable
// 也被置成 false。右键菜单原先只看有没有选区来灰掉剪切 / 复制，粘贴与格式项无条件高亮，
// 点下去什么也粘不进。这里把判定收成纯函数，菜单和测试共用同一口径。

/** 窗格里是否真有可编辑的文档：没打开文档或编辑器已关成只读都算不能编辑。 */
export function canEditPane(rel, viewEditable) {
  return !!rel && viewEditable !== false
}

/** 输入框 / 源码 CM 这类右键目标是否只读。 */
export function isReadOnlyTarget(el) {
  return !!el && !!(el.disabled || el.readOnly || el.getAttribute('contenteditable') === 'false')
}
