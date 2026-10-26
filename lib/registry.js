/** watch 注册表：扫描 specDirs、读取 watch.conf / state.json、热重载、原子写状态。 */

import { mkdir, readdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { normalizeConf, parseWatchConf } from './conf.js'
import { nowIso } from './ids.js'

/** 新建 watch 的初始状态。 */
export function defaultState(id) {
  return {
    schemaVersion: 1,
    id,
    status: 'drafting',
    enabled: true,
    target: null,
    rev: 0,
    failures: 0,
    failureReported: false,
    firstFailureAt: null,
    lastRunAt: null,
    lastExit: null,
    lastDurationMs: null,
    lastErrorAt: null,
    lastErrorTail: null,
    lastEventAt: null,
    lastTriggerAt: null,
    triggerCount: 0,
    suppressedTotal: 0,
    scriptPath: null,
    scriptHash: null,
    scriptChangedAt: null,
    scriptNotifyAt: null,
    scriptPendingHash: null,
    scriptNotifiedHash: null,
    scriptChangeReason: null,
    createdAt: null,
    validatedAt: null,
  }
}

function mergeState(id, stored) {
  const state = { ...defaultState(id), ...(stored ?? {}) }
  state.id = id
  return state
}

export class WatchRegistry {
  /**
   * @param {{dirs: string[], platform?: string, logger?: Console|object}} options
   */
  constructor({ dirs, platform = process.platform, logger = console } = {}) {
    this.dirs = (dirs ?? []).filter((dir) => typeof dir === 'string' && dir.length > 0)
    this.platform = platform
    this.logger = logger
    this.entries = new Map()
    this.duplicates = new Map()
    this.warnedMissing = new Set()
  }

  /** 全部可用 watch（不含重复 id、不含扫描失败的目录）。 */
  list() {
    return [...this.entries.values()]
  }

  /** 按 id 取 watch。 */
  get(id) {
    return this.entries.get(id)
  }

  /** 全量扫描（启动时）。 */
  async scan() {
    const seen = new Set()
    for (const root of this.dirs) {
      let dirEntries
      try {
        dirEntries = await readdir(root, { withFileTypes: true })
      } catch (error) {
        if (!this.warnedMissing.has(root)) {
          this.warnedMissing.add(root)
          this.logger.warn?.(`watch: cannot read specDir ${root}: ${error instanceof Error ? error.message : error}`)
        }
        continue
      }
      for (const dirEntry of dirEntries) {
        if (!dirEntry.isDirectory() || dirEntry.name.startsWith('.')) continue
        const dir = join(root, dirEntry.name)
        seen.add(dir)
        if (this.findById(dir) !== undefined) continue
        const entry = await this.loadEntry(root, dirEntry.name, dir)
        if (entry !== undefined) this.entries.set(entry.id, entry)
      }
    }
    for (const [id, entry] of [...this.entries.entries()]) {
      if (!seen.has(entry.dir)) this.entries.delete(id)
    }
    return this.list()
  }

  findById(dir) {
    for (const entry of this.entries.values()) if (entry.dir === dir) return entry
    return undefined
  }

  async loadEntry(root, id, dir) {
    const confPath = join(dir, 'watch.conf')
    let confText
    try {
      confText = await readFile(confPath, 'utf8')
    } catch {
      return undefined // 不是 watch 目录
    }
    let confStat
    try {
      confStat = await stat(confPath)
    } catch {
      return undefined
    }
    const { values, warnings } = parseWatchConf(confText, { path: confPath })
    const conf = normalizeConf(values, { platform: this.platform })
    const state = mergeState(id, await this.readStateFile(dir))
    const target = conf.targets[0] ?? state.target ?? null
    state.target = target
    const previous = this.entries.get(id)
    const duplicate = this.duplicates.get(id)
    if (previous !== undefined && previous.dir !== dir) {
      this.logger.warn?.(`watch: duplicate id "${id}" in ${dir}; keeping ${previous.dir}`)
      this.duplicates.set(id, dir)
      return undefined
    }
    if (duplicate !== undefined) {
      this.logger.warn?.(`watch: duplicate id "${id}" ignored at ${dir}`)
      return undefined
    }
    return {
      id,
      root,
      dir,
      confPath,
      confText,
      values,
      warnings,
      confMtimeMs: confStat.mtimeMs,
      confSize: confStat.size,
      conf,
      confError: null,
      state,
      inFlight: false,
      nextDueAt: previous?.nextDueAt ?? 0,
      runnerArgv: previous?.runnerArgv ?? null,
      runnerError: previous?.runnerError ?? null,
      noticeAttempts: 0,
      noticeRetryAt: undefined,
      dataDir: join(dir, 'data'),
      logsDir: join(dir, 'logs'),
    }
  }

  async readStateFile(dir) {
    try {
      const raw = await readFile(join(dir, 'state.json'), 'utf8')
      const parsed = JSON.parse(raw)
      return parsed !== null && typeof parsed === 'object' ? parsed : undefined
    } catch {
      return undefined
    }
  }

  /** 原子写状态（tmp + rename）。 */
  async writeState(entry, state) {
    const file = join(entry.dir, 'state.json')
    const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
    entry.state = state
    await mkdir(dirname(file), { recursive: true })
    await writeFile(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
    await rename(tmp, file)
  }

  /** 让某个 watch 立即参与下一次调度（激活/恢复时）。 */
  markDue(id, at = 0) {
    const entry = this.entries.get(id)
    if (entry !== undefined) entry.nextDueAt = at
  }

  /** 从内存移除（删除/归档后）。 */
  remove(id) {
    this.entries.delete(id)
    this.duplicates.delete(id)
  }

  /** 轻量刷新：新增/删除目录、watch.conf 内容变化时更新内存配置。 */
  async scanIfChanged() {
    const seenDirs = new Set()
    for (const root of this.dirs) {
      let dirEntries
      try {
        dirEntries = await readdir(root, { withFileTypes: true })
      } catch {
        continue
      }
      for (const dirEntry of dirEntries) {
        if (!dirEntry.isDirectory() || dirEntry.name.startsWith('.')) continue
        const dir = join(root, dirEntry.name)
        seenDirs.add(dir)
        const existing = this.findById(dir)
        if (existing === undefined) {
          const entry = await this.loadEntry(root, dirEntry.name, dir)
          if (entry !== undefined) this.entries.set(entry.id, entry)
          continue
        }
        let confStat
        try {
          confStat = await stat(existing.confPath)
        } catch {
          continue
        }
        if (confStat.mtimeMs !== existing.confMtimeMs || confStat.size !== existing.confSize) {
          await this.reloadConf(existing)
        }
      }
    }
    for (const [id, entry] of [...this.entries.entries()]) {
      if (!seenDirs.has(entry.dir)) this.entries.delete(id)
    }
  }

  /** 重新读取单个 watch 的 watch.conf，保留运行时字段。 */
  async reloadConf(entry) {
    try {
      const confText = await readFile(entry.confPath, 'utf8')
      const confStat = await stat(entry.confPath)
      const { values, warnings } = parseWatchConf(confText, { path: entry.confPath })
      entry.confText = confText
      entry.values = values
      entry.warnings = warnings
      entry.conf = normalizeConf(values, { platform: this.platform })
      entry.confMtimeMs = confStat.mtimeMs
      entry.confSize = confStat.size
      entry.confError = null
      entry.runnerArgv = null
      entry.runnerError = null
      entry.state.target = entry.conf.targets[0] ?? entry.state.target ?? null
    } catch (error) {
      entry.confError = error instanceof Error ? error.message : String(error)
    }
  }

  /** 记录一次外部错误（供 /watch-list 展示）。 */
  async markOrphaned(entry) {
    if (entry.state.status === 'orphaned') return entry.state
    entry.state.status = 'orphaned'
    entry.state.lastErrorAt = nowIso()
    await this.writeState(entry, entry.state)
    return entry.state
  }

  dispose() {
    this.entries.clear()
    this.duplicates.clear()
  }
}
