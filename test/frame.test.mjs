import assert from 'node:assert/strict'
import test from 'node:test'
import { renderBatchFrame, renderEventFrame, renderFailureFrame } from '../lib/frame.js'

const eventItem = {
  kind: 'event',
  id: 'mail-inbox',
  at: '2026-10-26T14:10:03.000Z',
  rev: 3,
  messageSource: 'script',
  message: '发现新邮件，请阅读后回复。',
  evidence: 'alice / 合同终稿',
  logPath: '/w/logs/2026-10-26.log',
}

test('事件帧包含固定头部、message、evidence、logs 与 next', () => {
  const frame = renderEventFrame(eventItem)
  assert.match(frame, /^\[WATCH TRIGGER\] id=mail-inbox reason=event at=/)
  assert.match(frame, /message_source=script/)
  assert.match(frame, /--- message ---\n发现新邮件/)
  assert.match(frame, /--- evidence \(/)
  assert.match(frame, /alice \/ 合同终稿/)
  assert.match(frame, /--- logs ---\n\/w\/logs\/2026-10-26\.log/)
  assert.match(frame, /不要 re-arm/)
})

test('没有证据时省略 evidence 段', () => {
  const frame = renderEventFrame({ ...eventItem, evidence: '' })
  assert.doesNotMatch(frame, /--- evidence/)
})

test('证据超限被截断并标注', () => {
  const frame = renderEventFrame({ ...eventItem, evidence: 'x'.repeat(50_000) }, { maxEvidenceBytes: 1024 })
  assert.match(frame, /\[truncated\]/)
})

test('失败帧包含 failures 与 error_tail', () => {
  const frame = renderFailureFrame({
    id: 'check-email',
    at: '2026-10-26T14:10:03.000Z',
    failures: 5,
    threshold: 5,
    firstFailureAt: '2026-10-26T14:00:00.000Z',
    lastFailureAt: '2026-10-26T14:10:03.000Z',
    message: 'watch check-email 连续失败 5 次，已记录；轮询继续。',
    errorTail: 'imaplib error: login failed',
    logPath: '/w/logs/2026-10-26.log',
  })
  assert.match(frame, /reason=failure failures=5\/5/)
  assert.match(frame, /--- error_tail ---\nimaplib error/)
  assert.match(frame, /轮询继续/)
})

test('合并帧按顺序编号并逐条给出 message', () => {
  const frame = renderBatchFrame(
    [
      eventItem,
      { kind: 'failure', id: 'check-disk', at: '2026-10-26T14:10:04.000Z', failures: 5, threshold: 5, message: '磁盘检查失败', errorTail: 'df error' },
    ],
    { at: '2026-10-26T14:10:05.000Z' },
  )
  assert.match(frame, /^\[WATCH TRIGGER\] batch=2 at=/)
  assert.match(frame, /--- \[1\/2\] id=mail-inbox reason=event/)
  assert.match(frame, /--- \[2\/2\] id=check-disk reason=failure failures=5\/5/)
  assert.match(frame, /message: 磁盘检查失败/)
  assert.match(frame, /逐条按 message 执行/)
})
