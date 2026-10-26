# Watch 编写指南（watch-authoring）

这个 skill 说明**如何为 dsh-watch-kit-plugin 编写和维护一个 watch**。创建动作只能由用户在会话里执行
`/watch-add <id>`；你收到 `[WATCH SETUP]` 后按本指南补全检测程序、配置与验证。

## 1. 一个 watch 只有三样东西值得关心

| 文件/字段 | 作用 |
|---|---|
| `check.sh`（Windows 为 `check.ps1`） | 检测程序：`exit 0` 无事件、`exit 1` 有事件、`exit 255` 异常 |
| `TRIGGER_MSG`（在 `watch.conf`） | 有事件时对 agent 说的常驻指令；为空时回退 `PURPOSE` |
| `INTERVAL`（在 `watch.conf`） | 检查间隔，默认 60 秒，范围 30 秒–24 小时 |

其余由插件管理：`TARGETS`（绑定会话，创建时写入）、`TIMEOUT`（默认 15 秒，必须 ≤ INTERVAL/2）、
`FAILURE_MSG`（可选）、`state.json`（不要手改）、`logs/`、`data/`（脚本自己的状态）。

## 2. 检测程序契约

```
exit 0    = 无事件（静默；失败计数清零）
exit 1    = 有事件（唤醒；stdout 可作为证据，或返回 JSON 覆盖 message）
exit 255  = 异常（不触发；连续 5 次提醒一次；日志记录 stderr）
```

- 工作目录是 watch 目录；可用环境变量：
  `WATCH_ID` `WATCH_DIR` `WATCH_STATE` `WATCH_LOGS` `WATCH_INTERVAL` `WATCH_DRY`。
- `WATCH_DRY=1` 时**不得修改状态或产生副作用**（`watch_validate` 干跑会带这个变量）。
- `TIMEOUT` 由内核强制；超时视为异常。
- stdout 只在 `exit 1` 时进入触发帧（≤8KB，超出截断）；stderr 只进日志，失败帧附最后 20 行。
- **去重由脚本自负**：需要"只在变化时提醒"就自己维护状态，写进 `"$WATCH_STATE"`。

### 去重模板（推荐）

```bash
#!/bin/bash
set -u
state="${WATCH_STATE:?}"
marker="$state/above"          # 用状态文件的"存在/内容"表达当前阶段
current="$(some-check)" || { echo "check failed" >&2; exit 255; }
if [ "$current" -gt 100 ]; then
  if [ ! -f "$marker" ]; then
    echo "超过阈值：$current"   # 证据
    : > "$marker"
    exit 1
  fi
  exit 0                        # 已经报过，去重
fi
rm -f "$marker"
exit 0
```

反例：每轮都 `exit 1`（会被每轮唤醒）、用时间戳当状态（永远在变）、把未读数当指纹（读信后会回落造成反复触发）。

## 3. JSON 事件：动态覆盖 message

`exit 1` 且**整段 stdout 是合法 JSON 对象**时，可覆盖提醒内容：

```json
{"message":"发现 2 封新邮件，请阅读后回复。","evidence":"alice/合同终稿；bob/排期"}
```

| 字段 | 约束 | 作用 |
|---|---|---|
| `message` | 可选，1–2048 字节 | 覆盖 `TRIGGER_MSG` |
| `evidence` | 可选，≤8KB | 覆盖证据 |

- 只认退出码 1；退出码 0/255 时 JSON 被忽略（按退出码语义）。
- 解析失败、非 object、字段类型错、message 超长、stdout 被截断 → **记为执行失败**（不触发事件），日志 `event_json_invalid`。
- 触发帧头会标记 `message_source=script`（JSON）或 `message_source=config`。
- 不需要动态措辞时，用普通文本 + 静态 `TRIGGER_MSG` 更简单。

## 4. 平台

- POSIX：`check.sh`，shebang 或扩展名自动选解释器。
- Windows：`check.ps1`（优先 `pwsh`，回退 `powershell`），输出前必须
  `[Console]::OutputEncoding = [Text.Encoding]::UTF8`；`.sh` 需要 Git Bash/WSL。
- 显式指定解释器：`RUNNER=bash|pwsh|powershell|python|node|direct`。
- 凭据从 keychain/环境读取，**不要写进 watch.conf 或 stdout**。

