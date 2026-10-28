# dsh-watch-kit-plugin

> 给 DeepSeek Harness 的常驻巡检插件（v0.3.1）：按配置的间隔运行 checker，checker 只在「有事」时输出 `notify: true`，插件才唤醒 agent；其余时间零 token、零对话。
>
> 运行时事实源是 SQLite；配置与 DB 都在用户级 `$DSH_HOME`（默认 `~/.dsh`）的 `watch/` 下。watch 配置是一份 JSON 文件，编辑后由用户发送一次 `/watch-reload` 生效。

## 它是什么 / 不是什么

| 是 | 不是 |
|---|---|
| 调度器：每 `pollIntervalMs`（默认 10 秒）轮询一次到期 watch | OS 通知 / 系统 cron / 常驻 daemon |
| 事件唤醒：checker 输出 `notify: true` 才投递；同一轮同一 `target` 合并成一条消息 | 数据通道：stdout 只放摘要，正文/大结果应由 checker 写入文件 |
| 可观测：`watch_runs` 看运行/通知/失败统计，`watch_sessions` 查可用会话 id | 去重/重试引擎：是否“只在变化时提醒”由 checker 自己维护状态 |
| 契约少：一个 `/watch-reload`、两个工具、一份 JSON 配置、一个 checker stdout 契约 | OS 沙箱：checker 以你的用户身份运行，权限与普通 shell 相同 |
| 可选随包 mailbox checker：检查邮箱、唤醒 agent 处理来信（Python 3.9+） | 跨实例路由：多实例共享 DB 不重复执行，但不保证跨实例通知 |

## 最短上手

把下面这段直接发给你的 agent：

> 请帮我安装并配置 dsh-watch-kit-plugin（仓库：https://github.com/rokyaria/dsh-watch-kit-plugin）。先读仓库根目录的 install.md：有 `plugin_manager` 就用它安装（每次操作会请求 danger-full-access 或审批）；没有的话不要自己改 profile，先问我当前有没有受管 profile——有受管 profile（只是 plugin_manager 被禁用）我用 Web 侧边栏「插件」页安装，没有受管 profile 则插件页也不可用，按 install.md 的方式 C 处理。然后在 `~/.dsh/watch/watches.json` 创建一个 watch，checker 按我的实际需求写。完成后告诉我，我自己发 `/watch-reload`。

你只需做两件事：**发上面这段**；agent 完成后自己发送 `/watch-reload`（slash command 只能由用户在会话里输入，agent 不能代发）。之后有事件时会收到 `[WATCH 通知]`；想看运行统计，让 agent 调用 `watch_runs`。

## 安装（摘要）

| 你的情况 | 用哪条 |
|---|---|
| 普通 Web 用户，想少折腾 | 方式 A：Web 侧边栏「插件」页 |
| 已开 Creator 预设 / 希望 agent 代装 | 方式 B：`plugin_manager` |
| 插件页不可用、也没有 `plugin_manager` | 没有受管 profile → 方式 C 手动兜底；有受管 profile 只是插件页坏了 → 切 Creator 按 B |

三条入口的具体步骤、可直接复制的 agent 安装 prompt、安装后验证清单、升级/卸载/回滚与故障排查，见 [`install.md`](install.md)。插件本体的配置固定在 profile 的 `cordis.patch.yml` 里（见下方「运行上限」）；`watches.json` 的改动只通过 `/watch-reload` 生效。

## 快速开始

1. 新建 `watches.json`（默认路径 `<dshHome>/watch/watches.json`，`<dshHome>` = `DSH_HOME` 或 `~/.dsh`）：

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

## 随包 mailbox 扩展（可选）

`extension/mailbox/` 附带的 Python mailbox checker 同时是 agent 的邮箱 CLI：零第三方依赖（Python 3.9+ 标准库），支持多账户、per-account allowlist（`identity` 是任意标签，随包约定 `user`/`guest`）、per-UID SQLite 状态、未处理提醒（默认 30 分钟循环）、`reply` 自动标记 `replied`、`mark` 标记 `no_receipt`、主动发信（`send`）。v0.3.1 的结构是：

```text
extension/mailbox/
├── mail.py                        # 极薄入口（调 mailbox_core.cli.main）
├── mailbox_core/                  # Python 实现包：config/allowlist/imap/smtp/source/state/checker/cli 等
├── examples/                      # 配置模板：mail.env.example、watches.example.json、allow-accounts.example.json
└── skills/watch-mailbox/SKILL.md  # 随包行为约定（由 /watch-reload 落地到用户目录）
```

