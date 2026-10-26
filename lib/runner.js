/** 解释器解析：把 CHECK 文件变成 argv。纯函数 + 注入的查找器，便于跨平台单测。 */

import { extname } from 'node:path'
import { platformDefaultCheck, RUNNERS } from './conf.js'

const PS1_ARGS = Object.freeze(['-NoProfile', '-NonInteractive', '-File'])
const PWSH_ARGS = Object.freeze([...PS1_ARGS])
const POWERSHELL_ARGS = Object.freeze(['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File'])

/** 生成"查找可执行文件"的包装：找不到时统一返回 null。 */
function makeFinder(resolveExecutable) {
  return async (command) => {
    try {
      const found = await resolveExecutable(command)
      return typeof found === 'string' && found.length > 0 ? found : null
    } catch {
      return null
    }
  }
}

async function firstFound(finder, candidates) {
  for (const candidate of candidates) {
    const found = await finder(candidate)
    if (found !== null) return { name: candidate, path: found }
  }
  return null
}

/** 按扩展名 + 平台解析；返回 null 表示缺少解释器。 */
async function resolveAuto({ platform, checkPath, finder, isExecutable }) {
  if (platform !== 'win32' && (await isExecutable(checkPath))) return [checkPath]

  const ext = extname(checkPath).toLowerCase()
  switch (ext) {
    case '.sh': {
      const bash = await finder('bash')
      return bash === null ? null : [bash, checkPath]
    }
    case '.ps1': {
      const pwsh = await finder('pwsh')
      if (pwsh !== null) return [pwsh, ...PWSH_ARGS, checkPath]
      const powershell = await finder('powershell')
      return powershell === null ? null : [powershell, ...POWERSHELL_ARGS, checkPath]
    }
    case '.py': {
      if (platform === 'win32') {
        const py = await finder('py')
        if (py !== null) return [py, '-3', checkPath]
      }
      const python = await firstFound(finder, ['python3', 'python'])
      return python === null ? null : [python.path, checkPath]
    }
    case '.js':
    case '.mjs':
    case '.cjs': {
      const node = await finder('node')
      return node === null ? null : [node, checkPath]
    }
    case '.cmd':
    case '.bat': {
      if (platform !== 'win32') return [checkPath]
      const cmd = (await finder('cmd.exe')) ?? 'cmd.exe'
      return [cmd, '/d', '/s', '/c', checkPath]
    }
    case '.exe':
      return [checkPath]
    default:
      return [checkPath]
  }
}

/**
 * 解析检测程序的 argv。
 *
 * @param {{platform?: string, checkPath: string, runner?: string,
 *          isExecutable?: (path: string) => Promise<boolean>|boolean,
 *          resolveExecutable?: (command: string) => Promise<string|null>|string|null}} input
 * @returns {Promise<string[]|null>} null 表示缺少解释器（runner_not_found）
 */
export async function resolveRunner({
  platform = process.platform,
  checkPath,
  runner = 'auto',
  isExecutable = async () => false,
  resolveExecutable = async () => null,
} = {}) {
  const normalized = String(runner ?? 'auto').trim().toLowerCase() || 'auto'
  if (!RUNNERS.includes(normalized)) {
    throw new TypeError(`unknown RUNNER "${runner}"`)
  }
  const finder = makeFinder(resolveExecutable)

  switch (normalized) {
    case 'direct':
      return [checkPath]
    case 'bash': {
      const bash = await finder('bash')
      return bash === null ? null : [bash, checkPath]
    }
    case 'pwsh': {
      const pwsh = await finder('pwsh')
      return pwsh === null ? null : [pwsh, ...PWSH_ARGS, checkPath]
    }
    case 'powershell': {
      const powershell = await finder('powershell')
      return powershell === null ? null : [powershell, ...POWERSHELL_ARGS, checkPath]
    }
    case 'python':
    case 'python3': {
      const python = await firstFound(finder, ['python3', 'python'])
      return python === null ? null : [python.path, checkPath]
    }
    case 'node': {
      const node = await finder('node')
      return node === null ? null : [node, checkPath]
    }
    default:
      return resolveAuto({ platform, checkPath, finder, isExecutable })
  }
}

export { platformDefaultCheck }
