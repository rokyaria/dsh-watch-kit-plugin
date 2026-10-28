# Changelog

## 0.3.1 — 2026-10-29

> 结构性重构版本：把 1659 行的单文件 mailbox 扩展拆成包，修掉一批稳定性/边界问题；
> 对外行为（CLI 子命令、JSON 契约、状态机、通知文本、插件配置与工具）保持不变。

### Changed

- **`extension/mailbox/mail.py` 拆分**：入口文件从 1659 行缩到约 30 行，只做
  `sys.path` 引导 + `from mailbox_core.cli import main`；实现移入
  `extension/mailbox/mailbox_core/`：
  `errors` / `model` / `text` / `config` / `locking` / `allowlist` / `imap` / `smtp` /
  `source` / `classify` / `state` / `records` / `legacy` / `notify` / `checker` 以及
  `cli/{__init__,parser,common,check,inbox,compose,admin}.py`。插件侧调用入口
  `extension/mailbox/mail.py` 不变，`python3 mail.py <subcommand>` 与
  `import mail; mail.main([...])` 两种用法都可用。
- **`extension/mailbox/` 结构整理**：配置模板移到 `examples/`
  （`mail.env.example` / `watches.example.json` / `allow-accounts.example.json`），
  README、随包 skill 与文档同步新路径；清理 `__pycache__`。
- **`check` 每轮最多 FETCH 200 个新 UID**：新信风暴或首次
  `--notify-existing` 大邮箱时 checker 不会因超时被反复杀死，剩余新信下一轮
  继续（状态机语义不变：未落库的 UID 仍是「新邮件」）。
- **状态库来源归一化改为按需**：只有存在非规范值（大小写/空白/旧值）时才
  `UPDATE`，避免每轮 check 对整表写 WAL；无脏值时零写入。
- **`mark` 改为全有或全无**：先整体校验所有 UID（存在、状态允许），再一个事务
  写入；任一非法时零写入并报错。重复 UID 自动去重。
- **`allow` 参数改为互斥必选**（`--list` / `--add-allow-account` /
  `--remove-allow-account` 三选一）；`--identity` 只能与 `--add-allow-account`
  一起使用。锁文件权限 0600，stale 锁处理更稳。
- **CLI 边界加固**：`read`/`attach` 的 `--uid` 非法时给出 `uid 不合法` 的可读
  错误（与 reply/mark 一致）；`list --limit` clamp 到 1–1000；`read` 优先取非附件
  `text/plain` 正文；`attach` 文件名单行化并去掉路径分隔符/Windows 非法字符、
  限制长度，避免越出输出目录。
- **UTF-8 stdio**：`mail.py` 入口把 stdout/stderr 重新配置为 UTF-8（errors=replace），
  在 Windows/重定向环境下中文与 JSON 不再乱码或抛 UnicodeEncodeError。
- **Python `state_transaction` COMMIT 失败时尝试回滚**，避免连接卡在未结束事务。
- **JS 侧透传 `limits.checker.maxErrorBytes`**：mailbox preset argv 新增
  `--max-error-bytes`（默认 2048，放在 `--folder` 之后；前 8 个 argv 位置不变）。
