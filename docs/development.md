# dsh-watch-kit-plugin 开发文档

> 状态：**v0.1 代码已实现（2026-10-26）**：`node --test` 96 项通过（纯逻辑 + 组件 + 集成替身）；核心链路已在真实 DSH 完成端到端验收（见 `verification.md` §9）。
> 规范性契约见 `design.md` §6；本文只讲**怎么实现、怎么测、怎么发布**。两者冲突时以 `design.md` 为准，并同步修订两处。

---

## 1. 仓库布局（目标形态）

```
projects/dsh-watch-kit-plugin/
├── package.json                    # dsh.bundle.patch、exports、files
├── cordis.patch.yml                # 插入 plugin row（id: watch）
├── lib/
│   ├── index.js                    # apply(ctx, config)：装配 + 生命周期
│   ├── config.js                   # schemastery Config
│   ├── conf.js                     # watch.conf 解析/校验/默认值
│   ├── registry.js                 # specDirs 扫描、state.json 读写、热重载
│   ├── runner.js                   # 解释器解析（RUNNER/扩展名 → argv，纯函数）
│   ├── exec.js                     # ctx.subprocess 执行、超时终止、输出收集
│   ├── event.js                    # 退出码 + JSON 事件载荷解析（纯函数）
│   ├── frame.js                    # event/failure/batch 帧渲染
│   ├── kernel.js                   # tick、调度、合并窗口、投递
│   ├── commands.js                 # 6 条 /watch-* 命令
│   ├── command-handlers.js         # 6 条命令的参数解析与业务逻辑（可注入、可单测）
│   ├── validate.js                 # watch_validate 核心：校验 + 干跑 + 激活
│   ├── integrity.js                # 脚本 sha256/指纹/变化通知文案
│   ├── budget.js                   # 可选唤醒预算（token bucket）纯函数
│   ├── tool.js                     # watch_validate 的 defineTool 包装
│   ├── logs.js                     # 按天日志、清理、audit
│   ├── text.js                     # UTF-8/截断/行尾等纯文本工具
│   └── ids.js                      # id 校验、时间戳、jitter
├── skills/watch-authoring/SKILL.md # 运行时注册的 agent 指南
├── assets/template/{posix,win32}/{watch.conf,check.sh|check.ps1,ACTION.md}
├── examples/{dir-size/{watch.conf,check.sh,check.ps1},json-event/check.sh}
├── locale/{en,zh}.json             # meta.title / meta.description
├── icon.svg
├── test/
│   ├── conf.test.mjs
│   ├── frame.test.mjs
│   ├── kernel.test.mjs
│   ├── commands.test.mjs
│   ├── tool.test.mjs
│   ├── logs.test.mjs
│   ├── event.test.mjs
│   ├── runner.test.mjs
│   ├── primitives.test.mjs
│   ├── validate.test.mjs
│   ├── exec.test.mjs
│   ├── budget.test.mjs
│   └── helpers/fixtures.mjs
├── README.md
└── docs/{design,development,install,verification}.md
```

> `examples/` 与 `test/` 都随包发布（`package.json` 的 `files` 已包含），`npm pack` 后 skill 中的示例链接仍然有效。

---

## 2. 技术选型

| 项 | 选择 | 理由 |
|---|---|---|
| 语言 | **纯 ESM JavaScript**（Node ≥ 22） | Host-only bundle 无需构建；安装即用；避免 TS 构建产物与宿主版本漂移 |
| 运行时依赖 | **零第三方依赖 + 3 个宿主包** | 逻辑只用 `node:` 内建模块；`@deepseek-ai/dsh-llm`（`createUserMessage`）/`@deepseek-ai/dsh-tools`（`defineTool`）/`@deepseek-ai/schemastery`（Config）需随插件声明并安装（与本机宿主同版本 `0.2.1-rc.3`）——否则运行时会从插件目录解析不到宿主包（2026-10-26 实测踩坑） |
| 测试 | `node:test` + `node:assert/strict` | 零依赖，DSH 自带 Node 24 可跑 |
| 插件形态 | Host-only | 无 UI；命令 + 文件即交互 |
| 配置校验 | schemastery（`@deepseek-ai/schemastery`，宿主提供） | 与其它插件一致 |
| 脚本语言 | 任意受支持：bash / PowerShell / Python / 原生可执行（`RUNNER` 或扩展名解析，见 design §6.2.1） | 跨平台；Windows 无 bash 工具时用 `.ps1` |
| 进程执行 | `ctx.subprocess`（宿主受管进程服务） | 跨平台进程组终止、输出收集与 spill、凭据环境清理；不直接用 `node:child_process` |
| demo 脚本风格 | bash 兼容 macOS 自带 3.2；另附未实测的 `.ps1` 移植参考 | demo 不用 bash 4 语法（无 `declare -A`、无 `mapfile`） |

