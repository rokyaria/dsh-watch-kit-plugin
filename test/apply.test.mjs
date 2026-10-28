/**
 * Assembly contract (contract §1/§7): Config schema, async apply with $DSH_HOME
 * default paths (no workspace heuristics since v0.2.4), command/tool registration,
 * immediate + interval polling, and dispose (clear interval, stop poller,
 * unregister command/tools).
 */

import assert from 'node:assert/strict'
import { mkdir, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { apply, Config, inject, name } from '../lib/index.js'
import { WatchDB } from '../lib/db.js'
import { cleanup, makeFakeSubprocess, makeHostCtx, makeTmp, rawGet, rawQuery, rawRun, waitFor, watchEntry, writeJsonFile } from './helpers/harness.mjs'

const DEFAULT_POLL_MS = 10_000
const DEFAULT_LIMITS = {
  checker: { maxStdoutBytes: 65536, maxStderrBytes: 8192, maxMessageBytes: 8192, maxErrorBytes: 2048 },
  message: { maxItems: 20, maxBytes: 16384 },
  scheduler: { maxConcurrentChecks: 4, runRetentionDays: 7, deliveryTimeoutMs: 30000 },
}
const exists = (file) => stat(file).then(() => true, () => false)

/** 每个用例用独立的 DSH_HOME，避免默认路径互相污染（apply 从 env 读）。 */
async function withDshHome(fn) {
  const home = await makeTmp()
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    return await fn(home)
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    await cleanup(home)
  }
}

const defaultPaths = (home) => ({
  configFile: join(home, 'watch', 'watches.json'),
  dbFile: join(home, 'watch', 'watch.db'),
})

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
  assert.deepEqual(inject, ['commands', 'tools', 'skills', 'sessionController', 'subprocess', 'timer'])
  assert.deepEqual(Config({}), { pollIntervalMs: DEFAULT_POLL_MS, configFile: '', dbFile: '', limits: DEFAULT_LIMITS })
  assert.throws(() => Config({ pollIntervalMs: 999 }), /pollIntervalMs/)
  assert.equal(Config({ limits: { checker: { maxStdoutBytes: 8192 } } }).limits.checker.maxStdoutBytes, 8192)
  assert.equal(Config({ limits: { checker: { maxStdoutBytes: 8192 } } }).limits.message.maxItems, 20)
  assert.throws(() => Config({ limits: { checker: { maxStdoutBytes: 1 } } }), /maxStdoutBytes/)
  assert.throws(() => Config({ limits: { scheduler: { runRetentionDays: 0 } } }), /runRetentionDays/)
  // scheduler.deliveryTimeoutMs：默认 30s，越界（<1000 / >600000）拒绝
  assert.equal(Config({}).limits.scheduler.deliveryTimeoutMs, 30_000)
  assert.equal(Config({ limits: { scheduler: { deliveryTimeoutMs: 5_000 } } }).limits.scheduler.deliveryTimeoutMs, 5_000)
  assert.throws(() => Config({ limits: { scheduler: { deliveryTimeoutMs: 500 } } }), /deliveryTimeoutMs/)
  assert.throws(() => Config({ limits: { scheduler: { deliveryTimeoutMs: 700_000 } } }), /deliveryTimeoutMs/)
})

test('apply uses <DSH_HOME>/watch defaults and never queries sessions', async () => {
  await withDshHome(async (home) => {
    const { configFile, dbFile } = defaultPaths(home)
    seedDueWatch(dbFile)
    const host = makeHostCtx({ subprocess: makeFakeSubprocess([{ stdout: '{"notify":false}' }]) })
    const pending = apply(host.ctx, {})
    assert.ok(pending instanceof Promise, 'apply is async')
    await pending
    try {
      assert.equal(host.session.lists.length, 0, 'defaults no longer depend on session cwd')
      assert.deepEqual(host.state.commands.map((command) => command.name), ['watch-reload'])
      assert.deepEqual(host.state.tools.map((tool) => tool.name), ['watch_runs', 'watch_sessions'])
      // v0.2.4：mailbox skill 不再运行时注册，改为 /watch-reload 落地到 <dshHome>/skills
      assert.deepEqual(host.state.skills.map((skill) => skill.name), ['watch-kit'])
      assert.ok(host.state.skills[0].content.includes('README.md'))
      assert.ok(host.state.skills[0].content.includes('不要凭空发明命令'))
      assert.ok(host.state.skills.every((skill) => !skill.content.includes('{{')))
      assert.ok(host.state.skills.every((skill) => !skill.content.startsWith('---')))
      assert.equal(host.state.intervals.length, 1)
      assert.equal(host.state.intervals[0].ms, DEFAULT_POLL_MS)
      await waitFor(() => host.subprocess.spawns.length === 1, { timeout: 2_000 })
      assert.equal(await exists(dbFile), true)
      assert.ok(logText(host).includes(`db=${dbFile}`))
      assert.ok(logText(host).includes(configFile))
    } finally {
      host.disposeAll()
    }
  })
})

