/**
 * /watch-reload contract (contract §2): JSON config validation (all-or-nothing),
 * transactional sync (upsert/soft-delete/resurrect), target binding rules,
 * 7-day run cleanup on reload, and the command handler result shape.
 */

import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { registerCommands, reloadConfig, validateConfigFile } from '../lib/commands.js'
import { cleanup, makeHostCtx, makeTmp, openDb, rawQuery, watchEntry, writeJsonFile } from './helpers/harness.mjs'

const NOW = 1_800_000_000_000
const CHECK = '["bash","/abs/check.sh"]'

async function withEnv(fn) {
  const dir = await makeTmp()
  const { db, file } = openDb(dir)
  const env = { dir, db, file, configFile: join(dir, 'watches.json'), configDir: dir }
  try {
    return await fn(env)
  } finally {
    db.close()
    await cleanup(dir)
  }
}

const snapshot = (env) => env.db.listWatches({ includeDeleted: true })

async function reload(env, watches, { sessionId = 'session-1', now = NOW } = {}) {
  if (typeof watches === 'string') await writeFile(env.configFile, watches, 'utf8')
  else await writeJsonFile(env.configFile, { watches })
  return reloadConfig({ db: env.db, configFile: env.configFile, configDir: env.configDir, sessionId, now })
}

const seedRun = (db, watchId, startedAt) => db.recordRun({
  watchId, startedAt, finishedAt: startedAt, status: 'ok', notify: false, durationMs: 1,
})

test('validateConfigFile normalizes entries and applies defaults', () => {
  const result = validateConfigFile({
    watches: [
      { id: 'mail-inbox', checker: ['bash', '/abs/check.sh'], cwd: 'relative/dir', target: '  session-1  ', extra: 'ignored' },
      { id: 'disk', checker: ['node', '/disk.js'], interval: 2.5, timeout: 4, enabled: false },
    ],
  }, { configDir: '/config/dir' })
  assert.equal(result.ok, true)
  assert.deepEqual(result.errors, [])
  assert.deepEqual(result.entries[0], {
    id: 'mail-inbox',
    checker: CHECK,
    cwd: '/config/dir/relative/dir',
    intervalMs: 60_000,
    timeoutMs: 30_000,
    target: 'session-1',
    enabled: true,
  })
  assert.deepEqual(result.entries[1], {
    id: 'disk',
    checker: '["node","/disk.js"]',
    cwd: null,
    intervalMs: 2_500,
    timeoutMs: 4_000,
    target: null,
    enabled: false,
  })
})

test('validateConfigFile rejects malformed config and entry fields', () => {
  const cases = [
    [null, /顶层/],
    [[], /顶层/],
    [{}, /watches/],
    [{ watches: null }, /watches/],
    [{ watches: [{ id: '', checker: ['x'] }] }, /id/],
    [{ watches: [{ id: 'has space', checker: ['x'] }] }, /id/],
    [{ watches: [{ id: 'x'.repeat(65), checker: ['x'] }] }, /id/],
    [{ watches: [{ id: 'dup', checker: ['x'] }, { id: 'dup', checker: ['y'] }] }, /重复/],
    [{ watches: [{ id: 'a' }] }, /checker/],
    [{ watches: [{ id: 'a', checker: [] }] }, /checker/],
    [{ watches: [{ id: 'a', checker: ['bash', ''] }] }, /checker/],
    [{ watches: [{ id: 'a', checker: ['bash', 5] }] }, /checker/],
    [{ watches: [{ id: 'a', checker: ['x'], cwd: '   ' }] }, /cwd/],
    [{ watches: [{ id: 'a', checker: ['x'], interval: 0 }] }, /interval/],
    [{ watches: [{ id: 'a', checker: ['x'], interval: 'soon' }] }, /interval/],
    [{ watches: [{ id: 'a', checker: ['x'], timeout: -1 }] }, /timeout/],
    [{ watches: [{ id: 'a', checker: ['x'], target: 5 }] }, /target/],
    [{ watches: [{ id: 'a', checker: ['x'], target: '  ' }] }, /target/],
    [{ watches: [{ id: 'a', checker: ['x'], enabled: 'yes' }] }, /enabled/],
    [{ watches: [null] }, /必须是对象/],
  ]
  for (const [raw, expected] of cases) {
    const result = validateConfigFile(raw, { configDir: '/cfg' })
    assert.equal(result.ok, false, JSON.stringify(raw)?.slice(0, 80))
    assert.ok(result.errors.length > 0)
    assert.match(result.errors.join('\n'), expected, JSON.stringify(raw)?.slice(0, 80))
  }
})

test('failed reloads (missing file, bad JSON, invalid entry, missing target) leave the DB unchanged', async () => {
  await withEnv(async (env) => {
    env.db.applyConfig([watchEntry({ id: 'existing' })], NOW)
    const before = snapshot(env)

    const missing = await reloadConfig({ db: env.db, configFile: env.configFile, configDir: env.configDir, sessionId: 'session-1', now: NOW })
    assert.equal(missing.ok, false)
    assert.match(missing.errors[0], /读取配置文件失败/)
    assert.deepEqual(snapshot(env), before)

    const badJson = await reload(env, '{ not json')
    assert.equal(badJson.ok, false)
    assert.match(badJson.errors[0], /JSON/)
    assert.deepEqual(snapshot(env), before)

    const invalid = await reload(env, [{ id: 'ok', checker: ['bash'] }, { id: 'bad', checker: [] }])
    assert.equal(invalid.ok, false)
    assert.deepEqual(snapshot(env), before)

    const noTarget = await reload(env, [{ id: 'new', checker: ['bash'] }], { sessionId: null })
    assert.equal(noTarget.ok, false)
    assert.match(noTarget.errors[0], /target/)
    assert.deepEqual(snapshot(env), before)
  })
})

