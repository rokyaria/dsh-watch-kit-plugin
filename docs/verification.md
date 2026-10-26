# 本机验证记录（2026-10-26）

> 环境：macOS（arm64）· DSH `0.2.1-rc.3` · Node `v24.21.0`（DSH 自带运行时）。
> 本文件只记录**已实际执行**的命令与结果；不代表 Windows 或真实 DSH 安装已验收。
> 注：文中的绝对路径已泛化为示例（`/path/to/workspace` 等）；相对路径（如 `plugins/watch/watches/…`）相对于作者的工作区。

## 1. 单元 / 组件 / 集成替身测试

```bash
NODE="$(command -v node)"   # 或 $DSH_HOME/dsh-runtimes/<runtime>/dependencies/node/bin/node
cd projects/dsh-watch-kit-plugin
"$NODE" --test test/*.test.mjs
```

结果（连续 3 次运行均为 96/96，无抖动）：

```
ℹ tests 96
ℹ pass 96
ℹ fail 0
ℹ duration_ms 1149.981
```

覆盖：`text/ids/conf/event/runner/frame/logs/exec/registry/kernel/validate/commands`，另含 `budget` 纯函数测试与 kernel 中的脚本完整性/唤醒预算集成测试。
`exec` 的宿主 `ctx.subprocess` 用替身实现；`ctx.commands / tools / skills / sessionController / subprocess` 的**真实装配**未在本轮运行（见 §4）。

## 2. 语法检查

```bash
for f in lib/*.js; do "$NODE" --check "$f"; done
```

结果：全部通过（无输出）。

## 3. Demo 脚本行为（真实 bash 执行）

### `examples/dir-size/check.sh`

```bash
WATCH_STATE=$(mktemp -d) WATCH_DEMO_DIR=/tmp/watch-demo WATCH_DEMO_LIMIT_MB=1
```

| 场景 | 退出码 | 输出 |
|---|---|---|
| 首次越界（2MB > 1MB） | `1` | `目录 /tmp/watch-demo 当前 2 MB，超过阈值 1 MB` |
| 仍在阈值上（去重） | `0` | — |
| 删大文件、目录仍在 | `0` | —（清掉去重标记） |
| 目录消失 | `255` | stderr `directory not found` |

### `examples/json-event/check.sh`

| 场景 | 退出码 | 输出 |
|---|---|---|
| 触发文件出现 | `1` | `{"message":"检测到演示触发器，请确认是否继续。","evidence":"触发文件：/tmp/watch-json-demo/trigger（6 字节）"}`，JSON 解析通过 |
| 仍在触发状态（去重） | `0` | — |
| 触发文件消失 | `0` | — |

## 4. 已核对的宿主 API（源码级）

| 依赖 | 核对内容 |
|---|---|
| `ctx.commands.register` | `handler(invocation)`、`input.hint` 不能为空串（无参数命令已省略 `input`） |
| `ctx.tools.register` + `defineTool` | `execute(args, exec)`、`output:{schema,render}` 形态与 mem0 插件一致 |
| `@deepseek-ai/dsh-llm` | 导出 `createUserMessage` |
| `ctx.subprocess` | `spawn({argv,cwd,stdio,graceMs,env})`、`handle.done/terminate()/collected.*.readFrom()`、`resolveExecutable()` |
| `ctx.sessionController` | `resolveAgent()`、`inspect()` |
| `ctx.skills.register` | 运行时 skill 注册（ctx 作用域，卸载自动移除） |
| Windows | base patch 在 `win32` 禁用 `tool-bash`、启用 `tool-pwsh`（解释器解析与 `.ps1` 模板的依据） |
| 客户端触发条 | `source.kind` 已知类型（`schedule`/`tool-jobs`/`cordis-host-runner`）；未知 kind 退化为通用行，不会崩 |

## 5. 尚未验证（下一步）

