# 开发与设计（v0.3.1）

本文面向要修改、审查或二次开发本插件的开发者；安装与日常使用见根目录
[README](../README.md) 与 [install.md](../install.md)。行为以代码和测试为准，
本文解释「为什么这样设计」以及「哪些边界是有意不做的」。

---

## 0. 先读：项目性质与测试边界

### 0.1 这是什么性质的项目

- 一个**单用户、本地、进程内**的常驻巡检插件：DSH Host 进程里每 10s 轮询一次
  SQLite，按到期时间运行用户自己的 checker 子进程；checker 输出 `notify: true`
  时把一条合并消息塞进目标会话。
- 运行时事实源是 SQLite（`<dshHome>/watch/watch.db`），配置是 JSON 文件
  （`<dshHome>/watch/watches.json`），由用户手动发送 `/watch-reload` 同步。
- `extension/mailbox/` 是随包的可选扩展：一个 Python checker + agent CLI，
  用 IMAP 只读检查、SMTP 发信，状态存在 per-account SQLite 里。
- 它不是：系统 cron / 常驻 daemon / 通知网关 / 多租户服务 / 安全沙箱 /
  邮件网关 / 工作流引擎。

### 0.2 典型场景

- 单台机器上一个 DSH 进程；watch 数量从几个到几十个；checker 是用户自己写的
  shell/node/python 脚本；接收会话通常是用户自己的 1 个会话，少量情况下有
  2–3 个 target。
- checker 自己负责「什么时候值得提醒」：把游标/状态写在 checker 自己的文件里，
  没事输出 `{"notify":false}`。
- mailbox 扩展用于「一个邮箱账户一个 watch」：agent 在会话里 read → reply/mark；
  来源验证结果（OK/RISK）只作为数据交给 agent/skill。

### 0.3 独立审查者不要过度理解的边界

以下都是**有意为之**的取舍，不是待修 bug；审查时请按「已知限制」理解：

1. **投递不是 exactly-once**。`followup()` 返回即记 delivered，故意不等待
   `ctx.sessions.flush()`；进程在持久化前崩溃时消息可能丢，由 checker 的
   `last_notified_at` 周期提醒在下一个静默窗口重投。不为此引入重试/确认协议。
2. **没有去重、没有自动重试、没有重放**。checker 输出 `notify=true` 就被唤醒；
   投递失败只计数，靠下一次成功投递做一次性补偿段。
3. **不做跨实例/多租户路由**。多个 DSH 实例共享同一个 DB 时 claim 保证同一
   watch 不会被重复执行，但「哪个实例能把消息送进目标会话」不保证。
4. **没有沙箱**。checker 以当前用户身份运行，权限等同普通 shell；插件不限制
   checker 能做什么，也不校验 checker 的来源。
5. **mailbox 来源验证（OK/RISK）不是密码学边界**。它只读接收方第一条
   `Authentication-Results`；发件人自带的伪造 AR 无法与接收方 AR 区分。结论是
   「能不能确认来源」，不是「邮件是否安全」；所有邮件数据一律按不可信处理。
6. **mail.py 的并发假设**是「插件 Poller 单飞 + agent 在单会话里串行」。不要用
   多个进程对同一 `stateDir` 并发跑 check/reply；SQLite 事务只保证数据不损坏，
   不提供跨进程业务去重。要支持那种拓扑，应在 DB 里做原子 claim，而不是恢复
   文件锁。
7. **投递补偿可能被长期延后**。消息预算不够时会优先保事件、延后该 watch 自己的
   补偿（失败计数保留），配置长期不变时补偿可能一直排不上。事件不会因此被饿死。
8. **`watch_sessions` 可能列出已归档会话**：DSH 的可见会话接口不暴露 archived
   字段，插件无法过滤；指定 target 前请用户自行确认。
9. **Windows 未完整实测**：argv 不经过 shell 可以跨平台执行，但 `.sh` checker
   需要 bash；`.cmd/.bat` 直接 spawn 不可靠。mailbox 扩展理论上跨平台，但没有
   Windows 实机回归。

### 0.4 测试覆盖的边界（测试证明什么、不证明什么）

- Node 测试使用真实的临时 `node:sqlite` DB + **fake host**（commands/tools/skills/
  sessionController/subprocess/timer/logger）。它证明「插件契约/记账/渲染」层面
  的正确性，**不证明**真实 DSH 宿主行为、真实子进程调度、真实会话投递。
