/** dsh-watch-kit-plugin 装配：SQLite + 10s 轮询 + /watch-reload + 两个工具。 */

import { mkdirSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { registerCommands } from './commands.js'
import { Config } from './config.js'
import { WatchDB } from './db.js'
import { Poller } from './poller.js'
import { registerSkills } from './skills.js'
import { registerTools } from './tools.js'

export const name = 'watch'
export const inject = ['commands', 'tools', 'skills', 'sessionController', 'subprocess', 'timer', 'workingDirectory']

export { Config }

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

function fallbackWorkspace(ctx) {
  try {
    const dir = ctx.workingDirectory?.defaultDirectory
    if (typeof dir === 'string' && dir !== '') return dir
  } catch {
    /* 回退 */
  }
  return process.cwd()
}

/** 默认 workspace：最近一个可见会话的 cwd；拿不到时退回 workingDirectory/process.cwd。 */
async function workspaceOf(ctx) {
  try {
    const value = await ctx.sessionController.list({}, AbortSignal.timeout(3000))
    const items = Array.isArray(value?.items) ? value.items : []
    const candidate = items.find(
      (item) => typeof item?.cwd === 'string' && item.cwd !== '' && item.blank !== true && item.origin !== 'subagent',
    )
    if (candidate !== undefined) return candidate.cwd
  } catch {
    /* 会话列表不可用时回退 */
  }
  return fallbackWorkspace(ctx)
}

function resolvePath(value, workspace, fallback) {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (trimmed !== '') return isAbsolute(trimmed) ? trimmed : resolve(workspace, trimmed)
  }
  return join(workspace, fallback)
}

/**
 * @param {object} ctx Cordis Host context
 * @param {object} config 插件配置（schemastery 已校验）
 */
export async function apply(ctx, config = {}) {
  const explicitPaths =
    typeof config.configFile === 'string' && config.configFile.trim() !== '' &&
    typeof config.dbFile === 'string' && config.dbFile.trim() !== ''
  const workspace = explicitPaths ? fallbackWorkspace(ctx) : await workspaceOf(ctx)
  const configFile = resolvePath(config.configFile, workspace, '.dsh/watch/watches.json')
  const dbFile = resolvePath(config.dbFile, workspace, '.dsh/watch/watch.db')
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
    checkerLimits: limits.checker,
    messageLimits: limits.message,
    retentionMs,
  })

  try {
    ctx.effect(
      () => registerCommands({ ctx, db, poller, configFile, configDir, retentionMs }),
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
