/**
 * Real end-to-end contract (contract §2/§5/§6): async apply → /watch-reload
 * from a real JSON file → immediate poll with fake checkers → merged wake per
 * target → run/delivery accounting → one-time compensation → restart
 * persistence (DB is the runtime source of truth).
 */

import assert from 'node:assert/strict'
import { join } from 'node:path'
import test from 'node:test'
import { apply } from '../lib/index.js'
import {
  cleanup, makeFakeSubprocess, makeHostCtx, makeSession, makeTmp, rawQuery, rawRun, waitFor, writeJsonFile,
} from './helpers/harness.mjs'

const MINUTE = 60_000

const paths = (workspace) => ({
  configFile: join(workspace, '.dsh', 'watch', 'watches.json'),
  dbFile: join(workspace, '.dsh', 'watch', 'watch.db'),
})

async function boot(workspace, { subprocess, session } = {}) {
  const { configFile, dbFile } = paths(workspace)
  const host = makeHostCtx({
    workspace,
    subprocess: subprocess ?? makeFakeSubprocess([]),
    session: session ?? makeSession(),
  })
  await apply(host.ctx, { configFile, dbFile })
  return { host, configFile, dbFile }
}

const commandOf = (host) => host.state.commands.find((command) => command.name === 'watch-reload')
const invokeReload = (host, agentId = 'session-1') => commandOf(host).handler({ agent: { id: agentId } })
const runsOf = (dbFile) => rawQuery(dbFile, 'SELECT watch_id, status, notify, delivered FROM runs ORDER BY id')
const watchesOf = (dbFile) => rawQuery(dbFile, 'SELECT * FROM watches ORDER BY id')

test('reload → poll → one merged wake per target, with runs/tools reflecting delivery', async () => {
  const workspace = await makeTmp()
  const subprocess = makeFakeSubprocess((spec) => ({
    stdout: JSON.stringify({ notify: true, message: `event ${spec.env.WATCH_ID}` }),
  }))
  const session = makeSession({
    sessions: [
      { sessionId: 'session-1', updatedAt: 1, cwd: workspace },
      { sessionId: 'session-2', updatedAt: 2, cwd: join(workspace, 'other') },
    ],
  })
  const { host, configFile, dbFile } = await boot(workspace, { subprocess, session })
  try {
    await writeJsonFile(configFile, {
      watches: [
        { id: 'a', checker: ['bash', '/a.sh'], target: 'session-1' },
        { id: 'b', checker: ['bash', '/b.sh'], target: 'session-1' },
        { id: 'c', checker: ['bash', '/c.sh'], target: 'session-2' },
        { id: 'd', checker: ['bash', '/d.sh'] }, // omitted target → bound to the invoking session
        { id: 'off', checker: ['bash', '/off.sh'], target: 'session-1', enabled: false },
      ],
    })
    const result = await invokeReload(host, 'session-1')
    assert.equal(result.kind, 'success')
    assert.equal(watchesOf(dbFile).find((watch) => watch.id === 'd').target, 'session-1')

    await waitFor(() => session.wakes.length === 2)
    const byTarget = Object.fromEntries(session.wakes.map((wake) => [wake.target, wake.text]))
    assert.match(byTarget['session-1'], /\[WATCH 通知\] 3 个事件/)
    for (const id of ['a', 'b', 'd']) assert.ok(byTarget['session-1'].includes(`event ${id}`), id)
    assert.match(byTarget['session-2'], /\[WATCH 通知\] 1 个事件/)
    assert.ok(byTarget['session-2'].includes('event c'))

    const runs = runsOf(dbFile)
    assert.deepEqual(runs.map((run) => run.watch_id), ['a', 'b', 'c', 'd'], 'disabled watch never ran')
    assert.equal(runs.every((run) => run.status === 'ok' && run.notify === 1 && run.delivered === 1), true)

    const runsTool = host.state.tools.find((tool) => tool.name === 'watch_runs')
    const runsValue = await runsTool.execute({ hours: 1 })
    assert.deepEqual(runsValue.watches.map((watch) => watch.id), ['a', 'b', 'c', 'd'])
    assert.equal(runsValue.watches.every((watch) => watch.invokeCount === 1 && watch.notifiedCount === 1), true)

    const sessionsTool = host.state.tools.find((tool) => tool.name === 'watch_sessions')
    const sessionsValue = await sessionsTool.execute({})
    assert.deepEqual(sessionsValue.sessions.map((item) => item.sessionId), ['session-2', 'session-1'])
  } finally {
    host.disposeAll()
    await cleanup(workspace)
  }
})

