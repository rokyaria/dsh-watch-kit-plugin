/** 执行 checker 并把 stdout 解析成 {notify,message,error}。 */

export const MAX_STDOUT_BYTES = 65536
export const MAX_STDERR_BYTES = 8192
export const MAX_MESSAGE_BYTES = 8192
export const MAX_ERROR_BYTES = 2048

function positive(value, fallback) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? number : fallback
}

function resolveLimits(limits = {}) {
  return {
    maxStdoutBytes: positive(limits.maxStdoutBytes, MAX_STDOUT_BYTES),
    maxStderrBytes: positive(limits.maxStderrBytes, MAX_STDERR_BYTES),
    maxMessageBytes: positive(limits.maxMessageBytes, MAX_MESSAGE_BYTES),
    maxErrorBytes: positive(limits.maxErrorBytes, MAX_ERROR_BYTES),
  }
}

function utf8Bytes(text) {
  return Buffer.byteLength(String(text ?? ''), 'utf8')
}

function invalid(status, stderr = '') {
  return { status, notify: false, message: null, error: null, stderr }
}

/**
 * 只认 stdout 的合法 JSON 对象。
 * @returns {{status:'ok', notify:boolean, message:string|null, error:string|null} |
 *          {status:'invalid_json'|'invalid_fields', notify:false, message:null, error:null}}
 */
export function parseCheckerOutput({ stdout = '', lossy = false, limits = {} } = {}) {
  const caps = resolveLimits(limits)
  if (lossy === true) return invalid('invalid_json')
  if (utf8Bytes(stdout) > caps.maxStdoutBytes) return invalid('invalid_json')

  const text = String(stdout ?? '').trim()
  if (text === '') return invalid('invalid_json')
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch {
    return invalid('invalid_json')
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return invalid('invalid_json')
  if (typeof parsed.notify !== 'boolean') return invalid('invalid_fields')

  const rawMessage = parsed.message === undefined || parsed.message === null ? null : parsed.message
  const rawError = parsed.error === undefined || parsed.error === null ? null : parsed.error
  if (rawMessage !== null && typeof rawMessage !== 'string') return invalid('invalid_fields')
  if (rawError !== null && typeof rawError !== 'string') return invalid('invalid_fields')
  if (rawMessage !== null && utf8Bytes(rawMessage) > caps.maxMessageBytes) return invalid('invalid_fields')
  if (rawError !== null && utf8Bytes(rawError) > caps.maxErrorBytes) return invalid('invalid_fields')
  if (parsed.notify === true && (rawMessage === null || rawMessage.trim() === '')) {
    return invalid('invalid_fields')
  }

  return { status: 'ok', notify: parsed.notify, message: rawMessage, error: rawError }
}

function readCollected(handle) {
  const out = { stdout: '', lossy: false, stderr: '' }
  try {
    const read = handle.collected?.stdout?.readFrom?.(0)
    if (read) {
      out.stdout = typeof read.text === 'string' ? read.text : ''
      out.lossy = read.lossy === true
    }
  } catch {
    /* 读取失败按空输出处理 */
  }
  try {
    const read = handle.collected?.stderr?.readFrom?.(0)
    if (read) out.stderr = typeof read.text === 'string' ? read.text : ''
  } catch {
    /* 忽略 */
  }
  return out
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

function envFor(watch) {
  return {
    WATCH_ID: watch.id,
    WATCH_INTERVAL: String(Math.round(Number(watch.intervalMs) / 1000)),
    WATCH_TIMEOUT: String(Math.round(Number(watch.timeoutMs) / 1000)),
  }
}

/**
 * 跑一次 checker。超时/启动失败返回 status；不关心 exit code，只看 stdout JSON。
 *
 * @param {{subprocess: {spawn: Function}, watch: object, argv: string[], configDir: string,
 *          signal?: AbortSignal, now?: () => number,
 *          limits?: {maxStdoutBytes?:number,maxStderrBytes?:number,maxMessageBytes?:number,maxErrorBytes?:number}}} input
 */
export async function runChecker({ subprocess, watch, argv, configDir, signal, now = Date.now, limits = {} }) {
  const caps = resolveLimits(limits)
  const startedAt = now()
  const finish = (result) => ({
    ...result,
    durationMs: Math.max(0, now() - startedAt),
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  })
  const failed = (status, extra = {}) =>
    finish({ status, notify: false, message: null, error: null, stdout: '', stderr: '', ...extra })

  if (signal?.aborted === true) return failed('spawn_error', { error: 'aborted' })
  if (!Array.isArray(argv) || argv.length === 0) return failed('spawn_error', { error: 'checker argv 为空' })

  let handle
  try {
    handle = subprocess.spawn({
      argv,
      cwd: watch.cwd ?? configDir,
      graceMs: 2000,
      stdio: {
        stdin: 'ignore',
        stdout: { maxBytes: caps.maxStdoutBytes },
        stderr: { maxBytes: caps.maxStderrBytes },
      },
      env: envFor(watch),
      ...(signal === undefined ? {} : { signal }),
    })
  } catch (error) {
    return failed('spawn_error', { error: errorMessage(error) })
  }

  let timedOut = false
  let terminateIssued = false
  const terminate = () => {
    if (terminateIssued) return
    terminateIssued = true
    try {
      handle.terminate()
    } catch {
      /* 已退出或实现不支持 */
    }
  }

  const timeoutMs = Math.max(1, Number(watch.timeoutMs) || 30_000)
  const timeoutTimer = setTimeout(() => {
    timedOut = true
    terminate()
  }, timeoutMs)
  timeoutTimer.unref?.()

  let giveUpTimer
  const giveUp = new Promise((resolve) => {
    giveUpTimer = setTimeout(() => {
      timedOut = true
      terminate()
      resolve({ __giveUp: true })
    }, timeoutMs + 2000 + 10_000)
    giveUpTimer.unref?.()
  })

  const onAbort = () => terminate()
  signal?.addEventListener?.('abort', onAbort, { once: true })

  let outcome = null
  let doneError
  let gaveUp = false
  try {
    const settled = await Promise.race([
      handle.done.then(
        (value) => ({ value }),
        (error) => ({ error }),
      ),
      giveUp,
    ])
    if (settled?.__giveUp === true) gaveUp = true
    else if (settled?.error !== undefined) doneError = settled.error
    else outcome = settled?.value ?? null
  } finally {
    clearTimeout(timeoutTimer)
    clearTimeout(giveUpTimer)
    signal?.removeEventListener?.('abort', onAbort)
  }

  const collected = readCollected(handle)
  if (timedOut) {
    return finish({
      status: 'timeout',
      notify: false,
      message: null,
      error: null,
      stdout: collected.stdout,
      stderr: collected.stderr,
    })
  }
  if (gaveUp) {
    return finish({
      status: 'spawn_error',
      notify: false,
      message: null,
      error: 'termination_timeout: process did not settle after terminate',
      stdout: collected.stdout,
      stderr: collected.stderr,
    })
  }
  if (doneError !== undefined) {
    return finish({
      status: 'spawn_error',
      notify: false,
      message: null,
      error: errorMessage(doneError),
      stdout: collected.stdout,
      stderr: collected.stderr,
    })
  }

  const parsed = parseCheckerOutput({ stdout: collected.stdout, lossy: collected.lossy, limits: caps })
  return finish({
    ...parsed,
    stdout: collected.stdout,
    stderr: collected.stderr,
    exitCode: outcome?.exitCode ?? null,
    signal: outcome?.signal ?? null,
  })
}
