import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveRunner } from '../lib/runner.js'

function makeFinders(available, executable = new Set()) {
  return {
    resolveExecutable: async (command) => (available[command] === undefined ? null : available[command]),
    isExecutable: async (path) => executable.has(path),
  }
}

test('RUNNER=direct 直接执行', async () => {
  assert.deepEqual(await resolveRunner({ checkPath: '/w/check.sh', runner: 'direct' }), ['/w/check.sh'])
})

test('显式 RUNNER=bash 找到/找不到解释器', async () => {
  assert.deepEqual(
    await resolveRunner({ checkPath: '/w/check.sh', runner: 'bash', ...makeFinders({ bash: '/bin/bash' }) }),
    ['/bin/bash', '/w/check.sh'],
  )
  assert.equal(
    await resolveRunner({ checkPath: '/w/check.sh', runner: 'bash', ...makeFinders({}) }),
    null,
  )
})

test('auto：POSIX 可执行文件直接执行', async () => {
  assert.deepEqual(
    await resolveRunner({ platform: 'linux', checkPath: '/w/check.sh', ...makeFinders({ bash: '/bin/bash' }, new Set(['/w/check.sh'])) }),
    ['/w/check.sh'],
  )
})

test('auto：.sh 走 bash（win32 同样）', async () => {
  for (const platform of ['linux', 'darwin', 'win32']) {
    const argv = await resolveRunner({ platform, checkPath: '/w/check.sh', ...makeFinders({ bash: '/bin/bash' }) })
    assert.deepEqual(argv, ['/bin/bash', '/w/check.sh'], platform)
  }
  assert.equal(
    await resolveRunner({ platform: 'win32', checkPath: '/w/check.sh', ...makeFinders({}) }),
    null,
  )
})

test('auto：.ps1 优先 pwsh、回退 powershell、都缺返回 null', async () => {
  assert.deepEqual(
    await resolveRunner({ platform: 'win32', checkPath: '/w/check.ps1', ...makeFinders({ pwsh: 'pwsh', powershell: 'powershell' }) }),
    ['pwsh', '-NoProfile', '-NonInteractive', '-File', '/w/check.ps1'],
  )
  assert.deepEqual(
    await resolveRunner({ platform: 'win32', checkPath: '/w/check.ps1', ...makeFinders({ powershell: 'powershell' }) }),
    ['powershell', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', '/w/check.ps1'],
  )
  assert.equal(
    await resolveRunner({ platform: 'win32', checkPath: '/w/check.ps1', ...makeFinders({}) }),
    null,
  )
})

test('auto：.py / .js / .cmd / .exe', async () => {
  assert.deepEqual(
    await resolveRunner({ platform: 'linux', checkPath: '/w/check.py', ...makeFinders({ python3: 'python3', python: 'python' }) }),
    ['python3', '/w/check.py'],
  )
  assert.deepEqual(
    await resolveRunner({ platform: 'win32', checkPath: '/w/check.py', ...makeFinders({ py: 'py', python: 'python' }) }),
    ['py', '-3', '/w/check.py'],
  )
  assert.deepEqual(
    await resolveRunner({ platform: 'linux', checkPath: '/w/check.mjs', ...makeFinders({ node: 'node' }) }),
    ['node', '/w/check.mjs'],
  )
  assert.deepEqual(
    await resolveRunner({ platform: 'win32', checkPath: '/w/check.cmd', ...makeFinders({ 'cmd.exe': 'C:/Windows/System32/cmd.exe' }) }),
    ['C:/Windows/System32/cmd.exe', '/d', '/s', '/c', '/w/check.cmd'],
  )
  assert.deepEqual(await resolveRunner({ platform: 'win32', checkPath: '/w/tool.exe' }), ['/w/tool.exe'])
})

test('未知 RUNNER 抛错', async () => {
  await assert.rejects(() => resolveRunner({ checkPath: '/w/check.sh', runner: 'ruby' }), /unknown RUNNER/)
})
