import assert from 'node:assert/strict'
import { readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { fileSha256 } from '../lib/integrity.js'
import { createCommandHandlers, parseAddArgs, parseIdArg } from '../lib/command-handlers.js'
import { cleanup, makeEntry, makeFakeRegistry, makeTmp, makeWatchDir } from './helpers/fixtures.mjs'

const templateDir = fileURLToPath(new URL('../assets/template/', import.meta.url))
const now = () => 1_800_000_000_000

function makeHandlers(registry, root, overrides = {}) {
  return createCommandHandlers({
    registry,
    kernel: {},
    config: { specDirs: [root] },
    templateDir,
    platform: 'linux',
    logger: { warn() {} },
    now,
    createUserMessage: undefined,
    resolveTargetAgent: async () => null,
    ...overrides,
  })
}

function makeInvocation(agent) {
  return { agent, commandId: 'c1', rawInput: '', attachments: [], signal: new AbortController().signal }
}

test('parseAddArgs', () => {
  assert.equal(parseAddArgs('').ok, false)
  assert.deepEqual(parseAddArgs('demo'), { ok: true, id: 'demo', purpose: '' })
  assert.deepEqual(parseAddArgs('demo --purpose "盯住邮箱"'), { ok: true, id: 'demo', purpose: '盯住邮箱' })
  assert.deepEqual(parseAddArgs('demo --purpose=盯住邮箱'), { ok: true, id: 'demo', purpose: '盯住邮箱' })
  assert.equal(parseAddArgs('Bad').ok, false)
  assert.equal(parseAddArgs('demo extra').ok, false)
})

test('parseIdArg', () => {
  assert.deepEqual(parseIdArg('demo'), { ok: true, id: 'demo' })
  assert.equal(parseIdArg('').ok, false)
  assert.equal(parseIdArg('demo extra').ok, false)
  assert.equal(parseIdArg('Bad').ok, false)
})

test('add：创建草稿、写入 PURPOSE/TARGETS、调用 scan 与 followup', async () => {
  const root = await makeTmp()
  try {
    const registry = makeFakeRegistry([])
    const handlers = makeHandlers(registry, root)
    const followups = []
    const agent = { id: 'session-test', followup: (message) => followups.push(message) }
    const result = await handlers.add(makeInvocation(agent), 'demo --purpose "盯住邮箱"')
    assert.equal(result.kind, 'success', result.text)

    const conf = await readFile(join(root, 'demo', 'watch.conf'), 'utf8')
    assert.match(conf, /PURPOSE=盯住邮箱/)
    assert.match(conf, /TARGETS=session-test/)
    const checkInfo = await stat(join(root, 'demo', 'check.sh'))
    assert.ok((checkInfo.mode & 0o111) !== 0, 'check.sh should be executable')
    const state = JSON.parse(await readFile(join(root, 'demo', 'state.json'), 'utf8'))
    assert.equal(state.status, 'drafting')
    assert.equal(state.target, 'session-test')
    assert.equal(registry.calls.scanned, 1)
    assert.equal(followups.length, 1)
    assert.match(followups[0].content[0].text, /\[WATCH SETUP\]/)
    assert.match(followups[0].content[0].text, /watch_validate/)
  } finally {
    await cleanup(root)
  }
})

test('add：重复 id / 非法 id / 未配置 specDirs', async () => {
  const root = await makeTmp()
  try {
    const registry = makeFakeRegistry([])
    const handlers = makeHandlers(registry, root)
    const agent = { id: 'session-test', followup() {} }
    assert.equal((await handlers.add(makeInvocation(agent), 'demo')).kind, 'success')
    const duplicate = await handlers.add(makeInvocation(agent), 'demo')
    assert.equal(duplicate.kind, 'error')
    assert.match(duplicate.text, /已存在/)
    assert.equal((await handlers.add(makeInvocation(agent), 'Bad_ID')).kind, 'error')

    const noDirs = createCommandHandlers({
      registry,
      kernel: {},
      config: { specDirs: [] },
      templateDir,
      platform: 'linux',
      logger: { warn() {} },
    })
    assert.equal((await noDirs.add(makeInvocation(agent), 'x1')).kind, 'error')
  } finally {
    await cleanup(root)
  }
})

test('list：展示状态 / 失败 / 目标', async () => {
  const root = await makeTmp()
  try {
    const { dir } = await makeWatchDir(root, 'mail-inbox')
    const entry = makeEntry({ dir, id: 'mail-inbox', stateOverrides: { failures: 5, suppressedTotal: 3, lastEventAt: '2026-10-26T10:00:00.000Z' } })
    const handlers = makeHandlers(makeFakeRegistry([entry]), root)
    const result = await handlers.list()
    assert.equal(result.kind, 'success')
    assert.match(result.text, /mail-inbox/)
    assert.match(result.text, /failing\(5\)/)
    assert.match(result.text, /suppressed\(3\)/)
    assert.match(result.text, /session-/)

    const empty = makeHandlers(makeFakeRegistry([]), root)
    assert.match((await empty.list()).text, /当前没有 watch/)
  } finally {
    await cleanup(root)
  }
})

test('list：状态以「中文(英文)」展示，needs_validation 可读', async () => {
  const root = await makeTmp()
  try {
    const { dir } = await makeWatchDir(root, 'demo')
    const entry = makeEntry({ dir, stateOverrides: { status: 'needs_validation' } })
    const handlers = makeHandlers(makeFakeRegistry([entry]), root)
    const result = await handlers.list()
    assert.equal(result.kind, 'success')
    assert.match(result.text, /待重校验\(needs_validation\)/)
    assert.match(result.text, /demo/)
  } finally {
    await cleanup(root)
  }
})

test('pause / resume', async () => {
  const root = await makeTmp()
  try {
    const { dir } = await makeWatchDir(root, 'demo')
    const entry = makeEntry({ dir })
    const registry = makeFakeRegistry([entry])
    const handlers = makeHandlers(registry, root)
    const invocation = makeInvocation({ id: 'session-test' })

    const paused = await handlers.pause(invocation, 'demo')
    assert.equal(paused.kind, 'success')
    assert.equal(entry.state.status, 'paused')
    assert.equal(entry.state.enabled, false)
    assert.equal((await handlers.pause(invocation, 'demo')).kind, 'success')

    const resumed = await handlers.resume(invocation, 'demo')
    assert.equal(resumed.kind, 'success')
    assert.equal(entry.state.status, 'active')
    assert.equal(entry.state.enabled, true)
    assert.ok(registry.calls.markDue.some((call) => call.id === 'demo'))

    entry.state.status = 'drafting'
    assert.equal((await handlers.resume(invocation, 'demo')).kind, 'error')
  } finally {
    await cleanup(root)
  }
})

test('remove：归档到 .removed', async () => {
  const root = await makeTmp()
  try {
    const { dir } = await makeWatchDir(root, 'demo')
    const entry = makeEntry({ dir })
    const registry = makeFakeRegistry([entry])
    const handlers = makeHandlers(registry, root)
    const result = await handlers.remove(makeInvocation({ id: 'session-test' }), 'demo')
    assert.equal(result.kind, 'success', result.text)
    assert.match(result.text, /\.removed/)
    assert.equal(registry.get('demo'), undefined)
    const archived = await stat(join(root, '.removed'))
    assert.equal(archived.isDirectory(), true)
  } finally {
    await cleanup(root)
  }
})

test('resume：脚本在暂停期间被修改 → 拒绝，要求 watch_validate', async () => {
  const root = await makeTmp()
  try {
    const { dir } = await makeWatchDir(root, 'demo')
    const entry = makeEntry({ dir, stateOverrides: { status: 'paused', enabled: false } })
    entry.state.scriptHash = await fileSha256(join(dir, 'check.sh'))
    await writeFile(join(dir, 'check.sh'), '#!/bin/bash\nexit 0\n# changed\n', 'utf8')
    const handlers = makeHandlers(makeFakeRegistry([entry]), root)
    const result = await handlers.resume(makeInvocation({ id: 'session-test' }), 'demo')
    assert.equal(result.kind, 'error')
    assert.match(result.text, /watch_validate/)
    assert.equal(entry.state.status, 'paused')
  } finally {
    await cleanup(root)
  }
})

test('remove：检查进行中拒绝删除，结束后可删', async () => {
  const root = await makeTmp()
  try {
    const { dir } = await makeWatchDir(root, 'demo')
    const entry = makeEntry({ dir })
    entry.inFlight = true
    const registry = makeFakeRegistry([entry])
    const handlers = makeHandlers(registry, root)
    const invocation = makeInvocation({ id: 'session-test' })

    const refused = await handlers.remove(invocation, 'demo')
    assert.equal(refused.kind, 'error')
    assert.match(refused.text, /正在执行检查/)
    assert.equal(entry.removing, undefined)
    assert.equal(registry.get('demo'), entry)

    entry.inFlight = false
    const removed = await handlers.remove(invocation, 'demo')
    assert.equal(removed.kind, 'success', removed.text)
    assert.equal(entry.removed, true)
    assert.equal(registry.get('demo'), undefined)
  } finally {
    await cleanup(root)
  }
})

test('approve：写审计并唤醒目标 agent', async () => {
  const root = await makeTmp()
  try {
    const { dir } = await makeWatchDir(root, 'demo')
    const entry = makeEntry({ dir })
    const registry = makeFakeRegistry([entry])
    const followups = []
    const targetAgent = { id: 'session-test', followup: (message) => followups.push(message) }
    const handlers = makeHandlers(registry, root, { resolveTargetAgent: async () => targetAgent })
    const result = await handlers.approve(makeInvocation({ id: 'session-test' }), 'demo')
    assert.equal(result.kind, 'success')
    assert.equal(followups.length, 1)
    assert.match(followups[0].content[0].text, /已批准/)
    const audit = await readFile(join(entry.logsDir, 'audit.log'), 'utf8')
    assert.match(audit, /event=approve id=demo/)
  } finally {
    await cleanup(root)
  }
})

test('找不到 watch 的每个命令都返回错误', async () => {
  const root = await makeTmp()
  try {
    const handlers = makeHandlers(makeFakeRegistry([]), root)
    const invocation = makeInvocation({ id: 'session-test' })
    for (const name of ['pause', 'resume', 'remove', 'approve']) {
      const result = await handlers[name](invocation, 'missing')
      assert.equal(result.kind, 'error', name)
    }
  } finally {
    await cleanup(root)
  }
})
