# 安装、升级与卸载

本文面向用户和 agent，只讲**怎么把 dsh-watch-kit-plugin 装进 DSH 并验证安装成功**；插件怎么用见 [README.md](README.md)，架构与开发说明见 [docs/development.md](docs/development.md)。当前版本 **0.3.1**，宿主口径为 **DSH 0.2.1-rc.3**。

## 1. 前置条件

| 项 | 要求 |
|---|---|
| DSH | `^0.2.1-rc.3`（见 `package.json` 的 `engines.dsh`） |
| Node | ≥24（DSH 0.2.1-rc.3 自带的 Node 24.21 即可；`node:sqlite` 无需 flag） |
| Python | 仅随包 mailbox 扩展需要，3.9+（实测 3.9.6 与 3.12）；不用 mailbox 功能时不需要 Python |
| 平台 | macOS / Linux（POSIX）；**Windows 未验证** |
| 网络/工具 | 能 `git clone`（或下载压缩包），并把仓库放到本地绝对路径 |

安装前先确认两件事：

1. **仓库在本地有绝对路径**：`git clone https://github.com/rokyaria/dsh-watch-kit-plugin`（或下载压缩包解压），记下路径。
2. **当前 DSH 是否有受管 profile**：有受管 profile，才能用 Web 侧边栏「插件」页或 Creator 里的 `plugin_manager`；没有受管 profile 时两者都不可用，只能走方式 C。

## 2. 三条安装入口

| 你的情况 | 用哪条 |
|---|---|
| 普通 Web 用户，想少折腾 | 方式 A：Web 侧边栏「插件」页 |
| 已开 Creator 预设 / 希望 agent 代装 | 方式 B：`plugin_manager` |
| 插件页不可用、也没有 `plugin_manager` | 没有受管 profile → 方式 C 手动兜底；有受管 profile、只是插件页坏了 → 切 Creator 按 B |

三种方式装的是同一个 bundle（`package.json` 的 `dsh.bundle.patch` 指向 `cordis.patch.yml`），差别只在由谁执行安装。

### 方式 A：Web 侧边栏「插件」页（普通用户首选）

1. 把仓库放到本地：`git clone https://github.com/rokyaria/dsh-watch-kit-plugin`，或下载压缩包解压；记下**绝对路径**。
2. DSH Web 侧边栏 → **插件** → **添加插件** → **安装第三方插件**，在对话框填本地绝对路径（也支持 Git 地址、压缩包、包名）。安装完成按页面提示启用组合包；需要固定路径/轮询间隔等配置时，按 [README.md](README.md) 的「运行上限」改 profile patch。
3. 已启用热加载的 profile 会立即重组本插件；否则页面提示 `restart-required` 时按提示重启 DSH。
4. 升级：先移除再安装新版本；pnpm 要求批准依赖构建脚本时，按页面提示单独确认。

> 「插件」页要求当前 Host 有受管 profile。若页面不存在/显示不可用是**因为没有受管 profile**，Creator 里的 `plugin_manager` 也会被禁用，只能走方式 C；只有已有受管 profile、仅插件页不可用时，才建议切 Creator 走方式 B。

### 方式 B：Creator 模式 + `plugin_manager`（agent 驱动）

Web 默认 agent preset 是 `standard`，其中 `tool-plugin-manager` 默认禁用；只有 **Creator**（`cordis` preset，且 profileContext 存在）才启用 `plugin_manager`。其他 preset 仍默认禁用。

1. 把当前会话切到 Creator 预设（或让已有 `plugin_manager` 权限的 agent 操作），并让仓库已在本地。
2. 让 agent 执行（`target` 为仓库**绝对路径**）：

   ```text
   plugin_manager install_bundle target=<本仓库绝对路径>
   ```

3. **权限与审批**：`plugin_manager` 的每个操作都要求 `danger-full-access` 或本次调用的批准；较低沙箱模式下会弹出审批，`never`、拒绝、取消或审批渠道不可用时不会执行。批准只对本次调用生效，不改变会话的权限模式。
4. 返回 `applied` 即完成；返回 `restart-required` 按提示重启 DSH；返回 `already-installed` 或要升级版本时，先 `remove_bundle` 再 `install_bundle`。