1. **真实 DSH 安装**：`plugin_manager install_bundle` → `/watch-list` → `/watch-add` → `watch_validate` → 真实触发 → `/watch-approve` 唤醒（`install.md` §4–§6）。
2. **真实命令 handler 里的 `followup` 时序与 UI 呈现**（作者 turn / 审批 turn 的实际观感）。
3. **真实 `ctx.subprocess`** 的超时终止、输出收集与 spill 行为。
4. 插件卸载后无残留定时器/子进程。
5. **真实 DSH 中的脚本变化通知**（`needs_validation` → `[WATCH NOTICE]` → `watch_validate` 恢复，见 `install.md` §4.6）。
6. **真实 DSH 中的可选唤醒预算**（`suppressed(n)` 与补投，见 `install.md` §4.7）。
7. **Windows**（PowerShell 编码、进程终止、路径）——v0.1 明确未实测。

## 6. 独立审查问题修复（2026-10-26）

| 审查项 | 处理 | 验证 |
|---|---|---|
| 调度基准文档与代码不一致 | 代码保持「以开始时刻为基准的固定频率」；新增 1s 最小间隔防御（执行超限时才生效），文档注释改准 | `test/kernel.test.mjs`「computeNextDue」、文档审阅 |
| `examples/`、`test/` 未列入 `files` | **已加入** `package.json` 的 `files`（供参考与核对）；design/development/skill 的说明同步 | `node -e "require('./package.json').files"` 人工核对 |
| `agents` 为未使用的 inject 依赖 | 已从 `inject` 移除，design §9 删除 `ctx.agents.get` 行 | `node --check lib/index.js` |
| `/watch-remove` 与在跑检查的竞态 | 检查进行中/删除中时命令直接拒绝；内核 tick 过滤 `removing`，迟到结果丢弃 | `test/commands.test.mjs`「remove：检查进行中拒绝删除」、`test/kernel.test.mjs`「tick 跳过正在删除的 watch」 |
| `/watch-pause` 不取消在跑检查 | 作为明确语义保留，README 命令说明处已写明 | 文档审阅 |
| event/frame 双重证据截断 | 移除 event 解析层截断，截断只保留在帧渲染层 | `test/event.test.mjs`「evidence 原样返回」 |
| 信任模型（脚本无沙箱、message 进上下文） | 保留并在 README「安全与信任模型」写明 | 文档审阅 |
| 脚本被外部替换无感知 | 新增完整性：激活记录 sha256；变化 → `needs_validation` + 暂停 + `[WATCH NOTICE]`；`watch_validate` 恢复；resume 拒绝 | `test/kernel.test.mjs`「脚本被外部修改」、`test/commands.test.mjs`「resume 脚本变化拒绝」 |
| 坏脚本每轮 exit 1 拖死会话 | 新增**可选**唤醒预算（默认关闭，按 watch 配容量/补充间隔），超额合并证据不丢弃 | `test/budget.test.mjs`、`test/kernel.test.mjs`「唤醒预算」、`test/conf.test.mjs` |

项目已更名 `dsh-watch-kit-plugin`（目录、package name、bundle row、文档引用同步更新）。

## 7. 新增功能的本机验证（2026-10-26）

| 功能 | 覆盖用例 | 结果 |
|---|---|---|
| 脚本完整性（哈希/指纹/通知/恢复） | `kernel.test.mjs`「脚本被外部修改：暂停轮询、通知一次，validate 前不恢复」；`commands.test.mjs`「resume：脚本在暂停期间被修改 → 拒绝」；`validate.test.mjs` 激活写入 `scriptHash` | 通过 |
| 可选唤醒预算（token bucket） | `budget.test.mjs`（补充/封顶/耗尽/合并）；`kernel.test.mjs`「容量 1/60s，超额合并证据，补充后补投一条」；`conf.test.mjs` 范围校验；`commands.test.mjs` `/watch-list` 展示 `suppressed(3)` | 通过 |
| 调度防御 | `kernel.test.mjs`「computeNextDue：固定频率基准 + 1s 最小间隔防御」 | 通过 |

注意：以上为代码级/替身级验证；真实 DSH 中的通知投递与预算行为仍需按 `docs/install.md` §4.6–§4.7 验收。

## 8. 二轮审查修复 + 真实 DSH 安装准备（2026-10-26 晚）

### 8.1 修复（测试 91 → 95）

