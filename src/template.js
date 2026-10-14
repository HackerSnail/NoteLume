// template.js —— 模板变量替换 + 日期格式化（纯函数，无 DOM / 无依赖，可单测）
//
// 用途：
//  · 每日笔记 / 从模板新建时，把模板正文里的 {{token}} 替换为运行期值。
//  · 只认白名单 token（date/time/datetime/title/filename/weekday/year/month/day 等），
//    未知 token 原样保留（避免误伤 Obsidian Templater 之类插件的 {{...}}）。
//  · 替换结果仍是普通 markdown，写盘即标准文件，不引入私有语法。

const WEEKDAYS_ZH = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六']

function pad2(n) {
  return String(n).padStart(2, '0')
}

// formatDate(fmt, date)：支持 YYYY / YY / MM / M / DD / D / HH / mm / ss
// 注意大小写敏感：MM=月、mm=分；DD=日、HH=时(24)。用一次正则按最长优先替换，避免互相吃掉。
export function formatDate(fmt, date = new Date()) {
  const map = {
    YYYY: String(date.getFullYear()),
    YY: pad2(date.getFullYear() % 100),
    MM: pad2(date.getMonth() + 1),
    M: String(date.getMonth() + 1),
    DD: pad2(date.getDate()),
    D: String(date.getDate()),
    HH: pad2(date.getHours()),
    mm: pad2(date.getMinutes()),
    ss: pad2(date.getSeconds()),
  }
  return String(fmt).replace(/YYYY|YY|MM|M|DD|D|HH|mm|ss/g, (t) => map[t])
}

// builtinVars({ title, filename, now })：给 applyTemplate 用的默认可用变量集。
// title 不含扩展名；filename 含扩展名（如 2026-10-14.md）；两者缺省时按 now 推导。
export function builtinVars({ title = '', filename = '', now = new Date() } = {}) {
  return {
    title,
    filename,
    date: formatDate('YYYY-MM-DD', now),
    time: formatDate('HH:mm', now),
    seconds: formatDate('ss', now),
    datetime: formatDate('YYYY-MM-DD HH:mm', now),
    year: String(now.getFullYear()),
    month: pad2(now.getMonth() + 1),
    day: pad2(now.getDate()),
    weekday: WEEKDAYS_ZH[now.getDay()],
  }
}

// applyTemplate(text, vars)：把 {{key}}（允许两侧空格）替换为 vars[key]；未知 key 原样保留。
export function applyTemplate(text, vars = {}) {
  return String(text).replace(/\{\{\s*([A-Za-z0-9_]+)\s*\}\}/g, (whole, key) =>
    Object.prototype.hasOwnProperty.call(vars, key) ? String(vars[key]) : whole
  )
}
