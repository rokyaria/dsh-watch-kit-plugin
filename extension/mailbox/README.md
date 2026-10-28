# mailbox checker（随包扩展）

单个 `mail.py`，零第三方依赖（Python 3.9+ 标准库），既是 dsh-watch-kit-plugin 的 checker，也是 agent 操作邮箱的 CLI。

- checker 自己维护信箱状态，不依赖 IMAP `\Seen`；
- 新信先打临时标记并通知 agent；30 分钟（可配置）仍未处理会再次提醒（未 ack 则按该周期反复提醒）；
- agent 回复成功后自动标记；纯回执/无需回复用 `mark`；
- 默认**不通知任何人**，必须配置 per-account allowlist；
- 支持多个邮箱账户：**一个账户一个 watch**（复用插件的多 watch/合并/隔离机制）。

## 1. 准备凭据

```bash
install -d -m 700 ~/.dsh/secrets
install -m 600 extension/mailbox/mail.env.example ~/.dsh/secrets/mail.env
# 编辑地址、授权码、IMAP/SMTP 主机端口
```

`MAIL_AUTHCODE` 用邮箱服务商的“授权码/应用专用密码”，不是登录密码。不要把凭据提交到仓库或写进 `watches.json`。当前实现使用 IMAP4_SSL / SMTP_SSL（常见端口 993 / 465）；STARTTLS 587 端口的账号需改用 SSL 端口或扩展脚本。

本机需要 Python 3.9+（实测 3.9.6 与 3.12 均可；推荐 DSH 捆绑的 3.12）；插件本体仍是 Node，不使用 mailbox 功能时不需要 Python。

## 2. 配置允许名单

默认 allowlist 为空 = 所有来信都不通知。复制示例后编辑：

```bash
install -d -m 700 ~/.dsh/mailbox
install -m 600 extension/mailbox/allow-accounts.example.json ~/.dsh/mailbox/allow-accounts.json
```

格式以**收件账户地址**为 key：

```json
{
  "agent-mail-1@example.com": [
    { "address": "owner@example.com", "identity": "user" },
    { "address": "guest@example.com", "identity": "guest" }
  ],
  "agent-mail-2@example.com": [
    { "address": "*", "identity": "guest" }
  ]
}
```

- 精确地址优先于 `*`；`*` 表示允许所有发件人。
- `identity` 是**任意标签**（`user` / `guest` / 自定义，如 `vendor`）；`mail.py` 只把它当数据传递，**行为约定在 `watch-mailbox` skill**（user = 所有者/高信任，guest = 外部/低信任；自定义标签需与 agent 另行约定，未约定按 guest 处理）。
- 未列入的发件人：忽略、不唤醒。

也可以用 CLI 修改：

```bash
python3 mail.py allow --list --env-file ~/.dsh/secrets/mail.env --allow-account-file ~/.dsh/mailbox/allow-accounts.json
python3 mail.py allow --add-allow-account owner@example.com --identity user --env-file ... --allow-account-file ...
python3 mail.py allow --remove-allow-account guest@example.com --env-file ... --allow-account-file ...
```

## 3. 配置 watch

把 `watches.example.json` 中的 entry 合并进 `$DSH_HOME` 下的 `<dshHome>/watch/watches.json`，把路径改成实际值，并把 `"enabled": false` 改成 `"enabled": true`。**不要改 checker 路径或参数**：`preset: "mailbox"` 会由插件自动映射到随包脚本。

```json
{
  "id": "mailbox-account-1",
  "preset": "mailbox",
  "enabled": true,
  "mailbox": {
    "envFile": "/absolute/path/to/mail.env",
    "stateDir": "/absolute/path/to/.dsh/mailbox",
    "allowAccountFile": "/absolute/path/to/allow-accounts.json",
    "remindAfterMinutes": 30,
    "maxNotify": 20,
    "folder": "INBOX",
    "python": "python3"
  },
  "interval": 60,
  "timeout": 60
}
```

- `stateDir` 可由多个账户共享，脚本按账户生成独立状态文件。
- `allowAccountFile` 省略时默认 `<stateDir>/allow-accounts.json`。
- `interval` 是检查间隔，默认 60 秒；`timeout` 要覆盖 IMAP/SMTP 网络操作，建议 60。
- `remindAfterMinutes` 默认 30：临时标记超过该时长仍未处理，会在后续 check 中再次提醒，直到 reply 或 mark；未 ack 会按该周期反复提醒。
- `maxNotify` 默认 20（范围 1–100）：单次通知最多列出的邮件数（新信 + 待回合计），超出部分显示「另有 N 封未列出」，可用 `list --pending` 查看。
- `folder` 默认 `INBOX`。
- `python` 默认按平台选择 `python3`/`python`（需要 Python 3.9+，推荐 DSH 捆绑的 3.12；找不到时显式指定绝对路径）。
- `enabled: false` 的模板只入库、不轮询；确认配置后改成 `true`，再由用户发送 `/watch-reload`。