- Python 测试使用 **fake IMAP/SMTP**（内存对象）验证解析、状态机、通知文本、
  CLI 契约。它**不证明**真实邮件服务商的兼容性矩阵（Gmail/Fastmail/Outlook 的
  真实 AR 头只以样本形式覆盖）、真实网络错误分类、TLS/证书环境差异。
- 没有测试：真实 DSH 会话、真实 checker 长时间稳定性、multiprocess 并发写、
  系统时区/编码边界（已做 best-effort 处理）、Windows。
- 修改行为时先加/改测试；测试不应弱化「只标记实际投递的 watch」「失败不重试」
  「补偿只清被表示记录」等不变量。

---

## 1. 设计目标与非目标

目标：

- **轻**：只做「定时跑 checker、判断是否唤醒、把事件带进会话」。
- **可靠**：调度状态在 SQLite，进程重启不丢；多实例共享 DB 不重复执行。
- **省 token**：没有事件时不产生任何会话消息。
- **可观测**：运行/通知/失败/checker error/投递失败都能从 `watch_runs` 查到。
- **契约少**：一个命令 `/watch-reload`、两个工具、一份 JSON 配置、一个 checker
  stdout JSON 契约。

明确不做：OS 通知、常驻 daemon、内置 checker 模板库、按内容去重、自动重试、
沙箱、worker thread 池。checker 的「业务正确性」（什么时候该提醒）完全由
checker 负责。

---

## 2. 架构概览

```
watches.json
    │  /watch-reload（读取 + 全量校验 + 事务同步）
    ▼
SQLite: watches / runs
    │
    │  poller：默认每 10s 一轮，单飞
    │  claimDue：BEGIN IMMEDIATE 里选到期行并推进 last_run_at
    ▼
checker argv 子进程（不经过 shell，单轮最多 4 个并发）
    │  stdout JSON {notify, message, error}
    ▼
按 target 合并 → 每个 target 每轮最多一条消息
    │  ctx.sessionController.resolveAgent(target) → agent.followup(createUserMessage(...))
    ▼
runs 记账：delivered / last_notify_at / 投递失败补偿
```

mailbox 扩展链（Python）：

```
watch(preset: mailbox)  ──argv(由插件生成)──▶  extension/mailbox/mail.py check --json ...
                                                     │
                                        mailbox_core/（IMAP 只读 + SQLite 状态）
                                                     │
                                     stdout: {"notify":true,"message":"[MAILBOX] ..."}
                                                     │
                                     插件合并投递 → agent 按 watch-mailbox skill 处理
                                                     │
                              agent 再执行 mail.py read/reply/mark（同一 CLI 的其他子命令）
```

### Node 模块职责

| 文件 | 职责 |
|---|---|
| `lib/index.js` | Cordis 插件入口：解析路径、打开 DB、装配 Poller、注册命令/工具、管理生命周期、投递函数 |
| `lib/config.js` | schemastery Config：`pollIntervalMs`、`configFile`、`dbFile`、`limits` |
| `lib/paths.js` | 解析 `<dshHome>`（显式参数 / `DSH_HOME` / `~/.dsh`）与默认 `configFile`/`dbFile` |
| `lib/db.js` | `WatchDB`：schema、claim、配置同步、runs、投递计数、聚合查询 |
| `lib/checker.js` | 执行 checker、收集 stdout/stderr、处理超时、解析 JSON 契约 |
| `lib/render.js` | 合并消息渲染；返回 `includedIds`/`renderedCompensationIds`/`compensatedIds`/`deferredCompensationIds` |
| `lib/poller.js` | 轮询、并发、投递（含单 target 投递超时）、失败补偿、清理、stop/dispose |
| `lib/commands.js` | `/watch-reload`：配置校验、事务同步、target 绑定、mailbox preset → argv |
| `lib/tools.js` | `watch_runs`、`watch_sessions` 两个模型工具 |
| `lib/skills.js` | 注册运行时 skill `watch-kit` |
| `lib/mailbox-skill.js` | mailbox skill 落地/归档：`<dshHome>/skills/watch-mailbox/` ↔ `<dshHome>/watch/extension/skills/watch-mailbox/` |
| `extension/mailbox/` | 随包 mailbox checker/CLI（Python 3.9+，仅标准库）与 skill、示例 |

依赖注入：`inject = ['commands','tools','skills','sessionController','subprocess','timer']`。

