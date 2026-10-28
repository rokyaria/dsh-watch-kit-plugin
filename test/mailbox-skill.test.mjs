/**
 * mailbox 扩展 skill 的落地/归档（v0.2.4）：不再运行时注册，改为 /watch-reload 同步文件，
 * 统一放在用户级 $DSH_HOME（默认 ~/.dsh）下：
 *   落地：<dshHome>/skills/watch-mailbox/SKILL.md
 *   归档：<dshHome>/watch/extension/skills/watch-mailbox/
 *
 * 覆盖：materialize / kept（不覆盖用户改动）/ restored（整目录）/ archived（整目录）/
 * absent、路径解析（含 ~）、空目标不覆盖归档，以及插件 apply + /watch-reload 的端到端接线。
 */

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { apply } from '../lib/index.js'
import { resolveDshHome, resolveWatchPaths } from '../lib/paths.js'
import { resolveMailboxSkillPaths, syncMailboxSkill } from '../lib/mailbox-skill.js'
import { cleanup, makeFakeSubprocess, makeHostCtx, makeTmp, writeJsonFile } from './helpers/harness.mjs'

const SRC = 'bundled-mailbox-skill-content\n'
const CUSTOM = 'custom-user-edit\n'

async function withDshHome(fn) {
  const home = await makeTmp()
  try {
    return await fn(home)
  } finally {
    await cleanup(home)
  }
}

function makeSource(home) {
  const file = join(home, 'bundled-SKILL.md')
  writeFileSync(file, SRC)
  return file
}

const skillPaths = (home) => resolveMailboxSkillPaths({ dshHome: home })
const targetFile = (home) => join(skillPaths(home).targetDir, 'SKILL.md')
const archiveFile = (home) => join(skillPaths(home).archiveDir, 'SKILL.md')

test('路径布局：落地在 <dshHome>/skills，归档在 <dshHome>/watch/extension/skills', () => {
  const paths = resolveMailboxSkillPaths({ dshHome: '/tmp/home' })
  assert.equal(paths.targetDir, '/tmp/home/skills/watch-mailbox')
  assert.equal(paths.archiveDir, '/tmp/home/watch/extension/skills/watch-mailbox')
})

test('resolveDshHome：显式参数 > DSH_HOME > ~/.dsh，并展开 ~/解析绝对路径', () => {
  const previous = process.env.DSH_HOME
  try {
    process.env.DSH_HOME = '/tmp/env-home'
    assert.equal(resolveDshHome('/tmp/explicit'), '/tmp/explicit')
    assert.equal(resolveDshHome(), '/tmp/env-home')
    assert.equal(resolveDshHome('~/alt-dsh'), join(homedir(), 'alt-dsh'))
    delete process.env.DSH_HOME
    assert.match(resolveDshHome(), /\.dsh$/)
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  }
})

test('resolveWatchPaths：DSH_HOME 含 ~ 时解析为绝对路径，不产生字面 ~ 目录', () => {
  const previous = process.env.DSH_HOME
  try {
    process.env.DSH_HOME = '~/alt-home'
    const paths = resolveWatchPaths()
    assert.equal(paths.dshHome, join(homedir(), 'alt-home'))
    assert.equal(paths.configFile, join(homedir(), 'alt-home', 'watch', 'watches.json'))
    assert.equal(paths.dbFile, join(homedir(), 'alt-home', 'watch', 'watch.db'))
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  }
})

test('enabled：目标不存在 → 写入随包内容（materialized）', async () => {
  await withDshHome(async (home) => {
    const result = syncMailboxSkill({ enabled: true, dshHome: home, sourcePath: makeSource(home) })
    assert.equal(result.status, 'materialized')
    assert.equal(readFileSync(targetFile(home), 'utf8'), SRC)
  })
})

test('enabled：目标已存在 → 保留用户文件，不覆盖（kept）', async () => {
  await withDshHome(async (home) => {
    mkdirSync(skillPaths(home).targetDir, { recursive: true })
    writeFileSync(targetFile(home), CUSTOM)
    const result = syncMailboxSkill({ enabled: true, dshHome: home, sourcePath: makeSource(home) })
    assert.equal(result.status, 'kept')
    assert.equal(readFileSync(targetFile(home), 'utf8'), CUSTOM)
  })
})

test('enabled：目标缺 SKILL.md 但目录存在 → 只补 SKILL.md，保留用户其他文件', async () => {
  await withDshHome(async (home) => {
    const { targetDir } = skillPaths(home)
    mkdirSync(targetDir, { recursive: true })
    writeFileSync(join(targetDir, 'notes.txt'), 'keep-me')
    const result = syncMailboxSkill({ enabled: true, dshHome: home, sourcePath: makeSource(home) })
    assert.equal(result.status, 'materialized')
    assert.equal(readFileSync(join(targetDir, 'notes.txt'), 'utf8'), 'keep-me')
    assert.equal(readFileSync(targetFile(home), 'utf8'), SRC)
  })
})

test('enabled：目标不存在但归档有历史副本 → 整个目录恢复（restored）', async () => {
  await withDshHome(async (home) => {
    const { archiveDir } = skillPaths(home)
    mkdirSync(archiveDir, { recursive: true })
    writeFileSync(archiveFile(home), CUSTOM)
    writeFileSync(join(archiveDir, 'notes.txt'), 'user-archive-file')
    const result = syncMailboxSkill({ enabled: true, dshHome: home, sourcePath: makeSource(home) })
    assert.equal(result.status, 'restored')
    assert.equal(readFileSync(targetFile(home), 'utf8'), CUSTOM)
    assert.equal(readFileSync(join(skillPaths(home).targetDir, 'notes.txt'), 'utf8'), 'user-archive-file')
    assert.equal(existsSync(archiveDir), false, '恢复后归档清空')
  })
})