test('apply forwards configurable checker limits to the spawned checker', async () => {
  await withDshHome(async (home) => {
    const { dbFile } = defaultPaths(home)
    seedDueWatch(dbFile)
    const subprocess = makeFakeSubprocess([{ stdout: '{"notify":false}' }])
    const host = makeHostCtx({ subprocess })
    await apply(host.ctx, { limits: { checker: { maxStdoutBytes: 8192, maxStderrBytes: 1024 } } })
    try {
      await waitFor(() => subprocess.spawns.length === 1, { timeout: 2_000 })
      assert.equal(subprocess.spawns[0].stdio.stdout.maxBytes, 8192)
      assert.equal(subprocess.spawns[0].stdio.stderr.maxBytes, 1024)
    } finally {
      host.disposeAll()
    }
  })
})

test('apply forwards limits.checker.maxMessageBytes/maxErrorBytes into mailbox preset argv on /watch-reload', async () => {
  await withDshHome(async (home) => {
    const { configFile, dbFile } = defaultPaths(home)
    const envFile = join(home, 'mail.env')
    const stateDir = join(home, 'mail-state')
    const allowFile = join(home, 'allow.json')
    await writeFile(envFile, 'MAIL_ADDRESS=agent@example.com\nMAIL_AUTHCODE=secret\n', 'utf8')
    await mkdir(stateDir, { recursive: true })
    await writeJsonFile(allowFile, { 'agent@example.com': [] })
    await writeJsonFile(configFile, {
      watches: [
        {
          id: 'mailbox',
          preset: 'mailbox',
          enabled: true,
          mailbox: { envFile, stateDir, allowAccountFile: allowFile },
          interval: 60,
          timeout: 60,
        },
      ],
    })
    const host = makeHostCtx({ subprocess: makeFakeSubprocess([]) })
    await apply(host.ctx, { limits: { checker: { maxMessageBytes: 4096, maxErrorBytes: 512 } } })
    try {
      const result = await host.state.commands[0].handler({ agent: { id: 'session-1' } })
      assert.equal(result.kind, 'success', result.text)
      const checker = JSON.parse(rawGet(dbFile, 'SELECT checker FROM watches WHERE id = ?', 'mailbox').checker)
      assert.equal(checker[checker.indexOf('--max-message-bytes') + 1], '4096')
      assert.equal(checker[checker.indexOf('--max-error-bytes') + 1], '512')
      // 新参数追加在 --folder 之后，既有位置不变（mail.py 前 8 个 argv 位置稳定）。
      assert.deepEqual(checker.slice(2, 8), ['check', '--json', '--env-file', envFile, '--state-dir', stateDir])
      assert.equal(checker[checker.length - 2], '--max-error-bytes')
    } finally {
      host.disposeAll()
    }
  })
})

test('explicit pollIntervalMs/configFile/dbFile win; relative paths resolve against <DSH_HOME>', async () => {
  await withDshHome(async (home) => {
    const dbFile = join(home, 'custom', 'state.db')
    const host = makeHostCtx({ subprocess: makeFakeSubprocess([]) })
    await apply(host.ctx, { pollIntervalMs: 2_500, configFile: 'cfg/watches.json', dbFile })
    try {
      assert.equal(host.session.lists.length, 0)
      assert.equal(host.state.intervals[0].ms, 2_500)
      assert.equal(await exists(join(home, 'cfg')), true, 'relative config path resolves against DSH_HOME')
      assert.equal(await exists(dbFile), true, 'custom DB file is created')
      assert.ok(logText(host).includes(join(home, 'cfg', 'watches.json')))
    } finally {
      host.disposeAll()
    }
  })
})

