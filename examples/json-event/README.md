# json-event（JSON 事件载荷示例）

演示 design §6.2.2：`exit 1` 时 stdout 返回 JSON，**覆盖** `watch.conf` 里的 `TRIGGER_MSG`。

```bash
# 本地测试（不需要插件）
export WATCH_STATE=$(mktemp -d)
export WATCH_JSON_DEMO_DIR=/tmp/watch-json-demo
mkdir -p "$WATCH_JSON_DEMO_DIR" && echo hello > "$WATCH_JSON_DEMO_DIR/trigger"

bash check.sh | python3 -m json.tool; echo "exit=${PIPESTATUS[0]}"   # 1，且 JSON 合法
bash check.sh; echo "exit=$?"                                        # 0（去重）

rm -rf "$WATCH_JSON_DEMO_DIR"; bash check.sh; echo "exit=$?"         # 0，清掉去重标记
```

装上插件后，这个脚本产生的触发帧里：

- 帧头是 `message_source=script`；
- `--- message ---` 来自 JSON 的 `message`；
- `--- evidence ---` 来自 JSON 的 `evidence`。

JSON 写坏（语法错误、非 object、`message` 超长、stdout 被截断）会被记为**执行失败**，不会触发事件。
