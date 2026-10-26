# 开发与设计

本文面向需要修改、审查或二次开发本插件的开发者；安装与日常使用请看根目录的 [README](../README.md)。

## 1. 设计目标

- **轻**：插件只做“定时跑 checker、判断是否唤醒、把事件带进会话”这一件事。
- **可靠**：调度状态在 SQLite 里，进程重启不丢；多 DSH 实例共享同一个 DB 时也不会重复执行。
- **省 token**：没有事件时不产生任何会话消息；checker 是否去重、状态存在哪里，由 checker 自己决定。
- **可观测**：运行、通知、失败、投递失败都能从 `watch_runs` 和 runs 表查到。
- **契约少**：一个命令 `/watch-reload`、两个工具、一份 JSON 配置、一个 checker stdout JSON 契约。

明确不做：OS 通知、常驻 daemon、内置 checker 模板库、按内容去重、自动重试、沙箱、worker thread 池。checker 的“业务正确性”（什么时候该提醒）完全由 checker 负责。

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

### 模块职责

| 文件 | 职责 |
|---|---|
| `lib/index.js` | Cordis 插件入口：解析路径、打开 DB、装配 Poller、注册命令/工具、管理生命周期 |
| `lib/config.js` | schemastery Config：`pollIntervalMs`、`configFile`、`dbFile` |
| `lib/db.js` | `WatchDB`：schema、claim、配置同步、runs、投递计数、聚合查询 |
| `lib/checker.js` | 执行 checker、收集 stdout/stderr、处理超时、解析 JSON 契约 |
| `lib/render.js` | 合并消息渲染；返回 `includedIds`，供投递记账使用 |
| `lib/poller.js` | 轮询、并发、投递、失败补偿、清理、stop/dispose |
| `lib/commands.js` | `/watch-reload`：配置校验、事务同步、target 绑定 |
| `lib/tools.js` | `watch_runs`、`watch_sessions` 两个模型工具 |

依赖注入：`inject = ['commands','tools','sessionController','subprocess','timer','workingDirectory']`。没有 skill，没有旧命令，没有随包模板。

## 3. 运行时存储

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

- **`last_run_at` 与 `last_notify_at` 分离。** `last_run_at` 在 claim 时推进（表示“这一轮跑过了”），`last_notify_at` 只有投递成功才更新。到期条件只看 `last_run_at`，避免“没事件 → 永远不算跑过 → 每轮都跑”的重复执行。
- **claim 是原子事务。** `claimDue(now)` 在 `BEGIN IMMEDIATE` 里选出 `enabled=1 AND is_deleted=0 AND target IS NOT NULL AND (last_run_at IS NULL OR now-last_run_at > interval_ms)` 的行，并把 `last_run_at=now`；多进程共享 DB 时同一行只会被一个事务认领。
- **软删除保留历史。** 配置中删除的 watch 置 `is_deleted=1, enabled=0`，runs 不删；重新出现时恢复。
- **WAL + 小事务。** `PRAGMA journal_mode=WAL`、`busy_timeout=5000`、`synchronous=NORMAL`；`node:sqlite` 是同步 API，事务必须小，不能长时间阻塞 host 事件循环。
- **schema 版本**：新库 `user_version=1`；打开时只接受 0（初始化成 1）或 1，更高版本拒绝，防止误开未来 schema。
- **runs 保留 7 天**：每轮 poll 和每次 `/watch-reload` 都会清理 `started_at < now-7d` 的行。
- **SQL 变量上限**：投递记账只操作实际被投递的 watch（默认 ≤20），避免单个 target 事件很多时撞上 SQLite 的 parameter limit；配置行数特别大时仍需注意 `IN (...)` 的边界。

