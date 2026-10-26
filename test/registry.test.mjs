import assert from 'node:assert/strict'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { defaultState, WatchRegistry } from '../lib/registry.js'
import { cleanup, makeTmp, makeWatchDir } from './helpers/fixtures.mjs'

test('scan 读取 watch.conf 与默认状态', async () => {
  const root = await makeTmp()
  try {
    await makeWatchDir(root, 'mail-inbox', { conf: { PURPOSE: '盯邮箱', INTERVAL: '90' } })
    const registry = new WatchRegistry({ dirs: [root], platform: 'linux' })
    const entries = await registry.scan()
    assert.equal(entries.length, 1)
    const entry = registry.get('mail-inbox')
    assert.equal(entry.conf.purpose, '盯邮箱')
    assert.equal(entry.conf.intervalSec, 90)
    assert.equal(entry.state.status, 'drafting')
    assert.equal(entry.state.target, 'session-test')
  } finally {
    await cleanup(root)
  }
})

test('已存在的 state.json 会被读取并合并默认字段', async () => {
  const root = await makeTmp()
  try {
    const { dir } = await makeWatchDir(root, 'demo')
    await writeFile(join(dir, 'state.json'), JSON.stringify({ status: 'active', rev: 2, failures: 1 }), 'utf8')
    const registry = new WatchRegistry({ dirs: [root], platform: 'linux' })
    await registry.scan()
    const entry = registry.get('demo')
    assert.equal(entry.state.status, 'active')
    assert.equal(entry.state.rev, 2)
    assert.equal(entry.state.failures, 1)
    assert.equal(entry.state.triggerCount, 0)
  } finally {
    await cleanup(root)
  }
})

test('不同目录同名 id：保留第一个并告警', async () => {
  const rootA = await makeTmp()
  const rootB = await makeTmp()
  const warnings = []
  try {
    await makeWatchDir(rootA, 'dup')
    await makeWatchDir(rootB, 'dup')
    const registry = new WatchRegistry({ dirs: [rootA, rootB], platform: 'linux', logger: { warn: (msg) => warnings.push(msg) } })
    await registry.scan()
    assert.equal(registry.list().length, 1)
    assert.equal(registry.get('dup').root, rootA)
    assert.ok(warnings.some((line) => line.includes('duplicate id')))
  } finally {
    await cleanup(rootA)
    await cleanup(rootB)
  }
})

test('scanIfChanged 感知 conf 修改与目录删除', async () => {
  const root = await makeTmp()
  try {
    const { dir } = await makeWatchDir(root, 'demo')
    const registry = new WatchRegistry({ dirs: [root], platform: 'linux' })
    await registry.scan()
    assert.equal(registry.get('demo').conf.intervalSec, 60)

    await writeFile(join(dir, 'watch.conf'), 'PURPOSE=x\nINTERVAL=120\nTARGETS=session-test\n', 'utf8')
    await registry.scanIfChanged()
    assert.equal(registry.get('demo').conf.intervalSec, 120)

    await rm(dir, { recursive: true, force: true })
    await registry.scanIfChanged()
    assert.equal(registry.get('demo'), undefined)
  } finally {
    await cleanup(root)
  }
})

test('writeState 原子写入并回读', async () => {
  const root = await makeTmp()
  try {
    await makeWatchDir(root, 'demo')
    const registry = new WatchRegistry({ dirs: [root], platform: 'linux' })
    await registry.scan()
    const entry = registry.get('demo')
    const state = { ...defaultState('demo'), status: 'active', rev: 3, target: 'session-test' }
    await registry.writeState(entry, state)
    const stored = JSON.parse(await readFile(join(entry.dir, 'state.json'), 'utf8'))
    assert.equal(stored.status, 'active')
    assert.equal(stored.rev, 3)
    assert.equal(entry.state.status, 'active')
  } finally {
    await cleanup(root)
  }
})

test('不存在的 specDir 只告警不抛错', async () => {
  const warnings = []
  const registry = new WatchRegistry({
    dirs: ['/nonexistent/watch-root'],
    platform: 'linux',
    logger: { warn: (msg) => warnings.push(msg) },
  })
  const entries = await registry.scan()
  assert.deepEqual(entries, [])
  assert.ok(warnings.length > 0)
})