test('reload adds/updates/soft-deletes/resurrects and cleans >7d runs on every reload', async () => {
  await withEnv(async (env) => {
    const entries = [
      { id: 'a', checker: ['bash', '/check.sh'] },
      { id: 'b', checker: ['bash', '/check.sh'], target: 'session-2' },
    ]
    let result = await reload(env, entries)
    assert.equal(result.ok, true)
    assert.deepEqual(result.stats, { added: 2, updated: 0, deleted: 0 })
    assert.equal(result.bound, 1, 'watch a omitted target and bound to the invoking session')

    const freshRun = seedRun(env.db, 'b', NOW)
    seedRun(env.db, 'b', NOW - 8 * 24 * 3_600_000)
    const updatedA = JSON.stringify(['node', '/new-check.js'])
    result = await reload(env, [
      { id: 'a', checker: ['node', '/new-check.js'], interval: 120, enabled: false },
      { id: 'c', checker: ['bash', '/c.sh'] },
    ], { now: NOW + 1_000 })
    assert.deepEqual(result.stats, { added: 1, updated: 1, deleted: 1 })
    const a = env.db.getWatch('a')
    assert.equal(a.checker, updatedA)
    assert.equal(a.intervalMs, 120_000)
    assert.equal(a.enabled, false)
    assert.equal(env.db.getWatch('b').isDeleted, true)
    assert.equal(env.db.getWatch('c').target, 'session-1', 'new watch without target binds the invoking session')
    assert.equal(rawQuery(env.file, 'SELECT COUNT(*) AS c FROM runs WHERE watch_id = ?', 'b')[0].c, 1, 'old run cleaned, fresh run kept')
    assert.equal(rawQuery(env.file, 'SELECT COUNT(*) AS c FROM runs WHERE id = ?', freshRun)[0].c, 1, 'soft delete keeps run history')

    result = await reload(env, [
      { id: 'a', checker: ['node', '/new-check.js'], interval: 120, enabled: false },
      { id: 'c', checker: ['bash', '/c.sh'] },
      { id: 'b', checker: ['bash', '/check.sh'] },
    ], { now: NOW + 2_000 })
    assert.deepEqual(result.stats, { added: 0, updated: 3, deleted: 0 }, 'a resurrected row counts as updated')
    assert.equal(env.db.getWatch('b').isDeleted, false)

    result = await reload(env, [], { now: NOW + 3_000 })
    assert.deepEqual(result.stats, { added: 0, updated: 0, deleted: 3 })
    assert.equal(env.db.countWatches(), 0)
    assert.equal(snapshot(env).every((watch) => watch.isDeleted), true)
    assert.equal(rawQuery(env.file, 'SELECT COUNT(*) AS c FROM runs')[0].c, 1, 'reload with empty list keeps run history')
  })
})

test('target binding: explicit wins, existing is preserved, new omitted binds the invoking session', async () => {
  await withEnv(async (env) => {
    env.db.applyConfig([watchEntry({ id: 'existing', target: 'old-target' })], NOW)

    let result = await reload(env, [{ id: 'existing', checker: ['bash', '/check.sh'] }], { sessionId: 'session-1' })
    assert.equal(result.ok, true)
    assert.equal(env.db.getWatch('existing').target, 'old-target', 'existing target is never silently rebound')
    assert.equal(result.bound, 0)

    result = await reload(env, [
      { id: 'existing', checker: ['bash', '/check.sh'] },
      { id: 'fresh', checker: ['bash', '/check.sh'] },
    ], { sessionId: 'session-1' })
    assert.equal(result.ok, true)
    assert.equal(env.db.getWatch('fresh').target, 'session-1')
    assert.equal(env.db.getWatch('existing').target, 'old-target')
    assert.equal(result.bound, 1)

    result = await reload(env, [{ id: 'existing', checker: ['bash', '/check.sh'], target: 'explicit' }], { sessionId: 'session-1' })
    assert.equal(result.ok, true)
    assert.equal(env.db.getWatch('existing').target, 'explicit', 'explicit target wins')
    assert.equal(result.bound, 0)
  })
})

test('registerCommands: /watch-reload handler reports errors, applies config and triggers a poll', async () => {
  await withEnv(async (env) => {
    const host = makeHostCtx()
    const pollCalls = []
    const poller = { poll: () => { pollCalls.push(1) } }
    const dispose = registerCommands({ ctx: host.ctx, db: env.db, poller, configFile: env.configFile, configDir: env.configDir })
    const command = host.state.commands.find((item) => item.name === 'watch-reload')
    assert.ok(command, 'watch-reload command is registered')

    let result = await command.handler({ agent: { id: 'session-1' } })
    assert.equal(result.kind, 'error')
    assert.equal(pollCalls.length, 0)

    await writeJsonFile(env.configFile, { watches: [{ id: 'mail', checker: ['bash', '/check.sh'] }] })
    result = await command.handler({ agent: { id: 'session-1' } })
    assert.equal(result.kind, 'success')
    assert.match(result.text, /已重载/)
    assert.match(result.text, /新增 1/)
    assert.match(result.text, /绑定 target 1/)
    assert.equal(env.db.getWatch('mail').target, 'session-1')
    assert.equal(pollCalls.length, 1, 'successful reload triggers an immediate poll')

    dispose()
    assert.equal(command.disposed, true)
  })
})
