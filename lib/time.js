/**
 * 本地时间格式化。
 *
 * 教训：`toISOString()` 是 UTC。这台机器在东八区，直接用它会把晚上六点显示成上午十点。
 * 所有面向人和文件的时间都走这里，只有日志/协议里才允许 UTC。
 */

/** YYYY-MM-DD HH:mm（本地） */
export function stamp(ts = Date.now()) {
  const d = new Date(Number(ts) || Date.now())
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

/** YYYY-MM-DD（本地） */
export function day(ts = Date.now()) {
  const d = new Date(Number(ts) || Date.now())
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** YYYY-MM（本地），归档目录用 */
export function month(ts = Date.now()) {
  return day(ts).slice(0, 7)
}
