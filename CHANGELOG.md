# Changelog

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

- 插件 Config 收敛为 3 项：`pollIntervalMs`、`configFile`、`dbFile`；默认路径 `<workspace>/.dsh/watch/`。
- 版本 0.2.1；`engines.dsh = ^0.2.1-rc.3`；peerDependencies 为 `@deepseek-ai/dsh-llm`、`@deepseek-ai/dsh-tools`、`@deepseek-ai/schemastery`。
- 包内文件仅保留 `lib/`、`locale/`、`icon.svg`、`cordis.patch.yml`、CHANGELOG、README（加上自动打包的 LICENSE）。

### Migration

- 旧 watch 目录不再读取：把每个 watch 写成 `watches.json` 的一个条目（`checker` 用 argv 指定），首次安装后执行一次 `/watch-reload`。
- 旧 checker 若依赖退出码语义，改为输出 JSON（`notify`/`message`/`error`）；状态与提醒内容由 checker 自行维护。

## 0.1.0 — 2026-10-26

- 首个可用版本：命令创建 watch 目录、退出码/JSON 事件、校验与合并唤醒、skill。
