/** dsh-watch-kit-plugin 装配：SQLite + 10s 轮询 + /watch-reload + 两个工具。 */

import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { registerCommands } from './commands.js'
import { Config } from './config.js'
import { WatchDB } from './db.js'
import { syncMailboxSkill } from './mailbox-skill.js'
import { resolveWatchPaths } from './paths.js'
import { Poller } from './poller.js'
import { registerSkills } from './skills.js'
import { registerTools } from './tools.js'

export const name = 'watch'
export const inject = ['commands', 'tools', 'skills', 'sessionController', 'subprocess', 'timer']

export { Config }

/**
 * 已知特性（不是遗漏）：这里只调用 `agent.followup()`，故意不等待
 * `ctx.sessions.flush()`。followup 只把消息放入宿主内存 inbox；即使宿主
 * 尚未/未能持久化，本轮也按 delivered 记账。若真的丢失，checker 的
 * last_notified_at / 周期提醒会在下个静默窗口重新投递。投递失败本身是偶发
 * 异常，为此增加 flush 等待/重试会把插件耦合进宿主持久化策略，收益不足。
 */
function createDeliver(ctx) {
  return async function deliver({ target, text }) {
    let resolved
    try {
      resolved = await ctx.sessionController.resolveAgent(target)
    } catch (error) {
      throw error instanceof Error ? error : new Error(String(error))
    }
    if (resolved === undefined || resolved === null) throw new Error(`session ${target} unavailable`)
    if (resolved.error !== undefined) {
      throw resolved.error instanceof Error ? resolved.error : new Error(String(resolved.error))
    }
    const agent = resolved.agent ?? resolved
    if (agent === undefined || agent === null || typeof agent.followup !== 'function') {
      throw new Error(`session ${target} has no agent`)
    }
    const outcome = agent.followup(
      createUserMessage({
        content: [{ type: 'text', text }],
        source: { kind: 'cordis-host-runner' },
      }),
    )
    if (outcome !== null && typeof outcome === 'object' && typeof outcome.then === 'function') await outcome
  }
}

/**
 * @param {object} ctx Cordis Host context
 * @param {object} config 插件配置（schemastery 已校验）
 */
export async function apply(ctx, config = {}) {
  // v0.2.4：运行时状态统一放用户级 $DSH_HOME（默认 ~/.dsh）下的 watch/，
  // 与 profile 级安装形态一致；不再用"最近会话 cwd"猜 workspace，避免目录漂移。
  const { configFile, dbFile } = resolveWatchPaths({
    configFile: config.configFile,
    dbFile: config.dbFile,
  })
  const configDir = dirname(configFile)
  const pollIntervalMs = Number(config.pollIntervalMs) > 0 ? Number(config.pollIntervalMs) : 10_000

  mkdirSync(configDir, { recursive: true })
  mkdirSync(dirname(dbFile), { recursive: true })

  const db = new WatchDB(dbFile)
  const limits = config.limits ?? {}
  const retentionDays = Number(limits.scheduler?.runRetentionDays)
  const retentionMs = (Number.isFinite(retentionDays) && retentionDays > 0 ? retentionDays : 7) * 24 * 3_600_000
  const poller = new Poller({
    db,
    deliver: createDeliver(ctx),
    subprocess: ctx.subprocess,
    logger: ctx.logger,
    configDir,
    pollIntervalMs,
    maxConcurrentChecks: limits.scheduler?.maxConcurrentChecks,
    deliveryTimeoutMs: limits.scheduler?.deliveryTimeoutMs,
    checkerLimits: limits.checker,
    messageLimits: limits.message,
    retentionMs,
  })

  // 扩展 skill 跟随配置：/watch-reload 成功后把 mailbox skill 落地/归档到 $DSH_HOME。
  // 只做文件同步，失败仅告警，不影响 watch 生效。
  const syncExtensionSkills = async (entries = []) => {
    const enabled = entries.some((entry) => entry.preset === 'mailbox' && entry.enabled)
    try {
      return syncMailboxSkill({ enabled })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      ctx.logger.warn?.("watch: mailbox skill sync failed: " + message)
      return { status: 'failed', error: message }
    }
  }

  try {
    ctx.effect(
      () => registerCommands({
        ctx, db, poller, configFile, configDir, retentionMs, syncExtensionSkills,
        maxMessageBytes: limits.checker?.maxMessageBytes,
      }),
      'watch.commands',
    )
    ctx.effect(() => registerTools({ ctx, db }), 'watch.tools')
    ctx.effect(() => registerSkills(ctx), 'watch.skills')
    ctx.effect(() => {
      const disposeInterval = ctx.interval(() => {
        void poller.poll()
      }, pollIntervalMs)
      void poller.poll()
      return () => {
        try {
          disposeInterval()
        } catch {
          /* 已释放 */
        }
        poller.dispose()
      }
    }, 'watch.poller')
  } catch (error) {
    // 注册失败时释放已打开的 DB/轮询，避免 fiber 失败后泄漏句柄。
    try {
      poller.dispose()
    } catch {
      /* 已释放 */
    }
    try {
      db.close()
    } catch {
      /* 已关闭 */
    }
    throw error
  }

  ctx.logger.info?.(
    `watch: db=${dbFile} config=${configFile} poll=${pollIntervalMs}ms watches=${db.countWatches()}（编辑配置后执行 /watch-reload）`,
  )
}
