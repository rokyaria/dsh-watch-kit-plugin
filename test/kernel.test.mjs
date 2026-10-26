import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { fileSha256, scriptFingerprint } from '../lib/integrity.js'
import { computeNextDue, Kernel } from '../lib/kernel.js'
import { nextDueAt } from '../lib/ids.js'
import { cleanup, makeEntry, makeFakeRegistry, makeTmp } from './helpers/fixtures.mjs'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function setup({ results = [], entries = 1, config = {}, deliver } = {}) {
  const root = await makeTmp()
  const watchEntries = []
  for (let index = 0; index < entries; index += 1) {
    const dir = `${root}/w${index}`
    await import('node:fs/promises').then((fs) => fs.mkdir(dir, { recursive: true }))
    watchEntries.push(makeEntry({ dir, id: index === 0 ? 'demo' : `demo-${index}` }))
  }
  const registry = makeFakeRegistry(watchEntries)
  const calls = []
  let cursor = 0
  const runCheck = async (args) => {
    calls.push(args)
    const result = results[Math.min(cursor, results.length - 1)] ?? { code: 0, durationMs: 1 }
    cursor += 1
    return { stdout: '', stdoutLossy: false, stderrTail: '', timedOut: false, signal: null, durationMs: 1, ...result }
  }
  const frames = []
  let clock = 1_800_000_000_000
  const kernel = new Kernel({
    registry,
    config: { batchWindowMs: 60_000, maxConcurrentChecks: 4, maxEvidenceBytes: 8192, maxStderrLines: 20, ...config },
    logger: { warn() {}, error() {} },
    now: () => clock,
    runCheck,
    deliver: async ({ target, frame }) => {
      frames.push({ target, frame })
      return deliver ? deliver(target, frame) : { ok: true }
    },
    retryDelayMs: 5,
  })
  return { kernel, registry, entries: watchEntries, calls, frames, setNow: (ms) => { clock = ms }, cleanup: () => cleanup(root) }
}

test('事件：code=1 + 纯文本 → message 来自配置，evidence 来自 stdout', async () => {
  const ctx = await setup({ results: [{ code: 1, stdout: '有新邮件' }] })
  try {
    await ctx.kernel.runOne(ctx.entries[0])
    await ctx.kernel.flushAll()
    assert.equal(ctx.frames.length, 1)
    assert.match(ctx.frames[0].frame, /message_source=config/)
    assert.match(ctx.frames[0].frame, /请处理这个事件/)
    assert.match(ctx.frames[0].frame, /有新邮件/)
    assert.equal(ctx.entries[0].state.triggerCount, 1)
  } finally {
    await ctx.cleanup()
  }
})

test('事件：JSON 覆盖 message 与 evidence', async () => {
  const ctx = await setup({ results: [{ code: 1, stdout: '{"message":"动态消息","evidence":"动态证据"}' }] })
  try {
    await ctx.kernel.runOne(ctx.entries[0])
    await ctx.kernel.flushAll()
    assert.match(ctx.frames[0].frame, /message_source=script/)
    assert.match(ctx.frames[0].frame, /动态消息/)
    assert.match(ctx.frames[0].frame, /动态证据/)
  } finally {
    await ctx.cleanup()
  }
})

test('非法 JSON 事件记为失败且不触发', async () => {
  const ctx = await setup({ results: [{ code: 1, stdout: '{bad' }] })
  try {
    await ctx.kernel.runOne(ctx.entries[0])
    await ctx.kernel.flushAll()
    assert.equal(ctx.frames.length, 0)
    assert.equal(ctx.entries[0].state.failures, 1)
    assert.match(ctx.entries[0].state.lastErrorTail, /event_json_invalid:json_parse/)
  } finally {
    await ctx.cleanup()
  }
})

