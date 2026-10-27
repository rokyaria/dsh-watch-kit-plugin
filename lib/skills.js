/** 随包运行时 skill：插件自我介绍 + mailbox 工作流。 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const WATCH_KIT_SKILL = fileURLToPath(new URL('../skills/watch-kit/SKILL.md', import.meta.url))
const MAILBOX_SKILL = fileURLToPath(new URL('../extension/mailbox/skills/watch-mailbox/SKILL.md', import.meta.url))
const README = fileURLToPath(new URL('../README.md', import.meta.url))
const MAILBOX_SCRIPT = fileURLToPath(new URL('../extension/mailbox/mail.py', import.meta.url))
const MAILBOX_README = fileURLToPath(new URL('../extension/mailbox/README.md', import.meta.url))

function content(path, replacements = {}) {
  let text = readFileSync(path, 'utf8')
  for (const [key, value] of Object.entries(replacements)) {
    text = text.replaceAll(`{{${key}}}`, value)
  }
  return text
}

/**
 * 注册两个运行时 skill；skill 文件随包，content 中的路径在 apply 时替换成本机绝对路径。
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
      whenToUse:
        '用户提到 dsh-watch-kit-plugin、watch 插件、巡检、定时检查、checker、/watch-reload、watch_runs、watch_sessions，或询问本插件怎么配置/怎么用时。',
      source: WATCH_KIT_SKILL,
      content: content(WATCH_KIT_SKILL, { README_PATH: README }),
    }),
  )
  disposers.push(
    ctx.skills.register({
      name: 'watch-mailbox',
      description:
        '处理 dsh-watch-kit-plugin mailbox checker 的来信：read → reply/mark、身份行为、附件与来源验证的严格默认策略。',
      whenToUse:
        '收到 [MAILBOX] 通知、用户让你查看/回复邮箱、处理待回邮件，或提到 watch-mailbox / mailbox checker 时。',
      source: MAILBOX_SKILL,
      content: content(MAILBOX_SKILL, {
        MAILBOX_SCRIPT,
        MAILBOX_README,
      }),
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