若系统没有 `node`（需要 Node >= 22），可用 DSH 自带 Node：

```bash
NODE="$(command -v node)"   # 或 $DSH_HOME/dsh-runtimes/<runtime>/dependencies/node/bin/node
"$NODE" --version
```

> 建议写一个 `scripts/node.sh`（gitignored）自动探测：优先 `$DSH_NODE` → `command -v node` → DSH 运行时路径。测试与本地检查统一走它。

---

## 3. 模块职责与关键签名

| 模块 | 导出 | 说明 |
|---|---|---|
| `config.js` | `Config` | schemastery 对象；字段见设计文档 §5.3 |
| `conf.js` | `parseWatchConf(text, {path})` → `{values, warnings}`；`validateWatchConf(cfg, {id})` → `{ok, errors}`；`effectiveTriggerMsg(cfg)`；`effectiveTimeout(cfg)` | 纯函数，无 IO；未知键 warning；范围夹紧由校验器拒绝（不静默） |
| `registry.js` | `WatchRegistry`：`constructor({dirs, logger})`、`async scan()`、`get(id)`、`list()`、`async readState(id)`、`async writeState(id, state)`、`onChange(cb)`、`dispose()` | 扫描 `specDirs/*/watch.conf`；`state.json` 缺失视为 `drafting`；写入用 tmp+rename |
| `runner.js` | `resolveRunner({platform, checkPath, runner, resolveExecutable})` → `argv` / `null` | 纯函数；`RUNNER` 显式或扩展名自动解析（design §6.2.1）；找不到解释器返回 `runner_not_found` |
| `exec.js` | `runCheck({watchDir, argv, timeoutMs, env, maxStdoutBytes, maxStderrBytes})` → `{code, signal, timedOut, durationMs, stdout, stdoutLossy, stderrTail}` | `ctx.subprocess.spawn` + 收集模式；超时 `handle.terminate()`；不自行 kill 进程组 |
| `event.js` | `parseEventOutput({code, stdout, lossy})` → `{kind:'event', message?, evidence?, source}` \| `{kind:'by-exit-code'}` \| `{kind:'invalid', reason}` | 纯函数；JSON 事件协议（design §6.2.2）；只取 `message`/`evidence`，剥离 BOM、校验类型与长度 |
| `frame.js` | `renderEventFrame(item, {maxEvidenceBytes})`、`renderFailureFrame(item, {...})`、`renderBatchFrame(items, {...})`；`clip(text, maxBytes)` | 纯函数，便于单测；帧头键值固定，正文节顺序固定 |
| `kernel.js` | `class Kernel`：`start()`、`tick()`、`runOne(entry)`、`enqueue(item)`、`flush(target)`、`flushAll()`、`dispose()` | 依赖注入：`{registry, resolveRunner, runCheck, parseEvent, deliver, now, logger, config}`；默认实现来自真实模块，测试用 stub |
| `commands.js` | `registerCommands({ctx, registry, kernel, config})` → disposer；`parseAddArgs(raw)`、`parseIdArg(raw)` | 命令 handler 里只做快速 IO；作者/审批 turn 用 `followup` |
| `tool.js` | `registerValidateTool({ctx, registry, config})` → disposer | 内部复用 `validateWatch()`；干跑逻辑放纯函数 `validateDraft()` 便于测试 |
| `integrity.js` | `fileSha256(path)`、`scriptFingerprint(path)`、`sameFingerprint`、`renderScriptChangedNotice({...})` | 纯/IO 分离；通知文案不进入合并窗口 |
| `budget.js` | `createBucket`、`refillBucket`、`tryConsume`、`mergePending`、`takePending` | 纯函数，令牌桶语义与边界单测 |
| `logs.js` | `appendRunLog(logsDir, line)`、`appendAudit(logsDir, event)`、`cleanupLogs(dir, {retentionDays, maxBytes})` | 每日文件名取本地时区日期；清理在启动与每日首次 tick 触发 |
| `ids.js` | `isValidWatchId(id)`、`dayStamp(date)`、`jitterFactor(id)`、`nextDue(state, interval, now)` | jitter：`hash(id) % 21 - 10` → ±10%，确定性 |
| `index.js` | `name`、`inject`、`Config`、`apply(ctx, config)` | 装配 kernel/registry/commands/tool/skill；全部注册用 `ctx.effect` 清理 |