test('连续失败 5 次只报一次，成功清零', async () => {
  const ctx = await setup({ results: [{ code: 255, stderr: 'boom' }] })
  try {
    for (let index = 0; index < 6; index += 1) await ctx.kernel.runOne(ctx.entries[0])
    await ctx.kernel.flushAll()
    assert.equal(ctx.frames.length, 1)
    assert.match(ctx.frames[0].frame, /reason=failure failures=5\/5/)
    assert.equal(ctx.entries[0].state.failures, 6)
    assert.equal(ctx.entries[0].state.failureReported, true)

    const success = await setup({ results: [{ code: 0 }] })
    try {
      success.entries[0].state.failures = 3
      success.entries[0].state.failureReported = true
      await success.kernel.runOne(success.entries[0])
      assert.equal(success.entries[0].state.failures, 0)
      assert.equal(success.entries[0].state.failureReported, false)
    } finally {
      await success.cleanup()
    }
  } finally {
    await ctx.cleanup()
  }
})

test('超时与异常退出都计为失败', async () => {
  const ctx = await setup({ results: [{ timedOut: true, code: null }, { code: 7 }] })
  try {
    await ctx.kernel.runOne(ctx.entries[0])
    assert.equal(ctx.entries[0].state.failures, 1)
    assert.match(ctx.entries[0].state.lastErrorTail, /timeout/)
    await ctx.kernel.runOne(ctx.entries[0])
    assert.equal(ctx.entries[0].state.failures, 2)
    assert.match(ctx.entries[0].state.lastErrorTail, /exit 7/)
  } finally {
    await ctx.cleanup()
  }
})

test('唤醒预算：容量 1/60s，超额合并证据，补充后补投一条', async () => {
  const ctx = await setup({ results: [{ code: 1, stdout: '证据' }] })
  try {
    const entry = ctx.entries[0]
    entry.conf.budgetCapacity = 1
    entry.conf.budgetRefillSec = 60

    await ctx.kernel.runOne(entry)
    await ctx.kernel.flushAll()
    assert.equal(ctx.frames.length, 1)
    assert.equal(entry.state.triggerCount, 1)

    await ctx.kernel.runOne(entry)
    await ctx.kernel.flushAll()
    assert.equal(ctx.frames.length, 1, 'suppressed event must not wake')
    assert.equal(entry.state.suppressedTotal, 1)

    ctx.setNow(1_800_000_000_000 + 61_000)
    await ctx.kernel.runOne(entry)
    await ctx.kernel.flushAll()
    assert.equal(ctx.frames.length, 2, 'pending evidence flushed after refill')
    assert.match(ctx.frames[1].frame, /合并了 1 条/)
    assert.equal(entry.state.suppressedTotal, 2)
  } finally {
    await ctx.cleanup()
  }
})

test('唤醒预算：补充 token 后，无事件的检查也会补投 pending', async () => {
  const ctx = await setup({ results: [{ code: 1, stdout: 'event-1' }, { code: 1, stdout: 'event-2' }, { code: 0 }] })
  try {
    const entry = ctx.entries[0]
    entry.conf.budgetCapacity = 1
    entry.conf.budgetRefillSec = 60

    await ctx.kernel.runOne(entry)
    await ctx.kernel.flushAll()
    assert.equal(ctx.frames.length, 1)

    await ctx.kernel.runOne(entry) // suppressed
    await ctx.kernel.flushAll()
    assert.equal(ctx.frames.length, 1)
    assert.equal(entry.state.suppressedTotal, 1)

    ctx.setNow(1_800_000_000_000 + 61_000)
    await ctx.kernel.runOne(entry) // code 0，但 token 可用 → 补投 pending
    await ctx.kernel.flushAll()
    assert.equal(ctx.frames.length, 2)
    assert.match(ctx.frames[1].frame, /合并了 1 条/)
    assert.equal(entry.state.triggerCount, 2)
  } finally {
    await ctx.cleanup()
  }
})

test('同一目标会话在窗口内合并为一条 batch 帧', async () => {
  const ctx = await setup({ results: [{ code: 1, stdout: 'a' }, { code: 1, stdout: 'b' }], entries: 2 })
  try {
    await Promise.all([ctx.kernel.runOne(ctx.entries[0]), ctx.kernel.runOne(ctx.entries[1])])
    await ctx.kernel.flushAll()
    assert.equal(ctx.frames.length, 1)
    assert.match(ctx.frames[0].frame, /batch=2/)
    assert.match(ctx.frames[0].frame, /\[1\/2\]/)
    assert.match(ctx.frames[0].frame, /\[2\/2\]/)
  } finally {
    await ctx.cleanup()
  }
})

