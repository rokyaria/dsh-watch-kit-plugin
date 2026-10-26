/** watch.conf 的解析、归一化与校验。零 IO，便于单测。 */

import { isAbsolute } from 'node:path'
import { isValidWatchId } from './ids.js'
import { stripBom, utf8Bytes } from './text.js'

/** watch.conf 认识的键；未知键忽略并返回 warning。 */
export const KNOWN_KEYS = Object.freeze([
  'PURPOSE',
  'TRIGGER_MSG',
  'INTERVAL',
  'TIMEOUT',
  'FAILURE_MSG',
  'TARGETS',
  'CHECK',
  'RUNNER',
  'WAKE_BUDGET_CAPACITY',
  'WAKE_BUDGET_REFILL_SECONDS',
])

/** 支持的 RUNNER 取值。 */
export const RUNNERS = Object.freeze([
  'auto',
  'bash',
  'pwsh',
  'powershell',
  'python',
  'python3',
  'node',
  'direct',
])

/** 默认检测程序文件名（按平台）。 */
export function platformDefaultCheck(platform = process.platform) {
  return platform === 'win32' ? './check.ps1' : './check.sh'
}

/** 未配置 message 时给 agent 的兜底说明。 */
export const DEFAULT_TRIGGER_FALLBACK = '（未设置 TRIGGER_MSG/PURPOSE，请根据 evidence 判断并处理）'

/**
 * 解析 KEY=VALUE 文本。
 * @returns {{values: Record<string,string>, warnings: string[]}}
 */
export function parseWatchConf(text, { path = 'watch.conf' } = {}) {
  const values = Object.create(null)
  const warnings = []
  const lines = stripBom(text).split(/\r?\n/)
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim()
    if (line === '' || line.startsWith('#')) continue
    const match = /^([A-Z][A-Z0-9_]*)\s*=\s*(.*)$/.exec(line)
    if (match === null) {
      warnings.push(`${path}:${index + 1}: not KEY=VALUE, ignored`)
      continue
    }
    const key = match[1]
    let value = match[2].trim()
    if (/^(['"]).*\1$/.test(value)) value = value.slice(1, -1)
    if (!KNOWN_KEYS.includes(key)) {
      warnings.push(`${path}:${index + 1}: unknown key ${key} ignored`)
      continue
    }
    values[key] = value
  }
  return { values, warnings }
}

function parseNonNegativeInt(raw) {
  if (typeof raw !== 'string' || !/^\d+$/.test(raw.trim())) return null
  const value = Number(raw.trim())
  return Number.isSafeInteger(value) ? value : null
}

/** 归一化配置（补齐默认值，不校验范围）。 */
export function normalizeConf(values, { platform = process.platform } = {}) {
  const intervalSec = parseNonNegativeInt(values?.INTERVAL) ?? 60
  const timeoutSec = parseNonNegativeInt(values?.TIMEOUT) ?? 15
  const targets = String(values?.TARGETS ?? '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)
  return {
    purpose: String(values?.PURPOSE ?? '').trim(),
    triggerMsg: String(values?.TRIGGER_MSG ?? '').trim(),
    failureMsg: String(values?.FAILURE_MSG ?? '').trim(),
    intervalSec,
    timeoutSec,
    check: String(values?.CHECK ?? '').trim() || platformDefaultCheck(platform),
    runner: String(values?.RUNNER ?? '').trim().toLowerCase() || 'auto',
    targets,
    // 可选唤醒预算：capacity=0 表示关闭（默认）。
    budgetCapacity: parseNonNegativeInt(values?.WAKE_BUDGET_CAPACITY) ?? 0,
    budgetRefillSec: parseNonNegativeInt(values?.WAKE_BUDGET_REFILL_SECONDS) ?? 600,
  }
}

/** 生效的触发消息：TRIGGER_MSG → PURPOSE → 兜底说明。 */
export function effectiveTriggerMsg(conf) {
  return conf?.triggerMsg || conf?.purpose || DEFAULT_TRIGGER_FALLBACK
}

const MIN_INTERVAL = 30
const MAX_INTERVAL = 86400
const MAX_MESSAGE_BYTES = 4096

/**
 * 校验并归一化 watch.conf。
 * @returns {{ok: boolean, errors: Array<{code: string, message: string}>, conf: object}}
 */
export function validateWatchConf(values, { id, platform = process.platform } = {}) {
  const conf = normalizeConf(values, { platform })
  const errors = []

  if (id !== undefined && !isValidWatchId(id)) {
    errors.push({ code: 'invalid_id', message: `watch id "${id}" must match ${WATCH_ID_RE_SOURCE}` })
  }
  if (conf.targets.length === 0) {
    errors.push({ code: 'missing_target', message: 'TARGETS 为空：请用 /watch-add 创建，或补写目标会话 id' })
  }
  if (!Number.isInteger(conf.intervalSec) || conf.intervalSec < MIN_INTERVAL || conf.intervalSec > MAX_INTERVAL) {
    errors.push({
      code: 'bad_interval',
      message: `INTERVAL 必须是 ${MIN_INTERVAL}–${MAX_INTERVAL} 的整数秒，当前 ${conf.intervalSec}`,
    })
  }
  if (
    !Number.isInteger(conf.timeoutSec) ||
    conf.timeoutSec < 1 ||
    conf.timeoutSec > Math.floor(conf.intervalSec / 2)
  ) {
    errors.push({
      code: 'bad_timeout',
      message: `TIMEOUT 必须是 1–INTERVAL/2（当前 ${Math.floor(conf.intervalSec / 2)} 秒）的整数秒，当前 ${conf.timeoutSec}`,
    })
  }
  if (!RUNNERS.includes(conf.runner)) {
    errors.push({ code: 'bad_runner', message: `RUNNER 取值无效：${conf.runner}（可选 ${RUNNERS.join('|')}）` })
  }
  if (isAbsolute(conf.check) || conf.check.split(/[\\/]+/).includes('..')) {
    errors.push({ code: 'bad_check_path', message: `CHECK 必须是 watch 目录内的相对路径，当前 ${conf.check}` })
  }
  if (utf8Bytes(effectiveTriggerMsg(conf)) > MAX_MESSAGE_BYTES) {
    errors.push({ code: 'bad_trigger_msg', message: `TRIGGER_MSG/PURPOSE 超过 ${MAX_MESSAGE_BYTES} 字节` })
  }
  if (utf8Bytes(conf.failureMsg) > MAX_MESSAGE_BYTES) {
    errors.push({ code: 'bad_failure_msg', message: `FAILURE_MSG 超过 ${MAX_MESSAGE_BYTES} 字节` })
  }
  if (!Number.isInteger(conf.budgetCapacity) || conf.budgetCapacity < 0 || conf.budgetCapacity > 1000) {
    errors.push({
      code: 'bad_budget',
      message: `WAKE_BUDGET_CAPACITY 必须是 0–1000 的整数（0 = 关闭），当前 ${conf.budgetCapacity}`,
    })
  }
  if (conf.budgetCapacity > 0 && (!Number.isInteger(conf.budgetRefillSec) || conf.budgetRefillSec < 1 || conf.budgetRefillSec > 86400)) {
    errors.push({
      code: 'bad_budget',
      message: `WAKE_BUDGET_REFILL_SECONDS 必须是 1–86400 的整数秒，当前 ${conf.budgetRefillSec}`,
    })
  }
  return { ok: errors.length === 0, errors, conf }
}

const WATCH_ID_RE_SOURCE = '^[a-z][a-z0-9-]{1,39}$'