`limits` 是插件级运行上限，通过 apply 注入 Poller/checker/render/cleanup：
`checker.maxStdoutBytes`、`maxStderrBytes`、`maxMessageBytes`、`maxErrorBytes`；
`message.maxItems`、`maxBytes`；`scheduler.maxConcurrentChecks`、`runRetentionDays`、
`deliveryTimeoutMs`。`checker.maxMessageBytes` / `maxErrorBytes` 同时传给 mailbox
preset 的 `mail.py --max-message-bytes` / `--max-error-bytes`。默认值见根 README。

### Python `mailbox_core` 模块职责与依赖

入口 `extension/mailbox/mail.py` 只有约 30 行：把自身目录加入 `sys.path`，然后
`from mailbox_core.cli import main`；`python3 mail.py <subcommand>` 与
`import mail; mail.main([...])` 两种用法都支持。

| 模块 | 职责 |
|---|---|
| `errors.py` | `MailboxError`（用户可读、可行动的错误） |
| `model.py` | 状态常量（ignored/pending/no_receipt/replied/invalid/gone）、来源归一化与展示标签 |
| `text.py` | RFC2047/折行头解码、正文编码回退、单行化、UTF-8 字节裁剪 |
| `config.py` | 默认路径、`mail.env` 解析、`--env-file/--state-dir/--allow-account-file/--folder` → `Settings` |
| `locking.py` | 可移植文件锁（仅 allowlist 读-改-写使用） |
| `allowlist.py` | allowlist 载入/校验/匹配/原子保存、增删规则 |
| `imap.py` | `ssl_context()` 与只读 `Mailbox`（connect/login/select/SEARCH/FETCH/UIDVALIDITY/close） |
| `smtp.py` | `send_email`、附件、`--body/--body-file` 读取 |
| `source.py` | Authentication-Results/DMARC → `ok`/`risk` 的保守判定 |
| `classify.py` | 新邮件分类（allowlist→pending/ignored）、Date 年龄 |
| `state.py` | SQLite 状态库生命周期：schema、`open_state`、事务、scope 管理、权限 |
| `records.py` | messages 表读写：插入/查询/状态流转/touch/prune/聚合 |
| `legacy.py` | v0.2.x JSONL → SQLite 一次性迁移 |
| `notify.py` | `checker_json()`（唯一 stdout 出口）与 `[MAILBOX]` 通知文本 |
| `checker.py` | check 模式流水线（一轮的完整语义见 §8） |
| `cli/` | `parser.py`（argparse）+ `common.py` + `check/inbox/compose/admin` 子命令实现 |

依赖方向（单向，无环）：

```
errors ← text/model ← config/allowlist/source ← classify/state/records/imap/smtp
       ← legacy/notify ← checker ← cli/*
```

约定：网络请求（IMAP/SMTP）期间绝不持有 SQLite 事务；写操作都是本地小事务。
`state.py` 管「库/scope/事务」，`records.py` 管「message 行」，二者都可被 CLI 与
checker 复用。

---

## 3. 运行时存储（watch.db）

`watches` 存配置和运行状态，`runs` 是追加式执行历史：

```sql
CREATE TABLE watches (
  id TEXT PRIMARY KEY,
  checker TEXT NOT NULL,          -- JSON 字符串：argv 数组
  cwd TEXT,
  interval_ms INTEGER NOT NULL,
  timeout_ms INTEGER NOT NULL,
  target TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  is_deleted INTEGER NOT NULL DEFAULT 0,
  last_run_at INTEGER,
  last_notify_at INTEGER,
  delivery_fail_count INTEGER NOT NULL DEFAULT 0,
  delivery_fail_streak INTEGER NOT NULL DEFAULT 0,
  delivery_first_fail_at INTEGER,
  last_delivery_error TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  watch_id TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  status TEXT NOT NULL,
  notify INTEGER NOT NULL DEFAULT 0,
  message TEXT,
  error TEXT,
  duration_ms INTEGER,
  stderr_tail TEXT,
  delivered INTEGER NOT NULL DEFAULT 0
);
```

关键不变量：

- **`last_run_at` 与 `last_notify_at` 分离。** `last_run_at` 在 claim 时推进（表示
  「这一轮跑过了」），`last_notify_at` 只有投递成功才更新。到期条件只看
  `last_run_at`。
- **claim 是原子事务。** `claimDue(now)` 在 `BEGIN IMMEDIATE` 里选
  `enabled=1 AND is_deleted=0 AND target IS NOT NULL AND (last_run_at IS NULL OR
  now-last_run_at > interval_ms)` 的行并把 `last_run_at=now`；共享 DB 时同一行
  只会被一个事务认领。
