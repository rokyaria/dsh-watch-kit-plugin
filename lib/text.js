/** 纯文本工具：UTF-8 长度、BOM、控制字符、截断、行尾。零依赖，便于单测。 */

/** UTF-8 字节长度。 */
export function utf8Bytes(text) {
  return Buffer.byteLength(String(text ?? ''), 'utf8')
}

/** 去掉开头的 UTF-8 BOM。 */
export function stripBom(text) {
  const value = String(text ?? '')
  return value.charCodeAt(0) === 0xfeff ? value.slice(1) : value
}

/** 把除换行/制表符外的控制字符替换为空格，避免破坏帧结构。 */
export function sanitizeText(text) {
  return String(text ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ' ')
}

/** 按 UTF-8 字节截断，不留下半个多字节字符；可选追加标记。 */
export function clipUtf8(text, maxBytes, marker = '') {
  const value = String(text ?? '')
  const budget = Math.max(0, Number(maxBytes) || 0)
  if (utf8Bytes(value) <= budget) return value
  const markerBytes = utf8Bytes(marker)
  if (markerBytes >= budget) {
    return Buffer.from(marker, 'utf8').subarray(0, budget).toString('utf8').replace(/\ufffd+$/u, '')
  }
  const head = Buffer.from(value, 'utf8').subarray(0, budget - markerBytes).toString('utf8')
  return head.replace(/\ufffd+$/u, '') + marker
}

/** 取最后 n 行。 */
export function tailLines(text, n) {
  const lines = String(text ?? '').split(/\r?\n/)
  const count = Math.max(0, Number(n) || 0)
  if (count === 0) return ''
  return (lines.length <= count ? lines : lines.slice(-count)).join('\n')
}

/** 人类可读的字节大小，用于帧里的证据标注。 */
export function sizeLabel(bytes) {
  const value = Math.max(0, Number(bytes) || 0)
  if (value < 1024) return `${value}B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)}KB`
  return `${(value / (1024 * 1024)).toFixed(1)}MB`
}

/** 把多行文本压成一行（用于帧内的单行字段）。 */
export function oneLine(text) {
  return sanitizeText(text).replace(/\s+/g, ' ').trim()
}
