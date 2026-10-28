/**
 * JS ↔ Python 契约互验：lib/commands.js 为 mailbox preset 生成的 argv 必须能被随包
 * Python 解析器（extension/mailbox/mailbox_core/cli/parser.py）接受，且各 flag 落到
 * 期望的 argparse 字段（含 v0.3.1 新增的 --max-error-bytes）。
 *
 * 找不到 python3/python 时跳过（Node 测试不强制依赖 Python 环境）。
 */

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { validateConfigFile } from '../lib/commands.js'

const MAILBOX_DIR = fileURLToPath(new URL('../extension/mailbox', import.meta.url))

function detectPython() {
  for (const candidate of ['python3', 'python']) {
    const probe = spawnSync(candidate, ['--version'], { encoding: 'utf8' })
    // 只接受 Python 3（`python` 在老系统上可能是 2.x，mailbox_core 需要 3.9+）。
    if (probe.error === undefined && probe.status === 0 && /^Python 3\./.test(String(probe.stdout))) {
      return candidate
    }
  }
  return null
}

const PYTHON = detectPython()
const PARSE_AND_DUMP = [
  'import json, sys',
  'from mailbox_core.cli.parser import build_parser',
  'ns = build_parser().parse_args(sys.argv[1:])',
  'print(json.dumps({',
  '    "command": ns.command,',
  '    "folder": ns.folder,',
  '    "max_message_bytes": ns.max_message_bytes,',
  '    "max_error_bytes": ns.max_error_bytes,',
  '    "remind_minutes": ns.remind_minutes,',
  '    "max_notify": ns.max_notify,',
  '    "json": ns.json,',
  '}))',
].join('\n')

function parseWithPython(argv) {
  return spawnSync(PYTHON, ['-c', PARSE_AND_DUMP, ...argv.slice(2)], {
    cwd: MAILBOX_DIR,
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', PYTHONIOENCODING: 'utf-8' },
    encoding: 'utf8',
  })
}

test(
  'mailbox preset argv is accepted by the bundled Python parser (JS ↔ Python contract)',
  { skip: PYTHON === null ? 'python3/python not available' : false },
  async () => {
    const dir = await mkdtemp(join(tmpdir(), 'watch-python-argv-'))
    try {
      const envFile = join(dir, 'mail.env')
      const allowFile = join(dir, 'allow-accounts.json')
      await writeFile(envFile, 'MAIL_ADDRESS=agent@example.com\n')
      await writeFile(allowFile, '{}')
      const validate = (options) => {
        const result = validateConfigFile(
          {
            watches: [
              {
                id: 'mailbox',
                preset: 'mailbox',
                enabled: true,
                mailbox: {
                  envFile,
                  stateDir: join(dir, 'state'),
                  allowAccountFile: allowFile,
                  remindAfterMinutes: 15,
                  maxNotify: 7,
                  folder: 'Archive',
                },
              },
            ],
          },
          { configDir: dir, ...options },
        )
        assert.equal(result.ok, true, result.errors?.join('\n'))
        return JSON.parse(result.entries[0].checker)
      }

      // custom limits：JS 生成的 argv 被 Python 解析成同样的 argparse 字段值。
      const custom = parseWithPython(validate({ maxMessageBytes: 4096, maxErrorBytes: 512 }))
      assert.equal(custom.error, undefined, String(custom.error))
      assert.equal(custom.status, 0, `python parser rejected the generated argv:\n${custom.stderr}`)
      assert.deepEqual(JSON.parse(custom.stdout), {
        command: 'check',
        folder: 'Archive',
        max_message_bytes: 4096,
        max_error_bytes: 512,
        remind_minutes: 15,
        max_notify: 7,
        json: true,
      })

      // 默认 limits：2048 / 8192 同样被接受（防止 JS 默认值与 Python parser 漂移）。
      const defaults = parseWithPython(validate({}))
      assert.equal(defaults.status, 0, `python parser rejected the default argv:\n${defaults.stderr}`)
      const parsed = JSON.parse(defaults.stdout)
      assert.equal(parsed.max_message_bytes, 8192)
      assert.equal(parsed.max_error_bytes, 2048)
      assert.equal(parsed.folder, 'Archive')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  },
)
