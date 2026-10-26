/** 检测脚本完整性：哈希、指纹与变化通知文案。 */

import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'

/** 文件内容的 sha256。 */
export async function fileSha256(path) {
  const data = await readFile(path)
  return createHash('sha256').update(data).digest('hex')
}

/** 轻量指纹（只 stat，不读内容）；不存在返回 null。 */
export async function scriptFingerprint(path) {
  try {
    const info = await stat(path)
    return { mtimeMs: info.mtimeMs, size: info.size }
  } catch {
    return null
  }
}

/** 指纹是否相同。 */
export function sameFingerprint(left, right) {
  if (left === null || left === undefined || right === null || right === undefined) return false
  return left.mtimeMs === right.mtimeMs && left.size === right.size
}

/** 展示用短哈希。 */
export function shortHash(hash) {
  return typeof hash === 'string' && hash.length > 0 ? hash.slice(0, 12) : '(unknown)'
}

/**
 * 脚本变化通知（直接投递到目标会话，不进入合并窗口）。
 * @param {{id: string, at: string, scriptPath: string, previousHash?: string|null,
 *          currentHash?: string|null, reason: string}} input
 */
export function renderScriptChangedNotice({ id, at, scriptPath, previousHash, currentHash, reason }) {
  const reasonText =
    reason === 'script_missing'
      ? '检测脚本不存在（被删除或重命名）'
      : reason === 'check_path_changed'
        ? 'CHECK 路径发生变化'
        : '检测脚本在 DSH 之外发生了变化'
  return [
    `[WATCH NOTICE] id=${id} reason=script_changed at=${at}`,
    `--- message ---`,
    `${reasonText}，已暂停轮询（不会用未验证的脚本继续执行）。`,
    `脚本：${scriptPath}`,
    `before=${shortHash(previousHash)} after=${shortHash(currentHash)}`,
    `--- next ---`,
    `请先审查脚本内容，然后调用 watch_validate（{"id":"${id}"}）重新校验并恢复。`,
    '如果你刚刚在改这个脚本，这是预期流程；如非预期，请检查工作区是否有其他进程/助手改动了它。',
  ].join('\n')
}
