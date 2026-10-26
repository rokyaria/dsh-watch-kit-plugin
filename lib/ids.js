/** watch id、时间戳与确定性抖动。零 IO，便于单测。 */

/** watch id：小写字母开头，2–40 位，小写字母/数字/连字符。 */
export const WATCH_ID_RE = /^[a-z][a-z0-9-]{1,39}$/

/** @returns 是否是合法的 watch id。 */
export function isValidWatchId(id) {
  return typeof id === 'string' && WATCH_ID_RE.test(id)
}

function pad2(value) {
  return String(value).padStart(2, '0')
}

/** 本地时区的日期串（YYYY-MM-DD），用于日志文件命名。 */
export function localDayStamp(date = new Date()) {
  const value = date instanceof Date ? date : new Date(date)
  return `${value.getFullYear()}-${pad2(value.getMonth() + 1)}-${pad2(value.getDate())}`
}

/** 稳定 32 位哈希（FNV-1a）。 */
export function hash32(text) {
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

/** 每个 watch 的确定性抖动 ±10%，避免同一秒扎堆检查。 */
export function jitterFactor(id) {
  return ((hash32(String(id)) % 21) - 10) / 100
}

/** 下一次到期时间：完成时刻 + INTERVAL ×（1 + 抖动）。 */
export function nextDueAt(startedAtMs, intervalSec, id) {
  return Math.round(startedAtMs + Number(intervalSec) * 1000 * (1 + jitterFactor(id)))
}

/** ISO 时间戳（UTC），用于状态与帧。 */
export function nowIso(ts = Date.now()) {
  return new Date(ts).toISOString()
}