- **软删除保留历史。** 配置中删除的 watch 置 `is_deleted=1, enabled=0`，runs 不删；
  重新出现时恢复。
- **WAL + 小事务。** `journal_mode=WAL`、`busy_timeout=5000`、`synchronous=NORMAL`；
  `node:sqlite` 是同步 API，事务必须小，不能长时间阻塞 host 事件循环。
- **文件权限（best-effort）**：新建的状态目录按 0700 创建，watch.db 及 WAL/SHM
  尽力 chmod 到 0600；`runs.message` 会保存 checker 输出的摘要（mailbox 通知含
  发件人/主题），共享 `DSH_HOME`/显式 `dbFile` 时请自行确认目录权限。
- **schema 版本**：新库 `user_version=1`；打开时只接受 0（初始化成 1）或 1，更高
  版本拒绝，防止误开未来 schema。
- **runs 保留 `scheduler.runRetentionDays` 天（默认 7）**：每轮 poll 和每次
  `/watch-reload` 清理。
- **SQL 变量上限**：投递记账只操作实际被投递的 watch（默认 ≤20）；`applyConfig`
  的软删除用 `NOT IN (...)`，条目数极大（>900）时退化为「读现有 id + 逐行软删除」
  （语义等价）；其它多 id 记账语句按小块执行，避免 SQLite 单语句参数上限。

---

## 4. 配置与 `/watch-reload`

配置文件是唯一编辑入口，DB 是运行时事实源；启动不自动导入配置。

```json
{
  "watches": [
    {
      "id": "mail-inbox",
      "checker": ["bash", "/abs/path/check-mail.sh"],
      "cwd": "/abs/path",
      "interval": 60,
      "timeout": 30,
      "target": "session-id",
      "enabled": true
    }
  ]
}
```

- `id`：1–64 字符、无空白、唯一。
- `checker`：非空字符串数组，直接 argv 执行，不经过 shell。
- `cwd`：可选；相对路径按配置文件所在目录解析；省略时用配置文件所在目录。
- `interval` / `timeout`：秒，>0；默认 60 / 30，转 ms 时四舍五入。
- `target`：可选；省略时新 watch 绑定执行 `/watch-reload` 的会话 id，已有 watch
  （含软删除后复活）保持原 target。
- `enabled`：默认 true；未知字段忽略。
- `preset: "mailbox"`：不写 checker，由插件生成 mail.py argv（见 §10）。

`/watch-reload` 行为：

1. 读取整份文件；读不到或 JSON 非法 → error，DB 不变。
2. 校验全部条目；任一条非法 → 整份不生效（all-or-nothing）。
3. 在事务里按 id upsert；文件中缺失的 watch 软删除；出现的旧 watch 复活。
4. 缺 target 且无法确定调用会话时 → 报错，DB 不变。
5. 成功后按 `scheduler.runRetentionDays` 清理 runs，立即触发一次 poll，并按
   mailbox 是否启用同步 `watch-mailbox` skill 文件。

---

## 5. 调度与生命周期

`apply(ctx, config)` 是 async 的：

1. 解析 `configFile`/`dbFile`：显式值优先；相对路径按 `$DSH_HOME` 解析；默认
   `<dshHome>/watch/watches.json` 与 `<dshHome>/watch/watch.db`。
2. `mkdir -p` 父目录、打开 `WatchDB`、装配 `Poller`。
3. 注册 `/watch-reload`、`watch_runs`、`watch_sessions`，安装 interval effect，
   并立即 poll 一次。
4. 注册阶段任何异常 → 关闭已打开的 DB/poller 后再抛出，避免句柄泄漏。

`Poller`：

- `poll()` 单飞：上一轮未完成时复用同一个 Promise；`stop` 后不再开新轮。
- 每轮先 `claimDue`；到期 checker 分块并发执行（默认 4）。
- checker 跑完后**重新读 DB**：跑的过程中被软删除/停用/改 target 的事件丢弃。
- 按 target 分组投递；单个 target 的渲染/记账异常不影响其他 target。
- `dispose()`：置 stopped、abort 正在运行的 checker、清 interval；当前轮最多再等
  约 5s，之后强制关闭 DB（保证 `db.close` 恰好一次）。

多实例共享 DB：claim 保证不重复执行；跨实例会话可见性/通知目标不保证。

---

## 6. checker 执行与 JSON 契约

执行：