> `plugin_manager` 只负责安装 bundle，**不要**为了安装去手改 profile 的 `cordis.patch.yml`；`/watch-reload` 也仍然只能由用户在输入框发送。

### 方式 C：profile 维护者手动安装（兜底）

没有受管 profile、插件页不可用、又无法切 Creator 时，只能由维护者按所用 DSH 版本的 profile 结构把本插件作为依赖安装，并让随包 `cordis.patch.yml` 的 bundle 层生效。本插件不提供跨 DSH 版本的通用手工步骤；不确定时请提 issue，不要猜着改 profile。

## 3. 可直接复制的 agent 安装 prompt

把下面整段发给你的 agent（按需替换仓库地址/本地路径）：

```text
请帮我安装并配置 dsh-watch-kit-plugin（仓库：https://github.com/rokyaria/dsh-watch-kit-plugin）。
1. 安装前先确认当前环境有没有 plugin_manager 工具：
   - 有：把仓库 clone 到本机绝对路径，然后执行
     plugin_manager install_bundle target=<clone 后的绝对路径>
     确认返回 application:"applied"；若提示 restart-required，按提示让我重启 DSH；
     若返回 already-installed，先 remove_bundle 再 install_bundle。
   - 没有：不要改 profile、不要手改 cordis.patch.yml，也不要尝试其它提权方式。
     先问我“当前有没有受管 profile”，再按情况停下：
       * 有受管 profile（只是 plugin_manager 被禁用）：告诉我用 Web 侧边栏「插件」页安装；
       * 没有受管 profile：插件页同样不可用，告诉我只能按 install.md 的方式 C（profile 维护者手动安装）。
2. 安装/加载成功后，先读仓库 README.md 与 install.md，再按 README 的「快速开始」
   在 ~/.dsh/watch/watches.json（用户级；可用 $DSH_HOME 覆盖）创建 watch；checker 按我的实际需求写。
   - 如果我启用了随包 mailbox 扩展，按 extension/mailbox/README.md 准备 mail.env 与 allowlist，
     并在 watches.json 里用 preset:"mailbox" 的条目（模板在 extension/mailbox/examples/）。
3. 不要改 profile 的 cordis.patch.yml，直接用默认配置；完成后把验证清单结果告诉我。
4. /watch-reload 由我自己在输入框发送，你不要代发；也不要替我执行浏览器里的安装操作。
```

**agent 的回退规则**：没有 `plugin_manager` 时唯一正确的动作是**停下来报告**，并先确认用户当前有没有受管 profile——有受管 profile → 请用户用 Web 侧边栏「插件」页安装；没有受管 profile → 插件页也不可用，只能走方式 C。不要自行编辑 profile、不要写 `~/.dsh` 下的 profile 文件、不要用其它工具绕过。

## 4. 安装后验证清单

逐项确认（第 1–2 项用户可自查，第 3–6 项可让 agent 配合）：

| # | 检查项 | 怎么确认 |
|---|---|---|
| 1 | 插件已启用 | Web 侧边栏「插件」页能看到本插件且已启用；Creator 方式的安装返回 `application:"applied"`、`warnings:[]` |
| 2 | `/watch-reload` 可用 | 在输入框能看到该 slash command；**只能由用户手动发送**，agent 不能代发 |
| 3 | 工具已注册 | agent 的工具列表里有 `watch_runs` 与 `watch_sessions`（尚未有运行时返回“没有执行记录”类提示也是正常） |
| 4 | `watch-kit` skill 已注册 | agent 提到 watch 插件/配置时可加载 `watch-kit`（由插件运行时注册，不需要落地文件） |
| 5 | 用户级路径就绪 | 插件加载后 `<dshHome>/watch/watch.db` 即创建（首次 `/watch-reload` 后其中才有 watch 配置与运行记录）；`<dshHome>` = `DSH_HOME` 或 `~/.dsh`；显式配置 `configFile`/`dbFile` 时以配置为准 |
| 6 | mailbox skill（仅启用 mailbox） | `<dshHome>/skills/watch-mailbox/SKILL.md` 已落地（不常驻注册）；停用后整目录归档到 `<dshHome>/watch/extension/skills/watch-mailbox/` |

