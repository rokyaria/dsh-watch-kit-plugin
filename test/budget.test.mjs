import assert from 'node:assert/strict'
import test from 'node:test'
import { createBucket, mergePending, refillBucket, takePending, tryConsume } from '../lib/budget.js'

test('createBucket：初始满桶、参数兜底', () => {
  const bucket = createBucket({ capacity: 3, refillSeconds: 60, now: 1000 })
  assert.equal(bucket.tokens, 3)
  assert.equal(bucket.lastRefillAt, 1000)
  assert.equal(bucket.pending, null)
})

test('refillBucket 按流逝时间补充并封顶', () => {
  const bucket = createBucket({ capacity: 2, refillSeconds: 60, now: 0 })
  bucket.tokens = 0
  refillBucket(bucket, 59_000)
  assert.equal(bucket.tokens, 0)
  refillBucket(bucket, 60_000)
  assert.equal(bucket.tokens, 1)
  refillBucket(bucket, 600_000)
  assert.equal(bucket.tokens, 2)
})

test('tryConsume 耗尽后拒绝', () => {
  const bucket = createBucket({ capacity: 1, refillSeconds: 60, now: 0 })
  assert.equal(tryConsume(bucket, 0), true)
  assert.equal(tryConsume(bucket, 0), false)
  assert.equal(tryConsume(bucket, 61_000), true)
})

test('mergePending 计数累加并保留最新证据，takePending 清空', () => {
  const bucket = createBucket({ capacity: 1, refillSeconds: 60, now: 0 })
  mergePending(bucket, { message: 'first', evidence: 'e1', suppressedCount: 1 })
  mergePending(bucket, { message: 'second', evidence: 'e2', suppressedCount: 1 })
  assert.equal(bucket.pending.suppressedCount, 2)
  assert.equal(bucket.pending.message, 'second')
  assert.equal(bucket.pending.evidence, 'e2')
  const pending = takePending(bucket)
  assert.equal(pending.message, 'second')
  assert.equal(bucket.pending, null)
})
