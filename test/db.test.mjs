/**
 * DB contract (contract §3): schema/pragmas, claim transaction + due filters,
 * soft delete/resurrect/upsert, runs, delivery counters (one-time first fail,
 * streak, compensation reset), 7-day cleanup and watch_runs aggregation.
 */

import assert from 'node:assert/strict'
import { chmod, mkdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { WatchDB } from '../lib/db.js'
import {
  cleanup, columnNames, makeTmp, openDb, rawGet, rawQuery, tableNames, watchEntry,
} from './helpers/harness.mjs'

const NOW = 1_800_000_000_000
const exists = (file) => stat(file).then(() => true, () => false)

async function withDb(fn) {
  const dir = await makeTmp()
  const { db, file } = openDb(dir)
  try {
    return await fn(db, file, dir)
  } finally {
    db.close()
    await cleanup(dir)
  }
}

test('creates the contract schema, WAL journal and user_version=1', async () => {
  const dir = await makeTmp()
  try {
    const { db, file } = openDb(dir, join('nested', 'watch.db'))
    try {
      assert.ok(await exists(file), 'DB file is created (parent dirs too)')
      assert.equal(rawGet(file, 'PRAGMA user_version').user_version, 1)
      assert.equal(String(rawGet(file, 'PRAGMA journal_mode').journal_mode).toLowerCase(), 'wal')
      assert.deepEqual(tableNames(file).filter((name) => ['watches', 'runs'].includes(name)).sort(), ['runs', 'watches'])
      const watchColumns = columnNames(file, 'watches')
      for (const column of ['id', 'checker', 'cwd', 'interval_ms', 'timeout_ms', 'target', 'enabled', 'is_deleted', 'last_run_at', 'last_notify_at', 'delivery_fail_count', 'delivery_fail_streak', 'delivery_first_fail_at', 'last_delivery_error', 'created_at', 'updated_at']) {
        assert.ok(watchColumns.includes(column), `watches.${column}`)
      }
      const runColumns = columnNames(file, 'runs')
      for (const column of ['id', 'watch_id', 'started_at', 'finished_at', 'status', 'notify', 'message', 'error', 'duration_ms', 'stderr_tail', 'delivered']) {
        assert.ok(runColumns.includes(column), `runs.${column}`)
      }
    } finally {
      db.close()
    }
  } finally {
    await cleanup(dir)
  }
})

test('claimDue claims only due, enabled, non-deleted watches with a target and does not re-claim', async () => {
  await withDb(async (db, file) => {
    const entries = [
      watchEntry({ id: 'due-a' }),
      watchEntry({ id: 'due-b', intervalMs: 30_000 }),
      watchEntry({ id: 'disabled', enabled: false }),
      watchEntry({ id: 'no-target', target: null }),
      watchEntry({ id: 'deleted' }),
    ]
    db.applyConfig(entries, NOW - 10_000)
    db.applyConfig(entries.filter((entry) => entry.id !== 'deleted'), NOW - 5_000)

    const first = db.claimDue(NOW).map((watch) => watch.id)
    assert.deepEqual(first, ['due-a', 'due-b'], 'only enabled/non-deleted/target watches are due')
    const claimedA = db.getWatch('due-a')
    assert.equal(claimedA.lastRunAt, NOW, 'claim writes last_run_at')

    assert.deepEqual(db.claimDue(NOW), [], 'a second claim in the same round is empty (transaction/claim)')
    assert.deepEqual(db.claimDue(NOW + 29_000).map((watch) => watch.id), [], 'neither watch is due before its interval')
    assert.deepEqual(db.claimDue(NOW + 30_001).map((watch) => watch.id), ['due-b'], '30s watch becomes due first')
    assert.deepEqual(db.claimDue(NOW + 60_001).map((watch) => watch.id), ['due-a'], '60s watch becomes due later')
    assert.deepEqual(db.claimDue(NOW + 90_002).map((watch) => watch.id), ['due-b'], 'only the 30s watch is due again here')

    // A second connection on the same file must not claim the same rows (BEGIN IMMEDIATE).
    db.applyConfig([watchEntry({ id: 'cross-connection' })], NOW + 100_000)
    assert.deepEqual(db.claimDue(NOW + 100_001).map((watch) => watch.id), ['cross-connection'])
    const second = new WatchDB(file)
    try {
      assert.deepEqual(second.claimDue(NOW + 100_001), [], 'second connection sees the claim')
    } finally {
      second.close()
    }
  })
})

test('listWatches/getWatch/countWatches hide soft-deleted rows unless asked', async () => {
  await withDb(async (db) => {
    db.applyConfig([watchEntry({ id: 'a' }), watchEntry({ id: 'b', target: 'session-2' })], NOW)
    db.applyConfig([watchEntry({ id: 'a' })], NOW + 1)
    assert.equal(db.countWatches(), 1)
    assert.deepEqual(db.listWatches().map((watch) => watch.id), ['a'])
    assert.equal(db.getWatch('b').isDeleted, true)
    assert.equal(db.getWatch('b').target, 'session-2', 'soft delete keeps the row')
    assert.deepEqual(db.listWatches({ includeDeleted: true }).map((watch) => watch.id), ['a', 'b'])
    const a = db.getWatch('a')
    assert.equal(typeof a.checker, 'string')
    assert.equal(a.enabled, true)
    assert.equal(a.intervalMs, 60_000)
    assert.equal(db.getWatch('missing'), null)
  })
})

test('applyConfig upserts, preserves created_at, soft-deletes and resurrects', async () => {
  await withDb(async (db, file) => {
    const initial = [
      watchEntry({ id: 'a', intervalMs: 60_000 }),
      watchEntry({ id: 'b', target: 'session-2' }),
    ]
    assert.deepEqual(db.applyConfig(initial, NOW), { added: 2, updated: 0, deleted: 0 })
    assert.equal(db.getWatch('a').createdAt, NOW)
    db.recordRun({ watchId: 'b', startedAt: NOW, finishedAt: NOW, status: 'ok', notify: false, durationMs: 0 })

    const updatedA = watchEntry({
      id: 'a',
      checker: JSON.stringify(['node', '/other.js']),
      intervalMs: 120_000,
      timeoutMs: 10_000,
      target: 'session-9',
      enabled: false,
    })
    assert.deepEqual(db.applyConfig([updatedA], NOW + 1_000), { added: 0, updated: 1, deleted: 1 })
    const a = db.getWatch('a')
    assert.equal(a.checker, JSON.stringify(['node', '/other.js']))
    assert.equal(a.intervalMs, 120_000)
    assert.equal(a.timeoutMs, 10_000)
    assert.equal(a.target, 'session-9')
    assert.equal(a.enabled, false)
    assert.equal(a.createdAt, NOW, 'created_at is preserved on update')
    assert.equal(a.updatedAt, NOW + 1_000)
    assert.equal(db.getWatch('b').isDeleted, true)
    assert.equal(db.getWatch('b').enabled, false)
    assert.equal(rawQuery(file, 'SELECT * FROM runs WHERE watch_id = ?', 'b').length, 1, 'runs history survives soft delete')

    assert.deepEqual(db.applyConfig([updatedA, watchEntry({ id: 'b' })], NOW + 2_000), { added: 0, updated: 2, deleted: 0 }, 'a resurrected row counts as updated')
    assert.equal(db.getWatch('b').isDeleted, false, 'reappearing watch is resurrected')
    assert.equal(db.getWatch('b').enabled, true)

    assert.deepEqual(db.applyConfig([], NOW + 3_000), { added: 0, updated: 0, deleted: 2 })
    assert.equal(db.countWatches(), 0)
    assert.equal(db.listWatches({ includeDeleted: true }).every((watch) => watch.isDeleted), true)
  })
})

test('recordRun stores the run and markRunsDelivered flips delivered', async () => {
  await withDb(async (db, file) => {
    db.applyConfig([watchEntry({ id: 'a' })], NOW)
    const runId = db.recordRun({
      watchId: 'a', startedAt: NOW, finishedAt: NOW + 12, status: 'ok', notify: true,
      message: 'hello', error: null, durationMs: 12, stderrTail: 'tail',
    })
    const stored = rawQuery(file, 'SELECT * FROM runs WHERE id = ?', runId)[0]
    assert.equal(stored.watch_id, 'a')
    assert.equal(stored.notify, 1)
    assert.equal(stored.delivered, 0)
    assert.equal(stored.status, 'ok')
    assert.equal(stored.message, 'hello')
    assert.equal(stored.duration_ms, 12)
    assert.equal(stored.stderr_tail, 'tail')

    db.markRunsDelivered([runId])
    assert.equal(rawQuery(file, 'SELECT delivered FROM runs WHERE id = ?', runId)[0].delivered, 1)
    db.markRunsDelivered([])
  })
})

test('delivery failure counters and success clearing: count/streak/first-fail/error, notified timestamp, clearFailureIds', async () => {
  await withDb(async (db, file) => {
    db.applyConfig([watchEntry({ id: 'a' }), watchEntry({ id: 'b' }), watchEntry({ id: 'c' })], NOW)
    db.recordDeliveryFailure(['a'], 'first error', NOW + 1_000)
    let a = db.getWatch('a')
    assert.equal(a.deliveryFailCount, 1)
    assert.equal(a.deliveryFailStreak, 1)
    assert.equal(a.deliveryFirstFailAt, NOW + 1_000)
    assert.equal(a.lastDeliveryError, 'first error')

    db.recordDeliveryFailure(['a'], 'second error', NOW + 2_000)
    a = db.getWatch('a')
    assert.equal(a.deliveryFailCount, 2)
    assert.equal(a.deliveryFailStreak, 2)
    assert.equal(a.deliveryFirstFailAt, NOW + 1_000, 'first failure time is only written once')
    assert.equal(a.lastDeliveryError, 'second error')

    db.markWatchesNotified(['a'], NOW + 3_000)
    assert.equal(db.getWatch('a').lastNotifyAt, NOW + 3_000)
    assert.equal(db.getWatch('b').deliveryFailCount, 0, 'other watches are untouched')

    // recordDeliverySuccess 只对 clearFailureIds 清失败计数；runs.delivered/last_notify 仍按 watchIds。
    db.recordDeliveryFailure(['a', 'b', 'c'], 'gateway/internal', NOW - 1_000)
    const addRun = (watchId) => db.recordRun({
      watchId, startedAt: NOW, finishedAt: NOW, status: 'ok', notify: true, message: 'event', durationMs: 1,
    })
    const runA = addRun('a')
    const runB = addRun('b')
    const runC = addRun('c')

    // 只清 a：b/c 的失败计数保留（消息未完整表示它们的补偿段，事后仍可追溯）。
    db.recordDeliverySuccess([runA, runB, runC], ['a', 'b', 'c'], NOW, ['a'])
    assert.equal(db.getWatch('a').deliveryFailStreak, 0)
    assert.equal(db.getWatch('a').deliveryFailCount, 0)
    assert.equal(db.getWatch('b').deliveryFailStreak, 1, 'b is not in clearFailureIds')
    assert.equal(db.getWatch('b').deliveryFailCount, 1)
    assert.equal(db.getWatch('b').lastDeliveryError, 'gateway/internal')
    assert.equal(db.getWatch('c').deliveryFailStreak, 1)
    // runs.delivered / last_notify_at 仍按 watchIds（不清失败计数不影响正常记账）。
    assert.equal(rawQuery(file, 'SELECT delivered FROM runs').every((row) => row.delivered === 1), true)
    for (const id of ['a', 'b', 'c']) assert.equal(db.getWatch(id).lastNotifyAt, NOW)

    // 显式空数组：一个都不清。
    db.recordDeliverySuccess([], ['a'], NOW, [])
    assert.equal(db.getWatch('b').deliveryFailStreak, 1)
    assert.equal(db.getWatch('c').deliveryFailStreak, 1)

    // 旧 3 参数调用仍默认清 watchIds（向后兼容）。
    db.recordDeliverySuccess([], ['b', 'c'], NOW + 1)
    assert.equal(db.getWatch('b').deliveryFailStreak, 0)
    assert.equal(db.getWatch('c').deliveryFailStreak, 0)
    assert.equal(db.getWatch('b').lastNotifyAt, NOW + 1)
  })
})

test('getCompensations reports only watches with a failure streak and clearDeliveryFailures resets them', async () => {
  await withDb(async (db) => {
    db.applyConfig([watchEntry({ id: 'a' }), watchEntry({ id: 'b' })], NOW)
    db.recordDeliveryFailure(['a'], 'boom', NOW - 7_200_000)
    const compensations = db.getCompensations(['a', 'b'])
    assert.equal(compensations.length, 1)
    assert.deepEqual(compensations[0], { id: 'a', count: 1, firstFailAt: NOW - 7_200_000, error: 'boom' })

    db.clearDeliveryFailures(['a'])
    const a = db.getWatch('a')
    assert.equal(a.deliveryFailCount, 0)
    assert.equal(a.deliveryFailStreak, 0)
    assert.equal(a.deliveryFirstFailAt, null)
    assert.equal(a.lastDeliveryError, null)
    assert.deepEqual(db.getCompensations(['a', 'b']), [])
    db.clearDeliveryFailures([])
  })
})

test('cleanupRuns removes only runs older than the 7-day cutoff', async () => {
  await withDb(async (db, file) => {
    db.applyConfig([watchEntry({ id: 'a' })], NOW)
    db.recordRun({ watchId: 'a', startedAt: NOW, finishedAt: NOW, status: 'ok', notify: false, durationMs: 1 })
    db.recordRun({ watchId: 'a', startedAt: NOW - 8 * 24 * 3_600_000, finishedAt: NOW - 8 * 24 * 3_600_000, status: 'ok', notify: false, durationMs: 1 })
    const deleted = db.cleanupRuns(NOW - 7 * 24 * 3_600_000)
    assert.equal(deleted, 1)
    assert.equal(rawQuery(file, 'SELECT COUNT(*) AS c FROM runs')[0].c, 1)
  })
})

test('runsReport aggregates the watch_runs contract fields and includes zero-run watches', async () => {
  await withDb(async (db) => {
    db.applyConfig([
      watchEntry({ id: 'a', intervalMs: 45_000 }),
      watchEntry({ id: 'idle' }),
      watchEntry({ id: 'disabled', enabled: false }),
      watchEntry({ id: 'b' }),
    ], NOW)
    db.applyConfig([
      watchEntry({ id: 'a', intervalMs: 45_000 }),
      watchEntry({ id: 'idle' }),
      watchEntry({ id: 'disabled', enabled: false }),
    ], NOW + 1) // b soft-deleted, excluded
    const add = (watchId, offset, status, extra = {}) => db.recordRun({ watchId, startedAt: NOW - offset, finishedAt: NOW - offset + 5, status, durationMs: 5, ...extra })
    const delivered = add('a', 5_000, 'ok', { notify: true, message: 'm1', delivered: 1 })
    void delivered
    const okRun = add('a', 4_000, 'ok', { notify: true, message: 'm2' })
    db.markRunsDelivered([okRun])
    add('a', 3_000, 'invalid_json')
    add('a', 2_500, 'invalid_fields')
    add('a', 2_000, 'timeout', { error: 'timeout after 30s' })
    add('a', 1_500, 'spawn_error', { error: 'ENOENT bash' })
    add('a', 800, 'spawn_error', { stderrTail: 'latest stderr' }) // most recent non-ok without error
    db.claimDue(NOW + 1)
    db.recordDeliveryFailure(['a'], 'delivery boom', NOW)
    db.markWatchesNotified(['a'], NOW - 100)

    const report = db.runsReport(NOW - 3_600_000)
    assert.deepEqual(report.map((item) => item.id), ['a', 'idle'], 'only enabled, non-deleted watches are reported')
    const idle = report.find((item) => item.id === 'idle')
    assert.equal(idle.invokeCount, 0, 'enabled watch with 0 runs is included')
    assert.equal(idle.lastRunAt, NOW + 1)
    const a = report.find((item) => item.id === 'a')
    assert.equal(a.intervalSec, 45)
    assert.equal(a.invokeCount, 7)
    assert.equal(a.notifiedCount, 1, 'only notify=1 and delivered=1 count')
    assert.equal(a.errorCount, 5, 'every status != ok')
    assert.equal(a.invalidJsonCount, 1)
    assert.equal(a.invalidFieldsCount, 1)
    assert.equal(a.timeoutCount, 1)
    assert.equal(a.deliveryFailCount, 1)
    assert.equal(a.lastRunAt, NOW + 1)
    assert.equal(a.lastNotifyAt, NOW - 100)
    assert.equal(a.lastError, 'latest stderr', 'latest non-ok error or stderr tail')

    const outside = db.runsReport(NOW + 10)
    assert.equal(outside[0].invokeCount, 0, 'time window filters runs')
    assert.equal(outside.find((item) => item.id === 'a').lastRunAt, NOW + 1, 'watch fields still reported')
  })
})

test('runsReport last_error only reflects non-ok runs inside the requested window', async () => {
  await withDb(async (db) => {
    db.applyConfig([watchEntry({ id: 'a' })], NOW)
    db.recordRun({
      watchId: 'a', startedAt: NOW - 5 * 3_600_000, finishedAt: NOW - 5 * 3_600_000,
      status: 'invalid_json', notify: false, durationMs: 1, error: 'ancient failure',
    })
    db.recordRun({
      watchId: 'a', startedAt: NOW - 1 * 3_600_000, finishedAt: NOW - 1 * 3_600_000,
      status: 'ok', notify: false, durationMs: 1,
    })

    const recent = db.runsReport(NOW - 3 * 3_600_000)
    assert.equal(recent[0].invokeCount, 1, 'old run is outside the window')
    assert.equal(recent[0].errorCount, 0)
    assert.equal(recent[0].lastError, null, 'stale non-ok run outside the window must not leak into last_error')

    const wide = db.runsReport(NOW - 6 * 3_600_000)
    assert.equal(wide[0].invokeCount, 2)
    assert.equal(wide[0].lastError, 'ancient failure', 'inside the window the non-ok run is reported')
  })
})

test('runsReport counts ok-run checker errors and lets hard failures win last_error', async () => {
  // checker 合法输出 {"notify":false,"error":"..."} 时 run 仍记 status='ok'（如 mailbox 的
  // IMAP/认证故障），error 不能因为不是硬失败而在 watch_runs 里消失。
  await withDb(async (db) => {
    db.applyConfig([watchEntry({ id: 'a' }), watchEntry({ id: 'b' }), watchEntry({ id: 'c' })], NOW)

    // 场景 1：ok + checker error 计入 checkerErrorCount；窗口内无硬失败时 last_error 回退到它。
    const add = (watchId, offset, extra = {}) =>
      db.recordRun({ watchId, startedAt: NOW - offset, finishedAt: NOW - offset, status: 'ok', notify: false, durationMs: 1, ...extra })
    add('a', 3_000, { error: 'older checker error' })
    add('a', 2_000, { error: '[Errno 61] Connection refused' })
    add('a', 1_000)
    add('b', 1_500)
    add('b', 5 * 3_600_000, { error: 'stale checker error' }) // 窗口外

    let report = db.runsReport(NOW - 3_600_000)
    const a = report.find((item) => item.id === 'a')
    assert.equal(a.errorCount, 0, 'status=ok is not a hard failure')
    assert.equal(a.checkerErrorCount, 2, 'every ok run carrying a checker error is counted')
    assert.equal(a.lastError, '[Errno 61] Connection refused', 'last_error falls back to the latest checker error')

    const b = report.find((item) => item.id === 'b')
    assert.equal(b.checkerErrorCount, 0, 'checker error outside the window is not counted')
    assert.equal(b.lastError, null, 'checker error outside the window must not leak into last_error')

    // 场景 2：窗口内存在硬失败时，更新的 checker error 不能盖过它。
    const addMixed = (offset, status, extra = {}) =>
      db.recordRun({ watchId: 'c', startedAt: NOW - offset, finishedAt: NOW - offset, status, notify: false, durationMs: 1, ...extra })
    addMixed(2_000, 'ok', { error: 'IMAP timeout' })
    addMixed(3_000, 'spawn_error', { error: 'ENOENT mail.py' }) // 更早的硬失败
    addMixed(500, 'ok', { error: 'still IMAP timeout' }) // 更新的 checker error 不应盖过硬失败

    report = db.runsReport(NOW - 3_600_000)
    const c = report.find((item) => item.id === 'c')
    assert.equal(c.errorCount, 1)
    assert.equal(c.checkerErrorCount, 2, 'checker errors stay independently counted')
    assert.equal(c.lastError, 'ENOENT mail.py', 'a hard failure wins over any newer checker error')
  })
})

test('applyConfig with more entries than the SQLite parameter limit (33k) keeps soft-delete semantics', async () => {
  await withDb(async (db, file) => {
    const bulk = (index, overrides = {}) => watchEntry({ id: `bulk-${String(index).padStart(5, '0')}`, ...overrides })
    const entries = Array.from({ length: 33_000 }, (_, index) => bulk(index))
    const started = Date.now()
    // 33k 个 id 的 `id NOT IN (...)` 会超过 SQLite 默认 32766 个绑定参数；回归旧实现会抛
    // "too many SQL variables" 使 /watch-reload 整份配置无法生效。
    assert.deepEqual(db.applyConfig(entries, NOW), { added: 33_000, updated: 0, deleted: 0 })
    assert.ok(Date.now() - started < 5_000, `33k-entry reload stays fast (${Date.now() - started}ms)`)

    // 大配置缩减到 1 条：其余全部软删除（逐行路径），既有行不误删。
    assert.deepEqual(db.applyConfig([bulk(0)], NOW + 1), { added: 0, updated: 1, deleted: 32_999 })
    assert.equal(db.getWatch('bulk-00000').isDeleted, false)
    assert.equal(db.getWatch('bulk-00000').updatedAt, NOW + 1)
    assert.equal(db.getWatch('bulk-32999').isDeleted, true)
    assert.equal(rawQuery(file, 'SELECT COUNT(*) AS c FROM watches')[0].c, 33_000, 'soft delete keeps rows')
    assert.equal(rawQuery(file, 'SELECT COUNT(*) AS c FROM watches WHERE is_deleted = 0')[0].c, 1)
  })
})

test('multi-id bookkeeping statements above the SQLite parameter limit use chunks', async () => {
  await withDb(async (db, file) => {
    // 905 个真实 watch 行 > SQL_CHUNK_SIZE(900)：跨分块边界验证记账语句与查询结果。
    const count = 905
    const ids = Array.from({ length: count }, (_, index) => `bulk-${String(index).padStart(4, '0')}`)
    db.applyConfig(ids.map((id) => watchEntry({ id })), NOW)
    db.recordDeliveryFailure(ids, 'bulk delivery failure', NOW - 3_600_000)
    assert.equal(
      rawQuery(file, 'SELECT COUNT(*) AS c FROM watches WHERE delivery_fail_streak > 0')[0].c,
      count,
      'every real watch got its failure counters',
    )

    // getCompensations：905 个真实 id 跨块查询后仍按 ORDER BY id 返回全部记录。
    const compensations = db.getCompensations([...ids].reverse())
    assert.equal(compensations.length, count, 'all real compensation rows are returned across chunks')
    assert.deepEqual(compensations.map((item) => item.id), ids, 'results are globally ordered by id')
    assert.equal(compensations[0].count, 1)
    assert.equal(compensations[0].error, 'bulk delivery failure')

    // markRunsDelivered：905 个真实 run 行跨块更新。
    const runIds = ids.map((id) => db.recordRun({
      watchId: id, startedAt: NOW, finishedAt: NOW, status: 'ok', notify: true, message: 'event', durationMs: 1,
    }))
    assert.equal(runIds.length, count)
    db.markRunsDelivered(runIds)
    assert.equal(rawQuery(file, 'SELECT COUNT(*) AS c FROM runs WHERE delivered = 1')[0].c, count)
    assert.equal(rawQuery(file, 'SELECT COUNT(*) AS c FROM runs WHERE delivered = 0')[0].c, 0)

    // markWatchesNotified：905 个真实 watch 行跨块更新。
    db.markWatchesNotified([...ids].reverse(), NOW + 5)
    assert.equal(rawQuery(file, 'SELECT COUNT(*) AS c FROM watches WHERE last_notify_at = ?', NOW + 5)[0].c, count)

    // clearDeliveryFailures：905 个真实 watch 行跨块清零。
    db.clearDeliveryFailures(ids)
    assert.equal(rawQuery(file, 'SELECT COUNT(*) AS c FROM watches WHERE delivery_fail_streak <> 0')[0].c, 0)
    assert.equal(rawQuery(file, 'SELECT COUNT(*) AS c FROM watches WHERE delivery_fail_count <> 0')[0].c, 0)
    assert.equal(rawQuery(file, 'SELECT COUNT(*) AS c FROM watches')[0].c, count, 'no rows are lost or duplicated')
  })
})

test('fresh DB tightens file/dir permissions; existing dirs are left untouched (POSIX)', {
  skip: process.platform === 'win32' ? 'chmod semantics are platform-specific on Windows' : false,
}, async () => {
  const dir = await makeTmp()
  try {
    const modeOf = async (path) => (await stat(path)).mode & 0o777
    const dbFile = join(dir, 'nested', 'deeper', 'watch.db')
    const db = new WatchDB(dbFile)
    try {
      assert.equal(await modeOf(dbFile), 0o600, 'new watch.db is 0600')
      assert.equal(await modeOf(join(dir, 'nested', 'deeper')), 0o700, 'created parent dir is 0700')
      assert.equal(await modeOf(join(dir, 'nested')), 0o700, 'every created ancestor is 0700')
      // 写入后 WAL/SHM 由 SQLite 创建：同样不能是 0644（runs.message 含通知内容）。
      db.applyConfig([watchEntry({ id: 'a' })], NOW)
      for (const suffix of ['-wal', '-shm']) {
        const path = `${dbFile}${suffix}`
        assert.equal(await exists(path), true, `${suffix} exists while the connection is open`)
        assert.equal(await modeOf(path), 0o600, `${suffix} is 0600`)
      }
    } finally {
      db.close()
    }

    // 已存在的目录权限不被改写（mkdir 的 mode 只作用于新建目录）。
    const existingDir = join(dir, 'existing')
    await mkdir(existingDir, { recursive: true, mode: 0o755 })
    await chmod(existingDir, 0o755)
    const second = new WatchDB(join(existingDir, 'watch.db'))
    try {
      assert.equal(await modeOf(existingDir), 0o755, 'existing parent dir mode is untouched')
      assert.equal(await modeOf(join(existingDir, 'watch.db')), 0o600, 'DB file itself is still tightened')
    } finally {
      second.close()
    }
  } finally {
    await cleanup(dir)
  }
})

test('opening a DB refuses newer schema versions and upgrades user_version 0 to 1', async () => {
  const dir = await makeTmp()
  try {
    const futureFile = join(dir, 'future.db')
    const future = new DatabaseSync(futureFile)
    future.exec('PRAGMA user_version = 2')
    future.close()
    assert.throws(() => new WatchDB(futureFile), /schema|版本|user_version/i, 'future schema version is refused')

    const freshFile = join(dir, 'fresh.db')
    const fresh = new DatabaseSync(freshFile)
    fresh.close() // user_version stays 0
    const db = new WatchDB(freshFile)
    try {
      assert.equal(rawGet(freshFile, 'PRAGMA user_version').user_version, 1, 'user_version 0 is upgraded')
      assert.deepEqual(tableNames(freshFile).filter((name) => ['watches', 'runs'].includes(name)).sort(), ['runs', 'watches'])
    } finally {
      db.close()
    }
  } finally {
    await cleanup(dir)
  }
})

test('a rejected newer schema version closes the opened connection instead of leaking it', async () => {
  const dir = await makeTmp()
  const file = join(dir, 'future-schema.db')
  try {
    const future = new DatabaseSync(file)
    future.exec('PRAGMA user_version = 99')
    future.close()

    // 不新增内部接口：直接监视 DatabaseSync.prototype.close，证明失败路径关闭了已打开的连接。
    const originalClose = DatabaseSync.prototype.close
    let closeCalls = 0
    DatabaseSync.prototype.close = function close(...args) {
      closeCalls += 1
      return originalClose.apply(this, args)
    }
    try {
      assert.throws(
        () => new WatchDB(file),
        (error) => /不支持的数据库 schema 版本 99/.test(String(error?.message)),
        'future schema is rejected with the documented error',
      )
    } finally {
      DatabaseSync.prototype.close = originalClose
    }
    assert.equal(closeCalls, 1, 'the opened connection is closed exactly once on the failure path')

    // 失败路径不会把进程/文件卡住：同一路径随后仍可正常打开读取。
    const reopened = new DatabaseSync(file)
    try {
      assert.equal(Number(reopened.prepare('PRAGMA user_version').get().user_version), 99)
    } finally {
      reopened.close()
    }
    // Windows 上句柄泄漏通常会让文件删不掉；POSIX 恒可删除，这里顺带验证失败路径可清理。
    await rm(file, { force: true })
    assert.equal(await exists(file), false, 'the rejected DB file is removable afterwards')
  } finally {
    await cleanup(dir)
  }
})
