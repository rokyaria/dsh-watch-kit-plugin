import assert from 'node:assert/strict'
import test from 'node:test'
import {
  effectiveTriggerMsg,
  normalizeConf,
  parseWatchConf,
  platformDefaultCheck,
  validateWatchConf,
} from '../lib/conf.js'

test('parseWatchConf：注释、空行、引号、未知键', () => {
  const { values, warnings } = parseWatchConf(
    [
      '# comment',
      '',
      'PURPOSE=盯住邮箱',
      'TRIGGER_MSG="有新邮件，请阅读"',
      "FAILURE_MSG='连续失败，请检查'",
      'INTERVAL=120',
      'UNKNOWN_KEY=x',
      'not a pair',
    ].join('\n'),
  )
  assert.equal(values.PURPOSE, '盯住邮箱')
  assert.equal(values.TRIGGER_MSG, '有新邮件，请阅读')
  assert.equal(values.FAILURE_MSG, '连续失败，请检查')
  assert.equal(values.INTERVAL, '120')
  assert.equal(values.UNKNOWN_KEY, undefined)
  assert.equal(warnings.length, 2)
})

test('normalizeConf 默认值', () => {
  const conf = normalizeConf({}, { platform: 'linux' })
  assert.equal(conf.intervalSec, 60)
  assert.equal(conf.timeoutSec, 15)
  assert.equal(conf.check, './check.sh')
  assert.equal(conf.runner, 'auto')
  assert.deepEqual(conf.targets, [])
})

test('platformDefaultCheck 按平台', () => {
  assert.equal(platformDefaultCheck('linux'), './check.sh')
  assert.equal(platformDefaultCheck('darwin'), './check.sh')
  assert.equal(platformDefaultCheck('win32'), './check.ps1')
})

test('effectiveTriggerMsg 回退到 PURPOSE', () => {
  assert.equal(effectiveTriggerMsg({ triggerMsg: 'a', purpose: 'b' }), 'a')
  assert.equal(effectiveTriggerMsg({ triggerMsg: '', purpose: 'b' }), 'b')
  assert.match(effectiveTriggerMsg({ triggerMsg: '', purpose: '' }), /未设置/)
})

test('validateWatchConf 接受合法配置', () => {
  const result = validateWatchConf(
    { PURPOSE: 'p', INTERVAL: '30', TIMEOUT: '15', TARGETS: 'session-a', CHECK: './check.sh' },
    { id: 'mail-inbox', platform: 'linux' },
  )
  assert.equal(result.ok, true, JSON.stringify(result.errors))
  assert.deepEqual(result.conf.targets, ['session-a'])
})

test('validateWatchConf 拒绝越界与非法值', () => {
  const cases = [
    [{ INTERVAL: '29', TIMEOUT: '14', TARGETS: 's' }, 'bad_interval'],
    [{ INTERVAL: '86401', TIMEOUT: '14', TARGETS: 's' }, 'bad_interval'],
    [{ INTERVAL: '60', TIMEOUT: '31', TARGETS: 's' }, 'bad_timeout'],
    [{ INTERVAL: '60', TIMEOUT: '0', TARGETS: 's' }, 'bad_timeout'],
    [{ INTERVAL: '60', TIMEOUT: '15', TARGETS: '' }, 'missing_target'],
    [{ INTERVAL: '60', TIMEOUT: '15', TARGETS: 's', RUNNER: 'ruby' }, 'bad_runner'],
    [{ INTERVAL: '60', TIMEOUT: '15', TARGETS: 's', CHECK: '/etc/passwd' }, 'bad_check_path'],
    [{ INTERVAL: '60', TIMEOUT: '15', TARGETS: 's', CHECK: '../x.sh' }, 'bad_check_path'],
    [{ INTERVAL: '60', TIMEOUT: '15', TARGETS: 's', PURPOSE: 'x'.repeat(5000) }, 'bad_trigger_msg'],
  ]
  for (const [values, code] of cases) {
    const result = validateWatchConf(values, { id: 'demo', platform: 'linux' })
    assert.equal(result.ok, false, JSON.stringify(values))
    assert.ok(
      result.errors.some((item) => item.code === code),
      `${code} not in ${result.errors.map((item) => item.code)}`,
    )
  }
})

test('validateWatchConf 拒绝非法 id', () => {
  const result = validateWatchConf({ INTERVAL: '60', TIMEOUT: '15', TARGETS: 's' }, { id: 'Bad_ID' })
  assert.equal(result.ok, false)
  assert.ok(result.errors.some((item) => item.code === 'invalid_id'))
})

test('validateWatchConf 校验可选唤醒预算', () => {
  const ok = validateWatchConf(
    { INTERVAL: '60', TIMEOUT: '15', TARGETS: 's', WAKE_BUDGET_CAPACITY: '5', WAKE_BUDGET_REFILL_SECONDS: '600' },
    { id: 'demo', platform: 'linux' },
  )
  assert.equal(ok.ok, true, JSON.stringify(ok.errors))
  assert.equal(ok.conf.budgetCapacity, 5)
  assert.equal(ok.conf.budgetRefillSec, 600)

  const tooBig = validateWatchConf(
    { INTERVAL: '60', TIMEOUT: '15', TARGETS: 's', WAKE_BUDGET_CAPACITY: '1001' },
    { id: 'demo', platform: 'linux' },
  )
  assert.ok(tooBig.errors.some((item) => item.code === 'bad_budget'))

  const badRefill = validateWatchConf(
    { INTERVAL: '60', TIMEOUT: '15', TARGETS: 's', WAKE_BUDGET_CAPACITY: '5', WAKE_BUDGET_REFILL_SECONDS: '0' },
    { id: 'demo', platform: 'linux' },
  )
  assert.ok(badRefill.errors.some((item) => item.code === 'bad_budget'))

  const off = validateWatchConf({ INTERVAL: '60', TIMEOUT: '15', TARGETS: 's' }, { id: 'demo', platform: 'linux' })
  assert.equal(off.ok, true)
  assert.equal(off.conf.budgetCapacity, 0)
})
