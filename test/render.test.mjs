/**
 * Render contract (contract §5): merged per-target notification message — header,
 * per-watch sections, optional [error] line, one-time delivery-failure compensation
 * (128-char error, <=10 rows), 20-item caps, and the detailed result
 * (`includedIds`/`truncated`) used for delivery accounting; compensation rows appear
 * only for watches whose event actually made it into the message.
 *
 * maxBytes 是用户可见上限；实际布局与裁剪上限为 maxBytes + RENDER_HEADROOM_BYTES，
 * 让补偿段与事件在同一预算内尽量都放下。detailed 额外返回 renderedCompensationIds
 * （完整写出补偿行的 id）与 compensatedIds（所有被表示的补偿 id，含被「另有 N 个」
 * 汇总行覆盖的），供 poller 精确记账；超出实际上限时优先保事件，必要时用
 * deferredCompensationIds 把该 watch 的补偿延后到下一轮。
 */

import assert from 'node:assert/strict'
import test from 'node:test'
import {
  MAX_MERGED_ITEMS, RENDER_HEADROOM_BYTES, renderMergedMessage, renderMergedMessageDetailed,
} from '../lib/render.js'

const NOW = 1_800_000_000_000
const item = (overrides = {}) => ({ id: 'mail-inbox', intervalMs: 60_000, message: 'new mail', ...overrides })
const compensate = (overrides = {}) => ({ id: 'mail-inbox', count: 1, firstFailAt: NOW - 3_600_000, error: 'gateway/internal', ...overrides })