**可测试性要求**：`conf/frame/ids/runner/event` 必须零 IO（平台、PATH 解析结果通过参数注入）；`kernel` 不直接 `require` 子进程与投递实现，通过构造参数注入（默认指向真实实现）。这是单元测试能在没有 DSH 的情况下跑起来的前提。

---

## 4. 核心算法（伪代码）

### 4.1 主循环与调度

```
start():
  await registry.scan()
  registry.onChange(debounce(500ms) => { await reload(); kernel.scheduleTickSoon() })
  disposer = ctx.interval(() => void tick(), tickMs)   // Cordis timer effect
  await cleanupLogsOnce()
  await tick()                                        // 启动即跑一轮（补报停机期间事件）

tick():
  if (ticking) return; ticking = true
  try:
    now = now()
    due = registry.list()
      .filter(w => w.status === active && w.enabled && !w.inFlight && now >= w.nextDueAt)
      .sort(by nextDueAt)
      .slice(0, maxConcurrentChecks - runningCount)
    for w of due: void runOne(w)        // 并发受控，不 await 全部
  finally ticking = false

runOne(w):
  w.inFlight = true
  started = now()
  result = await runCheck({..., timeoutMs: effectiveTimeout(w.conf)})
  w.inFlight = false
  w.lastRunAt = started
  w.nextDueAt = max(started + interval * (1 + jitter(id)),  // 固定频率基准（不随执行时长漂移）
                    finished + 1000ms)                     // 1s 最小间隔：仅防御"执行超时"被破坏的异常
  // 正常配置 TIMEOUT ≤ INTERVAL/2，所以 1s 下限不会生效
  appendRunLog(...)
  classify(result):
    code 0   -> failures = 0; failureReported = false
    code 1   -> failures = 0; failureReported = false; enqueue(eventFrameItem)
    其他      -> failures += 1; if failures >= 5 && !failureReported:
                   enqueue(failureFrameItem); failureReported = true
  持久化 state.json（原子写）
```

### 4.2 检测程序执行（runner.js + exec.js + event.js）

#### 4.2.1 解释器解析（runner.js，纯函数）

```
resolveRunner({platform, checkPath, runner, resolveExecutable}):
  if (runner && runner !== 'auto') return ARGV[runner](checkPath)    // design §6.2.1
  if (platform !== 'win32' && isExecutable(checkPath)) return [checkPath]
  switch (extname(checkPath)):
    '.sh'  → [find('bash'), checkPath]
    '.ps1' → find('pwsh') ? [pwsh, '-NoProfile', '-NonInteractive', '-File', checkPath]
                          : [powershell, '-NoProfile', '-NonInteractive',
                             '-ExecutionPolicy', 'Bypass', '-File', checkPath]
    '.py'  → find('python3') ?? find('python') ?? (win32 ? ['py', '-3'] : null) + checkPath
    '.js'/'.mjs'/'.cjs' → [find('node'), checkPath]
    '.cmd'/'.bat'（win32）→ ['cmd.exe', '/d', '/s', '/c', checkPath]
    '.exe' → [checkPath]
    default → [checkPath]
  找不到解释器 → null（= runner_not_found，配置错误，不进入失败计数）

find(cmd) = resolveExecutable(cmd)      // ctx.subprocess.resolveExecutable
```

#### 4.2.2 进程执行（exec.js，`ctx.subprocess`）

```
runCheck({watchDir, argv, timeoutMs, env, maxStdoutBytes, maxStderrBytes}):
  handle = ctx.subprocess.spawn({
    argv, cwd: watchDir, graceMs: 2000,
    stdio: { stdin: 'ignore',
             stdout: { maxBytes: maxStdoutBytes, spill: { maxBytes: 256*1024 } },
             stderr: { maxBytes: maxStderrBytes, spill: { maxBytes: 256*1024 } } },
    env: { ...scrubbedParentEnv(), WATCH_ID, WATCH_DIR, WATCH_STATE, WATCH_LOGS,
           WATCH_INTERVAL, ...(dryRun ? {WATCH_DRY: '1'} : {}) },
  })
  timer = setTimeout(() => { timedOut = true; handle.terminate() }, timeoutMs)
  outcome = await handle.done                  // {exitCode, signal}
  clearTimeout(timer)
  out = handle.collected.stdout.readFrom(0)    // {text, nextOffset, lossy, spillPath?}
  err = handle.collected.stderr.readFrom(0)
  return { code: outcome.exitCode, signal: outcome.signal, timedOut,
           durationMs, stdout: out.text, stdoutLossy: out.lossy,
           stderrTail: tailLines(err.text, maxStderrLines) }
```

