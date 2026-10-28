/**
 * mailbox 扩展 skill 的落地 / 归档（用户级口径）。
 *
 * mailbox skill 不走 ctx.skills.register（运行时条目优先级高于文件 skill，会遮蔽用户修改），
 * 由 /watch-reload 同步成文件，全部放在 $DSH_HOME（默认 ~/.dsh）下：
 *
 *   落地：<dshHome>/skills/watch-mailbox/SKILL.md
 *   归档：<dshHome>/watch/extension/skills/watch-mailbox/
 *
 * 规则：
 * - 启用（配置里存在 enabled 的 preset: mailbox）：
 *     目标已有 SKILL.md → 保留（用户可直接编辑，插件不覆盖）
 *     否则归档有副本 → 从归档恢复
 *     否则写入随包 extension/mailbox/skills/watch-mailbox/SKILL.md
 * - 停用：目标存在 → 整体移动到归档目录（同一 skill 只保留一份，覆盖旧归档）
 *
 * 随包内容更新时在 README/CHANGELOG 说明，由用户自行比对决定是否替换；
 * 插件只做"落地/归档"，不做哈希校验、不保留多份历史。
 */

import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveDshHome } from './paths.js'

/** skill 目录名（也是归档目录名）。 */
export const MAILBOX_SKILL_NAME = 'watch-mailbox'
/** skill 文件名。 */
export const MAILBOX_SKILL_FILE = 'SKILL.md'
/** 随包 mailbox skill 文件。 */
export const MAILBOX_SKILL_SOURCE = fileURLToPath(
  new URL('../extension/mailbox/skills/watch-mailbox/SKILL.md', import.meta.url),
)

/**
 * skill 目标目录与归档目录。
 * @param {{dshHome?: string}} [options]
 * @returns {{dshHome: string, targetDir: string, archiveDir: string}}
 */
export function resolveMailboxSkillPaths({ dshHome } = {}) {
  const home = resolveDshHome(dshHome)
  return {
    dshHome: home,
    targetDir: join(home, 'skills', MAILBOX_SKILL_NAME),
    archiveDir: join(home, 'watch', 'extension', 'skills', MAILBOX_SKILL_NAME),
  }
}

function hasSkillFile(dir) {
  return existsSync(join(dir, MAILBOX_SKILL_FILE))
}

/** 原子写入 SKILL.md（同目录 tmp + rename）。 */
function writeSkillFile(dir, content) {
  mkdirSync(dir, { recursive: true })
  const file = join(dir, MAILBOX_SKILL_FILE)
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
  writeFileSync(tmp, content, 'utf8')
  renameSync(tmp, file)
}

/** 目录整体移动；跨设备（EXDEV）退化为复制 + 删除。会覆盖已存在的目标。 */
function moveDir(from, to) {
  mkdirSync(dirname(to), { recursive: true })
  if (existsSync(to)) rmSync(to, { recursive: true, force: true })
  try {
    renameSync(from, to)
  } catch (error) {
    if (error === null || typeof error !== 'object' || error.code !== 'EXDEV') throw error
    cpSync(from, to, { recursive: true })
    rmSync(from, { recursive: true, force: true })
  }
}

/**
 * 按 mailbox 是否启用同步 skill 文件。
 * @param {{enabled: boolean, dshHome?: string, sourcePath?: string}} input
 * @returns {{status: 'materialized'|'restored'|'kept'|'archived'|'absent', path: string}}
 */
export function syncMailboxSkill({ enabled, dshHome, sourcePath = MAILBOX_SKILL_SOURCE } = {}) {
  const paths = resolveMailboxSkillPaths({ dshHome })

  if (enabled) {
    if (hasSkillFile(paths.targetDir)) return { status: 'kept', path: paths.targetDir }
    if (hasSkillFile(paths.archiveDir)) {
      mkdirSync(paths.targetDir, { recursive: true })
      cpSync(join(paths.archiveDir, MAILBOX_SKILL_FILE), join(paths.targetDir, MAILBOX_SKILL_FILE))
      rmSync(paths.archiveDir, { recursive: true, force: true })
      return { status: 'restored', path: paths.targetDir }
    }
    writeSkillFile(paths.targetDir, readFileSync(sourcePath, 'utf8'))
    return { status: 'materialized', path: paths.targetDir }
  }

  if (!existsSync(paths.targetDir)) return { status: 'absent', path: paths.targetDir }
  moveDir(paths.targetDir, paths.archiveDir)
  return { status: 'archived', path: paths.archiveDir }
}
