import assert from 'node:assert/strict'
import { mkdir, readFile, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import {
  appendAudit,
  appendLog,
  appendRunLog,
  cleanupRemoved,
  cleanupWatchLogs,
  formatRunLog,
  logFilePath,
} from '../lib/logs.js'
import { cleanup, makeTmp } from './helpers/fixtures.mjs'

test('appendLog 自动建目录并追加', async () => {
  const dir = await makeTmp()
  try {
    const file = join(dir, 'nested', 'x.log')
    await appendLog(file, 'a')
    await appendLog(file, 'b\n')
    assert.equal(await readFile(file, 'utf8'), 'a\nb\n')
  } finally {
    await cleanup(dir)
  }
})

test('运行日志与审计日志格式', async () => {
  const dir = await makeTmp()
  try {
    await appendRunLog({
      logsDir: join(dir, 'logs'),
      id: 'demo',
      at: '2026-10-26T14:00:00.000Z',
      code: 1,
      durationMs: 12,
      bytes: 3,
      note: 'event',
    })
    const line = formatRunLog({ at: 'x', id: 'demo', code: null, timedOut: true, durationMs: 1, bytes: 0 })
    assert.match(line, /exit=null timeout/)
    assert.match(await readFile(logFilePath(join(dir, 'logs')), 'utf8'), /exit=1 dur=12ms bytes=3 note=event/)
    await appendAudit({ logsDir: join(dir, 'logs'), at: 'x', event: 'create', id: 'demo', sessionId: 's1' })
    assert.match(await readFile(join(dir, 'logs', 'audit.log'), 'utf8'), /event=create id=demo session=s1/)
  } finally {
    await cleanup(dir)
  }
})

test('cleanupWatchLogs 删除过期文件', async () => {
  const dir = await makeTmp()
  try {
    const logsDir = join(dir, 'logs')
    await mkdir(logsDir, { recursive: true })
    const old = join(logsDir, 'old.log')
    const fresh = join(logsDir, 'fresh.log')
    await writeFile(old, 'old')
    await writeFile(fresh, 'fresh')
    const now = Date.now()
    const oldDate = new Date(now - 20 * 24 * 60 * 60 * 1000)
    await utimes(old, oldDate, oldDate)
    const result = await cleanupWatchLogs(dir, { retentionDays: 14, maxBytes: 1024 * 1024, now })
    assert.deepEqual(result.deleted.sort(), [old].sort())
    assert.equal(await readFile(fresh, 'utf8'), 'fresh')
  } finally {
    await cleanup(dir)
  }
})

test('cleanupWatchLogs 按大小从最旧删除', async () => {
  const dir = await makeTmp()
  try {
    const logsDir = join(dir, 'logs')
    await mkdir(logsDir, { recursive: true })
    const first = join(logsDir, 'a.log')
    const second = join(logsDir, 'b.log')
    await writeFile(first, 'x'.repeat(600))
    await writeFile(second, 'y'.repeat(600))
    const now = Date.now()
    const oldDate = new Date(now - 60_000)
    await utimes(first, oldDate, oldDate)
    const result = await cleanupWatchLogs(dir, { retentionDays: 14, maxBytes: 700, now })
    assert.ok(result.deleted.includes(first))
    assert.equal(result.totalBytes <= 700, true)
  } finally {
    await cleanup(dir)
  }
})

test('cleanupRemoved 删除过期归档、保留新归档', async () => {
  const dir = await makeTmp()
  try {
    const removed = join(dir, '.removed')
    const oldDir = join(removed, 'old-1')
    const newDir = join(removed, 'new-1')
    await mkdir(oldDir, { recursive: true })
    await mkdir(newDir, { recursive: true })
    const now = Date.now()
    const oldDate = new Date(now - 10 * 24 * 60 * 60 * 1000)
    await utimes(oldDir, oldDate, oldDate)
    const result = await cleanupRemoved(dir, { days: 7, now })
    assert.deepEqual(result.deleted, [oldDir])
  } finally {
    await cleanup(dir)
  }
})