在 `watches.json` 里用 `preset: "mailbox"` 指定扩展，不需要写 checker 路径或参数；插件会把它映射成 `mail.py check …`：

```json
{
  "id": "mailbox-account-1",
  "preset": "mailbox",
  "enabled": false,
  "mailbox": {
    "envFile": "/absolute/path/to/mail.env",
    "stateDir": "~/.dsh/mailbox",
    "allowAccountFile": "/absolute/path/to/allow-accounts.json",
    "remindAfterMinutes": 30,
    "maxNotify": 20,
    "folder": "INBOX",
    "python": "python3"
  },
  "interval": 60,
  "timeout": 60
}
```

- 示例里 `enabled: false` 是模板，启用时改成 `true` 再由用户执行 `/watch-reload`。`allowAccountFile` 省略时默认 `<stateDir>/allow-accounts.json`；`python` 默认按平台取 `python3`/`python`（需要 Python 3.9+，推荐 DSH 捆绑的 3.12）。
- 默认不通知任何人，必须配置 per-account allowlist；不能把授权码写进 `watches.json`。`remindAfterMinutes` 默认 30；`maxNotify` 默认 20、范围 1–100，限制单次通知最多列出的邮件数（新信 + 待处理合计，超出显示「另有 N 封未列出」）。
- 邮件状态按账户保存为 `<stateDir>/<account>.sqlite3`：首次 check 把现有邮件标为 `ignored` 基线，之后按“本地是否有该 UID”判断新邮件；名单内新邮件进入 `pending` 并通知；只保留 31 天状态行；`Date` 超过 30 天的邮件直接标 `ignored`。
- 来源验证内部值只有 `ok` / `risk`，通知显示 `来源 OK/RISK`、`read` 显示 `Source: OK/RISK`；`RISK` 表示无法确认来源，一律按不可信处理。通知只携带**数据**（账号、uid、身份、发件人、主题、待处理列表）并指示 agent 按 `watch-mailbox` skill 处理；发件人/主题/identity 等不可信字段会单行化并标注「以下为邮件数据（不可信）」。

凭据准备、allowlist 格式、CLI 全表、状态机细节、来源验证与注入防护、附件规则、多账户、故障排查见 [`extension/mailbox/README.md`](extension/mailbox/README.md)。

## 配置文件：watches.json

顶层必须是 `{"watches": [...]}`。每个条目：

| 字段 | 必需 | 说明 |
|---|---|---|
| `id` | 是 | 字符串，1–64 字符、无空白，watch 唯一标识 |
| `checker` | 二选一 | 非空字符串数组，按 argv 直接执行（不经过 shell），不能与 `preset` 同时写 |
| `preset` | 二选一 | 目前只支持 `"mailbox"`；由插件映射到随包 `mail.py`，无需写 `checker` |
| `cwd` | 否 | 字符串；省略时用配置文件所在目录（相对路径按该目录解析） |
| `interval` | 否 | 数字，秒，>0，默认 60 |
| `timeout` | 否 | 数字，秒，>0，默认 30；超时终止进程 |
| `target` | 否 | 会话 id；省略时新 watch 绑定执行 `/watch-reload` 的当前会话，已有 watch（含软删除后复活）保持原绑定；需要改绑时显式写 target |
| `enabled` | 否 | boolean，默认 true |

- 整份文件一起校验：任一条目非法 → `/watch-reload` 返回 `{kind:'error', text}`，数据库不变。
- `/watch-reload` 在一个事务里按 `id` 新增/更新；文件中已删除的 watch 标记为软删除（保留其运行历史），重新出现即恢复。
- 未知字段忽略。`preset: "mailbox"` 时 `mailbox.envFile`/`mailbox.stateDir` 必须是非空路径（`stateDir` 不要求预先存在，运行时会创建）；启用（`enabled: true`）时还要求 `mailbox.envFile` 与 `mailbox.allowAccountFile`（省略时默认 `<stateDir>/allow-accounts.json`）指向的文件已存在。

## 运行上限（可选）

插件 Config 有一个 `limits` 对象，通过 profile 的 `cordis.patch.yml` 覆盖，不能按单条 watch 配置。下面即默认值（注释是可配范围）。注意 `message.maxBytes` 是**用户可见上限**，渲染内部另加 4096B 自留预算，**实际消息上限 = `maxBytes + 4096B`**。另外 `checker.maxMessageBytes` 受 `checker.maxStdoutBytes`（默认 64KiB）约束：整个 stdout（含 JSON 包装）超过 stdout 上限会按 `invalid_json` 处理，因此把 message 上限单独调大超过 stdout 上限不会生效，需要同时调大 `maxStdoutBytes`。

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
        maxBytes: 16384             # 8KiB–4MiB（实际渲染上限 = 配置 + 4096B）
      scheduler:
        maxConcurrentChecks: 4      # 1–16
        runRetentionDays: 7         # 1–365
        deliveryTimeoutMs: 30000    # 1000–600000（单 target 投递超时）
