# dsh-watch-kit-plugin 安装与验收（面向 agent）

> **适用版本：v0.1.0（代码已实现，单测通过；安装后按 §4–§6 做验收）**。
> 阅读者是一个有本机 shell 与 `plugin_manager` 权限的 agent。按顺序执行，**每步都要看结果**；不要跳步，不要凭"应该装好了"下结论。
> 规范性契约见 `docs/design.md`；安装流程的异常处理见 §7。

---

## 0. 前置检查（全部通过才继续）

```bash
# 1) 确认实现已完成
ls projects/dsh-watch-kit-plugin/lib/index.js projects/dsh-watch-kit-plugin/package.json
# 2) 确认 profile
echo "$DSH_PROFILE" "$DSH_PROFILE_DIR"     # 期望 desktop / ~/.dsh/profiles/desktop
# 3) 确认工作区 watch 根目录（不存在就创建）
mkdir -p "$PWD/plugins/watch/watches"
# 4) 确认 Node（仅本地跑测试用；插件由 DSH 自身加载；需要 Node >= 22）
NODE="$(command -v node)"; "$NODE" -v   # 若无系统 node，可用 "$DSH_HOME/dsh-runtimes/<runtime>/dependencies/node/bin/node"
# 5) 本地单测（应为 96 pass / 0 fail）
cd projects/dsh-watch-kit-plugin && "$NODE" --test test/*.test.mjs
```

若 `lib/index.js` 不存在，**停止安装**，向用户报告"插件仍处于设计阶段，请先完成实现清单"。

> 平台：本文流程在 macOS 上验证；Windows 的差异与限制见 §10（v0.1 未实测）。

---

## 1. 安装 bundle

调用 `plugin_manager`：

| 参数 | 值 |
|---|---|
| `action` | `install_bundle` |
| `target` | `projects/dsh-watch-kit-plugin` 的**绝对路径** |

读取返回值，按 `application` 判定：

- `applied`：插件已加载，继续 §2。
- `restart-required`：告知用户需要重启 DSH，重启后继续 §2。
- `failed` / 有 `warnings`：**不要继续**，把完整返回贴给用户并排查（常见：package.json 缺 `dsh.bundle.patch`、locale/icon 导出缺失、peer 版本不符）。

安装本身会写入 profile 的 `package.json` 与 patch，**不要手工改这些文件**。

---

## 2. 配置 `specDirs`

插件默认 `specDirs: []`，即不轮询任何目录。在 **profile 的 `cordis.patch.yml`** 增加一条 row：

> ⚠️ 用 `- insert:` **显式建行**，不要只写 `- id: watch`——后者是「修改已有条目」，
> 在该插件以 link/bundle 方式挂载时行可能还不存在，会被静默跳过（实测：本机 desktop
> profile 下只写 id 覆盖，命令未注册；改 insert 后生效）。mem0 插件的安装文档同款模式。

```yaml
- insert:
    - id: watch
      name: dsh-watch-kit-plugin
      config:
        specDirs:
          - /path/to/workspace/plugins/watch/watches
```

（`patch` 覆盖会**整体替换** config，未写的键回落到插件 Config 默认值。）

保存后：

1. 若能热加载：进入会话验证；
2. 若命令/配置未生效：重启 DSH，再验证。

**验收**：在任意会话输入 `/watch-list`，应返回空列表（或已存在的 watch），而不是"未知命令"。

---

## 3. 读取命令与工具面

在会话里确认：

```
/watch-list          → 空列表提示
```

模型侧只有 `watch_validate` 一个工具；**不存在** create/remove 类工具。若发现命令缺失：

- 检查 `plugin_manager` 的 `list_plugins` 中 `watch` 行是否 enabled；
- 检查插件日志中是否有 `specDirs 为空` 的 warning；
- 检查是否需要重启。

---

## 4. 创建 demo watch（目录大小监控）

