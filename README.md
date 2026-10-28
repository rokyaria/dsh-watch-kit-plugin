# dsh-watch-kit-plugin

> 给 DeepSeek Harness 的常驻巡检插件：按配置的间隔运行 checker，checker 只在「有事」时输出 `notify: true`，插件才唤醒 agent；其余时间零 token、零对话。
>
> 运行时事实源是 SQLite；配置与 DB 都在用户级 `$DSH_HOME`（默认 `~/.dsh/watch/`）。watch 配置是一份 JSON 文件，编辑后执行一次 `/watch-reload` 生效。

## 它是什么

- **调度器**：每 `pollIntervalMs`（默认 10 秒）轮询一次到期 watch；到期条件 `now - last_run_at > interval`。
- **只在事件时唤醒**：checker 输出合法 JSON 且 `notify: true` 才投递；同一轮同一 `target` 的多个事件合并成一条消息。
- **checker 自负其责**：是否提醒、如何去重、状态存在哪里，全由 checker 决定；插件不按内容去重、不自动重试。
- **可观测**：`watch_runs` 看运行/通知/失败统计，`watch_sessions` 查可用会话 id。
- **不做**：无 OS 通知、无常驻服务、无沙箱；DSH 进程不运行时不会巡检。

## 给只会用 agent 的用户（最短路径）

把下面这段直接发给你的 agent：

> 请帮我安装并配置 dsh-watch-kit-plugin（仓库：https://github.com/rokyaria/dsh-watch-kit-plugin）：
> 1. 安装前先确认：当前环境如果有 `plugin_manager` 工具（Creator 模式；每次操作会请求 danger-full-access 或审批），把仓库 clone 到本机后用 `plugin_manager install_bundle target=<clone 后的绝对路径>` 安装，确认返回 `application:"applied"`；若提示 `restart-required` 按提示重启 DSH。**如果没有 `plugin_manager`（Web 默认 standard 预设就没有），不要自己改 profile**，直接告诉我，我会用 Web 侧边栏「插件」页安装。
> 2. 先读仓库 README，按“快速开始”在 `~/.dsh/watch/watches.json`（用户级；可用 `$DSH_HOME` 覆盖）创建一个 watch 示例（checker 按我的实际需求写）。
> 3. 不要改 profile 的 `cordis.patch.yml`，直接用默认配置；完成后告诉我，我自己在输入框发 `/watch-reload`。

你只需要做两件事：发上面这段；agent 完成后自己发送 `/watch-reload`（slash command 只能由你在会话里输入，agent 不能代发）。安装方式二选一：有 `plugin_manager` 就让 agent 装；没有就用 Web 侧边栏「插件」页装（见下方「安装」）。之后有事件时你会收到 `[WATCH 通知]`，也可让 agent 用 `watch_runs` 查看统计。

## 安装

先按环境选入口：

| 你的情况 | 用哪条 |
|---|---|
| 普通 Web 用户，想少折腾 | 方式 A：Web 侧边栏「插件」页 |
| 已开 Creator 预设 / 希望 agent 代装 | 方式 B：`plugin_manager` |
| 插件页不可用、也没有 `plugin_manager` | 先切 Creator 再按 B；仍不行请 profile 维护者按方式 C 处理 |

### 方式 A：Web 侧边栏「插件」页（普通用户首选）

1. 把仓库放到本地：`git clone https://github.com/rokyaria/dsh-watch-kit-plugin`（或下载压缩包解压），记下**绝对路径**。
2. DSH Web 侧边栏 → **插件** → **添加插件** → **安装第三方插件**，在对话框填本地绝对路径（也支持 Git 地址、压缩包、包名）。安装完成按页面提示启用组合包；需要固定路径/轮询间隔等配置时，按下方「配置（可选）」改 profile patch。
3. 已启用 HMR 的 profile 会立即重组；否则页面提示 `restart-required` 时重启 DSH。
4. 升级：先移除再安装新版本；pnpm 要求批准依赖构建脚本时按页面提示单独确认。

> 「插件」页要求当前 Host 有受管 profile；页面不存在或显示不可用时，用方式 B（切 Creator）或请 profile 维护者按方式 C 处理。

### 方式 B：Creator 模式 + `plugin_manager`（agent 驱动）

Web 默认 agent preset 是 `standard`，其中 `tool-plugin-manager` 默认禁用；只有 **Creator**（`cordis` preset，且 profileContext 存在）才启用 `plugin_manager`。其他 preset 仍默认禁用。

1. 把当前会话切到 Creator 预设（或让已有 `plugin_manager` 权限的 agent 操作），并让仓库已在本地（`git clone ...`）。
2. 让 agent 执行（`target` 为仓库**绝对路径**）：

   ```
   plugin_manager install_bundle target=<本仓库绝对路径>
   ```