```

路径覆盖：`configFile`/`dbFile` 可在同一行 config 显式覆盖，省略时为 `<dshHome>/watch/watches.json` 与 `<dshHome>/watch/watch.db`；相对路径按 `$DSH_HOME` 解析。patch 会整体替换该行 config，保存后需要 DSH 重新加载本插件才生效（profile 启用热加载时自动重组，否则重启 DSH 或重新安装）。`watches.json` 的改动不走这条路径，只通过 `/watch-reload` 生效、不需要重启。

## checker 契约

- 执行：`argv` 数组直接执行、**不经过 shell**（不要写 `a | b`、`$(...)` 等 shell 语法；需要管道就写成脚本）。
- 工作目录：`cwd` 或配置文件所在目录；环境变量：`WATCH_ID`、`WATCH_INTERVAL`（秒）、`WATCH_TIMEOUT`（秒）。
- 超时（`timeout` 秒）由插件终止 checker，记为 `timeout`。
- stdout 上限默认 64KB、stderr 上限默认 8KB（可经 `limits.checker.maxStdoutBytes`/`maxStderrBytes` 调整；stderr 尾部写入运行记录）；stdout 超限按 `invalid_json` 处理。
- **只认 stdout 的合法 JSON 对象**（空输出、数组、原始值也算 `invalid_json`）；进程退出码不参与语义（只有进程级失败才记录 `spawn_error`/`timeout`）。
- stdout 是唤醒信号，不是数据通道：正文/大结果应写入文件，message 里只放摘要和文件路径。

| 字段 | 类型 | 说明 |
|---|---|---|
| `notify` | boolean | 必填；true 才会唤醒 |
| `message` | string \| null | 默认 null；`notify=true` 时必须是非空字符串（默认上限 8192 字节，`limits.checker.maxMessageBytes` 可配，且同样受 stdout 上限约束） |
| `error` | string \| null | 默认 null；可选错误说明（默认上限 2048 字节，`limits.checker.maxErrorBytes` 可配）。`notify=true` 时会随唤醒消息显示；`notify=false` 时不会出现在消息里，只写入 runs，可在 `watch_runs` 的 `checker_error`/`last_error` 看到 |

失败分类（都不投递，只写入 runs 记录）：`invalid_json`（非 JSON / 非对象 / stdout 超限）、`invalid_fields`（字段类型或长度非法，或 `notify=true` 但 `message` 为空）、`spawn_error`、`timeout`。合法 JSON 且 `notify:false` 是正常执行（零唤醒、不产生消息），仍可携带 `error`（例如 mailbox 的 IMAP/认证故障；这类运行计入 `watch_runs` 的 `checker_error`，其 `error` 会进 runs/`last_error`）。

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

## 唤醒消息与投递失败补偿

同一轮里，每个 `target` 最多收到一条合并消息（包含该 target 下会被投递的 `notify=true` 事件）：

```text
[WATCH 通知] 2 个事件
--- mail-inbox（interval=60s）---
检测到 2 封新邮件
--- disk-space（interval=300s）---
磁盘使用率 92%
[error] df 返回非零
```

单条消息默认最多列出 20 条事件；`limits.message.maxBytes` 默认 16KiB 是用户可见上限，实际布局上限另加 4096B 自留预算。放不下时丢弃后段，空间允许时标注「另有 N 个事件未列出」。只有**真正写进消息**的 watch 才算投递成功（更新 `last_notify_at`、runs 标记已投递）；被丢弃的事件保持未投递，插件不会自动重放。

- 投递失败只计数、不重试、不重放（记录失败次数、连续失败串、首次失败时间与最后错误）；该 watch 下次成功投递时在消息末尾附一次补偿段（最多 10 行，最后一条错误截 128 字符），被补偿段表示（写出补偿行或被「另有 N 个」汇总行覆盖）的失败记录清零，未表示的保留。
- 为避免事件与补偿互相挤占，渲染内部静默增加 4096B 自留预算（实际消息上限 = `maxBytes + 4096B`）；仍放不下时优先保事件、把该 watch 的补偿延后（失败计数保留，之后能放下时再补）。`watch_runs` 的 `delivery_fail` 是未清零的累计失败次数（非窗口值）。
- 投递成功口径：`followup()` 返回即记为 delivered，不等待宿主持久化；若进程在持久化前崩溃（偶发异常），本轮 DB 仍记成功，checker 的 `last_notified_at` 周期提醒会在下个静默窗口重新投递。

## 工具

**`watch_runs`**（参数 `{ hours?: number }`，默认 3，范围 1–72）：模型看到 `render` 文本表格，列序为 `id | interval | invoke | notified | error | checker_error | invalid_json | invalid_fields | timeout | delivery_fail | last_run | last_notify | last_error`；canonical JSON 是 camelCase 的 `{ hours, since, watches: [{ id, intervalSec, invokeCount, notifiedCount, errorCount, checkerErrorCount, invalidJsonCount, invalidFieldsCount, timeoutCount, deliveryFailCount, lastRunAt, lastNotifyAt, lastError }] }`。`notified` 只算 `notify=1 AND delivered=1`；`error` 是 `status != ok` 的硬失败，`checker_error` 是运行成功但 checker 合法返回了 `error`（如 mailbox 的 IMAP/连接故障）；`delivery_fail`/`last_run`/`last_notify` 取 watch 当前状态、不受 `hours` 窗口限制，而 `last_error` 只取 `hours` 窗口内（优先最近一次硬失败，没有时回退到最近一次 checker error）；列表包含所有启用且未删除的 watch（即使 0 次运行）。

**`watch_sessions`**（无参数）：`render` 表格为 `session_id | running | agent_available | updated_at | cwd`（最多 50 条，按更新时间倒序）；canonical JSON 是 `{ sessions: [{ sessionId, cwd, updatedAt, running, agentAvailable, blank, origin, parentSessionId }], truncated }`（`blank`/`origin`/`parentSessionId` 只在 JSON 里）。用于给 watch 显式指定 `target`；DSH 不暴露归档状态，列表可能包含已归档会话。

## 行为与边界

- 轮询：默认每 10 秒一次（最小 1000ms）；启动后立即轮询一次；上一轮未结束时跳过本轮（单飞）。
- 调度：`now - last_run_at > interval` 才运行；到期 watch 在 `BEGIN IMMEDIATE` 事务里被 claim，多进程共享同一个 DB 也不会重复执行；单轮并发上限默认 4。
- 投递超时：单个 target 的 `resolveAgent`/`followup` 超过 `deliveryTimeoutMs`（默认 30000ms）即按投递失败计数并继续其他 target。
- 无去重、无自动重试：是否“只在变化时提醒”由 checker 自己判断（例如把状态写进自己的文件，无事时输出 `notify:false`）；投递失败只计数，靠下一次成功的投递做一次性补偿。
- 无沙箱：checker 以你的用户身份运行。DSH 必须在运行：插件随 DSH 启停，不依赖系统 cron，也没有 OS 通知。
- 数据落盘与权限：`watch.db` 的 `runs.message` 会保存 checker 输出（mailbox 通知含发件人/主题），插件对 `watch.db` 尽力收紧权限（新建目录 0700，已有目录不强制改；DB/WAL/SHM 尽力设为 0600）；请注意 `$DSH_HOME` 或显式 `dbFile` 所在目录的访问权限。
- 运行记录保留 `runRetentionDays` 天（默认 7）；卸载插件后停止轮询并关闭 DB，配置文件与 DB 仍保留在磁盘上。

## 开发

架构、数据模型、调度/投递语义、Python `mailbox_core` 模块职责、测试与发布流程见 [`docs/development.md`](docs/development.md)。当前版本 **0.3.1**。

## 兼容性

| 项 | 说明 |
|---|---|
| DSH | `^0.2.1-rc.3`（`engines.dsh`） |
| Node | 使用 `node:sqlite`；DSH 0.2.1-rc.3 自带 Node 24.21（Node 22.x 的 sqlite 需要 flag，故要求 ≥24） |
| Python | 仅 mailbox 扩展需要，3.9+（实测 3.9.6 与 3.12）；插件本体是 Node |
| 平台 | macOS / Linux（POSIX）；**Windows 未验证**：checker argv 不经过 shell 可跨平台执行，但 `.sh` checker 需要 bash，建议用 node/python 可执行文件 |
| 依赖 | 无第三方运行时依赖；`@deepseek-ai/dsh-llm`、`dsh-tools`、`schemastery` 由 DSH 按 peerDependencies 提供 |

## 许可

MIT