test('disabled：目标存在 → 移入归档（archived），目标消失', async () => {
  await withDshHome(async (home) => {
    mkdirSync(skillPaths(home).targetDir, { recursive: true })
    writeFileSync(targetFile(home), CUSTOM)
    const result = syncMailboxSkill({ enabled: false, dshHome: home, sourcePath: makeSource(home) })
    assert.equal(result.status, 'archived')
    assert.equal(existsSync(targetFile(home)), false)
    assert.equal(readFileSync(archiveFile(home), 'utf8'), CUSTOM)
  })
})

test('disabled：归档同一 skill 只保留一份（新的覆盖旧的）', async () => {
  await withDshHome(async (home) => {
    const paths = skillPaths(home)
    mkdirSync(paths.archiveDir, { recursive: true })
    writeFileSync(archiveFile(home), 'old-archive\n')
    mkdirSync(paths.targetDir, { recursive: true })
    writeFileSync(targetFile(home), CUSTOM)
    const result = syncMailboxSkill({ enabled: false, dshHome: home })
    assert.equal(result.status, 'archived')
    assert.equal(readFileSync(archiveFile(home), 'utf8'), CUSTOM)
  })
})

test('disabled：目标没有 SKILL.md 时不会用空目录覆盖最后一份归档', async () => {
  await withDshHome(async (home) => {
    const paths = skillPaths(home)
    mkdirSync(paths.archiveDir, { recursive: true })
    writeFileSync(archiveFile(home), 'last-user-edit\n')
    mkdirSync(paths.targetDir, { recursive: true })
    writeFileSync(join(paths.targetDir, 'extra.txt'), 'target-extra')
    const result = syncMailboxSkill({ enabled: false, dshHome: home })
    assert.equal(result.status, 'archived')
    assert.equal(readFileSync(archiveFile(home), 'utf8'), 'last-user-edit\n')
    assert.equal(readFileSync(join(paths.archiveDir, 'extra.txt'), 'utf8'), 'target-extra')
    assert.equal(existsSync(paths.targetDir), false)
  })
})

test('disabled：目标不存在 → absent，不创建归档', async () => {
  await withDshHome(async (home) => {
    const result = syncMailboxSkill({ enabled: false, dshHome: home })
    assert.equal(result.status, 'absent')
    assert.equal(existsSync(skillPaths(home).archiveDir), false)
  })
})

test('端到端：/watch-reload 跟随 mailbox enabled 落地、归档、恢复（$DSH_HOME 内）', async () => {
  const home = await makeTmp()
  const workspace = await makeTmp()
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  const configFile = join(workspace, 'watches.json')
  const dbFile = join(workspace, 'watch.db')
  const mailboxEntry = (enabled) => ({
    id: 'mailbox-account-1',
    preset: 'mailbox',
    enabled,
    mailbox: { envFile: join(workspace, 'mail.env'), stateDir: join(workspace, 'mailbox') },
    interval: 60,
    timeout: 60,
  })
  // mailbox preset 校验要求 envFile / allowlist 文件存在（内容不解析）
  mkdirSync(join(workspace, 'mailbox'), { recursive: true })
  writeFileSync(join(workspace, 'mail.env'), 'MAIL_ADDRESS=agent@example.com\n')
  writeFileSync(join(workspace, 'mailbox', 'allow-accounts.json'), '{}\n')
  const host = makeHostCtx({ workspace, subprocess: makeFakeSubprocess([]) })
  try {
    await writeJsonFile(configFile, { watches: [mailboxEntry(false)] })
    await apply(host.ctx, { configFile, dbFile, pollIntervalMs: 60_000 })
    const handler = host.state.commands[0].handler
    const invoke = () => handler({ agent: { id: 'session-1' } })

    // 未启用 → 不落地
    let result = await invoke()
    assert.equal(result.kind, 'success', result.text)
    assert.equal(existsSync(targetFile(home)), false)

    // 启用 → 落地（$DSH_HOME 内）
    await writeJsonFile(configFile, { watches: [mailboxEntry(true)] })
    result = await invoke()
    assert.equal(result.kind, 'success', result.text)
    assert.match(result.text, /mailbox skill/)
    assert.equal(existsSync(targetFile(home)), true)
    assert.match(readFileSync(targetFile(home), 'utf8'), /watch-mailbox/)

    // 用户改文件 → 再次 reload 保留
    writeFileSync(targetFile(home), CUSTOM)
    await invoke()
    assert.equal(readFileSync(targetFile(home), 'utf8'), CUSTOM)

    // 停用 → 归档；目标消失
    await writeJsonFile(configFile, { watches: [mailboxEntry(false)] })
    await invoke()
    assert.equal(existsSync(targetFile(home)), false)
    assert.equal(readFileSync(archiveFile(home), 'utf8'), CUSTOM)

    // 重新启用 → 从归档恢复用户修改
    await writeJsonFile(configFile, { watches: [mailboxEntry(true)] })
    await invoke()
    assert.equal(readFileSync(targetFile(home), 'utf8'), CUSTOM)
  } finally {
    host.disposeAll()
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    await cleanup(home)
    await cleanup(workspace)
  }
})
