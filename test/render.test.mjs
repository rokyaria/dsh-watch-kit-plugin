/**
 * Render contract (contract §5 + review fix M1): merged per-target notification
 * message, per-watch sections, optional [error] line, one-time delivery-failure
 * compensation (128-char error, <=10 rows), 20-item/16KB caps, and the detailed
 * result (`includedIds`/`truncated`) used for delivery accounting: compensation
 * rows appear only for watches whose event actually made it into the message.
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import { MAX_MERGED_ITEMS, renderMergedMessage, renderMergedMessageDetailed } from '../lib/render.js'

const NOW = 1_800_000_000_000
const item = (overrides = {}) => ({ id: 'mail-inbox', intervalMs: 60_000, message: 'new mail', ...overrides })
const compensate = (overrides = {}) => ({ id: 'mail-inbox', count: 1, firstFailAt: NOW - 3_600_000, error: 'gateway/internal', ...overrides })


test('configured item and byte caps override the defaults', () => {
  const items = Array.from({ length: 5 }, (_, index) => item({ id: `w${index}`, message: `msg ${index}` }))
  const detailed = renderMergedMessageDetailed({ items, now: NOW, maxItems: 2, maxBytes: 8192 })
  assert.deepEqual(detailed.includedIds, ['w0', 'w1'])
  assert.equal(detailed.truncated, true)
  assert.match(detailed.text, /另有 3 个事件未列出/)
  assert.ok(Buffer.byteLength(detailed.text, 'utf8') <= 8192)
})

test('single-target merged message: header, per-watch section and message', () => {
  const message = renderMergedMessage({ items: [item()], now: NOW })
  assert.match(message, /^\[WATCH 通知\] 1 个事件/)
  assert.ok(message.includes('--- mail-inbox（interval=60s）---'))
  assert.ok(message.includes('new mail'))
  assert.ok(!message.includes('[error]'))
  assert.ok(!message.includes('[投递失败补偿]'))
})

test('multiple watches for one target are merged into one ordered message with per-watch error lines', () => {
  const items = [
    item({ id: 'a', intervalMs: 30_000, message: 'event a', error: 'backend unreachable' }),
    item({ id: 'b', intervalMs: 120_000, message: 'event b' }),
    item({ id: 'c', intervalMs: 60_000, message: 'event c' }),
  ]
  const message = renderMergedMessage({ items, now: NOW })
  assert.match(message, /^\[WATCH 通知\] 3 个事件/)
  for (const [index, id] of ['a', 'b', 'c'].entries()) {
    const at = message.indexOf(`--- ${id}（`)
    assert.ok(at >= 0, `section ${id}`)
    if (index > 0) assert.ok(at > message.indexOf(`--- ${['a', 'b', 'c'][index - 1]}（`), 'sections keep item order')
  }
  assert.ok(message.includes('event a') && message.includes('event b') && message.includes('event c'))
  assert.ok(message.includes('[error] backend unreachable'), 'only the watch that reported an error gets an [error] line')
  assert.equal(message.split('[error]').length, 2)
})

test('delivery-failure compensation is rendered once with hours/count and last error', () => {
  const message = renderMergedMessage({
    items: [item()],
    compensations: [compensate({ count: 3, firstFailAt: NOW - 2 * 3_600_000 })],
    now: NOW,
  })
  assert.equal(message.split('[投递失败补偿]').length, 2, 'exactly one compensation section')
  assert.ok(message.includes('2.0 小时'))
  assert.ok(message.includes('投递失败 3 次'))
  assert.ok(message.includes('gateway/internal'))
})

test('compensation error text is truncated to 128 characters', () => {
  const longError = 'x'.repeat(300)
  const message = renderMergedMessage({
    items: [item({ error: null })],
    compensations: [compensate({ error: longError })],
    now: NOW,
  })
  assert.ok(message.includes(`${'x'.repeat(128)}…`), 'keeps the first 128 chars and marks the cut')
  assert.ok(!message.includes('x'.repeat(129)))
})

test('multiple compensations merge into one section; more than 10 collapses to a count', () => {
  const items = Array.from({ length: 12 }, (_, index) => item({ id: `w${index}`, message: `msg ${index}` }))
  const compensations = Array.from({ length: 12 }, (_, index) => compensate({ id: `w${index}`, error: `err ${index}` }))
  const message = renderMergedMessage({ items, compensations, now: NOW })
  assert.equal(message.split('[投递失败补偿]').length, 2)
  assert.equal(message.split('\n- ').length - 1, 10, 'at most 10 compensation rows')
  assert.match(message, /另有 2 个/)
})

test('caps: at most 20 watch sections; oversized messages drop items within the 16KB cap', () => {
  const items = Array.from({ length: 25 }, (_, index) => item({ id: `watch-${index}`, message: `message ${index}` }))
  const message = renderMergedMessage({ items, now: NOW })
  assert.match(message, /^\[WATCH 通知\] 25 个事件/)
  assert.equal((message.match(/^--- watch-\d+（interval=60s）---$/gm) ?? []).length, 20, '20 sections rendered')
  assert.match(message, /另有 5 个事件未列出/)

  const huge = Array.from({ length: 20 }, (_, index) => item({ id: `huge-${index}`, message: 'y'.repeat(2_000) }))
  const detailed = renderMergedMessageDetailed({
    items: huge,
    compensations: [compensate({ id: 'huge-0', count: 2 })],
    now: NOW,
  })
  assert.ok(Buffer.byteLength(detailed.text, 'utf8') <= 16 * 1024, `bytes=${Buffer.byteLength(detailed.text, 'utf8')}`)
  assert.equal(detailed.truncated, true, 'oversized message reports truncation')
  assert.ok(detailed.includedIds.length < 20, 'items that do not fit are dropped')
  assert.ok(detailed.text.includes('…另有'), 'the omission note is present')
  assert.ok(detailed.text.includes('[投递失败补偿]'), 'compensation budget survives item truncation')
})

test('detailed renderer reports includedIds/truncated and compensation only for included watches', () => {
  const items = Array.from({ length: MAX_MERGED_ITEMS + 1 }, (_, index) => item({ id: `w${index}`, message: `msg ${index}` }))
  const compensations = [
    compensate({ id: 'w0', count: 2 }),
    compensate({ id: `w${MAX_MERGED_ITEMS}`, count: 5, error: 'omitted-watch error' }),
  ]
  const detailed = renderMergedMessageDetailed({ items, compensations, now: NOW })
  assert.deepEqual(detailed.includedIds, items.slice(0, MAX_MERGED_ITEMS).map((entry) => entry.id))
  assert.equal(detailed.truncated, true)
  assert.match(detailed.text, /…另有 1 个事件未列出/)
  assert.ok(detailed.text.includes('[投递失败补偿]'))
  assert.ok(detailed.text.includes('w0'))
  assert.ok(!detailed.text.includes('omitted-watch error'), 'compensation for an omitted watch is not rendered')
  assert.equal(renderMergedMessage({ items, compensations, now: NOW }), detailed.text, 'string renderer stays compatible')
})