第一次加载配置：

1. 按 [README.md](README.md) 的「快速开始」创建 `watches.json`；
2. 用户发送 `/watch-reload`，应返回类似 `✓ 已重载 <path>`、`新增/更新/软删除/绑定 target` 的统计行；启用 mailbox 时还会多一行 mailbox skill 同步结果；
3. 让 agent 调用 `watch_runs` 验证 checker 开始执行（`invoke` 增加）；有事件时对应会话会收到 `[WATCH 通知]`。

> 只有 `/watch-reload` 成功把配置同步进 SQLite 后 watch 才会运行；DSH 启动不会自动导入 `watches.json`。

## 5. mailbox 扩展的额外准备（可选）

1. **Python 3.9+**：默认按平台取 `python3`/`python`；推荐在 `watches.json` 的 `mailbox.python` 显式写 DSH 自带 Python 3.12 的绝对路径，macOS 的 `/usr/bin/python3`（3.9.6）也可用。
2. **凭据文件 `mail.env`**（六个键：`MAIL_ADDRESS`、`MAIL_AUTHCODE`、`IMAP_HOST`、`IMAP_PORT`、`SMTP_HOST`、`SMTP_PORT`）：

   ```bash
   install -d -m 700 ~/.dsh/secrets
   install -m 600 extension/mailbox/examples/mail.env.example ~/.dsh/secrets/mail.env
   # 编辑地址、授权码、IMAP/SMTP 主机端口；MAIL_AUTHCODE 用授权码/应用专用密码，不是登录密码
   ```

3. **allowlist**：默认空 = 不通知任何人。模板在 `extension/mailbox/examples/allow-accounts.example.json`，复制到私有路径并 `chmod 600`，格式与 CLI 见 [extension/mailbox/README.md](extension/mailbox/README.md)。
4. **watch 配置**：模板在 `extension/mailbox/examples/watches.example.json`（`enabled: false`，路径是占位符）；填好真实路径后把 `enabled` 改成 `true`，再由用户 `/watch-reload`。
5. **SSL 证书**：若 Python 缺少系统 CA，需在**启动 DSH 的 shell/服务环境**中设置 `SSL_CERT_FILE`，写在 `mail.env` 里不会生效。
6. 凭据不要写进 `watches.json`、不要提交到仓库；`mail.py` 不会打印凭据。

## 6. 升级 / 卸载 / 回滚

**升级**（先备份 `<dshHome>/watch/`、`<dshHome>/mailbox/`，以及你的 `mail.env`/allowlist）：

- 插件页：先移除再安装新版本；pnpm 要求批准依赖构建脚本时按页面提示确认。
- Creator：先 `plugin_manager remove_bundle` 移除旧版本（目标为已安装的包名/路径，参数名以工具提示为准），再 `plugin_manager install_bundle target=<仓库绝对路径>`；确认 `application:"applied"`，`restart-required` 时按提示重启。
- `watches.json`、`watch.db`、mailbox 状态库都保留在用户目录；0.3.x 内 mailbox 状态库 schema 兼容，升级不需要手工迁移。

**卸载**：

- 插件页移除组合包，或 Creator 里 `remove_bundle`。插件停止轮询并关闭 DB；配置文件与 DB 仍保留在磁盘上。
- mailbox skill 与状态库不会被自动清理（它们归用户所有）；需要彻底清理时先备份，再按需删除 `<dshHome>/watch/`、`<dshHome>/mailbox/`、`<dshHome>/skills/watch-mailbox/`。

**回滚**：

