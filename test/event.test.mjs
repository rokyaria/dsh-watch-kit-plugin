import assert from 'node:assert/strict'
import test from 'node:test'
import { parseEventOutput } from '../lib/event.js'

test('退出码 0/255 不解析 JSON', () => {
  assert.deepEqual(parseEventOutput({ code: 0, stdout: '{"message":"x"}' }), { kind: 'by-exit-code' })
  assert.deepEqual(parseEventOutput({ code: 255, stdout: '{"message":"x"}' }), { kind: 'by-exit-code' })
})

test('纯文本输出回退到退出码语义', () => {
  assert.deepEqual(parseEventOutput({ code: 1, stdout: '有新邮件\n' }), { kind: 'by-exit-code' })
})

test('JSON 事件覆盖 message 与 evidence', () => {
  const parsed = parseEventOutput({
    code: 1,
    stdout: '{"message":"发现 2 封新邮件","evidence":"alice; bob"}',
  })
  assert.equal(parsed.kind, 'event')
  assert.equal(parsed.message, '发现 2 封新邮件')
  assert.equal(parsed.evidence, 'alice; bob')
  assert.equal(parsed.source, 'script')
})

test('缺省字段与空 message/evidence', () => {
  const parsed = parseEventOutput({ code: 1, stdout: '{"evidence":"e"}' })
  assert.equal(parsed.kind, 'event')
  assert.equal(parsed.message, undefined)
  assert.equal(parsed.evidence, 'e')
  const empty = parseEventOutput({ code: 1, stdout: '{"message":"  ","evidence":""}' })
  assert.equal(empty.message, undefined)
  assert.equal(empty.evidence, undefined)
})

test('剥离 BOM', () => {
  const parsed = parseEventOutput({ code: 1, stdout: '\ufeff{"message":"hi"}' })
  assert.equal(parsed.kind, 'event')
  assert.equal(parsed.message, 'hi')
})

test('非法 JSON / 非 object / 字段类型错误 / 超长', () => {
  const cases = [
    ['{bad', 'json_parse'],
    ['{ "a": }', 'json_parse'],
    ['{"message":1}', 'bad_message'],
    ['{"evidence":[]}', 'bad_evidence'],
    [`{"message":"${'x'.repeat(2049)}"}`, 'bad_message'],
  ]
  for (const [stdout, reason] of cases) {
    const parsed = parseEventOutput({ code: 1, stdout })
    assert.equal(parsed.kind, 'invalid', stdout)
    assert.equal(parsed.reason, reason, stdout)
  }
})

test('以 [ 或引号开头的 JSON 不按事件解析（回退退出码）', () => {
  assert.deepEqual(parseEventOutput({ code: 1, stdout: '[1,2]' }), { kind: 'by-exit-code' })
  assert.deepEqual(parseEventOutput({ code: 1, stdout: '"text"' }), { kind: 'by-exit-code' })
})

test('被截断的 stdout 视为无效事件', () => {
  const parsed = parseEventOutput({ code: 1, stdout: '{"message":"x"}', lossy: true })
  assert.equal(parsed.kind, 'invalid')
  assert.equal(parsed.reason, 'stdout_truncated')
})

test('未知字段忽略并产生 warning', () => {
  const parsed = parseEventOutput({ code: 1, stdout: '{"message":"x","extra":1}' })
  assert.equal(parsed.kind, 'event')
  assert.equal(parsed.warnings.length, 1)
  assert.match(parsed.warnings[0], /unknown event field/)
})

test('evidence 原样返回（截断只发生在 frame 渲染层）', () => {
  const long = 'e'.repeat(10_000)
  const parsed = parseEventOutput({ code: 1, stdout: JSON.stringify({ evidence: long }) })
  assert.equal(parsed.kind, 'event')
  assert.equal(parsed.evidence.length, long.length)
})