test('the registered interval callback polls due watches', async () => {
  await withDshHome(async (home) => {
    const { dbFile } = defaultPaths(home)
    seedDueWatch(dbFile)
    rawRun(dbFile, 'UPDATE watches SET enabled = 0')
    const subprocess = makeFakeSubprocess([{ stdout: '{"notify":false}' }])
    const host = makeHostCtx({ subprocess })
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
  await withDshHome(async (home) => {
    const { dbFile } = defaultPaths(home)
    seedDueWatch(dbFile)
    const subprocess = makeFakeSubprocess([{ stdout: '{"notify":false}' }])
    const host = makeHostCtx({ subprocess })
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
    assert.equal(host.state.skills.every((skill) => skill.disposed === true), true, 'skills are unregistered')
    interval.callback()
    await new Promise((resolve) => setTimeout(resolve, 20))
    assert.equal(subprocess.spawns.length, 1, 'no poll after dispose')
  })
})

test('blank config paths fall back to <DSH_HOME>/watch defaults', async () => {
  await withDshHome(async (home) => {
    const { configFile, dbFile } = defaultPaths(home)
    const host = makeHostCtx({ subprocess: makeFakeSubprocess([]) })
    await apply(host.ctx, { configFile: '   ', dbFile: '  ' })
    try {
      assert.equal(await exists(dbFile), true)
      assert.ok(logText(host).includes(configFile))
    } finally {
      host.disposeAll()
    }
  })
})

test('apply closes the poller/DB and rejects when command registration throws', async () => {
  await withDshHome(async () => {
    const host = makeHostCtx({ subprocess: makeFakeSubprocess([]) })
    host.ctx.commands.register = () => { throw new Error('commands unavailable') }
    // 监视 DatabaseSync.prototype.close：注册失败路径必须真正关闭 apply 打开的连接（不泄漏句柄）。
    const originalClose = DatabaseSync.prototype.close
    let successfulCloses = 0
    DatabaseSync.prototype.close = function close(...args) {
      const value = originalClose.apply(this, args)
      successfulCloses += 1
      return value
    }
    try {
      await assert.rejects(async () => apply(host.ctx, {}), /commands unavailable/)
    } finally {
      DatabaseSync.prototype.close = originalClose
    }
    assert.equal(host.state.intervals.length, 0, 'no poll interval registered after the failure')
    assert.equal(host.state.tools.length, 0, 'tools not registered after the command failure')
    assert.equal(successfulCloses, 1, 'the DB connection opened by apply is closed exactly once on the failure path')
    host.disposeAll() // must stay a safe no-op
  })
})

test('apply forwards scheduler.deliveryTimeoutMs so a hung followup fails the delivery instead of stalling', { timeout: 10_000 }, async () => {
  await withDshHome(async (home) => {
    const { dbFile } = defaultPaths(home)
    seedDueWatch(dbFile)
    const subprocess = makeFakeSubprocess([{ stdout: '{"notify":true,"message":"hung target"}' }])
    const host = makeHostCtx({ subprocess })
    // 模拟 host 挂起：resolveAgent 正常，但 followup 返回永不 settle 的 Promise。
    host.ctx.sessionController = {
      ...host.ctx.sessionController,
      resolveAgent: async (target) => ({ agent: { id: target, followup: () => new Promise(() => {}) } }),
    }
    await apply(host.ctx, { limits: { scheduler: { deliveryTimeoutMs: 1000 } } })
    try {
      await waitFor(() => {
        const watch = rawQuery(dbFile, 'SELECT delivery_fail_count, last_delivery_error FROM watches')[0]
        return watch.delivery_fail_count === 1
      }, { timeout: 3_000 })
      const watch = rawQuery(dbFile, 'SELECT last_delivery_error FROM watches')[0]
      assert.match(String(watch.last_delivery_error), /超时/)
      assert.equal(rawQuery(dbFile, 'SELECT delivered FROM runs')[0].delivered, 0)
    } finally {
      host.disposeAll()
    }
  })
})