| 审查项 | 处理 | 验证 |
|---|---|---|
| 脚本变化通知投递失败会每秒无限重试 | 与触发路径统一重试纪律：`deliveryRetryMs` 间隔、最多 3 次，之后丢弃并审计（`script_change_drop`）；无目标会话时消费通知避免空转 | `test/kernel.test.mjs`「脚本变化通知：投递失败按重试纪律退避，最多 3 次后放弃」 |
| `triggerCount` 实际按入队计数，与 design「只统计真正投递的触发」不符 | 计数移到 flush 成功投递后；同一 watch 在同一合并帧多条事件只计一次；投递失败最终丢弃不计数；`lastTriggerAt` = 实际唤醒时间 | `test/kernel.test.mjs`「同一 watch 同一合并帧只计一次」「投递失败不计数」 |
| `/watch-list` 状态英文裸奔 | 状态改为「中文(英文)」双语标签（`待重校验(needs_validation)` 等） | `test/commands.test.mjs`「状态以中文(英文)展示」 |

### 8.2 真实 DSH 安装准备（desktop profile，待重启生效）

1. 备份：`~/.dsh/profiles/desktop/package.json` 与 `cordis.patch.yml` 均已带时间戳备份（`.bak-20261026-190945`）。
2. `package.json`：新增 `dsh-watch-kit-plugin` 的 `link:` 依赖与 bundles 条目；JSON 校验通过。
3. `cordis.patch.yml`：新增 watch 行（`specDirs: [/path/to/workspace/plugins/watch/watches]`）；YAML 校验通过（9 行）。**注意：首次写的是 `- id: watch` 覆盖行，实测无效，已改为 `- insert:` 显式建行（见 §8.3）**。
4. `pnpm install`：链接已建立（`node_modules/dsh-watch-kit-plugin -> projects/dsh-watch-kit-plugin`）。
5. watch 根目录已创建。

**下一步**：重启 DeepSeek Harness 后按 `docs/install.md` §3–§6 执行验收（`/watch-list` → `/watch-add` → `watch_validate` → 真实触发 → 失败路径 → 脚本完整性 → 唤醒预算）。

### 8.3 首次重启后的实测诊断（2026-10-26 19:2x）

- 现象：宿主重启后，用户输入 `/watch-list` 未被命令注册表拦截（原样落入 agent 对话），说明命令未注册。
- 诊断：mem0（本 profile 里唯一参照）的行来自 profile patch 的 **`- insert:`**；watch 行此前只写了 `- id: watch` 覆盖——在该插件以 link 方式挂载、bundle patch 未建行时，覆盖会被静默跳过（与 profile 注释描述的语义一致）。
- 修复：profile patch 改为 `- insert:` 显式建行（YAML 校验通过，9 行）；`docs/install.md` §2 同步改为 insert 模式并记录该坑；插件 `apply` 的 commands/tool/skill 三个注册改为逐个 try/catch 兜底（单个宿主 API 形态不匹配时只损失该能力，不拖垮整行）。
- 待验证：再次重启后 `/watch-list` 是否被拦截；若仍未知命令，检查设置 → 插件里 `watch` 行的状态（ACTIVE/PENDING/FAILED）。

### 8.4 第二次重启失败：宿主包无法解析（2026-10-26 19:19，已修复）

- 现象：插件行加载失败，报 `ERR_MODULE_NOT_FOUND: Cannot find package '@deepseek-ai/dsh-llm'`（`lib/index.js`）。
- 根因：本项目是零依赖工程、目录下没有 `node_modules`；而 `lib/index.js`、`lib/commands.js` 依赖 `@deepseek-ai/dsh-llm`，`lib/tool.js` 依赖 `@deepseek-ai/dsh-tools`，`lib/config.js` 依赖 `@deepseek-ai/schemastery`。Node 从插件文件自身路径解析裸包，宿主 asar 内的副本不可达；mem0 能用同样 import 是因为它目录里有 `node_modules`。
- 修复：`package.json` 增加 `dependencies`（`dsh-llm`/`dsh-tools` 钉宿主同版本 `0.2.1-rc.3`，`schemastery` `~3.18.4`）；在插件目录执行 `pnpm install`（24 个包，含传递依赖）；新增 `.gitignore` 忽略 `node_modules/`；README/development 依赖描述同步更正。
- 安装后自检（全部通过）：
  - `import('./lib/index.js')` → 导出 `Config/apply/inject/name`，无解析错误；
  - 用真实 `dsh-tools@0.2.1-rc.3` 的 `defineTool` 构造 `watch_validate` 定义 → 通过；
  - 用假 ctx（六个服务 + `interval/effect/on`）调用 `apply()` → 注册 **6 条命令 + watch_validate + watch-authoring skill**，kernel 启动扫描，dispose 干净退出。