- `ctx.subprocess.spawn({ argv, cwd, env, stdio, graceMs: 2000, signal })`，argv 不
  经过 shell。
- `cwd = watch.cwd ?? dirname(configFile)`。
- 环境变量：`WATCH_ID`、`WATCH_INTERVAL`（秒）、`WATCH_TIMEOUT`（秒），值必须是
  字符串。
- stdout 默认 ≤64KB、stderr 默认 ≤8KB（`limits.checker` 可调）；stderr 尾部写入
  runs。
- 超时（`timeout` 秒）由插件 `terminate()`，记为 `timeout`；进程不退出还有兜底
  give-up 计时。
- **退出码不参与语义**，只看 stdout。
- 只认 stdout 的合法 JSON 对象；空输出、数组、原始值、非 JSON、stdout 超限
  （`lossy`）都算失败。
- stdout 是唤醒信号，不是数据通道：正文/大结果应写文件，message 只放摘要/路径。

JSON 字段：

| 字段 | 类型 | 规则 |
|---|---|---|
| `notify` | boolean | 必填；true 才投递 |
| `message` | string \| null | 默认 null；`notify=true` 时必须非空，默认 ≤8192B |
| `error` | string \| null | 默认 null；默认 ≤2048B；只作为消息里的错误说明 |

失败分类（都写 runs，不投递）：`ok`、`invalid_json`、`invalid_fields`、
`spawn_error`、`timeout`。`ok` 且 `notify=false` 也是正常执行；`ok` 仍可携带
checker 返回的 `error`（例如 mailbox 的 IMAP/认证故障），这类运行计入
`watch_runs.checkerErrorCount`，不计入 `errorCount`。

---

## 7. 合并消息、投递与补偿

- 同一轮同一 target 的 `notify=true` 事件合并成一条；不同 target 各自一条。
- 默认最多 20 个事件；`limits.message.maxBytes` 默认 16KB 是**用户可见上限**，
  渲染内部实际布局/上限 = `maxBytes + RENDER_HEADROOM_BYTES`（4096B 自留预算）。
  放不下的后段丢弃；空间允许时追加「另有 N 个事件未列出」。
- 渲染器按真实字节优先保证补偿段完整，返回
  `{ text, includedIds, truncated, renderedCompensationIds, compensatedIds, deferredCompensationIds }`。
  「事件优先回退」：候选连带自身补偿放不下、而「标题+完整补偿段」自身放得下时，
  先把该 watch 补偿放入 deferred 再试；成功则保事件、补偿下一轮再补。不变式：
  `renderedCompensationIds ⊆ compensatedIds ⊆ includedIds`；
  `deferredCompensationIds ⊆ includedIds` 且与 `compensatedIds` 互斥。
- **只有 `includedIds` 中的 watch 才算投递成功**：标记 runs.delivered、更新
  `last_notify_at`。失败计数只对 `compensatedIds` 覆盖的 watch 清零。
- 投递失败（resolveAgent/followup 异常或超时）：只对消息里实际包含的 watch 增加
  `delivery_fail_count/streak`、记录首次失败时间与最后错误；不重试、不重放。
- 下一次实际投递成功时，消息末尾补偿一次失败统计（最多 10 行、错误截断 128
  字符）；被表示的记录清零，未表示的保留。
- **投递成功口径（已接受特性）**：`followup()` 返回即记 delivered，故意不等待
  `ctx.sessions.flush()`；未持久化/崩溃属偶发异常，依赖 checker 的
  `last_notified_at` 周期提醒在后续静默窗口重投。

这些不变量有专门回归测试（超 20 条/超预算时的 omitted watch 必须保持未投递；
DB 写失败不能导致整轮静默丢失等）。

---

## 8. mailbox checker（`mail.py check`）一轮的语义

顺序（任何一步失败都只影响本步，stdout 始终只有一个 JSON）：

1. 连接 IMAP（只读）→ `SEARCH ALL` 取全部 UID。**SEARCH 失败不修改任何状态**。
2. 打开状态库（必要时迁移旧 JSONL）→ prune `first_seen_at` 超过 31 天的行。
3. 首次运行（scope 的 `baseline_done=0`）：**建立基线**——当前 UID 全部写
   `ignored`，不通知。`--notify-existing` 则跳过基线，把当前邮件当新信。
