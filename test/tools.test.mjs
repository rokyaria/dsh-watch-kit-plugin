/**
 * Tools contract (contract §6): watch_runs aggregation/windowing/render and
 * watch_sessions mapping/sorting/50-cap/error fallback.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { registerTools } from '../lib/tools.js'
import { cleanup, makeHostCtx, makeSession, makeTmp, openDb, watchEntry } from './helpers/harness.mjs'

const HOUR = 3_600_000

async function withTools(options, fn) {
  const dir = await makeTmp()
  const { db, file } = openDb(dir)
  const session = options.session ?? makeSession({ sessions: options.sessions ?? [] })
  if (options.list) session.sessionController.list = options.list
  const host = makeHostCtx({ workspace: '/workspace', session })
  const dispose = registerTools({ ctx: host.ctx, db })
  try {
    return await fn({ db, file, tools: host.state.tools, ctx: host.ctx, session })
  } finally {
    dispose()
    db.close()
    await cleanup(dir)
  }
}

const toolNamed = (tools, name) => {
  const tool = tools.find((item) => item.name === name)
  assert.ok(tool, `tool ${name} is registered`)
  return tool
}

const rendered = (tool, value) => tool.output.render({}, value).map((part) => part.text).join('\n')

test('registers watch_runs (optional hours 1-72) and watch_sessions', async () => {
  await withTools({}, async ({ tools }) => {
    assert.deepEqual(tools.map((tool) => tool.name), ['watch_runs', 'watch_sessions'])
    const runs = toolNamed(tools, 'watch_runs')
    assert.equal(runs.parameters.type, 'object')
    assert.deepEqual(Object.keys(runs.parameters.properties), ['hours'])
    assert.equal(runs.parameters.properties.hours.type, 'number')
    assert.equal(runs.parameters.required, undefined, 'hours is optional')
    const sessions = toolNamed(tools, 'watch_sessions')
    assert.deepEqual(sessions.parameters.properties, {})
  })
})

test('watch_runs defaults to 3 hours and clamps hours to 1-72', async () => {
  await withTools({}, async ({ db, tools }) => {
    const now = Date.now()
    db.applyConfig([watchEntry({ id: 'a' })], now)
    db.recordRun({ watchId: 'a', startedAt: now - 1_000, finishedAt: now - 1_000, status: 'ok', notify: false, durationMs: 1 })
    db.recordRun({ watchId: 'a', startedAt: now - 5 * HOUR, finishedAt: now - 5 * HOUR, status: 'ok', notify: false, durationMs: 1 })
    const runs = toolNamed(tools, 'watch_runs')

    let value = await runs.execute({})
    assert.equal(value.hours, 3)
    assert.ok(Math.abs(value.since - (now - 3 * HOUR)) < 5_000)
    assert.equal(value.watches[0].invokeCount, 1, 'only runs inside the 3h window')

    value = await runs.execute({ hours: 999 })
    assert.equal(value.hours, 72)
    assert.equal(value.watches[0].invokeCount, 2, 'both runs inside 72h')

    value = await runs.execute({ hours: 0.2 })
    assert.equal(value.hours, 1)
    assert.equal(value.watches[0].invokeCount, 1)

    await assert.rejects(async () => runs.execute({ hours: 'soon' }), /hours/, 'non-number hours is rejected by the tool schema')
  })
})

test('watch_runs aggregates contract counters and includes enabled zero-run watches', async () => {
  await withTools({}, async ({ db, tools }) => {
    const now = Date.now()
    db.applyConfig([
      watchEntry({ id: 'a', intervalMs: 45_000 }),
      watchEntry({ id: 'idle' }),
      watchEntry({ id: 'disabled', enabled: false }),
    ], now)
    db.claimDue(now + 1)
    const at = (offset, status, extra = {}) => db.recordRun({ watchId: 'a', startedAt: now - offset, finishedAt: now - offset, status, durationMs: 1, ...extra })
    const delivered = at(5_000, 'ok', { notify: true, message: 'm', delivered: 1 })
    db.markRunsDelivered([delivered])
    at(4_500, 'ok', { notify: true, message: 'not delivered' })
    at(4_000, 'invalid_json')
    at(3_500, 'invalid_fields')
    at(3_000, 'timeout', { error: 'timeout after 30s' })
    at(2_500, 'spawn_error', { error: 'ENOENT bash' })
    at(2_000, 'spawn_error', { stderrTail: 'latest stderr tail' })
    db.recordDeliveryFailure(['a'], 'delivery boom', now)
    db.markWatchesNotified(['a'], now - 9_000)
    const lastDelivered = at(1_000, 'ok', { notify: true, message: 'delivered' })
    db.markRunsDelivered([lastDelivered])

    const value = await toolNamed(tools, 'watch_runs').execute({ hours: 1 })
    assert.deepEqual(value.watches.map((watch) => watch.id), ['a', 'idle'], 'only enabled, non-deleted watches')
    const a = value.watches[0]
    assert.equal(a.intervalSec, 45)
    assert.equal(a.invokeCount, 8)
    assert.equal(a.notifiedCount, 2)
    assert.equal(a.errorCount, 5)
    assert.equal(a.invalidJsonCount, 1)
    assert.equal(a.invalidFieldsCount, 1)
    assert.equal(a.timeoutCount, 1)
    assert.equal(a.deliveryFailCount, 1)
    assert.equal(a.lastNotifyAt, now - 9_000)
    assert.equal(a.lastError, 'latest stderr tail')
    assert.equal(a.lastRunAt, now + 1)
    assert.equal(value.watches[1].invokeCount, 0)
  })
})

test('watch_runs rendering: empty state, table header, clipped last_error and checker errors (F-07)', async () => {
  await withTools({}, async ({ db, tools }) => {
    const tool = toolNamed(tools, 'watch_runs')
    assert.match(rendered(tool, { hours: 3, since: Date.now(), watches: [] }), /没有 watch 执行记录/)

    const now = Date.now()
    db.applyConfig([watchEntry({ id: 'a' }), watchEntry({ id: 'b' })], now)
    db.recordRun({
      watchId: 'a', startedAt: now - 1_000, finishedAt: now - 1_000, status: 'invalid_json',
      notify: false, durationMs: 1, error: 'e'.repeat(300),
    })
    db.recordRun({ watchId: 'a', startedAt: now - 500, finishedAt: now - 500, status: 'ok', notify: false, durationMs: 1 })
    let value = await tool.execute({ hours: 1 })
    let text = rendered(tool, value)
    assert.match(text, /id \| interval \| invoke \| notified \| error \| checker_error \| invalid_json/)
    assert.match(text, /a \| 60s \| 2 \| 0 \| 1 \| 0 \|/)
    assert.ok(text.includes('-'), 'null timestamps render as dash')
    assert.ok(text.includes(`${'e'.repeat(100)}…`), 'last_error is clipped to 100 chars')

    // checker 合法输出 {"notify":false,"error":"..."} 时 status 仍为 ok（mailbox 故障就是这样上报的），
    // error 不能因为不是硬失败而在 watch_runs 里消失。
    db.recordRun({
      watchId: 'b', startedAt: now - 400, finishedAt: now - 400, status: 'ok',
      notify: false, durationMs: 1, error: '[Errno 61] Connection refused',
    })
    value = await tool.execute({ hours: 1 })
    const b = value.watches.find((watch) => watch.id === 'b')
    assert.equal(b.errorCount, 0, 'status=ok is not counted as a hard failure')
    assert.equal(b.checkerErrorCount, 1, 'canonical JSON exposes checkerErrorCount')
    assert.equal(b.lastError, '[Errno 61] Connection refused', 'last_error falls back to the checker error')
    text = rendered(tool, value)
    assert.match(text, /\| checker_error \|/)
    assert.match(text, /b \| 60s \| 1 \| 0 \| 0 \| 1 \|/, 'checker_error column shows the count')
    assert.ok(text.includes('[Errno 61] Connection refused'), 'the checker error is visible in the last_error column')
    assert.match(tool.description, /checker_error_count/)
    assert.match(tool.description, /回退/, 'description documents the last_error fallback')
  })
})

test('watch_sessions maps every session (blank included), sorts and forwards exec.signal', async () => {
  const sessions = [
    { sessionId: 's-old', updatedAt: 1_000, running: false, cwd: '/old' },
    { sessionId: 's-new', updatedAt: 3_000, running: true, cwd: '/new', agentAvailable: false, origin: 'subagent', parentSessionId: 'p1' },
    { sessionId: 123, updatedAt: 4_000 },
    { sessionId: 's-blank', updatedAt: 5_000, blank: true },
    { updatedAt: 6_000 },
  ]
  await withTools({ sessions }, async ({ tools, session }) => {
    const controller = new AbortController()
    const value = await toolNamed(tools, 'watch_sessions').execute({}, { signal: controller.signal })
    assert.equal(session.lists.length, 1)
    assert.deepEqual(session.lists[0].params, {})
    assert.equal(session.lists[0].signal, controller.signal, 'exec.signal is forwarded to sessionController.list')
    assert.deepEqual(value.sessions, [
      { sessionId: 's-blank', cwd: null, updatedAt: 5_000, running: false, agentAvailable: true, blank: true, origin: null, parentSessionId: null },
      { sessionId: 's-new', cwd: '/new', updatedAt: 3_000, running: true, agentAvailable: false, blank: false, origin: 'subagent', parentSessionId: 'p1' },
      { sessionId: 's-old', cwd: '/old', updatedAt: 1_000, running: false, agentAvailable: true, blank: false, origin: null, parentSessionId: null },
    ], 'blank sessions are kept; non-string sessionIds are still dropped')
    assert.equal(value.truncated, false)
    const text = rendered(toolNamed(tools, 'watch_sessions'), value)
    assert.match(text, /session_id \| running \| agent_available \| updated_at \| cwd/)
    assert.ok(text.includes('s-blank'), 'blank session is listed')
  })
})

test('watch_sessions caps at 50 (truncated) and degrades gracefully when list fails', async () => {
  const many = Array.from({ length: 55 }, (_, index) => ({ sessionId: `s${index}`, updatedAt: 1_000 + index }))
  let seenSignal
  await withTools({ list: async (_params, signal) => { seenSignal = signal; return { items: many } } }, async ({ tools }) => {
    const tool = toolNamed(tools, 'watch_sessions')
    const value = await tool.execute({})
    assert.ok(seenSignal instanceof AbortSignal, 'default signal is an AbortSignal timeout')
    assert.equal(value.sessions.length, 50)
    assert.equal(value.truncated, true)
    assert.equal(value.sessions[0].sessionId, 's54', 'descending by updatedAt')
    assert.equal(value.sessions[49].sessionId, 's5')
    assert.match(rendered(tool, value), /只显示前 50 条/)
  })

  await withTools({ list: async () => { throw new Error('session list boom') } }, async ({ tools }) => {
    const tool = toolNamed(tools, 'watch_sessions')
    const value = await tool.execute({})
    assert.deepEqual(value.sessions, [])
    assert.equal(value.truncated, false)
    assert.match(value.error, /session list boom/)
    assert.match(rendered(tool, value), /查询会话失败：session list boom/)
  })
})
