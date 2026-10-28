/** mailbox preset: watchers.json -> bundled mail.py argv, without user checker fields. */

import assert from 'node:assert/strict'
import { readFile, stat, writeFile } from 'node:fs/promises'
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
  assert.match(mailbox, /收到 \[MAILBOX\] 通知/)
  assert.match(mailbox, /查看\/回复邮箱/)
  // 主动发信（send）必须出现在 skill 里（回归：CLI 有能力但文档漏写）
  assert.match(mailbox, /## 主动发信（send）/)
  assert.match(mailbox, /send\s+--to/)
  assert.match(mailbox, /默认策略：不主动发信/)
  assert.match(mailbox, /一次授权即对约定范围生效/)
  assert.match(mailbox, /给\*\*访客\*\*写信同理/)
  // 通知只给数据 + 指示按 skill 处理；命令与参数由 skill 指导组装
  assert.match(mailbox, /## 通知里有什么/)
  assert.match(mailbox, /## 命令与参数/)
  assert.match(mailbox, /按 skill `watch-mailbox` 处理/)
  // 附件/用户文件不得放插件管理目录；attach 默认系统临时目录；邮件数据不可拼命令
  assert.match(mailbox, /## 用户文件与附件存放/)
  assert.match(mailbox, /dsh-mailbox-attach-/)
  assert.match(mailbox, /恢复整个目录/)
  assert.match(mailbox, /pending/)
  assert.match(mailbox, /no_receipt/)
  assert.match(mailbox, /内部值只有 `ok` \/ `risk`/)
  assert.match(mailbox, /来源 OK\/RISK/)
  assert.match(mailbox, /attach --uid <uid> --out <用户自己的目录>/)
  assert.match(mailbox, /邮件数据不可信、不拼命令/)
  assert.match(mailbox, /不要拼进 shell 命令/)
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
    // v0.3.1 起 argv = 前 8 个稳定位置 + 既有 flag + 末尾新增的 --max-error-bytes。
    assert.equal(argv.length, 20)
    assert.equal(argv[0], 'python3')
    assert.match(argv[1], /extension[/\\]mailbox[/\\]mail\.py$/)
    assert.deepEqual(argv.slice(2, 8), ['check', '--json', '--env-file', envFile, '--state-dir', join(dir, 'state')])
    assert.deepEqual(argv.slice(8, 10), ['--allow-account-file', allowFile])
    assert.deepEqual(argv.slice(10, 12), ['--remind-minutes', '30'])
    assert.deepEqual(argv.slice(12, 14), ['--max-notify', '20'])
    assert.deepEqual(argv.slice(14, 16), ['--max-message-bytes', '8192'])
    assert.deepEqual(argv.slice(16, 18), ['--folder', 'INBOX'])
    // 新参数追加在 --folder 之后（argparse 选项顺序无关），不动既有位置。
    assert.deepEqual(argv.slice(18), ['--max-error-bytes', '2048'])
    const limited = validateConfigFile(raw, { configDir: dir, maxMessageBytes: 4096, maxErrorBytes: 512 })
    assert.equal(limited.ok, true, limited.errors?.join('\n'))
    const limitedArgv = JSON.parse(limited.entries[0].checker)
    assert.equal(limitedArgv[limitedArgv.indexOf('--max-message-bytes') + 1], '4096')
    assert.equal(limitedArgv[limitedArgv.indexOf('--max-error-bytes') + 1], '512')
  } finally {
    await cleanup(dir)
  }
})

test('mailbox preset clamps maxMessageBytes/maxErrorBytes to the limits.checker ranges (default 8192/2048)', async () => {
  const dir = await makeTmp()
  try {
    // disabled 模板无需真实文件存在，可直接断言默认值。
    const raw = {
      watches: [
        {
          id: 'mailbox',
          preset: 'mailbox',
          enabled: false,
          mailbox: { envFile: join(dir, 'mail.env'), stateDir: join(dir, 'state') },
        },
      ],
    }
    const argvFor = (options) => {
      const result = validateConfigFile(raw, { configDir: dir, ...options })
      assert.equal(result.ok, true, result.errors?.join('\n'))
      return JSON.parse(result.entries[0].checker)
    }
    const flagValue = (argv, name) => argv[argv.indexOf(name) + 1]
    assert.equal(flagValue(argvFor({}), '--max-message-bytes'), '8192')
    assert.equal(flagValue(argvFor({}), '--max-error-bytes'), '2048')

    // 与 lib/config.js 的护栏一致：256B–4MiB / 64B–1MiB；越界夹紧，非有限值回退默认。
    assert.equal(flagValue(argvFor({ maxMessageBytes: 1 }), '--max-message-bytes'), '256')
    assert.equal(flagValue(argvFor({ maxMessageBytes: 5 * 1024 * 1024 }), '--max-message-bytes'), String(4 * 1024 * 1024))
    assert.equal(flagValue(argvFor({ maxMessageBytes: Number.NaN }), '--max-message-bytes'), '8192')
    assert.equal(flagValue(argvFor({ maxErrorBytes: 1 }), '--max-error-bytes'), '64')
    assert.equal(flagValue(argvFor({ maxErrorBytes: 2 * 1024 * 1024 }), '--max-error-bytes'), String(1024 * 1024))
    assert.equal(flagValue(argvFor({ maxErrorBytes: Number.NaN }), '--max-error-bytes'), '2048')

    // 非 preset 条目不受这两个参数影响（不会悄悄改写 checker argv）。
    const plain = validateConfigFile(
      { watches: [{ id: 'plain', checker: ['bash', '/check.sh'] }] },
      { configDir: dir, maxErrorBytes: 1 },
    )
    assert.equal(plain.ok, true)
    assert.deepEqual(JSON.parse(plain.entries[0].checker), ['bash', '/check.sh'])
  } finally {
    await cleanup(dir)
  }
})

test('shipped mailbox watch template validates disabled', async () => {
  const template = JSON.parse(await readFile(new URL('../extension/mailbox/examples/watches.example.json', import.meta.url), 'utf8'))
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
    // disabled 模板也生成完整 argv：默认解释器按平台确定，脚本固定为随包 mail.py。
    const argv = JSON.parse(result.entries[0].checker)
    assert.equal(argv[0], process.platform === 'win32' ? 'python' : 'python3')
    assert.ok(argv[1].endsWith(join('extension', 'mailbox', 'mail.py')), `unexpected mailbox script: ${argv[1]}`)
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

test('shipped extension layout: thin mail.py entry, mailbox_core package and moved examples', async () => {
  const entryUrl = new URL('../extension/mailbox/mail.py', import.meta.url)
  const entry = await readFile(entryUrl, 'utf8')
  const nonEmptyLines = entry.split('\n').filter((line) => line.trim() !== '')
  // v0.3.1：mail.py 只是入口（应保持很薄）；实现不得重新堆回入口文件。
  assert.ok(nonEmptyLines.length < 80, `mail.py 应保持精简，非空行=${nonEmptyLines.length}`)
  assert.match(entry, /from mailbox_core\.cli import main/, 'mail.py 从 mailbox_core.cli 导入 main')
  assert.doesNotMatch(entry, /class Mailbox\b/, 'IMAP 实现不在 mail.py')
  assert.doesNotMatch(entry, /def cmd_/, '子命令实现不在 mail.py')

  for (const relative of [
    'mailbox_core/__init__.py',
    'mailbox_core/cli/__init__.py',
    'examples/mail.env.example',
    'examples/watches.example.json',
    'examples/allow-accounts.example.json',
    'skills/watch-mailbox/SKILL.md',
  ]) {
    const info = await stat(new URL(`../extension/mailbox/${relative}`, import.meta.url))
    assert.ok(info.isFile(), `${relative} 应存在且是文件`)
  }
  // 旧模板路径已迁移：根目录不再有这几个 example 文件。
  for (const moved of ['mail.env.example', 'watches.example.json', 'allow-accounts.example.json']) {
    await assert.rejects(
      stat(new URL(`../extension/mailbox/${moved}`, import.meta.url)),
      /ENOENT/,
      `${moved} 应已移入 examples/`,
    )
  }
})