4. 对「库里没有的 UID」拉邮件头 → 分类 → 落库：
   - 单轮最多 FETCH 200 个新 UID（内部常量 `MAX_NEW_FETCH_PER_RUN`；测试可用隐藏
     参数 `--max-new-fetch N` 覆盖），剩余下一轮继续；
   - FETCH 临时失败不落库，下一轮仍是「新邮件」，自动重试；
   - 解析/分类失败落 `invalid`（保留 last_error），不影响同轮其他邮件；
   - `Date` 超过 30 天的新邮件直接 `ignored`（不通知），避免 prune 后把仍留在
     INBOX 的旧邮件重新当新信；`Date` 缺失/非法不做年龄过滤。
5. 找出 `pending` 且到提醒周期的邮件：
   - `Date` 超过 30 天 → `ignored`；
   - allowlist 被收紧后不再匹配 → `ignored`；
   - `last_notified_at IS NULL` 或距上次 ≥ `remindAfterMinutes` → due；
   - 按 uid 排序取前 `--max-notify` 条（1–100 clamp），其余显示「另有 N 封」。
6. 先 `touch_notified`（记录本轮已通知），再输出 `{"notify":true,...}`；没有
   due 则 `{"notify":false,...}`，可带 error 附注（读取失败/解析失败计数，
   按 `--max-error-bytes` 裁剪）。
7. 通知里的「新信 / 待处理」按**是否曾通知过**划分：`last_notified_at IS NULL`
   → 新信；否则 → 待处理（已通知但未标记）。不能用「本轮是否新插入」划分，
   否则达到 `--max-notify` / FETCH 上限被截断的邮件下一轮会被误标为“已通知”。

其它保障：

- stdout 只允许 `checker_json()` 输出；人类日志全部 stderr。
- 失败时 `error` 按 `--max-error-bytes`（默认 2048，插件透传
  `limits.checker.maxErrorBytes`）裁剪，避免超过插件上限被判 `invalid_fields`。
- stdout/stderr 强制 UTF-8（`sys.stdout.reconfigure`），Windows/重定向下中文与
  JSON 不乱码。
- 迁移/来源归一化只在必要时写库（source 脏值检查、无脏值零写入）。

---

## 9. CLI（mail.py）契约

`python3 mail.py <subcommand> [common opts]`，公共参数：`--env-file`、
`--state-dir`、`--allow-account-file`、`--folder`（均可由 `MAILBOX_*` 环境变量或
默认值提供）。

| 子命令 | 作用 | 是否改状态 |
|---|---|---|
| `check` | checker 模式，stdout 一个 JSON | 会（状态机推进） |
| `list [--pending] [--limit N]` | 列状态记录 | 否 |
| `read --uid N` | 读整封邮件 + 来源详情 | 否 |
| `reply --uid N (--body/--body-file)` | 回复；成功自动标 replied（`--no-mark` 关闭） | 是 |
| `send --to --subject (--body/--body-file)` | 主动发新邮件 | 否 |
| `mark --uid N [--uid M...]` | 标 no_receipt；先整体校验再一个事务写入 | 是 |
| `attach --uid N [--list-only] [--out DIR]` | 列/下载附件；默认写系统临时目录 | 否 |
| `status` | 账号/路径/状态计数/来源计数/allowlist | 否 |
| `allow --list \| --add-allow-account A [--identity X] \| --remove-allow-account A` | 维护 allowlist | 文件 |
| `init [--notify-existing] [--force]` | 重建基线 | 是 |
| `selfcheck` | SMTP/IMAP 连通性 | 否 |

退出码：成功 0；`MailboxError`/其它异常 2（stderr `ERROR: ...`）；check 模式永远
返回 0（错误在 JSON 里）。多 uid 的 `mark` 是 all-or-nothing：任一 uid 不存在或
状态不允许时零写入。`--json` 是兼容参数（check 总是输出 JSON）。`--attach` 文件、
`--out` 目录都属于用户文件，不要放进插件托管目录。

---

## 10. mailbox preset 与 skill 落地

配置里的 `preset: "mailbox"` 由 `lib/commands.js` 映射成 argv：

```
<python> <repo>/extension/mailbox/mail.py check --json
  --env-file ... --state-dir ... --allow-account-file ...
  --remind-minutes N --max-notify N --max-message-bytes N
  --folder INBOX --max-error-bytes N
```

- `python`：默认按平台 `python3`/`python`；可显式写绝对路径（推荐 DSH 捆绑
  Python 3.12）。
