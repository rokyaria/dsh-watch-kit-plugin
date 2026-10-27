# dsh-watch-kit-plugin

> 给 DeepSeek Harness 的常驻巡检插件：按配置的间隔运行 checker，checker 只在「有事」时输出 `notify: true`，插件才唤醒 agent；其余时间零 token、零对话。
>
> **当前状态：v0.2.3（v0.2.1 重写 + 随包 mailbox 扩展）**。运行时事实源是 SQLite；watch 配置是一份 JSON 文件，编辑后执行一次 `/watch-reload` 生效。旧版命令、watch 目录与校验流程已删除，迁移见文末。

## 它是什么

- **调度器**：每 `pollIntervalMs`（默认 10 秒）轮询一次到期 watch；到期条件 `now - last_run_at > interval`。
- **只在事件时唤醒**：checker 输出合法 JSON 且 `notify: true` 才投递；同一轮同一 `target` 的多个事件合并成一条消息。
- **checker 自负其责**：是否提醒、如何去重、状态存在哪里，全由 checker 决定；插件不按内容去重、不自动重试。
- **可观测**：`watch_runs` 看运行/通知/失败统计，`watch_sessions` 查可用会话 id。
- **不做**：无 OS 通知、无常驻服务、无沙箱；DSH 进程不运行时不会巡检。

## 给只会用 agent 的用户（最短路径）

把下面这段直接发给你的 agent：

> 请帮我安装并配置 dsh-watch-kit-plugin（仓库：https://github.com/rokyaria/dsh-watch-kit-plugin）：
> 1. 把仓库 clone 到本机，用 `plugin_manager install_bundle target=<clone 后的绝对路径>` 安装，确认返回 `application:"applied"`；若提示 `restart-required` 按提示重启 DSH。
> 2. 先读仓库 README，按“快速开始”在这个工作区的 `.dsh/watch/watches.json` 创建一个 watch 示例（checker 按我的实际需求写）。
> 3. 不要改 profile 的 `cordis.patch.yml`，直接用默认配置；完成后告诉我，我自己在输入框发 `/watch-reload`。

你只需要做两件事：发上面这段；agent 完成后自己发送 `/watch-reload`（slash command 只能由你在会话里输入，agent 不能代发）。之后有事件时你会收到 `[WATCH 通知]`，也可让 agent 用 `watch_runs` 查看统计。

## 安装

1. 让有 `plugin_manager` 权限的 agent 安装本仓库（`target` 为仓库**绝对路径**；仓库还不在本地时先 clone，例如 `git clone https://github.com/rokyaria/dsh-watch-kit-plugin`）：

   ```
   plugin_manager install_bundle target=<本仓库绝对路径>
   ```

   返回 `applied` 完成；`restart-required` 按提示重启 DSH；`already-installed` 或升级版本时先 `remove_bundle` 再 `install_bundle`。

2. **可选**：只有想固定路径或轮询间隔时，才在 profile 的 `cordis.patch.yml` 里覆盖 `watch` 行的 config（本插件 bundle 已插入该行）；不改也能直接用默认值：

   ```yaml
   - id: watch
     config:
       pollIntervalMs: 10000
       configFile: /absolute/path/to/watches.json   # 省略 → <workspace>/.dsh/watch/watches.json
       dbFile: /absolute/path/to/watch.db           # 省略 → <workspace>/.dsh/watch/watch.db
   ```

   三个键都可省略，省略即用默认值；patch 会整体替换该行 config，保存后按 profile 是否启用热加载决定是否重启 DSH。只想快速用起来的用户/agent 可以跳过本步。

   `<workspace>` 默认取**最近一个可见会话的 cwd**（`ctx.sessionController.list`；DSH 的 `workingDirectory.defaultDirectory` 在桌面版通常是 profile 目录，不作为首选），都取不到时用 `process.cwd()`。默认路径：`<workspace>/.dsh/watch/watches.json` 与 `<workspace>/.dsh/watch/watch.db`；DB 父目录自动创建，配置文件不存在时 `/watch-reload` 报错。`configFile`/`dbFile` 也可写相对 `<workspace>` 的路径；**建议在 profile patch 里显式写绝对路径**，避免启动方式不同导致默认目录漂移。

### 运行上限（可选）

插件 Config 还有一个 `limits` 对象；不配置就是原来的默认值。它通过 profile 的 `cordis.patch.yml` 覆盖，不能按单条 watch 配置：

```yaml
- id: watch
  config:
    pollIntervalMs: 10000
    limits:
      checker:
        maxStdoutBytes: 65536       # 4KiB–4MiB
        maxStderrBytes: 8192        # 512B–1MiB
        maxMessageBytes: 8192       # 256B–4MiB
        maxErrorBytes: 2048         # 64B–1MiB
      message:
        maxItems: 20                # 1–100
        maxBytes: 16384             # 8KiB–4MiB
      scheduler:
        maxConcurrentChecks: 4      # 1–16
        runRetentionDays: 7         # 1–365
```

这些值只影响插件运行参数，不改变 `watches.json` 的 checker 契约；改完需要重启/重新安装插件让 Config 生效。

## 快速开始