在**用户所在会话**里执行 `/watch-add`（是用户输入，不是你调用；若用户让你代劳，请把下面整行发给用户，等其执行）：

```
/watch-add demo-dir-size --purpose "某个目录超过阈值时提醒我"
```

随后你（agent）会收到 `[WATCH SETUP]` 作者指令。按 `watch-authoring` skill 执行：

### 4.1 写检测脚本（macOS/Linux 为 `check.sh`，Windows 为 `check.ps1`）

路径：`plugins/watch/watches/demo-dir-size/check.sh`（`/watch-add` 已建目录）。

```bash
#!/bin/bash
# 目录大小监控 demo：首次越过阈值时事件；回落后重置；目录不存在算异常。
set -u
DIR="${WATCH_DEMO_DIR:-$HOME/Downloads}"
LIMIT_MB="${WATCH_DEMO_LIMIT_MB:-500}"
STATE_DIR="${WATCH_STATE:?WATCH_STATE is required}"

[ -d "$DIR" ] || { echo "directory not found: $DIR" >&2; exit 255; }

size_kb=$(du -sk "$DIR" 2>/dev/null | awk '{print $1}') || {
  echo "du failed for $DIR" >&2; exit 255
}
limit_kb=$(( LIMIT_MB * 1024 ))
marker="$STATE_DIR/above"

if [ "$size_kb" -gt "$limit_kb" ]; then
  if [ ! -f "$marker" ]; then
    printf '目录 %s 当前 %s MB，超过阈值 %s MB\n' \
      "$DIR" "$((size_kb / 1024))" "$LIMIT_MB"
    : > "$marker"
    exit 1
  fi
  exit 0                 # 已提醒过，去重
fi

rm -f "$marker"
exit 0
```

然后 `chmod +x check.sh`。

### 4.2 写 `watch.conf`

```ini
PURPOSE=目录大小超过阈值时提醒我
TRIGGER_MSG=目录超过阈值，请确认是否需要清理或提高阈值。
INTERVAL=30
TIMEOUT=15
```

`TARGETS` 已由 `/watch-add` 写入，不要手改。

### 4.3 激活并验证

1. 调用 `watch_validate`（参数 `{ "id": "demo-dir-size" }`），确认返回 `ok: true`、`status: active`、`sampleFrame` 内容合理；
2. `/watch-list` 确认状态为 `active`；
3. 等待一个周期，确认**没有**意外的触发（阈值以下应静默）。

### 4.4 制造一次事件（真实验收）

```bash
mkdir -p /tmp/watch-demo && dd if=/dev/zero of=/tmp/watch-demo/blob bs=1m count=20
```

把 `check.sh` 的 `WATCH_DEMO_DIR`/`WATCH_DEMO_LIMIT_MB` 默认值改为该目录与 `10`（或通过编辑脚本常量），然后：

- 在 **≤ 2×INTERVAL** 内，会话应收到一轮 `[WATCH TRIGGER]`（reason=event），帧里包含 `id`、`message`、evidence、logs 路径；
- 确认 `triggerCount` 变为 1；帧里的 `message` 等于 `TRIGGER_MSG`；
- 再等 2 个周期，确认**没有**新的触发（demo 去重生效）。

清理顺序：先 `/watch-pause demo-dir-size`，再 `rm -rf /tmp/watch-demo`，最后把阈值/目录常量还原；按用户意愿 `/watch-remove demo-dir-size`。（若目录已删除而 watch 仍在 active，脚本会返回 255，这是预期的"异常"而非"无事件"。）

### 4.5 JSON 覆盖验证（推荐）

把 `check.sh` 临时改成输出 JSON 后 `exit 1`，验证 design §6.2.2：

```bash
printf '{"message":"demo：目录超过阈值，请确认。","evidence":"JSON evidence 测试"}\n'
exit 1
```

