/** SQLite 运行时存储：watches（配置+运行状态）与 runs（执行历史）。 */

import { DatabaseSync } from 'node:sqlite'
import { chmodSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

/** 新建状态目录/库文件的权限：runs.message 会保存 checker 输出（mailbox 通知含发件人/主题）。 */
const DB_DIR_MODE = 0o700
const DB_FILE_MODE = 0o600

/**
 * 尽力把库文件与 WAL/SHM 收紧为 0600。文件可能尚未创建（WAL 懒创建）或平台无 chmod
 * 语义（Windows）：异常一律忽略，不影响数据库可用性。
 */
function tightenDbFilePermissions(file) {
  for (const path of [file, `${file}-wal`, `${file}-shm`]) {
    try {
      chmodSync(path, DB_FILE_MODE)
    } catch {
      /* 不存在或平台不支持：忽略 */
    }
  }
}

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

/**
 * SQLite 默认单条语句最多 32766 个绑定参数（本机 24.21/3.5x 实测）。
 * 多 id 语句统一按小块执行；正常规模（配置行数、单 target 事件数）仍是一条语句，
 * 行为与分块前完全一致，只有极大规模配置不再撞参数上限。
 */
const SQL_CHUNK_SIZE = 900

function* chunks(values, size = SQL_CHUNK_SIZE) {
  for (let offset = 0; offset < values.length; offset += size) {
    yield values.slice(offset, offset + size)
  }
}

/** 与 SQLite TEXT 列的 BINARY collation 一致（按 UTF-8 字节比较）。 */
function compareIds(left, right) {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'))
}

function toNumber(value) {
  if (typeof value === 'bigint') return Number(value)
  return Number(value ?? 0)
}

/** 一个进程一个连接；所有写操作串行、小事务。 */
export class WatchDB {
  constructor(file) {
    mkdirSync(dirname(file), { recursive: true, mode: DB_DIR_MODE })
    this.file = file
    this.db = new DatabaseSync(file)
    // 先收紧主库文件：WAL/SHM 由 SQLite 懒创建时会继承库文件权限（实测继承 0600）。
    tightenDbFilePermissions(file)
    try {
      this.db.exec('PRAGMA journal_mode = WAL')
      this.db.exec('PRAGMA busy_timeout = 5000')
      this.db.exec('PRAGMA synchronous = NORMAL')
      this.db.exec(SCHEMA)
      const version = Number(this.db.prepare('PRAGMA user_version').get().user_version)
      if (version !== 0 && version !== 1) {
        throw new Error(`watch: 不支持的数据库 schema 版本 ${version}（期望 0 或 1）：${file}`)
      }
      if (version === 0) this.db.exec('PRAGMA user_version = 1')
      // schema 初始化后 WAL/SHM 可能已创建，再统一收紧一次。
      tightenDbFilePermissions(file)
    } catch (error) {
      // 初始化失败（含不支持的 schema 版本）时关闭已打开的连接：插件加载失败后连接不应
      // 继续占着文件句柄/WAL 锁。close 自身异常吞掉，避免覆盖原始错误。
      try {
        this.db.close()
      } catch {
        /* 已关闭或关闭失败：保留原始错误 */
      }
      throw error
    }
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
        if (ids.length <= SQL_CHUNK_SIZE) {
          deleted = toNumber(
            this.db
              .prepare(
                `UPDATE watches SET is_deleted = 1, enabled = 0, updated_at = ?
                 WHERE is_deleted = 0 AND id NOT IN (${placeholders(ids.length)})`,
              )
              .run(now, ...ids).changes,
          )
        } else {
          // 配置条目可能超过单条语句的参数上限（默认 32766）：退回「读现有 id + 逐行软删除」，
          // 语义与 id NOT IN (全部 id) 一致，只是不在 SQL 里绑定超大参数列表。
          const keep = new Set(ids)
          const softDelete = this.db.prepare('UPDATE watches SET is_deleted = 1, enabled = 0, updated_at = ? WHERE id = ?')
          for (const row of this.db.prepare('SELECT id FROM watches WHERE is_deleted = 0').all()) {
            if (!keep.has(row.id)) deleted += toNumber(softDelete.run(now, row.id).changes)
          }
        }
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
    const statement = 'UPDATE runs SET delivered = 1 WHERE id IN ('
    for (const chunk of chunks(runIds)) {
      this.db.prepare(`${statement}${placeholders(chunk.length)})`).run(...chunk)
    }
  }

  markWatchesNotified(ids, at) {
    if (ids.length === 0) return
    for (const chunk of chunks(ids)) {
      this.db
        .prepare(`UPDATE watches SET last_notify_at = ?, updated_at = ? WHERE id IN (${placeholders(chunk.length)})`)
        .run(at, at, ...chunk)
    }
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
    const rows = []
    for (const chunk of chunks(ids)) {
      rows.push(
        ...this.db
          .prepare(
            `SELECT id, delivery_fail_count, delivery_first_fail_at, last_delivery_error
             FROM watches WHERE id IN (${placeholders(chunk.length)}) AND delivery_fail_streak > 0`,
          )
          .all(...chunk),
      )
    }
    // 分块查询后按 SQLite 的 BINARY collation 恢复全局 ORDER BY id。
    rows.sort((left, right) => compareIds(left.id, right.id))
    return rows.map((row) => ({
      id: row.id,
      count: row.delivery_fail_count,
      firstFailAt: row.delivery_first_fail_at,
      error: row.last_delivery_error,
    }))
  }

  clearDeliveryFailures(ids) {
    if (ids.length === 0) return
    for (const chunk of chunks(ids)) {
      this.db
        .prepare(
          `UPDATE watches SET
             delivery_fail_count = 0,
             delivery_fail_streak = 0,
             delivery_first_fail_at = NULL,
             last_delivery_error = NULL
           WHERE id IN (${placeholders(chunk.length)})`,
        )
        .run(...chunk)
    }
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