1. 新建 `watches.json`（可直接用默认路径 `<workspace>/.dsh/watch/watches.json`）：

   ```json
   {
     "watches": [
       {
         "id": "mail-inbox",
         "checker": ["bash", "/abs/path/check-mail.sh"],
         "cwd": "/abs/path",
         "interval": 60,
         "timeout": 30,
         "enabled": true
       }
     ]
   }
   ```

2. 你本人在输入框发送 `/watch-reload`（不能由 agent 代发）：配置合法则同步进数据库；省略 `target` 的新 watch 会绑定到当前会话。启动不会自动导入配置文件，首次安装后必须手动执行一次。
3. 之后 checker 约每 60 秒运行一次（到期轮询，默认轮询间隔 10 秒）；输出 `{"notify":true,"message":"…"}` 时会话收到一条 `[WATCH 通知]`。

## 随包 mailbox checker（可选）

仓库 `extension/mailbox/` 里附带一个零第三方依赖的 Python mailbox checker：`mail.py` 同时是 checker 和 agent 的邮箱 CLI，支持多账户、allowlist（user/guest）、临时标记、30 分钟未处理提醒、回复自动标记。使用 `preset: "mailbox"` 时不需要配置 checker 路径或参数：

```json
{
  "id": "mailbox-account-1",
  "preset": "mailbox",
  "enabled": false,
  "mailbox": {
    "envFile": "/absolute/path/to/mail.env",
    "stateDir": "/absolute/path/to/.dsh/mailbox",
    "allowAccountFile": "/absolute/path/to/allow-accounts.json",
    "remindAfterMinutes": 30,
    "folder": "INBOX",
    "python": "python3"
  },
  "interval": 60,
  "timeout": 60
}
```

