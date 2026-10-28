/**
 * Checker contract (contract §4): stdout JSON only, exit code ignored,
 * invalid_json/invalid_fields/spawn_error/timeout classification, spawn spec
 * (argv/cwd/env/stdio caps), message/error byte limits.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { MAX_ERROR_BYTES, MAX_MESSAGE_BYTES, MAX_STDERR_BYTES, MAX_STDOUT_BYTES, parseCheckerOutput, runChecker } from '../lib/checker.js'
import { makeFakeSubprocess } from './helpers/harness.mjs'

const WATCH = { id: 'w1', intervalMs: 60_000, timeoutMs: 30_000, cwd: null }
const ARGV = ['bash', '/abs/check.sh']

function run(subprocess, overrides = {}) {
  return runChecker({ subprocess, watch: { ...WATCH, ...overrides.watch }, argv: overrides.argv ?? ARGV, configDir: '/config/dir', ...overrides.extra })
}

test('valid JSON: notify=false is ok with null message/error and preserved stdout', async () => {
  const subprocess = makeFakeSubprocess([{ stdout: '{"notify":false}', exitCode: 0 }])
  const result = await run(subprocess)
  assert.equal(result.status, 'ok')
  assert.equal(result.notify, false)
  assert.equal(result.message, null)
  assert.equal(result.error, null)
  assert.equal(result.stdout, '{"notify":false}')
})

test('valid JSON: notify=true carries message/error and ignores unknown fields', async () => {
  const subprocess = makeFakeSubprocess([
    { stdout: '{"notify":true,"message":"new mail","error":"warn","extra":1}', exitCode: 0 },
  ])
  const result = await run(subprocess)
  assert.equal(result.status, 'ok')
  assert.equal(result.notify, true)
  assert.equal(result.message, 'new mail')
  assert.equal(result.error, 'warn')
})

test('the process exit code does not affect checker semantics', async () => {
  const subprocess = makeFakeSubprocess([{ stdout: '{"notify":true,"message":"still an event"}', exitCode: 255 }])
  const result = await run(subprocess)
  assert.equal(result.status, 'ok')
  assert.equal(result.notify, true)
  assert.equal(result.message, 'still an event')
})

test('invalid_json: non-JSON, non-object, empty, lossy/truncated or oversized stdout', () => {
  const cases = [
    ['hello', false],
    ['[1,2]', false],
    ['"text"', false],
    ['null', false],
    ['', false],
    ['   ', false],
    ['{"notify":false}', true],
  ]
  for (const [stdout, lossy] of cases) {
    assert.equal(parseCheckerOutput({ stdout, lossy }).status, 'invalid_json', JSON.stringify({ stdout, lossy }))
  }
  assert.equal(parseCheckerOutput({ stdout: 'x'.repeat(MAX_STDOUT_BYTES + 1) }).status, 'invalid_json')
})

test('invalid_fields: bad notify type, bad message/error types, empty notify message, byte limits', () => {
  const cases = [
    '{}',
    '{"notify":"yes"}',
    '{"notify":1}',
    '{"notify":false,"message":5}',
    '{"notify":false,"error":[]}',
    '{"notify":true}',
    '{"notify":true,"message":null}',
    '{"notify":true,"message":"   "}',
    '{"notify":false,"message":"' + 'x'.repeat(MAX_MESSAGE_BYTES + 1) + '"}',
    '{"notify":false,"error":"' + 'x'.repeat(MAX_ERROR_BYTES + 1) + '"}',
  ]
  for (const stdout of cases) {
    assert.equal(parseCheckerOutput({ stdout }).status, 'invalid_fields', stdout.slice(0, 60))
  }
  // Boundary values are accepted.
  assert.equal(parseCheckerOutput({ stdout: `{"notify":false,"message":"${'x'.repeat(MAX_MESSAGE_BYTES)}"}` }).status, 'ok')
  assert.equal(parseCheckerOutput({ stdout: `{"notify":false,"error":"${'x'.repeat(MAX_ERROR_BYTES)}"}` }).status, 'ok')
})

test('spawn spec: argv, cwd fallback, WATCH_* env and output caps are passed to the host subprocess', async () => {
  const subprocess = makeFakeSubprocess([{ stdout: '{"notify":false}' }])
  await run(subprocess)
  assert.equal(subprocess.spawns.length, 1)
  const spec = subprocess.spawns[0]
  assert.deepEqual(spec.argv, ARGV, 'argv is used verbatim (no shell)')
  assert.equal(spec.cwd, '/config/dir', 'cwd falls back to the config dir')
  assert.equal(spec.stdio.stdin, 'ignore')
  assert.equal(spec.stdio.stdout.maxBytes, MAX_STDOUT_BYTES)
  assert.equal(spec.stdio.stderr.maxBytes, MAX_STDERR_BYTES)
  assert.deepEqual(spec.env, { WATCH_ID: 'w1', WATCH_INTERVAL: '60', WATCH_TIMEOUT: '30' })

  const cwdSubprocess = makeFakeSubprocess([{ stdout: '{"notify":false}' }])
  await runChecker({ subprocess: cwdSubprocess, watch: { ...WATCH, cwd: '/watch/cwd' }, argv: ARGV, configDir: '/config/dir' })
  assert.equal(cwdSubprocess.spawns[0].cwd, '/watch/cwd', 'watch.cwd wins when set')
})


test('configured byte limits override the exported defaults', async () => {
  const caps = { maxStdoutBytes: 80, maxStderrBytes: 40, maxMessageBytes: 5, maxErrorBytes: 4 }
  assert.equal(parseCheckerOutput({ stdout: '{"notify":false}', limits: caps }).status, 'ok')
  assert.equal(
    parseCheckerOutput({ stdout: '{"notify":true,"message":"123456"}', limits: caps }).status,
    'invalid_fields',
  )
  // error 上限同理：v0.3.1 Python checker 会按 --max-error-bytes 裁剪，JS 侧仍做最终校验。
  assert.equal(parseCheckerOutput({ stdout: '{"notify":false,"error":"1234"}', limits: caps }).status, 'ok')
  assert.equal(parseCheckerOutput({ stdout: '{"notify":false,"error":"12345"}', limits: caps }).status, 'invalid_fields')
  const subprocess = makeFakeSubprocess([{ stdout: '{"notify":false}' }])
  await runChecker({ subprocess, watch: WATCH, argv: ARGV, configDir: '/cfg', limits: caps })
  assert.equal(subprocess.spawns[0].stdio.stdout.maxBytes, 80)
  assert.equal(subprocess.spawns[0].stdio.stderr.maxBytes, 40)
})

test('unreadable collected streams are treated as empty output instead of throwing', async () => {
  const throwingCollected = {
    spawn() {
      return {
        done: Promise.resolve({ exitCode: 0, signal: null }),
        terminate() {},
        get collected() {
          throw new Error('collected unavailable')
        },
      }
    },
  }
  const result = await runChecker({ subprocess: throwingCollected, watch: WATCH, argv: ARGV, configDir: '/cfg' })
  assert.equal(result.status, 'invalid_json', 'no stdout means invalid_json, not a thrown error')
  assert.equal(result.stdout, '')
  assert.equal(result.stderr, '')
  assert.ok(Number.isFinite(result.durationMs) && result.durationMs >= 0, 'durationMs is a finite non-negative number')

  const throwingRead = {
    spawn() {
      return {
        done: Promise.resolve({ exitCode: 0, signal: null }),
        terminate() {},
        collected: {
          stdout: { readFrom() { throw new Error('read boom') } },
          stderr: { readFrom() { throw new Error('read boom') } },
        },
      }
    },
  }
  const second = await runChecker({ subprocess: throwingRead, watch: WATCH, argv: ARGV, configDir: '/cfg' })
  assert.equal(second.status, 'invalid_json')
  assert.equal(second.stdout, '')
  assert.equal(second.stderr, '')
})

test('spawn failure is classified as spawn_error (thrown or empty argv)', async () => {
  const throwing = makeFakeSubprocess([{ spawnError: 'ENOENT bash' }])
  const result = await run(throwing)
  assert.equal(result.status, 'spawn_error')
  assert.match(String(result.error), /ENOENT/)

  const emptyArgv = await run(makeFakeSubprocess([{ stdout: '{"notify":false}' }]), { argv: [] })
  assert.equal(emptyArgv.status, 'spawn_error')

  const controller = new AbortController()
  controller.abort()
  const abortedSubprocess = makeFakeSubprocess([{ stdout: '{"notify":true,"message":"x"}' }])
  const aborted = await runChecker({ subprocess: abortedSubprocess, watch: WATCH, argv: ARGV, configDir: '/cfg', signal: controller.signal })
  assert.equal(aborted.status, 'spawn_error', 'already-aborted signal does not spawn')
  assert.equal(abortedSubprocess.spawns.length, 0)
})

test('timeout terminates the checker and is classified as timeout', async () => {
  let terminated = 0
  const subprocess = {
    spawn() {
      let resolveDone
      const done = new Promise((resolve) => { resolveDone = resolve })
      return {
        done,
        terminate() { terminated += 1; resolveDone({ exitCode: null, signal: 'SIGTERM' }) },
        collected: { stdout: { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) }, stderr: { readFrom: () => ({ text: '', nextOffset: 0, lossy: false }) } },
      }
    },
  }
  const result = await run(subprocess, { watch: { timeoutMs: 15 } })
  assert.equal(result.status, 'timeout')
  assert.equal(terminated, 1)
  assert.ok(Number.isFinite(result.durationMs) && result.durationMs >= 0, 'durationMs is a finite non-negative number')
})

