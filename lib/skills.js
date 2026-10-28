/** 随包运行时 skill：插件使用入口（watch-kit）。
 *
 * mailbox 扩展 skill 不在这里注册：运行时条目优先级高于用户 skill 目录，会遮蔽用户修改；
 * 它由 /watch-reload 落地成 <dshHome>/skills/watch-mailbox/SKILL.md（见 lib/mailbox-skill.js）。
 */

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const WATCH_KIT_SKILL = fileURLToPath(new URL('../skills/watch-kit/SKILL.md', import.meta.url))

function stripFrontmatter(text) {
  if (!text.startsWith('---')) return text
  const match = text.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/)
  return match ? text.slice(match[0].length) : text
}

function content(path) {
  return stripFrontmatter(readFileSync(path, 'utf8'))
}

/**
 * 注册 watch-kit 运行时 skill；skill 文件带 frontmatter，注册时剥离只加载正文。
 * 只注册 name/description：默认模型目录不渲染 whenToUse，触发条件写在 description 和正文里。
 * @param {{skills: {register: Function}}} ctx
 * @returns {() => void}
 */
export function registerSkills(ctx) {
  return ctx.skills.register({
    name: 'watch-kit',
    description:
      'dsh-watch-kit-plugin 使用入口：watch 配置、checker 契约、/watch-reload、watch_runs/watch_sessions，以及先读 README 的约定。',
    source: WATCH_KIT_SKILL,
    content: content(WATCH_KIT_SKILL),
  })
}

export { WATCH_KIT_SKILL }
