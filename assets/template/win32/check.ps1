# 检测程序契约（docs/design.md §6.2）：
#   exit 0   无事件
#   exit 1   有事件（stdout 可作为证据；也可返回 JSON 覆盖 message）
#   exit 255 异常（不触发；连续 5 次会提醒一次）
#
# 可用环境变量：
#   WATCH_ID  WATCH_DIR  WATCH_STATE  WATCH_LOGS  WATCH_INTERVAL  WATCH_DRY
#
# ⚠️ 输出中文或 JSON 前必须先设置 UTF-8，否则会乱码并导致 JSON 解析失败。
[Console]::OutputEncoding = [Text.Encoding]::UTF8

# TODO: 实现检测逻辑。参考 examples/dir-size/check.ps1。
exit 0