## 4. 配置模型与 `/watch-reload`

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
- `cwd`：可选；相对路径按配置文件所在目录解析。
- `interval` / `timeout`：秒，>0；分别默认 60 / 30，转成 ms 时四舍五入。
- `target`：可选；省略时新 watch 绑定执行 `/watch-reload` 的会话 id，已有 watch（包括软删除后复活）保持原 target。
- `enabled`：默认 true；未知字段忽略。

`/watch-reload` 的行为：

1. 读取整份文件；读不到或 JSON 非法 → 返回 error，DB 不变。
2. 校验全部条目；任一条非法 → 整份不生效（all-or-nothing）。
3. 在事务里按 id upsert；文件中缺失的 watch 软删除；出现的旧 watch 复活。
4. 缺 target 且无法确定调用会话时 → 报错，DB 不变。
5. 成功后清理 7 天前 runs，并立即触发一次 poll（新 watch 的 `last_run_at` 为空，会马上运行）。

## 5. 调度与生命周期

`apply(ctx, config)` 是 **async** 的：

1. 决定 workspace：如果 `configFile` 和 `dbFile` 都显式给了，直接用；否则尝试从 `ctx.sessionController.list` 找最近一个可见会话的 `cwd`，取不到再用 `ctx.workingDirectory.defaultDirectory`，最后退回 `process.cwd()`。
2. 解析并 trim `configFile` / `dbFile`；相对路径按 workspace 解析；默认 `<workspace>/.dsh/watch/watches.json` 与 `<workspace>/.dsh/watch/watch.db`。
3. `mkdir -p` 父目录，打开 `WatchDB`，装配 `Poller`。
4. 注册 `/watch-reload`、`watch_runs`、`watch_sessions`，安装 interval effect；安装后立即 poll 一次。
5. 注册阶段任何异常 → 关闭已打开的 DB/poller 后再抛出，避免泄漏。

`Poller`：

- `poll()` 单飞：上一轮未完成时复用同一个 Promise。
- 每轮先 `claimDue`；到期 checker 分块并发执行，上限 4。
- checker 跑完后**重新读 DB**：跑的过程中被软删除、停用或改 target 的事件丢弃，不投递。
- 按 target 分组投递；单个 target 的渲染/记账异常不影响其他 target。
- `dispose()`：置 stopped、abort 正在运行的 checker、清 interval；如果当前轮还在跑，等当前轮结束再关闭 DB。

多 DSH 实例共享同一个 DB 时：claim 保证不重复执行；但投递目标是否可见取决于各实例的会话状态，不保证跨实例通知。

## 6. checker 执行与 JSON 契约

执行：

- `ctx.subprocess.spawn({ argv, cwd, env, stdio, graceMs: 2000, signal })`，argv 不经过 shell。
- `cwd = watch.cwd ?? dirname(configFile)`。
- 环境变量：`WATCH_ID`、`WATCH_INTERVAL`（秒）、`WATCH_TIMEOUT`（秒），值必须是字符串（宿主会校验）。
- stdout 最多 64KB，stderr 最多 8KB；stderr 尾部写入 runs。
- 超时（`timeout` 秒）由插件调用 `handle.terminate()`，记为 `timeout`；进程不退出时还有兜底 give-up 计时。
- **退出码不参与语义**，只看 stdout。
- 只认 stdout 的合法 JSON 对象；空输出、数组、原始值、非 JSON、stdout 超限（`lossy`）都算失败。

JSON 字段：

| 字段 | 类型 | 规则 |
|---|---|---|
| `notify` | boolean | 必填；true 才投递 |
| `message` | string \| null | 默认 null；`notify=true` 时必须非空，≤8192 字节 |
| `error` | string \| null | 默认 null；≤2048 字节；只作为消息里的错误说明 |

状态分类（都写 runs，不投递）：`ok`、`invalid_json`、`invalid_fields`、`spawn_error`、`timeout`。`ok` 且 `notify=false` 也是一次正常执行，零唤醒。

## 7. 合并消息与投递记账

