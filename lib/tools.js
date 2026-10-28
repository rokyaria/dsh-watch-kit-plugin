/** 模型工具：watch_runs（最近执行统计）与 watch_sessions（可绑定会话）。 */

import { defineTool } from '@deepseek-ai/dsh-tools'

const DEFAULT_HOURS = 3
const MAX_HOURS = 72
const MAX_SESSIONS = 50
const MAX_ERROR_CHARS = 100

function iso(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '-'
  const date = new Date(value)
  // 超出 ECMAScript Date 范围的时间戳（损坏/未来 schema 的 DB 行）会让 toISOString 抛
  // RangeError；渲染层统一回退，避免整个 watch_runs 输出失败。
  if (Number.isNaN(date.getTime())) return '-'
  return date.toISOString()
}

function oneLine(value, maxChars = MAX_ERROR_CHARS) {
  if (typeof value !== 'string' || value.trim() === '') return '-'
  const text = value.replace(/\s+/g, ' ').trim()
  // 按码点截断，避免在代理对（emoji 等）中间切断产生孤立代理字符。
  const chars = Array.from(text)
  return chars.length <= maxChars ? text : `${chars.slice(0, maxChars).join('')}…`
}

function textResult(text) {
  return [{ type: 'text', text }]
}

function renderRuns(value) {
  const rows = Array.isArray(value?.watches) ? value.watches : []
  if (rows.length === 0) {
    return textResult(`最近 ${value?.hours ?? DEFAULT_HOURS} 小时没有 watch 执行记录。`)
  }
  const lines = [
    `最近 ${value.hours} 小时 watch 执行情况（since ${iso(value.since)}）`,
    'id | interval | invoke | notified | error | checker_error | invalid_json | invalid_fields | timeout | delivery_fail | last_run | last_notify | last_error',
  ]
  for (const row of rows) {
    lines.push(
      [
        row.id,
        `${row.intervalSec}s`,
        row.invokeCount,
        row.notifiedCount,
        row.errorCount,
        row.checkerErrorCount,
        row.invalidJsonCount,
        row.invalidFieldsCount,
        row.timeoutCount,
        row.deliveryFailCount,
        iso(row.lastRunAt),
        iso(row.lastNotifyAt),
        oneLine(row.lastError),
      ].join(' | '),
    )
  }
  return textResult(lines.join('\n'))
}

function renderSessions(value) {
  if (typeof value?.error === 'string' && value.error !== '') {
    return textResult(`查询会话失败：${value.error}`)
  }
  const sessions = Array.isArray(value?.sessions) ? value.sessions : []
  if (sessions.length === 0) return textResult('没有可见会话。')
  const lines = ['session_id | running | agent_available | updated_at | cwd']
  for (const session of sessions) {
    lines.push(
      [session.sessionId, session.running ? 'yes' : 'no', session.agentAvailable ? 'yes' : 'no', iso(session.updatedAt), session.cwd ?? '-'].join(
        ' | ',
      ),
    )
  }
  if (value.truncated === true) lines.push(`（只显示前 ${MAX_SESSIONS} 条）`)
  return textResult(lines.join('\n'))
}

/**
 * @param {{ctx: object, db: object}} input
 * @returns {() => void}
 */
export function registerTools({ ctx, db }) {
  const runsTool = defineTool({
    name: 'watch_runs',
    description:
      '列出最近 N 小时（默认 3）每个 watch 的执行统计：interval、invoke_count、notified_count、error_count、checker_error_count、invalid_json_count、invalid_fields_count、timeout_count、delivery_fail_count、last_run_at、last_notify_at、last_error。error_count 只统计 status≠ok 的运行；checker_error_count 统计 status=ok 但 checker 合法返回了 error 的运行（如 mailbox 的 IMAP/认证故障）；last_error 优先取窗口内最近一次失败，没有失败时回退到最近一次 checker error。',
    parameters: {
      hours: {
        type: 'number',
        description: `回看小时数，默认 ${DEFAULT_HOURS}，范围 1–${MAX_HOURS}`,
      },
    },
    output: {
      schema: { type: 'json' },
      render(_args, value) {
        return renderRuns(value)
      },
    },
    async execute(args = {}) {
      const requested = Number(args?.hours)
      const hours = Number.isFinite(requested) ? Math.min(MAX_HOURS, Math.max(1, requested)) : DEFAULT_HOURS
      const since = Date.now() - hours * 3_600_000
      const watches = db.runsReport(since)
      return { hours, since, watches }
    },
  })

  const sessionsTool = defineTool({
    name: 'watch_sessions',
    description:
      '列出可绑定的会话（session_id、cwd、更新时间、是否 running）；watch 配置里的 target 省略时会自动绑定到执行 /watch-reload 的会话，需要跨会话时才用本工具查找 id。',
    parameters: {},
    output: {
      schema: { type: 'json' },
      render(_args, value) {
        return renderSessions(value)
      },
    },
    async execute(_args, exec) {
      try {
        const signal = exec?.signal ?? AbortSignal.timeout(5000)
        const value = await ctx.sessionController.list({}, signal)
        const items = Array.isArray(value?.items) ? value.items : []
        const sessions = items
          .filter((item) => item !== null && typeof item === 'object' && typeof item.sessionId === 'string')
          .sort((left, right) => Number(right.updatedAt ?? 0) - Number(left.updatedAt ?? 0))
        return {
          sessions: sessions.slice(0, MAX_SESSIONS).map((item) => ({
            sessionId: item.sessionId,
            cwd: item.cwd ?? null,
            updatedAt: item.updatedAt ?? null,
            running: item.running === true,
            agentAvailable: item.agentAvailable !== false,
            blank: item.blank === true,
            origin: item.origin ?? null,
            parentSessionId: item.parentSessionId ?? null,
          })),
          truncated: sessions.length > MAX_SESSIONS,
        }
      } catch (error) {
        return { sessions: [], truncated: false, error: error instanceof Error ? error.message : String(error) }
      }
    },
  })

  const disposers = [ctx.tools.register(runsTool), ctx.tools.register(sessionsTool)]
  return () => {
    for (const dispose of disposers) {
      try {
        dispose()
      } catch {
        /* 已释放 */
      }
    }
  }
}