3. **权限与审批**：`plugin_manager` 的每个操作都要求 `danger-full-access` 或本次调用的批准；较低沙箱模式下会弹出审批，`never`、拒绝、取消或审批渠道不可用时不会执行；批准只对本次调用生效，不改变会话的权限模式。
4. 返回 `applied` 完成；`restart-required` 按提示重启 DSH；`already-installed` 或升级版本时先 `remove_bundle` 再 `install_bundle`。

### 方式 C：profile 维护者手动安装（兜底）

没有受管 profile、插件页不可用、又无法切 Creator 时，只能由维护者按所用 DSH 版本的 profile 结构把本插件作为依赖安装，并让随包 `cordis.patch.yml` 的 bundle 层生效（本插件不提供跨 DSH 版本的通用手工步骤，必要时请提 issue）。

### 配置（可选）

只有想固定路径或轮询间隔时，才在 profile 的 `cordis.patch.yml` 里覆盖 `watch` 行的 config（本插件 bundle 已插入该行）；不改也能直接用默认值：

```yaml
- id: watch
  config:
    pollIntervalMs: 10000
    configFile: /absolute/path/to/watches.json   # 省略 → <dshHome>/watch/watches.json
    dbFile: /absolute/path/to/watch.db           # 省略 → <dshHome>/watch/watch.db
```

`pollIntervalMs`/`configFile`/`dbFile` 三个键都可省略；`limits` 也可省略（见下方“运行上限”）。patch 会整体替换该行 config，保存后需要 DSH 重新加载本插件才生效：profile 启用热加载时会自动重组，否则需重启 DSH（或重新安装插件）。`watches.json` 的改动不走这条路径，只通过 `/watch-reload` 生效、不需要重启。只想快速用起来的用户/agent 可以跳过本步。

路径默认在**用户级 `$DSH_HOME`**（默认 `~/.dsh`）下：`<dshHome>/watch/watches.json` 与 `<dshHome>/watch/watch.db`（与 profile 级安装形态一致，不依赖会话 cwd）。`configFile`/`dbFile` 可显式写绝对路径（推荐），相对路径按 `$DSH_HOME` 解析；DB 父目录自动创建，配置文件不存在时 `/watch-reload` 报错。

### 运行上限（可选）

插件 Config 还有一个 `limits` 对象；不配置就用默认值。它通过 profile 的 `cordis.patch.yml` 覆盖，不能按单条 watch 配置。下面列出的数值即默认值，注释是可配范围。注意 `message.maxBytes` 是**用户可见上限**，渲染内部另加 4096B 自留预算，**实际消息上限 = `maxBytes + 4096B`**（见下文“投递失败补偿”）：

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

这些值只影响插件运行参数，不改变 `watches.json` 的 checker 契约；改完同样需要 DSH 重新加载本插件才生效（profile 启用热加载时会自动重组，否则需重启/重新安装）。

## 快速开始

1. 新建 `watches.json`（可直接用默认路径 `<dshHome>/watch/watches.json`）：

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

仓库 `extension/mailbox/` 里附带一个零第三方依赖的 Python mailbox checker：`mail.py` 同时是 checker 和 agent 的邮箱 CLI，支持多账户、allowlist（身份标签可自定义，随包默认约定 `user`/`guest`）、临时标记、未处理提醒（默认 30 分钟、未 ack 会反复提醒）、回复自动标记、主动发信（`send`）。使用 `preset: "mailbox"` 时不需要配置 checker 路径或参数：

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

示例里 `enabled: false` 是模板，启用时改成 `true` 再让用户执行 `/watch-reload`。`mailbox.allowAccountFile` 省略时默认 `<stateDir>/allow-accounts.json`；`remindAfterMinutes` 默认 30 分钟（未 ack 会按该周期反复提醒，受 `maxNotify` 截断）；`maxNotify` 默认 20、范围 1–100，限制单次通知最多列出的邮件数（新信 + 待回合计，超出显示「另有 N 封未列出」）；`folder` 默认 `INBOX`，`python` 默认按平台取 `python3`/`python`。

