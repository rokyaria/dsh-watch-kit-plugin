/**
 * Poller contract (contract §5): claim due watches → run checkers → merge
 * notify=true results per target into one delivery → delivery success/failure
 * accounting + one-time compensation → 7-day run cleanup → single-flight,
 * concurrency cap and dispose.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { Poller } from '../lib/poller.js'
import { MAX_MERGED_ITEMS, RENDER_HEADROOM_BYTES } from '../lib/render.js'
import {
  cleanup, makeFakeSubprocess, makeLogger, makeSession, makeTmp, openDb, rawQuery, watchEntry, waitFor,
} from './helpers/harness.mjs'

const NOW = 1_800_000_000_000
const MINUTE = 60_000

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 有界等待：promise 永不 settle 时用例快速失败而不是挂起。 */
function withDeadline(promise, ms = 1_000, label = 'poll') {
  let timer
  const deadline = new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} 未在 ${ms}ms 内 settle`)), ms)
  })
  return Promise.race([promise, deadline]).finally(() => clearTimeout(timer))
}

async function withPoller(options, fn) {
  const dir = await makeTmp()
  const { db, file } = openDb(dir)
  const logger = makeLogger()
  const session = options.session ?? makeSession()
  const subprocess = options.subprocess ?? makeFakeSubprocess([{ stdout: '{"notify":false}' }])
  const deliverCalls = []
  const failPlan = options.failPlan ?? []
  const deliver = async (input) => {
    const attempt = deliverCalls.length + 1
    deliverCalls.push(input)
    const step = typeof failPlan === 'function' ? failPlan(attempt, input) : failPlan[attempt - 1]
    if (step === 'throw') throw new Error('delivery failed')
    if (step === 'hang') return new Promise(() => {})
    if (step !== null && typeof step === 'object') {
      if (typeof step.rejectAfterMs === 'number') {
        await sleep(step.rejectAfterMs)
        throw step.error instanceof Error ? step.error : new Error(String(step.error ?? 'late delivery failure'))
      }
      throw step instanceof Error ? step : new Error(String(step))
    }
    if (step !== undefined) throw step instanceof Error ? step : new Error(String(step))
  }
  const clock = { value: options.now ?? NOW }
  const poller = new Poller({
    db,
    deliver,
    subprocess,
    logger,
    configDir: '/config',
    pollIntervalMs: 10_000,
    now: () => clock.value,
    maxConcurrentChecks: options.maxConcurrentChecks ?? 4,
    messageLimits: options.messageLimits,
    retentionMs: options.retentionMs,
    deliveryTimeoutMs: options.deliveryTimeoutMs,
    disposeGraceMs: options.disposeGraceMs,
  })
  try {
    return await fn({ poller, db, file, logger, subprocess, deliverCalls, clock, session })
  } finally {
    try { poller.dispose() } catch { /* already closed */ }
    try { db.close() } catch { /* already closed */ }
    await cleanup(dir)
  }
}

test('poll claims due watches, records ok runs and does not deliver notify=false', async () => {
  await withPoller({}, async ({ poller, db, file, deliverCalls }) => {
    db.applyConfig([watchEntry({ id: 'quiet' })], NOW)
    await poller.poll()
    assert.equal(deliverCalls.length, 0)
    const runs = rawQuery(file, 'SELECT * FROM runs')
    assert.equal(runs.length, 1)
    assert.equal(runs[0].status, 'ok')
    assert.equal(runs[0].notify, 0)
    assert.equal(runs[0].delivered, 0)
    assert.equal(db.getWatch('quiet').lastRunAt, NOW, 'claim wrote last_run_at')
  })
})

test('notify=true results are merged per target into exactly one message each', async () => {
  const subprocess = makeFakeSubprocess((spec) => {
    const id = spec.env.WATCH_ID
    return { stdout: JSON.stringify({ notify: true, message: `event from ${id}`, error: id === 'a' ? 'warn' : null }) }
  })
  await withPoller({ subprocess }, async ({ poller, db, file, deliverCalls }) => {
    db.applyConfig([
      watchEntry({ id: 'a', target: 'session-1' }),
      watchEntry({ id: 'b', target: 'session-1', intervalMs: 30_000 }),
      watchEntry({ id: 'c', target: 'session-2' }),
    ], NOW)
    await poller.poll()
    assert.equal(deliverCalls.length, 2, 'one delivery per target, not per watch')
    const byTarget = Object.fromEntries(deliverCalls.map((call) => [call.target, call.text]))
    assert.match(byTarget['session-1'], /\[WATCH 通知\] 2 个事件/)
    assert.ok(byTarget['session-1'].includes('event from a'))
    assert.ok(byTarget['session-1'].includes('event from b'))
    assert.ok(byTarget['session-1'].includes('[error] warn'))
    assert.match(byTarget['session-2'], /\[WATCH 通知\] 1 个事件/)

    const runs = rawQuery(file, 'SELECT watch_id, delivered FROM runs ORDER BY watch_id')
    assert.equal(runs.length, 3, 'one run row per watch')
    assert.equal(runs.every((run) => run.delivered === 1), true)
    assert.equal(db.getWatch('a').lastNotifyAt, NOW)
    assert.equal(db.getWatch('c').lastNotifyAt, NOW)
  })
})

test('invalid_json / invalid_fields / spawn_error / timeout are recorded but never delivered', async () => {
  const subprocess = makeFakeSubprocess((spec) => {
    const id = spec.env.WATCH_ID
    if (id === 'invalid-json') return { stdout: 'not json' }
    if (id === 'invalid-fields') return { stdout: '{"notify":"yes"}' }
    if (id === 'spawn-error') return { spawnError: 'ENOENT bash' }
    return { stdout: '{"notify":true,"message":"never"}', hang: true }
  })
  await withPoller({ subprocess }, async ({ poller, db, file, deliverCalls }) => {
    db.applyConfig([
      watchEntry({ id: 'invalid-json' }),
      watchEntry({ id: 'invalid-fields' }),
      watchEntry({ id: 'spawn-error' }),
      watchEntry({ id: 'timeout', timeoutMs: 15 }),
    ], NOW)
    await poller.poll()
    assert.equal(deliverCalls.length, 0)
    const statuses = Object.fromEntries(rawQuery(file, 'SELECT watch_id, status, delivered FROM runs').map((row) => [row.watch_id, row]))
    assert.equal(statuses['invalid-json'].status, 'invalid_json')
    assert.equal(statuses['invalid-fields'].status, 'invalid_fields')
    assert.equal(statuses['spawn-error'].status, 'spawn_error')
    assert.equal(statuses.timeout.status, 'timeout')
    assert.equal(rawQuery(file, 'SELECT COUNT(*) AS c FROM runs WHERE delivered = 1')[0].c, 0)
    assert.equal(db.getWatch('invalid-json').lastNotifyAt, null)
  })
})

test('delivery failure increments counters, leaves runs undelivered and does not retry the message', async () => {
  const subprocess = makeFakeSubprocess([{ stdout: '{"notify":true,"message":"event"}' }])
  await withPoller({ subprocess, failPlan: ['throw'] }, async ({ poller, db, file, deliverCalls }) => {
    db.applyConfig([watchEntry({ id: 'a' })], NOW)
    await poller.poll()
    assert.equal(deliverCalls.length, 1, 'no replay/retry of the message')
    const watch = db.getWatch('a')
    assert.equal(watch.deliveryFailCount, 1)
    assert.equal(watch.deliveryFailStreak, 1)
    assert.equal(watch.deliveryFirstFailAt, NOW)
    assert.match(String(watch.lastDeliveryError), /delivery failed/)
    assert.equal(watch.lastNotifyAt, null)
    assert.equal(rawQuery(file, 'SELECT delivered FROM runs')[0].delivered, 0)
  })
})

test('the next successful delivery carries the one-time compensation and resets the counters', async () => {
  const subprocess = makeFakeSubprocess([{ stdout: '{"notify":true,"message":"first"}' }, { stdout: '{"notify":true,"message":"second"}' }, { stdout: '{"notify":true,"message":"third"}' }])
  await withPoller({ subprocess, failPlan: ['throw'] }, async ({ poller, db, deliverCalls, clock }) => {
    db.applyConfig([watchEntry({ id: 'a' })], NOW)
    await poller.poll() // delivery fails
    assert.equal(deliverCalls.length, 1)

    clock.value += MINUTE + 1
    await poller.poll() // retry succeeds, carries compensation once
    const compensated = deliverCalls[1].text
    assert.equal(deliverCalls.length, 2)
    assert.equal(compensated.split('[投递失败补偿]').length, 2, 'one compensation section')
    assert.ok(compensated.includes('second'))
    assert.ok(compensated.includes('投递失败 1 次'))
    const watch = db.getWatch('a')
    assert.equal(watch.deliveryFailCount, 0)
    assert.equal(watch.deliveryFailStreak, 0)
    assert.equal(watch.deliveryFirstFailAt, null)
    assert.equal(watch.lastNotifyAt, clock.value)

    clock.value += MINUTE + 1
    await poller.poll() // later delivery has no compensation
    assert.equal(deliverCalls.length, 3)
    assert.ok(!deliverCalls[2].text.includes('[投递失败补偿]'))
  })
})

test('compensation counts streak failures and starts over after a successful delivery', async () => {
  const subprocess = makeFakeSubprocess(() => ({ stdout: '{"notify":true,"message":"event"}' }))
  const failPlan = (attempt) => (attempt === 1 || attempt === 2 || attempt === 4 ? 'throw' : undefined)
  await withPoller({ subprocess, failPlan }, async ({ poller, db, deliverCalls, clock }) => {
    db.applyConfig([watchEntry({ id: 'a' })], NOW)
    await poller.poll()
    clock.value += MINUTE + 1
    await poller.poll()
    clock.value += MINUTE + 1
    await poller.poll() // first success after 2 failures
    assert.ok(deliverCalls[2].text.includes('投递失败 2 次'))
    assert.equal(db.getWatch('a').deliveryFailCount, 0)

    clock.value += MINUTE + 1
    await poller.poll()
    clock.value += MINUTE + 1
    await poller.poll() // new failure then success -> count restarts at 1
    assert.ok(deliverCalls[4].text.includes('投递失败 1 次'))
  })
})

test('poll is single-flight: concurrent calls share one claim/round', async () => {
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const subprocess = {
    spawns: [],
    spawn() {
      this.spawns.push(1)
      const done = gate.then(() => ({ exitCode: 0, signal: null }))
      return {
        done,
        terminate() {},
        collected: { stdout: { readFrom: () => ({ text: '{"notify":false}', nextOffset: 17, lossy: false }) }, stderr: { readFrom: () => ({ text: '', nextOffset: 0 }) } },
      }
    },
  }
  await withPoller({ subprocess }, async ({ poller, db, file }) => {
    db.applyConfig([watchEntry({ id: 'a' })], NOW)
    const first = poller.poll()
    const second = poller.poll()
    assert.equal(first, second, 'single-flight returns the in-flight promise')
    release()
    await first
    assert.equal(subprocess.spawns.length, 1, 'one checker run for the shared round')
    assert.equal(rawQuery(file, 'SELECT COUNT(*) AS c FROM runs')[0].c, 1)
  })
})

test('checker concurrency inside a round is capped at 4', async () => {
  const gates = []
  const spawned = []
  let active = 0
  let maxActive = 0
  const subprocess = {
    spawn(spec) {
      spawned.push(spec)
      active += 1
      maxActive = Math.max(maxActive, active)
      let resolveDone
      const done = new Promise((resolve) => { resolveDone = resolve })
      gates.push(() => { active -= 1; resolveDone({ exitCode: 0, signal: null }) })
      return {
        done,
        terminate() {},
        collected: { stdout: { readFrom: () => ({ text: '{"notify":false}', nextOffset: 17, lossy: false }) }, stderr: { readFrom: () => ({ text: '', nextOffset: 0 }) } },
      }
    },
  }
  await withPoller({ subprocess }, async ({ poller, db, file }) => {
    db.applyConfig(Array.from({ length: 6 }, (_, index) => watchEntry({ id: `w${index}` })), NOW)
    const round = poller.poll()
    await waitFor(() => spawned.length === 4)
    assert.equal(maxActive, 4, 'max 4 checker processes in flight')
    for (const release of gates.splice(0, 4)) release()
    await waitFor(() => spawned.length === 6)
    for (const release of gates.splice(0)) release()
    await round
    assert.equal(spawned.length, 6)
    assert.equal(rawQuery(file, 'SELECT COUNT(*) AS c FROM runs')[0].c, 6)
  })
})

test('dispose stops polling, aborts the checker signal and closes the DB after the current round', async () => {
  let release
  const gate = new Promise((resolve) => { release = resolve })
  const spawned = []
  const subprocess = {
    spawn(spec) {
      spawned.push(spec)
      return {
        done: gate.then(() => ({ exitCode: 0, signal: null })),
        terminate() {},
        collected: { stdout: { readFrom: () => ({ text: '{"notify":false}', nextOffset: 17, lossy: false }) }, stderr: { readFrom: () => ({ text: '', nextOffset: 0 }) } },
      }
    },
  }
  await withPoller({ subprocess }, async ({ poller, db }) => {
    db.applyConfig([watchEntry({ id: 'a' })], NOW)
    const round = poller.poll()
    await waitFor(() => spawned.length === 1)
    poller.dispose()
    assert.equal(spawned[0].signal.aborted, true, 'in-flight checker is aborted')
    await poller.poll() // stopped: resolves without claiming
    assert.equal(spawned.length, 1)
    release()
    await round
    assert.throws(() => db.getWatch('a'), /database|closed|not open/i)
  })
})

test('each poll cleans runs older than the retention window', async () => {
  await withPoller({}, async ({ poller, db, file }) => {
    db.applyConfig([watchEntry({ id: 'a' })], NOW)
    db.recordRun({ watchId: 'a', startedAt: NOW - 8 * 24 * 3_600_000, finishedAt: NOW - 8 * 24 * 3_600_000, status: 'ok', notify: false, durationMs: 1 })
    db.recordRun({ watchId: 'a', startedAt: NOW - 1_000, finishedAt: NOW - 1_000, status: 'ok', notify: false, durationMs: 1 })
    await poller.poll()
    const rows = rawQuery(file, 'SELECT started_at FROM runs')
    assert.equal(rows.length, 2, 'old run removed, fresh run + new poll run kept')
    assert.equal(rows.some((row) => row.started_at === NOW - 8 * 24 * 3_600_000), false)
  })
})

test('only events included in the merged message are marked delivered/notified', async () => {
  const subprocess = makeFakeSubprocess((spec) => ({
    stdout: JSON.stringify({ notify: true, message: `event ${spec.env.WATCH_ID}` }),
  }))
  await withPoller({ subprocess }, async ({ poller, db, file, deliverCalls }) => {
    const ids = Array.from({ length: 21 }, (_, index) => `w${String(index).padStart(2, '0')}`)
    db.applyConfig(ids.map((id) => watchEntry({ id, target: 'session-1' })), NOW)
    db.recordDeliveryFailure(['w20'], 'old gateway error', NOW - 2 * 3_600_000)

    await poller.poll()

    assert.equal(deliverCalls.length, 1, 'one merged delivery for the target')
    const text = deliverCalls[0].text
    assert.match(text, /^\[WATCH 通知\] 21 个事件/)
    assert.ok(text.includes('event w19'))
    assert.equal(text.includes('event w20'), false, 'the 21st event is dropped by the 20-item cap')
    assert.match(text, /…另有 1 个事件未列出/)
    assert.ok(!text.includes('[投递失败补偿]'), 'compensation for an omitted watch is not rendered')

    const runs = rawQuery(file, 'SELECT watch_id, delivered FROM runs ORDER BY watch_id')
    assert.equal(runs.length, 21, 'every checker produced a run row')
    assert.equal(runs.filter((run) => run.delivered === 1).length, 20, 'only included runs are marked delivered')
    assert.equal(runs.find((run) => run.watch_id === 'w20').delivered, 0)

    const omitted = db.getWatch('w20')
    assert.equal(omitted.lastNotifyAt, null, 'omitted watch is not marked notified')
    assert.equal(omitted.deliveryFailStreak, 1, 'omitted compensation is not cleared')
    assert.equal(omitted.deliveryFailCount, 1)
    assert.equal(omitted.lastDeliveryError, 'old gateway error')
    assert.equal(db.getWatch('w19').lastNotifyAt, NOW, 'included watch is marked notified')
    assert.equal(db.listWatches().filter((watch) => watch.lastNotifyAt !== null).length, 20)
  })
})

test('a recordRun failure is logged and does not abort the round or delivery', async () => {
  const subprocess = makeFakeSubprocess((spec) => ({
    stdout: JSON.stringify({ notify: true, message: `event ${spec.env.WATCH_ID}` }),
  }))
  await withPoller({ subprocess }, async ({ poller, db, file, deliverCalls, logger }) => {
    db.applyConfig([watchEntry({ id: 'good' }), watchEntry({ id: 'bad' })], NOW)
    const original = db.recordRun.bind(db)
    let failed = false
    db.recordRun = (run) => {
      if (run.watchId === 'bad' && !failed) {
        failed = true
        throw new Error('run insert boom')
      }
      return original(run)
    }

    await poller.poll()

    assert.equal(failed, true)
    assert.equal(deliverCalls.length, 1, 'round continues after the failed run insert')
    assert.ok(deliverCalls[0].text.includes('event good'))
    assert.ok(deliverCalls[0].text.includes('event bad'))
    const runs = rawQuery(file, 'SELECT watch_id, delivered FROM runs')
    assert.equal(runs.length, 1, 'only the failing watch is missing its run row')
    assert.equal(runs[0].watch_id, 'good')
    assert.equal(runs[0].delivered, 1)
    assert.ok(logger.lines.some((line) => line.level === 'warn' && /记录运行失败 bad/.test(line.message)))
  })
})

test('delivery bookkeeping is atomic: a failed notify write leaves runs undelivered', async () => {
  const subprocess = makeFakeSubprocess([
    { stdout: '{"notify":true,"message":"event"}' },
    { stdout: '{"notify":true,"message":"event"}' },
  ])
  await withPoller({ subprocess }, async ({ poller, db, file, deliverCalls, logger, clock }) => {
    db.applyConfig([watchEntry({ id: 'a' })], NOW)
    const original = db.markWatchesNotified.bind(db)
    db.markWatchesNotified = () => { throw new Error('notify write boom') }

    await poller.poll()

    assert.equal(deliverCalls.length, 1)
    assert.equal(rawQuery(file, 'SELECT delivered FROM runs')[0].delivered, 0, 'transaction rolled back the delivered flag')
    assert.equal(db.getWatch('a').lastNotifyAt, null)
    assert.ok(logger.lines.some((line) => line.level === 'warn' && /记录投递成功失败/.test(line.message)))

    db.markWatchesNotified = original
    clock.value += MINUTE + 1
    await poller.poll()
    assert.equal(rawQuery(file, 'SELECT delivered FROM runs ORDER BY id')[1].delivered, 1)
    assert.equal(db.getWatch('a').lastNotifyAt, clock.value)
  })
})

test('a failed compensation lookup preserves failure counters instead of clearing them without rendering', async () => {
  const subprocess = makeFakeSubprocess([
    { stdout: '{"notify":true,"message":"first event"}' },
    { stdout: '{"notify":true,"message":"second event"}' },
  ])
  await withPoller({ subprocess }, async ({ poller, db, file, deliverCalls, logger, clock }) => {
    db.applyConfig([watchEntry({ id: 'a' })], NOW)
    db.recordDeliveryFailure(['a'], 'earlier delivery failure', NOW - 3_600_000)

    const original = db.getCompensations.bind(db)
    db.getCompensations = () => { throw new Error('compensation query boom') }
    try {
      await poller.poll()
    } finally {
      db.getCompensations = original
    }

    assert.equal(deliverCalls.length, 1, 'the event itself is still delivered')
    assert.equal(deliverCalls[0].text.includes('[投递失败补偿]'), false, 'no compensation could be rendered')
    const watch = db.getWatch('a')
    assert.equal(watch.lastNotifyAt, NOW, 'delivery/notify accounting still happens')
    // 关键回归：查询失败不能被当成“没有历史失败”而清空计数——否则失败记录永久消失且无补偿。
    assert.equal(watch.deliveryFailCount, 1, 'failure count is preserved')
    assert.equal(watch.deliveryFailStreak, 1, 'failure streak is preserved')
    assert.equal(watch.lastDeliveryError, 'earlier delivery failure')
    assert.ok(
      logger.lines.some((line) => line.level === 'warn' && /读取投递失败补偿记录失败/.test(line.message)),
      'the compensation query failure is logged as a warning',
    )
    assert.equal(rawQuery(file, 'SELECT COUNT(*) AS c FROM runs')[0].c, 1, 'the event run is recorded exactly once')

    // 下一轮查询恢复后，历史失败仍会被一次性补偿并清零。
    clock.value += MINUTE + 1
    await poller.poll()
    assert.equal(deliverCalls.length, 2)
    assert.match(deliverCalls[1].text, /\[投递失败补偿\]/)
    assert.match(deliverCalls[1].text, /投递失败 1 次/)
    const recovered = db.getWatch('a')
    assert.equal(recovered.deliveryFailCount, 0)
    assert.equal(recovered.deliveryFailStreak, 0)
  })
})

test('stale events are dropped when the watch is deleted/disabled/retargeted between claim and delivery', async () => {
  const subprocess = makeFakeSubprocess((spec) => ({
    stdout: JSON.stringify({ notify: true, message: `event ${spec.env.WATCH_ID}` }),
  }))
  await withPoller({ subprocess }, async ({ poller, db, file, deliverCalls, logger }) => {
    db.applyConfig(['deleted', 'disabled', 'keep', 'retarget'].map((id) => watchEntry({ id })), NOW)
    const original = db.getWatch.bind(db)
    db.getWatch = (id) => {
      const watch = original(id)
      if (!watch) return watch
      if (id === 'deleted') return { ...watch, isDeleted: true }
      if (id === 'disabled') return { ...watch, enabled: false }
      if (id === 'retarget') return { ...watch, target: 'session-2' }
      return watch
    }

    await poller.poll()
    db.getWatch = original

    assert.equal(deliverCalls.length, 1, 'only the live watch produces a delivery')
    assert.ok(deliverCalls[0].text.includes('event keep'))
    for (const stale of ['deleted', 'disabled', 'retarget']) {
      assert.equal(deliverCalls[0].text.includes(`event ${stale}`), false, `${stale} is suppressed`)
      assert.equal(db.getWatch(stale).lastNotifyAt, null)
    }
    const runs = rawQuery(file, 'SELECT watch_id, delivered FROM runs ORDER BY watch_id')
    assert.equal(runs.length, 4, 'checkers still produced runs for all claimed watches')
    assert.deepEqual(runs.filter((run) => run.delivered === 1).map((run) => run.watch_id), ['keep'])
    const warnings = logger.lines.filter((line) => line.level === 'warn' && /丢弃过期事件/.test(line.message))
    assert.equal(warnings.length, 3)
  })
})

test('poller defaults deliveryTimeoutMs to 30s and falls back for invalid values', () => {
  assert.equal(new Poller({}).deliveryTimeoutMs, 30_000)
  assert.equal(new Poller({ deliveryTimeoutMs: 0 }).deliveryTimeoutMs, 30_000)
  assert.equal(new Poller({ deliveryTimeoutMs: Number.NaN }).deliveryTimeoutMs, 30_000)
  assert.equal(new Poller({ deliveryTimeoutMs: 1200 }).deliveryTimeoutMs, 1200)
})

test('message maxItems is normalized the same way as the renderer', () => {
  assert.equal(new Poller({}).maxMergedItems, MAX_MERGED_ITEMS)
  assert.equal(new Poller({ messageLimits: { maxItems: 5 } }).maxMergedItems, 5)
  assert.equal(new Poller({ messageLimits: { maxItems: 7.9 } }).maxMergedItems, 7)
  // Config 保证 min 1；直接构造时 0/负数按 1（不再静默退回默认 20），NaN/缺失回退默认。
  assert.equal(new Poller({ messageLimits: { maxItems: 0 } }).maxMergedItems, 1)
  assert.equal(new Poller({ messageLimits: { maxItems: -3 } }).maxMergedItems, 1)
  assert.equal(new Poller({ messageLimits: { maxItems: Number.NaN } }).maxMergedItems, MAX_MERGED_ITEMS)
})

test('dispose before the first poll closes the DB immediately and exactly once', async () => {
  await withPoller({}, async ({ poller, db }) => {
    let closeCalls = 0
    const originalClose = db.close.bind(db)
    db.close = () => {
      closeCalls += 1
      originalClose()
    }
    poller.dispose()
    assert.equal(poller.stopped, true)
    assert.equal(closeCalls, 1, 'no in-flight round means an immediate close')
    poller.dispose()
    assert.equal(closeCalls, 1, 'dispose is idempotent')
    await withDeadline(poller.poll(), 500, 'stopped poll')
    assert.equal(closeCalls, 1, 'a stopped poller never closes again')
    assert.throws(() => db.getWatch('a'), /database|closed|not open/i)
  })
})

test('delivery timeout: a hung deliver fails the round, the next round recovers and a late rejection is swallowed', { timeout: 10_000 }, async () => {
  // 场景 1：deliver 永不 settle → 本轮按失败记账、下一轮正常投递、清零并补偿这次超时。
  {
    const subprocess = makeFakeSubprocess([
      { stdout: '{"notify":true,"message":"first"}' },
      { stdout: '{"notify":true,"message":"second"}' },
    ])
    await withPoller({ subprocess, deliveryTimeoutMs: 50, failPlan: ['hang'] }, async ({ poller, db, file, deliverCalls, logger, clock }) => {
      db.applyConfig([watchEntry({ id: 'a' })], NOW)

      await withDeadline(poller.poll())

      assert.equal(deliverCalls.length, 1, 'one delivery attempt in the first round')
      const failed = db.getWatch('a')
      assert.equal(failed.deliveryFailCount, 1)
      assert.equal(failed.deliveryFailStreak, 1)
      assert.equal(failed.deliveryFirstFailAt, NOW)
      assert.match(String(failed.lastDeliveryError), /超时/)
      assert.equal(failed.lastNotifyAt, null)
      assert.equal(rawQuery(file, 'SELECT delivered FROM runs')[0].delivered, 0, 'run stays undelivered')
      assert.ok(
        logger.lines.some((line) => line.level === 'warn' && /超时/.test(line.message)),
        'delivery timeout is logged as a warning',
      )

      clock.value += MINUTE + 1
      await withDeadline(poller.poll())

      assert.equal(deliverCalls.length, 2, 'the next interval tick delivers again instead of reusing a stuck promise')
      const recovered = db.getWatch('a')
      assert.equal(recovered.deliveryFailCount, 0)
      assert.equal(recovered.deliveryFailStreak, 0)
      assert.equal(recovered.deliveryFirstFailAt, null)
      assert.equal(recovered.lastDeliveryError, null)
      assert.equal(recovered.lastNotifyAt, clock.value)
      assert.equal(rawQuery(file, 'SELECT COUNT(*) AS c FROM runs WHERE delivered = 1')[0].c, 1)
      assert.match(deliverCalls[1].text, /投递失败 1 次/, 'the timeout failure is compensated on the next success')
      assert.match(deliverCalls[1].text, /超时/, 'compensation carries the timeout error')
    })
  }

  // 场景 2：超时之后底层 promise 迟到 reject 必须被吞掉，否则产生 unhandledRejection。
  {
    const subprocess = makeFakeSubprocess([{ stdout: '{"notify":true,"message":"event"}' }])
    const unhandled = []
    const onUnhandled = (reason) => { unhandled.push(reason) }
    process.on('unhandledRejection', onUnhandled)
    try {
      await withPoller({
        subprocess,
        deliveryTimeoutMs: 50,
        failPlan: [{ rejectAfterMs: 150, error: 'late gateway error' }],
      }, async ({ poller, db }) => {
        db.applyConfig([watchEntry({ id: 'a' })], NOW)

        await withDeadline(poller.poll())

        assert.match(String(db.getWatch('a').lastDeliveryError), /超时/)
        // 覆盖底层 promise 迟到 reject 的时刻；未被吞掉的话这里会收到 unhandledRejection。
        await sleep(200)
        assert.deepEqual(unhandled, [])
      })
    } finally {
      process.removeListener('unhandledRejection', onUnhandled)
    }
  }
})

test('delivery timeout: a hung target does not block delivery to another target in the same round', { timeout: 10_000 }, async () => {
  const subprocess = makeFakeSubprocess((spec) => ({
    stdout: JSON.stringify({ notify: true, message: `event ${spec.env.WATCH_ID}` }),
  }))
  const failPlan = (attempt, input) => (input.target === 'session-slow' ? 'hang' : undefined)
  await withPoller({ subprocess, deliveryTimeoutMs: 50, failPlan }, async ({ poller, db, deliverCalls }) => {
    db.applyConfig([
      watchEntry({ id: 'a-slow', target: 'session-slow' }),
      watchEntry({ id: 'b-fast', target: 'session-fast' }),
    ], NOW)

    await withDeadline(poller.poll())

    assert.equal(deliverCalls.length, 2, 'both targets are attempted in the same round')
    assert.deepEqual(deliverCalls.map((call) => call.target), ['session-slow', 'session-fast'])
    const slow = db.getWatch('a-slow')
    assert.equal(slow.deliveryFailCount, 1, 'the hung target is recorded as a delivery failure')
    assert.match(String(slow.lastDeliveryError), /超时/)
    assert.equal(slow.lastNotifyAt, null)
    const fast = db.getWatch('b-fast')
    assert.equal(fast.lastNotifyAt, NOW, 'the healthy target is still delivered')
    assert.equal(fast.deliveryFailCount, 0)
  })
})

test('dispose: a hung delivery cannot delay closing the DB beyond the grace window', { timeout: 10_000 }, async () => {
  const subprocess = makeFakeSubprocess([{ stdout: '{"notify":true,"message":"event"}' }])
  await withPoller({ subprocess, deliveryTimeoutMs: 500, disposeGraceMs: 50, failPlan: ['hang'] }, async ({ poller, db, deliverCalls, logger }) => {
    db.applyConfig([watchEntry({ id: 'a' })], NOW)

    void poller.poll()
    await waitFor(() => deliverCalls.length === 1)

    const originalClose = db.close.bind(db)
    let closeCalls = 0
    db.close = () => { closeCalls += 1; originalClose() }

    poller.dispose()
    assert.equal(poller.stopped, true)
    await withDeadline(poller.poll(), 500, 'stopped poll')

    await waitFor(() => closeCalls === 1, { timeout: 2_000 })
    assert.equal(closeCalls, 1, 'db.close runs exactly once')
    assert.throws(() => db.getWatch('a'), /database|closed|not open/i)
    assert.ok(
      logger.lines.some((line) => line.level === 'warn' && /dispose/.test(line.message)),
      'force-close after the grace window is logged',
    )

    poller.dispose() // 幂等：不会再次 close
    assert.equal(closeCalls, 1)
  })
})

test('dispose: a delivery timeout after the forced DB close is only a bookkeeping warning', { timeout: 10_000 }, async () => {
  const subprocess = makeFakeSubprocess([{ stdout: '{"notify":true,"message":"event"}' }])
  await withPoller({ subprocess, deliveryTimeoutMs: 100, disposeGraceMs: 40, failPlan: ['hang'] }, async ({ poller, db, deliverCalls, logger }) => {
    db.applyConfig([watchEntry({ id: 'a' })], NOW)

    const round = poller.poll()
    await waitFor(() => deliverCalls.length === 1)
    poller.dispose() // grace 到期先关闭 DB，随后投递超时才记账

    await withDeadline(round)
    assert.ok(
      logger.lines.some((line) => line.level === 'warn' && /记录投递失败失败/.test(line.message)),
      'failure bookkeeping is attempted after the DB closed and only warns',
    )
    assert.ok(logger.lines.some((line) => line.level === 'warn' && /超时/.test(line.message)))
  })
})

test('only represented compensations clear failure counters; a watch dropped to keep compensation complete keeps its counters', async () => {
  // 默认 maxBytes=16KB 的实际上限为 20KB；消息保持 ~860B，
  // 让 w18 因「补偿段优先完整」被丢弃，从而验证被丢事件不清失败计数。
  const subprocess = makeFakeSubprocess((spec) => ({
    stdout: JSON.stringify({ notify: true, message: `event ${spec.env.WATCH_ID} ${'x'.repeat(850)}` }),
  }))
  await withPoller({ subprocess }, async ({ poller, db, file, deliverCalls }) => {
    const ids = Array.from({ length: 19 }, (_, index) => `w${String(index).padStart(2, '0')}`)
    db.applyConfig(ids.map((id) => watchEntry({ id, target: 'session-1' })), NOW)
    // 前 10 个 watch 的历史失败填满 10 行补偿；w18 的失败只能被汇总覆盖。
    // 为了让补偿段完整，渲染器会少放 items，被丢弃事件的失败计数必须保留。
    const longError = '错'.repeat(128)
    for (const id of ids.slice(0, 10)) db.recordDeliveryFailure([id], longError, NOW - 3_600_000)
    db.recordDeliveryFailure(['w18'], 'old gateway error', NOW - 3_600_000)

    await poller.poll()

    assert.equal(deliverCalls.length, 1, 'one merged delivery for the target')
    const text = deliverCalls[0].text
    assert.ok(!text.includes('[truncated]'), 'the compensation section is never clipped to fit items')
    assert.equal(text.split('\n- ').length - 1, 10, '10 complete compensation rows')
    assert.equal(text.includes('event w18 '), false, 'the last event is dropped so the compensation section stays complete')

    // 被丢弃的 w18 没有被本次消息表示：失败计数与未投递状态都必须保留，供后续补偿/追溯。
    const dropped = db.getWatch('w18')
    assert.equal(dropped.lastNotifyAt, null)
    assert.equal(dropped.deliveryFailCount, 1)
    assert.equal(dropped.deliveryFailStreak, 1)
    assert.equal(dropped.lastDeliveryError, 'old gateway error')
    assert.equal(rawQuery(file, "SELECT delivered FROM runs WHERE watch_id = 'w18'")[0].delivered, 0)

    // included 且补偿行完整写出的 watch 正常记账并清零失败计数。
    for (const id of ids.slice(0, 10)) {
      const watch = db.getWatch(id)
      assert.equal(watch.deliveryFailStreak, 0, `${id} was compensated and is cleared`)
      assert.equal(watch.deliveryFailCount, 0)
      assert.equal(watch.lastNotifyAt, NOW)
    }
  })
})

test('with maxBytes=8192 a large event and its compensation are both delivered via the 4096B headroom', async () => {
  // 端到端：8192（合法最小值）+ 8000B 事件 + 该 watch 有 1 次历史投递失败。
  // 实际上限=8192+4096=12288：事件与补偿段同一条消息投递，失败计数正常清零。
  const longError = 'gateway/internal error '.repeat(8)
  const effective = 8192 + RENDER_HEADROOM_BYTES
  const subprocess = makeFakeSubprocess(() => ({ stdout: JSON.stringify({ notify: true, message: 'x'.repeat(8_000) }) }))
  await withPoller(
    { subprocess, messageLimits: { maxItems: 20, maxBytes: 8192 } },
    async ({ poller, db, file, deliverCalls, clock, logger }) => {
      db.applyConfig([watchEntry({ id: 'a' })], NOW)
      db.recordDeliveryFailure(['a'], longError, NOW - 3_600_000)

      await poller.poll()

      assert.equal(deliverCalls.length, 1, 'the watch is delivered instead of being silently starved')
      const text = deliverCalls[0].text
      assert.ok(text.includes('x'.repeat(8_000)), 'the event itself reaches the target')
      assert.ok(text.includes('[投递失败补偿]'), 'the compensation section is delivered in the same message')
      assert.ok(text.includes('投递失败 1 次'), 'the one-time compensation is represented')
      assert.ok(text.includes(longError.slice(0, 128)), 'the compensation carries the failure error')
      const bytes = Buffer.byteLength(text, 'utf8')
      assert.ok(bytes > 8192, `bytes=${bytes} uses the internal 4096B headroom over the configured maxBytes`)
      assert.ok(bytes <= effective, `bytes=${bytes} stays within maxBytes + RENDER_HEADROOM_BYTES`)
      assert.equal(logger.lines.some((line) => line.level === 'warn' && /没有可投递的事件/.test(line.message)), false)

      const runs = rawQuery(file, 'SELECT watch_id, delivered FROM runs')
      assert.equal(runs.length, 1)
      assert.equal(runs[0].delivered, 1, 'the included run is marked delivered')

      const watch = db.getWatch('a')
      assert.equal(watch.lastNotifyAt, NOW, 'the included watch is marked notified')
      assert.equal(watch.deliveryFailCount, 0, 'the represented compensation clears the failure count')
      assert.equal(watch.deliveryFailStreak, 0)
      assert.equal(watch.lastDeliveryError, null)

      // 配置不变时下一轮仍能投递，且不再重复补偿。
      clock.value += MINUTE + 1
      await poller.poll()
      assert.equal(deliverCalls.length, 2, 'the next due round delivers again')
      assert.ok(deliverCalls[1].text.includes('x'.repeat(8_000)))
      assert.equal(deliverCalls[1].text.includes('[投递失败补偿]'), false, 'compensation is one-time')
      const after = db.getWatch('a')
      assert.equal(after.lastNotifyAt, clock.value)
      assert.equal(after.deliveryFailCount, 0)
      assert.equal(rawQuery(file, 'SELECT delivered FROM runs ORDER BY id')[1].delivered, 1, 'the second run is delivered too')
    },
  )
})
