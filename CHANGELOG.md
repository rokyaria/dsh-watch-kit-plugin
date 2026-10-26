# Changelog

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
