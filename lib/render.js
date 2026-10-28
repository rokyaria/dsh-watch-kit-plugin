/**
 * 合并通知消息渲染：多 watch 合并 + 一次性投递失败补偿。
 * maxBytes 是用户配置的消息上限；实际布局与裁剪上限 = maxBytes + RENDER_HEADROOM_BYTES
 * （自留预算），让补偿段与事件在同一预算内尽量都放下。仍超出时优先保事件，必要时把
 * 该 watch 自己的补偿延后到下一轮。
 */

export const MAX_MERGED_ITEMS = 20
/** 渲染内部自留预算：布局与最终裁剪的实际上限 = 配置的 maxBytes + 该值。 */
export const RENDER_HEADROOM_BYTES = 4096
const MAX_BYTES = 16 * 1024
const MAX_COMPENSATIONS = 10
const ERROR_CHARS = 128
const COMPENSATION_HEADER = '[投递失败补偿]'

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
  if (!Number.isFinite(hours) || hours < 0.1) return '过去不到 0.1 小时'
  return `过去 ${hours.toFixed(1)} 小时`
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

function compensationRow(item, now) {
  const error = oneLine(item.error ?? '(无错误信息)', ERROR_CHARS)
  return `- ${item.id}：${hoursSpan(item.firstFailAt, now)}投递失败 ${item.count} 次，最后一次：${error}`
}

function compensationSummary(count) {
  return `…另有 ${count} 个 watch 的投递失败记录未列出（见 watch_runs）`
}

function eventSummary(count) {
  return `…另有 ${count} 个事件未列出（见 watch_runs）`
}

/**
 * 该 included 集合对应的完整补偿段（只列真正进入消息且未延后的 watch）。
 * 补偿段完整性优先：这里始终返回完整行，是否放得下由调用方按真实字节判断。
 * deferred 中的 watch 补偿被主动延后到下一轮，既不出补偿行也不计入补偿汇总。
 */
function fullCompensationSection(included, compensations, now, deferred = new Set()) {
  const visible = compensations.filter((item) => included.has(item.id) && !deferred.has(item.id))
  const rendered = visible.slice(0, MAX_COMPENSATIONS)
  const lines = []
  if (visible.length > 0) {
    lines.push(COMPENSATION_HEADER)
    for (const item of rendered) lines.push(compensationRow(item, now))
    if (visible.length > MAX_COMPENSATIONS) lines.push(compensationSummary(visible.length - MAX_COMPENSATIONS))
  }
  return {
    lines,
    renderedIds: rendered.map((item) => item.id),
    compensatedIds: visible.map((item) => item.id),
  }
}

/**
 * 核心渲染。除 includedIds/truncated 外，返回补偿段的记账信息：
 * - renderedCompensationIds：完整写出补偿行的 watch id；
 * - compensatedIds：所有被本次消息表示的补偿 watch id（含被「另有 N 个」汇总行覆盖的）；
 * - deferredCompensationIds：为保住事件而主动延后渲染补偿（下一轮再补偿）的 watch id，
 *   ⊆ includedIds 且与 compensatedIds 互斥、无重复。
 * 投递成功后只有 compensatedIds 覆盖的 watch 才允许清投递失败计数（见 poller）；
 * deferredCompensationIds 对应 watch 的失败计数必须保留。
 *
 * 预算规则：maxBytes 是用户配置的「可见上限」，实际布局与裁剪上限 byteLimit =
 * maxBytes + RENDER_HEADROOM_BYTES（自留预算），让补偿段与事件尽量同时放下；text 最多
 * 比 maxBytes 大 RENDER_HEADROOM_BYTES，且绝不超过 byteLimit。
 * 贪心接受 candidates：「补偿段优先完整、items 用剩余预算」——每个候选 item 都按 header +
 * 已接受 sections + 新 section + 该 included 集合对应的完整补偿段的真实字节数判断，放不下
 * 就丢弃后段而不是截断补偿段；无补偿时 items 可用满 byteLimit。
 *
 * 事件优先回退：候选 item 连同完整补偿段放不下、但「完整补偿段 + 标题」自身放得下时，先把
 * 该 watch 自己的补偿放进 deferred 再试一次——放得下就保事件、把它的补偿延后到下一轮，
 * 避免该 watch 每轮都被自身补偿挤掉；仍放不下才 break（保持补偿完整性优先）。deferred 对
 * 后续候选与最终渲染持续生效：补偿段与事件汇总 note 都不计入被延后的补偿行与补偿汇总数。
 *
 * @param {{items?: Array<{id:string, intervalMs:number, message:string, error?:string|null}>,
 *          compensations?: Array<{id:string,count:number,firstFailAt:number,error?:string|null}>,
 *          now?: number, maxItems?: number, maxBytes?: number}} input
 */