- 触发帧头应为 `message_source=script`，`message` 为脚本给出的文本；
- `evidence` 来自 JSON 的 `evidence` 字段；
- 再把 JSON 写坏（例如少一个引号）并让它 `exit 1`：`/watch-list` 的失败计数应增长、日志出现 `event_json_invalid`，且**不出现**事件轮；连续 5 次后才出现失败帧；
- 验证完恢复脚本，并重新调用 `watch_validate`。

### 4.6 脚本完整性验证（推荐）

1. 在 watch 目录里对 `check.sh` 做一次**无功能影响**的改动（例如末尾加一行注释）；
2. 在 `integrityNotifyDelayMs`（默认 5s）+ 1 个 tick 内，会话应收到一条 `[WATCH NOTICE] id=... reason=script_changed`；
3. `/watch-list` 状态变为 `needs_validation`，并且这段时间**没有**运行检查（日志无新 `run` 行）；
4. 调用 `watch_validate`（`{"id":"demo-dir-size"}`）→ 状态恢复 `active`；再确认没有第二条重复通知；
5. 先 `/watch-pause demo-dir-size`，再改一次脚本，然后尝试 `/watch-resume`：应被拒绝，提示先 `watch_validate`。

验证完把注释删掉再做一次 `watch_validate`。

### 4.7 唤醒预算验证（可选）

给 demo watch 的 `watch.conf` 加：

```ini
WAKE_BUDGET_CAPACITY=1
WAKE_BUDGET_REFILL_SECONDS=60
```

让脚本连续触发两次（可把阈值调低再触发），预期：只收到第一条触发；`/watch-list` 出现 `suppressed(n)`；
等 60 秒后再触发一次，应收到一条带"合并了 N 条较早的触发"的补投帧。验证后删除这两行配置并 `watch_validate`。

---

## 5. 验收证据（交付给用户时必须包含）

按工作区 `AGENT.md` 规则 2.9，逐条给出**命令输出或会话记录**，不要只说"已装好"：

- [ ] `plugin_manager` 安装返回的 `application` 与 `warnings`
- [ ] `/watch-list` 的前后输出
- [ ] `watch_validate` 的返回摘要（`ok/status/rev`）
- [ ] 事件轮出现的时间、帧内 `id`/`reason`/`message`
- [ ] `triggerCount` 从 0 → 1，之后保持不变
- [ ] 日志文件末 5 行（`plugins/watch/watches/demo-dir-size/logs/<date>.log`）
- [ ] （若做了 §4.5）`message_source=script` 的帧，以及非法 JSON 时失败计数增长、无事件轮的记录
- [ ] （若做了 §4.6）`needs_validation` 状态、`[WATCH NOTICE]` 帧、`watch_validate` 恢复、`/watch-resume` 被拒的记录
- [ ] （若做了 §4.7）`suppressed(n)` 与补投帧

---

## 6. 失败路径抽查（建议做一次）

把 `check.sh` 临时改为 `exit 255`，等待 5 个周期：

- 应出现一条 `reason=failure` 的合并/单条触发，且**只出现一次**；
- `/watch-list` 显示 `failing(5)`，轮询仍在继续；
- 改回正常脚本，下一次成功运行后失败计数清零。

验证完立即还原。

---

## 7. 故障排查

