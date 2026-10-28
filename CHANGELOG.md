# Changelog

## 0.3.0 — 2026-10-28

### Changed

- mailbox 状态改为**按每封邮件 UID 记录**的 SQLite（`<stateDir>/<account>.sqlite3`）：首次检查把当前邮件标为 `ignored` 基线；之后“新邮件”以数据库是否存在该 UID 判断，不再使用 `last_seen_uid`。allowlist 内新邮件进入 `pending`，`reply` 标记 `replied`，`mark` 标记 `no_receipt`；`pending` 每轮都会检查并在超时后再次通知，直到被标记。SEARCH 失败不再修改状态；单 UID FETCH 失败不落库、下轮重试；解析失败落为 `invalid`。旧 JSONL 状态首次打开时迁移到 SQLite。
- 来源验证恢复为保守的 OK/RISK 两态：读取接收方第一条 `Authentication-Results`；只有 `dmarc=pass`、`spf=pass` 或 `dkim=pass` 至少一项、`header.from` 与 `From` 域对齐才 `source=ok`，其余（缺失、解析失败、DMARC 失败、域名不一致）全部 `source=risk`。通知、`list`、`read` 显式显示 OK/RISK；`user` 身份来源 RISK 时按 guest 处理，不能作为所有者授权。
- mailbox skill 归档改为**整目录**：停用整个 `skills/watch-mailbox/` 移入归档；目标不存在时从归档恢复整个目录；空/缺 SKILL 的目标不会覆盖最后一份归档。
- mailbox 通知字节上限接入插件 `limits.checker.maxMessageBytes`（通过 preset argv 传给 `mail.py`）。
- 路径解析统一展开 `~` 并 `resolve()` 成绝对路径：`DSH_HOME`、显式 `configFile`/`dbFile`、watch `cwd`、mailbox skill 路径。
- `reply` 在发送前校验 state 的 folder/UIDVALIDITY，避免 UID 错配时回复错人；`mark` 同样校验。
- README/docs/package 同步：`docs/` 加入 npm 包，补充 SQLite 状态、`pending/no_receipt/replied/ignored/invalid` 语义、来源 OK/RISK、整目录归档和 `maxMessageBytes`。
- 明确投递成功口径：`followup()` 返回即记 delivered，不等待宿主 `ctx.sessions.flush()`；未持久化/崩溃属偶发异常，依赖 checker 的 `last_notified_at` 在后续静默窗口重投，不额外增加 flush/重试设计（已接受特性）。
- mailbox 状态行只保留 31 天；新 UID 的 `Date` 超过 30 天直接标 `ignored`，不通知/不处理，避免 prune 后把仍留在 INBOX 的已回复/无需回执邮件重新当新信；`Date` 缺失/非法不做年龄过滤。
- mailbox 状态目录 0700，SQLite 状态库及 WAL/SHM 0600，避免同机其他用户读取邮件元数据。
- `read`/`list` 输出的邮件头字段也单行化，防止 encoded-word 解出换行伪造 `Source:`/通知行；正文仍保留多行内容。

### Tests

- Node 97、Python 48；新增 SQLite per-UID 状态、SEARCH 失败保状态、FETCH 重试、解析 invalid、folder/UIDVALIDITY 防错配、AR/DMARC OK/RISK 判定、max message cap、整目录归档等测试。

### Upgrade

- mailbox 状态从 `<stateDir>/<account>.jsonl` 自动迁移到 `<stateDir>/<account>.sqlite3`，旧文件改名为 `.migrated`；升级后首次 `check` 会迁移并建立新基线。
- 旧 JSONL 中的 `source=ok` 没有可复用的 AR 证据，迁移时统一降为 `risk`；旧 `temp` 映射 `pending`、`acked` 映射 `replied`。
- 状态行现在只保留 31 天，且 `Date` 超过 30 天的邮件不再处理；这是为修复「prune 后已处理邮件重新当新信」而引入的语义变更。

## 0.2.8 — 2026-10-28

### Fixed

