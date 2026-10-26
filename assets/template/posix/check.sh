#!/bin/bash
# 检测程序契约（docs/design.md §6.2）：
#   exit 0   无事件
#   exit 1   有事件（stdout 可作为证据；也可返回 JSON 覆盖 message）
#   exit 255 异常（不触发；连续 5 次会提醒一次）
#
# 可用环境变量：
#   WATCH_ID  WATCH_DIR  WATCH_STATE  WATCH_LOGS  WATCH_INTERVAL  WATCH_DRY
#
# 去重由脚本自负：需要"只在变化时触发"时，把状态写进 "$WATCH_STATE"。
# JSON 事件示例（exit 1 时）：
#   printf '{"message":"发现了什么，请处理。","evidence":"证据文本"}\n'
set -u

# TODO: 实现检测逻辑。参考 examples/dir-size/ 与 examples/json-event/。
exit 0
