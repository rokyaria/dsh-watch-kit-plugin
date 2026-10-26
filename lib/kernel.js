/** 内核：调度、执行、失败计数、合并窗口与投递。依赖全部可注入，便于单测。 */

import { access, constants, mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createBucket, mergePending, takePending, tryConsume } from './budget.js'
import { effectiveTriggerMsg } from './conf.js'
import { localDayStamp, nextDueAt, nowIso } from './ids.js'
import { watchEnv } from './exec.js'
import { parseEventOutput } from './event.js'
import { renderBatchFrame, renderEventFrame, renderFailureFrame } from './frame.js'
import {
  fileSha256 as defaultFileSha256,
  renderScriptChangedNotice,
  sameFingerprint,
  scriptFingerprint as defaultScriptFingerprint,
} from './integrity.js'
import { appendAudit, appendRunLog, cleanupRemoved, cleanupWatchLogs } from './logs.js'
import { resolveRunner as defaultResolveRunner } from './runner.js'
import { tailLines } from './text.js'

/** 连续失败进入失败帧的默认阈值。 */
export const FAILURE_THRESHOLD = 5
/** 投递失败后的最大重试次数。 */
export const DELIVERY_RETRY_LIMIT = 3

/**
 * 下一次到期时间：以"开始时刻"为基准的固定频率（不随执行时长漂移）；
 * 另加 1s 最小间隔，防御"执行时长 > INTERVAL"这类本不该发生的超限情况
 * （正常配置下 TIMEOUT ≤ INTERVAL/2，所以这个下限不会生效）。
 */
export function computeNextDue({ startedAt, finishedAt, intervalSec, id, minGapMs = 1000 }) {
  const fixedRate = nextDueAt(startedAt, intervalSec, id)
  return Math.max(fixedRate, finishedAt + minGapMs)
}

/** @returns 连续失败的原因；成功/事件返回 null。 */
export function classifyFailure(result) {
  if (result?.spawnError) return `spawn_error: ${String(result.spawnError).split('\n')[0]}`
  if (result?.timedOut) return 'timeout'
  if (result?.code === null || result?.code === undefined) return `signal:${result.signal ?? 'unknown'}`
  if (result.code === 0 || result.code === 1) return null
  return `exit ${result.code}`
}

function defaultIsExecutable(path) {
  return access(path, constants.X_OK).then(
    () => true,
    () => false,
  )
}

export class Kernel {
  constructor({
    registry,
    config = {},
    logger = console,
    now = Date.now,
    resolveRunner = defaultResolveRunner,
    runCheck,
    parseEvent = parseEventOutput,
    deliver = async () => ({ ok: true }),
    schedule = (fn, ms) => setTimeout(fn, ms),
    cancel = (timer) => clearTimeout(timer),
    platform = process.platform,
    resolveExecutable = async () => null,
    isExecutable = defaultIsExecutable,
    failureThreshold = FAILURE_THRESHOLD,
    retryDelayMs = 30_000,
    deliveryRetryLimit = DELIVERY_RETRY_LIMIT,
    fileSha256 = defaultFileSha256,
    scriptFingerprint = defaultScriptFingerprint,
    integrityNotifyDelayMs = 5000,
  } = {}) {
    if (typeof runCheck !== 'function') throw new TypeError('Kernel requires a runCheck function')
    this.registry = registry
    this.config = {
      batchWindowMs: 2000,
      maxConcurrentChecks: 4,
      maxEvidenceBytes: 8192,
      maxStderrLines: 20,
      logRetentionDays: 14,
      logMaxBytesPerWatch: 20 * 1024 * 1024,
      integrityNotifyDelayMs,
      ...config,
    }
    this.logger = logger
    this.now = now
    this.resolveRunner = resolveRunner
    this.runCheck = runCheck
    this.parseEvent = parseEvent
    this.deliver = deliver
    this.schedule = schedule
    this.cancel = cancel
    this.platform = platform
    this.resolveExecutable = resolveExecutable
    this.isExecutable = isExecutable
    this.failureThreshold = failureThreshold
    this.retryDelayMs = retryDelayMs
    this.deliveryRetryLimit = deliveryRetryLimit
    this.fileSha256 = fileSha256
    this.scriptFingerprint = scriptFingerprint
    this.batches = new Map()
    this.inflight = new Set()
    this.stopped = false
    this.ticking = false
    this.lastCleanupDay = null
  }