- 同一轮同一 target 的所有 `notify=true` 事件合并成一条消息；不同 target 各自一条。
- 渲染上限：最多 20 个事件、最多 16KB。放不下的后段丢弃；空间允许时追加“另有 N 个事件未列出”。
- 渲染器为补偿段预留空间，并返回 `{ text, includedIds, truncated }`。**只有 `includedIds` 中的 watch 才算投递成功**：标记 runs.delivered、更新 `last_notify_at`、清补偿。被丢弃的事件保持 `delivered=0`，在 `watch_runs` 可见，由 checker 下一轮决定是否再次提醒。
- 投递失败（resolveAgent/followup 异常）：只对实际包含在消息里的 watch 增加 `delivery_fail_count/streak`、记录首次失败时间和最后错误；不重试、不重放。
- 该 watch 下一次**实际投递成功**时，消息末尾补偿一次失败统计，然后清零；错误截断 128 字符，最多 10 行。
- 成功记账是一个事务；失败计数也是事务；`recordRun` 或单个 target 记账失败只记日志，不中断整轮。
- 这些不变量有专门的回归测试：超 20 条/16KB 时 omitted watch 必须保持未投递；DB 写失败/记账失败不能导致整轮静默丢失。

## 8. 工具

`watch_runs({ hours?: 1–72, default 3 })`：

- 输出每个启用且未删除 watch 的 `intervalSec, invokeCount, notifiedCount, errorCount, invalidJsonCount, invalidFieldsCount, timeoutCount, deliveryFailCount, lastRunAt, lastNotifyAt, lastError`。
- `notifiedCount` 只统计 `notify=1 AND delivered=1`；`lastError` 只取请求窗口内最近的非 ok 记录。

`watch_sessions()`：

- 调用 `ctx.sessionController.list({}, exec.signal ?? AbortSignal.timeout(5000))`，返回 `sessionId, cwd, updatedAt, running, agentAvailable, blank, origin, parentSessionId`，按 updatedAt 倒序，最多 50 条。
- 不暴露 archived 字段，因此无法过滤已归档会话；blank 会话保留（可以作为 target）。

两个工具都用 `defineTool`：`parameters` 是属性 map（无参数传 `{}`），`output.schema = { type: 'json' }`，必须提供 `render(args, value)`；`ctx.tools.register` 返回 disposer。

## 9. 宿主 API 与打包约束

在 DSH 0.2.1-rc.3（Electron 44.7 / Node 24.21）上验证过的关键事实：

- **`node:sqlite` 可用**，无需 flag；`DatabaseSync` 同步、会阻塞 host 事件循环；WAL、`BEGIN IMMEDIATE`、`busy_timeout`、`user_version` 都可用。DB 必须是真实文件系统路径，不能放 asar 内。
- **`ctx.subprocess.spawn`**：argv/cwd/env/stdio/graceMs/signal 符合上面的用法；`env` 值必须是字符串；`readFrom(0)` 返回 `{ text, lossy }`，必须检查 `lossy`；超时由插件自己 `terminate()`。
- **`defineTool`**：`output: { schema: { type: 'json' }, render }` 是合法形状；`parameters` 必填；默认值要在 `execute` 里实现。
- **`ctx.commands.register`**：命令名需匹配 `/^[a-z][a-z0-9_-]*$/`，`description` 非空，handler 返回 `{kind:'success'|'error', text}`；invocation 里有 `agent` / `signal`。
- **`ctx.sessionController.list`**：`list(request, signal)`，返回 `{items: SessionSummary[]}`；`signal` 在类型上是必须的；visible 不等于 unarchived。
- **`ctx.workingDirectory.defaultDirectory`**：存在且是绝对路径，但它是部署 fallback，桌面版通常等于 host 进程 cwd（可能是 profile 目录），**不能直接当作“用户的 workspace”**；默认路径应优先从最近会话 cwd 解析，或让用户显式配置。
- **打包**：只把 `@deepseek-ai/dsh-llm`、`@deepseek-ai/dsh-tools`、`@deepseek-ai/schemastery` 放在 `peerDependencies`（不要放 `dependencies`），配合 `engines.dsh`；DSH 的 linked-root 路由会从安装副本解析 peer，fresh clone 无 `node_modules` 也能加载。本地开发需要 `devDependencies` + `pnpm install`。

