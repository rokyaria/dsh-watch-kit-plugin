/** watch_validate 的核心逻辑：校验配置/运行器/目标会话，干跑一次并激活。 */

import { access, constants, mkdir, stat } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { parseWatchConf, validateWatchConf } from './conf.js'
import { runCheck, watchEnv } from './exec.js'
import { parseEventOutput } from './event.js'
import { renderEventFrame } from './frame.js'
import { fileSha256, scriptFingerprint } from './integrity.js'
import { localDayStamp, nowIso } from './ids.js'
import { resolveRunner } from './runner.js'

function error(code, message) {
  return { code, message }
}

async function fileExists(path) {
  try {
    const info = await stat(path)
    return info.isFile()
  } catch {
    return false
  }
}

async function canExecute(path) {
  try {
    await access(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/**
 * 校验并激活一个 watch。
 *
 * @param {{
 *   entry: object,
 *   registry: {writeState: Function, markDue: Function},
 *   subprocess: object,
 *   config?: object,
 *   platform?: string,
 *   now?: () => number,
 *   resolveExecutable?: (command: string) => Promise<string|null>,
 *   inspectTarget?: (sessionId: string) => Promise<boolean>,
 *   logger?: object,
 * }} input
 * @returns {Promise<{ok: boolean, errors: Array<{code:string,message:string}>,
 *   state?: object, sampleFrame?: string, warnings?: string[]}>}
 */
export async function validateWatch({
  entry,
  registry,
  subprocess,
  config = {},
  platform = process.platform,
  now = Date.now,
  resolveExecutable = async () => null,
  inspectTarget = async () => true,
  logger = console,
} = {}) {
  if (entry === undefined || entry === null) {
    return { ok: false, errors: [error('unknown_watch', '没有找到这个 watch；用 /watch-list 查看已有 watch')] }
  }

  const { values, warnings } =
    entry.values !== undefined && entry.values !== null
      ? { values: entry.values, warnings: entry.warnings ?? [] }
      : parseWatchConf(entry.confText ?? '', { path: entry.confPath ?? 'watch.conf' })
  const validated = validateWatchConf(values, { id: entry.id, platform })
  const errors = [...validated.errors]
  const conf = validated.conf

  const checkPath = resolve(entry.dir, conf.check)
  const relativeCheck = relative(entry.dir, checkPath)
  if (relativeCheck === '' || relativeCheck.startsWith('..') || isAbsolute(relativeCheck)) {
    errors.push(error('bad_check_path', `CHECK 必须位于 watch 目录内：${conf.check}`))
  } else if (!(await fileExists(checkPath))) {
    errors.push(error('check_missing', `检测脚本不存在：${conf.check}`))
  }

  let argv = null
  if (errors.length === 0) {
    argv = await resolveRunner({
      platform,
      checkPath,
      runner: conf.runner,
      isExecutable: canExecute,
      resolveExecutable,
    })
    if (argv === null) {
      errors.push(
        error(
          'runner_not_found',
          `找不到运行 ${conf.check} 所需的解释器（RUNNER=${conf.runner}）；请安装 bash/pwsh/python，或改用 RUNNER=direct`,
        ),
      )
    }
  }

  if (errors.length === 0) {
    for (const target of conf.targets) {
      const known = await inspectTarget(target)
      if (!known) {
        errors.push(error('unknown_target', `目标会话不存在或不可用：${target}；请确认绑定会话`))
      }
    }
  }

  if (errors.length === 0) {
    const at = now()
    await mkdir(entry.dataDir ?? join(entry.dir, 'data'), { recursive: true })
    await mkdir(entry.logsDir ?? join(entry.dir, 'logs'), { recursive: true })
    const result = await runCheck({
      subprocess,
      watchDir: entry.dir,
      argv,
      timeoutMs: conf.timeoutSec * 1000,
      env: watchEnv({
        id: entry.id,
        watchDir: entry.dir,
        dataDir: entry.dataDir ?? join(entry.dir, 'data'),
        logsDir: entry.logsDir ?? join(entry.dir, 'logs'),
        intervalSec: conf.intervalSec,
        dryRun: true,
      }),
      maxStdoutBytes: config.maxEvidenceBytes ?? 8192,
      stderrTailLines: config.maxStderrLines ?? 20,
      now,
    })

    if (result.spawnError) {
      errors.push(error('dry_run_spawn_error', `干跑无法启动：${result.spawnError}`))
    } else if (result.timedOut) {
      errors.push(error('dry_run_timeout', `干跑超过 TIMEOUT=${conf.timeoutSec}s；先在本地手动运行脚本`))
    } else if (result.code !== 0 && result.code !== 1 && result.code !== 255) {
      errors.push(
        error(
          'bad_exit_code',
          `干跑退出码为 ${result.code ?? 'null'}（或信号 ${result.signal ?? 'unknown'}）；只接受 0/1/255`,
        ),
      )
    } else if (result.code === 1) {
      const parsed = parseEventOutput({
        code: 1,
        stdout: result.stdout,
        lossy: result.stdoutLossy === true,
      })
      if (parsed.kind === 'invalid') {
        errors.push(
          error(
            'dry_run_event_invalid',
            `退出码 1 的 JSON 事件载荷非法（${parsed.reason}）；JSON 必须是完整 UTF-8 对象，message 1–2048 字节`,
          ),
        )
      }
    }
  }

  if (errors.length > 0) {
    logger.warn?.(`watch ${entry.id}: validate failed: ${errors.map((item) => item.code).join(', ')}`)
    return { ok: false, errors, warnings }
  }

  let scriptHash
  try {
    scriptHash = await fileSha256(checkPath)
  } catch (error) {
    return {
      ok: false,
      errors: [error('script_hash_failed', `无法计算检测脚本哈希：${error instanceof Error ? error.message : error}`)],
      warnings,
    }
  }

  const state = entry.state
  state.status = state.status === 'paused' ? 'paused' : 'active'
  state.enabled = true
  state.target = conf.targets[0] ?? state.target ?? null
  state.rev = (state.rev ?? 0) + 1
  state.failures = 0
  state.failureReported = false
  state.firstFailureAt = null
  state.lastErrorTail = null
  state.scriptPath = checkPath
  state.scriptHash = scriptHash
  state.scriptChangedAt = null
  state.scriptNotifyAt = null
  state.scriptPendingHash = null
  state.scriptNotifiedHash = null
  state.scriptChangeReason = null
  state.validatedAt = nowIso(now())
  state.createdAt ??= state.validatedAt
  await registry.writeState(entry, state)
  registry.markDue(entry.id, 0)
  entry.conf = conf
  entry.runnerArgv = argv
  entry.runnerError = null
  entry.configError = null
  entry.scriptFingerprint = await scriptFingerprint(checkPath)

  const sampleFrame = renderEventFrame(
    {
      id: entry.id,
      at: nowIso(now()),
      rev: state.rev,
      messageSource: 'config',
      message: conf.triggerMsg || conf.purpose || '（未设置 TRIGGER_MSG/PURPOSE）',
      evidence: '（样例证据；真实触发时来自检测程序输出）',
      logPath: join(entry.logsDir ?? join(entry.dir, 'logs'), `${localDayStamp(new Date(now()))}.log`),
    },
    { maxEvidenceBytes: config.maxEvidenceBytes ?? 8192 },
  )

  return { ok: true, errors: [], state, sampleFrame, warnings }
}