  /** 启动：扫描 specDirs 并立即执行一轮（补报停机期间的事件）。 */
  async start() {
    await this.registry.scan()
    await this.tick()
  }

  runningCount() {
    let count = 0
    for (const entry of this.registry.list()) if (entry.inFlight) count += 1
    return count
  }

  /** 一次调度：刷新配置、清理日志、启动到期的检查。 */
  async tick(now = this.now()) {
    if (this.stopped || this.ticking) return
    this.ticking = true
    try {
      try {
        await this.registry.scanIfChanged()
      } catch (error) {
        this.logger.warn?.(`watch: scan failed: ${error instanceof Error ? error.message : error}`)
      }
      await this.maintain(now)
      try {
        await this.refreshScriptIntegrity(now)
      } catch (error) {
        this.logger.warn?.(`watch: script integrity check failed: ${error instanceof Error ? error.message : error}`)
      }
      const room = Math.max(0, Number(this.config.maxConcurrentChecks) - this.runningCount())
      if (room === 0) return
      const due = this.registry
        .list()
        .filter(
          (entry) =>
            entry.state.status === 'active' &&
            entry.state.enabled !== false &&
            entry.inFlight !== true &&
            entry.removing !== true &&
            now >= entry.nextDueAt,
        )
        .sort((left, right) => left.nextDueAt - right.nextDueAt)
        .slice(0, room)
      for (const entry of due) this.launch(entry)
    } finally {
      this.ticking = false
    }
  }

  launch(entry) {
    if (entry.inFlight) return
    entry.inFlight = true
    const task = this.runOne(entry)
      .catch((error) => {
        this.logger.warn?.(`watch ${entry.id}: run failed: ${error instanceof Error ? error.stack ?? error.message : error}`)
      })
      .finally(() => {
        entry.inFlight = false
        this.inflight.delete(task)
      })
    this.inflight.add(task)
  }

  /** 等待当前所有检查结束（测试与优雅退出用）。 */
  async idle() {
    while (this.inflight.size > 0) {
      await Promise.allSettled([...this.inflight])
    }
  }

  async runOne(entry, startedAt = this.now()) {
    if (entry.removing === true) return
    if (entry.state.status === 'needs_validation') return
    const conf = entry.conf
    try {
      await mkdir(entry.dataDir, { recursive: true })
      await mkdir(entry.logsDir, { recursive: true })
      if (entry.runnerArgv === null) {
        const argv = await this.resolveRunner({
          platform: this.platform,
          checkPath: resolve(entry.dir, conf.check),
          runner: conf.runner,
          isExecutable: this.isExecutable,
          resolveExecutable: this.resolveExecutable,
        })
        if (argv === null) {
          entry.runnerError = 'runner_not_found'
          this.logger.warn?.(`watch ${entry.id}: runner_not_found (RUNNER=${conf.runner}, CHECK=${conf.check})`)
          return
        }
        entry.runnerArgv = argv
        entry.runnerError = null
      }
      const result = await this.runCheck({
        watchDir: entry.dir,
        argv: entry.runnerArgv,
        timeoutMs: conf.timeoutSec * 1000,
        env: watchEnv({
          id: entry.id,
          watchDir: entry.dir,
          dataDir: entry.dataDir,
          logsDir: entry.logsDir,
          intervalSec: conf.intervalSec,
        }),
        maxStdoutBytes: this.config.maxEvidenceBytes,
        stderrTailLines: this.config.maxStderrLines,
      })
      // /watch-remove 已开始归档时丢弃迟到结果，避免把旧目录写回来。
      if (entry.removing !== true) await this.recordResult(entry, result)
    } finally {
      entry.nextDueAt = computeNextDue({
        startedAt,
        finishedAt: this.now(),
        intervalSec: conf.intervalSec,
        id: entry.id,
      })
      entry.inFlight = false
    }
  }