已知平台/运行时限制：

- Windows：无 shell 语义；`.sh` checker 需要显式 bash；`.cmd/.bat` 直接 spawn 不可靠；建议用 node/python 可执行文件。
- macOS/Linux：POSIX 正常；插件不提供沙箱，checker 以当前用户身份运行。
- 没有 worker thread：调度器单线程，checker 是 OS 子进程。

## 10. 测试

```bash
# 本地需要先安装 devDependencies
pnpm install

# 用 DSH 自带 Node 运行（node:sqlite 可用）
node --test test/*.test.mjs
```

- 8 个测试文件、64 个测试：`db`（11）、`checker`（8）、`render`（7）、`poller`（14）、`commands`（6）、`tools`（6）、`apply`（8）、`integration`（4），外加 `helpers/harness.mjs`。
- 使用真实临时 `node:sqlite` DB + fake host（commands/tools/sessionController/subprocess/timer/workingDirectory/logger），不依赖网络或真实会话。
- 覆盖重点：schema/claim 事务/多连接不重复 claim、软删除/复活、JSON 契约/失败分类/字节上限、合并消息/补偿/128 字符/10 行、超限截断记账、单条失败错误隔离、reload 原子性/target 绑定、watch_runs 窗口/聚合、watch_sessions signal/排序/50 条、async apply/默认路径/dispose、真实 DB 端到端。
- 修改行为时先加/改测试；测试不应弱化“只标记实际投递的 watch”“失败不重试”等不变量。

## 11. 发布与兼容

发布前检查：

1. `pnpm install --frozen-lockfile`
2. `node --test test/*.test.mjs`（必须全绿）
3. `pnpm pack` 检查 tarball 文件清单（lib/locale/icon/cordis.patch.yml/README/CHANGELOG/LICENSE）
4. 用 DSH 的 `plugin_manager install_bundle` 从仓库绝对路径安装，确认 `application:"applied"`、`warnings:[]`、version 正确
5. 确认 Config schema 只有 3 个键、`watch_runs`/`watch_sessions` live、无旧工具/skill
6. `remove_bundle` 后 profile 文件恢复一致
7. fresh clone（无 `node_modules`）再安装一次，验证 peer 解析
8. 更新版本、CHANGELOG、tag，并推送 main/tag

v0.1 → v0.2.1 是破坏性重写：旧管理命令、watch 目录、校验流程、skill、随包 docs/assets/examples 均不再读取；旧用户需把 watch 改写成 `watches.json`，执行一次 `/watch-reload`。

## 12. 已知取舍与后续方向

1. **渲染预算保守**：为补偿段固定预留 4KB，极端情况下可能丢掉一条本可放进 16KB 的事件；丢弃提示在空间不足时可能不出现。
2. **未来 schema 的 DB**：`user_version > 1` 会拒绝，但打开时可能已经执行 WAL/建表语句；正常版本（0/1）不受影响。
3. **默认 workspace 启发式**：最近可见会话 cwd；多 workspace/不同启动方式下建议显式写绝对 `configFile`/`dbFile`。
4. **归档会话不可见**：DSH 不暴露 archived 字段，`watch_sessions` 可能列出归档会话；需要用户自行确认。
5. **无自动去重/重试**：checker 要自己维护状态；投递失败只做一次性补偿。
6. **同步 SQLite**：极端写竞争下 `busy_timeout=5000` 可能让 host 事件循环阻塞至多 5s。
7. **多实例**：共享 DB 不重复执行，但跨实例会话可见性/通知目标不保证。
8. **Windows**：见上文，未做完整实测。
