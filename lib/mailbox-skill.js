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
 *     目标不存在且归档存在 → 整体恢复归档目录（不只看 SKILL.md）
 *     目标存在但缺 SKILL.md 且归档存在 → 把归档内容补进目标，再移除归档
 *     目标已有 SKILL.md → 保留（用户可直接编辑，插件不覆盖）
 *     否则写入随包 extension/mailbox/skills/watch-mailbox/SKILL.md
 * - 停用：目标存在 → 整体移动到归档目录；若目标缺 SKILL.md 且已有归档，
 *   只把目标额外文件合并进归档，避免用空目录覆盖最后一份 SKILL.md。
 *
 * 随包内容更新时在 README/CHANGELOG 说明，由用户自行比对决定是否替换；
 * 插件只做"落地/归档"，不做哈希校验、不保留多份历史。
 */

import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
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

/** stat 失败（竞态/权限）按“目标不可用”处理，交给调用方跳过。 */
function isDirectory(path) {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/**
 * 把 from 目录的内容**递归合并**进 to：目录逐层下钻，文件默认不覆盖（overwrite=true 才覆盖）。
 *
 * 注意：遇到目标已存在的同名目录时不能整体跳过——调用方在恢复/归档成功后会
 * `rmSync(from)` 删除源目录，跳过会让源目录里尚未合并的文件永久丢失（P1 数据丢失）。
 */
function copyDirContents(from, to, { overwrite = false } = {}) {
  mkdirSync(to, { recursive: true })
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    const source = join(from, entry.name)
    const target = join(to, entry.name)
    if (entry.isDirectory()) {
      if (!existsSync(target)) {
        cpSync(source, target, { recursive: true })
        continue
      }
      // 目标同名目录：递归合并；同名文件挡住目录（无法合并也按不覆盖语义跳过）。
      if (isDirectory(target)) copyDirContents(source, target, { overwrite })
      continue
    }
    if (!overwrite && existsSync(target)) continue
    cpSync(source, target, { recursive: true, force: true })
  }
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
    if (!existsSync(paths.targetDir)) {
      if (existsSync(paths.archiveDir)) {
        moveDir(paths.archiveDir, paths.targetDir)
        return { status: 'restored', path: paths.targetDir }
      }
      writeSkillFile(paths.targetDir, readFileSync(sourcePath, 'utf8'))
      return { status: 'materialized', path: paths.targetDir }
    }
    if (hasSkillFile(paths.targetDir)) return { status: 'kept', path: paths.targetDir }
    if (existsSync(paths.archiveDir)) {
      copyDirContents(paths.archiveDir, paths.targetDir)
      rmSync(paths.archiveDir, { recursive: true, force: true })
      return { status: 'restored', path: paths.targetDir }
    }
    writeSkillFile(paths.targetDir, readFileSync(sourcePath, 'utf8'))
    return { status: 'materialized', path: paths.targetDir }
  }

  if (!existsSync(paths.targetDir)) return { status: 'absent', path: paths.targetDir }
  if (!hasSkillFile(paths.targetDir) && existsSync(paths.archiveDir)) {
    // Do not let an empty/partial target overwrite the last archived SKILL.md.
    copyDirContents(paths.targetDir, paths.archiveDir)
    rmSync(paths.targetDir, { recursive: true, force: true })
    return { status: 'archived', path: paths.archiveDir }
  }
  moveDir(paths.targetDir, paths.archiveDir)
  return { status: 'archived', path: paths.archiveDir }
}
