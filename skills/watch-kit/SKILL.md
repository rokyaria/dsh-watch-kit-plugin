---
name: watch-kit
description: "dsh-watch-kit-plugin 使用入口：watch 配置（用户级 ~/.dsh/watch/watches.json）、checker 契约、/watch-reload、watch_runs/watch_sessions、mailbox 扩展；先读 README 再动手。"
---

# dsh-watch-kit-plugin 使用入口

当用户提到 **dsh-watch-kit-plugin、watch 插件、巡检、定时检查、checker、`/watch-reload`、`watch_runs`、`watch_sessions`、mailbox 扩展**，或询问“这个插件怎么用/怎么配置”时使用本 skill。

## 先读文档，不要猜旧命令

完整用法：

https://github.com/rokyaria/dsh-watch-kit-plugin/blob/main/README.md

开发/架构说明：仓库内 `docs/development.md`。

先读 README，再按用户的实际目标操作；不要凭空发明命令或沿用 v0.1 的旧命令。

## 当前版本（0.3.0）的对外表面

- 配置：`<dshHome>/watch/watches.json`（默认 `~/.dsh/watch/watches.json`）；`configFile`/`dbFile` 可在 profile patch 显式覆盖，相对路径按 `$DSH_HOME` 解析
- 运行时状态：`<dshHome>/watch/watch.db`（SQLite；**用户级，不跟随工作区**；旧版 `<workspace>/.dsh/watch/` 不自动迁移，见 CHANGELOG 0.2.4）
- 命令：只有 `/watch-reload`（由用户在输入框发送，agent 不能代发）
- 工具：`watch_runs`（执行/通知/失败统计）、`watch_sessions`（可见会话）
- checker：argv 直接执行；只认 stdout 的 JSON `{notify, message, error}`；插件不负责去重/重试
- 扩展：`extension/mailbox/` 提供 mailbox checker；配置里用 `preset: "mailbox"`，不需要写 checker 路径/参数
- 扩展 skill：mailbox skill **不常驻注册**——存在 `enabled: true` 的 mailbox watch 时，`/watch-reload` 把它落地到 `<dshHome>/skills/watch-mailbox/SKILL.md`（用户可直接编辑，插件不覆盖）；邮件状态在 `<stateDir>/<account>.sqlite3`（默认 `<dshHome>/mailbox/<account>.sqlite3`；SQLite，按 UID 记录，保留 31 天）；停用时整目录移入 `<dshHome>/watch/extension/skills/watch-mailbox/`，重新启用时整目录恢复（额外放入该目录的用户文件也会保留）

## 工作方式

1. 用户描述需求（检查什么、间隔、哪个会话接收）。
2. 读 README 的配置/checker 契约；必要时读 `docs/development.md`。
3. 帮用户写/改 checker 或 `watches.json`；提醒用户自己发送 `/watch-reload`。
4. 用 `watch_runs` 验证运行结果；不要用日志推测插件内部状态。

## 状态位置速查

`<dshHome>` = `DSH_HOME` 或 `~/.dsh`（默认）；显式配置的 `configFile`/`dbFile` 以配置为准。

- 配置：`<dshHome>/watch/watches.json`
- DB：`<dshHome>/watch/watch.db`
- mailbox skill：`<dshHome>/skills/watch-mailbox/SKILL.md`（停用时归档到 `<dshHome>/watch/extension/skills/watch-mailbox/`）
