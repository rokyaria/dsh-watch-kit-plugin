/** 插件路径解析：运行时状态与 mailbox skill 都放在用户级 $DSH_HOME 下。
 *
 * 安装形态是 profile 级（全局能力），因此状态也放用户级；workspace 不参与路径解析，
 * 避免"靠最近会话 cwd 猜目录"的漂移。显式配置的 configFile/dbFile 仍可指向任意位置；
 * 相对路径按 $DSH_HOME 解析。
 */

import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

/**
 * Expand a leading `~`/`~/`/`~\` using the OS home. Mirrors DSH's host helper.
 * @param {string} value
 * @returns {string}
 */
export function expandHomePath(value) {
  if (value === '~') return homedir()
  if (value.startsWith('~/') || value.startsWith('~\\')) return join(homedir(), value.slice(2))
  return value
}

/**
 * dshHome：显式参数 → DSH_HOME 环境变量 → ~/.dsh，最终解析成绝对路径。
 * @param {string|undefined} explicit
 * @returns {string}
 */
export function resolveDshHome(explicit) {
  const value = typeof explicit === 'string' ? explicit.trim() : ''
  const fromEnv = typeof process.env.DSH_HOME === 'string' ? process.env.DSH_HOME.trim() : ''
  return resolve(expandHomePath(value !== '' ? value : fromEnv !== '' ? fromEnv : join(homedir(), '.dsh')))
}

/**
 * 解析 watches.json 与 SQLite 路径。
 * @param {{dshHome?: string, configFile?: string, dbFile?: string}} [options]
 * @returns {{dshHome: string, configFile: string, dbFile: string}}
 */
export function resolveWatchPaths({ dshHome, configFile, dbFile } = {}) {
  const home = resolveDshHome(dshHome)
  const watchDir = join(home, 'watch')
  const resolveOne = (value, fallback) => {
    if (typeof value !== 'string' || value.trim() === '') return fallback
    const trimmed = value.trim()
    return resolve(home, expandHomePath(trimmed))
  }
  return {
    dshHome: home,
    configFile: resolve(resolveOne(configFile, join(watchDir, 'watches.json'))),
    dbFile: resolve(resolveOne(dbFile, join(watchDir, 'watch.db'))),
  }
}
