/** 可选的唤醒预算（token bucket）：容量与补充速率都可按 watch 配置。 */

/**
 * 创建桶（内存态；DSH 重启后回满，pending 丢失，见 design §6.15）。
 * @param {{capacity: number, refillSeconds: number, now: number}} input
 */
export function createBucket({ capacity, refillSeconds, now }) {
  return {
    capacity: Math.max(1, Number(capacity) || 1),
    refillSeconds: Math.max(1, Number(refillSeconds) || 600),
    tokens: Math.max(1, Number(capacity) || 1),
    lastRefillAt: now,
    pending: null,
  }
}

/** 按流逝时间补充 token（不超过容量）。 */
export function refillBucket(bucket, now) {
  const periodMs = bucket.refillSeconds * 1000
  const units = Math.floor((now - bucket.lastRefillAt) / periodMs)
  if (units <= 0) return
  bucket.tokens = Math.min(bucket.capacity, bucket.tokens + units)
  bucket.lastRefillAt += units * periodMs
}

/** 尝试消耗一个 token。 */
export function tryConsume(bucket, now) {
  refillBucket(bucket, now)
  if (bucket.tokens < 1) return false
  bucket.tokens -= 1
  return true
}

/** 把一次事件合并进 pending（保留最新证据，计数累加）。 */
export function mergePending(bucket, event) {
  if (bucket.pending === null) {
    bucket.pending = { ...event, suppressedCount: Math.max(1, Number(event.suppressedCount) || 1) }
    return bucket.pending
  }
  const pending = bucket.pending
  pending.suppressedCount += event.suppressedCount ?? 1
  pending.message = event.message
  pending.messageSource = event.messageSource
  pending.evidence = event.evidence
  pending.at = event.at
  pending.rev = event.rev
  pending.logPath = event.logPath
  return pending
}

/** 取出 pending 并清空。 */
export function takePending(bucket) {
  const pending = bucket.pending
  bucket.pending = null
  return pending
}
