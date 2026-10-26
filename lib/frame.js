/** 触发帧渲染：event / failure / batch。纯函数，便于单测。 */

import { clipUtf8, sanitizeText, sizeLabel, utf8Bytes } from './text.js'

const DEFAULT_MAX_EVIDENCE_BYTES = 8192

function messageText(message, fallback = '（message 为空）') {
  const value = sanitizeText(message).trim()
  return value === '' ? fallback : value
}

function evidenceSection(evidence, maxBytes) {
  const value = sanitizeText(evidence)
  if (value.trim() === '') return null
  const bytes = utf8Bytes(value)
  const clipped = clipUtf8(value, maxBytes, '\n[truncated]')
  return { text: clipped, label: `(${sizeLabel(bytes)}/${sizeLabel(maxBytes)})` }
}

/**
 * 单条事件帧。
 * @param {{id:string, at:string, rev:number, messageSource:'config'|'script',
 *          message:string, evidence?:string, logPath?:string}} item
 * @param {{maxEvidenceBytes?:number}} [options]
 */
export function renderEventFrame(item, { maxEvidenceBytes = DEFAULT_MAX_EVIDENCE_BYTES } = {}) {
  const lines = [
    `[WATCH TRIGGER] id=${item.id} reason=event at=${item.at} rev=${item.rev} message_source=${item.messageSource}`,
    '--- message ---',
    messageText(item.message),
  ]
  const evidence = evidenceSection(item.evidence, maxEvidenceBytes)
  if (evidence !== null) lines.push(`--- evidence ${evidence.label} ---`, evidence.text)
  if (item.logPath) lines.push('--- logs ---', item.logPath)
  lines.push('--- next ---', '按 message 执行；不要 re-arm（插件常驻轮询）。')
  return lines.join('\n')
}

/**
 * 单条失败帧。
 * @param {{id:string, at:string, failures:number, threshold:number,
 *          firstFailureAt?:string, lastFailureAt?:string, message:string,
 *          errorTail?:string, logPath?:string}} item
 */
export function renderFailureFrame(item) {
  const lines = [
    `[WATCH TRIGGER] id=${item.id} reason=failure failures=${item.failures}/${item.threshold}` +
      `${item.firstFailureAt ? ` first=${item.firstFailureAt}` : ''}` +
      `${item.lastFailureAt ? ` last=${item.lastFailureAt}` : ''}`,
    '--- message ---',
    messageText(item.message),
  ]
  const tail = sanitizeText(item.errorTail ?? '').trim()
  if (tail !== '') lines.push('--- error_tail ---', tail)
  if (item.logPath) lines.push('--- logs ---', item.logPath)
  lines.push('--- next ---', '按 message 处理；轮询继续（未暂停）。')
  return lines.join('\n')
}

function batchEntry(frameItem, index, total) {
  const header =
    `--- [${index + 1}/${total}] id=${frameItem.id} reason=${frameItem.kind}` +
    `${frameItem.kind === 'event' ? ` at=${frameItem.at} rev=${frameItem.rev} message_source=${frameItem.messageSource}` : ''}` +
    `${frameItem.kind === 'failure' ? ` failures=${frameItem.failures}/${frameItem.threshold}` : ''} ---`
  const lines = [header, `message: ${messageText(frameItem.message)}`]
  if (frameItem.kind === 'event') {
    const evidence = evidenceSection(frameItem.evidence, DEFAULT_MAX_EVIDENCE_BYTES)
    if (evidence !== null) lines.push(`evidence${evidence.label}: ${evidence.text}`)
  } else {
    const tail = sanitizeText(frameItem.errorTail ?? '').trim()
    if (tail !== '') lines.push(`error_tail: ${tail}`)
  }
  if (frameItem.logPath) lines.push(`logs: ${frameItem.logPath}`)
  return lines
}

/**
 * 合并帧：同一目标会话在一个窗口内的多条触发只唤醒一次。
 * @param {Array<object>} items
 * @param {{at:string}} [options]
 */
export function renderBatchFrame(items, { at } = {}) {
  const total = items.length
  const stamp = at ?? items[0]?.at ?? ''
  const lines = [`[WATCH TRIGGER] batch=${total} at=${stamp}`]
  items.forEach((item, index) => {
    lines.push(...batchEntry(item, index, total))
  })
  lines.push('--- next ---', '逐条按 message 执行；message 是用户为该 watch 设定的常驻指令。')
  return lines.join('\n')
}