要点：
- 不硬编码解释器；`argv` 来自 §4.2.1。
- 全异步；不用 `execSync`、不设 `shell:true`（避免二次解析）。
- **进程组终止与 Windows 差异由宿主服务负责**，插件不自行 `kill(-pid)`。
- 输出上限与 spill 由宿主服务提供；`lossy === true` 表示超限被截断（事件 JSON 因此视为不完整，见 §4.2.3）。
- `dryRun` 只由 `watch_validate` 使用。

#### 4.2.3 事件解析（event.js，纯函数）

```
parseEventOutput({code, stdout, lossy}):
  if (code === 1):
    text = stripBom(stdout).trimStart()
    if (text.startsWith('{')):
      try obj = JSON.parse(stdout) catch → {kind:'invalid', reason:'json_parse'}
      if (!isPlainObject(obj))                        → invalid('not_object')
      if (obj.message !== undefined &&
          (typeof obj.message !== 'string' ||
           utf8Bytes(obj.message) === 0 || utf8Bytes(obj.message) > 2048))
                                                      → invalid('bad_message')
      if (obj.evidence !== undefined && typeof obj.evidence !== 'string')
                                                      → invalid('bad_evidence')
      if (lossy)                                      → invalid('truncated')
      return {kind:'event', message: obj.message, evidence: obj.evidence, source:'script'}
  return {kind:'by-exit-code'}       // 0/255/非 JSON：内核按纯退出码语义处理
```

- `invalid` 由内核记为执行失败（`failures += 1`，无触发，日志 `event_json_invalid: <reason>`），不抛异常。
- 事件证据优先取 JSON `evidence`，否则为空；message 缺失时回退 `TRIGGER_MSG`。
- 控制字符（除 `\n`/`\t`）替换为空格，再按上限截断 evidence。

### 4.3 合并窗口与投递（kernel.js）

```
enqueue(item):                       // item = {id, kind: event|failure, frameData, target}
  batch = batches.get(item.target) ?? {items: [], timer: null, attempts: 0}
  batch.items.push(item)
  if (!batch.timer) batch.timer = setTimeout(() => flush(target), batchWindowMs)
  batches.set(target, batch)

async flush(target):
  batch = batches.get(target); batches.delete(target)
  if (!batch || batch.items.length === 0) return
  frame = batch.items.length === 1 ? renderOne(...) : renderBatchFrame(...)
  agent = await resolve(target)               // ctx.sessionController.resolveAgent
  if (error) { markOrphaned(target); retryLater(batch, attempts+1); return }
  agent.followup(createUserMessage({ content:[{type:'text',text:frame}],
                                     source:{kind:'cordis-host-runner'} }))
  persist lastTriggerAt / triggerCount / lastEventAt
```

- `retryLater`：最多 3 次、间隔 30s；失败丢弃并写 audit。
- 同一 target 同时最多一个 `timer`；flush 后新事件进入新 batch。
- 不因 `followup` 抛错而崩溃：catch + logger.warn + audit。

### 4.4 热重载（registry.js）

```
scan(): for dir of specDirs: for entry of readdir(dir, {withFileTypes:true}):
  if (!entry.isDirectory() || entry.name.startsWith('.')) continue
  conf = parseWatchConf(readFile(join(dir, entry.name, 'watch.conf')))
  state = readState(join(dir, entry.name, 'state.json')) ?? defaultState('drafting')
  entry = {id, dir, conf, confError, state}
registry.map = new Map(...)

scanIfChanged(): 每个 tick 做一次轻量刷新
  for dir of specDirs: entries = readdir(dir)
    新目录 → loadEntry()
    conf 的 mtime/size 变化 → reloadConf()（非法保留旧值 + confError；runnerArgv 缓存清空）
    已消失的目录 → 从内存移除
```

### 4.5 失败与恢复

- 失败计数、`failureReported`、`lastErrorAt/Tail` 都是 `state.json` 字段。
- 成功（0/1）一律 `failures=0; failureReported=false`。
- 不暂停、不重试失败运行；下一轮按 `nextDueAt` 正常到来。

### 4.6 watch_validate