test('configured item and byte caps override the defaults', () => {
  const items = Array.from({ length: 5 }, (_, index) => item({ id: `w${index}`, message: `msg ${index}` }))
  const detailed = renderMergedMessageDetailed({ items, now: NOW, maxItems: 2, maxBytes: 8192 })
  assert.deepEqual(detailed.includedIds, ['w0', 'w1'])
  assert.equal(detailed.truncated, true)
  assert.match(detailed.text, /另有 3 个事件未列出/)
  assert.ok(Buffer.byteLength(detailed.text, 'utf8') <= 8192 + RENDER_HEADROOM_BYTES)
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

test('delivery-failure compensation renders once with hours/count/error and clips the error to 128 characters', () => {
  const message = renderMergedMessage({
    items: [item()],
    compensations: [compensate({ count: 3, firstFailAt: NOW - 2 * 3_600_000 })],
    now: NOW,
  })
  assert.equal(message.split('[投递失败补偿]').length, 2, 'exactly one compensation section')
  assert.ok(message.includes('2.0 小时'))
  assert.ok(message.includes('投递失败 3 次'))
  assert.ok(message.includes('gateway/internal'), 'a short error is rendered verbatim')

  const clipped = renderMergedMessage({
    items: [item({ error: null })],
    compensations: [compensate({ error: 'x'.repeat(300) })],
    now: NOW,
  })
  assert.ok(clipped.includes(`${'x'.repeat(128)}…`), 'keeps the first 128 chars and marks the cut')
  assert.ok(!clipped.includes('x'.repeat(129)))
})

test('multiple compensations merge into one section; more than 10 collapses to a count', () => {
  const items = Array.from({ length: 12 }, (_, index) => item({ id: `w${index}`, message: `msg ${index}` }))
  const compensations = Array.from({ length: 12 }, (_, index) => compensate({ id: `w${index}`, error: `err ${index}` }))
  const message = renderMergedMessage({ items, compensations, now: NOW })
  assert.equal(message.split('[投递失败补偿]').length, 2)
  assert.equal(message.split('\n- ').length - 1, 10, 'at most 10 compensation rows')
  assert.match(message, /另有 2 个/)
})

test('caps: at most 20 watch sections; oversized messages drop items within the 16KB (+headroom) cap', () => {
  const items = Array.from({ length: 25 }, (_, index) => item({ id: `watch-${index}`, message: `message ${index}` }))
  const message = renderMergedMessage({ items, now: NOW })
  assert.match(message, /^\[WATCH 通知\] 25 个事件/)
  assert.equal((message.match(/^--- watch-\d+（interval=60s）---$/gm) ?? []).length, 20, '20 sections rendered')
  assert.match(message, /另有 5 个事件未列出/)

  const huge = Array.from({ length: 20 }, (_, index) => item({ id: `huge-${index}`, message: 'y'.repeat(2_100) }))
  const detailed = renderMergedMessageDetailed({
    items: huge,
    compensations: [compensate({ id: 'huge-0', count: 2 })],
    now: NOW,
  })
  const hugeEffective = 16 * 1024 + RENDER_HEADROOM_BYTES
  assert.ok(Buffer.byteLength(detailed.text, 'utf8') <= hugeEffective, `bytes=${Buffer.byteLength(detailed.text, 'utf8')}`)
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

// 补偿行最坏合法长度：64 字符 watch id（见 contract §5 的 id 上限）。
const LONG_ID = (index) => `w${String(index).padStart(2, '0')}-${'x'.repeat(60)}`
// 补偿行最坏合法错误：128 个中文字符（每个 3 字节，oneLine 后不再加省略号）。
const CN_ERROR = '错'.repeat(128)
const bytesOf = (text) => Buffer.byteLength(text, 'utf8')

test('the 16KB worst case and a tight budget keep the whole compensation section and drop items instead', () => {
  // 场景 1：19 个 candidates + 12 条补偿（10 行完整 + 2 条被汇总行覆盖）。
  // 默认 maxBytes=16KB 的实际上限为 16KB+4096=20KB；场景尺寸按该预算设置，
  // 验证「补偿段优先完整、放不下就丢后段 items」。
  const items = Array.from({ length: 19 }, (_, index) => ({
    id: LONG_ID(index),
    intervalMs: 60_000,
    message: 'x'.repeat(730),
  }))
  const compensations = [
    ...Array.from({ length: 10 }, (_, index) => ({
      id: LONG_ID(index),
      count: 2,
      firstFailAt: NOW - 2 * 3_600_000,
      error: CN_ERROR,
    })),
    ...Array.from({ length: 2 }, (_, index) => ({
      id: LONG_ID(10 + index),
      count: 1,
      firstFailAt: NOW - 3_600_000,
      error: '短错误',
    })),
  ]

  const detailed = renderMergedMessageDetailed({ items, compensations, now: NOW })
  const text = detailed.text
  const bytes = bytesOf(text)
  const effective = 16 * 1024 + RENDER_HEADROOM_BYTES
  assert.ok(bytes <= effective, `message bytes=${bytes} must stay within maxBytes + headroom`)
  assert.ok(!text.includes('[truncated]'), 'no hard clip in the normal 16KB (+headroom) configuration')
  assert.ok(!text.includes('\uFFFD'), 'no half-cut utf8 character')
  assert.ok(detailed.includedIds.length < items.length, 'items give way to the complete compensation section')
  assert.ok(detailed.includedIds.length >= 12, 'at least all compensated watches still get their event in')

  // 补偿段完整：10 行（≤MAX_COMPENSATIONS）+ 被汇总覆盖的 2 条（12 条补偿都在 included 里）。
  assert.equal(detailed.renderedCompensationIds.length, 10)
  assert.deepEqual(detailed.renderedCompensationIds, compensations.slice(0, 10).map((entry) => entry.id))
  for (const item of compensations.slice(0, 10)) {
    assert.ok(text.includes(`- ${item.id}：`), `compensation row for ${item.id}`)
  }
  assert.equal(text.split('\n- ').length - 1, 10, 'exactly 10 full compensation rows')
  assert.ok(text.includes(CN_ERROR), '128-char multi-byte error is written in full')
  const summary = '…另有 2 个 watch 的投递失败记录未列出（见 watch_runs）'
  assert.ok(text.includes(summary), 'summary line for the compensations beyond the 10-row cap')
  assert.ok(text.endsWith(summary), 'the message ends with the summary line, not a truncated row')

  // compensatedIds 覆盖 included 的全部补偿 id（含被汇总行覆盖的）。
  const includedCompensationIds = compensations.filter((entry) => detailed.includedIds.includes(entry.id)).map((entry) => entry.id)
  assert.ok(includedCompensationIds.length >= 12)
  for (const id of includedCompensationIds) {
    assert.ok(detailed.compensatedIds.includes(id), `compensatedIds covers ${id}`)
  }
  assert.equal(detailed.truncated, true, 'omitted events are still reported as truncated')
  assert.equal(renderMergedMessage({ items, compensations, now: NOW }), text, 'string renderer stays compatible')

  // 场景 2：20 个 items + 10 条满行补偿（effective=20KB），预算同样优先保补偿，宁少 items 不截补偿。
  const tightItems = Array.from({ length: 20 }, (_, index) => ({
    id: LONG_ID(index),
    intervalMs: 60_000,
    message: 'y'.repeat(680),
  }))
  const tightCompensations = Array.from({ length: 10 }, (_, index) => ({
    id: LONG_ID(index),
    count: index + 1,
    firstFailAt: NOW - 3_600_000,
    error: CN_ERROR,
  }))

  const tightDetailed = renderMergedMessageDetailed({ items: tightItems, compensations: tightCompensations, now: NOW })
  const tightText = tightDetailed.text
  assert.ok(bytesOf(tightText) <= 16 * 1024 + RENDER_HEADROOM_BYTES, `bytes=${bytesOf(tightText)}`)
  assert.ok(!tightText.includes('[truncated]'), 'compensation never clipped for items')
  assert.ok(tightDetailed.includedIds.length < tightItems.length, 'fewer items are rendered to keep compensation complete')
  assert.equal(tightDetailed.renderedCompensationIds.length, 10)
  assert.equal(tightDetailed.compensatedIds.length, 10)
  assert.equal(tightText.split('\n- ').length - 1, 10, 'all 10 compensation rows are complete')
  for (const [index, item] of tightCompensations.entries()) {
    assert.ok(tightText.includes(`投递失败 ${index + 1} 次，最后一次：${CN_ERROR}`), `row ${index} intact`)
  }
  assert.ok(tightText.endsWith(CN_ERROR), 'last compensation row is not cut in half')
  assert.ok(!/…另有 \d+ 个 watch/.test(tightText), 'exactly 10 compensations need no summary line')
})

test('budget edge cases: without compensation items use the full budget; tiny maxBytes still renders the complete section', () => {
  // 场景 1：没有补偿时 items 可用满实际上限。
  const items = [{ id: 'big-message', intervalMs: 60_000, message: 'z'.repeat(5_000) }]

  const detailed = renderMergedMessageDetailed({ items, maxBytes: 8192, now: NOW })
  assert.deepEqual(detailed.includedIds, ['big-message'], 'a 5000B message fits in an 8KB message again')
  assert.equal(detailed.truncated, false)
  assert.ok(bytesOf(detailed.text) <= 8192 + RENDER_HEADROOM_BYTES)
  assert.ok(detailed.text.includes('z'.repeat(5_000)))
  assert.equal(renderMergedMessage({ items, maxBytes: 8192, now: NOW }), detailed.text)

  // 没有补偿时 16KB 上限下 19 条 ~630B 的 items 全部能投（固定预留已删除）。
  const many = Array.from({ length: 19 }, (_, index) => ({ id: LONG_ID(index), intervalMs: 60_000, message: 'x'.repeat(600) }))
  const noCompensation = renderMergedMessageDetailed({ items: many, now: NOW })
  assert.equal(noCompensation.includedIds.length, 19)
  assert.equal(noCompensation.truncated, false)
  assert.ok(bytesOf(noCompensation.text) <= 16 * 1024 + RENDER_HEADROOM_BYTES)

  // 场景 2：maxBytes 极小（1024，clamp 下限）→ 实际上限 = 1024 + 4096 = 5120。
  // 12 条满行补偿与事件在同一条消息里完整表示：段头 + 10 行上限 + 「另有 N 个」汇总行，
  // 不出现硬截断。
  const tinyItems = Array.from({ length: 12 }, (_, index) => ({
    id: `w${index}`,
    intervalMs: 60_000,
    message: 'x'.repeat(10),
  }))
  const tinyCompensations = Array.from({ length: 12 }, (_, index) => ({
    id: `w${index}`,
    count: 1,
    firstFailAt: NOW - 3_600_000,
    error: CN_ERROR,
  }))

  const tinyDetailed = renderMergedMessageDetailed({ items: tinyItems, compensations: tinyCompensations, now: NOW, maxBytes: 1024 })
  const tinyText = tinyDetailed.text
  const tinyEffective = 1024 + RENDER_HEADROOM_BYTES
  assert.ok(bytesOf(tinyText) <= tinyEffective, `bytes=${bytesOf(tinyText)} stays within maxBytes + headroom`)
  assert.ok(bytesOf(tinyText) > 1024, 'the internal headroom lets the section exceed the configured cap')
  assert.ok(!tinyText.includes('[truncated]'), 'the section fits without a hard clip')
  assert.ok(tinyText.includes('[投递失败补偿]'), 'section header survives at the minimum maxBytes')
  assert.match(tinyText, /…另有 \d+ 个 watch 的投递失败记录未列出（见 watch_runs）/, 'summary line covers compensations beyond the 10-row cap')
  assert.equal(tinyDetailed.renderedCompensationIds.length, 10, 'the 10-row cap still limits rendered rows')
  assert.equal(tinyDetailed.compensatedIds.length, tinyDetailed.includedIds.length, 'every included compensated watch is still represented')
  assert.equal(tinyDetailed.compensatedIds.length, 12)
  for (const id of tinyCompensations.filter((entry) => tinyDetailed.includedIds.includes(entry.id)).map((entry) => entry.id)) {
    assert.ok(tinyDetailed.compensatedIds.includes(id))
  }
  assert.ok(tinyText.endsWith('（见 watch_runs）'), 'the message still ends with an intact summary line')
  assert.deepEqual(tinyDetailed.deferredCompensationIds, [], 'headroom removes the need to defer compensations at tiny maxBytes')
})
/** 补偿记账不变量：rendered ⊆ compensated ⊆ included，deferred ⊆ included 且与 compensated 互斥、无重复。 */
function assertCompensationAccounting(detailed) {
  const unique = (ids) => new Set(ids).size === ids.length
  assert.ok(unique(detailed.includedIds), 'includedIds has no duplicates')
  assert.ok(unique(detailed.renderedCompensationIds), 'renderedCompensationIds has no duplicates')
  assert.ok(unique(detailed.compensatedIds), 'compensatedIds has no duplicates')
  assert.ok(unique(detailed.deferredCompensationIds), 'deferredCompensationIds has no duplicates')
  for (const id of detailed.renderedCompensationIds) {
    assert.ok(detailed.compensatedIds.includes(id), `rendered compensation ${id} is also compensated`)
  }
  for (const id of detailed.compensatedIds) {
    assert.ok(detailed.includedIds.includes(id), `compensated ${id} is included`)
  }
  for (const id of detailed.deferredCompensationIds) {
    assert.ok(detailed.includedIds.includes(id), `deferred ${id} is included`)
    assert.equal(detailed.compensatedIds.includes(id), false, `deferred ${id} is not compensated`)
  }
}

test('maxBytes=8192 + an 8000B event + its own compensation are both delivered via the 4096B headroom', () => {
  // maxBytes=8192 的实际上限为 8192+4096=12288：8000B 事件与自身补偿段同一条消息完整投递，
  // text 允许超过配置的 maxBytes（最多 +RENDER_HEADROOM_BYTES）。
  const id = 'mail-inbox'
  const message = 'x'.repeat(8_000)
  const longError = 'gateway/internal error '.repeat(8)
  const items = [{ id, intervalMs: 60_000, message }]
  const compensations = [{ id, count: 1, firstFailAt: NOW - 3_600_000, error: longError }]
  const effective = 8192 + RENDER_HEADROOM_BYTES

  const detailed = renderMergedMessageDetailed({ items, compensations, now: NOW, maxBytes: 8192 })
  assert.deepEqual(detailed.includedIds, [id], 'the event is delivered')
  assert.ok(detailed.text.includes(message), 'the event itself is in the message')
  assert.ok(detailed.text.includes('[投递失败补偿]'), 'the compensation section fits thanks to the headroom')
  assert.equal(detailed.text.split('\n- ').length - 1, 1, 'the compensation row is complete')
  assert.ok(detailed.text.includes(longError.slice(0, 128)), 'the compensation error is rendered in full')
  const bytes = bytesOf(detailed.text)
  assert.ok(bytes > 8192, `bytes=${bytes} uses the internal headroom over the configured 8192 maxBytes`)
  assert.ok(bytes <= effective, `bytes=${bytes} stays within maxBytes + RENDER_HEADROOM_BYTES`)
  assert.equal(detailed.truncated, false, 'the only event is delivered, so nothing is reported as omitted')
  assert.deepEqual(detailed.renderedCompensationIds, [id])
  assert.deepEqual(detailed.compensatedIds, [id])
  assert.deepEqual(detailed.deferredCompensationIds, [], 'headroom removes the need to defer the compensation')
  assertCompensationAccounting(detailed)
  assert.equal(renderMergedMessage({ items, compensations, now: NOW, maxBytes: 8192 }), detailed.text, 'string renderer stays compatible')
})

test('when even the effective limit is exceeded, the event wins and its own compensation is deferred', () => {
  // maxBytes=8192 → 实际上限=12288；事件 ~12000B + 自身补偿仍超预算 → 保事件、延后补偿。
  const id = 'mail-inbox'
  const message = 'y'.repeat(12_000)
  const items = [{ id, intervalMs: 60_000, message }]
  const compensations = [{ id, count: 1, firstFailAt: NOW - 3_600_000, error: CN_ERROR }]
  const effective = 8192 + RENDER_HEADROOM_BYTES

  const detailed = renderMergedMessageDetailed({ items, compensations, now: NOW, maxBytes: 8192 })
  assert.deepEqual(detailed.includedIds, [id], 'the event is kept instead of being dropped')
  assert.ok(detailed.text.includes(message), 'the event itself is in the message')
  assert.equal(detailed.text.includes('[投递失败补偿]'), false, 'the compensation is deferred to a later round')
  assert.equal(detailed.text.includes(CN_ERROR.slice(0, 128)), false, 'the deferred compensation row never leaks in')
  assert.ok(bytesOf(detailed.text) <= effective, `bytes=${bytesOf(detailed.text)} stays within the effective limit`)
  assert.ok(!detailed.text.includes('[truncated]'), 'the event fits without a hard clip')
  assert.equal(detailed.truncated, false)
  assert.deepEqual(detailed.renderedCompensationIds, [])
  assert.deepEqual(detailed.compensatedIds, [], 'a deferred compensation is never reported as represented')
  assert.deepEqual(detailed.deferredCompensationIds, [id])
  assertCompensationAccounting(detailed)
})

test('headroom renders every compensation; past the effective limit only the oversized event compensation is deferred', () => {
  const small = { id: 'small-w', intervalMs: 60_000, message: 'small event' }
  const compensations = [
    { id: 'big-w', count: 2, firstFailAt: NOW - 2 * 3_600_000, error: 'gateway/internal error '.repeat(8) },
    { id: 'small-w', count: 1, firstFailAt: NOW - 3_600_000, error: 'gateway/internal' },
  ]
  const effective = 8192 + RENDER_HEADROOM_BYTES

  // 7.8KB 事件 + 两条补偿都在 8192+4096 内：全部表示，无需 deferral。
  const within = renderMergedMessageDetailed({
    items: [small, { id: 'big-w', intervalMs: 60_000, message: 'y'.repeat(7_800) }],
    compensations,
    now: NOW,
    maxBytes: 8192,
  })
  assert.deepEqual(within.includedIds, ['small-w', 'big-w'], 'both events are delivered')
  assert.ok(within.text.includes('small event') && within.text.includes('y'.repeat(7_800)), 'both events are in the message')
  const withinBytes = bytesOf(within.text)
  assert.ok(withinBytes > 8192 && withinBytes <= effective, `bytes=${withinBytes} uses the headroom and stays within effective`)
  assert.ok(!within.text.includes('[truncated]'), 'headroom keeps the message unclipped')
  assert.equal(within.truncated, false)
  assert.ok(within.text.includes('- small-w：'), 'the small-watch compensation row is rendered in full')
  assert.ok(within.text.includes('- big-w：'), 'the big-watch compensation row is rendered in full')
  assert.deepEqual(within.renderedCompensationIds, ['big-w', 'small-w'])
  assert.deepEqual(within.compensatedIds, ['big-w', 'small-w'])
  assert.deepEqual(within.deferredCompensationIds, [], 'no compensation is deferred while everything fits')
  assertCompensationAccounting(within)

  // 12KB 事件把总预算推过实际上限 12288：保事件，只延后 big-w 的补偿，small-w 补偿仍完整。
  const over = renderMergedMessageDetailed({
    items: [small, { id: 'big-w', intervalMs: 60_000, message: 'y'.repeat(12_000) }],
    compensations,
    now: NOW,
    maxBytes: 8192,
  })
  assert.deepEqual(over.includedIds, ['small-w', 'big-w'], 'both events are still delivered')
  assert.ok(over.text.includes('small event') && over.text.includes('y'.repeat(12_000)), 'both events are in the message')
  assert.ok(bytesOf(over.text) <= effective, `bytes=${bytesOf(over.text)} stays within the effective limit`)
  assert.ok(!over.text.includes('[truncated]'), 'the deferred fallback keeps the message unclipped')
  assert.equal(over.truncated, false)
  assert.ok(over.text.includes('- small-w：'), 'the small-watch compensation row is still rendered in full')
  assert.equal(over.text.includes('- big-w：'), false, 'the big-watch compensation row is deferred')
  assert.deepEqual(over.renderedCompensationIds, ['small-w'])
  assert.deepEqual(over.compensatedIds, ['small-w'])
  assert.deepEqual(over.deferredCompensationIds, ['big-w'])
  assertCompensationAccounting(over)
  assert.equal(renderMergedMessage({ items: [small, { id: 'big-w', intervalMs: 60_000, message: 'y'.repeat(12_000) }], compensations, now: NOW, maxBytes: 8192 }), over.text, 'string renderer stays compatible')
})

test('boundary: maxItems=1; invalid maxItems/maxBytes clamp predictably for direct renderer calls', () => {
  const items = [item({ id: 'a', message: 'first' }), item({ id: 'b', message: 'second' })]
  const one = renderMergedMessageDetailed({ items, now: NOW, maxItems: 1 })
  assert.deepEqual(one.includedIds, ['a'], 'exactly one event is rendered')
  assert.equal(one.truncated, true)
  assert.match(one.text, /^\[WATCH 通知\] 2 个事件/)
  assert.match(one.text, /…另有 1 个事件未列出/)

  // Config 保证 maxItems>=1、maxBytes>=8192；以下只覆盖直接调用渲染器的边界：
  // 0/负数夹到最小 1 项，NaN/null/缺省回退默认 20 项。
  assert.deepEqual(renderMergedMessageDetailed({ items, now: NOW, maxItems: 0 }).includedIds, ['a'], 'maxItems=0 clamps to 1, not silently to 20')
  assert.deepEqual(renderMergedMessageDetailed({ items, now: NOW, maxItems: -5 }).includedIds, ['a'])
  assert.deepEqual(renderMergedMessageDetailed({ items, now: NOW, maxItems: Number.NaN }).includedIds, ['a', 'b'])
  assert.deepEqual(renderMergedMessageDetailed({ items, now: NOW, maxItems: 7.9 }).includedIds, ['a', 'b'])

  const big = item({ id: 'big', message: 'x'.repeat(6_000) })
  assert.deepEqual(
    renderMergedMessageDetailed({ items: [big], now: NOW, maxBytes: 0 }).includedIds,
    [],
    'maxBytes=0 clamps to the 1024 floor instead of falling back to 16KB',
  )
  assert.deepEqual(renderMergedMessageDetailed({ items: [big], now: NOW, maxBytes: -1 }).includedIds, [])
  assert.deepEqual(renderMergedMessageDetailed({ items: [big], now: NOW, maxBytes: Number.NaN }).includedIds, ['big'], 'invalid maxBytes falls back to the default')
  assert.deepEqual(renderMergedMessageDetailed({ items: [big], now: NOW, maxBytes: null }).includedIds, ['big'], 'null means "not configured"')
})

test('compensation error clipping never splits a UTF-16 surrogate pair', () => {
  // 第 128 个码点恰好是代理对（emoji）：旧实现按 UTF-16 码元 slice 会留下孤立高代理字符，
  // 宿主编码后变成 U+FFFD。修复后按码点截断，emoji 保持完整。
  const error = `${'x'.repeat(127)}😀tail`
  const message = renderMergedMessage({ items: [item()], compensations: [compensate({ error })], now: NOW })
  assert.equal(message.isWellFormed(), true, 'no lone surrogate in the rendered message')
  assert.ok(message.includes(`${'x'.repeat(127)}😀…`), 'the emoji at the clip boundary is kept intact')

  // BMP 文本的截断语义不变：仍是前 128 个字符 + 省略号。
  const ascii = renderMergedMessage({
    items: [item({ error: null })],
    compensations: [compensate({ error: 'y'.repeat(300) })],
    now: NOW,
  })
  assert.ok(ascii.includes(`${'y'.repeat(128)}…`))
  assert.ok(!ascii.includes('y'.repeat(129)))
})
