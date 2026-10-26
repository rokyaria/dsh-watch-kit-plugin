# dsh-watch-kit-plugin 设计文档

> 状态：**v0.1 代码已实现**（96 个单测通过；核心链路已在真实 DSH 完成端到端验收，见 verification.md §9）。实现任务书见 `development.md`，验收标准见 §11。
> 适用宿主：DeepSeek Harness `0.2.1-rc.3`（本机验证）
> 本文是**规范性**文档：命令、退出码、配置字段、帧格式、状态机以本文为准；代码与本文冲突时，先改本文再改代码。

---

## 1. 问题与目标

### 1.1 问题

DSH 内置的三种"等待"能力都不能满足"只在事件发生时唤醒主 agent"：

| 能力 | 问题 |
|---|---|
| `schedule_create` | 每次到期都产生一个 turn，空转也花 token、涨上下文 |
| `run_in_background` + 脚本 | 可用，但 job 随 DSH 退出而丢失，重启后需要重新 arm（依赖模型纪律） |
| 系统 cron | 能检测，但没有稳定入口把事件投递进 DSH 会话 |

### 1.2 目标

一个 **Host 侧常驻插件**，在 DSH 运行期间按 watch 配置轮询用户/agent 编写的检测脚本；**只在事件发生或失败达到阈值时唤醒会话**，其余时间零 token、零 turn。watch 的创建被**用户命令**（`/watch-add`）收敛，可审计、可暂停、可直接手工改配置。

### 1.3 非目标（v0.1 明确不做）

- 不提供图形界面（命令 + 文件即全部交互）。
- 不做跨机器/云侧检测，不做推送（IMAP IDLE、webhook 等）；脚本自己决定怎么检测。
- 不做检测脚本的沙箱隔离：watch 脚本以宿主用户身份运行，信任边界是"用户自己的脚本"。
- 不做自动修复、不做自动暂停（失败策略由 `FAILURE_MSG` 表达）。
- 不替代 `schedule_create`：一次性/周期性的"提醒"仍用 schedule；watch 面向"状态变化"。
- **平台范围**：macOS（设计验证环境）、Linux（预期可用）、Windows（设计兼容：解释器自动解析 + 跨平台受管进程；v0.1 未实测，见 §6.2.1）。

---

## 2. 用户故事

1. **用户**在会话里输入 `/watch-add mail-inbox --purpose "合作方新邮件"`。agent 与用户确认细节后写好 `check.sh`，调用 `watch_validate` 激活。之后有新邮件时，会话里出现一轮 agent 处理；没有邮件时完全静默。
2. **用户**三个月后想改提醒频率，直接编辑 `watch.conf` 的 `INTERVAL`，保存即生效，不需要经过 agent。
3. **用户**发现某个 watch 误报太多，对 agent 说"这个别一天报八遍"；agent 修改 `check.sh` 的去重逻辑，调 `watch_validate` 生效，并在回复里说明改了什么。
4. **用户**出差一周，回来在另一个会话里输入 `/watch-list`，看到 `mail-inbox` 有 12 次触发、`failing(5)` 的另一个 watch 最后错误时间，决定处理哪个。

---

## 3. 架构总览

```
用户 composer
   │  /watch-add, /watch-list, /watch-pause, /watch-resume,
   │  /watch-remove, /watch-approve
   ▼
@deepseek-ai/dsh-commands（人类命令注册表）
   │ handler(invocation) —— 宿主侧执行，不经过模型
   ▼
dsh-watch-kit-plugin（Host 插件）
   ├── CommandService  命令实现（创建草稿、授权、状态管理、审计）
   ├── Kernel          常驻调度：tick → spawn check → 分类 → 合批 → followup
   ├── Tool            模型侧唯一收尾工具：watch_validate
   ├── SkillProvider   watch-authoring（运行时注册，随插件启停）
   └── WatchRegistry   扫描 specDirs，加载 watch.conf/state.json，热重载
   │
   ├── spawn ──► watches/<id>/check.sh        （用户/agent 编写的检测脚本）
   ├── read/write ──► watches/<id>/watch.conf  state.json  logs/
   └── resolveAgent + followup ──► 目标会话（trigger 帧）
```

设计要点：

1. **命令是唯一的人类入口**：`/watch-add` 是唯一能"无中生有"创建 watch 的动作；模型无法调用命令。
2. **工具只负责收尾**：模型只有一个 `watch_validate`，用于把 agent 写好的文件校验并激活；它不能创建、删除、改绑定。
3. **检测脚本是用户资产**：普通文件，任何语言、可手工编辑、可单独运行、可版本化。
4. **内核只做"何时叫醒"，不做"叫醒后做什么"**：动作语义写在 `TRIGGER_MSG` / `FAILURE_MSG` 里，由被唤醒的 agent 执行。

---

## 4. 组件与职责

| 组件 | 职责 | 不负责 |
|---|---|---|
| CommandService | 参数校验、草稿创建、授权审计、列表、暂停/恢复/删除；必要时 `followup` 唤醒 agent | 写检测脚本、判断事件 |
| WatchRegistry | 扫描 `specDirs`、解析 `watch.conf`、维护 `state.json`、监听文件变化热重载 | 运行脚本 |
| Kernel | 主 tick、调度、并发/超时/进程组、退出码/JSON 事件分类、失败计数、合并窗口、帧渲染、投递 | 业务判断、重试业务动作 |
| Tool `watch_validate` | 干跑校验（结构、可执行、范围、超时）、激活/重载、重置失败计数、`rev++`、返回样例帧 | 创建/删除 watch |
| Skill `watch-authoring` | 教 agent 如何写合格的 `check.sh` / `TRIGGER_MSG`，何时索要 `/watch-approve` | 运行时行为 |
| 模板 / Demo | `assets/template/` 与 `examples/dir-size/`，保证新建 watch 的结构一致 | — |