```
validateWatch(id, {dryRun: true}):
  watch = registry.get(id) or throw unknown_watch
  errors = validateWatchConf(watch.conf, {id})
  checkPath = resolve(watch.dir, conf.CHECK ?? platformDefaultCheck())
  errors += checkFile: exists, not directory
  argv = resolveRunner({platform, checkPath, runner: conf.RUNNER, resolveExecutable})
  if (argv === null) errors += runner_not_found
  errors += targets: 可被 `sessionController.inspect(target)` 查到（校验阶段不调用 `resolveAgent`，避免拉起 agent）
  if (errors.length) return {ok:false, errors}
  result = await runCheck({... dryRun: true, timeoutMs: effectiveTimeout(conf)})
  if (result.timedOut) return {ok:false, errors:['dry_run_timeout']}
  if (![0,1,255].includes(result.code)) return {ok:false, errors:['bad_exit_code']}
  if (result.code === 1) {
    const ev = parseEventOutput(result)
    if (ev.kind === 'invalid') return {ok:false, errors:['dry_run_event_invalid']}
  }
  state.status = state.status === 'paused' ? 'paused' : 'active'
  state.enabled = true
  state.rev += 1
  state.failures = 0; state.failureReported = false
  state.validatedAt = now(); state.lastErrorTail = undefined
  writeState()
  return {ok:true, id, status, interval, triggerMsg, sampleFrame: renderEventFrame(...)}
```

返回的 `sampleFrame` 用当前配置 + 占位证据渲染，让 agent 在汇报前看到"醒来时长什么样"。

### 4.7 日志清理

```
cleanupLogs(dir):
  files = list logs/*.log except audit.log
  删除 mtime 早于 now - retentionDays
  若剩余总大小 > maxBytes: 从最旧开始删
  .removed/ 同理保留 7 天
启动时执行一次；之后每日首次 tick 执行一次（用 localDate 判断换日）
```

### 4.8 脚本完整性（kernel.js + integrity.js）

```
refreshScriptIntegrity(now):                     # 每个 tick 调用
  对 status=active 的 watch：inspectScript()
  对 status=needs_validation 的 watch：notifyScriptChange()（到点才投、只投一次）

inspectScript(entry, now):
  scriptPath = resolve(entry.dir, entry.conf.check)
  fp = scriptFingerprint(scriptPath)             # 只 stat，不读内容
  if (state.scriptHash == null) {                # 旧 state/首次：建立基线，不打扰
     hash = fileSha256(scriptPath); 写回 state
     entry.scriptFingerprint = fp; return
  }
  if (state.scriptPath 变化) → markScriptChanged('check_path_changed')
  if (fp == null)           → markScriptChanged('script_missing')
  if (sameFingerprint(fp, entry.scriptFingerprint)) return
  hash = fileSha256(scriptPath); entry.scriptFingerprint = fp
  if (hash !== state.scriptHash) → markScriptChanged('script_changed')

markScriptChanged(): state.status='needs_validation'; 记 scriptChangedAt/NotifyAt/PendingHash；
                     entry.runnerArgv=null; nextDueAt=0; writeState + audit
notifyScriptChange(): now >= NotifyAt 且未通知过 → deliver(renderScriptChangedNotice(...))；
                      成功后记录 scriptNotifiedHash（失败下个 tick 重试）
```

- `needs_validation` 不参与 tick 调度；`/watch-resume` 在脚本哈希不符时也拒绝。
- `watch_validate` 成功后写入新 `scriptHash` 并清空变化标记。

### 4.9 可选唤醒预算（kernel.js + budget.js）

```
deliverEvent(entry, state, result, parsed, at):
  bucket = budgetFor(entry, now)                  # capacity=0 → null（关闭）
  if (bucket == null) { claimTrigger(); enqueue(event); return }

  如果 bucket.pending 存在且 tryConsume(bucket)：
      pending 转成一条事件（evidence 追加“合并了 N 条”），claimTrigger(); enqueue(pending)
  如果 bucket.pending 仍存在：mergePending(当前事件); suppressedTotal++; 写 state; return
  如果 tryConsume(bucket)：claimTrigger(); enqueue(event)
  否则：mergePending(当前事件); suppressedTotal++; 写 state
```

- 桶是内存态；`triggerCount` 只统计实际投递；`suppressedTotal` 统计被合并数。
- 默认关闭，按 watch 配置开启；对持续事件流建议保持关闭。

---

## 5. 插件装配（index.js）

