---
name: watch-kit
description: "dsh-watch-kit-plugin 使用入口：watch 配置、checker 契约、/watch-reload、watch_runs/watch_sessions；先读 README 再动手。"
---

# dsh-watch-kit-plugin 使用入口

当用户提到 **dsh-watch-kit-plugin、watch 插件、巡检、定时检查、checker、`/watch-reload`、`watch_runs`、`watch_sessions`**，或询问“这个插件怎么用/怎么配置”时使用本 skill。

## 先读文档，不要猜旧命令

完整用法：

https://github.com/rokyaria/dsh-watch-kit-plugin/blob/main/README.md

开发/架构说明：仓库内 `docs/development.md`。

先读 README，再按用户的实际目标操作；不要凭空发明命令或沿用 v0.1 的旧命令。

## 当前 v0.2.3 的对外表面

- 配置：`<workspace>/.dsh/watch/watches.json`
- 命令：只有 `/watch-reload`（由用户在输入框发送，agent 不能代发）
- 工具：`watch_runs`（执行/通知/失败统计）、`watch_sessions`（可见会话）
- checker：argv 直接执行；只认 stdout 的 JSON `{notify, message, error}`；插件不负责去重/重试
- 扩展：`extension/mailbox/` 提供 mailbox checker；配置里用 `preset: "mailbox"`，不需要写 checker 路径/参数

## 工作方式

1. 用户描述需求（检查什么、间隔、哪个会话接收）。
2. 读 README 的配置/checker 契约；必要时读 `docs/development.md`。
3. 帮用户写/改 checker 或 `watches.json`；提醒用户自己发送 `/watch-reload`。
4. 用 `watch_runs` 验证运行结果；不要用日志推测插件内部状态。