---

## 5. 文件布局与数据

### 5.1 运行时布局

`specDirs` 中每个目录是一个 **watch 根**（推荐每个工作区一个：`<workspace>/plugins/watch/watches`）。

```
<specRoot>/                      # 例：<workspace>/plugins/watch/watches
├── <id>/                        # watch id，唯一
│   ├── watch.conf               # 用户可编辑
│   ├── check.sh / check.ps1     # 检测程序，0/1/255 契约（见 §6.2）
│   ├── ACTION.md                # 可选：较长的处理说明（不进帧）
│   ├── data/                    # 脚本自有状态，内核不碰
│   ├── logs/
│   │   ├── YYYY-MM-DD.log       # 每次运行的记录
│   │   └── audit.log            # 创建/授权/暂停/删除/重载 等事件
│   └── state.json               # 内核状态，不给人看
└── .removed/<id>-<ts>/          # /watch-remove 的归档，保留 7 天
```

### 5.2 插件包布局（构建后）

```
dsh-watch-kit-plugin/
├── package.json
├── cordis.patch.yml
├── lib/            index.js, config.js, conf.js, registry.js, kernel.js,
│                   runner.js, exec.js, event.js, frame.js, commands.js,
│                   command-handlers.js, validate.js, tool.js, logs.js,
│                   integrity.js, budget.js, text.js, ids.js
├── skills/watch-authoring/SKILL.md
├── assets/template/{posix,win32}/{watch.conf,check.sh|check.ps1,ACTION.md}
├── examples/{dir-size/{watch.conf,check.sh,check.ps1},json-event/check.sh}
├── locale/{en,zh}.json
├── icon.svg
├── test/
├── README.md
└── docs/{design,development,install,verification}.md
```

> `examples/` 与 `test/` 都随包发布（`files` 已包含），用于参考与核对；skill 里指向 `examples/` 的链接在本地目录安装与 `npm pack` 后都有效。

### 5.3 插件层配置（`cordis.patch.yml` → Config）

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `specDirs` | string[] | `[]` | watch 根目录绝对路径；空 = 插件不工作 |
| `tickMs` | number | `1000` | 主时钟周期（只做时间比较，不跑检查） |
| `batchWindowMs` | number | `2000` | 合并窗口（按目标会话） |
| `maxConcurrentChecks` | number | `4` | 同时运行的 check 上限 |
| `maxEvidenceBytes` | number | `8192` | 帧内证据上限 |
| `maxStderrLines` | number | `20` | 失败帧附带的 stderr 行数 |
| `logRetentionDays` | number | `14` | 日志保留天数 |
| `logMaxBytesPerWatch` | number | `20971520` | 单 watch 日志总量上限（20MB） |
| `deliveryRetryMs` | number | `30000` | 投递失败后的重试间隔（最多 3 次） |
| `integrityNotifyDelayMs` | number | `5000` | 脚本变化后延迟多久通知（给编辑→validate 留窗口） |

---

## 6. 契约（规范性）

### 6.1 退出码

| 退出码 | 含义 | 内核行为 |
|---|---|---|
| `0` | 无事件 | 静默；失败计数清零 |
| `1` | **有事件，触发 trigger** | 进入合并窗口；失败计数清零 |
| `255`（文档写作 `-1`） | 异常 | 不触发；失败计数 +1；stderr 写日志 |
| 其它非 0 | 视为异常（记录真实码） | 同上 |
| 超时 / 被信号杀死 | 异常 | 同上；日志记录 `timeout` / `signal=N` |

> POSIX 退出码只有 0–255；`-1` 在 bash/Python 中实际落为 `255`。脚本应显式 `exit 255`。
>
> **`exit 1` 时 stdout 可以是 JSON 事件载荷**（§6.2.2），用于动态覆盖 `TRIGGER_MSG`；JSON 解析/校验失败按异常处理（不触发事件），stdout 不是 JSON 时回退到纯退出码语义。

**脚本自负原则**：`exit 1` 即"要触发"，内核不做去重。脚本必须在需要去重时自己维护状态（见 demo）——这是本设计的显式取舍（"防呆不防傻"）。

### 6.2 检测程序契约（默认 `check.sh`；Windows 常用 `check.ps1`）

| 项 | 规定 |
|---|---|
| 工作目录 | watch 目录（`<specRoot>/<id>/`） |
| 环境变量 | `WATCH_ID`、`WATCH_DIR`（watch 目录）、`WATCH_STATE`（推荐状态目录，内核保证存在）、`WATCH_LOGS`、`WATCH_INTERVAL`（秒）、`WATCH_DRY=1`（干跑时禁止改状态/发副作用） |
| stdout | `exit 1` 时：是 JSON 事件载荷则按 §6.2.2 解析；否则作为证据进帧（≤ `maxEvidenceBytes`，超出截断并给日志路径）。`exit 0/255` 时只进日志 |
| stderr | 只进日志；失败触发时取最后 `maxStderrLines` 行进帧 |
| 超时 | `TIMEOUT`（默认 15s，`1 ≤ TIMEOUT ≤ INTERVAL/2`）；由宿主受管进程服务终止（含子进程组），计一次失败 |
| 并发 | 同一 watch 同时最多 1 个进程；全局 ≤ `maxConcurrentChecks` |
| 状态 | 脚本只能写 `WATCH_STATE` / `WATCH_LOGS` 下的内容；不得依赖 TTY 或交互输入 |
| 秘密 | 凭据由脚本自行从 keychain/环境读取；**不得写入 watch.conf 或 stdout** |
| 编码 | stdout/stderr 必须是 UTF-8。Windows PowerShell 需先设置 `[Console]::OutputEncoding = [Text.Encoding]::UTF8` |
| 解释器 | 由 `RUNNER` 或扩展名自动解析（§6.2.1）；脚本可以是 bash、PowerShell、Python 或原生可执行 |

