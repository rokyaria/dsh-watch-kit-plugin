/** 合并通知消息渲染：多 watch 合并 + 一次性投递失败补偿。 */

export const MAX_MERGED_ITEMS = 20
const MAX_BYTES = 16 * 1024
const MAX_COMPENSATIONS = 10
const ERROR_CHARS = 128
// 预留给补偿段，保证它不会被 items 截断掉（最多 10 行，每行错误 128 字符）。
const COMPENSATION_BUDGET = 4096

function byteLength(text) {
  return Buffer.byteLength(text, 'utf8')
}

function clipUtf8(text, maxBytes, suffix = '\n[truncated]') {
  const value = String(text ?? '')
  if (byteLength(value) <= maxBytes) return value
  const clipped = Buffer.from(value, 'utf8')
    .subarray(0, Math.max(0, maxBytes - byteLength(suffix)))
    .toString('utf8')
  return `${clipped.endsWith('\uFFFD') ? clipped.slice(0, -1) : clipped}${suffix}`
}

function oneLine(text, maxChars) {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim()
  if (value.length <= maxChars) return value
  return `${value.slice(0, maxChars)}…`
}

function hoursSpan(firstFailAt, now) {
  const hours = Math.max(0, Number(now) - Number(firstFailAt)) / 3_600_000
  if (!Number.isFinite(hours) || hours < 0.1) return '不到 0.1 小时'
  return `${hours.toFixed(1)} 小时`
}

function itemSection(item) {
  const lines = [
    `--- ${item.id}（interval=${Math.round(Number(item.intervalMs) / 1000)}s）---`,
    String(item.message).trim(),
  ]
  if (typeof item.error === 'string' && item.error.trim() !== '') {
    lines.push(`[error] ${item.error.trim()}`)
  }
  return lines
}

/**
 * 核心渲染。返回实际写入消息的 item id，供投递记账只标记真正被模型看到的事件。
 *
 * @param {{items?: Array<{id:string, intervalMs:number, message:string, error?:string|null}>,
 *          compensations?: Array<{id:string,count:number,firstFailAt:number,error?:string|null}>,
 *          now?: number}} input
 */
export function renderMergedMessageDetailed({ items = [], compensations = [], now = Date.now() } = {}) {
  const lines = [`[WATCH 通知] ${items.length} 个事件`]
  const includedIds = []
  const included = new Set()
  const itemBudget = MAX_BYTES - COMPENSATION_BUDGET

  for (const item of items) {
    if (includedIds.length >= MAX_MERGED_ITEMS) break
    const section = itemSection(item)
    const candidate = [...lines, ...section].join('\n')
    if (byteLength(candidate) > itemBudget) break
    lines.push(...section)
    includedIds.push(item.id)
    included.add(item.id)
  }

  const omitted = items.length - includedIds.length
  if (omitted > 0) {
    const note = `…另有 ${omitted} 个事件未列出（见 watch_runs）`
    if (byteLength([...lines, note].join('\n')) <= itemBudget) lines.push(note)
  }

  const visibleCompensations = compensations.filter((item) => included.has(item.id))
  if (visibleCompensations.length > 0) {
    lines.push('[投递失败补偿]')
    for (const item of visibleCompensations.slice(0, MAX_COMPENSATIONS)) {
      const error = oneLine(item.error ?? '(无错误信息)', ERROR_CHARS)
      lines.push(
        `- ${item.id}：过去${hoursSpan(item.firstFailAt, now)}投递失败 ${item.count} 次，最后一次：${error}`,
      )
    }
    if (visibleCompensations.length > MAX_COMPENSATIONS) {
      lines.push(`…另有 ${visibleCompensations.length - MAX_COMPENSATIONS} 个 watch 的投递失败记录未列出（见 watch_runs）`)
    }
  }

  return {
    text: clipUtf8(lines.join('\n'), MAX_BYTES),
    includedIds,
    truncated: omitted > 0,
  }
}

/**
 * 兼容旧调用：返回消息字符串。
 * @returns {string}
 */
export function renderMergedMessage({ items = [], compensations = [], now = Date.now() } = {}) {
  return renderMergedMessageDetailed({ items, compensations, now }).text
}