```js
import z from '@deepseek-ai/schemastery'

export const name = 'watch'
export const inject = ['commands', 'tools', 'skills', 'sessionController', 'subprocess', 'timer']
export const Config = z.object({ /* 见 design §5.3 */ })

export function apply(ctx, config) {
  if (config.specDirs.length === 0) { ctx.logger.warn('watch: specDirs 为空，插件不轮询'); return }
  const registry = new WatchRegistry({ dirs: config.specDirs, logger: ctx.logger })
  const kernel = new Kernel({ ctx, config, registry })
  ctx.effect(() => () => kernel.stop(), 'watch.kernel')
  ctx.effect(() => () => registry.dispose(), 'watch.registry')
  ctx.effect(() => registerCommands({ ctx, registry, kernel, config }), 'watch.commands')
  ctx.effect(() => registerValidateTool({ ctx, registry, config }), 'watch.tool')
  ctx.effect(() => registerSkill(ctx), 'watch.skill')
  ctx.effect(() => start() /* async: scan + cleanup + tick */, 'watch.start')
}
```

要点：
- 所有资源注册都用 `ctx.effect`，插件禁用/卸载后不残留命令、工具、skill、定时器、子进程。
- `apply` 不阻塞宿主启动：`start()` 内部 catch，失败只 `logger.error` 不抛。
- 插件 row 在 `cordis.patch.yml`：

```yaml
- insert:
    - id: watch
      name: dsh-watch-kit-plugin
      config:
        specDirs:
          - /path/to/workspace/plugins/watch/watches
```

- `package.json` 必须声明 `dsh.bundle.patch`、`exports`（含 `./locale/*.json`、`./icon`）、`files` 列表（含 `assets`、`skills`）；补 `locale/en.json`、`locale/zh.json` 的 `meta.title/description` 与 `icon.svg`，否则 Plugin Manager 里是默认图。

---

## 6. 模板与 Demo

### 6.1 `assets/template/`

- `assets/template/posix/`：`watch.conf`（`CHECK=./check.sh`）、`check.sh`（可执行骨架，`set -u`、环境检查、`exit 0` 占位、注释解释退出码契约，**不能留会误触发的实现**）、`ACTION.md`（可选）。
- `assets/template/win32/`：同上，但 `CHECK=./check.ps1`、给 `check.ps1` 骨架（UTF-8 输出、`exit` 语义注释）。
- 两个 `watch.conf` 都注释齐全，只把 `PURPOSE` 留空、`INTERVAL=60`、其余键注释掉（含 `WAKE_BUDGET_*` 可选项注释）。

`/watch-add` 按 `process.platform` 复制对应模板，并替换 `PURPOSE`（若给了 `--purpose`）与 `TARGETS`。

### 6.2 `examples/dir-size/`

实现见设计文档 §10；要点是**只在首次越过阈值时 `exit 1`**，用 `$WATCH_STATE/above` 去重。测试里用它做真实子进程用例。

---

## 7. 测试策略

### 7.1 分层

| 层 | 范围 | 手段 |
|---|---|---|
| 单元 | `conf` 解析/校验、`frame` 渲染与截断、`ids` jitter、`logs` 清理 | 纯函数，`node:test` |
| 组件 | `Kernel` 调度/失败计数/合并窗口 | 注入 stub `runCheck`/`deliver`/`now`，假 registry |
| 组件 | `commands` 解析与错误分支、`tool` 的 validate 流程 | stub `invocation.agent`、临时目录、真实 `runCheck` + 假 `resolveExecutable` |
| 集成 | 真实的 `check.sh`（demo 与失败脚本）经 `exec.js`（`ctx.subprocess`）执行 | 临时目录 + `bash`，断言退出码/截断/超时/终止 |
| E2E（手工） | 装到真实 DSH，跑 `design.md` §11 的 13 条验收 | 安装文档流程 |

### 7.2 必须覆盖的用例