#### 6.2.1 运行器与平台

**为什么不能硬编码 `/bin/bash`**：DSH 的 base 配置在 Windows 上禁用 `tool-bash`、启用 `tool-pwsh`（按 `process.platform` 判定），Windows 也不保证存在 bash。所以检测程序先按 `CHECK` + `RUNNER` 解析成 `argv`，再交给宿主的 `ctx.subprocess` 服务执行。

`RUNNER`（watch.conf，可选）取值：

| RUNNER | 解析出的 argv |
|---|---|
| `auto`（默认） | 见下方规则 |
| `bash` | `[bash, <check>]` |
| `pwsh` | `[pwsh, -NoProfile, -NonInteractive, -File, <check>]` |
| `powershell` | `[powershell, -NoProfile, -NonInteractive, -ExecutionPolicy, Bypass, -File, <check>]` |
| `python` | `[python3|python|py -3, <check>]`（按平台查找） |
| `node` | `[node, <check>]`（要求 PATH 中有 node） |
| `direct` | `[<check>]`（POSIX 可执行文件/带 shebang；Windows 为 `.exe`） |

`auto` 规则（按顺序，首个命中）：
1. POSIX 且文件有可执行位：直接执行（kernel 读 shebang）。
2. 扩展名映射：`.sh`→bash；`.ps1`→pwsh（回退 powershell）；`.py`→python3/python（Windows 加 `py -3` 候选）；`.js/.mjs/.cjs`→node；`.cmd/.bat`→Windows `cmd.exe /d /s /c`；`.exe`→直接执行。
3. 其它：直接执行；失败时给出 `runner_not_found` / `not_executable` 的明确错误。

- 解释器查找使用 `ctx.subprocess.resolveExecutable()`；找不到属于**配置错误**：该 watch 不参与轮询，`/watch-list` 标记，`watch_validate` 返回 `runner_not_found`（不计入失败次数，避免把配置问题变成失败告警）。
- `/watch-add` 按平台复制模板：POSIX → `check.sh`（`CHECK=./check.sh`）；Windows → `check.ps1`（`CHECK=./check.ps1`）。
- **平台支持声明**：macOS 是设计验证环境；Linux 预期可用；Windows 设计兼容但 v0.1 **未实测**（见 §12）。Windows 上使用 `.sh` 需要 PATH 中存在 Git Bash/WSL 的 `bash`，否则请写 `.ps1`。

#### 6.2.2 事件输出：文本 / JSON

> 目标：退出码契约保持不变，同时允许脚本动态覆盖 `TRIGGER_MSG`。

**识别规则**：仅当退出码为 `1`、且 stdout 去空白后以 `{` 开头时，按 JSON 事件载荷解析（允许 UTF-8 BOM，自动剥离）。

**Schema（v1）**：

| 字段 | 类型 | 约束 | 含义 |
|---|---|---|---|
| `message` | string | 可选，1–2048 字节 | 覆盖 `TRIGGER_MSG`；省略/空串 → 用 `TRIGGER_MSG` |
| `evidence` | string | 可选，≤ `maxEvidenceBytes` | 覆盖"stdout 作为证据"；超出截断并标注 |
| 其它字段 | — | 忽略 | 前向兼容；日志记一次 warning |

- `evidence` 的长度截断**只发生在帧渲染层**；事件解析器不做二次截断（单一职责，避免两处上限不一致）。

- 顶层必须是 JSON object；字段类型不符、`message` 超长、stdout 因采集上限被截断导致 JSON 不完整 → **记为执行失败**（失败计数 +1，不触发事件），日志写 `event_json_invalid: <reason>` 与原始 stdout 尾部；连续 5 次进入失败帧。
- 退出码为 `0`/`255`，或 stdout 不以 `{` 开头 → **回退到纯退出码语义**（JSON 不解析）。
- 事件帧头增加 `message_source=script`（JSON）或 `message_source=config`（回退 `TRIGGER_MSG`）。
- `watch_validate` 的干跑（`WATCH_DRY=1`）同样执行 JSON 解析校验：若退出码 1 且 JSON 非法，返回 `dry_run_event_invalid`，便于在激活前发现脚本 bug。

**示例**：

```bash
printf '{"message":"发现 %s 封新邮件，请阅读后回复。","evidence":"%s"}\n' "$n" "$list"
exit 1
```

#### 6.2.3 超时、终止与执行环境

- 超时由内核计时器触发 `handle.terminate()`，宿主服务按受管进程范围（含子进程组）终止；超时计一次失败，日志记录 `timeout`。
- 子进程环境：继承的环境先去掉凭据形状变量与 `DSH_*`，再合并内核显式传入的 `WATCH_*`。
- stdout/stderr 使用宿主服务的收集模式（有上限、可 spill 到文件）；内核另设证据上限，并始终把当日日志路径写进帧。

### 6.3 watch.conf

普通 `KEY=VALUE` 文本，`#` 开头为注释；未知键忽略并记一条 warning（保证前向兼容）。

