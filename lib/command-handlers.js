/** /watch-* 命令的参数解析与业务逻辑（可注入依赖，便于单测）。 */

import { chmod, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { platformDefaultCheck } from './conf.js'
import { fileSha256 } from './integrity.js'
import { isValidWatchId, localDayStamp, nowIso } from './ids.js'
import { appendAudit } from './logs.js'
import { defaultState } from './registry.js'

const USAGE_ADD = '用法：/watch-add <id> [--purpose "一句话说明"]'
const USAGE_ID = '用法：/watch-<pause|resume|remove|approve> <id>'

/** 解析 `/watch-add <id> [--purpose "…"]`。 */
export function parseAddArgs(rawInput = '') {
  let rest = String(rawInput ?? '').trim()
  let purpose = ''
  const match = /(?:^|\s)--purpose(?:=|\s+)(?:"([^"]*)"|'([^']*)'|(\S+))/.exec(rest)
  if (match !== null) {
    purpose = (match[1] ?? match[2] ?? match[3] ?? '').trim()
    rest = `${rest.slice(0, match.index)} ${rest.slice(match.index + match[0].length)}`.trim()
  }
  const tokens = rest.split(/\s+/).filter(Boolean)
  if (tokens.length === 0) return { ok: false, error: USAGE_ADD }
  if (tokens.length > 1) {
    return { ok: false, error: `无法识别的参数：${tokens.slice(1).join(' ')}；${USAGE_ADD}` }
  }
  const id = tokens[0]
  if (!isValidWatchId(id)) {
    return { ok: false, error: `watch id 必须匹配 ^[a-z][a-z0-9-]{1,39}$（小写字母开头，2–40 位）：${id}` }
  }
  return { ok: true, id, purpose }
}

/** 解析只接受一个 id 的命令。 */
export function parseIdArg(rawInput = '') {
  const tokens = String(rawInput ?? '').trim().split(/\s+/).filter(Boolean)
  if (tokens.length === 0) return { ok: false, error: USAGE_ID }
  if (tokens.length > 1) return { ok: false, error: `只接受一个 watch id：${tokens.join(' ')}；${USAGE_ID}` }
  if (!isValidWatchId(tokens[0])) return { ok: false, error: `watch id 不合法：${tokens[0]}；${USAGE_ID}` }
  return { ok: true, id: tokens[0] }
}

