/** 唯一命令 /watch-reload：读 JSON 配置并同步进 SQLite。 */

import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const DEFAULT_INTERVAL_SEC = 60
const DEFAULT_TIMEOUT_SEC = 30
const RUN_RETENTION_MS = 7 * 24 * 3_600_000
const MAILBOX_SCRIPT = fileURLToPath(new URL('../extension/mailbox/mail.py', import.meta.url))
const DEFAULT_MAILBOX_PYTHON = process.platform === 'win32' ? 'python' : 'python3'
const DEFAULT_REMIND_MINUTES = 30
const DEFAULT_MAX_NOTIFY = 20

function errorText(text) {
  return { kind: 'error', text }
}

function okText(text) {
  return { kind: 'success', text }
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

function expandPathValue(value, configDir) {
  const trimmed = String(value).trim()
  const expanded = trimmed === '~' ? homedir() : trimmed.startsWith('~/') ? join(homedir(), trimmed.slice(2)) : trimmed
  return isAbsolute(expanded) ? expanded : resolve(configDir, expanded)
}

function parseCommonFields(item, at, configDir, errors) {
  let cwd = null
  if (item.cwd !== undefined && item.cwd !== null) {
    if (typeof item.cwd !== 'string' || item.cwd.trim() === '') {
      errors.push(`${at}.cwd: 必须是非空字符串`)
      return null
    }
    cwd = isAbsolute(item.cwd) ? item.cwd : resolve(configDir, item.cwd)
  }
  const intervalSec = item.interval === undefined ? DEFAULT_INTERVAL_SEC : Number(item.interval)
  if (!Number.isFinite(intervalSec) || intervalSec <= 0) {
    errors.push(`${at}.interval: 必须是正数（秒）`)
    return null
  }
  const timeoutSec = item.timeout === undefined ? DEFAULT_TIMEOUT_SEC : Number(item.timeout)
  if (!Number.isFinite(timeoutSec) || timeoutSec <= 0) {
    errors.push(`${at}.timeout: 必须是正数（秒）`)
    return null
  }
  let target = null
  if (item.target !== undefined && item.target !== null) {
    if (typeof item.target !== 'string' || item.target.trim() === '') {
      errors.push(`${at}.target: 必须是非空字符串`)
      return null
    }
    target = item.target.trim()
  }
  if (item.enabled !== undefined && typeof item.enabled !== 'boolean') {
    errors.push(`${at}.enabled: 必须是 boolean`)
    return null
  }
  return {
    cwd,
    intervalMs: Math.round(intervalSec * 1000),
    timeoutMs: Math.round(timeoutSec * 1000),
    target,
    enabled: item.enabled !== false,
  }
}

function parseMailboxPreset(item, at, configDir, enabled, errors) {
  if (item.checker !== undefined) {
    errors.push(`${at}.checker: preset mailbox 时不能同时写 checker`)
    return null
  }
  const mailbox = item.mailbox
  if (mailbox === null || typeof mailbox !== 'object' || Array.isArray(mailbox)) {
    errors.push(`${at}.mailbox: preset mailbox 需要配置对象`)
    return null
  }
  const pathField = (name, required) => {
    const value = mailbox[name]
    if (value === undefined || value === null || value === '') {
      if (required) errors.push(`${at}.mailbox.${name}: 必须是非空路径`)
      return null
    }
    if (typeof value !== 'string' || value.trim() === '') {
      errors.push(`${at}.mailbox.${name}: 必须是非空路径`)
      return null
    }
    return expandPathValue(value, configDir)
  }
  const envFile = pathField('envFile', true)
  const stateDir = pathField('stateDir', true)
  let allowAccountFile = pathField('allowAccountFile', false)
  if (allowAccountFile === null && stateDir !== null) allowAccountFile = join(stateDir, 'allow-accounts.json')

  const remindRaw = mailbox.remindAfterMinutes === undefined ? DEFAULT_REMIND_MINUTES : Number(mailbox.remindAfterMinutes)
  if (!Number.isFinite(remindRaw) || remindRaw <= 0) {
    errors.push(`${at}.mailbox.remindAfterMinutes: 必须是正数（分钟）`)
    return null
  }
  const maxRaw = mailbox.maxNotify === undefined ? DEFAULT_MAX_NOTIFY : Number(mailbox.maxNotify)
  if (!Number.isInteger(maxRaw) || maxRaw < 1 || maxRaw > 100) {
    errors.push(`${at}.mailbox.maxNotify: 必须是 1–100 的整数`)
    return null
  }
  const folder = mailbox.folder === undefined ? 'INBOX' : mailbox.folder
  if (typeof folder !== 'string' || folder.trim() === '') {
    errors.push(`${at}.mailbox.folder: 必须是非空字符串`)
    return null
  }
  const pythonRaw = mailbox.python === undefined ? DEFAULT_MAILBOX_PYTHON : mailbox.python
  if (typeof pythonRaw !== 'string' || pythonRaw.trim() === '') {
    errors.push(`${at}.mailbox.python: 必须是非空字符串`)
    return null
  }
  const python = /[\\/]/.test(pythonRaw) || pythonRaw.startsWith('~') ? expandPathValue(pythonRaw, configDir) : pythonRaw.trim()
  if (errors.length > 0) return null

  if (enabled) {
    if (!existsSync(envFile)) errors.push(`${at}.mailbox.envFile: 文件不存在: ${envFile}`)
    if (!existsSync(allowAccountFile)) errors.push(`${at}.mailbox.allowAccountFile: 文件不存在: ${allowAccountFile}`)
    if (errors.length > 0) return null
  }

  const argv = [
    python.trim(),
    MAILBOX_SCRIPT,
    'check',
    '--json',
    '--env-file',
    envFile,
    '--state-dir',
    stateDir,
    '--allow-account-file',
    allowAccountFile,
    '--remind-minutes',
    String(Math.round(remindRaw)),
    '--max-notify',
    String(maxRaw),
    '--folder',
    folder.trim(),
  ]
  return { checker: JSON.stringify(argv), mailbox: { envFile, stateDir, allowAccountFile } }
}

/** 把配置项解析/归一化；任何一条非法都返回 errors（整体不生效）。 */
export function validateConfigFile(raw, { configDir }) {
  const errors = []
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, errors: ['配置文件顶层必须是对象'] }
  }
  if (!Array.isArray(raw.watches)) {
    return { ok: false, errors: ['配置文件缺少 watches 数组'] }
  }
  const entries = []
  const seen = new Set()
  raw.watches.forEach((item, index) => {
    const at = `watches[${index}]`
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      errors.push(`${at}: 必须是对象`)
      return
    }
    if (typeof item.id !== 'string' || item.id.trim() === '' || /\s/.test(item.id) || item.id.length > 64) {
      errors.push(`${at}.id: 必须是 1–64 字符、无空白的字符串`)
      return
    }
    const id = item.id
    if (seen.has(id)) {
      errors.push(`${at}.id: 重复的 watch id "${id}"`)
      return
    }
    seen.add(id)
    const common = parseCommonFields(item, at, configDir, errors)
    if (common === null) return
    if (item.preset !== undefined) {
      if (item.preset !== 'mailbox') {
        errors.push(`${at}.preset: 目前只支持 "mailbox"`)
        return
      }
      const preset = parseMailboxPreset(item, at, configDir, common.enabled, errors)
      if (preset === null) return
      entries.push({ id, checker: preset.checker, ...common, preset: 'mailbox' })
      return
    }
    if (!Array.isArray(item.checker) || item.checker.length === 0) {
      errors.push(`${at}.checker: 必须是非空的字符串数组（或使用 preset: "mailbox"）`)
      return
    }
    if (!item.checker.every((part) => typeof part === 'string' && part !== '')) {
      errors.push(`${at}.checker: 每个元素必须是非空字符串`)
      return
    }
    entries.push({ id, checker: JSON.stringify(item.checker), ...common })
  })
  return { ok: errors.length === 0, errors, entries }
}

