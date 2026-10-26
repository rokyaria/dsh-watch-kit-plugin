/** 退出码 + JSON 事件载荷解析。纯函数，便于单测。 */

import { sanitizeText, stripBom, utf8Bytes } from './text.js'

/** JSON 事件里 message 的字节上限。 */
export const EVENT_MESSAGE_MAX_BYTES = 2048

const INVALID_REASONS = Object.freeze({
  truncated: 'stdout_truncated',
  parse: 'json_parse',
  notObject: 'not_object',
  badMessage: 'bad_message',
  badEvidence: 'bad_evidence',
})

function invalid(reason) {
  return { kind: 'invalid', reason }
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 解析一次运行的输出，决定它是不是一个事件。
 *
 * 规则（design §6.2.2）：
 * - 只有退出码 1 才可能是事件；
 * - stdout 去空白后以 `{` 开头时按 JSON 解析，失败视为执行失败；
 * - 否则回退到纯退出码语义。
 *
 * @param {{code: number|null, stdout?: string, lossy?: boolean}} input
 * @returns {{kind:'by-exit-code'} |
 *           {kind:'invalid', reason: string} |
 *           {kind:'event', message?: string, evidence?: string,
 *            source:'script', warnings: string[]}}
 */
export function parseEventOutput({ code, stdout = '', lossy = false }) {
  if (code !== 1) return { kind: 'by-exit-code' }
  const text = stripBom(stdout)
  if (!text.trimStart().startsWith('{')) return { kind: 'by-exit-code' }

  if (lossy) return invalid(INVALID_REASONS.truncated)

  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    return invalid(INVALID_REASONS.parse)
  }
  if (!isPlainObject(parsed)) return invalid(INVALID_REASONS.notObject)

  const warnings = []
  let message
  if (parsed.message !== undefined && parsed.message !== null) {
    if (typeof parsed.message !== 'string') return invalid(INVALID_REASONS.badMessage)
    const value = sanitizeText(parsed.message).trim()
    if (value !== '') {
      const bytes = utf8Bytes(value)
      if (bytes === 0 || bytes > EVENT_MESSAGE_MAX_BYTES) return invalid(INVALID_REASONS.badMessage)
      message = value
    }
  }

  let evidence
  if (parsed.evidence !== undefined && parsed.evidence !== null) {
    if (typeof parsed.evidence !== 'string') return invalid(INVALID_REASONS.badEvidence)
    // evidence 不在本层截断：调用方（内核）已用 maxStdoutBytes 限制 stdout 总量，
    // 截断统一由 frame 渲染层完成，避免两处上限不一致。
    const value = sanitizeText(parsed.evidence)
    if (value.trim() !== '') evidence = value
  }

  for (const key of Object.keys(parsed)) {
    if (key !== 'message' && key !== 'evidence') warnings.push(`unknown event field "${key}" ignored`)
  }

  return { kind: 'event', message, evidence, source: 'script', warnings }
}
