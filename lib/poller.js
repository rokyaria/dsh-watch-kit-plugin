/** 轮询调度：claim 到期 watch → 并发跑 checker → 按 target 合并投递 → 失败补偿记账。 */

import { runChecker } from './checker.js'
import { normalizeMaxItems, RENDER_HEADROOM_BYTES, renderMergedMessageDetailed } from './render.js'

export const MAX_CONCURRENT_CHECKS = 4
const RUN_RETENTION_MS = 7 * 24 * 3_600_000
const DEFAULT_DELIVERY_TIMEOUT_MS = 30_000
const DISPOSE_GRACE_MS = 5_000

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

function positive(value, fallback) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number : fallback
}

export class Poller {
  constructor({
    db,
    deliver,
    subprocess,
    logger = console,
    configDir,
    pollIntervalMs = 10_000,
    maxConcurrentChecks = MAX_CONCURRENT_CHECKS,
    checkerLimits = {},
    messageLimits = {},
    now = Date.now,
    retentionMs = RUN_RETENTION_MS,
    deliveryTimeoutMs = DEFAULT_DELIVERY_TIMEOUT_MS,
    disposeGraceMs = DISPOSE_GRACE_MS,
  } = {}) {
    this.db = db
    this.deliver = deliver
    this.subprocess = subprocess
    this.logger = logger
    this.configDir = configDir
    this.pollIntervalMs = pollIntervalMs
    this.maxConcurrentChecks = Math.max(1, Math.floor(Number(maxConcurrentChecks) || 1))
    this.checkerLimits = checkerLimits
    this.messageLimits = messageLimits
    this.maxMergedItems = normalizeMaxItems(messageLimits.maxItems)
    this.now = now
    this.retentionMs = retentionMs
    // 非法/缺失的投递超时回退默认值，避免 0/NaN 让超时退化为立即失败或永不触发。
    this.deliveryTimeoutMs = positive(deliveryTimeoutMs, DEFAULT_DELIVERY_TIMEOUT_MS)
    this.disposeGraceMs = positive(disposeGraceMs, DISPOSE_GRACE_MS)
    this.abort = new AbortController()
    this.stopped = false
    this.current = null
  }

  /** 单飞：上一次 poll 未结束则复用。 */
  poll() {
    if (this.stopped) return Promise.resolve()
    if (this.current !== null) return this.current
    this.current = this.doPoll()
      .catch((error) => {
        this.logger?.warn?.(`watch: poll 失败：${errorMessage(error)}`)
      })
      .finally(() => {
        this.current = null
      })
    return this.current
  }

  async doPoll() {
    const now = this.now()
    let due
    try {
      due = this.db.claimDue(now)
    } catch (error) {
      this.logger?.warn?.(`watch: claim 失败：${errorMessage(error)}`)
      return
    }
    if (due.length === 0) {
      this.cleanup(now)
      return
    }

    const results = []
    for (let index = 0; index < due.length; index += this.maxConcurrentChecks) {
      if (this.stopped) return
      const chunk = due.slice(index, index + this.maxConcurrentChecks)
      const settled = await Promise.all(chunk.map((watch) => this.executeWatch(watch)))
      results.push(...settled.filter((result) => result !== null))
    }
    if (this.stopped) return

    // 跑 checker 期间配置可能被 /watch-reload 改掉：只投递仍然启用、未删除、target 未变的 watch。
    const live = []
    for (const result of results) {
      if (result.status !== 'ok' || result.notify !== true || typeof result.watch.target !== 'string') continue
      let current
      try {
        current = this.db.getWatch(result.watch.id)
      } catch (error) {
        this.logger?.warn?.(`watch: 投递前读取 watch 失败 ${result.watch.id}：${errorMessage(error)}`)
        continue
      }
      if (!current || current.isDeleted === true || current.enabled !== true || current.target !== result.watch.target) {
        this.logger?.warn?.(`watch: 丢弃过期事件 ${result.watch.id}（已删除/停用/target 变更）`)
        continue
      }
      live.push({ ...result, watch: current })
    }

    const byTarget = new Map()
    for (const event of live) {
      const list = byTarget.get(event.watch.target) ?? []
      list.push(event)
      byTarget.set(event.watch.target, list)
    }
    for (const [target, items] of byTarget) {
      try {
        await this.deliverGroup(target, items, now)
      } catch (error) {
        // 单个 target 的渲染/记账异常不应影响其他 target。
        this.logger?.warn?.(`watch: 投递分组失败 target=${target}：${errorMessage(error)}`)
      }
    }
    this.cleanup(now)
  }

  async executeWatch(watch) {
    const startedAt = this.now()
    let argv = []
    try {
      argv = JSON.parse(watch.checker)
    } catch {
      argv = []
    }
    let result
    try {
      result = await runChecker({
        subprocess: this.subprocess,
        watch,
        argv,
        configDir: this.configDir,
        signal: this.abort.signal,
        now: this.now,
        limits: this.checkerLimits,
      })
    } catch (error) {
      result = {
        status: 'spawn_error',
        notify: false,
        message: null,
        error: errorMessage(error),
        stdout: '',
        stderr: '',
        durationMs: 0,
      }
    }
    let runId = null
    try {
      runId = this.db.recordRun({
        watchId: watch.id,
        startedAt,
        finishedAt: this.now(),
        status: result.status,
        notify: result.notify === true,
        message: result.message ?? null,
        error: result.error ?? null,
        durationMs: result.durationMs ?? null,
        stderrTail: result.stderr ?? null,
      })
    } catch (error) {
      // 单条运行记录失败不应中断整轮（否则 claim 后的事件会一起丢失）。
      this.logger?.warn?.(`watch: 记录运行失败 ${watch.id}：${errorMessage(error)}`)
    }
    return { ...result, watch, runId }
  }