  /** 每个 tick：检查 active watch 的脚本是否被替换；到期的通知投递出去。 */
  async refreshScriptIntegrity(now) {
    for (const entry of this.registry.list()) {
      if (entry.state.status === 'active') {
        await this.inspectScript(entry, now)
      } else if (entry.state.status === 'needs_validation') {
        await this.notifyScriptChange(entry, now)
      }
    }
  }

  async inspectScript(entry, now) {
    const state = entry.state
    const scriptPath = resolve(entry.dir, entry.conf.check)
    const fingerprint = await this.scriptFingerprint(scriptPath)

    // 旧版本 state 没有 scriptHash：只建立基线，不打扰。
    if (state.scriptHash == null) {
      if (fingerprint === null) return
      state.scriptPath = scriptPath
      state.scriptHash = await this.fileSha256(scriptPath)
      entry.scriptFingerprint = fingerprint
      await this.registry.writeState(entry, state)
      return
    }
    if (state.scriptPath !== null && state.scriptPath !== scriptPath) {
      return this.markScriptChanged(entry, now, scriptPath, 'check_path_changed', null)
    }
    if (fingerprint === null) {
      return this.markScriptChanged(entry, now, scriptPath, 'script_missing', null)
    }
    if (sameFingerprint(fingerprint, entry.scriptFingerprint)) return
    const hash = await this.fileSha256(scriptPath)
    entry.scriptFingerprint = fingerprint
    if (hash !== state.scriptHash) {
      await this.markScriptChanged(entry, now, scriptPath, 'script_changed', hash)
    }
  }

  async markScriptChanged(entry, now, scriptPath, reason, currentHash) {
    const state = entry.state
    if (state.status === 'needs_validation') return
    state.status = 'needs_validation'
    state.scriptPath = scriptPath
    state.scriptChangedAt = nowIso(now)
    state.scriptNotifyAt = now + Math.max(0, Number(this.config.integrityNotifyDelayMs) || 0)
    state.scriptPendingHash = currentHash
    state.scriptChangeReason = reason
    entry.runnerArgv = null
    entry.nextDueAt = 0
    entry.noticeAttempts = 0
    entry.noticeRetryAt = undefined
    await this.registry.writeState(entry, state)
    this.logger.warn?.(`watch ${entry.id}: script changed (${reason}); polling paused until watch_validate`)
    try {
      await appendAudit({
        logsDir: entry.logsDir,
        at: state.scriptChangedAt,
        event: 'script_changed',
        id: entry.id,
        sessionId: state.target ?? undefined,
        detail: reason,
      })
    } catch {
      /* 审计失败不阻塞 */
    }
  }

  async notifyScriptChange(entry, now) {
    const state = entry.state
    if (state.scriptNotifyAt == null || now < state.scriptNotifyAt) return
    if (state.scriptPendingHash !== null && state.scriptNotifiedHash === state.scriptPendingHash) return
    if (entry.noticeRetryAt !== undefined && now < entry.noticeRetryAt) return
    const target = this.targetOf(entry)
    if (target === null) {
      // 没有可通知的会话：消费掉待通知，避免每个 tick 空转。
      this.logger.warn?.(`watch ${entry.id}: script change notice dropped (no target session)`)
      state.scriptNotifiedHash = state.scriptPendingHash
      try {
        await this.registry.writeState(entry, state)
      } catch {
        /* 状态写入失败不阻塞 */
      }
      return
    }
    const frame = renderScriptChangedNotice({
      id: entry.id,
      at: nowIso(now),
      scriptPath: state.scriptPath ?? resolve(entry.dir, entry.conf.check),
      previousHash: state.scriptHash,
      currentHash: state.scriptPendingHash,
      reason: state.scriptChangeReason ?? 'script_changed',
    })
    let result
    try {
      result = await this.deliver({ target, frame })
    } catch (error) {
      result = { error }
    }
    if (result !== undefined && result !== null && result.error !== undefined) {
      // 与触发路径同一套重试纪律：retryDelayMs 间隔、最多 deliveryRetryLimit 次，之后丢弃并审计。
      const attempts = (entry.noticeAttempts ?? 0) + 1
      if (attempts < this.deliveryRetryLimit) {
        entry.noticeAttempts = attempts
        entry.noticeRetryAt = now + Math.max(0, Number(this.retryDelayMs) || 0)
        return
      }
      entry.noticeAttempts = 0
      entry.noticeRetryAt = undefined
      state.scriptNotifiedHash = state.scriptPendingHash
      try {
        await this.registry.writeState(entry, state)
      } catch {
        /* 状态写入失败不阻塞 */
      }
      try {
        await appendAudit({
          logsDir: entry.logsDir,
          at: nowIso(now),
          event: 'script_change_drop',
          id: entry.id,
          sessionId: target,
          detail: `attempts=${attempts} error=${describeError(result.error)}`,
        })
      } catch {
        /* 审计失败不阻塞 */
      }
      return
    }
    entry.noticeAttempts = 0
    entry.noticeRetryAt = undefined
    state.scriptNotifiedHash = state.scriptPendingHash
    await this.registry.writeState(entry, state)
    try {
      await appendAudit({
        logsDir: entry.logsDir,
        at: nowIso(now),
        event: 'script_change_notified',
        id: entry.id,
        sessionId: target,
      })
    } catch {
      /* 忽略 */
    }
  }

