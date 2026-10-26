/** dsh-watch-kit-plugin 装配：kernel + registry + 命令 + 工具 + skill。 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { registerCommands } from './commands.js'
import { Config } from './config.js'
import { runCheck } from './exec.js'
import { Kernel } from './kernel.js'
import { WatchRegistry } from './registry.js'
import { registerValidateTool } from './tool.js'

export const name = 'watch'
export const inject = ['commands', 'tools', 'skills', 'sessionController', 'subprocess', 'timer']
export { Config }

const SKILL_NAME = 'watch-authoring'
const SKILL_DESCRIPTION =
  'How to author and maintain dsh-watch-kit-plugin watches: check-program contract (exit codes, WATCH_* env, JSON events), ' +
  'TRIGGER_MSG, platform/interpreter rules, local testing, and when to ask the user to /watch-approve.'

/**
 * 注册 watch-authoring 运行时 skill。
 *
 * 宿主 skills.register() 只给 provider/invocation 补默认值；加载 skill 时还会校验
 * source/content 必须是字符串（实测：漏传 source 会在调用 skill 工具时报
 * "loaded skill ... source must be a string"）。因此这里显式给出 SKILL.md 的真实路径。
 */
export function registerAuthoringSkill(ctx) {
  const skillPath = fileURLToPath(new URL('../skills/watch-authoring/SKILL.md', import.meta.url))
  const content = readFileSync(skillPath, 'utf8')
  const dispose = ctx.skills.register({
    name: SKILL_NAME,
    description: SKILL_DESCRIPTION,
    whenToUse: '在 /watch-add 之后补全 watch，或修改已有 watch 的检测脚本/提醒内容时。',
    source: skillPath,
    content,
  })
  return () => {
    try {
      dispose()
    } catch {
      /* 已释放 */
    }
  }
}

/** 把触发帧投递到目标会话。 */
function createDeliver(ctx) {
  return async function deliver({ target, frame }) {
    let resolved
    try {
      resolved = await ctx.sessionController.resolveAgent(target)
    } catch (error) {
      return { error }
    }
    if (resolved === undefined || resolved === null) return { error: new Error(`session ${target} unavailable`) }
    if (resolved.error !== undefined) return { error: resolved.error }
    const agent = resolved.agent ?? resolved
    if (agent === undefined || agent === null || typeof agent.followup !== 'function') {
      return { error: new Error(`session ${target} has no agent`) }
    }
    agent.followup(
      createUserMessage({
        content: [{ type: 'text', text: frame }],
        source: { kind: 'cordis-host-runner' },
      }),
    )
    return { ok: true }
  }
}

/**
 * @param {object} ctx Cordis Host context
 * @param {object} config 插件配置（schemastery 已校验）
 */
export function apply(ctx, config) {
  const specDirs = Array.isArray(config?.specDirs) ? config.specDirs.filter(Boolean) : []
  if (specDirs.length === 0) {
    ctx.logger.warn('watch: specDirs 为空，插件不轮询任何目录（见 docs/install.md §2）')
    return
  }

  const registry = new WatchRegistry({ dirs: specDirs, platform: process.platform, logger: ctx.logger })
  const resolveExecutable = async (command) => {
    try {
      const found = await ctx.subprocess.resolveExecutable(command)
      return typeof found === 'string' ? found : null
    } catch {
      return null
    }
  }
  const kernel = new Kernel({
    registry,
    config,
    logger: ctx.logger,
    platform: process.platform,
    resolveExecutable,
    runCheck: (args) => runCheck({ subprocess: ctx.subprocess, ...args }),
    deliver: createDeliver(ctx),
    retryDelayMs: config.deliveryRetryMs ?? 30000,
  })

  ctx.effect(() => () => kernel.dispose(), 'watch.kernel')
  ctx.effect(() => () => registry.dispose(), 'watch.registry')
  ctx.effect(() => {
    const dispose = ctx.interval(() => {
      void kernel.tick()
    }, config.tickMs ?? 1000)
    return () => {
      try {
        dispose()
      } catch {
        /* 已释放 */
      }
    }
  }, 'watch.tick')
  ctx.effect(() => {
    void kernel.start().catch((error) => {
      ctx.logger.error?.(`watch: start failed: ${error instanceof Error ? error.stack ?? error.message : error}`)
    })
    return () => kernel.dispose()
  }, 'watch.start')
  // 注册类副作用逐个兜底：任一宿主 API 形态不匹配时只损失该能力，
  // 不让整个插件行 FAILED（否则连 /watch-list 都没有入口可诊断）。
  const registerSafely = (label, fn) => {
    try {
      return fn()
    } catch (error) {
      ctx.logger.error?.(`watch: ${label} failed: ${error instanceof Error ? error.stack ?? error.message : error}`)
      return () => {}
    }
  }
  ctx.effect(() => registerSafely('commands', () => registerCommands({ ctx, registry, kernel, config })), 'watch.commands')
  ctx.effect(() => registerSafely('tool', () => registerValidateTool({ ctx, registry, config })), 'watch.tool')
  ctx.effect(() => registerSafely('skill', () => registerAuthoringSkill(ctx)), 'watch.skill')
}