- `stateDir` 可共享，脚本按 `MAIL_ADDRESS` 生成 `<stateDir>/<account>.sqlite3`。
- `allowAccountFile` 省略 → `<stateDir>/allow-accounts.json`。
- `enabled: true` 的 mailbox watch 会让 `/watch-reload` 把 mailbox skill 落地到
  `<dshHome>/skills/watch-mailbox/SKILL.md`；停用时整目录归档到
  `<dshHome>/watch/extension/skills/watch-mailbox/`；重新启用时整目录恢复。
  插件不覆盖用户对 SKILL.md 的修改。

---

## 11. 宿主 API 与打包约束

在 DSH 0.2.1-rc.3（Electron 44.7 / Node 24.21）上验证过的关键事实：

- **`node:sqlite` 可用**，无需 flag；`DatabaseSync` 同步、会阻塞 host 事件循环；
  WAL、`BEGIN IMMEDIATE`、`busy_timeout`、`user_version` 可用。DB 必须是真实
  文件系统路径，不能放 asar 内。
- **`ctx.subprocess.spawn`**：argv/cwd/env/stdio/graceMs/signal 符合用法；`env`
  值必须是字符串；`readFrom(0)` 返回 `{ text, lossy }`，必须检查 `lossy`；超时
  由插件自己 `terminate()`。
- **`defineTool`**：`output: { schema: { type: 'json' }, render }` 合法；
  `parameters` 必填；默认值在 `execute` 里实现。
- **`ctx.commands.register`**：命令名匹配 `/^[a-z][a-z0-9_-]*$/`，`description`
  非空，handler 返回 `{kind:'success'|'error', text}`；invocation 里有 `agent` /
  `signal`。
- **`ctx.sessionController.list`**：`list(request, signal)` 返回
  `{items: SessionSummary[]}`；`signal` 类型上必须；visible ≠ unarchived。
- **`$DSH_HOME`**：运行时状态默认放 `$DSH_HOME/watch/`，不解析 workspace cwd。
- **打包**：`@deepseek-ai/dsh-llm`、`dsh-tools`、`schemastery` 放
  `peerDependencies`（不是 `dependencies`），配合 `engines.dsh`；本地开发需要
  `devDependencies` + `pnpm install`。

已知平台/运行时限制：Windows 无 shell 语义（`.sh` 需要 bash；`.cmd/.bat` 直接
spawn 不可靠；建议 node/python 可执行文件）；无 worker thread，调度器单线程，
checker 是 OS 子进程。

---

## 12. 测试策略与命令

```bash
# Node（需要仓库 devDependencies；本机 PATH 可能没有 node，用 DSH 自带 Node）
# 示例绝对路径：~/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node
node --test test/*.test.mjs

# Python（3.9+；推荐同时跑 3.9 与 DSH 捆绑的 3.12）
python3 -m unittest discover -s test/python -v
/usr/bin/python3 -m unittest discover -s test/python -v
```

v0.3.1 的基线：Node 114 个测试、Python 262 个测试（3.12 / 3.9 双绿）。

- Node：真实临时 `node:sqlite` DB + fake host；不依赖网络/真实会话；涉及
  `/watch-reload` 的测试把 `DSH_HOME` 指向临时目录；含一条 JS↔Python 的 mailbox
  argv 互验测试（生成 argv → 调 Python parser 校验，无 Python 时 skip）。
- 覆盖重点：schema/claim 事务/多连接不重复 claim、软删除/复活、JSON 契约/失败
  分类/字节上限、合并消息/补偿/128 字符/10 行、超限截断记账、4096B 自留预算与
  事件优先、单条失败错误隔离、reload 原子性/target 绑定、watch_runs 窗口/聚合/
  checker error 可见性、watch_sessions signal/排序/50 条、async apply/默认路径/
  有界 dispose、投递超时自愈、真实 DB 端到端、mailbox preset argv。
- Python：`test/python/support/` 提供 FakeIMAP/FakeSMTP 与 `run_cli` harness，
  测试按模块拆分（CLI 契约、checker 流水线、状态库、迁移、来源判定、分类、文本、
  allowlist/config、通知文本）；不依赖真实网络或 `~/.dsh`。
- 修改行为时先加/改测试；测试不应弱化核心不变量。

---

## 13. 已知缺陷与取舍（v0.3.1）

1. **补偿完整优先 + 自留预算/事件优先兜底**：渲染内部静默使用
   `maxBytes + 4096B` 的实际上限；仍放不下时优先保事件、把该 watch 补偿延后
   （失败计数保留）。配置长期不变时被延后的补偿可能持续无法渲染，但事件不会
   饿死。多 target/多 watch 的公平性（轮转）未做。
