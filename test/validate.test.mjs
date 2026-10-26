import assert from 'node:assert/strict'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { fileSha256 } from '../lib/integrity.js'
import { readFile } from 'node:fs/promises'
import { validateWatch } from '../lib/validate.js'
import { cleanup, makeEntry, makeFakeRegistry, makeFakeSubprocess, makeTmp, makeWatchDir } from './helpers/fixtures.mjs'

const baseOptions = {
  platform: 'linux',
  config: { maxEvidenceBytes: 8192, maxStderrLines: 20 },
  resolveExecutable: async (command) => `/usr/bin/${command}`,
  inspectTarget: async () => true,
  logger: { warn() {} },
}

async function cases() {
  const root = await makeTmp()
  return { root, cleanup: () => cleanup(root) }
}

test('未知 watch', async () => {
  const result = await validateWatch({ entry: undefined, registry: makeFakeRegistry(), subprocess: makeFakeSubprocess(), ...baseOptions })
  assert.equal(result.ok, false)
  assert.equal(result.errors[0].code, 'unknown_watch')
})

test('缺少检测脚本', async () => {
  const ctx = await cases()
  try {
    const dir = join(ctx.root, 'demo')
    await mkdir(dir, { recursive: true })
    const entry = makeEntry({ dir })
    const result = await validateWatch({
      entry,
      registry: makeFakeRegistry([entry]),
      subprocess: makeFakeSubprocess({ exitCode: 0 }),
      ...baseOptions,
    })
    assert.equal(result.ok, false)
    assert.ok(result.errors.some((item) => item.code === 'check_missing'))
  } finally {
    await ctx.cleanup()
  }
})

test('配置越界', async () => {
  const ctx = await cases()
  try {
    const { dir } = await makeWatchDir(ctx.root, 'demo', { conf: { INTERVAL: '10', TIMEOUT: '5' } })
    const entry = makeEntry({ dir, values: { INTERVAL: '10', TIMEOUT: '5' } })
    const result = await validateWatch({
      entry,
      registry: makeFakeRegistry([entry]),
      subprocess: makeFakeSubprocess({ exitCode: 0 }),
      ...baseOptions,
    })
    assert.equal(result.ok, false)
    assert.ok(result.errors.some((item) => item.code === 'bad_interval'))
  } finally {
    await ctx.cleanup()
  }
})

test('缺少解释器（runner_not_found），不计失败', async () => {
  const ctx = await cases()
  try {
    const { dir } = await makeWatchDir(ctx.root, 'demo', { chmod: 0o644 })
    const entry = makeEntry({ dir })
    const result = await validateWatch({
      entry,
      registry: makeFakeRegistry([entry]),
      subprocess: makeFakeSubprocess({ exitCode: 0 }),
      ...baseOptions,
      resolveExecutable: async () => null,
    })
    assert.equal(result.ok, false)
    assert.ok(result.errors.some((item) => item.code === 'runner_not_found'))
    assert.equal(entry.state.failures, 0)
  } finally {
    await ctx.cleanup()
  }
})

test('目标会话不可用', async () => {
  const ctx = await cases()
  try {
    const { dir } = await makeWatchDir(ctx.root, 'demo')
    const entry = makeEntry({ dir })
    const result = await validateWatch({
      entry,
      registry: makeFakeRegistry([entry]),
      subprocess: makeFakeSubprocess({ exitCode: 0 }),
      ...baseOptions,
      inspectTarget: async () => false,
    })
    assert.equal(result.ok, false)
    assert.ok(result.errors.some((item) => item.code === 'unknown_target'))
  } finally {
    await ctx.cleanup()
  }
})

test('干跑坏退出码 / 非法 JSON 事件', async () => {
  const ctx = await cases()
  try {
    const { dir } = await makeWatchDir(ctx.root, 'demo')
    const entry = makeEntry({ dir })
    const registry = makeFakeRegistry([entry])
    const badCode = await validateWatch({
      entry,
      registry,
      subprocess: makeFakeSubprocess({ exitCode: 7 }),
      ...baseOptions,
    })
    assert.equal(badCode.ok, false)
    assert.ok(badCode.errors.some((item) => item.code === 'bad_exit_code'))

    const badJson = await validateWatch({
      entry,
      registry,
      subprocess: makeFakeSubprocess({ exitCode: 1, stdout: '{bad' }),
      ...baseOptions,
    })
    assert.equal(badJson.ok, false)
    assert.ok(badJson.errors.some((item) => item.code === 'dry_run_event_invalid'))
  } finally {
    await ctx.cleanup()
  }
})

test('干跑超时', async () => {
  const ctx = await cases()
  try {
    const { dir } = await makeWatchDir(ctx.root, 'demo', { conf: { TIMEOUT: '1' } })
    const entry = makeEntry({ dir, values: { TIMEOUT: '1' } })
    const result = await validateWatch({
      entry,
      registry: makeFakeRegistry([entry]),
      subprocess: makeFakeSubprocess({ hang: true }),
      ...baseOptions,
    })
    assert.equal(result.ok, false)
    assert.ok(result.errors.some((item) => item.code === 'dry_run_timeout'))
  } finally {
    await ctx.cleanup()
  }
})

test('成功激活：rev+1、失败清零、sampleFrame、markDue', async () => {
  const ctx = await cases()
  try {
    const { dir } = await makeWatchDir(ctx.root, 'demo')
    const entry = makeEntry({ dir, stateOverrides: { status: 'drafting', rev: 2, failures: 4, failureReported: true } })
    const registry = makeFakeRegistry([entry])
    const result = await validateWatch({
      entry,
      registry,
      subprocess: makeFakeSubprocess({ exitCode: 0 }),
      ...baseOptions,
    })
    assert.equal(result.ok, true, JSON.stringify(result.errors))
    assert.equal(entry.state.status, 'active')
    assert.equal(entry.state.rev, 3)
    assert.equal(entry.state.failures, 0)
    assert.equal(entry.state.failureReported, false)
    assert.equal(entry.state.target, 'session-test')
    assert.equal(entry.state.scriptHash, await fileSha256(join(dir, 'check.sh')))
    assert.equal(entry.state.status, 'active')
    assert.match(result.sampleFrame, /请处理这个事件/)
    assert.ok(registry.calls.markDue.some((call) => call.id === 'demo'))
  } finally {
    await ctx.cleanup()
  }
})

test('干跑退出码 1 且 JSON 合法 → 允许激活', async () => {
  const ctx = await cases()
  try {
    const { dir } = await makeWatchDir(ctx.root, 'demo')
    const entry = makeEntry({ dir })
    const result = await validateWatch({
      entry,
      registry: makeFakeRegistry([entry]),
      subprocess: makeFakeSubprocess({ exitCode: 1, stdout: '{"message":"现在就有事件"}' }),
      ...baseOptions,
    })
    assert.equal(result.ok, true, JSON.stringify(result.errors))
  } finally {
    await ctx.cleanup()
  }
})

test('paused 状态在激活后保持 paused', async () => {
  const ctx = await cases()
  try {
    const { dir } = await makeWatchDir(ctx.root, 'demo')
    const entry = makeEntry({ dir, stateOverrides: { status: 'paused', enabled: false } })
    const result = await validateWatch({
      entry,
      registry: makeFakeRegistry([entry]),
      subprocess: makeFakeSubprocess({ exitCode: 0 }),
      ...baseOptions,
    })
    assert.equal(result.ok, true)
    assert.equal(entry.state.status, 'paused')
    assert.equal(entry.state.enabled, true)
  } finally {
    await ctx.cleanup()
  }
})