export function renderMergedMessageDetailed({
  items = [],
  compensations = [],
  now = Date.now(),
  maxItems = MAX_MERGED_ITEMS,
  maxBytes = MAX_BYTES,
} = {}) {
  const itemLimit = Math.max(1, Math.floor(Number(maxItems) || MAX_MERGED_ITEMS))
  // maxBytes 是用户可见上限；布局与最终裁剪统一使用加了自留预算的 effective 上限。
  const configuredByteLimit = Math.max(1024, Math.floor(Number(maxBytes) || MAX_BYTES))
  const byteLimit = configuredByteLimit + RENDER_HEADROOM_BYTES
  const header = `[WATCH 通知] ${items.length} 个事件`
  const includedIds = []
  const included = new Set()
  const sections = []
  const deferred = new Set()
  const hasCompensation = (id) => compensations.some((entry) => entry.id === id)

  // 当前已接受 sections + 候选 section + candidateIncluded 对应的完整补偿段。
  const candidateRender = (candidateIncluded, section, deferredSet) => {
    const compensation = fullCompensationSection(candidateIncluded, compensations, now, deferredSet)
    const bytes = byteLength([header, ...sections.flat(), ...section, ...compensation.lines].join('\n'))
    return { compensation, bytes }
  }

  for (const item of items) {
    if (includedIds.length >= itemLimit) break
    const section = itemSection(item)
    const candidateIncluded = new Set(included)
    candidateIncluded.add(item.id)

    const candidate = candidateRender(candidateIncluded, section, deferred)
    if (candidate.bytes <= byteLimit) {
      sections.push(section)
      includedIds.push(item.id)
      included.add(item.id)
      continue
    }
    // 「完整补偿段 + 标题」自身放得下，说明挤占预算的是 events 而不是补偿段本身：
    // 优先保事件，把该 watch 自己的补偿延后到下一轮。
    if (
      hasCompensation(item.id)
      && byteLength([header, ...candidate.compensation.lines].join('\n')) <= byteLimit
    ) {
      deferred.add(item.id)
      const retried = candidateRender(candidateIncluded, section, deferred)
      if (retried.bytes <= byteLimit) {
        sections.push(section)
        includedIds.push(item.id)
        included.add(item.id)
        continue
      }
      deferred.delete(item.id)
    }
    // 该 watch 没有补偿可延后，或延后补偿后仍放不下：保持补偿段完整，丢弃后段事件。
    break
  }

  const omitted = items.length - includedIds.length
  const omittedNote = omitted > 0 ? eventSummary(omitted) : null
  const fullCompensation = fullCompensationSection(included, compensations, now, deferred)
  const itemLines = [header, ...sections.flat()]
  const deferredCompensationIds = includedIds.filter((id) => deferred.has(id))

  // 贪心接受保证「已接受 sections + 完整补偿段」一定在 byteLimit 内；「另有 N 个事件未列出」
  // 只在其后仍放得下时追加。clipUtf8 仅作最后安全网（正常不会触发）。
  const withNote = omittedNote !== null
    && byteLength([...itemLines, omittedNote, ...fullCompensation.lines].join('\n')) <= byteLimit
  const lines = withNote ? [...itemLines, omittedNote] : itemLines
  return {
    text: clipUtf8([...lines, ...fullCompensation.lines].join('\n'), byteLimit),
    includedIds,
    truncated: omitted > 0,
    renderedCompensationIds: fullCompensation.renderedIds,
    compensatedIds: fullCompensation.compensatedIds,
    deferredCompensationIds,
  }
}

/**
 * 兼容旧调用：返回消息字符串。
 * @returns {string}
 */
export function renderMergedMessage({
  items = [],
  compensations = [],
  now = Date.now(),
  maxItems = MAX_MERGED_ITEMS,
  maxBytes = MAX_BYTES,
} = {}) {
  return renderMergedMessageDetailed({ items, compensations, now, maxItems, maxBytes }).text
}
