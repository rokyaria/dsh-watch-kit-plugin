/** 检测程序执行：把 argv 交给宿主的 ctx.subprocess，处理超时、输出收集与截断。 */

import { tailLines } from './text.js'

/** 构造检测程序的 WATCH_* 环境（宿主 subprocess 会自行合并净化后的父环境）。 */
export function watchEnv({ id, watchDir, dataDir, logsDir, intervalSec, dryRun = false }) {
  const env = {
    WATCH_ID: id,
    WATCH_DIR: watchDir,
    WATCH_STATE: dataDir,
    WATCH_LOGS: logsDir,
    WATCH_INTERVAL: String(intervalSec),
  }
  if (dryRun) env.WATCH_DRY = '1'
  return env
}

/**
 * 运行一次检测程序。
 *
 * @param {{subprocess: {spawn: Function}, watchDir: string, argv: string[],
 *          timeoutMs: number, env: Record<string,string>,
 *          maxStdoutBytes?: number, maxStderrBytes?: number, graceMs?: number,
 *          now?: () => number}} input
 * @returns {Promise<{code: number|null, signal: string|null, timedOut: boolean,
 *          durationMs: number, stdout: string, stdoutLossy: boolean,
 *          stderrTail: string, spawnError?: string}>}
 */
export async function runCheck({
  subprocess,
  watchDir,
  argv,
  timeoutMs,
  env,
  maxStdoutBytes = 64 * 1024,
  maxStderrBytes = 64 * 1024,
  graceMs = 2000,
  stderrTailLines = 20,
  now = Date.now,
}) {
  const startedAt = now()
  let handle
  try {
    handle = subprocess.spawn({
      argv,
      cwd: watchDir,
      graceMs,
      stdio: {
        stdin: 'ignore',
        stdout: { maxBytes: maxStdoutBytes, spill: { maxBytes: 256 * 1024 } },
        stderr: { maxBytes: maxStderrBytes, spill: { maxBytes: 256 * 1024 } },
      },
      env,
    })
  } catch (error) {
    return {
      code: null,
      signal: null,
      timedOut: false,
      durationMs: 0,
      stdout: '',
      stdoutLossy: false,
      stderrTail: '',
      spawnError: error instanceof Error ? error.message : String(error),
    }
  }

  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    try {
      handle.terminate()
    } catch {
      /* 已退出或实现不支持 */
    }
  }, Math.max(1, Number(timeoutMs) || 1))
  timer.unref?.()

  let outcome = null
  let doneError
  try {
    outcome = await handle.done
  } catch (error) {
    doneError = error
  }
  clearTimeout(timer)

  let stdout = ''
  let stdoutLossy = false
  let stderrText = ''
  try {
    const read = handle.collected?.stdout?.readFrom?.(0)
    if (read) {
      stdout = typeof read.text === 'string' ? read.text : ''
      stdoutLossy = read.lossy === true
    }
  } catch {
    /* 读取失败视为空输出 */
  }
  try {
    const read = handle.collected?.stderr?.readFrom?.(0)
    if (read) stderrText = typeof read.text === 'string' ? read.text : ''
  } catch {
    /* 忽略 */
  }

  return {
    code: outcome?.exitCode ?? null,
    signal: outcome?.signal ?? null,
    timedOut,
    durationMs: now() - startedAt,
    stdout,
    stdoutLossy,
    stderrTail: tailLines(stderrText, stderrTailLines),
    ...(doneError === undefined
      ? {}
      : { spawnError: doneError instanceof Error ? doneError.message : String(doneError) }),
  }
}