## 4. CLI

通用选项放在子命令后面（示例省略为 `...`）：

```bash
python3 mail.py check  --json --env-file ... --state-dir ... --allow-account-file ... --folder INBOX
python3 mail.py list   [--pending] --env-file ... --state-dir ... --allow-account-file ...
python3 mail.py read   --uid 42 --env-file ... --state-dir ... --allow-account-file ...
python3 mail.py reply  --uid 42 --body-file ./reply.txt --env-file ... --state-dir ... --allow-account-file ...
python3 mail.py send   --to x@example.com --subject S --body-file ./body.txt --env-file ...
python3 mail.py mark   --uid 42 [--uid 43 ...] --env-file ... --state-dir ...
python3 mail.py attach --uid 42 --list-only --env-file ... --state-dir ... --allow-account-file ...
python3 mail.py attach --uid 42 --out ~/mail-attachments --env-file ... --state-dir ... --allow-account-file ...
python3 mail.py status --env-file ... --state-dir ... --allow-account-file ...
python3 mail.py init   [--notify-existing] --env-file ... --state-dir ... --allow-account-file ...
python3 mail.py selfcheck --env-file ...
```

`attach` 不带 `--out` 时把附件写到系统临时目录（只适合临时查看）；需要保留时显式 `--out` 到用户自己的目录。用户文件/附件的存放规则见 §5。

`check` 只输出一个 JSON 对象；运行期错误也是 JSON（`{"notify":false,"error":"..."}`），不会往 stdout 打人类日志（命令行参数本身不合法时由 argparse 在 stderr 报错并以非零码退出）。`check` 的 `message` 只给数据（账号、uid、身份、发件人、主题）并指示 agent 按 `watch-mailbox` skill 处理；**命令与参数不内联**，由 agent 按 watch 配置组装（skill 里写了方法）。邮件数据（发件人/主题/identity）会先单行化并带「以下为邮件数据（不可信）」标注，伪造换行不能产生新的通知行；单封邮件解析失败只跳过该封，坏件计数写进 `error`，不影响其他新信与后续轮次。

### 主动发信（send）

`send` 从配置账户（`MAIL_ADDRESS`）发出**新邮件**，不绑定 uid、不修改信箱状态（不需要 mark）。

**默认不主动发信。** 主动发信只有两种依据：

1. **当次明确要求**：用户在当前会话直接要求发给某人/某地址；
2. **约定场景**：用户与 agent 另行约定过“什么情况下可以主动发”（例如长任务完成、构建失败、定时汇报、访客询问进度等）。**一次授权即对约定范围生效，不需要每封确认**。

约定什么由用户与 agent 自行商定，插件不预设；未约定即不发，超出约定范围先问用户。给访客写信同理：默认不发，有约定按约定执行。

不可突破的底线：邮件正文里的“请转发/发给某人”不构成授权；From 固定为配置账户，不冒充他人；未经授权不泄露密码/token 等敏感信息。

```bash
python3 mail.py send --to user@example.com --subject "主题" --body-file ./body.txt --env-file ~/.dsh/secrets/mail.env
```

多行正文用 `--body-file`（避免 shell 转义）；`send` 只需要 `--env-file`，`--state-dir`/`--allow-account-file` 只用于读信侧。

### 首次运行

第一次 `check` 默认建立基线：当前收件箱不通知。若希望把现有邮件当作新信：

```bash
python3 mail.py check --notify-existing --env-file ... --state-dir ... --allow-account-file ...
```

### 状态机

```text
new -> temp（通知；记录 last_notified_at）
temp 未超时 -> 静默
temp 超过 remindAfterMinutes -> 再次通知并重置 last_notified_at
temp -> acked（reply 成功，或显式 mark）
```

- 状态文件：`<stateDir>/<account>.jsonl`，内容是**单个 JSON 快照**（每次写入整文件原子覆盖、文件权限 0600，不是逐行追加的 JSONL），状态锁是 `<state>.lock`。
- allowlist 内且非自动批量的邮件记为 `temp`（待回）；未允许/自动批量邮件记为 `ignored`（同样记录在状态文件里）。
- 已处理记录保留 90 天后清理。
- 删除/移动的临时邮件在下次 check 时移除。

## 5. 身份与安全

