/**
 * Assembly contract (contract §1/§7): Config schema, async apply with workspace
 * resolution (recent session cwd → workingDirectory → process.cwd; explicit
 * configFile+dbFile bypass), command/tool registration, immediate + interval
 * polling, and dispose (clear interval, stop poller, unregister command/tools).
 */

import assert from 'node:assert/strict'
import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { apply, Config, inject, name } from '../lib/index.js'
import { WatchDB } from '../lib/db.js'
import { cleanup, makeFakeSubprocess, makeHostCtx, makeSession, makeTmp, rawRun, waitFor, watchEntry } from './helpers/harness.mjs'

const DEFAULT_POLL_MS = 10_000
const exists = (file) => stat(file).then(() => true, () => false)

async function withWorkspace(fn) {
  const dir = await makeTmp()
  try {
    return await fn(dir)
  } finally {
    await cleanup(dir)
  }
}

function seedDueWatch(dbFile, id = 'a') {
  const db = new WatchDB(dbFile)
  try {
    db.applyConfig([watchEntry({ id })], Date.now())
  } finally {
    db.close()
  }
}

const logText = (host) => host.logger.lines.map((line) => line.message).join('\n')

test('exports the plugin name, inject list and Config defaults', () => {
  assert.equal(name, 'watch')
  assert.deepEqual(inject, ['commands', 'tools', 'sessionController', 'subprocess', 'timer', 'workingDirectory'])
  assert.deepEqual(Config({}), { pollIntervalMs: DEFAULT_POLL_MS, configFile: '', dbFile: '' })
  assert.throws(() => Config({ pollIntervalMs: 999 }), /pollIntervalMs/)
})

test('apply resolves the default workspace from the most recent visible session cwd', async () => {
  await withWorkspace(async (workspace) => {
    const host = makeHostCtx({
      workspace: join(workspace, 'fallback'),
      session: makeSession({ sessions: [{ sessionId: 'recent', cwd: workspace, updatedAt: 10, blank: false }] }),
      subprocess: makeFakeSubprocess([{ stdout: '{"notify":false}' }]),
    })
    seedDueWatch(join(workspace, '.dsh', 'watch', 'watch.db'))
    const pending = apply(host.ctx, {})
    assert.ok(pending instanceof Promise, 'apply is async')
    await pending
    try {
      assert.equal(host.session.lists.length, 1, 'session list is used to resolve the workspace')
      assert.deepEqual(host.session.lists[0].params, {})
      assert.ok(host.session.lists[0].signal instanceof AbortSignal)
      assert.deepEqual(host.state.commands.map((command) => command.name), ['watch-reload'])
      assert.deepEqual(host.state.tools.map((tool) => tool.name), ['watch_runs', 'watch_sessions'])
      assert.equal(host.state.intervals.length, 1)
      assert.equal(host.state.intervals[0].ms, DEFAULT_POLL_MS)
      await waitFor(() => host.subprocess.spawns.length === 1, { timeout: 2_000 })
      assert.equal(await exists(join(workspace, '.dsh', 'watch', 'watch.db')), true)
      assert.match(logText(host), /db=.*\.dsh\/watch\/watch\.db/)
      assert.ok(logText(host).includes(join(workspace, '.dsh', 'watch', 'watches.json')))
    } finally {
      host.disposeAll()
    }
  })
})

test('apply honors explicit pollIntervalMs/configFile/dbFile and bypasses the session lookup', async () => {
  await withWorkspace(async (workspace) => {
    const dbFile = join(workspace, 'custom', 'state.db')
    const host = makeHostCtx({ workspace, subprocess: makeFakeSubprocess([]) })
    await apply(host.ctx, { pollIntervalMs: 2_500, configFile: 'cfg/watches.json', dbFile })
    try {
      assert.equal(host.session.lists.length, 0, 'explicit config+db paths skip the session list')
      assert.equal(host.state.intervals[0].ms, 2_500)
      assert.equal(await exists(join(workspace, 'cfg')), true, 'config dir is created')
      assert.equal(await exists(dbFile), true, 'custom DB file is created')
      assert.ok(logText(host).includes(join(workspace, 'cfg', 'watches.json')))
    } finally {
      host.disposeAll()
    }
  })
})