  /** 该 watch 的唤醒预算桶；未配置（capacity=0）时返回 null。 */
  budgetFor(entry, now) {
    const capacity = Number(entry.conf.budgetCapacity) || 0
    if (capacity <= 0) return null
    const refillSeconds = Number(entry.conf.budgetRefillSec) || 600
    if (
      entry.budget === undefined ||
      entry.budget.capacity !== capacity ||
      entry.budget.refillSeconds !== refillSeconds
    ) {
      entry.budget = createBucket({ capacity, refillSeconds, now })
    }
    return entry.budget
  }

  /** 事件投递：无预算直接投；有预算则按 token 投递/合并（不丢弃证据）。
   * triggerCount / lastTriggerAt 在 flush 成功投递后统计（见 flush）。 */
  async deliverEvent(entry, state, result, parsed, at) {
    const event = {
      kind: 'event',
      entry,
      id: entry.id,
      target: this.targetOf(entry),
      at,
      rev: state.rev,
      messageSource: parsed.message ? 'script' : 'config',
      message: parsed.message ?? effectiveTriggerMsg(entry.conf),
      evidence: parsed.evidence ?? result.stdout,
      logPath: this.logPath(entry, at),
    }
    const bucket = this.budgetFor(entry, this.now())
    if (bucket === null) {
      await this.registry.writeState(entry, state)
      this.enqueue(event)
      return 'event'
    }

    // 先尝试把之前被抑制的证据补投出去（消耗一个 token）。
    // triggerCount 在 flush 成功投递后统计（见 flush），这里只负责入队。
    if (bucket.pending !== null && tryConsume(bucket, this.now())) {
      const pending = takePending(bucket)
      pending.kind = 'event'
      pending.entry = entry
      pending.id = entry.id
      pending.target = event.target
      pending.evidence = appendBudgetNote(pending.evidence, pending.suppressedCount)
      this.enqueue(pending)
    }

    if (bucket.pending !== null) {
      mergePending(bucket, { ...event, suppressedCount: 1 })
      state.suppressedTotal = (state.suppressedTotal ?? 0) + 1
      await this.registry.writeState(entry, state)
      return 'suppressed'
    }

    if (tryConsume(bucket, this.now())) {
      this.enqueue(event)
    } else {
      mergePending(bucket, { ...event, suppressedCount: 1 })
      state.suppressedTotal = (state.suppressedTotal ?? 0) + 1
      await this.registry.writeState(entry, state)
      return 'suppressed'
    }
    await this.registry.writeState(entry, state)
    return 'event'
  }

  /** 任何一次检查结束后，若预算 token 可用且存在 pending，就先补投证据。 */
  async flushBudgetPending(entry) {
    const bucket = this.budgetFor(entry, this.now())
    if (bucket === null || bucket.pending === null) return
    if (!tryConsume(bucket, this.now())) return
    const pending = takePending(bucket)
    pending.kind = 'event'
    pending.entry = entry
    pending.id = entry.id
    pending.target = this.targetOf(entry)
    pending.evidence = appendBudgetNote(pending.evidence, pending.suppressedCount)
    this.enqueue(pending)
  }