| 键 | 必填 | 默认 | 约束 | 谁能改 |
|---|---|---|---|---|
| `PURPOSE` | 建议 | — | 一句话；`TRIGGER_MSG` 为空时作为其默认值 | agent/用户 |
| `TRIGGER_MSG` | 否 | = `PURPOSE` | 触发时给 agent 的常驻指令 | agent/用户 |
| `INTERVAL` | 否 | `60` | 整数秒，`30 ≤ INTERVAL ≤ 86400` | agent/用户 |
| `TIMEOUT` | 否 | `15` | 整数秒，`1 ≤ TIMEOUT ≤ INTERVAL/2` | agent/用户 |
| `FAILURE_MSG` | 否 | 空 | 空 = 连续失败只留记录；非空 = 失败触发时作为指令 | agent/用户 |
| `TARGETS` | 是 | — | 目标会话 id（v0.1 单值）；由 `/watch-add` 写入 | 改动需 `/watch-approve` |
| `CHECK` | 否 | 模板决定（POSIX `./check.sh`，Windows `./check.ps1`） | 相对 watch 目录的脚本路径 | agent/用户 |
| `RUNNER` | 否 | `auto` | `auto` / `bash` / `pwsh` / `powershell` / `python` / `node` / `direct`，见 §6.2.1 | agent/用户 |
| `WAKE_BUDGET_CAPACITY` | 否 | `0`（关闭） | 整数 0–1000；>0 时开启唤醒预算，见 §6.15 | agent/用户 |
| `WAKE_BUDGET_REFILL_SECONDS` | 否 | `600` | 整数 1–86400；仅在容量 >0 时生效 | agent/用户 |

**启用状态不在 watch.conf**：暂停/恢复由内核状态（`state.json.enabled`）与命令管理，避免"配置文件与命令两套真源"。

### 6.4 state.json（内核所有，不给人看）

```json
{
  "schemaVersion": 1,
  "id": "mail-inbox",
  "status": "drafting | active | paused | needs_validation | orphaned",
  "enabled": true,
  "target": "session-...",
  "rev": 3,
  "failures": 0,
  "failureReported": false,
  "lastRunAt": "...", "lastExit": 0, "lastDurationMs": 412,
  "lastErrorAt": "...", "lastErrorTail": "...",
  "lastEventAt": "...", "lastTriggerAt": "...", "triggerCount": 12,
  "suppressedTotal": 0,
  "scriptPath": "...", "scriptHash": "…", "scriptChangedAt": null,
  "scriptNotifyAt": null, "scriptPendingHash": null,
  "scriptNotifiedHash": null, "scriptChangeReason": null,
  "createdAt": "...", "validatedAt": "..."
}
```

- `rev`：每次成功 `watch_validate` 递增；用于帧中标识版本。
- `failureReported`：本次失败连续期内是否已报过（保证"一个连续期只报一次"）。
- `scriptHash`：激活时检测脚本的 sha256；运行期出现变化会进入 `needs_validation`（§6.14）。
- `suppressedTotal`：被唤醒预算合并过的触发累计数（§6.15）。
- `triggerCount`：实际投递成功（唤醒）的次数；同一 watch 在同一合并帧里的多条事件只计一次，投递失败最终被丢弃的不计数。
- 文件写入用"临时文件 + rename"原子替换。

### 6.5 Trigger 帧

帧头为稳定的机器可读键值行；正文按节。证据截断时明确标注。

**事件帧（单条）**

```
[WATCH TRIGGER] id=mail-inbox reason=event at=2026-10-26T14:10:03+08:00 rev=3 message_source=config
--- message ---
检查到新信件，请阅读信件并回复。            ← TRIGGER_MSG（空则 PURPOSE）；JSON 事件时来自脚本
--- evidence (2.1KB/8KB) ---
2 封新邮件：alice@… "合同终稿"; bob@… "排期"
--- logs ---
/…/watches/mail-inbox/logs/2026-10-26.log
--- next ---
按 message 执行；不要 re-arm（插件常驻轮询）。
```

**失败帧（单条，失败连续期内只发一次）**

```
[WATCH TRIGGER] id=check-email reason=failure failures=5/5 first=13:40 last=14:07
--- message ---
watch check-email 连续失败5次，已记录；轮询继续。   ← FAILURE_MSG 为空时的默认记录
--- error_tail ---
imaplib.IMAP4.error: LOGIN failed: invalid credentials
--- logs ---
/…/watches/check-email/logs/2026-10-26.log
--- next ---
按 message 处理；轮询继续（未暂停）。
```

**合并帧（窗口内多条）**

```
[WATCH TRIGGER] batch=2 at=2026-10-26T14:10:03+08:00
--- [1/2] id=mail-inbox reason=event at=… rev=3 ---
message: 检查到新信件，请阅读信件并回复。
evidence: …
--- [2/2] id=dir-size reason=event at=… rev=1 ---
message: 目录超过阈值，确认是否清理。
evidence: ~/Downloads 512MB > 500MB
--- next ---
逐条按 message 执行；message 是用户为该 watch 设定的常驻指令。
```

约束：`message` 必须原样保留（不翻译、不改写）；`message_source=config|script` 标明来源；`evidence`/`error_tail` 超限截断并给日志路径；帧总长建议 ≤ 24KB。

### 6.6 命令契约

所有命令由插件在全局命令层注册，名称固定：

| 命令 | 参数 | 行为 | 副作用 | 是否唤醒 |
|---|---|---|---|---|
| `/watch-add` | `<id> [--purpose "…"]` | 校验 id（`^[a-z][a-z0-9-]{1,39}$`、全局唯一）→ 复制模板到 specRoot → 写 `TARGETS=invocation.agent.id` → `state.status=drafting` → 返回提示并 `followup` 作者指令 | 建目录、写状态、审计 | 是（作者 turn） |
| `/watch-list` | 无 | 列出所有 watch：id / 状态（以「中文(英文)」形式展示，如 `待重校验(needs_validation)`）/ PURPOSE / INTERVAL / 最近事件 / 失败计数 / 被预算合并数 | 无 | 否 |
| `/watch-pause` | `<id>` | `enabled=false`，停止调度（保留状态与基线）；**不取消已在执行的检查**，最坏情况下仍可能送达一条已触发的帧 | 状态、审计 | 否 |
| `/watch-resume` | `<id>` | `enabled=true`、`status=active`、失败计数清零、立即参与下个 tick；**脚本变化后（needs_validation 或哈希不符）拒绝恢复，要求先 `watch_validate`** | 状态、审计 | 否 |
| `/watch-remove` | `<id>` | 停止 → 移动到 `.removed/<id>-<ts>/`（7 天后清理） | 目录移动、审计 | 否 |
| `/watch-approve` | `<id>` | 写入审批审计 → 向目标会话 `followup` "用户已批准…请继续" | 审计 | 是（继续 turn） |