test('the registered interval callback polls due watches', async () => {
  await withWorkspace(async (workspace) => {
    const dbFile = join(workspace, '.dsh', 'watch', 'watch.db')
    seedDueWatch(dbFile)
    rawRun(dbFile, 'UPDATE watches SET enabled = 0')
    const subprocess = makeFakeSubprocess([{ stdout: '{"notify":false}' }])
    const host = makeHostCtx({ workspace, subprocess })
    await apply(host.ctx, {})
    try {
      await new Promise((resolve) => setTimeout(resolve, 10))
      assert.equal(subprocess.spawns.length, 0, 'initial poll skips the disabled watch')
      rawRun(dbFile, 'UPDATE watches SET enabled = 1, last_run_at = NULL')
      host.state.intervals[0].callback()
      await waitFor(() => subprocess.spawns.length === 1, { timeout: 2_000 })
    } finally {
      host.disposeAll()
    }
  })
})

test('dispose clears the interval, stops polling and unregisters command/tools', async () => {
  await withWorkspace(async (workspace) => {
    const dbFile = join(workspace, '.dsh', 'watch', 'watch.db')
    seedDueWatch(dbFile)
    const subprocess = makeFakeSubprocess([{ stdout: '{"notify":false}' }])
    const host = makeHostCtx({ workspace, subprocess })
    await apply(host.ctx, {})
    await waitFor(() => subprocess.spawns.length === 1, { timeout: 2_000 })
    const { command, tool, interval } = {
      command: host.state.commands[0],
      tool: host.state.tools[0],
      interval: host.state.intervals[0],
    }
    rawRun(dbFile, 'UPDATE watches SET last_run_at = NULL')
    host.disposeAll()
    assert.equal(interval.cleared, true, 'poll interval is cleared')
    assert.equal(command.disposed, true, 'command is unregistered')
    assert.equal(tool.disposed, true, 'tools are unregistered')
    interval.callback()
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal(subprocess.spawns.length, 1, 'no poll after dispose')
  })
})

test('workspace falls back to process.cwd() when session list and workingDirectory are unavailable', async () => {
  await withWorkspace(async (workspace) => {
    const originalCwd = process.cwd
    process.cwd = () => workspace
    try {
      const host = makeHostCtx({ workspace: '/ignored' })
      delete host.ctx.workingDirectory
      host.session.sessionController.list = async () => ({ items: [] })
      await apply(host.ctx, {})
      try {
        assert.equal(await exists(join(workspace, '.dsh', 'watch', 'watch.db')), true)
        assert.ok(logText(host).includes(join(workspace, '.dsh', 'watch', 'watch.db')))
      } finally {
        host.disposeAll()
      }
    } finally {
      process.cwd = originalCwd
    }
  })
})

test('whitespace-only config paths are treated as unset defaults', async () => {
  await withWorkspace(async (workspace) => {
    const host = makeHostCtx({ workspace, subprocess: makeFakeSubprocess([]) })
    await apply(host.ctx, { configFile: '   ', dbFile: '  ' })
    try {
      assert.equal(host.session.lists.length, 1, 'blank paths do not count as explicit overrides')
      assert.equal(await exists(join(workspace, '.dsh', 'watch', 'watch.db')), true)
      assert.ok(logText(host).includes(join(workspace, '.dsh', 'watch', 'watches.json')))
    } finally {
      host.disposeAll()
    }
  })
})

test('apply closes the poller/DB and rejects when command registration throws', async () => {
  await withWorkspace(async (workspace) => {
    const host = makeHostCtx({ workspace, subprocess: makeFakeSubprocess([]) })
    host.ctx.commands.register = () => { throw new Error('commands unavailable') }
    await assert.rejects(async () => apply(host.ctx, {}), /commands unavailable/)
    assert.equal(host.state.intervals.length, 0, 'no poll interval registered after the failure')
    assert.equal(host.state.tools.length, 0, 'tools not registered after the command failure')
    host.disposeAll() // must stay a safe no-op
  })
})
