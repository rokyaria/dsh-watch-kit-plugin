/** 注册 6 条 `/watch-*` 人类命令。 */

import { fileURLToPath } from 'node:url'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { createCommandHandlers } from './command-handlers.js'

const COMMANDS = [
  {
    name: 'watch-add',
    description: '新建一个 watch（必须由用户执行；agent 会接着补全检测脚本）',
    hint: '<id> [--purpose "一句话"]',
  },
  {
    name: 'watch-list',
    description: '列出所有 watch 的状态、目标会话、最近事件与失败计数',
    hint: '',
  },
  {
    name: 'watch-pause',
    description: '暂停一个 watch（保留状态与脚本状态）',
    hint: '<id>',
  },
  {
    name: 'watch-resume',
    description: '恢复一个 watch，并立即执行一次检查',
    hint: '<id>',
  },
  {
    name: 'watch-remove',
    description: '删除一个 watch（归档到 .removed/，默认保留 7 天）',
    hint: '<id>',
  },
  {
    name: 'watch-approve',
    description: '对 agent 提出的关键修改表示"我同意"，并唤醒它继续',
    hint: '<id>',
  },
]

/**
 * @param {{ctx: object, registry: object, kernel: object, config: object}} input
 * @returns {() => void} 一次性 disposer（卸载全部命令）
 */
export function registerCommands({ ctx, registry, kernel, config }) {
  const templateDir = fileURLToPath(new URL('../assets/template/', import.meta.url))
  const handlers = createCommandHandlers({
    registry,
    kernel,
    config,
    templateDir,
    createUserMessage,
    resolveTargetAgent: async (target) => {
      try {
        const resolved = await ctx.sessionController.resolveAgent(target)
        if (resolved === undefined || resolved === null) return null
        if (resolved.error !== undefined) return null
        return resolved.agent ?? null
      } catch {
        return null
      }
    },
    platform: process.platform,
    logger: ctx.logger,
  })

  const disposers = COMMANDS.map((command) => {
    const definition = {
      name: command.name,
      description: command.description,
      handler: (invocation) => {
        switch (command.name) {
          case 'watch-add':
            return handlers.add(invocation, invocation.rawInput)
          case 'watch-list':
            return handlers.list()
          case 'watch-pause':
            return handlers.pause(invocation, invocation.rawInput)
          case 'watch-resume':
            return handlers.resume(invocation, invocation.rawInput)
          case 'watch-remove':
            return handlers.remove(invocation, invocation.rawInput)
          case 'watch-approve':
            return handlers.approve(invocation, invocation.rawInput)
          default:
            return Promise.resolve({ kind: 'error', text: `unknown command ${command.name}` })
        }
      },
    }
    // 输入提示不能为空串（dsh-commands 会拒绝）；无参数的命令不声明 input。
    if (typeof command.hint === 'string' && command.hint.trim().length > 0) {
      definition.input = { hint: command.hint }
    }
    return ctx.commands.register(definition)
  })

  return () => {
    for (const dispose of disposers) {
      try {
        dispose()
      } catch {
        /* 忽略重复释放 */
      }
    }
  }
}