通用规则：
- 命令 handler 在宿主侧执行，**不经过模型**；用 `invocation.agent` 做会话归属（不需要 `$DSH_SESSION_ID`）。
- 错误统一返回 `{kind:"error", text:"<中文原因 + 正确用法>"}`，成功返回 `{kind:"success", text:"<简短结论>"}`。
- 命令描述写清用途与示例（slash 菜单可见），`input.hint` 给出参数提示。
- `/watch-approve` 的语义是**用户同意**：不携带变更内容，不展示内部字段；agent 在请求前必须在对话里说明要改什么。插件只记录"何时、在哪个会话、批准了哪个 watch"。

**作者指令（`/watch-add` 的 followup）**

```
[WATCH SETUP] 已创建 watch "<id>"（草稿，未激活）。
请：加载 skill watch-authoring → 与用户确认 PURPOSE/触发条件/频率（最多 2 个问题）
→ 编写 check.sh（0/1/255 契约）并填写 TRIGGER_MSG/INTERVAL
→ 调用 watch_validate 激活 → 向用户汇报并建议执行 /watch-list 查看状态。
```

投递来源标记：`source.kind = "cordis-host-runner"`（客户端渲染为 plugin 触发条；实现后需在真实 UI 验证一次）。

### 6.7 Tool `watch_validate`

模型侧唯一工具，单参数：

```json
{ "id": "mail-inbox" }
```

行为：
1. 定位 watch（按 id 唯一匹配 specDirs）；
2. 校验 `watch.conf` 范围（INTERVAL/TIMEOUT）、`CHECK` 存在、`RUNNER` 能解析到解释器（§6.2.1）、`TARGETS` 存在且会话可被 `sessionController.inspect(target)` 查到（**不用 `resolveAgent`**，避免校验阶段拉起一个 agent 产生副作用）；
3. 以 `WATCH_DRY=1` 运行一次检测程序（超时 = TIMEOUT），接受退出码 0/1/255；超时、`runner_not_found`、非 0/1/255 视为校验失败；若退出码为 1 且 stdout 是 JSON 事件载荷，同时校验 JSON schema，非法则报 `dry_run_event_invalid`；
4. 通过后：`status=active`（若原本 paused 则保持 paused）、`enabled=true`、`failures=0`、`failureReported=false`、`rev++`、`validatedAt=now`；
5. 返回结构化结果：`{ok, id, status, interval, triggerMsg, sampleFrame, warnings}`，`render` 输出一行人类可读结论。

失败时返回明确原因（如 `missing_check`、`not_executable`、`bad_interval`、`dry_run_timeout`、`unknown_watch`），不修改现有状态。

### 6.8 失败语义

- 每次异常（退出码 255/其它/超时/信号）使 `failures += 1`；任何 `0/1` 使 `failures = 0, failureReported = false`。
- 当 `failures >= 5` 且 `failureReported == false`：进入合并窗口发一条失败帧，置 `failureReported = true`；**不暂停、不重试**，继续按 `INTERVAL` 轮询。
- 同一失败连续期只报一次（避免断网时每 5 次刷一个 turn）。
- 恢复后的下一次成功会自然清零，无需命令。

### 6.9 合并与投递

- 合并粒度：**目标会话**。同一 target 在 `batchWindowMs`（默认 2s）内产生的多条触发合并为一条 followup。
- 投递：`resolveAgent(target)` → 成功则 `agent.followup(createUserMessage({content, source}))`；失败则标记 `orphaned`，内存中保留该 batch（最多 5 条），每 30s 重试，连续 3 次失败则丢弃并记日志，`/watch-list` 显示 `orphaned`。
- 不做"未读抑制"：脚本若每轮 `exit 1`，就会每轮进入合并窗口；这由 `/watch-list` 的 `triggerCount` 暴露，属于脚本 bug，由 agent 修（v0.2 可加 `DEDUPE_WINDOW`）。
- 投递失败不阻塞轮询；事件帧内容始终先写入 `logs/`，可人工补偿。

### 6.10 日志与清理

- 每次运行一行：`<ts> run exit=<code> dur=<ms> bytes=<stdoutBytes>`；触发/失败/重载/审批各记一行。
- 按天文件；插件启动时与每日 03:00 清理：删除 14 天前文件；单 watch 日志总量超过 20MB 时从最旧删除。
- `.removed/` 归档保留 7 天。
- 日志是给 agent 排错用的第一手材料；帧里始终带当日日志路径。

### 6.11 生命周期状态机

```
             /watch-add
                 │
                 ▼
   ┌────────► drafting ──watch_validate──► active ──/watch-pause──► paused
   │              (rev++)                   │  ▲                    │
   │                                        │  └──/watch-resume─────┘
   │                                        │
   │                                        ├──脚本变化/丢失──► needs_validation
   │                                        │        （通知 agent；watch_validate 恢复）
   │                                        │
   │                                        ├──目标会话不可达──► orphaned
   │                                        │        （绑定修复 + watch_validate 恢复）
   │                                        │
   └── watch_validate 失败（保持 drafting）  └── /watch-remove ──► .removed/（终态）
```

