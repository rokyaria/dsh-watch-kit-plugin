#!/bin/bash
# dsh-watch-kit-plugin demo：目录大小监控。
#
# 契约（见 docs/design.md §6）：
#   exit 0   = 无事件
#   exit 1   = 有事件（首次越过阈值时；内核会唤醒会话）
#   exit 255 = 异常（不触发事件；连续失败 5 次时提醒一次）
#
# 去重由脚本自负：用 $WATCH_STATE/above 记录"已提醒"，回落后清除。
set -u

# ── 可修改的配置（也可以改成读环境变量） ──────────────────────────────
DIR="${WATCH_DEMO_DIR:-$HOME/Downloads}"
LIMIT_MB="${WATCH_DEMO_LIMIT_MB:-500}"
# ──────────────────────────────────────────────────────────────────────

STATE_DIR="${WATCH_STATE:?WATCH_STATE is required}"

[ -d "$DIR" ] || { echo "directory not found: $DIR" >&2; exit 255; }

size_kb=$(du -sk "$DIR" 2>/dev/null | awk '{print $1}') || {
  echo "du failed for $DIR" >&2
  exit 255
}
limit_kb=$(( LIMIT_MB * 1024 ))
marker="$STATE_DIR/above"

if [ "$size_kb" -gt "$limit_kb" ]; then
  if [ ! -f "$marker" ]; then
    printf '目录 %s 当前 %s MB，超过阈值 %s MB\n' \
      "$DIR" "$((size_kb / 1024))" "$LIMIT_MB"
    : > "$marker"
    exit 1
  fi
  exit 0   # 已经提醒过，去重
fi

rm -f "$marker"
exit 0