test('投递失败：标记 orphaned 并重试 3 次后放弃', async () => {
  const ctx = await setup({ results: [{ code: 1, stdout: 'a' }], deliver: async () => ({ error: new Error('nope') }) })
  try {
    await ctx.kernel.runOne(ctx.entries[0])
    await ctx.kernel.flushAll()
    await sleep(60)
    assert.equal(ctx.frames.length, 3)
    assert.equal(ctx.registry.calls.markOrphaned.length >= 1, true)
    assert.equal(ctx.entries[0].state.status, 'orphaned')
  } finally {
    await ctx.cleanup()
  }
})

test('computeNextDue：固定频率基准 + 1s 最小间隔防御', () => {
  const normal = computeNextDue({ startedAt: 0, finishedAt: 20_000, intervalSec: 60, id: 'demo' })
  assert.equal(normal, nextDueAt(0, 60, 'demo'))
  assert.ok(normal > 21_000, String(normal))

  const overrun = computeNextDue({ startedAt: 0, finishedAt: 70_000, intervalSec: 60, id: 'demo' })
  assert.equal(overrun, 71_000)
})

test('脚本被外部修改：暂停轮询、通知一次，validate 前不恢复', async () => {
  const root = await makeTmp()
  try {
    const dir = join(root, 'demo')
    await mkdir(dir, { recursive: true })
    const scriptPath = join(dir, 'check.sh')
    await writeFile(scriptPath, '#!/bin/bash\nexit 0\n', 'utf8')
    const entry = makeEntry({ dir })
    entry.state.scriptPath = scriptPath
    entry.state.scriptHash = await fileSha256(scriptPath)
    entry.scriptFingerprint = await scriptFingerprint(scriptPath)
    const registry = makeFakeRegistry([entry])
    const frames = []
    const calls = []
    const kernel = new Kernel({
      registry,
      config: { batchWindowMs: 60_000, maxConcurrentChecks: 4, maxEvidenceBytes: 8192, maxStderrLines: 20, integrityNotifyDelayMs: 0 },
      logger: { warn() {}, error() {} },
      now: () => clock,
      runCheck: async (args) => {
        calls.push(args)
        return { code: 0, signal: null, timedOut: false, durationMs: 1, stdout: '', stdoutLossy: false, stderrTail: '' }
      },
      deliver: async ({ frame }) => {
        frames.push(frame)
        return { ok: true }
      },
    })

    await writeFile(scriptPath, '#!/bin/bash\nexit 0\n# changed outside dsh\n', 'utf8')
    await kernel.tick(1_800_000_000_000)
    assert.equal(entry.state.status, 'needs_validation')
    assert.equal(calls.length, 0, 'must not poll after script change')

    await kernel.tick(1_800_000_000_001)
    assert.equal(frames.length, 1)
    assert.match(frames[0], /\[WATCH NOTICE\] id=demo reason=script_changed/)
    assert.match(frames[0], /watch_validate/)

    await kernel.tick(1_800_000_000_002)
    assert.equal(frames.length, 1, 'notice must not repeat')
  } finally {
    await cleanup(root)
  }
})

test('tick 跳过正在删除的 watch', async () => {
  const ctx = await setup({ results: [{ code: 0 }] })
  try {
    ctx.entries[0].removing = true
    await ctx.kernel.tick()
    await ctx.kernel.idle()
    assert.equal(ctx.calls.length, 0)
  } finally {
    await ctx.cleanup()
  }
})