- `drafting`：文件可能不完整，**不参与轮询**。
- `active`：参与调度；失败只影响健康度字段，不改变状态。
- `paused`：不轮询；保留状态与脚本状态。
- `needs_validation`：检测脚本在激活后被改动/丢失；不轮询，等待 agent 审查后 `watch_validate` 恢复（§6.14）。
- `orphaned`：投递失败且重试耗尽后停止轮询（避免对不可达会话空转）；修复 `TARGETS` 后经 `watch_validate` 恢复为 active。

### 6.12 热重载与 last-good

- **轻量轮询**：内核每个 tick 对 specDirs 做 `readdir` + `stat`（watch.conf 的 mtime/size），发现新增/删除/修改即热重载；不使用 `fs.watch`，跨平台行为一致、无 watcher 泄漏。
- `watch.conf` 变更：重新解析；非法值保留**上一版内存配置**继续运行，`state.json` 记 `configError`，`/watch-list` 标 `config-invalid`。
- `check.sh` 变更：**不再直接生效**。内核检测到内容哈希与激活时不一致，会进入 `needs_validation`、暂停轮询，并通知目标会话（§6.14）；agent 审查后调用 `watch_validate` 恢复。
- `watch.conf` 的普通参数（INTERVAL/TRIGGER_MSG 等）仍热重载；`CHECK` 路径变化按脚本变化处理。
- 直接手工编辑配置文件是**支持的正式入口**；直接改检测脚本是支持但**需要重新校验**的入口。

### 6.13 目标会话与 orphaned

- `TARGETS` 绑定会话 id；会话未打开时通过 `sessionController.resolveAgent` 拉起投递（与内置 schedule 服务同一机制）。
- 会话归档/删除导致解析失败 → `orphaned`；`/watch-list` 可见；agent 修改 `TARGETS` 并征得用户 `/watch-approve` 后，`watch_validate` 恢复。
- v0.1 只支持单目标；多目标（`TARGETS=a,b` + `WAKE=all|first`）列为 v0.2。

### 6.14 脚本完整性与"外部修改"通知

**规则**：`watch_validate` 时记录检测脚本的 sha256 与路径；运行期每个 tick 用 stat 指纹判断是否变化，变化才重算哈希。

- **脚本变化/丢失/`CHECK` 路径变化** → `state.status = needs_validation`，**暂停轮询**（不会执行未验证的脚本），记录 `scriptChangedAt/scriptPendingHash/scriptChangeReason`，写审计。
- 延迟 `integrityNotifyDelayMs`（默认 5s，给"agent 编辑后立即 validate"留窗口）后，向目标会话投递一条**独立通知**（不进入合并窗口、不计触发预算）：

```
[WATCH NOTICE] id=mail-inbox reason=script_changed at=...
--- message ---
检测脚本在 DSH 之外发生了变化，已暂停轮询（不会用未验证的脚本继续执行）。
脚本：/…/check.sh
before=… after=…
--- next ---
请先审查脚本内容，然后调用 watch_validate（{"id":"mail-inbox"}）重新校验并恢复。
```

- 同一次变化只通知一次（`scriptNotifiedHash`）；`watch_validate` 成功后写入新 `scriptHash`，清空变化标记并恢复原状态（paused 仍保持 paused）。
- 通知投递失败按与触发路径相同的重试纪律处理：`deliveryRetryMs` 间隔、最多 3 次，之后丢弃并写审计（`script_change_drop`），不会无限重试。
- `/watch-list` 显示 `needs_validation`；`/watch-resume` 拒绝直接恢复。
- 旧版 state 无 `scriptHash` 时只建立基线、不打扰（平滑升级）。

### 6.15 唤醒预算（可选，默认关闭）

> 解决"脚本每轮 `exit 1` 持续唤醒"的背压；**默认 off**，避免误伤即时聊天等"持续有事件流"的场景。

- 配置（每个 watch 独立）：`WAKE_BUDGET_CAPACITY`（容量，0=关闭）与 `WAKE_BUDGET_REFILL_SECONDS`（补充间隔）。
- 开启后：事件照常被检测与记录；token 用尽时**不丢弃证据**，只合并成一条 pending（保留最新 message/evidence、累计 `suppressedCount` 与 `suppressedTotal`）。
- 之后每次检查发现 token 可用时，先把 pending 作为一条帧投出（证据末尾追加"（唤醒预算：合并了 N 条较早的触发…）"），同一次事件若仍无 token 则继续合并。
- `/watch-list` 显示 `suppressed(n)`；`triggerCount` 只统计真正投递的触发。
- 桶是内存态：DSH 重启后回满、未投递的 pending 丢失（日志仍有记录）。
- 建议：状态型 watch 可开（例：容量 5 / 600 秒）；聊天类持续事件流保持关闭，改为脚本内合并/摘要。

---

## 7. 安全与边界