- **Node 小优化/修复**（详见对应测试）：路径展开统一复用 `lib/paths.js`
  （修 Windows `~\` 边界）；`oneLine` 按码点截断避免孤立代理字符；`iso()` 遇非法
  时间戳回退 `-` 而不是抛 RangeError；`applyConfig` 软删除在条目数极大（>900）时
  退化为逐行软删除（其它多 id 记账语句按 900 分块），避免撞 SQLite 单语句参数
  上限；render 的 `maxItems`/`maxBytes` 非法输入改为可预测 clamp。
- **测试重建**：Python 测试拆成 `test/python/support/`（FakeIMAP/FakeSMTP +
  `run_cli` harness）与按模块划分的测试文件（CLI 契约、checker、state/records、
  legacy、source、classify、text、allowlist/config、notify）；Node 测试更新
  mailbox preset/examples 路径并补充边界与回归用例。测试数量见下。

### Added

- `mail.py check --max-error-bytes`（插件经 `limits.checker.maxErrorBytes` 传入）：
  checker 的 `error` 字段按字节裁剪，避免超过插件上限被记为 `invalid_fields`。
- `mailbox_core` 包与 `examples/` 目录（见上）。
- Node 新增测试覆盖：`--max-error-bytes` 透传、examples 新路径、mailbox 结构
  存在性、以及上述修复的回归用例。

### Fixed

- 修复 `--max-message-bytes` / `--max-notify` / `--max-error-bytes` / `--remind-minutes`
  显式传 0/负数时的语义不一致：现在统一 clamp 到合法区间（message ≥256、
  error ≥64、notify 1–100、remind ≥1 分钟）；None/非数字才回退默认值。
- 修复旧 `source` 值为大写/带空白时不会被归一化的问题（现在任何非精确
  `ok`/`risk` 的值都会被收敛）。
- 修复 `mark` 部分成功后才报错导致的状态半更新（见 Changed）。
- 修复 `read` 对带内联附件的 multipart 邮件可能把附件正文当成正文输出的问题。
- 修复 `attach` 对恶意文件名（路径分隔符、控制字符、超长）的处理。
- 修复 mailbox preset 在极端配置下（错误信息很长时）被插件判成
  `invalid_fields` 的问题：
  - checker 的**错误附注**（同轮 FETCH 失败 + 解析失败等）现在也按
    `--max-error-bytes` 裁剪；此前附注可能超过插件上限，`notify=true` 时会导致
    整条通知被丢弃（而 `touch_notified` 已推进，邮件要等下一个提醒周期）。
  - 新增 `--max-error-bytes` 透传（见 Added/Changed）。
- 修复通知的新信/待处理分类：改为按「是否曾通知过」（`last_notified_at`）划分，
  不再按「本轮是否新插入」。此前达到 `--max-notify` 或单轮 FETCH 上限被截断的
  邮件，下一轮会出现在「待处理（已通知但未标记）」下、甚至出现「0 封新信」的
  误导性头部。
- 修复 `read` 正文上限按字符裁剪导致 CJK 正文输出可达 ~192KB 的问题：改为按
  UTF-8 字节裁剪到 64KiB。
- 加固 allowlist 文件锁：stale 锁接管前再次核对 inode/mtime，释放时只删除仍指向
  自己 inode 的锁文件，降低并发接管竞态下丢失更新的概率。
- 加固 `attach` 文件名冲突处理：dangling symlink 也视为已占用，不再跟随符号链接
  写出输出目录。
- `mark` 在极端情况下（状态行被并发删除/SQLite 触发器忽略）会向 stderr 报告实际
  更新行数，而不是无条件宣称成功。
- 修复单轮 FETCH 上限可能“饿死”后续新邮件的问题：FETCH 失败不再占满“成功处理”
  配额（每轮保留有限重试余量），前 N 个 UID 持续失败时后面的新邮件仍能逐轮推进。
- `file_lock` 修复悬空符号链接导致的忙等（不再绕过超时）；stale 锁接管与释放都做
  inode 校验，释放时不会误删已被接管的锁。
- `allow` 安全加固：默认 allowlist 路径下先确保 stateDir 0700；allowlist 用唯一
  临时文件 + `O_EXCL` 0600 原子写入（不再跟随可预测 `.tmp` 符号链接），最终文件
  再次 chmod 0600；`--add-allow-account ""` 现在报“地址不合法”而不是静默走删除分支；
  `load_allow_file` 的非法地址错误文案恢复为 `允许名单地址不合法:`。
- `clip_utf8` 对孤立 surrogate（surrogateescape 参数/异常来源数据）不再抛
  UnicodeEncodeError，checker JSON 与通知不会因编码错误整条丢失。
- `read` 正文选择把“带 filename 但无 Content-Disposition”的 text/plain 视为附件，
  优先输出真正的正文 part；正文上限仍按 UTF-8 字节 64KiB。
- `attach` 文件名改为按 UTF-8 字节（≤200B，保留扩展名）限长，避免 Linux ext4
  NAME_MAX 下 `ENAMETOOLONG`；碰撞名同样限长。
- `records.list_messages(status=...)` 对非法状态值改为抛 `MailboxError`（不再静默
  返回全部行）；每次 check 会更新当前 scope 的 `updated_at`，UIDVALIDITY 回退时
  `status`/`list` 显示当前 scope 而不是旧 scope。
- Node 侧独立审查修复：
  - **P1 数据丢失**：`syncMailboxSkill` 的目录合并遇到已存在同名子目录时原先直接
    跳过，恢复/归档后删除源目录会丢失其中未合并的文件；改为递归合并（文件默认
    不覆盖），restore/disable 两个方向都有回归测试。
  - **P2**：`getCompensations()` 查询失败不再被当成“没有历史失败”——保留失败
    计数（不无补偿清零）并 warn，下一轮再补。
  - **P2 权限**：`watch.db` 及新建父目录按 0700 创建、DB/WAL/SHM 尽力 chmod 0600
    （已有目录不改权限），避免 `runs.message` 中的 checker 输出（mailbox 通知含
    发件人/主题）在共享 `DSH_HOME`/显式 `dbFile` 下被其他本地用户读取。
- 文档审查修正（独立审查发现）：`last_error` 受 `hours` 窗口限制、`error` 仅
  `notify=true` 时进唤醒消息、preset 校验对象、`maxMessageBytes` 受
  `maxStdoutBytes` 约束、安装 prompt 按“有无受管 profile”分流、回滚 0.3.0 后需
  重发 `/watch-reload`、Date 缺失/prune 重通知边界、迁移 pending 的 scope 条件、
  read 64KiB 字节口径、stderr 与 JSON error 去向、watch.db 权限说明等。

### Tests

- Python：262 个测试（`unittest`，3.9.6 与 3.12.10 双绿），覆盖原
  48 个用例的全部行为并新增包级单测。
- Node：114 个测试（Node 24.21，11 个测试文件，`node --test test/*.test.mjs` 全绿）。
- 回归保障：checker error 裁剪（含附注）、FETCH 上限与失败不饿死后续新信、mark
  原子性、source 归一化、attach 文件名（含符号链接/UTF-8 字节限长）、allowlist
  权限与锁、read 正文选择/字节上限、通知新信分类、UIDVALIDITY 回退 scope；Node
  侧 `--max-error-bytes` 透传、mailbox-skill 递归合并、补偿查询失败保留计数、
  watch.db 权限、大参数分块、JS↔Python argv 互验均有专门用例。
- 重构过程另做了一次**差分核对**（脚本不随包）：用 git HEAD 的旧单文件实现与新实现
  在 8 组核心场景（baseline、新信、提醒、SEARCH/FETCH 失败、allowlist 收紧、旧邮件、
  UIDVALIDITY 变更、`--notify-existing`、reply）下逐项比较 stdout JSON、DB 状态、
  `list`/`status` 输出与 reply 邮件头，3.12/3.9 下均一致（重构不改变既有语义）。

### Docs

- `README.md` 重写为面向用户的项目入口（定位、最短上手、配置/checker 契约、
  行为边界、兼容性）；安装细节移到新的 `install.md`。
- 新增 `install.md`：三条安装入口（Web 插件页 / Creator + plugin_manager /
  手动兜底）、可复制的 agent 安装 prompt、安装后验证清单、升级/卸载/排障。
- `docs/development.md` 重写：新增「项目性质与测试边界」章节（典型场景、独立
  审查者不应过度理解的边界、测试覆盖与不覆盖的范围）；更新 Node/Python 模块表、
  架构、数据模型、调度/投递语义、已知缺陷与取舍、发布流程。
- `extension/mailbox/README.md` 重写：新目录结构、CLI 全表、状态机/保留期/权限/
  UIDVALIDITY/并发假设、来源 OK/RISK、注入防护、附件与用户文件规则、排障；
  去掉旧文重复段落。
- `skills/watch-kit/SKILL.md`、`extension/mailbox/skills/watch-mailbox/SKILL.md`
  更新到 v0.3.1 的结构与路径，行为语义不变。
- `package.json`：版本 0.3.1；`files` 增加 `install.md`；新增 `test:python` /
  `test:all` 脚本；keywords 补充 mailbox/imap/python。

### Upgrade

- 不需要迁移运行时数据：watch.db 与 mailbox 状态库 schema 未变；`/watch-reload`
  与现有 `watches.json` 无需修改即可继续使用。
- 如果你在脚本/文档里引用了随包模板的旧路径，请改用
  `extension/mailbox/examples/` 下的新路径。
- `mail.py` 仍是唯一调用入口（`preset: "mailbox"` 生成的 argv 不变，仅追加可选的
  `--max-error-bytes`）。升级后建议执行一次 `selfcheck` 或等一轮 `check`，
  并用 `watch_runs` 确认没有新的 `invalid_fields`。

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