test('invalid reload is atomic and a reduced reload soft-deletes while keeping run history', async () => {
  const workspace = await makeTmp()
  const { host, configFile, dbFile } = await boot(workspace, {})
  try {
    await writeJsonFile(configFile, {
      watches: [
        { id: 'a', checker: ['bash', '/a.sh'], target: 'session-1' },
        { id: 'b', checker: ['bash', '/b.sh'], target: 'session-1' },
      ],
    })
    assert.equal((await invokeReload(host)).kind, 'success')
    await waitFor(() => runsOf(dbFile).length === 2)

    const before = watchesOf(dbFile)
    await writeJsonFile(configFile, { watches: [{ id: 'bad', checker: [] }] })
    const failed = await invokeReload(host)
    assert.equal(failed.kind, 'error')
    assert.deepEqual(watchesOf(dbFile), before, 'invalid config leaves the DB untouched')
    assert.equal(runsOf(dbFile).length, 2)

    await writeJsonFile(configFile, { watches: [] })
    const cleared = await invokeReload(host)
    assert.equal(cleared.kind, 'success')
    assert.equal(watchesOf(dbFile).every((watch) => watch.is_deleted === 1 && watch.enabled === 0), true)
    assert.equal(runsOf(dbFile).length, 2, 'soft delete keeps run history')

    await writeJsonFile(configFile, {
      watches: [
        { id: 'a', checker: ['bash', '/a.sh'], target: 'session-1' },
        { id: 'b', checker: ['bash', '/b.sh'], target: 'session-1' },
      ],
    })
    assert.equal((await invokeReload(host)).kind, 'success')
    assert.equal(watchesOf(dbFile).every((watch) => watch.is_deleted === 0 && watch.enabled === 1), true)
    assert.equal(runsOf(dbFile).length, 2, 'resurrect keeps run history')
  } finally {
    host.disposeAll()
    await cleanup(workspace)
  }
})

test('delivery failure is compensated exactly once on the next successful delivery, then reset', async () => {
  const workspace = await makeTmp()
  const subprocess = makeFakeSubprocess(() => ({ stdout: '{"notify":true,"message":"important"}' }))
  const session = makeSession({ failPlan: ['throw'] })
  const { host, configFile, dbFile } = await boot(workspace, { subprocess, session })
  try {
    await writeJsonFile(configFile, { watches: [{ id: 'a', checker: ['bash', '/a.sh'], target: 'session-1' }] })
    assert.equal((await invokeReload(host)).kind, 'success')
    await waitFor(() => runsOf(dbFile).length === 1)
    await waitFor(() => {
      const watch = watchesOf(dbFile)[0]
      return watch.delivery_fail_streak === 1 && watch.delivery_fail_count === 1
    })
    assert.equal(session.wakes.length, 0)
    assert.equal(watchesOf(dbFile)[0].last_notify_at, null)
    assert.equal(runsOf(dbFile)[0].delivered, 0)

    rawRun(dbFile, 'UPDATE watches SET last_run_at = NULL')
    assert.equal((await invokeReload(host)).kind, 'success')
    await waitFor(() => session.wakes.length === 1)
    assert.match(session.wakes[0].text, /\[投递失败补偿\]/)
    assert.match(session.wakes[0].text, /投递失败 1 次/)
    assert.ok(session.wakes[0].text.includes('important'))
    const recovered = watchesOf(dbFile)[0]
    assert.equal(recovered.delivery_fail_count, 0)
    assert.equal(recovered.delivery_fail_streak, 0)
    assert.equal(recovered.delivery_first_fail_at, null)
    assert.notEqual(recovered.last_notify_at, null)
    assert.equal(runsOf(dbFile).filter((run) => run.delivered === 1).length, 1)

    rawRun(dbFile, 'UPDATE watches SET last_run_at = NULL')
    assert.equal((await invokeReload(host)).kind, 'success')
    await waitFor(() => session.wakes.length === 2)
    assert.ok(!session.wakes[1].text.includes('[投递失败补偿]'))
    assert.equal(runsOf(dbFile).filter((run) => run.delivered === 1).length, 2)
  } finally {
    host.disposeAll()
    await cleanup(workspace)
  }
})

test('restart keeps DB state, does not auto-import the config file, and reload applies it later', async () => {
  const workspace = await makeTmp()
  const first = await boot(workspace, { subprocess: makeFakeSubprocess([]) })
  const { configFile, dbFile } = paths(workspace)
  try {
    await writeJsonFile(configFile, { watches: [{ id: 'a', checker: ['bash', '/a.sh'], target: 'session-1' }] })
    assert.equal((await invokeReload(first.host)).kind, 'success')
    await waitFor(() => runsOf(dbFile).length === 1)
    assert.equal(watchesOf(dbFile).length, 1)
  } finally {
    first.host.disposeAll()
  }

  try {
    // A new config file exists but the DB is the runtime source of truth until /watch-reload.
    await writeJsonFile(configFile, { watches: [{ id: 'fresh', checker: ['bash', '/fresh.sh'], target: 'session-1' }] })
    const secondSubprocess = makeFakeSubprocess([])
    const second = await boot(workspace, { subprocess: secondSubprocess })
    try {
      assert.equal(secondSubprocess.spawns.length, 0, 'recent last_run_at prevents a duplicate run after restart')
      assert.deepEqual(watchesOf(dbFile).map((watch) => watch.id), ['a'], 'config file is not auto-imported')
      assert.equal(runsOf(dbFile).length, 1, 'no duplicate run/delivery after restart')
      assert.equal((await invokeReload(second.host)).kind, 'success')
      assert.deepEqual(watchesOf(dbFile).map((watch) => watch.id), ['a', 'fresh'], 'reload adds the new config watch')
    } finally {
      second.host.disposeAll()
    }
  } finally {
    await cleanup(workspace)
  }
})