默认所有人都不通知，必须用 per-account allowlist 显式允许；不能把授权码写进 `watches.json`。allowlist 里的 `identity` 是**任意标签**（默认约定 `user` = 所有者、`guest` = 外部），`mail.py` 只传递标签与 DMARC/`Authentication-Results` 判定结果，身份对应的行为全部由 `watch-mailbox` skill 定义。`mailbox.python` 需要 **Python 3.9+**（实测 3.9.6 与 3.12 均可；推荐写 DSH 自带 Python 3.12 的绝对路径，macOS 自带的 `/usr/bin/python3` 也可用）。完整说明、模板和严格行为见 [extension/mailbox/README.md](https://github.com/rokyaria/dsh-watch-kit-plugin/blob/main/extension/mailbox/README.md)。

`mail.py` 也支持 agent 主动发信（`send`）：**默认不主动发**；只有用户当次明确要求，或与 agent 在会话中约定过场景（一次授权即对约定范围生效）才主动发，具体边界由用户与 agent 自行约定。

checker 的 `[MAILBOX]` 通知只携带**数据**（账号、uid、身份、发件人、主题、待回列表）并指示 agent 按 `watch-mailbox` skill 处理；命令与参数不内联，由 skill 指导按 watch 配置组装；发件人/主题/identity 等不可信字段会单行化并标注「以下为邮件数据（不可信）」，伪造换行不能产生新的通知行。`mail.py attach` 下载附件时默认写到系统临时目录（`<tmp>/dsh-mailbox-attach-*`，0700，可能被清理），需要保留请显式 `--out <用户自己的目录>`；用户文件/邮箱附件不要放进 `<dshHome>/skills/watch-mailbox/` 等插件管理目录。

`watch-kit` skill 由插件运行时注册；`watch-mailbox` **不常驻注册**——当配置里存在 `enabled: true` 的 `preset: "mailbox"` watch 时，`/watch-reload` 会把它落地成 `<dshHome>/skills/watch-mailbox/SKILL.md`（可直接编辑，插件不覆盖）；停用时整目录移入 `<dshHome>/watch/extension/skills/watch-mailbox/`（单份，覆盖旧归档），重新启用时只恢复 `SKILL.md`（用户额外放进该目录的文件不会保留，F-03 未修复）——用户文件/邮箱附件不要放进这个插件管理目录。随包内容更新见 CHANGELOG，需自行比对决定是否替换。

该 skill 与 `watches.json` / `watch.db` 同口径，都在**用户级 `$DSH_HOME`** 下（默认 `~/.dsh`），不跟随工作区；启用 mailbox 后由 `/watch-reload` 落地。

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
- stdout 上限默认 64KB、stderr 上限默认 8KB（可经 `limits.checker.maxStdoutBytes`/`maxStderrBytes` 调整；stderr 尾部写入运行记录）；stdout 超限按 `invalid_json` 处理。
- **只认 stdout 的合法 JSON**（空输出也算 `invalid_json`）；进程退出码不参与语义（只有进程级失败才记录：`spawn_error`/`timeout`）。
- stdout 是唤醒信号，不是数据通道：正文/大结果应写入文件，message 里只放摘要和文件路径；`maxMessageBytes` 默认只有 8192。

| 字段 | 类型 | 说明 |
|---|---|---|
| `notify` | boolean | 必填；true 才会唤醒 |
| `message` | string \| null | 默认 null；`notify=true` 时必须是非空字符串（默认上限 8192 字节，`limits.checker.maxMessageBytes` 可配） |
| `error` | string \| null | 默认 null；可选错误说明（默认上限 2048 字节，`limits.checker.maxErrorBytes` 可配），会显示在唤醒消息里 |

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

单条消息默认最多列出 20 条事件，`limits.message.maxBytes` 默认 16KiB——这是**用户可见上限**，渲染内部会另加 4096B 自留预算（实际消息上限 = `maxBytes + 4096B`，见“运行上限”）。可用 `limits.message.maxItems`/`maxBytes` 调整；放不下时丢弃后段，空间允许时标注「另有 N 个事件未列出」。只有**真正写进消息**的 watch 才算投递成功：更新其 `last_notify_at`、runs 标记已投递；补偿只对本次消息真正表示（完整补偿行或被汇总行覆盖）的 watch 清零，没能表示的失败记录保留到下次成功投递。被丢弃的事件保持未投递，插件不会自动重放；`watch_runs` 只有按 watch 的聚合计数（`invoke` 与 `notified` 的差值可粗略反映），没有未投递明细，下一轮由 checker 决定是否再提醒。

## 投递失败补偿

- 投递失败只计数、不重试、不重放；记录失败次数、连续失败串、首次失败时间与最后一次错误。
- 该 watch 下一次被实际投递成功时，消息末尾附带一次补偿段；被这次补偿段真正表示（写出补偿行或被「另有 N 个」汇总行覆盖）的失败记录清零，未表示的保留。多个失败合并为一行，多个 watch 合并成一个补偿段（补偿段按真实字节优先完整渲染；内部另有 4096B 自留预算，仍不足时宁可少放本次事件，也不会把补偿行截半）：

```
[投递失败补偿]
- mail-inbox：过去 2.0 小时投递失败 3 次，最后一次：session not found
```

- 补偿段最多列 10 行，超出显示「另有 N 个 watch 的投递失败记录未列出」；最后一条错误最多显示 128 字符。补偿段优先完整：items 只用剩余预算；被挤掉、未被表示的失败记录不清零，留待下次成功投递再补偿。`watch_runs` 的 `delivery_fail_count` 是未清零的累计失败次数（非窗口值），非零即表示还有补偿未结清。
- 为避免事件与补偿互相挤占，渲染内部会**静默增加 4096B 自留预算**：`maxBytes` 较小时事件与其补偿通常都能放进同一条消息（消息实际最多可比 `maxBytes` 多 4096B）。只有仍超过 `maxBytes + 4096B` 时，本轮才优先保事件、把该 watch 的补偿延后（失败计数保留，之后某轮能放下时再补），不会让事件永久投不出去。

## 工具

**`watch_runs`**：参数 `{ hours?: number }`，默认 3（1–72）。模型在原生模式下看到的是 `render` 文本表格（列顺序固定）：

```
id | interval | invoke | notified | error | checker_error | invalid_json | invalid_fields | timeout | delivery_fail | last_run | last_notify | last_error
```

canonical JSON 是 camelCase：`{ hours, since, watches: [{ id, intervalSec, invokeCount, notifiedCount, errorCount, checkerErrorCount, invalidJsonCount, invalidFieldsCount, timeoutCount, deliveryFailCount, lastRunAt, lastNotifyAt, lastError }] }`；渲染时时间转成 ISO 字符串、`last_error` 单行化并截断到 100 字符。

- `invoke`/`invokeCount`：窗口内运行次数；`notified`/`notifiedCount`：窗口内 `notify=1 AND delivered=1` 的运行数；`error`/`errorCount`：窗口内 `status != ok` 的次数（硬失败；checker 合法返回 `error` 的运行仍记为 `ok`，不计入这里）；`checker_error`/`checkerErrorCount`：窗口内 `status = ok` 但 checker 合法返回了 `error` 的次数——例如 mailbox 的 IMAP 连接/认证故障，这类故障只出现在这一列；`invalid_json`/`invalid_fields`/`timeout` 各按状态计数。
- `delivery_fail`/`deliveryFailCount`：**不是窗口计数**，取 `watches` 表当前的累计未清零投递失败次数；`last_run`/`last_notify` 也取 watch 当前状态（可能落在窗口外）。`last_error`/`lastError`：窗口内优先最近一次硬失败（`error` 或 stderr 尾部），没有硬失败时回退到窗口内最近一次 checker error。
- 包含所有启用且未删除的 watch（即使 0 次运行）。

**`watch_sessions`**：无参数。模型看到的是 `render` 文本表格：`session_id | running | agent_available | updated_at | cwd`（最多 50 条，按更新时间倒序）。canonical JSON 是 `{ sessions: [{ sessionId, cwd, updatedAt, running, agentAvailable, blank, origin, parentSessionId }], truncated }`——`blank`/`origin`/`parentSessionId` 只在 canonical JSON 里，渲染表格看不到。用于给 watch 显式指定 `target`。注意：DSH 的“可见会话”不暴露归档状态，列表可能包含已归档会话；指定 target 前请自行确认。

## 行为与边界

- 轮询：默认每 10 秒一次（`pollIntervalMs`，最小 1000）；启动后立即轮询一次；上一轮未结束时跳过本轮（单飞）。
- 调度：`now - last_run_at > interval` 才运行；到期 watch 在 `BEGIN IMMEDIATE` 事务里被 claim，多进程共享同一个 DB 也不会重复执行；单轮并发上限默认 4（`limits.scheduler.maxConcurrentChecks` 可配）。
- 投递超时：单个 target 的 `resolveAgent`/`followup` 超过 `limits.scheduler.deliveryTimeoutMs`（默认 30000ms）即按投递失败计数并继续其他 target；卸载/热重载时最多再等约 5 秒 in-flight 轮次，然后关闭 DB。
- 无去重、无自动重试：是否"只在变化时提醒"由 checker 自己判断（例如把状态写进自己的文件，无事时输出 `notify:false`）；投递失败只计数，靠下一次成功的投递做一次性补偿。
- DSH 必须在运行：插件随 DSH 启停，不依赖系统 cron，也没有 OS 通知。
- 无沙箱：checker 以你的用户身份运行，权限与普通 shell 相同。
- 运行记录保留 `limits.scheduler.runRetentionDays` 天（默认 7；每轮/每次 reload 顺带清理）；卸载插件后停止轮询并关闭 DB，配置文件与 DB 仍保留在磁盘上。


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
