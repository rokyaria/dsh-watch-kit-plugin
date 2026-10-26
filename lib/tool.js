/** 模型侧唯一工具：watch_validate（校验并激活）。 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import { validateWatch } from './validate.js'

function renderResult(value) {
  if (value?.ok === true) {
    const lines = [
      `watch "${value.state?.id}" 已激活（rev=${value.state?.rev}, status=${value.state?.status}, INTERVAL=${value.state?.intervalSec ?? value.interval ?? '?'}s）。`,
      '样例触发帧（真实触发时长这样）：',
      value.sampleFrame ?? '(no sample)',
    ]
    if (Array.isArray(value.warnings) && value.warnings.length > 0) {
      lines.push(`warnings: ${value.warnings.join('; ')}`)
    }
    return [{ type: 'text', text: lines.join('\n') }]
  }
  const errors = Array.isArray(value?.errors) ? value.errors : []
  const lines = [`watch 校验失败（${errors.length} 项）：`]
  for (const item of errors) lines.push(`- ${item.code}: ${item.message}`)
  if (Array.isArray(value?.warnings) && value.warnings.length > 0) {
    lines.push(`warnings: ${value.warnings.join('; ')}`)
  }
  return [{ type: 'text', text: lines.join('\n') }]
}

/**
 * @param {{ctx: object, registry: object, config: object}} input
 * @returns {() => void} disposer
 */
export function registerValidateTool({ ctx, registry, config }) {
  const tool = defineTool({
    name: 'watch_validate',
    description:
      'Validate and activate a watch after writing or editing it: checks watch.conf, the check script and its runner, ' +
      'the bound session, runs the check once in dry-run mode (WATCH_DRY=1), then marks the watch active and returns a sample trigger frame.',
    parameters: {
      id: {
        type: 'string',
        required: true,
        description: 'watch id（来自 /watch-add，或 /watch-list 里的 id）',
      },
    },
    output: {
      schema: { type: 'json' },
      render(_args, value) {
        return renderResult(value)
      },
    },
    async execute(args) {
      let entry = registry.get(args.id)
      if (entry === undefined) {
        // agent 可能刚写完文件就调用；等一次轻量扫描把新目录读进内存。
        try {
          await registry.scanIfChanged()
        } catch {
          /* 扫描失败时下面会返回 unknown_watch */
        }
        entry = registry.get(args.id)
      }
      const result = await validateWatch({
        entry,
        registry,
        subprocess: ctx.subprocess,
        config,
        platform: process.platform,
        resolveExecutable: async (command) => {
          try {
            const found = await ctx.subprocess.resolveExecutable(command)
            return typeof found === 'string' ? found : null
          } catch {
            return null
          }
        },
        inspectTarget: async (sessionId) => {
          try {
            await ctx.sessionController.inspect(sessionId)
            return true
          } catch {
            return false
          }
        },
        logger: ctx.logger,
      })
      return { ...result }
    },
  })
  ctx.tools.register(tool)
  return () => {
    /* 工具注册由 ctx 作用域释放 */
  }
}