- **为什么不接沙箱**：① 检查脚本要访问任意数据源（IMAP/HTTP/本地状态），DSH 的沙箱是文件策略、面向 bash 工具，默认套用会拦掉合法场景；② 插件支持任意解释器（bash/pwsh/python/原生可执行），没有统一的沙箱入口；③ "激活前干跑校验"只是准入检查，脚本在运行期仍可被改写（热重载、agent 优化），沙箱解决不了"谁能改脚本"——那是文件权限与完整性问题。结论：信任边界是"本机上能改写工作区的人/进程"，与授予它 shell 同级；需要强隔离时应在独立用户/容器中运行，而不是在插件里假装沙箱。
- **秘密**：凭据只能由脚本从 keychain/环境读取；`stdout` 会进会话日志，禁止输出秘密。
- **完整性而非沙箱**：脚本被外部修改会暂停轮询并通知 agent 重新校验（§6.14）；这防止"未知代码静默继续跑"，但不等于隔离。
- **审批是"防呆"不是"防傻"**：`/watch-approve` 只记录用户同意并唤醒 agent；不校验变更内容，不向用户暴露内部字段（用户看的是 PURPOSE 与行为）。
- **JSON 事件载荷是数据不是指令**：只取 `message`/`evidence` 两个字符串，剥离控制字符、按上限截断或拒绝；脚本是用户/agent 编写的可信代码，但其输出仍按不可信数据处理。
- **Windows**：依赖 PowerShell（优先 `pwsh`，回退 `powershell`）与 `ctx.subprocess` 的跨平台受管终止；`.sh` 需要 PATH 中有 `bash`（Git Bash/WSL），否则请用 `.ps1`。
- **资源**：并发上限、超时、输出截断、日志清理共同约束资源；单 watch 进程组在超时/删除时统一 kill。
- **静默承诺**：除"事件触发、失败阈值触发、`/watch-add` 的作者 turn、`/watch-approve` 的继续 turn"外，插件不产生任何 turn，不注入 prompt。

---

## 8. 关键设计决策（ADR）

| # | 决策 | 理由 | 被放弃的方案 |
|---|---|---|---|
| D1 | 创建入口用 **human command** | 用户输入才存在，模型无法调用；有 `command/run` 日志 | skill/AGENT.md 约定（靠模型纪律）；model tool create（模型可自行创建） |
| D2 | 事件判定用 **退出码** | 简单、语言无关、脚本自负去重；重启后脚本状态自然补报 | fingerprint+detail 双脚本（内核维护基线，复杂度高） |
| D3 | 失败**不自动暂停** | 暂停的恢复动作最终还是落到用户，增加负担；"一个连续期只报一次"已足够安静 | 自动暂停 + `/watch-resume`；自动恢复（可绕过授权） |
| D4 | 失败默认"只留记录"，`FAILURE_MSG` 才执行策略 | 默认安静，需要时用一条消息表达策略 | 默认发邮件/自动修复（无法通用） |
| D5 | 触发消息 = `TRIGGER_MSG`（默认 = `PURPOSE`） | 一句话同时表达"为什么建"和"醒来做什么"，用户可读可改 | 独立模板引擎/变量插值（增加注入与调试成本） |
| D6 | 去掉 `SIDE_EFFECTS` | 动作边界由用户写的 `TRIGGER_MSG` 表达，再加枚举是重复建模 | 声明只读/有副作用并据此审批 |
| D7 | `/watch-approve` 只是"我同意" | 关键修改由 agent 判断并请求，插件不该假装能审计语义变更 | 受保护字段 diff + 待审批状态（用户看不懂、实现更重） |
| D8 | 模型侧只保留 `watch_validate` | 创建/删除/改绑必须走命令；模型需要的是确定性的收尾与反馈 | 全套 CRUD tool（模型可绕过命令） |
| D9 | 合并窗口 2s、按 target session | 一次多 watch 触发只产生一个 turn | 每条触发一次唤醒（刷屏） |
| D10 | watch 数据与状态放在 spec 目录内 | 用户可直接看/改/备份；无需插件私有存储 | DSH 私有 storage（不可见、不可手工修） |
| D11 | 帧头键值机器可读 | 便于 skill/agent 稳定解析；UI 展示另议 | 纯自然语言帧 |
| D12 | 纯 ESM JavaScript、无构建、无第三方依赖 | 安装即用；减少供应链与版本耦合 | TypeScript + 构建（引入构建步骤与版本漂移） |
| D13 | `exit 1` 时允许 JSON 事件载荷覆盖 `TRIGGER_MSG` | 动态事件需要动态措辞；解析失败按执行失败，错误可见 | 只用静态 `TRIGGER_MSG`（表达力不足）；引入模板引擎（注入与调试成本） |
| D14 | 运行器不硬编码 `/bin/bash`：`RUNNER`/扩展名解析 + `ctx.subprocess` | Windows 无 bash 工具；宿主服务提供跨平台进程组终止与输出上限 | 直接 `node:child_process`（需自行处理 Windows 进程树与截断） |
| D15 | 脚本变化 → 暂停 + 通知 + `watch_validate` 才能恢复 | 防止被替换的脚本静默继续执行；比沙箱轻、比"信任热重载"可控 | 静默热重载（当前风险）；沙箱（不适合多解释器/数据源） |
| D16 | 唤醒预算默认关闭、按 watch 可选 | 避免误伤持续事件流（聊天类）；需要时由用户显式开启 | 默认开启（误伤聊天流）；仅靠脚本去重（坏脚本可拖死会话） |

---

## 9. 与 DSH 的集成点（v0.2.1-rc.3 已核对）

| 用途 | API | 备注 / 风险 |
|---|---|---|
| 注册命令 | `ctx.commands.register({definitionId,name,description,input,handler})` | handler `(invocation)`；`invocation.agent` 为输入命令的会话；可 async |
| 命令里唤醒 | `invocation.agent.followup(createUserMessage({content, source}))` | 内置 `/goal` 同款用法；`createUserMessage` 来自 `@deepseek-ai/dsh-llm` |
| 注册工具 | `ctx.tools.register(defineTool({name,description,parameters,output,execute(args,exec)}))` | `exec.agent` 可用；`defineTool` 来自 `@deepseek-ai/dsh-tools` |
| 运行时技能 | `ctx.skills.register({name,description,content})` | ctx 作用域 effect，插件卸载即消失 |
| 定时 | `ctx.interval(cb, ms)` | Cordis timer effect，随插件卸载自动清理 |
| 唤醒会话 | `ctx.sessionController.resolveAgent(sessionId)` → `{agent}` \| `{error}` | 半内部 API（schedule 服务同款）；升级需回归 |
| 插件配置 | schemastery `export const Config` | 通过 `Config.listConfigs` 可查 |
| 插件清单 | `package.json` 的 `dsh.bundle.patch` + `plugin_manager install_bundle` | 更新已安装包需重启 backend |
| UI 触发条 | `source.kind = "cordis-host-runner"` | 客户端渲染为 plugin；未知 kind 退化为通用 request，不崩 |
| 检测程序执行 | `ctx.subprocess.spawn({argv,cwd,stdio,graceMs,env})`，读 `collected`、`done`、`terminate()` | 宿主受管进程范围，Windows 同样适用；输出有上限并可 spill |
| 解释器查找 | `ctx.subprocess.resolveExecutable(command, env)` | 执行世界内的 PATH 解析 |

