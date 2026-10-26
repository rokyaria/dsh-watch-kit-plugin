#!/bin/bash
# JSON 事件载荷示例：当 /tmp/watch-json-demo/trigger 出现时，
# 用 JSON 覆盖 message 与 evidence（design §6.2.2）。
#
# 契约：exit 0 无事件；exit 1 有事件（stdout 必须是完整 JSON）；exit 255 异常。
# 去重由脚本自负：用 $WATCH_STATE/reported 记录"已提醒"，触发器消失后清除。
set -u

BASE="${WATCH_JSON_DEMO_DIR:-/tmp/watch-json-demo}"
STATE_DIR="${WATCH_STATE:?WATCH_STATE is required}"
MARKER="$STATE_DIR/reported"

if [ -f "$BASE/trigger" ]; then
  if [ ! -f "$MARKER" ]; then
    size=$(wc -c < "$BASE/trigger" | tr -d ' ')
    printf '{"message":"检测到演示触发器，请确认是否继续。","evidence":"触发文件：%s/trigger（%s 字节）"}\n' "$BASE" "$size"
    : > "$MARKER"
    exit 1
  fi
  exit 0
fi

rm -f "$MARKER"
exit 0