## 5. 创建流程（收到 `[WATCH SETUP]` 后）

1. 用 1–2 句话复述你的理解；最多问 2 个问题（看什么、多久、怎么提醒）。缺省即可声明：
   "默认只读、只提醒、60 秒"。
2. 写 `check.sh` / `TRIGGER_MSG`（必要时 `FAILURE_MSG`），保持 `TARGETS` 不变。
3. 本地自检：
   ```bash
   cd <watch 目录>
   WATCH_STATE=$(mktemp -d) WATCH_DRY=1 bash check.sh; echo $?   # 期望 0（或 1，如果你在验证事件）
   ```
4. 调用 `watch_validate`（`{"id":"<id>"}`）；读返回的 `sampleFrame`，确认被叫醒时看到的内容合理。
5. 向用户汇报：监控什么、间隔、被叫醒时会发生什么、如何暂停（`/watch-pause`）。不要声称
   "已在真实 DSH 中验证触发"，除非你确实看到了触发帧。

## 6. 修改已有 watch

- **可以自主做**：修 bug、去重/降噪、错误处理、输出裁剪、`INTERVAL`/`TIMEOUT` 调参、`TRIGGER_MSG` 文案。
  **改完 `check.sh` 必须调用 `watch_validate`**：插件会记录脚本哈希，未校验的改动会让 watch 进入
  `needs_validation`、暂停轮询并向会话发一条 `[WATCH NOTICE]`。
- **必须先问用户**（并让其执行 `/watch-approve <id>`）：改 `PURPOSE`、改绑定会话、改变监控的
  数据范围（如从只看标题变成读正文）、改变是否有副作用、删除 watch。
- **不要**：手改 `state.json`、改 `TARGETS` 绕过审批、重建同名 watch（先 `/watch-list` 查重）、
  在触发轮里 re-arm（插件常驻，无需重新启动）。
- 用户直接编辑 `watch.conf`/脚本是支持的正式入口，修改会自动热加载。

## 7. 被叫醒时怎么读触发帧

```
[WATCH TRIGGER] id=<id> reason=event at=... rev=N message_source=config|script
--- message ---   ← 用户为该 watch 设定的常驻指令（按它做）
--- evidence ---  ← 脚本给出的证据（可能被截断，日志里有完整版）
--- logs ---      ← 当日日志路径，排查用
--- next ---      ← 明确的下一步
```

- `message` 是用户的常驻指令，不是新的用户消息；不要把它当成"重新起点"。
- 只做 `message` 要求的事；不要顺手改别的 watch、不要 re-arm、不要主动扩大动作范围。
- **收到 `[WATCH NOTICE] reason=script_changed`**：说明检测脚本在激活后被改动/丢失，watch 已暂停。
  先审查脚本 diff（是自己刚改的？还是别的进程改的？），确认安全后调用 `watch_validate` 恢复；
  不要用 `/watch-resume` 绕过，也不要在未理解改动时直接校验。
- 如果判定是误报：可以在当轮修脚本（噪声/实现问题）并 `watch_validate`，然后向用户报告；
  如果涉及监控范围/语义变化，先问用户。
- `reason=failure` 表示连续失败：看 `error_tail` 与日志；能修就修并重新 `watch_validate`；
  不能修就在回复里说明原因与下一步，不要静默。

## 8. 唤醒预算（可选）

如果某个 watch 可能持续高频触发（例如接入即时聊天），而用户不希望每次都唤醒，可以建议开启：

```ini
WAKE_BUDGET_CAPACITY=5
WAKE_BUDGET_REFILL_SECONDS=600
```

- 默认关闭；只在确有需要时开启，并先征得用户同意（这是行为变化）。
- 超额触发不会丢证据，会合并成一条 pending 并在补充 token 后投递；`/watch-list` 显示 `suppressed(n)`。
- 聊天/消息流场景优先考虑改进脚本的去重或摘要，而不是打开预算。

## 9. 参考

- 目录大小 + 去重：[`examples/dir-size/check.sh`](../../examples/dir-size/check.sh)
- JSON 覆盖：[`examples/json-event/check.sh`](../../examples/json-event/check.sh)
- 完整契约：`docs/design.md` §6
- `examples/` 随插件包发布，可直接参考；链接失效时读仓库对应文件。