- 回滚 = 重新安装旧版本 bundle（同样先 remove 再 install）。
- **0.3.1 → 0.3.0**：外部契约与 mailbox 状态库 schema 相同（`user_version=1`），watches.json 与状态库可直接复用，无需迁移数据。但 `watch.db` 里保存的是 0.3.1 生成的 checker argv（含 `--max-error-bytes`），0.3.0 的 `mail.py` 不认识该参数，argparse 会报错、stdout 为空 → 每轮运行记为 `invalid_json`。因此回滚后**必须让用户发送一次 `/watch-reload`**，按 0.3.0 的规则重新生成 argv（或删除/重建 `watch.db`，会丢运行历史）。
- **0.3.x → 0.2.x**：0.3.0 起 mailbox 状态已从 JSONL 迁移为 SQLite，旧 JSONL 已改名为 `.jsonl.migrated`，0.2.x 不会读取 SQLite 状态；确需降级时先备份 `<dshHome>/mailbox/`，再自行评估旧状态文件怎么处理（0.3.x 期间新增/变更的状态不会被带回）。

## 7. 常见故障排查

- **插件页不存在/不可用**：多半是没有受管 profile（此时 `plugin_manager` 同样被禁用），按方式 C；若已有受管 profile 只是插件页坏了，切 Creator 按方式 B。
- **安装返回 `restart-required`**：按提示重启 DSH；重启前插件不会生效。
- **审批/权限问题**：`plugin_manager` 每个操作都需要 `danger-full-access` 或本次批准；`never`、拒绝、取消或审批渠道不可用时会直接不执行。批准只对本次调用生效。
- **安装返回 `already-installed`**：先 `remove_bundle` 再 `install_bundle`。
- **peer 依赖解析失败**：fresh clone 没有 `node_modules` 属正常，peer 由 DSH 从安装副本解析；不要用 `npm install` 去“修”它。
- **输入框没有 `/watch-reload`**：插件未加载/未启用，或需要重启；确认 DSH 版本满足 `^0.2.1-rc.3`。
- **`/watch-reload` 报“读取配置文件失败”**：`watches.json` 路径不存在（省略 `configFile` 时默认 `<dshHome>/watch/watches.json`，相对路径按 `$DSH_HOME` 解析）；首次使用需要先创建文件。
- **`/watch-reload` 报 JSON/字段错误**：整份配置不生效、数据库不变；按返回的 `watches[i].xxx` 错误逐条修正后重发。
- **watch 不运行**：检查 `enabled` 是否为 `true`、`target` 是否已绑定（省略 `target` 且无法确定当前会话时会报错）、DSH 是否在运行；用 `watch_runs` 看 `invoke` 是否增长。
- **没有通知**：checker 输出 `notify:false`、或 JSON/字段不合法、或超时——`watch_runs` 的 `invalid_json`/`invalid_fields`/`timeout` 列可定位；去重逻辑在 checker 自己手里。
- **mailbox 报错**：先跑 `selfcheck` 检查凭据/网络/SSL；allowlist 为空、账户 key 不匹配、Python 不在 PATH、状态库损坏等排查看 [extension/mailbox/README.md](extension/mailbox/README.md) 的「故障排查」。
- **旧版状态迁移**：0.3.0 起首次打开会把旧 JSONL 状态迁移到 SQLite（`.jsonl.migrated`），迁移只发生一次；0.3.1 没有 schema 变更。

## 8. 安全与边界提醒

- 插件是**本地单用户插件**：没有 OS 沙箱，checker 以你的用户身份运行；只从可信来源安装，安装前可先看仓库代码。
- 安装只影响 DSH profile 的 bundle 层；不会修改你的 `watches.json`/邮箱状态，也不会替你发送 `/watch-reload`。
- mailbox 的 `mail.env` 含授权码：保持 `0600`、不要提交仓库、不要贴进会话；agent 不应打开或打印该文件。
- 需要固定 `configFile`/`dbFile`/轮询间隔时，改 profile 的 `cordis.patch.yml`（覆盖 `watch` 行 config，**不要用 insert**），然后重启/重新加载插件；`watches.json` 的日常改动只走 `/watch-reload`。