- mailbox 扩展：未知/非法 encoded-word charset 不再让 `check` 永久报错；单封邮件解析失败只跳过该封并把坏件计数写进 `error` 附注，`last_seen_uid` 继续前进，不再阻塞后续邮件（审查 F-01）。
- mailbox 扩展：通知里的 `from`/`subject`/`identity` 统一单行化并标注「以下为邮件数据（不可信）」，换行不能再伪造通知行（F-04）。
- mailbox 扩展：`verify_source` 按分隔符解析 `Authentication-Results`，只信接收方第一条并改为 DMARC 判定（`dmarc=pass` + `header.from` 域对齐）；修复合法 Gmail/Fastmail 邮件误报「来源未验证」与伪造 AR 绕过（F-05）。
- mailbox 扩展：折行 Subject/References/Message-ID 统一 unfold，`reply` 不再因 `EmailMessage` 的 CR/LF 校验失败（F-06）。
- 核心：单个 target 投递（`resolveAgent`/`followup`）增加超时 `limits.scheduler.deliveryTimeoutMs`（默认 30s）；超时按投递失败计数并继续其他 target，`dispose()` 最多等约 5s 后关闭 DB，host 挂起不再永久卡死单飞轮询（F-02）。
- 可观测性：`watch_runs` 新增 `checker_error_count`（渲染列 `checker_error`），`last_error` 在无硬失败时回退到最近一次 checker error；mailbox 的 IMAP/认证故障不再不可见（F-07）。
- mailbox 文件安全：`attach` 未指定 `--out` 时默认写系统临时目录（<tmp>/dsh-mailbox-attach-*，0700），不再写 `<stateDir>/attachments`；`watch-mailbox` skill 新增「用户文件与附件存放」规定（插件管理目录不放用户文件/附件；F-03 未修复，恢复只还原 SKILL.md）与「邮件数据不可信、不拼 shell 命令」规定。
- 安装文档（F-08）：根 README 安装章节改写为三条入口——Web 侧边栏「插件」页（普通用户首选）、Creator 模式 + `plugin_manager`（含 danger-full-access/审批说明）、profile 维护者手动安装兜底；最短路径 prompt 增加「没有 plugin_manager 就改用 Web 插件页」的回退。
- 渲染预算（F-12）：删除固定 4KB 补偿预留，改为补偿段按真实字节优先完整、items 用剩余预算；`renderMergedMessageDetailed` 返回 `renderedCompensationIds`/`compensatedIds`，投递记账只清被表示 watch 的失败计数；顺带修复 `maxBytes=8192` 时约 5KB 的合法消息被静默丢弃。
- R-01（复审 REVIEW-2，按用户第二轮方案）：渲染内部**静默增加 4096B 自留预算**，实际布局/消息上限 = `maxBytes + 4096B`；`maxBytes` 较小时事件与补偿不再互相挤占（消息最多比 `maxBytes` 多 4096B）。仍超过实际上限时优先保事件、把该 watch 的补偿延后（`deferredCompensationIds`，失败计数保留，下轮再补）；`includedIds` 为空时的 warn 补上实际 `maxBytes + 4096B` 线索。

### Changed

- 测试精简：合并两轮修复中重叠/同流程的用例（Node 98 → 94，Python 36 → 29），被合并用例的断言全部保留；回归覆盖与旧代码失败保护不减。
- 文档一致性审计（按代码实际行为修正，不改行为）：Python 版本统一为 3.9+（实测 3.9.6/3.12，推荐 DSH 捆绑 3.12）；watch_runs/watch_sessions 区分「模型可见 render 列」与 canonical JSON 字段，并注明 delivery_fail/last_run/last_notify 非窗口值；被丢弃事件改为「无明细、只能看聚合」；统一 Config/patch 生效与热加载说法；allowlist identity 改为任意标签；watch-kit SKILL 版本号、发布清单（watch-mailbox 文件落地而非注册）、模块表（补 lib/paths.js）、limits/上限默认可配标注、mailbox.maxNotify 与 allowAccountFile 等配置文档、状态文件「单 JSON 快照」、提醒反复语义、check 错误 JSON 限定、附件默认临时目录等。
- 清理修复残留：移除已不可达的补偿降级分支（死代码）并简化渲染收尾；清理源码与测试中的修复历史/审查编号注释；文档同步当前实现（4096B 自留预算、事件优先回退、无降级路径）。