- 待验证：第三次重启后 `/watch-list`。

### 8.5 第三次重启：插件加载成功 + 发现并修复 skill 注册 bug（2026-10-26 19:29）

- 结果：`/watch-add test-dir-check` 成功产出 `[WATCH SETUP]`，命令注册、followup 投递、`watch_validate` 工具全部就绪（本地补装宿主包后 import 解析问题解决）。
- 发现 bug：调用 `skill` 工具加载 `watch-authoring` 时报 `loaded skill "watch-authoring" source must be a string`。
- 根因（读取宿主 asar 中的 skills 服务实现确认）：`skills.register(skill)` 只给 `invocation` 与 `provider` 补默认值；而加载时的 `validateDefinition()` 要求 `source`、`provider`、`content` 均为字符串。插件注册时未传 `source`。
- 修复：`lib/index.js` 的 `registerAuthoringSkill` 显式传入 `source`（SKILL.md 绝对路径，`fileURLToPath`），并导出该函数；新增 `test/skill.test.mjs` 回归（断言 source/content 为字符串、disposer 透传）。测试 95 → 96，全绿。
- 注：该修复需插件重新加载（重启 DSH）后 `skill` 工具才会生效；本轮验收中 agent 已直接读取 SKILL.md 完成编写。

## 9. 真实 DSH 端到端验收（2026-10-26 19:31，desktop profile）

环境：DSH `0.2.1-rc.3` desktop · Node `v24.21.0` · profile `~/.dsh/profiles/desktop` · 插件经 `link:` + profile patch `- insert:` 行加载。

