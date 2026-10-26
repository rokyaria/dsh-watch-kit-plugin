import assert from 'node:assert/strict'
import test from 'node:test'
import { isValidWatchId, jitterFactor, localDayStamp, nextDueAt } from '../lib/ids.js'
import { clipUtf8, oneLine, sanitizeText, sizeLabel, tailLines, utf8Bytes } from '../lib/text.js'

test('isValidWatchId 接受合法 id、拒绝非法 id', () => {
  for (const id of ['ab', 'mail-inbox', 'a1', 'a'.repeat(40)]) assert.equal(isValidWatchId(id), true, id)
  for (const id of ['A', 'a', '1ab', 'a_b', 'a'.repeat(41), 'a b', '', null, undefined]) {
    assert.equal(isValidWatchId(id), false, String(id))
  }
})

test('jitterFactor 确定且在 ±10% 内', () => {
  for (const id of ['a', 'mail-inbox', 'x'.repeat(40)]) {
    const first = jitterFactor(id)
    assert.equal(first, jitterFactor(id))
    assert.ok(first >= -0.1 && first <= 0.1, `${id}: ${first}`)
  }
  const values = new Set(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map(jitterFactor))
  assert.ok(values.size > 1, 'should not be constant')
})

test('nextDueAt 在 INTERVAL 的 ±10% 内', () => {
  const start = 1_000_000
  const due = nextDueAt(start, 60, 'mail-inbox')
  assert.ok(due >= start + 54_000 && due <= start + 66_000, String(due))
})

test('localDayStamp 使用本地时区 YYYY-MM-DD', () => {
  const date = new Date(2026, 9, 26, 23, 30, 0)
  assert.equal(localDayStamp(date), '2026-10-26')
})

test('UTF-8 截断不产生半个字符', () => {
  const text = '中文'.repeat(10)
  const clipped = clipUtf8(text, 10, '…')
  assert.ok(utf8Bytes(clipped) <= 10)
  assert.ok(!clipped.includes('\ufffd'))
})

test('控制字符清理保留换行/制表符', () => {
  const value = sanitizeText('a\u0000b\nc\td\u001f')
  assert.equal(value, 'a b\nc\td ')
})

test('tailLines / sizeLabel / oneLine', () => {
  assert.equal(tailLines('1\n2\n3\n4', 2), '3\n4')
  assert.equal(sizeLabel(512), '512B')
  assert.equal(sizeLabel(2048), '2.0KB')
  assert.equal(oneLine('a\n b\tc'), 'a b c')
})
