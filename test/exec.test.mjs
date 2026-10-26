import assert from 'node:assert/strict'
import test from 'node:test'
import { runCheck, watchEnv } from '../lib/exec.js'
import { makeFakeSubprocess } from './helpers/fixtures.mjs'

const base = {
  watchDir: '/w/demo',
  argv: ['/bin/bash', '/w/demo/check.sh'],
  timeoutMs: 1000,
  env: { WATCH_ID: 'demo' },
}

test('watchEnv 构造 WATCH_* 与 dryRun', () => {
  const env = watchEnv({ id: 'demo', watchDir: '/w', dataDir: '/w/data', logsDir: '/w/logs', intervalSec: 60 })
  assert.deepEqual(env, {
    WATCH_ID: 'demo',
    WATCH_DIR: '/w',
    WATCH_STATE: '/w/data',
    WATCH_LOGS: '/w/logs',
    WATCH_INTERVAL: '60',
  })
  assert.equal(watchEnv({ id: 'd', watchDir: '/w', dataDir: '/w/d', logsDir: '/w/l', intervalSec: 60, dryRun: true }).WATCH_DRY, '1')
})

test('执行成功时返回退出码与 stdout，并把 spec 交给 subprocess', async () => {
  const subprocess = makeFakeSubprocess({ stdout: 'hello', stderr: 'warn', exitCode: 1 })
  const result = await runCheck({ ...base, subprocess })
  assert.equal(result.code, 1)
  assert.equal(result.stdout, 'hello')
  assert.equal(result.stderrTail, 'warn')
  assert.equal(subprocess.spawns.length, 1)
  assert.deepEqual(subprocess.spawns[0].argv, base.argv)
  assert.equal(subprocess.spawns[0].cwd, '/w/demo')
  assert.equal(subprocess.spawns[0].env.WATCH_ID, 'demo')
  assert.equal(subprocess.spawns[0].stdio.stdin, 'ignore')
})

test('超时会 terminate 并标记 timedOut', async () => {
  const subprocess = makeFakeSubprocess({ hang: true, exitCode: null, signal: 'SIGTERM' })
  const started = Date.now()
  const result = await runCheck({ ...base, subprocess, timeoutMs: 20 })
  assert.equal(result.timedOut, true)
  assert.equal(result.code, null)
  assert.ok(Date.now() - started >= 15)
})

test('spawn 抛错时返回 spawnError', async () => {
  const subprocess = makeFakeSubprocess({ spawnError: 'ENOENT bash' })
  const result = await runCheck({ ...base, subprocess })
  assert.match(result.spawnError, /ENOENT/)
  assert.equal(result.code, null)
})

test('stderr 只保留最后 N 行，lossy 透传', async () => {
  const subprocess = {
    spawn() {
      return {
        done: Promise.resolve({ exitCode: 1, signal: null }),
        terminate() {},
        collected: {
          stdout: { readFrom: () => ({ text: 'x', nextOffset: 1, lossy: true }) },
          stderr: { readFrom: () => ({ text: 'a\nb\nc\nd', nextOffset: 7, lossy: false }) },
        },
      }
    },
  }
  const result = await runCheck({ ...base, subprocess, stderrTailLines: 2 })
  assert.equal(result.stdoutLossy, true)
  assert.equal(result.stderrTail, 'c\nd')
})
