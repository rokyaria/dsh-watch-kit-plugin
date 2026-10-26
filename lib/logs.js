/** 日志与审计：按天文件、保留期清理、大小裁剪。 */

import { appendFile, mkdir, readdir, rm, stat, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { localDayStamp, nowIso } from './ids.js'

const DAY_MS = 24 * 60 * 60 * 1000

/** 追加一行日志（自动建目录）。 */
export async function appendLog(filePath, line) {
  await mkdir(dirname(filePath), { recursive: true })
  await appendFile(filePath, line.endsWith('\n') ? line : `${line}\n`, 'utf8')
}

/** 当天的运行日志路径。 */
export function logFilePath(logsDir, date = new Date()) {
  return join(logsDir, `${localDayStamp(date)}.log`)
}

/** 审计日志路径。 */
export function auditFilePath(logsDir) {
  return join(logsDir, 'audit.log')
}

/** 一行运行记录。 */
export function formatRunLog(record) {
  const parts = [
    record.at ?? nowIso(),
    'run',
    `id=${record.id ?? '-'}`,
    `exit=${record.code === null || record.code === undefined ? 'null' : record.code}`,
  ]
  if (record.timedOut) parts.push('timeout')
  if (record.signal) parts.push(`signal=${record.signal}`)
  if (record.lossy) parts.push('truncated')
  parts.push(`dur=${record.durationMs ?? 0}ms`, `bytes=${record.bytes ?? 0}`)
  if (record.note) parts.push(`note=${record.note}`)
  return parts.join(' ')
}

/** 追加运行日志。 */
export async function appendRunLog({ logsDir, id, at, code, timedOut, signal, lossy, durationMs, bytes, note }) {
  const line = formatRunLog({ id, at, code, timedOut, signal, lossy, durationMs, bytes, note })
  await appendLog(logFilePath(logsDir, at ? new Date(at) : new Date()), line)
}

/** 追加审计记录（创建/审批/暂停/删除/校验等）。 */
export async function appendAudit({ logsDir, at, event, id, sessionId, detail }) {
  const parts = [at ?? nowIso(), 'audit', `event=${event}`]
  if (id) parts.push(`id=${id}`)
  if (sessionId) parts.push(`session=${sessionId}`)
  if (detail) parts.push(`detail=${String(detail).replace(/\s+/g, ' ')}`)
  await appendLog(auditFilePath(logsDir), parts.join(' '))
}

async function listFiles(dir) {
  try {
    const entries = await readdir(dir, { withFileTypes: true })
    return entries.filter((entry) => entry.isFile()).map((entry) => join(dir, entry.name))
  } catch {
    return []
  }
}

/**
 * 清理单个 watch 的日志：先删过期文件，再按总大小从最旧删除。
 * @returns {{deleted: string[], totalBytes: number}}
 */
export async function cleanupWatchLogs(
  watchDir,
  { retentionDays = 14, maxBytes = 20 * 1024 * 1024, now = Date.now() } = {},
) {
  const logsDir = join(watchDir, 'logs')
  const files = await listFiles(logsDir)
  const withStat = []
  for (const file of files) {
    try {
      withStat.push({ file, ...(await stat(file)) })
    } catch {
      /* 文件可能刚被删 */
    }
  }
  const cutoff = now - Math.max(0, Number(retentionDays) || 0) * DAY_MS
  const deleted = []
  let kept = []
  for (const entry of withStat) {
    if (entry.mtimeMs < cutoff) {
      try {
        await unlink(entry.file)
        deleted.push(entry.file)
      } catch {
        kept.push(entry)
      }
    } else {
      kept.push(entry)
    }
  }
  let totalBytes = kept.reduce((sum, entry) => sum + entry.size, 0)
  kept.sort((left, right) => left.mtimeMs - right.mtimeMs)
  while (totalBytes > maxBytes && kept.length > 0) {
    const oldest = kept.shift()
    try {
      await unlink(oldest.file)
      deleted.push(oldest.file)
      totalBytes -= oldest.size
    } catch {
      /* 忽略并发删除 */
    }
  }
  return { deleted, totalBytes }
}

/** 清理 `.removed/` 下超过保留期的归档目录。 */
export async function cleanupRemoved(specRoot, { days = 7, now = Date.now() } = {}) {
  const removedDir = join(specRoot, '.removed')
  let entries
  try {
    entries = await readdir(removedDir, { withFileTypes: true })
  } catch {
    return { deleted: [] }
  }
  const cutoff = now - Math.max(0, Number(days) || 0) * DAY_MS
  const deleted = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const target = join(removedDir, entry.name)
    try {
      const info = await stat(target)
      if (info.mtimeMs < cutoff) {
        await rm(target, { recursive: true, force: true })
        deleted.push(target)
      }
    } catch {
      /* 忽略 */
    }
  }
  return { deleted }
}