  async deliverGroup(target, items, at) {
    // 补偿只需查可能被投递的前 N 个 watch（N 与渲染器上限一致）。
    const compensationIds = items.slice(0, this.maxMergedItems).map((item) => item.watch.id)
    let compensations = []
    let compensationQueryFailed = false
    try {
      compensations = this.db.getCompensations(compensationIds)
    } catch (error) {
      // 查询失败不能当成“没有历史失败”：否则投递成功后会把失败计数全部清零却没有任何补偿，
      // 用户永远看不到这段失败记录。保留计数（clearIds=[]），宁可下一轮多补偿一次。
      compensationQueryFailed = true
      this.logger?.warn?.(`watch: 读取投递失败补偿记录失败 target=${target}：${errorMessage(error)}`)
    }
    // 渲染前的失败集合：只有本次消息真正表示（补偿完整写出或汇总行覆盖）的 watch
    // 才允许清失败计数，被预算丢弃的失败记录保留，事后仍可在 watch_runs 追溯。
    const priorFailIds = new Set(compensations.map((item) => item.id))

    const rendered = renderMergedMessageDetailed({
      items: items.map((item) => ({
        id: item.watch.id,
        intervalMs: item.watch.intervalMs,
        message: item.message,
        error: item.error,
      })),
      compensations,
      now: at,
      maxItems: this.maxMergedItems,
      maxBytes: this.messageLimits.maxBytes,
    })
    const included = new Set(rendered.includedIds)
    const deliveredItems = items.filter((item) => included.has(item.watch.id))
    if (deliveredItems.length === 0) {
      // 通常意味着首条事件本身（即使不算补偿）就超过消息上限：给出可配置线索，
      // 避免只看到一条笼统 warn 时无从排查。
      const configuredMaxBytes = Number(this.messageLimits?.maxBytes)
      const maxBytesHint = Number.isFinite(configuredMaxBytes) && configuredMaxBytes > 0
        ? configuredMaxBytes
        : 16 * 1024
      this.logger?.warn?.(
        `watch: target=${target} 没有可投递的事件（事件内容超出消息上限 maxBytes=${maxBytesHint} + ${RENDER_HEADROOM_BYTES}B 余量，可考虑调大 limits.message.maxBytes）`,
      )
      return
    }
    const deliveredIds = deliveredItems.map((item) => item.watch.id)

    try {
      await this.deliverWithTimeout({ target, text: rendered.text })
    } catch (error) {
      const message = errorMessage(error)
      try {
        this.db.recordDeliveryFailure(deliveredIds, message, at)
      } catch (writeError) {
        this.logger?.warn?.(`watch: 记录投递失败失败：${errorMessage(writeError)}`)
      }
      this.logger?.warn?.(`watch: 投递失败 target=${target}：${message}`)
      return
    }

    const runIds = deliveredItems.map((item) => item.runId).filter((runId) => Number.isFinite(runId))
    const compensated = new Set(rendered.compensatedIds)
    const clearIds = compensationQueryFailed
      ? [] // 查不到历史失败 → 无法判断补偿是否被表示，保留全部计数
      : deliveredIds.filter((id) => !priorFailIds.has(id) || compensated.has(id))
    try {
      this.db.recordDeliverySuccess(runIds, deliveredIds, at, clearIds)
    } catch (error) {
      this.logger?.warn?.(`watch: 记录投递成功失败：${errorMessage(error)}`)
    }
  }

  /**
   * 单个 target 的投递超时保护：host 的 resolveAgent/followup 挂起时不能让
   * 单飞轮次永久 pending（否则调度器静默停摆）。超时按投递失败处理。
   */
  deliverWithTimeout(input) {
    return new Promise((resolve, reject) => {
      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        reject(new Error(`投递超时（${this.deliveryTimeoutMs}ms 内未完成）`))
      }, this.deliveryTimeoutMs)
      timer.unref?.()
      const finish = (action) => (value) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        action(value)
      }
      // 超时后底层 promise 的迟到 resolve/reject 必须被吞掉，避免 unhandledRejection。
      Promise.resolve()
        .then(() => this.deliver(input))
        .then(finish(resolve), finish(reject))
    })
  }

  cleanup(now) {
    try {
      this.db.cleanupRuns(now - this.retentionMs)
    } catch {
      /* 清理失败不影响主流程 */
    }
  }

  dispose() {
    if (this.stopped) return
    this.stopped = true
    this.abort.abort()
    let closed = false
    let graceTimer
    const close = () => {
      if (closed) return
      closed = true
      clearTimeout(graceTimer)
      try {
        this.db.close()
      } catch (error) {
        this.logger?.warn?.(`watch: 关闭数据库失败：${errorMessage(error)}`)
      }
    }
    // in-flight 轮次可能因投递挂起永不 settle：只等约 5s，之后强制关闭 DB。
    graceTimer = setTimeout(() => {
      this.logger?.warn?.(`watch: dispose 等待 in-flight 轮次超时（${this.disposeGraceMs}ms），强制关闭 DB`)
      close()
    }, this.disposeGraceMs)
    graceTimer.unref?.()
    if (this.current !== null) this.current.then(close, close)
    else close()
  }
}