test('tick 只调度 active/due 的 watch，并受并发上限约束', async () => {
  const ctx = await setup({ results: [{ code: 0 }, { code: 0 }], entries: 2, config: { maxConcurrentChecks: 1 } })
  try {
    ctx.entries[1].state.status = 'paused'
    await ctx.kernel.tick()
    await ctx.kernel.idle()
    assert.equal(ctx.calls.length, 1)
    assert.equal(ctx.calls[0].argv !== undefined, true)

    ctx.entries[1].state.status = 'active'
    await ctx.kernel.tick()
    await ctx.kernel.idle()
    assert.equal(ctx.calls.length, 2)
    assert.equal(ctx.registry.calls.scanned, 2)
  } finally {
    await ctx.cleanup()
  }
})
test('triggerCount：同一 watch 在同一合并帧里的多条事件只计一次', async () => {
  const ctx = await setup({})
  try {
    const entry = ctx.entries[0]
    const eventItem = {
      kind: 'event',
      entry,
      id: entry.id,
      target: 'session-test',
      at: '2026-10-26T14:10:03.000Z',
      rev: 1,
      messageSource: 'config',
      message: '请处理',
      evidence: '',
      logPath: '/w/logs/x.log',
    }
    ctx.kernel.enqueue(eventItem)
    ctx.kernel.enqueue({ ...eventItem, at: '2026-10-26T14:10:04.000Z' })
    await ctx.kernel.flushAll()
    assert.equal(ctx.frames.length, 1)
    assert.match(ctx.frames[0].frame, /batch=2/)
    assert.equal(entry.state.triggerCount, 1)
    assert.ok(entry.state.lastTriggerAt)
  } finally {
    await ctx.cleanup()
  }
})

test('triggerCount：投递失败最终被丢弃的事件不计数', async () => {
  const ctx = await setup({ deliver: async () => ({ error: new Error('nope') }) })
  try {
    const entry = ctx.entries[0]
    ctx.kernel.enqueue({
      kind: 'event',
      entry,
      id: entry.id,
      target: 'session-test',
      at: '2026-10-26T14:10:03.000Z',
      rev: 1,
      messageSource: 'config',
      message: '请处理',
      evidence: '',
      logPath: '',
    })
    await ctx.kernel.flushAll()
    await sleep(40) // retryDelayMs=5：3 次尝试后丢弃
    assert.equal(entry.state.triggerCount, 0)
    assert.equal(entry.state.status, 'orphaned')
  } finally {
    await ctx.cleanup()
  }
})

test('脚本变化通知：投递失败按重试纪律退避，最多 3 次后放弃', async () => {
  const root = await makeTmp()
  try {
    const dir = join(root, 'demo')
    await mkdir(dir, { recursive: true })
    const scriptPath = join(dir, 'check.sh')
    await writeFile(scriptPath, '#!/bin/bash\nexit 0\n', 'utf8')
    const entry = makeEntry({ dir })
    entry.state.scriptPath = scriptPath
    entry.state.scriptHash = await fileSha256(scriptPath)
    entry.scriptFingerprint = await scriptFingerprint(scriptPath)
    const registry = makeFakeRegistry([entry])
    let clock = 1_800_000_000_000
    let deliveries = 0
    const kernel = new Kernel({
      registry,
      config: { batchWindowMs: 60_000, maxConcurrentChecks: 4, maxEvidenceBytes: 8192, maxStderrLines: 20, integrityNotifyDelayMs: 0 },
      logger: { warn() {}, error() {} },
      now: () => clock,
      runCheck: async () => ({ code: 0, signal: null, timedOut: false, durationMs: 1, stdout: '', stdoutLossy: false, stderrTail: '' }),
      deliver: async () => {
        deliveries += 1
        return { error: new Error('unreachable') }
      },
      retryDelayMs: 5,
    })

    await writeFile(scriptPath, '#!/bin/bash\nexit 0\n# changed\n', 'utf8')
    await kernel.tick(clock) // 标记变化，安排通知（延迟 0）
    assert.equal(entry.state.status, 'needs_validation')

    await kernel.tick(clock + 1) // 第 1 次尝试
    assert.equal(deliveries, 1)
    await kernel.tick(clock + 2) // 仍在退避窗口内，不重试
    assert.equal(deliveries, 1)
    await kernel.tick(clock + 7) // 第 2 次尝试
    assert.equal(deliveries, 2)
    await kernel.tick(clock + 13) // 第 3 次尝试（最后一次）
    assert.equal(deliveries, 3)
    await kernel.tick(clock + 20) // 已放弃：不再尝试，通知被消费
    assert.equal(deliveries, 3)
    assert.equal(entry.state.scriptNotifiedHash, entry.state.scriptPendingHash)
  } finally {
    await cleanup(root)
  }
})