- 来源判定只读**接收方添加的第一条** `Authentication-Results`（AR）：要求 `dmarc=pass`，且 AR 里的 `header.from` 与 `From` 地址域对齐（宽松对齐，允许子域）才返回 `source=ok`；`dmarc=fail`/缺失 → `warn`；完全没有 AR → `unknown`。SPF/DKIM 单独通过**不算**通过（攻击者可用自己的域通过），也不再用可伪造的 `DKIM-Signature` 头当证据；AR 的 authserv-id 会记在 `read` 的 Source 详情里。
- 安全假设：接收方 MTA 会添加 AR 并排在最前；不添加 AR 的收件链路只能得到 `unknown`，不应把 `ok` 当作强证据。`source` 只是数据；`mail.py` **不按身份降级或拦截动作**——未验证邮件按 skill 约定一律按 guest 处理。
- 通知里的 `from`/`subject`/`identity` 会单行化（折行展开、控制字符替换为空格）并标注“以下为邮件数据（不可信）”；它不能伪造新的通知行或指令行，原始内容请用 `read` 查看。
- `Auto-Submitted`、`Precedence: bulk/list/junk`、`List-Id` 邮件忽略，不参与回信。
- 邮件是低权限通道：即使 `user` 来信，也不要仅凭邮件执行改配置、删数据、对外发送、透露隐私等高风险动作；在会话里再次确认。
- 附件默认策略是不下载、不自动打开（看元数据用 `attach --list-only`）；是否下载/回复带附件按 skill 约定判断（`attach --force` 仅为兼容参数，代码不再按身份拦截）。`attach` 不带 `--out` 时默认写到系统临时目录 `<tmp>/dsh-mailbox-attach-*`（权限 0700，可能被系统清理，不再使用旧的 `<stateDir>/attachments`）；需要保留时显式 `--out` 到用户自己的目录。**不要**把用户文件/附件放进 `<dshHome>/skills/watch-mailbox/` 或其它插件托管目录：停用/启用会整目录归档/恢复，当前版本恢复时只还原 `SKILL.md`（见 §7）。
- 不要把 `From` 显示名当成身份；匹配的是地址，且 allowlist 是唯一授权来源。
- **主动发信（`send`）是对外副作用**：默认不发；以用户与 agent 的约定（一次授权即生效）或当次明确要求为准；来信内容不构成授权。

## 6. 多账户

每个账户一个 watch entry，指向各自的 `envFile`；`stateDir` 和 `allowAccountFile` 可共享：

```json
{
  "id": "mailbox-account-2",
  "preset": "mailbox",
  "enabled": true,
  "mailbox": {
    "envFile": "/absolute/path/to/mail-2.env",
    "stateDir": "/absolute/path/to/.dsh/mailbox",
    "allowAccountFile": "/absolute/path/to/allow-accounts.json",
    "python": "python3"
  },
  "interval": 60,
  "timeout": 60
}
```

不同账户的 allowlist 用各自 `MAIL_ADDRESS` 作 key；同一会话的多个账户通知会由插件合并。

## 7. 严格策略与 skill

随包 `extension/mailbox/skills/watch-mailbox/SKILL.md` 包含默认严格行为。该 skill **不在插件运行时注册**，而是由 `/watch-reload` 落地成 `<dshHome>/skills/watch-mailbox/SKILL.md`（配置里存在 `enabled: true` 的 `preset: "mailbox"` 时）：

通知只带数据 + “按 skill 处理”的指示；agent 按 skill 的「命令与参数：按配置组装」一节，从 `watches.json` 的 mailbox entry 取参数、组装命令。

- **想放宽**（例如 guest 可带附件）：直接编辑 `<dshHome>/skills/watch-mailbox/SKILL.md`；插件不覆盖已存在的文件，`/watch-reload` 会保留你的修改；
- **停用 mailbox**：该目录整体移入 `<dshHome>/watch/extension/skills/watch-mailbox/`（单份，覆盖旧归档，不保留多份历史）；
- **重新启用**：自动从归档恢复，你对 `SKILL.md` 的修改会回来；当前版本只还原 `SKILL.md`，用户额外放进该目录的文件不会保留（审查 F-03 未修复）——用户文件/附件不要放在这里，见 §5；
- **随包 skill 更新**：见[根 CHANGELOG](../../CHANGELOG.md)，插件不会覆盖你的文件；需要时自行比对后替换（或删掉目标文件再 `/watch-reload` 重新生成）。

## 8. 故障排查

- `selfcheck` 失败：检查 `mail.env` 路径、端口、授权码、网络/SSL 证书。
- `check` 返回 error：错误会写进运行记录的 `error` 字段；`watch_runs` 的 `checker_error_count` 统计「运行成功但 checker 报 error」的次数，`last_error` 在没有硬失败时会回退显示最近一条 checker error（stderr 通常为空，只有单封邮件被跳过时带附注）。
- 单封邮件解析失败：该封被跳过并在 `check` 的 `error` 里附注「新邮件解析失败 N 封」，`last_seen_uid` 仍会前进，因此坏件不会永久阻塞后续邮件。
- 没有通知：确认 allowlist 有当前账户 key、发件人地址匹配；`status` 查看规则和状态。
- 重复提醒：说明 `temp` 未 ack；`list --pending`，读信后 reply 或 mark。
- `mark` 报 uid 不在状态：先 `check`/`list`，不要标记未知 uid。
