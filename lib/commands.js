/** 唯一命令 /watch-reload：读 JSON 配置并同步进 SQLite。 */

import { readFile } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'

const DEFAULT_INTERVAL_SEC = 60
const DEFAULT_TIMEOUT_SEC = 30
const RUN_RETENTION_MS = 7 * 24 * 3_600_000

function errorText(text) {
  return { kind: 'error', text }
}

function okText(text) {
  return { kind: 'success', text }
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
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
    if (!Array.isArray(item.checker) || item.checker.length === 0) {
      errors.push(`${at}.checker: 必须是非空的字符串数组`)
      return
    }
    if (!item.checker.every((part) => typeof part === 'string' && part !== '')) {
      errors.push(`${at}.checker: 每个元素必须是非空字符串`)
      return
    }
    let cwd = null
    if (item.cwd !== undefined && item.cwd !== null) {
      if (typeof item.cwd !== 'string' || item.cwd.trim() === '') {
        errors.push(`${at}.cwd: 必须是非空字符串`)
        return
      }
      cwd = isAbsolute(item.cwd) ? item.cwd : resolve(configDir, item.cwd)
    }
    const intervalSec = item.interval === undefined ? DEFAULT_INTERVAL_SEC : Number(item.interval)
    if (!Number.isFinite(intervalSec) || intervalSec <= 0) {
      errors.push(`${at}.interval: 必须是正数（秒）`)
      return
    }
    const timeoutSec = item.timeout === undefined ? DEFAULT_TIMEOUT_SEC : Number(item.timeout)
    if (!Number.isFinite(timeoutSec) || timeoutSec <= 0) {
      errors.push(`${at}.timeout: 必须是正数（秒）`)
      return
    }
    let target = null
    if (item.target !== undefined && item.target !== null) {
      if (typeof item.target !== 'string' || item.target.trim() === '') {
        errors.push(`${at}.target: 必须是非空字符串`)
        return
      }
      target = item.target.trim()
    }
    if (item.enabled !== undefined && typeof item.enabled !== 'boolean') {
      errors.push(`${at}.enabled: 必须是 boolean`)
      return
    }
    entries.push({
      id,
      checker: JSON.stringify(item.checker),
      cwd,
      intervalMs: Math.round(intervalSec * 1000),
      timeoutMs: Math.round(timeoutSec * 1000),
      target,
      enabled: item.enabled !== false,
    })
  })
  return { ok: errors.length === 0, errors, entries }
}

/**
 * 读配置文件并事务性同步到 DB。
 * @returns {Promise<{ok:true, stats:object, bound:number, configFile:string} | {ok:false, errors:string[]}>}
 */
export async function reloadConfig({ db, configFile, configDir, sessionId, now = Date.now() }) {
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
    db.cleanupRuns(now - RUN_RETENTION_MS)
  } catch {
    /* 清理失败不影响 reload */
  }
  return { ok: true, stats, bound, configFile }
}

export function registerCommands({ ctx, db, poller, configFile, configDir }) {
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