  async recordResult(entry, result) {
    const at = nowIso(this.now())
    await this.flushBudgetPending(entry)
    const state = entry.state
    state.lastRunAt = at
    state.lastExit = result.code
    state.lastDurationMs = result.durationMs

    const failure = classifyFailure(result)
    if (failure !== null) return this.recordFailure(entry, failure, result, at)

    if (result.code === 1) {
      const parsed = this.parseEvent({
        code: 1,
        stdout: result.stdout,
        lossy: result.stdoutLossy === true,
      })
      if (parsed.kind === 'invalid') {
        return this.recordFailure(entry, `event_json_invalid:${parsed.reason}`, result, at)
      }
      this.resetFailures(state)
      state.lastEventAt = at
      const note = await this.deliverEvent(entry, state, result, parsed, at)
      await this.logRun(entry, result, at, note)
      return
    }

    this.resetFailures(state)
    await this.registry.writeState(entry, state)
    await this.logRun(entry, result, at, 'ok')
  }

  resetFailures(state) {
    state.failures = 0
    state.failureReported = false
    state.firstFailureAt = null
    state.lastErrorTail = null
  }

  async recordFailure(entry, reason, result, at) {
    const state = entry.state
    state.failures = (state.failures ?? 0) + 1
    state.lastErrorAt = at
    state.firstFailureAt ??= at
    state.lastErrorTail = tailLines(
      result.stderrTail || result.spawnError || reason,
      this.config.maxStderrLines,
    )
    let report = false
    if (state.failures >= this.failureThreshold && state.failureReported !== true) {
      state.failureReported = true
      report = true
    }
    await this.registry.writeState(entry, state)
    await this.logRun(entry, result, at, reason)
    if (report) {
      this.enqueue({
        kind: 'failure',
        entry,
        id: entry.id,
        target: this.targetOf(entry),
        at,
        failures: state.failures,
        threshold: this.failureThreshold,
        message:
          entry.conf.failureMsg ||
          `watch ${entry.id} 连续失败 ${state.failures} 次，已记录；轮询继续。`,
        firstFailureAt: state.firstFailureAt,
        lastFailureAt: at,
        errorTail: state.lastErrorTail,
        logPath: this.logPath(entry, at),
      })
    }
  }

  targetOf(entry) {
    return entry.conf.targets[0] ?? entry.state.target ?? null
  }

  logPath(entry, at) {
    return join(entry.logsDir, `${localDayStamp(new Date(at))}.log`)
  }

  async logRun(entry, result, at, note) {
    try {
      await appendRunLog({
        logsDir: entry.logsDir,
        id: entry.id,
        at,
        code: result.code,
        timedOut: result.timedOut,
        signal: result.signal,
        lossy: result.stdoutLossy,
        durationMs: result.durationMs,
        bytes: Buffer.byteLength(result.stdout ?? '', 'utf8'),
        note,
      })
    } catch (error) {
      this.logger.warn?.(`watch ${entry.id}: run log failed: ${error instanceof Error ? error.message : error}`)
    }
  }

  /** 加入合并窗口（同一目标会话在窗口内只唤醒一次）。 */
  enqueue(item) {
    if (item.target === null) {
      this.logger.warn?.(`watch ${item.id}: no target session; trigger dropped`)
      return
    }
    let batch = this.batches.get(item.target)
    if (batch === undefined) {
      batch = { items: [], timer: null, attempts: 0 }
      this.batches.set(item.target, batch)
    }
    batch.items.push(item)
    if (batch.timer === null) {
      batch.timer = this.schedule(() => {
        batch.timer = null
        void this.flush(item.target)
      }, this.config.batchWindowMs)
    }
  }

