# dir-size（目录大小监控 demo）

最小可用的 `check.sh` 范本，演示两件事：

1. 退出码契约：`0` 无事件 / `1` 有事件 / `255` 异常；
2. **去重由脚本自负**：用 `$WATCH_STATE/above` 记录"已提醒"，所以超过阈值后不会每轮都唤醒。

```bash
# 本地单测（不需要安装插件）
export WATCH_STATE=$(mktemp -d)
export WATCH_DEMO_DIR=/tmp/watch-demo
export WATCH_DEMO_LIMIT_MB=1
mkdir -p /tmp/watch-demo && dd if=/dev/zero of=/tmp/watch-demo/blob bs=1m count=2
bash check.sh; echo "exit=$?"                              # 1（首次越界，有事件）
bash check.sh; echo "exit=$?"                              # 0（仍在阈值上，去重）
rm -f /tmp/watch-demo/blob; bash check.sh; echo "exit=$?"  # 0（回落，清掉标记）
rm -rf /tmp/watch-demo; bash check.sh; echo "exit=$?"      # 255（目录不存在 = 异常）
```

参数在 `check.sh` 顶部（`DIR` / `LIMIT_MB`），也可以改用环境变量覆盖；`TARGETS` 由 `/watch-add` 写进 `watch.conf`，不要手改。

- Windows 移植参考：`check.ps1`（**未在 Windows 实测**）。
- 想用 JSON 动态覆盖提醒内容：见 `../json-event/`。