- [ ] `parseWatchConf`：注释、空行、引号值、未知键 warning、`TRIGGER_MSG` 空 → 回退 `PURPOSE`
- [ ] `validateWatchConf`：INTERVAL 29/30/86400/86401；TIMEOUT 0/1/INTERVAL/2/越界
- [ ] `frame`：8KB 证据截断标注；stderr 尾部 20 行；batch 顺序与编号；帧总长上限
- [ ] `kernel`：退出码 0/1/255/其它/超时/信号六种分类；`failures` 与 `failureReported` 语义；成功清零
- [ ] `kernel`：2s 内两条触发 → 1 条 batch 帧；跨 target 不合并
- [ ] `kernel`：`resolve` 失败 → orphaned + 3 次重试后丢弃 + 审计
- [ ] `commands`：id 正则与长度、重复 id、`--purpose` 带空格、未知 flag、找不到 id
- [ ] `tool`：缺 check、不可执行、干跑超时、坏退出码、成功激活（rev++、failures 清零、sampleFrame）
- [ ] `logs`：14 天删除、20MB 裁剪、`.removed` 7 天清理
- [ ] 子进程：`sleep 20; exit 1` 超时被终止；不可执行/解释器缺失报错；stdout 超大只保留上限且不阻塞
- [ ] `event`：JSON `message`/`evidence` 覆盖；缺字段回退；非 JSON 回退退出码；非法 JSON / 非 object / 字段类型错 / message 超长 / `lossy` → `invalid`；BOM 剥离；`exit 0/255` 不解析 JSON
- [ ] `runner`：平台注入（darwin/linux/win32）× 扩展名（`.sh/.ps1/.py/.js/.cmd/.exe/无`）× `RUNNER` 显式覆盖；`RUNNER=direct`；解释器缺失 → `null`；可执行位分支
- [ ] `integrity`：脚本哈希记录、外部修改 → `needs_validation`＋通知一次、validate 后恢复；resume 拒绝脚本变化
- [ ] `budget`：令牌补充/封顶、耗尽后合并、补充后补投一条、`suppressedTotal` 与 `/watch-list` 展示

### 7.3 怎么跑

```bash
cd projects/dsh-watch-kit-plugin
"$NODE" --test test/*.test.mjs        # 全部单测/组件/集成（96 项）
"$NODE" --test test/kernel.test.mjs  # 单个文件
```

测试不得依赖本机路径、不得写 `$HOME`；全部用 `fs.mkdtemp` 临时目录，结束清理。

---

## 8. 调试手册

| 现象 | 先看什么 |
|---|---|
| 命令不存在 | 插件是否加载（`Config.listConfigs` 查 entry）、`specDirs` 是否为空、是否需要重启 |
| watch 不轮询 | `state.json.status` 是否 `drafting/paused`；`/watch-list`；日志有无 `run` 行 |
| 一直不触发 | 手工跑 `cd <watch>; bash check.sh; echo $?`；看 `WATCH_STATE` 里的去重标记 |
| 触发太频繁 | `triggerCount` 增长；`check.sh` 是否每轮 `exit 1`；`INTERVAL` 是否过小 |
| 失败帧刷屏 | `failureReported` 是否被外部改坏；日志里失败原因 |
| 改配置不生效 | `specDirs` 是否正确；文件名是否 `watch.conf`；日志有无 `config reload` |
| 激活失败 | `watch_validate` 的错误码；`chmod +x check.sh`；TIMEOUT 是否违反 INTERVAL/2 |

加速调试：把 `INTERVAL` 临时改成 30（下限）、`watch.conf` 里 `CHECK=./debug.sh` 指向一个 `sleep 1; exit 1` 的脚本，验证整条唤醒链后再换回。

---

## 9. 编码规范（对齐工作区 `AGENT.md`）

1. 文档与代码必须一致：改契约先改 `design.md`，再同步代码与 skill（工作区规则 2.8）。
2. 确定性逻辑（解析、分类、合并、清理）必须有测试；交付必须给出真实运行证据（工作区规则 2.2/2.9）。
3. 所有脚本/命令幂等：重复 `/watch-pause`、重复 `watch_validate`、重复 `scan` 都不能产生副作用或重复副作用。
4. 不写工作区/用户目录之外的内容；插件只写 `specDirs` 下的 watch 目录。
5. 错误信息面向 agent：包含**可执行的下一条动作**（如 `/watch-resume <id>`、`chmod +x check.sh`）。
6. 不使用第三方依赖；不引入构建步骤；不读写 `~/.dsh` 之外的私有位置。

---

## 10. 实现清单（v0.1）