**兼容性风险**：`sessionController.resolveAgent`、`createUserMessage`、`ctx.subprocess` 的收集模式都属于宿主内部契约；升级 DSH 前跑一遍安装文档里的 E2E 清单（含 Windows 可用性复核）。

---

## 10. Demo：目录大小监控（v0.1 交付物）

`examples/dir-size/` 提供一个完整示例，同时作为安装文档的验收用例。

- 目的：某目录（默认 `~/Downloads`）超过阈值（默认 500MB）时提醒一次；回落到阈值以下后重置，下次再超限再提醒。
- `check.sh`：
  - `du -sk` 取目录大小；`$WATCH_STATE/above` 记录"已提醒"状态；
  - 首次越过阈值：打印证据（目录、当前大小、阈值）→ `exit 1`；
  - 已在阈值以上：`exit 0`（去重，避免每轮唤醒）；
  - 回落到阈值以下：删状态；`exit 0`；
  - 目录不存在 / `du` 失败：stderr 输出原因 → `exit 255`。
- 该示例用来演示**脚本自负去重**这一核心契约，也是 agent 写其他 watch 的参照模板。
- 同时提供 `check.ps1` 作为 Windows 移植参考（**未在 Windows 实测**），以及 `examples/json-event/` 演示 §6.2.2 的 JSON 覆盖。

---

## 11. 验收标准（v0.1）

1. `/watch-add demo --purpose "目录大小超限提醒"` 后，agent 能按作者指令完成 `check.sh` 并通过 `watch_validate` 激活。
2. 阈值以下时，连续 10 分钟无任何 turn（`triggerCount` 不变）。
3. 手动把目录撑过阈值：**只产生一轮** agent 处理，帧包含 message/evidence/logs，`rev` 正确。
4. 失败路径：把 `check.sh` 改成 `exit 255`，5 次后产生**一条**失败帧；继续轮询，不自动暂停；`/watch-list` 显示 `failing(5)`；改回后计数清零。
5. 两个 watch 在 2s 内同时触发：只产生**一条**合并帧（batch=2）。
6. `/watch-pause` 后不再触发；`/watch-resume` 立即恢复（≤1 个 INTERVAL）。
7. 手工编辑 `watch.conf` 的 `INTERVAL`，无需重启即生效；写入非法值保留旧配置。
8. `/watch-remove` 后目录进入 `.removed/`，不再轮询。
9. 插件禁用/卸载后：无定时器、无子进程、无命令、无 skill 残留。
10. **JSON 覆盖**：把 demo 脚本改为输出 `{"message":"…","evidence":"…"}` 并 `exit 1`，帧头为 `message_source=script`、message 为脚本内容；输出非法 JSON 时记为失败，连续 5 次进入失败帧。
11. **运行器解析**：`RUNNER=direct` 与 `.py`/`.ps1`（平台可用的）能正确解析；解释器缺失时 `watch_validate` 返回 `runner_not_found` 且不轮询。
12. **脚本完整性**：激活后修改 `check.sh` → 状态变 `needs_validation`、轮询停止；延迟后收到一条 `[WATCH NOTICE]`；`watch_validate` 后恢复；`/watch-resume` 拒绝绕过。
13. **唤醒预算**：`WAKE_BUDGET_CAPACITY=1`、`REFILL_SECONDS=60` 时，连续触发只投第一条；补充 token 后把被合并的触发以一条帧补投（证据含"合并了 N 条"），`suppressedTotal` 计数正确。

---

## 12. 版本路线与未决问题

**v0.1（MVP，本设计覆盖）**：上述全部契约 + demo + 安装文档 + 单元测试。

**v0.2 候选**（不承诺）：
- ~~唤醒预算/背压（token bucket）~~：已在 v0.1 实现为**每 watch 可选配置**（§6.15，默认关闭）。
- ~~脚本完整性提示~~：已在 v0.1 实现（§6.14，变化即暂停并要求 `watch_validate`）。
- 多目标 `TARGETS` 与 `WAKE=all|first`
- `/watch-log <id>` 或 `watch_status` tool（查看健康度，减少读文件的成本）
- 帧语言可配置（zh/en）
- 心跳：`/watch-list` 显示"最近一次成功检查距今多久"
- Windows 实测（PowerShell 输出编码、进程组终止、路径与权限）

**未决问题**：
1. `source.kind` 的最终选择（`cordis-host-runner` vs 自定义 kind）需在真实 UI 实测后定。
2. `resolveAgent` 在会话归档后的行为需实测（决定 orphaned 的判定阈值）。
3. 是否需要 `HISTORY_LIMIT`：同一 watch 短时间内连续触发时，是否在帧里附"最近 N 次触发时间"以帮助 agent 判断噪声。
4. 失败路径是否也允许 JSON 覆盖 `FAILURE_MSG`（v0.1 只支持事件路径）。