async function pathExists(path) {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

async function copyTemplateFiles(templateRoot, targetDir) {
  const entries = await readdir(templateRoot, { withFileTypes: true })
  for (const entry of entries) {
    if (!entry.isFile()) continue
    const content = await readFile(join(templateRoot, entry.name))
    await writeFile(join(targetDir, entry.name), content)
  }
}

function renderSetupCue({ id, purpose, dir, checkName }) {
  return [
    `[WATCH SETUP] 已创建 watch "${id}"（草稿，未激活；目标=当前会话；默认间隔 60s）。`,
    `用户目的：${purpose || '（未提供，请先问用户"要盯什么、多久看一次、怎么提醒"）'}`,
    '请按顺序：',
    '1) 加载 skill watch-authoring；',
    '2) 用 1–2 句话复述理解；缺关键信息时最多问 2 个问题；',
    `3) 编写 ${checkName}（exit 0 无事件 / 1 有事件 / 255 异常；去重由脚本自负），并填写 watch.conf 的 TRIGGER_MSG / INTERVAL；`,
    `4) 调用 watch_validate（{"id":"${id}"}）激活，读返回的 sampleFrame 确认被叫醒时看到什么；`,
    '5) 向用户汇报：监控什么、间隔、如何暂停（/watch-pause）。不要声称已经发生过真实触发。',
    `目录：${dir}`,
  ].join('\n')
}

function shortTarget(target) {
  if (!target) return '-'
  return target.length <= 16 ? target : `${target.slice(0, 12)}…`
}

/** /watch-list 的状态展示：中文为主、英文状态名保留在括号里（可机器检索）。 */
const STATUS_LABELS = Object.freeze({
  drafting: '草稿(drafting)',
  active: '运行中(active)',
  paused: '已暂停(paused)',
  orphaned: '会话失效(orphaned)',
  needs_validation: '待重校验(needs_validation)',
})

function statusLabel(entry) {
  const flags = []
  const raw = entry.state?.status ?? 'drafting'
  const status = STATUS_LABELS[raw] ?? raw
  const failures = entry.state?.failures ?? 0
  if (failures > 0) flags.push(`failing(${failures})`)
  if ((entry.state?.suppressedTotal ?? 0) > 0) flags.push(`suppressed(${entry.state.suppressedTotal})`)
  if (entry.runnerError) flags.push(entry.runnerError)
  if (entry.confError) flags.push('config-invalid')
  return flags.length === 0 ? status : `${status} ${flags.join(' ')}`
}

function listLine(entry) {
  const conf = entry.conf ?? {}
  const state = entry.state ?? {}
  const last = state.lastEventAt ?? state.lastErrorAt ?? 'never'
  const purpose = (conf.purpose || conf.triggerMsg || '').replace(/\s+/g, ' ').slice(0, 40) || '(no purpose)'
  return `${entry.id} | ${statusLabel(entry)} | ${conf.intervalSec ?? '?'}s | ${shortTarget(state.target)} | ${purpose} | last=${last}`
}

/**
 * 命令处理器工厂。
 * @param {{
 *   registry: object, kernel: object, config: {specDirs: string[]},
 *   templateDir: string, createUserMessage?: Function,
 *   resolveTargetAgent?: (sessionId: string) => Promise<object|null>,
 *   platform?: string, logger?: object, now?: () => number,
 * }} options
 */
export function createCommandHandlers({
  registry,
  kernel,
  config,
  templateDir,
  createUserMessage,
  resolveTargetAgent,
  platform = process.platform,
  logger = console,
  now = Date.now,
} = {}) {
  async function findEntry(id) {
    let entry = registry.get(id)
    if (entry === undefined) {
      try {
        await registry.scanIfChanged()
      } catch {
        /* 扫描失败按不存在处理 */
      }
      entry = registry.get(id)
    }
    return entry
  }

  async function audit(entry, event, sessionId, detail) {
    try {
      await appendAudit({
        logsDir: entry.logsDir ?? join(entry.dir, 'logs'),
        at: nowIso(now()),
        event,
        id: entry.id,
        sessionId,
        detail,
      })
    } catch (error) {
      logger.warn?.(`watch ${entry.id}: audit failed: ${error instanceof Error ? error.message : error}`)
    }
  }

  /** 暂停期间脚本被改过（或从未验证）时，拒绝直接 resume。 */
  async function scriptChangedSinceValidation(entry) {
    if (!entry.state.scriptHash) return false
    const checkPath = resolve(entry.dir, entry.conf.check)
    try {
      return (await fileSha256(checkPath)) !== entry.state.scriptHash
    } catch {
      return true
    }
  }

  async function followupAgent(agent, text) {
    if (agent === undefined || agent === null || typeof agent.followup !== 'function') return false
    try {
      const message =
        typeof createUserMessage === 'function'
          ? createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'cordis-host-runner' } })
          : { role: 'user', content: [{ type: 'text', text }], source: { kind: 'cordis-host-runner' } }
      agent.followup(message)
      return true
    } catch (error) {
      logger.warn?.(`watch: followup failed: ${error instanceof Error ? error.message : error}`)
      return false
    }
  }

  async function add(invocation, rawInput) {
    const parsed = parseAddArgs(rawInput)
    if (!parsed.ok) return { kind: 'error', text: parsed.error }
    const roots = config?.specDirs ?? []
    if (roots.length === 0) {
      return { kind: 'error', text: '插件未配置 specDirs；请先按 docs/install.md §2 配置 watch 根目录' }
    }
    const root = roots[0]
    const target = invocation?.agent?.id ?? invocation?.agent?.session?.header?.id ?? invocation?.agent?.session?.id
    if (!target) return { kind: 'error', text: '无法确定当前会话 id，未创建 watch' }
    const dir = join(root, parsed.id)
    if (registry.get(parsed.id) !== undefined || (await pathExists(dir))) {
      return {
        kind: 'error',
        text: `watch "${parsed.id}" 已存在（${dir}）；用 /watch-list 查看，或换一个 id`,
      }
    }
    await mkdir(dir, { recursive: true })
    const templateRoot = join(templateDir, platform === 'win32' ? 'win32' : 'posix')
    try {
      await copyTemplateFiles(templateRoot, dir)
      const checkName = platform === 'win32' ? 'check.ps1' : 'check.sh'
      const confPath = join(dir, 'watch.conf')
      let confText = await readFile(confPath, 'utf8')
      confText = confText.replace(/^PURPOSE=.*$/m, `PURPOSE=${parsed.purpose}`.trimEnd())
      confText = confText.replace(/^TARGETS=.*$/m, `TARGETS=${target}`)
      await writeFile(confPath, confText.endsWith('\n') ? confText : `${confText}\n`, 'utf8')
      if (platform !== 'win32') {
        await chmod(join(dir, checkName), 0o755)
      }
      const state = defaultState(parsed.id)
      state.status = 'drafting'
      state.target = target
      state.createdAt = nowIso(now())
      await writeFile(join(dir, 'state.json'), `${JSON.stringify(state, null, 2)}\n`, 'utf8')
      await audit({ id: parsed.id, dir, logsDir: join(dir, 'logs') }, 'create', target, parsed.purpose || undefined)
      try {
        await registry.scanIfChanged()
      } catch {
        /* 下一轮 tick 会重新扫描 */
      }
      await followupAgent(
        invocation?.agent,
        renderSetupCue({ id: parsed.id, purpose: parsed.purpose, dir, checkName }),
      )
      return {
        kind: 'success',
        text: [
          `✓ 已创建草稿 watch "${parsed.id}"（绑定当前会话，未激活）。`,
          `目录：${dir}`,
          'agent 正在补全检测脚本；完成后会调用 watch_validate 激活。',
        ].join('\n'),
      }
    } catch (error) {
      try {
        await rm(dir, { recursive: true, force: true })
      } catch {
        /* 回滚失败不掩盖原始错误 */
      }
      return { kind: 'error', text: `创建失败：${error instanceof Error ? error.message : error}` }
    }
  }

  async function list() {
    try {
      await registry.scanIfChanged()
    } catch {
      /* 用内存里的旧视图 */
    }
    const entries = registry.list()
    if (entries.length === 0) {
      return { kind: 'success', text: '当前没有 watch。用 /watch-add <id> --purpose "…" 新建。' }
    }
    const lines = ['id | 状态 | 间隔 | 目标会话 | PURPOSE | 最近事件/错误']
    for (const entry of entries) lines.push(listLine(entry))
    return { kind: 'success', text: lines.join('\n') }
  }

  async function pause(invocation, rawInput) {
    const parsed = parseIdArg(rawInput)
    if (!parsed.ok) return { kind: 'error', text: parsed.error }
    const entry = await findEntry(parsed.id)
    if (entry === undefined) return { kind: 'error', text: `没有找到 watch "${parsed.id}"；用 /watch-list 查看` }
    if (entry.state.enabled === false && entry.state.status === 'paused') {
      return { kind: 'success', text: `watch "${parsed.id}" 已经是暂停状态。` }
    }
    entry.state.enabled = false
    entry.state.status = 'paused'
    await registry.writeState(entry, entry.state)
    await audit(entry, 'pause', invocation?.agent?.id)
    return { kind: 'success', text: `已暂停 watch "${parsed.id}"（保留状态与检测脚本状态）。` }
  }

  async function resume(invocation, rawInput) {
    const parsed = parseIdArg(rawInput)
    if (!parsed.ok) return { kind: 'error', text: parsed.error }
    const entry = await findEntry(parsed.id)
    if (entry === undefined) return { kind: 'error', text: `没有找到 watch "${parsed.id}"；用 /watch-list 查看` }
    if (entry.state.status === 'drafting') {
      return { kind: 'error', text: `watch "${parsed.id}" 还是草稿，未激活；请让 agent 完成脚本后调用 watch_validate` }
    }
    if (entry.state.status === 'needs_validation') {
      return {
        kind: 'error',
        text: `watch "${parsed.id}" 的检测脚本已变化，出于安全考虑不能直接恢复；请先调用 watch_validate 校验`,
      }
    }
    if (await scriptChangedSinceValidation(entry)) {
      return {
        kind: 'error',
        text: `watch "${parsed.id}" 的检测脚本在暂停期间被修改过；请先调用 watch_validate 校验后再恢复`,
      }
    }
    entry.state.enabled = true
    entry.state.status = 'active'
    entry.state.failures = 0
    entry.state.failureReported = false
    entry.state.firstFailureAt = null
    entry.state.lastErrorTail = null
    await registry.writeState(entry, entry.state)
    registry.markDue(parsed.id, 0)
    await audit(entry, 'resume', invocation?.agent?.id)
    return { kind: 'success', text: `已恢复 watch "${parsed.id}"，下一个 tick 立即检查一次。` }
  }

  async function remove(invocation, rawInput) {
    const parsed = parseIdArg(rawInput)
    if (!parsed.ok) return { kind: 'error', text: parsed.error }
    const entry = await findEntry(parsed.id)
    if (entry === undefined) return { kind: 'error', text: `没有找到 watch "${parsed.id}"；用 /watch-list 查看` }
    if (entry.removing === true) {
      return { kind: 'error', text: `watch "${parsed.id}" 正在删除中，请稍后刷新 /watch-list` }
    }
    if (entry.inFlight === true) {
      return {
        kind: 'error',
        text: `watch "${parsed.id}" 正在执行检查（最多 TIMEOUT 秒）；请等当前检查结束后重试 /watch-remove，避免归档目录被写回`,
      }
    }
    entry.removing = true
    const archiveRoot = join(entry.root, '.removed')
    const stamp = `${localDayStamp(new Date(now()))}-${now()}`
    const archiveDir = join(archiveRoot, `${entry.id}-${stamp}`)
    try {
      await audit(entry, 'remove', invocation?.agent?.id, archiveDir)
      await mkdir(archiveRoot, { recursive: true })
      await rename(entry.dir, archiveDir)
      entry.removed = true
      registry.remove(entry.id)
      return {
        kind: 'success',
        text: `已删除 watch "${parsed.id}"，归档到 ${archiveDir}（默认保留 7 天）。`,
      }
    } catch (error) {
      entry.removing = false
      return {
        kind: 'error',
        text: `删除 watch "${parsed.id}" 失败：${error instanceof Error ? error.message : error}`,
      }
    }
  }

  async function approve(invocation, rawInput) {
    const parsed = parseIdArg(rawInput)
    if (!parsed.ok) return { kind: 'error', text: parsed.error }
    const entry = await findEntry(parsed.id)
    if (entry === undefined) return { kind: 'error', text: `没有找到 watch "${parsed.id}"；用 /watch-list 查看` }
    const sessionId = invocation?.agent?.id
    await audit(entry, 'approve', sessionId)
    let agent = null
    if (typeof resolveTargetAgent === 'function' && entry.state.target) {
      try {
        agent = await resolveTargetAgent(entry.state.target)
      } catch {
        agent = null
      }
    }
    const woke = await followupAgent(agent ?? invocation?.agent, `用户已批准你对 watch "${parsed.id}" 的变更（/watch-approve），请继续。`)
    return {
      kind: 'success',
      text: `已记录批准：watch "${parsed.id}"。${woke ? 'agent 已收到继续提示。' : '但未能唤醒目标会话，请手动在会话里说明继续。'}`,
    }
  }

  return { add, list, pause, resume, remove, approve, platformDefaultCheck }
}