### Tests

- Node 94 个测试、Python 29 个测试（基线 81/18；覆盖 F-01/F-02/F-04/F-05/F-06/F-07/F-12、R-01 4096B 自留预算与事件优先、attach 默认临时目录与 skill 文档断言）。
- 回归用例仍在 HEAD 旧代码上失败（Node 17 个测试、Python 14 条失败记录），防止同类回归；文档同步根 README、extension README、watch-mailbox/watch-kit skill、docs/development.md。

## 0.2.7 — 2026-10-28

### Changed

- `mail.py` 移除全部身份语义与硬编码，只做数据传递：allowlist 的 `identity` 可以是**任意标签**（不再限定 user/guest）；SPF/DKIM 结果只作为 `source` 数据返回，**不再把未验证的 user 降级为 guest**；附件下载/回复带附件**不再按身份做代码门禁**（`attach --force` 保留为兼容参数，无行为）。
- `allow --identity` 不再限定可选值，任意标签都可写入 allowlist。
- `watch-mailbox` skill 更新身份约定：身份标签由 allowlist 定义、行为由 skill 约定；默认 user/guest 约定保留，自定义标签未约定时按 guest 处理，来源未验证一律按 guest 处理。
- 文档同步：extension README §2/§5、项目 README。

### Tests

- python 测试改为断言“声明身份保留 + 来源未验证标注”；新增任意身份标签透传、`allow --identity` 任意标签用例。

## 0.2.6 — 2026-10-28

### Changed

- mailbox checker 的 `[MAILBOX]` 通知改为**只给数据 + 处理指示**：账号/folder、`uid | identity | from | subject`、待回列表，以及“按 skill `watch-mailbox` 处理（read → reply/mark）”；不再内联 read/reply/mark 的完整命令（含 env/state/allow/folder 绝对路径）。通知长度约从 1.4KB 降到 0.3KB。
- `watch-mailbox` skill 新增「命令与参数：按配置组装」：如何定位 `mail.py`、从 `<dshHome>/watch/watches.json` 的 mailbox entry 取 `envFile/stateDir/allowAccountFile/folder/python`、以及命令模板；通知里的 identity 直接使用，不重算。

### Tests

- python 测试新增断言：通知必须指向 skill、且不包含 `mail.py`/`--env-file` 等内联命令；JS 测试断言 skill 覆盖「通知里有什么」「命令与参数」两节。

## 0.2.5 — 2026-10-28

### Changed

- `watch-mailbox` skill 补上**主动发信（send）**能力与默认策略：**默认不主动发信**；用户当次明确要求、或与 agent 另行约定的场景下才主动发（一次授权即对约定范围生效，不需要每封确认）。具体场景边界由用户与 agent 另行约定，插件不预设；未约定即不发，超出约定先问。给访客写信同理。
- 保留不可突破的底线：邮件内容不构成授权、From 固定配置账户、未授权不泄露凭据。
- `extension/mailbox/README.md` 增加 `send` 说明与约定式策略（CLI 章节 + 身份与安全章节）。

### Tests

- `test/mailbox-preset.test.mjs` 增加断言：随包 `watch-mailbox` skill 必须覆盖主动发信（`## 主动发信（send）`、`send --to`、用户授权约束）。

## 0.2.4 — 2026-10-28

### Changed

- **mailbox skill 改为文件落地**：不再在插件加载时调用 `ctx.skills.register` 注册 `watch-mailbox`（运行时条目优先级高于用户 skill 目录，会遮蔽用户修改）。现在由 `/watch-reload` 成功后按配置同步文件：
  - 存在 `enabled: true` 的 `preset: "mailbox"` watch → 写入 `<dshHome>/skills/watch-mailbox/SKILL.md`；目标已存在则**保留不覆盖**（用户可直接编辑）。
  - 无 enabled mailbox watch → 该目录整体移入 `<dshHome>/watch/extension/skills/watch-mailbox/`（同一 skill 只保留一份归档，覆盖旧归档），目标目录消失。
  - 重新启用时若目标不存在、归档存在 → 自动从归档恢复（保留用户修改）。