- [x] 脚手架：`package.json` / `cordis.patch.yml` / locale / icon / 目录
- [x] `config.js` + `conf.js` + `ids.js` + `text.js`（含单测）
- [x] `logs.js`（含清理单测）
- [x] `runner.js`（解释器解析，含平台注入单测）
- [x] `exec.js`（`ctx.subprocess` 执行、`terminate()` 超时、收集模式与截断，含集成测试）
- [x] `event.js`（JSON 事件解析与回退，含单测）
- [x] `frame.js`（event/failure/batch，含截断单测）
- [x] `registry.js`（扫描、state 原子写、热重载）
- [x] `kernel.js`（tick、并发、失败计数、合并窗口、orphaned 重试，含组件测试）
- [x] `command-handlers.js` + `commands.js`（6 条命令、错误分支、作者/审批 followup，含测试）
- [x] `validate.js` + `tool.js`（`watch_validate`、干跑、激活、sampleFrame，含测试）
- [x] `skills/watch-authoring/SKILL.md` + 运行时注册
- [x] `assets/template/{posix,win32}` + `examples/dir-size/`（含 `check.ps1` 移植参考）+ `examples/json-event/`
- [x] README / install 文档与实现核对（命令名、默认值、错误码）
- [x] 手工 E2E（真机，2026-10-26）：`design.md` §11 中 #1/#2/#3/#4/#6/#8/#12/#13 项 + 重启持久化/skill 加载已在 desktop profile 通过，证据见 `docs/verification.md` §9；#5 合并帧、#7 热重载、#9 卸载残留、#10 JSON 覆盖、#11 运行器矩阵由单测覆盖（真机未单独验证），Windows 未测
- [x] 独立审查修复（2026-10-26）：移除未使用的 `agents` 依赖；`/watch-remove` 增加 in-flight/removing 守卫；event/frame 证据截断去重；调度基准注释校正；项目更名为 dsh-watch-kit-plugin
- [x] 脚本完整性：激活记录哈希、变化暂停＋通知、`watch_validate` 恢复（含测试）
- [x] 可选唤醒预算：`WAKE_BUDGET_CAPACITY/REFILL_SECONDS`、合并补投（含测试）
- [x] 二轮审查修复（2026-10-26）：脚本变化通知改为与触发路径一致的重试纪律（间隔 + 3 次上限，失败审计 `script_change_drop`）；`triggerCount` 语义改为「实际投递成功的唤醒次数」（同帧多条只计一次、投递失败不计，与 design §6.4 对齐）；`/watch-list` 状态改为「中文(英文)」展示（95 项测试）
- [ ] 内存/进程检查：卸载插件后无残留定时器与子进程

---

## 11. 发布与升级

1. 确认版本号（`package.json`）与文档状态一致；`npm pack --dry-run` 或 `ls files` 校验打包清单。
2. 安装：
   - 本地目录（开发/自用）：`plugin_manager` → `install_bundle`，`target` 为**绝对路径**；
   - 升级已安装包：需要重启 backend（模块缓存）；预览/发布版走同一流程。
3. 安装结果以 `application` 与 `warnings` 为准；`applied` 后再做 E2E。
4. 回滚：`remove_bundle` 或 profile `cordis.patch.yml` 中禁用 row；watch 数据在 `specDirs` 内不受影响。
5. 破坏性契约变更（退出码、帧格式、state.json schema）必须升 `schemaVersion` 并在设计文档记录迁移办法。

---

## 12. 已知风险

| 风险 | 影响 | 应对 |
|---|---|---|
| `sessionController.resolveAgent` 是内部 API | DSH 升级可能失效 | 安装文档带 E2E 清单；升级后先跑 |
| 命令 handler 内 `followup` 的时序/UI 表现未实测 | 作者 turn 可能不出现或顺序怪 | 实现后第一件事做该实测；失败则改用 `ctx.effects` 延后一拍 |
| `source.kind` 的 UI 呈现 | 触发条标签不对 | 安装后实测；必要时改自定义 kind |
| 脚本每轮 `exit 1` | 持续唤醒 | 可选唤醒预算（默认关闭，按 watch 配置）；`triggerCount`/`suppressedTotal` 可见 |
| 宿主事件循环被阻塞 | 全会话卡顿 | 所有 IO 异步；不用 `execSync`；帧渲染纯内存 |
| macOS 睡眠 | 定时器暂停，醒来后立即补一次 | 属预期；日志记录时间跳变 |
| 用户手改文件写坏配置 | watch 失效 | 保留上一版内存配置继续跑 + `/watch-list` 标记 |
| Windows 未实测（PowerShell 编码、终止、路径） | Windows 用户可能遇到问题 | v0.1 明确标注未支持；安装文档给排查项；v0.2 实测 |
| 脚本完整性检查依赖 stat/hash | 极端情况下网络盘 mtime 抖动可能误报 | 先用 stat 指纹、变化才哈希；延迟通知；validate 可立即恢复 |
| PowerShell 5.1 默认输出编码非 UTF-8 | JSON/中文证据乱码 | 模板与文档要求先设置 `[Console]::OutputEncoding`；解析端剥离 BOM |
| `ctx.subprocess` 是宿主内部契约 | DSH 升级可能失效 | 安装文档 E2E 清单；升级后先跑 |
