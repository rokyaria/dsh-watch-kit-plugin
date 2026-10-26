# dsh-watch-kit-plugin

> 给 DeepSeek Harness 的**常驻巡检工具包**：检测脚本用任意语言写、用退出码表达"有没有事"；**只在有事时唤醒 agent**，其余时间零 token、零对话。
>
> **当前状态：v0.1 代码已实现，96 个单测通过；核心链路已在真实 DSH（desktop profile）完成端到端验收**——创建/编写/激活/真实触发/帧进入会话/去重/重启持久化/脚本完整性/唤醒预算/失败帧/pause·resume·remove 均有真机证据（见 [`docs/verification.md`](docs/verification.md) §9）。多 watch 合并帧、热重载、JSON 事件、运行器矩阵由单测覆盖；Windows 未测。契约见 [`docs/design.md`](docs/design.md)，开发说明见 [`docs/development.md`](docs/development.md)。

---

## 为什么需要它（和常见做法的区别）

| 做法 | 局限 |
|---|---|
| `schedule_create` | 到点必然产生一轮对话，没变化也烧 token、涨上下文 |
| 后台 job + 脚本 | DSH 退出后 job 丢失，重启后要靠模型记得重新 arm |
| 系统 cron | 能检测，但没有入口把结果送进会话、叫醒 agent |
| 文件/日志监听类工具 | 以"文件事件 / 日志行"为中心，检测逻辑要适配它们的事件模型或 DSL；换数据源（IMAP、HTTP、数据库）通常要另找方案 |

这个插件的组合（在本机常见方案里没有同类覆盖）：

- **检测逻辑语言无关、无边界**：IMAP 查信、目录大小阈值、任意 API、数据库查询……都写成同一个 `check.sh`（或 `.ps1` / `.py` / 原生可执行文件），用同一套 `0 / 1 / 255` 退出码契约表达；不需要为每种数据源找适配器。
- **创建必须经用户命令**（`/watch-add`）：agent 不能自己开监控，授权面更窄；创建、审批、暂停、删除都有审计记录。
- **文件即 UI**：`watch.conf` + 检测脚本 + `logs/`，直接编辑、保存即热重载，不需要后台管理界面。
- **重启自恢复**：插件随 DSH 启动；检测脚本自己持有状态，停机期间的变化在恢复后的第一轮检查里补报。
- **平时零打扰**：没有事件就没有 turn、没有 token；同一窗口内多个 watch 同时触发会合并成一次唤醒。

---

## 怎么用（三步）

1. **安装**：把 [`docs/install.md`](docs/install.md) 交给你的 agent 执行（安装 bundle、配置 watch 目录、跑验收）。
2. **建一个 watch**：在会话里输入

   ```
   /watch-add mail-inbox --purpose "合作方新邮件"
   ```

   agent 会和你确认一两句（看什么、多久看、怎么提醒），然后写好检测脚本并激活。
3. **等通知**：有事时，会话里会出现一轮带 `[WATCH TRIGGER]` 的处理；没事时什么都不发生。

---

## 命令

| 命令 | 作用 |
|---|---|
| `/watch-add <id> [--purpose "…"]` | 新建一个 watch（唯一创建入口，必须由你输入） |
| `/watch-list` | 查看所有 watch 的状态、目标会话、最近事件、失败计数 |
| `/watch-pause <id>` / `/watch-resume <id>` | 暂停 / 恢复巡检 |
| `/watch-remove <id>` | 删除（归档 7 天，脚本与数据可回捞） |
| `/watch-approve <id>` | 当 agent 要改关键设置（目的、绑定的会话等）时，表示"我同意" |

> **暂停/删除的语义**：暂停只停止排期，不取消已经在跑的检查——最坏情况下暂停后仍可能收到一条已经在路上的触发。删除时如果正好有检查在跑，命令会**拒绝**并提示稍后重试，避免归档目录被写回。
> 检测脚本在激活后被改动时，watch 会进入 `needs_validation` 并通知会话；此时 `/watch-resume` 会被拒绝，必须先用 `watch_validate` 重新校验。

---

## 一个 watch 长什么样

在 `plugins/watch/watches/<id>/` 下，通常你只需要关心三样：

| 文件/字段 | 作用 | 谁维护 |
|---|---|---|
| `check.sh`（Windows 为 `check.ps1`） | 检测脚本：`exit 0` 无事件、`exit 1` 有事件、`exit 255` 出错 | agent 写，你也可以直接改 |
| `TRIGGER_MSG`（在 `watch.conf`） | 有事件时对 agent 说的一句话，例如"检查到新信件，请阅读并回复" | 创建时确定，之后可改 |
| `INTERVAL`（在 `watch.conf`） | 检查间隔，默认 60 秒，最短 30 秒 | 你可直接改，保存即生效 |

其余由插件自动管理：目标会话、运行状态、失败计数、日志。**所有文件都是普通文件，可以直接编辑，改完自动重载**——不经过 agent 也行。

### 你会收到的消息

```
[WATCH TRIGGER] id=mail-inbox reason=event at=2026-10-26T14:10:03+08:00 rev=3 message_source=config
--- message ---
检查到新信件，请阅读信件并回复。
--- evidence ---
2 封新邮件：alice@… "合同终稿"; bob@… "排期"
--- logs ---
plugins/watch/watches/mail-inbox/logs/2026-10-26.log
```

同一 2 秒内多个 watch 同时触发时，会合并成一条，只叫醒一次。

### 想动态改提醒内容？脚本可以返回 JSON

