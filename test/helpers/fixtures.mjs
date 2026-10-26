/** 测试辅助：临时目录、watch entry 构造、假 subprocess。 */

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { normalizeConf } from '../../lib/conf.js'
import { defaultState } from '../../lib/registry.js'

export async function makeTmp(prefix = 'watch-test-') {
  return mkdtemp(join(tmpdir(), prefix))
}

export async function makeWatchDir(base, id, { conf, check = '#!/bin/bash\nexit 0\n', chmod = 0o755 } = {}) {
  const dir = join(base, id)
  await mkdir(dir, { recursive: true })
  const values = {
    PURPOSE: 'demo purpose',
    TRIGGER_MSG: '请处理这个事件',
    INTERVAL: '60',
    TIMEOUT: '15',
    TARGETS: 'session-test',
    ...(conf ?? {}),
  }
  const confText = Object.entries(values)
    .map(([key, value]) => `${key}=${value}`)
    .join('\n')
  await writeFile(join(dir, 'watch.conf'), `${confText}\n`, 'utf8')
  const checkFile = join(dir, 'check.sh')
  await writeFile(checkFile, check, 'utf8')
  await import('node:fs/promises').then((fs) => fs.chmod(checkFile, chmod))
  return { dir, values, checkFile }
}

export function makeEntry({ dir, id = 'demo', values = {}, confOverrides = {}, stateOverrides = {} } = {}) {
  const merged = {
    PURPOSE: 'demo purpose',
    TRIGGER_MSG: '请处理这个事件',
    INTERVAL: '60',
    TIMEOUT: '15',
    TARGETS: 'session-test',
    ...values,
  }
  const conf = { ...normalizeConf(merged), ...confOverrides }
  return {
    id,
    root: dirname(dir),
    dir,
    confPath: join(dir, 'watch.conf'),
    confText: '',
    values: merged,
    warnings: [],
    conf,
    confError: null,
    state: {
      ...defaultState(id),
      status: 'active',
      target: 'session-test',
      ...stateOverrides,
    },
    inFlight: false,
    nextDueAt: 0,
    runnerArgv: ['/bin/bash', join(dir, 'check.sh')],
    runnerError: null,
    dataDir: join(dir, 'data'),
    logsDir: join(dir, 'logs'),
  }
}

/** 假 registry：状态写回内存、按需记录调用。 */
export function makeFakeRegistry(entries = []) {
  const calls = { markDue: [], markOrphaned: [], scanned: 0 }
  const registry = {
    entries,
    calls,
    list: () => entries,
    get: (id) => entries.find((entry) => entry.id === id),
    scan: async () => entries,
    scanIfChanged: async () => {
      calls.scanned += 1
      return entries
    },
    writeState: async (entry, state) => {
      entry.state = state
    },
    markDue: (id, at = 0) => {
      calls.markDue.push({ id, at })
      const entry = entries.find((item) => item.id === id)
      if (entry) entry.nextDueAt = at
    },
    markOrphaned: async (entry) => {
      calls.markOrphaned.push(entry.id)
      entry.state.status = 'orphaned'
      return entry.state
    },
    remove: (id) => {
      const index = entries.findIndex((entry) => entry.id === id)
      if (index >= 0) entries.splice(index, 1)
    },
  }
  return registry
}

/** 假子进程服务：同步/超时/挂起三种行为。 */
export function makeFakeSubprocess({ stdout = '', stderr = '', exitCode = 0, signal = null, hang = false, spawnError } = {}) {
  const spawns = []
  const subprocess = {
    spawns,
    spawn(spec) {
      spawns.push(spec)
      if (spawnError !== undefined) throw new Error(spawnError)
      let resolveDone
      let settled = false
      const done = new Promise((resolve) => {
        resolveDone = resolve
      })
      const finish = () => {
        if (settled) return
        settled = true
        resolveDone({ exitCode, signal })
      }
      if (!hang) setTimeout(finish, 0)
      return {
        argv: spec.argv,
        cwd: spec.cwd,
        done,
        terminate() {
          finish()
        },
        collected: {
          stdout: {
            readFrom: () => ({ text: stdout, nextOffset: Buffer.byteLength(stdout), lossy: false }),
          },
          stderr: {
            readFrom: () => ({ text: stderr, nextOffset: Buffer.byteLength(stderr), lossy: false }),
          },
        },
      }
    },
    async resolveExecutable(command) {
      return `/usr/bin/${command}`
    },
  }
  return subprocess
}

export async function cleanup(dir) {
  await rm(dir, { recursive: true, force: true })
}