2. **未来 schema 的 DB**：`user_version > 1` 会拒绝，但打开时可能已经执行 WAL/
   建表语句；正常版本（0/1）不受影响。
3. **用户级状态**：默认所有 watch 共用 `$DSH_HOME/watch/`；需要按项目隔离时显式
   写 `configFile`/`dbFile`。旧版工作区 `.dsh/watch/` 不自动迁移。
4. **归档会话不可见**：DSH 不暴露 archived 字段，`watch_sessions` 可能列出归档
   会话；需要用户自行确认。
5. **无自动去重/重试**：checker 要自己维护状态；投递失败只做一次性补偿。
6. **同步 SQLite**：极端写竞争下 `busy_timeout=5000` 可能让 host 事件循环阻塞
   至多 5s。
7. **多实例**：共享 DB 不重复执行，但跨实例会话可见性/通知目标不保证。
8. **Windows**：见 §11，未做完整实测。
9. **mail.py 单实例假设**：不要多个进程对同一 stateDir 并发 check/reply；SQLite
   事务只保证数据不损坏，不提供跨进程业务去重。
10. **UIDVALIDITY 缺失（=0）**：部分服务器不返回 UIDVALIDITY 时，scope 无法区分
    服务器端重置；可能把重置后的邮件当新信处理（仍受 Date 30 天与 allowlist
    过滤约束）。
11. **`Date` 缺失/非法**：不做年龄过滤，prune（31 天）后仍留在 INBOX 的旧邮件
    理论上可能再次被当成新信；需要服务商提供正常 Date。
12. **mailbox skill 归档**：整目录归档/恢复，不保留多份历史；用户在插件托管
    目录里放的文件会随目录移动（这是有意的“保留用户文件”行为）。

---

## 14. 版本迁移

- v0.1 → v0.2.1 是破坏性重写：旧管理命令、watch 目录、校验流程、skill、随包
  docs/assets/examples 均不再读取；旧用户把 watch 改写成 `watches.json` 后执行
  一次 `/watch-reload`。
- v0.2.8 → v0.3.0：mailbox 状态从 JSONL 自动迁移到 per-UID SQLite；旧
  `temp`/`acked` 映射为 `pending`/`replied`，旧 `source=ok` 降为 `risk`；状态行
  只保留 31 天，`Date` 超过 30 天的邮件不再处理；来源验证改为 OK/RISK 两态；
  mailbox skill 改为整目录归档/恢复。
- v0.3.0 → v0.3.1：把单文件 `mail.py` 拆成 `mail.py` 入口 + `mailbox_core/` 包；
  示例模板从 `extension/mailbox/` 根移到 `extension/mailbox/examples/`；新增
  `check --max-error-bytes`（插件透传 `limits.checker.maxErrorBytes`）与单轮
  FETCH 上限；mail.py 的 CLI/状态机/通知格式保持不变。升级不需要迁移数据，
  但如果你在自己的脚本里引用了旧模板路径，请改用 `examples/` 下的新路径。

---

## 15. 发布流程

发布前检查：

1. `pnpm install --frozen-lockfile`
2. 用 DSH 自带 Node 跑 `node --test test/*.test.mjs`（必须全绿）
3. `python3 -m unittest discover -s test/python -v`（3.12 与 3.9 均全绿）
4. `pnpm pack` 检查 tarball 文件清单（lib/docs/locale/icon/cordis.patch.yml/
   README/install/CHANGELOG/LICENSE + extension/skills + `extension/mailbox/
   mailbox_core/`；不含 `__pycache__`/test）
5. 用 `plugin_manager install_bundle`（Creator 模式）或 Web 侧边栏「插件」页从
   仓库绝对路径安装，确认 `application:"applied"`、`warnings:[]`、version 正确；
   注意安装是「先 remove_bundle 再 install_bundle」才有可重复的升级结果
6. 确认 Config schema 为 4 个顶层键（`pollIntervalMs`/`configFile`/`dbFile`/
   `limits`，`limits` 下 `checker`/`message`/`scheduler`）、`watch_runs`/
   `watch_sessions` live、`watch-kit` skill 已由运行时注册、`watch-mailbox` 已
   落地为 `<dshHome>/skills/watch-mailbox/SKILL.md`（不常驻注册）
7. `remove_bundle` 后 profile 文件恢复一致
8. fresh clone（无 `node_modules`）再安装一次，验证 peer 解析
9. 更新版本、CHANGELOG、tag，并推送 main/tag