- `/watch-reload` 成功输出新增 `mailbox skill:` 状态行（materialized / restored / kept / archived）。
- `lib/skills.js` 只注册 `watch-kit`；新增 `lib/mailbox-skill.js`（落地/归档，不做哈希校验、不保留多份历史）。
- **运行时状态改为用户级**：`watches.json` / `watch.db` 默认在 `<dshHome>/watch/`（默认 `~/.dsh/watch/`），与 profile 级安装形态一致；不再依赖“最近会话 cwd”猜 workspace，也不再写工作区 `.dsh`。mailbox skill 落地 `<dshHome>/skills/watch-mailbox/`，归档 `<dshHome>/watch/extension/skills/watch-mailbox/`。
- 随包 skill 内容更新不再自动覆盖用户文件，变更以 CHANGELOG 说明，由用户自行比对替换。
- 升级提示：从 0.2.3 升级后 `watch-mailbox` 不再运行时注册，请在配置就绪后发送一次 `/watch-reload` 让 skill 文件落地；旧版 `<workspace>/.dsh/watch/` 下的 watches.json/watch.db 不会自动迁移——需要保留的话复制到 `~/.dsh/watch/`（或在 profile patch 里显式指向旧路径），再 `/watch-reload`。

### Docs

- README / `extension/mailbox/README.md` / `watch-mailbox/SKILL.md` 更新"放宽行为"与归档说明。
- `docs/development.md` 模块表与 skill 说明同步。
- `skills/watch-kit/SKILL.md` 更新到 v0.2.4 对外表面：用户级状态路径、mailbox skill 落地/归档、状态位置速查。

### Tests

- 新增 `test/mailbox-skill.test.mjs`（9 例：materialized / kept / restored / archived / 单份归档 / absent / 路径布局/workspace 必填 / reload 端到端）；`test/apply.test.mjs` 断言运行时只注册 `watch-kit`。测试 72 → 81。

## 0.2.3 — 2026-10-28

### Added

- 插件 Config 新增 `limits.checker` / `limits.message` / `limits.scheduler`，可覆盖原来写死在 `lib/checker.js`、`lib/render.js`、`lib/poller.js` 的 stdout/stderr/message/error 字节上限、合并消息条数/字节上限、单轮并发和 runs 保留天数；带上下限护栏，默认值保持原行为。
- README/development 文档说明 stdout 只应作为唤醒信号，正文/大结果写文件。

### Fixed

- `skills/watch-kit/SKILL.md` 和 `extension/mailbox/skills/watch-mailbox/SKILL.md` 补上可直接发现的 YAML frontmatter（`name`/`description`），复制到 `.dsh/skills/` 后可直接使用。
- 移除两个 `SKILL.md` 及运行时注册中的 `whenToUse` 元数据。DSH 默认模型侧 skill 目录只渲染 `name` + `description`，`whenToUse` 不参与自动触发；触发词集中到 `description`：`watch-mailbox` 补上“`[MAILBOX]` 通知 / 查看/回复邮箱”，`watch-kit` 原有触发词保留；正文首段仅作加载后确认。
- 运行时 `ctx.skills.register` 注册前剥离 frontmatter，避免加载后的 skill body 重复显示 YAML。
- 移除 skill 内的 `{{...}}` 占位符：`watch-kit` 指向公开 README，`watch-mailbox` 说明直接使用 `[MAILBOX]` 通知里的完整命令；不再依赖运行时路径替换。

### Changed

- 版本 0.2.3。

## 0.2.2 — 2026-10-28

### Added

