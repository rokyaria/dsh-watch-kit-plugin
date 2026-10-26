/**
 * Poller contract (contract §5): claim due watches → run checkers → merge
 * notify=true results per target into one delivery → delivery success/failure
 * accounting + one-time compensation → 7-day run cleanup → single-flight,
 * concurrency cap and dispose.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { Poller } from '../lib/poller.js'
import {
  cleanup, makeFakeSubprocess, makeLogger, makeSession, makeTmp, openDb, rawQuery, watchEntry, waitFor,
} from './helpers/harness.mjs'

const NOW = 1_800_000_000_000
const MINUTE = 60_000

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
    retentionMs: options.retentionMs,
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

test('M1: only events included in the merged message are marked delivered/notified', async () => {
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

test('M2: a recordRun failure is logged and does not abort the round or delivery', async () => {
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
