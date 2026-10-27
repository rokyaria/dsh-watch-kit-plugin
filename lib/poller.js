/** 轮询调度：claim 到期 watch → 并发跑 checker → 按 target 合并投递 → 失败补偿记账。 */

import { runChecker } from './checker.js'
import { MAX_MERGED_ITEMS, renderMergedMessageDetailed } from './render.js'

export const MAX_CONCURRENT_CHECKS = 4
const RUN_RETENTION_MS = 7 * 24 * 3_600_000

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
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
    this.maxMergedItems = Math.max(1, Math.floor(Number(messageLimits.maxItems) || MAX_MERGED_ITEMS))
    this.now = now
    this.retentionMs = retentionMs
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
    try {
      compensations = this.db.getCompensations(compensationIds)
    } catch {
      compensations = []
    }

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
      this.logger?.warn?.(`watch: target=${target} 没有可投递的事件（消息内容超出上限）`)
      return
    }
    const deliveredIds = deliveredItems.map((item) => item.watch.id)

    try {
      await this.deliver({ target, text: rendered.text })
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
    try {
      this.db.recordDeliverySuccess(runIds, deliveredIds, at)
    } catch (error) {
      this.logger?.warn?.(`watch: 记录投递成功失败：${errorMessage(error)}`)
    }
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
    const close = () => this.db.close()
    if (this.current !== null) this.current.finally(close)
    else close()
  }
}