`exit 1` 时，stdout 可以是一个 JSON 对象：

```json
{"message":"发现 2 封新邮件，请阅读后回复。","evidence":"alice / 合同终稿；bob / 排期"}
```

- `message` 覆盖 `TRIGGER_MSG`（`evidence` 作为帧里的证据）；
- 只认"退出码 1 且整段 stdout 是合法 JSON"；否则回退到退出码/纯文本语义；
- JSON 写坏（非法、超长、被截断）算一次**执行失败**，不会触发事件——错误会进日志和失败计数。

---

## 失败时会发生什么

- 检测脚本报错（退出码 255、超时、崩溃）不会触发事件，只记一次失败。
- **连续失败 5 次**时提醒一次（同一次故障只提醒一次），然后继续巡检；不会自动暂停。
- 如果你想在失败时做点什么（例如"发邮件通知我，并尝试修复"），在 `watch.conf` 里写 `FAILURE_MSG`；不写则只留一条记录。
- 恢复后失败计数自动清零。

---

## Demo：目录大小监控

仓库里的 [`examples/dir-size`](examples/dir-size/) 是第一个完整示例：某个目录超过阈值时提醒一次，回落后重置，下次再超限再提醒（另附 `.ps1` 移植参考，未在 Windows 实测）。

[`examples/json-event`](examples/json-event/) 演示用 JSON 动态覆盖提醒内容。

安装后可以按 [`docs/install.md`](docs/install.md) §4 建一个 `demo-dir-size`，用 `/tmp/watch-demo` 制造一次真实触发来验收。

---

## 安全与信任模型

- 检测脚本以**你的用户身份运行，没有沙箱**；能写文件的 agent 也能改脚本——这与它已有的 shell 能力同级，不是新增提权面。脚本被外部改动时插件会暂停并要求重新校验（`[WATCH NOTICE]`），但这只是"防静默替换"，不是沙箱。
- `TRIGGER_MSG` / JSON 的 `message` 会作为**常驻指令**进入 agent 上下文，本身就是 prompt-injection 面；插件做控制字符清洗与长度限制，信任边界仍是"你自己的脚本"。
- 凭据由脚本从 keychain/环境读取，不要写进 `watch.conf` 或 `stdout`（帧会进入会话历史）。

---

## 常见问题

**DSH 退出/重启后还在监控吗？**
插件随 DSH 启动自动恢复；每个 watch 的状态存在自己的目录里，重启后第一次检查就能发现停机期间的变化。

**电脑睡眠时呢？**
系统睡眠期间不检查；唤醒后立即补一次。这是预期行为。

**和 schedule_create 的区别？**
schedule 是"到点就产生一轮对话"；watch 是"状态变化才产生一轮对话"。周期巡检用 schedule，盯变化用 watch。

**会不会很费资源？**
没有事件时不产生对话；后台只有一个 1 秒的主时钟（只做时间比较），每个 watch 按自己的 `INTERVAL` 起一次检查脚本（默认 60 秒一次、最长 15 秒，可配但必须 ≤ INTERVAL/2），并发上限 4。

**脚本能干什么？**
本机用户权限内的一切：读文件、查 IMAP、调本地命令、访问网络。插件不做沙箱——它信任你写的脚本。

**脚本必须用 bash 吗？**
不必。支持 bash、PowerShell、Python 和原生可执行文件；按 `CHECK` 的扩展名自动选解释器（Windows 上 `.ps1` 优先 `pwsh`，回退 `powershell`）。

**Windows 能用吗？**
设计上兼容（PowerShell + 跨平台进程终止），但 v0.1 **未在 Windows 实测**；用 `.sh` 需要 Git Bash/WSL，否则请写 `.ps1`。

**脚本每轮都 `exit 1` 会怎样？**
默认会每轮唤醒一次（合并窗口只合并"同时"的触发）。可以在该 watch 的 `watch.conf` 里**按需开启唤醒预算**：

```ini
WAKE_BUDGET_CAPACITY=5          # 0 或不写 = 关闭（默认）
WAKE_BUDGET_REFILL_SECONDS=600  # 每 10 分钟补 1 个
```

开启后，token 用尽时不唤醒但**不丢证据**：合并成一条 pending，补充 token 后只投一条帧并标注"合并了 N 条较早的触发"；`/watch-list` 显示 `suppressed(n)`。**即时聊天这类持续有事件流的 watch 建议保持关闭**，由脚本自己做合并/摘要。

**脚本被改动了会怎样？**
激活时插件记录了检测脚本的哈希。之后脚本在 DSH 之外被改动（或 agent 改完没校验），插件会**暂停这个 watch**，并在会话里发一条 `[WATCH NOTICE]`，要求先审查脚本、再调用 `watch_validate` 校验后恢复。`/watch-resume` 不能绕过这一步。

**日志在哪？**
`plugins/watch/watches/<id>/logs/`，按天一个文件，保留 14 天 / 每个 watch 最多 20MB。

---

## 兼容性

| 项 | 说明 |
|---|---|
| DSH | `0.2.1-rc.3`（本机验证） |
| 平台 | macOS（开发验证）；Linux 预期可用；Windows 设计兼容、**v0.1 未实测**（见 `docs/install.md` §10） |
| 依赖 | 无第三方运行时依赖；仅依赖宿主自带的 3 个 `@deepseek-ai/*` 包（`dsh-llm`/`dsh-tools`/`schemastery`，随插件声明安装）。检测脚本可用 bash / PowerShell / Python / 原生可执行（demo 为 bash 3.2 兼容） |

## 许可

MIT
