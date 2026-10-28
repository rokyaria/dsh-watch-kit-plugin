/** SQLite 运行时存储：watches（配置+运行状态）与 runs（执行历史）。 */

import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

const SCHEMA = `
CREATE TABLE IF NOT EXISTS watches (
  id TEXT PRIMARY KEY,
  checker TEXT NOT NULL,
  cwd TEXT,
  interval_ms INTEGER NOT NULL,
  timeout_ms INTEGER NOT NULL,
  target TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  is_deleted INTEGER NOT NULL DEFAULT 0,
  last_run_at INTEGER,
  last_notify_at INTEGER,
  delivery_fail_count INTEGER NOT NULL DEFAULT 0,
  delivery_fail_streak INTEGER NOT NULL DEFAULT 0,
  delivery_first_fail_at INTEGER,
  last_delivery_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  watch_id TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  status TEXT NOT NULL,
  notify INTEGER NOT NULL DEFAULT 0,
  message TEXT,
  error TEXT,
  duration_ms INTEGER,
  stderr_tail TEXT,
  delivered INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS runs_watch_time ON runs(watch_id, started_at);
CREATE INDEX IF NOT EXISTS runs_time ON runs(started_at);
`

function toWatch(row) {
  if (row === undefined || row === null) return null
  return {
    id: row.id,
    checker: row.checker,
    cwd: row.cwd,
    intervalMs: row.interval_ms,
    timeoutMs: row.timeout_ms,
    target: row.target,
    enabled: row.enabled === 1,
    isDeleted: row.is_deleted === 1,
    lastRunAt: row.last_run_at,
    lastNotifyAt: row.last_notify_at,
    deliveryFailCount: row.delivery_fail_count,
    deliveryFailStreak: row.delivery_fail_streak,
    deliveryFirstFailAt: row.delivery_first_fail_at,
    lastDeliveryError: row.last_delivery_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function placeholders(count) {
  return Array.from({ length: count }, () => '?').join(',')
}

function toNumber(value) {
  if (typeof value === 'bigint') return Number(value)
  return Number(value ?? 0)
}

/** 一个进程一个连接；所有写操作串行、小事务。 */
export class WatchDB {
  constructor(file) {
    mkdirSync(dirname(file), { recursive: true })
    this.file = file
    this.db = new DatabaseSync(file)
    this.db.exec('PRAGMA journal_mode = WAL')
    this.db.exec('PRAGMA busy_timeout = 5000')
    this.db.exec('PRAGMA synchronous = NORMAL')
    this.db.exec(SCHEMA)
    const version = Number(this.db.prepare('PRAGMA user_version').get().user_version)
    if (version !== 0 && version !== 1) {
      throw new Error(`watch: 不支持的数据库 schema 版本 ${version}（期望 0 或 1）：${file}`)
    }
    if (version === 0) this.db.exec('PRAGMA user_version = 1')
  }

  close() {
    try {
      this.db.close()
    } catch {
      /* 已关闭 */
    }
  }

  transaction(fn) {
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const result = fn()
      this.db.exec('COMMIT')
      return result
    } catch (error) {
      try {
        this.db.exec('ROLLBACK')
      } catch {
        /* 回滚失败时忽略 */
      }
      throw error
    }
  }

  listWatches({ includeDeleted = false } = {}) {
    const sql = includeDeleted
      ? 'SELECT * FROM watches ORDER BY id'
      : 'SELECT * FROM watches WHERE is_deleted = 0 ORDER BY id'
    return this.db.prepare(sql).all().map(toWatch)
  }

  getWatch(id) {
    return toWatch(this.db.prepare('SELECT * FROM watches WHERE id = ?').get(id))
  }

  countWatches() {
    return toNumber(this.db.prepare('SELECT COUNT(*) AS c FROM watches WHERE is_deleted = 0').get().c)
  }

  /**
   * 一轮调度：事务内选出到期 watch 并把 last_run_at 推到 now（claim）。
   * 多进程共享 DB 时也不会重复认领。
   */
  claimDue(now) {
    return this.transaction(() => {
      const rows = this.db
        .prepare(
          `SELECT * FROM watches
           WHERE enabled = 1 AND is_deleted = 0 AND target IS NOT NULL
             AND (last_run_at IS NULL OR (? - last_run_at) > interval_ms)
           ORDER BY id`,
        )
        .all(now)
      const update = this.db.prepare('UPDATE watches SET last_run_at = ?, updated_at = ? WHERE id = ?')
      for (const row of rows) update.run(now, now, row.id)
      return rows.map(toWatch)
    })
  }

  /** 配置文件 → DB 的事务性同步；返回 added/updated/deleted。 */
  applyConfig(entries, now) {
    return this.transaction(() => {
      const exists = this.db.prepare('SELECT id FROM watches WHERE id = ?')
      const upsert = this.db.prepare(
        `INSERT INTO watches
           (id, checker, cwd, interval_ms, timeout_ms, target, enabled, is_deleted, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           checker = excluded.checker,
           cwd = excluded.cwd,
           interval_ms = excluded.interval_ms,
           timeout_ms = excluded.timeout_ms,
           target = excluded.target,
           enabled = excluded.enabled,
           is_deleted = 0,
           updated_at = excluded.updated_at`,
      )
      let added = 0
      let updated = 0
      for (const entry of entries) {
        const previous = exists.get(entry.id)
        upsert.run(
          entry.id,
          entry.checker,
          entry.cwd ?? null,
          entry.intervalMs,
          entry.timeoutMs,
          entry.target,
          entry.enabled ? 1 : 0,
          now,
          now,
        )
        if (previous === undefined) added += 1
        else updated += 1
      }
      let deleted = 0
      if (entries.length === 0) {
        deleted = toNumber(
          this.db.prepare('UPDATE watches SET is_deleted = 1, enabled = 0, updated_at = ? WHERE is_deleted = 0').run(now)
            .changes,
        )
      } else {
        const ids = entries.map((entry) => entry.id)
        deleted = toNumber(
          this.db
            .prepare(
              `UPDATE watches SET is_deleted = 1, enabled = 0, updated_at = ?
               WHERE is_deleted = 0 AND id NOT IN (${placeholders(ids.length)})`,
            )
            .run(now, ...ids).changes,
        )
      }
      return { added, updated, deleted }
    })
  }

  recordRun(run) {
    const info = this.db
      .prepare(
        `INSERT INTO runs
           (watch_id, started_at, finished_at, status, notify, message, error, duration_ms, stderr_tail)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        run.watchId,
        run.startedAt,
        run.finishedAt ?? null,
        run.status,
        run.notify ? 1 : 0,
        run.message ?? null,
        run.error ?? null,
        run.durationMs ?? null,
        run.stderrTail ?? null,
      )
    return toNumber(info.lastInsertRowid)
  }

  markRunsDelivered(runIds) {
    if (runIds.length === 0) return
    this.db
      .prepare(`UPDATE runs SET delivered = 1 WHERE id IN (${placeholders(runIds.length)})`)
      .run(...runIds)
  }

  markWatchesNotified(ids, at) {
    if (ids.length === 0) return
    this.db
      .prepare(`UPDATE watches SET last_notify_at = ?, updated_at = ? WHERE id IN (${placeholders(ids.length)})`)
      .run(at, at, ...ids)
  }

  recordDeliveryFailure(ids, error, at) {
    if (ids.length === 0) return
    const statement = this.db.prepare(
      `UPDATE watches SET
         delivery_fail_count = delivery_fail_count + 1,
         delivery_fail_streak = delivery_fail_streak + 1,
         delivery_first_fail_at = COALESCE(delivery_first_fail_at, ?),
         last_delivery_error = ?,
         updated_at = ?
       WHERE id = ?`,
    )
    this.transaction(() => {
      for (const id of ids) statement.run(at, error, at, id)
    })
  }

  /**
   * 一次成功投递的记账（一个事务，避免半成功状态）。
   * runs.delivered 与 last_notify_at 按 watchIds 记账；clearFailureIds 默认等于 watchIds，
   * 调用方可只传本次消息真正表示（补偿完整写出或被「另有 N 个」汇总行覆盖）的 watch id，
   * 未表示的失败记录保留，供后续补偿/追溯。
   */
  recordDeliverySuccess(runIds, watchIds, at, clearFailureIds = watchIds) {
    return this.transaction(() => {
      this.markRunsDelivered(runIds)
      this.markWatchesNotified(watchIds, at)
      this.clearDeliveryFailures(clearFailureIds)
    })
  }

  getCompensations(ids) {
    if (ids.length === 0) return []
    const rows = this.db
      .prepare(
        `SELECT id, delivery_fail_count, delivery_first_fail_at, last_delivery_error
         FROM watches WHERE id IN (${placeholders(ids.length)}) AND delivery_fail_streak > 0 ORDER BY id`,
      )
      .all(...ids)
    return rows.map((row) => ({
      id: row.id,
      count: row.delivery_fail_count,
      firstFailAt: row.delivery_first_fail_at,
      error: row.last_delivery_error,
    }))
  }

  clearDeliveryFailures(ids) {
    if (ids.length === 0) return
    this.db
      .prepare(
        `UPDATE watches SET
           delivery_fail_count = 0,
           delivery_fail_streak = 0,
           delivery_first_fail_at = NULL,
           last_delivery_error = NULL
         WHERE id IN (${placeholders(ids.length)})`,
      )
      .run(...ids)
  }

  cleanupRuns(before) {
    return toNumber(this.db.prepare('DELETE FROM runs WHERE started_at < ?').run(before).changes)
  }

  /**
   * watch_runs 工具的聚合查询。
   * error_count 只统计 status<>'ok' 的硬失败；checker_error_count 统计 status='ok' 但
   * checker 合法返回了 error 的运行（如 mailbox 的 IMAP/认证故障）；last_error 优先取
   * 窗口内最近一次硬失败，没有硬失败时回退到窗口内最近一次 checker error。
   */
  runsReport(since) {
    const rows = this.db
      .prepare(
        `SELECT w.id AS id,
                w.interval_ms AS interval_ms,
                w.delivery_fail_count AS delivery_fail_count,
                w.last_run_at AS last_run_at,
                w.last_notify_at AS last_notify_at,
                COUNT(r.id) AS invoke_count,
                COALESCE(SUM(CASE WHEN r.notify = 1 AND r.delivered = 1 THEN 1 ELSE 0 END), 0) AS notified_count,
                COALESCE(SUM(CASE WHEN r.status <> 'ok' THEN 1 ELSE 0 END), 0) AS error_count,
                COALESCE(SUM(CASE WHEN r.status = 'ok' AND r.error IS NOT NULL THEN 1 ELSE 0 END), 0) AS checker_error_count,
                COALESCE(SUM(CASE WHEN r.status = 'invalid_json' THEN 1 ELSE 0 END), 0) AS invalid_json_count,
                COALESCE(SUM(CASE WHEN r.status = 'invalid_fields' THEN 1 ELSE 0 END), 0) AS invalid_fields_count,
                COALESCE(SUM(CASE WHEN r.status = 'timeout' THEN 1 ELSE 0 END), 0) AS timeout_count,
                (SELECT COALESCE(r2.error, r2.stderr_tail) FROM runs r2
                  WHERE r2.watch_id = w.id AND r2.started_at >= ?
                    AND (r2.status <> 'ok' OR (r2.status = 'ok' AND r2.error IS NOT NULL))
                  ORDER BY CASE WHEN r2.status <> 'ok' THEN 0 ELSE 1 END, r2.started_at DESC
                  LIMIT 1) AS last_error
         FROM watches w
         LEFT JOIN runs r ON r.watch_id = w.id AND r.started_at >= ?
         WHERE w.is_deleted = 0 AND w.enabled = 1
         GROUP BY w.id
         ORDER BY w.id`,
      )
      .all(since, since)
    return rows.map((row) => ({
      id: row.id,
      intervalSec: Math.round(Number(row.interval_ms) / 1000),
      invokeCount: toNumber(row.invoke_count),
      notifiedCount: toNumber(row.notified_count),
      errorCount: toNumber(row.error_count),
      checkerErrorCount: toNumber(row.checker_error_count),
      invalidJsonCount: toNumber(row.invalid_json_count),
      invalidFieldsCount: toNumber(row.invalid_fields_count),
      timeoutCount: toNumber(row.timeout_count),
      deliveryFailCount: toNumber(row.delivery_fail_count),
      lastRunAt: row.last_run_at,
      lastNotifyAt: row.last_notify_at,
      lastError: row.last_error ?? null,
    }))
  }
}