| 现象 | 检查 | 处理 |
|---|---|---|
| `/watch-*` 是未知命令 | `list_plugins` 中 `watch` 状态；插件日志 | 启用/修复后重启 DSH |
| `/watch-list` 报 `specDirs 为空` | profile patch 的 `config.specDirs` | 补配置；重启 |
| `watch_validate` 返回 `unknown_watch` | `specDirs` 路径、目录名与 id 是否一致 | 修正路径或重新 `/watch-add` |
| `not_executable` | `ls -l check.sh`；Windows 看 `check.ps1` 是否存在 | `chmod +x` / 修正 `CHECK` |
| `runner_not_found` | `RUNNER`、扩展名、解释器是否在 PATH（bash/pwsh/python/node） | 安装解释器，或改 `RUNNER=direct` 并提供可执行文件 |
| `event_json_invalid` | stdout 是否为完整合法 JSON（≤8KB、UTF-8、退出码为 1） | 用 `bash check.sh \| python3 -m json.tool` 定位；修脚本或回退纯文本输出 |
| 中文/证据乱码（Windows） | PowerShell 输出编码 | 脚本开头设置 `[Console]::OutputEncoding = [Text.Encoding]::UTF8` |
| `dry_run_timeout` | 手动 `bash check.sh; echo $?` | 降低 TIMEOUT 前先修脚本；确保 ≤ INTERVAL/2 |
| 一直不触发 | 手动运行脚本；看 `$WATCH_STATE` 去重标记 | 修脚本逻辑 |
| 触发不只一次 | `triggerCount`、脚本是否每轮 `exit 1` | 加去重状态（见 demo） |
| 收不到触发 | `TARGETS` 的会话 id 是否有效（`/watch-list` 标 orphaned） | 改 `TARGETS` 前先取得用户 `/watch-approve`，改后 `watch_validate` |
| 配置改了不生效 | 文件名/键名；日志有无 `config reload` | 修正；必要时重启 |
| 状态 `needs_validation` | 检测脚本在激活后被改动/丢失 | 审查脚本后调用 `watch_validate`；不要用 `/watch-resume` 绕过 |
| 收到 `[WATCH NOTICE]` | 同上（通知在编辑后约 5s 才发，给 validate 留窗口） | 属于预期安全流程；确认改动来源后 validate |
| `/watch-list` 显示 `suppressed(n)` | 该 watch 开了唤醒预算 | 属预期；若误伤，调大容量/间隔或关闭预算 |
| 插件禁用后仍有行为 | 检查是否有残留 job/定时器 | 报告 bug（预期为零残留） |

---

## 8. 卸载与回滚

1. `/watch-pause` 或 `/watch-remove` 处理各 watch（数据在 `plugins/watch/watches/` 内，卸载插件不会删除）；
2. `plugin_manager` → `remove_bundle`，target 为 `dsh-watch-kit-plugin`；
3. 重启 DSH；
4. 验收：`/watch-list` 变为未知命令；`plugins/watch/watches/` 中的文件仍在（用户资产）。

---

## 9. 安全注意

- 只允许**用户**执行 `/watch-add`、`/watch-approve`；你不得替用户"确认"。
- 修改 `TARGETS`、`PURPOSE`、触发语义前，必须先在对话中说明并取得 `/watch-approve`。
- 不要在任何 watch 的 `stdout`/`TRIGGER_MSG` 中写入密码、token 或私密内容（帧会进入会话历史）。
- 不要给 watch 脚本添加删除、外发、提权类动作；如用户要求，先明确风险并取得确认。
- JSON 事件里的 `message` 会作为 agent 的常驻指令进入会话历史；不要在 `message`/`evidence` 中写秘密。

---

## 10. Windows（v0.1 未验证，best-effort）

> v0.1 只在 macOS 上验证；以下为设计预期，未经实测，验收报告中必须注明。

1. DSH 在 Windows 上不加载 `tool-bash`，改用 PowerShell；`/watch-add` 复制的是 `check.ps1` 模板（`CHECK=./check.ps1`）。
2. 运行器：`.ps1` 优先 `pwsh`，回退 `powershell`；`.py` 用 `py -3` 或 `python`；`.sh` 需要 PATH 中有 Git Bash/WSL 的 `bash`，否则改用 `.ps1`。
3. PowerShell 脚本输出前必须设置：
   ```powershell
   [Console]::OutputEncoding = [Text.Encoding]::UTF8
   ```
   否则中文/JSON 可能乱码（JSON 解析失败会记为执行失败）。
4. 退出码：`exit 0` / `exit 1` / `exit 255`；超时与子进程组终止由宿主受管进程服务负责。
5. 命令未出现、触发未送达等情况按 §7 排查；不要声称 Windows 已验证。