默认所有人都不通知，必须用 per-account allowlist 显式允许；不能把授权码写进 `watches.json`。完整说明、模板和严格行为见 [extension/mailbox/README.md](https://github.com/rokyaria/dsh-watch-kit-plugin/blob/main/extension/mailbox/README.md)。插件还会随包注册 `watch-kit` / `watch-mailbox` 两个运行时 skill。

## 配置文件：watches.json

| 字段 | 必需 | 说明 |
|---|---|---|
| `id` | 是 | 字符串，1–64 字符、无空白，watch 唯一标识 |
| `checker` | 是 | 非空字符串数组，按 argv 直接执行（不经过 shell） |
| `cwd` | 否 | 字符串；省略时用配置文件所在目录（相对路径按该目录解析） |
| `interval` | 否 | 数字，秒，>0，默认 60 |
| `timeout` | 否 | 数字，秒，>0，默认 30；超时终止进程 |
| `target` | 否 | 会话 id；省略时新 watch 绑定执行 `/watch-reload` 的当前会话，已有 watch（含软删除后复活）保持原绑定；需要改绑时显式写 target |
| `enabled` | 否 | boolean，默认 true |

- 顶层必须是 `{"watches": [...]}`，`watches` 必须是数组；未知字段忽略。
- 整份文件一起校验：任一条目非法 → `/watch-reload` 返回 `{kind:'error', text}`，数据库不变。
- `/watch-reload` 在一个事务里按 `id` 新增/更新；文件中已删除的 watch 标记为软删除（保留其运行历史），重新出现即恢复。

## checker 契约

- 执行：`argv` 数组直接执行、**不经过 shell**（不要写 `a | b`、`$(...)` 等 shell 语法；需要管道就写成脚本）。
- 工作目录：`cwd` 或配置文件所在目录；环境变量：`WATCH_ID`、`WATCH_INTERVAL`（秒）、`WATCH_TIMEOUT`（秒）。
- 超时（`timeout` 秒）由插件终止 checker，记为 `timeout`。
- stdout 上限 64KB、stderr 上限 8KB（stderr 尾部写入运行记录）；stdout 超限按 `invalid_json` 处理。
- **只认 stdout 的合法 JSON**（空输出也算 `invalid_json`）；进程退出码不参与语义（只有进程级失败才记录：`spawn_error`/`timeout`）。
- stdout 是唤醒信号，不是数据通道：正文/大结果应写入文件，message 里只放摘要和文件路径；`maxMessageBytes` 默认只有 8192。

| 字段 | 类型 | 说明 |
|---|---|---|
| `notify` | boolean | 必填；true 才会唤醒 |
| `message` | string \| null | 默认 null；`notify=true` 时必须是非空字符串（≤8192 字节） |
| `error` | string \| null | 默认 null；可选错误说明（≤2048 字节），会显示在唤醒消息里 |

失败分类（都不投递，只写入 runs 记录）：`invalid_json`（非 JSON / 非对象 / stdout 超限）、`invalid_fields`（字段类型或长度非法，或 `notify=true` 但 `message` 为空）、`spawn_error`、`timeout`。

最小 checker 示例（配成 `checker: ["bash", "/abs/check-mail.sh"]`）：

```bash
#!/bin/bash
# 有事件输出 notify=true + message；无事输出 notify=false。
if [ -n "$(ls /tmp/mail-need-review 2>/dev/null)" ]; then
  printf '{"notify":true,"message":"有待处理邮件，请检查。"}\n'
else
  printf '{"notify":false}\n'
fi
```

> 去重是 checker 的责任：插件每轮只看 `notify`。如果 checker 每轮都输出 `notify: true`，agent 每轮都会被唤醒。

## 唤醒消息

同一轮里，每个 `target` 最多收到一条合并消息（包含该 target 下会被投递的 `notify=true` 事件，受下面条数/大小上限约束）：

```
[WATCH 通知] 2 个事件
--- mail-inbox（interval=60s）---
检测到 2 封新邮件
--- disk-space（interval=300s）---
磁盘使用率 92%
[error] df 返回非零
```

单条消息最多列出 20 条事件、最多 16KB（放不下时丢弃后段，空间允许时标注"另有 N 个"）。只有**真正写进消息**的 watch 才算投递成功：更新其 `last_notify_at`、runs 标记已投递并清零补偿；被丢弃的事件保持未投递（在 `watch_runs` 里可见，下一轮由 checker 决定是否再提醒）。

## 投递失败补偿

- 投递失败只计数、不重试、不重放；记录失败次数、连续失败串、首次失败时间与最后一次错误。
- 该 watch 下一次被实际投递成功时，消息末尾附带一次补偿段，然后清零；多个失败合并为一行，多个 watch 合并成一个补偿段（补偿段预留空间，正常不会被 16KB 上限挤掉）：

```
[投递失败补偿]
- mail-inbox：过去 2.0 小时投递失败 3 次，最后一次：session not found
```

- 补偿段最多列 10 行，超出显示"另有 N 个"；最后一条错误最多显示 128 字符。

## 工具

**`watch_runs`**：参数 `{ hours?: number }`，默认 3（1–72）。按 watch 输出最近 hours 小时内：`id, interval(s), invoke_count, notified_count, error_count, invalid_json_count, invalid_fields_count, timeout_count, delivery_fail_count, last_run_at, last_notify_at, last_error`。

- `invoke_count`：运行次数；`notified_count`：已投递通知数；`error_count`：`status != ok` 次数；`last_error`：窗口内最近失败的错误或 stderr 尾部（截断）。
- 包含所有启用且未删除的 watch（即使 0 次运行）。

**`watch_sessions`**：无参数，返回最近可见会话（最多 50 条，按更新时间倒序）：`sessionId, cwd, updatedAt, running, agentAvailable, blank, origin, parentSessionId`。用于给 watch 显式指定 `target`。注意：DSH 的“可见会话”不暴露归档状态，列表可能包含已归档会话；指定 target 前请自行确认。

## 行为与边界

- 轮询：默认每 10 秒一次（`pollIntervalMs`，最小 1000）；启动后立即轮询一次；上一轮未结束时跳过本轮（单飞）。
- 调度：`now - last_run_at > interval` 才运行；到期 watch 在 `BEGIN IMMEDIATE` 事务里被 claim，多进程共享同一个 DB 也不会重复执行；单轮并发上限 4。
- 无去重、无自动重试：是否"只在变化时提醒"由 checker 自己判断（例如把状态写进自己的文件，无事时输出 `notify:false`）；投递失败只计数，靠下一次成功的投递做一次性补偿。
- DSH 必须在运行：插件随 DSH 启停，不依赖系统 cron，也没有 OS 通知。
- 无沙箱：checker 以你的用户身份运行，权限与普通 shell 相同。
- 运行记录保留 7 天（每轮/每次 reload 顺带清理）；卸载插件后停止轮询并关闭 DB，配置文件与 DB 仍保留在磁盘上。

## 从 0.1 升级（破坏性）

- 旧版的管理命令、模型侧工具、watch 目录与文件约定、skill、随包模板/示例全部删除；现在只有 `/watch-reload` 和 `watch_runs`/`watch_sessions`。
- 旧 watch 目录不再读取：把每个 watch 改写成 `watches.json` 的一个条目（`checker` 用 argv 指定原脚本与解释器），执行一次 `/watch-reload`。
- 旧的调度/提醒逻辑不会自动迁移；原 checker 若依赖退出码或自定义触发消息，需要改成输出 JSON（`notify`/`message`/`error`）。

## 开发

架构、数据模型、调度/投递语义、Host API 约束、测试与发布流程见 [docs/development.md](https://github.com/rokyaria/dsh-watch-kit-plugin/blob/main/docs/development.md)。

## 兼容性

| 项 | 说明 |
|---|---|
| DSH | `^0.2.1-rc.3`（`engines.dsh`） |
| Node | 使用 `node:sqlite`；DSH 0.2.1-rc.3 自带 Node 24.21（Node 22.x 的 sqlite 需要 flag，故要求 ≥24） |
| 平台 | macOS / Linux（POSIX）；**Windows 未验证**：argv 不经过 shell 可跨平台执行，但 `.sh` checker 需要 bash，建议用 node/python 可执行文件 |
| 依赖 | 无第三方运行时依赖；`@deepseek-ai/dsh-llm`、`dsh-tools`、`schemastery` 由 DSH 按 peerDependencies 提供 |

## 许可

MIT
