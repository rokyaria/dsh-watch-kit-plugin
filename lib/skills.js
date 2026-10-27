/** 随包运行时 skill：插件自我介绍 + mailbox 工作流。 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const WATCH_KIT_SKILL = fileURLToPath(new URL('../skills/watch-kit/SKILL.md', import.meta.url))
const MAILBOX_SKILL = fileURLToPath(new URL('../extension/mailbox/skills/watch-mailbox/SKILL.md', import.meta.url))

function stripFrontmatter(text) {
  if (!text.startsWith('---')) return text
  const match = text.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/)
  return match ? text.slice(match[0].length) : text
}

function content(path) {
  return stripFrontmatter(readFileSync(path, 'utf8'))
}

/**
 * 注册两个运行时 skill；skill 文件带 frontmatter，注册时剥离 frontmatter 只加载正文。
 * 只注册 name/description：默认模型目录不渲染 whenToUse，触发条件写在 description 和正文里。
 * @param {{skills: {register: Function}}} ctx
 * @returns {() => void}
 */
export function registerSkills(ctx) {
  const disposers = []
  disposers.push(
    ctx.skills.register({
      name: 'watch-kit',
      description:
        'dsh-watch-kit-plugin 使用入口：watch 配置、checker 契约、/watch-reload、watch_runs/watch_sessions，以及先读 README 的约定。',
      source: WATCH_KIT_SKILL,
      content: content(WATCH_KIT_SKILL),
    }),
  )
  disposers.push(
    ctx.skills.register({
      name: 'watch-mailbox',
      description:
        '处理 dsh-watch-kit-plugin mailbox checker 的来信：收到 [MAILBOX] 通知、查看/回复邮箱时，按 read → reply/mark、身份行为、附件与来源验证的严格默认策略执行。',
      source: MAILBOX_SKILL,
      content: content(MAILBOX_SKILL),
    }),
  )
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

export { WATCH_KIT_SKILL, MAILBOX_SKILL }
