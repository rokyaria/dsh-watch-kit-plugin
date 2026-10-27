/** mailbox preset: watchers.json -> bundled mail.py argv, without user checker fields. */

import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { validateConfigFile } from '../lib/commands.js'
import { cleanup, makeTmp } from './helpers/harness.mjs'

test('shipped SKILL.md files have discoverable frontmatter', async () => {
  const watchKit = await readFile(new URL('../skills/watch-kit/SKILL.md', import.meta.url), 'utf8')
  const mailbox = await readFile(new URL('../extension/mailbox/skills/watch-mailbox/SKILL.md', import.meta.url), 'utf8')
  assert.match(watchKit, /^---\nname: watch-kit\n/)
  assert.match(watchKit, /^---[\s\S]*?\ndescription: /)
  assert.doesNotMatch(watchKit, /whenToUse:/)
  assert.match(mailbox, /^---\nname: watch-mailbox\n/)
  assert.match(mailbox, /^---[\s\S]*?\ndescription: /)
  assert.doesNotMatch(mailbox, /whenToUse:/)
})

test('preset mailbox maps env/state/allowlist to the bundled script argv', async () => {
  const dir = await makeTmp()
  try {
    const envFile = join(dir, 'mail.env')
    const allowFile = join(dir, 'allow-accounts.json')
    await writeFile(envFile, 'MAIL_ADDRESS=a@example.com\n')
    await writeFile(allowFile, '{}')
    const raw = {
      watches: [
        {
          id: 'mailbox',
          preset: 'mailbox',
          enabled: true,
          mailbox: {
            envFile,
            stateDir: join(dir, 'state'),
            allowAccountFile: allowFile,
            remindAfterMinutes: 30,
            folder: 'INBOX',
            python: 'python3',
          },
          interval: 60,
          timeout: 60,
        },
      ],
    }
    const result = validateConfigFile(raw, { configDir: dir })
    assert.equal(result.ok, true, result.errors?.join('\n'))
    const entry = result.entries[0]
    assert.equal(entry.preset, 'mailbox')
    const argv = JSON.parse(entry.checker)
    assert.equal(argv[0], 'python3')
    assert.match(argv[1], /extension[/\\]mailbox[/\\]mail\.py$/)
    assert.deepEqual(argv.slice(2, 8), ['check', '--json', '--env-file', envFile, '--state-dir', join(dir, 'state')])
    assert.ok(argv.includes('--allow-account-file'))
    assert.equal(argv[argv.indexOf('--allow-account-file') + 1], allowFile)
    assert.equal(argv[argv.indexOf('--remind-minutes') + 1], '30')
    assert.equal(argv[argv.indexOf('--folder') + 1], 'INBOX')
  } finally {
    await cleanup(dir)
  }
})

test('shipped mailbox watch template validates disabled', async () => {
  const template = JSON.parse(await readFile(new URL('../extension/mailbox/watches.example.json', import.meta.url), 'utf8'))
  const result = validateConfigFile(template, { configDir: process.cwd() })
  assert.equal(result.ok, true, result.errors?.join('\n'))
  assert.equal(result.entries[0].enabled, false)
})

test('disabled mailbox template can keep placeholder paths', async () => {
  const dir = await makeTmp()
  try {
    const raw = {
      watches: [
        {
          id: 'mailbox',
          preset: 'mailbox',
          enabled: false,
          mailbox: {
            envFile: '/absolute/path/to/mail.env',
            stateDir: '/absolute/path/to/state',
            allowAccountFile: '/absolute/path/to/allow.json',
          },
        },
      ],
    }
    const result = validateConfigFile(raw, { configDir: dir })
    assert.equal(result.ok, true, result.errors?.join('\n'))
    assert.equal(result.entries[0].enabled, false)
    assert.ok(JSON.parse(result.entries[0].checker)[0])
  } finally {
    await cleanup(dir)
  }
})

test('enabled mailbox preset requires env and allowlist files and forbids checker', async () => {
  const dir = await makeTmp()
  try {
    const base = {
      id: 'mailbox',
      preset: 'mailbox',
      enabled: true,
      mailbox: {
        envFile: join(dir, 'missing.env'),
        stateDir: join(dir, 'state'),
        allowAccountFile: join(dir, 'missing-allow.json'),
      },
    }
    const missing = validateConfigFile({ watches: [base] }, { configDir: dir })
    assert.equal(missing.ok, false)
    assert.ok(missing.errors.some((error) => error.includes('envFile')))

    const withChecker = validateConfigFile(
      { watches: [{ ...base, checker: ['true'] }] },
      { configDir: dir },
    )
    assert.equal(withChecker.ok, false)
    assert.ok(withChecker.errors.some((error) => error.includes('checker')))

    const badPreset = validateConfigFile({ watches: [{ ...base, preset: 'unknown' }] }, { configDir: dir })
    assert.equal(badPreset.ok, false)
    assert.ok(badPreset.errors.some((error) => error.includes('preset')))
  } finally {
    await cleanup(dir)
  }
})