  /** 渲染并投递一个目标会话的合并窗口。 */
  async flush(target) {
    const batch = this.batches.get(target)
    if (batch === undefined) return
    if (batch.timer !== null) this.cancel(batch.timer)
    batch.timer = null
    this.batches.delete(target)
    if (batch.items.length === 0) return

    const at = batch.items[0].at
    const frame =
      batch.items.length === 1
        ? this.renderSingle(batch.items[0])
        : renderBatchFrame(batch.items, { at })

    let result
    try {
      result = await this.deliver({ target, frame })
    } catch (error) {
      result = { error }
    }

    if (result !== undefined && result !== null && result.error !== undefined) {
      const attempts = batch.attempts + 1
      for (const item of batch.items) {
        try {
          await this.registry.markOrphaned(item.entry)
        } catch {
          /* 状态写入失败不阻塞清理 */
        }
      }
      if (attempts < this.deliveryRetryLimit) {
        batch.attempts = attempts
        this.batches.set(target, batch)
        batch.timer = this.schedule(() => {
          batch.timer = null
          void this.flush(target)
        }, this.retryDelayMs)
        return
      }
      await this.audit(target, 'trigger_drop', `attempts=${attempts} error=${describeError(result.error)}`)
      return
    }
    await this.audit(target, 'trigger_delivered', `items=${batch.items.length}`)
    // triggerCount 语义：实际投递成功的唤醒次数。同一 watch 在同一合并帧里的多条事件只计一次；
    // 投递失败最终被丢弃的不计数（被唤醒预算合并的见 suppressedTotal）。
    const delivered = new Set()
    for (const item of batch.items) {
      if (item.kind !== 'event' || item.entry === undefined || delivered.has(item.entry)) continue
      delivered.add(item.entry)
      const itemState = item.entry.state
      itemState.triggerCount = (itemState.triggerCount ?? 0) + 1
      itemState.lastTriggerAt = nowIso(this.now())
      try {
        await this.registry.writeState(item.entry, itemState)
      } catch {
        /* 状态写入失败不阻塞投递审计 */
      }
    }
  }

  /** 立即冲刷所有待投递批次（测试与优雅退出用；重试仍按 schedule 重新排期）。 */
  async flushAll() {
    for (const [target, batch] of [...this.batches.entries()]) {
      if (batch.timer !== null) this.cancel(batch.timer)
      batch.timer = null
      await this.flush(target)
    }
  }

  renderSingle(item) {
    if (item.kind === 'event') return renderEventFrame(item, { maxEvidenceBytes: this.config.maxEvidenceBytes })
    return renderFailureFrame(item)
  }

  async audit(target, event, detail) {
    const first = this.firstEntry()
    if (first === undefined) return
    try {
      await appendAudit({ logsDir: first.logsDir, event, id: target, detail })
    } catch {
      /* 审计失败不阻塞 */
    }
  }

  firstEntry() {
    return this.registry.list()[0]
  }

  /** 每日清理：日志保留期 / 大小上限 / .removed 归档。 */
  async maintain(now = this.now()) {
    const day = localDayStamp(new Date(now))
    if (day === this.lastCleanupDay) return
    this.lastCleanupDay = day
    for (const entry of this.registry.list()) {
      try {
        await cleanupWatchLogs(entry.dir, {
          retentionDays: this.config.logRetentionDays,
          maxBytes: this.config.logMaxBytesPerWatch,
          now,
        })
      } catch {
        /* 忽略单个 watch 的清理失败 */
      }
    }
    const roots = new Set(this.registry.list().map((entry) => entry.root))
    for (const root of roots) {
      try {
        await cleanupRemoved(root, { days: 7, now })
      } catch {
        /* 忽略 */
      }
    }
  }

  /** 停止内核：取消所有合并窗口定时器。 */
  dispose() {
    this.stopped = true
    for (const batch of this.batches.values()) {
      if (batch.timer !== null) this.cancel(batch.timer)
      batch.timer = null
    }
    this.batches.clear()
  }
}

function describeError(error) {
  if (error instanceof Error) return error.message
  return String(error)
}


/** 合并被抑制事件时给证据追加说明。 */
export function appendBudgetNote(evidence, suppressedCount) {
  const count = Math.max(0, Number(suppressedCount) || 0)
  if (count === 0) return evidence
  const note = `（唤醒预算：合并了 ${count} 条较早的触发，证据以最新一条为准）`
  const base = typeof evidence === 'string' ? evidence.trimEnd() : ''
  return base === '' ? note : `${base}\n${note}`
}