| 步骤 | 操作 | 结果 |
|---|---|---|
| 1. 创建 | `/watch-add test-dir-check --purpose "目录监控 memories/mine/"` | ✅ 命令被拦截并执行；草稿创建；`TARGETS` 绑定当前会话；agent 收到 `[WATCH SETUP]` |
| 2. 编写检测脚本 | `check.sh`：递归监控 `memories/mine/` 新文件（基线自动建立、排除 `.DS_Store`、去重状态存 `$WATCH_STATE/seen_files`）；`INTERVAL=30`、`TRIGGER_MSG` 已填 | ✅ 本地 9 场景自检全部符合预期（基线/无变化/新文件/去重/干跑不写状态/干跑后补报/目录缺失 255/真实目录基线/无变化） |
| 3. 激活 | `watch_validate {"id":"test-dir-check"}` | ✅ `ok:true`、`status=active`、`rev=1`、`scriptHash` 记录、`sampleFrame` 正常 |
| 4. 真实触发 | 19:31:31 在 `memories/mine/L2/` 建探针文件 | ✅ 19:31:33 检查 `exit=1`（`bytes=120`，`note=event`）→ 19:31:35 投递（batchWindow 2s）→ `triggerCount=1`、`lastExit=1`、`lastTriggerAt` 落盘、审计 `trigger_delivered`；**触发帧实际进入活跃会话**（对话中可见 `[WATCH TRIGGER] id=test-dir-check reason=event ... message_source=config`，含 message/evidence/logs 三节），agent 按 message 处理并确认无其他新文件 |
| 5. 脚本完整性 | 在 DSH 之外给 `check.sh` 追加注释 | ✅ 4s 内 `status=needs_validation`（`script_changed`）→ 5s 后 `[WATCH NOTICE]` 投递 + 审计 `script_change_notified`；撤销修改后 `watch_validate` 恢复（`rev=2`、新 `scriptHash`） |
| 6. 重启持久化 | 19:35 重启 DSH（宿主新 PID 17016） | ✅ `state.json` 保留（`active`/`rev=2`/`triggerCount=1`）；`data/seen_files` 基线保留；重启后首轮立即执行（`lastRunAt=11:35:38Z`、`exit=0`），**无重复触发、无假事件** |
| 7. skill 修复生效 | 重启后调用 `skill` 工具加载 `watch-authoring` | ✅ 加载成功（`provider=runtime`，4402 字符）——`source` 字段修复已在真机生效 |
| 8. `/watch-pause` | 用户执行后等 45s（> INTERVAL 30s） | ✅ `status=paused`/`enabled=false`；45s 内**无任何新 run**（调度停止）；审计 `pause` |
| 9. `/watch-resume` | 用户执行后观察首轮 | ✅ `status=active`/`enabled=true`；立即续跑（`lastRunAt` 在 1s 内更新）；审计 `resume` |
| 10. 失败帧 | `fail-test`（恒 `exit 255`，INTERVAL=30s，自定义 `FAILURE_MSG`） | ✅ 第 5 次失败（`failures=5/5`，`first=11:44:06`、`last=11:45:58`）投递**一条** `reason=failure` 帧（含 message/error_tail/logs）；`failureReported=true`，`status=active` 不自动暂停，之后继续轮询（`failures` 继续累加） |
| 11. 唤醒预算 | `budget-test`（恒 `exit 1`，`WAKE_BUDGET_CAPACITY=1`/`REFILL_SECONDS=60`，INTERVAL=30s） | ✅ 第 1 轮放行（`triggerCount=1`）；第 2–4 轮合并（`suppressedTotal=3`，日志 `note=suppressed`）；约 60s 后补 token → 补投一条合并帧（`triggerCount=2`、`lastTriggerAt=11:48:40`，证据带「合并了 N 条较早的触发」） |
| 12. `/watch-remove` | 用户对 `fail-test`、`budget-test` 执行 | ✅ 归档到 `.removed/<id>-<ts>/`（完整保留 `check.sh`/`watch.conf`/`state.json`/`logs`/`data`）；归档内审计 `event=remove` 含归档路径；**归档后无新 run**（最后 run 均早于 remove 时间戳）；存活 watch 仅剩 `test-dir-check`（继续正常轮询） |

**证据位置**：`plugins/watch/watches/test-dir-check/state.json`（含 `triggerCount`/`lastExit`/`scriptHash`）、`logs/2026-10-26.log`（`exit=1 note=event`）、`logs/audit.log`（`trigger_delivered`、`script_changed`、`script_change_notified`）。

**尚未验收**：仅 Windows（v0.1 明确未测）。`fail-test` 与 `budget-test` 两个验收用临时 watch 已由 `/watch-remove` 归档到 `.removed/`（保留 7 天）。

**验收结论（2026-10-26）**：核心链路（创建 → 编写 → 激活 → 真实触发 → 帧进入会话 → 去重 → 重启持久化 → 脚本完整性 → 唤醒预算 → 失败帧 → pause/resume/remove）全部有真机证据。

按 `design.md` §11 的 13 条对照：

- **真机通过**：#1 创建与作者指令、#2 阈值下静默（30s 轮询无事件、triggerCount 不变）、#3 真实触发帧、#4 失败帧、#6 pause/resume、#8 remove 归档、#12 脚本完整性、#13 唤醒预算；另加 #14 重启持久化与 skill 加载。
- **仅单测覆盖（未在真机单独验证）**：#5 多 watch 同窗口合并帧、#7 手工改 `watch.conf` 热重载、#9 插件卸载后无残留、#10 JSON 事件覆盖（真机帧均为 `message_source=config`）、#11 运行器矩阵（真机只走了 bash + auto）、Windows 平台。

**探针文件**：`memories/mine/L2/2026-10-26-watch-e2e-probe.md` 为验收产物，已在验收后删除；下一轮检查把基线同步回 16 个文件，`triggerCount` 保持 1，无重复触发（删除不产生事件）。