/**
 * 读配置文件并事务性同步到 DB。
 * @returns {Promise<{ok:true, stats:object, bound:number, configFile:string} | {ok:false, errors:string[]}>}
 */
export async function reloadConfig({ db, configFile, configDir, sessionId, now = Date.now(), retentionMs = RUN_RETENTION_MS }) {
  let text
  try {
    text = await readFile(configFile, 'utf8')
  } catch (error) {
    return { ok: false, errors: [`读取配置文件失败：${configFile}（${errorMessage(error)}）`] }
  }
  let raw
  try {
    raw = JSON.parse(text)
  } catch (error) {
    return { ok: false, errors: [`配置文件不是合法 JSON：${errorMessage(error)}`] }
  }
  const validated = validateConfigFile(raw, { configDir })
  if (!validated.ok) return { ok: false, errors: validated.errors }

  const errors = []
  let bound = 0
  const entries = validated.entries.map((entry) => {
    const existing = db.getWatch(entry.id)
    let target = entry.target
    if (target === null) {
      target = existing?.target ?? sessionId ?? null
      if (target === null) {
        errors.push(`watch "${entry.id}" 没有 target，且无法确定当前会话 id`)
      } else if (existing?.target === undefined || existing?.target === null) {
        bound += 1
      }
    }
    return { ...entry, target }
  })
  if (errors.length > 0) return { ok: false, errors }

  const stats = db.applyConfig(entries, now)
  try {
    db.cleanupRuns(now - retentionMs)
  } catch {
    /* 清理失败不影响 reload */
  }
  return { ok: true, stats, bound, configFile }
}

export function registerCommands({ ctx, db, poller, configFile, configDir, retentionMs = RUN_RETENTION_MS }) {
  const dispose = ctx.commands.register({
    name: 'watch-reload',
    description: '从 watches.json 重新加载 watch 配置到 SQLite（新增/更新/软删除）',
    handler: async (invocation) => {
      try {
        const result = await reloadConfig({
          db,
          configFile,
          configDir,
          sessionId: invocation?.agent?.id,
          retentionMs,
        })
        if (!result.ok) {
          return errorText(['/watch-reload 失败：', ...result.errors].join('\n'))
        }
        void poller.poll()
        return okText(
          [
            `✓ 已重载 ${result.configFile}`,
            `新增 ${result.stats.added}，更新 ${result.stats.updated}，软删除 ${result.stats.deleted}，绑定 target ${result.bound}。`,
          ].join('\n'),
        )
      } catch (error) {
        return errorText(`/watch-reload 失败：${errorMessage(error)}`)
      }
    },
  })
  return () => {
    try {
      dispose()
    } catch {
      /* 已释放 */
    }
  }
}