- 随包 `extension/mailbox/` 扩展：单文件 `mail.py`（Python 3.10+，仅标准库）同时作为 checker 和 agent CLI，支持 IMAP/SMTP、附件、多账户。
- `watches.json` 的 `preset: "mailbox"`：直接配置 `envFile`/`stateDir`/`allowAccountFile`/`remindAfterMinutes`，插件自动映射到随包脚本，用户不需要写 checker 路径或参数。
- JSONL 状态机：新信 `temp` → 30 分钟未处理提醒并延长免打扰 → reply 成功自动 `acked`，或显式 `mark`；首次运行默认建立基线不通知历史邮件。
- per-account allowlist（`user`/`guest`，支持 `*`）：默认不通知任何人；user 检查 SPF/DKIM，guest 采用保守回复与附件策略。
- 随包运行时 skill：`watch-kit`（用户提到本插件时先读 README）、`watch-mailbox`（read/reply/mark、身份与附件严格策略）。
- 扩展模板：`mail.env.example`、`allow-accounts.example.json`、`watches.example.json`（mailbox entry 默认 `enabled: false`）。

### Changed

- 版本 0.2.2；npm `files` 增加 `extension/` 与 `skills/`；包内文档入口增加 mailbox 扩展说明。
- 新增技能的注册依赖 `skills` 服务；插件 inject 增加 `skills`。

## 0.2.1 — 2026-10-27

> 破坏性重写：从「命令创建 + watch 目录 + 校验流程」改为「SQLite 配置 + 轮询 + JSON checker 契约 + 合并唤醒 + 观测工具」。

### Removed

- v0.1 的全部 watch 管理命令、模型侧工具、skill。
- watch 目录与配套文件约定、随包模板/示例/docs/skills 资产。
- 旧版附加机制：完整性校验、旧调度与唤醒节流、持久状态机。

### Added

- 配置文件（JSON）`watches` 数组 + `/watch-reload` 事务化同步（软删除/复活/绑定 target）。
- SQLite（`node:sqlite`）持久化 watches/runs（WAL、`user_version=1`、runs 保留 7 天）。
- JSON checker 契约：只读 stdout 的 JSON（`notify`/`message`/`error`），退出码不参与语义；失败分类 `invalid_json`/`invalid_fields`/`spawn_error`/`timeout`。
- 轮询调度：`pollIntervalMs` 默认 10000、启动立即轮询、单飞、`BEGIN IMMEDIATE` claim、单轮并发 4。
- 合并唤醒：每个 target 每轮最多一条消息（≤20 watch / ≤16KB，超出丢弃后段）。
- 投递失败计数，以及下一次成功投递时的一次性补偿段（不重试、不重放）。
- 观测工具 `watch_runs`、`watch_sessions`。
- 面向贡献者的 `docs/development.md`：架构、数据模型、调度/投递语义、Host API、测试与发布流程。

### Fixed

- 合并消息触发 20 条/16KB 上限时，只把实际写入消息的 watch 标记为已投递/已通知，被丢弃事件保持未投递（不再静默丢事件或虚增 `notified_count`）。
- 单条 `recordRun`/单 target 投递记账失败不再中断整轮 poll；成功记账改为一个事务；投递前复查 watch 是否已删除/停用/改绑 target。
- `watch_runs.last_error` 限定在请求时间窗内；`watch_sessions` 不再过滤 blank 会话；DB `user_version > 1` 拒绝打开；apply 注册失败时关闭 DB/poller。

### Changed

- 插件 Config 收敛为 3 项：`pollIntervalMs`、`configFile`、`dbFile`；默认路径 `<dshHome>/watch/`。
- 版本 0.2.1；`engines.dsh = ^0.2.1-rc.3`；peerDependencies 为 `@deepseek-ai/dsh-llm`、`@deepseek-ai/dsh-tools`、`@deepseek-ai/schemastery`。
- 包内文件仅保留 `lib/`、`locale/`、`icon.svg`、`cordis.patch.yml`、CHANGELOG、README（加上自动打包的 LICENSE）。

### Migration

- 旧 watch 目录不再读取：把每个 watch 写成 `watches.json` 的一个条目（`checker` 用 argv 指定），首次安装后执行一次 `/watch-reload`。
- 旧 checker 若依赖退出码语义，改为输出 JSON（`notify`/`message`/`error`）；状态与提醒内容由 checker 自行维护。

## 0.1.0 — 2026-10-26

- 首个可用版本：命令创建 watch 目录、退出码/JSON 事件、校验与合并唤醒、skill。
